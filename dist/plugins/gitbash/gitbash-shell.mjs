/**
 * dsh-bash-gitbash —— 纯插件版：Windows 上把 shell 执行器换成 Git Bash，
 * 并把模型看到的 shell 工具从 `pwsh` 改名成 `bash`。
 *
 * 与旧版（preset + 插件两层）的区别：**不再需要 agent 预设**。
 * 旧方案要动两个平面：
 *   host  平面：谁提供 ctx.shell            -> cordis.patch.yml
 *   agent 平面：模型看到 bash 还是 pwsh     -> $DSH_HOME/.agent-presets/gitbash
 * 现在两个平面都在本文件里解决：
 *   host  平面：本类就是 ctx.shell 的提供方（继承上游执行器，只换 argv[0]）。
 *   agent 平面：不注册新工具，而是**拦截工具注册**——上游 `dsh-tool-pwsh`
 *               注册 `pwsh` 工具时，本插件把这份定义改写名字与提示词，
 *               于是模型看到的是 `bash` + Git Bash 的命令规范。
 *               工具的执行体一行未改，它照旧走 `ctx.shell`，也就是 Git Bash。
 *
 * ---------------------------------------------------------------------------
 * 为什么非要这个插件（下面每条都是实测结论，不是推测）
 *
 * 1) dsh 的 bash 执行器把 `bash` 硬编码成 argv[0]
 *    （@deepseek-ai/dsh-bash-local 的 run() 就是 ["bash","-c",cmd]），没有配置项能改。
 *
 * 2) Windows 上 `bash` 根本解析不出来。Git for Windows 只把 `C:\Program Files\Git\cmd`
 *    加进 PATH，那里只有 git.exe；bash.exe 在 `Git\bin` 和 `Git\usr\bin`，都不在 PATH 上。
 *    所以 spawn("bash") 必然 ENOENT。
 *
 * 3) Git 自带的两个 bash 不等价，选错会得到一个"空壳 shell"：
 *      Git\usr\bin\bash.exe -c 'command -v ls'  ->  找不到（非登录 shell，PATH 里没有 /usr/bin）
 *      Git\bin\bash.exe     -c 'command -v ls'  ->  /usr/bin/ls  ✓
 *    所以固定优先选 Git\bin\bash.exe（它的 wrapper 会先把 /mingw64/bin:/usr/bin 塞进 PATH）。
 *
 * 4) 【最关键】Git Bash 跑不了 dsh 的 Windows ACL 沙箱。
 *    实测（dsh-sandbox-windows-acl/lib/runner.js 的 argv 契约直接调）：
 *      cmd.exe / node.exe  ->  ok
 *      Git\bin\bash.exe    ->  "couldn't create signal pipe, Win32 error 5"，exit 127
 *    MSYS2 运行时要在内核对象命名空间建信号管道，受限令牌不给权限。
 *    结论：这不是配置问题，绕不过去 —— 所以本插件**默认不带沙箱**。
 *
 *    代价（必须知道）：shell 命令以 harness 自身权限运行，不再受 workspace-write /
 *    read-only 的文件访问限制。文件工具那条路径不受影响（dsh-fs-sandbox 是独立体系）。
 *
 * 5) 执行器必须声明一个 sandboxMode，否则 profile 直接加载失败：
 *      dsh-permission-presets 构造函数第一件事就是
 *        if (ctx.shell.sandboxMode === void 0) throw ...
 *    上游基类 ShellExecutor 的 getter 返回 undefined（语义是"本执行器不做限制"），
 *    照抄就加载不起来。这里如实转述**部署的**沙箱模式（ctx.sandboxPolicy.defaultMode，
 *    即 DSH_PERMISSION_MODE），原因：
 *      - permission 预设的推导结果与上游完全一致；
 *      - 文件工具那条路径仍按这个模式围栏（dsh-fs-sandbox 自己读 ctx.sandboxPolicy）；
 *      - 若谎报 danger-full-access 反而更糟：pinInitialPermission 会把会话模式钉成
 *        danger-full-access，于是连文件围栏一起被解掉。
 *    剩下唯一的偏差：shell 命令这一步不真正执行该模式，见第 4 条。
 *
 * 6) 改工具名的机制：`ctx.tools` 是 host 平面唯一的工具注册表（dsh-base 的 `tools` 行），
 *    agent 预设里的工具行都是往**同一个实例**注册（跨 scope 共享，this.ctx 由 cordis
 *    的 tracker 按调用方作用域重绑）。所以在本插件里给 `ToolRuntime.prototype.register`
 *    套一层，就能覆盖到所有作用域——包括 per-preset 的注册。上游 `register` 本身
 *    只做校验 + 按名字入表，改写发生在入表之前，后续的 view/schemaOf/dispatch 全都
 *    自然读到新名字，模型看到的 schema 与可调用的名字始终一致。
 *    本插件不新增工具、不改执行体，最小侵入。
 *
 * 7) 插件的裸包名（@deepseek-ai/*）是按**插件文件自己的位置**做 Node 解析的，不是按 profile。
 *    所以插件离开 $DSH_HOME/profiles/ 后 `import '@deepseek-ai/dsh-bash-local'` 会
 *    ERR_MODULE_NOT_FOUND。→ 用下面的 hostImport()：从 dsh 运行时自己的 node_modules
 *    解析包入口再 import。这样插件放哪儿都能加载，也不用往项目里塞 node_modules。
 *
 * 环境变量：
 *   DSH_GIT_BASH=<路径>            显式指定 bash，优先于自动探测
 *   DSH_GITBASH_SANDBOX=1          改用沙箱执行器（MSYS2 下会 error 5）
 *   DSH_GITBASH_MODULE_ROOT=<路径> 显式指定 dsh 运行时的 node_modules（默认自动探测）
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const TAG = '[dsh-bash-gitbash]'

/* -------------------------------------------------------------------------- */
/* 解析 dsh 运行时自己的包                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 候选的 node_modules 根，按可信度排列。`undefined` 表示"让 Node 按本文件位置
 * 正常解析"，留作兜底（插件本来就放在 profile 里时走这条）。
 */
