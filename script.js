function getPdfFilename(element) {
  // 解析器已在正文缺少一级标题时把 YAML title 转成一级标题，沿用相同的优先级。
  for (const selector of ['h1', 'h2']) {
    for (const heading of element.querySelectorAll(selector)) {
      // 用标题的纯文字命名，并清理文件系统不接受的字符和末尾句点。
      const name = heading.textContent.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');
      if (name) return `${name}.pdf`;
    }
  }
  return 'Document.pdf';
}

function preparePdfTables(element) {
  const view = element.ownerDocument.defaultView;
  element.querySelectorAll('table tr').forEach(row => {
    const background = view.getComputedStyle(row).backgroundColor;
    // html2canvas 按行绘制背景，会盖住前一行的 rowspan 文字；改由各单元格绘制原有底色。
    Array.from(row.cells).forEach(cell => {
      if (view.getComputedStyle(cell).backgroundColor === 'rgba(0, 0, 0, 0)') {
        cell.style.backgroundColor = background;
      }
    });
    row.style.backgroundColor = 'transparent';
    row.style.borderColor = 'transparent';
  });
}

function getPdfContentRanges(element, scale) {
  const doc = element.ownerDocument;
  const origin = element.getBoundingClientRect().top;
  const ranges = [];
  const addRect = (rect, isText) => {
    if (rect.width > 0 && rect.height > 0) {
      // 字形外留 1px 保护抗锯齿；块边界向内取整，避免相邻表格行因舍入重叠而连续回退。
      ranges.push(isText ? {
        top: Math.floor((rect.top - origin - 1) * scale),
        bottom: Math.ceil((rect.bottom - origin + 1) * scale)
      } : {
        top: Math.ceil((rect.top - origin) * scale),
        bottom: Math.floor((rect.bottom - origin) * scale)
      });
    }
  };

  // 按实际换行后的文字矩形分页，长段落和长代码块也能在行间断开。
  const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent.trim() || node.parentElement.closest('svg, mjx-container, style, script')) continue;
    range.selectNodeContents(node);
    Array.from(range.getClientRects()).forEach(rect => addRect(rect, true));
  }

  // 能放进一页的代码块、表格行和图形保持完整；超高代码块仍可在行间分页。
  element.querySelectorAll('pre, tr, thead, td[rowspan], th[rowspan], img, svg, .mermaid-container, mjx-container, mjx-math, h1, h2, h3, h4, h5, h6, code, kbd')
    .forEach(node => Array.from(node.getClientRects()).forEach(rect => addRect(rect, false)));

  // 图的标题、简短说明和外框一起换页，避免上一页只剩一个标题或半截边框。
  element.querySelectorAll('.mermaid-container').forEach(diagram => {
    let previous = diagram.previousElementSibling;
    if (previous?.matches('p')) previous = previous.previousElementSibling;
    if (previous?.matches('h1, h2, h3, h4, h5, h6')) {
      const top = previous.getBoundingClientRect().top;
      const rect = diagram.getBoundingClientRect();
      addRect({ top, bottom: rect.bottom, width: rect.width, height: rect.bottom - top }, false);
    }
  });
  return ranges;
}

function getPdfPageSlices(canvasHeight, pageHeight, contentRanges) {
  const height = Math.max(1, Math.floor(pageHeight));
  const ranges = contentRanges
    .map(({ top, bottom }) => ({ top: Math.max(0, Math.floor(top)), bottom: Math.ceil(bottom) }))
    .filter(({ top, bottom }) => bottom > top && bottom - top <= height)
    .sort((a, b) => b.top - a.top);
  const slices = [];
  let start = 0;

  while (start < canvasHeight) {
    let end = Math.min(start + height, canvasHeight);
    if (end < canvasHeight) {
      // 从下往上回退，兼顾同一行的行内代码、上下标和表格各列。
      for (const range of ranges) {
        if (range.top > start && range.top < end && range.bottom > end) {
          end = range.top;
        }
      }
    }
    slices.push({ start, end });
    // 下一页紧接上一页的实际切点，避免重复或漏掉像素行。
    start = end;
  }
  return slices;
}

