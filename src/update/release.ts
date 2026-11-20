// Finding and verifying a release (F25, Decision S12). Used by the updaters and
// by CI (`krnl0 updater verify`), so CI proves every release with the same code
// that will check it at home.
//
// Repository, URLs and the signer identity are constants: nothing the server
// process can write changes what gets installed (NF11). Tests inject `deps`.

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { compareVersions } from '../version.js'

export const REPO = 'theMindDeveloper/krnl0-server'
export const ISSUER = 'https://token.actions.githubusercontent.com'
export const IMAGE_REPO = 'ghcr.io/theminddeveloper/krnl0-server'
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`
const downloadBase = (tag: string): string => `https://github.com/${REPO}/releases/download/${tag}`

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
/** The one signer a release may have: this repository's release.yml, at exactly this tag. */
export function identityFor(tag: string): string {
  return `^${escape(`https://github.com/${REPO}/.github/workflows/release.yml@refs/tags/${tag}`)}$`
}

export const releaseJsonSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  web: z.string(),
  image: z.string().regex(new RegExp(`^${escape(IMAGE_REPO)}@sha256:[0-9a-f]{64}$`)),
  protocol: z.number().int(),
  dataFormat: z.number().int(),
  minApp: z.string().nullable(),
})
export type ReleaseJson = z.infer<typeof releaseJsonSchema>

export interface ReleaseDeps {
  fetchFn: (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; arrayBuffer: () => Promise<ArrayBuffer>; json: () => Promise<unknown> }>
  /** Throws unless `bundle` is a valid Sigstore signature of `data` by `identity`. */
  verifySignature: (bundle: unknown, data: Buffer, identity: string) => Promise<void>
}

/** Sigstore (sigstore-js) with its trust root cached in `tufCachePath` (the helper's own folder). */
export function sigstoreVerifier(tufCachePath: string): ReleaseDeps['verifySignature'] {
  return async (bundle, data, identity) => {
    const { verify } = await import('sigstore')
    await verify(bundle as Parameters<typeof verify>[0], data, { certificateIssuer: ISSUER, certificateIdentityURI: identity, tufCachePath })
  }
}

export const defaultDeps = (tufCachePath: string): ReleaseDeps => ({
  fetchFn: (url, init) => fetch(url, { ...init, headers: { 'User-Agent': 'krnl0-updater', ...(init?.headers ?? {}) } }),
  verifySignature: sigstoreVerifier(tufCachePath),
})

/** The newest *published* release (drafts and pre-releases are never seen). */
export async function latestTag(deps: ReleaseDeps): Promise<string> {
  const res = await deps.fetchFn(API_LATEST, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for the newest release`)
  const tag = z.object({ tag_name: z.string().regex(/^v\d+\.\d+\.\d+$/) }).parse(await res.json()).tag_name
  return tag
}

export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?([A-Za-z0-9._-]+)$/)
    if (m) out.set(m[2]!, m[1]!)
  }
  return out
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256')
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer)
  return h.digest('hex')
}

export interface VerifiedRelease {
  tag: string
  version: string
  sums: Map<string, string>
  release: ReleaseJson
}

/** Checks SHA256SUMS against its signature for `tag`, then release.json against SHA256SUMS. */
export async function verifyManifest(tag: string, sumsText: Buffer, bundle: unknown, releaseText: Buffer, deps: Pick<ReleaseDeps, 'verifySignature'>): Promise<VerifiedRelease> {
  await deps.verifySignature(bundle, sumsText, identityFor(tag)).catch((err: unknown) => {
    throw new Error(`The release signature does not check out (${err instanceof Error ? err.message : String(err)}). Nothing was changed.`)
  })
  const sums = parseSums(sumsText.toString('utf8'))
  const want = sums.get('release.json')
  if (!want || want !== sha256(releaseText)) throw new Error('release.json does not match the signed checksums. Nothing was changed.')
  const release = releaseJsonSchema.parse(JSON.parse(releaseText.toString('utf8')))
  if (`v${release.version}` !== tag) throw new Error(`release.json says ${release.version}, the release is ${tag}. Nothing was changed.`)
  return { tag, version: release.version, sums, release }
}

async function getBytes(deps: ReleaseDeps, url: string, max: number): Promise<Buffer> {
  const res = await deps.fetchFn(url, { signal: AbortSignal.timeout(10 * 60_000) })
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url.split('/').pop() ?? url}`)
  const b = Buffer.from(await res.arrayBuffer())
  if (b.length > max) throw new Error('A download was larger than expected. Nothing was changed.')
  return b
}

/** The newest release, verified, when it is newer than `current`; null when there is nothing newer. */
export async function newestVerified(current: string, deps: ReleaseDeps): Promise<VerifiedRelease | null> {
  const tag = await latestTag(deps)
  if (compareVersions(tag, current) <= 0) return null
  const base = downloadBase(tag)
  const [sumsText, bundleText, releaseText] = await Promise.all([
    getBytes(deps, `${base}/SHA256SUMS`, 64 * 1024),
    getBytes(deps, `${base}/SHA256SUMS.sigstore.json`, 256 * 1024),
    getBytes(deps, `${base}/release.json`, 16 * 1024),
  ])
  const v = await verifyManifest(tag, sumsText, JSON.parse(bundleText.toString('utf8')), releaseText, deps)
  if (compareVersions(v.version, current) <= 0) return null
  return v
}

/** Downloads one file of a verified release into `dir` and checks it against the signed checksums. */
export async function downloadChecked(v: VerifiedRelease, name: string, dir: string, deps: ReleaseDeps, max = 512 * 1024 * 1024): Promise<string> {
  const want = v.sums.get(name)
  if (!want) throw new Error(`${name} is not in this release.`)
  const b = await getBytes(deps, `${downloadBase(v.tag)}/${name}`, max)
  if (sha256(b) !== want) throw new Error(`${name} does not match the signed checksums. Nothing was changed.`)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, name)
  await writeFile(path, b, { mode: 0o600 })
  return path
}

/** CI: a built release folder verifies with the identity of `tag`, and every listed file matches. */
export async function verifyFolder(dir: string, tag: string, deps: Pick<ReleaseDeps, 'verifySignature'>): Promise<VerifiedRelease> {
  const read = (n: string): Buffer => {
    const p = join(dir, n)
    if (!existsSync(p)) throw new Error(`${n} is missing in ${dir}`)
    return readFileSync(p)
  }
  const v = await verifyManifest(tag, read('SHA256SUMS'), JSON.parse(read('SHA256SUMS.sigstore.json').toString('utf8')), read('release.json'), deps)
  for (const [name, want] of v.sums) {
    if ((await sha256File(join(dir, name))) !== want) throw new Error(`${name} does not match SHA256SUMS`)
  }
  return v
}
