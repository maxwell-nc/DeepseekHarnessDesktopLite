/**
 * dsh-loop-guard —— 思考循环守卫（宿主半边）
 * ===========================================
 *
 * 解决的问题：部分模型思考（reasoning）时疯狂循环，同一段内容反复刷，
 * 一直烧到 max_tokens 才停 —— 时间和 token 全浪费，最后还未必有答案。
 *
 * 做法：挂在 `llm/stream` 瀑布上，包裹每一次流式模型调用，对 `reasoning-delta`
 * 增量做三类实时检测（按「新增约 150 字符」的节奏扫描，累计 500 字符后才判定）：
 *
 *   1. 精确重复   —— 流尾部按最小周期逐字重复（单元越长，要求的连续次数越少）
 *   2. 相似回声   —— 相邻等长窗口（420 字符）trigram-Jaccard 连续高相似，
 *                    专抓「内容一样但数字/措辞略有漂移」的循环
 *   3. 退化重复   —— 尾部 240 字符只有 ≤6 种相邻字对（"wait wait wait…"、
 *                    纯标点刷屏这类）
 *
 * 命中后的动作（默认，可在面板切换）：
 *
 *   - **分支重跑**（重跑链第一环）：和 retry 插件同一套宿主机制 —— 先取消正在
 *     循环的这一轮（界面停止按钮同路径），`sessionController.fork` 切到本轮之前
 *     建出新分支，把这一轮的**用户原文**重新发出去。循环的那次留在父会话，新
 *     分支从头生成；浏览器半边轮询到新分支后自动跳转过去。重跑链深度记账，
 *     新分支里再循环就不再分支。
 *   - **中断**（重跑链已到上限）：`agent.cancel({kind:'hook'}, {keepInbox:true})`
 *     —— 与用户点停止同一条路：部分思考以 interrupted 标记保留，排队消息不丢；
 *     找不到 Agent 时兜底为「提前收流」。
 *   - 自动中断关闭：仅记录，流原样直通（零干预）。
 *
 * 思考缓冲保持约 150 字符的观察窗：中断时保留下来的部分思考不含重复尾巴
 * （重复内容不会进入最终消息）。
 *
 * 为什么分支而不是流内拼接续跑：同一份上下文「续」大概率还是循环，retry 的
 * 分支机制是 dsh 原生支持的重跑路径（界面认、历史留底），而且不用碰流拼装的
 * 各种边角。代价是新分支会把完整上下文重发一次（input token 翻倍）。
 *
 * 为什么自动中断默认敢开：判定要求「重复发生在流尾部」——模型中途重复过
 * 又正常往下走的内容不会被误伤；三类阈值都留了余量（见 thresholdFor）。
 *
 * 网页半边（lib/client.js）通过 /api 接口读状态、切开关、领「待跳转的新分支」：
 *
 *   GET  /api/dsh-loop-guard.state    只读：{autoInterrupt, activeStreams, seen, detections, pendingChild}
 *   POST /api/dsh-loop-guard.mode     {value:boolean} 切自动中断，返回同 state
 *   POST /api/dsh-loop-guard.opened   {childId} 浏览器已跳转到新分支，清掉待跳转标记
 *
 * 环境变量：
 *   DSH_LOOP_GUARD_QUIET=1       不打启动/命中日志
 *   DSH_LOOP_GUARD_MAX_RETRY=1   重跑链最多分支几次（0=命中即中断，上限 3）
 *
 * 已知边界：压缩（compaction）/ 会话标题等辅助调用（options.purpose）不参与监控；
 * 检测状态与命中记录都在内存里，重启后清零。
 */

import { randomUUID } from 'node:crypto'

/** 稳定的 cordis 插件名。 */
export const name = 'dsh-loop-guard'

const TAG = '[dsh-loop-guard]'

/** 关掉启动/命中日志。 */
const QUIET = (process.env.DSH_LOOP_GUARD_QUIET ?? '') === '1'

/** 重跑链最多分支几次（0 = 命中即中断）。 */
const MAX_RETRY = normalizeRetry(process.env.DSH_LOOP_GUARD_MAX_RETRY)

function normalizeRetry(raw) {
  const n = parseInt(raw ?? '1', 10)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(n, 3)
}

