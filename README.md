# DeepSeek Harness 桌面壳（dsh-ui）

把 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（`@deepseek-ai/dsh`）的 Web UI
包成一个 Windows 桌面程序。

## 特性

- **WebView2 内核**：用系统自带的 Edge WebView2 渲染界面，不依赖外部浏览器
- **自带 Node 运行时**：产物内置 Node 26（exe 同目录 `node/`），用户机器不用另装 Node；
  该目录缺失时才回退到系统 Node
- **亮色界面**：启动页与插件管理器都是亮色主题（底色 `#f4f6fb`，DeepSeek 蓝强调色 `#4d6bfe`）
- **无命令行窗口**：打包为 windowed onedir 目录（`exe` + `_internal/`），服务进程用
  `CREATE_NO_WINDOW` 静默拉起
- **系统托盘**：关闭窗口只是收进托盘，服务继续在后台跑；托盘菜单可重新打开界面，
  也可「重启应用」（先拉起新实例再退出旧实例，服务随之重启）
- **保持唤醒**：启动即阻止系统睡眠（`SetThreadExecutionState`），后台任务不会被睡眠打断；
  不阻止息屏、不影响锁屏，退出时自动恢复系统默认睡眠策略
- **插件管理器**：托盘 →「插件管理器」，绿灯启用 / 红灯关闭，下面一个「重启服务并生效」
- **插件自动加载**：启动时按启用状态把 exe 同目录 `plugins/` 里的插件装进 dsh
  （`~/.dsh/profiles/web/`），关掉的就撤下来，不用手工改 dsh 的配置
- **一键更新**：托盘 →「检查更新（npm）」，自动执行
  `停止服务 → npm install @deepseek-ai/dsh@latest → 重启服务 → 重载界面`
- **默认走国内镜像**（`registry.npmmirror.com`），托盘菜单可在镜像 / 跟随系统之间切换

## 目录结构

```
src/                         代码（含构建、打包、自测）
├── dsh_shell.py             主程序（服务管理 / WebView2 / 托盘 / 更新 / 插件同步 / 两个界面）
├── app_icon.py              运行时绘制图标，无外部资源依赖
├── build.py                 一键打包入口
├── assets/app.ico           打包用的图标（缺了 build.py 会按 app_icon.py 重新生成）
├── packaging/*.spec         PyInstaller 打包配置
├── runtime/dsh_fastboot.mjs 启动加速补丁（node --import 注入，不改 dsh 文件）
└── tools/                   自测脚本
    ├── probe_service.py         服务层：安装 / 启动 / 健康检查 / 更新 / 停止
    ├── probe_auth.py            鉴权链路：401 → 303 + Set-Cookie → 200
    ├── probe_gui.py             GUI + 托盘：发 WM_CLOSE，确认收进托盘且进程存活
    ├── probe_update.py          npm 更新动作
    ├── probe_plugins.py         插件同步：扫描 → 镜像进 dsh → 重写托管补丁块
    └── probe_plugin_manager.py  插件管理器窗口 + js_api 桥 + 红绿灯渲染

build/                       PyInstaller 工作目录 + Python 字节码缓存（build/pycache）
dist/                        整个目录就是程序目录，一起分发
├── DeepSeekHarness.exe      启动器
├── _internal/               Python 运行时 + 依赖 + runtime/dsh_fastboot.mjs
├── plugins/                 插件源码，进版本库
├── plugins-third-party/     第三方插件（本机私有，不进版本库，照常加载）
└── node/                    自带的 Node 26（win-x64 zip 摊平），不进版本库
```

`.pyc` 不走源码目录：`dsh_shell.py` / `build.py` / `tools/*.py` 都设了 `sys.pycache_prefix`，
字节码统一落在 `build/pycache/` 下，源码树里不会再冒 `__pycache__`。

## 构建

```bash
# 准备隔离环境
python -m venv .venv
.venv/Scripts/pip install pywebview pystray pillow pyinstaller

# 打包
.venv/Scripts/python src/build.py
```

产物（onedir，不是一个单文件）：

