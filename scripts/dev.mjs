// `npm run dev`: builds, then runs the server with a data folder and port of
// its own for this checkout (AGENTS.md rule 10) — two worktrees never collide.
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(import.meta.url), '..', '..')
const port = 20000 + (createHash('sha256').update(root.toLowerCase()).digest().readUInt16BE(0) % 10000)
const env = {
  ...process.env,
  KRNL0_DATA_DIR: process.env.KRNL0_DATA_DIR ?? join(root, '.dev-data'),
  KRNL0_PORT: process.env.KRNL0_PORT ?? String(port),
  KRNL0_UPDATE_CHECK: process.env.KRNL0_UPDATE_CHECK ?? 'off',
}

const build = spawnSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.build.json')], { stdio: 'inherit' })
if (build.status !== 0) process.exit(build.status ?? 1)

console.log(`Data: ${env.KRNL0_DATA_DIR}  Port: ${env.KRNL0_PORT}`)
const args = process.argv.slice(2)
const child = spawn(process.execPath, [join(root, 'bin', 'krnl0.js'), ...(args.length ? args : ['start'])], { stdio: 'inherit', env })
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
child.on('exit', (code) => process.exit(code ?? 0))
