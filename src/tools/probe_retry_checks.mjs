/**
 * retry 插件自测的**实际检查**（由 src/tools/probe_retry.py 拉起）。
 *
 * 分三块：
 *
 * A. **切点计算**（lib/origin.mjs，纯函数）
 *    喂手写的会话日志，验证「这一轮能不能重发、从哪个 seq 切、原文是什么」：
 *    找得到前一轮的 turn/end、第一轮给 first、没跑完给 open、注入上下文不算用户消息、
 *    只有附件 / 只有替换副本 的拒绝路径、轮次不存在 / 轮次号非法。
 *
 * B. **宿主接口**（retry.mjs）
 *    假 ctx + 假 sessionQuery：路由注册到 `/api/dsh-ui-retry.origin` 且只认 GET；
 *    正常返回、参数缺失、日志读不到；观测租约要 dispose；sessionQuery 缺失时
 *    退回活动会话。
 *
 * C. **浏览器半边**（lib/client.js）
 *    自己写一个够用的假 DOM（`children` / `parentElement` / `nextSibling` /
 *    `getAttribute` / `appendChild` / `insertBefore` / 事件监听全靠它），把 client.js
 *    跑起来，验证：
 *    - 只在「用户自己发的、带轮次号」那行的复制按钮后面插按钮，steering / 没有轮次号的行不插；
 *    - 重复扫 / 重新 apply 不会插重；行被 React 重建后能自己长回来（MutationObserver）；
 *    - 点重试 → 读接口 → fork(atSeq) → open → prompt(原文) → 提示条；
 *    - 点编辑 → 弹窗填的是原文 → 改完发送 → prompt(改后的文本)；
 *    - 第一轮走 create（fork 不出来）、轮次没跑完先 cancel、失败路径都弹提示条。
 *
 * 用法：node probe_retry_checks.mjs <插件目录>
 * 退出码 0 表示全部通过。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const pluginDir = process.argv[2]
if (!pluginDir) {
  console.error('用法：node probe_retry_checks.mjs <插件目录>')
  process.exit(2)
}

const originModule = await import(pathToFileURL(join(pluginDir, 'lib', 'origin.mjs')).href)
const { resolveOrigin } = originModule

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`[${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ========================================================================== */
/* A. 切点计算                                                                */
/* ========================================================================== */

console.log('--- 切点计算（lib/origin.mjs）---')

/** 造一条事件：`{type, seq, data}`。 */
const ev = (seq, type, data = {}, extra = {}) => ({ seq, time: 1700000000000 + seq, type, data, ...extra })

/** 一条用户消息事件（`source.kind` 默认是 user）。 */
const userMsg = (id, text, source = { kind: 'user' }, surfaceOp = 'append') => ({
  id,
  content: text === null ? [{ type: 'image', attachment: { id: 'a' } }] : [{ type: 'text', text }],
  source,
  surfaceOp
})

/** 一轮：turn/start → 用户消息 → 助手回答 → turn/end。返回事件数组。 */
function turnLog(turn, text, base, extraUser = null) {
  const events = [
    ev(base, 'turn/start', { turn }),
    ev(base + 1, 'user/message', userMsg(`m${String(turn)}`, text)),
    ev(base + 2, 'request/header', { header: { config: { model: 'x' } } }),
    ev(base + 3, 'assistant/message', { turn, step: 0, message: { id: 'a', role: 'assistant', content: [] }, stream: [] }),
    ev(base + 4, 'turn/end', { turn, reason: 'completed' })
  ]
  if (extraUser !== null) events.splice(2, 0, extraUser)
  return events
}

// A1. 三轮会话，重发第 3 轮（已跑完）
{
  const log = [...turnLog(1, '第一句', 0), ...turnLog(2, '第二句', 10), ...turnLog(3, '第三句', 20)]
  const got = resolveOrigin(log, 3)
  check('A1 第 3 轮切点 = 第 2 轮的 turn/end', got.ok === true && got.atSeq === 14, JSON.stringify(got))
  check('A1 不是第一轮', got.ok === true && got.first === false)
  check('A1 已跑完（open=false）', got.ok === true && got.open === false)
  check('A1 原文 = 第三句', got.ok === true && got.text === '第三句', String(got?.text))
}

// A2. 第一轮：没有可指的 turn/end → first
{
  const log = turnLog(1, '第一句', 0)
  const got = resolveOrigin(log, 1)
  check('A2 第一轮 first=true / atSeq=null', got.ok === true && got.first === true && got.atSeq === null, JSON.stringify(got))
}

// A3. 最后一轮还没跑完 → open
{
  const log = [...turnLog(1, '第一句', 0), ev(10, 'turn/start', { turn: 2 }), ev(11, 'user/message', userMsg('m2', '第二句'))]
  const got = resolveOrigin(log, 2)
  check('A3 没跑完 open=true', got.ok === true && got.open === true, JSON.stringify(got))
  check('A3 切点仍是第 1 轮的结尾', got.ok === true && got.atSeq === 4, String(got?.atSeq))
}

// A4. 一轮里先有注入上下文、再有用户消息 → 取用户那条
{
  const injected = ev(1, 'user/message', userMsg('ctx', '[系统注入]', { kind: 'plugin', plugin: 'goal' }))
  const log = turnLog(1, '真正的话', 0, injected)
  const got = resolveOrigin(log, 1)
  check('A4 跳过注入上下文', got.ok === true && got.text === '真正的话', String(got?.text))
}

// A5. 一轮里只有注入上下文 → 拒绝
{
  const injected = ev(1, 'user/message', userMsg('ctx', '[系统注入]', { kind: 'plugin', plugin: 'goal' }))
  const log = [ev(0, 'turn/start', { turn: 1 }), injected, ev(2, 'turn/end', { turn: 1, reason: 'completed' })]
  const got = resolveOrigin(log, 1)
  check('A5 没有用户消息 → NO_MESSAGE', got.ok === false && got.code === 'NO_MESSAGE', JSON.stringify(got))
}

// A6. 只有附件、没有正文 → 拒绝（附件重发不了）
{
  const log = [ev(0, 'turn/start', { turn: 1 }), ev(1, 'user/message', userMsg('m1', null)), ev(2, 'turn/end', { turn: 1, reason: 'completed' })]
  const got = resolveOrigin(log, 1)
  check('A6 只有附件 → EMPTY_TEXT', got.ok === false && got.code === 'EMPTY_TEXT', JSON.stringify(got))
}

