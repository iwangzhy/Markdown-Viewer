const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const marked = require('marked');
const yaml = require('js-yaml');
const { createMarkdownRenderer, prepareMarkdownSource } = require('../markdown.js');

const window = new JSDOM('').window;
const render = createMarkdownRenderer({
  marked, yaml, hljs: require('highlight.js'), footnote: require('marked-footnote'),
  gfmHeadingId: require('marked-gfm-heading-id').gfmHeadingId,
  DOMPurify: require('dompurify')(window)
});
const preview = source => JSDOM.fragment(render(source));

test('renders the requested title as H1 and hides all other front matter', () => {
  const doc = preview('---\nslug: /redis-practical-guide\ntitle: Redis 常用命令与实战手册\n---\n\n## 安装\n\n正文');
  assert.equal(doc.querySelector('h1').textContent, 'Redis 常用命令与实战手册');
  assert.equal(doc.querySelector('h1').id, 'redis-常用命令与实战手册');
  assert.equal(doc.querySelector('h2').textContent, '安装');
  assert.doesNotMatch(doc.textContent, /slug|title:|redis-practical-guide/);
  assert.equal(doc.querySelector('hr'), null);
});

test('accepts BOM, CRLF, comments, nested metadata, arrays and folded YAML titles', () => {
  const source = '\uFEFF---\r\n# 文档信息\r\ntitle: >-\r\n  Redis 常用命令\r\n  与实战手册\r\ntags: [Redis, 缓存]\r\nsidebar:\r\n  order: 1\r\n  draft: false\r\ndate: 2026-09-17\r\n...\r\n正文';
  const doc = preview(source);
  assert.equal(doc.querySelector('h1').textContent, 'Redis 常用命令 与实战手册');
  assert.equal(doc.querySelector('p').textContent, '正文');
  assert.doesNotMatch(doc.textContent, /sidebar|缓存|2026/);
});

for (const heading of ['# Redis 手册', 'Redis 手册\n===']) {
  test(`avoids a duplicate first title with ${JSON.stringify(heading)}`, () => {
    const doc = preview(`---\ntitle: Redis 手册\n---\n\n${heading}\n\n正文`);
    assert.equal(doc.querySelectorAll('h1').length, 1);
    assert.equal(doc.querySelector('h1').textContent, 'Redis 手册');
  });
}

for (const body of [
  '# Welcome to Markdown Viewer',
  'Welcome to Markdown Viewer\n===',
  '开场说明\n\n# Welcome to Markdown Viewer\n\n正文',
  '开场说明\n\nWelcome to Markdown Viewer\n===\n\n正文',
  '## 简介\n\n# Welcome to Markdown Viewer'
]) {
  test(`body H1 takes precedence over a different metadata title: ${JSON.stringify(body)}`, () => {
    const source = `---\ntitle: abc\n---\n${body}`;
    const doc = preview(source);
    assert.deepEqual([...doc.querySelectorAll('h1')].map(node => node.textContent), ['Welcome to Markdown Viewer']);
    assert.doesNotMatch(doc.textContent, /abc/);
    assert.equal(render(source), render(source));
  });
}

test('preserves all body H1 headings without inserting the metadata title', () => {
  const doc = preview('---\ntitle: abc\n---\n# 第一章\n\n# 第二章');
  assert.deepEqual([...doc.querySelectorAll('h1')].map(node => node.textContent), ['第一章', '第二章']);
});

test('H1 examples in fenced or indented code do not suppress the metadata title', () => {
  const doc = preview('---\ntitle: abc\n---\n```markdown\n# 示例标题\n```\n\n    # 缩进代码\n\n## 正文');
  assert.deepEqual([...doc.querySelectorAll('h1')].map(node => node.textContent), ['abc']);
  assert.equal(doc.querySelectorAll('pre code').length, 2);
});

for (const metadata of ['', 'tags: [Redis]', 'title: ""', 'title: null', 'title: 123', 'title: [Redis]']) {
  test(`does not create a heading for missing or non-text title: ${metadata}`, () => {
    const doc = preview(`---\n${metadata}\n---\n\n正文`);
    assert.equal(doc.textContent.trim(), '正文');
    assert.equal(doc.querySelector('h1'), null);
  });
}

test('supports a document containing only front matter', () => {
  assert.equal(preview('---\ntitle: Redis\n---').querySelector('h1').textContent, 'Redis');
  assert.equal(render('---\nslug: /redis\n---').trim(), '');
});

for (const source of [
  '---\n普通标题\n---\n\n正文',
  '正文\n\n---\ntitle: 正文中的内容\n---',
  '---\ntitle: [未闭合\n---\n\n## 正文',
  '---\ntitle: 未完成\n\n## 正文',
  '---\n- 数组文档\n---\n\n正文'
]) {
  test(`preserves non-metadata or invalid front matter: ${JSON.stringify(source)}`, () => {
    assert.equal(prepareMarkdownSource(source, yaml, marked), source);
    assert.ok(preview(source).textContent.includes('正文'));
  });
}

test('keeps metadata, footnotes and alert markers literal inside code', () => {
  const code = '---\ntitle: 示例\n---\n> [!NOTE]\n:::tip\n[^a]: example';
  const doc = preview('```yaml\n' + code + '\n```\n\n`[^a]`');
  assert.equal(doc.querySelector('pre code').textContent, code);
  assert.equal(doc.querySelector('h1'), null);
  assert.equal(doc.querySelector('.markdown-alert'), null);
  assert.equal(doc.querySelector('.footnotes'), null);
});

