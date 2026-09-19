/**
 * lan_access 插件自测的**实际检查**（由 src/tools/probe_lan_access.py 拉起）。
 *
 * 分三块：
 *
 * A. **二维码编码器**（lib/qr.mjs）
 *    - Reed-Solomon 用 ISO/IEC 18004 里 "01234567" 的 v1-M 已知向量对答案；
 *    - 格式信息 / 版本信息用标准已知值对答案；
 *    - 分块表自洽（每版总码字数 = 数据 + 纠错）；
 *    - 端到端：生成矩阵 → 反解格式信息取掩码 → 反掩码 → 反之字形读码字 →
 *      反交错 → 解析 bit 流 → 拿回原文。这一条能把排布/掩码/交错全串起来验一遍。
 *
 * B. **反向代理**（lib/proxy.mjs）
 *    起一个假上游（node:http）扮演 dsh，验证：
 *    - `?lan=<码>` → 303 + cookie；错码 / 无码 → 401；
 *    - 转发时 Host / Origin / Cookie 被改写、上游 Set-Cookie 被剥掉；
 *    - 上游回 401 时会用 launch token 重换 cookie 再试一次；
 *    - HTTP Upgrade 能双向透传（对话流靠它）；
 *    - 内网地址判定。
 *
 * C. **浏览器半边**（lib/client.js）
 *    用假 React 跑一遍组件，验证：模块加载/注册、槽位与 order、
 *    「未开启 / 开启失败 / 已开启」三种状态各自渲染什么（尤其**关闭时不能摆二维码**）、
 *    开关按钮走 POST /api/lan_access.set、以及**入口独占一行**（给父容器加 flex-wrap）。
 *
 * 用法：node probe_lan_access_checks.mjs <插件目录>
 * 退出码 0 表示全部通过。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const pluginDir = process.argv[2]
if (!pluginDir) {
  console.error('用法：node probe_lan_access_checks.mjs <插件目录>')
  process.exit(2)
}

const qr = await import(pathToFileURL(join(pluginDir, 'lib', 'qr.mjs')).href)
const proxyModule = await import(pathToFileURL(join(pluginDir, 'lib', 'proxy.mjs')).href)
const { createProxy, isPrivateAddress, COOKIE_NAME, KEY_PARAM } = proxyModule

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`[${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

/* ========================================================================== */
/* A. 二维码                                                                  */
/* ========================================================================== */

console.log('--- 二维码编码器 ---')

// A1. Reed-Solomon 已知向量（ISO 18004 的 "01234567" v1-M 例子）
const knownData = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11]
const knownEc = [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]
const gotEc = Array.from(qr.internals.rsEncode(Uint8Array.from(knownData), 10))
check('RS 已知向量 v1-M', gotEc.join(',') === knownEc.join(','), gotEc.map((v) => v.toString(16)).join(' '))

// A2. 格式信息已知值
check('formatBits(M,0) = 0x5412', qr.internals.formatBits('M', 0) === 0x5412)
check('formatBits(M,1) = 0x5125', qr.internals.formatBits('M', 1) === 0x5125)
check('formatBits(L,0) = 0x77c4', qr.internals.formatBits('L', 0) === 0x77c4)

// A3. 版本信息已知值
for (const [version, expected] of [[7, 0x07c94], [8, 0x085bc], [9, 0x09a99], [10, 0x0a4d3]]) {
  check(`versionInfoBits(${version})`, qr.internals.versionInfoBits(version) === expected)
}

// A4. 分块表自洽
for (const level of ['L', 'M']) {
  for (let version = 1; version <= 10; version += 1) {
    const [ec, groups] = qr.internals.BLOCKS[level][version]
    let total = 0
    for (const [count, per] of groups) total += count * (per + ec)
    check(`分块表 ${level} v${version}`, total === qr.internals.TOTAL_CODEWORDS[version - 1], String(total))
  }
}

// A5. 端到端回读
const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
]
const ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]]