```
dist/                        整个目录就是程序目录
├── DeepSeekHarness.exe      启动器，不能单独拷出来用
├── _internal/               Python 运行时 + 依赖 + runtime/dsh_fastboot.mjs
├── plugins/                 插件源码（运行时直接读这份）
├── plugins-third-party/     第三方插件（本机私有，不进版本库，照常加载）
└── node/                    自带的 Node 26
```

**分发要把整个 `dist/` 压成 zip。**

插件按**源码**放在 `dist/plugins/`（进版本库），**不打包进 exe**。本机私有的
第三方插件放 `dist/plugins-third-party/`（被 `.gitignore` 整体忽略，不进版本库），
外壳启动时两个目录一起扫描、一起参与加载，插件管理器里第三方插件带「第三方」徽标。

自带 Node 要**手工准备**（构建脚本不下载）：从 nodejs.org 下 win-x64 的 zip，把解压出来的
`node-v26.x.x-win-x64/` **里面的内容**（`node.exe`、`node_modules/`、`npm.cmd` 等）直接铺到
`dist/node/` 下 —— 要摊平，别留一层版本号目录。`src/build.py` 只检查 `dist/node/node.exe`
在不在并给警告，不会替你下载。`dist/node/` 被 `.gitignore` 的 `dist/*` 规则忽略，不进版本库。

## 运行前提

- Windows 10/11，已安装 **WebView2 运行时**（Win11 与近期 Win10 一般自带）
- **不用单独装 Node**：产物自带 Node 26（`dist/node/`）。只有该目录缺失时才回退到系统
  Node —— `PATH` 里找 `node`，再找常见安装位置（此时才需要 **Node.js 18+**）

首次启动会自动在数据目录里 `npm install @deepseek-ai/dsh`（依赖约 520 个包、
2.3 万个文件，首次需要几分钟，之后走缓存会快很多）。

## 数据目录

两个地方，别搞混：

**① `%LOCALAPPDATA%\DeepSeekHarness\`** —— 本壳程序自己的工作目录，**可丢、可重建**。
换台电脑不用带；只有想省掉重装和重登才值得拷。

| 路径 | 说明 | 丢了会怎样 |
| --- | --- | --- |
| `runtime/` | dsh 的 npm 安装目录（更新就是更新这里，约 220 MB） | 首次启动重新 `npm install`，几分钟 |
| `workspace/` | dsh 启动时的工作目录 | 里面放过东西的话就没了 |
| `webview/` | WebView2 用户数据（Cookie、localStorage） | 界面偏好重置；登录态由下面的 `.dsh` 决定 |
| `config.json` | 配置，`registry` 字段控制 npm 源，留空表示跟随系统 npm 配置 | 回到默认（国内镜像） |
| `plugins.json` | 插件启用状态（插件管理器写，红灯/绿灯就是它） | 所有插件回到默认「开启」 |
| `data/usage.json` | usage 插件的 token 账本 | 用量统计清零（从零开始记） |
| `shell.log` / `service.log` / `stdio.log` | 日志 | 无影响 |

**② `%USERPROFILE%\.dsh\`** —— dsh 自己的数据目录，**这个才是有状态的部分**：
`.credentials.yaml`（账号凭据）、`sessions/`（会话历史）、`storages/`、
`settings.yaml`，加上 `profiles/web/`（profile、插件安装副本、`cordis.patch.yml`）。
换机器想保住登录和聊天记录，要带的是它。

## 插件

插件包放在 **exe 同目录的 `plugins/`**（onedir 下就是 `dist/plugins/`，
壳运行时直接读这份，构建脚本不搬运），一个插件一个子目录。
**第三方插件**放在旁边的 `plugins-third-party/`（同样在 exe 同目录，开发态是
`dist/plugins-third-party/`）：目录整体被 `.gitignore` 忽略、不提交 git，但外壳
照常扫描、照常参与加载，插件管理器里会标「第三方」徽标。两个目录的包结构完全一样：

```
dist/
├── plugins/                         # 源码，同时也是运行时目录
│   ├── gitbash/                     # 内置插件：Windows 上改用 Git Bash
│   │   ├── manifest.json            # id / name / description / order / entry / patch
│   │   ├── cordis.patch.yml         # 要合进 dsh profile 的补丁片段
│   │   ├── gitbash-shell.mjs        # 插件本体（host 半边）
│   │   └── README.md
│   ├── usage/                       # 内置插件：token 用量统计
│   │   ├── manifest.json
│   │   ├── cordis.patch.yml         # 只插 host 半边
│   │   ├── package.json             # 声明 dsh.client → 浏览器半边被自动发现
│   │   ├── usage.mjs                # host 半边：采集 + 读取接口
│   │   ├── lib/client.js            # 浏览器半边：侧边栏入口 + 堆叠柱状图
│   │   └── README.md
│   ├── lan_access/                  # 内置插件：局域网扫码访问
│   │   ├── manifest.json
│   │   ├── cordis.patch.yml         # 只插 host 半边（刻意不改 webserver 的 host）
│   │   ├── package.json
│   │   ├── lan_access.mjs           # host 半边：访问码/开关落盘 + 起停代理 + 读取/开关/重置接口
│   │   ├── lib/proxy.mjs            # 带鉴权的反向代理（HTTP + WebSocket）
│   │   ├── lib/qr.mjs               # 纯 JS 二维码编码器 → SVG
│   │   ├── lib/client.js            # 浏览器半边：侧边栏入口（独占一行）+ 二维码/开关面板
│   │   └── README.md
│   ├── retry/                       # 内置插件：消息编辑 / 重试
│   │   ├── manifest.json
│   │   ├── cordis.patch.yml         # 只插 host 半边
│   │   ├── package.json             # 声明 dsh.client → 浏览器半边被自动发现
│   │   ├── retry.mjs                # host 半边：算「切哪儿、原文是什么」的读取接口
│   │   ├── lib/origin.mjs           # 纯函数：会话日志 → 切点 + 原文
│   │   ├── lib/client.js            # 浏览器半边：消息上的编辑/重试按钮 + 分支重发
│   │   └── README.md
│   └── …                            # 其余内置插件
└── plugins-third-party/             # 第三方插件：本机私有，不进版本库，照常加载
    ├── dsh-cf/                      # 例：CodeFree-O 反代（本机私有）
    └── review/                      # 例：待处理改动审查（本机私有）
