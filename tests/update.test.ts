// Updating the server (F24–F31, Decision S12): what may be installed, how each
// install updates, the owner-only request, and the Linux and Docker swaps with
// their way back — including a crash halfway.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { identityFor, newestVerified, verifyManifest, type ReleaseDeps } from '../src/update/release.js'
import { serverUpdate, DOCKER_INSTALL, LINUX_INSTALL } from '../src/update/info.js'
import { readStatus, writeStatus, requestUpdate, hasRequest } from '../src/update/files.js'
import { LinuxUpdater, type Sys } from '../src/update/linux.js'
import { DockerUpdater, type DockerApi } from '../src/update/docker.js'
import { browserLogin, claim, PASSWORD, startTestServer, tempDir, type TestServer } from './helpers.js'

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')
const REPO_ID = (tag: string): string => `https://github.com/theMindDeveloper/krnl0-server/.github/workflows/release.yml@refs/tags/${tag}`
const DIGEST = `sha256:${'a'.repeat(64)}`

/** A fake GitHub with one published release, signed by `signer` (a Sigstore stand-in). */
function fakeGithub(version: string, opts: { signer?: string; tamperRelease?: boolean; files?: Record<string, Buffer> } = {}) {
  const tag = `v${version}`
  const release = Buffer.from(JSON.stringify({ version, web: '0.13.0', image: `ghcr.io/theminddeveloper/krnl0-server@${DIGEST}`, protocol: 1, dataFormat: 1, minApp: '0.13.0' }))
  const files: Record<string, Buffer> = { 'release.json': release, ...(opts.files ?? {}) }
  const sums = Buffer.from(Object.entries(files).map(([n, b]) => `${sha(b)}  ${n}`).join('\n') + '\n')
  const bundle = { signedBy: opts.signer ?? REPO_ID(tag), digest: sha(sums) }
  const served: Record<string, Buffer> = {
    'https://api.github.com/repos/theMindDeveloper/krnl0-server/releases/latest': Buffer.from(JSON.stringify({ tag_name: tag })),
    [`https://github.com/theMindDeveloper/krnl0-server/releases/download/${tag}/SHA256SUMS`]: sums,
    [`https://github.com/theMindDeveloper/krnl0-server/releases/download/${tag}/SHA256SUMS.sigstore.json`]: Buffer.from(JSON.stringify(bundle)),
  }
  for (const [n, b] of Object.entries(files)) served[`https://github.com/theMindDeveloper/krnl0-server/releases/download/${tag}/${n}`] = n === 'release.json' && opts.tamperRelease ? Buffer.from(b.toString().replace('0.13.0', '0.99.0')) : b
  const deps: ReleaseDeps = {
    fetchFn: async (url) => {
      const b = served[url]
      return { ok: !!b, status: b ? 200 : 404, arrayBuffer: async () => (b ?? Buffer.alloc(0)).buffer.slice((b ?? Buffer.alloc(0)).byteOffset, (b ?? Buffer.alloc(0)).byteOffset + (b ?? Buffer.alloc(0)).length) as ArrayBuffer, json: async () => JSON.parse((b ?? Buffer.from('{}')).toString()) }
    },
    verifySignature: async (b, data, identity) => {
      const x = b as { signedBy: string; digest: string }
      if (!new RegExp(identity).test(x.signedBy)) throw new Error(`certificate identity error - got ${x.signedBy}`)
      if (x.digest !== sha(data)) throw new Error('signature does not match')
    },
  }
  return { deps, tag, sums, bundle, release }
}

