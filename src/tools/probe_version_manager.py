# -*- coding: utf-8 -*-
"""版本管理器窗口自测：每版本配置目录 + 备份/恢复 + 窗口/js_api 桥。

**不启动 dsh 服务**、**不碰真实数据**：homes/ 与 backups/ 全指向临时目录。

    <venv>/Scripts/python.exe src/tools/probe_version_manager.py

两段自测：
  1. fs_tests()  —— 种子复制（必须跳过 junction）、每池 10 份淘汰、恢复
                    （只读附件对象要删得掉）、路径穿越拒绝、DSH_HOME 一致性；
  2. 窗口       —— 头部配置目录行、备份按钮 / 备份清单 / 恢复·删除确认框。

约 15 秒后自动关窗退出，退出码 0 表示通过。
带 `--net` 时会额外调一次 api.refresh()（真的打一条 npm view，需要网络）。
"""

import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import time
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.dirname(HERE)                                    # <项目根>/src
sys.pycache_prefix = os.path.join(os.path.dirname(SRC), "build", "pycache")
sys.path.insert(0, SRC)

import webview  # noqa: E402

import dsh_shell  # noqa: E402

FAILURES = []
WANT_NET = "--net" in sys.argv


def check(label, condition, detail=""):
    mark = "OK  " if condition else "FAIL"
    print("[%s] %s%s" % (mark, label, (" — %s" % detail) if detail else ""))
    if not condition:
        FAILURES.append(label)



