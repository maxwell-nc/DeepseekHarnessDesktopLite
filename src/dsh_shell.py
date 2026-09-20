# -*- coding: utf-8 -*-
"""
DeepSeek Harness 桌面壳
=======================

把 DeepSeek Harness（``@deepseek-ai/dsh``）的 Web UI 包成一个 Windows 桌面程序：

* 用 **WebView2**（Edge Chromium）内核内嵌界面，不依赖外部浏览器
* 后台静默拉起 ``dsh web`` 服务，**全程不出现任何命令行窗口**
* 常驻**系统托盘**，点窗口关闭按钮只收起界面，服务继续在后台运行
* 托盘菜单一键**更新**：停止服务 -> ``npm install @deepseek-ai/dsh@latest`` -> 重启服务
"""

import http.cookiejar
import json
import logging
import math
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
import uuid
import webbrowser
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
    """插件包目录：exe 同目录的 plugins/。开发态回落到项目里的 dist/plugins。"""
    override = (os.environ.get("DSH_UI_PLUGINS_DIR") or "").strip()
    if override:
        return os.path.abspath(os.path.expanduser(override))
    if getattr(sys, "frozen", False):
        return os.path.join(BASE_DIR, "plugins")
    return os.path.join(os.path.dirname(BASE_DIR), "dist", "plugins")


