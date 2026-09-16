const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

// 加载真实分页函数；单元测试不启动编辑器，也不依赖浏览器或 CDN。
const context = vm.createContext({ document: { addEventListener() {} }, NodeFilter: { SHOW_TEXT: 4 } });
vm.runInContext(readFileSync(require.resolve('../script.js'), 'utf8'), context);
const paginate = (...args) => JSON.parse(JSON.stringify(context.getPdfPageSlices(...args)));

test('moves a page break above a Chinese text line crossing the page bottom', () => {
  assert.deepEqual(paginate(220, 100, [{ top: 92, bottom: 110 }]), [
    { start: 0, end: 92 }, { start: 92, end: 192 }, { start: 192, end: 220 }
  ]);
});

test('backs up across overlapping inline fragments and table columns', () => {
  const ranges = [{ top: 85, bottom: 96 }, { top: 92, bottom: 108 }];
  assert.equal(paginate(150, 100, ranges)[0].end, 85);
});

test('keeps a short code block or table row together', () => {
  const ranges = [{ top: 70, bottom: 130 }, { top: 93, bottom: 108 }];
  assert.equal(paginate(160, 100, ranges)[0].end, 70);
});

test('fractional borders of adjacent table rows do not push every row onto a new page', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    getClientRects: () => [{ top: 10.25 + i * 20, bottom: 30.25 + i * 20, width: 200, height: 20 }]
  }));
  const element = {
    ownerDocument: { createTreeWalker: () => ({ nextNode: () => false }), createRange: () => ({}) },
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: selector => selector === '.mermaid-container' ? [] : rows
  };
  const ranges = context.getPdfContentRanges(element, 2);
  const slices = paginate(510, 200, ranges);
  assert.equal(slices.length, 3);
  assert.equal(slices[0].end, 181);
});

test('splits an oversized code block between lines instead of producing blank pages', () => {
  const lines = Array.from({ length: 15 }, (_, i) => ({ top: i * 20 + 2, bottom: i * 20 + 18 }));
  const slices = paginate(310, 95, [{ top: 0, bottom: 310 }, ...lines]);
  assert.deepEqual(slices, [
    { start: 0, end: 82 }, { start: 82, end: 162 },
    { start: 162, end: 242 }, { start: 242, end: 310 }
  ]);
  for (const { end } of slices) {
    assert.ok(!lines.some(line => line.top < end && line.bottom > end));
  }
});

test('covers every source pixel exactly once with fractional dimensions', () => {
  const slices = paginate(1001, 100.75, [{ top: 90.7, bottom: 109.2 }]);
  let covered = 0;
  for (const { start, end } of slices) {
    assert.equal(start, covered);
    assert.ok(Number.isInteger(start) && Number.isInteger(end));
    assert.ok(end > start && end - start <= 100);
    covered = end;
  }
  assert.equal(covered, 1001);
  assert.equal(slices[0].end, 90);
});

test('does not add a blank page for exact page boundaries or a short document', () => {
  assert.deepEqual(paginate(200, 100, [{ top: 80, bottom: 100 }]), [
    { start: 0, end: 100 }, { start: 100, end: 200 }
  ]);
  assert.deepEqual(paginate(40, 100, []), [{ start: 0, end: 40 }]);
});

test('makes progress even when a single image is taller than a page', () => {
  assert.deepEqual(paginate(250, 100, [{ top: 0, bottom: 250 }]), [
    { start: 0, end: 100 }, { start: 100, end: 200 }, { start: 200, end: 250 }
  ]);
});

test('moves the diagram frame, title and description together', () => {
  const heading = { matches: () => true, getBoundingClientRect: () => ({ top: 60 }) };
  const description = { matches: selector => selector === 'p', previousElementSibling: heading };
  const frame = { top: 80, bottom: 140, width: 200, height: 60 };
  const diagram = {
    previousElementSibling: description,
    getBoundingClientRect: () => frame,
    getClientRects: () => [frame]
  };
  const element = {
    ownerDocument: { createTreeWalker: () => ({ nextNode: () => false }), createRange: () => ({}) },
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => [diagram]
  };
  assert.equal(paginate(160, 100, context.getPdfContentRanges(element, 1))[0].end, 60);

  // 标题到图底部超过一页时，只保护图本身，不让内容卡在空白页上。
  heading.getBoundingClientRect = () => ({ top: 10 });
  assert.equal(paginate(160, 100, context.getPdfContentRanges(element, 1))[0].end, 80);
});

test('removes row paint over rowspan cells while retaining stripe and explicit cell colors', () => {
  const cell = background => ({ style: {}, backgroundColor: background });
  const spanningCell = cell('rgba(0, 0, 0, 0)');
  const customCell = cell('rgb(255, 230, 150)');
  const stripedCell = cell('rgba(0, 0, 0, 0)');
  const rows = [
    { style: {}, backgroundColor: 'rgb(22, 27, 34)', cells: [spanningCell, customCell] },
    { style: {}, backgroundColor: 'rgb(28, 33, 40)', cells: [stripedCell] }
  ];
  context.preparePdfTables({
    ownerDocument: { defaultView: { getComputedStyle: node => node } },
    querySelectorAll: () => rows
  });
  assert.equal(spanningCell.style.backgroundColor, 'rgb(22, 27, 34)');
  assert.equal(stripedCell.style.backgroundColor, 'rgb(28, 33, 40)');
  assert.equal(customCell.style.backgroundColor, undefined);
  for (const row of rows) {
    assert.equal(row.style.backgroundColor, 'transparent');
    assert.equal(row.style.borderColor, 'transparent');
  }
});
