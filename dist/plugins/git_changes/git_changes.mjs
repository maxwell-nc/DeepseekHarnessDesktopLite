/**
 * git_changes.mjs —— dsh-git-changes 宿主入口（host 半边）。
 *
 * 绑定「当前对话的仓库」：通过 sessionQuery 读取当前会话的 header.cwd，向上定位
 * 其所属 git 仓库根（git rev-parse --show-toplevel）。之后所有 git 命令都以该仓库
 * 根为工作目录执行。
 *
 * 提供两组能力（通过 connection 的鉴权通道暴露 /api/git_changes.*）：
 *   1. 本地变更（localChanges）：git status --porcelain=v1 -z 列出所有变更文件
 *      （含未跟踪、不含忽略），每个文件可查看相对 HEAD 的差异；支持复制代码、
 *      单个/批量回滚（已跟踪用 git restore，未跟踪直接删除文件）。
 *   2. 提交日志（log）：git log --all -200 列出所有分支最近 200 条提交，每条可
 *      查看改动的文件（git show --name-status -z）与文件内容差异（git show）。
 *      日志只读，不支持回滚。
 */

import { execFile } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

export const name = 'git_changes'

const TAG = '[dsh-git-changes]'

/** 本地变更里，一个文件的状态码（git status --porcelain=v1 的 XY）。 */
const STATUS = {
  UNTRACKED: '??',
  ADDED: 'A',
  MODIFIED: 'M',
  DELETED: 'D',
  RENAMED: 'R',
  COPIED: 'C',
  TYPE_CHANGED: 'T',
  UNMERGED: 'U',
}

/** 运行 git 命令。root 为仓库根（-C 指定）。 */
function runGit(root, args, timeout = 20000) {
  return new Promise((done) => {
    try {
      execFile(
        'git',
        ['-C', root, ...args],
        { timeout, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => done({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      )
    } catch (e) {
      done({ ok: false, stdout: '', stderr: String(e?.message ?? e) })
    }
  })
}

/** 从某个目录向上定位它所属的 git 仓库根。 */
function gitRootOf(dir) {
  if (!dir) return Promise.resolve(null)
  return runGit(dir, ['rev-parse', '--show-toplevel'], 4000).then((r) => {
    const top = r.ok ? String(r.stdout).trim() : ''
    return top ? top : null
  })
}

/** 判断一段文本是否可视为文本（避免把二进制当 diff 展示）。 */
function isText(s) {
  if (s === null || s === undefined) return false
  const str = String(s)
  if (str.length === 0) return true
  const sample = str.slice(0, 8000)
  let bad = 0
  for (let i = 0; i < sample.length; i += 1) {
    const c = sample.charCodeAt(i)
    if (c === 0) return false
    if (c < 9 || (c > 13 && c < 32) || c === 127) bad += 1
  }
  return bad / sample.length < 0.1
}

/** 安全读取文件内容；不存在返回 null。 */
function safeRead(abs) {
  try {
    return readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

/** 把绝对路径转成相对仓库根的 posix 路径。 */
function relToRoot(abs, root) {
  const rel = relative(root, abs)
  return rel.startsWith('..') ? abs : rel.split(sep).join('/')
}

/**
 * 解析 `git status --porcelain=v1 -z` 输出。
 * 格式：`XY path\0`，重命名/复制为 `XY old\0new\0`。
 * 返回 [{ x, y, path, oldPath }]。
 */
function parseStatusZ(buf) {
  const out = []
  const parts = String(buf).split('\0')
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i]
    if (!p) continue
    const x = p[0]
    const y = p[1]
    let path = p.slice(3)
    let oldPath = null
    if ((x === STATUS.RENAMED || x === STATUS.COPIED) && i + 1 < parts.length) {
      oldPath = path
      path = parts[i + 1]
      i += 1
    }
    out.push({ x, y, path, oldPath })
  }
  return out
}

/**
 * 解析 `git show --name-status -z` 输出（提交改动的文件列表）。
 * 格式：`XY\0path\0`（状态后直接跟 NUL），重命名/复制为 `R100\0old\0new\0`。
 */
function parseNameStatusZ(buf) {
  const out = []
  const parts = String(buf).split('\0')
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i]
    if (!p) continue
    const m = /^([MADRCUTX?])(\d*)$/.exec(p)
    if (!m) continue
    const x = m[1]
    let path = parts[i + 1] ?? ''
    i += 1
    let oldPath = null
    if ((x === STATUS.RENAMED || x === STATUS.COPIED) && i + 1 < parts.length) {
      oldPath = path
      path = parts[i + 1]
      i += 1
    }
    out.push({ x, y: '', path, oldPath })
  }
  return out
}

/** 状态码 → 中文标签。 */
function statusLabel(x, y) {
  if (x === '?' && y === '?') return '未跟踪'
  if (x === STATUS.ADDED) return '新增'
  if (x === STATUS.DELETED) return '删除'
  if (x === STATUS.RENAMED) return '重命名'
  if (x === STATUS.COPIED) return '复制'
  if (x === STATUS.TYPE_CHANGED) return '类型变更'
  if (x === STATUS.UNMERGED) return '冲突'
  if (x === STATUS.MODIFIED) return '修改'
  if (y === STATUS.MODIFIED) return '已暂存修改'
  if (y === STATUS.ADDED) return '已暂存新增'
  if (y === STATUS.DELETED) return '已暂存删除'
  return '变更'
}

/**
 * 解析 `git diff` / `git show` 的 unified diff 文本，拆成带行号的差异块。
 * 返回 { hunks: [{ oldStart, oldLines, newStart, newLines, lines: [{type, text}] }], binary }。
 * type: 'ctx' | 'del' | 'add'。
 */
function parseUnifiedDiff(text) {
  const hunks = []
  let cur = null
  let binary = false
  const lines = String(text).split('\n')
  for (const line of lines) {
    if (line.startsWith('Binary files')) {
      binary = true
      continue
    }
    const hdr = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hdr) {
      if (cur) hunks.push(cur)
      cur = {
        oldStart: Number(hdr[1]),
        oldLines: hdr[2] ? Number(hdr[2]) : 1,
        newStart: Number(hdr[3]),
        newLines: hdr[4] ? Number(hdr[4]) : 1,
        lines: [],
      }
      continue
    }
    if (!cur) continue
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ')) continue
    if (line.startsWith('+')) {
      cur.lines.push({ type: 'add', text: line.slice(1) })
    } else if (line.startsWith('-')) {
      cur.lines.push({ type: 'del', text: line.slice(1) })
    } else {
      cur.lines.push({ type: 'ctx', text: line.slice(1) })
    }
  }
  if (cur) hunks.push(cur)
  return { hunks, binary }
}

