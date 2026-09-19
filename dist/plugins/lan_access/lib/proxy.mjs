/**
 * 局域网访问用的**带鉴权反向代理**。
 *
 * 为什么要有这一层：`dsh web` 只监听 127.0.0.1，而且上游明确拒绝 `--host 0.0.0.0`
 * （dsh-web-app 的 startup 里写着「会把 RCE 暴露到网络」）。本插件不去动 dsh 的绑定，
 * 而是自己在局域网侧再开一个口子，只转发「拿对了访问码」的请求 —— 这样暴露面完全
 * 由插件控制，关掉插件端口就关了。
 *
 * 两层鉴权，各管各的：
 *   1. **局域网侧**（本文件）：固定访问码。`?lan=<码>` 命中就发一个长期 cookie 并
 *      303 回干净路径；之后靠 cookie 放行。码存在插件的数据文件里，IP 不变则链接不变。
 *   2. **回环侧**（dsh 自己）：dsh 的浏览器会话 cookie 是**按 Host 头签发的**
 *      （`dsh-client-connection` 的 BrowserAuth），局域网浏览器永远拿不到、也不该拿到
 *      127.0.0.1 那份 cookie。所以这里在启动时用进程的 launch token 自己去回环换一份
 *      cookie 缓存起来，转发时替换掉浏览器带来的 Cookie —— 浏览器从头到尾不接触 dsh 的
 *      token/cookie，鉴权全在代理里完成。
 *
 * 请求头必须一起改写，否则过不了 dsh 的两道闸：
 *   - `Host` 必须是 `127.0.0.1:<port>`，否则 `/api` 的 browser-trust fence 直接 403；
 *   - `Origin` / `Referer` 要跟着改成同一个 authority（fence 会比对 Origin.host）；
 *   - `Cookie` 换成上面缓存的那份。
 *
 * **HTTP Upgrade 必须转发**：对话流不是 SSE，而是 `/api/remote.mux` 上的 WebSocket
 * （dsh-api-gateway 用 `webServer.registerUpgrade` 注册，握手时同样走 requestRejection）。
 * 少了这一段，页面能打开但一发消息就废。
 *
 * 响应一律**不缓冲**：gzip、SSE、WebSocket 全都原样透传；只剥掉 hop-by-hop 头、
 * 以及上游的 `Set-Cookie`（不能把 dsh 的会话 cookie 泄给局域网 origin）。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { pipeline } from 'node:stream'

/** 上游固定是 dsh 自己监听的回环地址。 */
const UPSTREAM_HOST = '127.0.0.1'

/** 局域网侧的 cookie 名与查询参数名。 */
export const COOKIE_NAME = 'dsh-lan-access'
export const KEY_PARAM = 'lan'

/** 访问码 cookie 的有效期（秒）。码不变就一直有效，重置访问码即作废。 */
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60

/** 请求转发时要剥掉的头（逐跳头）。Upgrade 请求额外保留 connection/upgrade。 */
const HOP_BY_HOP = new Set([
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding'
])
const UPGRADE_HEADERS = new Set(['connection', 'upgrade'])

/** 响应转发时要剥掉的头；set-cookie 是安全考虑，见文件头。 */
const RESPONSE_DROP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'set-cookie'
])

/**
 * 定长常量时间比较，别用 `===` 比访问码（长度不等直接 false，不泄露长度以外的东西）。
 * @param left - 客户端提供的值。
 * @param right - 真实访问码。
 */
function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || right.length === 0) return false
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * 是不是内网/回环地址。默认只放行这些 —— 机器连到公共 WiFi、或者路由器做了端口转发时，
 * 不至于把接口暴露给整个互联网。
 *
 * @param address - `req.socket.remoteAddress` 的原始值。
 */
export function isPrivateAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  let value = address
  if (value.startsWith('::ffff:')) value = value.slice(7)
  if (value === '::1') return true
  const parts = value.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((part) => Number(part))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false
  const [a, b] = octets
  if (a === 10 || a === 127) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 169 && b === 254) return true // 链路本地
  return false
}

