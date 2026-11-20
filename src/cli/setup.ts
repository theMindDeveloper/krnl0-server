// `krnl0 setup` on a real terminal (the owner's mix of TermA/B/C): the KRNL0
// header, one boxed question at a time with arrow keys, the path of answered
// steps, and the finish screen with a QR code. Off a terminal, with --yes or
// with flags, main.ts runs the plain typed setup instead.

import { isIP } from 'node:net'
import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import { passwordProblem } from '../auth/password.js'
import { localNames } from '../tls/selfsigned.js'
import { box, doneStep, finish, header, keysLine, menuLines, paint, pendingSteps, runMenu, type Check, type MenuState, type Option, type Paint } from './look.js'

export interface SetupAnswers {
  website: boolean
  appSync: boolean
  mode: 'self-signed' | 'files' | 'proxy'
  certFile?: string
  keyFile?: string
  hosts: string[]
  timeZone: string
  /** null = keep the current password. */
  password: string | null
}

export interface SetupStart {
  version: string
  website: boolean
  appSync: boolean
  mode: 'self-signed' | 'files' | 'proxy'
  certFile: string | null
  keyFile: string | null
  hosts: string[]
  timeZone: string
  hasOwner: boolean
  inDocker: boolean
}

const STEPS = ['What should this server do?', 'Encryption', 'Address and time zone', 'Owner password']
const out = (s: string): void => { process.stdout.write(s) }
const width = (): number => Math.min(78, (process.stdout.columns || 80) - 2)

async function menu<T extends string>(p: Paint, step: number, title: string, help: string | null, options: Array<Option<T>>, multi: boolean, preset: number[]): Promise<T[]> {
  const keys = multi ? '↑↓ move · space choose · enter next' : '↑↓ move · enter choose'
  const initial: MenuState = { cursor: preset[0] ?? 0, chosen: new Set(multi ? preset : []), done: false, cancelled: false, error: null }
  const picked = await runMenu(
    // TermA's box and keys, then TermB's steps still to come.
    (st) => [box(p, menuLines(p, title, help, options, st, multi), width()), keysLine(p, step, STEPS.length, keys), ...(step < STEPS.length ? ['', pendingSteps(p, STEPS.slice(step))] : [])].join('\n'),
    options.length, multi, initial,
  )
  return picked.map((i) => options[i]!.value)
}

/** A typed answer under a ◇ heading; replaced by its ◆ line once given. */
function text(p: Paint, title: string, hint: string | null, fallback: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const lines = [`${p.cyan('◇')}  ${p.ink(title)}`, ...(hint ? [`${p.edge('│')}  ${p.dim(hint)}`] : [])]
    out(lines.join('\n') + '\n')
    let muted = false
    const sink = new Writable({ write(chunk: Buffer, _e, cb) { if (!muted) process.stdout.write(chunk); cb() } })
    const rl = createInterface({ input: process.stdin, output: hidden ? sink : process.stdout, terminal: true })
    const prompt = `${p.edge('│')}  ${fallback && !hidden ? p.dim(`(${fallback}) `) : ''}`
    rl.question(prompt, (answer) => {
      rl.close()
      if (hidden) out('\n')
      // Up over the heading, the hint and the answer line; the caller prints the ◆ line.
      out(`\x1b[${lines.length + 1}A\x1b[0J`)
      resolve(answer.trim() || fallback)
    })
    if (hidden) muted = true
  })
}

/** Addresses this machine has, for the address step (LAN first; Tailscale named). */
export function addressChoices(names: string[], inDocker: boolean): Array<Option<string>> {
  const usable = names.filter((n) => n !== 'localhost' && n !== '::1' && n !== '127.0.0.1' && !n.startsWith('fe80') && isIP(n) !== 6)
  const rank = (n: string): number => (/^(192\.168\.|10\.)/.test(n) ? 0 : /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(n) ? 1 : n.endsWith('.local') ? 2 : isIP(n) === 0 ? 3 : 4)
  const label = (n: string): string => (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(n) ? 'Tailscale' : /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(n) ? (inDocker ? 'inside Docker only' : 'home network') : n.endsWith('.local') ? 'name on the network' : isIP(n) === 0 ? 'this computer\'s name' : '')
  return [...new Set(usable)].sort((a, b) => rank(a) - rank(b)).map((n) => ({ value: n, label: n, detail: label(n) }))
}