/** 从 unified diff 里提取「新增侧」的完整文本（用于复制代码）。 */
function newTextOf(hunks) {
  const lines = []
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.type === 'add' || l.type === 'ctx') lines.push(l.text)
    }
  }
  return lines.join('\n')
}

/** 从 unified diff 里提取「删除侧」的完整文本。 */
function oldTextOf(hunks) {
  const lines = []
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.type === 'del' || l.type === 'ctx') lines.push(l.text)
    }
  }
  return lines.join('\n')
}

export function apply(ctx) {
  // 当前绑定的仓库根（绝对路径）。由 sessionQuery 读取当前会话 cwd 后定位。
  let repoRoot = null
  let repoError = ''
  let boundSessionId = null

  /** 用当前会话的 cwd 定位仓库根。 */
  async function bindToSession(sessionId) {
    try {
      const sq = ctx.get('sessionQuery')
      if (!sq) {
        repoError = 'sessionQuery 服务不可用'
        return null
      }
      const obs = await sq.observeSession(sessionId, { projectionMode: 'none' })
      let cwd = null
      try {
        cwd = obs && obs.header && obs.header.cwd
      } finally {
        // 观察是一次可释放的租约：读完 header 就释放，避免长期占用
        try { if (obs && typeof obs[Symbol.dispose] === 'function') obs[Symbol.dispose]() } catch { /* ignore */ }
      }
      if (!cwd) {
        repoError = '当前会话没有工作目录'
        return null
      }
      const root = await gitRootOf(cwd)
      if (!root) {
        repoError = '当前工作目录不在 git 仓库内'
        return null
      }
      repoRoot = root
      boundSessionId = sessionId
      repoError = ''
      return root
    } catch (e) {
      repoError = String(e?.message ?? e)
      return null
    }
  }

  /** 确保已绑定仓库；会话变了就重新绑定。 */
  async function ensureRepo(sessionId) {
    if (repoRoot && boundSessionId === sessionId) return repoRoot
    return bindToSession(sessionId)
  }

  /** 本地变更列表。 */
  async function localChanges(sessionId) {
    const root = await ensureRepo(sessionId)
    if (!root) return { ok: false, error: repoError || '未绑定仓库', repoRoot: null }
    const status = await runGit(root, ['status', '--porcelain=v1', '-z', '-uall'])
    if (!status.ok) return { ok: false, error: 'git status 失败：' + status.stderr, repoRoot: root }
    const entries = parseStatusZ(status.stdout)
    const files = []
    for (const e of entries) {
      const abs = join(root, e.path)
      const isUntracked = e.x === '?' && e.y === '?'
      const isDeleted = e.x === STATUS.DELETED || e.y === STATUS.DELETED
      files.push({
        path: e.path,
        oldPath: e.oldPath,
        abs,
        status: statusLabel(e.x, e.y),
        code: e.x + e.y,
        untracked: isUntracked,
        deleted: isDeleted,
      })
    }
    return { ok: true, repoRoot: root, files }
  }

  /** 单个本地变更文件的差异（相对 HEAD）。 */
  async function localFileDiff(sessionId, relPath) {
    const root = await ensureRepo(sessionId)
    if (!root) return { ok: false, error: repoError || '未绑定仓库' }
    const tracked = await runGit(root, ['ls-files', '--error-unmatch', '--', relPath], 4000)
    const isUntracked = !tracked.ok
    let diffText = ''
    if (isUntracked) {
      // 未跟踪文件：与 /dev/null 对比（整文件新增）。git diff --no-index 有差异时
      // 退出码为 1，但 stdout 仍是完整 diff，所以只看 stdout。
      const d = await runGit(root, ['diff', '--no-index', '--no-color', '--unified=3', '/dev/null', relPath], 15000)
      diffText = d.stdout
    } else {
      const d = await runGit(root, ['diff', '--no-color', '--unified=3', 'HEAD', '--', relPath], 15000)
      diffText = d.ok ? d.stdout : ''
    }
    const parsed = parseUnifiedDiff(diffText)
    const binary = parsed.binary
    return {
      ok: true,
      path: relPath,
      hunks: parsed.hunks,
      binary,
      newText: binary ? '' : newTextOf(parsed.hunks),
      oldText: binary ? '' : oldTextOf(parsed.hunks),
    }
  }

  /** 回滚本地变更。files 为相对路径数组；untracked 直接删除，其余 git restore。 */
  async function revertLocal(sessionId, files) {
    const root = await ensureRepo(sessionId)
    if (!root) return { ok: false, error: repoError || '未绑定仓库' }
    if (!Array.isArray(files) || files.length === 0) return { ok: false, error: '没有指定要回滚的文件' }
    const done = []
    const errors = []
    for (const rel of files) {
      const abs = join(root, rel)
      const isUntracked = (await runGit(root, ['ls-files', '--error-unmatch', '--', rel], 4000)).ok === false
      if (isUntracked) {
        try {
          rmSync(abs, { force: true })
          done.push(rel)
        } catch (e) {
          errors.push(rel + '：' + String(e?.message ?? e))
        }
      } else {
        const r = await runGit(root, ['restore', '--staged', '--worktree', '--', rel], 15000)
        if (r.ok) done.push(rel)
        else errors.push(rel + '：' + r.stderr.trim())
      }
    }
    return { ok: errors.length === 0, done, errors }
  }

  /** 提交日志（所有分支，最多 200 条）。 */
  async function logList(sessionId) {
    const root = await ensureRepo(sessionId)
    if (!root) return { ok: false, error: repoError || '未绑定仓库', repoRoot: null }
    const r = await runGit(root, [
      'log', '--all', '-200',
      '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%D',
      '--date=format:%Y-%m-%d %H:%M:%S',
    ], 20000)
    if (!r.ok) return { ok: false, error: 'git log 失败：' + r.stderr, repoRoot: root }
    const commits = []
    for (const line of String(r.stdout).split('\n')) {
      if (!line) continue
      const [hash, short, author, email, date, subject, refs] = line.split('\x1f')
      commits.push({ hash, short, author, email, date, subject, refs: refs || '' })
    }
    return { ok: true, repoRoot: root, commits }
  }

  /** 某次提交改动的文件列表。 */
  async function logFiles(sessionId, hash) {
    const root = await ensureRepo(sessionId)
    if (!root) return { ok: false, error: repoError || '未绑定仓库' }
    // --root：兼容仓库首个提交（没有父提交时 git show 默认不输出内容）
    const r = await runGit(root, ['show', '--root', '--name-status', '-z', '--format=', hash], 15000)
    if (!r.ok) return { ok: false, error: 'git show 失败：' + r.stderr }
    const entries = parseNameStatusZ(r.stdout)
    const files = entries.map((e) => ({
      path: e.path,
      oldPath: e.oldPath,
      status: statusLabel(e.x, e.y),
      code: e.x + e.y,
    }))
    return { ok: true, files }
  }

  /** 某次提交里某个文件的差异。 */
  async function logFileDiff(sessionId, hash, relPath) {
    const root = await ensureRepo(sessionId)
    if (!root) return { ok: false, error: repoError || '未绑定仓库' }
    const r = await runGit(root, ['show', '--root', '--format=', '--no-color', '--unified=3', hash, '--', relPath], 15000)
    if (!r.ok) return { ok: false, error: 'git show 失败：' + r.stderr }
    const parsed = parseUnifiedDiff(r.stdout)
    const binary = parsed.binary
    return {
      ok: true,
      path: relPath,
      hunks: parsed.hunks,
      binary,
      newText: binary ? '' : newTextOf(parsed.hunks),
      oldText: binary ? '' : oldTextOf(parsed.hunks),
    }
  }

  // 注册 API 路由（connection 鉴权通道）。
  ctx.inject(['connection'], (scoped) => {
    try {
      const conn = scoped.connection.fetch
      const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } })

      // 绑定当前会话的仓库
      conn.register({
        path: '/api/git_changes.bind',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            const body = await request.json()
            const root = await bindToSession(body?.sessionId)
            return json({ ok: !!root, repoRoot: root, error: repoError })
          } catch (e) {
            return json({ ok: false, error: String(e?.message ?? e) }, 500)
          }
        },
      })

      // 本地变更列表
      conn.register({
        path: '/api/git_changes.local',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            const body = await request.json()
            const out = await localChanges(body?.sessionId)
            return json(out)
          } catch (e) {
            return json({ ok: false, error: String(e?.message ?? e) }, 500)
          }
        },
      })

      // 单个本地变更文件的差异
      conn.register({
        path: '/api/git_changes.local.diff',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            const body = await request.json()
            const out = await localFileDiff(body?.sessionId, body?.path)
            return json(out)
          } catch (e) {
            return json({ ok: false, error: String(e?.message ?? e) }, 500)
          }
        },
      })

      // 回滚本地变更（单个或批量）
      conn.register({
        path: '/api/git_changes.local.revert',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            const body = await request.json()
            const out = await revertLocal(body?.sessionId, body?.files)
            return json(out)
          } catch (e) {
            return json({ ok: false, error: String(e?.message ?? e) }, 500)
          }
        },
      })

      // 提交日志
      conn.register({
        path: '/api/git_changes.log',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            const body = await request.json()
            const out = await logList(body?.sessionId)
            return json(out)
          } catch (e) {
            return json({ ok: false, error: String(e?.message ?? e) }, 500)
          }
        },
      })

      // 某次提交改动的文件列表
      conn.register({
        path: '/api/git_changes.log.files',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            const body = await request.json()
            const out = await logFiles(body?.sessionId, body?.hash)
            return json(out)
          } catch (e) {
            return json({ ok: false, error: String(e?.message ?? e) }, 500)
          }
        },
      })

      // 某次提交里某个文件的差异
      conn.register({
        path: '/api/git_changes.log.diff',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            const body = await request.json()
            const out = await logFileDiff(body?.sessionId, body?.hash, body?.path)
            return json(out)
          } catch (e) {
            return json({ ok: false, error: String(e?.message ?? e) }, 500)
          }
        },
      })

      console.error(`${TAG} API = /api/git_changes.* 已注册`)
    } catch (error) {
      console.error(`${TAG} 注册 API 失败：${String(error?.message ?? error)}`)
    }
  })

  console.error(`${TAG} 插件已加载`)
}

export default { name, apply }