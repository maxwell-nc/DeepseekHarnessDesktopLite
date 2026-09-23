# -*- coding: utf-8 -*-
"""版本管理器窗口自测：真起 WebView2，打开窗口，用窗口里的 JS 调桥读回状态。

**不启动 dsh 服务**（只测窗口、js_api 桥、列表/确认框的 DOM）。

    <venv>/Scripts/python.exe src/tools/probe_version_manager.py

约 12 秒后自动关窗退出，退出码 0 表示通过。
带 `--net` 时会额外调一次 api.refresh()（真的打一条 npm view，需要网络）。
"""

import json
import os
import sys
import threading
import time

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


def main():
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
                        "registryUrl", "registryChoices"):
                check("state 有字段 %s" % key, key in state, ",".join(sorted(state)))
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

            # 2) DOM：头部信息 / 按钮 / 超限提示条 / 确认框 / 重启遮罩
            dom = manager.evaluate_js(
                "JSON.stringify({"
                "btnRefresh: !!document.getElementById('btn-refresh'),"
                "btnSlots: !!document.getElementById('btn-slots-dir'),"
                "quotaShown: document.getElementById('quota').classList.contains('show'),"
                "quotaBtn: !!document.getElementById('btn-clean'),"
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
            check("默认不弹确认框（mask 隐藏）", not info.get("maskShown"), str(info))
            check("默认没有重启遮罩", not info.get("restartShown"), str(info))
            check("已下载数没超限时提示条隐藏",
                  bool(info.get("quotaShown")) == (state.get("slotCount", 0) > state.get("maxSlots", 10**9)),
                  str(info))
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

            # 4) 拒绝路径（后端校验，不产生写操作）
            #    js_api 方法返回的是 Promise，必须等 then 之后再读，不能直接 stringify
            for name, call in (
                ("sw", "switch('9.9.9')"),
                ("rm", "remove('9.9.9')"),
                ("dl", "download('../x')"),
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
    if FAILURES:
        print("自测失败 %d 项：%s" % (len(FAILURES), "；".join(FAILURES)))
        return 1
    print("版本管理器窗口自测全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())