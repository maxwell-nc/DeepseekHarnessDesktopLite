# lan_access —— 局域网扫码访问网页版

在 dsh Web 界面**左下角、设置按钮上方**加一个入口（**独占一行**，不和 Token 用量挤在一起），
点开是一张二维码和一条固定链接：手机连同一个 WiFi，扫码就能打开网页版，功能与电脑上完全一致。

- **默认关闭**：插件装上后入口就在，但 3081 端口**不监听** —— 局域网通道等于把本机的
  操作权限摊到网上，不能默认开着。在面板里点「开启局域网访问」才起代理。
- **开了就记住**：开关状态和访问码存在同一个文件里，下次启动自动恢复。想彻底不加载，
  去插件管理器关掉本插件。
- **链接固定**：`http://<内网IP>:3081/?lan=<访问码>`。访问码只生成一次、存在应用数据根，
  所以**只要内网 IP 不变，链接和二维码就不变**（IP 变了链接跟着变，这是内网地址的性质）。
- **带鉴权**：默认只放行内网/回环来源，且必须带对访问码；面板上可一键**重置访问码**，
  旧链接立即作废。
- **不动 dsh 的绑定**：dsh 依旧只监听 `127.0.0.1:3080`，局域网侧由插件自己的反向代理把门。

## 开关：默认不开，开了就记住

| 状态 | 面板显示 | 3081 端口 |
| --- | --- | --- |
| 装好后没动过 | 灰点「未开启」+ 一段说明 | 不监听 |
| 点「开启局域网访问」 | 绿点「已开启」+ 二维码 | 监听中 |
| 开了但端口被占 | 橙点「开启失败」+ 原因 + 「重试」 | 没起来 |
| 点「关闭局域网访问」 | 灰点「未开启」 | 立即释放 |

宿主侧把「用户意图」和「实际在跑」分开记：`enabled` 是开关、`running` 是代理真的在监听。
端口被占时两者会分叉，**二维码只在 `running` 时才画** —— 否则会摆出一张扫了没反应的图。

面板上的开关是 `POST /api/lan_access.set`，宿主**先落盘再起停**，返回新快照，前端照着重画：
「开启成功了吗」以宿主的 `running` 为准，不靠前端猜。

## 为什么是「插件自带反代」

最省事的做法是让 dsh 直接监听 `0.0.0.0` —— dsh 的 webserver 本身支持，`dsh-web-app`
甚至会在全网卡绑定时自动把内网 IP 算进 `/api` 的信任名单并打印一条 LAN 链接。但：

1. 上游把 `--host 0.0.0.0` **明确堵死**了（`dsh-web-app/lib/startup.js` 里写着
   「intentionally not supported yet for safety: it would expose remote code execution to
   the network」）。绕过它等于把上游刻意关掉的门重新打开。
2. 那样**没法按来源网段过滤**，也没法做「重置访问码」—— 只能靠 dsh 自己的 token，
   而 token 每次启动都变，链接就不固定了。
3. 端口一旦对全网卡开放，机器连到公共 WiFi 或路由器做了端口转发时，服务就是裸露的。

所以这里改成：dsh 保持只听回环，插件在局域网侧另起一个**带鉴权的反向代理**。
暴露面完全由插件控制 —— 默认就是关的，面板上关掉开关端口立刻释放，关掉插件更是
一点痕迹不留，dsh 那边不受影响。

## 鉴权是怎么过掉的

两层，各管各的：

**① 局域网侧（插件自己的）** —— 固定访问码。
`?lan=<码>` 命中 → `303` + 一个长期 cookie（`dsh-lan-access`，`HttpOnly`），
地址收拾干净回到 `/`；之后靠 cookie 放行。码是 16 字节密码学随机，存在
`<应用数据根>/data/lan_access.json`（默认 `%LOCALAPPDATA%\DeepSeekHarness\data\`）。

**② 回环侧（dsh 自己的）** —— 会话 cookie。
dsh 的浏览器会话 cookie 是**按 Host 头签发的**（`dsh-client-connection` 的 `BrowserAuth`：
cookie 名是 `dsh-auth-<sha256(authority)>`，签名载荷里带 authority）。局域网浏览器拿不到、
也不该拿到 `127.0.0.1` 那份。所以代理在启动时自己完成登录跳转：

```
GET http://127.0.0.1:3080/?token=<进程 launch token>   （Host: 127.0.0.1:3080）
  → 303 + Set-Cookie: dsh-auth-…=…
