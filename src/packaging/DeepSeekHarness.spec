# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller 打包配置
--------------------

把 ``src/dsh_shell.py`` 打成 **无控制台** 的单文件 exe。

    <venv>/Scripts/python.exe src/build.py        # 由 build.py 调用
    pyinstaller src/packaging/DeepSeekHarness.spec --noconfirm --clean
"""

import os

# SPECPATH = <项目根>/src/packaging
SRC = os.path.abspath(os.path.join(SPECPATH, ".."))       # <项目根>/src
ICON = os.path.join(SRC, "assets", "app.ico")

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
    datas=[],
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
    a.binaries,
    a.datas,
    [],
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
)
