import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml } from '../../src/parser/xml/XmlParser.js';
import { DiagnosticBag } from '../../src/parser/xml/ParserDiagnostics.js';

test('parses a simple element with attributes and text', () => {
  const diagnostics = new DiagnosticBag();
  const doc = parseXml('<a x="1" y="two">hello</a>', 'inline.xml', diagnostics);
  assert.equal(diagnostics.errors.length, 0);
  assert.equal(doc.root.name, 'a');
  assert.equal(doc.root.attr('x'), '1');
  assert.equal(doc.root.attr('y'), 'two');
  assert.equal(doc.root.directText(), 'hello');
});

test('tracks line numbers across multiple lines', () => {
  const diagnostics = new DiagnosticBag();
  const source = '<root>\n  <child>\n    text\n  </child>\n</root>';
  const doc = parseXml(source, 'inline.xml', diagnostics);
  assert.equal(doc.root.sourceLine, 1);
  const child = doc.root.elementChildren('child')[0];
  assert.equal(child.sourceLine, 2);
});

test('decodes XML entities in text and attributes', () => {
  const diagnostics = new DiagnosticBag();
  const doc = parseXml('<a b="1 &lt; 2">A &amp; B &gt; C</a>', 'inline.xml', diagnostics);
  assert.equal(doc.root.attr('b'), '1 < 2');
  assert.equal(doc.root.directText(), 'A & B > C');
});

test('parses CDATA sections as raw text', () => {
  const diagnostics = new DiagnosticBag();
  const doc = parseXml('<a><![CDATA[1 < 2 && 3 > 1]]></a>', 'inline.xml', diagnostics);
  assert.equal(doc.root.directText(), '1 < 2 && 3 > 1');
});

test('skips comments and processing instructions', () => {
  const diagnostics = new DiagnosticBag();
  const source = '<?xml version="1.0"?>\n<!-- comment --><root><!-- inner --><a/></root>';
  const doc = parseXml(source, 'inline.xml', diagnostics);
  assert.equal(doc.root.name, 'root');
  assert.equal(doc.root.elementChildren().length, 1);
});

test('skips a DOCTYPE declaration without touching the network', () => {
  const diagnostics = new DiagnosticBag();
  const source = '<!DOCTYPE sqlMap PUBLIC "-//iBATIS.com//DTD SQL Map 2.0//EN" "http://www.ibatis.com/dtd/sql-map-2.dtd">\n<sqlMap namespace="x"/>';
  const doc = parseXml(source, 'inline.xml', diagnostics);
  assert.equal(diagnostics.errors.length, 0);
  assert.equal(doc.root.name, 'sqlMap');
});

test('handles self-closing tags', () => {
  const diagnostics = new DiagnosticBag();
  const doc = parseXml('<root><a/><b x="1"/></root>', 'inline.xml', diagnostics);
  assert.equal(doc.root.elementChildren().length, 2);
});

test('a stray closing tag is dropped with a warning; the document is kept (one typo must not lose a mapper)', () => {
  const diagnostics = new DiagnosticBag();
  const doc = parseXml('<root><a></b></a></root>', 'broken.xml', diagnostics);
  assert.ok(doc);
  assert.equal(doc.root.elementChildren('a').length, 1);
  assert.equal(diagnostics.errors.length, 0);
  assert.equal(diagnostics.warnings[0].code, 'XML_RECOVERED_STRAY_CLOSE');
  assert.equal(diagnostics.warnings[0].sourceFile, 'broken.xml');
});

test('an element closed by its parent\'s closing tag, or never closed, is recovered with a warning', () => {
  const diagnostics = new DiagnosticBag();
  const doc = parseXml('<root><a><b>x</a><c/></root>', 'broken.xml', diagnostics);
  assert.deepEqual(doc.root.elementChildren().map((e) => e.name), ['a', 'c'], '<b> ends at </a>; <c> is still a child of root');
  assert.equal(diagnostics.warnings[0].code, 'XML_RECOVERED_UNCLOSED');
  const eof = new DiagnosticBag();
  assert.ok(parseXml('<root><a>', 'broken.xml', eof));
  assert.equal(eof.errors.length, 0);
  assert.ok(eof.warnings.every((w) => w.code === 'XML_RECOVERED_UNCLOSED'));
});

test('an unescaped "<" in SQL text is read as text (A < 10, <=, <>), with a warning per occurrence', () => {
  const diagnostics = new DiagnosticBag();
  const doc = parseXml('<root><sql>A < 10 AND B <= 3 AND C <> 2 <x/></sql></root>', 'lt.xml', diagnostics);
  const sql = doc.root.elementChildren('sql')[0];
  assert.equal(sql.children[0].text, 'A < 10 AND B <= 3 AND C <> 2 ');
  assert.equal(sql.elementChildren('x').length, 1, 'a real tag after it is still a tag');
  assert.deepEqual(diagnostics.warnings.map((w) => w.code), ['XML_LENIENT_LT', 'XML_LENIENT_LT', 'XML_LENIENT_LT']);
});