// A7. 替换出来的副本（compaction 之类）不算用户消息
{
  const replaced = ev(3, 'user/message', userMsg('m2', '旧的', { kind: 'user' }, { op: 'replace', startSeq: 3, endSeq: 4 }))
  const log = [
    ev(0, 'turn/start', { turn: 1 }),
    ev(1, 'turn/end', { turn: 1, reason: 'completed' }),
    ev(2, 'turn/start', { turn: 2 }),
    replaced,
    ev(4, 'turn/end', { turn: 2, reason: 'completed' })
  ]
  const got = resolveOrigin(log, 2)
  check('A7 只看 append 副本 → NO_MESSAGE', got.ok === false && got.code === 'NO_MESSAGE', JSON.stringify(got))
}

// A8. 附件数量要报出来（正文照发，提示条里说明附件带不上）
{
  const mixed = ev(1, 'user/message', {
    id: 'm1',
    content: [{ type: 'text', text: '看这张图' }, { type: 'image', attachment: { id: 'img' } }, { type: 'file', attachment: { id: 'f', name: 'a.txt' } }],
    source: { kind: 'user' },
    surfaceOp: 'append'
  })
  const log = [ev(0, 'turn/start', { turn: 1 }), mixed, ev(2, 'turn/end', { turn: 1, reason: 'completed' })]
  const got = resolveOrigin(log, 1)
  check('A8 附件数 = 2', got.ok === true && got.attachments === 2, JSON.stringify(got))
}

// A9. 轮次不存在 / 轮次号非法 / 空日志
{
  const log = turnLog(1, '第一句', 0)
  const missing = resolveOrigin(log, 9)
  check('A9 轮次不存在 → TURN_NOT_FOUND', missing.ok === false && missing.code === 'TURN_NOT_FOUND', JSON.stringify(missing))
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    const got = resolveOrigin(log, bad)
    check(`A9 轮次号非法（${String(bad)}）→ BAD_TURN`, got.ok === false && got.code === 'BAD_TURN')
  }
  const empty = resolveOrigin([], 1)
  check('A9 空日志 → NO_LOG', empty.ok === false && empty.code === 'NO_LOG', JSON.stringify(empty))
}

/* ========================================================================== */
/* B. 宿主接口                                                                */
/* ========================================================================== */

console.log('--- 宿主接口（retry.mjs）---')

const hostModule = await import(pathToFileURL(join(pluginDir, 'retry.mjs')).href)
check('host 导出 name / apply', hostModule.name === 'dsh-ui-retry' && typeof hostModule.apply === 'function')

const ORIGIN_PATH = '/api/dsh-ui-retry.origin'
const COMMIT_PATH = '/api/dsh-ui-retry.commit'

/**
 * 假 ctx：只实现插件用到的那几个入口。
 *
 * `sessionController` / `workspaceRegistry` 是重发那半边真正依赖的宿主服务；
 * 每个调用都记下来（还记一份顺序，用来验「先 cancel 再 fork」）。
 */
function fakeHost(options = {}) {
  const {
    events = [],
    live = null,
    withQuery = true,
    cwd = 'D:/work',
    workspaces = [],
    createFails = false,
    forkFails = false,
    promptFails = false
  } = options
  const seen = { routes: [], disposed: 0, observed: [], order: [], create: [], fork: [], prompt: [], cancel: [], rename: [], agentCancels: [] }
  const sessionQuery = withQuery
    ? {
        observeSession: async (sessionId) => {
          seen.observed.push(sessionId)
          return {
            header: { id: sessionId, cwd },
            events,
            [Symbol.dispose]() {
              seen.disposed += 1
            }
          }
        }
      }
    : undefined
  const sessions = { get: (id) => (live !== null && live.id === id ? live.session : undefined) }
  // agents：fork 之后要清子会话继承的「幽灵待办」
  const agentCancels = []
  const agents = {
    get: (id) => ({
      id,
      cancel: (cause, options) => {
        agentCancels.push({ id, cause, options })
        seen.order.push('clear-inbox')
      }
    })
  }
  const sessionController = {
    create: async (request) => {
      seen.create.push(request)
      seen.order.push('create')
      if (createFails) throw new Error('workspace/not-found: workspace "ws-1" not found')
      return { sessionId: 'created-1' }
    },
    fork: async (request) => {
      seen.fork.push(request)
      seen.order.push('fork')
      if (forkFails) throw new Error('session/fork-unavailable: 没有可切的轮次')
      return { sessionId: 'child-1' }
    },
    prompt: async (request, signal) => {
      seen.prompt.push(request)
      seen.promptSignal = signal
      seen.order.push('prompt')
      if (promptFails) throw new Error('session/model-unavailable: no adapter serves provider "x"')
      return { accepted: true }
    },
    cancel: async (request) => {
      seen.cancel.push(request)
      seen.order.push('cancel')
      return { accepted: true }
    },
    rename: async (request) => {
      seen.rename.push(request)
      seen.order.push('rename')
      return { title: request.title, seq: 1 }
    }
  }
  const workspaceRegistry = {
    list: () =>
      workspaces.map((workspace, index) => ({
        id: workspace.id ?? `ws-${String(index + 1)}`,
        path: workspace.path ?? cwd,
        sessionIds: workspace.sessionIds ?? []
      }))
  }
  const scoped = {
    connection: {
      fetch: {
        register: (route) => {
          seen.routes.push(route)
          return async () => {}
        }
      }
    }
  }
  const ctx = {
    get: (id) =>
      id === 'sessionQuery'
        ? sessionQuery
        : id === 'sessions'
          ? sessions
          : id === 'sessionController'
            ? sessionController
            : id === 'workspaceRegistry'
              ? workspaceRegistry
              : id === 'agents'
                ? agents
                : undefined,
    inject: (deps, callback) => {
      seen.injected = deps
      callback(scoped)
    }
  }
  seen.agentCancels = agentCancels
  return { ctx, seen, scoped }
}

