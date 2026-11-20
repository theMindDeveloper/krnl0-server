#!/usr/bin/env node
import('../dist/cli/main.js').then((m) => m.main(process.argv.slice(2))).then(
  (code) => { process.exitCode = typeof code === 'number' ? code : 0 },
  (err) => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1 },
)
