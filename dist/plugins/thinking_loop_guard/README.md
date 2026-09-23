# 思考循环守卫（thinking_loop_guard）

实时检测模型**思考内容死循环**的 dsh 插件。部分模型思考（reasoning）时同一段内容
反复刷、一直烧到 max_tokens 才停 —— 本插件在循环早期就自动**分支重跑**一次（retry
同款机制），再循环才掐掉整轮，保住时间和 token。

## 怎么工作

**宿主半边**（`loop_guard.mjs`）挂在 `llm/stream` 瀑布上，包裹每一次流式模型调用
（所有会话、包括子代理都生效），对 `reasoning-delta` 增量做三类检测：

| 类型 | 原理 | 命中条件（阈值按单元长度分级） |
| --- | --- | --- |
| 精确重复 | 流尾部按最小周期逐字重复 | 单元 ≥120 字符重复 3 次；越短要求次数越多 |
| 相似回声 | 相邻 420 字符窗口 trigram-Jaccard ≥0.86 连续命中 | 连续 3 次（专抓带漂移的循环） |
| 退化重复 | 尾部 240 字符只有 ≤6 种相邻字对 | 直接命中（"wait wait wait…"、标点刷屏） |

节奏：每新增约 150 字符扫描一次，累计 500 字符后才开始判定 —— 模型中途重复过又
正常往下走的内容不会被误伤。

**命中后**（默认，可在面板关闭）分两步：

1. **分支重跑** —— 复用 retry 插件的宿主机制：先取消正在循环的这一轮（界面停止
   按钮同路径），`sessionController.fork` 切到本轮之前建出新分支，把这一轮的
   **用户原文**重新发出去；浏览器半边轮询到新分支后 `sessions.refresh() + open()`
   自动跳转过去。循环的那次留在父会话，新分支从头生成。思考缓冲保持约 150 字符
   观察窗，中断时保留下来的部分思考不含重复尾巴。重跑链深度记账（
   `DSH_LOOP_GUARD_MAX_RETRY`，默认 1），新分支里再循环不再分支。
2. **再命中才中断** —— `agent.cancel({kind:'hook'}, {keepInbox:true})`，与用户点
   停止同一条路：部分思考以 interrupted 标记保留，排队消息不丢。找不到 Agent 时
   兜底为提前收流。

分支重跑的代价：新分支把完整上下文重发一次（input token 翻倍）；换来的好处是
走 dsh 原生分支语义 —— 界面认、循环的那次留底可查，而不是流内拼接的「缝合」消息。

**网页半边**（`lib/client.js`）的入口是**输入框底栏里的盾牌图标钮**（发送键左边，
与原生工具钮同款 28px 圆钮）：轮询宿主的 `/api` 接口；点它弹出面板，展示监控状态、
命中记录（时间 / 模型 / 类型 / 动作 / 重复内容采样），并可切换自动中断。动作标签：
分支重跑 / 已中断 / 已截断 / 仅记录 / 预警。图标灰色 = 自动中断关，绿色 = 自动中断开；
流式进行中角标蓝点、有未读命中角标红色数字（点击即已读）。React 重渲染输入框后由
MutationObserver + 轮询自动归位；锚不进底栏时 6 秒后兜底显示右下角悬浮球。
依赖客户端 `sessions` 服务（跳转新分支用），与 retry 相同。**跳转入口从 0.1.7 起
换了名字**（`sessions.open` 没了，改用 `uiWorkspace.openSession`），所以浏览器半边
从 v1.2.2 起两个都试：优先 `uiWorkspace.openSession`，退回 `sessions.open` ——
用老写法在 0.1.7 上是「分支建好了但界面不跳」，不报错。

**v1.2.3 修掉一个启动即崩**：`uiWorkspace` 不在 `inject` 里（它可能比本插件晚挂上，
写进 inject 会让守卫一直 pending），而 cordis 的 `ctx.uiWorkspace` 属性访问在服务
还没就绪时会**抛** `cannot get property "uiWorkspace" without inject` —— apply 里抛
异常 = 条目 failed，界面直接报 `dsh-loop-guard: failed`。改用 `optionalService()`
（`ctx.get(id)` 拿不到给 undefined）取它。规则见根 README「浏览器半边取服务的规矩」。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-loop-guard.state` | 只读状态：`{ok, autoInterrupt, activeStreams, seen, detections[], pendingChild}` |
| POST | `/api/dsh-loop-guard.mode` | `{value:boolean}` 切自动中断，返回同 state |
| POST | `/api/dsh-loop-guard.opened` | `{childId}` 浏览器已跳转到新分支，清掉待跳转标记 |

## 边界与已知行为

- 压缩（compaction）/ 会话标题等辅助调用不参与监控（`options.purpose` 过滤）。
- 检测状态与命中记录在**内存**里，dsh 重启后清零（需要落盘再说）。
- 命中/预警同时打宿主日志（`[dsh-loop-guard]` 前缀），`DSH_LOOP_GUARD_QUIET=1` 可关。
- 面板每 2.5s 轮询一次；模型内容全部经 `textContent` 渲染，不走 innerHTML。
- `DSH_LOOP_GUARD_MAX_RETRY=1`：重跑链最多分支几次（0=命中即中断，上限 3）。

## 文件

- `manifest.json` —— 插件清单（dsh-ui 插件管理器读）
- `cordis.patch.yml` —— 补丁片段：把宿主半边插进 profile 插件树
- `loop_guard.mjs` —— 宿主半边（检测 + 中断 + /api）
- `lib/client.js` —— 网页半边（输入框盾牌钮 + 弹出面板）
- `package.json` —— `dsh.client` 声明让 client-modules 自动发现网页半边
