// The Docker updater (F29, Decision S12): a second container with the Docker
// socket and its own krnl0-update volume (never /data, no ports). It updates
// the container labelled krnl0.role=server to the image digest of a verified
// release, keeps its settings and Compose labels, checks it, and goes back on
// failure. It updates itself last.

import http from 'node:http'
import { z } from 'zod'
import type { Job, UpdaterStatus } from './files.js'
import { readAuto, readStatus, writeStatus, hasRequest, clearRequest } from './files.js'
import { IMAGE_REPO, newestVerified, type ReleaseDeps, type VerifiedRelease } from './release.js'
import { compareVersions } from '../version.js'

type Json = Record<string, unknown>

export interface DockerApi {
  call: (method: string, path: string, body?: unknown, timeoutMs?: number) => Promise<{ status: number; body: Buffer }>
}

/** Docker Engine API over the mounted socket. */
export function socketApi(socketPath = '/var/run/docker.sock'): DockerApi {
  return {
    call: (method, path, body, timeoutMs = 120_000) => new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
      // Unversioned paths: the engine's own API version (new engines refuse old fixed versions).
      const req = http.request({ socketPath, path, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}, timeout: timeoutMs }, (res) => {
        const parts: Buffer[] = []
        res.on('data', (c: Buffer) => parts.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts) }))
      })
      req.on('timeout', () => req.destroy(new Error('Docker did not answer in time')))
      req.on('error', reject)
      if (data) req.write(data)
      req.end()
    }),
  }
}

const enc = encodeURIComponent

export interface DockerOptions {
  updateDir: string
  healthWaitMs: number
  autoDefault: boolean
  /** KRNL0_UPDATE_CHECK=off: no night updates either (the owner's request still works). */
  checkOn: boolean
  now: () => Date
  sleep: (ms: number) => Promise<void>
}

const inspectSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  Image: z.string(),
  Config: z.record(z.string(), z.unknown()),
  HostConfig: z.record(z.string(), z.unknown()),
  NetworkSettings: z.object({ Networks: z.record(z.string(), z.record(z.string(), z.unknown())).nullable().optional() }).passthrough(),
  State: z.object({ Running: z.boolean(), Health: z.object({ Status: z.string() }).optional() }).passthrough(),
}).passthrough()
type Inspect = z.infer<typeof inspectSchema>

export class DockerUpdater {
  private job: Job
  constructor(private readonly api: DockerApi, private readonly o: DockerOptions, private readonly deps: ReleaseDeps, private readonly selfVersion: string) {
    this.job = readStatus(o.updateDir)?.job ?? { state: 'idle', step: null, from: null, to: null, message: null, at: o.now().toISOString(), auto: false }
  }

  // ── Docker calls ─────────────────────────────────────────────────────────

  private async json<T = unknown>(method: string, path: string, body?: unknown, ok: number[] = [200, 201, 204], timeoutMs?: number): Promise<T> {
    const r = await this.api.call(method, path, body, timeoutMs)
    if (!ok.includes(r.status)) {
      let msg = r.body.toString('utf8').slice(0, 300)
      try { msg = String((JSON.parse(msg) as { message?: string }).message ?? msg) } catch { /* plain text */ }
      throw new Error(`Docker: ${msg || `status ${r.status}`}`)
    }
    return (r.body.length ? JSON.parse(r.body.toString('utf8')) : null) as T
  }

  private async findByLabel(role: 'server' | 'updater'): Promise<Array<{ Id: string; Names: string[] }>> {
    const filters = enc(JSON.stringify({ label: [`krnl0.role=${role}`] }))
    return this.json('GET', `/containers/json?all=1&filters=${filters}`)
  }

  private async inspect(id: string): Promise<Inspect | null> {
    const r = await this.api.call('GET', `/containers/${enc(id)}/json`)
    if (r.status === 404) return null
    if (r.status !== 200) throw new Error(`Docker: could not inspect ${id}`)
    return inspectSchema.parse(JSON.parse(r.body.toString('utf8')))
  }

  private async exec(id: string, cmd: string[]): Promise<{ code: number; out: string }> {
    const { Id } = await this.json<{ Id: string }>('POST', `/containers/${enc(id)}/exec`, { Cmd: cmd, AttachStdout: true, AttachStderr: true })
    const r = await this.api.call('POST', `/exec/${enc(Id)}/start`, { Detach: false, Tty: false }, 10 * 60_000)
    const info = await this.json<{ ExitCode: number | null }>('GET', `/exec/${enc(Id)}/json`)
    // The output is multiplexed (8-byte frame headers): text search is enough here.
    return { code: info.ExitCode ?? 1, out: r.body.toString('utf8') }
  }

