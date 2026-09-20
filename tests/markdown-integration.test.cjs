const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');

async function openEditor(t, source, { layoutHeight = 100, headingTops = [], failPage = 0, failure = 'empty' } = {}) {
  const html = readFileSync(require.resolve('../index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;
  t.after(() => window.close());
  await new Promise(resolve => window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));

  const downloads = [];
  const rendered = [];
  const copied = [];
  const errors = [];
  const captures = [];
  const images = [];
  const canvases = [];
  const outlines = [];
  const getBoundingClientRect = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.matches('h1, h2, h3, h4, h5, h6') && this.closest('.pdf-export')) {
      const headings = [...this.closest('.pdf-export').querySelectorAll('h1, h2, h3, h4, h5, h6')];
      const top = headingTops[headings.indexOf(this)] ?? 20;
      return { top, bottom: top + 30, left: -9979, width: 700, height: 30 };
    }
    return this.matches('.pdf-export')
      ? { top: 0, bottom: layoutHeight, left: -9999, width: 793.6875, height: layoutHeight }
      : getBoundingClientRect.call(this);
  };
  window.Range.prototype.getClientRects = () => [];
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
    html2canvas: async (element, options) => {
      rendered.push(element.cloneNode(true));
      options.onclone?.(window.document);
      const canvas = window.document.createElement('canvas');
      canvas.width = Math.ceil(options.width ?? 793.6875) * options.scale;
      canvas.height = (options.height ?? layoutHeight) * options.scale;
      captures.push({ y: options.y ?? 0, width: canvas.width, height: canvas.height });
      canvases.push(canvas);
      // 模拟长画布上限；回归到整篇截图时必须失败，不能让替身掩盖空白问题。
      if (canvas.height > 32767) throw new Error('Canvas height limit exceeded');
      if (captures.length === failPage) {
        if (failure === 'transparent') canvas.getContext = () => ({ getImageData: () => ({ data: [0, 0, 0, 0] }) });
        else if (failure === 'context') canvas.getContext = () => null;
        else canvas.toDataURL = () => 'data:,';
      }
      return canvas;
    },
    jspdf: { jsPDF: class {
      internal = { pageSize: { getWidth: () => 210, getHeight: () => 297 } };
      outline = { root: { children: [] }, add(parent, title, options) {
        const item = { title, options: { ...options }, children: [] };
        (parent ?? this.root).children.push(item);
        return item;
      } };
      constructor() { outlines.push(this.outline); }
      setDisplayMode(zoom, layout, mode) { this.outline.mode = mode; }
      addPage() {}
      addImage(data, format, x, y, width, height) { images.push({ width, height }); }
      save(filename) { downloads.push(filename); }
    } }
  });
  window.document.fonts = { ready: Promise.resolve() };
  window.HTMLCanvasElement.prototype.getContext = () => ({
    drawImage() {}, getImageData: () => ({ data: [255, 255, 255, 255] })
  });
  window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AA==';
  window.navigator.clipboard = { writeText: async text => copied.push(text) };
  window.console.log = () => {};
  window.localStorage.setItem('markdown-viewer-content', source);
  window.eval(readFileSync(require.resolve('../markdown.js'), 'utf8'));
  window.eval(readFileSync(require.resolve('../script.js'), 'utf8'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await Promise.resolve();
  return { window, downloads, rendered, copied, errors, captures, images, canvases, outlines };
}

test('PDF export writes bookmarks once with final page numbers and resets them on the next export', async t => {
  const source = '# 中文手册\n\n## 安装\n\n### 子章节\n\n## 安装\n\n正文[^a]\n\n[^a]: 脚注';
  const { window, downloads, errors, outlines, captures } = await openEditor(t, source, {
    layoutHeight: 4000, headingTops: [20, 60, 1250, 2400, 3500]
  });
  window.document.getElementById('export-pdf').click();
  await new Promise(setImmediate);
  assert.deepEqual(errors, []);
  assert.ok(captures.length > 3);
  assert.deepEqual(outlines[0].root.children, [
    { title: '安装', options: { pageNumber: 1 }, children: [
      { title: '子章节', options: { pageNumber: 2 }, children: [] }
    ] },
    { title: '安装', options: { pageNumber: 3 }, children: [] }
  ]);
  assert.equal(outlines[0].mode, 'UseOutlines');

  window.document.getElementById('markdown-editor').value = '# 仅有一级标题\n\n正文';
  window.document.getElementById('export-pdf').click();
  await new Promise(setImmediate);
  assert.deepEqual(downloads, ['中文手册.pdf', '仅有一级标题.pdf']);
  assert.deepEqual(outlines[1].root.children, []);
  assert.equal(outlines[1].mode, undefined);
  assert.deepEqual(errors, []);
});

test('exports a document taller than the canvas limit with bounded, contiguous page captures', async t => {
  const layoutHeight = 71666;
  const { window, downloads, errors, captures, images, canvases } = await openEditor(t, '# 长文档', { layoutHeight });
  window.document.getElementById('export-pdf').click();
  await new Promise(setImmediate);
  assert.deepEqual(errors, []);
  assert.deepEqual(downloads, ['长文档.pdf']);
  assert.ok(captures.length > 60);
  assert.equal(images.length, captures.length);
  let end = 0;
  for (const capture of captures) {
    assert.equal(capture.y * 2, end);
    assert.ok(capture.height > 0 && capture.height <= 2355);
    assert.equal(capture.width, 1588);
    end += capture.height;
  }
  assert.equal(end, layoutHeight * 2);
  assert.ok(images.every(image => image.width === 180 && image.height <= 267));
  assert.ok(canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
});

for (const failure of ['empty', 'transparent', 'context']) {
  test(`does not download a partial PDF when a later page has ${failure} output`, async t => {
    const { window, downloads, errors, captures, canvases } = await openEditor(t, '# 导出失败', {
      layoutHeight: 4000, failPage: 2, failure
    });
    window.console.error = () => {};
    window.document.getElementById('export-pdf').click();
    await new Promise(setImmediate);
    assert.equal(captures.length, 2);
    assert.deepEqual(downloads, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /PDF page 2/);
    assert.ok(canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
    assert.equal(window.document.querySelector('.pdf-export'), null);
    assert.equal(window.document.getElementById('export-pdf').disabled, false);
    assert.equal(window.document.getElementById('mobile-export-pdf').disabled, false);
    assert.doesNotMatch(window.document.body.textContent, /Download successful|Generating PDF/);
  });
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
  const { window, downloads, errors, outlines } = await openEditor(t, '# 导出验证\n\n## 正文章节');
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
  assert.ok(outlines.every(outline => outline.root.children.length === 1 &&
    outline.root.children[0].title === '正文章节' && outline.mode === 'UseOutlines'));
  assert.deepEqual(errors, []);
});
