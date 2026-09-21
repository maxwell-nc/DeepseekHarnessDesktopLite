# 以 dsh_shell.py 服务进程完全相同的启动参数拉起 node 子进程，
# 触发 revealDirectory 同款 explorer.exe spawn，观察服务进程是否退出。
import subprocess
import sys
import time

CREATE_NO_WINDOW = 0x08000000
CREATE_NEW_PROCESS_GROUP = 0x00000200

NODE = r"D:\Project\Github\DeepseekHarnessDesktopLite\dist\node\node.exe"
SCRIPT = r"D:\Project\Github\DeepseekHarnessDesktopLite\src\tools\probe_reveal_child.mjs"

proc = subprocess.Popen(
    [NODE, SCRIPT],
    stdin=subprocess.DEVNULL,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    creationflags=CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP,
    text=True,
    encoding="utf-8",
    errors="replace",
    bufsize=1,
)

deadline = time.time() + 10
for raw in proc.stdout:
    line = raw.rstrip()
    print("child>", line)
    if time.time() > deadline:
        break

proc.wait(timeout=5)
print("exit code:", proc.returncode)
