# -*- coding: utf-8 -*-
"""retry 插件自测：切点计算 + 宿主接口 + 浏览器半边。

    <venv>/Scripts/python.exe src/tools/probe_retry.py

检查本体在 probe_retry_checks.mjs（假日志、假 ctx、假 DOM 全是 JS，放 JS 里写最直白），
这个脚本只负责：找 node、把插件目录传过去、转发输出与退出码。

**不碰真实环境**：不读不写 %LOCALAPPDATA%，不起服务，不发网络请求（浏览器半边的
fetch 也是假的）。
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.dirname(HERE)                                    # <项目根>/src
ROOT = os.path.dirname(SRC)                                    # <项目根>
sys.pycache_prefix = os.path.join(ROOT, "build", "pycache")
sys.path.insert(0, SRC)

import dsh_shell  # noqa: E402


def main():
    node = dsh_shell.find_node()
    if not node:
        print("找不到可用的 Node（产物内 dist/node 缺失，系统里也没有），跳过。")
        return 2

    plugin_dir = os.path.join(ROOT, "dist", "plugins", "retry")
    checks = os.path.join(HERE, "probe_retry_checks.mjs")
    if not os.path.isdir(plugin_dir):
        print("找不到插件目录：%s" % plugin_dir)
        return 2

    print("node     : %s" % node)
    print("插件目录 : %s" % plugin_dir)
    print("")

    env = dict(os.environ)
    env["DSH_UI_RETRY_QUIET"] = "1"

    try:
        proc = subprocess.run(
            [node, checks, plugin_dir],
            env=env,
            cwd=HERE,
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
    except OSError as exc:
        print("拉起 node 失败：%s" % exc)
        return 2

    sys.stdout.write(proc.stdout or "")
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
