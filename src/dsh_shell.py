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

import json
import logging
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
from PIL import Image

from app_icon import make_icon, save_ico

# --------------------------------------------------------------------------- #
# 常量
# --------------------------------------------------------------------------- #

APP_NAME = "DeepSeek Harness"
APP_VERSION = "1.0.0"
PACKAGE = "@deepseek-ai/dsh"
HOST = "127.0.0.1"
PORT = 3080
URL = "http://%s:%d" % (HOST, PORT)
MUTEX_NAME = "Local\\DeepSeekHarnessDesktopShell"

# 窗口底色：亮色主题，和 HTML 里的 --bg 保持一致（WebView2 首帧还没渲染时的底色）
WINDOW_BG = "#f4f6fb"

# 官方源在国内基本连不上，默认强制走国内镜像；
# 置空则回退到系统自身的 npm 配置（~/.npmrc）。
DEFAULT_REGISTRY = "https://registry.npmmirror.com"

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


def _dir_signature(path):
    """目录指纹：文件数 + 最新 mtime。用来判断源目录变没变，避免每次启动都重刷。"""
    count = 0
    newest = 0.0
    for root, _dirs, files in os.walk(path):
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
    """把插件包镜像到 dsh 的 plugins/ 下；源目录没变就跳过（省掉每次启动的复制）。"""
    signature = _dir_signature(package.path)
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
    shutil.copytree(package.path, dest)
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


def find_node():
    """找到 node.exe。优先 PATH，其次常见安装位置。"""
    found = shutil.which("node")
    if found:
        return found
    for folder in _node_dirs():
        candidate = os.path.join(folder, "node.exe")
        if os.path.isfile(candidate):
            return candidate
    return None


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


def port_open(port=PORT, host=HOST, timeout=0.5):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


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


