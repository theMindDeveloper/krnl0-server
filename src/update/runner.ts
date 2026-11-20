// `krnl0 updater …` — the privileged side of Decision S12. Not for people:
//   krnl0 updater verify <folder> <tag>   CI: a built release verifies like updaters will check it
//   krnl0 updater linux                   one run of krnl0-update.service (root)
//   krnl0 updater docker                  the updater container's loop

import http from 'node:http'
import https from 'node:https'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultDeps, sigstoreVerifier, verifyFolder } from './release.js'
import { LINUX_DEFAULTS, LinuxUpdater, type Sys } from './linux.js'
import { DockerUpdater, socketApi } from './docker.js'
import { VERSION } from '../version.js'

const say = (s: string): void => { process.stdout.write(`${s}\n`) }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function run(cmd: string, args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], timeout: opts.timeoutMs ?? 60_000 })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
    child.on('error', (err) => resolve({ code: 127, stdout, stderr: stderr + err.message }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    if (opts.input !== undefined) child.stdin.end(opts.input)
    else child.stdin.end()
  })
}

/** The local server's version from /api/v1/health (its own certificate is not checked: this is localhost). */
function health(port: number): Promise<string | null> {
  const get = (mod: typeof http | typeof https, extra: Record<string, unknown>): Promise<string | null> => new Promise((resolve) => {
    const req = mod.get({ host: '127.0.0.1', port, path: '/api/v1/health', timeout: 4000, ...extra }, (res) => {
      let body = ''
      res.on('data', (d: Buffer) => { body += d.toString('utf8') })
      res.on('end', () => { try { resolve(String((JSON.parse(body) as { version?: unknown }).version ?? '') || null) } catch { resolve(null) } })
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(null))
  })
  return get(https, { rejectUnauthorized: false }).then((v) => v ?? get(http, {}))
}

export async function updaterMain(args: string[]): Promise<number> {
  const [what, a, b] = args
  if (what === 'verify') {
    if (!a || !b) { say('Usage: krnl0 updater verify <folder> <tag>'); return 2 }
    const v = await verifyFolder(a, b, { verifySignature: sigstoreVerifier(mkdtempSync(join(tmpdir(), 'krnl0-tuf-'))) })
    say(`Verified ${v.tag}: signed by release.yml@refs/tags/${v.tag}; ${v.sums.size} files match; image ${v.release.image}; protocol ${v.release.protocol}; minimum KRNL0 ${v.release.minApp ?? '-'}`)
    return 0
  }
  if (what === 'linux') {
    if (process.getuid?.() !== 0) { say('The Linux updater runs as root (krnl0-update.service).'); return 1 }
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    const sys: Sys = { run, sleep, now: () => new Date(), health }
    const u = new LinuxUpdater({ ...LINUX_DEFAULTS, arch, autoDefault: process.env.KRNL0_AUTO_UPDATE === 'on' }, sys, defaultDeps(join(LINUX_DEFAULTS.cacheDir, 'tuf')), VERSION)
    await u.run()
    return 0
  }
  if (what === 'docker') {
    const updateDir = process.env.KRNL0_UPDATE_DIR ?? '/update'
    const u = new DockerUpdater(socketApi(process.env.KRNL0_DOCKER_SOCKET ?? '/var/run/docker.sock'), {
      updateDir, healthWaitMs: 90_000, autoDefault: process.env.KRNL0_AUTO_UPDATE === 'on', now: () => new Date(), sleep,
    }, defaultDeps(mkdtempSync(join(tmpdir(), 'krnl0-tuf-'))), VERSION)
    say(`KRNL0 updater ${VERSION}: watching ${updateDir}`)
    for (;;) {
      await u.tick().catch((err: unknown) => say(`updater: ${err instanceof Error ? err.message : String(err)}`))
      await sleep(60_000)
    }
  }
  say('Usage: krnl0 updater <verify|linux|docker>')
  return 2
}
