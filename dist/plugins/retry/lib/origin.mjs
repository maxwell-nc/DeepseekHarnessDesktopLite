/**
 * 会话日志 → 「这一轮能不能重发 / 从哪儿切 / 原文是什么」
 * ======================================================
 *
 * **纯函数**，不碰任何 dsh 服务、不读文件、不发请求：进来一个事件数组和一个轮次号，
 * 出去一个结论。宿主半边（retry.mjs）拿它算接口响应，自测（src/tools）直接喂假日志。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要它（设计约束都在这里）
 *
 * dsh 的会话日志是**只追加**的：一条用户消息发出去、模型答完，这些事件就钉在日志里了。
 * 界面上那个「分支」按钮走的也是这条路 —— `sessions.fork({sessionId, atSeq})` 把
 * 「某一轮之前的历史」复制成一个**新会话**，原会话原样留着。所以「编辑重发 / 重试这一轮」
 * 在 dsh 里只能是：
 *
 *     在这一轮之前切一刀 → 新分支 → 把（改过的）文本作为新的一轮发出去
 *
 * 而不是「就地改写历史」。后者在 dsh 的数据模型里虽然存在（surface 的 replace 操作），
 * 但**界面不认**：可见记录只由 append 事件拼出来，替换只影响模型看到的内容 ——
 * 结果是「你看得见旧回答、模型看不见」，两边对不上。所以别往那个方向做。
 *
 * fork 的切点语义（宿主 `session.fork` 的实现）：
 *
 *     boundary = 第一个 seq >= atSeq 的 turn/end   // 想切在「第 N 轮之前」，
 *     cut      = boundary.seq + 1 起往后找到下一个 turn/start
 *     seed     = events.slice(0, cut)
 *
 * 所以只要把 atSeq 指到**第 N-1 轮的 turn/end**，切出来的子会话就正好停在
 * 第 N 轮的 turn/start 之前 —— 这就是我们要的「这一轮之前」。合法区间是
 * **(第 N-2 轮的 turn/end, 第 N-1 轮的 turn/end]**：落在这个区间里的任何 seq 都会
 * 让「第一个 >= 它的 turn/end」等于第 N-1 轮的那个。直接取第 N-1 轮的 turn/end 最省事；
 * 给第 N 轮里面的任何 seq 会把切点推到第 N 轮自己的结尾（那是分支按钮的行为）；
 *
 * **第一轮没有「前一轮」**：没有 turn/end 可指，fork 不出来。这种情况界面那边改成
 * 新建一个会话（`sessions.create({cwd})`）再发 —— 效果一样（本来就是从头开始）。
 * 这里用 `first: true` 把这个事实告诉它。
 *
 * **这一轮还没跑完（拿不到 turn/end）**：能切（切点在第 N 轮之前，与它跑没跑完无关），
 * 但直接切会把「还在生成的那一轮」晾在父会话里继续烧 token。所以标成 `open: true`，
 * 界面先 `session.cancel()` 把父会话那一轮停掉再切。
 */

/** 解析失败时的统一形状：`{ok:false, code, message}`。 */
function fail(code, message) {
  return { ok: false, code, message }
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
 * 从一条 `user/message` 事件里取「用户自己写的」内容。
 *
 * `data.source.kind !== "user"` 的是**注入的上下文**（系统塞进来的东西，界面渲染成
 * context 行而不是用户气泡）；surface 替换（compaction 之类）出来的副本也不进可见
 * 会话，所以都跳过。
 *
 * @param event - 候选事件。
 * @returns 内容，或者 undefined 表示「不是一条用户消息」。
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
 * 算一轮的重发信息。
 *
 * @param events - 会话日志（按 seq 升序；来自 sessionQuery 观察或 Session.snapshotEvents）。
 * @param turn - 目标轮次（界面上 `data-chat-turn` 那个整数）。
 * @returns `{ok:true, turn, atSeq, first, open, text, attachments}`，或者
 *   `{ok:false, code, message}`（code 见下面各分支）。
 */
export function resolveOrigin(events, turn) {
  if (!Number.isSafeInteger(turn) || turn < 1) return fail('BAD_TURN', '轮次号不合法')
  const log = Array.isArray(events) ? events : []
  if (log.length === 0) return fail('NO_LOG', '这个会话还没有任何记录')

  let start = -1
  for (let index = 0; index < log.length; index += 1) {
    const event = log[index]
    if (event?.type === 'turn/start' && event.data?.turn === turn) {
      start = index
      break
    }
  }
  if (start < 0) return fail('TURN_NOT_FOUND', `会话日志里没有第 ${String(turn)} 轮`)

  // 这一轮结束了没有（下一个 turn/start 之前有没有自己的 turn/end）
  let ended = false
  let text = ''
  let attachments = 0
  let found = false
  for (let index = start + 1; index < log.length; index += 1) {
    const event = log[index]
    if (event?.type === 'turn/start') break
    if (event?.type === 'turn/end' && event.data?.turn === turn) ended = true
    if (found) continue
    const content = userContentOf(event)
    if (content === undefined) continue
    // 一轮可能有多条用户消息（中途 steering）。取**第一条**：这轮的起始消息，
    // 也就是界面上 kind 是 user 的那一行（steering 那些渲染成 kind=steering）。
    text = content.text
    attachments = content.attachments
    found = true
  }
  if (!found) return fail('NO_MESSAGE', `第 ${String(turn)} 轮没有用户消息，没法重发`)
  if (text.trim().length === 0) {
    return fail(
      'EMPTY_TEXT',
      attachments > 0
        ? `第 ${String(turn)} 轮只有附件、没有正文，重发不了（附件没法重新上传）`
        : `第 ${String(turn)} 轮的用户消息是空的`
    )
  }

  // 切点：这一轮之前最近的那个 turn/end（任意轮都行，不一定是第 N-1 轮：
  // 中间可能有 compaction 之类的轮间事件）
  let atSeq = null
  for (let index = start - 1; index >= 0; index -= 1) {
    const event = log[index]
    if (event?.type === 'turn/end' && Number.isSafeInteger(event.seq)) {
      atSeq = event.seq
      break
    }
  }

  return {
    ok: true,
    turn,
    atSeq,
    first: atSeq === null,
    open: !ended,
    text,
    attachments
  }
}

export default { resolveOrigin }
