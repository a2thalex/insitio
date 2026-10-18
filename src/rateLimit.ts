/**
 * An in-memory sliding-window limiter: at most `max` recorded hits per key within
 * `windowMs`. State lives in this process only, which is fine for one server.
 * Times are milliseconds and default to the current time.
 */
export function createRateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  // Past this many keys, record() sweeps out keys whose hits have all aged out.
  const SWEEP_AT = 10_000;

  function recent(key: string, at: number): number[] {
    const list = (hits.get(key) ?? []).filter((t) => t > at - windowMs);
    if (list.length > 0) hits.set(key, list);
    else hits.delete(key);
    return list;
  }

  return {
    /** Seconds until `key` may act again; 0 when it is under the limit. */
    retryAfter(key: string, at = Date.now()): number {
      const list = recent(key, at);
      if (list.length < max) return 0;
      return Math.max(1, Math.ceil((list[0] + windowMs - at) / 1000));
    },
    /** Counts one hit against `key`. */
    record(key: string, at = Date.now()): void {
      if (hits.size >= SWEEP_AT) for (const k of [...hits.keys()]) recent(k, at);
      hits.set(key, [...recent(key, at), at]);
    },
  };
}
