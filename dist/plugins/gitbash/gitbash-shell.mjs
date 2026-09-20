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
 * 第三条平面（v2.1.0）：**极简模式的持久终端**。
 *   极简模式（minimal 预设）不用 ctx.shell —— 它挂的是另一套 PTY 持久 shell 栈：
 *     dsh-terminal（PTY 注册表） + dsh-terminal-bash（win32 上 shellDialect: pwsh，
 *     起的是 PowerShell） + dsh-tool-pwsh-persistent（注册的工具名恰好也叫 `pwsh`）。
 *   只做上面两件事会出现「提示词说 Git Bash、实际跑 PowerShell」的劈叉（用户实测
 *   踩过）：工具改写按名字拦到了持久工具，但执行路径（PTY）没换。
 *   所以本插件再拦 `TerminalSessionService.prototype.registerBackend`：pwsh 方言的
 *   PTY 后端被就地换成 Git Bash 的 bash 方言（shellPath/args 换掉，启动协议随
 *   dialect 一起换 —— bash 用 PS1 + PROMPT_COMMAND 打就绪标记，协议自洽），并用
 *   一个「confine 原样返回」的沙箱替身绕过 ACL runner（MSYS2 在它下面起不来，
 *   见第 4 条）。持久工具的提示词也换成**持久版**的 Git Bash 描述（状态跨调用保留、
 *   没有作业 API）。Git Bash 没探测到时持久终端原样保留 PowerShell，不撒谎。
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
 *    持久终端那条路同理：dsh-terminal-bash 的 spawnArgv 在非 danger 模式下会把
 *    PTY argv 交给 ctx.sandbox.confine()，win32 上就是 ACL runner —— 用替身绕开。
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
 *    一次性工具和持久工具都叫 `pwsh`，按参数形状区分（持久版整个 schema 只有
 *    `command`），各配各的提示词。
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
import { randomUUID } from 'node:crypto'
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
const { TerminalSessionService } = await loadHost('@deepseek-ai/dsh-terminal')
// serviceForAgent：从 reflect 原始 store 里按 fiber 归属取 agent 挂载的隔离服务。
// 极简模式的 terminals 在 agent 入局隔离的 persistent-shell 组里，agent 自己的
// scope ctx 和 host 都看不见它，只有这条文档化的「从外部读 agent 隔离服务」路径
// 能拿到（api-proxy 的每个浏览器 RPC 都走它）。dsh-agent-presets 是核心包，但
// 仍按插件惯例防御式加载：拿不到就退回直接读，绝不让插件启动失败。
let serviceForAgent
try {
  ;({ serviceForAgent } = await loadHost('@deepseek-ai/dsh-agent-presets'))
} catch {
  serviceForAgent = undefined
}

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

/**
 * 持久终端版的提示词（极简模式的 `dsh-tool-pwsh-persistent`）。
 *
 * 与一次性版的差别：状态（cwd、环境变量）跨调用保留，没有 `run_in_background`
 * 的作业 API，超时/被打断会整壳重置。其余的「这是 Git Bash、POSIX 语法」部分
 * 与一次性版保持一致。
 */
function bashPersistentDescription({ unsandboxed }) {
  const base =
    'Run commands in a persistent Git Bash shell; state — current directory and exported environment variables — ' +
    'persists across calls for this agent. ' +
    'Command syntax is POSIX bash, not PowerShell: use the POSIX toolchain (`ls`, `grep`, `sed`, `find`, `cat`), ' +
    'read environment variables as `$NAME` (never `$env:NAME`), and prefer forward-slash paths (`/c/Users/...`, `~/...`); ' +
    'native `C:\\...` paths still work when quoted. ' +
    'Avoid commands that may produce a very large amount of output; run long-lived commands in the background ' +
    '(append `&`) and check on them with follow-up calls. ' +
    'A timed-out or interrupted command resets the shell: the next call starts from the workspace with a fresh ' +
    'directory and environment. ' +
    (unsandboxed
      ? 'This shell is NOT file-sandboxed — commands run with the harness process permissions; the file tools keep their own sandbox. '
      : 'Commands may run under a file sandbox; a blocked file operation is reported as a policy denial, not a bug in the command. ')
  return base
}