describe('only signed releases of this repository (F25)', () => {
  it('the identity is exactly release.yml at this tag', () => {
    const re = new RegExp(identityFor('v0.2.0'))
    expect(re.test(REPO_ID('v0.2.0'))).toBe(true)
    expect(re.test(REPO_ID('v0.2.01'))).toBe(false)
    expect(re.test(REPO_ID('v0.2.0').replace('release.yml', 'ci.yml'))).toBe(false)
    expect(re.test(REPO_ID('v0.2.0').replace('refs/tags', 'refs/heads'))).toBe(false)
    expect(re.test(REPO_ID('v0.2.0').replace('theMindDeveloper', 'someone'))).toBe(false)
  })
  it('a newer, correctly signed release verifies', async () => {
    const g = fakeGithub('0.2.0')
    const v = await newestVerified('0.1.0', g.deps)
    expect(v?.version).toBe('0.2.0')
    expect(v?.release.image).toBe(`ghcr.io/theminddeveloper/krnl0-server@${DIGEST}`)
  })
  it('nothing for the same or an older version (never a downgrade)', async () => {
    expect(await newestVerified('0.2.0', fakeGithub('0.2.0').deps)).toBeNull()
    expect(await newestVerified('0.3.0', fakeGithub('0.2.0').deps)).toBeNull()
  })
  it('refuses a signature from another workflow, and a changed release.json', async () => {
    await expect(newestVerified('0.1.0', fakeGithub('0.2.0', { signer: REPO_ID('v0.2.0').replace('release.yml', 'evil.yml') }).deps)).rejects.toThrow(/signature/)
    await expect(newestVerified('0.1.0', fakeGithub('0.2.0', { tamperRelease: true }).deps)).rejects.toThrow(/release.json does not match/)
  })
  it('refuses a release.json that names another version than its tag', async () => {
    const g = fakeGithub('0.2.0')
    const other = Buffer.from(g.release.toString().replace('"version":"0.2.0"', '"version":"0.3.0"'))
    const sums = Buffer.from(`${sha(other)}  release.json\n`)
    await expect(verifyManifest('v0.2.0', sums, { signedBy: REPO_ID('v0.2.0'), digest: sha(sums) }, other, g.deps)).rejects.toThrow(/says 0.3.0/)
  })
})

describe('how this server updates (F31)', () => {
  const check = { checkedAt: null, latest: '0.2.0', url: null, minApp: '0.13.0', protocol: 1, current: '0.1.0', available: true, enabled: true }
  const facts = (env: Record<string, string>, inDocker = false, program = '/app/bin/krnl0.js') => ({ env, inDocker, program, now: Date.parse('2026-11-21T10:00:00Z') })
  let dir = ''
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })
  const alive = (kind: 'docker' | 'systemd', at = '2026-11-21T09:59:30Z') => writeStatus(dir, { updater: { kind, version: '0.2.0', aliveAt: at }, job: { state: 'idle', step: null, from: null, to: null, message: null, at, auto: false } })

  it('Docker with a running updater: one click', () => {
    dir = tempDir(); alive('docker')
    expect(serverUpdate(check, dir, facts({ KRNL0_UPDATER: 'docker' }, true)).channel).toBe('one-click')
  })
  it('Docker updater silent for minutes: the command instead', () => {
    dir = tempDir(); alive('docker', '2026-11-21T09:00:00Z')
    const u = serverUpdate(check, dir, facts({ KRNL0_UPDATER: 'docker' }, true))
    expect(u.channel).toBe('command')
    expect(u.command).toContain('docker compose pull')
  })
  it('a pinned version: no one click, and it says where the pin is', () => {
    dir = tempDir(); alive('docker')
    const u = serverUpdate(check, dir, facts({ KRNL0_UPDATER: 'docker', KRNL0_IMAGE_TAG: '0.1.0' }, true))
    expect(u.channel).toBe('command')
    expect(u.reason).toMatch(/pinned to 0.1.0/)
  })
  it('plain docker run: the one-command installer, also for Windows', () => {
    dir = tempDir()
    const u = serverUpdate(check, dir, facts({}, true))
    expect(u).toMatchObject({ channel: 'command', command: DOCKER_INSTALL })
    expect(u.commandWindows).toContain('docker.ps1')
  })
  it('Linux with the helper: one click; without it: the install command', () => {
    dir = tempDir(); alive('systemd', '2026-11-20T04:00:00Z')
    expect(serverUpdate(check, dir, facts({ KRNL0_UPDATER: 'systemd' }, false, '/opt/krnl0/current/app/bin/krnl0.js')).channel).toBe('one-click')
    rmSync(join(dir, 'status.json'))
    expect(serverUpdate(check, dir, facts({}, false, '/opt/krnl0/current/app/bin/krnl0.js'))).toMatchObject({ channel: 'command', command: LINUX_INSTALL })
  })
  it('a Linux install inside a container (LXC, docker exec) is still one click', () => {
    dir = tempDir(); alive('systemd', '2026-11-20T04:00:00Z')
    expect(serverUpdate(check, dir, facts({ KRNL0_UPDATER: 'systemd' }, true, '/opt/krnl0/current/app/bin/krnl0.js')).channel).toBe('one-click')
  })
  it('from source: none', () => {
    dir = tempDir()
    expect(serverUpdate(check, dir, facts({}, false, '/home/me/krnl0-server/bin/krnl0.js')).channel).toBe('none')
  })
})

