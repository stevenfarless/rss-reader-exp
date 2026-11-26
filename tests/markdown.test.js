"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Markdown = require("../markdown.js");

test("renders headings and paragraphs", () => {
  const html = Markdown.render("# Theism vs. Atheism\n\n## An Exploration");
  assert.match(html, /<h1[^>]*>Theism vs\. Atheism<\/h1>/);
  assert.match(html, /<h2[^>]*>An Exploration<\/h2>/);
});

test("renders escaped opening parentheses in table-of-contents links", () => {
  const html = Markdown.render("- [Domain & Evidence]\\(#domain--evidence)");
  assert.match(html, /<a href="#domain--evidence">Domain &amp; Evidence<\/a>/);
});

test("renders nested unordered lists", () => {
  const html = Markdown.render("- Parent\n  - Child\n  - Another child\n- Sibling");
  assert.match(html, /<ul>/);
  assert.match(html, /Parent[\s\S]*<ul>[\s\S]*Child[\s\S]*Another child[\s\S]*Sibling/);
});

test("renders tables and column alignment", () => {
  const html = Markdown.render("| Name | Value |\n|:---|---:|\n| Alpha | 10 |");
  assert.match(html, /<table>/);
  assert.match(html, /<th style="text-align:left">Name<\/th>/);
  assert.match(html, /<td style="text-align:right">10<\/td>/);
});

test("renders fenced code and escapes HTML inside it", () => {
  const fence = "\x60\x60\x60";
  const html = Markdown.render(fence + "html\n<script>alert(1)</script>\n" + fence);
  assert.match(html, /<pre><code class="language-html">/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("escapes raw HTML", () => {
  const html = Markdown.render("<img src=x onerror=alert(1)>");
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
});

test("detects Markdown and leaves ordinary prose alone", () => {
  assert.equal(Markdown.looksLikeMarkdown("# Heading\n\nText"), true);
  assert.equal(Markdown.looksLikeMarkdown("Plain paragraph with no markup."), false);
});

test("renders ordered lists, blockquotes, emphasis, and horizontal rules", () => {
  const html = Markdown.render("1. First\n2. Second\n\n> Quoted text\n\n**Strong** and *emphasis*\n\n---");
  assert.match(html, /<ol>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<strong>Strong<\/strong>/);
  assert.match(html, /<em>emphasis<\/em>/);
  assert.match(html, /<hr>/);
});

test("does not create links for unsafe URL schemes", () => {
  const html = Markdown.render("[unsafe](javascript:alert%281%29)");
  assert.doesNotMatch(html, /href="javascript:/i);
});

test("creates heading anchors that preserve punctuation separators", () => {
  const html = Markdown.render("## Domain & Evidence\n\n## Position A -- Critique of Position B");
  assert.match(html, /id="domain--evidence"/);
  assert.match(html, /id="position-a----critique-of-position-b"/);
});