export async function runFancySetup(s: SetupStart, checksAfter: (a: SetupAnswers) => Promise<{ url: string | null; facts: Array<[string, string]>; checks: Check[]; next: string | null }>): Promise<SetupAnswers> {
  const p = paint(true)
  out(`\n${header(p, 'server setup', s.version)}\n`)
  const show = (title: string, answer: string): void => { out(`${doneStep(p, { title, answer })}\n`) }

  // 1 — what it does (TermA's box with checkboxes)
  const what = await menu(p, 1, STEPS[0]!, 'Both on is the usual choice. Change it later: krnl0 config', [
    { value: 'website', label: 'Website', detail: 'open KRNL0 in any browser, also on a phone' },
    { value: 'appSync', label: 'App sync', detail: 'keep the desktop app in sync on every computer' },
  ], true, [...(s.website ? [0] : []), ...(s.appSync ? [1] : [])])
  const website = what.includes('website')
  const appSync = what.includes('appSync')
  show(STEPS[0]!, [website ? 'Website' : '', appSync ? 'App sync' : ''].filter(Boolean).join(', '))

  // 2 — encryption
  const mode = (await menu(p, 2, STEPS[1]!, 'Every connection is encrypted; this is how browsers trust it. krnl0 help certificates', [
    { value: 'self-signed', label: 'Nothing to set up', detail: 'the app needs nothing; browsers warn once' },
    { value: 'files', label: 'My certificate files', detail: 'tailscale cert, certbot' },
    { value: 'proxy', label: 'My reverse proxy', detail: 'Caddy, Traefik, Nginx Proxy Manager' },
  ], false, [['self-signed', 'files', 'proxy'].indexOf(s.mode)]))[0] as SetupAnswers['mode']
  let certFile: string | undefined
  let keyFile: string | undefined
  if (mode === 'files') {
    certFile = await text(p, 'Certificate file (full chain)', null, s.certFile ?? '')
    keyFile = await text(p, 'Private key file', null, s.keyFile ?? '')
  }
  show(STEPS[1]!, mode === 'self-signed' ? 'Nothing to set up (self-signed)' : mode === 'files' ? `Certificate files · ${certFile ?? ''}` : 'My reverse proxy does HTTPS')

  // 3 — address (TermB's list) and time zone
  let hosts = s.hosts
  if (mode === 'self-signed') {
    const found = addressChoices(localNames(), s.inDocker)
    const preset = s.hosts.length ? found.flatMap((o, i) => (s.hosts.includes(o.value) ? [i] : [])) : (s.inDocker ? [] : [0])
    const options: Array<Option<string>> = [...found, { value: '__other', label: 'type another…', detail: s.inDocker ? 'the address of the computer running Docker' : 'a name or address' }]
    const picked = await menu(p, 3, 'Which address do you open KRNL0 by?', s.inDocker ? 'In Docker, add the address of the computer it runs on. The certificate will name it.' : 'The certificate will name it. Found on this machine:', options, true, preset.length ? preset : [options.length - 1])
    hosts = picked.filter((v) => v !== '__other')
    if (picked.includes('__other')) {
      const typed = await text(p, 'Other addresses', 'comma-separated, e.g. 192.168.1.20, nas.local', '')
      hosts = [...hosts, ...typed.split(',').map((x) => x.trim()).filter(Boolean)]
    }
  }
  let timeZone = ''
  for (;;) {
    timeZone = await text(p, 'Time zone', 'Your days start at its midnight.', s.timeZone)
    try { new Intl.DateTimeFormat('en', { timeZone }); break } catch { out(`${p.rust(`  "${timeZone}" is not a time zone. Use a name like Europe/Berlin.`)}\n`) }
  }
  show(STEPS[2]!, `${hosts.length ? hosts.join(', ') : 'this machine\'s addresses'} · ${timeZone}`)

  // 4 — password
  let password: string | null = null
  let keep = false
  if (s.hasOwner) {
    keep = (await menu(p, 4, 'Owner password', null, [
      { value: 'keep', label: 'Keep the current password' },
      { value: 'new', label: 'Choose a new one', detail: 'every browser logs in again' },
    ], false, [0]))[0] === 'keep'
  }
  if (!keep) {
    for (;;) {
      const a = await text(p, 'Owner password', '12 characters or more. It is never stored, only its hash.', '', true)
      const problem = passwordProblem(a)
      if (problem) { out(`${p.rust(`  ${problem}`)}\n`); continue }
      const b = await text(p, 'The same again', null, '', true)
      if (a !== b) { out(`${p.rust('  The two are not the same. Again.')}\n`); continue }
      password = a
      break
    }
  }
  show(STEPS[3]!, keep ? 'Kept' : 'Saved')

  const answers: SetupAnswers = { website, appSync, mode, hosts, timeZone, password, ...(certFile ? { certFile } : {}), ...(keyFile ? { keyFile } : {}) }
  const end = await checksAfter(answers)
  out(finish(p, {
    headline: 'KRNL0 server is set up',
    url: end.url,
    facts: end.facts,
    checks: end.checks,
    tip: mode === 'self-signed' ? 'First visit in a browser: it warns once; choose Advanced, then Continue.   krnl0 help certificates' : null,
    next: end.next,
    width: process.stdout.columns || 100,
  }))
  return answers
}