def pids_on_port(port=PORT):
    """列出正在监听该端口的进程 PID（用于兜底清理残留服务）。"""
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
                "未检测到 Node.js。请先安装 Node.js 18 或更高版本（https://nodejs.org），"
                "然后重新启动本程序。"
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
            node_exe = find_node()
            if not node_exe:
                raise RuntimeError("未检测到 Node.js，请先安装 Node.js 18+")
            entry = self.entry_script()
            if not os.path.isfile(entry):
                raise RuntimeError("DeepSeek Harness 尚未安装完整：%s" % entry)

            self.web_url = None
            self._service_tail.clear()
            _rotate(SERVICE_LOG, time.strftime("%Y%m%d%H%M%S"))
            try:
                self._log_handle = open(SERVICE_LOG, "a", encoding="utf-8", errors="replace")
            except OSError:
                self._log_handle = None

            # --no-open：别让 dsh 自己弹系统浏览器，界面交给本程序的 WebView2
            cmd = [node_exe, entry, "web", "--no-open"]
            log("启动服务: %s (cwd=%s)" % (" ".join(cmd), WORKSPACE_DIR))
            self._proc = subprocess.Popen(
                cmd,
                cwd=WORKSPACE_DIR,
                env=self._child_env(node_exe, effective_registry()),
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

    def stop(self, wait_release=25.0):
        """停掉服务：先收自己拉起的进程，再兜底清掉占用端口的残留 node。"""
        with self._lock:
            proc = self._proc
            self._proc = None
            handle = self._log_handle
            self._log_handle = None

        if proc is not None and proc.poll() is None:
            log("停止服务 pid=%s" % proc.pid)
            kill_tree(proc.pid)

        for pid in pids_on_port():
            log("清理占用 %d 端口的残留进程 pid=%s" % (PORT, pid))
            kill_tree(pid)

        deadline = time.time() + wait_release
        while time.time() < deadline and port_open():
            time.sleep(0.3)

        if handle is not None:
            try:
                handle.close()
            except Exception:
                pass

        self.web_url = None

        if port_open():
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
            if self.web_url and http_alive():
                return True
            with self._lock:
                proc = self._proc
            if proc is not None and proc.poll() is not None:
                log("服务进程已退出，exit=%s" % proc.returncode)
                if poll_log is not None:
                    poll_log(self.read_service_tail())
                return False
            # 端口通了但还没打印出 token 时，给个提示
            if not announced and http_alive():
                announced = True
                log("端口已就绪，等待 dsh 输出访问地址")
            time.sleep(0.4)
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

SPLASH_HTML = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>DeepSeek Harness</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center;
    background: radial-gradient(circle at 50% 26%, #ffffff 0%, #eef2fb 62%, #e2e9f7 100%);
    color: #1b2130; font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    -webkit-user-select: none; user-select: none; overflow: hidden;
  }
  .wrap { width: 620px; padding: 40px; text-align: center; }
  .logo {
    width: 84px; height: 84px; margin: 0 auto 26px;
    border-radius: 26px;
    background: linear-gradient(135deg, #4d6bfe 0%, #283ebe 100%);
    display: flex; align-items: center; justify-content: center;
    font-size: 46px; font-weight: 700; color: #fff;
    box-shadow: 0 16px 36px rgba(77, 107, 254, .28);
  }
  h1 { margin: 0 0 10px; font-size: 21px; font-weight: 600; letter-spacing: .3px; color: #141a27; }
  #status { margin: 0; font-size: 14px; color: #5b6478; min-height: 20px; }
  #detail {
    margin: 14px auto 0; font-size: 12px; color: #8a93a8;
    max-width: 520px; line-height: 1.7; word-break: break-all;
    font-family: Consolas, "Cascadia Mono", monospace;
  }
  .spinner {
    margin: 22px auto 0; width: 22px; height: 22px;
    border: 2.5px solid rgba(77, 107, 254, .18);
    border-top-color: #4d6bfe; border-radius: 50%;
    animation: spin .8s linear infinite;
  }
  .spinner.done { animation: none; border-color: rgba(17, 158, 106, .32); border-top-color: #119e6a; }
  .spinner.err { animation: none; border-color: rgba(214, 60, 76, .35); border-top-color: #d63c4c; }
  @keyframes spin { to { transform: rotate(360deg); } }
  #tail {
    margin: 18px auto 0; padding: 12px 14px; max-width: 560px; max-height: 150px;
    overflow: hidden; text-align: left; font-size: 11px; line-height: 1.65;
    color: #5f6880; background: #fff;
    border: 1px solid rgba(22, 32, 58, .10); border-radius: 10px;
    font-family: Consolas, "Cascadia Mono", monospace; white-space: pre-wrap;
    word-break: break-all; display: none; -webkit-user-select: text; user-select: text;
  }
</style>
</head>
<body>
  <div class="wrap">
    <div class="logo">D</div>
    <h1>DeepSeek Harness</h1>
    <p id="status">正在准备…</p>
    <div class="spinner" id="spinner"></div>
    <div id="detail"></div>
    <div id="tail"></div>
  </div>
<script>
  window.__setStatus = function (text, detail, kind) {
    document.getElementById('status').textContent = text || '';
    document.getElementById('detail').textContent = detail || '';
    var sp = document.getElementById('spinner');
    sp.className = 'spinner' + (kind ? ' ' + kind : '');
  };
  window.__setTail = function (text) {
    var el = document.getElementById('tail');
    if (!text) { el.style.display = 'none'; el.textContent = ''; return; }
    el.style.display = 'block';
    el.textContent = String(text).slice(-1600);
  };
</script>
</body>
</html>
"""


# --------------------------------------------------------------------------- #
# 插件管理器窗口
# --------------------------------------------------------------------------- #

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
        self._splash_loaded = threading.Event()
        # 插件管理器窗口底部那行状态文字
        self.plugin_status = ""
        self.plugin_error = False

    def set_plugin_status(self, text, error=False):
        self.plugin_status = str(text or "")
        self.plugin_error = bool(error)

    # ---------------- 启动页状态 ---------------- #

    def set_status(self, text, detail="", kind=""):
        self._eval(
            "window.__setStatus && window.__setStatus(%s, %s, %s);"
            % (js_str(text), js_str(detail), js_str(kind))
        )

    def set_tail(self, text):
        self._eval("window.__setTail && window.__setTail(%s);" % js_str(text))

    def _eval(self, script):
        window = self.window
        if window is None:
            return
        for _ in range(4):
            try:
                window.evaluate_js(script)
                return
            except Exception:
                time.sleep(0.35)

    def notify(self, message, title=None):
        try:
            if self.icon is not None:
                self.icon.notify(message, title or APP_NAME)
        except Exception as exc:  # noqa: BLE001
            log("托盘通知失败: %s" % exc)

    # ---------------- 窗口 ---------------- #

    def on_window_closing(self):
        """点关闭按钮 -> 收进托盘，不退出程序。"""
        if self.quitting:
            return True
        log("窗口关闭 -> 最小化到托盘")
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

            # 启动前先按「已启用的插件」把 plugins/ 镜像进 dsh 并刷新补丁文件。
            # 失败不阻塞启动：dsh 照常按现有补丁跑。
            try:
                sync_plugins(on_note=self.set_plugin_status)
            except Exception as exc:  # noqa: BLE001
                log("同步插件异常（继续启动）: %s" % exc)

            version = self.service.installed_version()
            if not version:
                self.set_status(
                    "首次运行，正在安装 DeepSeek Harness…",
                    "npm install %s —— 首次安装需要下载依赖，请耐心等待\nregistry: %s"
                    % (PACKAGE, effective_registry() or "系统默认"),
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
            if port_open():
                log("端口 %d 已被占用，先清理再启动" % PORT)
                self.set_status("正在清理旧服务…", "停掉上一次残留的 dsh 进程")
                self.service.stop()

            self.set_status("正在启动本地服务…", "dsh web --no-open @ %s" % URL)
            self.service.start()
            if not self.service.wait_ready(poll_log=self.set_tail):
                self.set_status(
                    "服务启动失败或超时",
                    "请查看日志：%s" % SHELL_LOG,
                    "err",
                )
                self.set_tail(self.service.read_service_tail())
                self.notify("本地服务启动失败，请查看日志")
                return

            log("服务就绪：%s（dsh %s）" % (self.service.access_url, version or "?"))
            self.set_status("正在加载界面…", "dsh %s" % (version or "?"), "done")
            if reload_page:
                self.load_url()
        except Exception as exc:  # noqa: BLE001
            log("启动流程异常: %s\n%s" % (exc, traceback.format_exc()))
            self.set_status("启动失败", str(exc), "err")
            self.set_tail(traceback.format_exc(limit=3))

    def _npm_progress(self, line):
        self.set_tail(line)

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
            window.load_url(url)
        except Exception as exc:  # noqa: BLE001
            log("加载界面失败: %s" % exc)

    # ---------------- 托盘动作 ---------------- #

    def action_restart(self, *_args):
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
        registry = effective_registry()
        if not registry:
            return "npm 源：跟随系统"
        if "npmmirror" in registry:
            return "npm 源：国内镜像"
        return "npm 源：%s" % registry

    def action_toggle_registry(self, *_args):
        cfg = load_config()
        current = (cfg.get("registry") or "").strip()
        if "npmmirror" in current:
            cfg["registry"] = ""
            label = "跟随系统 npm 配置"
        else:
            cfg["registry"] = DEFAULT_REGISTRY
            label = "国内镜像（npmmirror）"
        save_config(cfg)
        log("npm 源切换为：%s" % (cfg["registry"] or "(系统默认)"))
        self.notify("npm 源已切换：%s" % label)

    def build_menu(self):
        return pystray.Menu(
            pystray.MenuItem("打开主界面", self.show_window, default=True),
            pystray.MenuItem("插件管理器", self.show_plugin_manager),
            pystray.MenuItem("在浏览器中打开", self.open_in_browser),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(self._version_label, None, enabled=False),
            pystray.MenuItem("重启服务", self.action_restart),
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
        log("退出：清理托盘与本地服务")
        try:
            if self.icon is not None:
                self.icon.stop()
        except Exception:
            pass
        try:
            self.service.stop()
        except Exception as exc:  # noqa: BLE001
            log("退出时停止服务失败: %s" % exc)
        try:
            if self.window is not None:
                self.window.destroy()
        except Exception:
            pass
        try:
            if self.manager_window is not None:
                self.manager_window.destroy()
        except Exception:
            pass
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
    try:
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        handle = kernel32.CreateMutexW(None, False, MUTEX_NAME)
        if not handle:
            return True, None
        if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
            return False, handle
        return True, handle
    except Exception:  # noqa: BLE001
        return True, None


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

    ok, _handle = acquire_single_instance()
    if not ok:
        log("已有实例在运行，本次启动退出")
        return

    try:
        if not os.path.isfile(ICON_PATH):
            save_ico(ICON_PATH, 256)
    except Exception as exc:  # noqa: BLE001
        log("写入图标失败: %s" % exc)

    app = DshShellApp()

    window = webview.create_window(
        APP_NAME,
        html=SPLASH_HTML,
        width=1280,
        height=860,
        min_size=(940, 620),
        background_color=WINDOW_BG,
        text_select=True,
    )
    app.window = window
    window.events.closing += app.on_window_closing

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

    app.start_tray()
    app.start_service_async()

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

    log("GUI 主循环结束 (quitting=%s)" % app.quitting)
    if not app.quitting:
        # 窗口被直接关掉了（没有走拦截分支），托盘仍可用，保持进程存活
        log("窗口已关闭，程序继续驻留托盘")
        while True:
            time.sleep(3600)


if __name__ == "__main__":
    main()
