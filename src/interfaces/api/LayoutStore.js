import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Saved lineage-graph layouts: per statement, the offsets the user dragged
 * boxes and lanes by, plus the zoom / pan. One JSON file per statement in
 * `dir`, named by a hash of the statement id, so no id ever decides a path.
 *
 *   { key, sourceFile, offsets: { [layoutKey]: [dx, dy] }, view: { scale, tx, ty } | null, engine, updatedAt }
 *
 * engine: which version of the graph layout the offsets are relative to (1 when saved before
 * it existed); the UI applies only its own.
 *
 * Only offsets are stored, never absolute positions: the browser still
 * lays the graph out, so a layout saved before a mapper changed degrades to
 * "the boxes that still exist keep their nudge".
 */
export class LayoutStore {
  constructor(dir) {
    this.dir = dir;
  }

  #file(key) {
    return path.join(this.dir, `${createHash('sha256').update(key).digest('hex').slice(0, 40)}.json`);
  }

  get(key) {
    try {
      const layout = JSON.parse(fs.readFileSync(this.#file(key), 'utf8'));
      return layout.key === key ? { engine: 1, ...layout } : null;
    } catch {
      return null;
    }
  }

  save(key, { sourceFile = null, offsets, view = null, engine = 1 }) {
    const layout = { key, sourceFile, offsets, view, engine, updatedAt: new Date().toISOString() };
    fs.mkdirSync(this.dir, { recursive: true });
    // write-then-rename, so a crash mid-write never leaves half a layout
    const file = this.#file(key);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(layout, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return layout;
  }

  delete(key) {
    if (!this.get(key)) return false;
    fs.unlinkSync(this.#file(key));
    return true;
  }
}

const MAX_OFFSETS = 5000;
const finite = (n, limit) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= limit;

/** null when the body is a valid layout, otherwise what is wrong with it */
export function layoutError(body) {
  const { offsets, view = null, sourceFile = null } = body ?? {};
  if (!offsets || typeof offsets !== 'object' || Array.isArray(offsets)) return 'offsets: an object { layoutKey: [dx, dy] }';
  const entries = Object.entries(offsets);
  if (entries.length > MAX_OFFSETS) return `offsets: at most ${MAX_OFFSETS} entries`;
  for (const [k, v] of entries) {
    if (k.length > 400) return 'offsets: key too long';
    if (!Array.isArray(v) || v.length !== 2 || !finite(v[0], 1e6) || !finite(v[1], 1e6)) return `offsets.${k}: [dx, dy] numbers`;
  }
  if (view !== null && (typeof view !== 'object' || !finite(view.scale, 10) || view.scale <= 0 || !finite(view.tx, 1e7) || !finite(view.ty, 1e7))) {
    return 'view: { scale, tx, ty } numbers';
  }
  if (sourceFile !== null && typeof sourceFile !== 'string') return 'sourceFile: a string';
  if (body.engine !== undefined && !(Number.isInteger(body.engine) && body.engine > 0 && body.engine < 1000)) return 'engine: a positive integer';
  return null;
}