def dsh_home():
    """dsh 配置根：config.json 的 dshHome > 环境变量 DSH_HOME > ~/.dsh。"""
    value = (load_config().get("dshHome") or os.environ.get("DSH_HOME") or "").strip()
    if value:
        return os.path.abspath(os.path.expanduser(value))
    return os.path.join(os.path.expanduser("~"), ".dsh")


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
    """dsh-client-modules 的入口文件，补丁要拿它的原型打洞。"""
    return os.path.join(
        RUNTIME_DIR, "node_modules", "@deepseek-ai", "dsh-client-modules", "lib", "index.js"
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
    """删目录：是链接就只摘链接（绝不递归进目标），否则整棵删。"""
    if not os.path.lexists(path):
        return False
    if _is_link(path):
        os.rmdir(path)
    else:
        shutil.rmtree(path, onerror=None)
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
    """plugins/ 里的一个插件包。读 manifest，做基本校验，坏了就带着原因展示。"""

    def __init__(self, path):
        self.path = path
        self.id = os.path.basename(path)
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


def scan_plugin_packages():
    """扫描 plugins/，按 order 排好序返回（坏包也在列表里，带 error）。"""
    root = plugins_dir()
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
            found.append(PluginPackage(path))
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
        return os.path.join(RUNTIME_DIR, "node_modules", "@deepseek-ai", "dsh")

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
    def ensure_runtime_manifest():
        manifest = os.path.join(RUNTIME_DIR, "package.json")
        if not os.path.isfile(manifest):
            try:
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
                log("写入 runtime/package.json 失败: %s" % exc)

    # ---------------- 安装 / 更新 ---------------- #

    def npm_install(self, spec, on_line=None):
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

        self.ensure_runtime_manifest()
        log("npm: %s" % " ".join(cmd))
        log("npm registry: %s" % (registry or "(跟随系统 npm 配置)"))
        if on_line is not None:
            on_line("$ npm install %s\nregistry: %s" % (spec, registry or "系统默认"))
        try:
            proc = subprocess.Popen(
                cmd,
                cwd=RUNTIME_DIR,
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
        """终止还在跑的首次安装 npm 进程树（用户在安装中途退出时调用）。"""
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
      dsh 目录 <b id="p-dsh">…</b>
    </div>
  </header>
  <main id="list"><div class="empty">正在读取…</div></main>
  <footer>
    <div class="acts">
      <button class="primary" id="restart">重启服务并生效</button>
      <button class="ghost" id="open-plugins">打开插件目录</button>
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
    document.getElementById('p-dsh').textContent = state.dshHome || '(无)';

    var list = document.getElementById('list');
    if (!state.plugins || state.plugins.length === 0) {
      list.innerHTML = '<div class="empty">插件目录里还没有插件包。<br>'
        + '每个插件是一个子目录，里面要有 manifest.json、入口 .mjs 和 patch 片段。</div>';
    } else {
      list.innerHTML = state.plugins.map(function (p) {
        var cls = 'led ' + (p.enabled ? 'on' : 'off');
        var chip = p.enabled
          ? '<span class="chip state-on">已启用</span>'
          : '<span class="chip state-off">已关闭</span>';
        var inst = p.installed ? '<span class="chip">已装入 dsh</span>' : '';
        var ver = p.version ? '<span class="chip">v' + esc(p.version) + '</span>' : '';
        var warn = p.error ? '<div class="warn">⚠ ' + esc(p.error) + '</div>' : '';
        if (!p.usable && !p.error) warn = '<div class="warn">本平台不适用，已跳过</div>';
        return '<div class="row' + (p.error ? ' broken' : '') + '">'
          + '<button class="' + cls + '" data-id="' + esc(p.id) + '" data-on="' + (p.enabled ? '1' : '0') + '" title="点击切换"></button>'
          + '<div class="meta">'
          + '<div class="title"><span class="name">' + esc(p.name) + '</span>'
          + '<span class="id">' + esc(p.id) + '</span>' + ver + chip + inst + '</div>'
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


# --------------------------------------------------------------------------- #
# 应用主体
# --------------------------------------------------------------------------- #


class DshShellApp(object):
    def __init__(self):
        self.service = DshService()
        self.window = None
        self.manager_window = None
        self.icon = None
        self.quitting = False
        self.busy = threading.Lock()
        # 任务栏任务动画监听（订阅 dsh 任务状态，有任务时刷标题动画）
        self.taskbar_watcher = None
        # 插件管理器窗口底部那行状态文字
        self.plugin_status = ""
        self.plugin_error = False
        # 主窗口几何记忆：_last_geometry 记录最近一次已知的 (x, y, w, h)，
        # 退出/重启时写回 config.json。None 表示还没拿到过。
        self._last_geometry = None

    def set_plugin_status(self, text, error=False):
        self.plugin_status = str(text or "")
        self.plugin_error = bool(error)

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
                }
            )
        return {
            "plugins": rows,
            "pluginsDir": plugins_dir(),
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
            self.service.ensure_runtime_manifest()
            mark("_ensure_service: manifest 就绪")

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
                ok, output = self.service.npm_install(PACKAGE, self._npm_progress)
                if not ok:
                    log("安装失败:\n%s" % output)
                    self.set_status("安装失败", output, "err")
                    self.set_tail(output)
                    self.notify("安装失败，详情见界面或日志")
                    return
                version = self.service.installed_version()
                log("安装完成，版本 %s" % version)

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

    def action_restart_app(self, *_args):
        """托盘「重启应用」：先拉起一个新实例，再退出当前实例。

        新实例带着 DSH_UI_RESTART=1 启动，会在单实例锁上轮询等待本实例退出
        （见 acquire_single_instance），所以这里先 spawn 再 quit 的顺序是安全的：
        新实例不会因为锁被占而直接退出。旧实例退出时 _shutdown() 会停掉 dsh 服务，
        新实例随后按正常启动流程把服务拉起来。
        """
        if not self.busy.acquire(blocking=False):
            self.notify("已有任务在执行，请稍候")
            return
        try:
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
            log("重启应用：拉起新实例 %s" % " ".join(cmd))
            subprocess.Popen(
                cmd,
                cwd=os.path.dirname(exe) or None,
                env=env,
                creationflags=CREATE_NO_WINDOW,
            )
            self.quit()
        except Exception as exc:  # noqa: BLE001
            log("重启应用异常: %s\n%s" % (exc, traceback.format_exc()))
            self.set_status("重启失败", str(exc), "err")
            self.notify("重启失败：%s" % exc)
        finally:
            self.busy.release()

    def action_update(self, *_args):
        if not self.busy.acquire(blocking=False):
            self.notify("已有任务在执行，请稍候")
            return
        threading.Thread(target=self._do_update, daemon=True).start()

    def _do_update(self):
        try:
            before = self.service.installed_version()
            log("开始更新，当前版本 %s" % before)
            self.notify("开始更新 DeepSeek Harness…")
            self.set_status("正在停止服务…", "更新前先关闭本地服务", "")
            self.set_tail("")
            self.service.stop()

            self.set_status(
                "正在通过 npm 拉取最新版本…",
                "npm install %s@latest" % PACKAGE,
            )
            ok, output = self.service.npm_install(PACKAGE + "@latest", self._npm_progress)
            if not ok:
                log("更新失败:\n%s" % output)
                self.set_status("更新失败", "已保留原有版本，正在恢复服务", "err")
                self.set_tail(output)
                self.notify("更新失败，尝试恢复原有服务")
                self.start_service_async(reload_page=False)
                return

            after = self.service.installed_version()
            log("更新完成 %s -> %s" % (before, after))
            self.set_status("更新完成，正在重启服务…", "dsh %s" % (after or "?"), "done")
            self.service.start()
            self.service.wait_ready(poll_log=self.set_tail)
            self.set_status("已更新到 dsh %s" % (after or "?"), "服务已就绪", "done")
            self.load_url()
            if before and after and before == after:
                self.notify("已是最新版本 dsh %s" % after)
            else:
                self.notify("已更新：%s -> %s" % (before or "未安装", after or "?"))
        except Exception as exc:  # noqa: BLE001
            log("更新异常: %s\n%s" % (exc, traceback.format_exc()))
            self.set_status("更新异常", str(exc), "err")
            self.notify("更新异常：%s" % exc)
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
        version = self.service.installed_version()
        source = "running" if self.service.running() else "stopped"
        return "dsh %s · %s" % (version or "未安装", source)

    def _update_label(self, _item=None):
        return "正在更新…" if self.busy.locked() else "检查更新（npm）"

    @staticmethod
    def _registry_label(_item=None):
        return "npm 源：%s" % registry_label(effective_registry())

    def action_toggle_registry(self, *_args):
        """托盘菜单点一下就在 镜像1 → 镜像2 → 镜像3 → 跟随系统 → 镜像1 之间轮换。"""
        cfg = load_config()
        current = (cfg.get("registry") or "").strip()
        order = [url for _label, url in REGISTRY_CHOICES] + [""]
        if current in order:
            nxt = order[(order.index(current) + 1) % len(order)]
        else:
            nxt = order[0]
        cfg["registry"] = nxt
        save_config(cfg)
        log("npm 源切换为：%s" % (cfg["registry"] or "(系统默认)"))
        self.notify("npm 源已切换：%s" % registry_label(nxt))

    def build_menu(self):
        return pystray.Menu(
            pystray.MenuItem("打开主界面", self.show_window, default=True),
            pystray.MenuItem("插件管理器", self.show_plugin_manager),
            pystray.MenuItem("在浏览器中打开", self.open_in_browser),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(self._version_label, None, enabled=False),
            pystray.MenuItem("重启应用", self.action_restart_app),
            pystray.MenuItem(self._update_label, self.action_update),
            pystray.MenuItem(self._registry_label, self.action_toggle_registry),
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
        for name in ("window", "manager_window"):
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
        """退出收尾：停安装/服务 -> 销毁窗口 -> 强杀进程。"""
        try:
            # 首次安装还在跑的话，先把 npm 进程树杀掉，别留 node 在后台下载
            self.service.stop_npm_install()
        except Exception as exc:  # noqa: BLE001
            log("退出时终止 npm 安装失败: %s" % exc)
        try:
            self.service.stop()
        except Exception as exc:  # noqa: BLE001
            log("退出时停止服务失败: %s" % exc)
        mark("服务已停")
        for name in ("window", "manager_window"):
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

    def open_dsh_dir(self):
        self._app._open_path(dsh_home())

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
        live = any(item.get("running") for item in items)
        self._update_live(live)

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
                # args = [sessionId, running]
                self._update_live(bool(args[1]))
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
    log("dsh 目录: %s" % dsh_home())
    log("node: %s" % find_node())
    mark("main() 开始（frozen=%s）" % getattr(sys, "frozen", False))
    report_onefile_extract()

    ok, _handle = acquire_single_instance()
    if not ok:
        log("已有实例在运行，本次启动退出")
        return
    mark("单实例锁就绪")

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