/** 把矩阵解回原文 —— 相当于写了个最小解码器，用来验编码器。 */
function decode(text, level) {
  const { size, modules, version, ecLevel } = qr.qrMatrix(text, level)

  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false))
  const mark = (row, col) => {
    if (row >= 0 && row < size && col >= 0 && col < size) isFunction[row][col] = true
  }
  for (let i = 0; i < size; i += 1) {
    mark(6, i)
    mark(i, 6)
  }
  const finder = (cr, cc) => {
    for (let dy = -4; dy <= 4; dy += 1) for (let dx = -4; dx <= 4; dx += 1) mark(cr + dy, cc + dx)
  }
  finder(3, 3)
  finder(3, size - 4)
  finder(size - 4, 3)
  const positions = ALIGN[version - 1]
  const last = positions.length - 1
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = 0; j < positions.length; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) mark(positions[i] + dy, positions[j] + dx)
    }
  }
  for (let i = 0; i <= 5; i += 1) mark(i, 8)
  mark(7, 8)
  mark(8, 8)
  mark(8, 7)
  for (let i = 9; i < 15; i += 1) mark(8, 14 - i)
  for (let i = 0; i < 8; i += 1) mark(8, size - 1 - i)
  for (let i = 8; i < 15; i += 1) mark(size - 15 + i, 8)
  mark(size - 8, 8)
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      mark(b, a)
      mark(a, b)
    }
  }

  const formatBit = (i) => {
    let row
    let col
    if (i <= 5) { row = i; col = 8 } else if (i === 6) { row = 7; col = 8 } else if (i === 7) { row = 8; col = 8 } else if (i === 8) { row = 8; col = 7 } else { row = 8; col = 14 - i }
    return modules[row][col] ? 1 : 0
  }
  let format = 0
  for (let i = 0; i < 15; i += 1) format |= formatBit(i) << i
  const payload = format ^ 0x5412
  const mask = (payload >>> 10) & 7
  const levelFromFormat = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' }[payload >>> 13]

  const stream = []
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const col = right - j
        const upward = ((right + 1) & 2) === 0
        const row = upward ? size - 1 - vert : vert
        if (isFunction[row][col]) continue
        let dark = modules[row][col]
        if (MASKS[mask](col, row)) dark = !dark
        stream.push(dark ? 1 : 0)
      }
    }
  }
  const codewords = []
  for (let i = 0; i + 8 <= stream.length; i += 8) {
    let value = 0
    for (let j = 0; j < 8; j += 1) value = (value << 1) | stream[i + j]
    codewords.push(value)
  }

  const [ecPerBlock, groups] = qr.internals.BLOCKS[ecLevel][version]
  const lens = []
  for (const [count, per] of groups) for (let i = 0; i < count; i += 1) lens.push(per)
  const blocks = lens.map(() => [])
  let cursor = 0
  const maxData = Math.max(...lens)
  for (let i = 0; i < maxData; i += 1) {
    for (let b = 0; b < lens.length; b += 1) if (i < lens[b]) blocks[b].push(codewords[cursor++])
  }
  const data = []
  for (const block of blocks) data.push(...block)
  void ecPerBlock

  const bits = []
  for (const byte of data) for (let i = 7; i >= 0; i -= 1) bits.push((byte >>> i) & 1)
  let pos = 0
  const take = (n) => {
    let value = 0
    for (let i = 0; i < n; i += 1) value = (value << 1) | bits[pos++]
    return value
  }
  const mode = take(4)
  const length = take(version < 10 ? 8 : 16)
  const bytes = []
  for (let i = 0; i < length; i += 1) bytes.push(take(8))
  return { text: new TextDecoder().decode(Uint8Array.from(bytes)), mode, version, levelFromFormat }
}

const samples = [
  'http://192.168.1.5:3081/?lan=abcdefghijklmnopqrstuv',
  'http://10.0.0.7:3081/?lan=Zx9-_QwErTyUiOpAsDfGh',
  'http://172.16.31.254:3081/?lan=0123456789012345678901',
  'http://192.168.100.100:3081/',
  'https://example.com/',
  'x'
]
for (const sample of samples) {
  const result = decode(sample, 'M')
  check(`回读 "${sample.length > 44 ? sample.slice(0, 44) + '…' : sample}"`, result.text === sample, `v${result.version} 等级 ${result.levelFromFormat}`)
  check('  模式指示符 = byte', result.mode === 0b0100)
}
const long = 'http://192.168.1.5:3081/?lan=' + 'a'.repeat(120)
check('超长内容仍可编码并回读', decode(long, 'M').text === long)

const svg = qr.qrSvg('http://192.168.1.5:3081/?lan=abcdefghijklmnopqrstuv')
check('qrSvg 输出完整 SVG', svg.startsWith('<svg ') && svg.endsWith('</svg>') && svg.includes('<path d="M'))

/* ========================================================================== */
/* B. 反向代理                                                                */
/* ========================================================================== */

console.log('--- 反向代理 ---')

const TOKEN = 'launch-token-for-test'
const KEY = 'test-access-key-0123456'

