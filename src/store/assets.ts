// Images and media by id (F12). Same extensions and limits as the app's own
// asset store (KRNL0 Decision 21), so a board moves between them unchanged.

import { createWriteStream, existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Readable } from 'node:stream'
import { ensureDir } from '../fsutil.js'

export const ASSET_ID = /^[A-Za-z0-9_-]{8,64}$/
const GENERIC_EXT = /^[a-z0-9]{1,10}$/

export const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
}
export const MEDIA_MIME: Record<string, string> = {
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/mp4', m4v: 'video/mp4', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac',
  pdf: 'application/pdf',
}
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024
export const MAX_MEDIA_BYTES = 500 * 1024 * 1024
export const MAX_OTHER_BYTES = 100 * 1024 * 1024

export interface AssetChange { kind: 'asset'; id: string; deleted: boolean; by: string | null }

export type AssetKind = 'image' | 'svg' | 'media' | 'other'

export function parseAssetFile(file: string): { id: string; ext: string } | null {
  const dot = file.lastIndexOf('.')
  if (dot <= 0) return null
  const id = file.slice(0, dot)
  const ext = file.slice(dot + 1).toLowerCase()
  if (!ASSET_ID.test(id) || !GENERIC_EXT.test(ext)) return null
  return { id, ext }
}

export function kindOf(ext: string): AssetKind {
  if (ext === 'svg') return 'svg'
  if (IMAGE_MIME[ext]) return 'image'
  if (MEDIA_MIME[ext]) return 'media'
  return 'other'
}

export function mimeOf(ext: string): string {
  return IMAGE_MIME[ext] ?? MEDIA_MIME[ext] ?? 'application/octet-stream'
}

export function maxBytesOf(ext: string): number {
  const k = kindOf(ext)
  return k === 'image' || k === 'svg' ? MAX_IMAGE_BYTES : k === 'media' ? MAX_MEDIA_BYTES : MAX_OTHER_BYTES
}

export class TooLargeError extends Error {}

export class AssetStore {
  constructor(
    private readonly dir: string,
    private readonly onChange: (c: AssetChange) => void = () => {},
  ) {
    ensureDir(dir)
  }

  /** The stored file for an id, whatever its extension. */
  find(id: string): { path: string; ext: string; size: number } | null {
    if (!ASSET_ID.test(id) || !existsSync(this.dir)) return null
    for (const f of readdirSync(this.dir)) {
      const parsed = parseAssetFile(f)
      if (parsed && parsed.id === id) {
        const path = join(this.dir, f)
        return { path, ext: parsed.ext, size: statSync(path).size }
      }
    }
    return null
  }

  list(): Array<{ id: string; ext: string; size: number }> {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir).flatMap((f) => {
      const parsed = parseAssetFile(f)
      if (!parsed) return []
      return [{ ...parsed, size: statSync(join(this.dir, f)).size }]
    })
  }

  /** Streams the body to a temp file within the size limit, then renames it into place. */
  async put(id: string, ext: string, body: Readable, by: string | null = null): Promise<number> {
    if (!ASSET_ID.test(id) || !GENERIC_EXT.test(ext)) throw new RangeError('Bad asset name.')
    const limit = maxBytesOf(ext)
    const tmp = join(this.dir, `.upload-${randomBytes(8).toString('hex')}`)
    let size = 0
    try {
      await new Promise<void>((resolve, reject) => {
        const out = createWriteStream(tmp, { mode: 0o600 })
        body.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > limit) {
            body.destroy()
            out.destroy()
            reject(new TooLargeError(`The file is larger than ${Math.round(limit / 1024 / 1024)} MB.`))
          }
        })
        body.on('error', reject)
        out.on('error', reject)
        out.on('finish', () => resolve())
        body.pipe(out)
      })
      const old = this.find(id)
      if (old && old.ext !== ext) rmSync(old.path, { force: true })
      renameSync(tmp, join(this.dir, `${id}.${ext}`))
    } catch (err) {
      rmSync(tmp, { force: true })
      throw err
    }
    this.onChange({ kind: 'asset', id, deleted: false, by })
    return size
  }

  delete(id: string, by: string | null = null): boolean {
    const found = this.find(id)
    if (!found) return false
    rmSync(found.path, { force: true })
    this.onChange({ kind: 'asset', id, deleted: true, by })
    return true
  }
}
