// Questions in the terminal. Plain text for now (Decision S8: the coloured
// setup look waits for the owner's pick).

import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'

export const interactive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY)

export function ask(question: string, fallback = ''): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const hint = fallback ? ` [${fallback}]` : ''
    rl.question(`${question}${hint}: `, (answer) => {
      rl.close()
      resolve(answer.trim() || fallback)
    })
  })
}

export async function askYesNo(question: string, fallback: boolean): Promise<boolean> {
  for (;;) {
    const a = (await ask(`${question} (${fallback ? 'Y/n' : 'y/N'})`)).toLowerCase()
    if (a === '') return fallback
    if (['y', 'yes', 'on'].includes(a)) return true
    if (['n', 'no', 'off'].includes(a)) return false
  }
}

export async function askChoice<T extends string>(question: string, choices: Array<{ value: T; label: string }>, fallback: T): Promise<T> {
  process.stdout.write(`${question}\n`)
  choices.forEach((c, i) => process.stdout.write(`  ${i + 1}) ${c.label}${c.value === fallback ? '  (default)' : ''}\n`))
  for (;;) {
    const a = await ask('Choose a number', String(choices.findIndex((c) => c.value === fallback) + 1))
    const n = Number(a)
    const pick = choices[n - 1]
    if (Number.isInteger(n) && pick) return pick.value
  }
}

/** Reads a line without echoing it. */
export function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    let muted = false
    const out = new Writable({
      write(chunk: Buffer, _enc, cb) {
        if (!muted) process.stdout.write(chunk)
        cb()
      },
    })
    const rl = createInterface({ input: process.stdin, output: out, terminal: true })
    rl.question(`${question}: `, (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
    muted = true
  })
}

/** The whole of stdin (for --password-stdin), without the final newline. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
}
