/**
 * dsh-usage —— token 用量统计插件
 * ================================
 *
 * 干两件事：
 *
 * 1. **采集**：订阅 `session/event`，从会话事件里读模型返回的 usage
 *    （`assistant/message` / `assistant/attempt` 上的 `usage` 字段，或该次结算
 *    stream 里最后一个 `usage` chunk），按「天 × 模型」累计**总 token**，
 *    落到账本文件（默认 `<应用数据根>/data/usage.json`，见 dataFilePath()）。
 *
 * 2. **展示**：注册一条鉴权过的 HTTP 读取接口 `/api/usage.data`，浏览器那半边
 *    （lib/client.js）在左下角设置按钮上方渲染入口 + 堆叠柱状图。
 *
 * 两件事的依赖是**分开**的：采集只要 `session`（dsh-base 里就有），读取接口才需要
 * `connection`（只有 web profile 提供）。所以 `connection` 用 `ctx.inject` 按需绑定，
 * 而不是写在静态 `inject` 里 —— 否则在 headless / tui profile 里插件会一直挂着不激活，
 * 一个 token 都记不到。见 `apply()` 里的说明。
 *
 * ---------------------------------------------------------------------------
 * 关键约定（都是踩过的坑，别随手改）
 *
 * **总 token 的定义**跟上游 `@deepseek-ai/dsh-token-meter` 的 `usageTokens()` 对齐：
 *     inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens
 * 四个桶互不重叠（reasoning 已含在 outputTokens 里），相加不会重复计。
 *
 * **必须按 (turn, step) 做「覆盖」而不是「累加」**：同一步里 `assistant/message`
 * 可能带同一份 usage 反复结算（重试、流式收敛），直接累加会成倍虚高。上游
 * tokenUsageProjection 的做法是记住 last 样本，新增量 = 新值 - 旧值；这里照抄，
 * 并用 `llm/retry-started` 清空 last（重试后是**新**的一次调用，要重新计）。
 *
 * **模型名来自 `request/header` 的 `header.config.model`**，事件里没有别的来源。
 * 所以每个会话都要维护「当前模型」——新会话第一次被看到时，要把它已有的日志
 * 回放一遍（只读 header，**不计 usage**），否则第一轮对话会掉进「未知模型」。
 *
 * **第一次看到某会话时从 `session.seq` 起算**：也就是只统计「本插件在场时新发生
 * 的调用」，绝不回填历史。这样重启进程、插件热重载、会话 fork 都不会重复计数
 * ——回填历史必须自己存每会话水位表，一旦水位丢了就会双计，代价比收益大。
 *
 * **界面每次读取（刷新 / 轮询）都先回读数据文件**：内存账本只在进程启动时读过一次
 * 文件，别的进程、上一次运行、或者手工改过的内容得靠 `reload()` 同步进来 ——
 * 否则「刷新」永远只刷内存里那份旧的。详见 `reload()`。
 *
 * **任何异常都吞掉**：插件崩了不能连带 dsh 起不来，所有入口都是 try/catch。
 *
 * **账本不放在插件目录里**：插件包是被外壳「整目录重抄」到
 * `<DSH_HOME>/profiles/<profile>/plugins/<id>/` 的，账本放里面有两个后果 ——
 * 插件包一改就被连带删掉重建；源码树那份和镜像那份又会变成两个副本，谁是最新的
 * 说不清。所以放到外壳自己的运行数据根（`%LOCALAPPDATA%\DeepSeekHarness`，
 * 和它的 config.json / plugins.json 同处），全局只有一份。见 dataFilePath()。
 *
 * 环境变量：
 *   DSH_UI_DATA_DIR=<目录>  外壳传给子进程的运行数据根（优先，见 dataFilePath）
 *   DSH_USAGE_DATA=<路径>   直接指定账本文件（自测指向临时目录用，优先级最高）
 *   DSH_USAGE_QUIET=1       不打启动横幅
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 稳定的 cordis 插件名。 */
export const name = 'usage'

const TAG = '[dsh-usage]'

/** 关掉启动横幅（`DSH_USAGE_QUIET=1`）。 */
const QUIET = (process.env.DSH_USAGE_QUIET ?? '') === '1'

/**
 * 外壳（dsh-ui）的运行数据根。
 *
 * 正常由外壳通过 `DSH_UI_DATA_DIR` 传进来。手工直接跑 `dsh web`（没经过外壳）
 * 时按同样的约定自己算 —— 不能因为启动方式不同就让账本落到两个地方去。
 */