const STATE_API = '/api/dsh-loop-guard.state'
const MODE_API = '/api/dsh-loop-guard.mode'
const OPENED_API = '/api/dsh-loop-guard.opened'

// ---- 检测配置（进程内，可由面板切换 autoInterrupt）----

const CFG = {
  autoInterrupt: true, // 命中后自动处置（分支重跑 / 中断）
  minChars: 500,       // 思考累计达到该字符数后才开始判定
  scanEvery: 150,      // 每新增约 N 字符扫描一次
  bufKeep: 24000,      // 分析窗口上限（字符）
  win: 420,            // 相似回声窗口长度
  fuzzyJ: 0.86,        // 相似回声 trigram-Jaccard 阈值
  fuzzyWarn: 2,        // 相似回声预警次数
  fuzzyStop: 3,        // 相似回声中断次数
  degenTail: 240,      // 退化检测尾部长度
  degenBigrams: 6      // 退化检测允许的不同相邻字对数
}

// ---- 运行状态（进程内）----

const detections = []
let active = 0
let seen = 0
let seq = 0

/** 会话 id -> 重跑链深度（0 = 不是分支重跑出来的）。 */
const chainDepth = new Map()

/** 待浏览器跳转的新分支（一次一个，新的顶掉旧的）。 */
let pendingChild = null

function newMonitor(meta) {
  return {
    buf: '', total: 0, sinceScan: 0,
    fired: false, action: null, warned: false,
    echoStreak: 0, lastEvalAt: -1,
    pending: [],      // 尚未放行的 reasoning-delta 原始 chunk（缓冲观察区）
    heldLen: 0,       // pending 文本总长
    safeTotal: 0,     // 已扫描且未命中的位置（total 坐标），之前的都可放行
    rIndex: null,     // 当前 reasoning 块的 index
    emitted: new Map(), // index -> 实际放行的 reasoning 文本（block-end 改写用）
    hitDropTail: 0,   // 命中时要丢弃的尾部字符数（按类型）
    meta
  }
}

/** 按循环单元长度分级的命中阈值：单元越短，需要越多连续重复。 */
function thresholdFor(unitLen) {
  if (unitLen < 8) return { copies: 8, span: 120 }
  if (unitLen < 32) return { copies: 6, span: 160 }
  if (unitLen < 120) return { copies: 4, span: 200 }
  return { copies: 3, span: 420 }
}

/** 从缓冲区尾部找最小周期 p（>=4），返回 { unitLen, copies, unit }。 */
function exactRepeat(s) {
  const n = s.length
  if (n < 64) return null
  const maxP = Math.min(2048, Math.floor(n / 3))
  for (let p = 4; p <= maxP; p++) {
    const a = n - 2 * p
    const b = n - p
    let ok = true
    for (let i = 0; i < p; i++) {
      if (s[a + i] !== s[b + i]) { ok = false; break }
    }
    if (!ok) continue
    let copies = 2
    for (;;) {
      const start = n - (copies + 1) * p
      if (start < 0) break
      let match = true
      const base = n - copies * p
      for (let i = 0; i < p; i++) {
        if (s[start + i] !== s[base + i]) { match = false; break }
      }
      if (!match) break
      copies++
    }
    return { unitLen: p, copies: copies, unit: s.slice(n - p, n) }
  }
  return null
}

function trigrams(s) {
  const set = new Set()
  for (let i = 0; i + 3 <= s.length; i++) set.add(s.slice(i, i + 3))
  return set
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  a.forEach(function (t) { if (b.has(t)) inter++ })
  return inter / (a.size + b.size - inter)
}

/** 尾部退化：极短片段反复（如 "wait wait wait…"、纯标点刷屏）。 */
function degenerateTail(s) {
  const n = s.length
  if (n < CFG.degenTail) return null
  const tail = s.slice(-CFG.degenTail)
  const grams = new Set()
  for (let i = 0; i + 2 <= tail.length; i++) grams.add(tail.slice(i, i + 2))
  if (grams.size <= CFG.degenBigrams) return { tail: tail, grams: grams.size }
  return null
}

function clip(text, cap) {
  if (typeof text !== 'string') return ''
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > cap ? t.slice(0, cap) + '…' : t
}

