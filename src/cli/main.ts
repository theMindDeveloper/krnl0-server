// The `krnl0` command (F17). Every server function has a command here
// (AGENTS.md rule 8).

import { cpSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { configFileSchema, loadConfig, readConfigFile, TLS_MODES, writeConfigFile, type ConfigFile, type TlsMode } from '../config.js'
import { dataPaths, defaultDataDir, type DataPaths } from '../paths.js'
import { ensureDir } from '../fsutil.js'
import { AuthStore } from '../auth/store.js'
import { passwordProblem } from '../auth/password.js'
import { otpauthUri } from '../auth/totp.js'
import { listBackups, makeBackup, pruneBackups, restoreBackup } from '../store/backup.js'
import { fingerprintOf } from '../tls/selfsigned.js'
import { UpdateChecker } from '../update/check.js'
import { addressesOf, runningPid, startServer } from '../server.js'
import { PROTOCOL, VERSION } from '../version.js'
import { ask, askChoice, askHidden, askYesNo, interactive, readStdin } from './prompt.js'
import { formatChecks, runDoctor } from './doctor.js'
import { helpTopic, TOPIC_NAMES } from './help.js'

interface Parsed { args: string[]; flags: Map<string, string | true> }

export function parseArgs(argv: string[]): Parsed {
  const args: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1))
      else {
        const next = argv[i + 1]
        const boolFlags = new Set(['password-stdin', 'all', 'yes', 'help', 'json'])
        if (!boolFlags.has(a.slice(2)) && next !== undefined && !next.startsWith('--')) { flags.set(a.slice(2), next); i++ }
        else flags.set(a.slice(2), true)
      }
    } else args.push(a)
  }
  return { args, flags }
}

const say = (s = ''): void => { process.stdout.write(s + '\n') }

function flagStr(p: Parsed, name: string): string | undefined {
  const v = p.flags.get(name)
  return typeof v === 'string' ? v : undefined
}

const onOff = (v: string): boolean => {
  const s = v.trim().toLowerCase()
  if (['on', 'true', 'yes', '1'].includes(s)) return true
  if (['off', 'false', 'no', '0'].includes(s)) return false
  throw new Error(`Expected on or off, got "${v}".`)
}

/** Settings keys for `config get/set` and how to read a value for each. */
const KEYS: Record<string, { read: (v: string) => unknown; path: string[] }> = {
  website: { read: onOff, path: ['website'] },
  appSync: { read: onOff, path: ['appSync'] },
  port: { read: (v) => Number(v), path: ['port'] },
  httpPort: { read: (v) => (v === 'off' ? null : Number(v)), path: ['httpPort'] },
  bind: { read: (v) => v, path: ['bind'] },
  'tls.mode': { read: (v) => v, path: ['tls', 'mode'] },
  'tls.certFile': { read: (v) => resolve(v), path: ['tls', 'certFile'] },
  'tls.keyFile': { read: (v) => resolve(v), path: ['tls', 'keyFile'] },
  hosts: { read: (v) => v.split(',').map((s) => s.trim()).filter(Boolean), path: ['hosts'] },
  trustProxy: { read: onOff, path: ['trustProxy'] },
  timeZone: { read: (v) => v, path: ['timeZone'] },
  updateCheck: { read: onOff, path: ['updateCheck'] },
  webDir: { read: (v) => resolve(v), path: ['webDir'] },
  backupsKept: { read: (v) => Number(v), path: ['backupsKept'] },
}

function setKey(file: ConfigFile, key: string, value: unknown | undefined): ConfigFile {
  const spec = KEYS[key]
  if (!spec) throw new Error(`Unknown setting "${key}". Settings: ${Object.keys(KEYS).join(', ')}`)
  const next = structuredClone(file) as Record<string, unknown>
  const [top, sub] = spec.path
  if (!top) return file
  if (sub) {
    const inner = { ...((next[top] as Record<string, unknown> | undefined) ?? {}) }
    if (value === undefined) delete inner[sub]
    else inner[sub] = value
    next[top] = inner
  } else if (value === undefined) delete next[top]
  else next[top] = value
  return configFileSchema.parse(next)
}

function restartNote(paths: DataPaths): void {
  if (runningPid(paths) !== null) say('Restart the server to apply this (Docker: docker compose restart; Linux: systemctl restart krnl0).')
}