function moduleRoots() {
  const roots = []
  const explicit = (process.env.DSH_GITBASH_MODULE_ROOT ?? '').trim()
  if (explicit) roots.push(explicit)

  // 从 dsh 入口脚本往上找：<runtime>/node_modules/@deepseek-ai/dsh/lib/bin.js
  const entry = process.argv[1]
  if (typeof entry === 'string' && entry.length > 0) {
    let dir = dirname(entry)
    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = join(dir, 'node_modules')
      if (existsSync(join(candidate, '@deepseek-ai'))) {
        roots.push(candidate)
        break
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }

  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    if (local) roots.push(join(local, 'DeepSeekHarness', 'runtime', 'node_modules'))
  }

  roots.push(undefined)
  return roots
}

/** 解析 dsh 自己的包：先按候选根试，最后退回按本文件位置正常解析。 */
function resolveHost(specifier) {
  for (const root of moduleRoots()) {
    try {
      return require.resolve(specifier, root === undefined ? undefined : { paths: [root] })
    } catch {
      // 换下一个候选
    }
  }
  throw new Error(
    `${TAG} 解析不到 ${specifier}。` +
      '请把 dsh 运行时的 node_modules 路径写进 DSH_GITBASH_MODULE_ROOT。'
  )
}

const loadHost = async (specifier) => import(pathToFileURL(resolveHost(specifier)).href)
const { LocalBashExecutor } = await loadHost('@deepseek-ai/dsh-bash-local')
const { SandboxBashExecutor } = await loadHost('@deepseek-ai/dsh-bash-sandbox')

/* -------------------------------------------------------------------------- */
/* Git Bash 定位                                                                */
/* -------------------------------------------------------------------------- */

