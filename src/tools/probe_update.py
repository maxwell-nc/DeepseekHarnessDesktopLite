# -*- coding: utf-8 -*-
"""多槽位版本链路自测：拉远端版本列表（含 alpha）+ 展示槽位状态。

    python src/tools/probe_update.py                    # 只读：远端列表 + 本机槽位
    python src/tools/probe_update.py --download <ver>   # 额外把某版本下进新槽位

**不启停服务、不切换版本**（切换 = 自动重启应用，留给真机手测）。
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.dirname(HERE)                                    # <项目根>/src
sys.pycache_prefix = os.path.join(os.path.dirname(SRC), "build", "pycache")
sys.path.insert(0, SRC)

import dsh_shell as sh  # noqa: E402


def main(argv):
    svc = sh.DshService()
    print("镜像源      :", sh.effective_registry() or "(跟随系统)")
    print("活动槽位    :", sh.active_slot_dir())
    print("活动版本    :", sh.active_slot_version())
    print("已安装版本  :", svc.installed_version())
    print("老布局版本  :", sh.legacy_layout_version() or "(无)")
    slots = sh.list_local_slots()
    print("本机槽位    :", [
        "%s%s" % (s["version"], "" if not s["partial"] else " (下载中)")
        for s in slots
    ] or "(还没有槽位，启动应用会做老布局迁移)")

    step("\n1. 拉远端最近 %d 个版本（含 alpha）" % sh.VERSION_LIST_LIMIT)
    t0 = time.time()
    result = sh.fetch_remote_versions(force=True)
    print("耗时 %.1fs  ok=%s  stale=%s" % (time.time() - t0, result["ok"], result["stale"]))
    if result.get("error"):
        print("错误:", result["error"])
    have = {s["version"] for s in slots}
    for i, row in enumerate(result["rows"], 1):
        print("  %2d. %-22s %-8s %s  %s"
              % (i, row["version"], row["channel"],
                 (row["publishedAt"] or "")[:10],
                 "已下载" if row["version"] in have else ""))
    if not result["rows"]:
        print("没有拿到任何版本")
        return 1

    if len(result["rows"]) > sh.VERSION_LIST_LIMIT:
        print("FAIL: 超过 %d 条" % sh.VERSION_LIST_LIMIT)
        return 1

    if "--download" in argv:
        ver = argv[argv.index("--download") + 1] if argv.index("--download") + 1 < len(argv) else ""
        step("\n2. 下载 %s 到新槽位（不碰活动槽位）" % ver)
        t0 = time.time()
        ok, tail = svc.download_version(ver, lambda line: print("  npm> %s" % line, flush=True))
        print("耗时 %.1fs  成功=%s" % (time.time() - t0, ok))
        print("---- 输出尾部 ----\n%s" % tail[-800:])
        print("槽位现在是:", [s["version"] for s in sh.list_local_slots()])
        if not ok:
            return 1

    step("\n占用")
    total = 0
    for slot in sh.list_local_slots():
        mb = sh.slot_size_mb(slot["dir"])
        total += mb
        print("  %-22s %5d MB  %s" % (slot["version"], mb, slot["dir"]))
    print("  合计 %d MB（上限 %d 个槽位，超限只提示不自动删）" % (total, sh.max_slots()))
    print("\nDONE")
    return 0


def step(title):
    print("\n" + "=" * 62)
    print(title)
    print("=" * 62)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
