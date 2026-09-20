/**
 * dsh-ui-retry —— 宿主半边（读日志算切点 + 真的去建分支并重发）
 * ==============================================================
 *
 * 两条鉴权过的接口（走 connection 的 `/api` 通道，页面里同源 fetch 即可）：
 *
 *   GET  /api/dsh-ui-retry.origin?sessionId=…&turn=…
 *        「这一轮能不能重发、从哪个事件切、原文是什么」——**只读**。
 *   POST /api/dsh-ui-retry.commit   {sessionId, turn, text}
 *        建分支（或第一轮新建会话）→ 把 text 发出去 → 返回新会话 id。**有副作用**。
 *
 * 为什么建分支 + 发消息这两步放在**宿主**而不是浏览器半边（本来是那样）：
 *
 * 1. **分组**。侧边栏是按**工作区**分组的，而归属关系记在工作区那边
 *    （`workspaceRegistry` 的 `sessionIds`），会话的 header 里没有这个字段。所以
 *    「第一轮没有前一轮的 turn/end 可指 → 新建会话」这条路必须把 `workspaceId`
 *    交给宿主，否则新会话不属于任何工作区，侧边栏里会掉进「未分组」。
 *    工作区归属在宿主这边是现成的（`forkWorkspace()` 用的同一份数据），不用让
 *    浏览器去猜。
 * 2. **少一个时序坑**。浏览器那边发消息要先 `sessions.binding(childId)` 拿到会话面，
 *    新会话刚建出来时不一定立刻挂得上；而且 `prompt` 的模型选择、附件准入、
 *    resume/adopt 这套逻辑本来就在宿主的 `sessionController.prompt()` 里。
 *    直接调它，等于走的就是浏览器那条 RPC 的同一段代码。
 *
 * 浏览器半边只负责：读 origin → POST commit → `sessions.refresh()` → `open(childId)`。
 *
 * ---------------------------------------------------------------------------
 * 关键约定（别随手改）
 *
 * **切点算的是「这一轮之前」**：`atSeq` 指向第 N 轮之前最近的那个 `turn/end`。
 * 合法区间是 (第 N-2 轮的 turn/end, 第 N-1 轮的 turn/end]，取第 N-1 轮的那个最直接。
 * 宿主 `session.fork` 的语义是「第一个 seq >= atSeq 的 turn/end」，给第 N 轮里的
 * 任何 seq 都会切成「含第 N 轮」——那是内置分支按钮的行为，不是重试。
 *
 * **第一轮没有可指的 turn/end**：`resolveOrigin` 回 `first: true`，这里改成
 * `sessionController.create({workspaceId | cwd})`（宿主会拿工作区的 path 当 cwd
 * 并把新会话挂进那个工作区）。
 *
 * **这一轮还没跑完**：`open: true`，先 `sessionController.cancel({sessionId})`
 * （和界面上的停止按钮同一条路径）再切。fork 的切点在这一轮之前，不等它收尾也切得动。
 *
 * **fork 出来的子会话要自增标题**：子和父否则同名，侧边栏里分不清。规则和内置信的
 * `increasedForkTitle` 一致（不带序号 → ` (1)`，带序号 → 序号 +1，全角括号也认）。
 *
 * **任何异常都吞掉**：插件崩了不能连带 dsh 起不来。
 *
 * 环境变量：
 *   DSH_UI_RETRY_QUIET=1   不打启动横幅
 */

import { randomUUID } from 'node:crypto'

import { resolveOrigin } from './lib/origin.mjs'

/** 稳定的 cordis 插件名。 */
export const name = 'dsh-ui-retry'

const TAG = '[dsh-ui-retry]'

/** 关掉启动横幅。 */
const QUIET = (process.env.DSH_UI_RETRY_QUIET ?? '') === '1'

/** 只读入口：算切点 + 原文。 */
const API_ORIGIN = '/api/dsh-ui-retry.origin'

/** 动入口：建分支 + 发出去。 */
const API_COMMIT = '/api/dsh-ui-retry.commit'

