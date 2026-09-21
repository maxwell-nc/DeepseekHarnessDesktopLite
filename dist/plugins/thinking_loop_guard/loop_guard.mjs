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
 * 命中后（默认）`agent.cancel({kind:'hook'}, {keepInbox:true})` 中断本轮 ——
 * 与用户点停止同一条路：已生成的部分思考以 interrupted 标记保留，排队消息不丢。
 * 找不到 Agent 时兜底为「提前收流」（上层按正常 stop 结束这一步）。
 *
 * 为什么自动中断默认敢开：判定要求「重复发生在流尾部」——模型中途重复过
 * 又正常往下走的内容不会被误伤；三类阈值都留了余量（见 thresholdFor）。
 *
 * 网页半边（lib/client.js）通过两条 /api 接口读状态、切开关：
 *
 *   GET  /api/dsh-loop-guard.state   只读：{autoInterrupt, activeStreams, seen, detections}
 *   POST /api/dsh-loop-guard.mode    {value:boolean} 切自动中断，返回同 state
 *
 * 环境变量：
 *   DSH_LOOP_GUARD_QUIET=1   不打启动/命中日志
 *
 * 已知边界：压缩（compaction）/ 会话标题等辅助调用（options.purpose）不参与监控；
 * 检测状态与命中记录都在内存里，重启后清零。
 */

/** 稳定的 cordis 插件名。 */
export const name = 'dsh-loop-guard'

const TAG = '[dsh-loop-guard]'

/** 关掉启动/命中日志。 */
const QUIET = (process.env.DSH_LOOP_GUARD_QUIET ?? '') === '1'

const STATE_API = '/api/dsh-loop-guard.state'
const MODE_API = '/api/dsh-loop-guard.mode'

// ---- 检测配置（进程内，可由面板切换 autoInterrupt）----

const CFG = {
  autoInterrupt: true, // 命中后自动中断本轮
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

function newMonitor(meta) {
  return {
    buf: '', total: 0, sinceScan: 0,
    fired: false, action: null, warned: false,
    echoStreak: 0, lastEvalAt: -1,
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

function record(m, kind, detail, action) {
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
    action: action
  })
  if (detections.length > 30) detections.length = 30
}

/**
 * 取一个服务：优先 ctx.get()，拿不到（抛或 undefined）都统一成 undefined。
 * agents 在 fire 时才取 —— 不在 apply 时硬绑，避免加载顺序问题。
 */
function service(ctx, id) {
  try {
    const found = ctx.get(id)
    if (found !== undefined) return found
  } catch {
    // 落到 undefined
  }
  return undefined
}

function agentOf(ctx, sessionId) {
  if (!sessionId) return undefined
  const registry = service(ctx, 'agents')
  if (registry === undefined || typeof registry.get !== 'function') return undefined
  try {
    return registry.get(sessionId)
  } catch {
    return undefined
  }
}

function fire(ctx, m, kind, detail) {
  m.fired = true
  if (!CFG.autoInterrupt) {
    m.action = 'none'
    record(m, kind, detail, 'none')
    if (!QUIET) console.error(TAG, '检测到循环（仅记录）:', describe(kind, detail), m.meta.model)
    return
  }
  let action = 'truncated'
  const agent = agentOf(ctx, m.meta.sessionId)
  if (agent !== undefined && typeof agent.cancel === 'function') {
    try {
      agent.cancel(
        { kind: 'hook', reason: '思考循环守卫：' + describe(kind, detail) + '，已自动中断以避免无效消耗' },
        { keepInbox: true }
      )
      action = 'cancelled'
    } catch (error) {
      console.error(TAG, 'cancel 失败，回退为截断流:', error)
    }
  }
  m.action = action
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

function observe(ctx, m, chunk) {
  if (!chunk || typeof chunk !== 'object') return
  if (chunk.type === 'block-start' && chunk.blockType === 'reasoning') {
    m.buf = ''
    m.total = 0
    m.sinceScan = 0
    m.echoStreak = 0
    m.lastEvalAt = -1
    return
  }
  if (chunk.type !== 'reasoning-delta' || typeof chunk.text !== 'string' || chunk.text.length === 0) return
  m.buf += chunk.text
  m.total += chunk.text.length
  m.sinceScan += chunk.text.length
  if (m.buf.length > CFG.bufKeep + 4000) m.buf = m.buf.slice(-CFG.bufKeep)
  if (m.total < CFG.minChars || m.sinceScan < CFG.scanEvery || m.fired) return
  m.sinceScan = 0
  scan(ctx, m)
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
    detections: detections.slice(0, 20)
  })
}

async function handleMode(request) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, code: 'BAD_BODY', message: '请求体不是合法 JSON' })
  }
  if (body === null || typeof body !== 'object' || typeof body.value !== 'boolean') {
    return json({ ok: false, code: 'BAD_VALUE', message: '缺少布尔字段 value' })
  }
  CFG.autoInterrupt = body.value
  if (!QUIET) console.error(TAG, '自动中断已切换为:', CFG.autoInterrupt)
  return statePayload()
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
    const inner = next()
    if (!options || options.purpose || !options.sessionId) return inner
    seen++
    const m = newMonitor({
      sessionId: options.sessionId,
      provider: options.provider || '',
      model: options.model || ''
    })
    active++
    const guarded = async function* () {
      try {
        for await (const chunk of inner) {
          try { observe(ctx, m, chunk) } catch (error) { console.error(TAG, 'observe 异常:', error) }
          if (m.fired && m.action === 'truncated') return
          yield chunk
        }
      } finally {
        active--
      }
    }
    return guarded()
  })

  // ---- 面板用的两条 /api 接口 ----
  ctx.inject(['connection'], (scoped) => {
    const routes = [
      { path: STATE_API, methods: ['GET'], fetch: () => statePayload() },
      { path: MODE_API, methods: ['POST'], fetch: (request) => handleMode(request) }
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

  if (!QUIET) console.error(TAG, '已挂载 llm/stream 监听（自动中断:', CFG.autoInterrupt ? '开' : '关', '）')
}

export default { name, apply }
