const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const context = vm.createContext({ document: { addEventListener() {} } });
vm.runInContext(readFileSync(require.resolve('../script.js'), 'utf8'), context);

function outlineFor(t, html, slices = [{ start: 0, end: 1000 }], scale = 2) {
  const dom = new JSDOM(`<div id="content">${html}</div>`);
  t.after(() => dom.window.close());
  const element = dom.window.document.getElementById('content');
  element.getBoundingClientRect = () => ({ top: 125 });
  element.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(heading => {
    heading.getBoundingClientRect = () => ({
      top: 125 + Number(heading.dataset.top || 0),
      width: heading.hidden ? 0 : 300, height: heading.hidden ? 0 : 30
    });
  });
  const roots = [];
  const displayModes = [];
  const pdf = {
    outline: { add(parent, title, { pageNumber }) {
      const item = { title, pageNumber, children: [] };
      (parent ? parent.children : roots).push(item);
      return item;
    } },
    setDisplayMode(...args) { displayModes.push(args); }
  };
  context.addPdfOutline(pdf, element, slices, scale);
  return { roots, displayModes };
}

test('preserves heading hierarchy, skipped levels, repeated titles and plain Chinese text', t => {
  const { roots, displayModes } = outlineFor(t, `
    <h1>中文手册</h1>
    <h2> 中文 <em>安装</em> &amp; <code>API</code> </h2><h3>准备</h3><h5>跳级</h5><h6>详细说明</h6>
    <h4>返回上级</h4><h2>安装</h2>
    <h2>安装</h2><h1>附录</h1>
  `);
  const item = (title, children = []) => ({ title, pageNumber: 1, children });
  assert.deepEqual(roots, [
    item('中文 安装 & API', [item('准备', [item('跳级', [item('详细说明')]), item('返回上级')])]),
    item('安装'), item('安装')
  ]);
  assert.deepEqual(displayModes, [[null, null, 'UseOutlines']]);
});

test('omits H1 bookmarks while keeping chapters separate across H1 boundaries', t => {
  const { roots } = outlineFor(t, `
    <h1>第一章</h1><h2>安装</h2><h3>说明</h3>
    <h1>第二章</h1><h3>跳级前言</h3><h4>补充</h4>
  `);
  assert.deepEqual(roots, [
    { title: '安装', pageNumber: 1, children: [{ title: '说明', pageNumber: 1, children: [] }] },
    { title: '跳级前言', pageNumber: 1, children: [{ title: '补充', pageNumber: 1, children: [] }] }
  ]);
});

test('starts at the first available heading level without inventing parent entries', t => {
  const { roots } = outlineFor(t, '<h3>前言</h3><h5>补充</h5><h2>正文</h2>');
  assert.deepEqual(roots, [
    { title: '前言', pageNumber: 1, children: [{ title: '补充', pageNumber: 1, children: [] }] },
    { title: '正文', pageNumber: 1, children: [] }
  ]);
});

test('uses actual page slices and assigns fractional or exact boundaries to the next page', t => {
  const { roots } = outlineFor(t, `
    <h2 data-top="10">首页</h2>
    <h2 data-top="100.2">分页回退后的标题</h2>
    <h2 data-top="175">第三页边界</h2>
    <h2 data-top="260">末页</h2>
  `, [{ start: 0, end: 201 }, { start: 201, end: 350 }, { start: 350, end: 550 }]);
  assert.deepEqual(roots.map(item => item.pageNumber), [1, 2, 3, 3]);
});

test('excludes empty and hidden headings, footnote labels and code examples', t => {
  const { roots, displayModes } = outlineFor(t, `
    <h2>  </h2><h2 hidden>隐藏</h2><h3 style="visibility:hidden">不可见</h3>
    <section class="footnotes"><h2 class="sr-only">Footnotes</h2></section>
    <pre><code><h2>代码示例</h2></code></pre><p>只有正文</p>
  `);
  assert.deepEqual(roots, []);
  assert.deepEqual(displayModes, []);
});

for (const html of ['<p>普通正文</p>', '<h1>只有一级标题</h1><p>普通正文</p>']) {
  test(`does not open an empty bookmarks panel for ${html}`, t => {
    const { roots, displayModes } = outlineFor(t, html);
    assert.deepEqual(roots, []);
    assert.deepEqual(displayModes, []);
  });
}
