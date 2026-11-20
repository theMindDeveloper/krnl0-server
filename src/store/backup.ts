// Backups (F15): a dated folder per backup. Documents, time log, auth, TLS and
// config are copied; assets are hard-linked (they never change in place), so a
// backup costs almost no space for images and video.

import { copyFileSync, cpSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { DataPaths } from '../paths.js'
import { ensureDir, writeJsonAtomic } from '../fsutil.js'
import { VERSION } from '../version.js'

const manifestSchema = z.object({ createdAt: z.string(), serverVersion: z.string(), reason: z.string() })
export type BackupManifest = z.infer<typeof manifestSchema>
export interface BackupInfo extends BackupManifest { name: string }

const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}_\d{6}(?:_[a-z0-9.-]{1,40})?$/

function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
}

/** Hard-links every file under src into dst (copies when linking is not possible). */
function linkTree(src: string, dst: string): void {
  if (!existsSync(src)) return
  ensureDir(dst)
  for (const ent of readdirSync(src, { withFileTypes: true })) {
    if (ent.name.startsWith('.upload-')) continue
    const s = join(src, ent.name)
    const d = join(dst, ent.name)
    if (ent.isDirectory()) linkTree(s, d)
    else if (ent.isFile()) {
      try { linkSync(s, d) } catch { copyFileSync(s, d) }
    }
  }
}

function copyIfExists(src: string, dst: string): void {
  if (!existsSync(src)) return
  cpSync(src, dst, { recursive: true, errorOnExist: false, force: true })
}

/** What goes into a backup, relative to the data folder. */
function parts(paths: DataPaths): { config: string; format: string; auth: string; tls: string; users: string } {
  return { config: paths.config, format: paths.format, auth: paths.auth, tls: paths.tls, users: join(paths.root, 'users') }
}

function copyData(from: DataPaths, toRoot: string): void {
  const p = parts(from)
  ensureDir(toRoot)
  copyIfExists(p.config, join(toRoot, 'config.json'))
  copyIfExists(p.format, join(toRoot, 'format.json'))
  copyIfExists(p.auth, join(toRoot, 'auth'))
  copyIfExists(p.tls, join(toRoot, 'tls'))
  // users/<u>/{docs,timelog} copied, users/<u>/assets linked
  if (existsSync(p.users)) {
    for (const u of readdirSync(p.users, { withFileTypes: true })) {
      if (!u.isDirectory()) continue
      const su = join(p.users, u.name)
      const du = join(toRoot, 'users', u.name)
      ensureDir(du)
      for (const ent of readdirSync(su, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue
        if (ent.name === 'assets') linkTree(join(su, ent.name), join(du, ent.name))
        else copyIfExists(join(su, ent.name), join(du, ent.name))
      }
    }
  }
}

export function makeBackup(paths: DataPaths, reason = 'manual', now = new Date()): BackupInfo {
  ensureDir(paths.backups)
  const safeReason = reason.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').slice(0, 40)
  let name = `${stamp(now)}_${safeReason}`
  let n = 1
  while (existsSync(join(paths.backups, name))) name = `${stamp(now)}_${safeReason}-${n++}`
  const tmp = join(paths.backups, `.${name}.partial`)
  rmSync(tmp, { recursive: true, force: true })
  copyData(paths, tmp)
  const manifest: BackupManifest = { createdAt: now.toISOString(), serverVersion: VERSION, reason: safeReason }
  writeJsonAtomic(join(tmp, 'backup.json'), manifest)
  renameSync(tmp, join(paths.backups, name))
  return { name, ...manifest }
}

export function listBackups(paths: DataPaths): BackupInfo[] {
  if (!existsSync(paths.backups)) return []
  return readdirSync(paths.backups)
    .filter((n) => BACKUP_NAME.test(n))
    .flatMap((name) => {
      try {
        const m = manifestSchema.parse(JSON.parse(readFileSync(join(paths.backups, name, 'backup.json'), 'utf8')))
        return [{ name, ...m }]
      } catch {
        return []
      }
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** Keeps the newest `keep` backups. */
export function pruneBackups(paths: DataPaths, keep: number): string[] {
  const all = listBackups(paths)
  const drop = all.slice(0, Math.max(0, all.length - keep))
  for (const b of drop) rmSync(join(paths.backups, b.name), { recursive: true, force: true })
  // Leftovers of interrupted backups.
  if (existsSync(paths.backups)) {
    for (const n of readdirSync(paths.backups)) if (n.endsWith('.partial')) rmSync(join(paths.backups, n), { recursive: true, force: true })
  }
  return drop.map((b) => b.name)
}

export function lastBackupAt(paths: DataPaths): Date | null {
  const all = listBackups(paths)
  const last = all[all.length - 1]
  return last ? new Date(last.createdAt) : null
}

/**
 * Replaces the data with a backup. The caller makes sure the server is not
 * running. The current data is backed up first ("before-restore").
 */
export function restoreBackup(paths: DataPaths, name: string): BackupInfo {
  if (!BACKUP_NAME.test(name)) throw new Error(`No backup named "${name}". See: krnl0 backups`)
  const src = join(paths.backups, name)
  if (!existsSync(join(src, 'backup.json'))) throw new Error(`No backup named "${name}". See: krnl0 backups`)
  const before = makeBackup(paths, 'before-restore')
  const p = parts(paths)
  for (const target of [p.config, p.format, p.auth, p.tls, p.users]) rmSync(target, { recursive: true, force: true })
  copyIfExists(join(src, 'config.json'), p.config)
  copyIfExists(join(src, 'format.json'), p.format)
  copyIfExists(join(src, 'auth'), p.auth)
  copyIfExists(join(src, 'tls'), p.tls)
  const srcUsers = join(src, 'users')
  if (existsSync(srcUsers)) {
    mkdirSync(p.users, { recursive: true })
    for (const u of readdirSync(srcUsers, { withFileTypes: true })) {
      if (!u.isDirectory()) continue
      for (const ent of readdirSync(join(srcUsers, u.name), { withFileTypes: true })) {
        if (!ent.isDirectory()) continue
        const s = join(srcUsers, u.name, ent.name)
        const d = join(p.users, u.name, ent.name)
        if (ent.name === 'assets') linkTree(s, d)
        else copyIfExists(s, d)
      }
    }
  }
  return before
}

/** Bytes used by the data folder, without backups (for doctor). */
export function dataSize(dir: string): number {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name)
    if (ent.isDirectory()) total += dataSize(p)
    else if (ent.isFile()) total += statSync(p).size
  }
  return total
}
