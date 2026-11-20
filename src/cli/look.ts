// The terminal look of `krnl0` (Decision S8; the owner asked for the best of
// the three drafts, 2026-11-20):
//   TermA  the KRNL0 block letters with "server setup · version · step N of M",
//          the current question in a box, the key hints
//   TermB  the path of steps: ◆ answered (with its answer), ◇ now, ○ still to come
//   TermC  the finish: DONE, a QR code to open it on a phone, the facts, the checks
// Colours only on a real terminal (and never with NO_COLOR); a pipe or a file
// gets plain text. Arrow-key menus fall back to typed answers off a terminal.

import { emitKeypressEvents } from 'node:readline'
import { renderUnicodeCompact } from 'uqr'

// ── Colours ─────────────────────────────────────────────────────────────────

export const colorOn = (stream: NodeJS.WriteStream = process.stdout): boolean =>
  Boolean(stream.isTTY) && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb'

const truecolor = (): boolean => /truecolor|24bit/i.test(process.env.COLORTERM ?? '') || process.platform === 'win32'

type Rgb = [number, number, number]
const PALETTE = {
  acid: [201, 241, 88] as Rgb,
  ink: [244, 239, 226] as Rgb,
  dim: [179, 170, 148] as Rgb,
  rust: [238, 132, 102] as Rgb,
  cyan: [34, 211, 238] as Rgb,
  edge: [86, 80, 68] as Rgb,
}
const BASIC: Record<keyof typeof PALETTE, number> = { acid: 92, ink: 97, dim: 90, rust: 91, cyan: 96, edge: 90 }

export interface Paint {
  on: boolean
  acid(s: string): string
  ink(s: string): string
  dim(s: string): string
  rust(s: string): string
  cyan(s: string): string
  edge(s: string): string
  bold(s: string): string
  /** Dark text on acid: the DONE badge, the KRNL0 chip. */
  badge(s: string): string
}

