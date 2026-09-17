/**
 * Content script —— 划词气泡 + 右侧对话面板
 *
 * 交互模型：
 *   选区旁的小气泡只做「触发器」（体量小、不挡正文），
 *   真正的问答在右侧的对话面板里展开 —— 全高、可调宽、消息流式累积、多轮追问。
 *
 * 三个关键实现约束：
 *   1. UI 挂在自定义元素 <arc-reader-ui> 的 Shadow DOM 里，宿主用内联 !important 样式，
 *      页面 CSS 几乎无法干扰（普通 div 会被各种 `div {}` 规则命中）。
 *   2. 不直接 import lib/ 下的模块（content script 不是 ESM 环境），
 *      网络请求一律通过 Port 交给 service worker。
 *   3. 模型输出必须「先转义、后渲染」——答案里可能带 <script>，而它最终会进 innerHTML。
 */

(() => {
  'use strict';
  if (window.__ARC_READER_INJECTED__) return;
  window.__ARC_READER_INJECTED__ = true;

  /* ================================================================
   * 常量
   * ================================================================ */

  // 需与 lib/prompts.js 的 MODES 保持一致（这里只用到展示用的 label）
  const UI_MODES = [
    { key: 'explain', label: '解释', desc: '把这段讲明白' },
    { key: 'translate', label: '翻译', desc: '译成中文 / 英文' },
    { key: 'example', label: '举例', desc: '给个具体例子' },
    { key: 'deeper', label: '深入', desc: '背后的原理与延伸' },
    { key: 'summarize', label: '总结', desc: '提炼要点' },
    { key: 'ask', label: '提问', desc: '输入自己的问题' },
  ];

  const MODE_LABEL = UI_MODES.reduce((acc, m) => ({ ...acc, [m.key]: m.label }), {});

  const DEFAULT_SETTINGS = {
    trigger: 'chip',
    defaultMode: 'explain',
    selectedModes: UI_MODES.map((m) => m.key),
    autoSave: true,
    panelWidth: 400,
    disabledDomains: [],
  };

  const PANEL_MIN_WIDTH = 300;
  const PANEL_MAX_WIDTH = 760;
  const MINI_SIZE = 46;

  const BLOCK_SELECTOR =
    'p, li, td, th, blockquote, dd, dt, h1, h2, h3, h4, h5, h6, pre, figcaption, caption, summary';

  const MAX_SELECTION = 6000;

  /* ================================================================
   * 状态
   * ================================================================ */

  let settings = { ...DEFAULT_SETTINGS };
  let host = null;
  let shadow = null;
  let els = null;

  /** 当前会话：{ turns: [], page: {title,url}, activeId: null, minimized: false } */
  let session = null;
  let port = null;
  let popoverRenderKey = '';
  let lastSelectionText = '';
  let statusTimer = null;

  const uid = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  /* ================================================================
   * Markdown 渲染（安全优先）
   * ================================================================ */

  // #region markdown-renderer
  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function escapeHtml(input) {
    return String(input == null ? '' : input).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
  }

  /** 输入必须是已转义文本；只生成我们自己的标签 */
  function renderInline(escaped) {
    let out = escaped;
    out = out.replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    // 只接受 http(s) 链接，其他一律保持纯文本，杜绝 javascript: 注入
    out = out.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    return out;
  }

  function renderMarkdown(source) {
    const lines = String(source || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let listType = null;
    let i = 0;

    const closeList = () => {
      if (listType) {
        out.push(`</${listType}>`);
        listType = null;
      }
    };

    while (i < lines.length) {
      const line = lines[i];

      // 代码块
      const fence = line.match(/^\s*\x60\x60\x60\s*([\w+-]*)\s*$/);
      if (fence) {
        closeList();
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*\x60\x60\x60\s*$/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++; // 跳过收尾的 ```
        out.push(
          `<pre${fence[1] ? ` data-lang="${escapeHtml(fence[1])}"` : ''}><code>${escapeHtml(
            buf.join('\n')
          )}</code></pre>`
        );
        continue;
      }

      // 标题（压到 h3~h6，避免在面板里出现过大字号）
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        closeList();
        const level = Math.min(Math.max(heading[1].length, 3), 6);
        out.push(`<h${level}>${renderInline(escapeHtml(heading[2]))}</h${level}>`);
        i++;
        continue;
      }

      // 无序列表
      const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
      if (bullet) {
        if (listType !== 'ul') {
          closeList();
          out.push('<ul>');
          listType = 'ul';
        }
        out.push(`<li>${renderInline(escapeHtml(bullet[1]))}</li>`);
        i++;
        continue;
      }

      // 有序列表
      const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ordered) {
        if (listType !== 'ol') {
          closeList();
          out.push('<ol>');
          listType = 'ol';
        }
        out.push(`<li>${renderInline(escapeHtml(ordered[1]))}</li>`);
        i++;
        continue;
      }

      // 引用
      const quoteLine = line.match(/^\s*>\s?(.*)$/);
      if (quoteLine) {
        closeList();
        out.push(`<blockquote>${renderInline(escapeHtml(quoteLine[1]))}</blockquote>`);
        i++;
        continue;
      }

      // 分割线
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        closeList();
        out.push('<hr>');
        i++;
        continue;
      }

      // 空行
      if (!line.trim()) {
        closeList();
        i++;
        continue;
      }

      // 段落：把连续的普通行并成一段
      closeList();
      const buf = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^\s*([-*•]\s|\d+[.)]\s|#{1,6}\s|>|\x60\x60\x60)/.test(lines[i])
      ) {
        buf.push(lines[i]);
        i++;
      }
      out.push(`<p>${renderInline(escapeHtml(buf.join(' ')))}</p>`);
    }

    closeList();
    return out.join('');
  }
  // #endregion markdown-renderer

  /* ================================================================
   * 选区与上下文
   * ================================================================ */

  function inOurUI(node) {
    if (!host || !node) return false;
    if (node === host) return true;
    const root = node.getRootNode ? node.getRootNode() : null;
    return !!(root && root.host === host);
  }

  function editableAncestor(node) {
    let el = node && node.nodeType === 1 ? node : node?.parentElement;
    let hops = 0;
    while (el && hops < 6) {
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return el;
      if (el.isContentEditable) return el;
      el = el.parentElement;
      hops++;
    }
    return null;
  }

  /** 把选区所在的语义块取出来当背景（选区本身常常只是半句话） */
  function extractContext(el) {
    if (!el || !el.closest) return '';
    let node = el.closest(BLOCK_SELECTOR);
    if (!node) {
      let up = el.parentElement;
      for (let i = 0; i < 3 && up; i++, up = up.parentElement) {
        if (up.matches && up.matches(BLOCK_SELECTOR)) {
          node = up;
          break;
        }
        if ((up.innerText || '').length > 200) {
          node = up;
          break;
        }
      }
    }
    if (!node) return '';
    let text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length > 1200) text = `${text.slice(0, 1200)}…`;
    return text;
  }

  function currentSelectionInfo() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text) return null;

    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    if (inOurUI(node)) return null;
    if (editableAncestor(node)) return null;

    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;

    const el = node.nodeType === 1 ? node : node.parentElement;
    return {
      text: text.slice(0, MAX_SELECTION),
      rect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
      context: extractContext(el),
    };
  }

  /* ================================================================
   * 样式
   * ================================================================ */

  const CSS = `
:host { all: initial; }

/* ---------- 划词气泡：只做触发器，体量刻意做得小 ---------- */

.pop {
  position: fixed;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 9px 10px;
  max-width: min(400px, calc(100vw - 24px));
  background: #ffffff;
  border: 1px solid rgba(15, 23, 42, 0.09);
  border-radius: 12px;
  box-shadow: 0 14px 36px rgba(15, 23, 42, 0.16), 0 2px 8px rgba(15, 23, 42, 0.07);
  font: 400 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  visibility: hidden;
  animation: arc-pop-in 0.13s ease-out;
  z-index: 2;
}
@keyframes arc-pop-in {
  from { opacity: 0; transform: translateY(-4px) scale(0.98); }
  to   { opacity: 1; transform: none; }
}

.pop-quote {
  max-width: 340px;
  font-size: 11.5px;
  line-height: 1.5;
  color: #8b939f;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-left: 2px solid rgba(99, 102, 241, 0.4);
  padding-left: 7px;
}

.pop-chips { display: flex; flex-wrap: wrap; gap: 5px; }

.chip {
  all: unset;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid rgba(15, 23, 42, 0.1);
  background: #fff;
  font-size: 12px;
  color: #334155;
  cursor: pointer;
  transition: all 0.13s;
  white-space: nowrap;
}
.chip:hover { border-color: #6366f1; color: #4f46e5; background: rgba(99, 102, 241, 0.07); }
.chip.primary { background: #4f46e5; border-color: #4f46e5; color: #fff; }
.chip.primary:hover { background: #4338ca; border-color: #4338ca; color: #fff; }

/* ---------- 右侧对话面板 ---------- */

.panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: var(--arc-panel-w, 400px);
  display: flex;
  flex-direction: column;
  background: #ffffff;
  border-left: 1px solid rgba(15, 23, 42, 0.09);
  box-shadow: -12px 0 40px rgba(15, 23, 42, 0.12);
  font: 400 13.5px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  z-index: 1;
  animation: arc-slide-in 0.2s cubic-bezier(0.22, 0.61, 0.36, 1);
}
@keyframes arc-slide-in {
  from { transform: translateX(14px); opacity: 0.4; }
  to   { transform: none; opacity: 1; }
}

.panel-resize {
  position: absolute;
  left: -3px; top: 0; bottom: 0;
  width: 7px;
  cursor: col-resize;
  z-index: 5;
}
.panel-resize::after {
  content: "";
  position: absolute;
  left: 3px; top: 0; bottom: 0;
  width: 1px;
  background: transparent;
  transition: background 0.15s;
}
.panel-resize:hover::after, .panel-resize.dragging::after { background: #6366f1; }

.panel-head {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 11px 12px 11px 15px;
  border-bottom: 1px solid rgba(15, 23, 42, 0.07);
  background: linear-gradient(180deg, rgba(99, 102, 241, 0.05), rgba(99, 102, 241, 0));
  flex: none;
  user-select: none;
}

.dot { width: 7px; height: 7px; border-radius: 50%; background: #6366f1; flex: none; }
.panel-title { min-width: 0; flex: 1; }
.panel-title b { display: block; font-size: 12.5px; font-weight: 650; color: #4f46e5; letter-spacing: 0.01em; }
.panel-sub {
  display: block; font-style: normal; font-size: 11px; color: #9aa1ac;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.head-btn {
  all: unset;
  width: 24px; height: 24px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 7px;
  color: #94a3b8;
  font-size: 13px;
  cursor: pointer;
  flex: none;
  transition: background 0.12s, color 0.12s;
}
.head-btn:hover { background: rgba(15, 23, 42, 0.07); color: #334155; }

/* 消息流 */

.timeline {
  flex: 1 1 auto;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 14px 15px 6px;
  scroll-behavior: auto;
}

.msg { margin-bottom: 16px; }
.msg:last-child { margin-bottom: 4px; }

.msg-user { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; }
.msg-label {
  font-size: 10.5px;
  font-weight: 600;
  color: #6366f1;
  background: rgba(99, 102, 241, 0.09);
  padding: 1px 8px;
  border-radius: 999px;
  letter-spacing: 0.02em;
}
.msg-quote {
  max-width: 100%;
  background: rgba(99, 102, 241, 0.06);
  border-left: 2px solid rgba(99, 102, 241, 0.45);
  border-radius: 0 9px 9px 0;
  padding: 7px 10px;
  font-size: 12px;
  line-height: 1.6;
  color: #5b6470;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 132px;
  overflow: hidden;
  position: relative;
}
.msg-quote.expandable { cursor: pointer; }
.msg-quote.expandable::after {
  content: "展开";
  position: absolute; right: 7px; bottom: 4px;
  font-size: 10px; color: #6366f1;
  background: linear-gradient(90deg, transparent, #f6f7fd 32%);
  padding: 0 3px;
}
.msg-quote.expanded { max-height: 60vh; overflow-y: auto; }
.msg-quote.expanded::after { content: "收起"; position: sticky; float: right; }

.msg-question {
  max-width: 100%;
  background: #4f46e5;
  color: #fff;
  padding: 7px 11px;
  border-radius: 11px 11px 3px 11px;
  font-size: 12.5px;
  line-height: 1.6;
  word-break: break-word;
  white-space: pre-wrap;
}

.msg-ai {
  position: relative;
  padding-left: 11px;
  border-left: 2px solid rgba(99, 102, 241, 0.22);
}

.msg-body { font-size: 13.5px; line-height: 1.72; color: #1f2328; }
.msg-body > *:first-child { margin-top: 0; }
.msg-body > *:last-child { margin-bottom: 0; }
.msg-body p { margin: 0 0 9px; word-break: break-word; }
.msg-body h3, .msg-body h4, .msg-body h5, .msg-body h6 {
  margin: 13px 0 7px; font-weight: 650; line-height: 1.4; color: #0f172a;
}
.msg-body h3 { font-size: 14px; }
.msg-body h4, .msg-body h5, .msg-body h6 { font-size: 13.5px; }
.msg-body ul, .msg-body ol { margin: 0 0 9px; padding-left: 20px; }
.msg-body li { margin: 0 0 4px; word-break: break-word; }
.msg-body strong { font-weight: 650; color: #0f172a; }
.msg-body em { font-style: normal; background: rgba(250, 204, 21, 0.22); padding: 0 2px; border-radius: 3px; }
.msg-body hr { border: none; border-top: 1px solid rgba(15, 23, 42, 0.09); margin: 11px 0; }
.msg-body blockquote {
  margin: 9px 0; padding: 2px 0 2px 11px;
  border-left: 2px solid rgba(99, 102, 241, 0.4);
  color: #475569;
}
.msg-body a { color: #4f46e5; text-decoration: none; border-bottom: 1px solid rgba(79, 70, 229, 0.3); }
.msg-body a:hover { border-bottom-color: #4f46e5; }
.msg-body code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 12px;
  background: rgba(15, 23, 42, 0.06);
  padding: 1.5px 5px;
  border-radius: 4px;
  color: #b4305c;
  word-break: break-word;
}
.msg-body pre {
  margin: 9px 0;
  padding: 11px 12px;
  background: #f7f8fa;
  border: 1px solid rgba(15, 23, 42, 0.07);
  border-radius: 10px;
  overflow-x: auto;
}
.msg-body pre code {
  background: none; padding: 0; color: #1f2328;
  font-size: 12px; line-height: 1.62; white-space: pre;
}

.msg-actions {
  display: flex;
  gap: 3px;
  margin-top: 7px;
  opacity: 0;
  transition: opacity 0.15s;
}
.msg-ai:hover .msg-actions, .msg-ai.pinned .msg-actions { opacity: 1; }

.mini-btn {
  all: unset;
  display: flex; align-items: center; gap: 4px;
  padding: 2.5px 8px;
  border-radius: 6px;
  font-size: 11px;
  color: #8b939f;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
  white-space: nowrap;
}
.mini-btn:hover { background: rgba(15, 23, 42, 0.06); color: #334155; }
.mini-btn.on { color: #d97706; }

.caret {
  display: inline-block;
  width: 6px; height: 14px;
  margin-left: 2px;
  vertical-align: -3px;
  background: #6366f1;
  border-radius: 1px;
  animation: arc-blink 1s steps(2, start) infinite;
}
@keyframes arc-blink { to { visibility: hidden; } }

.skeleton { display: flex; flex-direction: column; gap: 8px; padding: 3px 0; }
.skeleton i {
  display: block; height: 10px; border-radius: 5px;
  background: linear-gradient(90deg, rgba(15,23,42,0.07) 25%, rgba(15,23,42,0.13) 37%, rgba(15,23,42,0.07) 63%);
  background-size: 400% 100%;
  animation: arc-shimmer 1.3s ease-in-out infinite;
}
.skeleton i:nth-child(1) { width: 100%; }
.skeleton i:nth-child(2) { width: 90%; }
.skeleton i:nth-child(3) { width: 64%; }
@keyframes arc-shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }

.err {
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(220, 38, 38, 0.06);
  border: 1px solid rgba(220, 38, 38, 0.18);
  color: #b91c1c;
  font-size: 12.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}
.err-actions { margin-top: 8px; display: flex; gap: 6px; }
.err-btn {
  all: unset;
  padding: 4px 11px;
  border-radius: 7px;
  background: #b91c1c;
  color: #fff;
  font-size: 11.5px;
  cursor: pointer;
}
.err-btn.ghost { background: rgba(185, 28, 28, 0.1); color: #b91c1c; }

/* 输入区 / 状态栏 */

.panel-composer {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  padding: 10px 12px;
  border-top: 1px solid rgba(15, 23, 42, 0.07);
  background: #fcfcfd;
  flex: none;
}

.input {
  all: unset;
  flex: 1;
  min-height: 34px;
  max-height: 132px;
  padding: 7px 11px;
  border: 1px solid rgba(15, 23, 42, 0.12);
  border-radius: 10px;
  background: #fff;
  font: 400 13px/1.55 inherit;
  font-family: inherit;
  color: #1f2328;
  resize: none;
  overflow-y: auto;
  display: block;
}
.input:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.13); }
.input::placeholder { color: #a3aab6; }

.send {
  all: unset;
  flex: none;
  height: 34px;
  padding: 0 15px;
  border-radius: 10px;
  background: #4f46e5;
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  display: flex; align-items: center;
  transition: background 0.13s;
}
.send:hover { background: #4338ca; }
.send:disabled { background: #cbd5e1; cursor: default; }

.panel-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-top: 1px solid rgba(15, 23, 42, 0.06);
  background: #fcfcfd;
  flex: none;
}

.status {
  flex: 1;
  font-size: 11px;
  color: #9aa1ac;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 最小化后的悬浮球 */

.mini {
  all: unset;
  position: fixed;
  right: 14px;
  top: 50%;
  transform: translateY(-50%);
  width: ${MINI_SIZE}px;
  height: ${MINI_SIZE}px;
  border-radius: 50%;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  color: #fff;
  font: 600 12px/1 -apple-system, "Segoe UI", sans-serif;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
  box-shadow: 0 8px 22px rgba(99, 102, 241, 0.4);
  transition: transform 0.15s;
  z-index: 3;
}
.mini:hover { transform: translateY(-50%) scale(1.07); }
.mini .mini-badge {
  position: absolute;
  top: -3px; right: -3px;
  min-width: 17px; height: 17px;
  padding: 0 4px;
  border-radius: 999px;
  background: #ef4444;
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 0 0 2px #fff;
}

/* 滚动条 */

.timeline::-webkit-scrollbar, .msg-quote::-webkit-scrollbar { width: 8px; height: 8px; }
.timeline::-webkit-scrollbar-thumb, .msg-quote::-webkit-scrollbar-thumb {
  background: rgba(15, 23, 42, 0.16); border-radius: 4px;
}
.timeline::-webkit-scrollbar-thumb:hover, .msg-quote::-webkit-scrollbar-thumb:hover {
  background: rgba(15, 23, 42, 0.3);
}
.timeline::-webkit-scrollbar-track, .msg-quote::-webkit-scrollbar-track { background: transparent; }

[hidden] { display: none !important; }

/* ---------- 深色 ---------- */

@media (prefers-color-scheme: dark) {
  .pop {
    background: #1d2025; border-color: rgba(255, 255, 255, 0.1);
    box-shadow: 0 14px 36px rgba(0, 0, 0, 0.5);
  }
  .pop-quote { color: #8b93a1; border-left-color: rgba(129, 140, 248, 0.5); }
  .chip { background: #262a30; border-color: rgba(255, 255, 255, 0.11); color: #cbd5e1; }
  .chip:hover { border-color: #818cf8; color: #a5b4fc; background: rgba(129, 140, 248, 0.13); }
  .chip.primary { background: #4f46e5; border-color: #4f46e5; color: #fff; }

  .panel {
    background: #1d2025;
    border-left-color: rgba(255, 255, 255, 0.1);
    box-shadow: -12px 0 40px rgba(0, 0, 0, 0.5);
  }
  .panel-head {
    border-bottom-color: rgba(255, 255, 255, 0.07);
    background: linear-gradient(180deg, rgba(129, 140, 248, 0.09), rgba(129, 140, 248, 0));
  }
  .panel-title b { color: #a5b4fc; }
  .panel-sub { color: #6f7784; }
  .head-btn { color: #6b7280; }
  .head-btn:hover { background: rgba(255, 255, 255, 0.09); color: #cbd5e1; }

  .msg-label { color: #a5b4fc; background: rgba(129, 140, 248, 0.14); }
  .msg-quote {
    background: rgba(129, 140, 248, 0.1);
    border-left-color: rgba(129, 140, 248, 0.5);
    color: #a8b0bd;
  }
  .msg-quote.expandable::after { background: linear-gradient(90deg, transparent, #23262c 32%); color: #a5b4fc; }
  .msg-ai { border-left-color: rgba(129, 140, 248, 0.28); }
  .msg-body { color: #e3e5e8; }
  .msg-body h3, .msg-body h4, .msg-body h5, .msg-body h6, .msg-body strong { color: #f1f3f5; }
  .msg-body em { background: rgba(250, 204, 21, 0.2); }
  .msg-body hr { border-top-color: rgba(255, 255, 255, 0.1); }
  .msg-body blockquote { color: #a8b0bd; border-left-color: rgba(129, 140, 248, 0.45); }
  .msg-body a { color: #a5b4fc; border-bottom-color: rgba(165, 180, 252, 0.35); }
  .msg-body code { background: rgba(255, 255, 255, 0.09); color: #f0a0c0; }
  .msg-body pre { background: #15181c; border-color: rgba(255, 255, 255, 0.08); }
  .msg-body pre code { color: #dfe3e8; }
  .skeleton i {
    background: linear-gradient(90deg, rgba(255,255,255,0.07) 25%, rgba(255,255,255,0.14) 37%, rgba(255,255,255,0.07) 63%);
    background-size: 400% 100%;
  }
  .err { background: rgba(248, 113, 113, 0.1); border-color: rgba(248, 113, 113, 0.28); color: #fca5a5; }
  .err-btn { background: #dc2626; }
  .err-btn.ghost { background: rgba(248, 113, 113, 0.15); color: #fca5a5; }
  .mini-btn { color: #8b93a1; }
  .mini-btn:hover { background: rgba(255, 255, 255, 0.08); color: #cbd5e1; }
  .mini-btn.on { color: #fbbf24; }
  .panel-composer, .panel-foot { background: #191c20; border-top-color: rgba(255, 255, 255, 0.07); }
  .input { background: #262a30; border-color: rgba(255, 255, 255, 0.12); color: #e3e5e8; }
  .input::placeholder { color: #6b7280; }
  .send { background: #4f46e5; }
  .send:hover { background: #6366f1; }
  .send:disabled { background: #3a3f47; }
  .status { color: #6f7784; }
  .mini .mini-badge { box-shadow: 0 0 0 2px #1d2025; }
  .timeline::-webkit-scrollbar-thumb, .msg-quote::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.16); }
}

@media (prefers-reduced-motion: reduce) {
  .pop, .panel, .caret, .skeleton i { animation: none !important; }
}
`;

  const TEMPLATE = `
<div class="pop" hidden>
  <div class="pop-quote"></div>
  <div class="pop-chips"></div>
</div>

<button class="mini" hidden title="展开 AI 阅读助手"><span>AI</span></button>

<aside class="panel" hidden>
  <div class="panel-resize" title="拖动调整宽度"></div>
  <header class="panel-head">
    <span class="dot"></span>
    <div class="panel-title">
      <b>AI 阅读助手</b>
      <i class="panel-sub"></i>
    </div>
    <button class="head-btn" data-act="options" title="打开设置">⚙</button>
    <button class="head-btn" data-act="minimize" title="最小化">—</button>
    <button class="head-btn" data-act="close" title="结束对话 (Esc)">✕</button>
  </header>

  <div class="timeline"></div>

  <div class="panel-composer">
    <textarea class="input" rows="1" placeholder="继续追问…（Enter 发送，Shift+Enter 换行）"></textarea>
    <button class="send" data-act="send">发送</button>
  </div>

  <div class="panel-foot">
    <span class="status"></span>
    <button class="mini-btn" data-act="copy-all" title="复制整段对话">复制全部</button>
    <button class="mini-btn" data-act="star-last" title="收藏最后一条回答">☆ 收藏</button>
  </div>
</aside>
`;

  function ensureUI() {
    if (host && host.isConnected) return;

    host = document.createElement('arc-reader-ui');
    // 内联 !important + all:initial：页面 CSS 基本无法命中或干扰
    host.style.cssText =
      'all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important;' +
      ' width: 0 !important; height: 0 !important; display: block !important;' +
      ' z-index: 2147483647 !important; pointer-events: none !important;';

    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    const wrap = document.createElement('div');
    wrap.innerHTML = TEMPLATE;
    while (wrap.firstChild) shadow.appendChild(wrap.firstChild);

    // 宿主是 pointer-events:none（不遮挡页面），两个交互单元各自恢复
    const pop = shadow.querySelector('.pop');
    pop.style.pointerEvents = 'auto';
    const panel = shadow.querySelector('.panel');
    panel.style.pointerEvents = 'auto';
    const mini = shadow.querySelector('.mini');
    mini.style.pointerEvents = 'auto';

    (document.documentElement || document.body).appendChild(host);

    els = {
      pop,
      popQuote: shadow.querySelector('.pop-quote'),
      popChips: shadow.querySelector('.pop-chips'),
      panel,
      panelSub: shadow.querySelector('.panel-sub'),
      resize: shadow.querySelector('.panel-resize'),
      timeline: shadow.querySelector('.timeline'),
      input: shadow.querySelector('.input'),
      send: shadow.querySelector('.send'),
      status: shadow.querySelector('.status'),
      mini,
      miniBadge: null,
    };

    applyPanelWidth(settings.panelWidth);
    renderChips();
    bindUI();
  }

  /* ================================================================
   * 面板宽度
   * ================================================================ */

  function clampPanelWidth(w) {
    const max = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, window.innerWidth - 120));
    return Math.round(Math.min(Math.max(Number(w) || 400, PANEL_MIN_WIDTH), max));
  }

  function applyPanelWidth(w) {
    if (!els) return;
    els.panel.style.setProperty('--arc-panel-w', `${clampPanelWidth(w)}px`);
  }

  function bindResize() {
    const handle = els.resize;
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = els.panel.offsetWidth;
      handle.classList.add('dragging');
      const prevCursor = document.documentElement.style.cursor;
      document.documentElement.style.cursor = 'col-resize';

      const onMove = (ev) => {
        const next = startW + (startX - ev.clientX);
        applyPanelWidth(next);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
        handle.classList.remove('dragging');
        document.documentElement.style.cursor = prevCursor;
        const w = els.panel.offsetWidth;
        settings.panelWidth = w;
        chrome.storage.local.get('arc_settings').then((got) => {
          const cur = got?.arc_settings || {};
          chrome.storage.local.set({ arc_settings: { ...cur, panelWidth: w } });
        });
      };
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    });
  }

  /* ================================================================
   * 气泡（触发器）
   * ================================================================ */

  function renderChips() {
    if (!els) return;
    const enabled = new Set(settings.selectedModes || DEFAULT_SETTINGS.selectedModes);
    els.popChips.innerHTML = '';
    for (const mode of UI_MODES) {
      if (!enabled.has(mode.key)) continue;
      const btn = document.createElement('button');
      btn.className = `chip${mode.key === (settings.defaultMode || 'explain') ? ' primary' : ''}`;
      btn.textContent = mode.label;
      btn.title = mode.desc;
      btn.dataset.mode = mode.key;
      els.popChips.appendChild(btn);
    }
  }

  function positionPopover(rect) {
    if (!els) return;
    const pop = els.pop;
    pop.style.visibility = 'hidden';
    pop.hidden = false;

    const w = pop.offsetWidth || 280;
    const h = pop.offsetHeight || 64;
    const pad = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 面板占用了右侧空间，气泡的可用右边界要相应收缩，避免被盖住
    const panelOpen = !els.panel.hidden;
    const usableRight = panelOpen ? vw - els.panel.offsetWidth - pad : vw - pad;

    let top = rect.bottom + 8;
    if (top + h > vh - pad) {
      const above = rect.top - h - 8;
      top = above >= pad ? above : Math.max(pad, vh - h - pad);
    }

    let left = rect.left + rect.width / 2 - w / 2;
    const maxLeft = Math.max(pad, usableRight - w);
    left = Math.min(Math.max(left, pad), maxLeft);

    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
    pop.style.visibility = 'visible';
  }

  function showPopover(info) {
    ensureUI();
    const key = `${info.text}|${info.rect.left},${info.rect.top}`;
    popoverRenderKey = key;

    const preview = info.text.length > 70 ? `${info.text.slice(0, 70)}…` : info.text;
    els.popQuote.textContent = preview;
    renderChips();
    positionPopover(info.rect);
  }

  function hidePopover() {
    if (!els) return;
    els.pop.hidden = true;
  }

  /* ================================================================
   * 会话与时间线
   * ================================================================ */

  function ensureSession() {
    if (session) return session;
    session = {
      turns: [],
      page: { title: document.title, url: location.href },
      activeId: null,
      minimized: false,
    };
    return session;
  }

  function activeTurn() {
    if (!session?.activeId) return null;
    return session.turns[session.turns.length - 1] || null;
  }

  function openPanel() {
    ensureUI();
    ensureSession();
    els.panel.hidden = false;
    els.mini.hidden = true;
    session.minimized = false;
    els.panelSub.textContent = document.title || location.hostname;
    syncPanelState();
  }

  function minimizePanel() {
    if (!session) return;
    session.minimized = true;
    els.panel.hidden = true;
    updateMiniBadge();
    els.mini.hidden = false;
  }

  function restorePanel() {
    if (!session) return;
    session.minimized = false;
    els.mini.hidden = true;
    els.panel.hidden = false;
    // 面板刚从 hidden 恢复时 scrollHeight 还没算出来，等一帧再贴底
    requestAnimationFrame(scrollTimelineToBottom);
  }

  function endSession() {
    if (session?.turns.some((t) => t.status === 'pending')) abortRequest();
    session = null;
    hidePopover();
    if (els) {
      els.panel.hidden = true;
      els.mini.hidden = true;
      els.timeline.innerHTML = '';
      els.input.value = '';
      els.input.style.height = 'auto';
      els.status.textContent = '';
    }
  }

  function updateMiniBadge() {
    if (!els || !session) return;
    const n = session.turns.filter((t) => t.status === 'done').length;
    let badge = els.mini.querySelector('.mini-badge');
    if (!n) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'mini-badge';
      els.mini.appendChild(badge);
    }
    badge.textContent = String(n);
  }

  function syncPanelState() {
    if (!els || !session) return;
    const pending = session.turns.some((t) => t.status === 'pending');
    els.send.disabled = pending;
    els.send.textContent = pending ? '…' : '发送';
  }

  function isNearBottom() {
    const el = els.timeline;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  function scrollTimelineToBottom() {
    if (!els) return;
    els.timeline.scrollTop = els.timeline.scrollHeight;
  }

  /* ---------- 消息渲染 ---------- */

  function buildUserBlock(turn) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-user';

    const label = document.createElement('div');
    label.className = 'msg-label';
    label.textContent = MODE_LABEL[turn.mode] || '提问';
    wrap.appendChild(label);

    if (turn.selection) {
      const quote = document.createElement('div');
      quote.className = 'msg-quote';
      quote.textContent = turn.selection;
      if (turn.selection.length > 220) {
        quote.classList.add('expandable');
        quote.addEventListener('click', () => {
          quote.classList.toggle('expanded');
        });
      }
      wrap.appendChild(quote);
    }

    if (turn.question) {
      const q = document.createElement('div');
      q.className = 'msg-question';
      q.textContent = turn.question;
      wrap.appendChild(q);
    }

    return wrap;
  }

  function buildAiBlock(turn) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-ai';
    wrap.dataset.turn = turn.id;

    const body = document.createElement('div');
    body.className = 'msg-body';
    paintBody(body, turn);
    wrap.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'msg-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'mini-btn';
    copyBtn.dataset.act = 'copy-turn';
    copyBtn.dataset.id = turn.id;
    copyBtn.textContent = '复制';
    actions.appendChild(copyBtn);

    const starBtn = document.createElement('button');
    starBtn.className = `mini-btn${turn.favorite ? ' on' : ''}`;
    starBtn.dataset.act = 'star-turn';
    starBtn.dataset.id = turn.id;
    starBtn.textContent = turn.favorite ? '★ 已收藏' : '☆ 收藏';
    actions.appendChild(starBtn);

    const retryBtn = document.createElement('button');
    retryBtn.className = 'mini-btn';
    retryBtn.dataset.act = 'retry-turn';
    retryBtn.dataset.id = turn.id;
    retryBtn.textContent = '重答';
    actions.appendChild(retryBtn);

    wrap.appendChild(actions);
    return wrap;
  }

  function paintBody(bodyEl, turn) {
    if (turn.status === 'pending' && !turn.answer) {
      bodyEl.innerHTML = '<div class="skeleton"><i></i><i></i><i></i></div>';
      return;
    }
    if (turn.status === 'error') {
      const actions =
        turn.errorCode === 'NO_KEY'
          ? '<div class="err-actions"><button class="err-btn" data-act="options">去设置</button></div>'
          : '';
      bodyEl.innerHTML = `<div class="err">${escapeHtml(turn.error || '出错了')}</div>${actions}`;
      return;
    }
    bodyEl.innerHTML =
      renderMarkdown(turn.answer) + (turn.status === 'pending' ? '<span class="caret"></span>' : '');
  }

  function renderTimeline() {
    if (!els || !session) return;
    const nearBottom = isNearBottom();
    els.timeline.innerHTML = '';
    for (const turn of session.turns) {
      els.timeline.appendChild(buildUserBlock(turn));
      els.timeline.appendChild(buildAiBlock(turn));
    }
    if (nearBottom) scrollTimelineToBottom();
    updateMiniBadge();
    syncPanelState();
  }

  /** 流式增量：只重绘最后一条回答，避免整棵树重建导致的滚动跳动 */
  let paintScheduled = false;
  function schedulePaint() {
    if (paintScheduled) return;
    paintScheduled = true;
    requestAnimationFrame(() => {
      paintScheduled = false;
      const turn = activeTurn();
      if (!turn || !els) return;
      const node = els.timeline.querySelector(`.msg-ai[data-turn="${turn.id}"] .msg-body`);
      if (!node) {
        renderTimeline();
        return;
      }
      const nearBottom = isNearBottom();
      paintBody(node, turn);
      if (nearBottom) scrollTimelineToBottom();
    });
  }

  /* ================================================================
   * 提问
   * ================================================================ */

  function ensurePort() {
    if (port) return port;
    port = chrome.runtime.connect({ name: 'arc-ask' });
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      const turn = activeTurn();
      if (turn?.status === 'pending') {
        turn.status = 'error';
        turn.error = '连接已断开（页面可能发生了跳转）。重新划词即可继续。';
        renderTimeline();
      }
    });
    return port;
  }

  /**
   * 新增一轮提问
   * @param {object} opts { mode, question, selection, context }
   */
  function startTurn({ mode, question = '', selection = '', context = '' }) {
    ensureUI();
    ensureSession();
    openPanel();

    const turn = {
      id: uid(),
      mode,
      question,
      selection,
      context,
      answer: '',
      status: 'pending',
      error: '',
      errorCode: '',
      model: '',
      elapsed: 0,
      saved: false,
      favorite: false,
      recordId: null,
    };
    session.turns.push(turn);
    session.activeId = turn.id;
    session.page = { title: document.title, url: location.href };

    const badge = els.mini.querySelector('.mini-badge');
    if (badge) badge.remove();

    renderTimeline();
    scrollTimelineToBottom();
    hidePopover();
    els.status.textContent = '正在思考…';
    setStarButton(false);

    // 多轮上下文：把已完成的历史轮次带上（当前轮走 selection/context 通道）
    const history = [];
    for (const t of session.turns.slice(0, -1)) {
      if (t.status !== 'done' || !t.answer) continue;
      history.push({
        role: 'user',
        content: t.question
          ? `${t.question}`
          : `请${MODE_LABEL[t.mode] || '解释'}这段内容：${String(t.selection).slice(0, 200)}`,
      });
      history.push({ role: 'assistant', content: t.answer });
    }

    try {
      ensurePort().postMessage({
        type: 'ask',
        reqId: turn.id,
        payload: {
          mode,
          question,
          selection,
          context,
          page: session.page,
          history,
        },
      });
    } catch (err) {
      turn.status = 'error';
      turn.error = `无法连接到扩展后台：${err?.message || err}\n请到 chrome://extensions 重新加载本扩展。`;
      renderTimeline();
    }
  }

  function retryTurn(turnId) {
    const idx = session?.turns.findIndex((t) => t.id === turnId);
    if (idx < 0) return;
    const old = session.turns[idx];
    if (old.status === 'pending') return;

    // 丢弃这一轮及其之后的轮次，用同样的素材重新问一次
    session.turns.splice(idx, session.turns.length - idx);
    startTurn({ mode: old.mode, question: old.question, selection: old.selection, context: old.context });
  }

  function abortRequest() {
    const turn = activeTurn();
    if (!turn) return;
    try {
      port?.postMessage({ type: 'abort', reqId: turn.id });
    } catch {
      /* ignore */
    }
  }

  function onPortMessage(msg) {
    if (!msg || !session || !els) return;
    const turn = session.turns.find((t) => t.id === msg.reqId);
    if (!turn) return;

    switch (msg.type) {
      case 'start':
        turn.model = msg.model || '';
        break;

      case 'delta':
        turn.answer += msg.text || '';
        if (msg.reqId === session.activeId) schedulePaint();
        break;

      case 'done': {
        turn.status = 'done';
        turn.answer = msg.answer || turn.answer;
        turn.saved = !!msg.saved;
        turn.recordId = msg.recordId || null;
        turn.model = msg.model || turn.model;
        turn.elapsed = msg.elapsed || 0;
        if (msg.reqId === session.activeId) {
          renderTimeline();
          scrollTimelineToBottom();
          els.status.textContent = [turn.model, turn.elapsed ? `${(turn.elapsed / 1000).toFixed(1)}s` : '', turn.saved ? '已存档' : '未存档']
            .filter(Boolean)
            .join(' · ');
          setStarButton(false);
        }
        updateMiniBadge();
        syncPanelState();
        break;
      }

      case 'error':
        turn.status = 'error';
        turn.error = msg.message || '未知错误';
        turn.errorCode = msg.code || '';
        if (msg.reqId === session.activeId) {
          renderTimeline();
          scrollTimelineToBottom();
          els.status.textContent = '出错';
        }
        syncPanelState();
        break;

      case 'aborted':
        turn.status = turn.answer ? 'done' : 'error';
        if (!turn.answer) turn.error = '已取消。';
        if (msg.reqId === session.activeId) {
          renderTimeline();
          els.status.textContent = '已取消';
        }
        syncPanelState();
        break;

      default:
        break;
    }
  }

  function sendFollowUp() {
    if (!session) return;
    const q = els.input.value.trim();
    if (!q) return;
    if (session.turns.some((t) => t.status === 'pending')) return;

    els.input.value = '';
    els.input.style.height = 'auto';

    // 优先用刚划好、还没被消费掉的选区；否则沿用上一轮，保证语境连续
    const prev = session.turns[session.turns.length - 1];
    const attach = session.pendingAttach || prev;
    session.pendingAttach = null;

    startTurn({
      mode: 'ask',
      question: q,
      selection: attach?.selection || attach?.text || '',
      context: attach?.context || '',
    });
  }

  function setStarButton(on) {
    const btn = shadow.querySelector('[data-act="star-last"]');
    if (!btn) return;
    btn.classList.toggle('on', !!on);
    btn.textContent = on ? '★ 已收藏' : '☆ 收藏';
  }

  /* ================================================================
   * 复制 / 收藏
   * ================================================================ */

  async function writeClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 非安全上下文（http 页面）没有 clipboard API，退回 execCommand
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:-9999px;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  function turnAsMarkdown(turn) {
    const parts = [];
    if (turn.selection) parts.push(`> ${turn.selection.replace(/\n/g, '\n> ')}`);
    if (turn.question) parts.push(`**问：** ${turn.question}`);
    parts.push('', turn.answer || '');
    return parts.join('\n');
  }

  async function copyTurn(turnId) {
    const turn = session?.turns.find((t) => t.id === turnId);
    if (!turn?.answer) return;
    const md = `${turnAsMarkdown(turn)}\n\n—— ${document.title} ${location.href}`;
    const ok = await writeClipboard(md);
    flashStatus(ok ? '已复制到剪贴板' : '复制失败，请手动选中复制');
  }

  async function copyAll() {
    if (!session?.turns.length) return;
    const md = [
      `# ${document.title}`,
      location.href,
      '',
      ...session.turns.filter((t) => t.answer).map((t) => `${turnAsMarkdown(t)}\n\n---\n`),
    ].join('\n');
    const ok = await writeClipboard(md);
    flashStatus(ok ? '已复制整段对话' : '复制失败');
  }

  async function starTurn(turnId) {
    const turn = session?.turns.find((t) => t.id === turnId);
    if (!turn?.answer) return;
    const willStar = !turn.favorite;

    try {
      let recordId = turn.recordId;
      if (!recordId) {
        const res = await chrome.runtime.sendMessage({
          type: 'history:upsert',
          record: {
            url: session.page.url,
            title: session.page.title,
            selection: turn.selection,
            context: turn.context,
            mode: turn.mode,
            question: turn.question,
            answer: turn.answer,
            model: turn.model,
          },
        });
        recordId = res?.record?.id || null;
        turn.recordId = recordId;
      }
      if (recordId) {
        await chrome.runtime.sendMessage({
          type: 'history:update',
          id: recordId,
          patch: { favorite: willStar },
        });
      }
      turn.favorite = willStar;
      turn.saved = true;
      const btn = els.timeline.querySelector(`[data-act="star-turn"][data-id="${turnId}"]`);
      if (btn) {
        btn.classList.toggle('on', willStar);
        btn.textContent = willStar ? '★ 已收藏' : '☆ 收藏';
      }
      setStarButton(willStar && turnId === session.activeId);
      flashStatus(willStar ? '已收藏' : '已取消收藏');
    } catch (err) {
      flashStatus(`操作失败：${err?.message || err}`);
    }
  }

  function flashStatus(text) {
    if (!els) return;
    const prev = els.status.textContent;
    els.status.textContent = text;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      if (els && els.status.textContent === text) els.status.textContent = prev;
    }, 2200);
  }

  /* ================================================================
   * 事件绑定
   * ================================================================ */

  /**
   * 事件链路上是否包含某个节点（能穿透 Shadow DOM 拿到真实链路）。
   *
   * 这里踩过一个坑：`composedPath` 是 **Event** 的方法，Element / Node 上**没有**。
   * 早期版本写成了 `node.composedPath()`，守卫因此恒为 false —— 于是「点气泡上的按钮」
   * 被判成「点了页面别处」，在 mousedown 阶段就把气泡 display:none 掉；
   * 鼠标抬起时按钮已不在指针下，Chrome 会把 click 派发给 <html>，
   * 按钮的 click 处理器根本不执行（右侧面板于是永远弹不出来）。
   * 已加自测静态守卫：composedPath 的调用者必须是事件对象。
   */
  function eventPathHas(e, node) {
    if (!e || !node) return false;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    return path.includes(node);
  }

  /** 事件是否来自我们自己的 UI（气泡 / 面板 / 悬浮球） */
  function fromOurUI(e) {
    return eventPathHas(e, host) || inOurUI(e?.target);
  }

  function bindUI() {
    // 保住宿区：点击我们的 UI 不应清掉页面上用户选中的文字
    const keepSelection = (e) => {
      const path = e.composedPath ? e.composedPath() : [];
      const isField = path.some(
        (n) => n instanceof HTMLElement && (n.tagName === 'TEXTAREA' || n.tagName === 'INPUT')
      );
      if (!isField) e.preventDefault();
    };
    els.pop.addEventListener('mousedown', keepSelection);
    els.panel.addEventListener('mousedown', keepSelection);

    const onClick = (e) => {
      const chip = e.target.closest?.('.chip');
      if (chip) {
        const mode = chip.dataset.mode;
        const info = pendingSelection;
        if (mode === 'ask') {
          // 「提问」不是直接发问，而是把当前选区挂到会话上，等用户输入问题
          ensureSession();
          if (info) session.pendingAttach = info;
          openPanel();
          els.input.focus();
          hidePopover();
          return;
        }
        if (!info) return;
        startTurn({ mode, selection: info.text, context: info.context });
        return;
      }

      const btn = e.target.closest?.('[data-act]');
      if (!btn) return;

      switch (btn.dataset.act) {
        case 'close':
          endSession();
          break;
        case 'minimize':
          minimizePanel();
          break;
        case 'options':
          chrome.runtime.sendMessage({ type: 'ui:open-options' });
          break;
        case 'send':
          sendFollowUp();
          break;
        case 'copy-turn':
          copyTurn(btn.dataset.id);
          break;
        case 'star-turn':
          starTurn(btn.dataset.id);
          break;
        case 'retry-turn':
          retryTurn(btn.dataset.id);
          break;
        case 'copy-all':
          copyAll();
          break;
        case 'star-last': {
          const t = activeTurn();
          if (t) starTurn(t.id);
          break;
        }
        default:
          break;
      }
    };

    els.pop.addEventListener('click', onClick);
    els.panel.addEventListener('click', onClick);

    els.mini.addEventListener('click', restorePanel);

    els.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendFollowUp();
      }
    });

    els.input.addEventListener('input', () => {
      els.input.style.height = 'auto';
      els.input.style.height = `${Math.min(els.input.scrollHeight, 132)}px`;
    });

    bindResize();
  }

  /* ================================================================
   * 选区驱动
   * ================================================================ */

  let pendingSelection = null;

  function isDisabledHere() {
    return (settings.disabledDomains || []).includes(location.hostname.replace(/^\.?www\./, ''));
  }

  function interceptSelection(autoMode) {
    if (settings.trigger === 'off' || isDisabledHere()) return;

    setTimeout(() => {
      const info = currentSelectionInfo();
      if (!info) return;

      // 同一段文字的去重规则：
      //   气泡还开着 → 不要重复摆一次（位置会闪）
      //   气泡已收起（选过动作 / 关过面板）→ 必须允许重新浮出，
      //   否则用户重新划同一段文字会「什么都没发生」
      //   自动提问模式气泡永远不开，必须硬去重，否则一次双击就重复发问
      const sameText = info.text === lastSelectionText;
      if (sameText && (autoMode || (els && !els.pop.hidden))) return;
      lastSelectionText = info.text;
      pendingSelection = info;

      // 正在等回答时不打断，只把新选区记下来，等当前这轮结束再用
      if (session?.turns.some((t) => t.status === 'pending')) {
        showPopover(info);
        return;
      }

      if (autoMode) {
        startTurn({ mode: settings.defaultMode || 'explain', selection: info.text, context: info.context });
      } else {
        showPopover(info);
      }
    }, 0);
  }

  function onMouseUp(e) {
    if (fromOurUI(e)) return;
    interceptSelection(settings.trigger === 'auto');
  }

  function onKeyUp(e) {
    if (fromOurUI(e)) return;
    if (e.key !== 'Shift' && !(e.shiftKey && e.key.startsWith('Arrow'))) return;
    interceptSelection(settings.trigger === 'auto');
  }

  function onDocMouseDown(e) {
    if (!els || els.pop.hidden) return;
    // 只有「点在气泡自己身上」才留着它；点页面别处、点面板，都收起来。
    // 面板是持久 UI，气泡是临时 UI —— 但绝不能因为页面上的 mousedown 把气泡
    // 连同它的按钮一起藏掉（那会让按钮永远收不到 click）。
    if (eventPathHas(e, els.pop)) return;
    hidePopover();
  }

  function onKeyDown(e) {
    if (e.key !== 'Escape') return;
    if (els && !els.pop.hidden) {
      hidePopover();
      return;
    }
    if (session && !session.minimized && els && !els.panel.hidden) endSession();
  }

  function onScroll() {
    // 气泡跟着选区走；面板是 fixed，不受页面滚动影响
    if (!els || els.pop.hidden || !pendingSelection) return;
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (r.width || r.height) {
        pendingSelection.rect = {
          left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
        };
      }
    }
    positionPopover(pendingSelection.rect);
  }

  function onResize() {
    if (!els || els.pop.hidden || !pendingSelection) return;
    applyPanelWidth(settings.panelWidth);
    positionPopover(pendingSelection.rect);
  }

  function onRuntimeMessage(msg, _sender, sendResponse) {
    if (msg?.type !== 'arc:ask-selection') return;

    const info = currentSelectionInfo();
    if (!info) return; // 没有选区就静默忽略，让真正持有选区的 frame 接手

    const mode = msg.mode || 'explain';
    lastSelectionText = info.text;
    pendingSelection = info;

    if (mode === 'ask') {
      ensureSession();
      session.pendingAttach = info;
      openPanel();
      els.input.focus();
    } else {
      startTurn({ mode, selection: info.text, context: info.context });
    }
    sendResponse({ ok: true });
  }

  /* ================================================================
   * 设置同步与启动
   * ================================================================ */

  function applySettings(next) {
    const prevWidth = settings.panelWidth;
    settings = { ...DEFAULT_SETTINGS, ...(next || {}) };
    if (els) {
      renderChips();
      if (settings.panelWidth !== prevWidth) applyPanelWidth(settings.panelWidth);
    }
  }

  async function bootstrap() {
    try {
      const got = await chrome.storage.local.get('arc_settings');
      applySettings(got?.arc_settings);
    } catch {
      applySettings(DEFAULT_SETTINGS);
    }

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.arc_settings) {
        applySettings(changes.arc_settings.newValue);
      }
    });

    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('keyup', onKeyUp, true);
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize, true);
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
  }

  bootstrap();
})();
