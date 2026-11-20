import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** 256 random bits, URL-safe. */
export const randomToken = (prefix = ''): string => prefix + randomBytes(32).toString('base64url')

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

// Setup code alphabet: no 0/O, 1/I/L — easy to read from a log and type.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/** Unbiased random characters from the code alphabet. */
function codeChars(n: number): string {
  let raw = ''
  for (let i = 0; i < n; i++) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return raw
}

/** "ABCD-EFGH-JK": 10 characters, ~49 bits. */
export function newSetupCode(): string {
  const raw = codeChars(10)
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`
}

export const normalizeSetupCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, '')

/** "7GQK-2MDP" style one-time recovery codes (~39 bits each). */
export function newRecoveryCode(): string {
  const raw = codeChars(8)
  return `${raw.slice(0, 4)}-${raw.slice(4)}`
}
