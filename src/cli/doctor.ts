// `krnl0 doctor`: every check, and how to fix what is wrong.

import { accessSync, constants, existsSync, readFileSync, statSync, statfsSync } from 'node:fs'
import https from 'node:https'
import http from 'node:http'
import { join } from 'node:path'
import * as x509 from '@peculiar/x509'
import { configProblems, loadConfig, type Config } from '../config.js'
import type { DataPaths } from '../paths.js'
import { AuthStore } from '../auth/store.js'
import { lastBackupAt } from '../store/backup.js'
import { UpdateChecker } from '../update/check.js'
import { inDocker, runningPid } from '../server.js'
import { compareVersions } from '../version.js'

export type CheckStatus = 'ok' | 'warn' | 'fail'
export interface Check { status: CheckStatus; title: string; fix?: string }

const DAY = 24 * 3600_000

function certDays(pemText: string): { days: number; names: string[] } | null {
  const first = pemText.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0]
  if (!first) return null
  const cert = new x509.X509Certificate(first)
  const san = cert.getExtension(x509.SubjectAlternativeNameExtension)
  return { days: Math.floor((cert.notAfter.getTime() - Date.now()) / DAY), names: san ? san.names.toJSON().map((n) => n.value.toLowerCase()) : [] }
}

function probe(cfg: Config, paths: DataPaths): Promise<string | null> {
  return new Promise((resolve) => {
    const host = cfg.bind === '0.0.0.0' || cfg.bind === '::' ? '127.0.0.1' : cfg.bind
    const secure = cfg.tls.mode !== 'proxy'
    const caFile = join(paths.tls, 'ca.crt')
    const opts = { host, port: cfg.port, path: '/api/v1/health', timeout: 5000 }
    const done = (res: http.IncomingMessage): void => {
      res.resume()
      resolve(res.statusCode === 200 ? null : `answered ${res.statusCode}`)
    }
    const req = secure
      ? https.get({ ...opts, servername: 'localhost', ...(cfg.tls.mode === 'self-signed' && existsSync(caFile) ? { ca: readFileSync(caFile) } : { rejectUnauthorized: false }) }, done)
      : http.get(opts, done)
    req.on('timeout', () => { req.destroy(); resolve('no answer within 5 seconds') })
    req.on('error', (e) => resolve(e.message))
  })
}