function addPdfOutline(pdf, element, pageSlices, scale) {
  const origin = element.getBoundingClientRect().top;
  const view = element.ownerDocument.defaultView;
  const ancestors = [];
  let hasBookmarks = false;

  for (const heading of element.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    // 脚注扩展会生成只供屏幕阅读器使用的标题，代码示例也不属于正文目录。
    if (heading.matches('.footnotes .sr-only') || heading.closest('pre, code')) continue;
    const level = Number(heading.tagName.slice(1));
    if (level === 1) {
      // 一级标题不进入目录，但仍是章节边界，后面的子标题不能挂到上一章。
      ancestors.length = 0;
      continue;
    }
    const title = heading.textContent.replace(/\s+/g, ' ').trim();
    const rect = heading.getBoundingClientRect();
    if (!title || rect.width <= 0 || rect.height <= 0 || view.getComputedStyle(heading).visibility !== 'visible') continue;

    // 与分页时的标题边界保持相同取整方式；页边界上的标题归入下一页。
    const top = Math.max(0, Math.ceil((rect.top - origin) * scale));
    const pageIndex = pageSlices.findIndex(slice => top >= slice.start && top < slice.end);
    if (pageIndex < 0) continue;

    // 跳级标题挂在最近的上级下，例如 H2 后直接出现 H4 时不补造 H3。
    while (ancestors.length && ancestors.at(-1).level >= level) ancestors.pop();
    const item = pdf.outline.add(ancestors.at(-1)?.item ?? null, title, { pageNumber: pageIndex + 1 });
    ancestors.push({ level, item });
    hasBookmarks = true;
  }

  if (hasBookmarks) pdf.setDisplayMode(null, null, 'UseOutlines');
}