async function newPassword(p: Parsed): Promise<string> {
  if (p.flags.has('password-stdin')) {
    const pw = await readStdin()
    const problem = passwordProblem(pw)
    if (problem) throw new Error(problem)
    return pw
  }
  if (!interactive()) throw new Error('No terminal to ask for a password. Use --password-stdin.')
  for (;;) {
    const a = await askHidden('New password (at least 12 characters)')
    const problem = passwordProblem(a)
    if (problem) { say(problem); continue }
    const b = await askHidden('Repeat it')
    if (a !== b) { say('The two are not the same. Again.'); continue }
    return a
  }
}

async function cmdSetup(paths: DataPaths, p: Parsed): Promise<number> {
  let file = readConfigFile(paths.config)
  const ask$ = interactive() && !p.flags.has('yes')
  const cur = loadConfig(paths.config)

  say('KRNL0 server setup')
  say('')
  let website = flagStr(p, 'website') !== undefined ? onOff(flagStr(p, 'website') ?? '') : cur.website
  let appSync = flagStr(p, 'app-sync') !== undefined ? onOff(flagStr(p, 'app-sync') ?? '') : cur.appSync
  if (ask$ && flagStr(p, 'website') === undefined && flagStr(p, 'app-sync') === undefined) {
    say('What should this server do? You can change this later.')
    website = await askYesNo('  Website — open KRNL0 in any browser, also on your phone', cur.website)
    appSync = await askYesNo('  App sync — keep the KRNL0 desktop app in sync across computers', cur.appSync)
    if (!website && !appSync) { say('At least one has to be on. Turning on both.'); website = true; appSync = true }
  }
  file = setKey(file, 'website', website)
  file = setKey(file, 'appSync', appSync)

  let mode = (flagStr(p, 'tls') as TlsMode | undefined) ?? cur.tls.mode
  if (!TLS_MODES.includes(mode)) throw new Error(`--tls is one of: ${TLS_MODES.join(', ')}`)
  if (ask$ && flagStr(p, 'tls') === undefined) {
    say('')
    say('Encryption: every connection is encrypted. Choose how browsers trust it (krnl0 help certificates):')
    mode = await askChoice('', [
      { value: 'self-signed', label: 'Nothing to set up — the app needs nothing; browsers warn once per device' },
      { value: 'files', label: 'My own certificate files (Tailscale "tailscale cert", certbot)' },
      { value: 'proxy', label: 'My reverse proxy does HTTPS (Caddy, Traefik, Nginx Proxy Manager)' },
    ], mode)
  }
  file = setKey(file, 'tls.mode', mode)
  if (mode === 'files') {
    const cert = flagStr(p, 'cert') ?? (ask$ ? await ask('Certificate file (full chain)', cur.tls.certFile ?? '') : cur.tls.certFile ?? '')
    const key = flagStr(p, 'key') ?? (ask$ ? await ask('Private key file', cur.tls.keyFile ?? '') : cur.tls.keyFile ?? '')
    if (!cert || !key) throw new Error('Files mode needs --cert and --key.')
    file = setKey(file, 'tls.certFile', resolve(cert))
    file = setKey(file, 'tls.keyFile', resolve(key))
  }
  if (mode === 'proxy') {
    file = setKey(file, 'trustProxy', true)
    file = setKey(file, 'httpPort', null)
  }

  const hostsFlag = flagStr(p, 'hosts')
  if (hostsFlag !== undefined) file = setKey(file, 'hosts', KEYS.hosts?.read(hostsFlag))
  else if (ask$ && mode === 'self-signed') {
    const h = await ask('\nExtra addresses you open KRNL0 by, comma-separated (e.g. 192.168.1.20, nas.local); empty for none', cur.hosts.join(', '))
    file = setKey(file, 'hosts', KEYS.hosts?.read(h))
  }

  const tz = flagStr(p, 'tz') ?? (ask$ ? await ask('\nTime zone (days start at your midnight)', cur.timeZone) : undefined)
  if (tz) {
    try { new Intl.DateTimeFormat('en', { timeZone: tz }) } catch { throw new Error(`Unknown time zone "${tz}". Use a name like Europe/Berlin.`) }
    file = setKey(file, 'timeZone', tz)
  }

  ensureDir(paths.root)
  writeConfigFile(paths.config, file)

  const auth = new AuthStore(paths)
  let setPw = !auth.hasOwner() || p.flags.has('password-stdin')
  if (auth.hasOwner() && ask$ && !p.flags.has('password-stdin')) setPw = !(await askYesNo('\nKeep the current password?', true))
  if (setPw) {
    say('')
    await auth.setPassword(await newPassword(p))
    say('Password saved.')
  }

  const cfg = loadConfig(paths.config)
  say('')
  say('Done.')
  say(`  Website: ${cfg.website ? 'on' : 'off'}   App sync: ${cfg.appSync ? 'on' : 'off'}   Encryption: ${cfg.tls.mode}`)
  for (const a of addressesOf(cfg, cfg.port).slice(0, 4)) say(`  ${a}`)
  if (!auth.totpEnabled()) say('  Recommended next: krnl0 2fa enable')
  restartNote(paths)
  return 0
}