test('treats the YAML title as plain text, including Markdown and HTML', () => {
  const title = '<img src=x onerror=alert(1)> **Redis** & [link](javascript:alert(1)) $x$';
  const doc = preview(`---\ntitle: ${JSON.stringify(title)}\n---\n正文`);
  assert.equal(doc.querySelector('h1').textContent, title);
  assert.equal(doc.querySelector('h1 img, h1 strong, h1 a'), null);
});

test('footnotes support repeated references, multiline bodies and working backlinks', () => {
  const source = '正文[^缓存] 再次引用[^缓存]。\n\n[^缓存]: **说明**\n\n    第二段。';
  const doc = preview(source);
  assert.equal(doc.querySelectorAll('.footnotes li').length, 1);
  assert.equal(doc.querySelectorAll('.footnotes p').length, 2);
  const links = [...doc.querySelectorAll('a[href^="#"]')];
  for (const link of links) assert.ok(doc.getElementById(link.getAttribute('href').slice(1)));
  const ids = [...doc.querySelectorAll('[id]')].map(node => node.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(render(source), render(source));
  assert.equal(preview('无脚注的新文档').querySelector('.footnotes'), null);
});

for (const kind of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']) {
  test(`renders a GitHub ${kind} alert while retaining its Markdown body`, () => {
    const doc = preview(`> [!${kind}]\n> **注意**\n>\n> - 第一项\n> - 第二项`);
    const alert = doc.querySelector(`.markdown-alert-${kind.toLowerCase()}`);
    assert.ok(alert);
    assert.equal(alert.querySelector('strong').textContent, '注意');
    assert.equal(alert.querySelectorAll('li').length, 2);
    assert.doesNotMatch(alert.textContent, /\[!/);
  });
}

test('retains normal quotes and escaped alert markers', () => {
  for (const source of ['> 普通引用', '> `[!NOTE]`\n> 示例', '> \\[!NOTE]\n> 转义', '> [!UNKNOWN]\n> 未知类型']) {
    const doc = preview(source);
    assert.ok(doc.querySelector('blockquote'));
    assert.equal(doc.querySelector('.markdown-alert'), null);
  }
});

test('supports nested colon admonitions and ignores closing markers in fences', () => {
  const source = '::::tip[Redis 建议]\n\n**外层**\n\n:::warning 注意\n警告\n:::\n\n```text\n:::\n```\n\n剩余正文\n::::\n\n结束';
  const doc = preview(source);
  const outer = doc.querySelector('.markdown-alert-tip');
  assert.ok(outer.querySelector('.markdown-alert-warning'));
  assert.equal(outer.querySelector('pre code').textContent, ':::');
  assert.ok(outer.textContent.includes('剩余正文'));
  assert.equal(doc.lastElementChild.textContent, '结束');
});

test('unfinished admonitions remain visible and unsafe titles cannot create HTML', () => {
  assert.ok(preview(':::tip\n还没写完').textContent.includes(':::tip'));
  const doc = preview(':::danger <img src=x onerror=alert(1)>\n正文\n:::');
  assert.equal(doc.querySelector('img'), null);
  assert.ok(doc.querySelector('.markdown-alert-title').textContent.includes('<img'));
});

test('headings have stable Chinese anchors and deduplicate repeated names', () => {
  const source = '[跳转](#redis-命令-1)\n\n# Redis 命令\n\n# Redis 命令';
  assert.deepEqual([...preview(source).querySelectorAll('h1')].map(node => node.id), ['redis-命令', 'redis-命令-1']);
  assert.equal(render(source), render(source));
});

test('retains GFM, safe HTML and syntax highlighting with fence attributes', () => {
  const doc = preview('| key | value |\n| --- | --- |\n| A | B |\n\n- [x] 完成\n- [ ] 待办\n\n~~删除~~\n\n<details><summary>详情</summary>正文</details>\n\n```js title="example.js" {1}\nconst x = 1;\n```');
  assert.equal(doc.querySelectorAll('table tr').length, 2);
  assert.equal(doc.querySelectorAll('input[type=checkbox]').length, 2);
  assert.equal(doc.querySelector('del').textContent, '删除');
  assert.ok(doc.querySelector('details summary'));
  assert.ok(doc.querySelector('code.language-js .hljs-keyword'));
});

test('preserves Mermaid source and sanitizes raw HTML in the same renderer', () => {
  const source = '```mermaid title="diagram"\ngraph LR\nA["<b>缓存</b>"] --> B\n```\n\n<script>alert(1)</script><img src=x onerror=alert(2)>\n\n[bad](javascript:alert(3))';
  const doc = preview(source);
  assert.equal(doc.querySelector('.mermaid').textContent, 'graph LR\nA["<b>缓存</b>"] --> B');
  assert.equal(doc.querySelector('.mermaid b, script, [onerror], a[href^="javascript:"]'), null);
});

test('renders the comprehensive fixture without losing later content', () => {
  const source = readFileSync(require.resolve('./fixtures/markdown-extensions.md'), 'utf8');
  const doc = preview(source);
  assert.equal(doc.querySelector('h1').textContent, 'Redis 常用命令与实战手册');
  assert.ok(doc.querySelector('.footnotes'));
  assert.ok(doc.querySelector('.markdown-alert-tip'));
  assert.ok(doc.querySelector('table'));
  assert.ok(doc.textContent.includes('文档结束'));
});