/** 探测顺序：显式指定 -> 各平台常见安装位置 -> 退回让系统按 PATH 解析。 */
function candidates() {
  const list = []
  const explicit = (process.env.DSH_GIT_BASH ?? '').trim()
  if (explicit) list.push(explicit)

  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const local = process.env.LOCALAPPDATA
    // 顺序有意义：Git\bin 的 wrapper 才带得动 /usr/bin，见文件头第 3 条。
    list.push(join(pf, 'Git', 'bin', 'bash.exe'))
    list.push(join(pf86, 'Git', 'bin', 'bash.exe'))
    if (local) list.push(join(local, 'Programs', 'Git', 'bin', 'bash.exe'))
  } else {
    list.push('/usr/bin/bash', '/bin/bash', '/opt/homebrew/bin/bash', '/usr/local/bin/bash')
  }
  list.push('bash')
  return list
}

let resolved
function bashPath() {
  if (resolved !== undefined) return resolved
  for (const candidate of candidates()) {
    // 'bash' 是兜底哨兵：交给系统按 PATH 解析，不做存在性检查。
    if (candidate === 'bash' || existsSync(candidate)) {
      resolved = candidate
      break
    }
  }
  if (resolved === undefined) resolved = 'bash'
  return resolved
}

function shellArgv(command) {
  return [bashPath(), '-c', command]
}

/**
 * 本部署的沙箱模式（ctx.sandboxPolicy.defaultMode，来自 DSH_PERMISSION_MODE）。
 * ctx.get 对未提供的服务返回 undefined 而不抛错，所以这里可以安全探测。
 */
function deploymentMode(ctx) {
  let policy
  try {
    policy = typeof ctx?.get === 'function' ? ctx.get('sandboxPolicy') : undefined
  } catch {
    policy = undefined
  }
  return policy?.defaultMode ?? 'workspace-write'
}

/* -------------------------------------------------------------------------- */
/* agent 平面：把 pwsh 工具改写成 bash                                            */
/* -------------------------------------------------------------------------- */

/** 工具提示词：如实描述"这是什么 shell、怎么写命令、怎么读结果"。 */
function bashDescription({ background, escalate, unsandboxed }) {
  const base =
    'Execute a shell command through Git Bash (`bash -c`) and return its stdout/stderr. ' +
    'Each call runs in a fresh bash process: no state (cwd, variables, functions) persists between calls — ' +
    'pass `workdir` instead of using `cd`. ' +
    'Command syntax is POSIX bash, not PowerShell: use the POSIX toolchain (`ls`, `grep`, `sed`, `find`, `cat`), ' +
    'read environment variables as `$NAME` (never `$env:NAME`), and prefer forward-slash paths (`/c/Users/...`, `~/...`); ' +
    'native `C:\\...` paths still work when quoted. ' +
    'Stdout and stderr are returned separately; non-zero exits are reported as `[exit code: N]`. ' +
    'Current harness environment facts are exposed through managed `$DSH_*` variables; inspect them when needed. ' +
    (unsandboxed
      ? 'This shell is NOT file-sandboxed — commands run with the harness process permissions, so a `[sandbox: ...]` denial is never reported here (the file tools keep their own sandbox). '
      : 'Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — a policy denial, not a bug in the command; do not retry another way. ') +
    'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. ' +
    'On Windows a force-killed command settles as `[exit code: 1]` without a signal marker — treat it as an interruption, not a command failure. ' +
    (background
      ? 'Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with `job_output` and stop it with `job_kill`.'
      : 'Background execution is not available; long-running commands must finish within the timeout.')

  if (!escalate) return base
  return (
    base +
    ' When a command is denied and a wider sandbox mode would let it succeed, escalate immediately in the same turn — ' +
    'retry the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) plus a one-sentence `justification`. ' +
    'Do not detour through chat to ask permission first — the approval prompt raised by that retry is how the user consents. ' +
    'Never escalate speculatively, and treat a rejected escalation as final for that command.'
  )
}

