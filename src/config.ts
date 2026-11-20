// Settings: defaults < <data>/config.json < KRNL0_* environment (F1, F7, F19).

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { readJson, writeJsonAtomic } from './fsutil.js'

export const TLS_MODES = ['self-signed', 'files', 'proxy'] as const
export type TlsMode = (typeof TLS_MODES)[number]

const portSchema = z.number().int().min(1).max(65535)

/** What config.json may hold. Every field is optional; missing ones take the default. */
export const configFileSchema = z.object({
  website: z.boolean().optional(),
  appSync: z.boolean().optional(),
  port: portSchema.optional(),
  httpPort: portSchema.nullable().optional(),
  bind: z.string().min(1).max(100).optional(),
  tls: z.object({
    mode: z.enum(TLS_MODES).optional(),
    certFile: z.string().max(1000).optional(),
    keyFile: z.string().max(1000).optional(),
  }).strict().optional(),
  hosts: z.array(z.string().min(1).max(253)).max(50).optional(),
  trustProxy: z.boolean().optional(),
  timeZone: z.string().min(1).max(64).optional(),
  updateCheck: z.boolean().optional(),
  webDir: z.string().max(1000).nullable().optional(),
  backupsKept: z.number().int().min(1).max(365).optional(),
}).strict()

export type ConfigFile = z.infer<typeof configFileSchema>

export interface Config {
  website: boolean
  appSync: boolean
  port: number
  /** Plain-HTTP port that only redirects to HTTPS; null = off. */
  httpPort: number | null
  bind: string
  tls: {
    mode: TlsMode
    certFile: string | null
    keyFile: string | null
  }
  /** Extra names and IPs the self-signed certificate covers (e.g. the host's LAN IP in Docker). */
  hosts: string[]
  /** Take the client IP and scheme from X-Forwarded-* (default on in proxy mode). */
  trustProxy: boolean
  timeZone: string
  updateCheck: boolean
  /** Folder with the KRNL0 web build (index.html). */
  webDir: string | null
  backupsKept: number
}

function systemTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

/** The web build shipped next to the server (image: /app/web, bundle: <install>/web). */
function bundledWebDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  const dir = resolve(here, '..', 'web')
  return existsSync(join(dir, 'index.html')) ? dir : null
}

const onOff = (v: string | undefined): boolean | undefined => {
  if (v === undefined || v === '') return undefined
  const s = v.trim().toLowerCase()
  if (['1', 'on', 'true', 'yes'].includes(s)) return true
  if (['0', 'off', 'false', 'no'].includes(s)) return false
  throw new Error(`Expected on/off, got "${v}"`)
}

const num = (v: string | undefined, name: string): number | undefined => {
  if (v === undefined || v === '') return undefined
  const n = Number(v)
  if (!Number.isInteger(n)) throw new Error(`${name} must be a whole number`)
  return n
}

