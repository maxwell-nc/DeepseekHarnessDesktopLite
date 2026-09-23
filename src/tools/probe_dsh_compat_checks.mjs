/**
 * dsh 版本兼容自测本体 —— 「插件依赖的 dsh 内部接口，在这个槽位上还在不在」
 * ==========================================================================
 *
 * 触发场景：dsh 升级后（例如 0.1.5-rc.3 → 0.1.7-alpha.2），插件不一定报错 ——
 * 更常见的是**静默降级**（执行器退回上游默认 argv、某个改写装不上、前端入口
 * 锚点找不到），界面还能开、日志也不红，直到用户点下去才发现功能没了。
 * 所以升级后跑一次这个脚本，比手点一遍快，也能在下次升级时直接复用。
 *
 *   node probe_dsh_compat_checks.mjs <接口定义文件/插件目录> <槽位 JSON>
 *
 * 它**只读**：不启动服务、不连真实 dsh、不写 %LOCALAPPDATA%（只读 dsh 运行时的
 * 包文件 + 需要时真跑一条 `bash -c echo` 验证执行器 argv）。
 *
 * 检查分三类：
 *   1. proto   —— 某个包的某个类原型上，插件要拦/要调的方法还在不在（可选「任一组
 *                 命中即可」，用来表达「旧版叫 A、新版叫 B」这种改名；类名本身也
 *                 会改（SettingsProvider -> SettingsForms），所以按 default 兜底）。
 *   2. service —— 插件通过 `ctx.get('名字')` 拿的服务，在包的 Context 声明里还叫不叫
 *                 这个名字，类型变成了什么（0.1.7 就改过 settings 的类型名）。
 *   3. source  —— 插件依赖的**字面契约**（事件名、DOM 属性、插槽名、工具名）在
 *                 上游文件里还搜不搜得到。契约断了通常不会报错，只会没反应。
 *   4. drive   —— 真跑：把插件自己的执行器实例挂上假 ctx，跑一条命令，看 argv
 *                 有没有被换成 Git Bash（这是「改了但没生效」唯一能自动发现的方式）。
 *
 * 退出码：0 = 全过；1 = 有失败；2 = 环境问题（找不到槽位）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const [pluginsRoot, slotsJson] = process.argv.slice(2)
if (!pluginsRoot || !slotsJson) {
  console.error('用法：node probe_dsh_compat_checks.mjs <plugins 源目录> <槽位 JSON>')
  process.exit(2)
}

const SLOTS = JSON.parse(slotsJson) // [{ version, nodeModules, slotDir }]
if (!Array.isArray(SLOTS) || SLOTS.length === 0) {
  console.error('槽位 JSON 是空的：没有可检查的 dsh 版本')
  process.exit(2)
}

/* -------------------------------------------------------------------------- */
/* 检查表：插件 → 它依赖的 dsh 接口                                              */
/* -------------------------------------------------------------------------- */

/**
 * `anyOf` = 「这几组方法里，至少有一组整组都在」。
 * 用途：上游改名时（0.1.5 的 run/runArgv vs 0.1.7 的 execute/executeArgv），
 * 插件会同时实现两套，但**运行的那个版本必须命中至少一套**，否则就是两条路都不通。
 */
