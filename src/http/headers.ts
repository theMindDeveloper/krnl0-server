// Security headers on every response (NF5).

import type { ServerResponse } from 'node:http'

/** Video embeds the KRNL0 media card can show (react-player). The owner adds these links themselves. */
export const EMBED_SOURCES = [
  'https://www.youtube-nocookie.com',
  'https://www.youtube.com',
  'https://player.vimeo.com',
]

export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // React and the canvas set inline styles; scripts stay strict.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  `frame-src ${EMBED_SOURCES.join(' ')}`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

/** An uploaded file is never active content in our origin (threat model: hostile board content). */
export const ASSET_CSP = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox"

export function securityHeaders(res: ServerResponse, opts: { hsts: boolean }): void {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=(), payment=(), usb=(), interest-cohort=()')
  res.setHeader('Content-Security-Policy', PAGE_CSP)
  if (opts.hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000')
  res.removeHeader('X-Powered-By')
}