/** 参数说明里同样有 PowerShell 措辞，一并改掉（结构原样保留）。 */
function rewriteParameters(parameters) {
  if (parameters === null || typeof parameters !== 'object') return parameters
  let cloned
  try {
    cloned = JSON.parse(JSON.stringify(parameters))
  } catch {
    return parameters
  }
  const props = cloned.properties
  if (props && typeof props === 'object') {
    if (props.command && typeof props.command === 'object') {
      props.command.description = 'The bash command to execute (Git Bash / POSIX shell syntax).'
    }
    if (props.description && typeof props.description === 'object') {
      props.description.description =
        'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). ' +
        'Examples: "ls" → "List files in current directory"; "git status" → "Show working tree status"; "ps aux" → "List running processes".'
    }
  }
  return cloned
}

/**
 * 给工具注册表套一层：上游注册 `fromTool` 时，把定义改写后交回原方法。
 *
 * 为什么可行：`ctx.tools`（dsh-base 的 `tools` 行）是 host 平面唯一的 ToolRuntime
 * 实例，per-preset 的工具行注册到的是同一个对象，所以改它的原型方法即可覆盖所有
 * 作用域。`register` 只做"校验 + 按名字入表"，改写发生在入表之前 —— 后续
 * view/schemaOf/dispatch 全都会自然读到新名字，模型看到的 schema 与实际可调用的
 * 名字不会不一致。
 */
function installToolRewrite(ctx, options) {
  const { fromTool, toolName, background, unsandboxed } = options

  const rewrite = (definition) => {
    // 升级入口是否被广告出来，决定要不要在提示词里写升级流程。schema 结构由上游
    // 的 parameterSchemaSpecToJsonSchema 生成，形态可能变，所以直接按文本找键名。
    let escalationAdvertised = false
    try {
      escalationAdvertised = JSON.stringify(definition.parameters ?? '').includes(
        'sandbox_permissions'
      )
    } catch {
      escalationAdvertised = false
    }
    return {
      ...definition,
      name: toolName,
      description: bashDescription({ background, escalate: escalationAdvertised, unsandboxed }),
      parameters: rewriteParameters(definition.parameters)
    }
  }

  const apply = (tools) => {
    if (!tools || typeof tools.register !== 'function') {
      console.error(`${TAG} 拿不到 ctx.tools，工具改名跳过（执行器部分不受影响）`)
      return
    }
    // 目标对象可能是实例，也可能是 cordis 的 callable 包装；原型与实例两处都尽力
    // 打上，标记位保证只打一次，且不会重复包装。
    const targets = []
    try {
      const proto = Object.getPrototypeOf(tools)
      if (proto && typeof proto.register === 'function' && !Object.hasOwn(proto, '__dshGitBashRewrite')) {
        targets.push(proto)
      }
    } catch {
      // 忽略：退回实例级
    }
    if (!Object.hasOwn(tools, '__dshGitBashRewrite')) targets.push(tools)
    if (targets.length === 0) return

    const original = tools.register
    for (const target of targets) {
      target.register = function register(definition) {
        if (
          definition !== null &&
          typeof definition === 'object' &&
          definition.name === fromTool
        ) {
          console.error(`${TAG} 正在注册的工具 ${fromTool} 已改写为 ${toolName}`)
          return original.call(this, rewrite(definition))
        }
        return original.apply(this, arguments)
      }
      Object.defineProperty(target, '__dshGitBashRewrite', {
        value: true,
        enumerable: false,
        configurable: true
      })
    }
    console.error(`${TAG} 工具改写已装：${fromTool} -> ${toolName}`)
  }

  // 懒注入：dsh-tools 一定在，但这样即使某个部署没有 tools 行，执行器也照常工作。
  const inject = ctx?.inject?.bind(ctx)
  if (typeof inject === 'function') inject(['tools'], (toolsCtx) => apply(toolsCtx.get('tools')))
}