const CHECKS = [
  {
    plugin: '壳（启动加速补丁）',
    kind: 'proto',
    module: '@deepseek-ai/dsh-client-modules',
    exportCandidates: ['ClientModuleRegistry'],
    has: ['compose'],
    what: '启动加速补丁的落点（compose + composed/responses 那组访问器）'
  },
  {
    plugin: 'gitbash（极简模式）',
    kind: 'source',
    module: '@deepseek-ai/dsh-tool-pwsh-persistent',
    file: 'lib/index.js',
    contains: 'card: "terminal"',
    what: '持久工具的工具卡类型（presentCall.card）'
  },

  /* ── gitbash：shell 执行器 + 持久终端 + 工具改写 ───────────────────────── */
  {
    plugin: 'gitbash',
    kind: 'proto',
    module: '@deepseek-ai/dsh-bash-local',
    export: 'LocalBashExecutor',
    anyOf: [
      ['run', 'runArgv', 'start', 'startArgv'], // dsh ≤ 0.1.5-rc.x
      ['execute', 'executeArgv'] // dsh ≥ 0.1.7-alpha
    ],
    what: 'shell 执行器的入口方法组（老版 run/start，新版 execute）'
  },
  {
    plugin: 'gitbash',
    kind: 'proto',
    module: '@deepseek-ai/dsh-bash-sandbox',
    export: 'SandboxBashExecutor',
    has: ['resolve', 'confine'],
    what: '沙箱执行器（DSH_GITBASH_SANDBOX=1 分支）的 resolve/confine'
  },
  {
    plugin: 'gitbash',
    kind: 'proto',
    module: '@deepseek-ai/dsh-terminal',
    export: 'TerminalSessionService',
    has: ['registerBackend', 'spawn', 'startSend', 'read', 'list', 'kill'],
    what: 'PTY 注册表：后端改写点 + 持久工具用到的终端 API'
  },
  {
    plugin: 'gitbash',
    kind: 'proto',
    module: '@deepseek-ai/dsh-tools',
    export: 'ToolRuntime',
    has: ['register', 'schemaOf', 'view'],
    what: '工具注册表（pwsh -> bash 改名拦的就是 register）'
  },
  {
    plugin: 'gitbash',
    kind: 'module-any',
    modules: ['@deepseek-ai/dsh-agent-preset-registry', '@deepseek-ai/dsh-agent-presets'],
    export: 'serviceForAgent',
    what: 'serviceForAgent（极简模式取 agent 隔离 terminals 的唯一可靠路径；包名随版本改过）'
  },
  {
    plugin: 'gitbash',
    kind: 'source',
    module: '@deepseek-ai/dsh-tool-pwsh-persistent',
    file: 'lib/index.js',
    contains: 'name: "pwsh"',
    what: '极简模式持久工具仍叫 pwsh（工具改写按名字拦它）'
  },
  {
    plugin: 'gitbash',
    kind: 'source',
    module: '@deepseek-ai/dsh-tool-pwsh',
    file: 'lib/index.js',
    contains: 'name: "pwsh"',
    what: '一次性 shell 工具仍叫 pwsh（Windows 上被改名成 bash）'
  },
  {
    plugin: 'gitbash',
    kind: 'source',
    module: '@deepseek-ai/dsh-base',
    file: 'cordis.patch.yml',
    contains: 'bash-sandbox',
    what: '补丁片段关掉的上游条目 id（bash-sandbox / pwsh-sandbox）还在'
  },

  /* ── retry / thinking_loop_guard：都会走会话日志 + fork ─────────────────── */
  {
    plugin: 'retry + thinking_loop_guard',
    kind: 'proto',
    module: '@deepseek-ai/dsh-session-query',
    export: 'SessionQueryEngine',
    has: ['observeSession'],
    what: '读会话日志（冷热通吃）的 observeSession'
  },
  {
    plugin: 'retry + thinking_loop_guard',
    kind: 'proto',
    module: '@deepseek-ai/dsh-api-session-controller',
    export: 'SessionController',
    has: ['create', 'fork', 'prompt', 'cancel', 'rename'],
    what: '建分支 / 新建会话 / 发消息 / 停这一轮 / 改名'
  },
  {
    plugin: 'retry + thinking_loop_guard',
    kind: 'source',
    module: '@deepseek-ai/dsh-api-session-controller',
    file: 'lib/types/types.d.ts',
    contains: 'agentPreset',
    what: 'create({agentPreset}) —— 首轮重试要跟着源会话的预设'
  },
  {
    plugin: 'retry + thinking_loop_guard',
    kind: 'source',
    module: '@deepseek-ai/dsh-session',
    file: 'lib/index.js',
    contains: 'session/event',
    what: '会话事件总线名（采集类插件的入口）'
  },
  {
    plugin: 'thinking_loop_guard',
    kind: 'source',
    module: '@deepseek-ai/dsh-llm',
    file: 'lib/index.js',
    contains: 'llm/stream',
    what: 'llm/stream 瀑布（思考循环守卫就是挂这里数思考量）'
  },
  {
    plugin: 'thinking_loop_guard',
    kind: 'source',
    module: '@deepseek-ai/dsh-agent',
    file: 'lib/types/runtime-types.d.ts',
    contains: 'cancel(cause',
    what: 'agent.cancel(cause, {keepInbox}) —— 自动中断走的同一条路'
  },

  /* ── 所有在网页里挂入口的插件：connection / slots / settings ────────────── */
  {
    plugin: '全部（网页入口）',
    kind: 'source',
    module: '@deepseek-ai/dsh-client-connection',
    file: 'lib/types/rpc.d.ts',
    contains: 'register(route: ConnectionFetchRoute)',
    what: 'connection.fetch.register({path, methods, fetch}) 契约'
  },
  {
    plugin: 'lan_access',
    kind: 'source',
    module: '@deepseek-ai/dsh-client-connection',
    file: 'lib/types/rpc-host.d.ts',
    contains: 'authenticatedUrl',
    what: 'connection.authenticatedUrl()（二维码里要带 token）'
  },
  {
    plugin: 'lan_access',
    kind: 'source',
    module: '@deepseek-ai/dsh-host-webserver',
    file: 'lib/types/index.d.ts',
    contains: 'port',
    what: 'webServer.port（反代要指向真实上游端口）'
  },
  {
    plugin: 'multimodal',
    kind: 'proto',
    module: '@deepseek-ai/dsh-settings',
    exportCandidates: ['SettingsProvider', 'SettingsForms'],
    has: ['describe', 'mutate'],
    what: 'settings.describe() / mutate(ns, ops, revision)（多模态开关写入）'
  },
  {
    plugin: 'multimodal',
    kind: 'service',
    module: '@deepseek-ai/dsh-settings',
    name: 'settings',
    what: 'ctx.settings 服务名（类型名改过：SettingsProvider -> SettingsForms）'
  },
  {
    plugin: 'multimodal',
    kind: 'proto',
    module: '@deepseek-ai/dsh-agent-default-model',
    exportCandidates: ['AgentDefaultModel', 'AgentDefaultModelConfig'],
    has: ['currentSelection'],
    what: 'agentDefaultModel.currentSelection()（默认模型回退）'
  },
  {
    plugin: 'multimodal',
    kind: 'service',
    module: '@deepseek-ai/dsh-agent-default-model',
    name: 'agentDefaultModel',
    what: 'ctx.agentDefaultModel 服务名'
  },
  {
    plugin: '使用会话日志的插件',
    kind: 'service',
    module: '@deepseek-ai/dsh-session-query',
    name: 'sessionQuery',
    what: 'ctx.sessionQuery 服务名（retry / loop_guard / git_changes 都读它）'
  },
  {
    plugin: 'retry + thinking_loop_guard',
    kind: 'service',
    module: '@deepseek-ai/dsh-api-session-controller',
    name: 'sessionController',
    what: 'ctx.sessionController 服务名'
  },
  {
    plugin: 'dsh-cf + dsh-opencode',
    kind: 'service',
    module: '@deepseek-ai/dsh-workspace',
    name: 'workspaceRegistry',
    what: 'ctx.workspaceRegistry 服务名'
  },
  {
    plugin: 'gitbash（极简模式）',
    kind: 'service',
    module: '@deepseek-ai/dsh-terminal',
    name: 'terminals',
    what: 'ctx.terminals 服务名（持久 shell 工具用）'
  },
  {
    plugin: 'gitbash + usage',
    kind: 'service',
    module: '@deepseek-ai/dsh-session',
    name: 'session',
    what: "ctx.session 服务名（usage 的静态 inject 就写它）"
  },
  {
    plugin: '全部（网页入口）',
    kind: 'service',
    module: '@deepseek-ai/dsh-client-connection',
    name: 'connection',
    what: 'ctx.connection 服务名（只有 web profile 提供）'
  },
  {
    plugin: 'lan_access',
    kind: 'service',
    module: '@deepseek-ai/dsh-host-webserver',
    name: 'webServer',
    what: 'ctx.webServer 服务名'
  },
  {
    plugin: 'gitbash',
    kind: 'service',
    module: '@deepseek-ai/dsh-tools',
    name: 'tools',
    what: 'ctx.tools 服务名（工具改名拦的就是它）'
  },
  {
    plugin: 'dsh-cf + dsh-opencode',
    kind: 'proto',
    module: '@deepseek-ai/dsh-workspace',
    export: 'WorkspaceRegistry',
    has: ['list'],
    what: 'workspaceRegistry.list()（上报要用工作区路径）'
  },

  {
    plugin: 'review',
    kind: 'source',
    module: '@deepseek-ai/dsh-tool-fs',
    file: 'lib/index.js',
    contains: 'name: "write"',
    what: '写文件工具名（review 靠它记 before/after）'
  },
  {
    plugin: 'review',
    kind: 'source',
    module: '@deepseek-ai/dsh-tool-str-replace-editor',
    file: 'lib/index.js',
    contains: 'name: "str_replace_editor"',
    what: '编辑器工具名（review 靠它记 before/after）'
  },

  /* ── 浏览器半边的 DOM/插槽契约（断了不报错，只是界面里没入口）───────────── */
  {
    plugin: 'retry + thinking_loop_guard（浏览器半边）',
    kind: 'source-any',
    candidates: [
      { module: '@deepseek-ai/dsh-client-ui-workspace', file: 'lib/client.js', contains: 'openSession(target)' },
      { module: '@deepseek-ai/dsh-client-ui-workspace', file: 'lib/client.js', contains: 'openSession(sessionId)' },
      { module: '@deepseek-ai/dsh-api-session-controller', file: 'lib/client.js', contains: 'open(id)' }
    ],
    what: '「把界面切到某个会话」的入口（0.1.7 把 sessions.open 换成了 uiWorkspace.openSession）'
  },
  {
    plugin: '全部（浏览器半边）',
    kind: 'source',
    module: '@deepseek-ai/dsh-client-modules',
    file: 'lib/client.js',
    contains: '__ModuleLoader__.load({',
    what: '浏览器端的模块加载器契约（每个 client.js 的第一行就是它）'
  },
  {
    plugin: 'retry',
    kind: 'source',
    module: '@deepseek-ai/dsh-client-ui-chat',
    file: 'lib/client.js',
    contains: 'data-chat-flow-kind',
    what: '对话行 kind 属性（重试按钮锚在用户行上）'
  },
  {
    plugin: 'retry',
    kind: 'source',
    module: '@deepseek-ai/dsh-client-ui-chat',
    file: 'lib/client.js',
    contains: 'data-chat-turn',
    what: '对话行轮次属性（重试要知道是第几轮）'
  },
  {
    plugin: 'thinking_loop_guard',
    kind: 'source',
    module: '@deepseek-ai/dsh-client-ui-conversation',
    file: 'lib/client.js',
    contains: 'data-composer-card',
    what: '输入框卡片属性（守卫按钮锚在底栏上）'
  },
  {
    plugin: 'usage + lan_access',
    kind: 'source',
    module: '@deepseek-ai/dsh-client-ui-sidebar',
    file: 'lib/client.js',
    contains: 'sidebar.footer.action',
    what: '侧边栏底部动作插槽（左下角两个入口）'
  },
  {
    plugin: 'git_changes + review',
    kind: 'source',
    module: '@deepseek-ai/dsh-client-ui-conversation',
    file: 'lib/client.js',
    contains: 'conversation.session.header.utilities',
    what: '会话 header 工具区插槽'
  },
  {
    plugin: 'multimodal',
    kind: 'source',
    module: '@deepseek-ai/dsh-client-ui-conversation',
    file: 'lib/client.js',
    contains: 'conversation.input.right',
    what: '输入框右侧插槽'
  }
]

