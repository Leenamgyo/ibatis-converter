import { XmlElement, XmlText, XmlDocument } from './XmlElement.js';

/**
 * Small, dependency-free, line-tracking XML tokenizer/parser.
 *
 * It is deliberately hand-rolled (rather than pulling in a DOM library)
 * for two reasons:
 *  1. iBATIS/MyBatis mapper XML is a well-known, well-formed subset of XML
 *     (elements, attributes, text, CDATA, comments, a DOCTYPE we must
 *     ignore rather than fetch over the network) so a focused parser is
 *     both sufficient and easy to reason about.
 *  2. It lets every node carry its originating line number, which the
 *     semantic AST (StatementNode.sourceLine, etc.) and every diagnostic
 *     downstream depend on.
 *
 * Recovery granularity is per-file: a malformed document raises a single
 * XmlParseException that `parseXml` converts into a ParserError and
 * returns `null` for that file's document, so the caller can keep parsing
 * every other mapper in the project.
 */

const NAME_CHARS = /[A-Za-z0-9_.\-:]/;
const NAME_START_CHARS = /[A-Za-z_:]/;
const WHITESPACE = /\s/;

const ENTITY_MAP = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

class XmlParseException extends Error {
  constructor(message, line) {
    super(message);
    this.line = line;
  }
}

class Scanner {
  constructor(source) {
    this.source = source;
    this.pos = 0;
    this.line = 1;
    this.len = source.length;
  }

  eof() {
    return this.pos >= this.len;
  }

  peek(offset = 0) {
    return this.source[this.pos + offset];
  }

  startsWith(str) {
    return this.source.startsWith(str, this.pos);
  }

  advance(n = 1) {
    for (let i = 0; i < n; i++) {
      if (this.pos >= this.len) return;
      if (this.source.charCodeAt(this.pos) === 10 /* \n */) this.line++;
      this.pos++;
    }
  }

  skipWhitespace() {
    while (!this.eof() && WHITESPACE.test(this.peek())) this.advance();
  }

  /** Consumes up to and including `terminator`; throws if EOF is reached first. */
  skipUntil(terminator, contextMessage) {
    const idx = this.source.indexOf(terminator, this.pos);
    if (idx === -1) {
      throw new XmlParseException(`Unterminated ${contextMessage}`, this.line);
    }
    this.advance(idx - this.pos + terminator.length);
  }

  /** Returns everything up to (not including) `terminator`, consuming through it. */
  readUntil(terminator, contextMessage) {
    const idx = this.source.indexOf(terminator, this.pos);
    if (idx === -1) {
      throw new XmlParseException(`Unterminated ${contextMessage}`, this.line);
    }
    const text = this.source.slice(this.pos, idx);
    this.advance(idx - this.pos + terminator.length);
    return text;
  }
}

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const codePoint = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }
    return Object.prototype.hasOwnProperty.call(ENTITY_MAP, body) ? ENTITY_MAP[body] : match;
  });
}

function skipDoctype(scanner) {
  // <!DOCTYPE ... > possibly containing an internal subset in [ ... ] with
  // its own '>' characters, so track bracket depth rather than a naive
  // indexOf('>').
  scanner.advance('<!DOCTYPE'.length);
  let depth = 0;
  while (!scanner.eof()) {
    const ch = scanner.peek();
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    else if (ch === '>' && depth <= 0) {
      scanner.advance();
      return;
    }
    scanner.advance();
  }
  throw new XmlParseException('Unterminated DOCTYPE declaration', scanner.line);
}

function skipDelimited(scanner, startLen, terminator, contextMessage) {
  scanner.advance(startLen);
  scanner.skipUntil(terminator, contextMessage);
}

function parseName(scanner) {
  if (scanner.eof() || !NAME_START_CHARS.test(scanner.peek())) {
    throw new XmlParseException(`Expected a name at this position`, scanner.line);
  }
  const start = scanner.pos;
  while (!scanner.eof() && NAME_CHARS.test(scanner.peek())) scanner.advance();
  return scanner.source.slice(start, scanner.pos);
}

