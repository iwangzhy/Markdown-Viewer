const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');

test('editor initialization and MD/HTML exports share title handling and preserve source', async () => {
  const html = readFileSync(require.resolve('../index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;
  await new Promise(resolve => window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));

  const source = '---\ntitle: "Redis <img src=x onerror=alert(1)> :smile:"\nslug: /private-metadata\n---\n\n> [!NOTE]\n> 提示\n\n正文[^a]\n\n[^a]: 说明';
  const downloads = [];
  const errors = [];
  Object.assign(window, {
    marked: require('marked'), hljs: require('highlight.js'), jsyaml: require('js-yaml'),
    markedFootnote: require('marked-footnote'), markedGfmHeadingId: require('marked-gfm-heading-id'),
    DOMPurify: require('dompurify')(window), Blob,
    mermaid: { initialize() {}, async run() {} },
    joypixels: { shortnameToUnicode: text => text === ':smile:' ? '😄' : text },
    matchMedia: () => ({ matches: false }),
    alert: message => errors.push(message),
    saveAs: (blob, filename) => downloads.push({ blob, filename })
  });
  window.console.log = () => {};
  window.localStorage.setItem('markdown-viewer-content', source);
  window.eval(readFileSync(require.resolve('../markdown.js'), 'utf8'));
  window.eval(readFileSync(require.resolve('../script.js'), 'utf8'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await Promise.resolve();

  const preview = window.document.getElementById('markdown-preview');
  assert.equal(preview.querySelector('h1').textContent, 'Redis <img src=x onerror=alert(1)> 😄');
  assert.equal(preview.querySelector('img, [onerror]'), null);
  assert.ok(preview.querySelector('.markdown-alert-note'));
  assert.ok(preview.querySelector('.footnotes'));
  assert.doesNotMatch(preview.textContent, /private-metadata/);

  window.document.getElementById('export-md').click();
  window.document.getElementById('export-html').click();
  assert.deepEqual(errors, []);
  assert.deepEqual(downloads.map(file => file.filename), ['document.md', 'document.html']);
  assert.equal(await downloads[0].blob.text(), source);
  const exported = new JSDOM(await downloads[1].blob.text());
  assert.equal(exported.window.document.querySelector('h1').textContent, 'Redis <img src=x onerror=alert(1)> :smile:');
  assert.ok(exported.window.document.querySelector('.markdown-alert-note'));
  assert.ok(exported.window.document.querySelector('.footnotes'));
  assert.ok(exported.window.document.querySelector('style').textContent.includes('.markdown-alert'));
  assert.doesNotMatch(exported.window.document.querySelector('article').textContent, /private-metadata/);
  assert.equal(exported.window.document.querySelector('article img, article [onerror]'), null);
  exported.window.close();

  const editor = window.document.getElementById('markdown-editor');
  editor.value = '---\ntitle: abc\n---\n# Welcome to Markdown Viewer';
  editor.dispatchEvent(new window.Event('input'));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(preview.textContent.trim(), 'Welcome to Markdown Viewer');
  window.document.getElementById('export-html').click();
  const bodyTitleExport = new JSDOM(await downloads.at(-1).blob.text());
  assert.equal(bodyTitleExport.window.document.querySelector('article').textContent.trim(), 'Welcome to Markdown Viewer');
  assert.equal(bodyTitleExport.window.document.querySelectorAll('h1').length, 1);
  bodyTitleExport.window.close();
  window.close();
});