/* -------------------------------------------------------------------------- */
/* 检查执行                                                                     */
/* -------------------------------------------------------------------------- */

const results = []

function pass(version, check, detail) {
  results.push({ version, ok: true, plugin: check.plugin, what: check.what, detail })
}
function fail(version, check, detail) {
  results.push({ version, ok: false, plugin: check.plugin, what: check.what, detail })
}

const moduleCache = new Map()

async function loadModule(nodeModules, specifier) {
  const key = `${nodeModules}::${specifier}`
  if (moduleCache.has(key)) return moduleCache.get(key)
  const promise = (async () => {
    const req = createRequire(join(nodeModules, 'probe.js'))
    return import(pathToFileURL(req.resolve(specifier)).href)
  })()
  moduleCache.set(key, promise)
  return promise
}

/** 这个包提供了哪些 ctx 服务：从 lib/types/**\/*.d.ts 的 Context 声明里抓 `名字: 类型`。 */
async function runServiceCheck(version, nodeModules, check) {
  const root = join(nodeModules, check.module)
  const pattern = new RegExp(`^\\s{2,}${check.name}\\s*:\\s*([A-Za-z_$][\\w$]*)`, 'm')
  const files = []
  const walk = (dir) => {
    let names
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const path = join(dir, name)
      let info
      try {
        info = statSync(path)
      } catch {
        continue
      }
      if (info.isDirectory()) walk(path)
      else if (name.endsWith('.d.ts')) files.push(path)
    }
  }
  walk(join(root, 'lib'))
  for (const file of files) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const hit = pattern.exec(text)
    if (hit !== null) {
      pass(version, check, `${check.name}: ${hit[1]}`)
      return
    }
  }
  fail(version, check, `${check.module} 的类型声明里找不到服务 ${check.name}`)
}

