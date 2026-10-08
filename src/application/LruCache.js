/**
 * A small least-recently-used cache, bounded by entry count and (optionally)
 * by an estimated size, so a project's files / ASTs / analyses are kept only
 * while they are being used and dropped when something newer needs the room.
 * No Node built-ins.
 */
export class LruCache {
  /**
   * @param {{ maxEntries?: number, maxSize?: number, sizeOf?: (value: any) => number }} [options]
   */
  constructor({ maxEntries = 100, maxSize = Infinity, sizeOf = () => 1 } = {}) {
    this.maxEntries = maxEntries;
    this.maxSize = maxSize;
    this.sizeOf = sizeOf;
    /** @type {Map<string, { value: any, size: number }>} insertion order = recency */
    this.entries = new Map();
    this.size = 0;
    this.stats = { hits: 0, misses: 0, evictions: 0 };
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) {
      this.stats.misses++;
      return undefined;
    }
    this.stats.hits++;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    const existing = this.entries.get(key);
    if (existing) {
      this.size -= existing.size;
      this.entries.delete(key);
    }
    const size = this.sizeOf(value);
    this.entries.set(key, { value, size });
    this.size += size;
    while (this.entries.size > this.maxEntries || (this.size > this.maxSize && this.entries.size > 1)) {
      const [oldest, entry] = this.entries.entries().next().value;
      this.entries.delete(oldest);
      this.size -= entry.size;
      this.stats.evictions++;
    }
    return value;
  }

  /** the cached value, or `load()` stored and returned */
  getOrLoad(key, load) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    return this.set(key, load());
  }

  clear() {
    this.entries.clear();
    this.size = 0;
  }

  get count() {
    return this.entries.size;
  }
}
