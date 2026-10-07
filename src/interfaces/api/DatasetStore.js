import fs from 'node:fs';
import path from 'node:path';

/**
 * Schema-migration datasets (named mapping definitions), one JSON file per
 * dataset in `dir`. Plain files because this is a single-user local tool:
 * they survive a server restart, can be diffed, and can be committed next
 * to the mappers they describe.
 *
 *   { id, name, description, mapping, createdAt, updatedAt }
 */
export class DatasetStore {
  constructor(dir) {
    this.dir = dir;
  }

  static isValidId(id) {
    return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id);
  }

  #file(id) {
    return path.join(this.dir, `${id}.json`);
  }

  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => this.get(f.slice(0, -5)))
      .filter(Boolean)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id) {
    if (!DatasetStore.isValidId(id)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.#file(id), 'utf8'));
    } catch {
      return null;
    }
  }

  save(id, { name, description = '', mapping }) {
    const now = new Date().toISOString();
    const existing = this.get(id);
    const dataset = { id, name: name || id, description, mapping, createdAt: existing?.createdAt ?? now, updatedAt: now };
    fs.mkdirSync(this.dir, { recursive: true });
    // write-then-rename, so a crash mid-write never leaves half a dataset
    const tmp = `${this.#file(id)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(dataset, null, 2)}\n`);
    fs.renameSync(tmp, this.#file(id));
    return dataset;
  }

  delete(id) {
    if (!this.get(id)) return false;
    fs.unlinkSync(this.#file(id));
    return true;
  }
}