async function runProtoCheck(version, nodeModules, check) {
  let mod
  try {
    mod = await loadModule(nodeModules, check.module)
  } catch (error) {
    fail(version, check, `加载不到 ${check.module}：${String(error.message ?? error).slice(0, 80)}`)
    return
  }
  // 类名会随版本改（SettingsProvider -> SettingsForms），所以按 candidates 逐个试，
  // 最后退回 default 导出 —— 插件只认方法名，不认类名。
  const candidates = [
    ...(Array.isArray(check.exportCandidates) ? check.exportCandidates : []),
    ...(check.export === undefined ? [] : [check.export])
  ]
  let ctor
  for (const name of candidates) {
    const candidate = mod[name] ?? mod.default?.[name]
    if (typeof candidate === 'function') {
      ctor = candidate
      break
    }
  }
  if (ctor === undefined && typeof mod.default === 'function') ctor = mod.default
  if (typeof ctor !== 'function') {
    fail(version, check, `${check.module} 里找不到类：${candidates.join('、') || '(default)'}`)
    return
  }
  const label = ctor.name.length > 0 ? ctor.name : 'default'
  const members = new Set([
    ...Object.getOwnPropertyNames(ctor.prototype ?? {}),
    ...Object.getOwnPropertyNames(ctor)
  ])
  if (Array.isArray(check.has)) {
    const missing = check.has.filter((name) => !members.has(name))
    if (missing.length > 0) {
      fail(version, check, `${label}.prototype 缺：${missing.join('、')}`)
      return
    }
    pass(version, check, `${label} 上有 ${check.has.length} 个方法`)
    return
  }
  const groups = Array.isArray(check.anyOf) ? check.anyOf : []
  const hit = groups.find((group) => group.every((name) => members.has(name)))
  if (hit === undefined) {
    fail(version, check, `${label} 上没有任何一组齐全：${groups.map((g) => g.join('/')).join(' 或 ')}`)
    return
  }
  pass(version, check, `${label} 命中 ${hit.join('/')}`)
}