/** 状态码对应的短语，只用到几个。 */
const STATUS_TEXT = { 401: 'Unauthorized', 403: 'Forbidden', 502: 'Bad Gateway' }

/** 拒绝/出错时给浏览器看的最小页面。 */
function errorPage(title, detail) {
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + title + '</title><style>' +
    'html,body{margin:0;height:100%;background:#f4f6fb;color:#1b2130;' +
    "font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif}" +
    'main{max-width:520px;margin:0 auto;padding:18vh 24px}' +
    'h1{margin:0 0 10px;font-size:17px;font-weight:600}' +
    'p{margin:0 0 8px;font-size:13px;line-height:1.9;color:#5b6478}' +
    '</style></head><body><main><h1>' + title + '</h1><p>' + detail + '</p></main></body></html>'
  )
}

/**
 * 建一个代理实例。返回的对象里 `start()` 起监听、`stop()` 关监听。
 *
 * 访问码与 launch token 都走**取值函数**而不是固定值：访问码可以被「重置」，
 * token 由 dsh 在连接服务就绪后才有 —— 建代理的时候两个都可能还拿不到。
 *
 * @param options.upstreamPort - dsh 自己监听的端口（回环）。
 * @param options.getAccessKey - 取当前访问码。
 * @param options.getLaunchToken - 取进程 launch token；拿不到返回空串。
 * @param options.allowPublic - true 表示不限制来源网段。
 * @param options.log - 打日志的回调。
 */