function appDataRoot() {
  const given = (process.env.DSH_UI_DATA_DIR ?? '').trim()
  if (given.length > 0) return given
  const base = (process.env.LOCALAPPDATA ?? '').trim() || homedir()
  return join(base, 'DeepSeekHarness')
}

/**
 * 账本文件位置：`<应用数据根>/data/usage.json`（默认
 * `%LOCALAPPDATA%\DeepSeekHarness\data\usage.json`）。
 *
 * **为什么不放插件目录**：插件包是「源目录 → <profile>/plugins/<id>/」整目录重抄
 * 的镜像，账本放里面等于把自己放进一个随时被删掉重建的目录里，而且源码树那份和
 * 镜像那份天然变成两个副本。放到外壳自己的数据根就只有一份，插件包怎么同步都不
 * 影响它。`DSH_USAGE_DATA` 用来直接指定文件（自测指向临时目录）。
 */
function dataFilePath() {
  const explicit = (process.env.DSH_USAGE_DATA ?? '').trim()
  if (explicit.length > 0) return explicit
  return join(appDataRoot(), 'data', 'usage.json')
}

/** 浏览器读取入口。走 connection 的鉴权通道，页面里同源 fetch 即可。 */
const API_PATH = '/api/usage.data'

/** 落盘去抖：连续事件合并成一次写，进程被强杀最多丢这么久的数据。 */
const FLUSH_DELAY_MS = 800

/** 数据文件里最多保留多少天（按日期键裁剪，天数是全局的，不分模型）。 */
const KEEP_DAYS = 120

/** 客户端一次最多画多少天。 */
const KEEP_DAYS_FOR_CLIENT = 30

/** 模型名读不出来时的占位，客户端按普通模型名处理。 */
const UNKNOWN_MODEL = '未知模型'

/* -------------------------------------------------------------------------- */
/* 纯函数：时间、桶、事件取值                                                    */
/* -------------------------------------------------------------------------- */

/** 本地日期键 `YYYY-MM-DD`（按用户所在时区切天，不用 UTC）。 */
function dayKey(now) {
  const d = now ?? new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** 一份 usage 是不是可用的样本：input / output 两个必填字段都得是有限数。 */
function isUsage(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    Number.isFinite(value.inputTokens) &&
    Number.isFinite(value.outputTokens)
  )
}

/** usage -> 四个互不重叠的桶 + 总 token。 */
function bucketsOf(usage) {
  const input = num(usage.inputTokens)
  const output = num(usage.outputTokens)
  const cacheRead = num(usage.cacheReadTokens)
  const cacheWrite = num(usage.cacheWriteTokens)
  return { tokens: input + cacheRead + cacheWrite + output, input, output, cacheRead, cacheWrite }
}

const zeroBuckets = () => ({ tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

function bucketsEqual(a, b) {
  return (
    a.tokens === b.tokens &&
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite
  )
}

/**
 * 从一次 Assistant 结算里取 usage 样本。
 *
 * `assistant/message` 上直接挂着 `usage`；没有的话（更早的格式、或者
 * `assistant/attempt`）去它自己的 stream 里倒着找最后一个 `usage` chunk ——
 * 等价于上游 `lastAssistantStreamChunk(stream, 'usage')`，只是不需要 import
 * dsh-llm（事件数据是 JSON，stream 一定是数组，扫一次很便宜）。
 */
function usageOf(event) {
  const data = event?.data
  if (data === null || typeof data !== 'object') return undefined
  if (event.type === 'assistant/message' && isUsage(data.usage)) return data.usage
  const stream = data.stream
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage' && isUsage(record.chunk.usage)) {
      return record.chunk.usage
    }
  }
  return undefined
}

/** 从 `request/header` 里读模型名。读不出来返回空串。 */
function modelOf(event) {
  const config = event?.data?.header?.config
  if (config === null || typeof config !== 'object') return ''
  const model = typeof config.model === 'string' ? config.model.trim() : ''
  if (model.length > 0) return model
  const provider = typeof config.provider === 'string' ? config.provider.trim() : ''
  return provider.length > 0 ? `${provider} / 默认模型` : ''
}

/* -------------------------------------------------------------------------- */
/* 数据文件                                                                     */
/* -------------------------------------------------------------------------- */