function runSourceCheck(version, nodeModules, check) {
  const file = join(nodeModules, check.module, check.file)
  if (!existsSync(file)) {
    fail(version, check, `文件不存在：${check.module}/${check.file}`)
    return
  }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    fail(version, check, `读不了 ${file}：${String(error.message ?? error).slice(0, 80)}`)
    return
  }
  if (!text.includes(check.contains)) {
    fail(version, check, `源码里搜不到 ${JSON.stringify(check.contains)}`)
    return
  }
  pass(version, check, `含 ${JSON.stringify(check.contains)}`)
}

/** 一组候选里命中任意一个就算过（用来表达「入口搬过家，两条路都在插件里兜住了」）。 */
function runSourceAnyCheck(version, nodeModules, check) {
  const tried = []
  for (const candidate of check.candidates) {
    const file = join(nodeModules, candidate.module, candidate.file)
    tried.push(`${candidate.module}/${candidate.file} 含 ${JSON.stringify(candidate.contains)}`)
    if (!existsSync(file)) continue
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (text.includes(candidate.contains)) {
      pass(version, check, `命中 ${candidate.module} 的 ${JSON.stringify(candidate.contains)}`)
      return
    }
  }
  fail(version, check, `候选都没命中：${tried.join('；')}`)
}

async function runModuleAnyCheck(version, nodeModules, check) {  const hits = []
  for (const specifier of check.modules) {
    try {
      const mod = await loadModule(nodeModules, specifier)
      if (typeof mod[check.export] === 'function') hits.push(specifier)
    } catch {
      // 这个版本没有这个包名，正常
    }
  }
  if (hits.length === 0) {
    fail(version, check, `这些包名里没有一个能提供 ${check.export}：${check.modules.join('、')}`)
    return
  }
  pass(version, check, `由 ${hits[0]} 提供`)
}

/**
 * 真跑一条命令：确认「执行器被换成了 Git Bash」这件事**在这个版本上确实生效**。
 * 假 ctx + 假 this（上游执行器是 cordis Service，构造需要真 ctx，那套起不来）。
 *
 * 两个执行器都跑：无沙箱的（默认）和沙箱的（`DSH_GITBASH_SANDBOX=1` 分支）——
 * 沙箱那条在 0.1.7 还多了一次「confine 第三个参数 signal / execute 统一入口」的
 * 改名，只测无沙箱会漏掉一半。
 */