/** 起一个假上游扮演 dsh；返回端口与统计。 */
function startUpstream() {
  const state = { mints: 0, tokenHosts: [], strictHits: 0 }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://upstream.invalid')

    // 登录跳转：换 cookie。**必须**带正确的回环 Host —— 这正是代理的关键手法
    if (url.pathname === '/' && url.searchParams.has('token')) {
      state.tokenHosts.push(req.headers.host)
      if (req.headers.host !== `127.0.0.1:${String(server.address().port)}`) {
        res.writeHead(400)
        res.end('bad host')
        return
      }
      if (url.searchParams.get('token') !== TOKEN) {
        res.writeHead(401)
        res.end('bad token')
        return
      }
      state.mints += 1
      res.writeHead(303, {
        'set-cookie': `dsh-auth-test=c${String(state.mints)}; Path=/; HttpOnly; SameSite=Strict`,
        location: '/'
      })
      res.end()
      return
    }

    // 回显收到的头，用来验证改写；顺手塞一个 Set-Cookie 验证它会被剥掉
    if (url.pathname === '/echo') {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'leak-me=1; Path=/' })
      res.end(JSON.stringify({
        host: req.headers.host,
        cookie: req.headers.cookie,
        origin: req.headers.origin,
        referer: req.headers.referer
      }))
      return
    }

    // 只认第二次换到的 cookie，用来验证 401 重换路径
    if (url.pathname === '/api/strict') {
      state.strictHits += 1
      if (req.headers.cookie !== 'dsh-auth-test=c2') {
        res.writeHead(401)
        res.end('stale')
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('fresh')
      return
    }

    res.writeHead(404)
    res.end()
  })

  // WebSocket 握手：回 101，然后把收到的关键头当正文写回去
  //
  // 升级后的 socket 会脱离 server 的连接跟踪，close() 不会管它 —— 自己收着，
  // 收尾时一起 destroy，否则 server.close() 的回调永远不回来（进程挂死）。
  const upgraded = new Set()
  server.on('upgrade', (req, socket) => {
    upgraded.add(socket)
    socket.on('close', () => upgraded.delete(socket))
    socket.on('error', () => {})
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.write(`HOST=${String(req.headers.host)}|COOKIE=${String(req.headers.cookie)}|ORIGIN=${String(req.headers.origin)}`)
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        server,
        state,
        port: server.address().port,
        close: () =>
          new Promise((done) => {
            for (const socket of upgraded) socket.destroy()
            server.close(() => done())
            server.closeAllConnections?.()
          })
      })
    )
  })
}

/** 占一个端口再放掉，拿到一个（大概率）空闲的端口号。 */
function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

function request(port, options) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: options.path,
        method: options.method ?? 'GET',
        headers: options.headers ?? {}
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

/** 直连代理发一个 WebSocket 握手，读回上游写来的那串正文。 */
function upgrade(port, headers) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let buffer = ''
    const done = () => {
      socket.destroy()
      resolve(buffer)
    }
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      const lines = ['GET /api/remote.mux HTTP/1.1', `host: 127.0.0.1:${String(port)}`, 'connection: Upgrade', 'upgrade: websocket']
      for (const [name, value] of Object.entries(headers ?? {})) lines.push(`${name}: ${value}`)
      lines.push('', '')
      socket.write(lines.join('\r\n'))
    })
    socket.on('data', (chunk) => {
      buffer += chunk
      if (buffer.includes('HOST=')) done()
    })
    socket.on('error', reject)
    socket.on('close', () => resolve(buffer))
    setTimeout(done, 3000)
  })
}

// ---- 内网地址判定 ----
for (const [address, expected] of [
  ['127.0.0.1', true],
  ['10.1.2.3', true],
  ['192.168.1.5', true],
  ['172.16.0.1', true],
  ['172.31.255.254', true],
  ['172.32.0.1', false],
  ['169.254.1.1', true],
  ['::1', true],
  ['::ffff:192.168.1.5', true],
  ['8.8.8.8', false],
  ['1.1.1.1', false],
  ['', false]
]) {
  check(`isPrivateAddress(${JSON.stringify(address)}) = ${String(expected)}`, isPrivateAddress(address) === expected)
}

const upstream = await startUpstream()
const proxyPort = await freePort()
const proxy = createProxy({
  upstreamPort: upstream.port,
  getAccessKey: () => KEY,
  getLaunchToken: () => TOKEN,
  allowPublic: false,
  log: () => {}
})
await proxy.start(proxyPort, '127.0.0.1')

