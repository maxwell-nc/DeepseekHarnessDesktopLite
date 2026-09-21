# 思考循环守卫（thinking_loop_guard）

实时检测模型**思考内容死循环**的 dsh 插件。部分模型思考（reasoning）时同一段内容
反复刷、一直烧到 max_tokens 才停 —— 本插件在循环早期就把这一轮掐掉，保住时间和
token；已生成的部分思考以 interrupted 标记保留。

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

**命中后**（默认，可在面板关闭）：`agent.cancel({kind:'hook'}, {keepInbox:true})`
—— 与用户点停止同一条路，排队消息不丢。找不到 Agent 时兜底为提前收流。

**网页半边**（`lib/client.js`）的入口是**输入框底栏里的盾牌图标钮**（发送键左边，
与原生工具钮同款 28px 圆钮）：轮询宿主的 `/api` 接口；点它弹出面板，展示监控状态、
命中记录（时间 / 模型 / 类型 / 重复内容采样），并可切换自动中断。图标灰色 = 自动
中断关，绿色 = 自动中断开；流式进行中角标蓝点、有命中记录角标红色数字。React 重
渲染输入框后由 MutationObserver + 轮询自动归位；锚不进底栏时 6 秒后兜底显示右下
角悬浮球。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-loop-guard.state` | 只读状态：`{ok, autoInterrupt, activeStreams, seen, detections[]}` |
| POST | `/api/dsh-loop-guard.mode` | `{value:boolean}` 切自动中断，返回同 state |

## 边界与已知行为

- 压缩（compaction）/ 会话标题等辅助调用不参与监控（`options.purpose` 过滤）。
- 检测状态与命中记录在**内存**里，dsh 重启后清零（需要落盘再说）。
- 命中/预警同时打宿主日志（`[dsh-loop-guard]` 前缀），`DSH_LOOP_GUARD_QUIET=1` 可关。
- 面板每 2.5s 轮询一次；模型内容全部经 `textContent` 渲染，不走 innerHTML。

## 文件

- `manifest.json` —— 插件清单（dsh-ui 插件管理器读）
- `cordis.patch.yml` —— 补丁片段：把宿主半边插进 profile 插件树
- `loop_guard.mjs` —— 宿主半边（检测 + 中断 + /api）
- `lib/client.js` —— 网页半边（输入框盾牌钮 + 弹出面板）
- `package.json` —— `dsh.client` 声明让 client-modules 自动发现网页半边