/* -------------------------------------------------------------------------- */
/* 执行器                                                                       */
/* -------------------------------------------------------------------------- */

/** 不带沙箱的执行器：把上游 LocalBashExecutor 硬编码的 argv[0] 换成绝对路径。 */
class GitBashLocalExecutor extends LocalBashExecutor {
  static inject = ['subprocess']

  /**
   * 声明部署的沙箱模式。本执行器自身不据此限制命令（见文件头第 4、5 条），
   * 但如实声明是必须的：permission / tool-bash / tool-pwsh 都读这个字段。
   */
  get sandboxMode() {
    return deploymentMode(this.ctx)
  }

  async run(spec) {
    return this.runArgv(spec, shellArgv(spec.command))
  }

  start(spec) {
    return this.startArgv(spec, shellArgv(spec.command))
  }
}

/**
 * 带沙箱的执行器：只重写 confine()，其余沿用 SandboxBashExecutor
 * （argv 交给 ctx.sandbox，win32 上由 ACL 受限令牌 runner 包一层）。
 * 注意 MSYS2 的 bash 在这个 runner 下起不来，见文件头第 4 条。
 */
class GitBashSandboxExecutor extends SandboxBashExecutor {
  confine(command, policy) {
    return this.ctx.sandbox.confine(shellArgv(command), policy)
  }

  /**
   * danger-full-access 在上游是绕过沙箱直接跑本地执行器的，而本地执行器的
   * argv 又硬编码 'bash' —— 这条分支必须自己接住，否则"全权限模式"下会退回
   * 那个解析不出来的裸 bash。
   */
  async run(spec) {
    if (spec.sandboxPolicy?.mode === 'danger-full-access') {
      const result = await this.runArgv(spec, shellArgv(spec.command))
      return { ...result, sandbox: { mode: 'danger-full-access', denied: false } }
    }
    return super.run(spec)
  }

  start(spec) {
    if (spec.sandboxPolicy?.mode === 'danger-full-access') {
      return this.startArgv(spec, shellArgv(spec.command))
    }
    return super.start(spec)
  }
}

/* -------------------------------------------------------------------------- */
/* 插件入口                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 继承执行器，顺带在构造时装上工具改写。
 *
 * config（来自 cordis.patch.yml 的那一行）：
 *   timeoutMs   执行器超时（默认 60000，由上游 Config 兜底）
 *   fromTool    要接管的工具名，默认 'pwsh'（上游 Windows 上的 shell 工具）
 *   toolName    改写后的工具名，默认 'bash'
 *   rewriteTool 设为 false 可关掉工具改写（只换执行器，保留 pwsh 名字）
 */
class GitBashShellPlugin extends (process.env.DSH_GITBASH_SANDBOX === '1'
  ? GitBashSandboxExecutor
  : GitBashLocalExecutor) {
  constructor(ctx, config = {}) {
    super(ctx, config)
    const entry = config ?? {}
    if (entry.rewriteTool !== false) {
      try {
        installToolRewrite(ctx, {
          fromTool: entry.fromTool ?? 'pwsh',
          toolName: entry.toolName ?? 'bash',
          background: true,
          unsandboxed: process.env.DSH_GITBASH_SANDBOX !== '1'
        })
      } catch (error) {
        console.error(`${TAG} 工具改写安装失败：%s`, error?.message ?? error)
      }
    }
  }
}

const chosen = bashPath()
const sandboxed = process.env.DSH_GITBASH_SANDBOX === '1'
console.error(
  `${TAG} bash = ${chosen}（${sandboxed ? '沙箱执行器' : '无沙箱执行器'}）`
)
if (chosen === 'bash') {
  console.error(
    `${TAG} 没探测到 Git Bash，退回按 PATH 解析 "bash"。` +
      '若报 ENOENT，请装 Git for Windows 或设 DSH_GIT_BASH 指向 bash.exe。'
  )
}

export default GitBashShellPlugin
