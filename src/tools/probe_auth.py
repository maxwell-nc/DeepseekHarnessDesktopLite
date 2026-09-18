# -*- coding: utf-8 -*-
"""验证 token 换 cookie 的完整鉴权链路（用 http.client，不自动跟随重定向）。"""
import http.client
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.dirname(HERE)                                    # <项目根>/src
sys.pycache_prefix = os.path.join(os.path.dirname(SRC), "build", "pycache")
sys.path.insert(0, SRC)

import dsh_shell as sh  # noqa: E402


def raw_request(path, cookie=None):
    conn = http.client.HTTPConnection(sh.HOST, sh.PORT, timeout=10)
    headers = {"Host": "%s:%d" % (sh.HOST, sh.PORT)}
    if cookie:
        headers["Cookie"] = cookie
    conn.request("GET", path, headers=headers)
    resp = conn.getresponse()
    body = resp.read(200)
    conn.close()
    return resp.status, dict(resp.getheaders()), body


def step(text):
    print("\n" + "=" * 62)
    print(text)
    print("=" * 62)


svc = sh.DshService()

step("0. 环境")
print("已安装版本 :", svc.installed_version())
print("端口占用   :", sh.pids_on_port() or "无")
if sh.pids_on_port():
    svc.stop()

step("1. 启动服务")
t0 = time.time()
svc.start()
ready = svc.wait_ready(timeout=120, poll_log=lambda t: None)
print("就绪=%s  耗时 %.1fs" % (ready, time.time() - t0))
print("access_url :", svc.access_url)
if not ready:
    print("服务未就绪，退出")
    sys.exit(1)

token_url = svc.web_url
path = token_url.split("3080", 1)[1] if "3080" in token_url else "/"
token = re.search(r"token=([A-Za-z0-9_\-]+)", token_url).group(1)
print("path       :", path)
print("token      :", token[:12] + "…")

step("2. 裸地址（应为 401）")
status, headers, body = raw_request("/")
print("HTTP", status)
print("body:", body[:120])

step("3. 带 token（应为 303 + Set-Cookie）")
status, headers, body = raw_request(path)
print("HTTP", status)
cookie_header = headers.get("Set-Cookie") or headers.get("set-cookie")
print("Location:", headers.get("Location") or headers.get("location"))
print("Set-Cookie:", (cookie_header or "")[:90] + ("…" if cookie_header else ""))

step("4. 用上一步拿到的 Cookie 访问 /（应为 200）")
if cookie_header:
    cookie_pair = cookie_header.split(";")[0]
    status, headers, body = raw_request("/", cookie=cookie_pair)
    print("HTTP", status)
    print("content-type:", headers.get("Content-Type") or headers.get("content-type"))
    print("body 前 160 字节:", body[:160])
else:
    print("没有拿到 Set-Cookie，跳过")

step("5. 停止服务")
print("已释放:", svc.stop())

step("6. 结论")
print("若第 3 步是 303、第 4 步是 200，则 WebView2 用带 token 的 URL 能正常打开界面。")
