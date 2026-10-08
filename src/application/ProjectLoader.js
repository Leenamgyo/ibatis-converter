import fs from 'node:fs';
import path from 'node:path';
import { SKIPPED_DIRECTORIES, decodeXml, classifyXml, SKIP_REASONS } from './mapperDetection.js';

/**
 * Recursively finds every `.xml` file under `rootDir`, not descending into
 * build output / tool directories (target/, build/, node_modules/, .git/ ...).
 * Maven's target/classes holds a copy of every mapper; reading it too
 * would register every namespace twice.
 */
export function findXmlFiles(rootDir) {
  const results = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skip it, keep scanning
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) stack.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.xml')) {
        results.push(full);
      }
    }
  }
  return results.sort();
}

/**
 * Scans a project folder for iBATIS mappers.
 *
 * @param {string} rootDir
 * @param {{ maxFileBytes?: number }} [options]
 * @returns {{
 *   rootDir: string,
 *   mappers: { sourceFile: string, source: string, encoding: string, path: string }[],
 *   skipped: { sourceFile: string, kind: string, reason: string }[],
 * }} `sourceFile` is relative to rootDir with forward slashes (stable across machines);
 *    `path` is the absolute path
 */
export function scanProject(rootDir, { maxFileBytes = 20 * 1024 * 1024 } = {}) {
  const root = path.resolve(rootDir);
  const mappers = [];
  const skipped = [];
  for (const file of findXmlFiles(root)) {
    const sourceFile = path.relative(root, file).split(path.sep).join('/');
    let bytes;
    try {
      const { size } = fs.statSync(file);
      if (size > maxFileBytes) {
        skipped.push({ sourceFile, kind: 'TOO_LARGE', reason: `${Math.round(size / 1024 / 1024)}MB — ${Math.round(maxFileBytes / 1024 / 1024)}MB 초과` });
        continue;
      }
      bytes = fs.readFileSync(file);
    } catch (e) {
      skipped.push({ sourceFile, kind: 'UNREADABLE', reason: e.message });
      continue;
    }
    const { text, encoding } = decodeXml(bytes);
    const kind = classifyXml(text);
    if (kind === 'IBATIS_MAPPER') mappers.push({ sourceFile, source: text, encoding, path: file });
    else skipped.push({ sourceFile, kind, reason: SKIP_REASONS[kind] });
  }
  return { rootDir: root, mappers, skipped };
}

/**
 * Reads every iBATIS mapper under `rootDir` into `{ sourceFile, source }` pairs
 * (non-mapper XML is left out; see scanProject for the list of what was skipped).
 */
export function loadMapperFiles(rootDir) {
  return scanProject(rootDir).mappers.map(({ sourceFile, source }) => ({ sourceFile, source }));
}