```

**装进 dsh 的规则**（dsh-ui 每次启动、以及管理器点「重启」时执行）：

1. 扫 `plugins/` **和** `plugins-third-party/` 下所有带 `manifest.json` 的包
   （第三方目录不存在就跳过）；没记录过的插件默认**开启**；
2. 开启的包 → 整目录镜像到 `%USERPROFILE%\.dsh\profiles\web\plugins\<id>\`
   （源目录没变就跳过复制，靠 `.dsh-ui-plugin.json` 指纹判断；包**根目录**下的 `data/`
   是插件的运行态，既不复制也不进指纹 —— 插件自己的数据放 `<数据目录>/data/`）；
3. 关闭的包 → 删掉安装副本（只删本程序装的，认指纹文件；目录链接一律不碰）；
4. 把已启用插件的补丁片段按 `order` 拼成一个托管块，重写
   `~/.dsh/profiles/web/cordis.patch.yml` ——
   两个 `dsh-ui 插件管理块` 标记之外的内容原样保留，没有插件时回到 `[]`。

插件目录里 `cordis.patch.yml` 的 `./plugins/<id>/<entry>` 是**相对 profile 目录**的
路径，dsh 的 loader 会把它转成 `file://` —— 所以插件本身可以放在任何地方。

### 内置：`gitbash`

Windows 上把 shell 执行器换成 Git Bash，并把模型看到的 shell 工具从 `pwsh`
改成 `bash`。**纯插件**：不写 agent 预设、不动 `$DSH_HOME/.agent-presets`，
改名和提示词改写都在运行时拦截工具注册完成。原理、代价和踩过的坑见
[dist/plugins/gitbash/README.md](dist/plugins/gitbash/README.md)。

### 内置：`usage`