function describe(kind, detail) {
  if (kind === 'exact') return '单元 ' + detail.unitLen + ' 字符连续重复 ' + detail.copies + ' 次'
  if (kind === 'fuzzy') return '相邻窗口相似回声 ' + detail.copies + ' 次'
  return '尾部 ' + CFG.degenTail + ' 字符仅 ' + detail.grams + ' 种相邻字对'
}

/** 命中时从缓冲尾巴丢弃多少字符（尽量裁在重复段起点附近）。 */
function dropTailFor(kind, detail) {
  if (kind === 'exact') return detail.copies * detail.unitLen
  if (kind === 'fuzzy') return CFG.win
  return CFG.degenTail
}

function record(m, kind, detail, action, childId) {
  seq++
  detections.unshift({
    id: seq,
    at: Date.now(),
    sessionId: m.meta.sessionId ? String(m.meta.sessionId) : '',
    provider: m.meta.provider,
    model: m.meta.model,
    kind: kind,
    detail: describe(kind, detail) + ' · 累计思考 ' + m.total + ' 字',
    sample: clip(detail.unit || detail.tail || '', 140),
    action: action,
    ...(childId !== undefined ? { childId: childId } : {})
  })
  if (detections.length > 30) detections.length = 30
}

/**
 * 取一个服务：优先 `ctx.get()`（cordis 的正规入口），退回属性访问。
 * 两个都要 try —— 服务访问器拿不到时有的版本直接抛、有的给 undefined，
 * 这里统一成 undefined。agents / sessionController 这类在用时才取，
 * 不在 apply 时硬绑，避免加载顺序问题。
 */
function service(ctx, id) {
  try {
    if (typeof ctx.get === 'function') {
      const found = ctx.get(id)
      if (found !== undefined) return found
    }
  } catch {
    // 落到属性访问再试一次
  }
  try {
    return ctx[id]
  } catch {
    return undefined
  }
}

/** 错误的可读文本（RemoteError 带 code，能拼上就拼上）。 */
function reasonOf(error) {
  const message = String(error?.message ?? error)
  const code = typeof error?.code === 'string' ? error.code.trim() : ''
  if (code.length === 0 || message.includes(code)) return message
  return `${code}: ${message}`
}

/** Dispose 一个 `using` 资源（SessionObservation），不管成没成都不抛。 */
function dispose(resource) {
  for (const key of ['dispose', 'asyncDispose']) {
    const symbol = Symbol[key]
    if (symbol === undefined) continue
    let fn
    try {
      fn = resource?.[symbol]
    } catch {
      return
    }
    if (typeof fn === 'function') {
      try {
        fn.call(resource)
      } catch {
        // 观测租约释放失败不影响主流程
      }
      return
    }
  }
}

/**
 * 读一份会话日志（冷热通吃）—— 照搬 retry 插件的同名实现。
 * @returns `{events, header, projections}`（events 按 seq 升序）。
 */
async function readLog(ctx, sessionId) {
  const query = service(ctx, 'sessionQuery')
  if (query !== undefined && typeof query.observeSession === 'function') {
    let observed
    try {
      observed = await query.observeSession(sessionId)
    } catch (error) {
      throw new Error(`会话 ${sessionId} 读不到日志：${reasonOf(error)}`)
    }
    try {
      const events = observed?.events
      if (Array.isArray(events) && events.length > 0) {
        return { events, header: observed?.header ?? undefined, projections: observed?.projections ?? undefined }
      }
    } finally {
      dispose(observed)
    }
  }
  const store = service(ctx, 'sessions')
  const live = store !== undefined && typeof store.get === 'function' ? store.get(sessionId) : undefined
  if (live !== undefined && typeof live.snapshotEvents === 'function') {
    const events = live.snapshotEvents()
    if (Array.isArray(events) && events.length > 0) return { events, header: live.header }
  }
  throw new Error(`读不到会话 ${sessionId} 的日志（既不是活动会话，持久化里也没有）`)
}

/** 文本块拼起来 —— 只取 `type === "text"`，其余（图片/文件）算附件。 */
function readContent(content) {
  const blocks = Array.isArray(content) ? content : []
  let text = ''
  let attachments = 0
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text
      continue
    }
    attachments += 1
  }
  return { text, attachments }
}

/**
 * 从一条 `user/message` 事件里取「用户自己写的」内容 —— 照搬 retry 的约定：
 * `source.kind !== 'user'` 是注入的上下文，surface 替换出来的副本不进可见会话，
 * 都跳过。
 */