async function runGitBashDrive(version, nodeModules) {
  const pluginUrl = pathToFileURL(join(pluginsRoot, 'gitbash', 'gitbash-shell.mjs')).href
  process.env.DSH_GITBASH_MODULE_ROOT = nodeModules
  let mod
  try {
    mod = await import(`${pluginUrl}?slot=${encodeURIComponent(version)}`)
  } catch (error) {
    fail(version, { plugin: 'gitbash', what: '真跑一条 bash 命令，argv 必须是 Git Bash 绝对路径' },
      `插件加载失败：${String(error.message ?? error).slice(0, 120)}`)
    return
  }

  const internals = mod.internals ?? {}
  const { upstream } = internals
  if (typeof internals.GitBashLocalExecutor !== 'function') {
    fail(version, { plugin: 'gitbash', what: '真跑一条 bash 命令，argv 必须是 Git Bash 绝对路径' },
      '插件没有导出 GitBashLocalExecutor（internals 里没有，无法真跑验证）')
    return
  }
  const legacy = typeof upstream?.LocalBashExecutor?.prototype?.run === 'function'

  const num = { timeoutMs: 120000, maxTimeoutMs: 600000, maxOutputBytes: 64000, maxSpillBytes: 64 * 1024 * 1024, graceMs: 3000 }
  const configFor = () => {
    const out = {}
    for (const [key, value] of Object.entries(num)) out[key] = legacy ? value : { get: () => value }
    out.cwd = legacy ? undefined : { get: () => undefined }
    return out
  }
  const reader = { readFrom: () => ({ text: '', lossy: false, nextOffset: 0 }) }

  /** 造一个「没走构造函数」的执行器实例（类字段自己补）。 */
  const makeExecutor = (Ctor, mode, seen) => {
    const sandbox = {
      confine(argv, policy) {
        seen.confine = argv
        const result = { argv: ['<runner>', ...argv], enforcement: 'test', denialSignatures: [], runnerFailureRules: [] }
        return legacy ? result : Promise.resolve(result)
      }
    }
    const executor = Object.create(Ctor.prototype)
    executor.ctx = {
      subprocess: {
        spawn(spec) {
          seen.spawned.push(spec.argv)
          return {
            done: Promise.resolve({ exitCode: 0, signal: null }),
            collected: { stdout: reader, stderr: reader },
            terminate() {}
          }
        }
      },
      sandbox,
      get(id) {
        if (id === 'sandbox') return sandbox
        if (id === 'sandboxPolicy') return { defaultMode: mode, resolve: () => ({ mode }) }
        return undefined
      }
    }
    // 上游的类字段：绕开构造函数就得自己补（mode 是沙箱执行器记的部署模式）
    executor.mode = mode
    executor.processFacts = new Map()
    try {
      executor.config = configFor()
    } catch {
      executor.source = () => configFor() // 老版本：config 是原型 getter
    }
    return executor
  }

  const driveOne = async (label, Ctor, mode) => {
    const check = { plugin: 'gitbash', what: `${label}：真跑命令，argv 必须是 Git Bash 绝对路径` }
    const seen = { spawned: [], confine: undefined }
    const executor = makeExecutor(Ctor, mode, seen)
    const spec = {
      command: 'echo compat-probe',
      workdir: process.cwd(),
      timeoutMs: 5000,
      onExpiry: 'kill',
      stdoutMaxBytes: 65536,
      sandboxPolicy: { mode }
    }
    let out
    try {
      if (legacy) {
        out = await executor.run(spec)
      } else {
        const handle = await executor.execute(spec)
        out = handle !== null && typeof handle === 'object' && typeof handle.result === 'function' ? await handle.result() : handle
      }
    } catch (error) {
      fail(version, check, `执行器调用抛错：${String(error.message ?? error).slice(0, 120)}`)
      return
    }

    const argv = seen.spawned.at(-1) ?? seen.confine
    if (!Array.isArray(argv) || argv.length === 0) {
      fail(version, check, '执行器没有把命令交给 subprocess（没有捕获到 spawn）')
      return
    }
    // 沙箱分支的 argv 会被 runner 包一层，真正的 shell 在 argv 里
    const program = argv.includes('bash') ? 'bash' : argv.find((part) => /(^|[\\/])bash(\.exe)?$/i.test(part))
    if (program === undefined || program === 'bash') {
      fail(version, check, `argv 里没有 Git Bash 绝对路径：${JSON.stringify(argv)}`)
      return
    }
    if (!existsSync(program)) {
      fail(version, check, `argv 里的 bash 不存在：${program}`)
      return
    }
    const probe = spawnSync(program, ['-c', 'printf compat-probe'], { encoding: 'utf8' })
    if (probe.status !== 0 || (probe.stdout ?? '') !== 'compat-probe') {
      fail(version, check, `Git Bash 起不来（exit=${probe.status}）：${String(probe.stderr ?? '').slice(0, 120)}`)
      return
    }
    const sandboxFact = out?.sandbox?.mode
    pass(version, check, `${legacy ? 'run' : 'execute'} -> ${program}${sandboxFact === undefined ? '' : `（sandbox=${sandboxFact}）`}`)
  }

  await driveOne('无沙箱执行器（默认）', internals.GitBashLocalExecutor, 'workspace-write')
  if (typeof internals.GitBashSandboxExecutor === 'function') {
    await driveOne('沙箱执行器（DSH_GITBASH_SANDBOX=1）', internals.GitBashSandboxExecutor, 'workspace-write')
  }
}

/* -------------------------------------------------------------------------- */

/**
 * 与 dsh 版本无关的自检：**用 `--dsw-specific-menu` 的浮层必须同时给
 * `backdrop-filter`**。
 *
 * 为什么单列一条：dsh 0.1.7 把 `--dsw-specific-menu` 从「不透明色
 * （`var(--dsw-alias-bg-layer-3)`）」改成了**半透明色**（浅色 `#f8f9fa94`、
 * 深色 `#30313680`），并配 `--dsw-menu-backdrop-filter`（`blur(40px)
 * saturate(150%)`）把面板糊实。只留 background 的面板在新版上会变成「透明白」
 * —— 能看见底下滚动的对话内容（用户实测报过「dsh-cf 面板背景变透明白」）。
 * 老版本没有 `--dsw-menu-backdrop-filter`，回退 `none`，画面与升级前一致。
 */
function auditPanelBackdrop() {
  const roots = [join(pluginsRoot), join(pluginsRoot, '..', 'plugins-third-party')]
  let checked = 0
  for (const root of roots) {
    let names
    try {
      names = readdirSync(root)
    } catch {
      continue
    }
    for (const name of names) {
      const file = join(root, name, 'lib', 'client.js')
      if (!existsSync(file)) continue
      const text = readFileSync(file, 'utf8')
      if (!text.includes('--dsw-specific-menu')) continue
      checked += 1
      const check = { plugin: name, what: '浮层用了 --dsw-specific-menu，必须配 backdrop-filter' }
      if (text.includes('--dsw-menu-backdrop-filter')) pass('（与版本无关）', check, '已配')
      else fail('（与版本无关）', check, '缺 backdrop-filter:var(--dsw-menu-backdrop-filter,none)')
    }
  }
  if (checked === 0) {
    console.log('  ! 没有找到任何用 --dsw-specific-menu 的浮层（检查路径对不对？）')
  }
}