/** Environment overrides as a partial config file (validated by the same schema). */
export function envOverrides(env: NodeJS.ProcessEnv): ConfigFile {
  const tls: NonNullable<ConfigFile['tls']> = {}
  if (env.KRNL0_TLS) tls.mode = env.KRNL0_TLS as TlsMode
  if (env.KRNL0_CERT_FILE) tls.certFile = env.KRNL0_CERT_FILE
  if (env.KRNL0_KEY_FILE) tls.keyFile = env.KRNL0_KEY_FILE

  const out: ConfigFile = {}
  const website = onOff(env.KRNL0_WEBSITE)
  if (website !== undefined) out.website = website
  const appSync = onOff(env.KRNL0_APP_SYNC)
  if (appSync !== undefined) out.appSync = appSync
  const port = num(env.KRNL0_PORT, 'KRNL0_PORT')
  if (port !== undefined) out.port = port
  if (env.KRNL0_HTTP_PORT !== undefined && env.KRNL0_HTTP_PORT !== '') {
    out.httpPort = env.KRNL0_HTTP_PORT.trim().toLowerCase() === 'off' ? null : num(env.KRNL0_HTTP_PORT, 'KRNL0_HTTP_PORT') ?? null
  }
  if (env.KRNL0_BIND) out.bind = env.KRNL0_BIND
  if (Object.keys(tls).length > 0) out.tls = tls
  if (env.KRNL0_HOSTS) out.hosts = env.KRNL0_HOSTS.split(',').map((h) => h.trim()).filter(Boolean)
  const trustProxy = onOff(env.KRNL0_TRUST_PROXY)
  if (trustProxy !== undefined) out.trustProxy = trustProxy
  if (env.TZ) out.timeZone = env.TZ
  const updateCheck = onOff(env.KRNL0_UPDATE_CHECK)
  if (updateCheck !== undefined) out.updateCheck = updateCheck
  if (env.KRNL0_WEB_DIR) out.webDir = env.KRNL0_WEB_DIR
  const kept = num(env.KRNL0_BACKUPS_KEPT, 'KRNL0_BACKUPS_KEPT')
  if (kept !== undefined) out.backupsKept = kept
  return configFileSchema.parse(out)
}

export function readConfigFile(path: string): ConfigFile {
  return readJson(path, configFileSchema, {})
}

export function writeConfigFile(path: string, file: ConfigFile): void {
  writeJsonAtomic(path, configFileSchema.parse(file))
}

export function resolveConfig(file: ConfigFile, env: ConfigFile = {}): Config {
  const tlsFile = { ...file.tls, ...env.tls }
  const mode: TlsMode = tlsFile.mode ?? 'self-signed'
  const cfg: Config = {
    website: env.website ?? file.website ?? true,
    appSync: env.appSync ?? file.appSync ?? true,
    port: env.port ?? file.port ?? 8443,
    httpPort: env.httpPort !== undefined ? env.httpPort : file.httpPort !== undefined ? file.httpPort : null,
    bind: env.bind ?? file.bind ?? (mode === 'proxy' ? '127.0.0.1' : '0.0.0.0'),
    tls: {
      mode,
      certFile: tlsFile.certFile ?? null,
      keyFile: tlsFile.keyFile ?? null,
    },
    hosts: env.hosts ?? file.hosts ?? [],
    trustProxy: env.trustProxy ?? file.trustProxy ?? mode === 'proxy',
    timeZone: env.timeZone ?? file.timeZone ?? systemTimeZone(),
    updateCheck: env.updateCheck ?? file.updateCheck ?? true,
    webDir: env.webDir !== undefined ? env.webDir : file.webDir !== undefined ? file.webDir : bundledWebDir(),
    backupsKept: env.backupsKept ?? file.backupsKept ?? 14,
  }
  return cfg
}

/** Problems that stop the server from starting, in plain words. */
export function configProblems(cfg: Config): string[] {
  const out: string[] = []
  if (!cfg.website && !cfg.appSync) out.push('Website and App sync are both off. Turn on at least one: krnl0 config set website on')
  if (cfg.tls.mode === 'files' && (!cfg.tls.certFile || !cfg.tls.keyFile)) {
    out.push('TLS mode "files" needs a certificate and a key: krnl0 config set tls.certFile /path/cert.pem and tls.keyFile /path/key.pem')
  }
  if (cfg.httpPort !== null && cfg.httpPort === cfg.port) out.push('The HTTP port and the HTTPS port must differ.')
  if (cfg.tls.mode === 'proxy' && cfg.httpPort !== null) out.push('In proxy mode your proxy handles HTTP; turn the redirect port off: krnl0 config set httpPort off')
  try { new Intl.DateTimeFormat('en', { timeZone: cfg.timeZone }) } catch { out.push(`Unknown time zone "${cfg.timeZone}" (use a name like Europe/Berlin).`) }
  return out
}

export function loadConfig(configPath: string, env: NodeJS.ProcessEnv = process.env): Config {
  return resolveConfig(readConfigFile(configPath), envOverrides(env))
}
