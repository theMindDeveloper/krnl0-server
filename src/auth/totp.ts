// TOTP two-factor codes (F3): RFC 6238, SHA-1, 6 digits, 30 seconds — what
// every authenticator app understands.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export const STEP_SECONDS = 30

export function base32Encode(buf: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = B32.indexOf(ch)
    if (idx < 0) throw new Error('Not a base32 secret')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

export function stepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS)
}

export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f
  const bin = ((mac[offset] ?? 0) & 0x7f) << 24 | (mac[offset + 1] ?? 0) << 16 | (mac[offset + 2] ?? 0) << 8 | (mac[offset + 3] ?? 0)
  return String(bin % 1_000_000).padStart(6, '0')
}

/**
 * The step a code matches (now ±1 step for clock drift), or null. A step at or
 * before `lastStep` is refused, so a code cannot be used twice.
 */
export function matchTotp(secret: string, code: string, nowMs: number, lastStep: number | null): number | null {
  const clean = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(clean)) return null
  const now = stepAt(nowMs)
  for (const step of [now - 1, now, now + 1]) {
    if (lastStep !== null && step <= lastStep) continue
    const expected = Buffer.from(totpCode(secret, step))
    if (timingSafeEqual(expected, Buffer.from(clean))) return step
  }
  return null
}

export function otpauthUri(secret: string, account: string, issuer = 'KRNL0'): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`
}
