// Small in-memory limiters, keyed by client IP. They protect activation and
// trial endpoints from key guessing; a restart simply resets them.
export class SlidingCounter {
  constructor({ limit, windowSeconds, now = () => Date.now() / 1000 }) {
    this.limit = limit;
    this.window = windowSeconds;
    this.now = now;
    this.hits = new Map();
  }

  recent(key) {
    const cutoff = this.now() - this.window;
    const list = (this.hits.get(key) || []).filter((t) => t > cutoff);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  isBlocked(key) {
    return this.recent(key).length >= this.limit;
  }

  record(key) {
    const list = this.recent(key);
    list.push(this.now());
    this.hits.set(key, list);
    if (this.hits.size > 50_000) this.sweep();
  }

  // Counts the hit and reports whether the key is now over the limit.
  hit(key) {
    this.record(key);
    return this.recent(key).length > this.limit;
  }

  sweep() {
    for (const key of [...this.hits.keys()]) this.recent(key);
  }
}