const EMPTY_STATE = () => ({ version: 1, updatedAt: '', days: {} })

function readState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && parsed.days !== null && typeof parsed.days === 'object') {
      return { version: 1, updatedAt: String(parsed.updatedAt ?? ''), days: parsed.days }
    }
  } catch {
    // 文件不存在 / 坏了都当空账本，重来即可（这里不打印，免得每次启动刷日志）
  }
  return EMPTY_STATE()
}

/** 先写临时文件再 rename —— 断电/强杀不会留下半截 JSON。 */
function writeState(path, state) {
  const tmp = `${path}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tmp, path)
}

/** 文件最后修改时间（毫秒）；不存在 / 读不到返回 0。 */
function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** 按日期键裁掉过老的天，防止文件无限长。 */
function prune(state, today) {
  const keys = Object.keys(state.days)
  if (keys.length <= KEEP_DAYS) return
  const floor = new Date(`${today}T00:00:00`)
  floor.setDate(floor.getDate() - KEEP_DAYS)
  const floorKey = dayKey(floor)
  for (const key of keys) if (key < floorKey) delete state.days[key]
}

/* -------------------------------------------------------------------------- */
/* 采集器                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 一个采集器实例：会话水位表 + 待落盘状态 + 去抖定时器。
 *
 * `marks` 是 WeakMap（会话对象 → 已消费到的事件数），`slots` 放每个会话的
 * 「当前模型」和「上一条 usage 样本」。
 */
function createCollector(path) {
  let state = readState(path)
  /** 我们上一次读/写这个文件时它的 mtime —— 用来判断文件有没有被别人动过。 */
  let seenMtime = mtimeOf(path)
  const marks = new WeakMap()
  const slots = new WeakMap()
  let timer
  let dirty = false

  function slotOf(session) {
    let slot = slots.get(session)
    if (slot === undefined) {
      slot = { model: '', last: undefined }
      slots.set(session, slot)
    }
    return slot
  }

  function addToDay(day, model, buckets) {
    const row = (state.days[day] ??= { models: {} })
    const bucket = (row.models[model] ??= { ...zeroBuckets(), calls: 0 })
    bucket.tokens += buckets.tokens
    bucket.input += buckets.input
    bucket.output += buckets.output
    bucket.cacheRead += buckets.cacheRead
    bucket.cacheWrite += buckets.cacheWrite
  }

  /**
   * 折一个事件。
   * @param countUsage - false 表示这次只是回放旧日志补「当前模型」，不要计用量。
   * @returns 账本是否变化。
   */
  function fold(session, event, countUsage) {
    if (event === null || typeof event !== 'object') return false
    const slot = slotOf(session)

    if (event.type === 'request/header') {
      const model = modelOf(event)
      if (model.length > 0) slot.model = model
      return false
    }

    // 重试 = 同一 (turn, step) 的**新**一次调用，丢掉旧样本让下次重新计
    if (event.type === 'llm/retry-started') {
      slot.last = undefined
      return false
    }

    if (!countUsage) return false
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return false

    const usage = usageOf(event)
    if (usage === undefined) return false

    const data = event.data
    const turn = num(data?.turn)
    const step = num(data?.step)
    const model = slot.model.length > 0 ? slot.model : UNKNOWN_MODEL
    const buckets = bucketsOf(usage)
    const day = dayKey()

    const previous = slot.last !== undefined && slot.last.turn === turn && slot.last.step === step ? slot.last : undefined
    if (previous !== undefined && previous.model === model && previous.day === day && bucketsEqual(previous.buckets, buckets)) {
      return false
    }

    if (previous !== undefined) {
      // 覆盖语义：先把上一次记的减掉，再把这次完整记上。跨天/换模型的边界情况
      // 也靠这一手兜住（减法落在旧样本自己的那一天/那个模型上）。
      addToDay(previous.day, previous.model, {
        tokens: -previous.buckets.tokens,
        input: -previous.buckets.input,
        output: -previous.buckets.output,
        cacheRead: -previous.buckets.cacheRead,
        cacheWrite: -previous.buckets.cacheWrite
      })
    }

    addToDay(day, model, buckets)
    if (previous === undefined || previous.model !== model) {
      state.days[day].models[model].calls += 1
      prune(state, day)
    }

    slot.last = { turn, step, model, day, buckets }
    return true
  }

  /**
   * 会话第一次被看到：回放已有日志，只补「当前模型」，**不计用量**。
   *
   * 为什么非要这一趟：模型名只出现在 `request/header` 里，而请求头事件在一轮
   * 对话的最开头。不回放的话，插件刚起来/刚打开一个老会话时，那一轮的 usage
   * 就会被记成「未知模型」。只读 header 事件，几千条日志也就几毫秒。
   */
  function warmUp(session, total) {
    for (let seq = 0; seq < total; seq += 1) {
      let event
      try {
        event = session.eventAt(seq)
      } catch {
        break
      }
      if (event === undefined || event === null) break
      fold(session, event, false)
    }
  }

  /** 消费一个会话的增量事件。 */
  function track(session) {
    if (session === null || typeof session !== 'object') return
    if (typeof session.eventAt !== 'function') return
    const total = Number(session.seq)
    if (!Number.isFinite(total) || total < 0) return

    let seen = marks.get(session)
    if (seen === undefined) {
      // 第一次见到：只统计「从现在起」的新事件，历史不回填（见文件头说明）
      marks.set(session, total)
      warmUp(session, total)
      return
    }
    if (seen >= total) return

    let changed = false
    for (let seq = seen; seq < total; seq += 1) {
      let event
      try {
        event = session.eventAt(seq)
      } catch {
        break
      }
      if (event === undefined || event === null) break
      if (fold(session, event, true)) changed = true
    }
    marks.set(session, total)
    if (changed) {
      state.updatedAt = new Date().toISOString()
      schedule()
    }
  }

  function schedule() {
    dirty = true
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      flush()
    }, FLUSH_DELAY_MS)
  }

  function flush() {
    if (!dirty) return
    dirty = false
    try {
      writeState(path, state)
      seenMtime = mtimeOf(path) // 这一笔是自己写的，别当成「被别人动过」
    } catch (error) {
      console.error(`${TAG} 写数据文件失败：${String(error?.message ?? error)}`)
    }
  }

  function dispose() {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    flush()
  }

  /**
   * 回读数据文件，把**磁盘上的账本**同步进内存。
   *
   * 为什么需要：内存里的账本只在「本次进程启动」时读过一次文件。同一个
   * `data/usage.json` 被别的进程写过时（同时开着别的 profile、进程被强杀后重启、
   * 插件热重载、或者你自己手改过），内存就是旧的了 —— 界面每次读都先过这一手，
   * 「刷新」才真的是刷新。
   *
   * 判定「有没有被别人动过」只看 mtime（我们每次读/写都记下当时的 mtime），
   * 比拿 updatedAt 比内容可靠：别处写进来但内容恰好一样时也算动过，回读一次无害。
   *
   * 两个不覆盖内存的例外：
   *   - 内存里还有**没落盘的增量**（dirty）时跳过：那会儿回读会把它冲掉，
   *     新鲜度不值得拿数据换（等 800ms 落盘后下一次读自然就同步了）。
   *   - 文件不在 / 读坏时不动内存：`readState` 那会儿给的是空账本，
   *     不能拿它抹掉内存里的账。
   *
   * @returns 是否真的换成了磁盘上的状态。
   */
  function reload() {
    if (dirty) return false
    const mtime = mtimeOf(path)
    if (mtime === 0 || mtime === seenMtime) return false
    const disk = readState(path)
    if (Object.keys(disk.days).length === 0 && Object.keys(state.days).length > 0) return false
    state = disk
    seenMtime = mtime
    return true
  }

  /** 数据文件自身的信息，给界面脚注显示（文件还没落盘时也给路径，只是没时间/大小）。 */
  function fileInfo() {
    try {
      const stat = statSync(path)
      return { path, mtime: stat.mtime.toISOString(), size: stat.size }
    } catch {
      return { path, mtime: '', size: 0 }
    }
  }

  /**
   * 给浏览器用的视图：最近 KEEP_DAYS_FOR_CLIENT 天 + 全期模型排行。
   * 颜色不上这里定 —— 由客户端按 models 顺序分配，柱子和图例自然一致。
   *
   * 每次调用都先 `reload()` 一次：界面上的「刷新」和 5 秒轮询都打到这儿，
   * 所以拿到的永远是磁盘上最新的账本（见 reload 的说明）。
   */
  function payload(now) {
    reload()
    const keys = Object.keys(state.days).sort()
    const recent = keys.slice(-KEEP_DAYS_FOR_CLIENT)
    const days = []
    const totals = new Map()
    for (const date of recent) {
      const models = state.days[date]?.models ?? {}
      const row = { date, total: 0, models: {} }
      for (const model of Object.keys(models)) {
        const bucket = models[model]
        if (bucket === null || typeof bucket !== 'object') continue
        const tokens = num(bucket.tokens)
        if (tokens <= 0) continue
        row.models[model] = {
          tokens,
          input: num(bucket.input),
          output: num(bucket.output),
          cacheRead: num(bucket.cacheRead),
          cacheWrite: num(bucket.cacheWrite),
          calls: num(bucket.calls)
        }
        row.total += tokens
        totals.set(model, (totals.get(model) ?? 0) + tokens)
      }
      days.push(row)
    }
    const models = [...totals.entries()]
      .filter(([, tokens]) => tokens > 0)
      .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
      .map(([id, tokens]) => ({ id, tokens }))
    return {
      today: dayKey(now),
      updatedAt: state.updatedAt,
      file: fileInfo(),
      total: models.reduce((sum, model) => sum + model.tokens, 0),
      models,
      days
    }
  }

  return { track, payload, flush, dispose }
}

/* -------------------------------------------------------------------------- */
/* 插件入口                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 非有它不可的服务：`session/event` 是 `dsh-session` 发的，而 `dsh-session` 由
 * `dsh-base` 提供 —— 每个 profile（web / headless / tui）都有，声明它不会挂死。
 *
 * `connection` **故意不在这里**，见 `apply()`。
 */
export const inject = ['session']

/** 模块级标记：进程退出钩子只装一次（插件热重载会反复 apply）。 */
let EXIT_HOOKED = false

/**
 * 挂上采集器和读取接口。
 *
 * **为什么静态 `inject` 里没有 `connection`**：静态 inject 是「全部就绪才激活」的
 * 语义，`connection` 只由 web profile 的 `@deepseek-ai/dsh-client-connection` 提供。
 * 写进去的话，插件在 headless / tui profile 里会**永远停在 pending**，连采集都不跑。
 * 采集本来只依赖 `session/event`（dsh-base 自带 `dsh-session`），不该被传输层连坐。
 * 所以改成 `ctx.inject(['connection'], ...)` 起一个子插件：有 connection 就多一条
 * HTTP 出口，没有就纯记账。
 *
 * 读取接口**不需要**注入 webServer：`ctx.connection.fetch.register` 会把路由登记到
 * connection 自己挂在 `/api` 前缀上的共享 Fetch 处理器里，而它已经处理了
 * Host/Origin 围栏 + 浏览器 cookie 鉴权（所以浏览器里直接同源 fetch 就行）。
 *
 * @param ctx - 宿主侧插件 context。
 */
export function apply(ctx) {
  const path = dataFilePath()
  const collector = createCollector(path)

  ctx.effect(() => collector.dispose(), 'dsh-usage: flush data file')

  // 传输层是可选的：只有 web profile 有 connection，缺了照样记账
  ctx.inject(['connection'], (scoped) => {
    try {
      scoped.connection.fetch.register({
        path: API_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: () =>
          Promise.resolve(
            Response.json(collector.payload(), { headers: { 'cache-control': 'no-store' } })
          )
      })
      if (!QUIET) {
        console.error(`${TAG} 读取接口 = ${API_PATH}；界面入口在左下角设置上方`)
      }
    } catch (error) {
      console.error(`${TAG} 注册 ${API_PATH} 失败：${String(error?.message ?? error)}`)
    }
  })

  ctx.on('session/event', (session) => {
    try {
      collector.track(session)
    } catch (error) {
      console.error(`${TAG} 采集事件失败：${String(error?.message ?? error)}`)
    }
  })

  // 兜底：进程正常退出时把待写内容落盘（被 taskkill /F 时走不到这里，
  // 那就靠 800ms 的去抖，最多丢一秒的数据）
  if (!EXIT_HOOKED) {
    EXIT_HOOKED = true
    process.on('exit', () => {
      try {
        collector.flush()
      } catch {
        // 退出路径上不再抛
      }
    })
  }

  if (!QUIET) {
    console.error(`${TAG} 数据文件 = ${path}`)
  }
}

export default { name, apply }