describe('the owner asks (F24)', () => {
  let s: TestServer | null = null
  afterEach(async () => { await s?.stop(); s = null })

  async function ready(env: Record<string, string> = {}) {
    s = await startTestServer({ KRNL0_UPDATER: 'docker', KRNL0_UPDATE_DIR: join(tempDir(), 'update'), ...env })
    await claim(s)
    return { s, auth: await browserLogin(s) }
  }
  const headers = (s: TestServer, a: { cookie: string; csrf: string }) => ({ Cookie: a.cookie, 'X-KRNL0-CSRF': a.csrf, Origin: s.origin })

  it('with the right password and a running updater, the request is made', async () => {
    const { s, auth } = await ready()
    writeStatus(s.ctx.updateDir, { updater: { kind: 'docker', version: '0.1.0', aliveAt: new Date().toISOString() }, job: { state: 'idle', step: null, from: null, to: null, message: null, at: new Date().toISOString(), auto: false } })
    const r = await s.request('POST', '/api/v1/server/update', { json: { password: PASSWORD }, headers: headers(s, auth) })
    expect(r.status).toBe(202)
    expect(hasRequest(s.ctx.updateDir)).toBe(true)
  })
  it('a wrong password is refused and nothing is requested', async () => {
    const { s, auth } = await ready()
    writeStatus(s.ctx.updateDir, { updater: { kind: 'docker', version: '0.1.0', aliveAt: new Date().toISOString() }, job: { state: 'idle', step: null, from: null, to: null, message: null, at: new Date().toISOString(), auto: false } })
    const r = await s.request('POST', '/api/v1/server/update', { json: { password: 'wrong password here' }, headers: headers(s, auth) })
    expect(r.status).toBe(401)
    expect(hasRequest(s.ctx.updateDir)).toBe(false)
  })
  it('a session alone (no password) is not enough, and no CSRF token is refused', async () => {
    const { s, auth } = await ready()
    expect((await s.request('POST', '/api/v1/server/update', { json: {}, headers: headers(s, auth) })).status).toBe(400)
    expect((await s.request('POST', '/api/v1/server/update', { json: { password: PASSWORD }, headers: { Cookie: auth.cookie, Origin: s.origin } })).status).toBe(403)
  })
  it('without an updater the answer is 409 with the command to run', async () => {
    const { s, auth } = await ready()
    const r = await s.request('POST', '/api/v1/server/update', { json: { password: PASSWORD }, headers: headers(s, auth) })
    expect(r.status).toBe(409)
    expect(JSON.stringify(r.json())).toContain('docker compose pull')
  })
  it('night updates switch on with the password, and GET /server reports it', async () => {
    const { s, auth } = await ready()
    const r = await s.request('PUT', '/api/v1/server/update/auto', { json: { on: true, password: PASSWORD }, headers: headers(s, auth) })
    expect(r.status).toBe(200)
    const g = await s.request('GET', '/api/v1/server', { headers: headers(s, auth) })
    expect((g.json().update as { auto: boolean }).auto).toBe(true)
  })
})

// ── Linux: /opt/krnl0 with versions, a fake systemd and a fake krnl0 user ────

