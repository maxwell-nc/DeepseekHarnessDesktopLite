# dist/plugins/usage — Token 用量统计

订阅 dsh 的 `session/event`，把模型返回的 usage 按「天 × 模型」记账，
并在 Web 界面的**左下角、设置按钮上方**给一个入口：点开是堆叠柱状图，
一天一根柱子、每个模型一个颜色，鼠标移到色块上提示模型 + 颜色 + 占比 + 用量。

这个目录是 **dsh-ui 的插件包**：exe 同目录的 `plugins/` 下每个子目录是一个插件，
dsh-ui 启动时会把「已启用」的插件镜像到 dsh 自己的插件目录并刷新 profile 补丁。

```
dist/plugins/usage/
├── manifest.json        # 插件元数据（dsh-ui 读它）
├── cordis.patch.yml     # 合进 <profile>/cordis.patch.yml 的补丁片段（只插 host 半边）
├── package.json         # 声明 dsh.client，让 client-modules 自动发现浏览器半边
├── usage.mjs            # host 半边：采集 + 读取接口
├── lib/client.js        # 浏览器半边：入口 + 面板 + 柱状图
└── data/usage.json      # 账本（运行时生成，不进版本库）
```

## 装法

不是手工装的 —— 托盘菜单 →「插件管理器」，绿灯是启用，点「重启服务并生效」。
dsh-ui 会把本目录镜像到 `%USERPROFILE%\.dsh\profiles\web\plugins\usage\`，
并把 `cordis.patch.yml` 的托管块写成：

```yaml
- insert:
    - id: dsh-usage
      name: ./plugins/usage/usage.mjs
```

关掉插件时，安装副本和这几行补丁会被一起撤掉，`cordis.patch.yml` 回到 `[]`。

## 账本长什么样

```json
{
  "version": 1,
  "updatedAt": "2026-09-19T02:20:06.312Z",
  "days": {
    "2026-09-19": {
      "models": {
        "deepseek-chat": { "tokens": 2220, "input": 1900, "output": 320,
                           "cacheRead": 0, "cacheWrite": 0, "calls": 3 }
      }
    }
  }
}
```

`tokens = input + cacheRead + cacheWrite + output`，四个桶互不重叠
（reasoning 已含在 output 里）—— 和上游 `@deepseek-ai/dsh-token-meter` 的
`usageTokens()` 一致。界面上一律按 **万 token**（除以 10000）显示。

## 几个刻意的设计（都是坑，别随手改）

**按 (turn, step) 做「覆盖」而不是「累加」。** 同一步里 `assistant/message` 可能带
同一份 usage 反复结算（重试、流式收敛），直接累加会成倍虚高。做法是记住 last 样本、
新增量 = 新值 − 旧值（上游 `tokenUsageProjection` 同款）；`llm/retry-started` 时清空
last，因为重试是**新**的一次调用，要重新计。

**模型名只来自 `request/header` 的 `header.config.model`。** 所以每个会话要维护
「当前模型」；会话第一次被看到时把它已有的日志回放一遍补模型名（**只读 header、
不计 usage**），否则第一轮会掉进「未知模型」。

**第一次看到某会话时从 `session.seq` 起算，绝不回填历史。** 只统计「插件在场时
新发生的调用」，这样重启进程、插件热重载、会话 fork 都不会重复计数。回填历史必须
自存每会话水位表，水位一丢就双计，代价大于收益。

**`connection` 用 `ctx.inject` 按需绑定，不写进静态 `inject`。** 静态 inject 是
「全部就绪才激活」，而 `connection` 只有 web profile 提供。写进去的话插件在
headless / tui profile 里会**永远停在 pending**，连采集都不跑；而采集本来只依赖
`session/event`（dsh-base 自带 `dsh-session`），不该被传输层连坐。

**浏览器半边不用写进补丁。** `package.json` 里的 `dsh.client.platform = "web"`
就够了 —— dsh 的 `client-modules` 会自动发现 `lib/client.js` 并拼进启动图。

**入口挂在 `sidebar.footer.action`。** 这个 slot 在 DOM 里排在 `sidebar.settings`
**之前**，而侧边栏底栏是 flex-column，所以天然就在设置按钮上方；展开时是整行，
收起成轨道时只剩图标（`wide` 由 shell 传进来）。面板用 `createPortal` + `position: fixed`
挂到 body，因为侧边栏有 overflow 和 transform 动画，留在原位会被裁掉。

**读取接口不需要注入 webServer。** `ctx.connection.fetch.register` 会把路由登记到
connection 自己挂在 `/api` 前缀上的共享 Fetch 处理器里，Host/Origin 围栏和浏览器
cookie 鉴权都由它处理，所以浏览器里直接同源 `fetch('/api/usage.data')` 就行
（实测：带 cookie 200，不带 401）。

**任何异常都吞掉。** 插件崩了不能连带 dsh 起不来，所有入口都是 try/catch。

## 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_USAGE_DATA=<路径>` | 把账本换个地方（默认 `<插件目录>/data/usage.json`） |
| `DSH_USAGE_QUIET=1` | 不打启动横幅 |

## 自测

采集逻辑可以脱开 dsh 单测；**真实事件形状**用 headless profile 跑一轮真对话验证
（最省事，一条命令跑完即退）：

```bash
# 把插件暂存进 headless profile，patch 写 insert，然后：
node <dsh>/lib/bin.js --profile headless "只回答两个字：收到。不要调用任何工具。"
# 看 <profile>/plugins/usage/data/usage.json 是否出现 tokens / 模型名 / 当天日期
```

Web 那一侧的接点（横幅、启动图里的 `dsh-usage` 行、bundle 可取、`/api/usage.data`
的 200/401）用 `src/tools/probe_plugins.py` 配合一个临时探针核对。