function userContentOf(event) {
  if (event === null || typeof event !== 'object' || event.type !== 'user/message') return undefined
  const data = event.data
  if (data === null || typeof data !== 'object') return undefined
  if (data.source?.kind !== 'user') return undefined
  if (data.surfaceOp !== undefined && data.surfaceOp !== 'append') return undefined
  return readContent(data.content)
}

/**
 * 找「正在跑的这一轮」的重发信息：最后一条 turn/start 之后的第一条用户消息
 * （一轮可能多条 —— 中途 steering，取第一条，和 retry 一致），以及本轮之前
 * 最近的 turn/end 作为 fork 切点；没有就是全新会话的第一轮（first）。
 */
function resolveOpenTurn(events) {
  const log = Array.isArray(events) ? events : []
  let start = -1
  for (let index = log.length - 1; index >= 0; index -= 1) {
    if (log[index]?.type === 'turn/start') { start = index; break }
  }
  if (start < 0) return { ok: false, code: 'NO_TURN', message: '日志里没有任何轮次' }

  let text = null
  for (let index = start + 1; index < log.length; index += 1) {
    const event = log[index]
    if (event?.type === 'turn/start') break
    const content = userContentOf(event)
    if (content === undefined) continue
    if (content.text.trim().length > 0) { text = content.text; break }
  }
  if (text === null) return { ok: false, code: 'NO_MESSAGE', message: '本轮没有可重发的用户消息' }

  let atSeq = null
  for (let index = start - 1; index >= 0; index -= 1) {
    const event = log[index]
    if (event?.type === 'turn/end' && Number.isSafeInteger(event.seq)) { atSeq = event.seq; break }
  }
  return { ok: true, atSeq, first: atSeq === null, text }
}

/**
 * 这个会话归哪个工作区管（侧边栏按它分组）—— 照搬 retry 的同名实现。
 * 拿不到就 undefined，调用方退化成「按 cwd 新建」。
 */
function workspaceOwnerOf(ctx, sessionId) {
  const registry = service(ctx, 'workspaceRegistry')
  if (registry === undefined || typeof registry.list !== 'function') return undefined
  let list
  try {
    list = registry.list()
  } catch {
    return undefined
  }
  if (!Array.isArray(list)) return undefined
  for (const workspace of list) {
    const ids = workspace?.sessionIds
    if (!Array.isArray(ids) || !ids.includes(sessionId)) continue
    const id = workspace.id
    if (typeof id === 'string' && id.length > 0) return id
  }
  return undefined
}

/** 会话日志里最后一条标题（`session/title` 事件，最新一条赢）。 */
function titleOf(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'session/title') continue
    const title = event.data?.title
    return typeof title === 'string' && title.trim().length > 0 ? title : undefined
  }
  return undefined
}

/** 把标题拆成「base + 结尾序号」，认半角 ` (n)` 和全角 `（n）`。 */
function splitTrailingNumber(title) {
  const text = typeof title === 'string' ? title.trim() : ''
  const ascii = /^(.*?)\((\d+)\)$/u.exec(text)
  if (ascii?.[1] !== undefined && ascii[2] !== undefined) {
    return { base: ascii[1].trim(), number: Number.parseInt(ascii[2], 10) }
  }
  const fullWidth = /^(.*?)（(\d+)）$/u.exec(text)
  if (fullWidth?.[1] !== undefined && fullWidth[2] !== undefined) {
    return { base: fullWidth[1].trim(), number: Number.parseInt(fullWidth[2], 10) }
  }
  return { base: text, number: 0 }
}

/** 分支标题：`base (n)`，n 取现有标题里没被占过的下一个（同 retry 的规则）。 */
function branchTitle(sourceTitle) {
  const source = splitTrailingNumber(sourceTitle)
  return `${source.base} (${String(source.number + 1)})`
}

/** 子会话标题自增。失败不影响主流程（只是侧边栏里父子同名而已）。 */
async function renameChild(controller, events, childId) {
  const title = titleOf(events)
  if (title === undefined) return
  try {
    await controller.rename({ sessionId: childId, title: branchTitle(title) })
  } catch (error) {
    console.error(`${TAG} 分支标题自增失败：${reasonOf(error)}`)
  }
}

