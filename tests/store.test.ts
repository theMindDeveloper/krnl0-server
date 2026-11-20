import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { DocStore, type DocChange } from '../src/store/docs.js'
import { TimelogStore } from '../src/store/timelog.js'
import { AssetStore, TooLargeError } from '../src/store/assets.js'
import { listBackups, makeBackup, pruneBackups, restoreBackup } from '../src/store/backup.js'
import { dataPaths } from '../src/paths.js'
import { tempDir } from './helpers.js'

describe('documents (F9)', () => {
  it('refuses a stale write with the current document', async () => {
    const changes: DocChange[] = []
    const docs = new DocStore(tempDir(), (c) => changes.push(c))
    expect(await docs.put('board:b1', 0, { schemaVersion: 2, a: 1 })).toEqual({ ok: true, rev: 1 })
    expect(await docs.put('board:b1', 1, { schemaVersion: 2, a: 2 })).toEqual({ ok: true, rev: 2 })
    const stale = await docs.put('board:b1', 1, { schemaVersion: 2, a: 3 })
    expect(stale).toEqual({ ok: false, reason: 'conflict', rev: 2, body: { schemaVersion: 2, a: 2 }, deleted: false })
    expect(changes.map((c) => c.rev)).toEqual([1, 2])
  })

  it('refuses a lower schemaVersion (no downgrade by an old app)', async () => {
    const docs = new DocStore(tempDir())
    await docs.put('board:b1', 0, { schemaVersion: 3 })
    expect(await docs.put('board:b1', 1, { schemaVersion: 2 })).toEqual({ ok: false, reason: 'schema', storedSchemaVersion: 3 })
    expect(await docs.put('board:b1', 1, { nothing: true })).toEqual({ ok: false, reason: 'schema', storedSchemaVersion: 3 })
    expect(await docs.put('board:b1', 1, { schemaVersion: 4 })).toEqual({ ok: true, rev: 2 })
  })

  it('keeps a tombstone so an offline client learns about a delete', async () => {
    const docs = new DocStore(tempDir())
    await docs.put('board:b1', 0, { schemaVersion: 2 })
    expect(await docs.delete('board:b1', 1)).toEqual({ ok: true, rev: 2 })
    expect(docs.getText('board:b1')).toBeNull()
    expect(docs.meta('board:b1')?.deleted).toBe(true)
    const old = await docs.put('board:b1', 1, { schemaVersion: 2 })
    expect(old).toMatchObject({ ok: false, reason: 'conflict', rev: 2, deleted: true })
    expect(await docs.put('board:b1', 2, { schemaVersion: 2 })).toEqual({ ok: true, rev: 3 })
  })

  it('serialises concurrent writes to one document', async () => {
    const docs = new DocStore(tempDir())
    const results = await Promise.all([1, 2, 3, 4, 5].map((i) => docs.put('d', 0, { i })))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
  })

  it('rejects bad names and non-objects', async () => {
    const docs = new DocStore(tempDir())
    expect(await docs.put('../etc/passwd', 0, {})).toMatchObject({ ok: false, reason: 'invalid' })
    expect(await docs.put('d', 0, [1, 2])).toMatchObject({ ok: false, reason: 'invalid' })
  })
})

describe('time log (F11)', () => {
  it('stores an id once and queries by month', async () => {
    const t = new TimelogStore(tempDir())
    const r = await t.append('b1', [
      { month: '2026-10', entry: { id: 'e1' } },
      { month: '2026-11', entry: { id: 'e2' } },
      { month: '2026-11', entry: { id: 'e2' } },
      { month: '2026-11', entry: { note: 'no id' } },
    ])
    expect(r).toEqual({ written: 3, skipped: 1 })
    expect((await t.append('b1', [{ month: '2026-11', entry: { id: 'e2' } }])).skipped).toBe(1)
    expect(t.query('b1', '2026-10', '2026-12')).toEqual({ '2026-10': [{ id: 'e1' }], '2026-11': [{ id: 'e2' }, { note: 'no id' }] })
    expect(t.months('b1')).toEqual(['2026-10', '2026-11'])
  })

  it('refuses bad months, board ids and huge ranges', async () => {
    const t = new TimelogStore(tempDir())
    await expect(t.append('b1', [{ month: '2026-13', entry: {} }])).rejects.toThrow(RangeError)
    await expect(t.append('../x', [])).rejects.toThrow(RangeError)
    expect(() => t.query('b1', '2020-01', '2026-01')).toThrow(/60 months/)
  })
})

describe('assets (F12)', () => {
  it('stores by id and enforces the size limit', async () => {
    const dir = tempDir()
    const a = new AssetStore(dir)
    expect(await a.put('01HXYZABCDEFGH', 'png', Readable.from([Buffer.from('png')]))).toBe(3)
    expect(a.find('01HXYZABCDEFGH')?.ext).toBe('png')
    const big = Readable.from((function* () { for (let i = 0; i < 27; i++) yield Buffer.alloc(1024 * 1024) })())
    await expect(a.put('01HXYZABCDEFGJ', 'png', big)).rejects.toBeInstanceOf(TooLargeError)
    expect(a.find('01HXYZABCDEFGJ')).toBeNull()
    expect(a.delete('01HXYZABCDEFGH')).toBe(true)
  })
})

describe('backups (F15)', () => {
  it('keeps the newest 14', () => {
    const paths = dataPaths(tempDir())
    mkdirSync(paths.docs, { recursive: true })
    for (let i = 0; i < 15; i++) makeBackup(paths, 'daily', new Date(Date.UTC(2026, 0, 1 + i)))
    expect(listBackups(paths)).toHaveLength(15)
    const dropped = pruneBackups(paths, 14)
    expect(dropped).toHaveLength(1)
    expect(dropped[0]).toMatch(/^2026-01-01/)
    expect(listBackups(paths)).toHaveLength(14)
  })

  it('restores, and backs up the current data first', async () => {
    const paths = dataPaths(tempDir())
    const docs = new DocStore(paths.docs)
    await docs.put('d', 0, { v: 'old' })
    mkdirSync(paths.assets, { recursive: true })
    writeFileSync(join(paths.assets, '01HXYZABCDEFGH.png'), 'img')
    const b = makeBackup(paths, 'manual')
    await docs.put('d', 1, { v: 'new' })
    const before = restoreBackup(paths, b.name)
    expect(JSON.parse(new DocStore(paths.docs).getText('d')?.text ?? '{}')).toEqual({ v: 'old' })
    expect(readFileSync(join(paths.assets, '01HXYZABCDEFGH.png'), 'utf8')).toBe('img')
    expect(before.reason).toBe('before-restore')
    expect(existsSync(join(paths.backups, before.name, 'users', 'owner', 'docs'))).toBe(true)
    expect(() => restoreBackup(paths, '../../etc')).toThrow(/No backup/)
  })
})
