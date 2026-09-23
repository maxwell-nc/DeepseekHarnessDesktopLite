# -*- coding: utf-8 -*-
"""
DeepSeek Harness 桌面壳
=======================

把 DeepSeek Harness（``@deepseek-ai/dsh``）的 Web UI 包成一个 Windows 桌面程序：

* 用 **WebView2**（Edge Chromium）内核内嵌界面，不依赖外部浏览器
* 后台静默拉起 ``dsh web`` 服务，**全程不出现任何命令行窗口**
* 常驻**系统托盘**，点窗口关闭按钮只收起界面，服务继续在后台运行
* **版本管理器**：预览远端最近 10 个版本（含 alpha），每个版本下载到独立槽位
  （``runtime/slots/<版本>/``），确认后切换 —— 切换自动重启应用，多版本并存不互相覆盖
"""

import http.cookiejar
import json
import logging
import math
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
import uuid
import webbrowser
import zipfile
from collections import deque

# 源码旁边的 __pycache__ 是噪音，统一丢到 <项目根>/build/pycache 下。
# 必须在导入本项目自己的模块（app_icon）之前设置，否则 pyc 已经落进 src/ 了。
if not hasattr(sys, "_MEIPASS"):        # frozen 时不折腾，bundle 里没这个概念
    sys.pycache_prefix = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "build", "pycache"
    )

import pystray
import webview
import websocket
from PIL import Image

from app_icon import make_icon, save_ico

# --------------------------------------------------------------------------- #
# 常量
# --------------------------------------------------------------------------- #

APP_NAME = "DeepSeek Harness"
APP_VERSION = "1.1.0"
PACKAGE = "@deepseek-ai/dsh"
HOST = "127.0.0.1"
PORT = 3080
URL = "http://%s:%d" % (HOST, PORT)
MUTEX_NAME = "Local\\DeepSeekHarnessDesktopShell"
# 重启应用时，新实例在单实例锁上轮询等待旧实例退出释放锁的最长时间。
RESTART_LOCK_TIMEOUT = 30.0
# 版本切换时，新实例带着这个环境变量启动：拿到单实例锁（旧实例已完全退出、
# WebView2 进程已释放文件）后，先删掉整个 webview 配置目录再启动，避免跨版本
# 残留的 localStorage / 缓存 / cookie（同一 origin 共用）把新版本前端带崩。
CLEAR_WEBVIEW_ENV = "DSH_UI_CLEAR_WEBVIEW"

# 窗口底色：亮色主题，和 HTML 里的 --bg 保持一致（WebView2 首帧还没渲染时的底色）
WINDOW_BG = "#f4f6fb"

# 官方源在国内基本连不上，默认强制走国内镜像；
# 置空则回退到系统自身的 npm 配置（~/.npmrc）。
DEFAULT_REGISTRY = "https://registry.npmmirror.com"

# 首次安装未就绪时让用户三选一的镜像列表（label, url）。
# 顺序即推荐顺序：npmmirror 一般最快，但部分地区连不上时华为云更快。
REGISTRY_CHOICES = (
    ("npmmirror（阿里）", "https://registry.npmmirror.com"),
    ("华为云", "https://repo.huaweicloud.com/repository/npm"),
    ("腾讯云", "https://mirrors.cloud.tencent.com/npm"),
)


def registry_label(value):
    """给一个 registry URL 返回短名；空串 = 跟随系统。"""
    value = (value or "").strip()
    if not value:
        return "跟随系统"
    for label, url in REGISTRY_CHOICES:
        if value == url:
            return label
    return value


# dsh web 启动时会打印一个带 token 的地址，必须用这个地址访问，
# 直接访问 http://127.0.0.1:3080/ 会返回 401。
TOKEN_URL_RE = re.compile(r"(https?://[\w.\-]+:\d+/\?token=[A-Za-z0-9_\-]+)")
TOKEN_RE = re.compile(r"[?&]token=([A-Za-z0-9_\-]+)")

CREATE_NO_WINDOW = 0x08000000
CREATE_NEW_PROCESS_GROUP = 0x00000200

# --------------------------------------------------------------------------- #
# 防睡眠（保持系统唤醒）
# --------------------------------------------------------------------------- #
# 用 Windows 的 SetThreadExecutionState 阻止系统进入睡眠：
#   ES_CONTINUOUS(0x80000000) | ES_SYSTEM_REQUIRED(0x00000001)
# 只阻止睡眠，不阻止息屏（不带 ES_DISPLAY_REQUIRED），也不影响锁屏。
# 进程退出时系统会自动清除该标志，但显式释放更干净（重启/更新流程会复用）。
ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001
ES_DISPLAY_REQUIRED = 0x00000002
_AWAKE_STATE = ES_CONTINUOUS | ES_SYSTEM_REQUIRED
_awake_held = False
_awake_lock = threading.Lock()


def keep_system_awake():
    """阻止系统睡眠（不阻止息屏/锁屏）。重复调用幂等。"""
    global _awake_held
    with _awake_lock:
        if _awake_held:
            return
        try:
            import ctypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            prev = kernel32.SetThreadExecutionState(_AWAKE_STATE)
            if prev == 0:
                log("设置防睡眠失败（SetThreadExecutionState 返回 0）")
                return
            _awake_held = True
            log("已阻止系统睡眠（息屏/锁屏不受影响）")
        except Exception as exc:  # noqa: BLE001
            log("设置防睡眠异常: %s" % exc)


def release_system_awake():
    """释放防睡眠标志，恢复系统默认睡眠策略。重复调用幂等。"""
    global _awake_held
    with _awake_lock:
        if not _awake_held:
            return
        try:
            import ctypes

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.SetThreadExecutionState(ES_CONTINUOUS)
            _awake_held = False
            log("已释放防睡眠，恢复系统默认睡眠策略")
        except Exception as exc:  # noqa: BLE001
            log("释放防睡眠异常: %s" % exc)


# --------------------------------------------------------------------------- #
# 路径
# --------------------------------------------------------------------------- #


def _base_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


BASE_DIR = _base_dir()
DATA_DIR = os.path.join(
    os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "DeepSeekHarness"
)
RUNTIME_DIR = os.path.join(DATA_DIR, "runtime")
WORKSPACE_DIR = os.path.join(DATA_DIR, "workspace")
WEBVIEW_DIR = os.path.join(DATA_DIR, "webview")
ASSETS_DIR = os.path.join(DATA_DIR, "assets")
ICON_PATH = os.path.join(ASSETS_DIR, "app.ico")
CONFIG_FILE = os.path.join(DATA_DIR, "config.json")
SHELL_LOG = os.path.join(DATA_DIR, "shell.log")
SERVICE_LOG = os.path.join(DATA_DIR, "service.log")
STDIO_LOG = os.path.join(DATA_DIR, "stdio.log")

for _d in (DATA_DIR, RUNTIME_DIR, WORKSPACE_DIR, WEBVIEW_DIR, ASSETS_DIR):
    try:
        os.makedirs(_d, exist_ok=True)
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# 日志（打包成无控制台 exe 后 stdout/stderr 可能是 None，必须兜住）
# --------------------------------------------------------------------------- #


def _install_stdio_fallback():
    if sys.stdout is not None and sys.stderr is not None:
        return
    try:
        handle = open(STDIO_LOG, "a", encoding="utf-8", buffering=1)
    except OSError:
        return
    if sys.stdout is None:
        sys.stdout = handle
    if sys.stderr is None:
        sys.stderr = handle


_install_stdio_fallback()

_log_lock = threading.Lock()
_MAX_LOG_BYTES = 2 * 1024 * 1024


def _rotate(path, mark):
    try:
        if os.path.isfile(path) and os.path.getsize(path) > _MAX_LOG_BYTES:
            backup = "%s.%s" % (path, mark)
            if os.path.isfile(backup):
                os.remove(backup)
            os.replace(path, backup)
    except OSError:
        pass