export async function runDoctor(paths: DataPaths): Promise<Check[]> {
  const out: Check[] = []

  out.push(compareVersions(process.versions.node, '24.7.0') >= 0
    ? { status: 'ok', title: `Node.js ${process.versions.node}` }
    : { status: 'fail', title: `Node.js ${process.versions.node} is too old`, fix: 'Install Node.js 24.7 or newer (the Docker image and the Linux bundle include it).' })

  try {
    accessSync(paths.root, constants.W_OK)
    out.push({ status: 'ok', title: `Data folder ${paths.root}` })
  } catch {
    out.push({ status: 'fail', title: `Cannot write the data folder ${paths.root}`, fix: 'Check that the folder exists and belongs to the user that runs KRNL0.' })
    return out
  }

  let cfg: Config
  try {
    cfg = loadConfig(paths.config)
  } catch (err) {
    out.push({ status: 'fail', title: 'The settings cannot be read', fix: `${err instanceof Error ? err.message : String(err)} — fix config.json or run: krnl0 setup` })
    return out
  }
  const problems = configProblems(cfg)
  for (const p of problems) out.push({ status: 'fail', title: 'Settings', fix: p })
  if (problems.length === 0) out.push({ status: 'ok', title: `Website ${cfg.website ? 'on' : 'off'}, App sync ${cfg.appSync ? 'on' : 'off'}, encryption ${cfg.tls.mode}` })

  const auth = new AuthStore(paths)
  if (!auth.hasOwner()) out.push({ status: 'warn', title: 'No owner account yet', fix: 'Run: krnl0 setup  (or use the setup code in the server log)' })
  else out.push({ status: 'ok', title: 'Owner account exists' })
  if (auth.hasOwner() && !auth.totpEnabled()) out.push({ status: 'warn', title: 'Two-factor codes are off', fix: 'Recommended: krnl0 2fa enable' })
  if (auth.totpEnabled() && auth.recoveryCodesLeft() < 3) out.push({ status: 'warn', title: `Only ${auth.recoveryCodesLeft()} recovery codes left`, fix: 'Turn 2FA off and on again for new ones: krnl0 2fa disable && krnl0 2fa enable' })

  if (process.platform !== 'win32') {
    for (const f of [paths.owner, paths.sessions, paths.devices, join(paths.tls, 'ca.key'), join(paths.tls, 'server.key')]) {
      if (existsSync(f) && (statSync(f).mode & 0o077) !== 0) out.push({ status: 'fail', title: `${f} can be read by other users`, fix: `chmod 600 ${f}` })
    }
  }

  // TLS
  if (cfg.tls.mode === 'self-signed') {
    const crt = join(paths.tls, 'server.crt')
    const info = existsSync(crt) ? certDays(readFileSync(crt, 'utf8')) : null
    if (!info) out.push({ status: 'warn', title: 'No certificate yet', fix: 'It is made on the first start: krnl0 start' })
    else {
      out.push(info.days > 30 ? { status: 'ok', title: `Certificate valid for ${info.days} more days` } : { status: 'warn', title: `Certificate ends in ${info.days} days`, fix: 'Restart the server; it renews automatically.' })
      const missing = cfg.hosts.map((h) => h.toLowerCase()).filter((h) => !info.names.includes(h))
      if (missing.length > 0) out.push({ status: 'warn', title: `Certificate does not cover ${missing.join(', ')}`, fix: 'Restart the server to renew it with the new names.' })
    }
    if (inDocker() && cfg.hosts.length === 0) out.push({ status: 'warn', title: 'In Docker without KRNL0_HOSTS', fix: 'Set KRNL0_HOSTS to the address you open (e.g. 192.168.1.20) so the certificate covers it.' })
  } else if (cfg.tls.mode === 'files') {
    try {
      const info = certDays(readFileSync(cfg.tls.certFile ?? '', 'utf8'))
      readFileSync(cfg.tls.keyFile ?? '')
      if (!info) out.push({ status: 'fail', title: 'The certificate file holds no certificate', fix: `Check ${cfg.tls.certFile ?? ''}` })
      else out.push(info.days > 14 ? { status: 'ok', title: `Certificate file valid for ${info.days} more days` } : { status: info.days < 0 ? 'fail' : 'warn', title: `Certificate file ends in ${info.days} days`, fix: 'Renew it (tailscale cert / certbot renew); the server picks it up within an hour.' })
    } catch (err) {
      out.push({ status: 'fail', title: 'Cannot read the certificate files', fix: err instanceof Error ? err.message : String(err) })
    }
  } else {
    out.push(cfg.trustProxy
      ? { status: 'ok', title: `Behind a reverse proxy, listening on ${cfg.bind}:${cfg.port}` }
      : { status: 'warn', title: 'Proxy mode without trustProxy', fix: 'krnl0 config set trustProxy on  (so rate limits see real addresses)' })
  }

  // Running?
  const pid = runningPid(paths)
  if (pid === null) out.push({ status: 'warn', title: 'The server is not running', fix: 'Start it: krnl0 start  (Docker: docker compose up -d; Linux: systemctl start krnl0)' })
  else {
    const err = await probe(cfg, paths)
    out.push(err === null ? { status: 'ok', title: `Running (pid ${pid}) and answering on port ${cfg.port}` } : { status: 'fail', title: `Running (pid ${pid}) but not answering on port ${cfg.port}`, fix: err })
  }

  try {
    new Intl.DateTimeFormat('en', { timeZone: cfg.timeZone })
    out.push(inDocker() && cfg.timeZone === 'UTC'
      ? { status: 'warn', title: 'Time zone is UTC', fix: 'Set TZ to yours (e.g. TZ=Europe/Berlin) so days start at your midnight.' }
      : { status: 'ok', title: `Time zone ${cfg.timeZone}` })
  } catch {
    out.push({ status: 'fail', title: `Unknown time zone ${cfg.timeZone}`, fix: 'krnl0 config set timeZone Europe/Berlin' })
  }

  try {
    const fs = statfsSync(paths.root)
    const free = fs.bavail * fs.bsize
    out.push(free > 1024 ** 3 ? { status: 'ok', title: `${(free / 1024 ** 3).toFixed(1)} GB free` } : { status: 'warn', title: `Only ${(free / 1024 ** 2).toFixed(0)} MB free`, fix: 'Free some disk space; backups and media need room.' })
  } catch { /* not available everywhere */ }

  const last = lastBackupAt(paths)
  if (!last) out.push({ status: 'warn', title: 'No backup yet', fix: 'One is made on start and daily; or now: krnl0 backup' })
  else {
    const hours = Math.floor((Date.now() - last.getTime()) / 3600_000)
    out.push(hours <= 48 ? { status: 'ok', title: `Last backup ${hours} hours ago` } : { status: 'warn', title: `Last backup ${Math.floor(hours / 24)} days ago`, fix: 'Is the server running? Make one now: krnl0 backup' })
  }

  if (cfg.website) {
    const has = cfg.webDir !== null && existsSync(join(cfg.webDir, 'index.html'))
    out.push(has ? { status: 'ok', title: 'KRNL0 web app installed' } : { status: 'warn', title: 'Website is on but the KRNL0 web app is not installed', fix: 'Use the Docker image or the Linux bundle (they include it), or set webDir.' })
  }

  const upd = new UpdateChecker(paths, cfg.updateCheck).info()
  if (upd.available) out.push({ status: 'warn', title: `KRNL0 server ${upd.latest ?? ''} is out (you have ${upd.current})`, fix: 'See: krnl0 help updates' })
  else if (!cfg.updateCheck) out.push({ status: 'ok', title: 'Update check is off' })

  return out
}

export function formatChecks(checks: Check[]): string {
  const mark: Record<CheckStatus, string> = { ok: '[ ok ]', warn: '[warn]', fail: '[FAIL]' }
  const lines = checks.map((c) => `${mark[c.status]} ${c.title}${c.fix ? `\n       -> ${c.fix}` : ''}`)
  const fails = checks.filter((c) => c.status === 'fail').length
  const warns = checks.filter((c) => c.status === 'warn').length
  lines.push('', fails === 0 && warns === 0 ? 'Everything looks good.' : `${fails} problem(s), ${warns} warning(s).`)
  return lines.join('\n')
}