统计 token 用量。界面上在**左下角、设置按钮上方**多一个入口，点开是堆叠柱状图：
固定最近 15 天一天一根柱子（今天在最右、横轴刻度只写「日」），每个模型一个颜色自下而上叠，
鼠标移到色块上提示「模型 + 颜色 + **当日占比** + 用量」。没有用量的那天留一条占位短横。
用量单位自动进位：**万 token**，到 1 亿走**亿**。

- **账本**：`%LOCALAPPDATA%\DeepSeekHarness\data\usage.json` —— 外壳自己的数据根
  （和 `config.json` / `plugins.json` 同处），**不放插件目录**：插件包是整目录重抄的镜像，
  放里面会被连坐删掉、还天然多出一个副本。按「天 × 模型」累计，落盘走
  「写临时文件 + rename」+ 800ms 去抖。
- **口径**：`input + cacheRead + cacheWrite + output`，四桶互不重叠
  （与上游 `dsh-token-meter` 的 `usageTokens()` 一致）。
- **只统计安装之后新发生的调用**，不回填历史 —— 所以刚装上是空的，发一轮对话就有数据。
  同一 (turn, step) 反复结算时按「覆盖」而非「累加」，重试/流式收敛不会虚高。
- **刷新会回读账本文件**：每次读（含 5 秒轮询）都先同步磁盘，别处写进去的账能看见。
- **双面插件**：host 半边（`usage.mjs`）采集并注册鉴权过的 `GET /api/usage.data`；
  浏览器半边（`lib/client.js`）靠 `package.json` 里的 `dsh.client` 被
  `dsh-client-modules` 自动发现，**不用写进补丁**。
- 细节与设计取舍见 [dist/plugins/usage/README.md](dist/plugins/usage/README.md)。

### 内置：`lan_access`

让手机在**同一个局域网里扫码打开网页版**。界面上同样在**左下角、设置按钮上方**多一个入口
（**独占一行**，不和 `usage` 挤在同一行），点开是二维码 + 一条链接；手机上扫码就能用，
功能与电脑上一致。

- **默认关闭、开了就记住**：插件装上后入口就在，但 3081 端口**不监听** —— 局域网通道等于
  把本机的操作权限摊到网上，不能默认开着。面板里点「开启局域网访问」才起代理，开关状态和
  访问码存在一起，下次启动自动恢复；点「关闭」端口立刻释放。
- **链接固定**：`http://<内网IP>:3081/?lan=<访问码>`。访问码 16 字节随机、只生成一次，
  落在 `%LOCALAPPDATA%\DeepSeekHarness\data\lan_access.json`，所以**只要内网 IP 不变，
  链接和二维码就不变**（IP 变了链接跟着变，这是内网地址本身的性质）。端口写死 3081：
  端口一变链接就变，被占用时宁可报错也不换（面板会显示原因并给「重试」）。
- **不动 dsh 的绑定**：dsh 依旧只监听 `127.0.0.1:3080`。上游把 `--host 0.0.0.0` 明确堵死了
  （`dsh-web-app` 的 startup 里写着「会把 RCE 暴露到网络」），插件改成**自己在局域网侧起一个
  带鉴权的反向代理**，暴露面完全由插件控制 —— 关掉开关端口就释放，关掉插件更是一点不留。
- **两层鉴权**：局域网侧是固定访问码（`?lan=` → 长期 cookie）；回环侧是 dsh 自己的会话 cookie，
  由代理用进程 launch token 自己完成登录跳转换好后代持，**浏览器全程不接触 dsh 的 token/cookie**。
  默认只放行内网/回环来源；面板上可一键**重置访问码**，旧链接立即失效。
- **WebSocket 也走代理**：对话流不是 SSE，而是 `/api/remote.mux` 上的 WebSocket
  （`dsh-api-gateway` 注册的 Upgrade 路由，握手时同样过 dsh 的 Host/Origin 围栏 + cookie 鉴权）。
  代理用 `net.connect` 原样转发握手，少了这一段页面能开但一发消息就废。
- **二维码在宿主侧生成**（`lib/qr.mjs`，纯 JS 编码器，无依赖），前端只负责显示 ——
  浏览器半边不用为了显示一张图多背几百行编码器。
