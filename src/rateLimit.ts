/** The most keys a limiter tracks at once unless it is told otherwise. */
export const DEFAULT_MAX_KEYS = 10_000;

/**
 * An in-memory sliding-window limiter: at most `max` recorded hits per key within
 * `windowMs`. State lives in this process only, which is fine for one server.
 * Times are milliseconds and default to the current time.
 *
 * Memory is bounded. A key remembers at most its last `max` hits, and the limiter holds
 * at most `maxKeys` keys. The map is kept in order of each key's latest hit (a key that
 * records again moves to the back), so the front is always the key that was active longest
 * ago: record() drops the keys at the front whose hits have all aged out, then, if the map
 * is still over `maxKeys`, evicts further keys from the front. Every key is removed at most
 * once, so that work is O(1) amortized per record. An evicted key starts again from zero,
 * so under a flood of distinct keys the oldest are forgotten first.
 */
export function createRateLimiter(max: number, windowMs: number, maxKeys = DEFAULT_MAX_KEYS) {
  const hits = new Map<string, number[]>();
  const cap = Math.max(1, maxKeys);

  function recent(key: string, at: number): number[] {
    const list = (hits.get(key) ?? []).filter((t) => t > at - windowMs);
    if (list.length > 0) hits.set(key, list);
    else hits.delete(key);
    return list;
  }

  /** Forgets expired keys, then the least recently active ones, until at most `cap` remain. */
  function trim(at: number): void {
    for (const [key, list] of hits) {
      const expired = list[list.length - 1] <= at - windowMs;
      if (!expired && hits.size <= cap) return;
      hits.delete(key);
    }
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
      const list = recent(key, at);
      list.push(at);
      if (list.length > max) list.splice(0, list.length - max);
      // Delete and set again so the key moves to the back of the map.
      hits.delete(key);
      hits.set(key, list);
      trim(at);
    },
    /** How many keys are tracked right now. */
    size(): number {
      return hits.size;
    },
  };
}