```

把这份 cookie 缓存起来，转发时替换掉浏览器带来的 Cookie。**浏览器全程不接触 dsh 的
token/cookie**，鉴权都在代理里完成。launch token 从 `ctx.connection.authenticatedUrl()`
取（连接服务就绪后才有，所以整个代理挂在 `ctx.inject(['connection','webServer'], …)` 里）。

### 转发时的头改写（必须一起改，少一个就 403）

dsh 的 `/api` 有一道 browser-trust fence（`dsh-client-connection`）：

| 头 | 改成 | 为什么 |
| --- | --- | --- |
| `Host` | `127.0.0.1:<port>` | Host 不是回环又不在 `trustedHosts` 里 → 直接 403 |
| `Origin` / `Referer` | `http://127.0.0.1:<port>` | fence 会比对 `Origin.host` 与 Host，浏览器带来的是局域网那个 |
| `Cookie` | 缓存的上游 cookie | 见上 |

响应侧反过来：剥掉 hop-by-hop 头和上游的 `Set-Cookie`（别把 dsh 的会话 cookie 泄给
局域网 origin），其余（含 `content-encoding: gzip`、`content-length`）原样透传，**不缓冲**。

### HTTP Upgrade 必须转发（否则对话是废的）

对话/会话流**不是 SSE**，而是 `/api/remote.mux` 上的 WebSocket —— `dsh-api-gateway` 用
`webServer.registerUpgrade` 注册，握手时同样走 `requestRejection`（Host/Origin fence +
cookie 鉴权）。浏览器那边用 `new WebSocket(remoteStreamUrl())`，URL 由 `location.origin`
推出，所以必然是 `ws://<内网IP>:3081/api/remote.mux`。

代理里这段走 `net.connect` 直连上游、把改写过的握手请求原样写过去再双向对拷，
不解析帧 —— 少了这一段，页面能打开、但一发消息就废。

## 自测

```bash
<venv>/Scripts/python.exe src/tools/probe_lan_access.py
```

不碰真实环境：起一个假的上游 HTTP 服务，把访问码文件指向临时目录。覆盖：

- **二维码编码器**：Reed-Solomon 的 ISO 已知向量、格式信息/版本信息的已知值、
  分块表自洽，以及「生成矩阵 → 反解回原文」的端到端回读（含掩码与交错）。
- **代理行为**：`?lan=` → 303 + cookie；错码/无码 → 401；转发时 Host/Origin/Cookie
  被正确改写、上游 `Set-Cookie` 被剥掉；上游回 401 时会重换 cookie 再试；
  内网地址判定；WebSocket 握手能双向透传；**用过 WebSocket 之后关代理不卡住**
  （升级过的 socket 脱离 http server 的连接跟踪，不自己 destroy 的话 `close()`
  会一直等下去 —— 这个坑在自测里留了回归）。
- **宿主半边（开关持久化）**：真起代理（绑定 `127.0.0.1` + 临时端口）验一遍：
  首次启动默认关闭且**不占端口**、访问码按 16 字节 base64url 落盘、开启后端口真的在听
  且链接 = 固定 IP + 固定端口 + 落盘的访问码；然后用带 `?v=N` 的 URL 重新 import
  模拟重启 —— 开着会自己开回来、链接不变，关掉则保持关闭；状态文件损坏时当没配过
  （**绝不能因为读不出来就顺手把端口开了**）。
