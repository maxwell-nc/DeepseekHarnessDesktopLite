# -*- coding: utf-8 -*-
"""dsh 版本兼容自测：升级 dsh 后，插件依赖的内部接口在新槽位上还在不在。

    <venv>/Scripts/python.exe src/tools/probe_dsh_compat.py            # 所有已下载槽位
    <venv>/Scripts/python.exe src/tools/probe_dsh_compat.py --slot 0.1.7-alpha.2

检查本体在 probe_dsh_compat_checks.mjs（检查表按「插件 → 它依赖的 dsh 接口」写，
加一列就能扩），这个脚本只负责：把已下载的槽位（版本 + node_modules 路径）交给它，
转发输出与退出码。

**只读**：不启动服务、不连真实 dsh、不写 %LOCALAPPDATA%。会真跑一条
`bash -c`（验证执行器 argv 确实换成了 Git Bash），仅此而已。
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.dirname(HERE)                                    # <项目根>/src
ROOT = os.path.dirname(SRC)                                    # <项目根>
sys.pycache_prefix = os.path.join(ROOT, "build", "pycache")
sys.path.insert(0, SRC)

import dsh_shell  # noqa: E402


def arg_value(name):
    """取 --name <值>；没有就返回 None。"""
    for index, item in enumerate(sys.argv):
        if item == name and index + 1 < len(sys.argv):
            return sys.argv[index + 1]
    return None


def main():
    node = dsh_shell.find_node()
    if not node:
        print("找不到可用的 Node（产物内 dist/node 缺失，系统里也没有），跳过。")
        return 2

    only = arg_value("--slot")
    slots = []
    for slot in dsh_shell.list_local_slots(include_partial=True):
        if slot["partial"]:
            continue                                   # 下载中的槽位不检查
        if only and slot["version"] != only:
            continue
        slots.append(
            {
                "version": slot["version"],
                "slotDir": slot["dir"],
                "nodeModules": os.path.join(slot["dir"], "node_modules"),
            }
        )
    if not slots:
        print("没有可检查的槽位（%s）：先下载一个 dsh 版本" % dsh_shell.SLOTS_DIR)
        return 2

    plugins_root = os.path.join(ROOT, "dist", "plugins")
    checks = os.path.join(HERE, "probe_dsh_compat_checks.mjs")
    if not os.path.isdir(plugins_root):
        print("找不到插件目录：%s" % plugins_root)
        return 2

    print("node      : %s" % node)
    print("插件目录  : %s" % plugins_root)
    print("槽位      : %s" % "、".join(s["version"] for s in slots))
    print("")

    env = dict(os.environ)
    env.pop("DSH_GITBASH_MODULE_ROOT", None)           # 由检查脚本自己按槽位设置

    try:
        proc = subprocess.run(
            [node, checks, plugins_root, json.dumps(slots, ensure_ascii=False)],
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