  // ── Status ───────────────────────────────────────────────────────────────

  private async setJob(patch: Partial<Job>): Promise<void> {
    this.job = { ...this.job, ...patch, at: this.o.now().toISOString() }
    this.heartbeat()
  }

  heartbeat(): void {
    const s: UpdaterStatus = { updater: { kind: 'docker', version: this.selfVersion, aliveAt: this.o.now().toISOString() }, job: this.job }
    try { writeStatus(this.o.updateDir, s) } catch { /* best effort */ }
  }

  // ── The swap ─────────────────────────────────────────────────────────────

  /** The settings to create `c` again from another image: what the old image set itself is left to the new one. */
  private async recreateBody(c: Inspect, imageId: string): Promise<Json> {
    const oldImage = await this.json<{ Config?: Json }>('GET', `/images/${enc(c.Image)}/json`).catch(() => ({ Config: {} as Json }))
    const ic = (oldImage.Config ?? {}) as Json
    const cfg: Json = { ...c.Config }
    const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
    for (const k of ['Cmd', 'Entrypoint', 'Healthcheck', 'WorkingDir', 'User', 'ExposedPorts', 'Volumes', 'StopSignal']) {
      if (same(cfg[k], ic[k])) delete cfg[k]
    }
    const imageEnv = new Set(Array.isArray(ic['Env']) ? (ic['Env'] as string[]) : [])
    cfg['Env'] = (Array.isArray(cfg['Env']) ? (cfg['Env'] as string[]) : []).filter((e) => !imageEnv.has(e))
    const imageLabels = (ic['Labels'] ?? {}) as Record<string, string>
    const labels = { ...((cfg['Labels'] ?? {}) as Record<string, string>) }
    for (const [k, v] of Object.entries(imageLabels)) if (labels[k] === v) delete labels[k]
    if ('com.docker.compose.image' in labels) labels['com.docker.compose.image'] = imageId
    cfg['Labels'] = labels
    delete cfg['Hostname']
    delete cfg['Image']
    const nets = c.NetworkSettings.Networks ?? {}
    const EndpointsConfig = Object.fromEntries(Object.entries(nets).map(([name, e]) => [name, {
      ...(e['Aliases'] ? { Aliases: (e['Aliases'] as string[]).filter((a) => !c.Id.startsWith(a)) } : {}),
      ...(e['IPAMConfig'] ? { IPAMConfig: e['IPAMConfig'] } : {}),
      ...(e['Links'] ? { Links: e['Links'] } : {}),
    }]))
    return { ...cfg, Image: String(c.Config['Image']), HostConfig: c.HostConfig, NetworkingConfig: { EndpointsConfig } }
  }

  private async waitHealthy(id: string, version: string): Promise<boolean> {
    const until = Date.now() + this.o.healthWaitMs
    while (Date.now() < until) {
      const c = await this.inspect(id)
      if (c && c.State.Running && (!c.State.Health || c.State.Health.Status === 'healthy')) {
        const v = await this.exec(id, ['krnl0', 'version']).catch(() => ({ code: 1, out: '' }))
        if (v.out.includes(`krnl0-server ${version} `)) return true
      }
      await this.o.sleep(3000)
    }
    return false
  }

