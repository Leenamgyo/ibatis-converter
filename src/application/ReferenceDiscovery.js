import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findXmlFiles } from './ProjectLoader.js';
import { classifyHead, decodeXml, HEAD_BYTES } from './mapperDetection.js';
import { ProjectSession, DirectorySource, ReferencedSource } from './ProjectSession.js';

/**
 * Finds, OUTSIDE the opened folder, the mapper files that define the `<sql>`
 * fragments its refids name but it doesn't contain. A module of a multi-module
 * project includes fragments of a common module next to it; MyBatis finds them
 * on the classpath (`classpath*:mapper/**\/*.xml`), the opened folder alone
 * doesn't have them.
 *
 * Where: the repository the folder belongs to — the nearest ancestor holding
 * `.git`, else the top-most ancestor (up to 4 levels) with a pom.xml /
 * build.gradle / settings.gradle (a multi-module build). NEVER a plain parent
 * folder: `~/projects/*` holds unrelated projects, whose `paging` is not this
 * project's. No such ancestor -> no search.
 * What: only files that DEFINE something missing — a qualified refid's
 * namespace (read from the file's head), or a bare refid's `<sql id>` (read
 * from its text) defined by exactly ONE file there. Nothing else is parsed.
 *
 * @param {string} rootDir the opened folder
 * @param {{ refid: string }[]} missing the session's unresolved includes
 * @returns {{ repoRoot: string, files: string[], scanned: number }} absolute paths
 */
export function findReferenceMappers(rootDir, missing, { maxFiles = 50000 } = {}) {
  const root = path.resolve(rootDir);
  const repoRoot = repositoryRoot(root);
  const result = { repoRoot, files: [], scanned: 0 };
  if (!missing.length || !repoRoot || repoRoot === root) return result;

  const namespaces = new Set();
  const bareIds = new Set();
  for (const { refid } of missing) {
    if (refid.includes('.')) namespaces.add(refid.slice(0, refid.lastIndexOf('.')));
    else bareIds.add(refid);
  }
  const bareDefiners = new Map(); // bare id -> files defining it
  const definesBare = bareIds.size
    ? new RegExp(`<sql\\b[^>]*\\bid\\s*=\\s*["'](${[...bareIds].map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})["']`)
    : null;

  for (const file of findXmlFiles(repoRoot)) {
    if (file === root || file.startsWith(root + path.sep)) continue; // the project itself
    if (++result.scanned > maxFiles) break;
    let head;
    try {
      const fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(HEAD_BYTES);
      const n = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
      fs.closeSync(fd);
      head = buffer.subarray(0, n);
    } catch {
      continue;
    }
    const kind = classifyHead(head, head.length < HEAD_BYTES);
    if (kind !== null && kind !== 'IBATIS_MAPPER' && kind !== 'MYBATIS_MAPPER') continue;
    const namespace = /<(?:sqlMap|mapper)\b[^>]*\bnamespace\s*=\s*["']([^"']+)["']/.exec(decodeXml(head).text)?.[1];
    if (namespace && namespaces.has(namespace)) {
      result.files.push(file);
      continue;
    }
    if (definesBare) {
      try {
        const text = decodeXml(fs.readFileSync(file)).text;
        for (const id of bareIds) {
          if (new RegExp(`<sql\\b[^>]*\\bid\\s*=\\s*["']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`).test(text)) {
            (bareDefiners.get(id) ?? bareDefiners.set(id, []).get(id)).push(file);
          }
        }
      } catch { /* unreadable: skip */ }
    }
  }
  // a bare id is taken from outside only when ONE file there defines it (else: ambiguous, not guessed)
  for (const files of bareDefiners.values()) if (files.length === 1 && !result.files.includes(files[0])) result.files.push(files[0]);
  return result;
}

/** the repository a folder belongs to (see findReferenceMappers) */
export function repositoryRoot(dir) {
  const has = (d, names) => names.some((n) => fs.existsSync(path.join(d, n)));
  let gitRoot = null;
  let buildRoot = null;
  let current = dir;
  for (let up = 0; up <= 6; up++) {
    if (has(current, ['.git'])) {
      gitRoot = current;
      break;
    }
    if (up <= 4 && has(current, ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'])) buildRoot = current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const found = gitRoot ?? (buildRoot && buildRoot !== dir ? buildRoot : null);
  // never the home folder or the filesystem root (a dotfiles repo at ~ is not "the project's repository")
  if (!found || found === os.homedir() || found === path.parse(found).root) return null;
  return found;
}

/**
 * Opens a project folder; when refids are left unresolved, looks for their
 * fragments outside the folder (findReferenceMappers) and reopens with them
 * as external reference files — up to 3 rounds, since a fragment found
 * outside may include yet another one.
 * @returns {{ session: import('./ProjectSession.js').ProjectSession, references: { repoRoot: string|null, files: string[], scanned: number } }}
 */
export function openProjectFolder(dir, options = {}, { lookOutside = true } = {}) {
  let session = new ProjectSession(new DirectorySource(dir), options).open();
  const references = { repoRoot: null, files: [], scanned: 0 };
  for (let round = 0; lookOutside && round < 3 && session.meta.missingIncludes.length; round++) {
    const found = findReferenceMappers(dir, session.meta.missingIncludes);
    references.repoRoot = found.repoRoot;
    references.scanned += found.scanned;
    const fresh = found.files.filter((f) => !references.files.includes(f));
    if (!fresh.length) break;
    references.files.push(...fresh);
    session.close();
    session = new ProjectSession(new ReferencedSource(dir, references.files), options).open();
  }
  return { session, references };
}
