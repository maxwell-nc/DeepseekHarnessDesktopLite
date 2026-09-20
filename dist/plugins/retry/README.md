# dist/plugins/retry — 消息编辑 / 重试

在每条**用户消息**的复制按钮旁边加两个按钮：

- **编辑**：弹出编辑框（预填这轮的用户消息原文），改完点「发送并新建分支」；
- **重试**：原文重发，不问。

效果都是**从这一轮之前新建一个分支，再把消息作为新的一轮发出去**：原会话原样保留，
新分支出现在**同一个工作区分组**里（标题自增，父子不会同名），界面自动切过去。

## 为什么是「新建分支」而不是「就地改写」

dsh 的会话日志是**只追加**的：用户消息发出去、模型答完，这些事件就钉在日志里了。
日志之上有一层 surface（`append` / `replace`），理论上可以追加一条 `replace` 把旧的
那一轮从**模型可见**的历史里抹掉 —— 但**界面不认**：可见记录只由 `append` 事件拼出来
（`isAppendSurfaceEvent`，见 `dsh-client-ui-chat` 里那个 `messageDefinition`），替换只
影响送到模型的内容。真那么做的话就是「你看得见旧回答、模型看不见」，两边对不上。

所以只有一条正路：照搬内置**「分支」按钮**的做法 —— 在目标轮次之前切一刀，
新分支里重新发一轮。`/api/usage`、`lan_access` 那些插件是往界面上加东西，
这个是复用 dsh 自己的会话生命周期，代价是「每次重试多一个会话」；换来的好处是
历史永远是真的、模型看到的和你看到的永远一致。

## 切点怎么算（宿主 `session.fork` 的语义）

宿主 `session.fork` 的实现是：

```
boundary = 第一个 seq >= atSeq 的 turn/end
cut      = boundary.seq + 1 起往后找到的下一个 turn/start
seed     = events.slice(0, cut)
```

所以想让新分支**正好停在第 N 轮的 `turn/start` 之前**，`atSeq` 必须落在
**(第 N-2 轮的 `turn/end`, 第 N-1 轮的 `turn/end`]** 这个区间里 —— 取第 N-1 轮的
`turn/end` 本身最直接（`lib/origin.mjs` 就是这么算的）。给第 N 轮内部的任何一个 seq
会切出「含第 N 轮」的历史，那是分支按钮的行为，不是重试。

两个边界情况：

- **第一轮**：前面没有任何 `turn/end` 可指，fork 不出来 → `resolveOrigin` 回
  `first: true`，改成 `sessionController.create({workspaceId})` 新建一个会话再发
  （本来就是从头开始，效果一样）。**必须带工作区**，见下面的「分组」。
- **这一轮还在生成**：`fork` 的切点在这一轮之前，跟它跑没跑完无关，照样切得动。
  但直接切会把父会话那一轮晾着继续烧 token，所以 `resolveOrigin` 回 `open: true`，
  先 `sessionController.cancel({sessionId})`（和停止按钮同一条路径）再切，不等它落地。

## 数据流（建分支和发消息都在宿主）

```
浏览器                      宿主（retry.mjs）                        dsh 服务
  │ 点「重试」/「发送」          │                                      │
  ├─ GET /api/dsh-ui-retry.origin?sessionId&turn ─────────────► 读会话日志
  │                           │  resolveOrigin()（lib/origin.mjs）
  │◄─ {ok, atSeq, first, open, text, attachments} ──────────────┤
  ├─ POST /api/dsh-ui-retry.commit {sessionId, turn, text, titles} ►│
  │                           │  open 时先 sessionController.cancel()
  │                           │  first 时 create({workspaceId})
  │                           │  否则 fork({sessionId, atSeq}) → 清幽灵待办 → rename
  │                           │  sessionController.prompt(文本, queue)
  │◄─ {ok, childId, kind} ─────────────────────────────────────┤
  ├─ sessions.refresh() → sessions.open(childId)                │
```

**为什么这两步在宿主、不在浏览器**（最初是浏览器那边做 `sessions.fork()` + `prompt()`，
实测有两个坑）：

