/**
 * 模拟 dsh 服务进程里的 revealDirectory 调用：
 * 起一个 http 服务 + 3 秒后用 dsh-cf 的原样参数 spawn explorer.exe。
 * stdout 打心跳，观察进程是否中途退出。
 */
import http from 'node:http'
import { spawn } from 'node:child_process'

const server = http.createServer((req, res) => {
  res.writeHead(200).end('ok')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
console.log('server listening on', server.address().port)

process.on('exit', (code) => console.log('process exit', code))
process.on('uncaughtException', (err) => {
  console.log('UNCAUGHT EXCEPTION:', err?.stack || err)
  process.exit(70)
})

setTimeout(() => {
  console.log('spawning explorer.exe (detached:true, stdio:ignore) ...')
  const directory = 'C:\\Users\\Ali\\AppData\\Local\\DeepSeekHarness\\logs'
  try {
    const child = spawn('explorer.exe', [directory], { detached: true, stdio: 'ignore' })
    child.on('error', (err) => console.log('child error event:', err?.message))
    child.on('exit', (code, signal) => console.log('child exit', code, signal))
    child.unref()
    console.log('spawn() returned without throwing')
  } catch (error) {
    console.log('spawn threw synchronously:', error?.message)
  }
}, 1000)

setTimeout(() => {
  console.log('still alive after 4s — OK')
  server.close()
  process.exit(0)
}, 4000)

setInterval(() => console.log('heartbeat'), 1000)
