const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');

async function openEditor(t, source) {
  const html = readFileSync(require.resolve('../index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;
  t.after(() => window.close());
  await new Promise(resolve => window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));

  const downloads = [];
  const rendered = [];
  const copied = [];
  const errors = [];
  Object.assign(window, {
    marked: require('marked'), hljs: require('highlight.js'), jsyaml: require('js-yaml'),
    markedFootnote: require('marked-footnote'), markedGfmHeadingId: require('marked-gfm-heading-id'),
    DOMPurify: require('dompurify')(window),
    mermaid: { initialize() {}, async run() {} },
    joypixels: { shortnameToUnicode: text => text === ':smile:' ? '😄' : text },
    matchMedia: () => ({ matches: false }),
    isSecureContext: true,
    alert: message => errors.push(message),
    // JSDOM 不绘制画布；保留真实解析及点击流程，只替换 PDF 绘制和下载。
    html2canvas: async element => {
      rendered.push(element.cloneNode(true));
      return { width: 800, height: 100 };
    },
    jspdf: { jsPDF: class {
      internal = { pageSize: { getWidth: () => 210, getHeight: () => 297 } };
      addImage() {}
      save(filename) { downloads.push(filename); }
    } }
  });
  window.document.fonts = { ready: Promise.resolve() };
  window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
  window.navigator.clipboard = { writeText: async text => copied.push(text) };
  window.console.log = () => {};
  window.localStorage.setItem('markdown-viewer-content', source);
  window.eval(readFileSync(require.resolve('../markdown.js'), 'utf8'));
  window.eval(readFileSync(require.resolve('../script.js'), 'utf8'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await Promise.resolve();
  return { window, downloads, rendered, copied, errors };
}

test('editor and PDF export share title handling while copying preserves source', async t => {
  const source = '---\ntitle: "Redis <img src=x onerror=alert(1)> :smile:"\nslug: /private-metadata\n---\n\n> [!NOTE]\n> 提示\n\n正文[^a]\n\n[^a]: 说明';
  const { window, downloads, rendered, copied, errors } = await openEditor(t, source);
  const preview = window.document.getElementById('markdown-preview');
  assert.equal(preview.querySelector('h1').textContent, 'Redis <img src=x onerror=alert(1)> 😄');
  assert.equal(preview.querySelector('img, [onerror]'), null);
  assert.ok(preview.querySelector('.markdown-alert-note'));
  assert.ok(preview.querySelector('.footnotes'));
  assert.doesNotMatch(preview.textContent, /private-metadata/);

  window.document.getElementById('copy-markdown-button').click();
  window.document.getElementById('export-pdf').click();
  await new Promise(setImmediate);
  assert.deepEqual(errors, []);
  assert.deepEqual(copied, [source]);
  assert.deepEqual(downloads, ['Redis img src=x onerror=alert(1) smile.pdf']);
  const exported = rendered[0];
  assert.equal(exported.querySelector('h1').textContent, 'Redis <img src=x onerror=alert(1)> :smile:');
  assert.ok(exported.querySelector('.markdown-alert-note'));
  assert.ok(exported.querySelector('.footnotes'));
  assert.doesNotMatch(exported.textContent, /private-metadata/);
  assert.equal(exported.querySelector('img, [onerror]'), null);

  const editor = window.document.getElementById('markdown-editor');
  editor.value = '---\ntitle: abc\n---\n# Welcome to Markdown Viewer';
  editor.dispatchEvent(new window.Event('input'));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(preview.textContent.trim(), 'Welcome to Markdown Viewer');
  window.document.getElementById('export-pdf').click();
  await new Promise(setImmediate);
  assert.equal(downloads.at(-1), 'Welcome to Markdown Viewer.pdf');
  assert.equal(rendered.at(-1).textContent.trim(), 'Welcome to Markdown Viewer');
  assert.equal(rendered.at(-1).querySelectorAll('h1').length, 1);
  assert.deepEqual(errors, []);
});

test('PDF filename follows heading priority using current editor content', async t => {
  const { window, downloads, errors } = await openEditor(t, '# 旧标题');
  const editor = window.document.getElementById('markdown-editor');
  const cases = [
    ['---\ntitle: 元数据标题\n---\n## 前言\n\n# 正文 **标题**\n\n# 另一个标题', '正文 标题.pdf'],
    ['---\ntitle: 元数据标题\n---\n## 前言', '元数据标题.pdf'],
    ['---\ntitle: 元数据标题\n---\n```markdown\n# 示例标题\n```', '元数据标题.pdf'],
    ['```markdown\n# 示例标题\n```\n\n## [二级标题](https://example.com)\n\n## 后续章节', '二级标题.pdf'],
    ['Setext 标题\n===\n\n## 前言', 'Setext 标题.pdf'],
    ['二级标题\n---\n\n正文', '二级标题.pdf'],
    ['# Redis `缓存` &amp; 入门', 'Redis 缓存 & 入门.pdf'],
    ['# A / B : C | D ? E * F...', 'A B C D E F.pdf'],
    ['#\n\n## 有内容的标题', '有内容的标题.pdf'],
    ['---\ntitle: ""\n---\n## 二级标题', '二级标题.pdf'],
    ['### 只有三级标题\n\n正文', 'Document.pdf'],
    ['', 'Document.pdf']
  ];
  for (const [source, expected] of cases) {
    editor.value = source;
    editor.dispatchEvent(new window.Event('input'));
    // 不等预览的防抖更新，点击就应按最新原文导出。
    window.document.getElementById('export-pdf').click();
    await new Promise(setImmediate);
    assert.deepEqual(errors, []);
    assert.equal(downloads.at(-1), expected, source);
  }
  assert.equal(downloads.length, cases.length);
});

test('desktop, mobile and save shortcuts export PDF without a format dropdown', async t => {
  const { window, downloads, errors } = await openEditor(t, '# 导出验证');
  const { document } = window;
  assert.equal(document.querySelector('.dropdown, #export-md, #export-html, #mobile-export-md, #mobile-export-html'), null);
  const desktop = document.getElementById('export-pdf');
  const mobile = document.getElementById('mobile-export-pdf');
  assert.equal(desktop.tagName, 'BUTTON');
  assert.equal(desktop.textContent.trim(), 'Export');
  assert.equal(desktop.hasAttribute('data-bs-toggle'), false);

  desktop.click();
  assert.equal(desktop.disabled, true);
  assert.equal(mobile.disabled, true);
  mobile.click();
  await new Promise(setImmediate);
  assert.equal(downloads.length, 1);
  assert.equal(desktop.disabled, false);
  assert.equal(mobile.disabled, false);

  mobile.click();
  await new Promise(setImmediate);
  for (const modifier of ['ctrlKey', 'metaKey']) {
    const event = new window.KeyboardEvent('keydown', { key: 's', [modifier]: true, cancelable: true });
    document.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    await new Promise(setImmediate);
  }
  assert.deepEqual(downloads, Array(4).fill('导出验证.pdf'));
  assert.deepEqual(errors, []);
});