/** 统一 JSON 响应：业务失败也是 200 + `ok:false`，让浏览器那边只认一个开关。 */
function json(payload) {
  return Response.json(payload, { headers: { 'cache-control': 'no-store' } })
}

/**
 * 取一个服务：优先 `ctx.get()`（cordis 的正规入口），退回属性访问。
 *
 * 两个都要 try —— cordis 的服务是访问器，拿不到的服务名有的版本直接抛，
 * 有的给 undefined，这里统一成 undefined。
 *
 * @param ctx - 任意 cordis context。
 * @param id - 服务名。
 * @returns 服务实例，或 undefined。
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
        // 观测租约释放失败不影响响应
      }
      return
    }
  }
}

/**
 * 读一份会话日志（冷热通吃）。
 *
 * @param ctx - 宿主侧 context。
 * @param sessionId - 会话 id。
 * @returns `{events, header}`（events 按 seq 升序）。
 * @throws 当两条路都拿不到日志时。
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
        return { events, header: observed?.header ?? undefined }
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

/**
 * 这个会话归哪个工作区管（侧边栏就是按它分组的）。
 *
 * 和宿主 `fork` 里的 `forkWorkspace()` 看的是同一份数据：工作区实体的 `sessionIds`。
 * 拿不到就返回 undefined，调用方退化成「按 cwd 新建」。
 *
 * @param ctx - 宿主侧 context。
 * @param sessionId - 源会话 id。
 * @returns 工作区 id，或 undefined。
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

/**
 * 会话日志里最后一条标题（没有就 undefined）。
 *
 * 标题是 `session/title` 事件，log-only、不进模型历史，最新一条赢。
 */
function titleOf(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'session/title') continue
    const title = event.data?.title
    return typeof title === 'string' && title.trim().length > 0 ? title : undefined
  }
  return undefined
}

/**
 * 把标题拆成「base + 结尾序号」，认半角 ` (n)` 和全角 `（n）`。
 *
 * 没有序号时 number 是 0 —— 0 表示「没占位」，不是「第 0 个」。
 *
 * @param title - 标题。
 * @returns `{base, number}`。
 */
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

/**
 * 给分支起名：`base (n)`，n 取「现有标题里没被占过」的下一个。
 *
 * 为什么不直接「源标题 +1」（内置分支按钮的 `increasedForkTitle` 就是那么干的）：
 * 连着从**同一个会话**切两次，源标题一直是 `base`，两次都得到 `base (1)` ——
 * 侧边栏里两个同名分支（用户报过这个）。所以拿**现存标题**当占位表：凡是 base
 * 相同、带序号的都算占过，取 max+1；源标题自己带的序号也参与（源是 `base (1)`
 * 时至少从 2 开始，不会和源撞名）。
 *
 * `titles` 为空（别的调用方、自测）时退化成 `base (1)`。
 *
 * @param sourceTitle - 源会话的标题。
 * @param titles - 现有会话标题（可选，由浏览器送来，越全越准）。
 * @returns 子会话该用的标题。
 */
function branchTitle(sourceTitle, titles) {
  const source = splitTrailingNumber(sourceTitle)
  let max = source.number > 0 ? source.number : 0
  for (const title of Array.isArray(titles) ? titles : []) {
    if (typeof title !== 'string') continue
    const parsed = splitTrailingNumber(title)
    if (parsed.base.length === 0 || parsed.base !== source.base) continue
    if (parsed.number > max) max = parsed.number
  }
  return `${source.base} (${String(max + 1)})`
}

/**
 * 子会话标题自增。失败不影响主流程（只是侧边栏里父子同名而已）。
 *
 * @param controller - sessionController。
 * @param events - 源会话的日志（用来取源标题）。
 * @param titles - 现有会话标题（浏览器送来）。
 * @param childId - 子会话 id。
 */