- 首次连不上多半是 **Windows 防火墙**拦了入站，要放行本程序自带的 `node.exe`（私有网络）；
  更多坑与设计取舍见 [dist/plugins/lan_access/README.md](dist/plugins/lan_access/README.md)。

### 内置：`retry`

每条**用户消息**的复制按钮旁边多两个按钮：**编辑**（弹出编辑框，预填这轮消息的原文）
和**重试**（原文重发）。两者的效果都是**从这一轮之前新建一个分支，把消息作为新的一轮
发出去** —— 原会话原样保留，新分支出现在同一个工作区分组里（标题自增），界面自动切过去。

- **为什么是新建分支**：dsh 的会话日志是只追加的。日志之上那层 surface 虽然能追加
  `replace` 把旧轮次从**模型可见**的历史里抹掉，但**界面不认**（可见记录只由 `append`
  事件拼出来），真那么做就是「你看得见旧回答、模型看不见」。所以照搬内置「分支」按钮
  的做法：在目标轮次之前切一刀，在新分支里重新发一轮。代价是每次重试多一个会话。
- **切点**：宿主 `session.fork` 的语义是「第一个 seq ≥ atSeq 的 `turn/end`」，
  所以 `atSeq` 要指到**前一轮的 `turn/end`**，切出来的分支才正好停在这一轮之前。
  第一轮没有前一轮可指 → 改成新建一个同目录会话；这一轮还在生成 → 先
  `session.cancel()`（和停止按钮同一个调用）再切。
- **原文从日志取、不从界面读**：界面上的气泡是渲染过的（`@文件` 变成 chip、空白折叠），
  拿它的文本去重发会走形。带附件的消息照样能重试/编辑，**但附件不会跟着走**
  （重发通道只收浏览器现传的上传回执），弹窗和提示条里都会说明。
- **分组靠宿主**：侧边栏按**工作区**分组，归属关系只记在工作区那边（会话 header 里没有）。
  第一轮那条路要新建会话，宿主 `session.create` 只收 `workspaceId` 或 `cwd` 之一 ——
  给 `cwd` 会得到不属于任何工作区的会话，掉进「未分组」。所以建分支 + 发消息都在
  宿主做（`sessionController.fork/create/prompt`，也就是浏览器那条 RPC 的同一段代码）。
- **切完要清一次子会话收件箱**：fork 的切点让这一轮那条用户消息的 inbox 插入 splice
  落在种子里、配对的移除 splice 留在外面，子会话会把它当**待发**复活（先跑一遍旧消息，
  再把重发的那条接上）。`agent.cancel(cause, {keepInbox:false})` 清掉。
- **分支标题挑没被占用的序号**：只按「源标题 +1」的话，连着从同一个会话切两次会得到
  两个同名的 `xxx (1)`；改成拿现有标题列表算 `max+1`。
- **按钮是 DOM 注入的**：用户消息那一行没有插槽可挂（`user` 键位是整块替换，
  `extraActions` 只给助手行）。认 `[data-chat-flow-kind="user"][data-chat-turn]` 那行、
  插在动作行里复制按钮后面；`MutationObserver` 让它被 React 重建后自己长回来。
  中途插话（`steering`）和还没有轮次号的本地回显不给按钮。
- host 半边提供两条接口：`GET .../origin` 只读地算「切哪儿、原文是什么」，
  `POST .../commit` 真正建分支 + 发消息；浏览器半边只负责刷列表和把界面切过去。
  **改完这个插件要重启服务**（`patchReload: live` 对插件文件不生效，重启最稳）。
- 详细取舍、DOM 契约和自测见 [dist/plugins/retry/README.md](dist/plugins/retry/README.md)。

### 任务栏鲸鱼动画（桌面壳内置）

**有会话在活动（agent 正在响应）时，任务栏按钮的文字变成鲸鱼游动 + 波浪起伏的动画**：
鲸鱼 `🐋` 匀速左右游动，三层波浪（`≈` 内层、`~` 中层、`-` 外层）从鲸鱼两侧一层层
泛起又收回；空闲时回到静止的「DeepSeek Harness」。