- **浏览器半边**：用假 React 把 `lib/client.js` 跑一遍，验证模块注册、槽位/order、
  **入口独占一行**（造一条 `flex 行容器 > display:contents 锚点 > 本插件根节点` 的假 DOM 链，
  确认 `flex-wrap` 加在**行容器**上而不是锚点上，卸载时还原）、
  开关按钮走 `POST /api/lan_access.set`，以及面板在「数据未就绪 / 未开启 / 已开启 /
  开启失败 / 没有内网地址」五种状态下都不抛异常，且**只有已开启时才画二维码**。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_UI_DATA_DIR` | 外壳注入 | 运行数据根；访问码 + 开关存 `<它>/data/lan_access.json` |
| `DSH_LAN_ACCESS_PORT` | `3081` | 代理端口。**故意写死**：端口一变链接就变；被占用时宁可报错也不换 |
| `DSH_LAN_ACCESS_BIND` | `0.0.0.0` | 代理绑定地址 |
| `DSH_LAN_ACCESS_IP` | 自动挑 | 指定对外展示的内网 IP（自动挑不中时用） |
| `DSH_LAN_ACCESS_ALLOW_PUBLIC` | 关 | `1` = 不限制来源网段（默认只放行内网/回环） |
| `DSH_LAN_ACCESS_DATA` | — | 直接指定状态文件（访问码 + 开关，自测用） |
| `DSH_LAN_ACCESS_QUIET` | 关 | `1` = 不打启动横幅 |

## 坑与边界

- **Windows 防火墙**：入站是 `node.exe` 在监听，首次会被防火墙拦。要在
  「允许应用通过防火墙」里勾上本程序自带的 `node.exe`（**私有网络**即可），否则手机连不上、
  电脑本机却一切正常 —— 这个现象最容易误判成插件坏了。
- **明文 HTTP**：局域网里可以嗅探，访问码和 cookie 都等同明文。这是局域网场景的固有限制，
  要更强的保证只能上 TLS/隧道。
- **链接等于本机操作权限**：拿到链接的人就能操作这台电脑上的 agent（它本来就有 shell 能力）。
  别外传；泄露了就在面板上「重置访问码」。
- **端口冲突**：3081 被占则代理起不来，面板显示原因并给「重试」。**不会悄悄换端口** ——
  换端口就破坏「地址固定」这个前提了。注意此时开关仍是「开着」的（用户的意图记着），
  下次启动还会再试一次。
- **入口独占一行是「往上找 flex 容器」换来的**：`sidebar.footer.action` 是 `kind:"list"`，
  注册项被摊在 dsh 的 `footerActions` 里，而那是 `display:flex` **不换行**的行容器 ——
  两个插件会各占一半挤在同一行。所以组件挂载时把那个容器的 `flex-wrap` 改成 `wrap`
  （配合自己的 `flex:1 1 100%`），卸载时还原。
  注意**不能只看 `parentElement`**：`renderSlot()` 会先套一层
  `<div data-slot="…" style="display:contents">` 锚点，而 `display:contents` 的盒子不参与
  布局 —— 加在它身上等于没加（踩过：改完还是两个一半一半）。要往上找**第一个 computed
  display 是 flex 的祖先**。也不写死 class：那是构建期哈希（`hHd-Xa_footerActions`），
  dsh 一升级就变；而结构反而稳定。
- **依赖 dsh 的内部行为**，上游升级时留意这几个锚点：
  1. cookie 按 Host 头签发（`dsh-client-connection` 的 `BrowserAuth.authorizeIndex`）；
  2. 对话流走 `/api/remote.mux` 的 WebSocket Upgrade（`dsh-api-gateway`）；
  3. `/api` 的 Host/Origin 围栏（`isTrustedApiRequest`）；
  4. `sidebar.footer.action` 是 list 槽位、`renderSlot` 会套一层 `display:contents` 锚点、
     真正的行容器 `footerActions` 不换行（`dsh-client-ui-sidebar` + `dsh-client-ui-renderer`）。
  这四处任一改动，反代/入口都要跟着调。
- **虚拟网卡**：装了 Docker/WSL/Hyper-V 的机器上会有一堆网卡地址，自动挑选时会按
  「私有网段 > 非私有、非虚拟 > 虚拟、192.168 > 10 > 172.16-31」排序，避免把链接指到
  手机连不上的网段。挑错了可以用 `DSH_LAN_ACCESS_IP` 指定；面板底部也会列出其他网卡地址。

## 文件

```
manifest.json        id / order / entry / patch
cordis.patch.yml     把 host 半边插进 profile 插件树（刻意不动 webserver 的 host）
package.json         声明 dsh.client → 浏览器半边被 dsh-client-modules 自动发现
lan_access.mjs       host 半边：访问码 + 开关落盘、挑内网 IP、起停代理、注册读取/开关/重置接口
lib/proxy.mjs        反向代理本体：鉴权、cookie 兑换、头改写、HTTP + Upgrade 转发
lib/qr.mjs           纯 JS 二维码编码器（byte 模式 / EC M / v1-10 / 自动掩码）→ SVG
lib/client.js        浏览器半边：侧边栏入口（独占一行）+ 二维码/开关面板
```
