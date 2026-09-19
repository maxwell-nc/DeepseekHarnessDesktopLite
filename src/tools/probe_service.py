# -*- coding: utf-8 -*-
"""服务层自测：安装 -> 启动 -> 健康检查 -> 更新 -> 停止。"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.dirname(HERE)                                    # <项目根>/src
sys.pycache_prefix = os.path.join(os.path.dirname(SRC), "build", "pycache")
sys.path.insert(0, SRC)

import dsh_shell as sh  # noqa: E402


def step(title):
    print("\n" + "=" * 62)
    print(title)
    print("=" * 62)


step("1. 环境定位")
bundled = sh.bundled_node_dir()
node = sh.find_node()
print("自带 node     :", bundled)
print("node          :", node)
print("node 来源     :", "自带" if bundled and node
      and os.path.dirname(node) == bundled else "系统 / PATH")
print("npm-cli       :", sh.find_npm_cli(node))
print("runtime dir   :", sh.RUNTIME_DIR)

svc = sh.DshService()
print("已安装版本    :", svc.installed_version())
print("npm registry  :", sh.effective_registry() or "(跟随系统)")

if not svc.installed_version():
    step("2. npm install @deepseek-ai/dsh")
    t0 = time.time()
    ok, out = svc.npm_install(
        sh.PACKAGE, lambda line: print("  npm> %s" % line, flush=True)
    )
    print("耗时 %.1fs  成功=%s" % (time.time() - t0, ok))
    print("---- 末尾输出 ----")
    print(out[-1500:])
    if not ok:
        sys.exit(1)

print("\n安装后版本    :", svc.installed_version())
print("入口脚本      :", svc.entry_script())
print("入口存在      :", os.path.isfile(svc.entry_script()))

if sh.http_alive():
    print("端口已有服务，先停掉")
    svc.stop()

step("3. 启动服务并捕获带 token 的访问地址")
t0 = time.time()
svc.start()
ready = svc.wait_ready(timeout=180, poll_log=lambda t: print("[service]", t[:400]))
print("就绪=%s  耗时 %.1fs" % (ready, time.time() - t0))
print("access_url    :", svc.access_url)
print("端口 PID      :", sh.pids_on_port())
print("---- 服务日志尾部 ----")
print(svc.read_service_tail(20))

if ready:
    import urllib.request

    for label, target in (("裸地址 ", sh.URL), ("带 token", svc.access_url)):
        try:
            with urllib.request.urlopen(target, timeout=8) as resp:
                body = resp.read(200)
            print("%s -> HTTP %s (%d 字节)" % (label, resp.status, len(body)))
        except urllib.error.HTTPError as exc:
            print("%s -> HTTP %s  %s" % (label, exc.code, exc.read(120)))
        except Exception as exc:
            print("%s -> 失败 %s" % (label, exc))

step("4. 停止服务")
t0 = time.time()
stopped = svc.stop()
print("端口已释放=%s  耗时 %.1fs" % (stopped, time.time() - t0))
print("http_alive    :", sh.http_alive())

step("5. shell 日志尾部")
print(open(sh.SHELL_LOG, "r", encoding="utf-8", errors="replace").read()[-1500:])

print("\nDONE")
