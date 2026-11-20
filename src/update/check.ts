// Update check (F16): once a day, ask GitHub Releases for the newest version.
// Sends nothing about the owner: a plain request with a generic user agent.
// Switch off with KRNL0_UPDATE_CHECK=off or `krnl0 config set updateCheck off`.

import { join } from 'node:path'
import { z } from 'zod'
import type { DataPaths } from '../paths.js'
import { readJson, writeJsonAtomic } from '../fsutil.js'
import { compareVersions, RELEASES_REPO, VERSION } from '../version.js'
import { log } from '../log.js'

const DAY_MS = 24 * 3600_000

const stateSchema = z.object({
  checkedAt: z.string().nullable(),
  latest: z.string().nullable(),
  url: z.string().nullable(),
})
export type UpdateState = z.infer<typeof stateSchema>

export interface UpdateInfo extends UpdateState { current: string; available: boolean; enabled: boolean }

const releaseSchema = z.object({ tag_name: z.string(), html_url: z.string(), draft: z.boolean().optional(), prerelease: z.boolean().optional() })

export type FetchFn = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

export class UpdateChecker {
  private timer: NodeJS.Timeout | null = null
  private readonly file: string

  constructor(
    paths: DataPaths,
    private readonly enabled: boolean,
    private readonly fetchFn: FetchFn = (url, init) => fetch(url, init),
  ) {
    this.file = join(paths.state, 'update.json')
  }

  info(): UpdateInfo {
    let s: UpdateState
    try { s = readJson(this.file, stateSchema, { checkedAt: null, latest: null, url: null }) } catch { s = { checkedAt: null, latest: null, url: null } }
    return { ...s, current: VERSION, available: s.latest !== null && compareVersions(s.latest, VERSION) > 0, enabled: this.enabled }
  }

  async checkNow(): Promise<UpdateInfo> {
    if (!this.enabled) return this.info()
    const res = await this.fetchFn(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'krnl0-server' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
    const rel = releaseSchema.parse(await res.json())
    const latest = rel.tag_name.replace(/^v/, '')
    writeJsonAtomic(this.file, { checkedAt: new Date().toISOString(), latest, url: rel.html_url } satisfies UpdateState)
    return this.info()
  }

  start(): void {
    if (!this.enabled || this.timer) return
    const run = (): void => {
      const last = this.info().checkedAt
      if (last && Date.now() - new Date(last).getTime() < DAY_MS) return
      this.checkNow().then(
        (i) => { if (i.available) log.info(`KRNL0 server ${i.latest ?? ''} is out`, { current: VERSION }) },
        (err: unknown) => log.debug('Update check failed', { reason: err instanceof Error ? err.message : String(err) }),
      )
    }
    setTimeout(run, 30_000).unref()
    this.timer = setInterval(run, 3600_000)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
