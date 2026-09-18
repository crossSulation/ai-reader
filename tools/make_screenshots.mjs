#!/usr/bin/env node
/**
 * 生成商店截图（1280×800，Chrome / Edge 都认这个尺寸）。
 *
 * 为什么用脚本而不是手动截图：
 *   1. 商店要求 1280×800 **精确尺寸**，手动截容易被窗口边框、缩放假比例毁掉；
 *   2. 截图要能复现 —— 改了 UI 之后重跑一遍就有新图，不用手动重来。
 *
 * 做法：拿 e2e 那套真实 Chrome + CDP，在测试页上注入一段「像技术文档」的排版，
 * 然后走真实的划词 → 点动作 → 流式回答路径。页面上跑的是**真实的 content.js**，
 * 只是把模型输出用桩灌进去（本机没有 Key，也不需要 Key）。
 *
 * 用法：node tools/make_screenshots.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchChrome, sleep } from './cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = pathToFileURL(path.join(HERE, 'harness.html')).href;
const OUT_DIR = path.resolve(HERE, '..', 'store');
const PORT = Number(process.env.PORT || 9345);
const W = 1280;
const H = 800;

/** 把测试页打扮成一篇真实的技术笔记：隐藏探针，加标题与排版 */
const DRESS_UP = `(() => {
  const style = document.createElement('style');
  style.textContent = \`
    #probe { display: none !important; }
    #spacer { height: 0 !important; }
    body { background: #fff; padding: 44px 56px !important; }
    .demo-body { max-width: 680px; }
    .demo-kicker { font-size: 12px; letter-spacing: .12em; color: #9ca3af; margin-bottom: 10px; }
    h1.demo-title { font-size: 31px; line-height: 1.34; margin: 0 0 10px; color: #111827; font-weight: 700; }
    .demo-meta { font-size: 13px; color: #9ca3af; margin-bottom: 26px; }
    #para { font-size: 17px; line-height: 2.05; color: #1f2937; margin: 0; }
    h2.demo-h2 { font-size: 19px; color: #111827; margin: 30px 0 10px; }
    p.demo-p { font-size: 16.5px; line-height: 2.05; color: #374151; margin: 0; }
  \`;
  document.head.appendChild(style);

  const wrap = document.createElement('div');
  wrap.className = 'demo-body';

  const kicker = document.createElement('div');
  kicker.className = 'demo-kicker';
  kicker.textContent = '深度学习笔记 · 第 3 章';

  const title = document.createElement('h1');
  title.className = 'demo-title';
  title.textContent = '注意力机制：模型是怎么「看见」重点的';

  const meta = document.createElement('div');
  meta.className = 'demo-meta';
  meta.textContent = '2026-09-18 · 约 8 分钟 · 基础笔记';

  const para = document.getElementById('para');
  document.body.insertBefore(wrap, para);
  wrap.append(kicker, title, meta, para);

  const h2 = document.createElement('h2');
  h2.className = 'demo-h2';
  h2.textContent = '为什么需要注意力';

  const p2 = document.createElement('p');
  p2.className = 'demo-p';
  p2.textContent = '在它出现之前，序列模型只能把历史压进一个定长向量里，句子一长，早期的信息就被挤掉了。注意力换了个做法：不再压缩，而是每次都回头看一眼全部输入，按相关度加权取用。';

  wrap.append(h2, p2);
  return document.querySelector('h1.demo-title').textContent;
})()`;

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { cdp, chromePath, close } = await launchChrome({ port: PORT, startUrl: HARNESS });
  console.log(`Chrome: ${chromePath}`);

  const shots = [];
  const shoot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT_DIR, name);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    shots.push(file);
    console.log(`  → ${name}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
  };

  try {
    // 固定视口 = 截图尺寸。不这么做的话窗口 chrome（地址栏）会把高度吃掉几十像素，
    // 出来的图就不是 1280×800，商店会拒收。
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: W,
      height: H,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(400);

    const title = await cdp.eval(DRESS_UP);
    console.log(`测试页：${title}`);

    /* --- 截图 1：划词后浮出动作气泡（强调不遮挡正文） --- */
    const rect = await cdp.eval(`(() => { const r = document.getElementById('para').getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`);
    await cdp.dragSelect(
      { x: rect.left + 4, y: rect.top + 14 },
      { x: rect.right - 120, y: rect.top + 14 }
    );
    await sleep(350);
    await shoot('screenshot-1-selection.png');

    /* --- 截图 2：右侧面板的分层回答 --- */
    const chip = await cdp.eval(`(() => {
      const sr = document.querySelector('arc-reader-ui').shadowRoot;
      const c = sr.querySelector('.chip');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: c.textContent };
    })()`);
    if (!chip) throw new Error('没找到动作气泡上的按钮，划词可能没生效');
    await cdp.clickAt(chip.x, chip.y);
    await sleep(400);

    const reqId = await cdp.eval('(window.__port.posted[0] || {}).reqId');
    const emit = (msg) => cdp.eval(`window.__emit(${JSON.stringify(msg)})`);

    await emit({ type: 'start', reqId, model: 'deepseek-chat' });
    for (const text of [
      '注意力机制让模型在处理每个位置时，回头看一眼全部输入并按相关度加权取用，',
      '而不是把整句压进一个定长向量。',
    ]) {
      await emit({ type: 'delta', reqId, part: 'brief', text });
      await sleep(90);
    }
    for (const text of [
      '它解决的是一句话里的「长距离依赖」：早期信息不再被中间步骤逐层稀释。\n\n',
      '三个角色：查询（Query）表示「我在找什么」，键（Key）表示「我有什么」，',
      '值（Value）表示「我实际提供什么」。相似度决定权重，权重决定取用多少。\n\n',
      '一句话记住：注意力不是筛选，而是按需要「重新分配关注度」。',
    ]) {
      await emit({ type: 'delta', reqId, part: 'detail', text });
      await sleep(90);
    }
    await emit({
      type: 'done',
      reqId,
      answer: '注意力机制让模型在处理每个位置时，回头看一眼全部输入并按相关度加权取用，而不是把整句压进一个定长向量。',
      detail: '它解决的是一句话里的「长距离依赖」……',
      saved: true,
      recordId: 'screenshot',
      elapsed: 1240,
      model: 'deepseek-chat',
    });
    await sleep(400);
    await shoot('screenshot-2-panel.png');

    /* --- 小宣传图 440×280：商店 listing 的 promo tile，缺了排名会靠后 --- */
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 440, height: 280, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.eval(`(() => {
      document.documentElement.style.overflow = 'hidden';
      document.body.style.overflow = 'hidden';
      document.getElementById('promo-tile')?.remove();
      const tile = document.createElement('div');
      tile.id = 'promo-tile';
      tile.style.cssText = 'position:fixed;inset:0;z-index:2147483647;overflow:hidden;' +
        'background:linear-gradient(135deg,#6d28d9 0%,#8b5cf6 52%,#a78bfa 100%);' +
        'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
        'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;';
      tile.innerHTML = [
        '<div style="position:absolute;width:220px;height:220px;border-radius:50%;background:rgba(255,255,255,.08);right:-60px;top:-70px"></div>',
        '<div style="position:absolute;width:150px;height:150px;border-radius:50%;background:rgba(255,255,255,.06);left:-40px;bottom:-50px"></div>',
        '<img src="../icons/icon128.png" alt="" style="width:76px;height:76px;border-radius:18px;box-shadow:0 6px 18px rgba(30,10,80,.35)">',
        '<div style="color:#fff;font-size:30px;font-weight:700;margin-top:16px;letter-spacing:.02em">AI 阅读助手</div>',
        '<div style="color:rgba(255,255,255,.88);font-size:14px;margin-top:8px;letter-spacing:.04em">划词即问 · 双击即问 · 随时追问</div>',
      ].join('');
      document.documentElement.appendChild(tile);
    })()`);
    await sleep(400);
    await shoot('tile-440.png');

    console.log(`\n完成，共 ${shots.length} 张，输出目录：store/`);
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(`生成失败：${err.message}`);
  process.exit(1);
});