function linuxWorld(opts: { broken?: string[]; refusesNewerData?: string[] } = {}) {
  const root = tempDir('krnl0-linux-')
  const prefix = join(root, 'opt')
  const data = join(root, 'var-lib-krnl0')
  mkdirSync(join(prefix, 'versions', '0.1.0', 'app', 'bin'), { recursive: true })
  writeFileSync(join(prefix, 'versions', '0.1.0', 'app', 'bin', 'krnl0.js'), '')
  writeFileSync(join(prefix, 'versions', '0.1.0', 'krnl0'), '#!/bin/sh')
  symlinkSync(join(prefix, 'versions', '0.1.0'), join(prefix, 'current'), 'junction')
  mkdirSync(join(data, 'update'), { recursive: true })
  let running: string | null = '0.1.0'
  let dataFormatOf = '0.1.0'
  const restores: string[] = []
  const calls: string[] = []
  const sys: Sys = {
    sleep: async () => { /* time is free here */ },
    now: () => new Date('2026-11-21T10:00:00Z'),
    health: async () => running,
    run: async (cmd, args, o) => {
      calls.push([cmd, ...args].join(' '))
      if (cmd === 'runuser') {
        const rest = args.slice(3)
        if (rest[0] === 'env') {
          const sub = rest.slice(4)
          if (sub[0] === 'backup') return { code: 0, stdout: 'Backup made: 2026-11-21_manual\n', stderr: '' }
          if (sub[0] === 'restore') { restores.push(sub[1]!); dataFormatOf = basename(String(rest[2]).split(/[\\/]versions[\\/]/)[1]?.split(/[\\/]/)[0] ?? ''); return { code: 0, stdout: '', stderr: '' } }
        }
        if (rest[0] === 'test') return { code: existsSync(rest[2]!) ? 0 : 1, stdout: '', stderr: '' }
        if (rest[1] === '-e') { writeFileSync(join(String(rest[3]), 'status.json'), o?.input ?? ''); return { code: 0, stdout: '', stderr: '' } }
        if (rest[0] === 'rm') { rmSync(rest[2]!, { force: true }); return { code: 0, stdout: '', stderr: '' } }
        if (rest[0] === 'head') return existsSync(rest[3]!) ? { code: 0, stdout: readFileSync(rest[3]!, 'utf8'), stderr: '' } : { code: 1, stdout: '', stderr: '' }
      }
      if (cmd === 'tar') {
        const dest = args[3]!
        mkdirSync(join(dest, 'app', 'bin'), { recursive: true })
        writeFileSync(join(dest, 'app', 'bin', 'krnl0.js'), '')
        writeFileSync(join(dest, 'krnl0'), '#!/bin/sh')
        writeFileSync(join(dest, 'krnl0-update.service'), '[Service]')
        return { code: 0, stdout: '', stderr: '' }
      }
      if (cmd === 'systemctl' && (args[0] === 'restart' || args[0] === 'start')) {
        const v = basename(readlinkSync(join(prefix, 'current')).replace(/[\\/]+$/, ''))
        // A newer version moves the data on as it starts, even if it then fails.
        if (v > dataFormatOf) dataFormatOf = v
        const older = (opts.refusesNewerData ?? []).includes(v) && dataFormatOf !== v
        running = (opts.broken ?? []).includes(v) || older ? null : v
        return { code: 0, stdout: '', stderr: '' }
      }
      if (cmd === 'systemctl' && args[0] === 'stop') { running = null; return { code: 0, stdout: '', stderr: '' } }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  const bundle = Buffer.from('bundle-bytes')
  const g = fakeGithub('0.2.0', { files: { 'krnl0-server-0.2.0-linux-x64.tar.gz': bundle } })
  const u = new LinuxUpdater({ prefix, data, stateDir: join(root, 'state'), cacheDir: join(root, 'cache'), unitDir: join(root, 'units'), binDir: join(root, 'bin'), arch: 'x64', healthWaitMs: 50, autoDefault: false }, sys, g.deps, '0.1.0')
  mkdirSync(join(root, 'units'), { recursive: true }); mkdirSync(join(root, 'bin'), { recursive: true })
  return { root, prefix, data, u, calls, restores, running: () => running, status: () => readStatus(join(data, 'update')) }
}

describe('Linux: one click, and the way back (F26, F27)', () => {
  const worlds: string[] = []
  afterEach(() => { for (const w of worlds.splice(0)) rmSync(w, { recursive: true, force: true }) })

  it('a request updates 0.1.0 to 0.2.0 after a backup', async () => {
    const w = linuxWorld(); worlds.push(w.root)
    requestUpdate(join(w.data, 'update'))
    await w.u.run()
    expect(w.running()).toBe('0.2.0')
    expect(w.status()?.job).toMatchObject({ state: 'done', from: '0.1.0', to: '0.2.0' })
    expect(existsSync(join(w.data, 'update', 'request'))).toBe(false)
    expect(w.calls.some((c) => c.includes(' backup'))).toBe(true)
    expect(w.calls.findIndex((c) => c.includes(' backup'))).toBeLessThan(w.calls.findIndex((c) => c.startsWith('systemctl restart')))
  })
  it('without a request and with night updates off, nothing happens', async () => {
    const w = linuxWorld(); worlds.push(w.root)
    await w.u.run()
    expect(w.running()).toBe('0.1.0')
    expect(w.status()?.updater.kind).toBe('systemd')
  })
  it('a new version that does not answer: back on 0.1.0 by itself', async () => {
    const w = linuxWorld({ broken: ['0.2.0'] }); worlds.push(w.root)
    requestUpdate(join(w.data, 'update'))
    await w.u.run()
    expect(w.running()).toBe('0.1.0')
    expect(w.status()?.job.state).toBe('rolled-back')
    expect(w.status()?.job.message).toMatch(/Nothing was lost/)
  })
  it('when 0.1.0 refuses the data 0.2.0 already moved on, the backup is restored first', async () => {
    const w = linuxWorld({ broken: ['0.2.0'], refusesNewerData: ['0.1.0'] }); worlds.push(w.root)
    requestUpdate(join(w.data, 'update'))
    await w.u.run()
    expect(w.restores).toEqual(['2026-11-21_manual'])
    expect(w.running()).toBe('0.1.0')
    expect(w.status()?.job.state).toBe('rolled-back')
  })
})

// ── Docker: a fake Engine API with containers, images and exec ───────────────

function dockerWorld(opts: { newBroken?: boolean } = {}) {
  const dir = tempDir('krnl0-docker-')
  type C = { Id: string; Name: string; Image: string; Labels: Record<string, string>; running: boolean; version: string }
  const containers = new Map<string, C>()
  let n = 0
  const add = (name: string, role: string, version: string, image: string): C => { const c = { Id: `id${++n}`, Name: `/${name}`, Image: image, Labels: { 'krnl0.role': role, 'com.docker.compose.project': 'krnl0' }, running: true, version }; containers.set(c.Id, c); return c }
  add('krnl0', 'server', '0.1.0', 'img-old')
  add('krnl0-updater', 'updater', '0.1.0', 'img-old')
  const execs = new Map<string, { id: string; cmd: string[] }>()
  const pulled: string[] = []
  const reply = (status: number, body: unknown = '') => ({ status, body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) })
  const api: DockerApi = {
    call: async (method, path, body) => {
      const p = decodeURIComponent(path)
      if (method === 'GET' && p.startsWith('/containers/json')) {
        const role = /krnl0\.role=(\w+)/.exec(p)?.[1]
        return reply(200, [...containers.values()].filter((c) => c.Labels['krnl0.role'] === role).map((c) => ({ Id: c.Id, Names: [c.Name] })))
      }
      let m = /^\/containers\/([^/]+)\/json$/.exec(p)
      if (m && method === 'GET') {
        const c = containers.get(m[1]!)
        if (!c) return reply(404)
        return reply(200, { Id: c.Id, Name: c.Name, Image: c.Image, Config: { Image: 'ghcr.io/theminddeveloper/krnl0-server:latest', Labels: c.Labels, Env: ['A=1'] }, HostConfig: { Mounts: [] }, NetworkSettings: { Networks: { krnl0_default: { Aliases: ['krnl0'] } } }, State: { Running: c.running, Health: { Status: c.running ? 'healthy' : 'starting' } } })
      }
      m = /^\/containers\/([^/]+)\/exec$/.exec(p)
      if (m) { const id = `ex${++n}`; execs.set(id, { id: m[1]!, cmd: (body as { Cmd: string[] }).Cmd }); return reply(201, { Id: id }) }
      m = /^\/exec\/([^/]+)\/start$/.exec(p)
      if (m) {
        const e = execs.get(m[1]!)!; const c = containers.get(e.id)!
        if (e.cmd[1] === 'version') return reply(200, c.running ? `krnl0-server ${c.version} (protocol 1)\n` : '')
        if (e.cmd[1] === 'backup') return reply(200, 'Backup made: 2026-11-21_manual\n')
        return reply(200)
      }
      m = /^\/exec\/([^/]+)\/json$/.exec(p)
      if (m) return reply(200, { ExitCode: 0 })
      if (p.startsWith('/images/create')) { pulled.push(p); return reply(200, '{"status":"Downloaded"}') }
      m = /^\/images\/(.+)\/json$/.exec(p)
      if (m) return reply(200, { Id: 'img-new', RepoDigests: [`ghcr.io/theminddeveloper/krnl0-server@${DIGEST}`], Config: { Env: [], Labels: {} } })
      if (/^\/images\/.+\/tag/.test(p)) return reply(201)
      m = /^\/containers\/([^/]+)\/(stop|start|rename|wait)/.exec(p)
      if (m) {
        const c = containers.get(m[1]!)
        if (!c) return reply(404, { message: 'no such container' })
        if (m[2] === 'stop') c.running = false
        if (m[2] === 'start') c.running = !(opts.newBroken && c.version === '0.2.0')
        if (m[2] === 'rename') c.Name = `/${/name=([^&]+)/.exec(p)![1]}`
        if (m[2] === 'wait') return reply(200, { StatusCode: 0 })
        return reply(204)
      }
      if (p.startsWith('/containers/create')) {
        const name = /name=([^&]+)/.exec(p)?.[1] ?? `tmp${n}`
        const b = body as { Labels?: Record<string, string>; Cmd?: string[] }
        const c = add(name, b.Labels?.['krnl0.role'] ?? 'oneoff', '0.2.0', 'img-new')
        c.running = false
        return reply(201, { Id: c.Id })
      }
      m = /^\/containers\/([^/?]+)\?force=1$/.exec(p)
      if (m && method === 'DELETE') { containers.delete(m[1]!); return reply(204) }
      return reply(404, { message: `unhandled ${method} ${p}` })
    },
  }
  const g = fakeGithub('0.2.0')
  const u = new DockerUpdater(api, { updateDir: dir, healthWaitMs: 30, autoDefault: false, checkOn: true, now: () => new Date('2026-11-21T10:00:00Z'), sleep: async () => { /* free */ } }, g.deps, '0.1.0')
  const byName = (name: string) => [...containers.values()].find((c) => c.Name === `/${name}`)
  return { dir, u, containers, byName, pulled, add }
}

describe('Docker: one click, and the way back (F29)', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

  it('a request pulls the signed digest, swaps the container, and updates the updater last', async () => {
    const w = dockerWorld(); dirs.push(w.dir)
    requestUpdate(w.dir)
    await w.u.tick()
    expect(w.pulled[0]).toContain(`tag=${DIGEST}`)
    expect(w.byName('krnl0')?.version).toBe('0.2.0')
    expect(w.byName('krnl0')?.running).toBe(true)
    expect(w.byName('krnl0-old')).toBeUndefined()
    expect(w.byName('krnl0-updater')?.version).toBe('0.2.0')
    expect(readStatus(w.dir)?.job).toMatchObject({ state: 'done', from: '0.1.0', to: '0.2.0' })
  })
  it('a new container that does not get healthy: the old one is back under its name', async () => {
    const w = dockerWorld({ newBroken: true }); dirs.push(w.dir)
    requestUpdate(w.dir)
    await w.u.tick()
    expect(w.byName('krnl0')?.version).toBe('0.1.0')
    expect(w.byName('krnl0')?.running).toBe(true)
    expect(readStatus(w.dir)?.job.state).toBe('rolled-back')
  })
  it('a crash halfway (krnl0-old, no krnl0) is repaired on the next start', async () => {
    const w = dockerWorld(); dirs.push(w.dir)
    const old = w.byName('krnl0')!
    old.Name = '/krnl0-old'; old.running = false
    await w.u.tick()
    expect(w.byName('krnl0')?.Id).toBe(old.Id)
    expect(w.byName('krnl0')?.running).toBe(true)
  })
  it('nothing happens without a request when night updates are off', async () => {
    const w = dockerWorld(); dirs.push(w.dir)
    await w.u.tick()
    expect(w.pulled).toEqual([])
    expect(readStatus(w.dir)?.updater.kind).toBe('docker')
  })
})