export function paint(on = colorOn()): Paint {
  const tc = truecolor()
  const fg = (k: keyof typeof PALETTE) => (s: string): string => {
    if (!on) return s
    const [r, g, b] = PALETTE[k]
    return tc ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m` : `\x1b[${BASIC[k]}m${s}\x1b[39m`
  }
  return {
    on,
    acid: fg('acid'), ink: fg('ink'), dim: fg('dim'), rust: fg('rust'), cyan: fg('cyan'), edge: fg('edge'),
    bold: (s) => (on ? `\x1b[1m${s}\x1b[22m` : s),
    badge: (s) => (!on ? `[${s.trim()}]` : tc ? `\x1b[48;2;201;241;88m\x1b[38;2;10;9;8m\x1b[1m${s}\x1b[0m` : `\x1b[102m\x1b[30m\x1b[1m${s}\x1b[0m`),
  }
}

/** Visible width of a string with colour codes. */
export const visible = (s: string): number => [...s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')].length
const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - visible(s)))

// ── TermA: the header ──────────────────────────────────────────────────────

const LOGO = ['█▄▀ █▀█ █▄ █ █   █▀█', '█ █ █▀▄ █ ▀█ █▄▄ █▄█']

export function header(p: Paint, title: string, version: string, step?: { n: number; of: number }): string {
  const right1 = p.dim(`${title} · ${version}`)
  const right2 = step ? p.dim(`step ${step.n} of ${step.of}`) : ''
  return [`${p.acid(LOGO[0]!)}   ${right1}`, `${p.acid(LOGO[1]!)}   ${right2}`, ''].join('\n')
}

// ── TermB: the path ────────────────────────────────────────────────────────

export interface Step { title: string; answer?: string }

/** An answered step: ◆ title, │ answer. */
export const doneStep = (p: Paint, s: Step): string => `${p.acid('◆')}  ${p.ink(s.title)}\n${p.edge('│')}  ${p.dim(s.answer ?? '')}\n${p.edge('│')}`
/** The steps still to come, quietly. */
export const pendingSteps = (p: Paint, titles: string[]): string => titles.map((t) => `${p.edge('○')}  ${p.dim(t)}`).join('\n')

// ── TermA: the current question in a box ───────────────────────────────────

export function box(p: Paint, lines: string[], width: number): string {
  const inner = Math.max(20, width - 4)
  const top = p.edge(`╭${'─'.repeat(inner + 2)}╮`)
  const bottom = p.edge(`╰${'─'.repeat(inner + 2)}╯`)
  const body = lines.map((l) => `${p.edge('│')} ${pad(clip(l, inner), inner)} ${p.edge('│')}`)
  return [top, ...body, bottom].join('\n')
}

/** Cuts a (coloured) line to `w` visible characters. */
function clip(s: string, w: number): string {
  if (visible(s) <= w) return s
  let out = ''
  let n = 0
  for (let i = 0; i < s.length && n < w - 1; i++) {
    if (s[i] === '\x1b') { const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i)); if (m) { out += m[0]; i += m[0].length - 1; continue } }
    out += s[i]
    n++
  }
  return `${out}…\x1b[0m`
}

/** "●●●○" progress and the keys. */
export const keysLine = (p: Paint, n: number, of: number, keys: string): string =>
  `${p.acid('●'.repeat(n))}${p.edge('●'.repeat(Math.max(0, of - n)))}  ${p.dim(`step ${n} of ${of}`)}   ${p.dim(keys)}`

export const nextLine = (p: Paint, titles: string[]): string =>
  titles.length ? `${p.dim('next:')} ${titles.join(p.dim(' › '))}` : ''

// ── Menus (arrow keys; typed answers off a terminal) ───────────────────────

export interface Option<T extends string> { value: T; label: string; detail?: string }

export interface MenuState { cursor: number; chosen: Set<number>; done: boolean; cancelled: boolean; error: string | null }

/** One key in a menu (pure, so it is tested without a terminal). */
export function menuKey(st: MenuState, key: { name?: string; ctrl?: boolean; sequence?: string }, count: number, multi: boolean): MenuState {
  const s: MenuState = { ...st, chosen: new Set(st.chosen), error: null }
  if (key.ctrl && key.name === 'c') return { ...s, cancelled: true }
  if (key.name === 'up' || key.name === 'k') s.cursor = (s.cursor - 1 + count) % count
  else if (key.name === 'down' || key.name === 'j' || key.name === 'tab') s.cursor = (s.cursor + 1) % count
  else if (key.name === 'space' && multi) { if (s.chosen.has(s.cursor)) s.chosen.delete(s.cursor); else s.chosen.add(s.cursor) }
  else if (key.name === 'return' || key.name === 'enter') {
    if (multi && s.chosen.size === 0) s.error = 'Choose at least one (space).'
    else s.done = true
  } else if (key.sequence && /^[1-9]$/.test(key.sequence)) {
    const i = Number(key.sequence) - 1
    if (i < count) { s.cursor = i; if (multi) { if (s.chosen.has(i)) s.chosen.delete(i); else s.chosen.add(i) } }
  }
  return s
}

export function menuLines<T extends string>(p: Paint, title: string, help: string | null, options: Array<Option<T>>, st: MenuState, multi: boolean): string[] {
  const labelW = Math.max(...options.map((o) => visible(o.label))) + 2
  const lines = [p.bold(p.ink(title)), '']
  options.forEach((o, i) => {
    const here = i === st.cursor
    const mark = multi ? (st.chosen.has(i) ? p.acid('[x]') : p.dim('[ ]')) : (here ? p.acid('●') : p.dim('○'))
    const arrow = here ? p.acid('❯') : ' '
    const label = here ? p.ink(pad(o.label, labelW)) : p.dim(pad(o.label, labelW))
    lines.push(`${arrow} ${mark} ${label}${o.detail ? p.dim(o.detail) : ''}`)
  })
  if (help) lines.push('', p.dim(help))
  if (st.error) lines.push('', p.rust(st.error))
  return lines
}

/** Draws, redraws in place, and clears a block of lines. */
export class Live {
  private shown = 0
  constructor(private readonly out: NodeJS.WriteStream = process.stdout) {}
  draw(text: string): void {
    const cols = this.out.columns || 100
    const rows = text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(visible(l) / cols)), 0)
    this.clear()
    this.out.write(`${text}\n`)
    this.shown = rows
  }
  clear(): void {
    if (this.shown > 0) this.out.write(`\x1b[${this.shown}A\x1b[0J`)
    this.shown = 0
  }
}

/** Reads keys until the menu is answered. Resolves to the chosen indexes. */
export function runMenu(render: (st: MenuState) => string, count: number, multi: boolean, initial: MenuState): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const input = process.stdin
    const live = new Live()
    let st = initial
    emitKeypressEvents(input)
    input.setRawMode?.(true)
    input.resume()
    process.stdout.write('\x1b[?25l')
    live.draw(render(st))
    const finish = (): void => {
      input.off('keypress', onKey)
      input.setRawMode?.(false)
      input.pause()
      process.stdout.write('\x1b[?25h')
      live.clear()
    }
    const onKey = (_s: string, key: { name?: string; ctrl?: boolean; sequence?: string } | undefined): void => {
      st = menuKey(st, key ?? {}, count, multi)
      if (st.cancelled) { finish(); reject(new Error('Setup stopped. Nothing after the last answered step was saved.')); return }
      if (st.done) { finish(); resolve(multi ? [...st.chosen].sort((a, b) => a - b) : [st.cursor]); return }
      live.draw(render(st))
    }
    input.on('keypress', onKey)
  })
}

// ── TermC: the finish ──────────────────────────────────────────────────────

export interface Check { status: 'ok' | 'warn' | 'fail'; title: string; fix?: string }

/** The QR code of an address (light quiet zone, for dark terminals). */
export const qrOf = (text: string): string[] => renderUnicodeCompact(text, { border: 1 }).split('\n')

export function finish(p: Paint, o: {
  headline: string
  url: string | null
  facts: Array<[string, string]>
  checks: Check[]
  tip: string | null
  next: string | null
  /** The terminal's width: long values are cut to it, never wrapped into the next column. */
  width?: number
}): string {
  const W = Math.max(60, o.width ?? 100)
  const out: string[] = ['', `${p.badge(' DONE ')}  ${p.ink(p.bold(o.headline))}`, '']
  const factLines = o.facts.map(([k, v]) => `${p.dim(pad(k, 13))}${v.startsWith('◆') ? p.acid(v) : p.ink(v)}`)
  if (o.url) {
    const qr = qrOf(o.url).map((l) => (p.on ? p.ink(l) : l))
    const caption = p.dim('scan with your phone')
    const right = [`${p.dim(pad('open', 13))}${p.acid(o.url)}`, ...factLines]
    const rows = Math.max(qr.length + 1, right.length)
    const qrW = visible(qr[0] ?? '')
    const rightW = W - qrW - 7
    for (let i = 0; i < rows; i++) {
      const left = i < qr.length ? qr[i]! : i === qr.length ? pad(caption, qrW) : ' '.repeat(qrW)
      out.push(`  ${pad(left, qrW)}    ${clip(right[i] ?? '', rightW)}`)
    }
  } else {
    out.push(...factLines.map((l) => `  ${clip(l, W - 3)}`))
  }
  if (o.checks.length) {
    out.push('', `  ${p.bold(p.ink('krnl0 doctor'))}`)
    const mark = (c: Check): string => (c.status === 'ok' ? p.acid('✓') : c.status === 'warn' ? p.rust('!') : p.rust('✗'))
    const oks = o.checks.filter((c) => c.status === 'ok')
    const rest = o.checks.filter((c) => c.status !== 'ok')
    // TermC's two columns while every line is short; one column otherwise.
    const col = Math.floor((W - 4) / 2)
    const two = oks.every((c) => visible(c.title) + 2 <= col - 2)
    if (two) for (let i = 0; i < oks.length; i += 2) out.push(`  ${pad(`${mark(oks[i]!)} ${p.ink(oks[i]!.title)}`, col)}${oks[i + 1] ? `${mark(oks[i + 1]!)} ${p.ink(oks[i + 1]!.title)}` : ''}`)
    else for (const c of oks) out.push(`  ${clip(`${mark(c)} ${p.ink(c.title)}`, W - 3)}`)
    for (const c of rest) {
      out.push(`  ${clip(`${mark(c)} ${p.ink(c.title)}`, W - 3)}`)
      if (c.fix) out.push(`    ${clip(p.dim(`→ ${c.fix}`), W - 5)}`)
    }
  }
  if (o.tip) out.push('', `  ${p.dim(o.tip)}`)
  if (o.next) out.push('', `  ${o.next}`)
  out.push('')
  return out.join('\n')
}

/** `krnl0 doctor` in colour (plain off a terminal). */
export function formatChecksColored(p: Paint, checks: Check[]): string {
  const lines = checks.map((c) => {
    const mark = c.status === 'ok' ? p.acid('✓') : c.status === 'warn' ? p.rust('!') : p.rust('✗')
    return `${mark} ${p.ink(c.title)}${c.fix ? `\n  ${p.dim('→ ' + c.fix)}` : ''}`
  })
  const fails = checks.filter((c) => c.status === 'fail').length
  const warns = checks.filter((c) => c.status === 'warn').length
  lines.push('', fails === 0 && warns === 0 ? p.acid('Everything looks good.') : p.rust(`${fails} problem(s), ${warns} warning(s).`))
  return lines.join('\n')
}
