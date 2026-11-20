// The small files the server and its updater share (Decision S12):
//
//   <update>/request         the owner asked for an update (the server makes it; its content is ignored)
//   <update>/settings.json   { auto } — update by itself at night (the server writes it)
//   <update>/status.json     the updater's state and the last job (the updater writes it)
//
// <update> is KRNL0_UPDATE_DIR (Docker: the krnl0-update volume at /update) or
// <data>/update (Linux install). The updater reads from here only WHETHER to
// act, never what to install (NF11).

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { writeJsonAtomic } from '../fsutil.js'

export function updateDir(dataRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.KRNL0_UPDATE_DIR ? resolve(env.KRNL0_UPDATE_DIR) : join(dataRoot, 'update')
}

export const STEPS = ['backup', 'download', 'verify', 'switch', 'health', 'rollback', 'restore'] as const
export type Step = (typeof STEPS)[number]

export const jobSchema = z.object({
  state: z.enum(['idle', 'running', 'done', 'failed', 'rolled-back']),
  step: z.enum(STEPS).nullable().default(null),
  from: z.string().nullable().default(null),
  to: z.string().nullable().default(null),
  message: z.string().nullable().default(null),
  at: z.string(),
  auto: z.boolean().default(false),
})
export type Job = z.infer<typeof jobSchema>

export const statusSchema = z.object({
  updater: z.object({
    kind: z.enum(['docker', 'systemd']),
    version: z.string(),
    aliveAt: z.string(),
  }),
  job: jobSchema,
})
export type UpdaterStatus = z.infer<typeof statusSchema>

const settingsSchema = z.object({ auto: z.boolean() })

export function readStatus(dir: string): UpdaterStatus | null {
  try {
    const raw = readFileSync(join(dir, 'status.json'), 'utf8')
    if (raw.length > 64 * 1024) return null
    return statusSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

export function writeStatus(dir: string, s: UpdaterStatus): void {
  mkdirSync(dir, { recursive: true })
  // Readable by the server's own user (Docker: the updater runs as root).
  writeJsonAtomic(join(dir, 'status.json'), s, 0o644)
}

/** Auto on/off as the owner set it; `fallback` when never set (the installer's answer). */
export function readAuto(dir: string, fallback: boolean): boolean {
  try {
    const raw = readFileSync(join(dir, 'settings.json'), 'utf8')
    if (raw.length > 4096) return fallback
    return settingsSchema.parse(JSON.parse(raw)).auto
  } catch {
    return fallback
  }
}

export function writeAuto(dir: string, auto: boolean): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Readable by the updater (Docker: another user in the same group).
  writeJsonAtomic(join(dir, 'settings.json'), { auto }, 0o644)
}

export function requestUpdate(dir: string, now: Date = new Date()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeJsonAtomic(join(dir, 'request'), { at: now.toISOString() })
}

export function hasRequest(dir: string): boolean {
  return existsSync(join(dir, 'request'))
}

export function clearRequest(dir: string): void {
  rmSync(join(dir, 'request'), { force: true })
}