/**
 * 与 dsh 版本无关的自检（二）：**浏览器半边不许用属性访问取非注入的服务**。
 *
 * 为什么单列一条：cordis 的 ctx 是个 Proxy —— 属性访问 `ctx.foo` 只对
 * 「写进 `inject` 且已就绪」的服务安全，其余情况那个 getter 会**抛**
 * `cannot get property "foo" without inject`（服务还没被 provide、或者活在别的
 * isolate 里，都算「没有」）。而 apply 抛异常 = 整个条目变 failed，界面上直接报
 * `dsh-loop-guard: failed`（用户实测踩过：换会话入口搬到 uiWorkspace 之后，
 * 插件在它还没挂上时用属性访问读了一次）。
 *
 * 可选服务一律走 **`ctx.get(id)`**（拿不到给 undefined，不抛）。
 * 这条检查做两件事：静态看「有没有非注入属性的访问」，再真跑一次 apply
 * （假 document + **严格 ctx**：访问未知服务就抛，模拟 cordis 的真实行为）。
 */
const CORDIS_CTX_MEMBERS = new Set([
  'get', 'set', 'on', 'once', 'off', 'emit', 'parallel', 'waterfall', 'bail', 'sequential',
  'inject', 'provide', 'effect', 'plugin', 'scope', 'isolate', 'logger', 'reflect', 'fiber',
  'start', 'stop', 'dispose', 'root', 'registry', 'lifecycle'
])

function clientFiles() {
  const roots = [join(pluginsRoot), join(pluginsRoot, '..', 'plugins-third-party')]
  const out = []
  for (const root of roots) {
    let names
    try {
      names = readdirSync(root)
    } catch {
      continue
    }
    for (const name of names) {
      const file = join(root, name, 'lib', 'client.js')
      if (existsSync(file)) out.push({ id: name, file })
    }
  }
  return out
}

/** 从 client.js 里读它声明的 inject 列表。 */
function injectOf(text) {
  const match = /(?:exports\.inject|const inject)\s*=\s*\[([^\]]*)\]/.exec(text)
  if (match === null) return []
  return match[1]
    .split(',')
    .map((part) => part.trim().replace(/^["']|["']$/g, ''))
    .filter((part) => part.length > 0)
}

/** 假 DOM 节点：够「模块体 + apply 的浅层路径」跑起来就行。 */
function makeStubNode(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    childNodes: [],
    children: [],
    parentNode: null,
    parentElement: null,
    dataset: {},
    style: {},
    hidden: false,
    isConnected: true,
    offsetParent: null,
    listeners: {},
    className: '',
    innerHTML: '',
    textContent: '',
    setAttribute() {},
    getAttribute() {
      return null
    },
    removeAttribute() {},
    hasAttribute() {
      return false
    },
    appendChild(child) {
      this.childNodes.push(child)
      if (child !== null && typeof child === 'object') child.parentNode = this
      return child
    },
    insertBefore(child) {
      return child
    },
    removeChild() {},
    remove() {},
    addEventListener(type, handler) {
      ;(this.listeners[type] ??= []).push(handler)
    },
    removeEventListener() {},
    querySelector() {
      return null
    },
    querySelectorAll() {
      return []
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
    },
    contains() {
      return false
    },
    focus() {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }
  }
}

/**
 * 真跑 apply：假 DOM + **严格 ctx**（未知服务属性访问就抛，和 cordis 一样）。
 * 只跑到「apply 返回」为止 —— 够抓住「启动即抛」这一类（实测那次就是这种）。
 */
async function runClientApplyDrive(entry, index) {
  const check = { plugin: entry.id, what: '浏览器半边 apply 在严格 ctx 下不抛（可选服务要走 ctx.get）' }
  let text
  try {
    text = readFileSync(entry.file, 'utf8')
  } catch (error) {
    fail('（与版本无关）', check, `读不了：${String(error?.message ?? error).slice(0, 80)}`)
    return
  }
  const injected = injectOf(text)

  // 静态：非注入服务的属性访问（先剥注释 —— 注释里写着 `ctx.uiWorkspace` 不算访问）
  const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  const accessed = new Set()
  for (const match of code.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) accessed.add(match[1])
  const suspicious = [...accessed].filter(
    (name) => !injected.includes(name) && !CORDIS_CTX_MEMBERS.has(name)
  )

  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    MutationObserver: globalThis.MutationObserver
  }
  let registration = null
  try {
    globalThis.document = {
      head: makeStubNode('head'),
      documentElement: makeStubNode('html'),
      body: null, // 让插件走「等 DOMContentLoaded」那条浅路，不做真 DOM 操作
      createElement: (tag) => makeStubNode(tag),
      createTextNode: (value) => ({ textContent: value }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
      activeElement: null
    }
    globalThis.MutationObserver = class {
      observe() {}
      disconnect() {}
    }
    globalThis.window = {
      // 真窗口：review 这类插件会在 apply 里挂 window 级监听
      addEventListener() {},
      removeEventListener() {},
      innerWidth: 1280,
      innerHeight: 800,
      getComputedStyle: () => ({ marginLeft: '0px', paddingLeft: '0px' }),
      __ModuleLoader__: {
        load: (value) => {
          registration = value
        }
      }
    }

    await import(`${pathToFileURL(entry.file).href}?drive=${index}`)

    if (registration === null || typeof registration.factory !== 'function') {
      fail('（与版本无关）', check, '没走 window.__ModuleLoader__.load 注册')
      return
    }
    // 需要 react / react-dom 的插件：给个「什么属性都能当函数用」的替身。
    // 模块体只做常量与组件定义、不进渲染，够用。
    const makeModule = () =>
      new Proxy(
        {},
        {
          get: (_target, prop) => {
            if (prop === 'then') return undefined
            return (...args) => {
              if (prop === 'createPortal') return args[0]
              return makeStubNode('div')
            }
          }
        }
      )
    const exported = registration.factory(makeModule)
    if (exported === null || typeof exported.apply !== 'function') {
      fail('（与版本无关）', check, '没导出 apply')
      return
    }

    // 注入的服务：什么属性都能当函数调用（slots.inject / slots.register /
    // sessions.refresh / sessions.open …），免得假替身比真服务还苛刻。
    const serviceStub = () =>
      new Proxy(
        {},
        {
          get: (_target, prop) => {
            if (prop === 'then') return undefined
            if (typeof prop === 'symbol') return undefined
            return () => {}
          }
        }
      )

    const strictCtx = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (typeof prop === 'symbol') return undefined
          if (CORDIS_CTX_MEMBERS.has(prop)) {
            if (prop === 'get') return (id) => (injected.includes(id) ? serviceStub() : undefined)
            return () => {}
          }
          if (injected.includes(prop)) return serviceStub()
          // 和 cordis 一样：没注入的服务属性访问直接抛
          throw new Error(`cannot get property "${String(prop)}" without inject`)
        }
      }
    )
    try {
      exported.apply(strictCtx)
    } catch (error) {
      fail(
        '（与版本无关）',
        check,
        `apply 抛错：${String(error?.message ?? error).slice(0, 160)}` +
          (suspicious.length > 0 ? `（静态也发现非注入访问：${suspicious.join('、')}）` : '')
      )
      return
    }
    if (suspicious.length > 0) {
      fail('（与版本无关）', check, `属性访问了非注入服务：${suspicious.join('、')}（应改 ctx.get）`)
      return
    }
    pass('（与版本无关）', check, `inject=[${injected.join(',')}]，apply 未抛`)
  } catch (error) {
    fail('（与版本无关）', check, `驱动失败（可能假 DOM 不够）：${String(error?.message ?? error).slice(0, 160)}`)
  } finally {
    globalThis.document = saved.document
    globalThis.window = saved.window
    globalThis.MutationObserver = saved.MutationObserver
  }
}