def log(message):
    line = "%s %s" % (time.strftime("[%Y-%m-%d %H:%M:%S]"), message)
    with _log_lock:
        try:
            _rotate(SHELL_LOG, time.strftime("%Y%m%d%H%M%S"))
            with open(SHELL_LOG, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        except OSError:
            pass


# --------------------------------------------------------------------------- #
# 耗时埋点
#
# 设 DSH_UI_TIMING=1 启动后，日志里会多出形如
#   [t+  3.412s] [timing] 服务就绪
# 的打点行（相对本模块第一条语句的秒数），用来定位"打开慢 / 退出慢"到底慢在哪一段。
# 默认关闭，正常使用时日志不受影响。
# --------------------------------------------------------------------------- #

T_START = time.perf_counter()
TIMING = (os.environ.get("DSH_UI_TIMING") or "").strip() == "1"


def mark(label):
    """打一个耗时点。标签统一带 [timing] 前缀，方便 grep。"""
    if TIMING:
        log("[t+%7.3fs] [timing] %s" % (time.perf_counter() - T_START, label))


def _timed(label, func, *args, **kwargs):
    """跑 func 并记录耗时，返回其结果。"""
    if not TIMING:
        return func(*args, **kwargs)
    begin = time.perf_counter()
    try:
        return func(*args, **kwargs)
    finally:
        log("[t+%7.3fs] [timing] %s（耗时 %.3fs）" % (
            time.perf_counter() - T_START, label, time.perf_counter() - begin))


def report_onefile_extract():
    """单文件 exe 每次启动都要把自己解压到 %TEMP%\\_MEIxxxxx，这段开销用户完全看不见。

    用解压目录的创建时间近似它（只在开了埋点时才记录）。若这段明显偏大，
    说明瓶颈在打包形态本身，而不是代码。
    """
    if not TIMING:
        return
    mei = getattr(sys, "_MEIPASS", None)
    if not mei:
        return
    try:
        cost = time.time() - os.path.getctime(mei)
    except OSError:
        return
    log("[t+%7.3fs] [timing] onefile 解压+解释器启动 ≈ %.3fs（%s）"
        % (time.perf_counter() - T_START, cost, mei))


# --------------------------------------------------------------------------- #
# 原生 loading（启动期唯一的界面）
# --------------------------------------------------------------------------- #

# 主窗口里那层原生 loading 的状态：已铺上的面板、最新状态文字、待回答的镜像询问
_LOADING = {
    "panels": [],
    "text": "正在启动本地服务…",
    "action": None,
    "armed": False,
    "asker": None,
}
_LOADING_LOCK = threading.Lock()

# 界面迟迟铺不上（WebView2 初始化失败之类）时，别让首次安装一直等着选镜像
ASKER_UI_TIMEOUT = 20.0


class _LoadingPanel(object):
    """铺在主窗口里的那一层原生 loading：控件 + 把镜像选择器亮出来的入口。"""

    __slots__ = ("panel", "tip", "ask")

    def __init__(self, panel, tip, ask):
        self.panel = panel
        self.tip = tip
        self.ask = ask      # ask(asker, reveal) —— 只能在 UI 线程调用


class _RegistryAsker(object):
    """一次「用哪个 npm 镜像」的询问，等用户在启动界面上点确认。"""

    def __init__(self, current):
        self.current = current
        self.choice = None
        self.shown = threading.Event()      # 选择器已经铺到界面上
        self.decided = threading.Event()    # 用户已经点了「开始安装」


def ask_registry_choice(current):
    """首次安装前问一次用哪个镜像，返回选中的 registry URL。

    选择器不另开窗体，直接铺在原生 loading 那一层上（用户看到的还是同一个启动
    界面），所以也不用自建消息泵。界面迟迟铺不上（WebView2 初始化失败之类）就
    回退到 current，不把首次安装卡死。
    """
    asker = _RegistryAsker(current)
    with _LOADING_LOCK:
        _LOADING["asker"] = asker
        items = list(_LOADING["panels"])
        action = _LOADING.get("action")

    # 面板已经在（重启流程）就立刻铺上；还没建（首启时本线程跑在 webview.start()
    # 前面）就留给建面板的那段代码来取，见 patch_webview_loading。
    for item in items:
        try:
            if action is not None and item.panel.InvokeRequired:
                item.panel.BeginInvoke(action(lambda _item=item: _item.ask(asker, True)))
            else:
                item.ask(asker, True)
        except Exception as exc:  # noqa: BLE001
            log("铺镜像选择器失败: %s" % exc)

    if not asker.shown.wait(ASKER_UI_TIMEOUT):
        log("镜像选择器没铺上（原生 loading 不可用？），沿用当前镜像")
        with _LOADING_LOCK:
            if _LOADING.get("asker") is asker:
                _LOADING["asker"] = None
        return current

    asker.decided.wait()        # 问题已经在界面上了，等用户点，不设超时
    with _LOADING_LOCK:
        if _LOADING.get("asker") is asker:
            _LOADING["asker"] = None
    return asker.choice or current


def set_loading_tip(text):
    """改原生 loading 上那行文字。任意线程可调，异步投递，绝不阻塞调用方。"""
    text = str(text or "")
    with _LOADING_LOCK:
        _LOADING["text"] = text
        items = list(_LOADING["panels"])
    action = _LOADING.get("action")

    for item in items:

        def apply(_label=item.tip, _text=text):
            try:
                _label.Text = _text
            except Exception:  # noqa: BLE001
                pass

        try:
            if action is not None and item.panel.InvokeRequired:
                item.panel.BeginInvoke(action(apply))
            else:
                apply()
        except Exception as exc:  # noqa: BLE001
            log("更新原生 loading 文字失败: %s" % exc)


def arm_loading_drop():
    """真实页面（dsh 界面）开始导航了 —— 允许撤掉原生 loading。

    服务没起来之前不能撤：撤了就是一片空窗口，用户既看不到进度也看不到报错。
    """
    with _LOADING_LOCK:
        _LOADING["armed"] = True


def patch_webview_loading():
    """主窗口一出来就显示**原生** loading，WebView2 在它底下并行初始化。

    启动期唯一的界面就是这一层：应用名 + 进度条 + 一行状态（状态文字由
    ``set_loading_tip`` 从服务线程实时更新）。等 dsh 页面真正加载完
    （``arm_loading_drop()`` 之后再收到 NavigationCompleted）才撤掉，露出真页面。
    首次安装前问「用哪个 npm 镜像」也用这一层（见 ``ask_registry_choice``）：
    选项直接铺在这里，不另开窗体。

    两个必须记住的坑：

    1. **先把 WebView2 控件设成不可见。** 它是带 HWND 的子窗口，WinForms 那些没有
       句柄的控件（Panel / Label / ProgressBar）按 airspace 规则永远画不到它上面，
       z-order 和 BringToFront 都救不了 —— 不藏掉的话这层 loading 铺了也看不见
       （实测中部非底色像素占比 0.000）。只藏控件不藏窗口：内核初始化和导航照常跑。
    2. **不要另开小窗。** pywebview 的 ``setup_app()`` 要求在任何窗体之前调用
       ``SetCompatibleTextRenderingDefault``，抢先建窗体会让整个 GUI 起不来。
       原生控件长在主窗口里就没有这个顺序问题。
    """
    try:
        import clr as _clr

        _clr.AddReference("System.Drawing")
        from System import Action  # noqa: PLC0415
        from System.Drawing import (  # noqa: PLC0415
            ColorTranslator,
            ContentAlignment,
            Font,
            FontStyle,
            Point,
            Size,
        )
        from webview.platforms import edgechromium  # noqa: PLC0415
    except Exception as exc:  # noqa: BLE001
        log("跳过原生 loading：%s" % exc)
        return

    _LOADING["action"] = Action
    real_init = edgechromium.EdgeChrome.__init__
    if getattr(real_init, "_dsh_loading", False):
        return

    def make_font(size, bold=False):
        for name in ("Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI"):
            try:
                return Font(name, size, FontStyle.Bold if bold else FontStyle.Regular)
            except Exception:  # noqa: BLE001
                continue
        return None

    def patched(self, form, window, cache_dir):
        real_init(self, form, window, cache_dir)
        # 只给主窗口铺这一层：插件管理器窗口是隐藏建好、点开才显示的，它有自己的
        # HTML，不需要这层（铺上反而要等 120s 兜底才撤）。
        if getattr(window, "uid", None) != "master":
            return
        try:
            WinForms = edgechromium.WinForms
            value = (window.background_color or "").lstrip("#")
            color = edgechromium.Color.FromArgb(
                255, int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)
            )

            self.webview.Visible = False      # 见上面第 1 条：不藏就看不见

            panel = WinForms.Panel()
            panel.Dock = WinForms.DockStyle.Fill
            panel.BackColor = color

            # 内容块固定尺寸，靠 panel 的 Resize 居中——省掉 Dock 先后次序的坑
            box = WinForms.Panel()
            box.Size = Size(560, 132)
            box.BackColor = color

            title = WinForms.Label()
            title.Text = APP_NAME
            title.Location = Point(0, 12)
            title.Size = Size(560, 44)
            title.TextAlign = ContentAlignment.MiddleCenter
            title.ForeColor = ColorTranslator.FromHtml("#1b2130")
            title.BackColor = color
            title.Font = make_font(16.0, True) or title.Font

            bar = WinForms.ProgressBar()
            bar.Style = WinForms.ProgressBarStyle.Marquee
            bar.MarqueeAnimationSpeed = 25
            bar.Location = Point(160, 70)
            bar.Size = Size(240, 6)

            tip = WinForms.Label()
            tip.Location = Point(0, 88)
            tip.Size = Size(560, 32)
            tip.TextAlign = ContentAlignment.MiddleCenter
            tip.ForeColor = ColorTranslator.FromHtml("#6b7488")
            tip.BackColor = color
            tip.Font = make_font(10.5) or tip.Font
            with _LOADING_LOCK:
                tip.Text = _LOADING["text"]

            # 镜像选择器：常驻控件，平时收着，首次安装前才亮出来（不另开窗体，
            # 和第 2 条坑一个道理）。放在状态行下面，内容块平时高 132，亮出来时变高。
            ask_box = WinForms.Panel()
            ask_box.Size = Size(560, 134)
            ask_box.Location = Point(0, 132)
            ask_box.BackColor = color
            ask_box.Visible = False

            radios = []
            for i, (label, _url) in enumerate(REGISTRY_CHOICES):
                radio = WinForms.RadioButton()
                radio.Text = label
                radio.AutoSize = True      # 默认是 False，不打开「npmmirror（阿里）」会被截断
                radio.Location = Point(200, 6 + i * 28)
                radio.ForeColor = ColorTranslator.FromHtml("#1b2130")
                radio.BackColor = color
                radio.Font = make_font(10.5) or radio.Font
                radios.append(radio)
                ask_box.Controls.Add(radio)

            go = WinForms.Button()
            go.Text = "开始安装"
            go.Size = Size(120, 32)
            go.Location = Point(220, 96)
            go.Font = make_font(10.5) or go.Font
            ask_box.Controls.Add(go)

            box.Controls.Add(title)
            box.Controls.Add(bar)
            box.Controls.Add(tip)
            box.Controls.Add(ask_box)

            def recenter(_sender=None, _args=None):
                try:
                    box.Location = Point(
                        max(0, (panel.ClientSize.Width - box.Width) // 2),
                        max(0, (panel.ClientSize.Height - box.Height) // 2 - 24),
                    )
                except Exception:  # noqa: BLE001
                    pass

            def show_asker(asker, reveal=False):
                """把镜像选择器亮出来（只在 UI 线程调）。"""
                if reveal:
                    try:
                        # 用户可能把窗口收进托盘了：得拉回来，否则他看不到问题
                        window.show()
                    except Exception as exc:  # noqa: BLE001
                        log("拉起主窗口失败: %s" % exc)
                for radio, (_label, url) in zip(radios, REGISTRY_CHOICES):
                    radio.Checked = url == asker.current
                if not any(radio.Checked for radio in radios):
                    radios[0].Checked = True        # 配置里是「跟随系统」之类，默认第一个
                go.Enabled = True
                ask_box.Visible = True
                box.Size = Size(560, 132 + ask_box.Height)
                recenter()
                set_loading_tip("首次运行，请选择下载镜像（约 220 MB）：")
                asker.shown.set()

            def confirm(_sender=None, _args=None):
                asker = _LOADING.get("asker")
                if asker is None:
                    return
                go.Enabled = False
                for radio, (_label, url) in zip(radios, REGISTRY_CHOICES):
                    if radio.Checked:
                        asker.choice = url
                        break
                # 收起选择器，界面还原成「纯进度」，接下来由安装流程刷进度
                ask_box.Visible = False
                box.Size = Size(560, 132)
                recenter()
                set_loading_tip("正在准备安装…")
                asker.decided.set()

            go.Click += confirm

            panel.Resize += recenter
            panel.Controls.Add(box)
            form.Controls.Add(panel)
            panel.BringToFront()
            recenter()
            mark("原生 loading 已铺上（WebView2 在底下并行初始化）")

            with _LOADING_LOCK:
                _LOADING["panels"].append(_LoadingPanel(panel, tip, show_asker))
                pending = _LOADING.get("asker")

            if pending is not None:
                # 服务线程比窗口起得早：它要的镜像选择器在这里补上
                show_asker(pending)

            dropped = []
            action = _LOADING["action"]

            def drop(force=False):
                if dropped:
                    return
                with _LOADING_LOCK:
                    if not force:
                        if not _LOADING["armed"]:
                            return      # 真实页面还没开始导航，继续等
                    elif _LOADING.get("asker") is not None:
                        # 兜底撤离不能撤掉还没人回答的问题：撤了用户就没法选镜像
                        return
                dropped.append(1)
                with _LOADING_LOCK:
                    for item in list(_LOADING["panels"]):
                        if item.panel is panel:
                            _LOADING["panels"].remove(item)

                def remove():
                    try:
                        self.webview.Visible = True      # 先亮页面，再撤挡板
                    except Exception:  # noqa: BLE001
                        pass
                    try:
                        form.Controls.Remove(panel)
                        panel.Dispose()
                    except Exception:  # noqa: BLE001
                        pass

                try:
                    # NavigationCompleted 在 UI 线程，兜底定时器不在 —— 都 marshal 过去
                    if action is not None and panel.InvokeRequired:
                        panel.BeginInvoke(action(remove))
                    else:
                        remove()
                except Exception:  # noqa: BLE001
                    pass
                mark("原生 loading 已撤（页面已加载）")

            def on_nav(*_args):
                # 注意：这里的 self 是 EdgeChrome 实例，不是 DshShellApp
                try:
                    src = str(self.webview.Source or "")
                except Exception:  # noqa: BLE001
                    return
                # 认准 dsh 那个端口：初始空白页也可能触发 NavigationCompleted
                if (":%d" % PORT) not in src:
                    return
                drop()

            self.webview.NavigationCompleted += on_nav
            # 兜底：万一页面一直没加载完，也不能永远挡着（首次 npm 安装可能很久）
            threading.Timer(120.0, lambda: drop(force=True)).start()
        except Exception as exc:  # noqa: BLE001
            log("铺原生 loading 失败: %s\n%s" % (exc, traceback.format_exc()))

    patched._dsh_loading = True
    edgechromium.EdgeChrome.__init__ = patched


def _setup_logging():
    try:
        handler = logging.FileHandler(SHELL_LOG, encoding="utf-8")
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
        )
        root = logging.getLogger()
        root.handlers = [handler]
        root.setLevel(logging.INFO)
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# 配置（npm 源等）
# --------------------------------------------------------------------------- #

_config_lock = threading.Lock()


def load_config():
    cfg = {"registry": DEFAULT_REGISTRY}
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            cfg.update(data)
    except (OSError, ValueError):
        pass
    return cfg


def save_config(cfg):
    with _config_lock:
        try:
            with open(CONFIG_FILE, "w", encoding="utf-8") as fh:
                json.dump(cfg, fh, indent=2, ensure_ascii=False)
        except OSError as exc:
            log("保存配置失败: %s" % exc)


# --------------------------------------------------------------------------- #
# 主窗口位置记忆
#
# 默认每次启动都用 CenterScreen 居中；用户手动挪过窗口后，把位置/尺寸记到
# config.json，下次启动恢复，避免"每次打开位置都不一样"。
# --------------------------------------------------------------------------- #

WINDOW_GEOMETRY_KEYS = ("window_x", "window_y", "window_w", "window_h")


def load_window_geometry():
    """读回上次的主窗口几何。返回 (x, y, w, h) 或 None（没有/非法）。"""
    cfg = load_config()
    try:
        x = int(cfg["window_x"])
        y = int(cfg["window_y"])
        w = int(cfg["window_w"])
        h = int(cfg["window_h"])
    except (KeyError, TypeError, ValueError):
        return None
    if w < 200 or h < 200:
        return None
    return x, y, w, h


def save_window_geometry(x, y, w, h):
    """把主窗口几何写进 config.json（只更新这四个键，不动其它配置）。"""
    try:
        cfg = load_config()
        cfg["window_x"] = int(x)
        cfg["window_y"] = int(y)
        cfg["window_w"] = int(w)
        cfg["window_h"] = int(h)
        save_config(cfg)
    except Exception as exc:  # noqa: BLE001
        log("保存窗口位置失败: %s" % exc)


def clamp_window_geometry(x, y, w, h):
    """把恢复的窗口位置夹回当前可见屏幕内，避免拔掉副屏后窗口跑到屏幕外。

    只保证窗口左上角落在虚拟屏幕范围内（并留出标题栏余量）；尺寸不变。
    拿不到屏幕信息时原样返回。坐标一律用逻辑像素（与保存/恢复一致）。
    """
    try:
        import webview

        screens = webview.screens()
        if not screens:
            return x, y, w, h
        vx = min(s.x for s in screens)
        vy = min(s.y for s in screens)
        vw = max(s.x + s.width for s in screens) - vx
        vh = max(s.y + s.height for s in screens) - vy
    except Exception:  # noqa: BLE001
        return x, y, w, h
    if vw <= 0 or vh <= 0:
        return x, y, w, h
    # 至少让标题栏（约 40px）留在屏幕内
    margin = 40
    cx = min(max(x, vx - w + margin), vx + vw - margin)
    cy = min(max(y, vy - margin), vy + vh - margin)
    return cx, cy, w, h


def effective_registry():
    """返回本次 npm 调用要用的 registry；空串表示交给系统 npm 配置决定。"""
    value = (load_config().get("registry") or "").strip()
    if value.lower() in ("", "default", "system", "official"):
        return ""
    return value


# --------------------------------------------------------------------------- #
# 版本槽位：多版本并存的运行时布局（版本管理器的地基）
#
# 老布局（单目录原地覆盖）：runtime/node_modules/@deepseek-ai/dsh
# 新布局：
#     runtime/slots/<版本>/            每个版本一个完整 npm 工程根
#     runtime/slots/<版本>.dl/          下载中的临时目录，装完 rename 成正式槽位
# 活动版本记在 config.activeSlot；切换 = 改它 + 自动重启应用（见 vm_switch）。
# workspace/ 插件/ 配置全都不分版本，所有槽位共享。
# ---------------------------------------------------------------------------

SLOTS_DIR = os.path.join(RUNTIME_DIR, "slots")
SLOT_DL_SUFFIX = ".dl"
# 首次安装时还不知道装的是哪个版本，临时目录先叫这个（同刻只允许一个 npm 任务）
SLOT_PENDING_NAME = "_pending"
DEFAULT_MAX_SLOTS = 5            # 槽位数上限（超限只提示 + 跳转按钮，不自动删）
VERSION_LIST_LIMIT = 10           # 远端版本列表展示条数（含 alpha）
VERSIONS_CACHE_TTL = 600.0        # 远端版本列表内存缓存（秒）

_SCOPE, _NAME = PACKAGE.split("/") if "/" in PACKAGE else ("", PACKAGE)


def sanitize_version(ver):
    """版本号 -> 安全的目录名；不合法返回 None（防路径穿越）。"""
    ver = str(ver or "").strip()
    if not ver or len(ver) > 64:
        return None
    if not re.match(r"^[0-9A-Za-z][0-9A-Za-z._+-]*$", ver):
        return None
    if ".." in ver or "/" in ver or "\\" in ver:
        return None
    return ver


def slot_dir(version):
    """某版本的槽位目录（不存在也返回路径）。"""
    ver = sanitize_version(version)
    if not ver:
        raise ValueError("非法版本号: %r" % (version,))
    return os.path.join(SLOTS_DIR, ver)


def _version_sort_key(ver):
    """够用的简化 semver 排序键：1.5.0-alpha.4 < 1.5.0（同号时正式版更大）。"""
    parts = []
    for chunk in re.split(r"[.\-+_]", str(ver)):
        if not chunk:
            continue
        parts.append((0, int(chunk)) if chunk.isdigit() else (1, chunk.lower()))
    if "-" not in str(ver):
        parts.append((2, ""))       # 没有预发布段 = 正式版，压过同号 prerelease
    return parts


def _read_package_version(manifest):
    """读一个 package.json 的 version（带白名单校验）；读不到返回 None。"""
    try:
        with open(manifest, "r", encoding="utf-8") as fh:
            return sanitize_version(json.load(fh).get("version"))
    except (OSError, ValueError):
        return None


def legacy_layout_version():
    """老单目录布局里装的版本号；没有老布局返回 None。"""
    return _read_package_version(
        os.path.join(RUNTIME_DIR, "node_modules", _SCOPE, _NAME, "package.json")
    )


def list_local_slots(include_partial=False):
    """扫描 slots/，返回 [{version, dir, partial}]；partial = 下载中的 *.dl。"""
    out = []
    if not os.path.isdir(SLOTS_DIR):
        return out
    try:
        names = sorted(os.listdir(SLOTS_DIR))
    except OSError:
        return out
    for name in names:
        path = os.path.join(SLOTS_DIR, name)
        if not os.path.isdir(path):
            continue
        partial = name.endswith(SLOT_DL_SUFFIX)
        if partial and not include_partial:
            continue
        base = name[: -len(SLOT_DL_SUFFIX)] if partial else name
        if partial:
            ver = sanitize_version(base) or base
        else:
            ver = (
                _read_package_version(
                    os.path.join(path, "node_modules", _SCOPE, _NAME, "package.json")
                )
                or (sanitize_version(base) or base)
            )
        out.append({"version": ver, "dir": path, "partial": partial})
    return out


_slot_size_cache = {}     # 目录 -> (记录时间, MB)


def slot_size_mb(path, max_age=60.0):
    """槽位占用（MB）。os.walk 不便宜，结果缓存 60 秒（删槽位时手动失效）。"""
    now = time.time()
    hit = _slot_size_cache.get(path)
    if hit and now - hit[0] < max_age:
        return hit[1]
    total = 0
    for _base, _dirs, names in os.walk(path):
        for name in names:
            try:
                total += os.path.getsize(os.path.join(_base, name))
            except OSError:
                pass
    mb = int(round(total / 1048576.0))
    _slot_size_cache[path] = (now, mb)
    return mb


def active_slot_version():
    """当前活动版本：config.activeSlot → 本地最高版本 → 老布局版本 → None。"""
    want = sanitize_version(load_config().get("activeSlot"))
    slots = [s for s in list_local_slots() if not s["partial"]]
    versions = {s["version"] for s in slots}
    if want and want in versions:
        return want
    if slots:
        return max(versions, key=_version_sort_key)
    legacy = legacy_layout_version()
    if legacy:
        return legacy
    return None


def active_slot_dir():
    """活动版本所在目录；老布局（迁移没跑成）回退 RUNTIME_DIR，未安装也回它。"""
    ver = active_slot_version()
    if ver:
        path = slot_dir(ver)
        if _read_package_version(
            os.path.join(path, "node_modules", _SCOPE, _NAME, "package.json")
        ):
            return path
    if legacy_layout_version():
        return RUNTIME_DIR          # 老单目录布局继续可用（只是没法多版本）
    slots = [s for s in list_local_slots() if not s["partial"]]
    if slots:
        return max(slots, key=lambda s: _version_sort_key(s["version"]))["dir"]
    return RUNTIME_DIR


def set_active_slot(version):
    """把活动版本写进 config.json（version 为空 = 清除，回落到自动探测）。"""
    ver = sanitize_version(version)
    cfg = load_config()
    cfg["activeSlot"] = ver or ""
    save_config(cfg)


def max_slots():
    """槽位数上限（config.maxSlots > 0 时用它，否则默认值）。"""
    try:
        value = int(load_config().get("maxSlots") or 0)
    except (TypeError, ValueError):
        value = 0
    return value if value > 0 else DEFAULT_MAX_SLOTS


def migrate_legacy_runtime():
    """老单目录布局 -> slots/<版本>/。幂等，启动早期调一次（服务还没起）。

    同一卷 rename，220MB 也是瞬间完成；搬一半失败就把搬过去的挪回去，
    保持老布局可用（active_slot_dir() 会兜住老布局）。
    """
    legacy_ver = legacy_layout_version()
    if not legacy_ver:
        return False                        # 没有老布局（已迁移过 / 全新安装）
    if list_local_slots(include_partial=True):
        return False                        # slots/ 已有内容，老目录当残留，不动
    dest = slot_dir(legacy_ver)
    if os.path.exists(dest):
        return False
    try:
        os.makedirs(SLOTS_DIR, exist_ok=True)
        os.makedirs(dest)
    except OSError as exc:
        log("创建槽位目录失败（继续按老布局运行）: %s" % exc)
        return False
    moved = []
    try:
        for name in ("node_modules", "package.json", "package-lock.json", ".package-lock.json"):
            src = os.path.join(RUNTIME_DIR, name)
            if os.path.exists(src):
                shutil.move(src, os.path.join(dest, name))
                moved.append(name)
    except Exception as exc:  # noqa: BLE001
        log("旧布局迁移中断，回滚: %s" % exc)
        for name in moved:
            try:
                shutil.move(os.path.join(dest, name), os.path.join(RUNTIME_DIR, name))
            except OSError as back_exc:
                log("回滚 %s 失败: %s" % (name, back_exc))
        try:
            os.rmdir(dest)
        except OSError:
            pass
        return False
    set_active_slot(legacy_ver)
    log("旧布局已迁移到槽位: %s（dsh %s）" % (dest, legacy_ver))
    return True


def cleanup_partial_slots():
    """清掉上次异常退出留下的 *.dl 半成品（启动早期调）。"""
    for slot in list_local_slots(include_partial=True):
        if not slot["partial"]:
            continue
        try:
            _rmtree(slot["dir"])
            log("已清理下载残留: %s" % slot["dir"])
        except OSError as exc:
            log("清理下载残留失败 %s: %s" % (slot["dir"], exc))


# --------------------------------------------------------------------------- #
# 配置目录：**每个版本一份独立的 dsh home**（等价于原来的 ~/.dsh）
#
#     homes/<版本>/           credentials / settings / sessions / storages /
#                             attachments / profiles/…
#     backups/auto|manual/    切换版本前自动备份 / 版本管理器里手动备份，
#                             两个池子各自滚动保留 BACKUP_RETENTION 份
#
# 第一次给某个版本建目录时，从「切换前正在用的那份 home」拷一个副本过去：
# 源 = 其它版本 home 里 mtime 最新的那个 -> 老 ~/.dsh -> 空目录（再由外壳按
# dsh 的 shipped 模板补一个 profiles/web 骨架）。**已存在的目录一个字节不动。**
#
# 复制 / 打包一律**跳过 reparse point**（junction / symlink）：profiles/node_modules
# 是 dsh 每次启动按活动槽位重建的 400+ 条 junction，跟着拷会把旧槽位 220 MB 真
# 文件拖进来；拷成真目录 dsh 还会拒绝启动（heal 的 ensureSymlink 抛 "exists and
# is not a symlink or dsh-managed module proxy"）。这些链接由 dsh 自己在下次启动
# 时按当前活动槽位重建，所以跳过它们是安全的。
# --------------------------------------------------------------------------- #

HOMES_ROOT = os.path.join(DATA_DIR, "homes")
BACKUPS_ROOT = os.path.join(DATA_DIR, "backups")
BACKUP_RETENTION = 10                # auto / manual 两个池子各自保留的份数
LEGACY_DSH_HOME = os.path.join(os.path.expanduser("~"), ".dsh")
# Windows：junction / symlink / mount point 都带 FILE_ATTRIBUTE_REPARSE_POINT
FILE_ATTRIBUTE_REPARSE_POINT = 0x400
# 备份文件名：<版本>__<YYYYmmdd-HHMMSS>[-n].zip（版本里可能有下划线，所以用正则拆）
BACKUP_NAME_RE = re.compile(r"^(?P<ver>.+)__(?P<ts>\d{8}-\d{6}(?:-\d+)?)\.zip$")
# 恢复时的临时目录后缀（这些目录不算 home，也必须在扫描时跳过）
PARTIAL_HOME_SUFFIXES = (".restoring", ".old", ".part")

# profiles/web 的 shipped 模板 —— 照抄 dsh 的 PROFILE_TEMPLATES.web + initProfile。
# 只在「全新配置目录、dsh 还没起过」时由外壳补骨架，dsh 启动时的
# normalizeShippedProfile 会在元组不对时把它纠正成自己那版。
PROFILE_TEMPLATE_MANIFEST = {
    "name": "dsh-profile-web",
    "private": True,
    "dependencies": {},
    "dsh": {
        "profile": {
            "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
            "patchReload": "live",
        }
    },
}
PROFILE_ROOT_CONFIG = (
    "# dsh profile root — an empty entry list. The tree is composed as patches:\n"
    "# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any\n"
    "# --patch overlays. Edit cordis.patch.yml, not this file.\n"
    "[]\n"
)
PROFILE_PATCH_TEMPLATE = (
    "# Your patch layer for this dsh profile, applied after every bundle layer:\n"
    "# a top-level YAML array of loader patch entries (id-targeted config\n"
    "# overrides, disables, and insert lists; `!!js` expressions allowed).\n"
    "[]\n"
)
PROFILE_PNPM_WORKSPACE = (
    "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n"
)


def _is_reparse(path):
    """是不是 reparse point（junction / symlink / mount point）。"""
    try:
        return bool(os.lstat(path).st_file_attributes & FILE_ATTRIBUTE_REPARSE_POINT)
    except (OSError, AttributeError):
        return False


def _rmtree(path):
    """删目录树：**先清掉只读位再删**（Windows 上只读文件 unlink 会 EACCES）。

    dsh 的 attachments 内容寻址对象就是只读的（0o444），恢复配置要换名删老目录
    时必然撞上 —— 裸 shutil.rmtree 会在那里抛 PermissionError 并留下半截残目录。
    """

    def clear_readonly(func, target, _exc):
        try:
            os.chmod(target, stat.S_IWRITE | stat.S_IREAD)
        except OSError:
            pass
        func(target)                      # 还删不掉就照常抛给调用方

    shutil.rmtree(path, onerror=clear_readonly)


def _force_remove(path):
    """删文件 / 目录 / **链接**，只读的先解锁（返回有没有删掉）。

    顺序很要紧：先判 reparse point —— 对 junction 做 chmod 会跟着改到**目标目录**
    的权限（那可能是整个槽位），所以链接一律只 `rmdir` 摘掉，绝不碰目标。
    """
    if not os.path.lexists(path):
        return False
    if _is_reparse(path):
        os.rmdir(path)                    # junction / symlink：只摘链接
        return True
    if os.path.isdir(path):
        _rmtree(path)
        return True
    os.chmod(path, stat.S_IWRITE | stat.S_IREAD)   # 只读文件 unlock
    os.remove(path)
    return True


def _skip_reparse(src, names):
    """shutil.copytree 的 ignore 回调：**丢掉** reparse point（不跟随、不复制）。"""
    return {name for name in names if _is_reparse(os.path.join(src, name))}


def home_dir_for(version):
    """某版本的配置目录（不存在也返回路径）。"""
    ver = sanitize_version(version)
    if not ver:
        raise ValueError("非法版本号: %r" % (version,))
    return os.path.join(HOMES_ROOT, ver)


def _explicit_home_override():
    """显式**固定**的 dsh home（config.dshHome），没写返回 None。

    只认配置、**不认环境变量**：dsh 自己的会话会把 ``DSH_HOME=~/.dsh`` 带进
    子进程环境（从 dsh 终端里启动本程序就会撞上），拿它当开关会让「每版本独立
    配置目录」在毫无提示的情况下失效。外壳算出来的结果一律由 _child_env()
    注入子进程，所以忽略环境变量不会造成两边各说各话。
    """
    value = (load_config().get("dshHome") or "").strip()
    return os.path.abspath(os.path.expanduser(value)) if value else None


def _home_for_version(version=None):
    """某个版本**实际在用**的配置目录：显式固定时是固定值，否则 homes/<版本>。"""
    override = _explicit_home_override()
    if override:
        return override
    ver = sanitize_version(version) or active_slot_version()
    if ver:
        return home_dir_for(ver)
    return LEGACY_DSH_HOME


def dsh_home():
    """dsh 配置根 —— 外壳与服务子进程共用的**唯一事实源**。

    优先级：config.dshHome（显式固定，不版本化）> ``homes/<活动版本>``
    > 老 ``~/.dsh``（还没装出任何版本时）。

    服务子进程那边由 _child_env() 把这个结果注入 ``DSH_HOME``，保证插件同步、
    信息面板和服务读的是同一份配置。
    """
    return _home_for_version()


def list_local_homes():
    """扫描 homes/，返回 [{version, dir, mtime}]，按 mtime 降序（最新用过的在前）。"""
    out = []
    if not os.path.isdir(HOMES_ROOT):
        return out
    try:
        names = os.listdir(HOMES_ROOT)
    except OSError:
        return out
    for name in names:
        if name.endswith(PARTIAL_HOME_SUFFIXES) or name.startswith("."):
            continue
        ver = sanitize_version(name)
        if not ver:
            continue
        path = os.path.join(HOMES_ROOT, name)
        if not os.path.isdir(path):
            continue
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            mtime = 0.0
        out.append({"version": ver, "dir": path, "mtime": mtime})
    out.sort(key=lambda item: item["mtime"], reverse=True)
    return out


def _seed_home_source(exclude_version):
    """给 exclude_version 找种子目录：其它版本 home（最新用过的优先）-> 老 ~/.dsh。"""
    for item in list_local_homes():
        if item["version"] != exclude_version:
            return item["dir"]
    if os.path.isdir(LEGACY_DSH_HOME):
        return LEGACY_DSH_HOME
    return None


def _init_profile_skeleton(profile_dir):
    """按 dsh 的 shipped 模板补 ``profiles/web`` 骨架（**缺才写，绝不覆盖**）。

    只在全新配置目录 / 恢复后需要：不补的话插件同步会因为 profile 目录不存在
    而被 sync_plugins 的既有兜底跳过一次启动。
    """
    try:
        os.makedirs(profile_dir, exist_ok=True)
    except OSError as exc:
        log("创建 profile 目录失败 %s: %s" % (profile_dir, exc))
        return False
    wrote = False
    files = (
        ("package.json", json.dumps(PROFILE_TEMPLATE_MANIFEST, indent=2, ensure_ascii=False) + "\n"),
        ("cordis.yml", PROFILE_ROOT_CONFIG),
        ("cordis.patch.yml", PROFILE_PATCH_TEMPLATE),
        ("pnpm-workspace.yaml", PROFILE_PNPM_WORKSPACE),
    )
    for name, text in files:
        path = os.path.join(profile_dir, name)
        if os.path.exists(path):
            continue
        try:
            with open(path, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(text)
            wrote = True
        except OSError as exc:
            log("写 %s 失败: %s" % (path, exc))
    if wrote:
        log("已补 profile 骨架: %s" % profile_dir)
    return wrote


def ensure_version_home(version=None, note=None):
    """保证某个版本的配置目录在；缺了就从「切换前那份 home」拷副本过去。

    **已存在的目录一个字节不动。** 任何失败都不抛，只记日志 —— 配置目录准备
    失败不该挡住服务启动（dsh 自己会按默认目录跑）。

    返回 {"dir": str, "created": bool, "source": str|None}。
    """

    def say(text):
        log("[home] %s" % text)
        if note is not None:
            try:
                note(text)
            except Exception:  # noqa: BLE001
                pass

    ver = sanitize_version(version) or active_slot_version()
    if not ver:
        return {"dir": dsh_home(), "created": False, "source": None}
    override = _explicit_home_override()
    if override:
        # 显式指定的 home 不版本化：目录归用户自己管，外壳只补缺失的 profile 骨架
        if not os.path.isdir(os.path.join(override, "profiles", PLUGIN_PROFILE)):
            _init_profile_skeleton(os.path.join(override, "profiles", PLUGIN_PROFILE))
        return {"dir": override, "created": False, "source": None}
    dest = home_dir_for(ver)
    created = False
    source = None
    if not os.path.isdir(dest):
        source = _seed_home_source(ver)
        try:
            os.makedirs(dest, exist_ok=True)
        except OSError as exc:
            say("创建配置目录失败 %s: %s" % (dest, exc))
            return {"dir": dest, "created": False, "source": None}
        if source:
            try:
                # ignore 会丢掉 junction：dsh 下次启动自己按活动槽位重建
                shutil.copytree(source, dest, dirs_exist_ok=True, ignore=_skip_reparse)
            except Exception as exc:  # noqa: BLE001
                say("复制配置目录失败（按全新目录继续）%s -> %s: %s" % (source, dest, exc))
                source = None
            else:
                say("配置目录 %s 已从 %s 复制" % (dest, source))
        else:
            say("全新配置目录: %s" % dest)
        created = True
    # 骨架函数只写**缺失**的文件，所以这里总是调：种子目录里的 profile 是空壳时
    # （只拷到目录、没拷到文件）也能补齐，插件同步就不会被「找不到 profile」挡住。
    _init_profile_skeleton(os.path.join(dest, "profiles", PLUGIN_PROFILE))
    return {"dir": dest, "created": created, "source": source}


def cleanup_partial_homes():
    """清掉恢复过程中留下的 *.restoring / *.old / *.part 残留（启动早期调）。"""
    if not os.path.isdir(HOMES_ROOT):
        return
    try:
        names = os.listdir(HOMES_ROOT)
    except OSError:
        return
    for name in names:
        if not name.endswith(PARTIAL_HOME_SUFFIXES):
            continue
        path = os.path.join(HOMES_ROOT, name)
        try:
            _force_remove(path)
            log("已清理配置目录残留: %s" % path)
        except OSError as exc:
            log("清理配置目录残留失败 %s: %s" % (path, exc))


# ----------------------------- 配置备份 ----------------------------- #


def _backup_pool(kind):
    """备份池目录；kind 只能是 auto（切换前自动）或 manual（窗口里手动）。"""
    if kind not in ("auto", "manual"):
        raise ValueError("未知备份池: %r" % (kind,))
    return os.path.join(BACKUPS_ROOT, kind)


def _zip_directory(src_dir, dest_zip):
    """把目录打成 zip（跳过 reparse point），先写 .part 再原子换名。返回文件数。

    不跟随 junction 的意义：备份里不该有指向某个槽位的链接，恢复时也没有
    链接语义可言（链接由 dsh 按当时的活动槽位重建）。
    """
    tmp = dest_zip + ".part"
    if os.path.exists(tmp):
        os.remove(tmp)
    count = 0
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for base, dirs, names in os.walk(src_dir):
            dirs[:] = [name for name in dirs if not _is_reparse(os.path.join(base, name))]
            for name in names:
                path = os.path.join(base, name)
                if _is_reparse(path):
                    continue
                zf.write(path, os.path.relpath(path, src_dir))
                count += 1
    os.replace(tmp, dest_zip)
    return count


def prune_backups(kind):
    """池子里只留最近 BACKUP_RETENTION 份，返回被删掉的名字。"""
    pool = _backup_pool(kind)
    if not os.path.isdir(pool):
        return []
    entries = []
    try:
        names = os.listdir(pool)
    except OSError:
        return []
    for name in names:
        if not BACKUP_NAME_RE.match(name):
            continue
        path = os.path.join(pool, name)
        try:
            entries.append((os.path.getmtime(path), path))
        except OSError:
            pass
    entries.sort(reverse=True)          # 新的在前
    removed = []
    for _mtime, path in entries[BACKUP_RETENTION:]:
        try:
            os.remove(path)
            removed.append(os.path.basename(path))
        except OSError as exc:
            log("淘汰旧备份失败 %s: %s" % (path, exc))
    if removed:
        log("备份池 %s 淘汰旧备份: %s" % (kind, "、".join(removed)))
    return removed


def backup_home(version=None, kind="auto", note=None):
    """把某版本的配置目录打成 zip 放进 backups/<kind>/，并按池子淘汰旧的。

    返回 {ok, name, path, version, sizeMB, kind, pruned} / {ok: False, error}。
    """

    def say(text):
        log("[backup] %s" % text)
        if note is not None:
            try:
                note(text)
            except Exception:  # noqa: BLE001
                pass

    ver = sanitize_version(version) or active_slot_version()
    if not ver:
        return {"ok": False, "error": "还没有活动版本，没有可备份的配置"}
    src = _home_for_version(ver)
    if not os.path.isdir(src):
        return {"ok": False, "error": "配置目录不存在：%s" % src}
    try:
        pool = _backup_pool(kind)
        os.makedirs(pool, exist_ok=True)
    except OSError as exc:
        return {"ok": False, "error": "建不了备份目录：%s" % exc}
    stamp = time.strftime("%Y%m%d-%H%M%S")
    name = "%s__%s.zip" % (ver, stamp)
    path = os.path.join(pool, name)
    index = 1
    while os.path.exists(path):         # 同一秒里点了两次
        index += 1
        name = "%s__%s-%d.zip" % (ver, stamp, index)
        path = os.path.join(pool, name)
    say("正在备份配置 %s（%s）…" % (ver, kind))
    try:
        files = _zip_directory(src, path)
    except Exception as exc:  # noqa: BLE001
        try:
            if os.path.exists(path):
                os.remove(path)
        except OSError:
            pass
        log("配置备份失败 %s: %s" % (src, exc))
        return {"ok": False, "error": "备份失败：%s" % exc}
    try:
        size_mb = int(round(os.path.getsize(path) / 1048576.0))
    except OSError:
        size_mb = 0
    removed = prune_backups(kind)
    say("配置备份完成：%s（%d 个文件，%d MB）" % (name, files, size_mb))
    return {
        "ok": True, "name": name, "path": path, "version": ver,
        "sizeMB": size_mb, "kind": kind, "pruned": removed,
    }


def list_backups():
    """全部备份，按时间倒序：[{name, kind, version, at, sizeMB}]。"""
    out = []
    for kind in ("auto", "manual"):
        pool = _backup_pool(kind)
        if not os.path.isdir(pool):
            continue
        try:
            names = os.listdir(pool)
        except OSError:
            continue
        for name in names:
            match = BACKUP_NAME_RE.match(name)
            if not match:
                continue
            path = os.path.join(pool, name)
            if not os.path.isfile(path):
                continue
            try:
                stat = os.stat(path)
            except OSError:
                continue
            out.append(
                {
                    "name": name,
                    "kind": kind,
                    "version": match.group("ver"),
                    "at": int(stat.st_mtime * 1000),
                    "sizeMB": int(round(stat.st_size / 1048576.0)),
                }
            )
    out.sort(key=lambda item: item["at"], reverse=True)
    return out


def _backup_path(name):
    """备份名 -> 绝对路径；必须落在 auto / manual 两个池子里且真实存在。

    返回 (path, kind)；不合法或找不到抛 ValueError（调用方转成 {"ok": False}）。
    """
    name = str(name or "")
    if not BACKUP_NAME_RE.match(name):
        raise ValueError("非法备份名：%r" % (name,))
    for kind in ("auto", "manual"):
        pool = _backup_pool(kind)
        path = os.path.join(pool, name)
        if os.path.isfile(path):
            return path, kind
    raise ValueError("找不到备份：%s" % name)


def delete_backup(name):
    """删掉一份备份（校验名字必须落在备份池里，防路径穿越）。"""
    try:
        path, kind = _backup_path(name)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    try:
        os.remove(path)
    except OSError as exc:
        return {"ok": False, "error": "删除失败：%s" % exc}
    log("已删除配置备份: %s" % name)
    return {"ok": True, "name": name, "kind": kind}


def version_from_backup_name(name):
    """备份名里的版本号；读不出来返回 None。"""
    match = BACKUP_NAME_RE.match(str(name or ""))
    if not match:
        return None
    return sanitize_version(match.group("ver"))


def _extract_home_zip(zip_path, dest_dir):
    """解压配置备份，并把 zip 里记录的权限（比如只读位）还原回去。

    zipfile 默认不恢复文件权限 —— attachments 的内容寻址对象是只读的，
    解成可写就和 dsh 自己写的不一致了。
    """
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            out = zf.extract(info, dest_dir)
            mode = (info.external_attr >> 16) & 0o777
            if mode and os.path.isfile(out):
                try:
                    os.chmod(out, mode)
                except OSError:
                    pass


def restore_backup(name, note=None):
    """把一份备份解回**它自己的版本目录**。

    顺序：先把现有目录备份一次（auto 池，失败不阻塞）-> 解到 <目录>.restoring
    -> 老目录退到 <目录>.old -> 新目录顶上 -> 删掉 .old。任何一步失败都会把
    现有目录恢复原样，**绝不留下半残的配置**。

    返回 {ok, version, dir, replaced} / {ok: False, error}。
    """

    def say(text):
        log("[restore] %s" % text)
        if note is not None:
            try:
                note(text)
            except Exception:  # noqa: BLE001
                pass

    try:
        path, _kind = _backup_path(name)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    ver = version_from_backup_name(name)
    if not ver:
        return {"ok": False, "error": "备份名里读不出版本号：%s" % name}
    target = _home_for_version(ver)
    existed = os.path.isdir(target)
    if existed:
        say("恢复前先备份当前配置（%s）…" % ver)
        backup_home(ver, kind="auto", note=note)
    staging = target + ".restoring"
    old = target + ".old"
    for stale in (staging, old):
        if os.path.isdir(stale):
            _rmtree(stale)
    try:
        os.makedirs(staging, exist_ok=True)
        _extract_home_zip(path, staging)
    except Exception as exc:  # noqa: BLE001
        try:
            _rmtree(staging)
        except OSError:
            pass
        log("解压备份失败 %s: %s" % (name, exc))
        return {"ok": False, "error": "解压失败：%s" % exc}
    try:
        if existed:
            os.rename(target, old)
        os.rename(staging, target)
    except OSError as exc:
        # 回滚：老目录挪回去，新的丢掉
        if existed and not os.path.isdir(target) and os.path.isdir(old):
            try:
                os.rename(old, target)
            except OSError as back_exc:
                log("恢复回滚失败（老配置留在 %s）: %s" % (old, back_exc))
        try:
            _rmtree(staging)
        except OSError:
            pass
        return {"ok": False, "error": "替换配置目录失败：%s" % exc}
    if existed:
        try:
            _rmtree(old)                     # 只读的 attachments 对象靠 _rmtree 清
        except OSError as exc:
            log("老配置目录没删干净（下次启动会清）%s: %s" % (old, exc))
    profile = os.path.join(target, "profiles", PLUGIN_PROFILE)
    if not os.path.isdir(profile):
        _init_profile_skeleton(profile)
    say("已恢复配置：%s -> %s" % (name, target))
    return {"ok": True, "version": ver, "dir": target, "replaced": existed}


def _channel_of(ver, tags):
    """给版本打通道标签：stable / alpha / beta / rc / 具体 tag 名。"""
    for tag, target in (tags or {}).items():
        if str(target) == str(ver):
            return "stable" if str(tag) == "latest" else str(tag)
    match = re.search(r"-([0-9A-Za-z]+)", str(ver))
    if match:
        pre = match.group(1).lower()
        for name in ("alpha", "beta", "rc", "next", "canary"):
            if pre.startswith(name):
                return name
        return pre
    return "stable"


def _run_npm_capture(args, cwd=None, timeout=90.0):
    """跑一条 npm 命令并收集输出（npm view 之类的一次性查询）。返回 (ok, text)。"""
    node_exe = find_node()
    if not node_exe:
        return False, "未检测到可用的 Node.js"
    registry = effective_registry()
    npm_cli = find_npm_cli(node_exe)
    if npm_cli:
        cmd = [node_exe, npm_cli]
    else:
        npm_cmd = os.path.join(os.path.dirname(node_exe), "npm.cmd")
        if not os.path.isfile(npm_cmd):
            npm_cmd = shutil.which("npm") or "npm"
        cmd = ["cmd.exe", "/c", npm_cmd]
    cmd += list(args)
    if registry:
        cmd.append("--registry=%s" % registry)
    log("npm: %s" % " ".join(cmd))
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=cwd or RUNTIME_DIR,
            env=DshService._child_env(node_exe, registry),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            creationflags=CREATE_NO_WINDOW,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
    except OSError as exc:
        return False, "启动 npm 失败：%s" % exc
    try:
        out, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        kill_tree(proc.pid)
        return False, "npm 超时（%d 秒）" % int(timeout)
    out = out or ""
    return proc.returncode == 0, out


def _build_version_rows(data):
    """npm view 的 {versions, time, dist-tags} -> 按发布时间倒序的前 N 条。"""
    times = data.get("time") or {}
    tags = data.get("dist-tags") or data.get("distTags") or {}
    rows = []
    for ver, published in times.items():
        if ver in ("created", "modified"):
            continue
        version = sanitize_version(ver)
        if not version:
            continue
        rows.append(
            {
                "version": version,
                "channel": _channel_of(version, tags),
                "publishedAt": str(published or ""),
            }
        )
    rows.sort(
        key=lambda r: (r["publishedAt"], _version_sort_key(r["version"])), reverse=True
    )
    return rows[:VERSION_LIST_LIMIT]


_versions_cache = {"at": 0.0, "result": None}


def fetch_remote_versions(force=False):
    """最近 VERSION_LIST_LIMIT 个版本（含 alpha），按发布时间倒序。

    成功结果同时写进内存缓存和 config.versionsCache（离线兜底）。
    返回 {ok, stale, checkedAt, error, rows}。
    """
    now = time.time()
    memory = _versions_cache.get("result")
    if not force and memory and now - _versions_cache["at"] < VERSIONS_CACHE_TTL:
        return memory

    ok, text = _run_npm_capture(
        [
            "view",
            PACKAGE,
            "versions",
            "time",
            "dist-tags",
            "--json",
            "--loglevel=error",
            "--fetch-retries=1",
            "--fetch-retry-maxtimeout=15000",
        ]
    )
    rows, error = None, None
    if ok:
        try:
            rows = _build_version_rows(json.loads(text))
        except (ValueError, TypeError) as exc:
            error = "解析 npm view 输出失败: %s" % exc
    else:
        error = (text or "").strip()[-300:] or "npm view 执行失败"

    if rows is not None:
        result = {"ok": True, "stale": False, "checkedAt": now, "error": "", "rows": rows}
        _versions_cache["at"] = now
        _versions_cache["result"] = result
        cfg = load_config()
        cfg["versionsCache"] = {"at": now, "rows": rows}
        save_config(cfg)
        return result

    # 失败：内存缓存 → 磁盘缓存 → 空列表，都带上错误原因
    if memory:
        return dict(memory, stale=True, error=error)
    disk = load_config().get("versionsCache") or {}
    if isinstance(disk, dict) and disk.get("rows"):
        return {
            "ok": False,
            "stale": True,
            "checkedAt": disk.get("at") or 0,
            "error": error,
            "rows": disk["rows"],
        }
    return {"ok": False, "stale": False, "checkedAt": 0, "error": error, "rows": []}


def cached_remote_versions():
    """只读缓存的远端版本列表（不打 npm）；给轮询用，保证 state() 不阻塞。"""
    memory = _versions_cache.get("result")
    if memory:
        return memory
    disk = load_config().get("versionsCache") or {}
    if isinstance(disk, dict) and disk.get("rows"):
        return {
            "ok": False,
            "stale": True,
            "checkedAt": disk.get("at") or 0,
            "error": "",
            "rows": disk["rows"],
        }
    return {"ok": False, "stale": False, "checkedAt": 0, "error": "", "rows": []}


# --------------------------------------------------------------------------- #
# 插件：目录 / 状态 / 同步
#
# 插件包放在 **exe 同目录的 plugins/**，一个插件一个子目录，里面必须有 manifest.json。
# 每次启动（以及插件管理器点"重启"时）本程序会把「已启用」的插件镜像到 dsh 自己的
# 插件目录 <DSH_HOME>/profiles/<profile>/plugins/，并按插件自带的 patch 片段重写
# <profile>/cordis.patch.yml 的托管块；关掉的插件连同它的补丁行一起撤掉。
# --------------------------------------------------------------------------- #

PLUGIN_STATE_FILE = os.path.join(DATA_DIR, "plugins.json")
PLUGIN_PROFILE = "web"
PLUGIN_STAMP = ".dsh-ui-plugin.json"
# 插件包**根目录**下的这些目录是「运行态」，不是包的一部分：既不参与指纹，
# 也不镜像过去。插件要落盘的数据一律自己找地方放（约定是 <DATA_DIR>/data/，
# 由 DSH_UI_DATA_DIR 告诉它），塞在包里面的话每次重抄都会连数据一起删掉。
PLUGIN_RUNTIME_DIRS = frozenset({"data"})
PATCH_BEGIN = "# >>> dsh-ui 插件管理块（自动生成，勿手工编辑） >>>"
PATCH_END = "# <<< dsh-ui 插件管理块 <<<"
PATCH_HEADER = (
    "# dsh profile patch —— 由 dsh-ui 的插件管理器维护。\n"
    "# 两个 dsh-ui 标记之间的内容按「已启用的插件」生成，手工改动会被覆盖；\n"
    "# 标记之外的内容原样保留。\n"
)


def plugins_dir():
    """内置插件包目录：exe 同目录的 plugins/。开发态回落到项目里的 dist/plugins。"""
    override = (os.environ.get("DSH_UI_PLUGINS_DIR") or "").strip()
    if override:
        return os.path.abspath(os.path.expanduser(override))
    if getattr(sys, "frozen", False):
        return os.path.join(BASE_DIR, "plugins")
    return os.path.join(os.path.dirname(BASE_DIR), "dist", "plugins")


def third_party_plugins_dir():
    """第三方插件包目录：exe 同目录的 plugins-third-party/（不进版本库）。

    开发态回落到项目里的 dist/plugins-third-party/。目录不存在时返回 None，
    调用方按「没有第三方插件」处理。
    """
    override = (os.environ.get("DSH_UI_THIRD_PARTY_PLUGINS_DIR") or "").strip()
    if override:
        return os.path.abspath(os.path.expanduser(override))
    if getattr(sys, "frozen", False):
        return os.path.join(BASE_DIR, "plugins-third-party")
    return os.path.join(os.path.dirname(BASE_DIR), "dist", "plugins-third-party")


def plugin_profile_dir():
    return os.path.join(dsh_home(), "profiles", PLUGIN_PROFILE)


# --------------------------------------------------------------------------- #
# 启动加速补丁
#
# dsh 在启动期间每注册一个插件就把全部前端 client bundle 重算一遍（实测 7 次、
# 约 3 秒），而这段时间没有任何消费者。补丁把「组合」推迟到首次被读取时，只算
# 一次。补丁是独立 .mjs，由 node --import 注入，不改 dsh 任何文件；
# DSH_UI_FASTBOOT=0 可整体关掉。
# --------------------------------------------------------------------------- #

FASTBOOT_ENABLED = (os.environ.get("DSH_UI_FASTBOOT") or "1").strip() != "0"


def fastboot_script():
    """补丁脚本路径。打包后在 exe 的自解压目录里，开发态在 src/runtime/。"""
    if getattr(sys, "frozen", False):
        return os.path.join(
            getattr(sys, "_MEIPASS", BASE_DIR), "runtime", "dsh_fastboot.mjs"
        )
    return os.path.join(BASE_DIR, "runtime", "dsh_fastboot.mjs")


def client_modules_entry():
    """dsh-client-modules 的入口文件，补丁要拿它的原型打洞。

    按**活动槽位**解析 —— 切换版本后节点目录跟着换，补丁不能打到旧槽位上。
    """
    return os.path.join(
        active_slot_dir(), "node_modules", "@deepseek-ai", "dsh-client-modules", "lib", "index.js"
    )


def file_url(path):
    """node 的 --import 只认 URL，Windows 绝对路径得转成 file:///C:/...。"""
    return "file:///" + os.path.abspath(path).replace("\\", "/")


def _is_link(path):
    """junction / symlink 都算真（Windows 上 os.path.islink 对 junction 返回 True）。"""
    try:
        return os.path.islink(path)
    except OSError:
        return False


def _remove_tree(path):
    """删目录：是链接就只摘链接（绝不递归进目标），否则整棵删（容忍只读）。"""
    if not os.path.lexists(path):
        return False
    if _is_link(path):
        os.rmdir(path)
    else:
        _rmtree(path)
    return True


def _same_dir(left, right):
    """两个路径是不是同一个目录（Windows 上大小写不敏感，走 normcase）。"""
    return os.path.normcase(os.path.abspath(left)) == os.path.normcase(os.path.abspath(right))


def _dir_signature(path):
    """目录指纹：文件数 + 最新 mtime。用来判断源目录变没变，避免每次启动都重刷。

    根目录下的运行态目录（PLUGIN_RUNTIME_DIRS）不算数 —— 它们不进镜像，改了也
    不该触发重抄。
    """
    count = 0
    newest = 0.0
    for root, dirs, files in os.walk(path):
        if _same_dir(root, path):
            dirs[:] = [name for name in dirs if name not in PLUGIN_RUNTIME_DIRS]
        for name in files:
            count += 1
            try:
                newest = max(newest, os.path.getmtime(os.path.join(root, name)))
            except OSError:
                pass
    return {"files": count, "mtime": round(newest, 3)}


def _strip_comments(text):
    """去掉整行注释与空行，用来判断补丁文件是不是"空列表"。"""
    return "\n".join(
        line for line in text.splitlines() if not line.lstrip().startswith("#")
    ).strip()


class PluginPackage(object):
    """plugins/ 或 plugins-third-party/ 里的一个插件包。读 manifest，做基本校验，
    坏了就带着原因展示。third_party 标记它来自第三方目录（不进版本库）。
    """

    def __init__(self, path, third_party=False):
        self.path = path
        self.id = os.path.basename(path)
        self.third_party = bool(third_party)
        self.name = self.id
        self.description = ""
        self.version = ""
        self.order = 100
        self.entry = None
        self.patch = None
        self.platforms = []
        self.error = None
        self._read_manifest()

    def _read_manifest(self):
        manifest = os.path.join(self.path, "manifest.json")
        try:
            with open(manifest, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError) as exc:
            self.error = "读不到 manifest.json：%s" % exc
            return
        if not isinstance(data, dict):
            self.error = "manifest.json 顶层不是一个对象"
            return
        declared = str(data.get("id") or "").strip()
        if declared and declared != self.id:
            self.error = "manifest 的 id（%s）与目录名（%s）不一致" % (declared, self.id)
            return
        self.name = str(data.get("name") or self.id)
        self.description = str(data.get("description") or "")
        self.version = str(data.get("version") or "")
        try:
            self.order = int(data.get("order", 100))
        except (TypeError, ValueError):
            self.order = 100
        self.entry = str(data.get("entry") or "").strip() or None
        self.patch = str(data.get("patch") or "").strip() or None
        raw = data.get("platforms")
        self.platforms = [str(item) for item in raw] if isinstance(raw, list) else []
        if not self.entry:
            self.error = "manifest 没写 entry"
        elif not os.path.isfile(os.path.join(self.path, self.entry)):
            self.error = "入口文件不存在：%s" % self.entry
        elif not self.patch:
            self.error = "manifest 没写 patch（插件必须带上要合进 profile 的补丁片段）"
        elif not os.path.isfile(os.path.join(self.path, self.patch)):
            self.error = "补丁片段不存在：%s" % self.patch

    @property
    def platform_ok(self):
        return not self.platforms or sys.platform in self.platforms

    @property
    def usable(self):
        return self.error is None and self.platform_ok


def _scan_dir(root, third_party=False):
    """扫一个插件目录，返回里面的包（坏包也在列表里，带 error）。"""
    found = []
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return found
    for name in names:
        if name.startswith("."):
            continue
        path = os.path.join(root, name)
        if os.path.isdir(path):
            found.append(PluginPackage(path, third_party=third_party))
    return found


def scan_plugin_packages():
    """扫描 plugins/ 与 plugins-third-party/，按 order 排好序返回。

    第三方目录不存在时静默跳过；两个目录里的包都参与加载，只是第三方包
    带 third_party 标记（插件管理器里显示「第三方」徽标）。
    """
    found = _scan_dir(plugins_dir(), third_party=False)
    third = third_party_plugins_dir()
    if third:
        found.extend(_scan_dir(third, third_party=True))
    found.sort(key=lambda item: (item.order, item.id))
    return found


def load_plugin_state():
    try:
        with open(PLUGIN_STATE_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        data = {}
    enabled = data.get("enabled") if isinstance(data, dict) else None
    if not isinstance(enabled, dict):
        enabled = {}
    return {"enabled": {str(key): bool(value) for key, value in enabled.items()}}


def save_plugin_state(state):
    payload = {"profile": PLUGIN_PROFILE, "enabled": state.get("enabled", {})}
    try:
        with open(PLUGIN_STATE_FILE, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, ensure_ascii=False)
    except OSError as exc:
        log("保存插件状态失败: %s" % exc)


def plugin_enabled(state, package):
    """没有记录的插件默认开启 —— 往 plugins/ 里丢一个包就该直接生效。"""
    return bool(state["enabled"].get(package.id, True))


def _sync_one(package, dest):
    """把插件包镜像到 dsh 的 plugins/ 下；源目录没变就跳过（省掉每次启动的复制）。

    包根目录下的运行态目录（PLUGIN_RUNTIME_DIRS，目前只有 `data/`）**不镜像**：
    它是插件自己管的数据，镜像一份只会多出一个副本，而且在重抄时把源目录那份
    盖回镜像里运行时的账本。插件的数据现在统一放在 <DATA_DIR>/data/ 下，
    由 DSH_UI_DATA_DIR 环境变量告诉它 —— 外壳怎么同步都碰不到。
    """
    signature = _dir_signature(package.path)

    def ignore_runtime(src, names):
        """copytree 的回调：只过滤包**根目录**下的运行态目录，子目录里的同名目录不动。"""
        if not _same_dir(src, package.path):
            return set()
        return {name for name in names if name in PLUGIN_RUNTIME_DIRS}

    stamp_path = os.path.join(dest, PLUGIN_STAMP)
    try:
        with open(stamp_path, "r", encoding="utf-8") as fh:
            stamp = json.load(fh)
    except (OSError, ValueError):
        stamp = {}
    if (
        stamp.get("files") == signature["files"]
        and stamp.get("mtime") == signature["mtime"]
        and stamp.get("version") == package.version
    ):
        return "unchanged"
    existed = os.path.lexists(dest)
    if existed:
        _remove_tree(dest)
    shutil.copytree(package.path, dest, ignore=ignore_runtime)
    with open(stamp_path, "w", encoding="utf-8") as fh:
        json.dump(
            {
                "id": package.id,
                "managedBy": "dsh-ui",
                "version": package.version,
                "files": signature["files"],
                "mtime": signature["mtime"],
            },
            fh,
            indent=2,
        )
    return "updated" if existed else "installed"


def _render_managed_block(installed):
    """把已启用插件的补丁片段拼成一个 YAML 列表；没有插件就返回 None。"""
    chunks = []
    for package in installed:
        try:
            with open(
                os.path.join(package.path, package.patch), "r", encoding="utf-8"
            ) as fh:
                fragment = fh.read().strip()
        except OSError as exc:
            raise RuntimeError("读不到 %s 的补丁片段：%s" % (package.id, exc))
        chunks.append(
            "# ── plugin: %s %s ──\n%s" % (package.id, package.version, fragment)
        )
    if not chunks:
        return None
    return "%s\n%s\n%s\n" % (PATCH_BEGIN, "\n\n".join(chunks), PATCH_END)


def _write_managed_patch(profile_dir, installed):
    """重写 <profile>/cordis.patch.yml：托管块之外的内容一律原样保留。"""
    path = os.path.join(profile_dir, "cordis.patch.yml")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            current = fh.read()
    except OSError:
        current = ""

    user = current
    if PATCH_BEGIN in user and PATCH_END in user:
        user = user[: user.index(PATCH_BEGIN)] + user[user.index(PATCH_END) + len(PATCH_END):]
    user = user.strip()

    body_is_empty = _strip_comments(user) in ("", "[]")
    block = _render_managed_block(installed)

    if block is None:
        new = PATCH_HEADER + "[]\n" if body_is_empty else user + "\n"
    elif body_is_empty:
        new = PATCH_HEADER + "\n" + block
    else:
        new = user + "\n\n" + block

    if new == current:
        return "unchanged"
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(new)
    return "written"


def sync_plugins(on_note=None):
    """把 plugins/ 里已启用的插件同步进 dsh，并刷新托管补丁块。

    返回 (是否成功, 说明)。任何一步失败都只记日志、不影响 dsh 启动。
    """

    def note(text):
        log("[plugins] %s" % text)
        if on_note is not None:
            try:
                on_note(text)
            except Exception:  # noqa: BLE001
                pass

    # 每版本配置目录可能还没建（探针 / 直调 sync_plugins 不经过 main()）：
    # 先保证它在 —— 缺了就从「切换前那份 home」拷副本，还是没有就补 profile 骨架。
    try:
        ensure_version_home(note=on_note)
    except Exception as exc:  # noqa: BLE001
        note("准备配置目录失败（继续按现状同步）：%s" % exc)

    profile_dir = plugin_profile_dir()
    if not os.path.isdir(profile_dir):
        message = "找不到 dsh profile 目录：%s（dsh 还没初始化过？）" % profile_dir
        note(message)
        return False, message

    plugins_root = os.path.join(profile_dir, "plugins")
    try:
        os.makedirs(plugins_root, exist_ok=True)
    except OSError as exc:
        message = "建不了 %s：%s" % (plugins_root, exc)
        note(message)
        return False, message

    state = load_plugin_state()
    packages = scan_plugin_packages()
    installed = []

    for package in packages:
        dest = os.path.join(plugins_root, package.id)
        has_stamp = os.path.isfile(os.path.join(dest, PLUGIN_STAMP))
        if not package.usable:
            if has_stamp:
                _remove_tree(dest)
                note("%s 不可用（%s），已撤下" % (package.id, package.error))
            elif package.error:
                note("%s 跳过：%s" % (package.id, package.error))
            continue
        if plugin_enabled(state, package):
            try:
                action = _sync_one(package, dest)
            except OSError as exc:
                note("%s 同步失败：%s" % (package.id, exc))
                continue
            installed.append(package)
            if action != "unchanged":
                note(
                    "%s %s -> %s"
                    % (package.id, "已更新" if action == "updated" else "已安装", dest)
                )
        elif has_stamp:
            _remove_tree(dest)
            note("%s 已关闭，从 dsh 撤下" % package.id)
        elif _is_link(dest):
            note("%s 已关闭，但 %s 是目录链接（不是本程序装的），没动" % (package.id, dest))
        elif os.path.isdir(dest):
            note("%s 已关闭，但 %s 没有本程序的安装标记，没动" % (package.id, dest))

    # 本程序装过、插件包却已经不在 plugins/ 里的，一并清掉
    known = {package.id for package in packages}
    try:
        for name in sorted(os.listdir(plugins_root)):
            if name in known or name.startswith("."):
                continue
            path = os.path.join(plugins_root, name)
            if os.path.isfile(os.path.join(path, PLUGIN_STAMP)):
                _remove_tree(path)
                note("%s 的插件包已不在 plugins/ 里，清掉安装副本" % name)
    except OSError:
        pass

    try:
        patch_result = _write_managed_patch(profile_dir, installed)
    except RuntimeError as exc:
        note(str(exc))
        return False, str(exc)

    enabled_names = "、".join(package.id for package in installed) or "（无）"
    message = "已启用：%s，补丁文件%s" % (
        enabled_names,
        "已更新" if patch_result == "written" else "无变化",
    )
    note(message)
    return True, message


# --------------------------------------------------------------------------- #
# Node / npm 定位
# --------------------------------------------------------------------------- #


def bundled_node_dir():
    """产物自带的 Node 目录：exe 同目录的 node/。开发态回落到项目里的 dist/node。

    只有 node.exe 真的在才算数：目录在、exe 不在（手工解压放了一半）一律当没有，
    好让 find_node() 干净地回退到系统 Node。DSH_UI_NODE_DIR 可整体指向别处，
    对应 plugins_dir() 的 DSH_UI_PLUGINS_DIR。
    """
    override = (os.environ.get("DSH_UI_NODE_DIR") or "").strip()
    if override:
        base = os.path.abspath(os.path.expanduser(override))
    elif getattr(sys, "frozen", False):
        base = os.path.join(BASE_DIR, "node")
    else:
        base = os.path.join(os.path.dirname(BASE_DIR), "dist", "node")
    if os.path.isfile(os.path.join(base, "node.exe")):
        return base
    return None


def _node_dirs():
    out = []

    def add(path):
        if path and path not in out and os.path.isdir(path):
            out.append(path)

    for key in ("ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"):
        base = os.environ.get(key)
        if base:
            add(os.path.join(base, "nodejs"))
    local = os.environ.get("LOCALAPPDATA", "")
    roaming = os.environ.get("APPDATA", "")
    home = os.environ.get("USERPROFILE", "")
    add(os.path.join(local, "Programs", "nodejs"))
    add(os.path.join(roaming, "nvm"))
    add(os.path.join(home, "scoop", "apps", "nodejs", "current"))
    add(os.environ.get("NVM_HOME", ""))
    add(r"C:\nvm4w\nodejs")
    add(r"C:\Program Files\nodejs")
    return out


_node_cache = []


def find_node(refresh=False):
    """找到 node.exe。优先产物自带的 node/，其次 PATH，最后常见安装位置。

    结果会缓存：启动路径上 ``main()`` 和 ``DshService.start()`` 各要一次，
    而 ``shutil.which`` 遍历一遍 PATH 实测近 90ms。想重新探测（比如刚装完 Node）
    就传 ``refresh=True``；找不到时不写缓存，下次照样重新找。
    """
    if _node_cache and not refresh:
        return _node_cache[0]
    bundled = bundled_node_dir()
    if bundled:
        found = os.path.join(bundled, "node.exe")
    else:
        found = shutil.which("node")
    if not found:
        for folder in _node_dirs():
            candidate = os.path.join(folder, "node.exe")
            if os.path.isfile(candidate):
                found = candidate
                break
    if found:
        _node_cache[:] = [found]
    return found


def find_npm_cli(node_exe):
    """找到 npm 的 JS 入口，直接交给 node 执行，绕开 .cmd 的引号坑。"""
    if not node_exe:
        return None
    base = os.path.dirname(node_exe)
    candidates = [
        os.path.join(base, "node_modules", "npm", "bin", "npm-cli.js"),
        os.path.join(base, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ]
    for candidate in candidates:
        candidate = os.path.abspath(candidate)
        if os.path.isfile(candidate):
            return candidate
    return None


# --------------------------------------------------------------------------- #
# 网络与进程辅助
# --------------------------------------------------------------------------- #


def http_alive(port=PORT, timeout=2.5):
    """服务是否已经在监听。

    注意：裸地址访问会返回 401，而 urllib 对 4xx 是抛 HTTPError 而不是返回响应，
    所以必须单独接住 —— 能返回 HTTP 状态码就说明服务已经起来了。
    """
    try:
        with urllib.request.urlopen("http://%s:%d/" % (HOST, port), timeout=timeout) as resp:
            return 200 <= resp.status < 500
    except urllib.error.HTTPError:
        return True
    except Exception:
        return False


def _pids_on_port_native(port):
    """直接读系统 TCP 表，拿监听某端口的进程 PID。

    起一次 netstat 进程实测要 0.23s（exe 里更慢），而 iphlpapi 是进程内的，
    只要 1 毫秒上下。拿不到就返回 None，让调用方回落到 netstat。
    只查 IPv4 —— 本程序只监听 127.0.0.1。
    """
    try:
        import ctypes
        from ctypes import wintypes
    except Exception:  # noqa: BLE001
        return None

    class MIB_TCPROW_OWNER_PID(ctypes.Structure):
        _fields_ = [
            ("dwState", wintypes.DWORD),
            ("dwLocalAddr", wintypes.DWORD),
            ("dwLocalPort", wintypes.DWORD),
            ("dwRemoteAddr", wintypes.DWORD),
            ("dwRemotePort", wintypes.DWORD),
            ("dwOwningPid", wintypes.DWORD),
        ]

    AF_INET = 2                     # ulAf
    TCP_TABLE_OWNER_PID_ALL = 5     # TableClass
    MIB_TCP_STATE_LISTEN = 2        # dwState

    try:
        iphlpapi = ctypes.WinDLL("iphlpapi", use_last_error=True)
        size = wintypes.DWORD(0)
        # 第一次调用只为问出需要的缓冲区大小（必然报 ERROR_INSUFFICIENT_BUFFER）
        iphlpapi.GetExtendedTcpTable(None, ctypes.byref(size), False, AF_INET,
                                     TCP_TABLE_OWNER_PID_ALL, 0)
        if size.value <= 0:
            return None
        buf = ctypes.create_string_buffer(size.value)
        ret = iphlpapi.GetExtendedTcpTable(buf, ctypes.byref(size), False, AF_INET,
                                           TCP_TABLE_OWNER_PID_ALL, 0)
        if ret != 0:
            return None
        count = ctypes.cast(buf, ctypes.POINTER(wintypes.DWORD)).contents.value
        rows = ctypes.cast(
            ctypes.byref(buf, ctypes.sizeof(wintypes.DWORD)),
            ctypes.POINTER(MIB_TCPROW_OWNER_PID),
        )
        pids = set()
        for index in range(count):
            row = rows[index]
            if row.dwState != MIB_TCP_STATE_LISTEN:
                continue
            # dwLocalPort 是网络字节序，低 16 位才是端口
            if socket.ntohs(row.dwLocalPort & 0xFFFF) == port:
                pids.add(int(row.dwOwningPid))
        return pids
    except Exception:  # noqa: BLE001
        return None


def _pids_on_port_netstat(port):
    pids = set()
    try:
        proc = subprocess.run(
            ["netstat", "-ano", "-p", "TCP"],
            creationflags=CREATE_NO_WINDOW,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=12,
        )
        text = proc.stdout.decode("utf-8", "replace")
    except Exception:
        return pids
    suffix = ":%d" % port
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[0].upper() == "TCP" and parts[3].upper() == "LISTENING":
            if parts[1].endswith(suffix):
                try:
                    pids.add(int(parts[4]))
                except ValueError:
                    pass
    return pids


def pids_on_port(port=PORT):
    """列出正在监听该端口的进程 PID（用于兜底清理残留服务）。"""
    native = _pids_on_port_native(port)
    if native is not None:
        return native
    return _pids_on_port_netstat(port)


def kill_tree(pid):
    try:
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            creationflags=CREATE_NO_WINDOW,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=20,
        )
        return True
    except Exception as exc:
        log("taskkill %s 失败: %s" % (pid, exc))
        return False


def js_str(text):
    """把 Python 字符串安全地嵌进 JS 代码里。"""
    return json.dumps(str(text), ensure_ascii=True)


# --------------------------------------------------------------------------- #
# dsh 服务管理
# --------------------------------------------------------------------------- #


class DshService(object):
    def __init__(self):
        self._lock = threading.RLock()
        self._proc = None
        self._log_handle = None
        # 首次安装的 npm 子进程：安装中途退出时要在 _shutdown 里终止它
        self._npm_proc = None
        self._service_tail = deque(maxlen=300)
        # dsh web 每次启动都会打印带 token 的地址，直接用裸地址会 401
        self.web_url = None

    @property
    def access_url(self):
        """WebView2 真正该加载的地址（带 token）。"""
        return self.web_url or URL

    # ---------------- 状态查询 ---------------- #

    @property
    def package_dir(self):
        """活动槽位里的 dsh 包目录（多版本布局见「版本槽位」一节）。"""
        return os.path.join(active_slot_dir(), "node_modules", _SCOPE, _NAME)

    def installed_version(self):
        manifest = os.path.join(self.package_dir, "package.json")
        try:
            with open(manifest, "r", encoding="utf-8") as fh:
                return json.load(fh).get("version")
        except (OSError, ValueError):
            return None

    def managed_running(self):
        with self._lock:
            return self._proc is not None and self._proc.poll() is None

    def running(self):
        return self.managed_running() or bool(pids_on_port())

    def entry_script(self):
        manifest = os.path.join(self.package_dir, "package.json")
        rel = "lib/bin.js"
        try:
            with open(manifest, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            bin_field = data.get("bin")
            if isinstance(bin_field, dict) and bin_field:
                rel = bin_field.get("dsh") or list(bin_field.values())[0]
            elif isinstance(bin_field, str):
                rel = bin_field
        except (OSError, ValueError, IndexError):
            pass
        return os.path.join(self.package_dir, rel.replace("/", os.sep))

    # ---------------- 环境 ---------------- #

    @staticmethod
    def _child_env(node_exe, registry=None):
        env = os.environ.copy()
        if node_exe:
            env["PATH"] = os.path.dirname(node_exe) + os.pathsep + env.get("PATH", "")
        env["NO_COLOR"] = "1"
        env["FORCE_COLOR"] = "0"
        env["BROWSER"] = "none"          # 阻止 dsh 自己弹系统浏览器
        # 配置目录：**每版本一个 home**，由外壳算好注进子进程，保证服务读的
        # 和外壳（插件同步、信息面板）读的是同一份。不覆盖的话，机器上残留的
        # 旧 DSH_HOME 会让两边各说各话（config.dshHome 曾经就是这么只给外壳用的）。
        env["DSH_HOME"] = dsh_home()
        # 插件的运行数据（比如 usage 插件的账本）统一放到本程序的数据根下，
        # 别塞进会被整目录重抄的插件目录里。约定见 PLUGIN_RUNTIME_DIRS。
        env["DSH_UI_DATA_DIR"] = DATA_DIR
        env.pop("npm_config_prefix", None)
        env.pop("NODE_OPTIONS", None)
        if registry:
            # 环境变量优先级最高，确保任何子进程都不会回退到连不上的官方源
            env["npm_config_registry"] = registry
        return env

    @staticmethod
    def ensure_runtime_manifest(target_dir=None):
        """给一个 npm 工程根补 package.json（缺才写）。默认 = 活动槽位目录。"""
        target_dir = target_dir or active_slot_dir()
        manifest = os.path.join(target_dir, "package.json")
        if not os.path.isfile(manifest):
            try:
                os.makedirs(target_dir, exist_ok=True)
                with open(manifest, "w", encoding="utf-8") as fh:
                    json.dump(
                        {
                            "name": "dsh-desktop-runtime",
                            "version": "1.0.0",
                            "private": True,
                            "description": "DeepSeek Harness desktop shell runtime",
                        },
                        fh,
                        indent=2,
                    )
            except OSError as exc:
                log("写入 %s 失败: %s" % (manifest, exc))

    # ---------------- 安装 / 更新 ---------------- #

    def npm_install(self, spec, on_line=None, cwd=None):
        """执行 npm install spec，装进 cwd（默认活动槽位），返回 (是否成功, 末尾输出)。"""
        target = cwd or active_slot_dir()
        self.ensure_runtime_manifest(target)
        return self._run_npm_install(spec, target, on_line)

    def install_to_slot(self, spec, expected_version=None, on_line=None):
        """把 spec 装进一个**新槽位**：先 <名>.dl，装完按实际版本 rename。

        活动槽位永远不被碰 —— 下载失败/中断只留下可清理的 .dl 目录，
        现有版本照常可用。返回 (是否成功, 实际版本 or None, 末尾输出)。
        """
        hint = sanitize_version(expected_version)
        tmp = os.path.join(SLOTS_DIR, (hint or SLOT_PENDING_NAME) + SLOT_DL_SUFFIX)
        if os.path.isdir(tmp):
            shutil.rmtree(tmp, ignore_errors=True)      # 上次残留
        try:
            os.makedirs(SLOTS_DIR, exist_ok=True)
        except OSError as exc:
            return False, None, "创建槽位目录失败：%s" % exc
        self.ensure_runtime_manifest(tmp)
        ok, tail = self._run_npm_install(spec, tmp, on_line)
        if not ok:
            shutil.rmtree(tmp, ignore_errors=True)
            return False, None, tail
        actual = _read_package_version(
            os.path.join(tmp, "node_modules", _SCOPE, _NAME, "package.json")
        )
        if not actual:
            shutil.rmtree(tmp, ignore_errors=True)
            return False, None, "装完了但读不到 %s 的版本号" % PACKAGE
        if hint and actual != hint:
            log("装到的版本 %s 与请求的 %s 不一致，以实际版本为准" % (actual, hint))
        final = slot_dir(actual)
        if os.path.isdir(final):
            shutil.rmtree(tmp, ignore_errors=True)
            return False, actual, "该版本已下载：%s" % final
        try:
            os.rename(tmp, final)
        except OSError as exc:
            return False, actual, "槽位落位失败（%s -> %s）：%s" % (tmp, final, exc)
        log("槽位就绪: %s" % final)
        return True, actual, tail

    def download_version(self, version, on_line=None):
        """下载某个具体版本到新槽位（已下载直接拒绝，绝不覆盖）。"""
        ver = sanitize_version(version)
        if not ver:
            return False, "版本号不合法：%r" % (version,)
        if os.path.isdir(slot_dir(ver)):
            return False, "该版本已下载：%s" % slot_dir(ver)
        ok, _actual, tail = self.install_to_slot("%s@%s" % (PACKAGE, ver), ver, on_line)
        return ok, tail

    def _run_npm_install(self, spec, cwd, on_line=None):
        """执行 npm install，返回 (是否成功, 末尾输出)。"""
        node_exe = find_node()
        if not node_exe:
            return False, (
                "未检测到可用的 Node.js：产物内的 node/ 目录缺失，系统里也没找到 Node。"
                "请重新获取完整发行包（应包含 node/ 目录），"
                "或自行安装 Node.js 18 或更高版本（https://nodejs.org），然后重新启动本程序。"
            )

        npm_cli = find_npm_cli(node_exe)
        if npm_cli:
            cmd = [node_exe, npm_cli]
        else:
            npm_cmd = os.path.join(os.path.dirname(node_exe), "npm.cmd")
            if not os.path.isfile(npm_cmd):
                npm_cmd = shutil.which("npm") or "npm"
            cmd = ["cmd.exe", "/c", npm_cmd]

        registry = effective_registry()
        cmd += [
            "install",
            spec,
            "--no-fund",
            "--no-audit",
            "--no-progress",
            "--loglevel=notice",
            # 网络不稳时快速失败，别把界面挂死
            "--fetch-retries=2",
            "--fetch-retry-maxtimeout=30000",
        ]
        if registry:
            cmd.append("--registry=%s" % registry)

        log("npm: %s" % " ".join(cmd))
        log("npm registry: %s" % (registry or "(跟随系统 npm 配置)"))
        log("npm cwd: %s" % cwd)
        if on_line is not None:
            on_line("$ npm install %s\nregistry: %s\ncwd: %s"
                    % (spec, registry or "系统默认", cwd))
        try:
            proc = subprocess.Popen(
                cmd,
                cwd=cwd,
                env=self._child_env(node_exe, registry),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                creationflags=CREATE_NO_WINDOW,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
        except OSError as exc:
            return False, "启动 npm 失败：%s" % exc
        # 记录句柄：用户在安装中途退出时，_shutdown 要能终止这个进程树，
        # 否则 node/npm 会残留在后台继续下载。
        self._npm_proc = proc

        # npm 在非 TTY 下会把输出攒着，加个心跳让界面别看起来像卡死
        stop_beat = threading.Event()
        last_output = [time.time()]
        started_at = time.time()

        def heartbeat():
            while not stop_beat.wait(2.0):
                if on_line is None:
                    continue
                if time.time() - last_output[0] < 4.0:
                    continue
                try:
                    on_line("[等待 npm 返回…] 已用时 %d 秒" % int(time.time() - started_at))
                except Exception:
                    pass

        beat_thread = threading.Thread(target=heartbeat, daemon=True)
        beat_thread.start()

        lines = []
        try:
            for raw in proc.stdout:
                line = raw.rstrip()
                if not line:
                    continue
                last_output[0] = time.time()
                lines.append(line)
                log("npm | %s" % line)
                if on_line is not None:
                    try:
                        on_line(line)
                    except Exception:
                        pass
                    lines = lines[-200:]
            code = proc.wait()
        except Exception as exc:  # noqa: BLE001
            return False, "npm 执行异常：%s" % exc
        finally:
            stop_beat.set()
            with self._lock:
                if self._npm_proc is proc:
                    self._npm_proc = None

        tail = "\n".join(lines[-25:]) if lines else "(npm 无输出)"
        if code != 0:
            log("npm 退出码 %s" % code)
            return False, tail
        return True, tail

    # ---------------- 启停 ---------------- #

    def start(self):
        with self._lock:
            if self.managed_running():
                return True
            node_exe = _timed("find_node()", find_node)
            if not node_exe:
                raise RuntimeError(
                    "未检测到 Node.js：产物内的 node/ 目录缺失，系统也未安装。"
                    "请重新获取完整发行包，或安装 Node.js 18+"
                )
            entry = _timed("entry_script()", self.entry_script)
            if not os.path.isfile(entry):
                raise RuntimeError("DeepSeek Harness 尚未安装完整：%s" % entry)

            self.web_url = None
            self._service_tail.clear()
            _rotate(SERVICE_LOG, time.strftime("%Y%m%d%H%M%S"))
            try:
                self._log_handle = open(SERVICE_LOG, "a", encoding="utf-8", errors="replace")
            except OSError:
                self._log_handle = None

            env = self._child_env(node_exe, effective_registry())

            # 注入启动加速补丁：见 fastboot_script() 上方的说明。
            # 补丁缺失或目标不存在时静默降级，按原样启动。
            cmd = [node_exe]
            patch = fastboot_script()
            target = client_modules_entry()
            if FASTBOOT_ENABLED and os.path.isfile(patch) and os.path.isfile(target):
                env["DSH_FASTBOOT_TARGET"] = file_url(target)
                if TIMING:
                    env["DSH_UI_FASTBOOT_VERBOSE"] = "1"
                cmd += ["--import", file_url(patch)]
                log("已注入启动加速补丁: %s" % patch)
            else:
                log(
                    "未注入启动加速补丁（enabled=%s 补丁=%s 目标=%s）"
                    % (FASTBOOT_ENABLED, os.path.isfile(patch), os.path.isfile(target))
                )

            # --no-open：别让 dsh 自己弹系统浏览器，界面交给本程序的 WebView2
            cmd += [entry, "web", "--no-open"]
            log("启动服务: %s (cwd=%s)" % (" ".join(cmd), WORKSPACE_DIR))
            self._proc = subprocess.Popen(
                cmd,
                cwd=WORKSPACE_DIR,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                creationflags=CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                close_fds=True,
            )
            log("服务进程 pid=%s" % self._proc.pid)
            threading.Thread(
                target=self._pump_output, args=(self._proc,), daemon=True
            ).start()
            return True

    def _pump_output(self, proc):
        """实时转存服务输出，并从中抓出带 token 的访问地址。"""
        try:
            for raw in proc.stdout:
                line = raw.rstrip()
                if not line:
                    continue
                self._service_tail.append(line)
                handle = self._log_handle
                if handle is not None:
                    try:
                        handle.write(line + "\n")
                        handle.flush()
                    except (OSError, ValueError):
                        pass
                match = TOKEN_URL_RE.search(line)
                if match:
                    self.web_url = match.group(1)
                    log("捕获到带 token 的访问地址")
        except Exception as exc:  # noqa: BLE001
            log("读取服务输出异常: %s" % exc)

    def stop_npm_install(self):
        """终止还在跑的 npm 进程树（首装/下载中途取消，或用户中途退出时调用）。"""
        with self._lock:
            proc = self._npm_proc
            self._npm_proc = None
        if proc is not None and proc.poll() is None:
            log("终止进行中的 npm 安装 pid=%s" % proc.pid)
            _timed("taskkill npm 安装进程树", kill_tree, proc.pid)

    def stop(self, wait_release=10.0):
        """停掉服务：先收自己拉起的进程，再兜底清掉占用端口的残留 node。

        判断"端口上还有没有服务在听"一律走 pids_on_port()，不要用 TCP connect 探活：
        进程刚被 taskkill 掉的那一瞬间，connect 既连不上也收不到拒绝，会一直卡到
        timeout（0.5s）才返回，比读一次系统 TCP 表慢三个数量级。
        """
        with self._lock:
            proc = self._proc
            self._proc = None
            handle = self._log_handle
            self._log_handle = None

        if proc is not None and proc.poll() is None:
            log("停止服务 pid=%s" % proc.pid)
            _timed("taskkill 服务进程树", kill_tree, proc.pid)

        deadline = time.time() + wait_release
        released = False
        while True:
            stale = _timed("查端口占用进程", pids_on_port)
            if not stale:
                released = True
                break
            for pid in stale:
                log("清理占用 %d 端口的残留进程 pid=%s" % (PORT, pid))
                _timed("taskkill 残留 pid=%s" % pid, kill_tree, pid)
            if time.time() >= deadline:
                break
            time.sleep(0.1)
        mark("端口已释放（stop 结束，released=%s）" % released)

        if handle is not None:
            try:
                handle.close()
            except Exception:
                pass

        self.web_url = None

        if not released:
            log("警告：端口 %d 仍被占用" % PORT)
            return False
        return True

    def wait_ready(self, timeout=240.0, should_abort=None, poll_log=None):
        """等服务起来：既要端口通，也要拿到带 token 的访问地址。"""
        start_at = time.time()
        announced = False
        while time.time() - start_at < timeout:
            if should_abort is not None and should_abort():
                return False
            alive = http_alive()
            if self.web_url and alive:
                return True
            with self._lock:
                proc = self._proc
            if proc is not None and proc.poll() is not None:
                log("服务进程已退出，exit=%s" % proc.returncode)
                if poll_log is not None:
                    poll_log(self.read_service_tail())
                return False
            # 端口通了但还没打印出 token 时，给个提示
            if not announced and alive:
                announced = True
                log("端口已就绪，等待 dsh 输出访问地址")
            # 小步快跑：dsh 打印 token 之后最多再等 0.15s 就能接上，
            # 原来 0.4s 的粒度会白等掉两三百毫秒
            time.sleep(0.15)
        return False

    def read_service_tail(self, lines=12):
        if self._service_tail:
            return "\n".join(list(self._service_tail)[-lines:])
        try:
            with open(SERVICE_LOG, "r", encoding="utf-8", errors="replace") as fh:
                content = fh.read()
            return "\n".join(content.strip().splitlines()[-lines:])
        except OSError:
            return ""


# --------------------------------------------------------------------------- #
# 启动页
# --------------------------------------------------------------------------- #

# 启动期窗口里必须有个页面给 WebView2，但用户看的是原生 loading 那层，
# 所以这里只放一个和窗口同色的空白页（原生层出问题时也不会闪白）。
BLANK_HTML = """<!doctype html>
<html><head><meta charset="utf-8"><title>DeepSeek Harness</title>
<style>html,body{margin:0;height:100%;background:#f4f6fb}</style></head>
<body></body></html>
"""


MANAGER_HTML = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>插件管理器</title>
<style>
  :root {
    --bg: #f4f6fb;
    --panel: #ffffff;
    --panel2: #f7f9fe;
    --line: rgba(22, 32, 58, .10);
    --fg: #1b2130;
    --dim: #6b7488;
    --accent: #4d6bfe;
    --on: #119e6a;
    --off: #d63c4c;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg); color: var(--fg);
    font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    font-size: 13px; display: flex; flex-direction: column;
    -webkit-user-select: none; user-select: none;
  }
  header { padding: 18px 22px 12px; border-bottom: 1px solid var(--line); background: var(--panel); }
  h1 { margin: 0 0 6px; font-size: 16px; font-weight: 600; letter-spacing: .2px; }
  .paths { font-size: 11px; color: var(--dim); line-height: 1.7; word-break: break-all; }
  .paths b { color: #47506a; font-weight: 500; }
  main { flex: 1; overflow-y: auto; padding: 14px 18px 18px; }
  .row {
    display: flex; align-items: flex-start; gap: 14px;
    padding: 13px 15px; margin-bottom: 10px;
    background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
    box-shadow: 0 1px 2px rgba(22, 32, 58, .04);
    transition: border-color .15s ease, background .15s ease;
  }
  .row:hover { background: var(--panel2); }
  .row.broken { border-color: rgba(214, 60, 76, .38); }
  .led {
    flex: 0 0 auto; width: 26px; height: 26px; margin-top: 2px; padding: 0;
    border: none; border-radius: 50%; cursor: pointer; position: relative;
    background: #e6eaf4; transition: background .18s ease, box-shadow .18s ease;
  }
  .led::after {
    content: ''; position: absolute; inset: 7px; border-radius: 50%;
    background: #b6bed2; transition: background .18s ease;
  }
  .led.on { background: rgba(17, 158, 106, .14); box-shadow: 0 0 0 1px rgba(17, 158, 106, .40), 0 0 12px rgba(17, 158, 106, .18); }
  .led.on::after { background: var(--on); }
  .led.off { background: rgba(214, 60, 76, .10); box-shadow: 0 0 0 1px rgba(214, 60, 76, .32); }
  .led.off::after { background: var(--off); }
  .led:hover { filter: brightness(.96); }
  .meta { flex: 1; min-width: 0; }
  .title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .title .name { font-size: 13.5px; font-weight: 600; }
  .title .id { font-size: 11px; color: var(--dim); font-family: Consolas, monospace; }
  .chip {
    font-size: 10.5px; padding: 1px 7px; border-radius: 999px;
    border: 1px solid var(--line); color: var(--dim);
  }
  .state-on { color: var(--on); border-color: rgba(17, 158, 106, .38); }
  .state-off { color: var(--off); border-color: rgba(214, 60, 76, .3); }
  .third { color: #8a5a00; border-color: rgba(166, 102, 0, .38); background: rgba(255, 244, 214, .5); }
  .desc { margin-top: 6px; font-size: 12px; color: #5b6478; line-height: 1.65; }
  .warn { margin-top: 6px; font-size: 11.5px; color: #a8660d; line-height: 1.6; }
  .empty { color: var(--dim); text-align: center; padding: 40px 10px; line-height: 1.8; }
  footer {
    border-top: 1px solid var(--line); padding: 12px 18px 14px;
    background: #eef1f8;
  }
  .acts { display: flex; align-items: center; gap: 10px; }
  button.primary {
    background: linear-gradient(135deg, #4d6bfe 0%, #3a54d8 100%);
    color: #fff; border: none; border-radius: 9px; padding: 9px 18px;
    font-size: 13px; font-weight: 600; cursor: pointer;
  }
  button.primary:hover { filter: brightness(1.08); }
  button.primary:disabled { opacity: .5; cursor: default; filter: none; }
  button.ghost {
    background: #fff; color: var(--dim); border: 1px solid var(--line);
    border-radius: 8px; padding: 7px 12px; font-size: 12px; cursor: pointer;
  }
  button.ghost:hover { color: var(--fg); border-color: rgba(22, 32, 58, .26); }
  #status { margin-top: 10px; font-size: 12px; color: var(--dim); min-height: 18px; line-height: 1.6; }
  #status.busy { color: #a8660d; }
  #status.ok { color: var(--on); }
  #status.err { color: var(--off); }
</style>
</head>
<body>
  <header>
    <h1>插件管理器</h1>
    <div class="paths">
      插件目录 <b id="p-plugins">…</b><br>
      第三方插件目录 <b id="p-third">…</b><br>
      dsh 目录 <b id="p-dsh">…</b>
    </div>
  </header>
  <main id="list"><div class="empty">正在读取…</div></main>
  <footer>
    <div class="acts">
      <button class="primary" id="restart">重启服务并生效</button>
      <button class="ghost" id="open-plugins">打开插件目录</button>
      <button class="ghost" id="open-third">打开第三方插件目录</button>
      <button class="ghost" id="open-dsh">打开 dsh 目录</button>
      <button class="ghost" id="open-log">查看日志</button>
    </div>
    <div id="status">绿色＝启用，红色＝关闭。改动后需要重启服务才会生效。</div>
  </footer>
<script>
  var api = null;
  var last = null;

  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setStatus(text, kind) {
    var el = document.getElementById('status');
    el.textContent = text || '';
    el.className = kind || '';
  }

  function render(state) {
    document.getElementById('p-plugins').textContent = state.pluginsDir || '(无)';
    document.getElementById('p-third').textContent = state.thirdPartyPluginsDir || '(无)';
    document.getElementById('p-dsh').textContent = state.dshHome || '(无)';

    var list = document.getElementById('list');
    if (!state.plugins || state.plugins.length === 0) {
      list.innerHTML = '<div class="empty">插件目录里还没有插件包。<br>'
        + '每个插件是一个子目录，里面要有 manifest.json、入口 .mjs 和 patch 片段。<br>'
        + '第三方插件放在「第三方插件目录」（不进版本库），同样会被扫描加载。</div>';
    } else {
      list.innerHTML = state.plugins.map(function (p) {
        var cls = 'led ' + (p.enabled ? 'on' : 'off');
        var chip = p.enabled
          ? '<span class="chip state-on">已启用</span>'
          : '<span class="chip state-off">已关闭</span>';
        var third = p.thirdParty ? '<span class="chip third">第三方</span>' : '';
        var inst = p.installed ? '<span class="chip">已装入 dsh</span>' : '';
        var ver = p.version ? '<span class="chip">v' + esc(p.version) + '</span>' : '';
        var warn = p.error ? '<div class="warn">⚠ ' + esc(p.error) + '</div>' : '';
        if (!p.usable && !p.error) warn = '<div class="warn">本平台不适用，已跳过</div>';
        return '<div class="row' + (p.error ? ' broken' : '') + '">'
          + '<button class="' + cls + '" data-id="' + esc(p.id) + '" data-on="' + (p.enabled ? '1' : '0') + '" title="点击切换"></button>'
          + '<div class="meta">'
          + '<div class="title"><span class="name">' + esc(p.name) + '</span>'
          + '<span class="id">' + esc(p.id) + '</span>' + third + ver + chip + inst + '</div>'
          + (p.description ? '<div class="desc">' + esc(p.description) + '</div>' : '')
          + warn
          + '</div></div>';
      }).join('');
      Array.prototype.forEach.call(list.querySelectorAll('.led'), function (led) {
        led.addEventListener('click', function () {
          toggle(led.getAttribute('data-id'), led.getAttribute('data-on') !== '1');
        });
      });
    }

    var btn = document.getElementById('restart');
    btn.disabled = !!state.busy;
    if (state.status) {
      setStatus(state.status, state.busy ? 'busy' : (state.error ? 'err' : ''));
    }
    last = state;
  }

  function refresh() {
    if (!api) return;
    return api.state().then(render).catch(function (error) {
      setStatus('读取状态失败：' + error, 'err');
    });
  }

  function toggle(id, enabled) {
    if (!api) return;
    setStatus((enabled ? '正在启用 ' : '正在关闭 ') + id + '…', 'busy');
    api.toggle(id, enabled).then(function (state) {
      render(state);
      setStatus(id + (enabled ? ' 已启用' : ' 已关闭') + '，点「重启服务并生效」让它生效。', '');
    }).catch(function (error) {
      setStatus('切换失败：' + error, 'err');
    });
  }

  function restart() {
    if (!api) return;
    document.getElementById('restart').disabled = true;
    setStatus('正在同步插件并重启服务…', 'busy');
    api.restart().then(function (started) {
      if (!started) setStatus('已有任务在执行，等它跑完再试。', 'err');
    }).catch(function (error) {
      setStatus('重启失败：' + error, 'err');
      document.getElementById('restart').disabled = false;
    });
  }

  function bind() {
    document.getElementById('restart').addEventListener('click', restart);
    document.getElementById('open-plugins').addEventListener('click', function () { api.open_plugins_dir(); });
    document.getElementById('open-third').addEventListener('click', function () { api.open_third_party_plugins_dir(); });
    document.getElementById('open-dsh').addEventListener('click', function () { api.open_dsh_dir(); });
    document.getElementById('open-log').addEventListener('click', function () { api.open_log(); });
  }

  window.addEventListener('pywebviewready', function () {
    api = window.pywebview.api;
    bind();
    refresh();
    setInterval(refresh, 1500);
  });
</script>
</body>
</html>
"""


# 版本管理器窗口：预览远端最近 N 个版本（含 alpha）、下载到独立槽位、
# 确认后切换（自动重启应用）、删除多余槽位。样式沿用 MANAGER_HTML 的亮色主题。
VERSION_MANAGER_HTML = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>版本管理器</title>
<style>
  :root {
    --bg: #f4f6fb;
    --panel: #ffffff;
    --panel2: #f7f9fe;
    --line: rgba(22, 32, 58, .10);
    --fg: #1b2130;
    --dim: #6b7488;
    --accent: #4d6bfe;
    --on: #119e6a;
    --off: #d63c4c;
    --warn: #a8660d;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: var(--bg); color: var(--fg);
    font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    font-size: 13px; display: flex; flex-direction: column;
    -webkit-user-select: none; user-select: none;
  }
  header {
    padding: 16px 22px 12px; border-bottom: 1px solid var(--line);
    background: var(--panel); display: flex; align-items: flex-start; gap: 14px;
  }
  header .head { flex: 1; min-width: 0; }
  h1 { margin: 0 0 6px; font-size: 16px; font-weight: 600; letter-spacing: .2px; }
  .paths { font-size: 11px; color: var(--dim); line-height: 1.7; word-break: break-all; }
  .paths b { color: #47506a; font-weight: 500; }
  .paths select {
    font: inherit; font-size: 11px; color: #47506a;
    border: 1px solid var(--line); border-radius: 6px;
    background: var(--panel2); padding: 1px 5px; cursor: pointer;
    max-width: 220px;
  }
  .paths select:hover { border-color: rgba(22, 32, 58, .26); }
  .hbtns { display: flex; gap: 8px; flex: 0 0 auto; flex-wrap: wrap; justify-content: flex-end; max-width: 46%; }
  .quota {
    display: none; align-items: center; gap: 10px;
    margin: 12px 18px 0; padding: 9px 13px;
    background: rgba(255, 244, 214, .7); border: 1px solid rgba(166, 102, 0, .38);
    border-radius: 10px; color: #8a5a00; font-size: 12px; line-height: 1.6;
  }
  .quota.show { display: flex; }
  .quota button {
    margin-left: auto; flex: 0 0 auto;
    background: #fff; color: #8a5a00; border: 1px solid rgba(166, 102, 0, .45);
    border-radius: 8px; padding: 5px 12px; font-size: 12px; cursor: pointer;
  }
  .quota button:hover { background: #fff8e8; }
  main { flex: 1; overflow-y: auto; padding: 12px 18px 16px; }
  .bk-title {
    display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
    margin: 18px 2px 8px; font-size: 12.5px; font-weight: 600; color: #47506a;
  }
  .bk-title .hint { font-weight: 400; font-size: 11px; color: var(--dim); }
  .bk-title .open { margin-left: auto; }
  .row {
    display: flex; align-items: flex-start; gap: 14px;
    padding: 12px 15px; margin-bottom: 10px;
    background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
    box-shadow: 0 1px 2px rgba(22, 32, 58, .04);
    transition: border-color .15s ease, background .15s ease;
  }
  .row:hover { background: var(--panel2); }
  .row.active { border-color: rgba(77, 107, 254, .45); box-shadow: 0 0 0 1px rgba(77, 107, 254, .18); }
  .row.downloading { border-color: rgba(17, 158, 106, .45); }
  .meta { flex: 1; min-width: 0; }
  .title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .title .ver { font-size: 13.5px; font-weight: 600; font-family: Consolas, monospace; }
  .chip {
    font-size: 10.5px; padding: 1px 7px; border-radius: 999px;
    border: 1px solid var(--line); color: var(--dim); background: var(--panel2);
    white-space: nowrap;
  }
  .chip.on-now { color: var(--accent); border-color: rgba(77, 107, 254, .45); background: rgba(77, 107, 254, .10); }
  .chip.have { color: var(--on); border-color: rgba(17, 158, 106, .38); background: rgba(17, 158, 106, .08); }
  .chip.stable { color: var(--on); border-color: rgba(17, 158, 106, .35); }
  .chip.alpha, .chip.beta, .chip.rc, .chip.next, .chip.canary {
    color: #8a5a00; border-color: rgba(166, 102, 0, .42); background: rgba(255, 244, 214, .6);
  }
  .sub { margin-top: 5px; font-size: 11.5px; color: var(--dim); line-height: 1.6; }
  .acts { display: flex; gap: 8px; flex: 0 0 auto; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
  button.primary {
    background: linear-gradient(135deg, #4d6bfe 0%, #3a54d8 100%);
    color: #fff; border: none; border-radius: 8px; padding: 7px 15px;
    font-size: 12.5px; font-weight: 600; cursor: pointer;
  }
  button.primary:hover { filter: brightness(1.08); }
  button.ghost {
    background: #fff; color: var(--dim); border: 1px solid var(--line);
    border-radius: 8px; padding: 6px 12px; font-size: 12px; cursor: pointer;
  }
  button.ghost:hover { color: var(--fg); border-color: rgba(22, 32, 58, .26); }
  button.danger { color: var(--off); }
  button:disabled { opacity: .45; cursor: default; pointer-events: none; }
  .progress {
    margin-top: 8px; padding: 8px 10px; border-radius: 8px;
    background: rgba(77, 107, 254, .06); border: 1px solid rgba(77, 107, 254, .18);
    font-size: 11.5px; color: #47506a; line-height: 1.6;
  }
  .progress .bar {
    height: 4px; margin: 6px 0; border-radius: 999px; overflow: hidden;
    background: rgba(77, 107, 254, .15);
  }
  .progress .bar i {
    display: block; height: 100%; width: 40%;
    background: linear-gradient(90deg, #4d6bfe, #7a90ff, #4d6bfe);
    background-size: 200% 100%; animation: slide 1.2s linear infinite;
  }
  @keyframes slide { from { background-position: 0 0; } to { background-position: 200% 0; } }
  .progress .tail { font-family: Consolas, monospace; color: var(--dim); word-break: break-all; }
  .empty { color: var(--dim); text-align: center; padding: 40px 10px; line-height: 1.9; }
  footer {
    border-top: 1px solid var(--line); padding: 10px 18px 12px;
    background: #eef1f8; font-size: 12px; color: var(--dim); line-height: 1.6;
  }
  #status.busy { color: var(--warn); }
  #status.ok { color: var(--on); }
  #status.err { color: var(--off); }
  /* 窗口内确认框（不是系统弹窗）：所有切换都必须先过它 */
  #mask {
    display: none; position: fixed; inset: 0; z-index: 20;
    background: rgba(22, 32, 58, .38); align-items: center; justify-content: center;
  }
  #mask.show { display: flex; }
  #dialog {
    width: 420px; max-width: 90%; background: #fff; border-radius: 14px;
    padding: 20px 22px 16px; box-shadow: 0 12px 40px rgba(22, 32, 58, .25);
  }
  #dialog h2 { margin: 0 0 10px; font-size: 15px; }
  #dialog .body { font-size: 12.5px; color: #47506a; line-height: 1.8; }
  #dialog .body b { font-family: Consolas, monospace; }
  /* 恢复「非当前版本」备份时的红字提醒 */
  #dialog .body .dlg-warn {
    margin-top: 10px; padding: 9px 11px; border-radius: 8px;
    background: rgba(214, 60, 76, .08); border: 1px solid rgba(214, 60, 76, .35);
    color: var(--off); font-weight: 600; line-height: 1.7;
  }
  #dialog .btns { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
  /* 重启遮罩 */
  #restarting {
    display: none; position: fixed; inset: 0; z-index: 30;
    background: rgba(244, 246, 251, .96); flex-direction: column;
    align-items: center; justify-content: center; gap: 14px; color: var(--dim);
  }
  #restarting.show { display: flex; }
  #restarting .big { font-size: 15px; color: var(--fg); font-weight: 600; }
  .spin {
    width: 26px; height: 26px; border-radius: 50%;
    border: 3px solid rgba(77, 107, 254, .2); border-top-color: var(--accent);
    animation: turn .8s linear infinite;
  }
  @keyframes turn { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <header>
    <div class="head">
      <h1>版本管理器</h1>
      <div class="paths">
        当前版本 <b id="p-installed">…</b>
        ｜服务 <b id="p-running">…</b><br>
        活动槽位 <b id="p-slots">…</b><br>
        配置目录 <b id="p-home">…</b><br>
        npm 源 <select id="p-registry" title="下载 / 检查更新走哪个源；托盘不再提供换源入口"></select>
        ｜已下载 <b id="p-count">…</b>｜共占用 <b id="p-size">…</b>
      </div>
    </div>
    <div class="hbtns">
      <button class="ghost" id="btn-refresh">刷新</button>
      <button class="ghost" id="btn-backup" title="把当前版本的配置打包存到 backups/manual（最多保留 10 份）">备份配置</button>
      <button class="ghost" id="btn-home-dir" title="打开当前版本的配置目录（删掉的版本想清配置也从这里进）">打开配置目录</button>
      <button class="ghost" id="btn-slots-dir">打开槽位目录</button>
    </div>
  </header>

  <div class="quota" id="quota">
    <span id="quota-text">…</span>
    <button id="btn-clean">去清理</button>
  </div>

  <main>
    <div id="list"><div class="empty">正在读取…</div></div>

    <div class="bk-title">
      <span>配置备份</span>
      <span class="hint" id="bk-hint">切换版本前会自动备一份；手动备份两个池子各留最近 10 份</span>
      <button class="ghost open" id="btn-backups-dir">打开备份目录</button>
    </div>
    <div id="bk-list"><div class="empty">还没有备份</div></div>
  </main>

  <footer>
    <span id="status">下载会进独立文件夹，互不覆盖；切换前会先确认，确认后自动重启应用并自动备份旧版本的配置。</span>
  </footer>

  <div id="mask">
    <div id="dialog">
      <h2 id="dlg-title">确认切换</h2>
      <div class="body" id="dlg-body"></div>
      <div class="btns">
        <button class="ghost" id="dlg-cancel">取消</button>
        <button class="primary" id="dlg-ok">切换并重启</button>
      </div>
    </div>
  </div>

  <div id="restarting">
    <div class="spin"></div>
    <div class="big">正在重启应用…</div>
    <div>新实例会按所选版本启动，稍候片刻。</div>
  </div>

<script>
  var api = null;
  var last = null;
  var pendingSwitch = null;      // 确认框里待切换的版本
  var pendingRemove = null;      // 确认框里待删除的版本
  var pendingRestore = null;     // 确认框里待恢复的备份名
  var pendingDeleteBk = null;    // 确认框里待删除的备份名
  var restarting = false;
  var homeDirs = {};             // 版本 -> 配置目录（homes/<版本>）

  var CHANNELS = {
    stable: '稳定', alpha: 'alpha', beta: 'beta', rc: 'rc',
    next: 'next', canary: 'canary'
  };

  function esc(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setStatus(text, kind) {
    var el = document.getElementById('status');
    el.textContent = text || '';
    el.className = kind || '';
  }

  function fmtDate(iso) {
    if (typeof iso === 'number' && iso > 0) {       // 毫秒时间戳
      try { return new Date(iso).toISOString().slice(0, 10); } catch (e) { return ''; }
    }
    var s = String(iso || '');
    return s ? s.slice(0, 10) : '';
  }

  function fmtMB(mb) {
    if (mb == null) return '';
    if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
    return mb + ' MB';
  }

  function fmtTime(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function channelChip(row) {
    var ch = row.channel || 'stable';
    var label = CHANNELS[ch] || ch;
    return '<span class="chip ' + esc(ch) + '">' + esc(label) + '</span>';
  }

  function rowHtml(row, state) {
    var busy = !!state.busy;
    var task = state.task;
    var cls = 'row' + (row.active ? ' active' : '');
    var downloading = task && task.running && task.version === row.version;
    if (downloading) cls += ' downloading';

    var chips = channelChip(row);
    if (row.active) chips += '<span class="chip on-now">当前使用</span>';
    if (row.installed && !row.active) chips += '<span class="chip have">已下载 ' + fmtMB(row.sizeMB) + '</span>';
    if (!row.installed) chips += '<span class="chip">未下载</span>';
    if (row.source === 'local-only') chips += '<span class="chip">仅本机</span>';

    var sub = [];
    if (row.publishedAt) sub.push('发布于 ' + fmtDate(row.publishedAt));
    if (row.installed && row.sizeMB != null) sub.push(fmtMB(row.sizeMB));

    var acts = '';
    if (downloading) {
      acts = '<button class="ghost" data-act="cancel" data-ver="' + esc(row.version) + '"' + (busy ? '' : ' disabled') + '>取消</button>';
    } else if (!row.installed) {
      acts = '<button class="primary" data-act="download" data-ver="' + esc(row.version) + '"' + (busy ? ' disabled' : '') + '>下载</button>';
    } else {
      if (!row.active) {
        acts += '<button class="primary" data-act="switch" data-ver="' + esc(row.version) + '"' + (busy ? ' disabled' : '') + '>切换</button>';
        acts += '<button class="ghost danger" data-act="remove" data-ver="' + esc(row.version) + '"' + (busy ? ' disabled' : '') + '>删除</button>';
      }
      acts += '<button class="ghost" data-act="dir" data-ver="' + esc(row.version) + '">打开目录</button>';
      // 配置目录按版本分开存（homes/<版本>）；删掉槽位它也还在，就靠这个按钮进去清
      if (homeDirs[row.version]) {
        acts += '<button class="ghost" data-act="home" data-ver="' + esc(row.version) + '"'
          + ' title="' + esc(homeDirs[row.version]) + '">配置目录</button>';
      }
    }

    var progress = '';
    if (downloading) {
      var tail = (task.tail && task.tail.length) ? task.tail[task.tail.length - 1] : '';
      progress = '<div class="progress">'
        + '<span>' + esc(task.phase || '下载中') + ' · 已用时 ' + (task.elapsed || 0) + ' 秒</span>'
        + '<div class="bar"><i></i></div>'
        + '<div class="tail">' + esc(tail) + '</div>'
        + '</div>';
    }

    return '<div class="' + cls + '" data-row="' + esc(row.version) + '">'
      + '<div class="meta">'
      + '<div class="title"><span class="ver">' + esc(row.version) + '</span>' + chips + '</div>'
      + (sub.length ? '<div class="sub">' + esc(sub.join(' ｜ ')) + '</div>' : '')
      + progress
      + '</div>'
      + '<div class="acts">' + acts + '</div>'
      + '</div>';
  }

  // npm 源下拉框：选项来自 state.registryChoices + 跟随系统；
  // 配置里存着自定义源时也补一个选项，保证当前值始终选得中。
  function fillRegistry(state) {
    var sel = document.getElementById('p-registry');
    if (!sel) return;
    var choices = (state.registryChoices || []).slice();
    var url = state.registryUrl || '';
    if (url && !choices.some(function (c) { return c.url === url; })) {
      choices.push({ label: state.registry || url, url: url });
    }
    choices.push({ label: '跟随系统', url: '' });
    var sig = choices.map(function (c) { return c.url + '' + c.label; }).join('');
    if (sel.getAttribute('data-sig') !== sig) {
      sel.innerHTML = choices.map(function (c) {
        return '<option value="' + esc(c.url) + '">' + esc(c.label) + '</option>';
      }).join('');
      sel.setAttribute('data-sig', sig);
    }
    if (sel.value !== url) sel.value = url;
  }

  // 备份行：名字 / 来源（自动·切换前 / 手动）/ 版本 / 时间 / 大小 + 恢复·删除
  function backupRowHtml(bk, state) {
    var busy = !!state.busy;
    var chipCls = bk.kind === 'manual' ? 'have' : '';
    var chipTxt = bk.kind === 'manual' ? '手动' : '切换前自动';
    return '<div class="row" data-backup="' + esc(bk.name) + '">'
      + '<div class="meta">'
      + '<div class="title"><span class="ver">' + esc(bk.name) + '</span>'
      + '<span class="chip ' + chipCls + '">' + chipTxt + '</span>'
      + '<span class="chip">' + esc(bk.version) + '</span></div>'
      + '<div class="sub">' + esc(fmtTime(bk.at)) + ' ｜ ' + fmtMB(bk.sizeMB) + '</div>'
      + '</div>'
      + '<div class="acts">'
      + '<button class="primary" data-act="restore-bk" data-name="' + esc(bk.name) + '"' + (busy ? ' disabled' : '') + '>恢复</button>'
      + '<button class="ghost danger" data-act="delete-bk" data-name="' + esc(bk.name) + '"' + (busy ? ' disabled' : '') + '>删除</button>'
      + '</div>'
      + '</div>';
  }

  function render(state) {
    last = state;
    document.getElementById('p-installed').textContent = state.installedVersion || '未安装';
    document.getElementById('p-running').textContent = state.serviceRunning ? '运行中' : '已停止';
    document.getElementById('p-slots').textContent = state.activeSlotDir || '(未安装)';
    document.getElementById('p-home').textContent = state.homeDir || '(未安装)';
    fillRegistry(state);
    document.getElementById('p-count').textContent = state.slotCount + ' 个（上限 ' + state.maxSlots + '）';
    document.getElementById('p-size').textContent = fmtMB(state.totalSizeMB) || '0 MB';

    // 版本 -> 配置目录（行里的「配置目录」按钮靠它判断在不在）
    homeDirs = {};
    (state.homes || []).forEach(function (h) { homeDirs[h.version] = h.dir; });

    // 超限：只提示（非弹窗），带跳转按钮方便清理
    var quota = document.getElementById('quota');
    if (state.slotCount > state.maxSlots) {
      document.getElementById('quota-text').textContent =
        '已下载 ' + state.slotCount + ' 个版本（上限 ' + state.maxSlots + '），共占用 '
        + fmtMB(state.totalSizeMB) + '，建议清理不再需要的版本 —— 每个版本约 220 MB。';
      quota.classList.add('show');
    } else {
      quota.classList.remove('show');
    }

    var list = document.getElementById('list');
    if (!state.versions || state.versions.length === 0) {
      list.innerHTML = '<div class="empty">还没有可展示的版本。<br>'
        + (state.checking ? '正在检查更新…' : '点右上角「刷新」拉取远端版本列表（含 alpha）。')
        + '</div>';
    } else {
      list.innerHTML = state.versions.map(function (row) { return rowHtml(row, state); }).join('');
      Array.prototype.forEach.call(list.querySelectorAll('button[data-act]'), function (btn) {
        btn.addEventListener('click', function () {
          onAction(btn.getAttribute('data-act'), btn.getAttribute('data-ver'),
                   btn.getAttribute('data-name'));
        });
      });
    }

    var refreshBtn = document.getElementById('btn-refresh');
    refreshBtn.disabled = !!state.checking;
    refreshBtn.textContent = state.checking ? '检查中…' : '刷新';

    // ---- 配置备份清单 ----
    var hint = document.getElementById('bk-hint');
    if (hint) {
      hint.textContent = '切换前会自动备份；自动 / 手动两个池子各留最近 '
        + (state.backupRetention || 10) + ' 份'
        + (state.backupSizeMB ? '，共占 ' + fmtMB(state.backupSizeMB) : '')
        + '（存 backups 下，删配置前先想清楚）';
    }
    var bkList = document.getElementById('bk-list');
    if (bkList) {
      var bks = state.backups || [];
      if (bks.length === 0) {
        bkList.innerHTML = '<div class="empty">还没有备份 —— 点右上角「备份配置」手动存一份。</div>';
      } else {
        bkList.innerHTML = bks.map(function (bk) { return backupRowHtml(bk, state); }).join('');
        Array.prototype.forEach.call(bkList.querySelectorAll('button[data-act]'), function (btn) {
          btn.addEventListener('click', function () {
            onAction(btn.getAttribute('data-act'), btn.getAttribute('data-ver'),
                     btn.getAttribute('data-name'));
          });
        });
      }
    }

    var text = state.status || '';
    var kind = state.error ? 'err' : (state.busy ? 'busy' : '');
    if (!text) {
      text = '配置按版本分开存（homes/<版本>）；切换前自动备份旧配置，最多各留 10 份。';
    } else if (state.busy) {
      kind = 'busy';
    } else if (!state.error) {
      kind = 'ok';
    }
    if (state.remoteStale && (state.versions || []).length) {
      text += '（离线缓存' + (state.remoteCheckedAt ? ' · ' + fmtDate(state.remoteCheckedAt * 1000) : '') + '）';
    } else if (!state.remoteOk && state.remoteError) {
      text += '（远端列表不可用：' + state.remoteError + '）';
    }
    setStatus(text, kind);
  }

  function onAction(act, ver, name) {
    if (!api) return;
    if (act === 'download') {
      setStatus('开始下载 dsh ' + ver + '…', 'busy');
      api.download(ver).then(function (res) {
        if (!res.ok) setStatus(res.error || '下载失败', 'err');
      }).catch(function (error) { setStatus('下载失败：' + error, 'err'); });
    } else if (act === 'switch') {
      openSwitchConfirm(ver);
    } else if (act === 'remove') {
      openRemoveConfirm(ver);
    } else if (act === 'cancel') {
      api.cancel();
    } else if (act === 'dir') {
      api.open_slot_dir(ver);
    } else if (act === 'home') {
      api.open_home_dir(ver);
    } else if (act === 'restore-bk') {
      openRestoreConfirm(name);
    } else if (act === 'delete-bk') {
      openDeleteBackupConfirm(name);
    }
  }

  // ---- 窗口内确认框（所有切换都必须先确认） ----
  function openSwitchConfirm(ver) {
    pendingSwitch = ver;
    document.getElementById('dlg-title').textContent = '确认切换版本';
    document.getElementById('dlg-body').innerHTML =
      '确定切换到 <b>' + esc(ver) + '</b> 吗？<br>'
      + '切换将<b>自动重启应用</b>（本地服务会中断几秒）。<br>'
      + '重启前会<b>先停服务、自动备份</b>当前版本的配置（backups/auto，留 10 份）；'
      + '新版本的配置目录不存在时会从当前这份复制一个副本。<br>'
      + '预发布（alpha/beta）版本可能与现有会话数据不兼容，动手前也可以先点'
      + '「备份配置」手动存一份。';
    document.getElementById('dlg-ok').textContent = '切换并重启';
    document.getElementById('mask').classList.add('show');
  }

  function openRemoveConfirm(ver) {
    pendingRemove = ver;
    document.getElementById('dlg-title').textContent = '确认删除';
    document.getElementById('dlg-body').innerHTML =
      '确定删除已下载的 <b>' + esc(ver) + '</b> 吗？<br>'
      + '这会连同它的依赖一起删掉（释放约 220 MB），以后要用得重新下载。<br>'
      + '它的<b>配置目录不会被删</b>，想清掉就用列表里那一行的「配置目录」按钮进去手工删。';
    document.getElementById('dlg-ok').textContent = '删除';
    document.getElementById('mask').classList.add('show');
  }

  function openRestoreConfirm(name) {
    pendingRestore = name;
    // 备份属于哪个版本：从备份清单里按名字找（backupRowHtml 渲染时带 version）
    var bkVer = '';
    (last && last.backups || []).forEach(function (bk) {
      if (bk.name === name) bkVer = bk.version;
    });
    var curVer = last ? (last.installedVersion || '') : '';
    var isCurrent = bkVer && curVer && bkVer === curVer;
    document.getElementById('dlg-title').textContent = '确认恢复配置';
    document.getElementById('dlg-body').innerHTML =
      '确定用备份 <b>' + esc(name) + '</b> 覆盖配置吗？<br>'
      + '恢复前会<b>先把当前配置自动备份一次</b>（不会丢现在的状态）。<br>'
      + (isCurrent
        ? '恢复的是当前活动版本，会<b>停服务 → 恢复 → 重启服务</b>。'
        : '恢复的是<b>别的版本</b>（' + esc(bkVer || '?') + '），'
          + '要等切到那个版本才生效；当前版本（' + esc(curVer || '?') + '）的配置不受影响。')
      + (isCurrent ? '' : '<div class="dlg-warn">⚠ 注意：这份备份属于 '
        + esc(bkVer || '?') + '，不是当前版本 ' + esc(curVer || '?')
        + '。恢复后需切换到 ' + esc(bkVer || '?') + ' 才能看到效果，'
        + '且不会改动当前版本的配置。</div>');
    document.getElementById('dlg-ok').textContent = '恢复';
    document.getElementById('mask').classList.add('show');
  }

  function openDeleteBackupConfirm(name) {
    pendingDeleteBk = name;
    document.getElementById('dlg-title').textContent = '确认删除备份';
    document.getElementById('dlg-body').innerHTML =
      '确定删除备份 <b>' + esc(name) + '</b> 吗？<br>'
      + '删掉就找不回来了，只能靠池子里剩下的其它备份。';
    document.getElementById('dlg-ok').textContent = '删除备份';
    document.getElementById('mask').classList.add('show');
  }

  function closeDialog() {
    pendingSwitch = null;
    pendingRemove = null;
    pendingRestore = null;
    pendingDeleteBk = null;
    document.getElementById('mask').classList.remove('show');
  }

  function confirmDialog() {
    if (pendingSwitch) {
      var ver = pendingSwitch;
      closeDialog();
      setStatus('正在切换到 dsh ' + ver + '…（先备份配置）', 'busy');
      api.switch(ver).then(function (res) {
        if (!res.ok) { setStatus(res.error || '切换失败', 'err'); return; }
        restarting = true;
        document.getElementById('restarting').classList.add('show');
      }).catch(function (error) { setStatus('切换失败：' + error, 'err'); });
    } else if (pendingRemove) {
      var target = pendingRemove;
      closeDialog();
      setStatus('正在删除 dsh ' + target + '…', 'busy');
      api.remove(target).then(function (res) {
        setStatus(res.ok
          ? ('已删除 dsh ' + target + (res.homeKept ? '；配置目录保留在 ' + res.homeDir : ''))
          : (res.error || '删除失败'), res.ok ? 'ok' : 'err');
      }).catch(function (error) { setStatus('删除失败：' + error, 'err'); });
    } else if (pendingRestore) {
      var bkName = pendingRestore;
      closeDialog();
      setStatus('正在恢复配置 ' + bkName + '…', 'busy');
      api.restore_backup(bkName).then(function (res) {
        setStatus(res.ok ? ('已恢复配置：' + bkName) : (res.error || '恢复失败'),
                  res.ok ? 'ok' : 'err');
        if (res.ok) refresh();
      }).catch(function (error) { setStatus('恢复失败：' + error, 'err'); });
    } else if (pendingDeleteBk) {
      var delName = pendingDeleteBk;
      closeDialog();
      api.delete_backup(delName).then(function (res) {
        setStatus(res.ok ? ('已删除备份：' + delName) : (res.error || '删除失败'),
                  res.ok ? 'ok' : 'err');
        if (res.ok) refresh();
      }).catch(function (error) { setStatus('删除备份失败：' + error, 'err'); });
    }
  }

  function refresh() {
    if (!api || restarting) return;
    return api.state().then(render).catch(function (error) {
      setStatus('读取状态失败：' + error, 'err');
    });
  }

  function bind() {
    document.getElementById('btn-refresh').addEventListener('click', function () {
      setStatus('正在检查更新…', 'busy');
      api.refresh();
    });
    document.getElementById('btn-slots-dir').addEventListener('click', function () { api.open_slots_dir(); });
    document.getElementById('btn-backup').addEventListener('click', function () {
      setStatus('正在备份配置…', 'busy');
      api.backup().then(function (res) {
        setStatus(res.ok ? ('已备份配置：' + res.name) : (res.error || '备份失败'),
                  res.ok ? 'ok' : 'err');
        if (res.ok) refresh();
      }).catch(function (error) { setStatus('备份失败：' + error, 'err'); });
    });
    document.getElementById('btn-home-dir').addEventListener('click', function () {
      api.open_home_dir(null);
    });
    document.getElementById('btn-backups-dir').addEventListener('click', function () {
      api.open_backups_dir();
    });
    document.getElementById('p-registry').addEventListener('change', function (ev) {
      var value = ev.target.value;
      setStatus('正在切换 npm 源…', 'busy');
      api.set_registry(value).then(function (res) {
        if (!res.ok) { setStatus(res.error || '换源失败', 'err'); return; }
        if (res.unchanged) { setStatus('npm 源没有变化：' + res.registry, ''); return; }
        setStatus('npm 源已切换：' + res.registry + '，之后的下载/检查更新都走它', 'ok');
      }).catch(function (error) { setStatus('换源失败：' + error, 'err'); });
    });
    document.getElementById('btn-clean').addEventListener('click', function () { api.open_slots_dir(); });
    document.getElementById('dlg-cancel').addEventListener('click', closeDialog);
    document.getElementById('dlg-ok').addEventListener('click', confirmDialog);
  }

  window.addEventListener('pywebviewready', function () {
    api = window.pywebview.api;
    bind();
    refresh();
    setInterval(refresh, 1500);
  });
</script>
</body>
</html>
"""


# --------------------------------------------------------------------------- #
# 应用主体
# --------------------------------------------------------------------------- #


class DshShellApp(object):
    def __init__(self):
        self.service = DshService()
        self.window = None
        self.manager_window = None
        self.version_window = None
        self.icon = None
        self.quitting = False
        self.busy = threading.Lock()
        # 任务栏任务动画监听（订阅 dsh 任务状态，有任务时刷标题动画）
        self.taskbar_watcher = None
        # 插件管理器窗口底部那行状态文字
        self.plugin_status = ""
        self.plugin_error = False
        # 版本管理器：状态文字 + 当前下载任务（{version, phase, running, lines, ...}）
        self.vm_status = ""
        self.vm_error = False
        self.vm_task = None
        self.vm_checking = False          # 正在打 npm view 刷新远端列表
        # 主窗口几何记忆：_last_geometry 记录最近一次已知的 (x, y, w, h)，
        # 退出/重启时写回 config.json。None 表示还没拿到过。
        self._last_geometry = None

    def set_plugin_status(self, text, error=False):
        self.plugin_status = str(text or "")
        self.plugin_error = bool(error)

    def set_vm_status(self, text, error=False):
        self.vm_status = str(text or "")
        self.vm_error = bool(error)

    # ---------------- 启动状态（写在那层原生 loading 上） ---------------- #

    def set_status(self, text, detail="", kind=""):
        """启动期唯一那层界面就是原生 loading，状态文字直接写上去。

        不再走 evaluate_js：那会同步 Invoke 到 UI 线程，程序刚起来时主线程正忙着
        初始化 WebView2（实测约 3 秒），会把 service.start() 一起堵住。原生控件
        那边是 BeginInvoke，异步、不阻塞调用方。
        """
        set_loading_tip(text)
        if detail:
            log("状态[%s]: %s | %s" % (kind or "-", text, detail))

    def set_tail(self, text):
        """dsh / npm 的输出行：没有启动页可显示了，只进日志。"""
        if text:
            log("tail: %s" % text)

    def notify(self, message, title=None):
        try:
            if self.icon is not None:
                self.icon.notify(message, title or APP_NAME)
        except Exception as exc:  # noqa: BLE001
            log("托盘通知失败: %s" % exc)

    # ---------------- 窗口 ---------------- #

    def _capture_geometry(self):
        """从 pywebview 窗口读当前几何（逻辑像素），存到 _last_geometry。

        读不到就保持原值，不覆盖上次已知值。
        """
        window = self.window
        if window is None:
            return
        try:
            x, y = window.x, window.y
            w, h = window.width, window.height
        except Exception:  # noqa: BLE001
            return
        if w > 0 and h > 0:
            self._last_geometry = (x, y, w, h)

    def _save_geometry(self):
        """把最近一次已知几何写进 config.json（幂等，可反复调）。"""
        if self._last_geometry is None:
            return
        save_window_geometry(*self._last_geometry)

    def on_window_closing(self):
        """点关闭按钮 -> 收进托盘，不退出程序。"""
        if self.quitting:
            return True
        log("窗口关闭 -> 最小化到托盘")
        self._capture_geometry()
        self._save_geometry()
        try:
            self.window.hide()
        except Exception as exc:  # noqa: BLE001
            log("隐藏窗口失败: %s" % exc)
        return False     # pywebview: 返回 False 取消关闭事件

    def show_window(self, *_args):
        try:
            self.window.show()
            self.window.restore()
        except Exception as exc:  # noqa: BLE001
            log("显示窗口失败: %s" % exc)

    def open_in_browser(self, *_args):
        webbrowser.open(self.service.access_url)

    # ---------------- 插件管理器窗口 ---------------- #

    def show_plugin_manager(self, *_args):
        window = self.manager_window
        if window is None:
            log("插件管理器窗口不存在（创建失败？）")
            self.notify("插件管理器打不开，请看日志")
            return
        try:
            window.show()
            window.restore()
            log("打开插件管理器")
        except Exception as exc:  # noqa: BLE001
            log("显示插件管理器失败: %s" % exc)

    def hide_plugin_manager(self):
        window = self.manager_window
        if window is None:
            return
        try:
            window.hide()
        except Exception as exc:  # noqa: BLE001
            log("隐藏插件管理器失败: %s" % exc)

    def on_manager_closing(self):
        """插件管理器的关闭按钮 = 收起窗口，不销毁（要能反复打开）。"""
        if self.quitting:
            return True
        self.hide_plugin_manager()
        return False     # pywebview: 返回 False 取消关闭事件

    # ---------------- 版本管理器窗口 ---------------- #

    def show_version_manager(self, *_args):
        window = self.version_window
        if window is None:
            log("版本管理器窗口不存在（创建失败？）")
            self.notify("版本管理器打不开，请看日志")
            return
        try:
            window.show()
            window.restore()
            log("打开版本管理器")
        except Exception as exc:  # noqa: BLE001
            log("显示版本管理器失败: %s" % exc)

    def hide_version_manager(self):
        window = self.version_window
        if window is None:
            return
        try:
            window.hide()
        except Exception as exc:  # noqa: BLE001
            log("隐藏版本管理器失败: %s" % exc)

    def on_version_closing(self):
        """版本管理器的关闭按钮 = 收起窗口，不销毁（要能反复打开）。"""
        if self.quitting:
            return True
        self.hide_version_manager()
        return False     # pywebview: 返回 False 取消关闭事件

    # ---------------- 版本管理器：状态 / 动作 ---------------- #

    def _vm_task_state(self):
        """当前下载任务的快照（没有任务返回 None）。"""
        task = self.vm_task
        if not task:
            return None
        return {
            "version": task["version"],
            "phase": task["phase"],
            "running": task["running"],
            "elapsed": int(time.time() - task["started"]),
            "ok": task.get("ok"),
            "error": task.get("error") or "",
            "tail": list(task["lines"])[-12:],
        }

    def version_manager_state(self):
        """版本管理器窗口的状态快照（纯 JSON，**不打 npm**，轮询安全）。

        远端列表来自缓存（内存 / config.versionsCache），刷新走 vm_refresh()。
        """
        remote = cached_remote_versions()
        active = active_slot_version()
        slots = [s for s in list_local_slots() if not s["partial"]]
        local_by_ver = {s["version"]: s for s in slots}

        rows = []
        seen = set()
        for item in remote.get("rows") or []:
            ver = item.get("version")
            if not ver or ver in seen:
                continue
            seen.add(ver)
            slot = local_by_ver.get(ver)
            rows.append(
                {
                    "version": ver,
                    "channel": item.get("channel") or _channel_of(ver, {}),
                    "publishedAt": item.get("publishedAt") or "",
                    "installed": slot is not None,
                    "active": ver == active,
                    "sizeMB": slot_size_mb(slot["dir"]) if slot else None,
                    "source": "remote",
                }
            )
        # 本机有、远端列表里没有的（老版本 / 远端下架），追加在后面，仍可切换/删除
        for ver in sorted(
            (v for v in local_by_ver if v not in seen),
            key=_version_sort_key,
            reverse=True,
        ):
            slot = local_by_ver[ver]
            rows.append(
                {
                    "version": ver,
                    "channel": _channel_of(ver, {}),
                    "publishedAt": "",
                    "installed": True,
                    "active": ver == active,
                    "sizeMB": slot_size_mb(slot["dir"]),
                    "source": "local-only",
                }
            )

        total = 0
        for slot in slots:
            total += slot_size_mb(slot["dir"])
        backups = list_backups()
        return {
            "versions": rows,
            "activeSlot": active,
            "activeSlotDir": active_slot_dir(),
            "installedVersion": self.service.installed_version(),
            "serviceRunning": self.service.managed_running(),
            "busy": self.busy.locked(),
            "checking": self.vm_checking,
            "slotCount": len(slots),
            "maxSlots": max_slots(),
            "totalSizeMB": total,
            "registry": registry_label(effective_registry()),
            "registryUrl": effective_registry(),
            # 下拉框的数据源（托盘已不提供换源入口，换源只在这里）
            "registryChoices": [
                {"label": label, "url": url} for label, url in REGISTRY_CHOICES
            ],
            "remoteOk": bool(remote.get("ok")),
            "remoteStale": bool(remote.get("stale")),
            "remoteCheckedAt": remote.get("checkedAt") or 0,
            "remoteError": remote.get("error") or "",
            # 配置目录（每版本一个 home）+ 备份清单（auto/manual 两个池子）
            "homeDir": dsh_home(),
            "homes": [
                {
                    "version": item["version"],
                    "dir": item["dir"],
                    "sizeMB": slot_size_mb(item["dir"]),
                    "active": item["version"] == active,
                }
                for item in list_local_homes()
            ],
            "backups": backups,
            "backupSizeMB": sum(item["sizeMB"] for item in backups),
            "backupRetention": BACKUP_RETENTION,
            "task": self._vm_task_state(),
            "status": self.vm_status,
            "error": self.vm_error,
            "packageName": PACKAGE,
        }

    def vm_refresh(self):
        """强制刷新远端版本列表：后台打一次 npm view，立即返回当前快照。"""
        if self.vm_checking:
            return self.version_manager_state()
        self.vm_checking = True
        self.set_vm_status("正在检查更新…")

        def worker():
            try:
                result = fetch_remote_versions(force=True)
                rows = result.get("rows") or []
                if result.get("ok") and rows:
                    self.set_vm_status(
                        "已检查更新：最新 %s %s" % (PACKAGE, rows[0]["version"])
                    )
                elif result.get("ok"):
                    self.set_vm_status("已检查更新：远端没有返回任何版本", True)
                else:
                    self.set_vm_status(
                        "检查更新失败：%s%s"
                        % (
                            result.get("error") or "未知错误",
                            "（已回退缓存列表）" if rows else "",
                        ),
                        True,
                    )
            except Exception as exc:  # noqa: BLE001
                log("检查更新异常: %s\n%s" % (exc, traceback.format_exc()))
                self.set_vm_status("检查更新异常：%s" % exc, True)
            finally:
                self.vm_checking = False

        threading.Thread(target=worker, daemon=True).start()
        return self.version_manager_state()

    def vm_start_download(self, version):
        """把某个版本下载进新槽位（后台跑，可与服务并行）。"""
        ver = sanitize_version(version)
        if not ver:
            return {"ok": False, "error": "版本号不合法：%r" % (version,)}
        if os.path.isdir(slot_dir(ver)):
            return {"ok": False, "error": "该版本已下载"}
        if self.vm_task and self.vm_task.get("running"):
            return {"ok": False, "error": "已有下载在进行（%s）" % self.vm_task["version"]}
        if not self.busy.acquire(blocking=False):
            return {"ok": False, "error": "已有任务在执行，等它跑完再试"}
        task = {
            "version": ver,
            "phase": "下载中",
            "started": time.time(),
            "running": True,
            "lines": deque(maxlen=200),
            "ok": None,
            "error": "",
        }
        self.vm_task = task
        self.set_vm_status("正在下载 dsh %s…" % ver)
        log("开始下载槽位: %s" % ver)
        threading.Thread(target=self._do_download, args=(task,), daemon=True).start()
        return {"ok": True}

    def _do_download(self, task):
        ver = task["version"]

        def on_line(line):
            if line:
                task["lines"].append(str(line))     # 供窗口轮询 progress 尾部

        try:
            ok, actual, tail = self.service.install_to_slot(
                "%s@%s" % (PACKAGE, ver), ver, on_line
            )
            task["ok"] = ok
            if not ok:
                task["error"] = (tail or "").strip()[-400:]
                self.set_vm_status("下载 dsh %s 失败：%s" % (ver, task["error"]), True)
                self.notify("下载 dsh %s 失败，详情见版本管理器" % ver)
            else:
                task["phase"] = "完成"
                self.set_vm_status(
                    "dsh %s 已下载，点「切换」即可使用（切换会自动重启应用）"
                    % (actual or ver)
                )
                self.notify("dsh %s 下载完成" % (actual or ver))
        except Exception as exc:  # noqa: BLE001
            task["ok"] = False
            task["error"] = str(exc)
            log("下载 dsh %s 异常: %s\n%s" % (ver, exc, traceback.format_exc()))
            self.set_vm_status("下载 dsh %s 异常：%s" % (ver, exc), True)
        finally:
            task["running"] = False
            self.busy.release()

    def vm_cancel(self):
        """取消进行中的下载：杀 npm 进程树，install_to_slot 失败后会清掉 .dl。"""
        task = self.vm_task
        if not task or not task.get("running"):
            return {"ok": False, "error": "当前没有进行中的下载"}
        self.set_vm_status("正在取消下载 dsh %s…" % task["version"])
        self.service.stop_npm_install()
        return {"ok": True}

    def vm_set_registry(self, value):
        """切换 npm 源（版本管理器窗口专用；托盘不再提供这个入口）。

        value = REGISTRY_CHOICES 里的 URL，或空串 = 跟随系统 npm 配置。
        只影响**之后**的 npm 调用（下载 / 检查更新 / 服务子进程的
        npm_config_registry），不影响正在进行中的任务。
        """
        value = str(value or "").strip()
        if value not in [url for _label, url in REGISTRY_CHOICES] + [""]:
            return {"ok": False, "error": "未知的 npm 源：%r" % (value,)}
        cfg = load_config()
        current = (cfg.get("registry") or "").strip()
        if value == current:
            return {"ok": True, "unchanged": True,
                    "registry": registry_label(value), "registryUrl": value}
        # 切源后各 registry 的版本内容理论上一致，但缓存旧源的结果没有意义：
        # 下次点「刷新」应该按新源重拉一次。
        _versions_cache["result"] = None
        cfg["registry"] = value
        save_config(cfg)
        label = registry_label(value)
        log("npm 源切换为：%s（版本管理器）" % (value or "(系统默认)"))
        self.set_vm_status("npm 源已切换：%s，之后的下载/检查更新都走它" % label)
        self.notify("npm 源已切换：%s" % label)
        return {"ok": True, "registry": label, "registryUrl": value}

    def vm_switch(self, version):
        """切换活动版本。**调用方必须先在窗口里完成确认**（见 VERSION_MANAGER_HTML）。

        确认后的动作 = 记 activeSlot + 自动重启应用（新实例按新槽位起服务）。
        立即返回 {ok}；真正的切换在后台线程里跑（先等窗口收到响应再动进程）。
        """
        ver = sanitize_version(version)
        if not ver:
            return {"ok": False, "error": "版本号不合法：%r" % (version,)}
        if not os.path.isdir(slot_dir(ver)):
            return {"ok": False, "error": "该版本尚未下载，请先下载"}
        if ver == active_slot_version():
            return {"ok": False, "error": "当前已经是这个版本"}
        if not self.busy.acquire(blocking=False):
            return {"ok": False, "error": "已有任务在执行，等它跑完再试"}
        threading.Thread(target=self._do_switch, args=(ver,), daemon=True).start()
        return {"ok": True, "restarting": True}

    def _do_switch(self, ver):
        old = active_slot_version()
        note = ""
        try:
            # 先停服务、再备份旧版本的配置：会话 / 存储都是活文件，停机压出来的
            # 快照才一致。停机时间 = 压缩耗时（home 几十 MB，几秒），状态行实时显示。
            # 备份失败**不阻塞切换**（只记日志 + 状态行提一句）。
            if old:
                self.set_vm_status("正在停服务并备份 dsh %s 的配置…" % old)
                self.service.stop()
                res = backup_home(old, kind="auto", note=self.set_vm_status)
                if res.get("ok"):
                    note = "，已自动备份配置 %s" % res["name"]
                else:
                    note = "（配置备份失败：%s）" % (res.get("error") or "?")
                    log("切换前备份配置失败: %s" % res.get("error"))
            set_active_slot(ver)
            self.set_vm_status("正在切换到 dsh %s，应用将自动重启…%s" % (ver, note))
            log("切换版本: %s -> %s%s" % (old or "?", ver, note))
            self.notify("正在切换到 dsh %s，应用即将重启…" % ver)
            # 等窗口先拿到 {ok: True} 的响应（js_api 调用是并行的，这里只是稳妥）
            time.sleep(1.2)
            # 切换版本 = 换一套前端代码，但 WebView2 的 localStorage / 缓存 / cookie
            # 是跨版本共用的（同一 origin http://127.0.0.1:3080）。旧版本写下的
            # 存储格式新版本不一定兼容（例如 0.1.7 删掉的 sessionUpdatedAtByAccount
            # 会让 0.1.5 的会话列表渲染崩溃），所以切换时让新实例清空整个 webview
            # 配置目录，从干净状态启动。
            self._spawn_new_instance(clear_webview=True)
            self.quit()          # 退出旧实例；_shutdown 会停掉服务（已经停过，幂等）
        except Exception as exc:  # noqa: BLE001
            log("切换 dsh %s 失败: %s\n%s" % (ver, exc, traceback.format_exc()))
            if old and old != ver:
                set_active_slot(old)
            self.set_vm_status(
                "切换失败：%s（已回滚到 dsh %s）" % (exc, old or "?"), True
            )
            self.notify("切换失败，已回滚到原版本")
            try:
                self.service.start()
                if self.service.wait_ready():
                    self.load_url()
            except Exception as start_exc:  # noqa: BLE001
                log("回滚后恢复服务失败: %s" % start_exc)
            self.busy.release()

    @staticmethod
    def _spawn_new_instance(clear_webview=False):
        """拉起一个新实例（带 DSH_UI_RESTART=1，会在单实例锁上等本实例退出）。

        clear_webview=True 时额外带 DSH_UI_CLEAR_WEBVIEW=1：新实例拿到单实例锁
        （旧实例已退出、WebView2 已释放文件）后先删掉整个 webview 配置目录再启动。
        目前只有版本切换走这个分支（见 _do_switch）。
        """
        if getattr(sys, "frozen", False):
            exe = sys.executable
            cmd = [exe]
        else:
            exe = os.path.abspath(sys.argv[0])
            cmd = [sys.executable, exe]
        if not os.path.isfile(exe):
            raise RuntimeError("找不到可执行文件：%s" % exe)
        env = os.environ.copy()
        env["DSH_UI_RESTART"] = "1"
        if clear_webview:
            env[CLEAR_WEBVIEW_ENV] = "1"
        log("拉起新实例 %s%s" % (" ".join(cmd), "（切换版本，将清空 webview 配置）" if clear_webview else ""))
        subprocess.Popen(
            cmd,
            cwd=os.path.dirname(exe) or None,
            env=env,
            creationflags=CREATE_NO_WINDOW,
        )
        return True

    def vm_remove(self, version):
        """删除一个**非活动、非下载中**的槽位。"""
        ver = sanitize_version(version)
        if not ver:
            return {"ok": False, "error": "版本号不合法：%r" % (version,)}
        path = slot_dir(ver)
        root = os.path.normcase(os.path.abspath(SLOTS_DIR)) + os.sep
        if not os.path.normcase(os.path.abspath(path)).startswith(root):
            return {"ok": False, "error": "拒绝删除槽位之外的路径"}
        if not os.path.isdir(path):
            return {"ok": False, "error": "该版本没有下载过"}
        if ver == active_slot_version():
            return {"ok": False, "error": "当前使用中的版本不能删除（先切换到别的版本）"}
        task = self.vm_task
        if task and task.get("running") and task["version"] == ver:
            return {"ok": False, "error": "该版本正在下载，请先取消"}
        if not self.busy.acquire(blocking=False):
            return {"ok": False, "error": "已有任务在执行，等它跑完再试"}
        try:
            size = slot_size_mb(path)          # 删除前取一次（缓存里有就直接用）
            _rmtree(path)                      # 只读文件也得删得掉
            _slot_size_cache.pop(path, None)
            # **只删代码，不删配置**：homes/<版本> 留着（以后重下还能接着用），
            # 要清理由用户自己点「配置目录」进去手工删。
            home = "" if _explicit_home_override() else home_dir_for(ver)
            home_kept = (
                "；配置目录保留在 %s（用每行的「配置目录」按钮打开后手工删）" % home
                if home and os.path.isdir(home) else ""
            )
            self.set_vm_status("已删除 dsh %s（释放 %d MB）%s" % (ver, size, home_kept))
            log("已删除槽位: %s%s" % (path, home_kept))
            self.notify("已删除 dsh %s" % ver)
            return {"ok": True, "homeDir": home, "homeKept": bool(home_kept)}
        except OSError as exc:
            log("删除槽位失败 %s: %s" % (path, exc))
            return {"ok": False, "error": "删除失败（可能有文件被占用）：%s" % exc}
        finally:
            self.busy.release()

    def vm_open_slots_dir(self):
        try:
            os.makedirs(SLOTS_DIR, exist_ok=True)
        except OSError:
            pass
        self._open_path(SLOTS_DIR)

    def vm_open_slot_dir(self, version):
        ver = sanitize_version(version)
        if not ver:
            return
        path = slot_dir(ver)
        if not os.path.isdir(path):
            self.notify("该版本没有下载过")
            return
        self._open_path(path)

    # ---------------- 配置备份 / 配置目录 ---------------- #

    def vm_backup(self):
        """版本管理器「备份配置」：手动打包当前版本的配置（不打断服务）。"""
        if not self.busy.acquire(blocking=False):
            return {"ok": False, "error": "已有任务在执行，等它跑完再试"}
        try:
            ver = active_slot_version()
            self.set_vm_status("正在备份配置（%s）…" % (ver or "?"))
            res = backup_home(ver, kind="manual", note=self.set_vm_status)
            if res.get("ok"):
                self.set_vm_status(
                    "已备份配置：%s（%d MB，本池最多保留 %d 份）"
                    % (res["name"], res["sizeMB"], BACKUP_RETENTION)
                )
                self.notify("配置备份完成")
            else:
                self.set_vm_status("备份失败：%s" % res.get("error"), True)
                self.notify("配置备份失败")
            return res
        finally:
            self.busy.release()

    def vm_delete_backup(self, name):
        """删掉一份备份（名字必须落在备份池里）。"""
        res = delete_backup(name)
        if res.get("ok"):
            self.set_vm_status("已删除备份：%s" % res["name"])
            log("删除配置备份: %s" % res["name"])
        else:
            self.set_vm_status("删除备份失败：%s" % res.get("error"), True)
        return res

    def vm_restore_backup(self, name):
        """恢复一份备份到它自己的版本目录。

        恢复活动版本时：**先停服务**（文件是活的）-> restore_backup() 内部会先把
        当前配置自动备份一次 -> 解压换名 -> 重新同步插件 -> 起服务 -> 刷新页面。
        """
        ver = version_from_backup_name(name)
        if not ver:
            return {"ok": False, "error": "备份名里读不出版本号：%s" % name}
        if not self.busy.acquire(blocking=False):
            return {"ok": False, "error": "已有任务在执行，等它跑完再试"}
        try:
            active = active_slot_version()
            was_running = bool(ver == active and self.service.managed_running())
            if was_running:
                self.set_vm_status("正在恢复配置（%s）：先停服务…" % ver)
                self.service.stop()
            else:
                self.set_vm_status("正在恢复配置（%s）…" % ver)
            res = restore_backup(name, note=self.set_vm_status)
            if not res.get("ok"):
                self.set_vm_status("恢复失败：%s" % res.get("error"), True)
                self.notify("恢复配置失败")
                if was_running:
                    self._resume_after_task()
                return res
            if was_running:
                # 恢复出来的 profile 和外壳的插件开关可能对不上，重新同步一遍
                try:
                    sync_plugins(on_note=self.set_plugin_status)
                except Exception as exc:  # noqa: BLE001
                    log("恢复后同步插件异常: %s" % exc)
                self._resume_after_task()
                self.set_vm_status("已恢复配置并重启服务（dsh %s）" % ver)
            elif ver == active:
                self.set_vm_status("已恢复配置（dsh %s，重启服务后生效）" % ver)
            else:
                self.set_vm_status("已恢复配置：%s -> %s（切到 dsh %s 后生效）"
                                   % (name, res["dir"], ver))
            self.notify("配置已恢复")
            return res
        except Exception as exc:  # noqa: BLE001
            log("恢复配置异常: %s\n%s" % (exc, traceback.format_exc()))
            self.set_vm_status("恢复失败：%s" % exc, True)
            return {"ok": False, "error": str(exc)}
        finally:
            self.busy.release()

    def _resume_after_task(self):
        """任务里停掉的服务拉回来；失败只记日志 + 状态行，不抛。"""
        try:
            self.service.start()
            if self.service.wait_ready():
                self.load_url()
        except Exception as exc:  # noqa: BLE001
            log("恢复服务失败: %s" % exc)
            self.set_vm_status("服务没能自动拉起：%s（可点托盘『重启服务』）" % exc, True)

    def vm_open_home_dir(self, version=None):
        """打开某个版本的**配置目录**（删槽位后手工清理 / 直接看文件就靠它）。"""
        ver = sanitize_version(version) or active_slot_version()
        path = _home_for_version(ver) if ver else dsh_home()
        if not os.path.isdir(path):
            self.notify("配置目录还不存在：%s" % path)
            return {"ok": False, "error": "配置目录还不存在：%s" % path}
        self._open_path(path)
        return {"ok": True, "path": path}

    def vm_open_backups_dir(self):
        """打开备份根目录（两池子 auto / manual 在它下面）。"""
        try:
            os.makedirs(BACKUPS_ROOT, exist_ok=True)
        except OSError:
            pass
        self._open_path(BACKUPS_ROOT)
        return {"ok": True, "path": BACKUPS_ROOT}

    # ---------------- 插件状态 / 同步 / 生效 ---------------- #

    def plugin_manager_state(self):
        """给插件管理器窗口用的完整状态快照（必须是纯 JSON 可序列化）。"""
        state = load_plugin_state()
        profile_dir = plugin_profile_dir()
        rows = []
        for package in scan_plugin_packages():
            dest = os.path.join(profile_dir, "plugins", package.id)
            rows.append(
                {
                    "id": package.id,
                    "name": package.name,
                    "description": package.description,
                    "version": package.version,
                    "enabled": plugin_enabled(state, package),
                    "usable": package.usable,
                    "error": package.error,
                    "installed": os.path.isfile(os.path.join(dest, PLUGIN_STAMP)),
                    "thirdParty": package.third_party,
                }
            )
        return {
            "plugins": rows,
            "pluginsDir": plugins_dir(),
            "thirdPartyPluginsDir": third_party_plugins_dir(),
            "dshHome": dsh_home(),
            "profileDir": profile_dir,
            "status": self.plugin_status,
            "error": self.plugin_error,
            "busy": self.busy.locked(),
            "serviceRunning": self.service.managed_running(),
            "version": APP_VERSION,
        }

    def set_plugin_enabled(self, plugin_id, enabled):
        plugin_id = str(plugin_id or "").strip()
        state = load_plugin_state()
        state["enabled"][plugin_id] = bool(enabled)
        save_plugin_state(state)
        log("插件 %s -> %s" % (plugin_id, "启用" if enabled else "关闭"))
        self.set_plugin_status(
            "%s 已%s，点「重启服务并生效」应用改动。"
            % (plugin_id, "启用" if enabled else "关闭")
        )
        return self.plugin_manager_state()

    def apply_plugins_async(self):
        """同步 + 重启服务。返回 False 表示已有任务在跑。"""
        if not self.busy.acquire(blocking=False):
            self.set_plugin_status("已有任务在执行（更新/重启），等它跑完再试。", error=True)
            return False
        self.set_plugin_status("正在同步插件到 dsh…")
        threading.Thread(target=self._do_apply_plugins, daemon=True).start()
        return True

    def _do_apply_plugins(self):
        try:
            ok, message = sync_plugins(on_note=self.set_plugin_status)
            if not ok:
                self.set_plugin_status(message, error=True)
                return
            self.set_plugin_status("正在重启 dsh 服务…")
            self.service.stop()
            self.service.start()
            if not self.service.wait_ready():
                tail = self.service.read_service_tail()
                log("插件改动后服务未就绪:\n%s" % tail)
                self.set_plugin_status("服务没起来，看日志：%s" % SHELL_LOG, error=True)
                self.notify("插件改动后服务启动失败")
                return
            self.load_url()
            self.set_plugin_status("已生效：%s" % message)
            log("插件改动已生效")
            self.notify("插件改动已生效")
        except Exception as exc:  # noqa: BLE001
            log("应用插件失败: %s\n%s" % (exc, traceback.format_exc()))
            self.set_plugin_status("失败：%s" % exc, error=True)
        finally:
            self.busy.release()

    # ---------------- 服务生命周期 ---------------- #

    def start_service_async(self, reload_page=True):
        threading.Thread(
            target=self._ensure_service, args=(reload_page,), daemon=True
        ).start()

    def _ensure_service(self, reload_page=True):
        try:
            mark("_ensure_service: 启动流程开始")

            # 每版本配置目录：缺了先从「切换前那份 home」拷副本（已存在不动）。
            # 必须在插件同步之前 —— 同步要写进 dsh_home() 底下的 profiles/。
            try:
                ensure_version_home(note=self.set_plugin_status)
            except Exception as exc:  # noqa: BLE001
                log("准备配置目录异常（继续启动）: %s" % exc)

            # 启动前先按「已启用的插件」把 plugins/ 镜像进 dsh 并刷新补丁文件。
            # 失败不阻塞启动：dsh 照常按现有补丁跑。
            try:
                _timed("sync_plugins", sync_plugins, on_note=self.set_plugin_status)
            except Exception as exc:  # noqa: BLE001
                log("同步插件异常（继续启动）: %s" % exc)

            version = _timed("读已安装版本", self.service.installed_version)
            if not version:
                # 尚未安装：先在启动界面里让用户挑一个镜像，写进配置再装。
                chosen = ask_registry_choice(effective_registry() or DEFAULT_REGISTRY)
                cfg = load_config()
                if chosen and chosen != (cfg.get("registry") or "").strip():
                    cfg["registry"] = chosen
                    save_config(cfg)
                    log("镜像已写入配置：%s" % chosen)
                self.set_status(
                    "首次运行，正在安装 DeepSeek Harness…",
                    "npm install %s —— 首次安装需要下载依赖，请耐心等待\n镜像: %s"
                    % (PACKAGE, registry_label(effective_registry())),
                )
                self.notify("首次运行，正在安装 DeepSeek Harness…")
                # 首装也走槽位：先 <名字>.dl，装完按实际版本 rename + 记为活动版本
                ok, installed_ver, output = self.service.install_to_slot(
                    PACKAGE, None, self._npm_progress
                )
                if not ok:
                    log("安装失败:\n%s" % output)
                    self.set_status("安装失败", output, "err")
                    self.set_tail(output)
                    self.notify("安装失败，详情见界面或日志")
                    return
                if installed_ver:
                    set_active_slot(installed_ver)
                version = self.service.installed_version()
                log("安装完成，版本 %s（槽位 %s）"
                    % (version, active_slot_dir()))
                # 首装这一刻才定下活动版本 —— 前面那次同步写的是老 home，
                # 这里补建 homes/<版本> 并再同步一次插件。
                try:
                    ensure_version_home(note=self.set_plugin_status)
                    _timed("sync_plugins(首装后)", sync_plugins, on_note=self.set_plugin_status)
                except Exception as exc:  # noqa: BLE001
                    log("首装后准备配置目录/同步插件异常（继续启动）: %s" % exc)

            # dsh 的访问 token 每次启动都会变，必须由本程序自己拉起服务才能拿到地址，
            # 所以端口上如果有残留进程，先清掉再重新启动。
            # 这里读系统 TCP 表，不用 TCP connect 探活：exe 首次 connect 到一个
            # 没人监听的端口不会立刻收到 RST，会一路卡到 timeout（实测 0.23s）。
            if _timed("探测端口是否有旧服务", pids_on_port):
                log("端口 %d 已被占用，先清理再启动" % PORT)
                self.set_status("正在清理旧服务…", "停掉上一次残留的 dsh 进程")
                self.service.stop()

            self.set_status("正在启动本地服务…", "dsh web --no-open @ %s" % URL)
            _timed("service.start()", self.service.start)
            mark("服务进程已拉起")
            if not self.service.wait_ready(poll_log=self.set_tail):
                self.set_status(
                    "服务启动失败或超时",
                    "请查看日志：%s" % SHELL_LOG,
                    "err",
                )
                self.set_tail(self.service.read_service_tail())
                self.notify("本地服务启动失败，请查看日志")
                return
            mark("服务已就绪（token 到手）")

            log("服务就绪：%s（dsh %s）" % (self.service.access_url, version or "?"))
            self.set_status("正在加载界面…", "dsh %s" % (version or "?"), "done")
            if reload_page:
                self.load_url()
                mark("已下发 load_url（dsh 前端开始加载）")
        except Exception as exc:  # noqa: BLE001
            log("启动流程异常: %s\n%s" % (exc, traceback.format_exc()))
            self.set_status("启动失败", str(exc), "err")
            self.set_tail(traceback.format_exc(limit=3))

    def _npm_progress(self, line):
        """npm 的每一行输出：写进日志，同时刷到启动 loading 的提示行上，
        让首次安装的进度直接显示出来（loading 只有一行，取行尾关键信息）。"""
        if not line:
            return
        log("tail: %s" % line)
        text = line.strip()
        # loading 提示行宽度有限：包名/进度条在行尾，砍掉过长的前缀
        if len(text) > 90:
            text = "…" + text[-89:]
        set_loading_tip("安装中：%s" % text)

    def load_url(self):
        window = self.window
        if window is None:
            return
        if not self.service.web_url:
            log("尚未拿到带 token 的访问地址，跳过加载")
            return
        url = self.service.access_url
        try:
            log("加载界面：%s" % url)
            arm_loading_drop()          # 真页面开始导航了，允许撤掉原生 loading
            window.load_url(url)
        except Exception as exc:  # noqa: BLE001
            log("加载界面失败: %s" % exc)

    # ---------------- 托盘动作 ---------------- #

    def action_restart(self, *_args):
        """托盘「重启服务」：只重启本地 dsh 服务进程（反代），应用本体不动。

        stop -> start -> wait_ready，完成后重新加载当前页面（token 会变）。
        应用进程、托盘、窗口都保持原样。
        """
        if not self.busy.acquire(blocking=False):
            self.notify("已有任务在执行，请稍候")
            return
        try:
            self.set_status("正在重启服务…", "stop -> start")
            self.service.stop()
            self.service.start()
            if not self.service.wait_ready(poll_log=self.set_tail):
                self.set_status("重启后服务未就绪", self.service.read_service_tail(), "err")
                self.notify("服务重启失败，请查看日志")
                return
            self.set_status("服务已重启", "dsh %s" % (self.service.installed_version() or "?"), "done")
            self.load_url()
            self.notify("本地服务已重启")
        except Exception as exc:  # noqa: BLE001
            log("重启异常: %s\n%s" % (exc, traceback.format_exc()))
            self.set_status("重启失败", str(exc), "err")
            self.notify("重启失败：%s" % exc)
        finally:
            self.busy.release()

    def action_restart_app(self, *_args):
        """托盘「重启应用」：先拉起一个新实例，再退出当前实例。

        新实例带着 DSH_UI_RESTART=1 启动，会在单实例锁上轮询等待本实例退出
        （见 acquire_single_instance），所以这里先 spawn 再 quit 的顺序是安全的：
        新实例不会因为锁被占而直接退出。旧实例退出时 _shutdown() 会停掉 dsh 服务，
        新实例随后按正常启动流程把服务拉起来。
        版本切换（vm_switch -> _do_switch）复用同一条路径。
        """
        if not self.busy.acquire(blocking=False):
            self.notify("已有任务在执行，请稍候")
            return
        try:
            self._spawn_new_instance()
            self.quit()
        except Exception as exc:  # noqa: BLE001
            log("重启应用异常: %s\n%s" % (exc, traceback.format_exc()))
            self.set_status("重启失败", str(exc), "err")
            self.notify("重启失败：%s" % exc)
        finally:
            self.busy.release()

    # ---------------- 托盘菜单 ---------------- #

    @staticmethod
    def _open_path(path):
        try:
            os.startfile(path)  # noqa: S606
        except Exception as exc:  # noqa: BLE001
            log("打开 %s 失败: %s" % (path, exc))

    def action_open_data(self, *_args):
        self._open_path(DATA_DIR)

    def action_open_log(self, *_args):
        self._open_path(SHELL_LOG)

    def action_quit(self, *_args):
        self.quit()

    def _version_label(self, _item=None):
        """版本行只报版本号，不再带 running/stopped 状态（服务状态在版本管理器里看）。"""
        return "dsh %s" % (self.service.installed_version() or "未安装")

    def build_menu(self):
        # 托盘**没有**「检查更新」和「npm 源」入口：
        # 检查/下载/切换/删除全部收进版本管理器窗口（选源保留给首次安装对话框）。
        return pystray.Menu(
            pystray.MenuItem("打开主界面", self.show_window, default=True),
            pystray.MenuItem("插件管理器", self.show_plugin_manager),
            pystray.MenuItem("版本管理器", self.show_version_manager),
            pystray.MenuItem("在浏览器中打开", self.open_in_browser),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(self._version_label, None, enabled=False),
            pystray.MenuItem("重启服务", self.action_restart),
            pystray.MenuItem("重启应用", self.action_restart_app),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("打开数据目录", self.action_open_data),
            pystray.MenuItem("查看运行日志", self.action_open_log),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("退出", self.action_quit),
        )

    def start_tray(self):
        try:
            image = make_icon(64)
        except Exception as exc:  # noqa: BLE001
            log("生成托盘图标失败: %s" % exc)
            image = Image.new("RGBA", (64, 64), (77, 107, 254, 255))
        self.icon = pystray.Icon(
            "deepseek-harness", image, "%s %s" % (APP_NAME, APP_VERSION), self.build_menu()
        )
        self.icon.run_detached()

    # ---------------- 退出 ---------------- #

    def quit(self, *_args):
        if self.quitting:
            return
        self.quitting = True
        log("退出：先把界面撤掉，再清理后台")

        # 停掉任务栏任务动画监听，标题恢复空闲文字
        if self.taskbar_watcher is not None:
            try:
                self.taskbar_watcher.stop()
            except Exception:  # noqa: BLE001
                pass

        # 退出前把主窗口几何记下来（重启应用/退出都走这里）
        self._capture_geometry()
        self._save_geometry()

        # 第一步只做「让用户看到程序已经关了」：隐藏窗口 + 停托盘。
        # 这两步都是毫秒级，所以点完「退出」界面几乎立刻消失。
        for name in ("window", "manager_window", "version_window"):
            window = getattr(self, name)
            if window is None:
                continue
            try:
                _timed("%s hide" % name, window.hide)
            except Exception:
                pass
        try:
            if self.icon is not None:
                _timed("icon.stop()", self.icon.stop)
        except Exception:
            pass
        mark("界面已撤下（用户视角退出完成）")

        # 第二步才是真正耗时的收尾：杀 node 服务（1 秒上下）、销毁 WebView2 控件。
        # 放后台做，用户不必为了等它跑完而多盯一秒；跑完立刻结束进程。
        threading.Thread(target=self._shutdown, daemon=True).start()

    def _shutdown(self):
        """退出收尾：停安装/服务 -> 释放防睡眠 -> 销毁窗口 -> 强杀进程。"""
        try:
            # 首次安装/版本下载还在跑的话，先把 npm 进程树杀掉，别留 node 在后台下载
            self.service.stop_npm_install()
        except Exception as exc:  # noqa: BLE001
            log("退出时终止 npm 安装失败: %s" % exc)
        try:
            self.service.stop()
        except Exception as exc:  # noqa: BLE001
            log("退出时停止服务失败: %s" % exc)
        mark("服务已停")
        # 程序要退出了，恢复系统默认睡眠策略（进程退出时系统也会自动清除，
        # 但显式释放更干净，也覆盖重启/更新等复用流程）。
        release_system_awake()
        mark("防睡眠已释放")
        for name in ("window", "manager_window", "version_window"):
            window = getattr(self, name)
            if window is None:
                continue
            try:
                _timed("%s destroy" % name, window.destroy)
            except Exception:
                pass
        mark("窗口已销毁")
        log("退出完成")
        os._exit(0)


# --------------------------------------------------------------------------- #
# 插件管理器窗口的桥（窗口里的 JS 通过 pywebview.api.* 调这些方法）
# --------------------------------------------------------------------------- #


class PluginManagerApi(object):
    def __init__(self, app):
        self._app = app

    def state(self):
        return self._app.plugin_manager_state()

    def toggle(self, plugin_id, enabled):
        return self._app.set_plugin_enabled(plugin_id, enabled)

    def restart(self):
        return self._app.apply_plugins_async()

    def open_plugins_dir(self):
        path = plugins_dir()
        try:
            os.makedirs(path, exist_ok=True)
        except OSError:
            pass
        self._app._open_path(path)

    def open_third_party_plugins_dir(self):
        path = third_party_plugins_dir()
        if not path:
            return
        try:
            os.makedirs(path, exist_ok=True)
        except OSError:
            pass
        self._app._open_path(path)

    def open_dsh_dir(self):
        self._app._open_path(dsh_home())

    def open_log(self):
        self._app._open_path(SHELL_LOG)


# --------------------------------------------------------------------------- #
# 版本管理器窗口的桥（窗口里的 JS 通过 pywebview.api.* 调这些方法）
# --------------------------------------------------------------------------- #


class VersionManagerApi(object):
    """全部动作都**先由前端弹窗口内确认框**，这里只执行。

    state() 只读缓存、绝不打 npm，1.5s 轮询不会卡 UI；
    列表真正刷新走 refresh()（后台 npm view）。
    """

    def __init__(self, app):
        self._app = app

    def state(self):
        return self._app.version_manager_state()

    def refresh(self):
        return self._app.vm_refresh()

    def download(self, version):
        return self._app.vm_start_download(version)

    def cancel(self):
        return self._app.vm_cancel()

    def set_registry(self, value):
        """换 npm 源：版本管理器窗口里的下拉框调它（托盘没有这个入口了）。"""
        return self._app.vm_set_registry(value)

    def switch(self, version):
        return self._app.vm_switch(version)

    def remove(self, version):
        return self._app.vm_remove(version)

    def open_slots_dir(self):
        self._app.vm_open_slots_dir()

    def open_slot_dir(self, version):
        self._app.vm_open_slot_dir(version)

    # ---- 配置备份 / 配置目录（每版本一个 home） ----

    def backup(self):
        """手动备份当前版本的配置（窗口里「备份配置」按钮）。"""
        return self._app.vm_backup()

    def restore_backup(self, name):
        """恢复一份备份（**前端必须先弹窗口内确认框**）。"""
        return self._app.vm_restore_backup(name)

    def delete_backup(self, name):
        return self._app.vm_delete_backup(name)

    def open_home_dir(self, version=None):
        """打开某个版本的配置目录（删槽位后手工清理用）。"""
        return self._app.vm_open_home_dir(version)

    def open_backups_dir(self):
        return self._app.vm_open_backups_dir()

    def open_log(self):
        self._app._open_path(SHELL_LOG)


# --------------------------------------------------------------------------- #
# 单实例
# --------------------------------------------------------------------------- #


def acquire_single_instance():
    """拿单实例锁。返回 (ok, handle)。

    重启应用（托盘「重启应用」）时，新实例会带着 DSH_UI_RESTART=1 先起来，
    旧实例随后退出并释放锁 —— 所以这种启动要**轮询等待**锁，而不是立刻放弃；
    等不到就放弃，避免两个实例同时跑。
    """
    try:
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        restarting = (os.environ.get("DSH_UI_RESTART") or "").strip() == "1"
        deadline = time.time() + (RESTART_LOCK_TIMEOUT if restarting else 0.0)
        while True:
            handle = kernel32.CreateMutexW(None, False, MUTEX_NAME)
            if not handle:
                return True, None
            if ctypes.get_last_error() != 183:  # ERROR_ALREADY_EXISTS
                return True, handle
            if handle:
                kernel32.CloseHandle(handle)
            if not restarting or time.time() >= deadline:
                return False, None
            time.sleep(0.2)
    except Exception:  # noqa: BLE001
        return True, None


# --------------------------------------------------------------------------- #
# 任务栏任务动画
# --------------------------------------------------------------------------- #


class TaskbarJobWatcher(object):
    """监听 dsh 会话活动状态，判断 dsh 自身是否有对话/任务在跑。

    有会话处于 running（agent 正在响应）时，把主窗口标题（= 任务栏按钮
    文字）刷成鲸鱼游动 + 波浪扩张的文字动画，空闲时恢复 "DeepSeek Harness"。

    * 数据源和前端会话列表的活动指示器完全一致：
      - 初始状态：session/list 的 summaries（running 字段）
      - 实时更新：$events 事件流的 api-session/status 事件
    * 走 WebSocket 直连本地服务，与 WebView2 页面无关 —— 窗口最小化、
      隐藏到托盘、甚至页面卡住时都照常工作。
    * 动画每帧严格 16 字符（和 "DeepSeek Harness" 等长，按字符数计，
      非字体测量）。
    """

    MUX_PATH = "/api/remote.mux"
    EVENTS_ENDPOINT = "$events"
    LIST_ENDPOINT = "session/list"
    FRAME_INTERVAL = 0.18          # 动画帧间隔（秒）
    RECONNECT_DELAY = 3.0          # 断线重连间隔（秒）
    IDLE_TEXT = APP_NAME           # 空闲时任务栏文字（16 字符）
    ANIM_WIDTH = len(IDLE_TEXT) - 4  # 动画宽度：左右各删 2 个字符（12 字符）

    def __init__(self, app):
        self._app = app
        self._stop = threading.Event()
        self._thread = None
        self._has_live = False
        self._last_title = None
        # 每个会话的 running 状态（sessionId -> bool），全局 live = 任一为 True
        self._running_sessions = {}

    # ---------------- 对外接口 ---------------- #

    def start(self):
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, daemon=True, name="taskbar-watcher"
        )
        self._thread.start()

    def stop(self):
        self._stop.set()

    # ---------------- 主循环 ---------------- #

    def _run(self):
        while not self._stop.is_set():
            try:
                self._connect_once()
            except Exception as exc:  # noqa: BLE001
                log("任务栏任务监听异常: %s" % exc)
            if self._stop.wait(self.RECONNECT_DELAY):
                break
        self._set_title(self.IDLE_TEXT)

    def _connect_once(self):
        """连一次 WebSocket 并订阅 $events 事件流，直到断线或停止。"""
        url = self._app.service.access_url
        match = TOKEN_RE.search(url or "")
        if not match:
            return
        cookie = self._exchange_cookie(match.group(1))
        if not cookie:
            return
        # 初始状态：先拉一次 session/list 拿 running 快照
        try:
            self._fetch_running(cookie)
        except Exception as exc:  # noqa: BLE001
            log("任务栏任务监听: 初始状态获取失败 %s" % exc)
        ws = websocket.create_connection(
            "ws://%s:%d%s" % (HOST, PORT, self.MUX_PATH),
            header=["Cookie: " + cookie],
            timeout=10,
        )
        try:
            sid = str(uuid.uuid4())
            ws.send(json.dumps({
                "type": "open",
                "streamId": sid,
                "endpoint": self.EVENTS_ENDPOINT,
                "payload": {"args": {}},
            }))
            ws.settimeout(0.05)
            next_frame_at = 0.0
            tick = 0
            while not self._stop.is_set():
                # 1) 尽量把已到的消息读完（最多等 50ms）
                try:
                    msg = ws.recv()
                except websocket.WebSocketTimeoutException:
                    msg = None
                except websocket.WebSocketConnectionClosedException:
                    break
                if msg:
                    if not self._handle_message(msg):
                        return  # 流已结束/出错，重连
                # 2) 按节奏刷标题
                now = time.monotonic()
                if self._has_live:
                    if now >= next_frame_at:
                        self._set_title(self._frame(tick))
                        tick += 1
                        next_frame_at = now + self.FRAME_INTERVAL
                elif self._last_title != self.IDLE_TEXT:
                    self._set_title(self.IDLE_TEXT)
                # 3) 歇一下，别空转
                self._stop.wait(0.05)
        finally:
            try:
                ws.close()
            except Exception:  # noqa: BLE001
                pass
            # 断线期间没有状态可依，回到空闲（重连后会重新拉快照）
            self._has_live = False
            self._running_sessions = {}

    def _fetch_running(self, cookie):
        """调 session/list 拿所有会话的 running 快照。"""
        rpc_id = str(uuid.uuid4())
        body = json.dumps({
            "type": "client-request",
            "rpcId": rpc_id,
            "method": self.LIST_ENDPOINT,
            "payload": {"args": {"_request": {}}},
        })
        req = urllib.request.Request(
            "http://%s:%d/api/%s" % (HOST, PORT, self.LIST_ENDPOINT),
            data=body.encode("utf-8"),
            headers={"content-type": "application/json", "Cookie": cookie},
            method="POST",
        )
        resp = urllib.request.urlopen(req, timeout=5)
        data = json.loads(resp.read().decode("utf-8"))
        items = ((data.get("result") or {}).get("value") or {}).get("items") or []
        # 重建整个 running 集合（快照是权威的）
        self._running_sessions = {
            item.get("sessionId"): bool(item.get("running"))
            for item in items
        }
        self._update_live(any(self._running_sessions.values()))

    def _handle_message(self, msg):
        """处理一帧 WS 消息。返回 False 表示流已结束，需要重连。"""
        try:
            data = json.loads(msg)
        except ValueError:
            return True
        mtype = data.get("type")
        if mtype == "end":
            return False
        if mtype == "error":
            log("任务栏任务监听: 流错误 %s" % (data.get("error") or {}).get("message"))
            return False
        if mtype != "item":
            return True
        value = data.get("value") or {}
        ftype = value.get("type")
        if ftype == "ready":
            return True
        if ftype == "emit":
            event = value.get("event")
            args = value.get("args") or []
            if event == "api-session/status" and len(args) >= 2:
                # args = [sessionId, running] —— 只更新这一个会话，
                # 全局 live 仍看所有会话（任一 running 就播动画）
                self._running_sessions[args[0]] = bool(args[1])
                self._update_live(any(self._running_sessions.values()))
        return True

    def _update_live(self, live):
        if live != self._has_live:
            self._has_live = live
            log("任务栏任务状态: %s" % ("有会话活动" if live else "空闲"))

    # ---------------- 动画 ---------------- #

    @staticmethod
    def _frame(tick):
        """生成一帧动画：鲸鱼匀速左右游动，三层波浪一层层泛起又收回。

        每帧严格 12 字符（"DeepSeek Harness" 左右各删 2 个字符）。
        鲸鱼用三角波匀速往返，不会在端点停留。
        三层波浪（内层 ≈、中层 ~、外层 -）各自呼吸：从鲸鱼两侧
        泛起、扩散到最大、再收回，三层相位依次错开，形成一层层
        起伏的涟漪效果。
        """
        width = TaskbarJobWatcher.ANIM_WIDTH
        center = (width - 1) / 2.0
        amp = width / 2.0 - 2.0
        # 三角波：0..1 循环，线性往返 -1..1，鲸鱼匀速移动
        t = (tick % 8.0) / 8.0
        if t < 0.5:
            tri = 4.0 * t - 1.0
        else:
            tri = 3.0 - 4.0 * t
        pos = int(round(center + amp * tri))
        pos = max(1, min(width - 2, pos))
        chars = ["~"] * width
        chars[pos] = "🐋"          # 🐋
        # 三层波浪：内层 ≈、中层 ~、外层 -，从鲸鱼两侧一层层泛起又收回
        # 三层共用同一个呼吸周期（16 帧：0→最大→0），相位依次错开 2 帧，
        # 形成"一层推一层"的涟漪效果
        layers = (
            (1, 3, "≈", 0),   # ≈ 内层先起，扩到 3 格
            (2, 4, "~", 2),        # ~ 中层随后，扩到 4 格
            (3, 5, "-", 4),        # - 外层最后，扩到 5 格
        )
        for lo, hi, ch, offset in layers:
            ph = ((tick + offset) % 16.0) / 16.0
            if ph < 0.5:
                r = 2.0 * ph * hi
            else:
                r = 2.0 * (1.0 - ph) * hi
            for dist in range(lo, min(hi, int(r)) + 1):
                if pos - dist >= 0:
                    chars[pos - dist] = ch
                if pos + dist < width:
                    chars[pos + dist] = ch
        return "".join(chars)

    # ---------------- 标题写入 ---------------- #

    def _set_title(self, text):
        if text == self._last_title:
            return
        window = self._app.window
        if window is None:
            return
        gui = getattr(window, "gui", None)
        if gui is None:
            return
        try:
            gui.set_title(text, window.uid)
        except Exception:  # noqa: BLE001
            return
        self._last_title = text

    # ---------------- 认证 ---------------- #

    @staticmethod
    def _exchange_cookie(token):
        """用启动 token 换认证 cookie（等价于浏览器首次访问 ?token=...）。"""
        try:
            cj = http.cookiejar.CookieJar()
            opener = urllib.request.build_opener(
                urllib.request.HTTPCookieProcessor(cj)
            )
            opener.open(
                urllib.request.Request(
                    "http://%s:%d/?token=%s" % (HOST, PORT, token), method="GET"
                ),
                timeout=5,
            )
            return "; ".join("%s=%s" % (c.name, c.value) for c in cj)
        except Exception:  # noqa: BLE001
            return None


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #


def main():
    _setup_logging()
    log("=" * 60)
    log("%s v%s 启动 (frozen=%s, pid=%s)" % (APP_NAME, APP_VERSION, getattr(sys, "frozen", False), os.getpid()))
    log("数据目录: %s" % DATA_DIR)
    log("插件目录: %s" % plugins_dir())
    log("第三方插件目录: %s" % (third_party_plugins_dir() or "(无)"))
    log("dsh 目录: %s" % dsh_home())
    log("node: %s" % find_node())
    mark("main() 开始（frozen=%s）" % getattr(sys, "frozen", False))
    report_onefile_extract()

    ok, _handle = acquire_single_instance()
    if not ok:
        log("已有实例在运行，本次启动退出")
        return
    mark("单实例锁就绪")

    # 版本切换（_do_switch -> _spawn_new_instance(clear_webview=True)）时，新实例
    # 带着 DSH_UI_CLEAR_WEBVIEW=1 启动。拿到单实例锁 = 旧实例已完全退出、WebView2
    # 进程已释放文件锁，此时删掉整个 webview 配置目录最安全（localStorage / 缓存 /
    # cookie 全部清空，避免跨版本格式不兼容把新版本前端带崩）。删完重建空目录，
    # 后续 webview.start(storage_path=WEBVIEW_DIR) 会从干净状态初始化。
    if (os.environ.get(CLEAR_WEBVIEW_ENV) or "").strip() == "1":
        try:
            if os.path.isdir(WEBVIEW_DIR):
                _rmtree(WEBVIEW_DIR)
                log("已清空 webview 配置目录（版本切换）: %s" % WEBVIEW_DIR)
            os.makedirs(WEBVIEW_DIR, exist_ok=True)
        except Exception as exc:  # noqa: BLE001
            log("清空 webview 配置目录失败（继续启动）: %s" % exc)

    # 多槽位布局：先清掉上次异常退出留下的 *.dl 半成品，再把老单目录迁进
    # slots/<版本>/（同卷 rename，瞬间完成）。都在服务启动之前做。
    try:
        cleanup_partial_slots()
    except Exception as exc:  # noqa: BLE001
        log("清理下载残留异常（继续启动）: %s" % exc)
    try:
        if migrate_legacy_runtime():
            mark("旧布局已迁移到槽位")
    except Exception as exc:  # noqa: BLE001
        log("旧布局迁移异常（继续启动）: %s" % exc)
    log("活动槽位: %s（活动版本 %s）"
        % (active_slot_dir(), active_slot_version() or "未安装"))

    # 每版本配置目录：缺了先从「切换前那份 home」拷副本（已存在一个字节不动）。
    # 必须在任何 dsh_home() 消费者（插件同步 / 信息面板）之前跑。
    try:
        cleanup_partial_homes()
        home_info = ensure_version_home()
        if home_info.get("created"):
            mark("配置目录已就绪: %s（来源 %s）"
                 % (home_info["dir"], home_info.get("source") or "全新"))
    except Exception as exc:  # noqa: BLE001
        log("准备配置目录异常（继续启动）: %s" % exc)
    if (os.environ.get("DSH_HOME") or "").strip():
        # 见 _explicit_home_override()：环境里这个值多半是从 dsh 终端泄漏进来的，
        # 不参与解析（服务子进程那边会被外壳重新注入）。说出来免得用户困惑。
        log("忽略环境变量 DSH_HOME=%s（每版本配置目录由外壳接管；"
            "想固定一个目录请写 config.json 的 dshHome）" % os.environ.get("DSH_HOME"))
    log("dsh 配置目录: %s" % dsh_home())

    # 启动即阻止系统睡眠（不阻止息屏/锁屏），退出时在 _shutdown 里释放。
    keep_system_awake()
    mark("防睡眠已设置")

    try:
        if not os.path.isfile(ICON_PATH):
            save_ico(ICON_PATH, 256)
    except Exception as exc:  # noqa: BLE001
        log("写入图标失败: %s" % exc)
    mark("图标文件就绪")

    app = DshShellApp()

    # 启动期唯一的界面 = 主窗口里那层原生 loading，必须在 webview.start() 之前挂上。
    patch_webview_loading()

    # 主窗口几何：上次退出时记过就恢复（位置/尺寸），否则用默认尺寸居中。
    # 恢复的坐标是逻辑像素，pywebview 会按 DPI 换算成物理像素。
    geometry = load_window_geometry()
    if geometry is not None:
        gx, gy, gw, gh = clamp_window_geometry(*geometry)
        log("恢复主窗口几何: (%d, %d) %dx%d" % (gx, gy, gw, gh))
        window = webview.create_window(
            APP_NAME,
            html=BLANK_HTML,
            width=gw,
            height=gh,
            x=gx,
            y=gy,
            min_size=(940, 620),
            background_color=WINDOW_BG,
            text_select=True,
        )
    else:
        window = webview.create_window(
            APP_NAME,
            html=BLANK_HTML,
            width=1280,
            height=860,
            min_size=(940, 620),
            background_color=WINDOW_BG,
            text_select=True,
        )
    app.window = window
    window.events.closing += app.on_window_closing
    window.events.loaded += lambda: mark("页面加载完成")
    # 用户拖动/缩放窗口时持续记录几何，退出时写回
    window.events.moved += lambda *_: app._capture_geometry()
    window.events.resized += lambda *_: app._capture_geometry()
    mark("主窗口对象已建（尚未真正创建 WebView2）")

    # 插件管理器：先建好、隐藏着，托盘菜单点开再 show()。
    # pywebview 6 的 hidden=True 在 winforms 后端上就是"建好不显示"。
    try:
        manager = webview.create_window(
            "插件管理器 · %s" % APP_NAME,
            html=MANAGER_HTML,
            width=860,
            height=640,
            min_size=(700, 480),
            hidden=True,
            background_color=WINDOW_BG,
            text_select=True,
            js_api=PluginManagerApi(app),
        )
        app.manager_window = manager
        manager.events.closing += app.on_manager_closing
    except Exception as exc:  # noqa: BLE001
        log("创建插件管理器窗口失败: %s\n%s" % (exc, traceback.format_exc()))
    mark("插件管理器窗口对象已建")

    # 版本管理器：同样先建好、隐藏着，托盘菜单点开再 show()。
    try:
        version_win = webview.create_window(
            "版本管理器 · %s" % APP_NAME,
            html=VERSION_MANAGER_HTML,
            width=880,
            height=660,
            min_size=(720, 520),
            hidden=True,
            background_color=WINDOW_BG,
            text_select=True,
            js_api=VersionManagerApi(app),
        )
        app.version_window = version_win
        version_win.events.closing += app.on_version_closing
    except Exception as exc:  # noqa: BLE001
        log("创建版本管理器窗口失败: %s\n%s" % (exc, traceback.format_exc()))
    mark("版本管理器窗口对象已建")

    app.start_tray()
    mark("托盘已起")
    app.start_service_async()
    mark("服务启动已派发（后台线程）")

    # 任务栏任务动画：订阅 dsh 任务状态，有任务时把标题刷成鲸鱼动画。
    # 独立于 WebView2 页面，窗口最小化/隐藏到托盘时照常工作。
    try:
        app.taskbar_watcher = TaskbarJobWatcher(app)
        app.taskbar_watcher.start()
        mark("任务栏任务监听已启动")
    except Exception as exc:  # noqa: BLE001
        log("任务栏任务监听启动失败: %s" % exc)

    try:
        webview.start(
            gui="edgechromium",
            debug=False,
            private_mode=False,
            storage_path=WEBVIEW_DIR,
            icon=ICON_PATH if os.path.isfile(ICON_PATH) else None,
        )
    except Exception as exc:  # noqa: BLE001
        log("WebView2 启动失败: %s\n%s" % (exc, traceback.format_exc()))
        app.notify("WebView2 初始化失败，请确认已安装 WebView2 运行时")
        return
    mark("GUI 主循环结束")

    log("GUI 主循环结束 (quitting=%s)" % app.quitting)
    if not app.quitting:
        # 窗口被直接关掉了（没有走拦截分支），托盘仍可用，保持进程存活
        log("窗口已关闭，程序继续驻留托盘")
        while True:
            time.sleep(3600)


if __name__ == "__main__":
    main()