function parseAttributes(scanner) {
  const attributes = {};
  for (;;) {
    scanner.skipWhitespace();
    if (scanner.eof()) throw new XmlParseException('Unterminated start tag', scanner.line);
    if (scanner.peek() === '>' || scanner.startsWith('/>')) return attributes;

    const name = parseName(scanner);
    scanner.skipWhitespace();
    if (scanner.peek() !== '=') {
      throw new XmlParseException(`Expected '=' after attribute "${name}"`, scanner.line);
    }
    scanner.advance();
    scanner.skipWhitespace();
    const quote = scanner.peek();
    if (quote !== '"' && quote !== "'") {
      throw new XmlParseException(`Expected quoted value for attribute "${name}"`, scanner.line);
    }
    scanner.advance();
    const value = scanner.readUntil(quote, `attribute "${name}" value`);
    attributes[name] = decodeEntities(value);
  }
}

function parseText(scanner) {
  const startLine = scanner.line;
  const start = scanner.pos;
  while (!scanner.eof() && scanner.peek() !== '<') scanner.advance();
  const raw = scanner.source.slice(start, scanner.pos);
  return new XmlText(decodeEntities(raw), startLine);
}

function parseElement(scanner) {
  const startLine = scanner.line;
  scanner.advance(); // consume '<'
  const name = parseName(scanner);
  const attributes = parseAttributes(scanner);
  const element = new XmlElement(name, attributes, startLine);

  scanner.skipWhitespace();
  if (scanner.startsWith('/>')) {
    scanner.advance(2);
    return element;
  }
  if (scanner.peek() !== '>') {
    throw new XmlParseException(`Malformed start tag for <${name}>`, scanner.line);
  }
  scanner.advance();

  for (;;) {
    if (scanner.eof()) {
      throw new XmlParseException(`Unterminated element <${name}> (opened at line ${startLine})`, scanner.line);
    }
    if (scanner.startsWith('</')) {
      const closeLine = scanner.line;
      scanner.advance(2);
      scanner.skipWhitespace();
      const closeName = parseName(scanner);
      scanner.skipWhitespace();
      if (scanner.peek() !== '>') {
        throw new XmlParseException(`Malformed closing tag for </${closeName}>`, closeLine);
      }
      scanner.advance();
      if (closeName !== name) {
        throw new XmlParseException(
          `Mismatched closing tag: expected </${name}> but found </${closeName}>`,
          closeLine,
        );
      }
      return element;
    }
    if (scanner.startsWith('<!--')) {
      skipDelimited(scanner, '<!--'.length, '-->', 'comment');
      continue;
    }
    if (scanner.startsWith('<![CDATA[')) {
      const cdataLine = scanner.line;
      scanner.advance('<![CDATA['.length);
      const text = scanner.readUntil(']]>', 'CDATA section');
      element.children.push(new XmlText(text, cdataLine));
      continue;
    }
    if (scanner.startsWith('<?')) {
      skipDelimited(scanner, 2, '?>', 'processing instruction');
      continue;
    }
    if (scanner.peek() === '<') {
      element.children.push(parseElement(scanner));
      continue;
    }
    const textNode = parseText(scanner);
    if (textNode.text.length > 0) element.children.push(textNode);
  }
}

/**
 * Parses one XML document. Never throws: parse failures are appended to
 * `diagnostics` and `null` is returned for `document` so callers can keep
 * processing the rest of a multi-file project.
 *
 * @returns {XmlDocument|null}
 */
export function parseXml(source, sourceFile, diagnostics) {
  const scanner = new Scanner(source);
  try {
    for (;;) {
      scanner.skipWhitespace();
      if (scanner.startsWith('<?xml')) {
        skipDelimited(scanner, '<?xml'.length, '?>', 'XML declaration');
        continue;
      }
      if (scanner.startsWith('<!--')) {
        skipDelimited(scanner, '<!--'.length, '-->', 'comment');
        continue;
      }
      if (scanner.startsWith('<!DOCTYPE')) {
        skipDoctype(scanner);
        continue;
      }
      if (scanner.startsWith('<?')) {
        skipDelimited(scanner, 2, '?>', 'processing instruction');
        continue;
      }
      break;
    }
    scanner.skipWhitespace();
    if (scanner.eof() || scanner.peek() !== '<') {
      throw new XmlParseException('Expected a root element', scanner.line);
    }
    const root = parseElement(scanner);
    return new XmlDocument(root, sourceFile);
  } catch (e) {
    if (e instanceof XmlParseException) {
      diagnostics.error(e.message, sourceFile, e.line, 'XML_PARSE_ERROR');
    } else {
      diagnostics.error(`Unexpected parser failure: ${e.message}`, sourceFile, scanner.line, 'XML_PARSE_ERROR');
    }
    return null;
  }
}