- **「在跑」的判据 = 前端会话列表的活动指示器**：`session/list` 的 summaries 里
  任一会话 `running` 为 true（agent 正在响应），或 `$events` 事件流收到
  `api-session/status` 事件。和侧边栏会话名字旁那个旋转动画同源。
- **每帧固定 12 字符**（「DeepSeek Harness」左右各删 2 个字符，按字符数计、
  非字体测量），任务栏按钮不会随动画变宽变窄。
- **桌面壳 Python 侧实现**（`src/dsh_shell.py` 的 `TaskbarJobWatcher`）：WebSocket
  直连本地服务订阅 `$events` 事件流，与 WebView2 页面无关 —— 窗口最小化、隐藏到
  托盘、甚至页面卡住时都照常工作。
- **低占用**：约 5.5 帧/秒（0.18s/帧），50ms 接收超时 + 50ms 等待，不空转；
  标题只在变化时写入。

## 两个容易踩的坑

1. **访问必须带 token。** `dsh web` 启动时会打印
   `http://127.0.0.1:3080/?token=xxx`，直接访问裸地址会返回 `401`。
   本程序启动服务时抓取该地址（`--no-open` 同时阻止 dsh 自己弹浏览器），
   带 token 访问会拿到 `303 + Set-Cookie`，Cookie 落在 `webview/` 里持久化。
2. **token 每次启动都变**，所以服务必须由本程序自己拉起，不能复用外部已在跑的实例。
3. **`evaluate_js` / `load_url` / `hide` 都会同步 Invoke 到 UI 线程。** 程序刚起来的
   那几秒，主线程正卡在 `webview.start()` 里初始化 WebView2，此时从后台线程发任何
   窗口操作都会被堵住（实测约 3 秒）。所以启动页状态走 `_post_ui()` 投递给独立线程
   异步发，`service.start()` 排在它们前面 —— 否则 dsh 那段冷启动会被平白推迟 3 秒。
   同理，退出时「隐藏窗口 + 停托盘」是前台做的（毫秒级），杀服务和销毁窗口这些
   耗时动作交给 `_shutdown()` 后台做。

## 启动构成 / 启动加速

一次冷启动（真机 onedir exe，`DSH_UI_TIMING=1` 实测）：**进程启动 → 界面开始加载 ≈ 3.4 秒**。

同一套产物下把 `dist/node/` 撤掉、回退到系统 Node 22.23.2，同一个打点会变成 **≈ 4.4 秒** ——
自带 Node 26 在这里省了约 1.0 秒（−22%）。各测 3 次：3.351 / 3.414 / 3.519s（自带）对
4.408 / 4.462 / 4.286s（系统 22）。

| 阶段 | 耗时 | 说明 |
| --- | --- | --- |
| exe 自举 + 壳自身（单实例锁 / 图标 / 建窗口 / 托盘 / 起服务） | ≈ 0.44s | PyInstaller 起运行时占大头，`service.start()` 本身只要 0.016s |
| dsh 冷启动 | ≈ 3.0s | 大头，见下 |

**打包形态是 onedir，不是 onefile。** 单文件 exe 每次启动都要把自己解压到
`%TEMP%\_MEIxxxxx`，实测固定多花 **0.65s**（端口 listen 3.35s vs onedir 2.75s），
而且被强杀 / 崩溃时解压目录不会清理 —— 实测一次排查就攒了 18 个残留共 646MB。
onedir 没有这一步，代价是产物从 1 个文件变成一个目录（159MB，其中自带 Node 占 107MB，
分发要压 zip）。

dsh 那 3.0 秒里：

- **约 1.5s 是 Node 加载 200 多个包**。Node 版本对这个数字影响很大 —— 见下。
- **约 0.6s 是拼接前端 client bundle**（延迟到首次被读时才算的那一次）。
  不加速的话这一步要重复 10 次、合计 **2.5 秒以上** —— 见下。
- 其余是插件加载、起 HTTP 服务、打印 token。

### Node 版本：自带 26，不是系统 22

补丁之后，dsh 冷启动的瓶颈就落到 Node 本身。直连 dsh 测「spawn → 打印带 token 的 URL」
（各 5 次，都开补丁）：

