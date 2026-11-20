#!/usr/bin/env node
// Prepares the server release that ships a newer KRNL0 web app (Decision S13).
//   node scripts/follow-krnl0.mjs <krnl0-version> [date]
// Writes web-version, bumps the patch version, and adds the CHANGELOG section,
// the release notes and the history entry. Prints the new version.
// Run by .github/workflows/follow-krnl0.yml; safe to run by hand.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const web = (process.argv[2] ?? '').replace(/^v/, '')
const date = process.argv[3] ?? new Date().toISOString().slice(0, 10)
if (!/^\d+\.\d+\.\d+$/.test(web)) { console.error('usage: follow-krnl0.mjs <krnl0 X.Y.Z> [YYYY-MM-DD]'); process.exit(2) }

const file = (p) => join(ROOT, p)
const current = readFileSync(file('web-version'), 'utf8').trim()
if (current === web) { console.error(`web-version is already ${web}`); process.exit(3) }

const pkg = JSON.parse(readFileSync(file('package.json'), 'utf8'))
const [ma, mi, pa] = pkg.version.split('.').map(Number)
const next = `${ma}.${mi}.${pa + 1}`
pkg.version = next
writeFileSync(file('package.json'), JSON.stringify(pkg, null, 2) + '\n')
const lockPath = file('package-lock.json')
if (existsSync(lockPath)) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  lock.version = next
  if (lock.packages && lock.packages['']) lock.packages[''].version = next
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n')
}
writeFileSync(file('web-version'), web + '\n')

const changelog = readFileSync(file('CHANGELOG.md'), 'utf8')
writeFileSync(file('CHANGELOG.md'), changelog.replace(/^# Changelog\s*\n/, `# Changelog\n\n## ${next} — ${date}\n\n- The website is KRNL0 ${web}.\n\n`))

writeFileSync(file(`docs/releases/v${next}.md`), `# KRNL0 server ${next}

Your server's website is now **KRNL0 ${web}** — the same version as the desktop app. [What's new in KRNL0 ${web}](https://github.com/theMindDeveloper/KRNL0/releases/tag/v${web}).

**Update:** in the KRNL0 app, click **saved** in the top bar, then **Update server**. Or on the server: Docker \`docker compose pull && docker compose up -d\` (in \`~/krnl0\`), Linux the install command again. Your data is backed up first.

Downloads are listed in \`SHA256SUMS\`, signed with Sigstore (\`SHA256SUMS.sigstore.json\`); the image is pulled by the digest in \`release.json\`.
`)

const history = readFileSync(file('docs/history/HISTORY.md'), 'utf8')
const entry = `## ${date} — Release ${next}: the website is KRNL0 ${web}

**Type:** Release
**PRs/Commits:** follow-krnl0 release PR
**Files changed:** web-version, package.json, package-lock.json, CHANGELOG.md, docs/releases/v${next}.md, docs/history/HISTORY.md

**Summary:** KRNL0 ${web} was published; this release pins its web app (checked against KRNL0's SHA-256 when the release is built). Merging tags v${next} and builds the draft; the owner's Publish ships it to updaters.

`
writeFileSync(file('docs/history/HISTORY.md'), history.replace(/(\n## )/, `\n${entry}## `))
console.log(next)