  private name(c: Inspect): string { return c.Name.replace(/^\//, '') }

  /** krnl0-old exists: an update was cut off. Keep the new one if it is healthy, else put the old one back. */
  async recover(): Promise<void> {
    const servers = await this.findByLabel('server')
    const old = servers.find((s) => s.Names.some((n) => n.endsWith('-old')))
    if (old) {
      const oldC = await this.inspect(old.Id)
      const base = oldC ? this.name(oldC).replace(/-old$/, '') : 'krnl0'
      const cur = servers.find((s) => s.Names.some((n) => n === `/${base}`))
      const ok = cur && this.job.to ? await this.waitHealthy(cur.Id, this.job.to) : false
      if (ok) {
        await this.api.call('DELETE', `/containers/${enc(old.Id)}?force=1`)
        if (this.job.state === 'running') await this.setJob({ state: 'done', step: null, message: null })
      } else {
        if (cur) await this.api.call('DELETE', `/containers/${enc(cur.Id)}?force=1`)
        await this.json('POST', `/containers/${enc(old.Id)}/rename?name=${enc(base)}`)
        await this.json('POST', `/containers/${enc(old.Id)}/start`, undefined, [204, 304])
        await this.setJob({ state: 'rolled-back', step: null, message: `The update was interrupted. Your server is back on ${this.job.from ?? 'the version before'}. Nothing was lost.` })
      }
    }
    // A previous updater left behind after it updated itself.
    for (const u of await this.findByLabel('updater')) {
      if (u.Names.some((n) => n.endsWith('-old'))) await this.api.call('DELETE', `/containers/${enc(u.Id)}?force=1`)
    }
  }

  async apply(v: VerifiedRelease, auto: boolean): Promise<void> {
    const list = await this.findByLabel('server')
    const target = list.find((s) => !s.Names.some((n) => n.endsWith('-old')))
    if (!target) { await this.setJob({ state: 'failed', step: null, message: 'No KRNL0 server container was found (label krnl0.role=server).', auto }); return }
    const c = await this.inspect(target.Id)
    if (!c) return
    const ref = String(c.Config['Image'] ?? '')
    const pinned = /:(\d+\.\d+\.\d+)$/.exec(ref)?.[1]
    if (pinned) { await this.setJob({ state: 'failed', step: null, message: `This server is pinned to ${pinned} (KRNL0_VERSION in .env). Change it there to update.`, auto }); return }
    const from = (await this.exec(c.Id, ['krnl0', 'version'])).out.match(/krnl0-server (\d+\.\d+\.\d+)/)?.[1] ?? '?'
    const to = v.version
    await this.setJob({ state: 'running', step: 'backup', from, to, message: null, auto })

    const b = await this.exec(c.Id, ['krnl0', 'backup'])
    const backup = b.out.match(/Backup made: (\S+)/)?.[1] ?? null
    if (b.code !== 0 || !backup) { await this.setJob({ state: 'failed', step: null, message: 'The backup did not work, so nothing was changed.' }); return }

    await this.setJob({ step: 'download' })
    const digest = v.release.image.split('@')[1]!
    const pull = await this.api.call('POST', `/images/create?fromImage=${enc(IMAGE_REPO)}&tag=${enc(digest)}`, undefined, 30 * 60_000)
    if (pull.status !== 200 || /"error"/.test(pull.body.toString('utf8'))) { await this.setJob({ state: 'failed', step: null, message: 'The new image could not be downloaded. Nothing was changed.' }); return }
    await this.setJob({ step: 'verify' })
    const img = await this.json<{ Id: string; RepoDigests?: string[] }>('GET', `/images/${enc(v.release.image)}/json`)
    if (!(img.RepoDigests ?? []).includes(v.release.image)) { await this.setJob({ state: 'failed', step: null, message: 'The downloaded image is not the signed one. Nothing was changed.' }); return }
    const [repo, tag] = ref.includes(':') && !ref.includes('@') ? [ref.slice(0, ref.lastIndexOf(':')), ref.slice(ref.lastIndexOf(':') + 1)] : [IMAGE_REPO, 'latest']
    await this.json('POST', `/images/${enc(v.release.image)}/tag?repo=${enc(repo)}&tag=${enc(tag)}`, undefined, [200, 201])

    await this.setJob({ step: 'switch' })
    const base = this.name(c)
    const body = await this.recreateBody(c, img.Id)
    await this.json('POST', `/containers/${enc(c.Id)}/stop?t=20`, undefined, [204, 304])
    await this.json('POST', `/containers/${enc(c.Id)}/rename?name=${enc(`${base}-old`)}`)
    let created: { Id: string }
    try {
      created = await this.json<{ Id: string }>('POST', `/containers/create?name=${enc(base)}`, body)
      await this.json('POST', `/containers/${enc(created.Id)}/start`, undefined, [204, 304])
    } catch (err) {
      await this.putBack(c.Id, base, null, backup, from, `The new container could not start (${err instanceof Error ? err.message : String(err)}).`)
      return
    }
    await this.setJob({ step: 'health' })
    if (!(await this.waitHealthy(created.Id, to))) {
      await this.putBack(c.Id, base, created.Id, backup, from, `The new version did not answer within ${Math.round(this.o.healthWaitMs / 1000)} seconds.`)
      return
    }
    await this.api.call('DELETE', `/containers/${enc(c.Id)}?force=1`)
    await this.setJob({ state: 'done', step: null, message: null })
    await this.updateSelf(v, img.Id).catch(() => { /* the next run tries again */ })
  }

  /** The way back: the old container under its own name again; the backup when it will not start. */
  private async putBack(oldId: string, base: string, newId: string | null, backup: string, from: string, reason: string): Promise<void> {
    await this.setJob({ step: 'rollback', message: reason })
    if (newId) await this.api.call('DELETE', `/containers/${enc(newId)}?force=1`)
    await this.json('POST', `/containers/${enc(oldId)}/rename?name=${enc(base)}`)
    await this.json('POST', `/containers/${enc(oldId)}/start`, undefined, [204, 304])
    if (!(await this.waitHealthy(oldId, from))) {
      await this.setJob({ step: 'restore' })
      const c = await this.inspect(oldId)
      if (c) {
        await this.json('POST', `/containers/${enc(oldId)}/stop?t=20`, undefined, [204, 304])
        const one = await this.json<{ Id: string }>('POST', `/containers/create`, { Image: c.Image, Cmd: ['restore', backup, '--yes'], HostConfig: { Binds: c.HostConfig['Binds'] ?? null, Mounts: c.HostConfig['Mounts'] ?? null } })
        await this.json('POST', `/containers/${enc(one.Id)}/start`, undefined, [204, 304])
        await this.json('POST', `/containers/${enc(one.Id)}/wait`, undefined, [200], 10 * 60_000)
        await this.api.call('DELETE', `/containers/${enc(one.Id)}?force=1`)
        await this.json('POST', `/containers/${enc(oldId)}/start`, undefined, [204, 304])
      }
      if (!(await this.waitHealthy(oldId, from))) {
        await this.setJob({ state: 'failed', step: null, message: `${reason} Going back to ${from} did not start either. Run: docker compose logs krnl0` })
        return
      }
    }
    await this.setJob({ state: 'rolled-back', step: null, message: `${reason} Your server is back on ${from}. Nothing was lost.` })
  }

  /** The updater container moves to the same image; the new one removes this one when it starts. */
  private async updateSelf(v: VerifiedRelease, imageId: string): Promise<void> {
    if (compareVersions(v.version, this.selfVersion) <= 0) return
    const me = (await this.findByLabel('updater')).find((u) => !u.Names.some((n) => n.endsWith('-old')))
    if (!me) return
    const c = await this.inspect(me.Id)
    if (!c || c.Image === imageId) return
    const base = this.name(c)
    const body = await this.recreateBody(c, imageId)
    await this.json('POST', `/containers/${enc(c.Id)}/rename?name=${enc(`${base}-old`)}`)
    const created = await this.json<{ Id: string }>('POST', `/containers/create?name=${enc(base)}`, body)
    await this.json('POST', `/containers/${enc(created.Id)}/start`, undefined, [204, 304])
  }

  /** One tick of the updater's loop (every minute). */
  async tick(): Promise<void> {
    await this.recover()
    const requested = hasRequest(this.o.updateDir)
    if (requested) clearRequest(this.o.updateDir)
    const auto = readAuto(this.o.updateDir, this.o.autoDefault)
    const now = this.o.now()
    const nightKey = now.toISOString().slice(0, 10)
    const nightly = auto && this.o.checkOn && !requested && now.getHours() === 4 && this.lastNight !== nightKey
    if (!requested && !nightly) { this.heartbeat(); return }
    if (nightly) this.lastNight = nightKey
    let v: VerifiedRelease | null
    try {
      v = await newestVerified(await this.serverVersion() ?? this.selfVersion, this.deps)
    } catch (err) {
      if (requested) await this.setJob({ state: 'failed', step: null, message: err instanceof Error ? err.message : String(err) })
      return
    }
    if (!v) { if (requested) await this.setJob({ state: 'done', step: null, message: 'Your server already runs the newest version.' }); return }
    // A pull can take minutes: keep the heartbeat going so the app doesn't think the updater died.
    const beat = setInterval(() => this.heartbeat(), 30_000)
    beat.unref?.()
    try {
      await this.apply(v, nightly).catch(async (err: unknown) => {
        await this.setJob({ state: 'failed', step: null, message: err instanceof Error ? err.message : String(err) })
        await this.recover().catch(() => { /* next tick */ })
      })
    } finally {
      clearInterval(beat)
    }
  }

  private lastNight: string | null = null

  /** The version the server container runs now (what an update is compared with). */
  private async serverVersion(): Promise<string | null> {
    const target = (await this.findByLabel('server')).find((s) => !s.Names.some((n) => n.endsWith('-old')))
    if (!target) return null
    const v = await this.exec(target.Id, ['krnl0', 'version']).catch(() => ({ code: 1, out: '' }))
    return v.out.match(/krnl0-server (d+.d+.d+)/)?.[1] ?? null
  }
}