async function auditClientHalves() {
  for (const [index, entry] of clientFiles().entries()) {
    await runClientApplyDrive(entry, index)
  }
}

for (const slot of SLOTS) {
  const { version, nodeModules } = slot
  console.log(`\n===== dsh ${version}（${nodeModules}）`)
  if (!existsSync(nodeModules)) {
    console.log('  ! 槽位里没有 node_modules，跳过')
    continue
  }
  for (const check of CHECKS) {
    try {
      if (check.kind === 'proto') await runProtoCheck(version, nodeModules, check)
      else if (check.kind === 'service') await runServiceCheck(version, nodeModules, check)
      else if (check.kind === 'source') runSourceCheck(version, nodeModules, check)
      else if (check.kind === 'source-any') runSourceAnyCheck(version, nodeModules, check)
      else if (check.kind === 'module-any') await runModuleAnyCheck(version, nodeModules, check)
    } catch (error) {
      // 单项检查自己崩了也算失败，不能带崩整轮
      fail(version, check, `检查抛错：${String(error?.message ?? error).slice(0, 120)}`)
    }
  }
  try {
    await runGitBashDrive(version, nodeModules)
  } catch (error) {
    fail(version, { plugin: 'gitbash', what: '真跑一条 bash 命令，argv 必须是 Git Bash 绝对路径' },
      `检查抛错：${String(error?.message ?? error).slice(0, 120)}`)
  }
}

/* -------------------------------------------------------------------------- */
/* 汇总                                                                         */
/* -------------------------------------------------------------------------- */

// 与槽位无关的那两条（浮层 backdrop-filter / 浏览器半边 apply）放在最后跑，
// 报告里单列一组
auditPanelBackdrop()
await auditClientHalves()
SLOTS.push({ version: '（与版本无关）' })

let failed = 0
for (const slot of SLOTS) {
  const mine = results.filter((row) => row.version === slot.version)
  if (mine.length === 0) continue
  console.log(`\n----- dsh ${slot.version}`)
  for (const row of mine) {
    const mark = row.ok ? 'ok  ' : 'FAIL'
    console.log(`  [${mark}] ${row.plugin}：${row.what}`)
    if (!row.ok) console.log(`         ${row.detail}`)
    else if (process.env.DSH_COMPAT_VERBOSE === '1') console.log(`         ${row.detail}`)
    if (!row.ok) failed += 1
  }
}

console.log(`\n共 ${results.length} 项检查，失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)