| Node | 耗时 |
| --- | --- |
| 22.23.2 | 3.66s |
| 24.21.0 LTS | 3.29s |
| **26.9.0（产物自带）** | **2.50s** |

所以产物自带 Node 26（`dist/node/`，win-x64 zip 摊平），`find_node()` 自带优先、系统兜底。
自带的这份不调 `module.enableCompileCache`，Node 26 也不默认开 —— 提速来自 V8 / 模块加载
本身，不需要任何配置。

### 启动加速补丁（`src/runtime/dsh_fastboot.mjs`）

`dsh-client-modules` 会在**每注册一个插件**时把全部前端 client bundle 重新拼接一遍
（含逐行生成的 identity sourcemap）。实测一次启动它被调用 **10 次**，
而启动阶段这些产物**没有任何消费者**——前端还没连上来，第一次读取发生在浏览器请求
首页（`webserver/index-inject`）或 `.js` 产物（`bundleResource`）的时候。

补丁把这四个字段（`composed` / `responses` / `batchResponses` /
`previousBatchResponses`）改成访问器：启动期间 `compose()` 只记账，**首次被读时才算一次**，
之后立刻交回 dsh 原逻辑。实测 10 次 → 1 次，直连 dsh 的「打印带 token 的 URL」
从 **5.04s 降到 2.50s**（Node 26；Node 22 上是 4.44s → 3.66s）。

- **不改 dsh 任何文件**，由 `node --import` 注入，路径写在 `DshService.start()` 里。
- **只做延迟、不改结果**：首次读取时按完整表格算，结果与不加速时一致；
  若有人在启动中途读图，只是让加速失效，不会给出错误结果；整个补丁包在 `try/catch` 里，
  任何异常都只意味着「没加速」。
- **开关**：`DSH_UI_FASTBOOT=0` 关闭；`DSH_UI_TIMING=1` 时补丁会把
  「跳过 N 次 / 实际算 1 次花多久」写进 `service.log`。
- **顺带说一个负面结果**：补丁里曾经还有一段 `module.enableCompileCache()`（字节码缓存），
  实测它建的 `dsh-compile-cache` 目录始终是 **0 个文件**、开关前后耗时也没有差异
  （4.60s vs 4.51s），已从 `dsh_fastboot.mjs` 里删掉。别再往回加。
- **验证结论**：补丁前后各抓一次首页 `window.__DSH_BOOT__` 里的产物做逐字节比对 ——
  dsh 每次启动会混入随机 nonce，产物字节本来就不可能完全一致，所以比对前先归一化；
  归一化后实测 55 份产物里 54 份字节完全相同，只有那个 11MB 的批量包拼接顺序会变
  （`orderByModuleGraph` 允许同优先级按扫描顺序打破平局，与补丁无关）。

### 自测

```bash
<venv>/Scripts/python.exe src/tools/probe_plugins.py --list      # 只看扫描到哪些插件
<venv>/Scripts/python.exe src/tools/probe_plugins.py             # 真同步一次到 ~/.dsh
# 想不碰真实环境，指向临时目录：
<venv>/Scripts/python.exe src/tools/probe_plugins.py \
    --plugins-dir <临时插件目录> --dsh-home <临时 dsh 目录>

<venv>/Scripts/python.exe src/tools/probe_lan_access.py          # 局域网访问插件
<venv>/Scripts/python.exe src/tools/probe_retry.py               # 消息编辑 / 重试插件
```

`probe_gui.py` 可以带一个参数：不传跑源码，传 exe 路径就测打包产物。

`probe_lan_access.py` 只负责找 node、把插件目录传给
`src/tools/probe_lan_access_checks.mjs`（检查本体是 JS）。它**不碰真实环境**：
假上游是现起的 node:http，状态文件指向临时目录，代理只绑 `127.0.0.1` + 临时端口。
覆盖二维码编码器的已知向量与「生成矩阵 → 反解回原文」、代理的鉴权/头改写/Upgrade 透传/
收尾不卡住、宿主半边的**默认关闭与开关持久化**（含「重新 import 模拟重启」和状态文件损坏），
以及浏览器半边在几种数据状态下的渲染冒烟与「入口独占一行」。

