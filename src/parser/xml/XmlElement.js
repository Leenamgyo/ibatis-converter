/**
 * Generic, XML-shaped tree produced by the tokenizer/parser in this
 * package. This is intentionally NOT treated as a business model anywhere
 * outside `parser/xml` and `parser/ibatis`: `IbatisMapperParser` walks it
 * once to build the real semantic AST (`ast/ibatis`), and nothing else in
 * the pipeline ever imports this file.
 */

export class XmlText {
  constructor(text, sourceLine) {
    this.kind = 'text';
    this.text = text;
    this.sourceLine = sourceLine;
  }
}

export class XmlElement {
  constructor(name, attributes, sourceLine) {
    this.kind = 'element';
    this.name = name;
    this.attributes = attributes; // plain object: { name: value }
    /** @type {(XmlElement|XmlText)[]} */
    this.children = [];
    this.sourceLine = sourceLine;
  }

  attr(name, defaultValue = null) {
    if (Object.prototype.hasOwnProperty.call(this.attributes, name)) {
      return this.attributes[name];
    }
    return defaultValue;
  }

  boolAttr(name, defaultValue = false) {
    const raw = this.attr(name, null);
    if (raw === null) return defaultValue;
    return raw === 'true' || raw === '1' || raw === 'yes';
  }

  intAttr(name, defaultValue = null) {
    const raw = this.attr(name, null);
    if (raw === null) return defaultValue;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? defaultValue : n;
  }

  /** All direct child elements, optionally filtered by tag name. */
  elementChildren(name = null) {
    return this.children.filter((c) => c.kind === 'element' && (name === null || c.name === name));
  }

  /** Concatenated text of direct text-node children (does not recurse into elements). */
  directText() {
    return this.children
      .filter((c) => c.kind === 'text')
      .map((c) => c.text)
      .join('');
  }
}

export class XmlDocument {
  constructor(root, sourceFile) {
    this.root = root;
    this.sourceFile = sourceFile;
  }
}