1. **分组**。侧边栏是按**工作区**分组的（`dsh-client-ui-workspace` 的 `owningGroupKey()`
   拿工作区的 `sessionIds` 反查），而归属关系记在工作区那边 —— 会话自己的 header 里
   没有这个字段。第一轮那条路要新建会话，宿主 `session.create` **只收
   `workspaceId` 或 `cwd` 之一**，给 `cwd` 会得到一个**不属于任何工作区**的会话，
   侧边栏里直接掉进「未分组」。宿主这边工作区归属是现成的
   （`workspaceRegistry.list()`，也就是 `fork` 内部 `forkWorkspace()` 用的那份数据），
   所以把 `workspaceId` 交上去 —— 顺带 cwd 也由工作区的 path 决定，不用再传。
2. **少一个时序坑**。浏览器那边发消息得先 `sessions.binding(childId)` 拿到会话面，
   新会话刚建出来时不一定立刻挂得上（实测就是这样：会话建出来了、消息没发出去，
   只留一个空会话）；而 `prompt` 的模型选择、附件准入、resume/adopt 本来就在宿主
   `sessionController.prompt()` 里 —— 直接调它，走的就是浏览器那条 RPC 的同一段代码。

浏览器的活只剩：读接口 → POST → `sessions.refresh()` → `open(childId)`。
（子会话是宿主建的，浏览器列表还不知道它，所以要先刷一次权威列表；刷完还 open 不动
就不 open 了 —— 分支和消息都已经就位，提示条里让用户去侧边栏点开。）

### 三个踩过的坑

- **`sessionController.prompt()` 的第二个参数（AbortSignal）是必填的**：RPC 那层拿它做
  「准入前的取消」，内部第一句就是 `signal.throwIfAborted()`。漏了会当场炸
  `Cannot read properties of undefined (reading 'throwIfAborted')`（`fork` / `create` /
  `cancel` / `rename` 都不需要）。
- **`create` 的 `workspaceId` 和 `cwd` 不能同时给**，宿主会直接
  `gateway/bad-request: session.create accepts workspaceId or cwd, not both`。
  有工作区就给 `workspaceId`，没有（别的部署）才退回会话自己的 cwd。
- **第一轮新建会话必须带上源会话的 agent 预设**，否则极简模式里重试第一轮会落到默认
  预设（「重试/编辑后模式变了」的根因）。预设取**当前值**而不是创建时的值：会话 header
  里记的是**创建那一刻**的预设，之后用户可能通过 `agent-preset/selected` 切过（极简
  模式就是这么进的），header 会过期。所以优先读观测的**投影**
  （`projections.values.agentPreset`，和宿主 fork 路由的 `presetForObservation` 看的是
  同一份数据），投影拿不到（老会话 / 非预设部署）才退回 header。fork 那条路由宿主自己
  继承预设，不用管。
- **fork 出来的子会话会「复活」这一轮那条旧消息**（用户报的「重发之后原来那条还在」）。
  原因：fork 的切点在「上一轮的 `turn/end`」和「这一轮的 `turn/start`」之间，而这一轮
  那条用户消息的 **inbox splice（插入）正好落在这个区间里**，配对的「移除」splice 在
  `turn/start` 之后 —— 子会话按日志重建收件箱时就把它当成**待发**了。于是先跑一遍旧
  消息（界面看着像「没去掉」），再把重发的那条接在后面。
  修法：fork 之后、`prompt` **之前** `agent.cancel({kind:"user"}, {keepInbox:false})`
  把收件箱清空（界面的停止按钮用的是 `keepInbox:true`，那是「保留待办、只中断这一轮」）。
  顺序不能反 —— 反了会把自己刚发的那条一起清掉。实测子会话日志里会出现一条
  `agent/inbox/spliced`（`removedCount:1, outcome:"canceled"`）。

**分支标题要挑一个没被占用的序号**：只按源标题 +1（内置分支按钮的
`increasedForkTitle` 就是那么干的）的话，连着从**同一个会话**切两次会得到两个同名的
`base (1)`（用户报过这个）。所以宿主拿浏览器送来的**现有标题列表**当占位表：base 相同
且带序号的都算占过，取 `max+1`；源标题自己带的序号也参与（源是 `base (1)` 时从 2 开始）。
规则在 `branchTitle()`（纯函数，自测直接对答案），`titles` 为空时退化成 `(1)`。
标题从日志里最后一条 `session/title` 事件取，改名走 `sessionController.rename()`。

