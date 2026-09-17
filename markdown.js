function escapeMarkdownHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function prepareMarkdownSource(source, yaml, marked) {
  // BOM 和 Windows 换行不属于正文，但会干扰文件头分隔符的识别。
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = /^---[ \t]*\n([\s\S]*?)^(?:---|\.\.\.)[ \t]*(?:\n|$)/m.exec(normalized);
  if (!match || match.index !== 0) return normalized;

  let metadata;
  try {
    metadata = yaml.load(match[1], { schema: yaml.CORE_SCHEMA });
  } catch {
    // 编辑过程中 YAML 可能尚未写完，保留原文，不能把后面的正文一起吞掉。
    return normalized;
  }
  // 普通分隔线加 Setext 标题也可能长得像文件头；只接受键值映射或空元数据。
  if (metadata != null && (typeof metadata !== 'object' || Array.isArray(metadata))) return normalized;

  const body = normalized.slice(match[0].length);
  const title = typeof metadata?.title === 'string' ? metadata.title.replace(/\s+/g, ' ').trim() : '';
  if (!title) return body;

  // 正文已有一级标题时优先使用正文，不要求与 title 同名或出现在第一行；代码示例不算标题。
  const hasHeading = marked.lexer(body).some(token => token.type === 'heading' && token.depth === 1);
  if (hasHeading) return body;

  // title 是普通文字，转义后再生成标题，避免其中的 HTML、链接或换行变成可执行内容。
  const escapedTitle = title.replace(/[\\`*_{}\[\]()#+\-.!|~<>$&]/g, '\\$&');
  return `# ${escapedTitle}\n\n${body}`;
}

function markdownAdmonitions() {
  const opening = /^(:{3,})(note|tip|info|warning|danger|important|caution)(?:\[([^\n]*)\]|[ \t]+([^\n]*))?[ \t]*\n/i;
  const kinds = { note: 'note', info: 'note', tip: 'tip', warning: 'warning', danger: 'caution', caution: 'caution', important: 'important' };
  const render = (kind, title, body) => `<div class="markdown-alert markdown-alert-${kind}"><p class="markdown-alert-title">${title}</p>\n${body}</div>\n`;

  return {
    extensions: [{
      name: 'blockquote',
      renderer(token) {
        // 先看原始标记，避免把用户转义过的 \[!NOTE] 也变成提示块。
        if (!/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i.test(token.text)) return false;
        const quote = this.parser.parse(token.tokens);
        const match = /^<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(\n|<\/p>\n?)/i.exec(quote);
        if (!match) return false;
        const kind = match[1].toLowerCase();
        const body = (match[2].startsWith('</p>') ? '' : '<p>') + quote.slice(match[0].length);
        return render(kind, kind[0].toUpperCase() + kind.slice(1), body);
      }
    }, {
      name: 'admonition',
      level: 'block',
      start(source) { return source.match(/^:{3,}(?:note|tip|info|warning|danger|important|caution)\b/im)?.index; },
      tokenizer(source) {
        const match = opening.exec(source);
        if (!match) return;
        const stack = [match[1].length];
        let offset = match[0].length;
        let fence = null;

        for (const line of source.slice(offset).match(/[^\n]*(?:\n|$)/g)) {
          const codeFence = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line);
          if (codeFence) {
            if (!fence) fence = codeFence[1];
            else if (codeFence[1][0] === fence[0] && codeFence[1].length >= fence.length && !codeFence[2].trim()) fence = null;
          } else if (!fence) {
            // 嵌套提示块逐层闭合；代码示例中的 ::: 不应提前结束外层提示。
            const nested = opening.exec(line);
            const closing = /^(:{3,})[ \t]*(?:\n|$)/.exec(line);
            if (nested) stack.push(nested[1].length);
            else if (closing && closing[1].length >= stack[stack.length - 1]) {
              stack.pop();
              if (!stack.length) {
                return {
                  type: 'admonition', raw: source.slice(0, offset + line.length),
                  kind: kinds[match[2].toLowerCase()],
                  title: match[3] || match[4] || match[2],
                  tokens: this.lexer.blockTokens(source.slice(match[0].length, offset))
                };
              }
            }
          }
          offset += line.length;
        }
      },
      renderer(token) {
        return render(token.kind, escapeMarkdownHtml(token.title), this.parser.parse(token.tokens));
      }
    }]
  };
}

function createMarkdownRenderer({ marked, hljs, yaml, footnote, gfmHeadingId, DOMPurify }) {
  const renderer = new marked.Renderer();
  renderer.code = (code, info = '') => {
    // 文档站经常附带 title="..." 或 {1,3}，高亮器只需要最前面的语言名。
    const language = info.trim().split(/\s+/)[0].toLowerCase();
    if (language === 'mermaid') {
      return `<div class="mermaid-container"><div class="mermaid">${escapeMarkdownHtml(code)}</div></div>`;
    }
    const validLanguage = hljs.getLanguage(language) ? language : 'plaintext';
    return `<pre><code class="hljs language-${validLanguage}">${hljs.highlight(code, { language: validLanguage }).value}</code></pre>\n`;
  };

  const parser = new marked.Marked(
    { gfm: true, breaks: false, pedantic: false, renderer },
    gfmHeadingId(), markdownAdmonitions(), footnote()
  );

  // 预览和两种富文本导出共用解析、扩展及清理规则，避免同一文档出现不同结果。
  return source => DOMPurify.sanitize(parser.parse(prepareMarkdownSource(source, yaml, marked)), {
    ADD_TAGS: ['mjx-container'],
    ADD_ATTR: ['id', 'class', 'style']
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createMarkdownRenderer, prepareMarkdownSource };
}