`probe_retry.py` 同理，检查本体在 `src/tools/probe_retry_checks.mjs`，全程假日志 / 假 ctx /
假 DOM / 假 fetch（不起服务、不发请求）。覆盖切点计算的全部边界（第一轮 / 没跑完 / 注入
上下文 / 只有附件 / 轮次不存在）、宿主接口的参数与错误分支（含观测租约释放、退回活动会话），
以及浏览器半边的按钮注入幂等、行重建后自己长回来、重试 / 编辑 / 第一轮走新建 / 正在跑先
cancel / 四类失败路径。

#### 耗时诊断

觉得「打开慢 / 退出慢」时，带 `DSH_UI_TIMING=1` 启动（源码或 exe 都行），
`shell.log` 里会多出形如 `[t+  3.412s] [timing] <阶段名>` 的打点，直接看时间花在哪一段：

```bat
set DSH_UI_TIMING=1
dist\DeepSeekHarness.exe
```

对照的耗时构成见上一节。改动启动 / 退出路径后，务必守着上面那条
「`evaluate_js` 会同步 Invoke 到 UI 线程」的约束 —— 那是当初 3 秒延迟的根源。

## 已验证的边界

`dsh web` 只监听 loopback，不允许对外提供服务：`--host 0.0.0.0` 被 CLI 直接拒绝，
`--host <具体IP>` 过不了配置校验。要让其他设备访问只能套反向代理/隧道，
且真实 authority 必须进 `--trusted-host`，否则 `/api` 会被 browser-trust fence 挡成 403。

内置的 `lan_access` 插件就是照这条路走的：**反向代理**在局域网侧另开一个口子，
转发时把 `Host` / `Origin` / `Referer` 改写成回环 authority、`Cookie` 换成它自己用
launch token 换来的 dsh 会话 cookie —— 围栏和鉴权都由代理替浏览器过掉，
浏览器从头到尾只跟代理打交道。而且这个口子**默认是关的**（要在面板里手动开），
开关状态落盘，下次启动照旧。原理、代价与踩过的坑见
[dist/plugins/lan_access/README.md](dist/plugins/lan_access/README.md)。

`sidebar.footer.action` 是 `kind:"list"` 槽位，注册项被摊在 dsh 的 `footerActions` 里，
而那是 `display:flex` 且**不换行**的行容器 —— 所以多个插件默认会各占一半挤在同一行。
想让入口独占一行，只能在挂载时把那个容器的 `flex-wrap` 改成 `wrap`（`lan_access` 就是这么做的）。
坑在于**不能只看 `parentElement`**：`renderSlot()` 会先套一层 `display:contents` 的锚点，
盒子不参与布局，改它等于没改 —— 要往上找第一个 computed display 是 `flex` 的祖先。

**每条消息那一行没有插槽**：`conversation.chat.node` 是按 kind 的 keyed 槽（`user` 键位是
**整块替换**，注册了就顶掉 dsh 自己的用户气泡渲染），`MessageIconActions` 的 `extraActions`
只往助手行传。想往**用户消息**上加动作只能 DOM 注入，靠 dsh 自己标在行上的三个属性认位置：

| 属性 | 值 | 用途 |
| --- | --- | --- |
| `data-chat-flow-kind` | `user` / `steering` / `assistant` / … | 用户自己发的起始消息是 `user`；中途插话是 `steering`（没有「轮」的概念，别给重试按钮） |
| `data-chat-turn` | 轮次号（整数） | 就是 `turn/start` 事件里的 `turn`，宿主拿它去会话日志里找切点 |
| `data-chat-anchor-key` / `data-chat-flow-key` | 节点 key | 形如 `input-message:<消息 id>`（**不是** seq），别拿它当事件序号用 |

动作行容器是行里第一个 class 形如 `<hash>_actions` 的 div（CSS Modules 的
`xzv4MW_actions`，哈希随版本变、后缀不会），「复制」是它里面第一个 `button`。
按钮插在 React 管的 DOM 里会被重建冲掉，得挂 `MutationObserver` 自己长回来
（`retry` 就是这么做的）。