## 按钮是怎么插进去的

用户消息那一行**没有插槽**可挂（`conversation.chat.node` 的 `user` 键位是整块替换，
`MessageIconActions` 的 `extraActions` 只给助手行），所以走 DOM 注入：

- 认行：`[data-chat-flow-kind="user"][data-chat-turn]`。`kind` 是 dsh 自己标的
  （用户起始消息是 `user`，中途插话是 `steering`，助手/工具行另说），`turn` 是这一轮在
  会话日志里的轮次号 —— 宿主拿它去日志里找切点。两个都在才算数，**steering 行和最上面
  那条本地回显（还没有轮次号）不给按钮**。
- 认容器：行里第一个 class 形如 `<hash>_actions` 的 div（CSS Modules 生成的
  `xzv4MW_actions`，哈希会随版本变、`_actions` 后缀不会），再把按钮插在**复制按钮**
  （容器里第一个 `button`）后面 —— 正好是 dsh 自己留给 `extraActions` 的位置。
- **能自己长回来**：按钮插在 React 管的 DOM 里，行重建 / 切会话都会被冲掉。
  所以挂了个 `MutationObserver`（攒 80ms 一批，只扫新增子树 + 它所在的那行，
  不然流式输出时全量扫会把界面拖卡），用 `data-dshr-ui` 标记做幂等。
- 样式用 dsh 的主题变量（`--dsw-*`）和内容字号变量（`--dsh-content-font-delta`），
  没引 dsh 的 class —— 类名是哈希的，跟着版本走会崩。按钮外面那圈 hover / 显隐
  （非最新一轮要鼠标悬停才出现）直接继承动作行的样式。

## 装法

跟其它插件一样：放在 `dist/plugins/retry/`，外壳启动时按启用状态镜像到
`<DSH_HOME>/profiles/<profile>/plugins/retry/`，并把 `cordis.patch.yml` 的片段
拼进托管块。**客户端那半边不用写进补丁**：`package.json` 里的 `dsh.client` 会被
`dsh-client-modules` 自动发现（管理块里只有 host 半边那一行）。

**改完插件要重启服务**（托盘「插件管理器 → 重启服务并生效」，或者干脆重开程序）：

- **host 半边**（接口那部分）：`profile.patchReload` 虽然是 `live`，但实测**改了插件
  文件不会自动重新加载** —— 曾经出现过「origin 路由是新的、commit 路由 404」这种
  半新半旧的混合状态（旧 fiber 的路由还在，新代码又没注册上新路由）。所以别指望热重载，
  以「重启服务/重开程序」为准。
- **浏览器半边**：客户端包的清单是页面加载时拼进 `window.__DSH_BOOT__` 的，
  已经打开的页面不会自己认出新插件；新开的页面会拿到新版本（客户端模块注册表按
  文件基线重新拼，实测「改完源码 → 重新同步 → 刷一次页面」拿到的就是新产物）。
  注意两边要**一起**是新的：界面已经拿到新版本、服务里还是旧插件时，POST 会 404 ——
  提示条会明说「插件可能刚更新过，重启服务后刷新界面」。

## 自测

```bash
<venv>/Scripts/python.exe src/tools/probe_retry.py
```

不碰真实环境：假日志、假 ctx、假 DOM、假 fetch。覆盖：

- **切点计算**（`lib/origin.mjs`）：全部边界 —— 第一轮 / 还没跑完 / 注入上下文 /
  只有附件 / 替换副本 / 轮次不存在 / 轮次号非法 / 空日志；
- **宿主接口**：两条路由的注册、参数与业务校验、观测租约释放、退回活动会话、
  `fork`+标题自增+`prompt` 的调用与顺序、`create` 必须带工作区（没有工作区时退回 cwd）、
  正在跑先 cancel、prompt 的 AbortSignal、四类失败路径；
- **浏览器半边**：按钮注入幂等、行重建后自己长回来、重试 / 编辑（弹窗预填日志原文）、
  POST 体、刷列表 + 切会话、以及失败/切不过去时的提示条。