async function renameChild(controller, events, titles, childId) {
  const title = titleOf(events)
  if (title === undefined) return
  try {
    await controller.rename({ sessionId: childId, title: branchTitle(title, titles) })
  } catch (error) {
    console.error(`${TAG} 分支标题自增失败：${reasonOf(error)}`)
  }
}

/**
 * 清掉子会话**种子里带过来的**幽灵待办。
 *
 * fork 的切点在「上一轮的 turn/end」和「这一轮的 turn/start」之间，而**这一轮那条
 * 用户消息的 inbox splice（插入）正好落在这个区间里**，配对的「移除」splice 在
 * turn/start 之后 —— 于是子会话按日志重建收件箱时，会把那条旧消息当成**待发**复活。
 * 结果是：先跑一遍旧消息（用户看到「原来那条没去掉」），再把重发的那条接在后面。
 *
 * `agent.cancel(cause, {keepInbox:false})` 就是清收件箱（界面的停止按钮用的是
 * `keepInbox:true`，那是「保留待办，只中断这一轮」）。必须在 `prompt` **之前**清，
 * 否则把我们自己刚发的那条也一起清掉了。
 *
 * @param ctx - 宿主侧 context。
 * @param childId - 子会话 id。
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

/**
 * 处理 `GET /api/dsh-ui-retry.origin?sessionId=…&turn=…`。
 *
 * @param ctx - 宿主侧 context。
 * @param request - 已过围栏与鉴权的请求。
 * @returns 响应：`{ok:true, turn, atSeq, first, open, text, attachments}` 或
 *   `{ok:false, code, message}`。
 */
async function handleOrigin(ctx, request) {
  try {
    const url = new URL(request.url)
    const sessionId = (url.searchParams.get('sessionId') ?? '').trim()
    if (sessionId.length === 0) return json({ ok: false, code: 'BAD_SESSION', message: '缺少 sessionId' })
    const raw = (url.searchParams.get('turn') ?? '').trim()
    const turn = Number.parseInt(raw, 10)
    if (!Number.isSafeInteger(turn) || turn <= 0) {
      return json({ ok: false, code: 'BAD_TURN', message: `轮次号不合法：${JSON.stringify(raw)}` })
    }
    const { events } = await readLog(ctx, sessionId)
    return json(resolveOrigin(events, turn))
  } catch (error) {
    const message = reasonOf(error)
    console.error(`${TAG} 算切点失败：${message}`)
    return json({ ok: false, code: 'INTERNAL', message })
  }
}

/**
 * 处理 `POST /api/dsh-ui-retry.commit`。
 *
 * 请求体：`{sessionId, turn, text}`。
 * 响应：`{ok:true, childId, kind:'fork'|'create', turn}` 或 `{ok:false, code, message}`。
 *
 * 顺序：停掉正在跑的那一轮（如果切的是它）→ 建分支 → 子会话标题自增 →
 * 把文本作为新的一轮发出去。
 *
 * @param ctx - 宿主侧 context。
 * @param request - 已过围栏与鉴权的请求。
 * @returns 响应。
 */
