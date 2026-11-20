// Starts the server: config, data folder, TLS, stores, HTTP(S), WebSocket,
// backups and the update check.

import { existsSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { isIP } from 'node:net'
import { z } from 'zod'
import { configProblems, loadConfig, type Config } from './config.js'
import { dataPaths, type DataPaths } from './paths.js'
import { ensureDir, readJson, writeJsonAtomic } from './fsutil.js'
import { AuthStore, SetupCodeKeeper } from './auth/store.js'
import { WindowLimiter } from './auth/ratelimit.js'
import { newSetupCode } from './auth/tokens.js'
import { DocStore } from './store/docs.js'
import { TimelogStore } from './store/timelog.js'
import { AssetStore } from './store/assets.js'
import { lastBackupAt, makeBackup, pruneBackups } from './store/backup.js'
import { TlsManager } from './tls/index.js'
import { localNames } from './tls/selfsigned.js'
import { SyncHub } from './sync/hub.js'
import { UpdateChecker, type FetchFn } from './update/check.js'
import { createApp, type AppContext } from './http/app.js'
import { VERSION } from './version.js'
import { log } from './log.js'

export const DATA_FORMAT = 1
const DAY_MS = 24 * 3600_000

const formatSchema = z.object({ format: z.number().int(), lastServerVersion: z.string().nullable() })
const lockSchema = z.object({ pid: z.number().int(), startedAt: z.string() })

export function inDocker(): boolean {
  return process.env.KRNL0_IN_DOCKER === '1' || existsSync('/.dockerenv')
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

/** The pid of a running server on this data folder, or null. */
export function runningPid(paths: DataPaths): number | null {
  if (!existsSync(paths.lock)) return null
  try {
    const lock = lockSchema.parse(JSON.parse(readFileSync(paths.lock, 'utf8')))
    if (lock.pid === process.pid) return null
    return pidAlive(lock.pid) ? lock.pid : null
  } catch {
    return null
  }
}

/** Home-network IPv4 first, then other IPv4, then names, then IPv6. */
function addressRank(n: string): number {
  if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(n)) return 0
  if (isIP(n) === 4) return 1
  if (isIP(n) === 0 && n !== 'localhost') return 2
  if (isIP(n) === 6) return 3
  return 4
}

/** Every address to print: the names the owner set first, then the machine's own. */
export function addressesOf(cfg: Config, port: number): string[] {
  const names = cfg.hosts.length > 0
    ? cfg.hosts
    : localNames().filter((n) => n !== '::1' && n !== '127.0.0.1').sort((a, b) => addressRank(a) - addressRank(b))
  const scheme = cfg.tls.mode === 'proxy' ? 'http' : 'https'
  return names.map((n) => `${scheme}://${isIP(n) === 6 ? `[${n}]` : n}:${port}`)
}

export interface StartOptions {
  dataDir: string
  env?: NodeJS.ProcessEnv
  /** Port override (0 = any free port, for tests). */
  port?: number
  /** Redirect-port override (tests). */
  httpPort?: number | null
  bind?: string
  fetchFn?: FetchFn
}

export interface RunningServer {
  cfg: Config
  paths: DataPaths
  ctx: AppContext
  port: number
  url: string
  close: () => Promise<void>
}

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const paths = dataPaths(opts.dataDir)
  ensureDir(paths.root)
  const cfg = loadConfig(paths.config, opts.env ?? process.env)
  if (opts.port !== undefined) cfg.port = opts.port
  if (opts.httpPort !== undefined) cfg.httpPort = opts.httpPort
  if (opts.bind !== undefined) cfg.bind = opts.bind
  const problems = configProblems(cfg)
  if (problems.length > 0) throw new Error(problems.join('\n'))

  const other = runningPid(paths)
  if (other !== null) throw new Error(`A KRNL0 server (pid ${other}) already runs on ${paths.root}.`)
  writeJsonAtomic(paths.lock, { pid: process.pid, startedAt: new Date().toISOString() })

  // A new version backs up before it touches anything (F15).
  const format = readJson(paths.format, formatSchema, { format: DATA_FORMAT, lastServerVersion: null })
  if (format.format > DATA_FORMAT) throw new Error('This data folder was written by a newer KRNL0 server. Update the server, or restore an older backup.')
  if (format.lastServerVersion !== null && format.lastServerVersion !== VERSION) {
    const b = makeBackup(paths, `before-v${VERSION}`)
    log.info('Backed up before the new version', { backup: b.name, from: format.lastServerVersion, to: VERSION })
  }
  writeJsonAtomic(paths.format, { format: DATA_FORMAT, lastServerVersion: VERSION })

  const tls = await TlsManager.create(cfg, paths)
  const hub = new SyncHub(() => ({ timeZone: cfg.timeZone }))
  const broadcast = hub.broadcast.bind(hub)
  const auth = new AuthStore(paths)
  const setup = new SetupCodeKeeper(newSetupCode, (code, expiresAt) => {
    log.block([
      '',
      '  ┌──────────────────────────────────────────────────────────┐',
      `  │  Setup code: ${code.padEnd(44)}│`,
      `  │  ${`Valid until ${new Date(expiresAt).toISOString().slice(11, 16)} UTC. It creates the owner account.`.padEnd(56)}│`,
      '  │  Or run on the server: krnl0 setup                       │',
      '  └──────────────────────────────────────────────────────────┘',
      '',
    ].join('\n'))
  })
  const updates = new UpdateChecker(paths, cfg.updateCheck, opts.fetchFn)
  const ctx: AppContext = {
    cfg,
    paths,
    auth,
    setup,
    docs: new DocStore(paths.docs, broadcast),
    timelog: new TimelogStore(paths.timelog, broadcast),
    assets: new AssetStore(paths.assets, broadcast),
    tls: () => tls.info(),
    hub,
    updates,
    authLimiter: new WindowLimiter(10, 15 * 60_000),
  }
  const app = createApp(ctx)

  const mat = tls.material()
  const server: http.Server = tls.info().secure && mat
    ? https.createServer({ key: mat.key, cert: mat.cert, minVersion: 'TLSv1.2' }, app.handle)
    : http.createServer(app.handle)
  server.on('upgrade', app.upgrade)
  server.headersTimeout = 20_000
  server.requestTimeout = 30 * 60_000 // large media uploads
  server.keepAliveTimeout = 5_000
  if (server instanceof https.Server) {
    const s = server
    tls.onChange((m) => s.setSecureContext({ key: m.key, cert: m.cert, minVersion: 'TLSv1.2' }))
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(cfg.port, cfg.bind, () => { server.off('error', reject); resolve() })
  })
  const port = (server.address() as AddressInfo).port

  // Plain HTTP only redirects (F7).
  let redirect: http.Server | null = null
  if (cfg.httpPort !== null && tls.info().secure) {
    redirect = http.createServer((req, res) => {
      const host = (req.headers.host ?? 'localhost').replace(/:\d+$/, '')
      res.statusCode = 308
      res.setHeader('Location', `https://${host}${port === 443 ? '' : `:${port}`}${req.url ?? '/'}`)
      res.end()
    })
    const r = redirect
    await new Promise<void>((resolve) => {
      r.once('error', (err) => { log.warn('Could not open the HTTP redirect port', { port: cfg.httpPort, reason: err.message }); resolve() })
      r.listen(cfg.httpPort ?? 0, cfg.bind, () => resolve())
    })
  }

  // Daily backups (F15).
  const backupTick = (): void => {
    try {
      const last = lastBackupAt(paths)
      if (!last || Date.now() - last.getTime() >= DAY_MS) {
        const b = makeBackup(paths, 'daily')
        const dropped = pruneBackups(paths, cfg.backupsKept)
        log.info('Backup made', { backup: b.name, removed: dropped.length })
      }
    } catch (err) {
      log.error('Backup failed', { reason: err instanceof Error ? err.message : String(err) })
    }
  }
  backupTick()
  const backupTimer = setInterval(backupTick, 3600_000)
  backupTimer.unref()

  tls.startRenewal()
  updates.start()

  const t = tls.info()
  const lines = [
    '',
    `  KRNL0 server ${VERSION}`,
    `  Website: ${cfg.website ? 'on' : 'off'}   App sync: ${cfg.appSync ? 'on' : 'off'}   Encryption: ${t.mode}`,
    ...addressesOf(cfg, port).slice(0, 6).map((a, i) => `  ${i === 0 ? 'Open' : '    '}  ${a}`),
  ]
  if (t.fingerprint) lines.push(`  Fingerprint  ${t.fingerprint}`)
  if (cfg.tls.mode === 'proxy') lines.push(`  Listening on ${cfg.bind}:${port} for your reverse proxy.`)
  if (inDocker() && cfg.hosts.length === 0) lines.push('  Tip: set KRNL0_HOSTS to the address you open (e.g. 192.168.1.20) so the certificate covers it.')
  lines.push('')
  log.block(lines.join('\n'))
  if (!auth.hasOwner()) setup.current()

  const url = `${t.secure ? 'https' : 'http'}://localhost:${port}`

  return {
    cfg,
    paths,
    ctx,
    port,
    url,
    close: async () => {
      clearInterval(backupTimer)
      tls.stop()
      updates.stop()
      hub.close()
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      await closed
      if (redirect) await new Promise<void>((resolve) => redirect?.close(() => resolve()))
      try {
        const lock = lockSchema.parse(JSON.parse(readFileSync(paths.lock, 'utf8')))
        if (lock.pid === process.pid) rmSync(paths.lock, { force: true })
      } catch { /* already gone */ }
    },
  }
}
