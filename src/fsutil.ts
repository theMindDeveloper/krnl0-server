// File helpers (NF2): every write is atomic, writes to one key are serialised.

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ZodType } from 'zod'

export function ensureDir(dir: string, mode = 0o700): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode })
}

/** Write to a temp file next to the target, then rename over it. */
export function writeFileAtomic(path: string, data: string | Uint8Array, mode = 0o600): void {
  ensureDir(dirname(path))
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, data, { mode })
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
  try { chmodSync(path, mode) } catch { /* not supported on every file system */ }
}

export function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2) + '\n', mode)
}

/** Parsed and validated JSON, or `fallback` when the file is missing. Throws on a corrupt file. */
export function readJson<T>(path: string, schema: ZodType<T>, fallback: T): T {
  if (!existsSync(path)) return fallback
  const text = readFileSync(path, 'utf8')
  const parsed: unknown = JSON.parse(text)
  return schema.parse(parsed)
}

export function mtimeOf(path: string): number {
  try { return statSync(path).mtimeMs } catch { return 0 }
}

/**
 * A JSON file kept in memory and re-read when it changes on disk, so the
 * `krnl0` CLI can change it while the server runs (Decision S4).
 */
export class JsonFile<T> {
  private value: T | null = null
  private mtime = -1
  private size = -1

  constructor(
    readonly path: string,
    private readonly schema: ZodType<T>,
    private readonly fallback: () => T,
  ) {}

  get(): T {
    let st: { mtimeMs: number; size: number } | null = null
    try { st = statSync(this.path) } catch { st = null }
    const mtime = st?.mtimeMs ?? 0
    const size = st?.size ?? 0
    if (this.value === null || mtime !== this.mtime || size !== this.size) {
      this.value = readJson(this.path, this.schema, this.fallback())
      this.mtime = mtime
      this.size = size
    }
    return this.value
  }

  set(value: T): void {
    writeJsonAtomic(this.path, value)
    this.value = value
    try {
      const st = statSync(this.path)
      this.mtime = st.mtimeMs
      this.size = st.size
    } catch { this.mtime = 0 }
  }

  update(fn: (value: T) => T): T {
    const next = fn(this.get())
    this.set(next)
    return next
  }
}

/** Serialises async work per key (one document, one month file). */
export class KeyedLock {
  private chains = new Map<string, Promise<unknown>>()

  run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.catch(() => undefined)
    this.chains.set(key, tail)
    void tail.then(() => { if (this.chains.get(key) === tail) this.chains.delete(key) })
    return next
  }
}