try {
  // B1. 无码 / 错码 → 401
  const noKey = await request(proxyPort, { path: '/' })
  check('无访问码 → 401', noKey.status === 401, String(noKey.status))
  const badKey = await request(proxyPort, { path: `/?${KEY_PARAM}=wrong-key-wrong-key` })
  check('错访问码 → 401', badKey.status === 401, String(badKey.status))

  // B2. 对的码 → 303 + cookie
  const redirect = await request(proxyPort, { path: `/?${KEY_PARAM}=${KEY}` })
  const setCookie = String(redirect.headers['set-cookie'] ?? '')
  check('带访问码 → 303', redirect.status === 303, String(redirect.status))
  check('  回干净路径', redirect.headers.location === '/', String(redirect.headers.location))
  check('  发了访问码 cookie', setCookie.includes(`${COOKIE_NAME}=${KEY}`), setCookie)
  check('  cookie 带 HttpOnly', /HttpOnly/i.test(setCookie))
  const cookie = `${COOKIE_NAME}=${KEY}`

  // B3. 带上 cookie 转发，检查头改写
  const echo = await request(proxyPort, { path: '/echo', headers: { cookie, origin: `http://127.0.0.1:${String(proxyPort)}`, referer: `http://127.0.0.1:${String(proxyPort)}/` } })
  const seen = JSON.parse(echo.body)
  check('带 cookie → 200', echo.status === 200, String(echo.status))
  check('  Host 改写成回环上游', seen.host === `127.0.0.1:${String(upstream.port)}`, String(seen.host))
  check('  Cookie 换成 dsh 会话 cookie', String(seen.cookie).startsWith('dsh-auth-test='), String(seen.cookie))
  check('  Origin 改写成回环上游', seen.origin === `http://127.0.0.1:${String(upstream.port)}`, String(seen.origin))
  check('  Referer 跟着改写', seen.referer === `http://127.0.0.1:${String(upstream.port)}/`, String(seen.referer))
  check('  上游 Set-Cookie 被剥掉', echo.headers['set-cookie'] === undefined, String(echo.headers['set-cookie']))
  check('  兑换 cookie 时用了回环 Host', upstream.state.tokenHosts.every((host) => host === `127.0.0.1:${String(upstream.port)}`), upstream.state.tokenHosts.join(' '))

  // B4. 上游 401 → 重换 cookie 再试
  const before = upstream.state.mints
  const strict = await request(proxyPort, { path: '/api/strict', headers: { cookie } })
  check('上游 401 后重换 cookie 并成功', strict.status === 200 && strict.body === 'fresh', `HTTP ${String(strict.status)} / ${strict.body}`)
  check('  确实重换了一次', upstream.state.mints === before + 1, `${String(before)} -> ${String(upstream.state.mints)}`)

  // B5. WebSocket 握手透传
  const ws = await upgrade(proxyPort, { cookie, origin: `http://127.0.0.1:${String(proxyPort)}` })
  check('WebSocket 握手返回 101', ws.startsWith('HTTP/1.1 101'), ws.split('\r\n')[0])
  check('  上游收到改写后的 Host', ws.includes(`HOST=127.0.0.1:${String(upstream.port)}`), ws.split('\r\n\r\n')[1] ?? ws)
  check('  上游收到 dsh 会话 cookie', /COOKIE=dsh-auth-test=/.test(ws))
  const wsDenied = await upgrade(proxyPort, {})
  check('无 cookie 的握手被拒（非 101）', !wsDenied.startsWith('HTTP/1.1 101'), wsDenied.split('\r\n')[0])
} finally {
  // 回归：升级过的 socket 脱离了 http server 的连接跟踪，收尾时必须自己 destroy，
  // 否则 server.close() 会一直等下去（踩过：关服务卡满两分钟）。
  const startedAt = Date.now()
  await proxy.stop()
  await upstream.close()
  const elapsed = Date.now() - startedAt
  check('用过 WebSocket 后关代理不卡住（< 5s）', elapsed < 5000, `${String(elapsed)}ms`)
}

/* ========================================================================== */
/* C. 浏览器半边                                                              */
/* ========================================================================== */

console.log('--- 浏览器半边 ---')

/**
 * 用**假的 React** 把 client.js 跑一遍。
 *
 * 真实浏览器里跑不动（没有 DOM、也没打包 React），但这里要抓的是另一类问题：
 * 模块加载/注册是否正常、组件在「没数据 / 关闭 / 开启失败 / 已开启」几种状态下会不会
 * 因为空值或拼错的变量直接抛异常、以及开关有没有真的 POST 出去。
 *
 * 假 React 只负责把元素树记下来，不渲染 —— 但 effect 要能手动跑（`flush`），
 * 否则「给父容器加 flex-wrap」那条就验不了。
 */
function createFakeReact() {
  let queue = null
  let effects = []
  const react = {
    createElement: (type, props, ...children) => ({ __el: true, type, props: props ?? {}, children }),
    Fragment: Symbol('Fragment'),
    useState: (initial) => {
      if (queue !== null && queue.length > 0) return [queue.shift(), () => {}]
      return [typeof initial === "function" ? initial() : initial, () => {}]
    },
    useEffect: (fn) => {
      effects.push(fn)
    },
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn
  }
  return {
    react,
    reactDom: { createPortal: (element) => element },
    forceStates: (list) => {
      queue = list
      effects = []
    },
    /** 只清 useState 队列，**不动**已记录的 effect（渲染完要接着跑 effect）。 */
    drainStates: () => {
      queue = []
    },
    effects: () => effects
  }
}

/** 遍历假元素树。 */
function walk(node, visit) {
  if (node === null || node === undefined || node === false || node === true) return
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  if (typeof node !== "object" || node.__el !== true) return
  visit(node)
  walk(node.children, visit)
}

/** 找第一个满足条件的元素。 */
function findElement(node, predicate) {
  let found = null
  walk(node, (element) => {
    if (found === null && predicate(element)) found = element
  })
  return found
}

