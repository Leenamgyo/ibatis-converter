import { randomUUID } from 'node:crypto';

/**
 * The server's open projects. Each is a `ProjectSession` (an index plus
 * bounded caches), not a full analysis result, and it does not live forever:
 *
 * - it closes after `ttlMs` without a request (default 30 min),
 * - opening one more than `maxSessions` closes the least recently used,
 * - `DELETE /api/v1/projects/:id` closes it right away (the UI does so
 *   when it loads another project or the tab closes).
 *
 * Closing a session drops its caches and deletes an upload's temporary
 * directory.
 */
export class SessionManager {
  constructor({ ttlMs = 30 * 60 * 1000, maxSessions = 4, sweepMs = 60 * 1000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.maxSessions = maxSessions;
    this.now = now;
    /** @type {Map<string, { session: import('../../application/ProjectSession.js').ProjectSession, lastUsed: number }>} recency order */
    this.sessions = new Map();
    this.lastId = null;
    this.timer = sweepMs ? setInterval(() => this.sweep(), sweepMs) : null;
    this.timer?.unref?.();
  }

  add(session) {
    const id = randomUUID();
    this.sessions.set(id, { session, lastUsed: this.now() });
    this.lastId = id;
    while (this.sessions.size > this.maxSessions) this.close(this.sessions.keys().next().value);
    return id;
  }

  /** the session (touching it), or undefined; `id` omitted = the most recently opened */
  get(id = this.lastId) {
    const entry = id ? this.sessions.get(id) : undefined;
    if (!entry) return undefined;
    entry.lastUsed = this.now();
    this.sessions.delete(id);
    this.sessions.set(id, entry);
    return entry.session;
  }

  close(id) {
    const entry = this.sessions.get(id);
    if (!entry) return false;
    this.sessions.delete(id);
    if (this.lastId === id) this.lastId = null;
    entry.session.close();
    return true;
  }

  sweep() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, entry] of [...this.sessions]) if (entry.lastUsed < cutoff) this.close(id);
  }

  closeAll() {
    for (const id of [...this.sessions.keys()]) this.close(id);
    if (this.timer) clearInterval(this.timer);
  }
}
