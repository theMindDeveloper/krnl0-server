// The terminal look (Decision S8, the owner's mix of TermA/B/C).
import { describe, expect, it } from 'vitest'
import { box, doneStep, finish, formatChecksColored, header, keysLine, menuKey, menuLines, paint, pendingSteps, qrOf, visible, type MenuState } from '../src/cli/look.js'
import { addressChoices } from '../src/cli/setup.js'

const plain = paint(false)
const color = paint(true)
const start = (cursor = 0, chosen: number[] = []): MenuState => ({ cursor, chosen: new Set(chosen), done: false, cancelled: false, error: null })

describe('menus by keys', () => {
  it('moves with the arrows and wraps around', () => {
    let s = start()
    s = menuKey(s, { name: 'down' }, 3, false)
    s = menuKey(s, { name: 'down' }, 3, false)
    s = menuKey(s, { name: 'down' }, 3, false)
    expect(s.cursor).toBe(0)
    s = menuKey(s, { name: 'up' }, 3, false)
    expect(s.cursor).toBe(2)
  })
  it('space chooses in a checklist; enter needs at least one', () => {
    let s = start(0, [])
    s = menuKey(s, { name: 'return' }, 2, true)
    expect(s.done).toBe(false)
    expect(s.error).toMatch(/at least one/)
    s = menuKey(s, { name: 'space' }, 2, true)
    s = menuKey(s, { name: 'return' }, 2, true)
    expect(s.done).toBe(true)
    expect([...s.chosen]).toEqual([0])
  })
  it('a number picks that line; Ctrl+C stops', () => {
    expect(menuKey(start(), { sequence: '2' }, 3, false).cursor).toBe(1)
    expect(menuKey(start(), { name: 'c', ctrl: true }, 3, false).cancelled).toBe(true)
  })
})

describe('what it draws', () => {
  it('TermA: the block letters with version and step', () => {
    const h = header(plain, 'server setup', '0.2.0', { n: 1, of: 4 })
    expect(h).toContain('█▄▀ █▀█')
    expect(h).toContain('server setup · 0.2.0')
    expect(h).toContain('step 1 of 4')
  })
  it('TermA: a box keeps every line inside, also coloured ones', () => {
    const lines = box(color, [color.acid('a fairly long line that has to be cut to fit the box at all costs, really'), 'short'], 40).split('\n')
    expect(new Set(lines.map(visible)).size).toBe(1)
  })
  it('a checklist shows its marks and the cursor', () => {
    const l = menuLines(plain, 'What should this server do?', null, [{ value: 'w', label: 'Website' }, { value: 'a', label: 'App sync' }], start(1, [0]), true)
    expect(l.join('\n')).toContain('[x] Website')
    expect(l.join('\n')).toContain('❯ [ ] App sync')
  })
  it('TermB: answered steps with their answer, then the rest', () => {
    expect(doneStep(plain, { title: 'Encryption', answer: 'Nothing to set up' })).toBe('◆  Encryption\n│  Nothing to set up\n│')
    expect(pendingSteps(plain, ['Time zone', 'Owner password'])).toBe('○  Time zone\n○  Owner password')
    expect(keysLine(plain, 2, 4, 'enter next')).toBe('●●●●  step 2 of 4   enter next')
  })
  it('TermC: DONE, a QR code of the address, the facts and the checks', () => {
    const f = finish(plain, {
      headline: 'KRNL0 server is set up',
      url: 'https://192.168.1.20:8443',
      facts: [['website', '◆ on'], ['time zone', 'Europe/Berlin']],
      checks: [{ status: 'ok', title: 'owner account set' }, { status: 'warn', title: 'two-factor codes are off', fix: 'krnl0 2fa enable' }],
      tip: 'First visit in a browser: it warns once.',
      next: null,
    })
    expect(f).toContain('[DONE]  KRNL0 server is set up')
    expect(f).toContain('https://192.168.1.20:8443')
    expect(f).toContain('scan with your phone')
    expect(f).toContain('✓ owner account set')
    expect(f).toContain('! two-factor codes are off')
    expect(f).toContain('→ krnl0 2fa enable')
    expect(qrOf('https://192.168.1.20:8443').length).toBeGreaterThan(10)
  })
  it('off a terminal there are no colour codes at all', () => {
    const out = formatChecksColored(plain, [{ status: 'ok', title: 'fine' }])
    expect(out).not.toMatch(/\x1b\[/)
    expect(formatChecksColored(color, [{ status: 'ok', title: 'fine' }])).toMatch(/\x1b\[/)
  })
})

describe('the address step', () => {
  it('home network first, Tailscale named, loopback and IPv6 left out; in Docker its own addresses say so', () => {
    const o = addressChoices(['localhost', '127.0.0.1', '::1', 'fe80::1', 'homelab', 'homelab.local', '100.81.4.12', '192.168.1.20'], false)
    expect(o.map((x) => x.value)).toEqual(['192.168.1.20', '100.81.4.12', 'homelab.local', 'homelab'])
    expect(o[0]!.detail).toBe('home network')
    expect(o[1]!.detail).toBe('Tailscale')
    expect(addressChoices(['172.17.0.2'], true)[0]!.detail).toBe('inside Docker only')
  })
})