document.addEventListener("DOMContentLoaded", function () {
  let markdownRenderTimeout = null;
  const RENDER_DELAY = 100;
  let syncScrollingEnabled = true;
  let isEditorScrolling = false; 
  let isPreviewScrolling = false;
  let scrollSyncTimeout = null;
  const SCROLL_SYNC_DELAY = 10;
  const STORAGE_KEY = 'markdown-viewer-content';

  function saveToLocalStorage() {
    try {
      localStorage.setItem(STORAGE_KEY, markdownEditor.value);
    } catch (e) {
      console.warn('Failed to save to localStorage:', e);
    }
  }

  function loadFromLocalStorage() {
    try {
      const savedContent = localStorage.getItem(STORAGE_KEY);
      return savedContent;
    } catch (e) {
      console.warn('Failed to load from localStorage:', e);
      return null;
    }
  }

  const markdownEditor = document.getElementById("markdown-editor");
  const markdownPreview = document.getElementById("markdown-preview");
  const themeToggle = document.getElementById("theme-toggle");
  const importButton = document.getElementById("import-button");
  const fileInput = document.getElementById("file-input");
  const exportPdf = document.getElementById("export-pdf");
  const copyMarkdownButton = document.getElementById("copy-markdown-button");
  const dropzone = document.getElementById("dropzone");
  const closeDropzoneBtn = document.getElementById("close-dropzone");
  const toggleSyncButton = document.getElementById("toggle-sync");
  const editorPane = document.getElementById("markdown-editor");
  const previewPane = document.querySelector(".preview-pane");
  const readingTimeElement = document.getElementById("reading-time");
  const wordCountElement = document.getElementById("word-count");
  const charCountElement = document.getElementById("char-count");
  const resizer = document.getElementById("resizer");
  const editorPaneContainer = document.querySelector(".editor-pane");

  const mobileMenuToggle    = document.getElementById("mobile-menu-toggle");
  const mobileMenuPanel     = document.getElementById("mobile-menu-panel");
  const mobileMenuOverlay   = document.getElementById("mobile-menu-overlay");
  const mobileCloseMenu     = document.getElementById("close-mobile-menu");
  const mobileReadingTime   = document.getElementById("mobile-reading-time");
  const mobileWordCount     = document.getElementById("mobile-word-count");
  const mobileCharCount     = document.getElementById("mobile-char-count");
  const mobileToggleSync    = document.getElementById("mobile-toggle-sync");
  const mobileImportBtn     = document.getElementById("mobile-import-button");
  const mobileExportPdf     = document.getElementById("mobile-export-pdf");
  const mobileCopyMarkdown  = document.getElementById("mobile-copy-markdown");
  const mobileThemeToggle   = document.getElementById("mobile-theme-toggle");

  // Check dark mode preference first for proper initialization
  const prefersDarkMode =
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  
  document.documentElement.setAttribute(
    "data-theme",
    prefersDarkMode ? "dark" : "light"
  );
  
  themeToggle.innerHTML = prefersDarkMode
    ? '<i class="bi bi-sun"></i>'
    : '<i class="bi bi-moon"></i>';

  const initMermaid = () => {
    const currentTheme = document.documentElement.getAttribute("data-theme");
    const mermaidTheme = currentTheme === "dark" ? "dark" : "default";
    
    mermaid.initialize({
      startOnLoad: false,
      theme: mermaidTheme,
      securityLevel: 'loose',
      flowchart: { useMaxWidth: true, htmlLabels: true },
      fontSize: 16
    });
  };

  initMermaid();

  const initMermaidZoom = () => {
    console.log('initMermaidZoom called');
    const mermaidContainers = document.querySelectorAll('.mermaid-container');
    console.log('Found mermaid containers:', mermaidContainers.length);
    
    mermaidContainers.forEach((container, index) => {
      console.log('Processing container', index);
      const svg = container.querySelector('svg');
      if (!svg) {
        console.log('No SVG found in container', index);
        return;
      }
      
      console.log('Found SVG in container', index);
      
      let scale = 1;
      let panning = false;
      let pointX = 0;
      let pointY = 0;
      let startX = 0;
      let startY = 0;
      
      svg.style.cursor = 'grab';
      svg.style.transition = 'transform 0.1s ease-out';
      
      const setTransform = () => {
        svg.style.transform = `translate(${pointX}px, ${pointY}px) scale(${scale})`;
      };
      
      svg.addEventListener('mousedown', (e) => {
        e.preventDefault();
        panning = true;
        startX = e.clientX - pointX;
        startY = e.clientY - pointY;
        svg.style.cursor = 'grabbing';
        svg.style.transition = 'none';
      });
      
      svg.addEventListener('mousemove', (e) => {
        if (!panning) return;
        e.preventDefault();
        pointX = e.clientX - startX;
        pointY = e.clientY - startY;
        setTransform();
      });
      
      svg.addEventListener('mouseup', () => {
        panning = false;
        svg.style.cursor = 'grab';
        svg.style.transition = 'transform 0.1s ease-out';
      });
      
      svg.addEventListener('mouseleave', () => {
        panning = false;
        svg.style.cursor = 'grab';
        svg.style.transition = 'transform 0.1s ease-out';
      });
      
      svg.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const newScale = scale * delta;
        
        if (newScale >= 0.1 && newScale <= 10) {
          scale = newScale;
          setTransform();
        }
      });
      
      svg.addEventListener('dblclick', () => {
        scale = 1;
        pointX = 0;
        pointY = 0;
        setTransform();
      });

      const copyButton = document.createElement('button');
      copyButton.className = 'mermaid-copy-btn';
      copyButton.innerHTML = '<i class="bi bi-clipboard"></i> Copy as Image';
      copyButton.title = 'Copy diagram as image to clipboard';
      copyButton.addEventListener('click', async () => {
        try {
          await copySvgToClipboard(svg);
          const originalText = copyButton.innerHTML;
          copyButton.innerHTML = '<i class="bi bi-check-lg"></i> Copied!';
          setTimeout(() => {
            copyButton.innerHTML = originalText;
          }, 2000);
        } catch (error) {
          console.error('Failed to copy SVG:', error);
          alert('Failed to copy diagram: ' + error.message);
        }
      });
      container.appendChild(copyButton);
    });
  };

  async function copySvgToClipboard(svg) {
    const svgClone = svg.cloneNode(true);
    svgClone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svgClone.setAttribute('width', svgClone.getAttribute('width') || '100%');
    svgClone.setAttribute('height', svgClone.getAttribute('height') || '100%');
    
    const bbox = svg.getBoundingClientRect();
    const width = Math.max(bbox.width, 300);
    const height = Math.max(bbox.height, 200);
    
    svgClone.setAttribute('width', width);
    svgClone.setAttribute('height', height);
    
    const svgData = new XMLSerializer().serializeToString(svgClone);
    const svgBase64 = btoa(unescape(encodeURIComponent(svgData)));
    const svgUrl = `data:image/svg+xml;base64,${svgBase64}`;
    
    const img = new Image();
    
    try {
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = svgUrl;
      });
      
      const canvas = document.createElement('canvas');
      const padding = 20;
      canvas.width = width + padding * 2;
      canvas.height = height + padding * 2;
      
      const ctx = canvas.getContext('2d');
      const currentTheme = document.documentElement.getAttribute('data-theme');
      ctx.fillStyle = currentTheme === 'dark' ? '#0d1117' : '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, padding, padding, width, height);
      
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(resolve, 'image/png');
      });
      
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': blob })
        ]);
      } else {
        throw new Error('Clipboard API not available in this context');
      }
    } catch (error) {
      throw new Error('Failed to convert SVG to image: ' + error.message);
    }
  }

  const renderDocument = createMarkdownRenderer({
    marked, hljs, yaml: jsyaml, footnote: markedFootnote,
    gfmHeadingId: markedGfmHeadingId.gfmHeadingId, DOMPurify
  });

  const sampleMarkdown = `# Welcome to Markdown Viewer

## ✨ Key Features
- **Live Preview** with GitHub styling
- **Markdown Import and PDF Export**
- **Mermaid Diagrams** for visual documentation
- **LaTeX Math Support** for scientific notation
- **Emoji Support** 😄 👍 🎉

## 💻 Code with Syntax Highlighting
\`\`\`javascript
  function renderMarkdown() {
    const markdown = markdownEditor.value;
    const html = marked.parse(markdown);
    const sanitizedHtml = DOMPurify.sanitize(html);
    markdownPreview.innerHTML = sanitizedHtml;
    
    // Apply syntax highlighting to code blocks
    markdownPreview.querySelectorAll('pre code').forEach((block) => {
        hljs.highlightElement(block);
    });
  }
\`\`\`

## 🧮 Mathematical Expressions
Write complex formulas with LaTeX syntax:

Inline equation: $$E = mc^2$$

Display equations:
$$\\frac{\\partial f}{\\partial x} = \\lim_{h \\to 0} \\frac{f(x+h) - f(x)}{h}$$

$$\\sum_{i=1}^{n} i^2 = \\frac{n(n+1)(2n+1)}{6}$$

## 📊 Mermaid Diagrams
Create powerful visualizations directly in markdown:

\`\`\`mermaid
flowchart LR
    A[Start] --> B{Is it working?}
    B -->|Yes| C[Great!]
    B -->|No| D[Debug]
    C --> E[Deploy]
    D --> B
\`\`\`

### Sequence Diagram Example
\`\`\`mermaid
sequenceDiagram
    User->>Editor: Type markdown
    Editor->>Preview: Render content
    User->>Editor: Make changes
    Editor->>Preview: Update rendering
    User->>Export: Save as PDF
\`\`\`

## 📋 Task Management
- [x] Create responsive layout
- [x] Implement live preview with GitHub styling
- [x] Add syntax highlighting for code blocks
- [x] Support math expressions with LaTeX
- [x] Enable mermaid diagrams

## 🆚 Feature Comparison

| Feature                  | Markdown Viewer (Ours) | Other Markdown Editors  |
|:-------------------------|:----------------------:|:-----------------------:|
| Live Preview             | ✅ GitHub-Styled       | ✅                     |
| Sync Scrolling           | ✅ Two-way             | 🔄 Partial/None        |
| Mermaid Support          | ✅                     | ❌/Limited             |
| LaTeX Math Rendering     | ✅                     | ❌/Limited             |

### 📝 Multi-row Headers Support

<table>
  <thead>
    <tr>
      <th rowspan="2">Document Type</th>
      <th colspan="2">Support</th>
    </tr>
    <tr>
      <th>Markdown Viewer (Ours)</th>
      <th>Other Markdown Editors</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Technical Docs</td>
      <td>Full + Diagrams</td>
      <td>Limited/Basic</td>
    </tr>
    <tr>
      <td>Research Notes</td>
      <td>Full + Math</td>
      <td>Partial</td>
    </tr>
    <tr>
      <td>Developer Guides</td>
      <td>Full + Export Options</td>
      <td>Basic</td>
    </tr>
  </tbody>
</table>

## 📝 Text Formatting Examples

### Text Formatting

Text can be formatted in various ways for ~~strikethrough~~, **bold**, *italic*, or ***bold italic***.

For highlighting important information, use <mark>highlighted text</mark> or add <u>underlines</u> where appropriate.

### Superscript and Subscript

Chemical formulas: H<sub>2</sub>O, CO<sub>2</sub>  
Mathematical notation: x<sup>2</sup>, e<sup>iπ</sup>

### Keyboard Keys

Press <kbd>Ctrl</kbd> + <kbd>B</kbd> for bold text.

### Abbreviations

<abbr title="Graphical User Interface">GUI</abbr>  
<abbr title="Application Programming Interface">API</abbr>

### Text Alignment

<div style="text-align: center">
Centered text for headings or important notices
</div>

<div style="text-align: right">
Right-aligned text (for dates, signatures, etc.)
</div>

### **Lists**

Create bullet points:
* Item 1
* Item 2
  * Nested item
    * Nested further

### **Links and Images**

Add a [link](https://github.com/ThisIs-Developer/Markdown-Viewer) to important resources.

Embed an image:
![Markdown Logo](https://example.com/logo.png)

### **Blockquotes**

Quote someone famous:
> "The best way to predict the future is to invent it." - Alan Kay

---

## 🛡️ Security Note

This is a fully client-side application. Your content never leaves your browser and stays secure on your device.`;

  const savedContent = loadFromLocalStorage();
  markdownEditor.value = savedContent || sampleMarkdown;

  async function renderMarkdown() {
    try {
      const markdown = markdownEditor.value;
      markdownPreview.innerHTML = renderDocument(markdown);

      // 围栏代码已在解析时高亮；这里只补处理文档直接嵌入的 HTML 代码块。
      markdownPreview.querySelectorAll('pre code:not(.hljs)').forEach(block => {
        try {
          hljs.highlightElement(block);
        } catch (e) {
          console.warn('Syntax highlighting failed for a code block:', e);
        }
      });

      processEmojis(markdownPreview);
      
      // Reinitialize mermaid with current theme before rendering diagrams
      initMermaid();
      
      try {
        await mermaid.run({
          nodes: markdownPreview.querySelectorAll('.mermaid'),
          suppressErrors: true
        });
        initMermaidZoom();
      } catch (e) {
        console.warn("Mermaid rendering failed:", e);
      }
      
      if (window.MathJax) {
        try {
          MathJax.typesetPromise([markdownPreview]).catch((err) => {
            console.warn('MathJax typesetting failed:', err);
          });
        } catch (e) {
          console.warn("MathJax rendering failed:", e);
        }
      }

      updateDocumentStats();
    } catch (e) {
      console.error("Markdown rendering failed:", e);
      markdownPreview.innerHTML = `<div class="alert alert-danger">
              <strong>Error rendering markdown:</strong> ${escapeMarkdownHtml(e.message)}
          </div>
          <pre>${escapeMarkdownHtml(markdownEditor.value)}</pre>`;
    }
  }

  function importMarkdownFile(file) {
    const reader = new FileReader();
    reader.onload = function(e) {
      markdownEditor.value = e.target.result;
      renderMarkdown();
      saveToLocalStorage();
      dropzone.style.display = "none";
    };
    reader.readAsText(file);
  }

  function processEmojis(element) {
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );
    
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      let parent = node.parentNode;
      let isInCode = false;
      while (parent && parent !== element) {
        if (parent.tagName === 'PRE' || parent.tagName === 'CODE' || parent.classList?.contains('mermaid')) {
          isInCode = true;
          break;
        }
        parent = parent.parentNode;
      }
      
      if (!isInCode && node.nodeValue.includes(':')) {
        textNodes.push(node);
      }
    }
    
    textNodes.forEach(textNode => {
      const text = textNode.nodeValue;
      const emojiRegex = /:([\w+-]+):/g;
      
      let match;
      let lastIndex = 0;
      let result = '';
      let hasEmoji = false;
      
      while ((match = emojiRegex.exec(text)) !== null) {
        const shortcode = match[1];
        const emoji = joypixels.shortnameToUnicode(`:${shortcode}:`);
        
        if (emoji !== `:${shortcode}:`) { // If conversion was successful
          hasEmoji = true;
          result += text.substring(lastIndex, match.index) + emoji;
          lastIndex = emojiRegex.lastIndex;
        } else {
          result += text.substring(lastIndex, emojiRegex.lastIndex);
          lastIndex = emojiRegex.lastIndex;
        }
      }
      
      if (hasEmoji) {
        result += text.substring(lastIndex);
        const span = document.createElement('span');
        // 文本中的 <...> 可能来自已转义的标题，替换表情时不能把它重新当成 HTML。
        span.textContent = result;
        textNode.parentNode.replaceChild(span, textNode);
      }
    });
  }

  function debouncedRender() {
    clearTimeout(markdownRenderTimeout);
    markdownRenderTimeout = setTimeout(() => {
      renderMarkdown();
      saveToLocalStorage();
    }, RENDER_DELAY);
  }

  function updateDocumentStats() {
    const text = markdownEditor.value;

    const charCount = text.length;
    charCountElement.textContent = charCount.toLocaleString();

    const wordCount = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
    wordCountElement.textContent = wordCount.toLocaleString();

    const readingTimeMinutes = Math.ceil(wordCount / 200);
    readingTimeElement.textContent = readingTimeMinutes;
  }

  function syncEditorToPreview() {
    if (!syncScrollingEnabled || isPreviewScrolling) return;

    isEditorScrolling = true;
    clearTimeout(scrollSyncTimeout);

    scrollSyncTimeout = setTimeout(() => {
      const editorScrollRatio =
        editorPane.scrollTop /
        (editorPane.scrollHeight - editorPane.clientHeight);
      const previewScrollPosition =
        (previewPane.scrollHeight - previewPane.clientHeight) *
        editorScrollRatio;

      if (!isNaN(previewScrollPosition) && isFinite(previewScrollPosition)) {
        previewPane.scrollTop = previewScrollPosition;
      }

      setTimeout(() => {
        isEditorScrolling = false;
      }, 50);
    }, SCROLL_SYNC_DELAY);
  }

  function syncPreviewToEditor() {
    if (!syncScrollingEnabled || isEditorScrolling) return;

    isPreviewScrolling = true;
    clearTimeout(scrollSyncTimeout);

    scrollSyncTimeout = setTimeout(() => {
      const previewScrollRatio =
        previewPane.scrollTop /
        (previewPane.scrollHeight - previewPane.clientHeight);
      const editorScrollPosition =
        (editorPane.scrollHeight - editorPane.clientHeight) *
        previewScrollRatio;

      if (!isNaN(editorScrollPosition) && isFinite(editorScrollPosition)) {
        editorPane.scrollTop = editorScrollPosition;
      }

      setTimeout(() => {
        isPreviewScrolling = false;
      }, 50);
    }, SCROLL_SYNC_DELAY);
  }

  function toggleSyncScrolling() {
    syncScrollingEnabled = !syncScrollingEnabled;
    if (syncScrollingEnabled) {
      toggleSyncButton.innerHTML = '<i class="bi bi-link-45deg"></i> Sync Off';
      toggleSyncButton.classList.add("sync-disabled");
      toggleSyncButton.classList.remove("sync-enabled");
      toggleSyncButton.classList.add("border-primary");
    } else {
      toggleSyncButton.innerHTML = '<i class="bi bi-link"></i> Sync On';
      toggleSyncButton.classList.add("sync-enabled");
      toggleSyncButton.classList.remove("sync-disabled");
      toggleSyncButton.classList.remove("border-primary");
    }
  }

  function openMobileMenu() {
    mobileMenuPanel.classList.add("active");
    mobileMenuOverlay.classList.add("active");
  }
  function closeMobileMenu() {
    mobileMenuPanel.classList.remove("active");
    mobileMenuOverlay.classList.remove("active");
  }
  mobileMenuToggle.addEventListener("click", openMobileMenu);
  mobileCloseMenu.addEventListener("click", closeMobileMenu);
  mobileMenuOverlay.addEventListener("click", closeMobileMenu);

  function updateMobileStats() {
    mobileCharCount.textContent   = charCountElement.textContent;
    mobileWordCount.textContent   = wordCountElement.textContent;
    mobileReadingTime.textContent = readingTimeElement.textContent;
  }

  const origUpdateStats = updateDocumentStats;
  updateDocumentStats = function() {
    origUpdateStats();
    updateMobileStats();
  };

  mobileToggleSync.addEventListener("click", () => {
    toggleSyncScrolling();
    if (syncScrollingEnabled) {
      mobileToggleSync.innerHTML = '<i class="bi bi-link-45deg me-2"></i> Sync Off';
      mobileToggleSync.classList.add("sync-disabled");
      mobileToggleSync.classList.remove("sync-enabled");
      mobileToggleSync.classList.add("border-primary");
    } else {
      mobileToggleSync.innerHTML = '<i class="bi bi-link me-2"></i> Sync On';
      mobileToggleSync.classList.add("sync-enabled");
      mobileToggleSync.classList.remove("sync-disabled");
      mobileToggleSync.classList.remove("border-primary");
    }
  });
  mobileImportBtn.addEventListener("click", () => fileInput.click());
  mobileExportPdf.addEventListener("click", () => exportPdf.click());
  mobileCopyMarkdown.addEventListener("click", () => copyMarkdownButton.click());
  mobileThemeToggle.addEventListener("click", () => {
    themeToggle.click();
    mobileThemeToggle.innerHTML = themeToggle.innerHTML + " Toggle Dark Mode";
  });
  
  renderMarkdown();
  updateMobileStats();

  markdownEditor.addEventListener("input", debouncedRender);
  editorPane.addEventListener("scroll", syncEditorToPreview);
  previewPane.addEventListener("scroll", syncPreviewToEditor);
  toggleSyncButton.addEventListener("click", toggleSyncScrolling);
  themeToggle.addEventListener("click", function () {
    const theme =
      document.documentElement.getAttribute("data-theme") === "dark"
        ? "light"
        : "dark";
    document.documentElement.setAttribute("data-theme", theme);

    if (theme === "dark") {
      themeToggle.innerHTML = '<i class="bi bi-sun"></i>';
    } else {
      themeToggle.innerHTML = '<i class="bi bi-moon"></i>';
    }
    
    renderMarkdown();
  });

  importButton.addEventListener("click", function () {
    fileInput.click();
  });

  fileInput.addEventListener("change", function (e) {
    const file = e.target.files[0];
    if (file) {
      importMarkdownFile(file);
    }
    this.value = "";
  });

  exportPdf.addEventListener("click", async function (event) {
    event.preventDefault();
    if (exportPdf.disabled) return;
    const originalText = exportPdf.innerHTML;
    let progressContainer;
    let tempElement;
    try {
      exportPdf.innerHTML = '<i class="bi bi-hourglass-split"></i> Generating...';
      exportPdf.disabled = true;
      mobileExportPdf.disabled = true;

      progressContainer = document.createElement('div');
      progressContainer.style.position = 'fixed';
      progressContainer.style.top = '50%';
      progressContainer.style.left = '50%';
      progressContainer.style.transform = 'translate(-50%, -50%)';
      progressContainer.style.padding = '15px 20px';
      progressContainer.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
      progressContainer.style.color = 'white';
      progressContainer.style.borderRadius = '5px';
      progressContainer.style.zIndex = '9999';
      progressContainer.style.textAlign = 'center';

      const statusText = document.createElement('div');
      statusText.textContent = 'Generating PDF...';
      progressContainer.appendChild(statusText);
      document.body.appendChild(progressContainer);

      const markdown = markdownEditor.value;
      const sanitizedHtml = renderDocument(markdown);

      tempElement = document.createElement("div");
      tempElement.className = "markdown-body pdf-export";
      tempElement.innerHTML = sanitizedHtml;
      const filename = getPdfFilename(tempElement);
      tempElement.style.padding = "20px";
      tempElement.style.width = "210mm";
      tempElement.style.margin = "0 auto";
      tempElement.style.fontSize = "14px";
      tempElement.style.position = "fixed";
      tempElement.style.left = "-9999px";
      tempElement.style.top = "0";

      const currentTheme = document.documentElement.getAttribute("data-theme");
      tempElement.style.backgroundColor = currentTheme === "dark" ? "#0d1117" : "#ffffff";
      tempElement.style.color = currentTheme === "dark" ? "#c9d1d9" : "#24292e";

      document.body.appendChild(tempElement);

      try {
        await mermaid.run({
          nodes: tempElement.querySelectorAll('.mermaid'),
          suppressErrors: true
        });
      } catch (mermaidError) {
        console.warn("Mermaid rendering issue:", mermaidError);
      }

      if (window.MathJax) {
        try {
          await MathJax.typesetPromise([tempElement]);
        } catch (mathJaxError) {
          console.warn("MathJax rendering issue:", mathJaxError);
        }
      }

      // 图片和字体会改变行高，必须等排版稳定后再测量分页位置。
      await Promise.all(Array.from(tempElement.querySelectorAll('img'), img =>
        img.decode().catch(() => {})
      ));
      await document.fonts.ready;

      const pdfOptions = {
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4',
        compress: true,
        hotfixes: ["px_scaling"]
      };

      const pdf = new jspdf.jsPDF(pdfOptions);
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 15;
      const contentWidth = pageWidth - (margin * 2);

      const renderScale = 2;
      const canvasWidth = Math.ceil(tempElement.getBoundingClientRect().width) * renderScale;
      const scaleFactor = canvasWidth / contentWidth;
      const maxPageHeight = Math.floor((pageHeight - margin * 2) * scaleFactor);
      let pageSlices;
      const renderOptions = {
        scale: renderScale,
        width: canvasWidth / renderScale,
        useCORS: true,
        allowTaint: true,
        logging: false,
        windowWidth: 1000,
        windowHeight: tempElement.scrollHeight,
        scrollX: 0,
        scrollY: 0,
        onclone: (clonedDocument) => {
          const clonedContent = clonedDocument.querySelector('.pdf-export');
          preparePdfTables(clonedContent);
          if (!pageSlices) {
            // 首次克隆时先测量完整排版；这里只保存坐标，不创建整篇长画布。
            const height = Math.ceil(clonedContent.getBoundingClientRect().height) * renderScale;
            const contentRanges = getPdfContentRanges(clonedContent, renderScale);
            pageSlices = getPdfPageSlices(height, maxPageHeight, contentRanges);
            addPdfOutline(pdf, clonedContent, pageSlices, renderScale);
          }
        }
      };

      // 第一页的切点要等 onclone 测量后才知道，先绘制至多一页，再裁掉切点之后的部分。
      let canvas = await html2canvas(tempElement, {
        ...renderOptions,
        y: 0,
        height: maxPageHeight / renderScale
      });

      for (let page = 0; page < pageSlices.length; page++) {
        statusText.textContent = `Generating PDF... ${page + 1}/${pageSlices.length}`;
        const sourceY = pageSlices[page].start;
        const sourceHeight = pageSlices[page].end - sourceY;
        const destHeight = sourceHeight / scaleFactor;

        if (page > 0) {
          // y 和 height 使用 CSS 像素；分页坐标是放大后的像素，必须换算后再截图。
          canvas = await html2canvas(tempElement, {
            ...renderOptions,
            y: sourceY / renderScale,
            height: sourceHeight / renderScale
          });
        }

        let pageCanvas = canvas;
        try {
          const context = canvas.getContext('2d');
          // 导出背景始终不透明；全透明像素或空图片表示绘制失败，不能继续保存空白 PDF。
          if (!context || canvas.width !== canvasWidth || canvas.height < sourceHeight ||
              context.getImageData(0, 0, 1, 1).data[3] === 0) {
            throw new Error(`Could not render PDF page ${page + 1}. Please try again.`);
          }

          if (canvas.height !== sourceHeight) {
            pageCanvas = document.createElement('canvas');
            pageCanvas.width = canvasWidth;
            pageCanvas.height = sourceHeight;
            const context = pageCanvas.getContext('2d');
            if (!context) throw new Error(`Could not create PDF page ${page + 1}.`);
            context.drawImage(canvas, 0, 0, canvasWidth, sourceHeight, 0, 0, canvasWidth, sourceHeight);
          }

          const imgData = pageCanvas.toDataURL('image/png');
          if (!imgData.startsWith('data:image/png;base64,') || imgData.length <= 22) {
            throw new Error(`Could not encode PDF page ${page + 1}. Please try again.`);
          }
          if (page > 0) pdf.addPage();
          pdf.addImage(imgData, 'PNG', margin, margin, contentWidth, destHeight);
        } finally {
          // 长文档逐页释放像素缓冲，避免已写入 PDF 的画布继续占用内存。
          canvas.width = canvas.height = 0;
          pageCanvas.width = pageCanvas.height = 0;
        }
      }

      pdf.save(filename);

      statusText.textContent = 'Download successful!';
      setTimeout(() => {
        progressContainer.remove();
      }, 1500);
    } catch (error) {
      console.error("PDF export failed:", error);
      alert("PDF export failed: " + error.message);
      progressContainer?.remove();
    } finally {
      tempElement?.remove();
      exportPdf.innerHTML = originalText;
      exportPdf.disabled = false;
      mobileExportPdf.disabled = false;
    }
  });

  copyMarkdownButton.addEventListener("click", function () {
    try {
      const markdownText = markdownEditor.value;
      copyToClipboard(markdownText);
    } catch (e) {
      console.error("Copy failed:", e);
      alert("Failed to copy Markdown: " + e.message);
    }
  });

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        showCopiedMessage();
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        textArea.style.position = "fixed";
        textArea.style.opacity = "0";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        const successful = document.execCommand("copy");
        document.body.removeChild(textArea);
        if (successful) {
          showCopiedMessage();
        } else {
          throw new Error("Copy command was unsuccessful");
        }
      }
    } catch (err) {
      console.error("Copy failed:", err);
      alert("Failed to copy HTML: " + err.message);
    }
  }

  function showCopiedMessage() {
    const originalText = copyMarkdownButton.innerHTML;
    copyMarkdownButton.innerHTML = '<i class="bi bi-check-lg"></i> Copied!';

    setTimeout(() => {
      copyMarkdownButton.innerHTML = originalText;
    }, 2000);
  }

  const dropEvents = ["dragenter", "dragover", "dragleave", "drop"];

  dropEvents.forEach((eventName) => {
    dropzone.addEventListener(eventName, preventDefaults, false);
    document.body.addEventListener(eventName, preventDefaults, false);
  });

  function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  ["dragenter", "dragover"].forEach((eventName) => {
    dropzone.addEventListener(eventName, highlight, false);
  });

  ["dragleave", "drop"].forEach((eventName) => {
    dropzone.addEventListener(eventName, unhighlight, false);
  });

  function highlight() {
    dropzone.classList.add("active");
  }

  function unhighlight() {
    dropzone.classList.remove("active");
  }

  dropzone.addEventListener("drop", handleDrop, false);
  dropzone.addEventListener("click", function (e) {
    if (e.target !== closeDropzoneBtn && !closeDropzoneBtn.contains(e.target)) {
      fileInput.click();
    }
  });
  closeDropzoneBtn.addEventListener("click", function(e) {
    e.stopPropagation(); 
    dropzone.style.display = "none";
  });

  function handleDrop(e) {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files.length) {
      const file = files[0];
      const isMarkdownFile =
        file.type === "text/markdown" ||
        file.name.endsWith(".md") ||
        file.name.endsWith(".markdown");
      if (isMarkdownFile) {
        importMarkdownFile(file);
      } else {
        alert("Please upload a Markdown file (.md or .markdown)");
      }
    }
  }

  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      exportPdf.click();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "c") {
      e.preventDefault();
      copyMarkdownButton.click();
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "S") {
      e.preventDefault();
      toggleSyncScrolling();
    }
  });

  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  resizer.addEventListener("mousedown", function (e) {
    isResizing = true;
    startX = e.clientX;
    startWidth = editorPaneContainer.offsetWidth;
    resizer.classList.add("resizing");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });

  document.addEventListener("mousemove", function (e) {
    if (!isResizing) return;

    const dx = e.clientX - startX;
    const newWidth = startWidth + dx;
    const containerWidth = document.querySelector(".content-container").offsetWidth;
    const minWidth = 200;
    const maxWidth = containerWidth - 200 - resizer.offsetWidth;

    if (newWidth >= minWidth && newWidth <= maxWidth) {
      editorPaneContainer.style.width = newWidth + "px";
    }
  });

  document.addEventListener("mouseup", function () {
    if (isResizing) {
      isResizing = false;
      resizer.classList.remove("resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
  });
});