async function cmdStatus(paths: DataPaths, p: Parsed): Promise<number> {
  const cfg = loadConfig(paths.config)
  const auth = new AuthStore(paths)
  const pid = runningPid(paths)
  const upd = new UpdateChecker(paths, cfg.updateCheck).info()
  const caFile = join(paths.tls, 'ca.crt')
  const fp = cfg.tls.mode === 'self-signed' && existsSync(caFile) ? fingerprintOf(readFileSync(caFile, 'utf8')) : null
  const last = listBackups(paths).at(-1)
  const status = {
    version: VERSION,
    protocol: PROTOCOL,
    running: pid !== null,
    pid,
    website: cfg.website,
    appSync: cfg.appSync,
    encryption: cfg.tls.mode,
    addresses: addressesOf(cfg, cfg.port),
    fingerprint: fp,
    owner: auth.hasOwner(),
    twoFactor: auth.totpEnabled(),
    devices: auth.listDevices().length,
    sessions: auth.listSessions().length,
    lastBackup: last?.createdAt ?? null,
    update: upd,
    data: paths.root,
  }
  if (p.flags.has('json')) { say(JSON.stringify(status, null, 2)); return 0 }
  say(`KRNL0 server ${VERSION} — ${pid !== null ? `running (pid ${pid})` : 'not running'}`)
  say(`  Website: ${cfg.website ? 'on' : 'off'}   App sync: ${cfg.appSync ? 'on' : 'off'}   Encryption: ${cfg.tls.mode}`)
  for (const [i, a] of status.addresses.slice(0, 4).entries()) say(`  ${i === 0 ? 'Open' : '    '}  ${a}`)
  if (fp) say(`  Fingerprint  ${fp}`)
  say(`  Owner: ${status.owner ? 'set' : 'not yet (krnl0 setup)'}   2FA: ${status.twoFactor ? 'on' : 'off'}   Devices: ${status.devices}   Browsers: ${status.sessions}`)
  say(`  Last backup: ${status.lastBackup ?? 'none yet'}`)
  if (upd.available) say(`  Update: ${upd.latest ?? ''} is out — krnl0 help updates`)
  say(`  Data: ${paths.root}`)
  return 0
}

async function cmdConfig(paths: DataPaths, p: Parsed): Promise<number> {
  const [, sub, key, ...rest] = p.args
  if (!sub || sub === 'get') {
    const cfg = loadConfig(paths.config)
    const flat: Record<string, unknown> = {
      website: cfg.website, appSync: cfg.appSync, port: cfg.port, httpPort: cfg.httpPort ?? 'off', bind: cfg.bind,
      'tls.mode': cfg.tls.mode, 'tls.certFile': cfg.tls.certFile, 'tls.keyFile': cfg.tls.keyFile,
      hosts: cfg.hosts.join(','), trustProxy: cfg.trustProxy, timeZone: cfg.timeZone, updateCheck: cfg.updateCheck,
      webDir: cfg.webDir, backupsKept: cfg.backupsKept,
    }
    if (key) {
      if (!(key in flat)) throw new Error(`Unknown setting "${key}".`)
      say(String(flat[key] ?? ''))
      return 0
    }
    for (const [k, v] of Object.entries(flat)) say(`${k.padEnd(14)} ${v === null ? '' : String(v)}`)
    say('\nEnvironment variables (KRNL0_*) override these. See: krnl0 help docker')
    return 0
  }
  if (sub === 'set') {
    if (!key || rest.length === 0) throw new Error('Usage: krnl0 config set <key> <value>')
    const spec = KEYS[key]
    if (!spec) throw new Error(`Unknown setting "${key}". Settings: ${Object.keys(KEYS).join(', ')}`)
    writeConfigFile(paths.config, setKey(readConfigFile(paths.config), key, spec.read(rest.join(' '))))
    say(`${key} saved.`)
    restartNote(paths)
    return 0
  }
  if (sub === 'unset') {
    if (!key) throw new Error('Usage: krnl0 config unset <key>')
    writeConfigFile(paths.config, setKey(readConfigFile(paths.config), key, undefined))
    say(`${key} is back to its default.`)
    restartNote(paths)
    return 0
  }
  throw new Error('Usage: krnl0 config get|set|unset')
}

