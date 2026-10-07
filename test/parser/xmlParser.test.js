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

test('reports a mismatched closing tag as a recoverable ParserError instead of throwing', () => {
  const diagnostics = new DiagnosticBag();
  const doc = parseXml('<root><a></b></root>', 'broken.xml', diagnostics);
  assert.equal(doc, null);
  assert.equal(diagnostics.errors.length, 1);
  assert.match(diagnostics.errors[0].message, /Mismatched closing tag/);
  assert.equal(diagnostics.errors[0].sourceFile, 'broken.xml');
});

test('reports an unterminated element as a recoverable ParserError instead of throwing', () => {
  const diagnostics = new DiagnosticBag();
  const doc = parseXml('<root><a>', 'broken.xml', diagnostics);
  assert.equal(doc, null);
  assert.equal(diagnostics.errors.length, 1);
});