/** 找第一个「直接子节点里含指定文本」的元素（按钮基本都长这样）。 */
function findByText(node, text) {
  return findElement(node, (element) => {
    const children = Array.isArray(element.children) ? element.children : [element.children]
    return children.some((child) => typeof child === "string" && child.includes(text))
  })
}

/**
 * 找按钮。
 *
 * 断言「某个按钮在不在」时不能只用 `flatten` 搜文本 —— 说明文字里也会提到
 * 「重置访问码」这类词，一搜就假阳性。必须限定到 `button` 元素。
 */
function findButton(node, text) {
  return findElement(node, (element) => {
    if (element.type !== "button") return false
    const children = Array.isArray(element.children) ? element.children : [element.children]
    return children.some((child) => typeof child === "string" && child.includes(text))
  })
}

/** 把树里所有文本和关键属性收成一个字符串，方便断言「渲染出来了没有」。 */
function flatten(node) {
  const parts = []
  walk(node, (element) => {
    if (typeof element.props?.src === "string") parts.push(element.props.src)
    if (typeof element.props?.title === "string") parts.push(element.props.title)
    const children = Array.isArray(element.children) ? element.children : [element.children]
    for (const child of children) {
      if (typeof child === "string" || typeof child === "number") parts.push(String(child))
    }
  })
  return parts.join("\n")
}

const fake = createFakeReact()
let definition = null
/** 顶层注入的那段 CSS（断言「独占一行」的规则真的在）。 */
let injectedCss = ''
/** 记录前端发出去的请求（只记录，不真的发）。 */
const fetchCalls = []

// client.js 顶层会往 document.head 塞一段 CSS，渲染面板时又会用到 document.body
// （createPortal 的落点）—— 这里给个最小替身，别让「没有浏览器」变成假失败。
globalThis.document = {
  body: {},
  head: {
    appendChild: (tag) => {
      injectedCss += tag.textContent ?? ''
    }
  },
  createElement: () => ({ dataset: {}, style: {} }),
  querySelector: () => null,
  addEventListener: () => {},
  removeEventListener: () => {}
}
// 相对 URL 在 node 的 fetch 里会直接抛；这里替换成「记录 + 永远 pending」——
// 只关心请求发出去了没有，不关心响应。
globalThis.fetch = (url, options) => {
  fetchCalls.push({ url, options })
  return new Promise(() => {})
}
globalThis.window = {
  __ModuleLoader__: { load: (value) => { definition = value } },
  // 组件靠 computed display 往上找 flex 行容器（要跳过 display:contents 的锚点）
  getComputedStyle: (node) => ({ display: node?.display ?? "block" })
}
await import(pathToFileURL(join(pluginDir, "lib", "client.js")).href)

check("client.js 走模块加载器注册", definition?.id === "dsh-lan-access", String(definition?.id))

const exported = definition.factory((name) => {
  if (name === "react") return fake.react
  if (name === "react-dom") return fake.reactDom
  throw new Error("意外的 require：" + String(name))
})
check("导出 apply / inject", typeof exported.apply === "function" && Array.isArray(exported.inject))
check("inject = ['slots']", exported.inject.length === 1 && exported.inject[0] === "slots", exported.inject.join(","))

let slotName = ""
let registered = null
exported.apply({
  slots: {
    inject: (name, callback) => {
      slotName = name
      callback()
    },
    register: (meta, component) => {
      registered = { meta, component }
    }
  }
})
check("槽位 = sidebar.footer.action", slotName === "sidebar.footer.action", slotName)
check("order = 60（排在设置上方）", registered?.meta?.order === 60, String(registered?.meta?.order))
check("组件已注册", typeof registered?.component === "function")

// 入口的 CSS 必须让自己独占一行：footerActions 是不换行的 flex 行容器，
// 没有这条 `flex:1 1 100%`（配合组件里给父节点加的 wrap）就会和 usage 挤在一行。
check("入口 CSS 声明 flex:1 1 100%（独占一行）", injectedCss.includes(".dshl-root{display:flex;flex:1 1 100%"))

/** 渲染入口：先喂状态，再排空队列，免得后面的面板渲染消费到入口的状态。 */
const renderFooter = (states) => {
  fake.forceStates(states)
  const tree = registered.component({ wide: true })
  fake.drainStates()
  return tree
}

/** 假 DOM 节点。`display` 是给 `getComputedStyle` 用的。 */
const domNode = (display) => ({ display, style: {}, parentElement: null })

/** 按「自己 ← 父 ← 祖父」的顺序接成一条链，返回最内层那个。 */
function chain(...nodes) {
  for (let i = 0; i < nodes.length - 1; i += 1) nodes[i].parentElement = nodes[i + 1]
  return nodes[0]
}

