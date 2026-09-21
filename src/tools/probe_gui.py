# -*- coding: utf-8 -*-
"""GUI 行为自测：启动壳 -> 等界面加载 -> 发 WM_CLOSE -> 确认缩到托盘且进程存活。"""
import ctypes
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.dirname(HERE)                                    # <项目根>/src
ROOT = os.path.dirname(SRC)
sys.pycache_prefix = os.path.join(ROOT, "build", "pycache")
sys.path.insert(0, SRC)

import dsh_shell as sh  # noqa: E402

user32 = ctypes.windll.user32
user32.FindWindowW.restype = ctypes.c_void_p
user32.FindWindowW.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p]
user32.IsWindowVisible.argtypes = [ctypes.c_void_p]
user32.PostMessageW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]

WM_CLOSE = 0x0010

print("=" * 62)
print("清理上一次残留")
print("=" * 62)
sh.DshService().stop()

# 防睡眠标志是进程级的：壳进程退出后系统自动清除，所以这里先确认当前是"未设置"。
print("启动前防睡眠状态 :", sh._awake_held, "（应为 False）")

log_start = 0
try:
    log_start = os.path.getsize(sh.SHELL_LOG)
except OSError:
    pass

print("\n启动壳程序（%s）" % os.path.join(SRC, "dsh_shell.py"))
import subprocess  # noqa: E402

# 不带参数时跑源码；传 exe 路径则测打包产物
target = sys.argv[1] if len(sys.argv) > 1 else os.path.join(SRC, "dsh_shell.py")
if target.lower().endswith(".exe"):
    cmd = [target]
    cwd = os.path.dirname(target)
else:
    cmd = [sys.executable, target]
    cwd = ROOT
print("命令: %s" % " ".join(cmd))

proc = subprocess.Popen(
    cmd,
    cwd=cwd,
    creationflags=subprocess.CREATE_NO_WINDOW,
)
print("壳进程 pid=%s" % proc.pid)

hwnd = None
deadline = time.time() + 60
while time.time() < deadline:
    if proc.poll() is not None:
        print("壳进程提前退出，exit=%s" % proc.returncode)
        break
    hwnd = user32.FindWindowW(None, sh.APP_NAME)
    if hwnd:
        print("找到窗口 hwnd=%s  用时 %.1fs" % (hwnd, 60 - (deadline - time.time())))
        break
    time.sleep(1)

if not hwnd:
    print("未找到窗口")
else:
    # 壳刻意先 hidden、等首屏 HTML 渲染完再显示（不然用户会先看到一片白），
    # 所以这里轮询等待的是「真的看得见」的那一刻。
    shown_after = None
    waited = time.time()
    while time.time() - waited < 30:
        if user32.IsWindowVisible(hwnd):
            shown_after = time.time() - waited
            break
        time.sleep(0.2)
    print("窗口可见 :", shown_after is not None,
          "（找到句柄后等了 %s）" % ("%.1fs" % shown_after if shown_after is not None else "超时 30s"))

    # 等服务就绪（dsh 冷启动要好几秒），别睡固定时长
    ready = False
    waited = time.time()
    while time.time() - waited < 90:
        if sh.http_alive():
            ready = True
            break
        time.sleep(0.5)
    print("服务就绪 :", ready, "（等了 %.1fs）" % (time.time() - waited))
    print("端口占用 :", sh.pids_on_port())
    print("HTTP 可达:", sh.http_alive())

    # 防睡眠是壳进程内的状态，探针进程里看不到；改从日志确认设置成功。
    print("\n--- 防睡眠检查 ---")
    try:
        with open(sh.SHELL_LOG, "r", encoding="utf-8", errors="replace") as fh:
            fh.seek(log_start)
            log_text = fh.read()
        print("日志含「已阻止系统睡眠」:", "已阻止系统睡眠" in log_text)
        print("日志含「防睡眠已设置」  :", "防睡眠已设置" in log_text)
    except OSError as exc:
        print("读日志失败:", exc)

    print("\n--- 发送 WM_CLOSE（模拟点关闭按钮）---")
    user32.PostMessageW(hwnd, WM_CLOSE, None, None)

    # 轮询而不是睡固定时长：区分「隐藏得慢」和「压根没隐藏」
    still_alive = None
    visible = None
    for i in range(12):
        time.sleep(1)
        still_alive = user32.FindWindowW(None, sh.APP_NAME)
        visible = bool(user32.IsWindowVisible(still_alive)) if still_alive else None
        print("  +%2ds 句柄=%s 可见=%s" % (i + 1, still_alive, visible))
        if visible is False:
            break

    print("关闭后窗口句柄 :", still_alive)
    print("关闭后窗口可见 :", visible, "（应为 False，即收进托盘）")
    print("壳进程存活     :", proc.poll() is None, "（应为 True）")
    print("服务仍在运行   :", bool(sh.pids_on_port()), "（应为 True）")

    # 收进托盘后防睡眠应仍然保持（服务继续后台跑）
    try:
        with open(sh.SHELL_LOG, "r", encoding="utf-8", errors="replace") as fh:
            fh.seek(log_start)
            log_text = fh.read()
        print("托盘驻留后防睡眠仍保持:", "已阻止系统睡眠" in log_text and "已释放防睡眠" not in log_text)
    except OSError as exc:
        print("读日志失败:", exc)

print("\n--- 壳日志 ---")
try:
    with open(sh.SHELL_LOG, "r", encoding="utf-8", errors="replace") as fh:
        fh.seek(log_start)
        print(fh.read()[-2500:])
except OSError as exc:
    print("读日志失败:", exc)

print("\n--- 清理 ---")
proc.terminate()
try:
    proc.wait(timeout=10)
except Exception:
    proc.kill()
time.sleep(1)
sh.DshService().stop()
print("已清理，端口占用:", sh.pids_on_port() or "无")
