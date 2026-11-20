#!/usr/bin/env node
// release.json for a release (Decision S12): signed through SHA256SUMS, read by updaters.
//   node scripts/release-json.mjs <version> <krnl0-web-version> <image@sha256:digest>
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const [version, web, image] = process.argv.slice(2)
if (!version || !web || !/@sha256:[0-9a-f]{64}$/.test(image ?? '')) {
  console.error('usage: release-json.mjs <version> <web-version> <image@sha256:digest>')
  process.exit(2)
}
const num = (file, re) => {
  const m = readFileSync(join(ROOT, file), 'utf8').match(re)
  if (!m) throw new Error(`${re} not found in ${file}`)
  return Number(m[1])
}
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
if (pkg.version !== version) throw new Error(`package.json is ${pkg.version}, not ${version}`)
const out = {
  version,
  web,
  image,
  protocol: num('src/version.ts', /export const PROTOCOL = (\d+)/),
  dataFormat: num('src/server.ts', /export const DATA_FORMAT = (\d+)/),
  minApp: pkg.krnl0?.minApp ?? null,
}
process.stdout.write(JSON.stringify(out, null, 2) + '\n')
