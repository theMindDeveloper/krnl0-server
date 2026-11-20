// Time log per board (F11): <timelog>/<boardId>/YYYY-MM.jsonl, append-only.
// The client says which month an entry belongs to; the server reads nothing
// else of it except an optional string `id` used to drop duplicates.

import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir, KeyedLock } from '../fsutil.js'

export const BOARD_ID = /^[A-Za-z0-9_-]{1,80}$/
export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
export const MAX_ENTRY_BYTES = 64 * 1024
export const MAX_ENTRIES_PER_CALL = 5000
export const MAX_QUERY_MONTHS = 60

export interface TimelogChange { kind: 'timelog'; boardId: string; month: string; by: string | null }

export interface AppendItem { month: string; entry: unknown }

const monthIndex = (m: string): number => {
  const [y, mo] = m.split('-').map(Number)
  return (y ?? 0) * 12 + ((mo ?? 1) - 1)
}

const monthOf = (i: number): string => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`

export class TimelogStore {
  private readonly lock = new KeyedLock()

  constructor(
    private readonly dir: string,
    private readonly onChange: (c: TimelogChange) => void = () => {},
  ) {
    ensureDir(dir)
  }

  private boardDir(boardId: string): string { return join(this.dir, boardId) }
  private file(boardId: string, month: string): string { return join(this.boardDir(boardId), `${month}.jsonl`) }

  private readMonth(boardId: string, month: string): unknown[] {
    const p = this.file(boardId, month)
    if (!existsSync(p)) return []
    const out: unknown[] = []
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line)) } catch { /* a torn last line from a crash is skipped */ }
    }
    return out
  }

  /** Validates, groups by month, drops entries whose `id` is already stored. */
  async append(boardId: string, items: AppendItem[], by: string | null = null): Promise<{ written: number; skipped: number }> {
    if (!BOARD_ID.test(boardId)) throw new RangeError('Bad board id.')
    if (items.length > MAX_ENTRIES_PER_CALL) throw new RangeError(`At most ${MAX_ENTRIES_PER_CALL} entries per call.`)
    const byMonth = new Map<string, string[]>()
    const idsByMonth = new Map<string, Array<string | null>>()
    for (const it of items) {
      if (!MONTH.test(it.month)) throw new RangeError(`Bad month "${String(it.month)}".`)
      if (typeof it.entry !== 'object' || it.entry === null || Array.isArray(it.entry)) throw new RangeError('An entry must be a JSON object.')
      const line = JSON.stringify(it.entry)
      if (Buffer.byteLength(line) > MAX_ENTRY_BYTES) throw new RangeError('An entry is too large.')
      const id = (it.entry as Record<string, unknown>).id
      byMonth.set(it.month, [...(byMonth.get(it.month) ?? []), line])
      idsByMonth.set(it.month, [...(idsByMonth.get(it.month) ?? []), typeof id === 'string' ? id : null])
    }
    let written = 0
    let skipped = 0
    for (const [month, lines] of byMonth) {
      await this.lock.run(`${boardId}/${month}`, () => {
        const seen = new Set<string>()
        for (const e of this.readMonth(boardId, month)) {
          const id = (e as Record<string, unknown> | null)?.id
          if (typeof id === 'string') seen.add(id)
        }
        const ids = idsByMonth.get(month) ?? []
        const keep: string[] = []
        lines.forEach((line, i) => {
          const id = ids[i] ?? null
          if (id !== null && seen.has(id)) { skipped++; return }
          if (id !== null) seen.add(id)
          keep.push(line)
        })
        if (keep.length > 0) {
          ensureDir(this.boardDir(boardId))
          appendFileSync(this.file(boardId, month), keep.join('\n') + '\n', { mode: 0o600 })
          written += keep.length
          this.onChange({ kind: 'timelog', boardId, month, by })
        }
      })
    }
    return { written, skipped }
  }

  query(boardId: string, from: string, to: string): Record<string, unknown[]> {
    if (!BOARD_ID.test(boardId)) throw new RangeError('Bad board id.')
    if (!MONTH.test(from) || !MONTH.test(to)) throw new RangeError('Months are YYYY-MM.')
    const a = monthIndex(from)
    const b = monthIndex(to)
    if (b < a) throw new RangeError('"from" is after "to".')
    if (b - a + 1 > MAX_QUERY_MONTHS) throw new RangeError(`At most ${MAX_QUERY_MONTHS} months per query.`)
    const out: Record<string, unknown[]> = {}
    for (let i = a; i <= b; i++) {
      const m = monthOf(i)
      const entries = this.readMonth(boardId, m)
      if (entries.length > 0) out[m] = entries
    }
    return out
  }

  months(boardId: string): string[] {
    if (!BOARD_ID.test(boardId)) return []
    const d = this.boardDir(boardId)
    if (!existsSync(d)) return []
    return readdirSync(d).map((f) => /^(\d{4}-\d{2})\.jsonl$/.exec(f)?.[1]).filter((m): m is string => !!m).sort()
  }

  boards(): string[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir, { withFileTypes: true }).filter((d) => d.isDirectory() && BOARD_ID.test(d.name)).map((d) => d.name).sort()
  }

  /** Moves a deleted board's log aside (kept until the next backup prune). */
  removeBoard(boardId: string): boolean {
    if (!BOARD_ID.test(boardId)) return false
    const d = this.boardDir(boardId)
    if (!existsSync(d)) return false
    const trash = join(this.dir, '.deleted')
    ensureDir(trash)
    renameSync(d, join(trash, `${boardId}-${Date.now()}`))
    return true
  }
}
