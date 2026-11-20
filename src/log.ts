// Plain log lines on stdout/stderr (NF7: never board content, passwords,
// tokens, session ids; the setup-code banner is the one deliberate exception).

type Level = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

let threshold: number = ORDER[(process.env.KRNL0_LOG_LEVEL as Level | undefined) ?? 'info'] ?? ORDER.info
let silent = false

export function setLogSilent(on: boolean): void { silent = on }
export function setLogLevel(level: Level): void { threshold = ORDER[level] }

function emit(level: Level, msg: string, fields?: Record<string, string | number | boolean | null | undefined>): void {
  if (silent || ORDER[level] < threshold) return
  const extra = fields
    ? ' ' + Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${String(v)}`).join(' ')
    : ''
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${extra}`
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n')
  else process.stdout.write(line + '\n')
}

export const log = {
  debug: (msg: string, fields?: Record<string, string | number | boolean | null | undefined>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, string | number | boolean | null | undefined>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, string | number | boolean | null | undefined>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, string | number | boolean | null | undefined>) => emit('error', msg, fields),
  /** A block printed as-is (banners). Not affected by the level. */
  block: (text: string) => { if (!silent) process.stdout.write(text.endsWith('\n') ? text : text + '\n') },
}
