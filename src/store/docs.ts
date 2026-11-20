// Documents with revisions (F9, Decisions S1, S6). The server never reads a
// document beyond its top-level `schemaVersion`.
//
//   <docs>/<file>.json        the body as the client sent it
//   <docs>/<file>.meta.json   { rev, schemaVersion, updatedAt, size, deleted }
//
// A deleted document keeps its meta as a tombstone, so a client that was
// offline learns about the delete instead of bringing the document back.

import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { ensureDir, KeyedLock, writeFileAtomic, writeJsonAtomic } from '../fsutil.js'

export const DOC_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/
export const MAX_DOC_BYTES = 20 * 1024 * 1024

const metaSchema = z.object({
  rev: z.number().int().min(0),
  schemaVersion: z.number().nullable(),
  updatedAt: z.string(),
  size: z.number().int().min(0),
  deleted: z.boolean().optional(),
})
export type DocMeta = z.infer<typeof metaSchema>

export interface DocChange { kind: 'doc'; name: string; rev: number; deleted: boolean; by: string | null }

export type PutResult =
  | { ok: true; rev: number }
  | { ok: false; reason: 'conflict'; rev: number; body: unknown; deleted: boolean }
  | { ok: false; reason: 'schema'; storedSchemaVersion: number }
  | { ok: false; reason: 'invalid'; message: string }

export type DeleteResult =
  | { ok: true; rev: number }
  | { ok: false; reason: 'conflict'; rev: number; body: unknown; deleted: boolean }
  | { ok: false; reason: 'missing' }

/** ':' is not allowed in Windows file names. */
const fileOf = (name: string): string => name.replace(/:/g, '%3A')
const nameOf = (file: string): string => file.replace(/%3A/g, ':')

export class DocStore {
  private readonly lock = new KeyedLock()

  constructor(
    private readonly dir: string,
    private readonly onChange: (c: DocChange) => void = () => {},
    private readonly now: () => Date = () => new Date(),
  ) {
    ensureDir(dir)
  }

  private bodyPath(name: string): string { return join(this.dir, `${fileOf(name)}.json`) }
  private metaPath(name: string): string { return join(this.dir, `${fileOf(name)}.meta.json`) }

  meta(name: string): DocMeta | null {
    const p = this.metaPath(name)
    if (!existsSync(p)) return null
    return metaSchema.parse(JSON.parse(readFileSync(p, 'utf8')))
  }

  list(): Array<DocMeta & { name: string }> {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.meta.json'))
      .map((f) => nameOf(f.slice(0, -'.meta.json'.length)))
      .filter((n) => DOC_NAME.test(n))
      .sort()
      .flatMap((name) => {
        const m = this.meta(name)
        return m ? [{ name, ...m }] : []
      })
  }

  /** The stored JSON text, or null when missing or deleted. */
  getText(name: string): { meta: DocMeta; text: string } | null {
    const meta = this.meta(name)
    if (!meta || meta.deleted) return null
    const p = this.bodyPath(name)
    if (!existsSync(p)) return null
    return { meta, text: readFileSync(p, 'utf8') }
  }

  private current(name: string): { rev: number; body: unknown; deleted: boolean } {
    const meta = this.meta(name)
    if (!meta) return { rev: 0, body: null, deleted: false }
    if (meta.deleted) return { rev: meta.rev, body: null, deleted: true }
    const got = this.getText(name)
    return { rev: meta.rev, body: got ? (JSON.parse(got.text) as unknown) : null, deleted: false }
  }

  put(name: string, baseRev: number, body: unknown, by: string | null = null): Promise<PutResult> {
    if (!DOC_NAME.test(name)) return Promise.resolve({ ok: false, reason: 'invalid', message: 'Bad document name.' })
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return Promise.resolve({ ok: false, reason: 'invalid', message: 'A document must be a JSON object.' })
    }
    const text = JSON.stringify(body)
    if (Buffer.byteLength(text) > MAX_DOC_BYTES) return Promise.resolve({ ok: false, reason: 'invalid', message: 'The document is too large.' })
    const incoming = (body as Record<string, unknown>).schemaVersion
    const incomingSv = typeof incoming === 'number' && Number.isFinite(incoming) ? incoming : null

    return this.lock.run(name, () => {
      const meta = this.meta(name)
      const rev = meta?.rev ?? 0
      if (baseRev !== rev) {
        const cur = this.current(name)
        return { ok: false, reason: 'conflict', rev: cur.rev, body: cur.body, deleted: cur.deleted } satisfies PutResult
      }
      const stored = meta && !meta.deleted ? meta.schemaVersion : null
      if (stored !== null && (incomingSv === null || incomingSv < stored)) {
        return { ok: false, reason: 'schema', storedSchemaVersion: stored } satisfies PutResult
      }
      const next = rev + 1
      writeFileAtomic(this.bodyPath(name), text)
      writeJsonAtomic(this.metaPath(name), { rev: next, schemaVersion: incomingSv, updatedAt: this.now().toISOString(), size: Buffer.byteLength(text) } satisfies DocMeta)
      this.onChange({ kind: 'doc', name, rev: next, deleted: false, by })
      return { ok: true, rev: next } satisfies PutResult
    })
  }

  delete(name: string, baseRev: number, by: string | null = null): Promise<DeleteResult> {
    if (!DOC_NAME.test(name)) return Promise.resolve({ ok: false, reason: 'missing' })
    return this.lock.run(name, () => {
      const meta = this.meta(name)
      if (!meta || meta.deleted) return { ok: false, reason: 'missing' } satisfies DeleteResult
      if (baseRev !== meta.rev) {
        const cur = this.current(name)
        return { ok: false, reason: 'conflict', rev: cur.rev, body: cur.body, deleted: cur.deleted } satisfies DeleteResult
      }
      const next = meta.rev + 1
      rmSync(this.bodyPath(name), { force: true })
      writeJsonAtomic(this.metaPath(name), { rev: next, schemaVersion: meta.schemaVersion, updatedAt: this.now().toISOString(), size: 0, deleted: true } satisfies DocMeta)
      this.onChange({ kind: 'doc', name, rev: next, deleted: true, by })
      return { ok: true, rev: next } satisfies DeleteResult
    })
  }
}