async function cmd2fa(paths: DataPaths, p: Parsed): Promise<number> {
  const auth = new AuthStore(paths)
  const sub = p.args[1] ?? 'status'
  if (sub === 'status') {
    say(auth.totpEnabled() ? `Two-factor codes are on (${auth.recoveryCodesLeft()} recovery codes left).` : 'Two-factor codes are off. Turn on: krnl0 2fa enable')
    return 0
  }
  if (sub === 'disable') {
    say(auth.disableTotp() ? 'Two-factor codes are off.' : 'They were already off.')
    return 0
  }
  if (sub === 'enable') {
    if (auth.totpEnabled()) { say('Two-factor codes are already on. To renew: krnl0 2fa disable, then enable.'); return 0 }
    if (!interactive()) throw new Error('Run this in a terminal: it asks for a code from your app.')
    const secret = auth.beginTotp()
    say('Add KRNL0 to your authenticator app (Aegis, 2FAS, Google Authenticator, 1Password, ...):')
    say('')
    say(`  Key:  ${secret.replace(/(.{4})/g, '$1 ').trim()}`)
    say(`  Or this link in an app that takes otpauth links:`)
    say(`  ${otpauthUri(secret, 'owner')}`)
    say('')
    for (let i = 0; i < 3; i++) {
      const code = await ask('Code the app shows now')
      const recovery = auth.confirmTotp(code)
      if (recovery) {
        say('')
        say('Two-factor codes are on. Save these recovery codes somewhere safe; each works once if you lose the app:')
        say('')
        for (const c of recovery) say(`  ${c}`)
        say('')
        return 0
      }
      say('That code does not match. Check the phone\'s clock and try again.')
    }
    throw new Error('Two-factor codes were not turned on.')
  }
  throw new Error('Usage: krnl0 2fa enable|disable|status')
}

