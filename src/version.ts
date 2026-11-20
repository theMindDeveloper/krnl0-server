import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** Wire protocol between KRNL0 clients and this server (Decision S9). */
export const PROTOCOL = 1

/** The repo whose GitHub Releases announce new server versions (F16). */
export const RELEASES_REPO = 'theMindDeveloper/krnl0-server'

function readVersion(): string {
  // src/version.ts and dist/version.js both sit one level below package.json.
  const here = dirname(fileURLToPath(import.meta.url))
  try {
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const VERSION = readVersion()

/** -1, 0 or 1 for two `X.Y.Z` versions (pre-release suffixes are ignored). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] => v.replace(/^v/, '').split(/[.+-]/).slice(0, 3).map((p) => Number.parseInt(p, 10) || 0)
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}
