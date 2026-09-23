# dist/plugins/usage — Token 用量统计

订阅 dsh 的 `session/event`，把模型返回的 usage 按「天 × 模型」记账，
并在 Web 界面的**左下角、设置按钮上方**给一个入口：点开是堆叠柱状图，
横轴固定最近 15 天（刻度只写「日」），一天一根柱子、每个模型一个颜色；
鼠标移到色块上提示模型 + 颜色 + **当日占比** + 用量。没有用量的那天留一条占位短横。

这个目录是 **dsh-ui 的插件包**：exe 同目录的 `plugins/` 下每个子目录是一个插件，
dsh-ui 启动时会把「已启用」的插件镜像到 dsh 自己的插件目录并刷新 profile 补丁。

```
dist/plugins/usage/
├── manifest.json        # 插件元数据（dsh-ui 读它）
├── cordis.patch.yml     # 合进 <profile>/cordis.patch.yml 的补丁片段（只插 host 半边）
├── package.json         # 声明 dsh.client，让 client-modules 自动发现浏览器半边
├── usage.mjs            # host 半边：采集 + 读取接口
└── lib/client.js        # 浏览器半边：入口 + 面板 + 柱状图
```

**账本不在上面这个目录里。** 它放在**应用数据根**下：

```
%LOCALAPPDATA%\DeepSeekHarness\data\usage.json
```

和外壳自己的 `config.json` / `plugins.json` 同一处。放这儿是因为插件包是「源目录 →
`<DSH_HOME>/profiles/<profile>/plugins/<id>/`」**整目录重抄**的镜像：账本放包里面，
一是插件一改就被连坐删掉重建，二是源码树那份和镜像那份天然变成两个副本、谁是最新的
说不清。挪出来以后全局只有一份，插件包怎么同步都碰不到它。

（`dist/plugins/usage/data/` 如果还在，那是 1.0.x 时代写在插件目录里的旧账本残留，
已经搬到上面那个路径，**别再往里写**；外壳的同步会忽略插件包根下的 `data/`，
既不复制也不参与「源变没变」的指纹。）

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

`%LOCALAPPDATA%\DeepSeekHarness\data\usage.json`：

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
`usageTokens()` 一致。

界面上的用量单位**自动进位**：不到 1 亿走「万」（除以 10000），到 1 亿走「亿」
（除以 1e8）。判定按四舍五入后的值来（阈值 `9999.5 万`），免得写出「10000.0 万」。
单位是**按单个数值各选各的**，不做全局面板统一 —— 一个模型 1.2 亿、另一个 3000 万时，
各显示各的读起来更顺；硬统一会冒出「0.30 亿」这种数字。

**柱状图固定 15 天，柱子不撑满。** 横轴永远是「今天往前 15 天」，日期由客户端自己按日
推出来（不是拿账本里「有记录的天」铺）—— 中间某天完全没用过模型时账本里根本没有那一天，
按天铺会错位、也看不出空档；现在那天只画一条浅色占位短横，日期照常标注。每根柱子最宽
20px 且居中排（`flex:1 1 0; max-width:20px`），面板宽度跟着收到 460px —— 宁可留白，
不为了填满把柱子拉粗。配色走**柔和浅色系**（天蓝 / 浅绿 / 杏黄 / 薰衣草 …，见
`PALETTE`）：一天一根挨着排，饱和深色堆一片会闷；相邻两位刻意错开色相，叠在一起分得开。

**横轴刻度只写「日」，不写月份。** 列宽只有 20px，10px 字号下「09-15」有 25px 宽，
会被 `overflow:hidden` 裁掉半截（这是实际踩过的）；只留 `date.slice(8)` 就装得下，
完整日期在 `title` 和 hover 气包里都有。

**气包里的占比是「当天占比」，图例那行是全期占比。** 柱子本来就是「一天一根」，
看的是那天各模型怎么分的，分母只能是那天的合计；拿全期总量当分母会把日内差异压成
零点几个百分点（实测同一天：当日 13.7% vs 全期 1.88%）。所以图例是全天候排行口径、
气包是日内口径，两处刻意不一样。

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
挂到 body，因为侧边栏有 overflow 和 transform 动画，留在原位会被裁掉。**面板背景必须配 `backdrop-filter`（dsh 0.1.7 起）。** `--dsw-specific-menu` 从
不透明色变成了半透明色，只留 background 会变成「透明白」（看见底下的对话）。
见根 README「浮层样式」一节。**柱状图的气泡（`.dshu-tip`）也挂在 body**：它是
`position: fixed` 且坐标来自 `getBoundingClientRect()`（视口系），而带
`backdrop-filter` 的面板会成为 fixed 后代的**包含块** —— 留在面板里会被面板的
padding 原点偏移、还会被 `overflow:auto` 裁掉。

**读取接口不需要注入 webServer。** `ctx.connection.fetch.register` 会把路由登记到
connection 自己挂在 `/api` 前缀上的共享 Fetch 处理器里，Host/Origin 围栏和浏览器
cookie 鉴权都由它处理，所以浏览器里直接同源 `fetch('/api/usage.data')` 就行
（实测：带 cookie 200，不带 401）。

**界面每次读都先回读账本文件。** 内存里的账本只在进程启动时读过一次文件，而同一个
`data/usage.json` 可能被别的进程写（同时开着别的 profile、进程被强杀后重启、插件热重载、
或者你手改过）—— 所以 `payload()` 每次都先 `reload()`，「刷新」和 5 秒轮询才真是刷新。
判定「被别人动过」看 mtime（我们每次读/写都记下当时的 mtime），比比 `updatedAt` 可靠。
两个例外不覆盖内存：**有未落盘的增量**（`dirty`）时跳过，**文件不在/读坏**时也不动
（那会儿 `readState` 给的是空账本，不能拿它抹掉内存里的账）。

**任何异常都吞掉。** 插件崩了不能连带 dsh 起不来，所有入口都是 try/catch。

## 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_UI_DATA_DIR=<目录>` | 应用数据根（外壳启动 dsh 时注入，账本落在它的 `data/` 下） |
| `DSH_USAGE_DATA=<路径>` | 直接指定账本文件，优先级最高（自测指到临时目录用） |
| `DSH_USAGE_QUIET=1` | 不打启动横幅 |

没经过外壳、手工跑 `dsh web` 时 `DSH_UI_DATA_DIR` 是空的，插件按同样的约定自己算
（`%LOCALAPPDATA%\DeepSeekHarness`）—— 不能因为启动方式不同就让账本落到两个地方。

## 自测

host 半边可以喂个假 ctx 直接驱动，**不用起 dsh、不花 token**：收下
`connection.fetch.register` 给的路由和 `session/event` 的监听器，喂合成事件，
再通过路由取一次 payload —— 采集口径、去重、回读同步都能这么验。

**真实事件形状**用 headless profile 跑一轮真对话验证（最省事，一条命令跑完即退）：

```bash
# 把插件暂存进 headless profile，patch 写 insert，然后：
node <dsh>/lib/bin.js --profile headless "只回答两个字：收到。不要调用任何工具。"
# 看 %LOCALAPPDATA%\DeepSeekHarness\data\usage.json 是否出现 tokens / 模型名 / 当天日期
```

**别让自测污染真账本**：headless 跑真对话时把 `DSH_USAGE_DATA` 指到临时文件，
否则测试用量会记进你日常那份账本里。

Web 那一侧的接点（横幅、启动图里的 `dsh-usage` 行、bundle 可取、`/api/usage.data`
的 200/401）用 `src/tools/probe_plugins.py` 配合一个临时探针核对。
