# -*- coding: utf-8 -*-
"""插件同步自测：扫描 plugins/ -> 镜像进 dsh -> 重写托管补丁块。

    <venv>/Scripts/python.exe src/tools/probe_plugins.py            # 真的同步一次
    <venv>/Scripts/python.exe src/tools/probe_plugins.py --dry-run  # 只看会做什么
    <venv>/Scripts/python.exe src/tools/probe_plugins.py --list     # 只看扫描结果

用 --plugins-dir / --dsh-home 可以把整个流程指向临时目录，不碰真实环境：

    src/tools/probe_plugins.py --plugins-dir /tmp/p --dsh-home /tmp/h
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.dirname(HERE)                                    # <项目根>/src
sys.pycache_prefix = os.path.join(os.path.dirname(SRC), "build", "pycache")
sys.path.insert(0, SRC)

DRY = "--dry-run" in sys.argv
LIST_ONLY = "--list" in sys.argv


def arg_value(name):
    """取 --name <值>；没有就返回 None（先把值取出来，别放进闭包）。"""
    for index, item in enumerate(sys.argv):
        if item == name and index + 1 < len(sys.argv):
            return os.path.abspath(sys.argv[index + 1])
    return None


PLUGINS_DIR = arg_value("--plugins-dir")
DSH_HOME_DIR = arg_value("--dsh-home")

if PLUGINS_DIR:
    os.environ["DSH_UI_PLUGINS_DIR"] = PLUGINS_DIR

import dsh_shell  # noqa: E402

if DSH_HOME_DIR:
    dsh_shell.load_config = lambda: {"dshHome": DSH_HOME_DIR}


def main():
    print("插件目录 : %s" % dsh_shell.plugins_dir())
    print("dsh 目录  : %s" % dsh_shell.dsh_home())
    print("profile  : %s" % dsh_shell.plugin_profile_dir())
    print("状态文件 : %s" % dsh_shell.PLUGIN_STATE_FILE)
    print("")

    state = dsh_shell.load_plugin_state()
    packages = dsh_shell.scan_plugin_packages()
    print("扫描到 %d 个插件包：" % len(packages))
    for package in packages:
        flag = "可用" if package.usable else "不可用"
        enabled = "开" if dsh_shell.plugin_enabled(state, package) else "关"
        print(
            "  - %-12s order=%-4s v%-8s [%s/%s] %s"
            % (package.id, package.order, package.version, flag, enabled, package.name)
        )
        if package.error:
            print("      ! %s" % package.error)
        print("      入口 %s / 片段 %s" % (package.entry, package.patch))

    if LIST_ONLY:
        return 0

    if DRY:
        print("\n(dry-run：不写任何东西)")
        for package in packages:
            if not package.usable:
                continue
            dest = os.path.join(dsh_shell.plugin_profile_dir(), "plugins", package.id)
            action = "撤下" if not dsh_shell.plugin_enabled(state, package) else "安装/刷新"
            print("  %s -> %s" % (action, dest))
        return 0

    print("\n开始同步：")
    ok, message = dsh_shell.sync_plugins(on_note=lambda text: print("  %s" % text))
    print("\n结果：%s" % ("成功" if ok else "失败"))
    print("说明：%s" % message)

    patch = os.path.join(dsh_shell.plugin_profile_dir(), "cordis.patch.yml")
    print("\n%s 内容：" % patch)
    try:
        with open(patch, "r", encoding="utf-8") as fh:
            print(fh.read())
    except OSError as exc:
        print("  (读不到：%s)" % exc)

    plugins_root = os.path.join(dsh_shell.plugin_profile_dir(), "plugins")
    print("插件安装目录：")
    try:
        for name in sorted(os.listdir(plugins_root)):
            print("  %s" % name)
    except OSError as exc:
        print("  (读不到：%s)" % exc)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
