import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { setLogSilent } from '../src/log.js'
import { startServer, type RunningServer } from '../src/server.js'

setLogSilent(true)

export function tempDir(prefix = 'krnl0-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export interface TestServer extends RunningServer {
  dir: string
  ca: Buffer
  origin: string
  request: (method: string, path: string, opts?: { headers?: Record<string, string>; body?: string | Buffer; json?: unknown }) => Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string; json: () => Json }>
  ws: (headers?: Record<string, string>) => WebSocket
  stop: () => Promise<void>
}

export async function startTestServer(env: Record<string, string> = {}, existingDir?: string): Promise<TestServer> {
  const dir = existingDir ?? tempDir()
  const server = await startServer({
    dataDir: dir,
    env: { KRNL0_UPDATE_CHECK: 'off', TZ: 'Europe/Berlin', ...env },
    port: 0,
    httpPort: null,
    bind: '127.0.0.1',
  })
  const ca = readFileSync(join(dir, 'tls', 'ca.crt'))
  const origin = `https://localhost:${server.port}`

  const request: TestServer['request'] = (method, path, opts = {}) =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) }
      let body = opts.body
      if (opts.json !== undefined) {
        body = JSON.stringify(opts.json)
        headers['Content-Type'] ??= 'application/json'
      }
      const req = https.request({ host: 'localhost', port: server.port, method, path, headers, ca, servername: 'localhost' }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) })
        })
      })
      req.on('error', reject)
      if (body !== undefined) req.write(body)
      req.end()
    })

  const ws: TestServer['ws'] = (headers = {}) =>
    new WebSocket(`wss://localhost:${server.port}/api/v1/sync`, { ca, headers })

  return {
    ...server,
    dir,
    ca,
    origin,
    request,
    ws,
    stop: async () => {
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** A parsed JSON object; read nested values with toMatchObject or a cast. */
export type Json = Record<string, unknown>

export const PASSWORD = 'correct horse battery staple'

/** Creates the owner through the setup endpoint with the live setup code. */
export async function claim(s: TestServer): Promise<void> {
  const code = s.ctx.setup.current()
  const r = await s.request('POST', '/api/v1/setup', { json: { code, password: PASSWORD } })
  if (r.status !== 201) throw new Error(`setup failed: ${r.status} ${r.text}`)
}

export async function pair(s: TestServer, name = 'Laptop'): Promise<{ token: string; deviceId: string }> {
  const r = await s.request('POST', '/api/v1/devices/pair', { json: { password: PASSWORD, name, platform: 'test' } })
  if (r.status !== 201) throw new Error(`pair failed: ${r.status} ${r.text}`)
  const j = r.json()
  return { token: String(j.token), deviceId: String(j.deviceId) }
}

export async function browserLogin(s: TestServer): Promise<{ cookie: string; csrf: string }> {
  const r = await s.request('POST', '/api/v1/auth/login', { json: { password: PASSWORD }, headers: { Origin: s.origin } })
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${r.text}`)
  const set = r.headers['set-cookie']
  const cookie = ((Array.isArray(set) ? set[0] : set) ?? '').split(';')[0] ?? ''
  return { cookie, csrf: String(r.json().csrf) }
}

export function nextMessage(ws: WebSocket, pred: (m: Json) => boolean = () => true, timeoutMs = 5000): Promise<Json> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', on); reject(new Error('no message')) }, timeoutMs)
    const on = (data: Buffer): void => {
      const m = JSON.parse(data.toString()) as Json
      if (pred(m)) { clearTimeout(t); ws.off('message', on); resolve(m) }
    }
    ws.on('message', on)
  })
}

export function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); ws.once('unexpected-response', (_r, res) => reject(new Error(`HTTP ${res.statusCode}`))) })
}

export function closed(ws: WebSocket): Promise<{ code: number }> {
  return new Promise((resolve) => ws.once('close', (code) => resolve({ code })))
}