/**
 * 清掉子会话**种子里带过来的**幽灵待办（照搬 retry）：fork 的切点落在本轮
 * 用户消息的 inbox splice 与配对移除之间，子会话会把那条旧消息当成待发复活。
 * 必须在 prompt 之前清，否则把我们自己刚发的那条也清掉了。
 */
function clearInheritedInbox(ctx, childId) {
  const registry = service(ctx, 'agents')
  const agent = registry !== undefined && typeof registry.get === 'function' ? registry.get(childId) : undefined
  if (agent === undefined || typeof agent.cancel !== 'function') return
  try {
    agent.cancel({ kind: 'user' }, { keepInbox: false })
  } catch (error) {
    console.error(`${TAG} 清理子会话继承的待办失败：${reasonOf(error)}`)
  }
}

/** 兜底中断：找不到控制器 / 分支失败时，确保正在循环的那一轮被停掉。 */
function fallbackCancel(ctx, m, why) {
  const agent = agentOf(ctx, m.meta.sessionId)
  let action = 'truncated'
  if (agent !== undefined && typeof agent.cancel === 'function') {
    try {
      agent.cancel(
        { kind: 'hook', reason: '思考循环守卫：' + why + '，已自动中断以避免无效消耗' },
        { keepInbox: true }
      )
      action = 'cancelled'
    } catch (error) {
      console.error(TAG, 'cancel 失败，回退为截断流:', error)
    }
  }
  m.action = action
  return action
}

/**
 * 分支重跑（retry 的宿主机制，程序化触发）：
 * 取消本轮 → 算切点（本轮之前最近的 turn/end）→ fork/新建 → 子会话清种子待办、
 * 标题自增 → 把本轮的用户原文重新发出去。成功后记录 'branched' 并把 childId
 * 挂到 pendingChild，浏览器半边轮询到后自动跳转。
 */
async function branchRetry(ctx, m, kind, detail) {
  const controller = service(ctx, 'sessionController')
  if (controller === undefined || typeof controller.prompt !== 'function' || typeof controller.fork !== 'function') {
    // 没有 sessionController（非 web profile）：退回普通中断
    const action = fallbackCancel(ctx, m, describe(kind, detail))
    record(m, kind, detail, action)
    return
  }
  try {
    // 1) 停掉正在循环的那一轮（和界面停止按钮同一条路径；切点在本轮之前，停不下来也切得动）
    try {
      await controller.cancel({ sessionId: m.meta.sessionId })
    } catch (error) {
      console.error(`${TAG} 停止正在跑的那一轮失败：${reasonOf(error)}`)
    }
    // 2) 读日志、算切点 + 本轮用户原文
    const { events, header, projections } = await readLog(ctx, m.meta.sessionId)
    const origin = resolveOpenTurn(events)
    if (origin.ok !== true) {
      const action = fallbackCancel(ctx, m, describe(kind, detail))
      record(m, kind, detail, action)
      if (!QUIET) console.error(TAG, '分支重跑不可用（' + origin.code + '），已中断:', m.meta.model)
      return
    }
    // 3) fork / 新建
    let childId
    if (origin.first === true) {
      const workspaceId = workspaceOwnerOf(ctx, m.meta.sessionId)
      const cwd = typeof header?.cwd === 'string' && header.cwd.length > 0 ? header.cwd : undefined
      // 源会话的 agent 预设要跟着走（取投影里的「当前」值，header 会过期 —— 同 retry）
      const preset =
        (typeof projections?.values?.agentPreset === 'string' && projections.values.agentPreset.length > 0
          ? projections.values.agentPreset
          : typeof header?.agentPreset === 'string' && header.agentPreset.length > 0
            ? header.agentPreset
            : undefined)
      const created = await controller.create({
        ...(workspaceId !== undefined ? { workspaceId } : cwd !== undefined ? { cwd } : {}),
        ...(preset !== undefined ? { agentPreset: preset } : {})
      })
      childId = created.sessionId
    } else {
      const forked = await controller.fork({ sessionId: m.meta.sessionId, atSeq: origin.atSeq })
      childId = forked.sessionId
      // 先清种子里复活的旧消息，再改名 —— 顺序错了会把我们自己发的消息清掉
      clearInheritedInbox(ctx, childId)
      await renameChild(controller, events, childId)
    }
    // 4) 本轮用户原文重发到新分支（mode: 'queue'，signal 必填 —— 同 retry）
    await controller.prompt(
      {
        requestId: randomUUID(),
        sessionId: childId,
        mode: 'queue',
        content: [{ type: 'text', text: origin.text }]
      },
      new AbortController().signal
    )
    // 5) 记账：重跑链深度 + 待跳转标记 + 命中记录
    const depth = (chainDepth.get(m.meta.sessionId) ?? 0) + 1
    chainDepth.set(childId, depth)
    pendingChild = childId
    m.childId = childId
    record(m, kind, detail, 'branched', childId)
    if (!QUIET) {
      console.error(TAG, '已分支重跑:', describe(kind, detail), '· 父', m.meta.sessionId, '→ 子', childId, '· 链深', depth)
    }
  } catch (error) {
    console.error(TAG, '分支重跑失败，回退为中断:', reasonOf(error))
    const action = fallbackCancel(ctx, m, describe(kind, detail))
    record(m, kind, detail, action)
  }
}