/**
 * 跑一遍组件注册的 effect。
 *
 * 真实 React 是先挂 DOM 再跑 effect，effect 里能拿到已挂载的节点；假渲染器没有 DOM，
 * 这里先把 ref 接到桩节点上再跑，返回所有 cleanup。
 *
 * 只有**根节点**（`.dshl-root`）的 ref 指向传入的挂载点，别的 ref（触发器）给一个
 * `parentElement` 为空的桩 —— 这样「找 flex 容器时用错了 ref」会直接暴露成找不到容器。
 */
function flushEffects(tree, rootNode) {
  walk(tree, (element) => {
    const ref = element.props?.ref
    if (ref === null || typeof ref !== "object" || !("current" in ref)) return
    ref.current = element.props?.className === "dshl-root" ? rootNode : { parentElement: null }
  })
  const cleanups = []
  for (const effect of fake.effects()) {
    const cleanup = effect()
    if (typeof cleanup === "function") cleanups.push(cleanup)
  }
  return cleanups
}

// 打开状态下的入口 + 面板
const opened = renderFooter([true, { left: 10, bottom: 20 }])
const panelElement = findElement(opened, (element) => typeof element.type === "function" && element.type.name === "LanPanel")
check("打开时渲染出 LanPanel", panelElement !== null)

/**
 * 「独占一行」。
 *
 * 真实 DOM 是三层：`footerActions`（flex，不换行）> `div[data-slot]`
 * （`display:contents`，renderSlot 套的锚点）> 本插件的根节点。
 * 组件必须**跳过**那个没有盒子的锚点，把 `flex-wrap` 加到真正的行容器上 ——
 * 只看 `parentElement` 的话会加在锚点上，等于没加（这就是「改完还是两个一半一半」的原因）。
 */
{
  const row = domNode("flex") // footerActions
  const anchor = chain(domNode("contents"), row, domNode("flex")) // 锚点，外面是 footArea(column)
  const mine = domNode("flex")
  mine.parentElement = anchor

  const cleanups = flushEffects(opened, mine)
  check("把 flex-wrap 加在真正的 flex 行容器上（跳过 display:contents 锚点）", row.style.flexWrap === "wrap", String(row.style.flexWrap))
  check("没把 flex-wrap 加在没有盒子的锚点上", anchor.style.flexWrap === undefined, String(anchor.style.flexWrap))
  for (const cleanup of cleanups) cleanup()
  check("卸载后还原行容器的 flex-wrap", row.style.flexWrap === undefined || row.style.flexWrap === "", String(row.style.flexWrap))
}

const sample = {
  enabled: true,
  running: true,
  url: "http://192.168.1.5:3081/?lan=abcdefghijklmnopqrstuv",
  qr: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  ip: "192.168.1.5",
  port: 3081,
  bind: "0.0.0.0",
  addresses: [
    { name: "Wi-Fi", address: "192.168.1.5" },
    { name: "vEthernet (WSL)", address: "172.20.0.1" }
  ],
  allowPublic: false,
  error: ""
}

/** 渲染面板。`onToggle` 单独记下来，方便验开关回调。 */
let toggled = null
const renderPanel = (state, extra = {}) =>
  panelElement.type({
    state,
    anchor: { left: 10, bottom: 20 },
    onRefresh: () => {},
    onReset: () => {},
    onToggle: (next) => {
      toggled = next
    },
    onClose: () => {},
    resetting: false,
    toggling: false,
    ...extra
  })

const QR_PREFIX = "data:image/svg+xml;charset=utf-8,"

// 数据还没读回来时不能炸
let emptyOk = true
try {
  renderPanel({ phase: "loading", data: null, error: "" })
} catch (error) {
  emptyOk = false
  check("数据未就绪时不抛异常", false, String(error?.message ?? error))
}
if (emptyOk) check("数据未就绪时不抛异常", true)

// 已开启：链接、二维码、按钮都要在
const readyPanelTree = renderPanel({ phase: "ready", data: sample, error: "" })
const readyText = flatten(readyPanelTree)
check("面板显示链接", readyText.includes(sample.url))
check("面板渲染二维码 img（data URL）", readyText.includes(QR_PREFIX))
check("面板有复制按钮", readyText.includes("复制链接"))
check("面板有重置按钮", findButton(readyPanelTree, "重置访问码") !== null)
check("面板列出其他网卡地址", readyText.includes("172.20.0.1"))
check("已开启时状态行显示「已开启」", readyText.includes("已开启"))

// 默认关闭（用户没开过）：给说明 + 开启按钮，**不能**摆二维码
const offState = { ...sample, enabled: false, running: false, url: "", qr: "" }
const offPanelTree = renderPanel({ phase: "ready", data: offState, error: "" })
const offText = flatten(offPanelTree)
check("默认关闭时状态行显示「未开启」", offText.includes("未开启"))
check("默认关闭时给「开启局域网访问」按钮", findButton(offPanelTree, "开启局域网访问") !== null)
check("默认关闭时说明「开启后会记住」", offText.includes("下次启动自动恢复"))
check("默认关闭时不渲染二维码", !offText.includes(QR_PREFIX))
check("默认关闭时不显示重置按钮", findButton(offPanelTree, "重置访问码") === null)