def fs_tests():
    """每版本配置目录 + 备份/恢复的文件系统自测（临时根目录）。"""
    tmp = tempfile.mkdtemp(prefix="dsh-home-probe-")
    dsh_shell.HOMES_ROOT = os.path.join(tmp, "homes")
    dsh_shell.BACKUPS_ROOT = os.path.join(tmp, "backups")

    # 种子源 = 「切换前那份 home」：带 junction（profiles/node_modules 的
    # 404 条链接就是这个形态）+ 只读对象（dsh attachments 就是 0o444）。
    src = dsh_shell.home_dir_for("0.0.1")
    os.makedirs(os.path.join(src, "profiles", "web"), exist_ok=True)
    with open(os.path.join(src, "profiles", "web", "package.json"), "w", encoding="utf-8") as fh:
        fh.write('{"name": "dsh-profile-web"}')
    with open(os.path.join(src, ".credentials.yaml"), "w", encoding="utf-8") as fh:
        fh.write("token: abc\n")
    obj_dir = os.path.join(src, "attachments", "objects")
    os.makedirs(obj_dir, exist_ok=True)
    obj = os.path.join(obj_dir, "deadbeef")
    with open(obj, "w", encoding="utf-8") as fh:
        fh.write("blob")
    os.chmod(obj, stat.S_IREAD)
    outside = os.path.join(tmp, "outside")
    os.makedirs(outside, exist_ok=True)
    with open(os.path.join(outside, "index.js"), "w", encoding="utf-8") as fh:
        fh.write("x" * 4096)
    nm = os.path.join(src, "profiles", "node_modules")
    os.makedirs(nm, exist_ok=True)
    subprocess.run(
        ["cmd", "/c", "mklink", "/J", os.path.join(nm, "xxx"), outside],
        capture_output=True,
    )
    check("自测造出了 junction", dsh_shell._is_reparse(os.path.join(nm, "xxx")))

    res = dsh_shell.ensure_version_home("0.0.2")
    dest = dsh_shell.home_dir_for("0.0.2")
    check("新版本配置目录已创建（种子复制）", res.get("created") is True, str(res))
    check("种子源是切换前那份 home", res.get("source") == src, str(res.get("source")))
    check("凭据被复制过去", os.path.isfile(os.path.join(dest, ".credentials.yaml")))
    check("profile 被复制过去",
          os.path.isfile(os.path.join(dest, "profiles", "web", "package.json")))
    check("**junction 没被复制**（不会把旧槽位 220 MB 拖进来）",
          not os.path.exists(os.path.join(dest, "profiles", "node_modules", "xxx")))
    marker = os.path.join(dest, "MARKER")
    with open(marker, "w", encoding="utf-8") as fh:
        fh.write("keep")
    res = dsh_shell.ensure_version_home("0.0.2")
    check("目录已存在就不再拷贝（一个字节不动）",
          res.get("created") is False and os.path.isfile(marker), str(res))

    # 手动备份 13 次 -> 池子里只留 10 份（utime 强制时间递增，省掉 sleep）
    names = []
    base = time.time() - 400
    for i in range(13):
        r = dsh_shell.backup_home("0.0.2", kind="manual")
        names.append(r.get("name"))
        os.utime(r["path"], (base + i, base + i))
    manual = [b for b in dsh_shell.list_backups() if b["kind"] == "manual"]
    kept = {b["name"] for b in manual}
    check("手动池只留 10 份", len(manual) == 10, "%d 份" % len(manual))
    # 同秒创建会带 -N 后缀，且被淘汰后名字可能被复用 —— 所以按 mtime 判：
    # 留下的 10 份必须全都比第 3 旧的时间戳新（最早的 3 个时间点已消失）。
    ats = sorted(b["at"] for b in manual)
    check("淘汰的是时间最早的 3 份",
          len(ats) == 10 and ats[0] >= int((base + 3) * 1000),
          str([time.strftime("%H:%M:%S", time.localtime(a / 1000)) for a in ats[:4]]))
    newest = manual[0]["name"]
    with zipfile.ZipFile(os.path.join(dsh_shell.BACKUPS_ROOT, "manual", newest)) as zf:
        entries = zf.namelist()
    check("zip 里没有 junction 指向的文件", not any("xxx" in e for e in entries),
          str(entries)[:160])
    check("zip 里有只读对象", any(e.endswith("deadbeef") for e in entries), str(entries)[:160])

    # auto 池独立（切换前的自动备份不会冲掉手动备份）
    for i in range(3):
        r = dsh_shell.backup_home("0.0.2", kind="auto")
        os.utime(r["path"], (base + 100 + i, base + 100 + i))
    check("auto / manual 两池各留各的",
          len([b for b in dsh_shell.list_backups() if b["kind"] == "auto"]) == 3
          and len([b for b in dsh_shell.list_backups() if b["kind"] == "manual"]) == 10,
          str(dsh_shell.list_backups())[:160])

    # 恢复：把配置改坏 -> 用最新备份还原
    with open(os.path.join(dest, ".credentials.yaml"), "w", encoding="utf-8") as fh:
        fh.write("token: BROKEN\n")
    with open(os.path.join(dest, "JUNK"), "w", encoding="utf-8") as fh:
        fh.write("x")
    res = dsh_shell.restore_backup(newest)
    check("恢复成功", res.get("ok") is True, str(res))
    with open(os.path.join(dest, ".credentials.yaml"), encoding="utf-8") as fh:
        check("配置回到备份时的内容", fh.read() == "token: abc\n")
    check("恢复后多余文件被清掉", not os.path.exists(os.path.join(dest, "JUNK")))
    restored_obj = os.path.join(dest, "attachments", "objects", "deadbeef")
    check("只读对象恢复后仍是只读",
          os.path.isfile(restored_obj)
          and bool(os.stat(restored_obj).st_mode & stat.S_IREAD),
          oct(os.stat(restored_obj).st_mode) if os.path.isfile(restored_obj) else "缺失")
    check("恢复前自动备份了一份（auto 池 +1）",
          len([b for b in dsh_shell.list_backups() if b["kind"] == "auto"]) == 4)
    check("没有 .restoring / .old 残留",
          not [n for n in os.listdir(dsh_shell.HOMES_ROOT)
               if n.endswith((".restoring", ".old"))],
          str(os.listdir(dsh_shell.HOMES_ROOT)))

    # 路径穿越 / 非法名必须被后端拒掉
    check("恢复 ../../x.zip 被拒",
          dsh_shell.restore_backup("../../x.zip").get("ok") is False)
    check("删除非法备份名被拒",
          dsh_shell.delete_backup("nope.zip").get("ok") is False)
    check("备份名能解析出版本", dsh_shell.version_from_backup_name(newest) == "0.0.2",
          str(dsh_shell.version_from_backup_name(newest)))

    # 外壳和服务子进程必须读同一份配置
    active = dsh_shell.active_slot_version()
    if active:
        check("dsh_home() 指向活动版本的配置目录",
              dsh_shell.dsh_home() == dsh_shell.home_dir_for(active), dsh_shell.dsh_home())
        check("服务子进程拿到同一个 DSH_HOME",
              dsh_shell.DshService._child_env(None, None)["DSH_HOME"] == dsh_shell.dsh_home())
    return tmp