const routeOf = (seen, path) => seen.routes.find((route) => route.path === path)
const originRequest = (query) => new Request(`http://127.0.0.1:3080${ORIGIN_PATH}${query}`)
const commitRequest = (body) =>
  new Request(`http://127.0.0.1:3080${COMMIT_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
/** 追加一条标题事件（log-only，不进模型历史）。 */
const withTitle = (log, title) => [...log, ev(90, 'session/title', { title, messageSeqs: [], source: 'fallback' })]

const log3 = [...turnLog(1, '第一句', 0), ...turnLog(2, '第二句', 10), ...turnLog(3, '第三句', 20)]

/* -------------------------------------------------------------------------- */
/* B1. 路由注册与读接口                                                        */
/* -------------------------------------------------------------------------- */

{
  const { ctx, seen } = fakeHost({ events: log3 })
  hostModule.apply(ctx)
  check('B1 注册了两条路由', seen.routes.length === 2, String(seen.routes.length))
  check(
    'B1 读接口 = GET /api/dsh-ui-retry.origin',
    routeOf(seen, ORIGIN_PATH)?.methods?.join(',') === 'GET',
    JSON.stringify(routeOf(seen, ORIGIN_PATH)?.methods)
  )
  check(
    'B1 重发接口 = POST /api/dsh-ui-retry.commit',
    routeOf(seen, COMMIT_PATH)?.methods?.join(',') === 'POST',
    JSON.stringify(routeOf(seen, COMMIT_PATH)?.methods)
  )
  check('B1 requestBody = buffered', routeOf(seen, COMMIT_PATH)?.requestBody === 'buffered')

  const payload = await (await routeOf(seen, ORIGIN_PATH).fetch(originRequest('?sessionId=s1&turn=2'))).json()
  check('B1 读接口给出切点与原文', payload.ok === true && payload.atSeq === 4 && payload.text === '第二句', JSON.stringify(payload))
  check('B1 观测租约被 dispose', seen.disposed === 1, String(seen.disposed))

  const noSession = await (await routeOf(seen, ORIGIN_PATH).fetch(originRequest('?turn=2'))).json()
  check('B1 缺 sessionId → BAD_SESSION', noSession.ok === false && noSession.code === 'BAD_SESSION', JSON.stringify(noSession))
  const badTurn = await (await routeOf(seen, ORIGIN_PATH).fetch(originRequest('?sessionId=s1&turn=abc'))).json()
  check('B1 轮次号不是数字 → BAD_TURN', badTurn.ok === false && badTurn.code === 'BAD_TURN', JSON.stringify(badTurn))
  const missing = await (await routeOf(seen, ORIGIN_PATH).fetch(originRequest('?sessionId=s1&turn=7'))).json()
  check('B1 轮次不存在 → TURN_NOT_FOUND', missing.ok === false && missing.code === 'TURN_NOT_FOUND', JSON.stringify(missing))
}

/* -------------------------------------------------------------------------- */
/* B2. 日志来源（sessionQuery → 活动会话）                                     */
/* -------------------------------------------------------------------------- */

{
  const liveEvents = turnLog(1, '活会话里的第一句', 0)
  const { ctx, seen } = fakeHost({
    live: { id: 's9', session: { snapshotEvents: () => liveEvents, header: { id: 's9', cwd: 'D:/live' } } },
    withQuery: false
  })
  hostModule.apply(ctx)
  const payload = await (await routeOf(seen, ORIGIN_PATH).fetch(originRequest('?sessionId=s9&turn=1'))).json()
  check('B2 sessionQuery 缺失时退回活动会话', payload.ok === true && payload.text === '活会话里的第一句', JSON.stringify(payload))

  const unknown = await (await routeOf(seen, ORIGIN_PATH).fetch(originRequest('?sessionId=nope&turn=1'))).json()
  check('B2 两条路都读不到 → INTERNAL', unknown.ok === false && unknown.code === 'INTERNAL', JSON.stringify(unknown))
}

/* -------------------------------------------------------------------------- */
/* B3. 重发：不是第一轮 → fork + 标题自增 + 发出去                             */
/* -------------------------------------------------------------------------- */

{
  const { ctx, seen } = fakeHost({ events: withTitle(log3, '我的会话') })
  hostModule.apply(ctx)
  const commit = routeOf(seen, COMMIT_PATH)
  const payload = await (await commit.fetch(commitRequest({ sessionId: 's1', turn: 2, text: '第二句（改过）' }))).json()

  check('B3 返回 ok + childId + kind=fork', payload.ok === true && payload.childId === 'child-1' && payload.kind === 'fork', JSON.stringify(payload))
  check('B3 fork 用前一轮的 turn/end 当切点', JSON.stringify(seen.fork[0]) === JSON.stringify({ sessionId: 's1', atSeq: 4 }), JSON.stringify(seen.fork[0]))
  check('B3 没在跑就不 cancel', seen.cancel.length === 0)
  check('B3 子会话标题自增', JSON.stringify(seen.rename[0]) === JSON.stringify({ sessionId: 'child-1', title: '我的会话 (1)' }), JSON.stringify(seen.rename[0]))
  check(
    'B3 清掉子会话继承的幽灵待办（keepInbox:false）',
    JSON.stringify(seen.agentCancels[0]) === JSON.stringify({ id: 'child-1', cause: { kind: 'user' }, options: { keepInbox: false } }),
    JSON.stringify(seen.agentCancels[0])
  )
  check(
    'B3 prompt 发到子会话、queue、带上文本',
    seen.prompt[0]?.sessionId === 'child-1' && seen.prompt[0]?.mode === 'queue' && seen.prompt[0]?.content?.[0]?.text === '第二句（改过）',
    JSON.stringify(seen.prompt[0])
  )
  check('B3 prompt 带 requestId', typeof seen.prompt[0]?.requestId === 'string' && seen.prompt[0].requestId.length > 0, String(seen.prompt[0]?.requestId))
  check(
    'B3 prompt 带上 AbortSignal（漏了会当场抛 throwIfAborted）',
    seen.promptSignal !== undefined && typeof seen.promptSignal.throwIfAborted === 'function' && seen.promptSignal.aborted === false,
    String(seen.promptSignal)
  )
  check('B3 顺序 = fork → 清待办 → rename → prompt', seen.order.join(',') === 'fork,clear-inbox,rename,prompt', seen.order.join(','))

  // 连着切两次：第二次要拿到没被占用的序号（用户报的「永远是 (1)」）
  const again = await (await commit.fetch(commitRequest({ sessionId: 's1', turn: 2, text: '第二句', titles: ['我的会话', '我的会话 (1)'] }))).json()
  check('B3 第二次切拿到 (2)', again.ok === true && seen.rename[1]?.title === '我的会话 (2)', JSON.stringify(seen.rename[1]))

  // 第一轮不走 fork，也不该去动标题/清待办
  const agentCancelsBefore = seen.agentCancels.length
  const first = await (await commit.fetch(commitRequest({ sessionId: 's1', turn: 1, text: '第一句' }))).json()
  check('B3 第一轮走 create（kind=create）', first.ok === true && first.kind === 'create' && first.childId === 'created-1', JSON.stringify(first))
  check('B3 第一轮没有种子，不用清待办', seen.agentCancels.length === agentCancelsBefore)
}

/* -------------------------------------------------------------------------- */
/* B4. 第一轮新建会话：必须带上工作区（分组）                                  */
/* -------------------------------------------------------------------------- */

{
  const { ctx, seen } = fakeHost({ events: log3, workspaces: [{ id: 'ws-9', sessionIds: ['s1'] }] })
  hostModule.apply(ctx)
  const payload = await (await routeOf(seen, COMMIT_PATH).fetch(commitRequest({ sessionId: 's1', turn: 1, text: '第一句' }))).json()
  check('B4 第一轮 ok', payload.ok === true && payload.kind === 'create', JSON.stringify(payload))
  check('B4 带上源会话所属的工作区', JSON.stringify(seen.create[0]) === JSON.stringify({ workspaceId: 'ws-9' }), JSON.stringify(seen.create[0]))
  check('B4 不把 workspaceId 和 cwd 一起给（宿主会直接报错）', seen.create[0]?.cwd === undefined)
  check('B4 新会话里发原文', seen.prompt[0]?.sessionId === 'created-1' && seen.prompt[0]?.content?.[0]?.text === '第一句', JSON.stringify(seen.prompt[0]))
}

{
  // 没有 workspaceRegistry（别的部署）→ 退回用会话自己的 cwd
  const { ctx, seen } = fakeHost({ events: log3, cwd: 'D:/somewhere' })
  hostModule.apply(ctx)
  const payload = await (await routeOf(seen, COMMIT_PATH).fetch(commitRequest({ sessionId: 's1', turn: 1, text: '第一句' }))).json()
  check('B4 没有工作区服务 → 按会话的 cwd 新建', payload.ok === true && JSON.stringify(seen.create[0]) === JSON.stringify({ cwd: 'D:/somewhere' }), JSON.stringify(seen.create[0]))

  // 有服务但这个会话不归任何工作区 → 同样退回 cwd
  const other = fakeHost({ events: log3, cwd: 'D:/elsewhere', workspaces: [{ id: 'ws-1', sessionIds: ['别的会话'] }] })
  hostModule.apply(other.ctx)
  await routeOf(other.seen, COMMIT_PATH).fetch(commitRequest({ sessionId: 's1', turn: 1, text: '第一句' }))
  check('B4 会话不属于任何工作区 → 按 cwd 新建', JSON.stringify(other.seen.create[0]) === JSON.stringify({ cwd: 'D:/elsewhere' }), JSON.stringify(other.seen.create[0]))
}

/* -------------------------------------------------------------------------- */
/* B5. 正在跑的这一轮：先 cancel 再切                                          */
/* -------------------------------------------------------------------------- */

{
  const openLog = [...turnLog(1, '第一句', 0), ev(10, 'turn/start', { turn: 2 }), ev(11, 'user/message', { id: 'm2', content: [{ type: 'text', text: '第二句' }], source: { kind: 'user' }, surfaceOp: 'append' })]
  const { ctx, seen } = fakeHost({ events: withTitle(openLog, '我的会话') })
  hostModule.apply(ctx)
  const payload = await (await routeOf(seen, COMMIT_PATH).fetch(commitRequest({ sessionId: 's1', turn: 2, text: '第二句' }))).json()
  check('B5 没跑完也能切', payload.ok === true && payload.kind === 'fork', JSON.stringify(payload))
  check('B5 先 cancel 父会话那一轮', JSON.stringify(seen.cancel[0]) === JSON.stringify({ sessionId: 's1' }), JSON.stringify(seen.cancel[0]))
  check('B5 顺序 = cancel → fork → 清待办 → rename → prompt', seen.order.join(',') === 'cancel,fork,clear-inbox,rename,prompt', seen.order.join(','))
}

/* -------------------------------------------------------------------------- */
/* B6. 失败路径                                                                */
/* -------------------------------------------------------------------------- */

{
  // 模型路由不通 → 原样把宿主的错报回去
  const { ctx, seen } = fakeHost({ events: log3, promptFails: true })
  hostModule.apply(ctx)
  const payload = await (await routeOf(seen, COMMIT_PATH).fetch(commitRequest({ sessionId: 's1', turn: 2, text: '第二句' }))).json()
  check('B6 prompt 失败 → COMMIT_FAILED', payload.ok === false && payload.code === 'COMMIT_FAILED', JSON.stringify(payload))
  check('B6 失败原因带 provider 信息', String(payload.message).includes('model-unavailable'), String(payload.message))
}

{
  // 工作区没了 / 建会话被拒
  const { ctx, seen } = fakeHost({ events: log3, workspaces: [{ id: 'ws-1', sessionIds: ['s1'] }], createFails: true })
  hostModule.apply(ctx)
  const payload = await (await routeOf(seen, COMMIT_PATH).fetch(commitRequest({ sessionId: 's1', turn: 1, text: '第一句' }))).json()
  check('B6 建会话失败 → COMMIT_FAILED', payload.ok === false && payload.code === 'COMMIT_FAILED', JSON.stringify(payload))
  check('B6 建会话失败不发消息', seen.prompt.length === 0)
}

{
  // fork 被拒（比如源会话还在被别的地方改）
  const { ctx, seen } = fakeHost({ events: log3, forkFails: true })
  hostModule.apply(ctx)
  const payload = await (await routeOf(seen, COMMIT_PATH).fetch(commitRequest({ sessionId: 's1', turn: 2, text: '第二句' }))).json()
  check('B6 fork 失败 → COMMIT_FAILED', payload.ok === false && payload.code === 'COMMIT_FAILED', JSON.stringify(payload))
}

{
  // 参数与业务校验
  const { ctx, seen } = fakeHost({ events: log3 })
  hostModule.apply(ctx)
  const commit = routeOf(seen, COMMIT_PATH)
  const cases = [
    ['空文本', { sessionId: 's1', turn: 1, text: '  ' }, 'EMPTY_TEXT'],
    ['缺 sessionId', { turn: 1, text: 'x' }, 'BAD_SESSION'],
    ['轮次号非法', { sessionId: 's1', turn: 0, text: 'x' }, 'BAD_TURN'],
    ['轮次不存在', { sessionId: 's1', turn: 9, text: 'x' }, 'TURN_NOT_FOUND']
  ]
  for (const [label, body, code] of cases) {
    const payload = await (await commit.fetch(commitRequest(body))).json()
    check(`B6 ${label} → ${code}`, payload.ok === false && payload.code === code, JSON.stringify(payload))
  }
  const badJson = await (await commit.fetch(commitRequest('{不是 json'))).json()
  check('B6 坏 JSON → BAD_BODY', badJson.ok === false && badJson.code === 'BAD_BODY', JSON.stringify(badJson))
  check('B6 校验失败都不碰会话', seen.create.length === 0 && seen.fork.length === 0 && seen.prompt.length === 0)
}

/* -------------------------------------------------------------------------- */
/* B7. 分支标题规则（序号不能重复）                                            */
/* -------------------------------------------------------------------------- */

{
  const { branchTitle, splitTrailingNumber } = hostModule.internals ?? {}
  check('B7 导出 internals.branchTitle', typeof branchTitle === 'function')
  if (typeof branchTitle === 'function') {
    check('B7 没序号、也没别的会话 → (1)', branchTitle('我的会话', []) === '我的会话 (1)', branchTitle('我的会话', []))
    check(
      'B7 已有 (1) → 给 (2)',
      branchTitle('我的会话', ['我的会话', '我的会话 (1)']) === '我的会话 (2)',
      branchTitle('我的会话', ['我的会话', '我的会话 (1)'])
    )
    check(
      'B7 跳着占号也能接上（有 (1)(2) → (3)）',
      branchTitle('我的会话', ['我的会话 (1)', '我的会话 (2)']) === '我的会话 (3)',
      branchTitle('我的会话', ['我的会话 (1)', '我的会话 (2)'])
    )
    check(
      'B7 别的会话的同名标题不算占位',
      branchTitle('我的会话', ['别的会话 (7)', '我的会话语 (2)']) === '我的会话 (1)',
      branchTitle('我的会话', ['别的会话 (7)', '我的会话语 (2)'])
    )
    check('B7 源自己带序号 → 至少 +1', branchTitle('我的会话 (3)', []) === '我的会话 (4)', branchTitle('我的会话 (3)', []))
    check(
      'B7 全角序号也认（（9）→（10））',
      branchTitle('我的会话（9）', []) === '我的会话 (10)',
      branchTitle('我的会话（9）', [])
    )
    check('B7 中间有括号不算序号', branchTitle('修 (a) 的 bug', []) === '修 (a) 的 bug (1)', branchTitle('修 (a) 的 bug', []))
    check('B7 splitTrailingNumber 拆得对', JSON.stringify(splitTrailingNumber('x（12）')) === JSON.stringify({ base: 'x', number: 12 }), JSON.stringify(splitTrailingNumber('x（12）')))
  }
}

/* ========================================================================== */
/* C. 浏览器半边                                                              */
/* ========================================================================== */

console.log('--- 浏览器半边（lib/client.js）---')

/* -------------------------------------------------------------------------- */
/* 假 DOM                                                                     */
/* -------------------------------------------------------------------------- */

const camel = (name) => name.replace(/-([a-z0-9])/g, (_, ch) => ch.toUpperCase())

class FakeNode {
  constructor(tagName, owner) {
    this.nodeType = 1
    this.tagName = String(tagName || 'div').toUpperCase()
    this.ownerDocument = owner
    this.childNodes = []
    this.parentNode = null
    this.attributes = {}
    this.dataset = {}
    this.style = {}
    this.className = ''
    this.textContent = ''
    this.innerHTML = ''
    this.value = ''
    this.disabled = false
    this.type = ''
    this.listeners = {}
  }

  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1)
  }

  get parentElement() {
    return this.parentNode !== null && this.parentNode.nodeType === 1 ? this.parentNode : null
  }

  get nextSibling() {
    if (this.parentNode === null) return null
    const index = this.parentNode.childNodes.indexOf(this)
    return index < 0 ? null : this.parentNode.childNodes[index + 1] ?? null
  }

  get firstChild() {
    return this.childNodes[0] ?? null
  }

  setAttribute(name, value) {
    const text = String(value)
    this.attributes[name] = text
    if (name.startsWith('data-')) this.dataset[camel(name.slice(5))] = text
  }

  getAttribute(name) {
    const value = this.attributes[name]
    return value === undefined ? null : value
  }

  removeAttribute(name) {
    delete this.attributes[name]
    if (name.startsWith('data-')) delete this.dataset[camel(name.slice(5))]
  }

  appendChild(node) {
    if (node.parentNode !== null) node.parentNode.removeChild(node)
    node.parentNode = this
    this.childNodes.push(node)
    return node
  }

  insertBefore(node, reference) {
    if (node.parentNode !== null) node.parentNode.removeChild(node)
    if (reference === null || reference === undefined) return this.appendChild(node)
    const index = this.childNodes.indexOf(reference)
    node.parentNode = this
    if (index < 0) this.childNodes.push(node)
    else this.childNodes.splice(index, 0, node)
    return node
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node)
    if (index >= 0) this.childNodes.splice(index, 1)
    node.parentNode = null
    return node
  }

  addEventListener(type, handler) {
    const list = (this.listeners[type] ??= [])
    list.push(handler)
  }

  removeEventListener(type, handler) {
    const list = this.listeners[type]
    if (list === undefined) return
    const index = list.indexOf(handler)
    if (index >= 0) list.splice(index, 1)
  }

  /** 测试里手动派发（真浏览器里点一下就是这个）。 */
  dispatch(type) {
    const event = { type, target: this, preventDefault() {}, stopPropagation() {} }
    for (const handler of [...(this.listeners[type] ?? [])]) handler(event)
    return event
  }

  focus() {
    this.ownerDocument.activeElement = this
  }

  setSelectionRange() {}
}

class FakeDocument {
  constructor() {
    this.head = new FakeNode('head', this)
    this.body = new FakeNode('body', this)
    this.documentElement = new FakeNode('html', this)
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
    this.listeners = {}
    this.activeElement = null
  }

  createElement(tag) {
    return new FakeNode(tag, this)
  }

  /** 只用于「CSS 插过没有」的去重判断，这里永远当没有。 */
  querySelector() {
    return null
  }

  addEventListener(type, handler) {
    const list = (this.listeners[type] ??= [])
    list.push(handler)
  }

  removeEventListener(type, handler) {
    const list = this.listeners[type]
    if (list === undefined) return
    const index = list.indexOf(handler)
    if (index >= 0) list.splice(index, 1)
  }

  dispatch(type) {
    for (const handler of [...(this.listeners[type] ?? [])]) handler({ type, target: this })
  }
}

const observers = []

class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback
    this.active = false
    observers.push(this)
  }

  observe(target, options) {
    this.target = target
    this.options = options
    this.active = true
  }

  disconnect() {
    this.active = false
  }

  /** 手动喂一批新增节点（真浏览器里 DOM 变了就自动回调）。 */
  emit(addedNodes) {
    if (this.active) this.callback([{ addedNodes }], this)
  }
}

/* -------------------------------------------------------------------------- */
/* 装全局                                                                     */
/* -------------------------------------------------------------------------- */

let doc = new FakeDocument()
let fetchHandler = async () => jsonResponse({ ok: false, code: 'NO_HANDLER', message: '没设 fetch 处理器' })
const fetchCalls = []
let injectedCss = ''
let definition = null

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload
})

globalThis.document = doc
globalThis.MutationObserver = FakeMutationObserver
globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url, options })
  return fetchHandler(url, options)
}
globalThis.window = {
  __ModuleLoader__: {
    load: (value) => {
      definition = value
    }
  }
}

/** 换一套全新的假 DOM（每个用例干净起步）。 */
function resetDom() {
  doc = new FakeDocument()
  globalThis.document = doc
  observers.length = 0
  fetchCalls.length = 0
  fetchHandler = async () => jsonResponse({ ok: false, code: 'NO_HANDLER', message: '没设 fetch 处理器' })
  return doc
}

await import(pathToFileURL(join(pluginDir, 'lib', 'client.js')).href)
check('C0 client.js 走模块加载器注册', definition?.id === 'dsh-ui-retry', String(definition?.id))

const exported = definition.factory(() => {
  throw new Error('浏览器半边不应该 require 任何模块')
})
check('C0 导出 apply / inject', typeof exported.apply === 'function' && Array.isArray(exported.inject))
check("C0 inject = ['sessions']", exported.inject.length === 1 && exported.inject[0] === 'sessions', exported.inject.join(','))

// CSS 已经通过假 document.head 收上来了（模块物化时就注入了）
{
  const collect = (node) => {
    for (const child of node.childNodes) {
      injectedCss += child.textContent ?? ''
      collect(child)
    }
  }
  collect(doc.head)
  check('C0 注入的 CSS 带 dshr- 前缀', injectedCss.includes('.dshr-action{'))
  check('C0 按钮尺寸跟着内容字号走', injectedCss.includes('var(--dsh-content-font-delta,0px)'))
}

/* -------------------------------------------------------------------------- */
/* 假会话服务                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 造一份假客户端会话服务。
 *
 * 建分支和发消息都在宿主做了（见 retry.mjs），浏览器这半边只剩：定位当前会话、
 * 读接口、POST、刷列表、切过去 —— 所以这里只要记 `refresh` / `open`。
 */
function fakeSessions(overrides = {}) {
  const calls = { refresh: 0, open: [] }
  const sessions = {
    list: {
      getSnapshot: () => ({
        current: overrides.current === null ? undefined : (overrides.current ?? 's1'),
        byId: {
          s1: { id: 's1', cwd: 'D:/work', title: '我的会话' },
          s2: { id: 's2', cwd: 'D:/work', title: '我的会话 (1)' }
        }
      })
    },
    refresh: async () => {
      calls.refresh += 1
      if (overrides.refreshFails === true) throw new Error('刷新失败')
    },
    open: (id) => {
      calls.open.push(id)
      if (overrides.openFails === true) throw new Error('列表里没有这个会话')
    }
  }
  return { sessions, calls }
}

/**
 * 装两段假响应。`http500` 表示这一路直接回 500（接口没挂上）。
 *
 * @param routes - `{origin, commit}` 各自的 JSON 载荷。
 */
function setApi(routes) {
  fetchHandler = async (url) => {
    const text = String(url)
    if (text.includes('/api/dsh-ui-retry.commit')) {
      return routes.commit === 'http500' ? jsonResponse({ ok: false }, 500) : jsonResponse(routes.commit)
    }
    if (text.includes('/api/dsh-ui-retry.origin')) {
      return routes.origin === 'http500' ? jsonResponse({ ok: false }, 500) : jsonResponse(routes.origin)
    }
    return jsonResponse({ ok: false, code: 'NO_HANDLER', message: '没设 fetch 处理器' })
  }
}

/**
 * 造一行用户消息。
 *
 * @param doc - 假 document。
 * @param options - `turn` 轮次号（不传就没有 data-chat-turn）、`kind` 行类型、`text` 气泡里的文字。
 */
function userRow(doc, { turn = 1, kind = 'user', text = '你好', withCopy = true } = {}) {
  const row = doc.createElement('div')
  row.setAttribute('data-chat-flow-kind', kind)
  if (turn !== null) row.setAttribute('data-chat-turn', String(turn))
  row.setAttribute('data-chat-flow-key', `input-message:m${String(turn)}`)
  const bubble = doc.createElement('div')
  bubble.className = 'bubble'
  bubble.textContent = text
  const box = doc.createElement('div')
  box.className = 'xzv4MW_actions'
  if (withCopy) {
    const copy = doc.createElement('button')
    copy.className = 'xzv4MW_action'
    copy.setAttribute('aria-label', '复制')
    copy.innerHTML = '<svg></svg>'
    box.appendChild(copy)
  }
  row.appendChild(bubble)
  row.appendChild(box)
  return row
}

/** 行里我们的按钮（按插入顺序）。 */
function ourButtons(row) {
  const found = []
  const stack = [row]
  while (stack.length > 0) {
    const node = stack.pop()
    for (const child of [...node.children].reverse()) stack.push(child)
    if (node.getAttribute?.('data-dshr-ui') === '1' && node.tagName === 'BUTTON') found.push(node)
  }
  return found
}

/** 页面上所有带某个 class 的节点（弹窗 / 提示条用）。 */
function findAll(root, className) {
  const found = []
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    const names = String(node.className ?? '').split(/\s+/)
    if (names.includes(className)) found.push(node)
    for (const child of [...node.children].reverse()) stack.push(child)
  }
  return found
}

/** 等一个条件成立（点按钮之后的异步链路用）。 */
async function waitFor(predicate, label, timeoutMs = 1500) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(5)
  }
  check(`等待「${label}」超时`, false)
  return false
}

/* -------------------------------------------------------------------------- */
/* C1. 注入                                                                   */
/* -------------------------------------------------------------------------- */

{
  resetDom()
  const flow = doc.createElement('div')
  flow.setAttribute('data-chat-flow', '')
  const first = userRow(doc, { turn: 1, text: '第一句' })
  const second = userRow(doc, { turn: 2, text: '第二句' })
  const steering = userRow(doc, { turn: 2, kind: 'steering', text: '插一句' })
  const noTurn = userRow(doc, { turn: null, text: '本地回显' })
  const assistant = doc.createElement('div')
  assistant.setAttribute('data-chat-flow-kind', 'assistant')
  assistant.setAttribute('data-chat-turn', '1')
  const copy = doc.createElement('button')
  copy.className = 'xzv4MW_action'
  assistant.appendChild(copy)
  for (const node of [first, assistant, second, steering, noTurn]) flow.appendChild(node)
  doc.body.appendChild(flow)

  const { sessions } = fakeSessions()
  exported.apply({ sessions })

  check('C1 用户行插了 2 个按钮', ourButtons(first).length === 2 && ourButtons(second).length === 2, `${String(ourButtons(first).length)} / ${String(ourButtons(second).length)}`)
  check('C1 助手行不插', ourButtons(assistant).length === 0)
  check('C1 steering 行不插（没有「这一轮」的概念）', ourButtons(steering).length === 0)
  check('C1 没有轮次号的行不插（本地回显）', ourButtons(noTurn).length === 0)
  const actions = first.children[1].childNodes.map((node) => node.getAttribute('data-dshr-action')).filter((value) => value !== null)
  check('C1 按钮顺序 = 复制 → 编辑 → 重试', actions.join(',') === 'edit,retry', actions.join(','))
  check('C1 复制按钮仍在最前', String(first.children[1].childNodes[0]?.getAttribute('aria-label')) === '复制')
  check('C1 编辑按钮的可访问名', String(ourButtons(first)[0].getAttribute('aria-label')).includes('编辑'))
  check('C1 重试按钮的可访问名', String(ourButtons(first)[1].getAttribute('aria-label')).includes('重试'))

  // 重复扫不插重（观察器会反复扫到同一行）
  const observer = observers.find((item) => item.active === true)
  observer.emit([first])
  observer.emit([second])
  await sleep(160)
  check('C1 重复扫不插重', ourButtons(first).length === 2 && ourButtons(second).length === 2, `${String(ourButtons(first).length)} / ${String(ourButtons(second).length)}`)

  // 行被 React 重建（旧节点整个换掉）→ 新行自己长回按钮
  const late = userRow(doc, { turn: 3, text: '第三句' })
  flow.appendChild(late)
  observer.emit([late])
  await waitFor(() => ourButtons(late).length === 2, '新行长回按钮')
  check('C1 新出现的行会自己长回按钮', ourButtons(late).length === 2)

  // 重新 apply（热重载）不会插成两套
  exported.apply({ sessions })
  check('C1 重新 apply 后仍只有 2 个按钮', ourButtons(first).length === 2, String(ourButtons(first).length))

  window.__DSH_UI_RETRY__.dispose()
  check('C1 dispose 摘干净', ourButtons(first).length === 0 && ourButtons(late).length === 0)
}

/* -------------------------------------------------------------------------- */
/* C2. 重试                                                                   */
/* -------------------------------------------------------------------------- */

{
  resetDom()
  const row = userRow(doc, { turn: 2, text: '第二句' })
  doc.body.appendChild(row)

  const { sessions, calls } = fakeSessions()
  setApi({
    origin: { ok: true, turn: 2, atSeq: 14, first: false, open: false, text: '第二句', attachments: 0 },
    commit: { ok: true, childId: 'child-1', kind: 'fork', turn: 2 }
  })
  exported.apply({ sessions })

  ourButtons(row)[1].dispatch('click')

  await waitFor(() => calls.open.length === 1, '切到新分支')
  check('C2 读接口带上了 sessionId / turn', String(fetchCalls[0]?.url).includes('/api/dsh-ui-retry.origin?sessionId=s1&turn=2'), String(fetchCalls[0]?.url))
  const commitCall = fetchCalls.find((call) => String(call.url).includes('/api/dsh-ui-retry.commit'))
  check('C2 重发走 POST + JSON', commitCall?.options?.method === 'POST' && String(commitCall?.options?.headers?.['content-type'] ?? '').includes('json'), JSON.stringify(commitCall?.options))
  let posted = {}
  try {
    posted = JSON.parse(String(commitCall?.options?.body ?? '{}'))
  } catch {
    posted = {}
  }
  check(
    'C2 POST 体 = {sessionId, turn, text, titles}',
    posted.sessionId === 's1' && posted.turn === 2 && posted.text === '第二句' && Array.isArray(posted.titles) && posted.titles.includes('我的会话'),
    JSON.stringify(posted)
  )
  check('C2 刷了会话列表', calls.refresh >= 1, String(calls.refresh))
  check('C2 切到新分支', calls.open[0] === 'child-1', JSON.stringify(calls.open))

  await waitFor(() => findAll(doc.body, 'dshr-toast').length > 0, '提示条')
  const toastText = String(findAll(doc.body, 'dshr-toast')[0]?.textContent ?? '')
  check('C2 提示条说明是新分支', toastText.includes('新分支') && toastText.includes('第 2 轮'), toastText)
}

/* -------------------------------------------------------------------------- */
/* C3. 编辑                                                                   */
/* -------------------------------------------------------------------------- */

{
  resetDom()
  const row = userRow(doc, { turn: 2, text: '第二句（界面上的样子）' })
  doc.body.appendChild(row)

  const { sessions, calls } = fakeSessions()
  setApi({
    origin: { ok: true, turn: 2, atSeq: 14, first: false, open: false, text: '第二句（日志里的原文）', attachments: 1 },
    commit: { ok: true, childId: 'child-1', kind: 'fork', turn: 2 }
  })
  exported.apply({ sessions })

  ourButtons(row)[0].dispatch('click')

  await waitFor(() => findAll(doc.body, 'dshr-panel').length > 0, '编辑弹窗')
  const panel = findAll(doc.body, 'dshr-panel')[0]
  check('C3 弹窗里填的是日志原文（不是界面渲染出来的文本）', panel !== undefined && findAll(panel, 'dshr-input')[0]?.value === '第二句（日志里的原文）', String(findAll(panel, 'dshr-input')[0]?.value))
  check('C3 附件带不上要提示', String(findAll(panel, 'dshr-note')[0]?.textContent ?? '').includes('1 个附件'))
  check('C3 还没点发送就不该发出去', fetchCalls.length === 1, String(fetchCalls.length))

  const input = findAll(panel, 'dshr-input')[0]
  input.value = '改过的第二句'
  findAll(panel, 'dshr-btnPrimary')[0].dispatch('click')

  await waitFor(() => calls.open.length === 1, '编辑后发出并切过去')
  const commitCall = fetchCalls.find((call) => String(call.url).includes('/api/dsh-ui-retry.commit'))
  let posted = {}
  try {
    posted = JSON.parse(String(commitCall?.options?.body ?? '{}'))
  } catch {
    posted = {}
  }
  check('C3 发送用的是改后的文本', posted.text === '改过的第二句' && posted.turn === 2, JSON.stringify(posted))
  await waitFor(() => findAll(doc.body, 'dshr-panel').length === 0, '弹窗关闭')
  check('C3 发完关窗', findAll(doc.body, 'dshr-panel').length === 0)
}

/* -------------------------------------------------------------------------- */
/* C4. 失败路径                                                                */
/* -------------------------------------------------------------------------- */

{
  // 宿主业务失败（比如只有附件）→ 提示条带原因，不发 POST
  resetDom()
  const row = userRow(doc, { turn: 2, text: '第二句' })
  doc.body.appendChild(row)
  const { sessions, calls } = fakeSessions()
  setApi({ origin: { ok: false, code: 'EMPTY_TEXT', message: '第 2 轮只有附件、没有正文' } })
  exported.apply({ sessions })
  ourButtons(row)[1].dispatch('click')
  await waitFor(() => findAll(doc.body, 'dshr-toast').length > 0, '失败提示条')
  const text = String(findAll(doc.body, 'dshr-toast')[0]?.textContent ?? '')
  check('C4 业务失败弹提示条', text.includes('重试失败') && text.includes('只有附件'), text)
  check('C4 业务失败不发 POST', fetchCalls.length === 1, String(fetchCalls.length))
  check('C4 业务失败不切会话', calls.open.length === 0)
}

{
  // 读接口 500（插件没开）→ 提示条说清楚
  resetDom()
  const row = userRow(doc, { turn: 2, text: '第二句' })
  doc.body.appendChild(row)
  const { sessions } = fakeSessions()
  setApi({ origin: 'http500', commit: { ok: true, childId: 'child-1' } })
  exported.apply({ sessions })
  ourButtons(row)[1].dispatch('click')
  await waitFor(() => findAll(doc.body, 'dshr-toast').length > 0, 'HTTP 失败提示条')
  const text = String(findAll(doc.body, 'dshr-toast')[0]?.textContent ?? '')
  check('C4 接口不可用时的提示能看懂', text.includes('HTTP 500') && text.includes('插件'), text)
}

{
  // 宿主收下了但没做成（模型路由不通等）→ 原样报出来
  resetDom()
  const row = userRow(doc, { turn: 2, text: '第二句' })
  doc.body.appendChild(row)
  const { sessions, calls } = fakeSessions()
  setApi({
    origin: { ok: true, turn: 2, atSeq: 14, first: false, open: false, text: '第二句', attachments: 0 },
    commit: { ok: false, code: 'COMMIT_FAILED', message: 'session/model-unavailable: 没有可用的模型' }
  })
  exported.apply({ sessions })
  ourButtons(row)[1].dispatch('click')
  await waitFor(() => findAll(doc.body, 'dshr-toast').length > 0, '重发失败提示条')
  const text = String(findAll(doc.body, 'dshr-toast')[0]?.textContent ?? '')
  check('C4 重发失败原样报原因', text.includes('没有可用的模型'), text)
  check('C4 重发失败不切会话', calls.open.length === 0)
}

{
  // 重发接口本身 500
  resetDom()
  const row = userRow(doc, { turn: 2, text: '第二句' })
  doc.body.appendChild(row)
  const { sessions } = fakeSessions()
  setApi({
    origin: { ok: true, turn: 2, atSeq: 14, first: false, open: false, text: '第二句', attachments: 0 },
    commit: 'http500'
  })
  exported.apply({ sessions })
  ourButtons(row)[1].dispatch('click')
  await waitFor(() => findAll(doc.body, 'dshr-toast').length > 0, '重发接口 500 提示条')
  check('C4 重发接口不可用有提示', String(findAll(doc.body, 'dshr-toast')[0]?.textContent ?? '').includes('HTTP 500'), String(findAll(doc.body, 'dshr-toast')[0]?.textContent ?? ''))
}

{
  // 分支建好了但界面切不过去（列表里还没有）→ 不算失败，提示去侧边栏点开
  resetDom()
  const row = userRow(doc, { turn: 2, text: '第二句' })
  doc.body.appendChild(row)
  const { sessions, calls } = fakeSessions({ openFails: true })
  setApi({
    origin: { ok: true, turn: 2, atSeq: 14, first: false, open: false, text: '第二句', attachments: 0 },
    commit: { ok: true, childId: 'child-1', kind: 'fork', turn: 2 }
  })
  exported.apply({ sessions })
  ourButtons(row)[1].dispatch('click')
  await waitFor(() => findAll(doc.body, 'dshr-toast').length > 0, '切不过去的提示条')
  const text = String(findAll(doc.body, 'dshr-toast')[0]?.textContent ?? '')
  check('C4 切不过去也报成功（分支已经建好）', text.includes('新分支') && !text.includes('失败'), text)
  check('C4 切不过去时提示去侧边栏', text.includes('侧边栏'), text)
  check('C4 切不过去时重试过刷新', calls.refresh >= 2, String(calls.refresh))
}

{
  // 没有打开的会话
  resetDom()
  const row = userRow(doc, { turn: 2, text: '第二句' })
  doc.body.appendChild(row)
  const { sessions } = fakeSessions({ current: null })
  setApi({ origin: { ok: true, turn: 2, atSeq: 14, first: false, open: false, text: '第二句', attachments: 0 }, commit: { ok: true, childId: 'c' } })
  exported.apply({ sessions })
  ourButtons(row)[1].dispatch('click')
  await waitFor(() => findAll(doc.body, 'dshr-toast').length > 0, '无会话提示条')
  check('C4 没有当前会话时提示', String(findAll(doc.body, 'dshr-toast')[0]?.textContent ?? '').includes('没有打开的会话'), String(findAll(doc.body, 'dshr-toast')[0]?.textContent ?? ''))
  check('C4 没有当前会话时不发请求', fetchCalls.length === 0)
}

/* -------------------------------------------------------------------------- */
/* 结果                                                                       */
/* -------------------------------------------------------------------------- */

console.log('')
if (failures === 0) {
  console.log('全部通过。')
} else {
  console.log(`有 ${String(failures)} 项没过。`)
}
process.exit(failures === 0 ? 0 : 1)