export function createProxy(options) {
  const { upstreamPort, getAccessKey, getLaunchToken, allowPublic, log } = options

  let server = null
  /**
   * 挂在代理上的 Upgrade socket（WebSocket）。
   *
   * 必须自己收着：升级过的 socket 会脱离 http server 的连接跟踪，
   * `closeAllConnections()` **不管它们**，`server.close()` 就会一直等下去
   * —— 表现为关服务时卡住（实测卡满两分钟）。收尾时手动 destroy。
   */
  const upgrades = new Set()
  /** 缓存的上游 cookie（`name=value` 形式）。 */
  let cookieCache = null
  /** 正在兑换 cookie 的 Promise，避免并发请求各换一次。 */
  let cookiePending = null

  const upstreamOrigin = () => `http://${UPSTREAM_HOST}:${String(upstreamPort)}`

  /* ------------------------------------------------------------------------ */
  /* 上游 cookie：用 launch token 去回环换一份                                 */
  /* ------------------------------------------------------------------------ */

  /**
   * 拿一份 `dsh-auth-*` cookie。
   *
   * 做法是模拟 dsh 自己的登录跳转：`GET /?token=<launchToken>`。`authorizeIndex`
   * **没有 Host 围栏**，它按请求的 Host 头签发 cookie —— 这里 Host 保持回环，
   * 拿到的 cookie 也就绑定在回环 authority 上，正好和转发时改写的 Host 对得上。
   */
  function exchangeCookie() {
    const token = getLaunchToken()
    if (typeof token !== 'string' || token.length === 0) {
      return Promise.reject(new Error('拿不到 dsh 的 launch token（连接服务还没就绪？）'))
    }
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: UPSTREAM_HOST,
          port: upstreamPort,
          path: `/?token=${encodeURIComponent(token)}`,
          method: 'GET',
          headers: { host: `${UPSTREAM_HOST}:${String(upstreamPort)}` }
        },
        (response) => {
          const raw = response.headers['set-cookie']
          const first = Array.isArray(raw) ? raw[0] : raw
          response.resume() // 响应体没用，排空即可
          if (response.statusCode !== 303 || typeof first !== 'string' || first.length === 0) {
            reject(new Error(`兑换上游 cookie 失败：HTTP ${String(response.statusCode ?? 0)}`))
            return
          }
          resolve(first.split(';')[0].trim())
        }
      )
      request.on('error', reject)
      request.setTimeout(8000, () => request.destroy(new Error('兑换上游 cookie 超时')))
      request.end()
    })
  }

  /**
   * 取缓存的上游 cookie；没有就换一次。
   * @param force - true 表示丢掉缓存重换（上游回了 401/403 时用）。
   */
  function ensureCookie(force) {
    if (force) {
      cookieCache = null
      cookiePending = null
    }
    if (cookieCache !== null) return Promise.resolve(cookieCache)
    if (cookiePending !== null) return cookiePending
    cookiePending = exchangeCookie().then(
      (value) => {
        cookieCache = value
        cookiePending = null
        return value
      },
      (error) => {
        cookiePending = null
        throw error
      }
    )
    return cookiePending
  }

  /* ------------------------------------------------------------------------ */
  /* 请求头改写                                                                */
  /* ------------------------------------------------------------------------ */

  /**
   * 把浏览器的请求头改写成 dsh 能接受的样子。
   *
   * @param raw - `req.headers`（node 已经小写化）。
   * @param upstreamCookie - 要注入的 dsh 会话 cookie。
   * @param upgrade - true 时保留 connection/upgrade（WebSocket 握手要）。
   */
  function rewriteHeaders(raw, upstreamCookie, upgrade) {
    const headers = {}
    for (const [name, value] of Object.entries(raw)) {
      if (HOP_BY_HOP.has(name)) continue
      if (UPGRADE_HEADERS.has(name) && !upgrade) continue
      if (name === 'host' || name === 'cookie' || name === 'origin' || name === 'referer') continue
      if (value === undefined) continue
      headers[name] = value
    }
    headers.host = `${UPSTREAM_HOST}:${String(upstreamPort)}`
    headers.cookie = upstreamCookie
    // fence 会比对 Origin.host 与 Host，浏览器带来的 origin 是局域网那个，必须换掉
    if (raw.origin !== undefined) headers.origin = upstreamOrigin()
    if (raw.referer !== undefined) headers.referer = `${upstreamOrigin()}/`
    return headers
  }

  /** 响应头：剥掉逐跳头与 set-cookie，其余原样（gzip/content-length 都留着）。 */
  function responseHeaders(raw) {
    const headers = {}
    for (const [name, value] of Object.entries(raw)) {
      if (RESPONSE_DROP.has(name) || value === undefined) continue
      headers[name] = value
    }
    return headers
  }

  /* ------------------------------------------------------------------------ */
  /* 局域网侧鉴权                                                              */
  /* ------------------------------------------------------------------------ */

  /** 请求带来的 cookie 里有没有对的访问码。 */
  function cookieMatches(header) {
    if (typeof header !== 'string' || header.length === 0) return false
    const key = getAccessKey()
    for (const part of header.split(';')) {
      const index = part.indexOf('=')
      if (index < 0) continue
      if (part.slice(0, index).trim() !== COOKIE_NAME) continue
      return safeEqual(part.slice(index + 1).trim(), key)
    }
    return false
  }

  /**
   * 判定一个请求该放行、该跳转、还是该拒。
   *
   * @returns `{ action: 'allow' }` / `{ action: 'redirect', location }` /
   *   `{ action: 'deny', status, title, detail }`。
   */
  function gate(req) {
    if (!allowPublic && !isPrivateAddress(req.socket?.remoteAddress)) {
      return {
        action: 'deny',
        status: 403,
        title: '只允许局域网内访问',
        detail: '这个地址只对同一个局域网里的设备开放。请确认手机和电脑连的是同一个 WiFi。'
      }
    }

    let url
    try {
      url = new URL(req.url ?? '/', 'http://lan.invalid')
    } catch {
      return { action: 'deny', status: 400, title: '请求不合法', detail: '看不懂这个请求。' }
    }

    const provided = url.searchParams.get(KEY_PARAM)
    if (provided !== null) {
      if (!safeEqual(provided, getAccessKey())) {
        return {
          action: 'deny',
          status: 401,
          title: '访问码不对',
          detail: '链接里的访问码不正确或已被重置。请在电脑上重新打开面板，扫新的二维码。'
        }
      }
      // 命中就发长期 cookie，并把地址收拾干净（去掉 lan 参数）
      url.searchParams.delete(KEY_PARAM)
      const query = url.searchParams.toString()
      return { action: 'redirect', location: url.pathname + (query.length > 0 ? `?${query}` : '') }
    }

    if (!cookieMatches(req.headers.cookie)) {
      return {
        action: 'deny',
        status: 401,
        title: '需要访问码',
        detail: '请用电脑上「局域网访问」面板里的二维码扫码打开，或直接粘贴那条带访问码的链接。'
      }
    }

    return { action: 'allow' }
  }

  /** 发一个拒绝页。 */
  function deny(res, verdict) {
    const body = errorPage(verdict.title, verdict.detail)
    res.writeHead(verdict.status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body)
    })
    res.end(body)
  }

  /* ------------------------------------------------------------------------ */
  /* 转发                                                                      */
  /* ------------------------------------------------------------------------ */

  /**
   * 能不能安全重试。
   *
   * 只在 GET/HEAD 上重试：重试要重新 `req.pipe(upstream)`，而请求流第一次就被消费掉了，
   * 再 pipe 一个已经结束的流不会触发 end，上游会一直等着请求体 —— 直接挂住。
   * GET/HEAD 没有请求体，没有这个问题。
   */
  function isRetryable(req) {
    return req.method === 'GET' || req.method === 'HEAD'
  }

  /** 普通 HTTP 请求转发。 */
  async function handleRequest(req, res) {
    const verdict = gate(req)
    if (verdict.action === 'deny') {
      deny(res, verdict)
      return
    }
    if (verdict.action === 'redirect') {
      res.writeHead(303, {
        location: verdict.location,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'set-cookie':
          `${COOKIE_NAME}=${getAccessKey()}; Path=/; HttpOnly; SameSite=Lax; ` +
          `Max-Age=${String(COOKIE_MAX_AGE_SECONDS)}`
      })
      res.end()
      return
    }

    let cookie
    try {
      cookie = await ensureCookie(false)
    } catch (error) {
      log(`换上游 cookie 失败：${String(error?.message ?? error)}`)
      deny(res, { status: 502, title: '连不上本机的 dsh 服务', detail: '请稍后重试，或重启服务。' })
      return
    }

    const forward = (upstreamCookie, retried) => {
      const upstream = http.request(
        {
          host: UPSTREAM_HOST,
          port: upstreamPort,
          method: req.method,
          path: req.url,
          headers: rewriteHeaders(req.headers, upstreamCookie, false)
        },
        (response) => {
          const status = response.statusCode ?? 502
          // cookie 过期/进程换了 token 时上游会 401/403：重换一次再试
          if ((status === 401 || status === 403) && !retried && isRetryable(req)) {
            response.resume()
            ensureCookie(true).then(
              (fresh) => forward(fresh, true),
              (error) => {
                log(`重新换上游 cookie 失败：${String(error?.message ?? error)}`)
                if (!res.headersSent) {
                  deny(res, { status: 502, title: '连不上本机的 dsh 服务', detail: '请稍后重试，或重启服务。' })
                }
              }
            )
            return
          }
          res.writeHead(status, responseHeaders(response.headers))
          pipeline(response, res, () => {})
        }
      )
      upstream.on('error', (error) => {
        log(`转发 ${String(req.method)} ${String(req.url)} 失败：${String(error?.message ?? error)}`)
        if (!res.headersSent) {
          deny(res, { status: 502, title: '连不上本机的 dsh 服务', detail: '请稍后重试，或重启服务。' })
        } else {
          res.destroy()
        }
      })
      req.pipe(upstream)
    }

    forward(cookie, false)
  }

  /**
   * HTTP Upgrade（WebSocket）转发。
   *
   * 这里不走 `http.request` 而是直接开一条 TCP，把改写过的握手请求原样写过去，
   * 之后两个 socket 双向对拷 —— 101 响应、帧、关闭握手全都原样过，不需要理解协议。
   * `/api/remote.mux` 就是靠这条活着的。
   */
  async function handleUpgrade(req, socket, head) {
    socket.on('error', () => {})
    upgrades.add(socket)
    socket.on('close', () => upgrades.delete(socket))

    const rejectUpgrade = (status, title, detail) => {
      const body = errorPage(title, detail)
      socket.end(
        `HTTP/1.1 ${String(status)} ${STATUS_TEXT[status] ?? 'Error'}\r\n` +
          'connection: close\r\n' +
          'content-type: text/html; charset=utf-8\r\n' +
          `content-length: ${String(Buffer.byteLength(body))}\r\n\r\n` +
          body
      )
    }

    const verdict = gate(req)
    if (verdict.action !== 'allow') {
      if (verdict.action === 'deny') rejectUpgrade(verdict.status, verdict.title, verdict.detail)
      else rejectUpgrade(403, '需要访问码', 'WebSocket 握手缺少访问码。')
      return
    }

    let cookie
    try {
      cookie = await ensureCookie(false)
    } catch (error) {
      log(`WebSocket 换上游 cookie 失败：${String(error?.message ?? error)}`)
      rejectUpgrade(502, '连不上本机的 dsh 服务', '请稍后重试，或重启服务。')
      return
    }

    const upstream = net.connect(upstreamPort, UPSTREAM_HOST, () => {
      const headers = rewriteHeaders(req.headers, cookie, true)
      const lines = [`GET ${String(req.url)} HTTP/1.1`]
      for (const [name, value] of Object.entries(headers)) {
        if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`)
        else if (value !== undefined) lines.push(`${name}: ${String(value)}`)
      }
      lines.push('', '')
      upstream.write(lines.join('\r\n'))
      if (head !== undefined && head.length > 0) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })

    const teardown = () => {
      upstream.destroy()
      socket.destroy()
    }
    upstream.on('error', teardown)
    socket.on('close', teardown)
    upstream.on('close', teardown)
    upstream.setNoDelay(true)
    socket.setNoDelay(true)
  }

  /* ------------------------------------------------------------------------ */
  /* 生命周期                                                                  */
  /* ------------------------------------------------------------------------ */

  /**
   * 起监听。
   * @param port - 监听端口。
   * @param bind - 监听地址。
   * @returns 端口被占等失败时 reject。
   */
  function start(port, bind) {
    return new Promise((resolve, reject) => {
      const instance = http.createServer((req, res) => {
        handleRequest(req, res).catch((error) => {
          log(`处理请求出错：${String(error?.message ?? error)}`)
          if (!res.headersSent) {
            deny(res, { status: 502, title: '内部错误', detail: '代理处理这个请求时出错了。' })
          } else {
            res.destroy()
          }
        })
      })

      instance.on('upgrade', (req, socket, head) => {
        handleUpgrade(req, socket, head).catch((error) => {
          log(`处理 WebSocket 出错：${String(error?.message ?? error)}`)
          socket.destroy()
        })
      })
      instance.on('clientError', (_error, socket) => socket.destroy())

      // 上传大文件、长连 SSE 都不该被默认的请求超时掐掉
      instance.requestTimeout = 0
      instance.headersTimeout = 60_000

      const onListenError = (error) => reject(error)
      instance.once('error', onListenError)
      instance.listen(port, bind, () => {
        instance.removeListener('error', onListenError)
        instance.on('error', (error) => log(`代理出错：${String(error?.message ?? error)}`))
        server = instance
        resolve()
      })
    })
  }

  /** 关监听；顺手掐掉还挂着的长连接，别让 close 卡住。 */
  function stop() {
    const instance = server
    server = null
    cookieCache = null
    cookiePending = null
    if (instance === null) return Promise.resolve()
    return new Promise((resolve) => {
      // 顺序有讲究：先掐 Upgrade socket（closeAllConnections 不管它们），
      // 再关普通连接，最后 close() 的回到才能来。
      for (const socket of upgrades) socket.destroy()
      upgrades.clear()
      instance.close(() => resolve())
      instance.closeAllConnections?.()
    })
  }

  return { start, stop }
}

/** 生成一个新的访问码：16 字节密码学随机 → base64url（22 字符）。 */
export function createAccessKey() {
  return randomBytes(16).toString('base64url')
}