/**
 * 参数说明里同样有 PowerShell 措辞，一并改掉（结构原样保留）。
 * 持久终端工具只有一个 `command` 参数，说明文字单独给一份。
 */
function rewriteParameters(parameters, persistent = false) {
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
      props.command.description = persistent
        ? 'The bash command to run (persistent Git Bash shell, POSIX syntax; state persists across calls).'
        : 'The bash command to execute (Git Bash / POSIX shell syntax).'
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
 * 这是持久终端工具（极简模式 `dsh-tool-pwsh-persistent`）还是一次性 shell 工具？
 *
 * 两个插件注册的工具名都叫 `pwsh`，只能按参数形状区分：持久版整个 schema 就一个
 * `command`；一次性版还有 `description` / `workdir` / `run_in_background` 等。
 */
function isPersistentShellDefinition(definition) {
  const props = definition?.parameters?.properties
  return (
    props !== null &&
    typeof props === 'object' &&
    props.command !== null &&
    typeof props.command === 'object' &&
    props.description === undefined &&
    props.workdir === undefined
  )
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
  const { fromTool, toolName, background, unsandboxed, rewritePersistent } = options

  const rewrite = (definition, registrationCtx) => {
    const persistent = isPersistentShellDefinition(definition)
    // Git Bash 没探测到时，持久终端后端没有换（还是 PowerShell），
    // 此时把持久工具改名为 bash 就是撒谎 —— 原样放行。
    if (persistent && rewritePersistent !== true) return definition
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
    if (persistent) {
      // 工具层也要换方言：上游 execute 说的是 PowerShell 包装协议（见
      // createBashPersistentExecute 的注释），PTY 换成 bash 后必须整层替换。
      // registrationCtx 是注册时调用方的 ctx（cordis 的 tracker 按调用方作用域
      // 重绑 this.ctx）：极简模式下持久工具是在 agent 入局隔离的 persistent-shell
      // 组里注册的，那个 ctx 看得见本 agent 的 terminals —— 而 exec.agent.ctx
      // 是 agent 自己的 scope ctx，隔离组外的服务它看不见（v2.2.0 的 bug 就在这）。
      return {
        ...definition,
        name: toolName,
        description: bashPersistentDescription({ unsandboxed }),
        parameters: rewriteParameters(definition.parameters, true),
        execute: createBashPersistentExecute(registrationCtx)
      }
    }
    return {
      ...definition,
      name: toolName,
      description: bashDescription({ background, escalate: escalationAdvertised, unsandboxed }),
      parameters: rewriteParameters(definition.parameters, persistent)
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
          // this.ctx 由 cordis 的 tracker 按调用方作用域重绑：持久工具在
          // 极简模式的 persistent-shell 组里注册时，这里拿到的就是那个组的
          // ctx（看得见本 agent 的 terminals）。见 rewrite 里那段注释。
          const rewritten = rewrite(definition, this?.ctx)
          // 原样放行（持久工具在无 Git Bash 时的退路）就不打「已改写」，免得误导排查
          if (rewritten !== definition) {
            console.error(`${TAG} 正在注册的工具 ${fromTool} 已改写为 ${toolName}`)
          }
          return original.call(this, rewritten)
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
/* agent 平面（极简模式）：把持久终端的 PTY 从 PowerShell 换成 Git Bash            */
/* -------------------------------------------------------------------------- */

/**
 * 一个「confine 原样返回」的沙箱替身 + 包着它的 ctx。
 *
 * 为什么必须绕过沙箱：`dsh-terminal-bash` 的 spawnArgv 在非 danger 模式下会把
 * PTY 的 argv 交给 ctx.sandbox.confine() —— win32 上就是 ACL 受限令牌 runner，
 * 而 MSYS2 的 bash 在它下面起不来（`couldn't create signal pipe, Win32 error 5`，
 * 见文件头第 4 条）。一次性 shell 那条路我们已经用「无沙箱执行器」绕开；持久终端
 * 这条路用这个替身绕开，语义一致：shell 不围栏，文件工具照常围栏。
 *
 * 只拦 `ctx.get("sandbox")` 这一个调用点，其余属性（on / terminals /
 * sandboxPolicy / sessionProjections / subprocess …）全部转发到真 ctx。
 */
const PLAIN_CONFINE = { confine: (argv) => ({ argv }) }

function plainSandboxCtx(ctx) {
  if (ctx === null || typeof ctx !== 'object') return ctx
  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'get') {
        const realGet = target.get
        return typeof realGet === 'function'
          ? (id) => (id === 'sandbox' ? PLAIN_CONFINE : realGet.call(target, id))
          : realGet
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

/** bash PTY 的启动参数，照抄上游 bash 方言的默认值（交互式、不带 profile）。 */
const BASH_PTY_ARGS = ['--noprofile', '--norc', '-i']

/**
 * 给 `TerminalSessionService.prototype.registerBackend` 套一层：上游按平台注册的
 * pwsh 方言 PTY 后端（极简模式 `terminal-pwsh` 那行），把它的配置就地换成
 * Git Bash 的 bash 方言。
 *
 * 为什么能就地换：后端把 `ctx` / `config` 存成普通实例属性，`spawn()` 每次现读
 * —— dialect 决定启动协议（bash 用 PS1 + PROMPT_COMMAND 的就绪标记，pwsh 用
 * 注入的 prompt 函数）、shellPath/args 决定起谁，全部跟着 config 走。换成 bash
 * 方言后，就绪标记由 bash 自己的 PROMPT_COMMAND 打出来，协议自洽。
 *
 * `terminals` 是 agent 入局隔离的服务（`isolate: { terminals: true }`），每个
 * agent 一份实例；打在**原型**上就能覆盖所有 realm —— 和工具改写是同一招。
 */
function installTerminalRewrite(bashExe) {
  const proto = TerminalSessionService.prototype
  if (Object.hasOwn(proto, '__dshGitBashTerminal')) return
  const original = proto.registerBackend
  proto.registerBackend = function registerBackend(backend) {
    if (
      backend !== null &&
      typeof backend === 'object' &&
      backend.type === 'shell' &&
      backend.config !== null &&
      typeof backend.config === 'object' &&
      backend.config.shellDialect === 'pwsh'
    ) {
      try {
        console.error(
          `${TAG} 持久终端后端（${backend.config.shellPath}）已换成 Git Bash：${bashExe}`
        )
        backend.config = {
          ...backend.config,
          shellDialect: 'bash',
          shellPath: bashExe,
          shellArgs: BASH_PTY_ARGS
        }
        backend.ctx = plainSandboxCtx(backend.ctx)
      } catch (error) {
        console.error(`${TAG} 持久终端改写失败：%s`, error?.message ?? error)
      }
    }
    return original.call(this, backend)
  }
  Object.defineProperty(proto, '__dshGitBashTerminal', {
    value: true,
    enumerable: false,
    configurable: true
  })
  console.error(`${TAG} 持久终端改写已装：pwsh PTY -> Git Bash PTY`)
}

/* -------------------------------------------------------------------------- */
/* agent 平面（极简模式）：持久 shell 工具整层换成 bash 方言                       */
/* -------------------------------------------------------------------------- */

/**
 * 【v2.2.0】只换 PTY 后端不够：`dsh-tool-pwsh-persistent` 的**工具层**也是硬编码的
 * PowerShell —— 建壳时注入 PS prompt 函数、每条命令包成 `Write-Output` /
 * `Invoke-Expression` / `$LASTEXITCODE` 的 PS 包装、靠 PS 标记切输出。bash PTY 收到
 * 这些等于收到乱码：START/END 标记永远打不出来，工具一直轮询到 300 秒超时（实测：
 * 「要等很久」+ 打断时报 `Error: [object Object]`，见 2026-09-20 会话日志）。
 *
 * 所以在工具注册拦截里，把持久 pwsh 工具的 `execute` **整体替换**成下面的 bash 方言
 * 实现。结构镜像上游（owner 级壳缓存 + 序列化 + deadline + 标记轮询），差异只有方言：
 * 命令经 base64 进 `eval`（单物理行，绕开 tty 回显/续行提示符对输出区的污染），
 * 输出靠 START/END 标记切，退出码随 END 标记回来。终端服务从 `exec.agent.ctx` 现取
 * —— 那就是本 agent 入局隔离的 terminals 注册表（PTY 后端已被上面换成 Git Bash）。
 */

const BASH_PERSISTENT_TIMEOUT_MS = 300_000
const BASH_PERSISTENT_MAX_OUTPUT_CHARS = 16_000
const BASH_PERSISTENT_PROMPT = 'dsh> '
const BASH_PERSISTENT_POLL_MS = 25
const BASH_SCROLLBACK_PAGE_LINES = 1_000
const BASH_CLIP_NOTE =
  '\n<response clipped><NOTE>Output exceeded the character budget; the middle was dropped, head and tail are kept.</NOTE>\n'
const BASH_LOST_PREFIX_MESSAGE =
  '<response clipped><NOTE>The beginning of this command output was dropped by the terminal scrollback limit. The following text is the earliest retained output.</NOTE>\n'
const BASH_RESET_MESSAGE =
  'The persistent bash shell was reset; the next call starts from the workspace with a fresh current directory and environment.'

/** 每次调用一对一次性标记（nonce 进标记名，防命令输出里出现同名串）。 */
function bashMarkers() {
  const nonce = randomUUID().replaceAll('-', '')
  return {
    varName: `__dsh_rc_${nonce}`,
    start: `__DSH_BASH_START_${nonce}__`,
    end: `__DSH_BASH_END_${nonce}__`
  }
}

/** 命令 → 单物理行 bash 包装：base64 进 eval，退出码随 END 标记回来。 */
function wrapBashCommand(command, m) {
  const encoded = Buffer.from(command.replaceAll('\r', ''), 'utf8').toString('base64')
  return (
    `printf '%s\\n' '${m.start}'; ` +
    `eval "$(printf %s '${encoded}' | base64 -d)"; ` +
    `${m.varName}=$?; ` +
    `printf '%s\\n' "${m.end}:\$${m.varName}"`
  )
}

/** 从 scrollback 快照里切出 [START, END:code] 之间的命令输出。 */
function extractBashOutput(snapshotText, m, wrapped) {
  const endKey = `${m.end}:`
  const endIndex = snapshotText.lastIndexOf(endKey)
  if (endIndex < 0) return undefined
  const status = /^(\d+)/.exec(snapshotText.slice(endIndex + endKey.length))?.[1]
  if (status === undefined) return undefined
  const startIndex = snapshotText.lastIndexOf(m.start, endIndex)
  let captured = startIndex < 0 ? '' : snapshotText.slice(startIndex + m.start.length, endIndex)
  captured = captured.replaceAll(wrapped, '')
  return {
    text: captured.replace(/^\r?\n/, '').replace(/\r?\n$/, ''),
    incomplete: startIndex < 0,
    exitCode: Number(status)
  }
}

function stripBashPrompt(text) {
  let result = text.replace(/\r?\n$/, '')
  while (result.endsWith(BASH_PERSISTENT_PROMPT)) result = result.slice(0, -BASH_PERSISTENT_PROMPT.length)
  return result.endsWith('\n') ? result.slice(0, -1) : result
}

/** 命令还没结束（或刚超时）时，把现有输出尽量拼出来。 */
function partialBashOutput(snapshotText, m, wrapped, fallback, fallbackTruncated) {
  const startIndex = snapshotText.lastIndexOf(m.start)
  if (startIndex >= 0) {
    return {
      text: stripBashPrompt(snapshotText.slice(startIndex + m.start.length).replace(/^\r?\n/, '')),
      incomplete: false
    }
  }
  const fallbackStart = fallback.lastIndexOf(m.start)
  const afterStart =
    fallbackStart < 0 ? fallback : fallback.slice(fallbackStart + m.start.length).replace(/^\r?\n/, '')
  const fallbackEnd = afterStart.lastIndexOf(m.end)
  return {
    text: stripBashPrompt(
      (fallbackEnd < 0 ? afterStart : afterStart.slice(0, fallbackEnd)).replaceAll(wrapped, '')
    ),
    incomplete: fallbackTruncated || fallbackStart < 0
  }
}

function renderBashOutput(output) {
  let text = output.text ?? ''
  if (text.length > BASH_PERSISTENT_MAX_OUTPUT_CHARS) {
    const keep = BASH_PERSISTENT_MAX_OUTPUT_CHARS - BASH_CLIP_NOTE.length
    const head = Math.floor(keep * 0.75)
    const tail = keep - head
    text = `${text.slice(0, head)}${BASH_CLIP_NOTE}${tail > 0 ? text.slice(-tail) : ''}`
  }
  if (output.incomplete === true && text.length > 0) text = `${BASH_LOST_PREFIX_MESSAGE}${text}`
  if (typeof output.exitCode === 'number' && output.exitCode !== 0) {
    const mark = `[exit code: ${output.exitCode}]`
    text = text.length === 0 ? mark : `${text}\n${mark}`
  }
  return text
}

/** 把整份 scrollback 按页读全（read 的 offset 是「从尾部往回的行数」）。 */
function retainedBashScrollback(owner, terminals, id, latest) {
  const page = latest ?? terminals.read(owner, id, { offset: 0, count: BASH_SCROLLBACK_PAGE_LINES })
  const pages = page.text.length === 0 ? [] : [page.text]
  let offset = page.lineEnd
  let truncated = page.truncated
  for (;;) {
    if (offset >= page.totalLines) break
    const next = terminals.read(owner, id, { offset, count: BASH_SCROLLBACK_PAGE_LINES })
    truncated ||= next.truncated
    if (next.text.length > 0) pages.unshift(next.text)
    if (next.text.length === 0 || next.lineEnd <= offset || next.lineEnd >= next.totalLines) break
    offset = next.lineEnd
  }
  return { text: pages.join('\n'), truncated }
}

/**
 * 命令级 deadline：上游用 dsh-timeout 的 deadline()，这里手写一份省一个 hostImport。
 * timedOut 区分「自己超时」和「被上游打断」——超时要回部分输出，打断要原样上抛。
 */
function bashCommandDeadline(upstreamSignal, timeoutMs) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`persistent bash command timed out after ${Math.round(timeoutMs / 1e3)}s`))
  }, timeoutMs)
  const onUpstreamAbort = () => controller.abort(upstreamSignal.reason)
  if (upstreamSignal !== undefined) {
    if (upstreamSignal.aborted) onUpstreamAbort()
    else upstreamSignal.addEventListener('abort', onUpstreamAbort, { once: true })
  }
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut
    },
    dispose() {
      clearTimeout(timer)
      upstreamSignal?.removeEventListener('abort', onUpstreamAbort)
    }
  }
}

