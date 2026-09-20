# -*- coding: utf-8 -*-
"""
一键打包：生成无控制台的 onedir 目录（exe + _internal/）。

    <venv>/Scripts/python.exe src/build.py

产物：**``dist/`` 本身就是程序目录** ——

    dist/DeepSeekHarness.exe      启动器
    dist/_internal/               Python 运行时 + 依赖 + runtime/dsh_fastboot.mjs
    dist/plugins/                 插件源码（唯一一份，运行时直接读它）
    dist/node/                    自带的 Node 运行时（手工放，构建脚本不下载）

分发把整个 ``dist/`` 压成 zip。PyInstaller 不能直接输出到 ``dist/`` 根目录
（COLLECT 会先 rmtree 目标目录，那样会把 plugins 一起删掉），所以先打到
``build/collect/``，再把内容搬过来。
"""

import os
import sys

# 源码旁边的 __pycache__ 是噪音，统一丢到 build/pycache 下。
# 必须在 import 自己的模块之前设置，否则 pyc 已经写到 src/ 里了。
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.pycache_prefix = os.path.join(_ROOT, "build", "pycache")

import shutil  # noqa: E402
import subprocess  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))   # <项目根>/src
ROOT = _ROOT                                        # <项目根>
SRC = HERE
ASSETS = os.path.join(SRC, "assets")
ICON = os.path.join(ASSETS, "app.ico")
SPEC = os.path.join(SRC, "packaging", "DeepSeekHarness.spec")
DIST = os.path.join(ROOT, "dist")
BUILD = os.path.join(ROOT, "build")

APP_NAME = "DeepSeekHarness"
PLUGINS = os.path.join(DIST, "plugins")                    # 插件**源码**，同时也是运行时目录
COLLECT_OUT = os.path.join(BUILD, "collect")               # PyInstaller 先落到这里
APP_DIR = os.path.join(COLLECT_OUT, APP_NAME)              # build/collect/DeepSeekHarness/
EXE = os.path.join(DIST, APP_NAME + ".exe")                # dist/DeepSeekHarness.exe
BUNDLED_NODE = os.path.join(DIST, "node")                  # 手工放的自带 Node（dist/* 已被 .gitignore 忽略）


def plugin_report():
    """dist/plugins 是插件源码目录，顺带报一下有几个包（含第三方目录）。"""
    def _names(root):
        if not os.path.isdir(root):
            return []
        return [
            name
            for name in sorted(os.listdir(root))
            if os.path.isfile(os.path.join(root, name, "manifest.json"))
        ]

    names = _names(PLUGINS)
    third = _names(os.path.join(DIST, "plugins-third-party"))
    print("[build] 插件源码： %s（%d 个包：%s）" % (PLUGINS, len(names), "、".join(names) or "空"))
    if third:
        print("[build] 第三方插件： %s（%d 个包：%s，不进版本库）"
              % (os.path.join(DIST, "plugins-third-party"), len(third), "、".join(third)))
    return names


def node_report():
    """提醒 dist/node/ 是否就位：构建期不下载 Node，全靠手工放。

    只警告不失败 —— 开发 / 自测产物用系统 Node 也能跑；但对外发布时缺了它，
    用户机器上没装 Node 就直接起不来，这是最该在构建期拦住的一类错误。
    """
    exe = os.path.join(BUNDLED_NODE, "node.exe")
    if not os.path.isfile(exe):
        print("[build] 警告：%s 不存在 —— 产物不自带 Node，"
              "将回退到用户系统里的 Node（没装则无法启动）" % exe)
        return False
    total, files = dir_size(BUNDLED_NODE)
    print("[build] 自带 Node： %s（%d 个文件，%.1f MB）"
          % (BUNDLED_NODE, files, total / 1048576.0))
    return True


def install_to_dist():
    """把 PyInstaller 打出来的目录内容搬进 dist/（dist 就是程序目录）。

    plugins/ 只有一份、就在 dist 下，所以这里**不碰**它 —— 壳运行时直接读
    ``dirname(exe)/plugins``，也就是源码那份。node/ 同理，PyInstaller 不产出它，
    这里的「清 _internal + 覆盖顶层项」既不会删它也不会覆盖它。
    """
    if not os.path.isdir(APP_DIR):
        print("[build] 未找到 PyInstaller 产物： %s" % APP_DIR)
        return False

    # 先清掉上一次的 _internal，免得残留用不到的旧依赖（删不掉就覆盖，不影响产物）
    stale = os.path.join(DIST, "_internal")
    if os.path.isdir(stale):
        try:
            shutil.rmtree(stale)
        except Exception as exc:  # noqa: BLE001
            # 清不掉也无所谓：下面整目录覆盖，多余的旧文件只是占点空间
            print("[build] 旧 _internal 清理失败（改为直接覆盖）： %s" % exc)

    for name in sorted(os.listdir(APP_DIR)):
        src = os.path.join(APP_DIR, name)
        dest = os.path.join(DIST, name)
        if os.path.isdir(src):
            shutil.copytree(src, dest, dirs_exist_ok=True)
        else:
            shutil.copy2(src, dest)
    return True


def dir_size(path):
    """目录总体积（字节）与文件数。"""
    total = 0
    files = 0
    for base, _dirs, names in os.walk(path):
        for name in names:
            try:
                total += os.path.getsize(os.path.join(base, name))
                files += 1
            except OSError:
                pass
    return total, files


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

    print("[build] 打包形态： onedir，产物直接落在 dist/ 根目录")

    # 3. 调用 PyInstaller（先打到 build/collect，不直接碰 dist）
    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--distpath",
        COLLECT_OUT,
        "--workpath",
        BUILD,
        SPEC,
    ]
    print("[build] %s" % " ".join(cmd))
    code = subprocess.call(cmd, cwd=ROOT)
    if code != 0:
        print("[build] 打包失败，退出码 %s" % code)
        return code

    # 4. 搬进 dist/
    if not install_to_dist():
        return 1
    if not os.path.isfile(EXE):
        print("[build] 未找到产物： %s" % EXE)
        return 1

    plugin_report()
    node_report()
    total, files = dir_size(DIST)
    print("[build] 完成： %s" % EXE)
    print("[build] 程序目录： %s（%d 个文件，%.1f MB，含 plugins、node）"
          % (DIST, files, total / 1048576.0))
    print("[build] 分发：整个 dist 目录压成 zip 即可")

    legacy = os.path.join(DIST, APP_NAME)
    if os.path.isdir(legacy):
        print("[build] 提醒：旧的嵌套布局 %s 还在，确认没问题后整个删掉" % legacy)
    return 0


if __name__ == "__main__":
    sys.exit(main())
