/**
 * 从 content.js 里抽取真实的 CSS 与 DOM 模板，生成一个静态预览页。
 *
 * 目的：改完界面后不用重新加载扩展就能看到面板长什么样。
 * 样式和结构都取自真实源码，所以预览不会和实际效果脱节。
 *
 * 运行：node tools/make_preview.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const src = fs.readFileSync(path.join(root, 'content/content.js'), 'utf8');

const cssRaw = (src.match(/const CSS = `([\s\S]*?)\n`;/) || [])[1];
const tplRaw = (src.match(/const TEMPLATE = `([\s\S]*?)\n`;/) || [])[1];
if (!cssRaw || !tplRaw) throw new Error('无法从 content.js 提取 CSS 或 TEMPLATE');

const MINI_SIZE = 46;
const css = cssRaw.replace(/\$\{MINI_SIZE\}/g, String(MINI_SIZE));
const tpl = tplRaw.replace(/\$\{MINI_SIZE\}/g, String(MINI_SIZE));

// 预览时把所有 hidden 打开，并给气泡一个固定落点（真实场景里由 JS 定位）
const shown = tpl
  .replace(/\shidden(?=[\s>])/g, '')
  .replace('class="pop"', 'class="pop" style="left: 430px; top: 226px; visibility: visible;"')
  .replace('class="mini"', 'class="mini" style="display: none;"');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>AI 阅读助手 · 界面预览</title>
<style>
  /* 仅预览页自身的壳样式；面板与气泡的样式全部来自 content.js 的真实 CSS */
  body {
    margin: 0;
    background: #ffffff;
    color: #1f2328;
    font: 400 15px/1.9 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .page {
    max-width: 720px;
    margin: 0 auto;
    padding: 40px 48px 120px 40px;
  }
  @media (min-width: 1100px) { .page { margin-left: 6vw; } }
  .page h1 { font-size: 24px; margin: 0 0 6px; letter-spacing: -0.01em; }
  .page .lead { color: #8b939f; font-size: 13px; margin-bottom: 28px; }
  .page h2 { font-size: 16px; margin: 28px 0 10px; }
  .page p { color: #3d4450; }
  .page mark { background: rgba(99, 102, 241, 0.18); padding: 1px 2px; border-radius: 3px; }
  .page code {
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 13px; background: rgba(15,23,42,0.06);
    padding: 1px 5px; border-radius: 4px; color: #b4305c;
  }
  .note {
    position: fixed; left: 16px; bottom: 16px;
    font-size: 12px; color: #8b939f; background: #f6f7f9;
    border: 1px solid rgba(15,23,42,0.08); border-radius: 9px;
    padding: 8px 12px; max-width: 300px; line-height: 1.6;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #16181c; color: #e3e5e8; }
    .page p { color: #b9bfc9; }
    .page .lead { color: #6f7784; }
    .page code { background: rgba(255,255,255,0.09); color: #f0a0c0; }
    .note { background: #1d2025; border-color: rgba(255,255,255,0.1); color: #6f7784; }
  }
</style>
<style>
/* ======== 以下样式由 tools/make_preview.mjs 从 content/content.js 抽取 ======== */
${css}
</style>
</head>
<body>

<main class="page">
  <h1>HTTP 缓存的四种失效策略</h1>
  <div class="lead">模拟一篇正在阅读的技术文档</div>

  <p>当浏览器再次请求同一资源时，会先检查本地缓存是否仍然可用。这依赖响应头中的一组指令，
  其中最常被讨论的是 <mark>Cache-Control</mark> 与 <code>ETag</code> 之间的分工。</p>

  <h2>强缓存与协商缓存</h2>
  <p>强缓存命中时浏览器不会发出任何网络请求，直接使用本地副本；
  它的判断依据是 <code>max-age</code> 或 <code>Expires</code>。
  一旦过期，就进入协商缓存阶段。</p>

  <p>协商缓存会带着 <code>If-None-Match</code> 回源，服务端如果认为内容没变，
  就返回 304，省掉响应体的传输。这时 <mark>ETag 的生成方式</mark>就成了性能与正确性的取舍点。</p>

  <h2>为什么 ETag 有时不如 Last-Modified</h2>
  <p>在多台机器上生成的 ETag 往往互不相同，同一份内容会被判定为「变了」，
  在不该回源的地方反复回源。这就是分布式部署下常见的 ETag 抖动问题。</p>
</main>

<div class="note">
  <b>这是静态预览</b><br>
  样式与结构直接抽取自 <code>content/content.js</code>，不是另画的一版。<br>
  阴影跟随系统主题，可切换深色模式查看。
</div>

<!-- ======== 以下 DOM 由 tools/make_preview.mjs 从 content/content.js 抽取 ======== -->
${shown}

<script>
// 预览页把面板内容补成一段真实问答，方便看排版密度
const timeline = document.querySelector('.timeline');
timeline.innerHTML = \`
  <div class="msg msg-user">
    <div class="msg-label">解释</div>
    <div class="msg-quote">协商缓存会带着 If-None-Match 回源，服务端如果认为内容没变，就返回 304，省掉响应体的传输。这时 ETag 的生成方式就成了性能与正确性的取舍点。</div>
  </div>
  <div class="msg msg-ai">
    <div class="msg-body">
      <p><strong>ETag 是服务端给资源算的一枚指纹</strong>，用于回答「这份内容还是上次那份吗」。</p>
      <p>问题出在指纹的算法：如果每台机器按自己的元数据生成，同一份内容在不同节点会得到不同指纹。</p>
      <ul>
        <li><strong>抖动</strong>：内容没变却判为变了，304 失效，白白回源</li>
        <li><strong>失效</strong>：只按文件大小取指纹，改动等长内容时检测不到</li>
        <li><strong>开销</strong>：大文件全量哈希，CPU 成本高</li>
      </ul>
      <p>常见做法是：静态资源用「内容哈希 + 版本号」，动态资源改用 <code>Last-Modified</code>，或直接 <code>Cache-Control: no-cache</code> 交给业务判断。</p>
      <blockquote>一句话记住：ETag 要能跨节点稳定复现，否则它只是个添乱的随机数。</blockquote>
    </div>
    <div class="msg-actions">
      <button class="mini-btn">复制</button>
      <button class="mini-btn">☆ 收藏</button>
      <button class="mini-btn">重答</button>
    </div>
  </div>
\`;
document.querySelector('.panel-sub').textContent = 'HTTP 缓存的四种失效策略';
document.querySelector('.status').textContent = 'deepseek-chat · 1.8s · 已存档';
document.querySelector('.msg-ai').classList.add('pinned');
</script>

</body>
</html>
`;

const out = path.join(here, 'preview.html');
fs.writeFileSync(out, html, 'utf8');
console.log(`已生成 ${out}（${(html.length / 1024).toFixed(1)} KB）`);
