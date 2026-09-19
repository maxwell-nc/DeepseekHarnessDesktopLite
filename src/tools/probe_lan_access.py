# -*- coding: utf-8 -*-
"""lan_access 插件自测：二维码编码器 + 反向代理行为。

    <venv>/Scripts/python.exe src/tools/probe_lan_access.py

检查本体在 probe_lan_access_checks.mjs（逻辑全是 JS，放在 JS 里写最直白），
这个脚本只负责：找 node、把插件目录传过去、转发输出与退出码。

**不碰真实环境**：假上游是本进程里现起的 node:http，访问码文件指向临时目录，
不读也不写 %LOCALAPPDATA%，更不会去连真实的 dsh 服务。
"""

import os
import shutil
import subprocess
import sys
import tempfile

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

    plugin_dir = os.path.join(ROOT, "dist", "plugins", "lan_access")
    checks = os.path.join(HERE, "probe_lan_access_checks.mjs")
    if not os.path.isdir(plugin_dir):
        print("找不到插件目录：%s" % plugin_dir)
        return 2

    print("node     : %s" % node)
    print("插件目录 : %s" % plugin_dir)
    print("")

    # 临时目录：万一将来有落盘的东西，别写到真实的数据根去
    scratch = tempfile.mkdtemp(prefix="dsh-lan-access-probe-")
    env = dict(os.environ)
    env["DSH_LAN_ACCESS_DATA"] = os.path.join(scratch, "lan_access.json")
    env["DSH_LAN_ACCESS_QUIET"] = "1"
    env.pop("DSH_LAN_ACCESS_PORT", None)

    try:
        proc = subprocess.run(
            [node, checks, plugin_dir],
            env=env,
            cwd=scratch,
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
    except OSError as exc:
        print("拉起 node 失败：%s" % exc)
        return 2
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    sys.stdout.write(proc.stdout or "")
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
