# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller 打包配置
--------------------

把 ``src/dsh_shell.py`` 打成 **无控制台** 的 onedir 目录（``_internal/`` + exe）。

产物由 ``build.py`` 搬进 ``dist/``（``dist`` 本身就是程序目录：exe + ``_internal/`` +
``plugins/``）。本 spec 只负责打出一个自洽的 onedir 目录，不关心它最后落在哪。

为什么不是 onefile：单文件 exe 每次启动都要把自己解压到 ``%TEMP%\\_MEIxxxxx``，
实测多花 0.46s（含冷读），而且被强杀 / 崩溃时解压目录不会被清理，会慢慢吃掉
临时盘（实测 18 个残留共 646MB）。换成目录后这段开销直接消失。

    <venv>/Scripts/python.exe src/build.py        # 由 build.py 调用
    pyinstaller src/packaging/DeepSeekHarness.spec --noconfirm --clean
"""

import os

# SPECPATH = <项目根>/src/packaging
SRC = os.path.abspath(os.path.join(SPECPATH, ".."))       # <项目根>/src
ICON = os.path.join(SRC, "assets", "app.ico")
MANIFEST = os.path.join(SPECPATH, "app.manifest")         # DPI 感知清单

# 启动加速补丁：node --import 要求它是磁盘上的真实文件，必须打进包里，
# 运行时从 sys._MEIPASS/runtime/ 取。
RUNTIME_FILES = [
    (os.path.join(SRC, "runtime", "dsh_fastboot.mjs"), "runtime"),
]

# 动态导入的模块，静态分析扫不到，必须显式声明
hiddenimports = [
    "webview.platforms.winforms",
    "webview.platforms.win32",
    "webview.platforms.edgechromium",
    "pystray._win32",
    "clr",
    "clr_loader",
]

# 明确用不到的东西，剔掉能省不少体积
excludes = [
    "tkinter",
    "unittest",
    "pydoc",
    "doctest",
    "numpy",
    "pandas",
    "matplotlib",
    "PyQt5",
    "PyQt6",
    "PySide2",
    "PySide6",
    "IPython",
]


a = Analysis(
    [os.path.join(SRC, "dsh_shell.py")],
    pathex=[SRC],
    binaries=[],
    datas=RUNTIME_FILES,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,         # onedir：依赖交给下面的 COLLECT，exe 本体只是个启动器
    name="DeepSeekHarness",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=False,                 # 关键：无控制台窗口
    disable_windowed_traceback=True,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=ICON if os.path.isfile(ICON) else None,
    manifest=MANIFEST if os.path.isfile(MANIFEST) else None,
)

# onedir 产物： dist/DeepSeekHarness/DeepSeekHarness.exe + _internal/
# PyInstaller 6.x 会把 binaries/datas 全收进 _internal/，sys._MEIPASS 指向它，
# 所以 dsh_shell.py 里 fastboot_script() 的 _MEIPASS 拼法不用改。
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="DeepSeekHarness",
)