function fire(ctx, m, kind, detail) {
  m.fired = true
  m.hitDropTail = dropTailFor(kind, detail)
  if (!CFG.autoInterrupt) {
    // 仅记录模式：流原样直通，不做任何截断
    m.action = 'none'
    record(m, kind, detail, 'none')
    if (!QUIET) console.error(TAG, '检测到循环（仅记录）:', describe(kind, detail), m.meta.model)
    return
  }
  const depth = chainDepth.get(m.meta.sessionId) ?? 0
  if (depth < MAX_RETRY) {
    // 重跑链还有额度：分支重跑（异步任务，不阻塞流收尾）
    m.action = 'branched'
    void branchRetry(ctx, m, kind, detail)
    return
  }
  // 重跑链已到上限：取消本轮（与用户点停止同一条路）
  const action = fallbackCancel(ctx, m, describe(kind, detail))
  record(m, kind, detail, action)
  if (!QUIET) console.error(TAG, '已处理:', action, describe(kind, detail), m.meta.model)
}

function warn(m, kind, detail) {
  m.warned = true
  record(m, kind, detail, 'warned')
  if (!QUIET) console.error(TAG, '预警:', describe(kind, detail), m.meta.model)
}

function scan(ctx, m) {
  if (m.fired) return
  const s = m.buf
  const n = s.length

  // 1) 精确重复：尾部按最小周期逐字重复
  const ex = exactRepeat(s)
  if (ex) {
    const th = thresholdFor(ex.unitLen)
    const span = ex.copies * ex.unitLen
    if (ex.copies >= th.copies && span >= th.span) { fire(ctx, m, 'exact', ex); return }
    if (!m.warned && ex.copies >= th.copies - 1 && span >= th.span) warn(m, 'exact', ex)
  }

  // 2) 相似回声：相邻等长窗口 trigram-Jaccard 连续高相似（捕捉带漂移的循环）
  if (n >= 2 * CFG.win + 60 && (m.lastEvalAt < 0 || n - m.lastEvalAt >= CFG.win)) {
    m.lastEvalAt = n
    const wa = s.slice(n - 2 * CFG.win, n - CFG.win)
    const wb = s.slice(n - CFG.win)
    const ga = trigrams(wa)
    if (ga.size >= 30) {
      const j = jaccard(ga, trigrams(wb))
      if (j >= CFG.fuzzyJ) {
        m.echoStreak++
        if (m.echoStreak >= CFG.fuzzyStop) { fire(ctx, m, 'fuzzy', { unit: wb, copies: m.echoStreak }); return }
        if (!m.warned && m.echoStreak >= CFG.fuzzyWarn) warn(m, 'fuzzy', { unit: wb, copies: m.echoStreak })
      } else {
        m.echoStreak = 0
      }
    }
  }

  // 3) 退化重复
  const dg = degenerateTail(s)
  if (dg) fire(ctx, m, 'degenerate', dg)
}

/** 记录某个 index 实际放行出去的 reasoning 文本（block-end 改写的数据源）。 */
function noteEmitted(m, index, text) {
  const prev = m.emitted.get(index)
  if (prev === undefined) {
    if (text.length <= 120000) m.emitted.set(index, text)
    return
  }
  if (prev.length + text.length <= 200000) m.emitted.set(index, prev + text)
}