const ago = (ms: number): string => {
  const m = Math.floor((Date.now() - ms) / 60_000)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} days ago`
}

async function cmdDevices(paths: DataPaths, p: Parsed): Promise<number> {
  const auth = new AuthStore(paths)
  const sub = p.args[1] ?? 'list'
  if (sub === 'list') {
    const list = auth.listDevices()
    if (list.length === 0) { say('No paired devices.'); return 0 }
    for (const d of list) say(`${d.id}  ${d.name.padEnd(24)} ${d.platform.padEnd(10)} last seen ${ago(d.lastSeenAt)}`)
    return 0
  }
  if (sub === 'revoke') {
    if (p.flags.has('all')) { say(`${auth.revokeAllDevices()} device(s) can no longer sync.`); return 0 }
    const id = p.args[2]
    if (!id) throw new Error('Usage: krnl0 devices revoke <id> | --all')
    if (!auth.revokeDevice(id)) throw new Error(`No device ${id}. See: krnl0 devices`)
    say(`Device ${id} can no longer sync.`)
    return 0
  }
  throw new Error('Usage: krnl0 devices [list] | revoke <id|--all>')
}

async function cmdSessions(paths: DataPaths, p: Parsed): Promise<number> {
  const auth = new AuthStore(paths)
  const sub = p.args[1] ?? 'list'
  if (sub === 'list') {
    const list = auth.listSessions()
    if (list.length === 0) { say('No browser is logged in.'); return 0 }
    for (const s of list) say(`${s.id}  ${s.ip.padEnd(16)} last seen ${ago(s.lastSeenAt).padEnd(12)} ${s.agent.slice(0, 50)}`)
    return 0
  }
  if (sub === 'revoke') {
    if (p.flags.has('all')) { say(`${auth.revokeAllSessions()} browser(s) logged out.`); return 0 }
    const id = p.args[2]
    if (!id) throw new Error('Usage: krnl0 sessions revoke <id> | --all')
    if (!auth.revokeSession(id)) throw new Error(`No session ${id}. See: krnl0 sessions`)
    say(`Session ${id} logged out.`)
    return 0
  }
  throw new Error('Usage: krnl0 sessions [list] | revoke <id|--all>')
}

export async function main(argv: string[]): Promise<number> {
  const p = parseArgs(argv)
  const cmd = p.args[0] ?? (p.flags.has('help') ? 'help' : 'help')
  const dataFlag = flagStr(p, 'data')
  const paths = dataPaths(dataFlag ? resolve(dataFlag) : defaultDataDir())

  try {
    switch (cmd) {
      case 'start': {
        const server = await startServer({ dataDir: paths.root })
        let stopping = false
        const stop = (): void => {
          if (stopping) return
          stopping = true
          server.close().then(() => process.exit(0), () => process.exit(1))
        }
        process.on('SIGINT', stop)
        process.on('SIGTERM', stop)
        await new Promise<never>(() => { /* runs until a signal */ })
        return 0
      }
      case 'setup': return await cmdSetup(paths, p)
      case 'status': return await cmdStatus(paths, p)
      case 'doctor': {
        const checks = await runDoctor(paths)
        say(formatChecks(checks))
        return checks.some((c) => c.status === 'fail') ? 1 : 0
      }
      case 'config': return await cmdConfig(paths, p)
      case 'fingerprint': {
        const caFile = join(paths.tls, 'ca.crt')
        if (!existsSync(caFile)) throw new Error('No server certificate yet (it is made on the first start), or this server uses its own certificate files.')
        say(fingerprintOf(readFileSync(caFile, 'utf8')))
        return 0
      }
      case 'reset-password': {
        const auth = new AuthStore(paths)
        await auth.setPassword(await newPassword(p))
        say('Password saved. Every browser has to log in again.')
        return 0
      }
      case '2fa': return await cmd2fa(paths, p)
      case 'devices': return await cmdDevices(paths, p)
      case 'sessions': return await cmdSessions(paths, p)
      case 'backup': {
        const b = makeBackup(paths, 'manual')
        const cfg = loadConfig(paths.config)
        pruneBackups(paths, cfg.backupsKept)
        say(`Backup made: ${b.name}`)
        return 0
      }
      case 'backups': {
        const list = listBackups(paths)
        if (list.length === 0) { say('No backups yet. Make one: krnl0 backup'); return 0 }
        for (const b of list) say(`${b.name}  (server ${b.serverVersion})`)
        return 0
      }
      case 'restore': {
        const name = p.args[1]
        if (!name) throw new Error('Usage: krnl0 restore <name>   (see: krnl0 backups)')
        const pid = runningPid(paths)
        if (pid !== null) throw new Error(`Stop the server first (pid ${pid}). Docker: docker compose stop, then docker compose run --rm krnl0 restore ${name}`)
        if (interactive() && !p.flags.has('yes') && !(await askYesNo(`Replace the current data with backup ${name}? (The current data is backed up first.)`, false))) return 1
        const before = restoreBackup(paths, name)
        say(`Restored ${name}. Your previous data is in backup ${before.name}.`)
        return 0
      }
      case 'export': {
        const dest = p.args[1]
        if (!dest) throw new Error('Usage: krnl0 export <folder>')
        const target = join(resolve(dest), `krnl0-export-${new Date().toISOString().slice(0, 10)}`)
        if (existsSync(target)) throw new Error(`${target} already exists.`)
        ensureDir(target, 0o700)
        for (const part of ['docs', 'timelog', 'assets'] as const) {
          if (existsSync(paths[part])) cpSync(paths[part], join(target, part), { recursive: true })
        }
        say(`Your data is in ${target}`)
        return 0
      }
      case 'version': say(`krnl0-server ${VERSION} (protocol ${PROTOCOL})`); return 0
      case 'help': {
        const text = helpTopic(p.args[1])
        if (text === null) throw new Error(`No help for "${p.args[1] ?? ''}". Topics: ${TOPIC_NAMES.join(', ')}`)
        say(text)
        return 0
      }
      default:
        throw new Error(`Unknown command "${cmd}". See: krnl0 help`)
    }
  } catch (err) {
    process.stderr.write(`krnl0: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}
