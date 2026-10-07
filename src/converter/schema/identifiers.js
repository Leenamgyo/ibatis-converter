import { TokenKind } from './SqlLexer.js';

const CLOSING_QUOTE = { '"': '"', '`': '`', '[': ']' };

/**
 * Renders a new identifier in the token's own style: a quoted identifier
 * stays quoted with the same quote characters (each dotted part quoted
 * separately), a bare word stays bare.
 */
export function renderIdentifier(token, name) {
  if (token.kind !== TokenKind.QUOTED_IDENTIFIER) return name;
  const close = CLOSING_QUOTE[token.quote];
  return name.split('.').map((part) => `${token.quote}${part}${close}`).join('.');
}

/** 'NEW.COUNTRY' -> { schema: 'NEW', name: 'COUNTRY' }, 'COUNTRY' -> { schema: null, name: 'COUNTRY' } */
export function splitQualifiedName(qualified) {
  const at = qualified.lastIndexOf('.');
  return at === -1
    ? { schema: null, name: qualified }
    : { schema: qualified.slice(0, at), name: qualified.slice(at + 1) };
}
