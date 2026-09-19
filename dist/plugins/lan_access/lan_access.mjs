/**
 * dsh-lan-access —— 局域网扫码访问网页版
 * ======================================
 *
 * 干两件事：
 *
 * 1. **开一条局域网通道**：在 `0.0.0.0:3081` 起一个带鉴权的反向代理，转发到
 *    dsh 自己监听的 `127.0.0.1:3080`。为什么是反代而不是直接让 dsh 监听 0.0.0.0：
 *    上游把 `--host 0.0.0.0` 明确堵死了（dsh-web-app 的 startup 里写着「会把 RCE
 *    暴露到网络」），而且那样就没法按来源网段过滤、也没法做「重置访问码」。细节见
 *    lib/proxy.mjs 的文件头。
 *
 * 2. **给界面一个入口**：注册鉴权过的 `GET /api/lan_access.info`，把固定链接和
 *    二维码（服务端生成的 SVG）交给浏览器半边（lib/client.js）显示。
 *
 * ---------------------------------------------------------------------------
 * 关键约定（都是踩过的坑，别随手改）
 *
 * **默认不开，开了就记住**：局域网通道等于把本机的操作权限摊到局域网上，所以
 * `enabled` 默认 **false** —— 插件装上、入口能看见，但 3081 不监听。用户在面板里
 * 点「开启」后才起代理，并且这个选择落盘（`<应用数据根>/data/lan_access.json` 的
 * `enabled` 字段），下次启动自动恢复。想彻底不加载插件，去插件管理器关。
 *
 * **链接固定**：`http://<内网IP>:3081/?lan=<访问码>`。访问码 16 字节随机、只生成一次，
 * 和 `enabled` 存在同一个文件里。所以**只要内网 IP 不变，链接和二维码就不变**。
 * 端口故意写死（默认 3081，可用 DSH_LAN_ACCESS_PORT 覆盖）—— 端口随机会让链接每次都变，
 * 那就不叫固定了；被占用时宁可报错也不换端口。
 *
 * **访问码不放插件目录**：插件包是「源目录 → <profile>/plugins/<id>/」整目录重抄的镜像
 * （见 dsh_shell.py 的 PLUGIN_RUNTIME_DIRS），放里面会被连坐删掉、还多出一个副本。
 * 统一放外壳的运行数据根，和 usage 的账本同一个地方。
 *
 * **鉴权是两层**：局域网侧是这里发的固定访问码（`?lan=` → 长期 cookie）；
 * 回环侧是 dsh 自己的会话 cookie，由代理用进程 launch token 换好后代持，浏览器
 * 全程不接触它。见 lib/proxy.mjs。
 *
 * **launch token 只能在连接服务就绪后拿**：所以整个代理挂在
 * `ctx.inject(['connection', 'webServer'], ...)` 里，不在 apply 顶层直接起。
 *
 * **代理可以反复起停**：`createProxy()` 只建一次，`start()`/`stop()` 成对调用
 * （关掉再开就是同一个实例重来）。`stop()` 必须能干净收尾，见 proxy.mjs 里关于
 * Upgrade socket 的说明。
 *
 * **effect 要返回 disposer**：`ctx.effect(() => () => proxy.stop())`，不是
 * `ctx.effect(() => proxy.stop())` —— 后者会当场执行，起不到「退出时清理」的作用。
 *
 * **任何异常都吞掉**：插件崩了不能连带 dsh 起不来。
 *
 * 环境变量：
 *   DSH_UI_DATA_DIR=<目录>            外壳传给子进程的运行数据根（状态存它下面）
 *   DSH_LAN_ACCESS_PORT=<端口>        代理端口，默认 3081
 *   DSH_LAN_ACCESS_BIND=<地址>        代理绑定地址，默认 0.0.0.0
 *   DSH_LAN_ACCESS_IP=<地址>          指定对外展示的内网 IP（自动挑不中时用）
 *   DSH_LAN_ACCESS_ALLOW_PUBLIC=1     不限制来源网段（默认只放行内网/回环）
 *   DSH_LAN_ACCESS_DATA=<路径>        直接指定状态文件（自测指向临时目录用）
 *   DSH_LAN_ACCESS_QUIET=1            不打启动横幅
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'

import { createAccessKey, createProxy, isPrivateAddress, KEY_PARAM } from './lib/proxy.mjs'
import { qrSvg } from './lib/qr.mjs'

/** 稳定的 cordis 插件名。 */
export const name = 'lan-access'

const TAG = '[dsh-lan-access]'

/** 关掉启动横幅。 */
const QUIET = (process.env.DSH_LAN_ACCESS_QUIET ?? '') === '1'

/** 代理端口。写死是有意的：端口一变链接就变，见文件头。 */
const PORT = Number.parseInt((process.env.DSH_LAN_ACCESS_PORT ?? '').trim(), 10) || 3081

/** 代理绑定地址。默认全网卡 —— 局域网设备才连得上。 */
const BIND = (process.env.DSH_LAN_ACCESS_BIND ?? '').trim() || '0.0.0.0'