/**
 * 持久 bash 工具的工具面。owner 级状态（壳缓存 / 串行化队列）用 WeakMap 挂在
 * agent 上——拦截器是打在原型上的全局一份，按 owner 分键等价于上游的按插件实例。
 *
 * @param registrationCtx - 持久工具注册时调用方的 ctx。极简模式下 terminals 在
 *   agent 入局隔离的 persistent-shell 组里，agent 自己的 scope ctx 和 host 都
 *   看不见它（v2.2.0 的 bug 就在这）。v2.2.1 曾试图靠 cordis 的 tracker 让
 *   this.ctx 重绑成组内 ctx，实测拿不到 —— 所以这里改用文档化的
 *   serviceForAgent(ctx, agent, 'terminals') 从 reflect 原始 store 按 fiber 归属
 *   取 agent 挂载的 terminals 实例（api-proxy 的每个浏览器 RPC 都走这条路径）。
 */
function createBashPersistentExecute(registrationCtx) {
  const shells = new WeakMap()
  const pending = new WeakMap()
  const serialized = new WeakMap()

  const terminalsOf = (owner) => {
    // 首选文档化的生产路径：serviceForAgent 从 reflect 原始 store 里按 fiber 归属
    // 取 agent 挂载的 terminals（隔离组内注册的那份实例），不依赖调用方作用域。
    if (serviceForAgent !== undefined && owner?.ctx !== undefined) {
      try {
        const viaPreset = serviceForAgent(registrationCtx, owner, 'terminals')
        if (
          viaPreset !== undefined &&
          typeof viaPreset.spawn === 'function' &&
          typeof viaPreset.startSend === 'function'
        ) {
          return viaPreset
        }
      } catch {
        // 退回下面的候选
      }
    }
    // 兜底：注册时捕获的 ctx 与 exec.agent.ctx（标准模式等非隔离场景下直接可见）。
    const candidates = [registrationCtx, owner?.ctx]
    for (const ctx of candidates) {
      if (ctx === null || ctx === undefined) continue
      let terminals
      try {
        terminals = ctx?.terminals ?? (typeof ctx?.get === 'function' ? ctx.get('terminals') : undefined)
      } catch {
        terminals = undefined
      }
      if (
        terminals !== undefined &&
        typeof terminals.spawn === 'function' &&
        typeof terminals.startSend === 'function'
      ) {
        return terminals
      }
    }
    throw new Error('persistent bash tool cannot reach the terminals service of this agent')
  }

  const closeShell = async (owner, terminals, id, reason) => {
    if (!terminals.list(owner).some((snapshot) => snapshot.sessionId === id)) return
    await terminals.kill(owner, id, reason)
  }

  const resetShell = async (owner, terminals, reason) => {
    const id = shells.get(owner)
    shells.delete(owner)
    if (id !== undefined) await closeShell(owner, terminals, id, reason)
  }

  const ensureShell = async (owner, terminals, signal) => {
    const existing = shells.get(owner)
    if (existing !== undefined) return existing
    const inflight = pending.get(owner)
    if (inflight !== undefined) return inflight
    const task = (async () => {
      let created
      try {
        const cwd = owner.session?.header?.cwd
        const spawned = await terminals.spawn(
          owner,
          { type: 'shell', ...(cwd === undefined ? {} : { cwd }) },
          signal
        )
        created = spawned.sessionId
        shells.set(owner, created)
        return created
      } catch (error) {
        if (created !== undefined) await closeShell(owner, terminals, created, 'persistent bash spawn failed')
        throw error
      }
    })()
    pending.set(owner, task)
    try {
      return await task
    } finally {
      pending.delete(owner)
    }
  }

  const exitResult = async (owner, terminals, id, status, m, wrapped, fallback, fallbackTruncated) => {
    const snapshot = retainedBashScrollback(owner, terminals, id)
    await resetShell(owner, terminals, 'persistent bash shell exited')
    const body = renderBashOutput({
      ...partialBashOutput(snapshot.text, m, wrapped, fallback, fallbackTruncated),
      exitCode: undefined
    })
    const statusMark =
      status.signal !== null
        ? `[shell killed by signal: ${status.signal}]`
        : status.exitCode !== null
          ? `[shell exited: code ${status.exitCode}]`
          : '[shell exited]'
    return [body, statusMark, BASH_RESET_MESSAGE].filter((part) => part.length > 0).join('\n')
  }

  const executeCommand = async (owner, terminals, command, upstreamSignal) => {
    const state = bashCommandDeadline(upstreamSignal, BASH_PERSISTENT_TIMEOUT_MS)
    try {
      const id = await ensureShell(owner, terminals, state.signal)
      const m = bashMarkers()
      const wrapped = wrapBashCommand(command, m)
      let first = true
      let fallback = ''
      let fallbackTruncated = false
      for (;;) {
        const status = terminals.list(owner).find((snapshot) => snapshot.sessionId === id)?.status
        if (status?.kind === 'exited') {
          return await exitResult(owner, terminals, id, status, m, wrapped, fallback, fallbackTruncated)
        }
        let operation
        let result
        try {
          operation = terminals.startSend(owner, id, {
            text: first ? wrapped : '',
            submit: first,
            signal: state.signal
          })
          first = false
          result = await operation.done
        } catch (error) {
          await resetShell(owner, terminals, 'persistent bash send failed')
          throw error
        }
        const incremental = operation.readOutput()
        fallback = incremental.delta.length > 0 ? fallback + incremental.delta : result.viewport
        fallbackTruncated ||= incremental.truncated || result.truncated
        const latest = terminals.read(owner, id, { offset: 0, count: BASH_SCROLLBACK_PAGE_LINES })
        if (state.timedOut) {
          const partial = renderBashOutput(
            partialBashOutput(retainedBashScrollback(owner, terminals, id, latest).text, m, wrapped, fallback, fallbackTruncated)
          )
          await resetShell(owner, terminals, 'persistent bash command timed out')
          return `Your command timed out after ${Math.round(BASH_PERSISTENT_TIMEOUT_MS / 1e3)} seconds. Below is partial output:\n${partial}\n${BASH_RESET_MESSAGE}`
        }
        if (state.signal.aborted) {
          await resetShell(owner, terminals, 'persistent bash command aborted')
          state.signal.throwIfAborted()
        }
        if (latest.text.includes(`${m.end}:`)) {
          const complete = extractBashOutput(
            retainedBashScrollback(owner, terminals, id, latest).text,
            m,
            wrapped
          )
          if (complete !== undefined) return renderBashOutput(complete)
        }
        if (result.sessionStatus.kind === 'exited') {
          return await exitResult(owner, terminals, id, result.sessionStatus, m, wrapped, fallback, fallbackTruncated)
        }
        if (
          result.viewport.endsWith(BASH_PERSISTENT_PROMPT) ||
          result.viewport.endsWith(`${BASH_PERSISTENT_PROMPT}\r\n`) ||
          result.viewport.endsWith(`${BASH_PERSISTENT_PROMPT}\n`)
        ) {
          return renderBashOutput(
            partialBashOutput(retainedBashScrollback(owner, terminals, id, latest).text, m, wrapped, fallback, fallbackTruncated)
          )
        }
        await new Promise((resolve) => setTimeout(resolve, BASH_PERSISTENT_POLL_MS))
      }
    } finally {
      state.dispose()
    }
  }

  return async function execute(args, exec) {
    if (typeof args?.command !== 'string' || args.command.trim().length === 0) {
      throw new Error('command must be a non-empty string')
    }
    const owner = exec?.agent
    if (owner === undefined) throw new Error('persistent bash tool requires an owning agent session')
    // 同一 owner 的调用串行（PT 只有一个活跃 send），与上游一致
    const tail = serialized.get(owner) ?? Promise.resolve()
    const run = tail.then(
      () => executeCommand(owner, terminalsOf(owner), args.command, exec.signal),
      () => executeCommand(owner, terminalsOf(owner), args.command, exec.signal)
    )
    serialized.set(
      owner,
      run.then(
        () => undefined,
        () => undefined
      )
    )
    return run
  }
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
 * 继承执行器，顺带在构造时装上工具改写与持久终端改写。
 *
 * config（来自 cordis.patch.yml 的那一行）：
 *   timeoutMs   执行器超时（默认 60000，由上游 Config 兜底）
 *   fromTool    要接管的工具名，默认 'pwsh'（上游 Windows 上的 shell 工具；
 *               极简模式的持久工具恰好也叫这个名字，一并覆盖）
 *   toolName    改写后的工具名，默认 'bash'
 *   rewriteTool 设为 false 可关掉两处改写（只换执行器，保留 pwsh 名字）
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
          unsandboxed: process.env.DSH_GITBASH_SANDBOX !== '1',
          rewritePersistent: chosen !== 'bash'
        })
      } catch (error) {
        console.error(`${TAG} 工具改写安装失败：%s`, error?.message ?? error)
      }
      try {
        // Git Bash 没探测到时不动持久终端：换过去只会得到一个起不来的 PTY，
        // 不如保留能用的 PowerShell（工具名也就不撒谎）。
        if (chosen !== 'bash') {
          installTerminalRewrite(chosen)
        } else {
          console.error(`${TAG} 没探测到 Git Bash，持久终端保持 PowerShell 不动`)
        }
      } catch (error) {
        console.error(`${TAG} 持久终端改写安装失败：%s`, error?.message ?? error)
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

/** 给自测用的内部件（与 retry 插件同款做法：外部脚本直接对答案）。 */
export const internals = {
  bashPath,
  bashDescription,
  bashPersistentDescription,
  isPersistentShellDefinition,
  rewriteParameters,
  installToolRewrite,
  installTerminalRewrite,
  plainSandboxCtx,
  bashMarkers,
  wrapBashCommand,
  extractBashOutput,
  partialBashOutput,
  renderBashOutput,
  retainedBashScrollback,
  createBashPersistentExecute
}