/** 全部放行缓冲区（思考自然结束 / 切到别的块时）。返回要 yield 的 chunk。 */
function drain(m) {
  if (m.pending.length === 0) return []
  const emit = m.pending
  m.pending = []
  m.heldLen = 0
  for (const c of emit) noteEmitted(m, c.index, c.text)
  return emit
}

/** 放行缓冲区里「结束位置不超过上次干净扫描点」的部分。 */
function takeReady(m) {
  const emit = []
  while (m.pending.length > 0) {
    const first = m.pending[0]
    if (m.total - m.heldLen + first.text.length > m.safeTotal) break
    m.pending.shift()
    m.heldLen -= first.text.length
    noteEmitted(m, first.index, first.text)
    emit.push(first)
  }
  return emit
}

/**
 * 命中后的截断放行：丢弃缓冲区尾部 hitDropTail 个字符（重复段），
 * 前面的良好前缀照常放行 —— 重复内容不会进入最终消息。
 */
function flushTrimmed(m) {
  const keep = Math.max(0, m.heldLen - m.hitDropTail)
  const emit = []
  let remain = keep
  for (const c of m.pending) {
    if (remain <= 0) break
    if (c.text.length <= remain) {
      emit.push(c)
      noteEmitted(m, c.index, c.text)
      remain -= c.text.length
    } else {
      const part = Object.assign({}, c, { text: c.text.slice(0, remain) })
      emit.push(part)
      noteEmitted(m, c.index, part.text)
      remain = 0
    }
  }
  m.pending = []
  m.heldLen = 0
  return emit
}

/**
 * block-end 携带的块文本是 adapter 从「它自己的完整流」装配的，包含已被我们
 * 截掉的内容 —— 用实际放行的文本改写，保证最终消息与用户看到的流一致。
 */
function rewriteBlockEnd(m, chunk) {
  const mine = m.emitted.get(chunk.index)
  if (mine === undefined || !chunk.block || chunk.block.type !== 'reasoning') return chunk
  m.emitted.delete(chunk.index)
  if (mine === chunk.block.text) return chunk
  return Object.assign({}, chunk, { block: Object.assign({}, chunk.block, { text: mine }) })
}

/**
 * 喂一个 chunk 给监控，返回 { hit, emit }：
 *   hit  —— 本路流应在此结束（已触发分支重跑 / 已中断 / 截断收尾）
 *   emit —— 此次要放行的 chunk（可能含截断后的部分块、块结束改写等）
 */
function feedChunk(ctx, m, chunk) {
  if (!chunk || typeof chunk !== 'object') return { hit: false, emit: chunk ? [chunk] : [] }

  if (chunk.type === 'block-start' && chunk.blockType === 'reasoning') {
    const emit = drain(m)
    m.buf = ''
    m.total = 0
    m.sinceScan = 0
    m.echoStreak = 0
    m.lastEvalAt = -1
    m.safeTotal = 0
    m.rIndex = null
    return { hit: false, emit: emit.concat([chunk]) }
  }

  if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
    if (m.fired && m.action === 'none') return { hit: false, emit: drain(m).concat([chunk]) }
    if (m.fired) return { hit: true, emit: flushTrimmed(m) }
    m.buf += chunk.text
    m.total += chunk.text.length
    m.sinceScan += chunk.text.length
    if (m.buf.length > CFG.bufKeep + 4000) m.buf = m.buf.slice(-CFG.bufKeep)
    if (m.rIndex === null) m.rIndex = chunk.index
    m.pending.push(chunk)
    m.heldLen += chunk.text.length
    if (m.total < CFG.minChars) {
      m.safeTotal = m.total // 热身期不判定：全部直接放行，思考显示零延迟
    } else if (m.sinceScan >= CFG.scanEvery) {
      m.sinceScan = 0
      scan(ctx, m)
      if (!m.fired) m.safeTotal = m.total
    }
    if (m.fired) {
      if (m.action === 'none') return { hit: false, emit: drain(m).concat([chunk]) }
      return { hit: true, emit: flushTrimmed(m) }
    }
    return { hit: false, emit: takeReady(m) }
  }

  if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'reasoning') {
    const emit = drain(m)
    return { hit: false, emit: emit.concat([rewriteBlockEnd(m, chunk)]) }
  }

  // 其余块（text-delta / tool-call / usage / finish…）：思考已结束，放行残留
  return { hit: false, emit: drain(m).concat([chunk]) }
}