/** 是否放开来源网段限制（默认只放行内网/回环）。 */
const ALLOW_PUBLIC = (process.env.DSH_LAN_ACCESS_ALLOW_PUBLIC ?? '') === '1'

/** 手动指定的对外 IP；空表示自动挑。 */
const FIXED_IP = (process.env.DSH_LAN_ACCESS_IP ?? '').trim()

/** 浏览器读取入口（走 connection 的鉴权通道）。 */
const INFO_PATH = '/api/lan_access.info'
const SET_PATH = '/api/lan_access.set'
const RESET_PATH = '/api/lan_access.reset'

/** 看起来像虚拟网卡的接口名 —— 排序时往后放，别把 URL 指到 WSL/Hyper-V 的网段上。 */
const VIRTUAL_INTERFACE = /(virtual|vmware|vbox|virtualbox|hyper-?v|wsl|docker|loopback|tailscale|zerotier|vpn|tap|tun|radmin|hamachi|utun|bridge|bluetooth)/i

/* -------------------------------------------------------------------------- */
/* 状态落盘（访问码 + 开关）                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 外壳（dsh-ui）的运行数据根。
 *
 * 正常由外壳通过 `DSH_UI_DATA_DIR` 传进来；手工直接跑 `dsh web` 时按同样的约定自己算，
 * 免得启动方式不同就让状态落到两个地方去。
 */
function appDataRoot() {
  const given = (process.env.DSH_UI_DATA_DIR ?? '').trim()
  if (given.length > 0) return given
  const base = (process.env.LOCALAPPDATA ?? '').trim() || homedir()
  return join(base, 'DeepSeekHarness')
}

/** 状态文件：`<应用数据根>/data/lan_access.json`。 */
function keyFilePath() {
  const explicit = (process.env.DSH_LAN_ACCESS_DATA ?? '').trim()
  if (explicit.length > 0) return explicit
  return join(appDataRoot(), 'data', 'lan_access.json')
}

/**
 * 读状态；文件不在 / 坏了 / 内容不像样都当「没配过」。
 *
 * `enabled` 读不出来时一律 false —— **默认不开**，宁可让用户点一次，也不要
 * 因为文件损坏就悄悄把端口开起来。
 */
function readState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed !== null && typeof parsed === 'object') {
      const key = typeof parsed.key === 'string' ? parsed.key.trim() : ''
      return { key: key.length >= 16 ? key : null, enabled: parsed.enabled === true }
    }
  } catch {
    // 文件不存在或坏了：当作没配过，不打印（免得每次启动刷日志）
  }
  return { key: null, enabled: false }
}