// 开了但代理没起来（端口被占）：给原因 + 重试，同样不能摆二维码
const failedState = { ...sample, enabled: true, running: false, error: "EADDRINUSE", url: "", qr: "" }
const failedText = flatten(renderPanel({ phase: "ready", data: failedState, error: "" }))
check("开启失败时显示错误原因", failedText.includes("EADDRINUSE") && failedText.includes("3081"), failedText.split("\n").slice(0, 3).join(" / "))
check("开启失败时状态行显示「开启失败」", failedText.includes("开启失败"))
check("开启失败时给「重试」按钮", failedText.includes("重试"))
check("开启失败时不渲染二维码", !failedText.includes(QR_PREFIX))

// 没有可用内网地址：给提示而不是空二维码
const noIpState = { ...sample, url: "", qr: "", ip: "", addresses: [] }
const noIpText = flatten(renderPanel({ phase: "ready", data: noIpState, error: "" }))
check("没有内网地址时给提示", noIpText.includes("没有找到可用的内网地址"))
check("没有内网地址时不渲染二维码", !noIpText.includes(QR_PREFIX))

// 开关按钮：已开启 → 点「关闭」传 false；未开启 → 点「开启」传 true
{
  const onPanel = renderPanel({ phase: "ready", data: sample, error: "" })
  const closeButton = findByText(onPanel, "关闭局域网访问")
  check("已开启时给「关闭局域网访问」按钮", closeButton !== null)
  toggled = null
  closeButton?.props?.onClick?.()
  check("「关闭」回调传 enabled=false", toggled === false, String(toggled))

  const offPanel = renderPanel({ phase: "ready", data: offState, error: "" })
  const openButton = findByText(offPanel, "开启局域网访问")
  toggled = null
  openButton?.props?.onClick?.()
  check("「开启」回调传 enabled=true", toggled === true, String(toggled))
}

// 开关必须走宿主的 SET 接口（POST + {enabled}），否则状态不会落盘
{
  fetchCalls.length = 0
  panelElement.props.onToggle(true)
  const call = fetchCalls.find((entry) => entry.url === "/api/lan_access.set")
  check("开关走 POST /api/lan_access.set", call !== undefined && call.options?.method === "POST", fetchCalls.map((entry) => String(entry.url)).join(","))
  check("开关请求体是 {enabled:true}", call?.options?.body === JSON.stringify({ enabled: true }), String(call?.options?.body))
}

// 读取入口走 GET（顺带验：往上找不到 flex 容器时也不能抛）
{
  fetchCalls.length = 0
  const tree = renderFooter([false, null])
  const cleanups = flushEffects(tree, domNode("flex"))
  const call = fetchCalls.find((entry) => entry.url === "/api/lan_access.info")
  check("入口挂载时 GET /api/lan_access.info", call !== undefined, fetchCalls.map((entry) => String(entry.url)).join(","))
  for (const cleanup of cleanups) cleanup()
}

/* ========================================================================== */
/* D. 宿主半边：默认关闭 + 开关持久化                                          */
/* ========================================================================== */

console.log('--- 宿主半边（默认关闭 / 开关持久化）---')

/** 端口通不通。代理是异步起的，判断「有没有在监听」只能真连一下。 */
function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(700)
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.once('timeout', () => done(false))
  })
}

/**
 * 起一份宿主半边，返回读取/开关接口。
 *
 * 「重启」靠带 `?v=N` 的 URL 重新 import：模块级状态、env 读取全部重来一遍，
 * 等价于 dsh 重启后重新加载插件。`stateFile` 不变，就能验「记不记得住」。
 */
async function bootHost(version, stateFile) {
  process.env.DSH_LAN_ACCESS_DATA = stateFile
  const loaded = await import(pathToFileURL(join(pluginDir, 'lan_access.mjs')).href + '?v=' + String(version))

  const routes = new Map()
  const disposers = []
  loaded.apply({
    inject: (names, callback) => {
      callback({
        // 代理只会把这个端口写进 URL / 当转发目标，测试里没有真上游
        webServer: { port: 65000 },
        connection: {
          authenticatedUrl: (base) => base + '/?token=probe-launch-token',
          fetch: {
            register: (spec) => {
              routes.set(spec.path, spec)
            }
          }
        },
        effect: (fn) => {
          const disposer = fn()
          if (typeof disposer === 'function') disposers.push(disposer)
        }
      })
    }
  })

  return {
    disposers,
    info: () => routes.get('/api/lan_access.info').fetch({}).then((response) => response.json()),
    set: (value) =>
      routes
        .get('/api/lan_access.set')
        .fetch({ json: async () => ({ enabled: value }) })
        .then((response) => response.json())
  }
}

