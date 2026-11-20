// The Linux install's updater (F26, F27, Decision S12). Runs as root from
// krnl0-update.service, started by krnl0-update.path (the owner's request) or
// krnl0-update.timer (daily: update at night when on, repair a crash halfway).
//
// Root never opens files in the server's data folder: requests are removed,
// settings read and status written as the krnl0 user (runuser). What to
// install comes only from release.ts (signed, this repository, newer).

import { existsSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, mkdirSync, readlinkSync, cpSync, chmodSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { writeJsonAtomic } from '../fsutil.js'
import { compareVersions } from '../version.js'
import { statusSchema, type Job, type UpdaterStatus } from './files.js'
import { downloadChecked, newestVerified, type ReleaseDeps, type VerifiedRelease } from './release.js'

export interface Sys {
  run: (cmd: string, args: string[], opts?: { input?: string; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>
  sleep: (ms: number) => Promise<void>
  now: () => Date
  /** The running server's version from /api/v1/health, or null when it does not answer. */
  health: (port: number) => Promise<string | null>
}

export interface LinuxOptions {
  prefix: string        // /opt/krnl0
  data: string          // /var/lib/krnl0
  stateDir: string      // /var/lib/krnl0-updater (root only)
  cacheDir: string      // /var/cache/krnl0-updater
  unitDir: string       // /etc/systemd/system
  binDir: string        // /usr/local/bin
  arch: 'x64' | 'arm64'
  healthWaitMs: number  // 90 s
  autoDefault: boolean
}

export const LINUX_DEFAULTS: Omit<LinuxOptions, 'arch' | 'autoDefault'> = {
  prefix: '/opt/krnl0',
  data: '/var/lib/krnl0',
  stateDir: '/var/lib/krnl0-updater',
  cacheDir: '/var/cache/krnl0-updater',
  unitDir: '/etc/systemd/system',
  binDir: '/usr/local/bin',
  healthWaitMs: 90_000,
}

const stateSchema = z.object({
  phase: z.enum(['switching', 'done']),
  from: z.string(),
  to: z.string(),
  backup: z.string().nullable(),
  at: z.string(),
})
type State = z.infer<typeof stateSchema>

const UNITS = ['krnl0.service', 'krnl0-update.service', 'krnl0-update.path', 'krnl0-update.timer']

export class LinuxUpdater {
  private job: Job
  constructor(private readonly o: LinuxOptions, private readonly sys: Sys, private readonly deps: ReleaseDeps, private readonly selfVersion: string) {
    this.job = { state: 'idle', step: null, from: null, to: null, message: null, at: sys.now().toISOString(), auto: false }
  }

  private get updateDir(): string { return join(this.o.data, 'update') }
  private versionDir(v: string): string { return join(this.o.prefix, 'versions', v) }
  private node(v: string): string { return join(this.versionDir(v), 'node', 'bin', 'node') }
  private app(v: string): string { return join(this.versionDir(v), 'app', 'bin', 'krnl0.js') }

  /** The version /opt/krnl0/current points at. */
  currentVersion(): string {
    return basename(readlinkSync(join(this.o.prefix, 'current')))
  }

  private asKrnl0(args: string[], input?: string, timeoutMs = 60_000): ReturnType<Sys['run']> {
    return this.sys.run('runuser', ['-u', 'krnl0', '--', ...args], { ...(input !== undefined ? { input } : {}), timeoutMs })
  }

  private async cli(version: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return this.asKrnl0(['env', `KRNL0_DATA_DIR=${this.o.data}`, this.node(version), this.app(version), ...args], undefined, 10 * 60_000)
  }

  /** Writes status.json as the krnl0 user, atomically. */
  async writeStatus(): Promise<void> {
    const s: UpdaterStatus = { updater: { kind: 'systemd', version: this.selfVersion, aliveAt: this.sys.now().toISOString() }, job: this.job }
    const script = "const fs=require('fs'),p=require('path');let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=process.argv[1];fs.mkdirSync(d,{recursive:true,mode:0o700});const t=p.join(d,'.status.tmp');fs.writeFileSync(t,s,{mode:0o600});fs.renameSync(t,p.join(d,'status.json'))})"
    await this.asKrnl0([this.node(this.currentVersion()), '-e', script, this.updateDir], JSON.stringify(s))
  }

  private async setJob(patch: Partial<Job>): Promise<void> {
    this.job = { ...this.job, ...patch, at: this.sys.now().toISOString() }
    await this.writeStatus().catch(() => { /* status is best effort */ })
  }

  private async readAsKrnl0(path: string): Promise<string | null> {
    const r = await this.asKrnl0(['head', '-c', '65536', path])
    return r.code === 0 ? r.stdout : null
  }

  async hasRequest(): Promise<boolean> {
    return (await this.asKrnl0(['test', '-e', join(this.updateDir, 'request')])).code === 0
  }

  async clearRequest(): Promise<void> {
    await this.asKrnl0(['rm', '-f', join(this.updateDir, 'request')])
  }

  async autoOn(): Promise<boolean> {
    // The owner's update check off also stops night updates.
    const cfg = await this.readAsKrnl0(join(this.o.data, 'config.json'))
    try { if (z.object({ updateCheck: z.boolean() }).partial().parse(JSON.parse(cfg ?? '{}')).updateCheck === false) return false } catch { /* no config yet */ }
    const raw = await this.readAsKrnl0(join(this.updateDir, 'settings.json'))
    if (raw === null) return this.o.autoDefault
    try { return z.object({ auto: z.boolean() }).parse(JSON.parse(raw)).auto } catch { return this.o.autoDefault }
  }

  private async port(): Promise<number> {
    const raw = await this.readAsKrnl0(join(this.o.data, 'config.json'))
    try { const p = z.object({ port: z.number().int() }).partial().parse(JSON.parse(raw ?? '{}')).port; return p ?? 8443 } catch { return 8443 }
  }

  private async waitFor(version: string): Promise<boolean> {
    const port = await this.port()
    const until = Date.now() + this.o.healthWaitMs
    while (Date.now() < until) {
      if ((await this.sys.health(port)) === version) return true
      await this.sys.sleep(2000)
    }
    return false
  }

  private readState(): State | null {
    try { return stateSchema.parse(JSON.parse(readFileSync(join(this.o.stateDir, 'state.json'), 'utf8'))) } catch { return null }
  }

  private saveState(s: State): void {
    mkdirSync(this.o.stateDir, { recursive: true, mode: 0o700 })
    writeJsonAtomic(join(this.o.stateDir, 'state.json'), s)
  }

  /** current → `version`, its wrapper and units installed, the service restarted. */
  private async switchTo(version: string): Promise<void> {
    const tmp = join(this.o.prefix, '.current.tmp')
    rmSync(tmp, { force: true })
    symlinkSync(this.versionDir(version), tmp, 'junction') // the type only matters on Windows (tests)
    const cur = join(this.o.prefix, 'current')
    try {
      renameSync(tmp, cur) // atomic on Linux
    } catch (err) {
      if (process.platform !== 'win32') throw err
      rmSync(cur, { force: true }) // Windows (tests) cannot rename over a link
      renameSync(tmp, cur)
    }
    cpSync(join(this.versionDir(version), 'krnl0'), join(this.o.binDir, 'krnl0'))
    chmodSync(join(this.o.binDir, 'krnl0'), 0o755)
    for (const u of UNITS) {
      const src = join(this.versionDir(version), u)
      if (existsSync(src)) cpSync(src, join(this.o.unitDir, u))
    }
    await this.sys.run('systemctl', ['daemon-reload'])
    await this.sys.run('systemctl', ['restart', 'krnl0'])
  }

  /** Back to `s.from`; restores the backup when the older version will not start on the newer data. */
  private async rollback(s: State, reason: string): Promise<void> {
    await this.setJob({ state: 'running', step: 'rollback', message: reason })
    await this.switchTo(s.from)
    if (!(await this.waitFor(s.from)) && s.backup) {
      await this.setJob({ step: 'restore' })
      await this.sys.run('systemctl', ['stop', 'krnl0'])
      await this.cli(s.from, ['restore', s.backup, '--yes'])
      await this.sys.run('systemctl', ['start', 'krnl0'])
      if (!(await this.waitFor(s.from))) {
        this.saveState({ ...s, phase: 'switching' })
        await this.setJob({ state: 'failed', step: null, message: `${reason} Going back to ${s.from} did not start either. Run: sudo krnl0 doctor` })
        return
      }
    }
    this.saveState({ ...s, phase: 'done' })
    await this.setJob({ state: 'rolled-back', step: null, to: s.to, from: s.from, message: `${reason} Your server is back on ${s.from}. Nothing was lost.` })
  }

  /** Finishes or undoes an update a crash interrupted. */
  async recover(): Promise<void> {
    const s = this.readState()
    if (!s || s.phase !== 'switching') return
    const running = await this.sys.health(await this.port())
    if (running === s.to && this.currentVersion() === s.to) {
      this.saveState({ ...s, phase: 'done' })
      await this.setJob({ state: 'done', step: null, from: s.from, to: s.to, message: null })
      return
    }
    await this.rollback(s, 'The update was interrupted.')
  }

  /** One update to `v` (already verified), with backup, health check and the way back. */
  async apply(v: VerifiedRelease, auto: boolean): Promise<void> {
    const from = this.currentVersion()
    const to = v.version
    await this.setJob({ state: 'running', step: 'backup', from, to, message: null, auto })
    const b = await this.cli(from, ['backup'])
    const backup = b.stdout.match(/Backup made: (\S+)/)?.[1] ?? null
    if (b.code !== 0 || !backup) { await this.setJob({ state: 'failed', step: null, message: 'The backup did not work, so nothing was changed. Run: sudo krnl0 doctor' }); return }

    await this.setJob({ step: 'download' })
    const name = [...v.sums.keys()].find((n) => n === `krnl0-server-${to}-linux-${this.o.arch}.tar.gz`)
    if (!name) { await this.setJob({ state: 'failed', step: null, message: `This release has no bundle for ${this.o.arch}. Nothing was changed.` }); return }
    const file = await downloadChecked(v, name, join(this.o.cacheDir, 'download'), this.deps)

    await this.setJob({ step: 'verify' })
    const dest = this.versionDir(to)
    const partial = `${dest}.partial`
    rmSync(partial, { recursive: true, force: true })
    mkdirSync(partial, { recursive: true })
    const x = await this.sys.run('tar', ['-xzf', file, '-C', partial, '--strip-components=1', '--no-same-owner'], { timeoutMs: 5 * 60_000 })
    rmSync(file, { force: true })
    if (x.code !== 0 || !existsSync(join(partial, 'app', 'bin', 'krnl0.js'))) {
      rmSync(partial, { recursive: true, force: true })
      await this.setJob({ state: 'failed', step: null, message: 'The download could not be unpacked (is the disk full?). Nothing was changed.' })
      return
    }
    await this.sys.run('chown', ['-R', 'root:root', partial])
    rmSync(dest, { recursive: true, force: true })
    renameSync(partial, dest)

    const s: State = { phase: 'switching', from, to, backup, at: this.sys.now().toISOString() }
    this.saveState(s)
    await this.setJob({ step: 'switch' })
    await this.switchTo(to)
    await this.setJob({ step: 'health' })
    if (!(await this.waitFor(to))) {
      await this.rollback(s, `The new version did not answer within ${Math.round(this.o.healthWaitMs / 1000)} seconds.`)
      return
    }
    this.saveState({ ...s, phase: 'done' })
    this.prune(to, from)
    await this.setJob({ state: 'done', step: null, message: null })
  }

  /** Keeps the three newest versions (never the one running or the one before). */
  private prune(keepA: string, keepB: string): void {
    const dir = join(this.o.prefix, 'versions')
    const versions = readdirSync(dir).filter((n) => /^\d+\.\d+\.\d+$/.test(n)).sort(compareVersions)
    for (const old of versions.slice(0, Math.max(0, versions.length - 3))) {
      if (old !== keepA && old !== keepB) rmSync(join(dir, old), { recursive: true, force: true })
    }
  }

  /** One run of krnl0-update.service. */
  async run(): Promise<void> {
    const prev = await this.readAsKrnl0(join(this.updateDir, 'status.json'))
    try { if (prev) this.job = statusSchema.parse(JSON.parse(prev)).job } catch { /* a fresh status */ }
    await this.recover()
    const requested = await this.hasRequest()
    if (requested) await this.clearRequest()
    const auto = await this.autoOn()
    const hour = this.sys.now().getHours()
    const nightly = auto && !requested && hour >= 3 && hour < 6
    if (!requested && !nightly) { await this.setJob({}); return }
    let v: VerifiedRelease | null
    try {
      v = await newestVerified(this.currentVersion(), this.deps)
    } catch (err) {
      await this.setJob({ state: 'failed', step: null, message: err instanceof Error ? err.message : String(err), auto: nightly })
      return
    }
    if (!v) { await this.setJob({ state: requested ? 'done' : this.job.state, step: null, message: requested ? 'Your server already runs the newest version.' : this.job.message }); return }
    await this.apply(v, nightly).catch(async (err: unknown) => {
      const s = this.readState()
      const reason = err instanceof Error ? err.message : String(err)
      if (s && s.phase === 'switching') await this.rollback(s, reason)
      else await this.setJob({ state: 'failed', step: null, message: reason })
    })
  }
}
