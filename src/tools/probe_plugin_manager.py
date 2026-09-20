# -*- coding: utf-8 -*-
"""插件管理器窗口自测：真起 WebView2，打开管理器窗口，用窗口里的 JS 调桥读回状态。

**不启动 dsh 服务**，只测窗口本身、js_api 桥、以及 DOM 渲染出来的红绿灯。

    <venv>/Scripts/python.exe src/tools/probe_plugin_manager.py

约 12 秒后自动关窗退出，退出码 0 表示通过。
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


def check(label, condition, detail=""):
    mark = "OK  " if condition else "FAIL"
    print("[%s] %s%s" % (mark, label, (" — %s" % detail) if detail else ""))
    if not condition:
        FAILURES.append(label)


def main():
    app = dsh_shell.DshShellApp()
    app.plugin_status = "自测：窗口已加载"

    window = webview.create_window(
        "probe-main", html="<html><body style='background:#f4f6fb'></body></html>",
        width=800, height=500,
    )
    app.window = window

    manager = webview.create_window(
        "插件管理器（自测）",
        html=dsh_shell.MANAGER_HTML,
        width=860,
        height=640,
        hidden=True,
        js_api=dsh_shell.PluginManagerApi(app),
    )
    app.manager_window = manager
    manager.events.closing += app.on_manager_closing

    def driver():
        try:
            time.sleep(3)
            app.show_plugin_manager()
            time.sleep(2.5)

            check("窗口状态不是 hidden", manager.state != "hidden", str(manager.state))

            # 让窗口里的 JS 去调桥，把结果放回 window.__probe
            manager.evaluate_js(
                "window.pywebview.api.state().then(function (s) { window.__probe = s; return 1 })"
            )
            time.sleep(2.0)
            raw = manager.evaluate_js("window.__probe ? JSON.stringify(window.__probe) : ''")
            state = json.loads(raw) if raw else {}
            check("js_api.state() 有返回", bool(state), raw[:120])
            check(
                "扫到插件包",
                len(state.get("plugins", [])) >= 1,
                "plugins=%s" % [p.get("id") for p in state.get("plugins", [])],
            )
            check("插件目录指向 dist/plugins", "plugins" in (state.get("pluginsDir") or ""),
                  state.get("pluginsDir", ""))
            check("第三方插件目录指向 dist/plugins-third-party",
                  "plugins-third-party" in (state.get("thirdPartyPluginsDir") or ""),
                  state.get("thirdPartyPluginsDir", ""))
            check("dsh 目录是 ~/.dsh", (state.get("dshHome") or "").endswith(".dsh"),
                  state.get("dshHome", ""))

            # DOM 侧：红绿灯渲染出来了吗
            dom = manager.evaluate_js(
                "JSON.stringify({"
                "led: document.querySelectorAll('.led').length,"
                "on: document.querySelectorAll('.led.on').length,"
                "off: document.querySelectorAll('.led.off').length,"
                "btn: !!document.getElementById('restart'),"
                "status: (document.getElementById('status')||{}).textContent||''"
                "})"
            )
            info = json.loads(dom) if dom else {}
            check("列表渲染出小灯", info.get("led", 0) >= 1, str(info))
            check("小灯有开/关状态", (info.get("on", 0) + info.get("off", 0)) == info.get("led", 0),
                  str(info))
            check("重启按钮在", bool(info.get("btn")), str(info))
            check("状态行读到了 Python 侧文本", "自测" in (info.get("status") or ""),
                  info.get("status", ""))

            # 桥的返回必须能被 json 序列化（pywebview 拿不到就报错）
            check(
                "js_api.state() 可 JSON 序列化",
                len(json.dumps(state, ensure_ascii=False)) > 0,
            )
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
    print("插件管理器窗口自测全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
