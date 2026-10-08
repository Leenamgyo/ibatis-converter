import fs from 'node:fs';
import path from 'node:path';
import { IGNORED_DIRECTORIES, BUILD_DIRECTORY_NAMES, decodeXml, classifyXml, SKIP_REASONS } from './mapperDetection.js';

/**
 * Recursively finds every `.xml` file under `rootDir`, not descending into
 * build output / tool directories (target/, build/, node_modules/, .git/ ...).
 * Maven's target/classes holds a copy of every mapper; reading it too
 * would register every namespace twice.
 */
export function findXmlFiles(rootDir, { skipBuildDirectories = false } = {}) {
  const results = [];
  const stack = [rootDir];
  // symlinked folders are followed (a shared checkout linked into the project), each real folder once
  const visited = new Set();
  while (stack.length > 0) {
    const dir = stack.pop();
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (visited.has(real)) continue;
    visited.add(real);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skip it, keep scanning
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const target = fs.statSync(full);
          isDir = target.isDirectory();
          isFile = target.isFile();
        } catch {
          continue; // dangling link
        }
      }
      if (isDir) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        if (skipBuildDirectories && BUILD_DIRECTORY_NAMES.has(entry.name)) continue;
        stack.push(full);
      } else if (isFile && entry.name.toLowerCase().endsWith('.xml')) {
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
  // the reference pipeline keeps the old name rule; ProjectSession reads build-named folders and drops copies by content
  for (const file of findXmlFiles(root, { skipBuildDirectories: true })) {
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
