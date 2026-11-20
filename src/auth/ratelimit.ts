// Rate limits (F4). In memory: a restart clears them, which a remote attacker
// cannot cause.

export class WindowLimiter {
  private hits = new Map<string, number[]>()

  constructor(private readonly max: number, private readonly windowMs: number) {}

  /** Records an attempt; false when the key is over its limit. */
  take(key: string, now = Date.now()): boolean {
    const since = now - this.windowMs
    const list = (this.hits.get(key) ?? []).filter((t) => t > since)
    if (list.length >= this.max) {
      this.hits.set(key, list)
      return false
    }
    list.push(now)
    this.hits.set(key, list)
    if (this.hits.size > 10_000) this.prune(now)
    return true
  }

  private prune(now: number): void {
    const since = now - this.windowMs
    for (const [k, list] of this.hits) {
      if (!list.some((t) => t > since)) this.hits.delete(k)
    }
  }
}

/** After `freeFailures` wrong passwords in a row, wait 1 minute, doubling to 1 hour. */
export class AccountBackoff {
  private failures = 0
  private lockedUntil = 0

  constructor(
    private readonly freeFailures = 5,
    private readonly baseMs = 60_000,
    private readonly maxMs = 3_600_000,
  ) {}

  /** Milliseconds left to wait, 0 when a try is allowed. */
  waitMs(now = Date.now()): number {
    return Math.max(0, this.lockedUntil - now)
  }

  fail(now = Date.now()): void {
    this.failures += 1
    if (this.failures >= this.freeFailures) {
      const n = this.failures - this.freeFailures
      const delay = Math.min(this.maxMs, this.baseMs * 2 ** n)
      this.lockedUntil = now + delay
    }
  }

  succeed(): void {
    this.failures = 0
    this.lockedUntil = 0
  }
}