/** 先写临时文件再 rename —— 断电/强杀不会留下半截 JSON。 */
function writeState(path, state) {
  const tmp = `${path}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(tmp, JSON.stringify({ version: 1, ...state }, null, 2), 'utf8')
  renameSync(tmp, path)
}

/* -------------------------------------------------------------------------- */
/* 内网地址                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 列出所有可用的 IPv4 地址（跳过回环），按「像不像要用的那个」排序。
 *
 * 排序偏好：私有网段 > 非私有；非虚拟网卡 > 虚拟网卡；192.168 > 10 > 172.16-31。
 * 装了 Docker/WSL/Hyper-V 的机器上虚拟网卡一大堆，不排一下很容易把链接指到
 * 一个手机根本连不上的网段。
 */
function listAddresses() {
  const found = []
  const interfaces = networkInterfaces()
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      found.push({ name, address: entry.address })
    }
  }

  const score = (entry) => {
    const [a, b] = entry.address.split('.').map((part) => Number(part))
    let value = 0
    if (VIRTUAL_INTERFACE.test(entry.name)) value += 100
    if (!isPrivateAddress(entry.address)) value += 50
    if (a === 192 && b === 168) value += 0
    else if (a === 10) value += 1
    else if (a === 172 && b >= 16 && b <= 31) value += 2
    else value += 10
    return value
  }

  return found.sort((left, right) => score(left) - score(right) || left.address.localeCompare(right.address))
}

/* -------------------------------------------------------------------------- */
/* 插件入口                                                                     */
/* -------------------------------------------------------------------------- */

/** 非有它不可的服务：两个都只在 web profile 提供，缺了代理没有意义。 */
export const inject = ['webServer']

/** 进程退出钩子只装一次（插件热重载会反复 apply）。 */
let EXIT_HOOKED = false

/**
 * 起代理、挂读取接口。
 *
 * @param ctx - 宿主侧插件 context。
 */
export function apply(ctx) {
  const stateFile = keyFilePath()
  const stored = readState(stateFile)

  let accessKey = stored.key ?? createAccessKey()
  let enabled = stored.enabled
  let proxy = null
  /** 代理是否真的在监听（start 成功、且没被 stop）。 */
  let running = false
  /** 起代理失败的原因（端口被占等），空串表示正常。 */
  let failure = ''

  /** 把当前状态落盘。 */
  const persist = () => {
    try {
      writeState(stateFile, { key: accessKey, enabled })
    } catch (error) {
      console.error(`${TAG} 状态落盘失败：${String(error?.message ?? error)}`)
    }
  }

  // 第一次跑：把新生成的访问码落盘（enabled 默认 false，不写也会被当成 false）
  if (stored.key === null) persist()

  /** 给浏览器半边的视图。每次调用都按当前状态现算，开关/重置后立刻反映。 */
  const snapshot = () => {
    const addresses = listAddresses()
    const ip = FIXED_IP.length > 0 ? FIXED_IP : (addresses[0]?.address ?? '')
    const url = ip.length > 0 ? `http://${ip}:${String(PORT)}/?${KEY_PARAM}=${accessKey}` : ''
    let qr = ''
    if (url.length > 0) {
      try {
        qr = qrSvg(url)
      } catch (error) {
        console.error(`${TAG} 生成二维码失败：${String(error?.message ?? error)}`)
      }
    }
    return {
      enabled, // 用户的开关意图
      running, // 代理是否真的在监听
      url,
      qr,
      ip,
      port: PORT,
      bind: BIND,
      addresses,
      allowPublic: ALLOW_PUBLIC,
      error: failure
    }
  }

  const json = (payload) =>
    Response.json(payload, { headers: { 'cache-control': 'no-store' } })

  ctx.inject(['connection', 'webServer'], (scoped) => {
    let upstreamPort
    try {
      upstreamPort = scoped.webServer.port
    } catch (error) {
      failure = `读不到 dsh 监听端口：${String(error?.message ?? error)}`
      console.error(`${TAG} ${failure}`)
      return
    }

    proxy = createProxy({
      upstreamPort,
      getAccessKey: () => accessKey,
      getLaunchToken: () => {
        try {
          const url = new URL(scoped.connection.authenticatedUrl(`http://127.0.0.1:${String(upstreamPort)}`))
          return url.searchParams.get('token') ?? ''
        } catch (error) {
          console.error(`${TAG} 取 launch token 失败：${String(error?.message ?? error)}`)
          return ''
        }
      },
      allowPublic: ALLOW_PUBLIC,
      log: (message) => console.error(`${TAG} ${message}`)
    })

    /** 起代理。已经在跑就什么都不做；失败只记原因，不翻掉用户的开关意图。 */
    const startProxy = async () => {
      if (running || proxy === null) return
      try {
        await proxy.start(PORT, BIND)
        running = true
        failure = ''
        if (!QUIET) {
          console.error(`${TAG} 局域网代理已监听 ${BIND}:${String(PORT)} -> 127.0.0.1:${String(upstreamPort)}`)
        }
      } catch (error) {
        running = false
        failure = String(error?.message ?? error)
        console.error(`${TAG} 代理起不来（端口 ${String(PORT)} 可能被占用）：${failure}`)
      }
    }

    /** 停代理。没在跑就是空操作。 */
    const stopProxy = async () => {
      if (!running || proxy === null) return
      await proxy.stop()
      running = false
      failure = ''
      if (!QUIET) console.error(`${TAG} 局域网代理已关闭，端口 ${String(PORT)} 已释放`)
    }

    try {
      scoped.connection.fetch.register({
        path: INFO_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: () => Promise.resolve(json(snapshot()))
      })

      // 面板上的「开启 / 关闭」：先落盘再起停，保证重启后状态一致
      scoped.connection.fetch.register({
        path: SET_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let next = false
          try {
            const body = await request.json()
            next = body?.enabled === true
          } catch {
            // 体坏了就当关闭，别把开关打开
          }
          enabled = next
          persist()
          if (next) await startProxy()
          else await stopProxy()
          return json(snapshot())
        }
      })

      scoped.connection.fetch.register({
        path: RESET_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: () => {
          accessKey = createAccessKey()
          persist()
          console.error(`${TAG} 访问码已重置，旧链接立即失效`)
          return Promise.resolve(json(snapshot()))
        }
      })
    } catch (error) {
      console.error(`${TAG} 注册读取接口失败：${String(error?.message ?? error)}`)
    }

    // 注意这里返回的是 disposer，不是直接调用 stop()
    scoped.effect(
      () => () => {
        running = false
        void proxy?.stop()
      },
      'dsh-lan-access: stop proxy'
    )

    // 上次开过就自动恢复；没开过就什么都不做 —— 默认不开
    if (enabled) {
      void startProxy()
    } else if (!QUIET) {
      console.error(`${TAG} 默认关闭；在左下角「局域网访问」面板里开启，开启后会记住`)
    }
  })

  if (!EXIT_HOOKED) {
    EXIT_HOOKED = true
    process.on('exit', () => {
      try {
        void proxy?.stop()
      } catch {
        // 退出路径上不再抛
      }
    })
  }

  if (!QUIET) {
    console.error(`${TAG} 状态文件 = ${stateFile}`)
  }
}

export default { name, inject, apply }