/** 等 `running` 变成期望值 —— apply 里的 startProxy 是 fire-and-forget 的。 */
async function waitRunning(host, expected, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  let last = await host.info()
  while (last.running !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    last = await host.info()
  }
  return last
}

/** 停掉一份宿主半边，并等端口真的释放（stop 也是异步的）。 */
async function shutdownHost(host, port) {
  for (const disposer of host.disposers) disposer()
  const deadline = Date.now() + 4000
  while (Date.now() < deadline && (await portOpen(port))) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

try {
  const hostPort = await freePort()
  const stateFile = process.env.DSH_LAN_ACCESS_DATA
  // 端口和对外 IP 都写死，链接才可预期（FIXED_IP 只影响展示，不影响绑定）
  process.env.DSH_LAN_ACCESS_PORT = String(hostPort)
  process.env.DSH_LAN_ACCESS_BIND = '127.0.0.1'
  process.env.DSH_LAN_ACCESS_IP = '192.168.77.77'

  // D1. 头一次跑：默认不开，端口不占
  const first = await bootHost(1, stateFile)
  const fresh = await first.info()
  check('首次启动默认关闭（enabled=false）', fresh.enabled === false, String(fresh.enabled))
  check('首次启动代理没在监听（running=false）', fresh.running === false, String(fresh.running))
  check('默认关闭时不占用端口', (await portOpen(hostPort)) === false)

  const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
  check('访问码已落盘（16 字节 base64url）', typeof saved.key === 'string' && saved.key.length === 22, String(saved.key))
  check('落盘的 enabled 是 false', saved.enabled === false, String(saved.enabled))

  // D2. 面板里打开
  const on = await first.set(true)
  check('开启后 enabled=true', on.enabled === true, String(on.enabled))
  check('开启后 running=true', on.running === true, String(on.error))
  check('开启后端口在监听', (await portOpen(hostPort)) === true)
  check('链接 = 固定 IP + 固定端口 + 落盘的访问码', on.url === `http://192.168.77.77:${String(hostPort)}/?lan=${saved.key}`, on.url)
  check('开启后给出二维码 SVG', typeof on.qr === 'string' && on.qr.startsWith('<svg'), String(on.qr).slice(0, 24))
  check('开启状态已落盘', JSON.parse(readFileSync(stateFile, 'utf8')).enabled === true)

  // D3. 重启：开着就自己开回来，链接不能变
  await shutdownHost(first, hostPort)
  const second = await bootHost(2, stateFile)
  const restored = await waitRunning(second, true)
  check('重启后仍是 enabled=true（记住了）', restored.enabled === true, String(restored.enabled))
  check('重启后自动恢复监听', restored.running === true, String(restored.error))
  check('重启后链接不变（访问码没换）', restored.url === on.url, restored.url)

  // D4. 关掉也要记住，下次启动不能自己开
  const off = await second.set(false)
  check('关闭后 running=false', off.running === false, String(off.running))
  check('关闭后端口已释放', (await portOpen(hostPort)) === false)
  check('关闭状态已落盘', JSON.parse(readFileSync(stateFile, 'utf8')).enabled === false)

  // D4b. 同一个实例里关了再开：stop 之后 start 必须能重新 bind 同一个端口
  // （proxy 内部 stop 会把 server 置空，start 要能重建 —— 这是「开关能反复按」的前提）
  const reopened = await second.set(true)
  check('关闭后还能再开启（重新绑定同一端口）', reopened.running === true && (await portOpen(hostPort)) === true, String(reopened.error))
  const reclosed = await second.set(false)
  check('再关闭后端口再次释放', reclosed.running === false && (await portOpen(hostPort)) === false)

  await shutdownHost(second, hostPort)
  const third = await bootHost(3, stateFile)
  const stayedOff = await third.info()
  check('重启后保持关闭（不会自己开）', stayedOff.enabled === false && stayedOff.running === false, `${String(stayedOff.enabled)}/${String(stayedOff.running)}`)
  await shutdownHost(third, hostPort)

  // D5. 状态文件坏了：当没配过 —— 绝不能因为读不出来就顺手把端口开了
  const corruptFile = join(dirname(stateFile), 'corrupt.json')
  writeFileSync(corruptFile, '{ 这不是 JSON', 'utf8')
  const corrupt = await bootHost(4, corruptFile)
  const corruptInfo = await corrupt.info()
  check(
    '状态文件损坏时当作默认关闭',
    corruptInfo.enabled === false && corruptInfo.running === false,
    `${String(corruptInfo.enabled)}/${String(corruptInfo.running)}`
  )
  await shutdownHost(corrupt, hostPort)
} catch (error) {
  check('宿主半边检查未抛异常', false, String(error?.stack ?? error))
}

console.log(failures === 0 ? '\n全部通过' : `\n${String(failures)} 项失败`)
process.exit(failures === 0 ? 0 : 1)
