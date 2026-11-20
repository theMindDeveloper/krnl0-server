import { describe, expect, it } from 'vitest'
import { configProblems, envOverrides, resolveConfig } from '../src/config.js'
import { parseArgs } from '../src/cli/main.js'

describe('config (F1, F7, F19)', () => {
  it('defaults: both switches on, self-signed, port 8443', () => {
    const c = resolveConfig({})
    expect(c).toMatchObject({ website: true, appSync: true, port: 8443, bind: '0.0.0.0', httpPort: null, tls: { mode: 'self-signed' }, backupsKept: 14 })
  })

  it('environment beats the file', () => {
    const c = resolveConfig({ website: true, port: 9000 }, envOverrides({ KRNL0_WEBSITE: 'off', KRNL0_PORT: '7443', KRNL0_HOSTS: '192.168.1.20, nas.local', TZ: 'Europe/Berlin' }))
    expect(c.website).toBe(false)
    expect(c.port).toBe(7443)
    expect(c.hosts).toEqual(['192.168.1.20', 'nas.local'])
    expect(c.timeZone).toBe('Europe/Berlin')
  })

  it('proxy mode listens on 127.0.0.1 by default', () => {
    expect(resolveConfig({ tls: { mode: 'proxy' } }).bind).toBe('127.0.0.1')
  })

  it('names the problems in plain words', () => {
    expect(configProblems(resolveConfig({ website: false, appSync: false }))[0]).toMatch(/at least one/)
    expect(configProblems(resolveConfig({ tls: { mode: 'files' } }))[0]).toMatch(/certificate and a key/)
    expect(configProblems(resolveConfig({ timeZone: 'Mars/Olympus' }))[0]).toMatch(/time zone/)
  })

  it('refuses unknown settings and bad switches', () => {
    expect(() => envOverrides({ KRNL0_WEBSITE: 'maybe' })).toThrow(/on\/off/)
    expect(() => resolveConfig(JSON.parse('{}'), envOverrides({ KRNL0_TLS: 'acme' }))).toThrow()
  })
})

describe('krnl0 arguments', () => {
  it('reads commands and flags', () => {
    const p = parseArgs(['setup', '--website', 'off', '--tls=proxy', '--password-stdin', '--data', '/srv/k'])
    expect(p.args).toEqual(['setup'])
    expect(p.flags.get('website')).toBe('off')
    expect(p.flags.get('tls')).toBe('proxy')
    expect(p.flags.get('password-stdin')).toBe(true)
    expect(p.flags.get('data')).toBe('/srv/k')
  })
})
