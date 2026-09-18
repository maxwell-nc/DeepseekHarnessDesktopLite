# -*- coding: utf-8 -*-
"""
一键打包：生成无控制台的单文件 exe。

    <venv>/Scripts/python.exe src/build.py

产物：``dist/DeepSeekHarness.exe``
"""

import os
import sys

# 源码旁边的 __pycache__ 是噪音，统一丢到 build/pycache 下。
# 必须在 import 自己的模块之前设置，否则 pyc 已经写到 src/ 里了。
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.pycache_prefix = os.path.join(_ROOT, "build", "pycache")

import subprocess  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))   # <项目根>/src
ROOT = _ROOT                                        # <项目根>
SRC = HERE
ASSETS = os.path.join(SRC, "assets")
ICON = os.path.join(ASSETS, "app.ico")
SPEC = os.path.join(SRC, "packaging", "DeepSeekHarness.spec")
DIST = os.path.join(ROOT, "dist")
BUILD = os.path.join(ROOT, "build")
PLUGINS = os.path.join(DIST, "plugins")


def plugin_report():
    """dist/plugins 是运行时资产（dsh-ui 扫描 exe 同目录的 plugins/），
    不在 exe 里、也不该被 PyInstaller 动到 —— 顺手报一下有几包。"""
    if not os.path.isdir(PLUGINS):
        print("[build] 注意：%s 不存在，exe 将没有任何插件可加载" % PLUGINS)
        return
    names = [
        name
        for name in sorted(os.listdir(PLUGINS))
        if os.path.isfile(os.path.join(PLUGINS, name, "manifest.json"))
    ]
    print("[build] 插件目录： %s（%d 个包：%s）" % (PLUGINS, len(names), "、".join(names) or "空"))


def main():
    # 1. 图标
    os.makedirs(ASSETS, exist_ok=True)
    if not os.path.isfile(ICON):
        sys.path.insert(0, SRC)
        import app_icon

        app_icon.save_ico(ICON)
        print("[build] 已生成图标 %s" % ICON)

    # 2. 依赖自检
    try:
        import PyInstaller  # noqa: F401
        import pystray  # noqa: F401
        import webview  # noqa: F401
    except ImportError as exc:
        print("[build] 缺少依赖：%s" % exc)
        print("        请先执行： pip install pywebview pystray pillow pyinstaller")
        return 1

    # 3. 调用 PyInstaller
    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--distpath",
        DIST,
        "--workpath",
        BUILD,
        SPEC,
    ]
    print("[build] %s" % " ".join(cmd))
    code = subprocess.call(cmd, cwd=ROOT)
    if code != 0:
        print("[build] 打包失败，退出码 %s" % code)
        return code

    exe = os.path.join(DIST, "DeepSeekHarness.exe")
    if os.path.isfile(exe):
        print("[build] 完成： %s" % exe)
        print("[build] 体积： %.1f MB" % (os.path.getsize(exe) / 1048576.0))
    else:
        print("[build] 未找到产物： %s" % exe)
        return 1

    plugin_report()
    return 0


if __name__ == "__main__":
    sys.exit(main())