/**
 * 泵一路上游流：边观察边放行。返回 'hit'（命中截断）或 'clean'（自然结束）。
 * 上游抛错时原样上抛 —— 消费方（agent 循环）本来就要处理流错误。
 */
async function* pumpAttempt(ctx, m, stream) {
  for await (const chunk of stream) {
    let feed
    try {
      feed = feedChunk(ctx, m, chunk)
    } catch (error) {
      console.error(TAG, 'feed 异常:', error)
      feed = { hit: false, emit: [chunk] }
    }
    for (const c of feed.emit) yield c
    if (feed.hit) return 'hit'
  }
  for (const c of drain(m)) yield c
  return 'clean'
}

/** 统一 JSON 响应：业务失败也是 200 + ok:false，让浏览器那边只认一个开关。 */
function json(payload) {
  return Response.json(payload, { headers: { 'cache-control': 'no-store' } })
}

function statePayload() {
  return json({
    ok: true,
    autoInterrupt: CFG.autoInterrupt,
    activeStreams: active,
    seen: seen,
    detections: detections.slice(0, 20),
    pendingChild: pendingChild
  })
}

async function readJsonBody(request) {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

async function handleMode(request) {
  const body = await readJsonBody(request)
  if (body === null || typeof body !== 'object' || typeof body.value !== 'boolean') {
    return json({ ok: false, code: 'BAD_VALUE', message: '缺少布尔字段 value' })
  }
  CFG.autoInterrupt = body.value
  if (!QUIET) console.error(TAG, '自动中断已切换为:', CFG.autoInterrupt)
  return statePayload()
}

async function handleOpened(request) {
  const body = await readJsonBody(request)
  if (body === null || typeof body !== 'object' || typeof body.childId !== 'string' || body.childId.length === 0) {
    return json({ ok: false, code: 'BAD_CHILD', message: '缺少 childId' })
  }
  if (pendingChild === body.childId) pendingChild = null
  return json({ ok: true })
}

/**
 * 插件入口。
 *
 * llm/stream 是进程级瀑布：这里注册的监听对**所有**会话的模型调用生效
 * （包括子代理）。connection 只有 web profile 提供，所以用 ctx.inject
 * 按需绑定而不是写进静态 inject —— 否则在 headless / tui 里会一直 pending。
 *
 * @param ctx - 宿主侧插件 context。
 */
export function apply(ctx) {
  // ---- llm/stream 瀑布：包裹每一次流式模型调用 ----
  ctx.on('llm/stream', function (options, next) {
    if (!options || options.purpose || !options.sessionId) return next()
    seen++
    const m = newMonitor({
      sessionId: options.sessionId,
      provider: options.provider || '',
      model: options.model || ''
    })
    active++
    const guarded = async function* () {
      try {
        // 单路直泵：命中后 fire() 已按动作处置（分支重跑任务在后台跑 / 已取消），
        // 这里只负责把截断后的良好前缀放行完就收流。
        yield* pumpAttempt(ctx, m, next())
      } finally {
        active--
      }
    }
    return guarded()
  })

  // ---- 面板用的 /api 接口 ----
  ctx.inject(['connection'], (scoped) => {
    const routes = [
      { path: STATE_API, methods: ['GET'], fetch: () => statePayload() },
      { path: MODE_API, methods: ['POST'], fetch: (request) => handleMode(request) },
      { path: OPENED_API, methods: ['POST'], fetch: (request) => handleOpened(request) }
    ]
    // 一条一条注册、各自 try：一条失败不连累另一条（retry 插件踩过的坑）
    for (const route of routes) {
      try {
        scoped.connection.fetch.register({ ...route, requestBody: 'buffered' })
        if (!QUIET) console.error(TAG, '接口已注册:', route.methods.join('/'), route.path)
      } catch (error) {
        console.error(TAG, '注册', route.path, '失败:', error)
      }
    }
  })

  if (!QUIET) {
    console.error(TAG, '已挂载 llm/stream 监听（自动中断:', CFG.autoInterrupt ? '开' : '关', '· 分支重跑:', MAX_RETRY, '次）')
  }
}

export default { name, apply }
