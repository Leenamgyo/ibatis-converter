/**
 * Recognising iBATIS mappers inside an arbitrary project, shared by the
 * Node ProjectLoader / CLI and the browser's folder upload — the API server
 * serves this very file at /shared/mapperDetection.js, which is why it must
 * stay free of Node built-ins.
 *
 * A real legacy project's `*.xml` files are mostly not mappers: pom.xml,
 * Spring contexts, sqlMapConfig.xml, log4j, web.xml, sometimes already
 * converted MyBatis mappers. The root element decides:
 *
 *   <sqlMap>          iBATIS 2 mapper            -> analysed
 *   <sqlMapConfig>    iBATIS config              -> skipped
 *   <mapper>          MyBatis 3 mapper           -> skipped (already converted)
 *   <configuration>   MyBatis config             -> skipped
 *   anything else                                -> skipped
 */

/** Build output and tool directories: they hold copies (target/classes/**.xml) or nothing of interest. */
export const SKIPPED_DIRECTORIES = new Set([
  'node_modules', '.git', '.svn', '.hg', '.idea', '.vscode', '.gradle', '.settings',
  'target', 'build', 'dist', 'out', 'bin', 'classes', 'WEB-INF/classes',
]);

/**
 * The charset a `<?xml ... encoding="..."?>` declaration names, from the
 * file's first bytes (ASCII-compatible in every encoding that matters
 * here). Korean legacy mappers are often EUC-KR / MS949.
 * @param {Uint8Array} bytes
 * @returns {string} a TextDecoder label
 */
export function detectXmlEncoding(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return bytes[0] === 0xff ? 'utf-16le' : 'utf-16be';
  let head = '';
  for (let i = 0; i < Math.min(bytes.length, 200); i++) head += String.fromCharCode(bytes[i]);
  const declared = /^\s*<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head)?.[1]?.toLowerCase();
  if (!declared) return 'utf-8';
  // MS949 / CP949 are supersets of EUC-KR; the WHATWG "euc-kr" decoder is in fact windows-949
  if (['ms949', 'cp949', 'x-windows-949', 'ks_c_5601-1987', 'ksc5601'].includes(declared)) return 'euc-kr';
  return declared;
}

/** Decodes a file's bytes using its declared encoding (UTF-8 if none or unknown). */
export function decodeXml(bytes) {
  const label = detectXmlEncoding(bytes);
  let decoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  return { text: decoder.decode(bytes).replace(/^﻿/, ''), encoding: decoder.encoding };
}

/**
 * The root element name of an XML document, skipping the prolog,
 * comments, processing instructions and a DOCTYPE (with or without an
 * internal subset). Null when there is none.
 */
export function rootElementName(text) {
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end === -1) return null;
      i = end + 2;
    } else if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end === -1) return null;
      i = end + 3;
    } else if (text.startsWith('<!DOCTYPE', i) || text.startsWith('<!doctype', i)) {
      let depth = 0;
      let j = i + 9;
      for (; j < n; j++) {
        if (text[j] === '[') depth++;
        else if (text[j] === ']') depth--;
        else if (text[j] === '>' && depth <= 0) break;
      }
      i = j + 1;
    } else if (text[i] === '<') {
      return /^<([A-Za-z_][\w.:-]*)/.exec(text.slice(i, i + 200))?.[1] ?? null;
    } else {
      return null;
    }
  }
  return null;
}

const KIND_BY_ROOT = {
  sqlMap: 'IBATIS_MAPPER',
  sqlMapConfig: 'IBATIS_CONFIG',
  mapper: 'MYBATIS_MAPPER',
  configuration: 'MYBATIS_CONFIG',
};

export const SKIP_REASONS = {
  IBATIS_CONFIG: 'iBATIS 설정 파일 (sqlMapConfig)',
  MYBATIS_MAPPER: '이미 MyBatis 매퍼',
  MYBATIS_CONFIG: 'MyBatis 설정 파일',
  OTHER: 'iBATIS 매퍼가 아님',
  UNREADABLE: '루트 요소를 찾을 수 없음',
};

/** @returns {'IBATIS_MAPPER'|'IBATIS_CONFIG'|'MYBATIS_MAPPER'|'MYBATIS_CONFIG'|'OTHER'|'UNREADABLE'} */
export function classifyXml(text) {
  const root = rootElementName(text);
  if (!root) return 'UNREADABLE';
  return KIND_BY_ROOT[root] ?? 'OTHER';
}

/** Is any segment of this relative path a directory we never descend into? */
export function isInSkippedDirectory(relativePath) {
  const parts = relativePath.split(/[\\/]/).slice(0, -1);
  return parts.some((part, k) => SKIPPED_DIRECTORIES.has(part) || SKIPPED_DIRECTORIES.has(`${parts[k - 1]}/${part}`));
}