def main():
    tmp_root = fs_tests()

    app = dsh_shell.DshShellApp()
    app.vm_status = "自测：窗口已加载"

    window = webview.create_window(
        "probe-main", html="<html><body style='background:#f4f6fb'></body></html>",
        width=800, height=500,
    )
    app.window = window

    manager = webview.create_window(
        "版本管理器（自测）",
        html=dsh_shell.VERSION_MANAGER_HTML,
        width=880,
        height=660,
        hidden=True,
        js_api=dsh_shell.VersionManagerApi(app),
    )
    app.version_window = manager
    manager.events.closing += app.on_version_closing

    def driver():
        try:
            time.sleep(3)
            app.show_version_manager()
            time.sleep(2.5)

            check("窗口状态不是 hidden", manager.state != "hidden", str(manager.state))

            # 1) 桥：state() 必须返回可序列化快照
            manager.evaluate_js(
                "window.pywebview.api.state().then(function (s) { window.__probe = s; return 1 })"
            )
            time.sleep(2.0)
            raw = manager.evaluate_js("window.__probe ? JSON.stringify(window.__probe) : ''")
            state = json.loads(raw) if raw else {}
            check("js_api.state() 有返回", bool(state), raw[:120])
            for key in ("versions", "activeSlot", "slotCount", "maxSlots",
                        "busy", "checking", "task", "registry",
                        "registryUrl", "registryChoices",
                        # 每版本配置目录 + 备份清单
                        "homeDir", "homes", "backups", "backupRetention"):
                check("state 有字段 %s" % key, key in state, ",".join(sorted(state)))
            check("backupRetention 是 10", state.get("backupRetention") == 10,
                  str(state.get("backupRetention")))
            check("homeDir 指向每版本配置目录（homes 下的活动版本）",
                  os.path.basename(os.path.dirname(state.get("homeDir") or "")) == "homes",
                  str(state.get("homeDir")))
            check("homes 是列表", isinstance(state.get("homes"), list),
                  str(type(state.get("homes"))))
            check("fs 自测留下的备份在 state.backups 里",
                  len(state.get("backups") or []) >= 4,
                  str(len(state.get("backups") or [])))
            check("registryChoices 是列表且至少 3 个源",
                  isinstance(state.get("registryChoices"), list)
                  and len(state.get("registryChoices")) >= 3,
                  str(state.get("registryChoices"))[:120])
            check("versions 是列表", isinstance(state.get("versions"), list),
                  str(type(state.get("versions"))))
            check("不是弹窗式的 busy 快照", state.get("busy") in (True, False),
                  str(state.get("busy")))
            check("状态行读到了 Python 侧文本", "自测" in (state.get("status") or ""),
                  state.get("status", ""))

            # 2) DOM：头部信息 / 按钮 / 确认框 / 重启遮罩
            dom = manager.evaluate_js(
                "JSON.stringify({"
                "btnRefresh: !!document.getElementById('btn-refresh'),"
                "btnSlots: !!document.getElementById('btn-slots-dir'),"
                "btnBackup: !!document.getElementById('btn-backup'),"
                "btnHome: !!document.getElementById('btn-home-dir'),"
                "btnBackupsDir: !!document.getElementById('btn-backups-dir'),"
                "homeText: (document.getElementById('p-home')||{}).textContent||'',"
                "bkRows: document.querySelectorAll('#bk-list .row').length,"
                "bkHint: (document.getElementById('bk-hint')||{}).textContent||'',"
                "bkEmpty: !!document.querySelector('#bk-list .empty'),"
                "maskShown: document.getElementById('mask').classList.contains('show'),"
                "restartShown: document.getElementById('restarting').classList.contains('show'),"
                "rows: document.querySelectorAll('#list .row').length,"
                "regTag: (document.getElementById('p-registry')||{}).tagName||'',"
                "regOpts: (document.getElementById('p-registry')||{}).options ? "
                "document.getElementById('p-registry').options.length : 0,"
                "regValue: (document.getElementById('p-registry')||{}).value,"
                "installed: (document.getElementById('p-installed')||{}).textContent||''"
                "})"
            )
            info = json.loads(dom) if dom else {}
            check("刷新按钮在", bool(info.get("btnRefresh")), str(info))
            check("npm 源是下拉框（可切换）", info.get("regTag") == "SELECT", str(info.get("regTag")))
            check("下拉框有 3 个源 + 跟随系统", int(info.get("regOpts") or 0) >= 4,
                  "%s 个选项" % info.get("regOpts"))
            check("下拉框选中当前源",
                  (info.get("regValue") or "") == (state.get("registryUrl") or ""),
                  "%r vs %r" % (info.get("regValue"), state.get("registryUrl")))
            check("打开槽位目录按钮在", bool(info.get("btnSlots")), str(info))
            check("「备份配置」按钮在", bool(info.get("btnBackup")), str(info))
            check("「打开配置目录」按钮在", bool(info.get("btnHome")), str(info))
            check("「打开备份目录」按钮在", bool(info.get("btnBackupsDir")), str(info))
            check("头部显示了配置目录", bool(info.get("homeText")), str(info.get("homeText")))
            check("备份清单渲染出了行", int(info.get("bkRows") or 0) >= 1,
                  "%s 行" % info.get("bkRows"))
            check("备份提示写明保留 10 份", "10" in (info.get("bkHint") or ""),
                  str(info.get("bkHint")))
            check("默认不弹确认框（mask 隐藏）", not info.get("maskShown"), str(info))
            check("默认没有重启遮罩", not info.get("restartShown"), str(info))
            check("当前版本写进了头部", bool(info.get("installed")), str(info))

            # 3) 切换确认框：**所有切换都必须先过它**（窗口内，不是系统弹窗）
            manager.evaluate_js("openSwitchConfirm('1.2.3'); 1")
            time.sleep(0.5)
            dlg = manager.evaluate_js(
                "JSON.stringify({"
                "shown: document.getElementById('mask').classList.contains('show'),"
                "title: document.getElementById('dlg-title').textContent,"
                "body: document.getElementById('dlg-body').textContent,"
                "ok: document.getElementById('dlg-ok').textContent"
                "})"
            )
            info = json.loads(dlg) if dlg else {}
            check("确认框弹出", bool(info.get("shown")), str(info))
            check("确认框标题对", "切换" in (info.get("title") or ""), info.get("title", ""))
            check("确认框写明会自动重启应用", "自动重启应用" in (info.get("body") or ""),
                  (info.get("body") or "")[:80])
            check("确认按钮是「切换并重启」", "切换并重启" in (info.get("ok") or ""),
                  info.get("ok", ""))
            manager.evaluate_js("closeDialog(); 1")
            time.sleep(0.3)
            closed = manager.evaluate_js(
                "document.getElementById('mask').classList.contains('show')"
            )
            check("取消后确认框收起", closed in ("false", False), str(closed))

            # 3b) 恢复备份也必须先过窗口内确认框（且和切换框互不串台）
            manager.evaluate_js(
                "openRestoreConfirm('9.9.9__20260101-000000.zip'); 1"
            )
            time.sleep(0.5)
            dlg = json.loads(manager.evaluate_js(
                "JSON.stringify({"
                "shown: document.getElementById('mask').classList.contains('show'),"
                "title: document.getElementById('dlg-title').textContent,"
                "body: document.getElementById('dlg-body').textContent,"
                "ok: document.getElementById('dlg-ok').textContent"
                "})"
            ) or "{}")
            check("恢复确认框弹出", bool(dlg.get("shown")), str(dlg))
            check("恢复确认框标题对", "恢复" in (dlg.get("title") or ""), str(dlg.get("title")))
            check("恢复确认写明会先备份当前",
                  "备份" in (dlg.get("body") or ""), str(dlg.get("body"))[:120])
            check("恢复确认按钮是「恢复」", dlg.get("ok") == "恢复", str(dlg.get("ok")))
            manager.evaluate_js("closeDialog(); 1")
            time.sleep(0.3)

            manager.evaluate_js("openDeleteBackupConfirm('x.zip'); 1")
            time.sleep(0.5)
            dlg = json.loads(manager.evaluate_js(
                "JSON.stringify({"
                "shown: document.getElementById('mask').classList.contains('show'),"
                "title: document.getElementById('dlg-title').textContent,"
                "ok: document.getElementById('dlg-ok').textContent"
                "})"
            ) or "{}")
            check("删除备份确认框弹出", bool(dlg.get("shown")), str(dlg))
            check("删除备份确认按钮是「删除备份」", dlg.get("ok") == "删除备份",
                  str(dlg.get("ok")))
            manager.evaluate_js("closeDialog(); 1")
            time.sleep(0.3)
            pend = json.loads(manager.evaluate_js(
                "JSON.stringify({sw: !!pendingSwitch, rm: !!pendingRemove,"
                " rs: !!pendingRestore, db: !!pendingDeleteBk})"
            ) or "{}")
            check("closeDialog 清干净所有 pending",
                  not any(pend.values()), str(pend))
            manager.evaluate_js("openRestoreConfirm('a.zip'); 1")
            time.sleep(0.3)
            pend = json.loads(manager.evaluate_js(
                "JSON.stringify({rs: !!pendingRestore, sw: !!pendingSwitch})"
            ) or "{}")
            check("恢复框置位 pendingRestore", pend.get("rs") is True
                  and pend.get("sw") is False, str(pend))
            manager.evaluate_js("closeDialog(); 1")
            time.sleep(0.3)
            pend = json.loads(manager.evaluate_js(
                "JSON.stringify({rs: !!pendingRestore})"
            ) or "{}")
            check("关闭后 pendingRestore 复位", pend.get("rs") is False, str(pend))

            # 4) 拒绝路径（后端校验，不产生写操作）
            #    js_api 方法返回的是 Promise，必须等 then 之后再读，不能直接 stringify
            for name, call in (
                ("sw", "switch('9.9.9')"),
                ("rm", "remove('9.9.9')"),
                ("dl", "download('../x')"),
                ("rs", "restore_backup('../../evil.zip')"),
                ("db", "delete_backup('nope.zip')"),
            ):
                manager.evaluate_js(
                    "window.pywebview.api.%s.then(function (r) { window.__%s = r; return 1 })"
                    % (call, name)
                )
                time.sleep(0.8)
                raw = manager.evaluate_js(
                    "window.__%s ? JSON.stringify(window.__%s) : ''" % (name, name)
                )
                res = json.loads(raw) if raw else {}
                check("%s 返回对象" % name, isinstance(res, dict) and "ok" in res, str(res))
                check("%s 被拒绝（ok=False）" % name, res.get("ok") is False, str(res))

            # 4b) 桥的「备份配置」按钮：真的产一份，state.backups 里要能看到
            before = len(state.get("backups") or [])
            manager.evaluate_js(
                "window.pywebview.api.backup().then(function (r) { window.__bk = r; return 1 })"
            )
            time.sleep(2.5)
            raw = manager.evaluate_js("window.__bk ? JSON.stringify(window.__bk) : ''")
            bk = json.loads(raw) if raw else {}
            check("backup() 返回 ok", bk.get("ok") is True, str(bk))
            check("备份名带版本号和时间戳",
                  bool(bk.get("name")) and str(bk.get("name")).endswith(".zip"),
                  str(bk.get("name")))
            manager.evaluate_js(
                "window.pywebview.api.state().then(function (s) { window.__probe2 = s; return 1 })"
            )
            time.sleep(1.5)
            raw = manager.evaluate_js("window.__probe2 ? JSON.stringify(window.__probe2) : ''")
            state2 = json.loads(raw) if raw else {}
            check("手动备份出现在 state.backups",
                  len(state2.get("backups") or []) == before + 1,
                  "%d -> %d" % (before, len(state2.get("backups") or [])))
            check("状态行读到了备份完成文案", "备份" in (state2.get("status") or ""),
                  str(state2.get("status")))

            # 5) 可选：真打一次 npm view（--net）
            if WANT_NET:
                manager.evaluate_js(
                    "window.pywebview.api.refresh().then(function (s) { window.__net = s; return 1 })"
                )
                time.sleep(15.0)
                raw = manager.evaluate_js("window.__net ? JSON.stringify(window.__net) : ''")
                net = json.loads(raw) if raw else {}
                rows = net.get("versions") or []
                check("refresh() 返回快照", bool(net), str(net)[:120])
                check("远端列表拿到版本（≤%d 条）" % dsh_shell.VERSION_LIST_LIMIT,
                      0 < len(rows) <= dsh_shell.VERSION_LIST_LIMIT, "%d 条" % len(rows))

            # 桥的返回必须能被 JSON 序列化
            check("js_api.state() 可 JSON 序列化",
                  len(json.dumps(state, ensure_ascii=False)) > 0)
        except Exception as exc:  # noqa: BLE001
            import traceback

            traceback.print_exc()
            FAILURES.append("driver 异常：%s" % exc)
        finally:
            time.sleep(1.0)
            app.quitting = True
            for win in (manager, window):
                try:
                    win.destroy()
                except Exception:  # noqa: BLE001
                    pass

    threading.Thread(target=driver, daemon=True).start()
    webview.start(gui="edgechromium", debug=False, private_mode=False,
                  storage_path=dsh_shell.WEBVIEW_DIR)

    print("")
    try:
        dsh_shell._rmtree(tmp_root)
    except OSError:
        pass
    if FAILURES:
        print("自测失败 %d 项：%s" % (len(FAILURES), "；".join(FAILURES)))
        return 1
    print("版本管理器窗口自测全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())