async function handleCommit(ctx, request) {
  let body
  try {
    body = await request.json()
  } catch (error) {
    return json({ ok: false, code: 'BAD_BODY', message: `请求体不是合法 JSON：${reasonOf(error)}` })
  }
  if (body === null || typeof body !== 'object') {
    return json({ ok: false, code: 'BAD_BODY', message: '请求体不是一个对象' })
  }
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  if (sessionId.length === 0) return json({ ok: false, code: 'BAD_SESSION', message: '缺少 sessionId' })
  const turn = Number.parseInt(String(body.turn ?? ''), 10)
  if (!Number.isSafeInteger(turn) || turn <= 0) {
    return json({ ok: false, code: 'BAD_TURN', message: '轮次号不合法' })
  }
  const text = typeof body.text === 'string' ? body.text : ''
  if (text.trim().length === 0) return json({ ok: false, code: 'EMPTY_TEXT', message: '内容不能是空的' })
  // 现有会话标题（浏览器送来的一整份列表），用来给分支起一个没被占用的序号
  const titles = Array.isArray(body.titles) ? body.titles.filter((title) => typeof title === 'string') : []

  const controller = service(ctx, 'sessionController')
  if (controller === undefined || typeof controller.prompt !== 'function') {
    return json({ ok: false, code: 'NO_CONTROLLER', message: '宿主没有会话控制器（不是 web profile？）' })
  }

  try {
    const { events, header } = await readLog(ctx, sessionId)
    const origin = resolveOrigin(events, turn)
    if (origin.ok !== true) return json(origin)

    if (origin.open === true) {
      try {
        await controller.cancel({ sessionId })
      } catch (error) {
        // 停不下来也照样能切（切点在这一轮之前）
        console.error(`${TAG} 停止正在跑的那一轮失败：${reasonOf(error)}`)
      }
    }

    let childId
    let kind
    if (origin.first === true) {
      const workspaceId = workspaceOwnerOf(ctx, sessionId)
      const cwd = typeof header?.cwd === 'string' && header.cwd.length > 0 ? header.cwd : undefined
      // 宿主只收一个：给了 workspaceId 就用工作区的 path 当 cwd，并把这个会话挂进该工作区
      const created = await controller.create(
        workspaceId !== undefined ? { workspaceId } : cwd !== undefined ? { cwd } : {}
      )
      childId = created.sessionId
      kind = 'create'
    } else {
      const forked = await controller.fork({ sessionId, atSeq: origin.atSeq })
      childId = forked.sessionId
      kind = 'fork'
      // 先清种子里复活的旧消息，再改名、再发 —— 顺序错了会把我们自己的消息清掉（见函数注释）
      clearInheritedInbox(ctx, childId)
      await renameChild(controller, events, titles, childId)
    }

    await controller.prompt(
      {
        requestId: randomUUID(),
        sessionId: childId,
        mode: 'queue',
        content: [{ type: 'text', text }]
      },
      // 这个 signal 是**必填**的（RPC 那层拿它做「准入前的取消」，内部直接
      // `signal.throwIfAborted()`）。不传就是 `undefined.throwIfAborted()` 当场炸 ——
      // 实测踩过：`Cannot read properties of undefined (reading 'throwIfAborted')`。
      new AbortController().signal
    )
    return json({ ok: true, childId, kind, turn, text })
  } catch (error) {
    const message = reasonOf(error)
    console.error(`${TAG} 重发失败：${message}`)
    return json({ ok: false, code: 'COMMIT_FAILED', message })
  }
}

/**
 * 挂上两条接口。
 *
 * `connection` 只有 web profile 提供，所以用 `ctx.inject` 按需绑定而不是写进静态
 * `inject` —— 否则在 headless / tui 里插件会一直 pending（那边本来也没有界面要点它）。
 *
 * @param ctx - 宿主侧插件 context。
 */
export function apply(ctx) {
  ctx.inject(['connection'], (scoped) => {
    // 一条一条注册、各自 try：热重载时上一条还没释放的话，
    // 共用一个 try 会让**后面那条**被连坐（注册接口时踩过：commit 一直 404）
    const routes = [
      { path: API_ORIGIN, methods: ['GET'], fetch: (request) => handleOrigin(ctx, request) },
      { path: API_COMMIT, methods: ['POST'], fetch: (request) => handleCommit(ctx, request) }
    ]
    for (const route of routes) {
      try {
        scoped.connection.fetch.register({ ...route, requestBody: 'buffered' })
        if (!QUIET) console.error(`${TAG} 接口已注册：${route.methods.join('/')} ${route.path}`)
      } catch (error) {
        console.error(`${TAG} 注册 ${route.path} 失败：${reasonOf(error)}`)
      }
    }
  })
}

export default { name, apply }

/** 给自测用的内部件（`src/tools/probe_retry_checks.mjs` 直接对答案）。 */
export const internals = { branchTitle, splitTrailingNumber, titleOf, workspaceOwnerOf }
