#!/usr/bin/env node
/**
 * 打包上架包：生成 dist/ai-reader-<version>.zip，并在打包前做一遍「发布体检」。
 *
 * 为什么自己写 zip 而不是调 Compress-Archive / zip：
 *   1. 本项目零依赖、跨平台，脚本本身也要零依赖；
 *   2. 商店包对**内容**有硬要求（不能带 tools/、.git、node_modules），
 *      自己写就能在写文件的那一刻保证清单可控，而不是压完了再猜里面有什么。
 *
 * 用法：
 *   node tools/package.mjs            # 打包 + 体检
 *   node tools/package.mjs --check     # 只体检，不产出 zip
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CHECK_ONLY = process.argv.includes('--check');

/** 上架包只装扩展运行时需要的目录/文件 —— 测试、脚本、文档一概不进包 */
const INCLUDE_DIRS = ['background', 'content', 'lib', 'options', 'popup', 'icons'];
const INCLUDE_FILES = ['manifest.json', 'LICENSE'];

/** 商店对 manifest 字段的硬限制 */
const NAME_MAX = 75; // manifest.name
const DESC_MAX = 132; // manifest.description（商店列表的短描述就取这里）

let problems = [];
let warnings = [];
const fail = (msg) => problems.push(msg);
const warn = (msg) => warnings.push(msg);

/* ------------------------------------------------------------------ */
/* 最小 ZIP 写入（deflate，UTF-8 文件名）                               */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosStamp(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** entries: [{ name, data }] —— name 必须是正斜杠相对路径 */
function makeZip(entries) {
  const { time, date } = dosStamp();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const deflated = zlib.deflateRawSync(e.data, { level: 9 });
    const useDeflate = deflated.length < e.data.length;
    const body = useDeflate ? deflated : e.data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0x0800, 6); // 文件名用 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // 创建版本
    central.writeUInt16LE(20, 6); // 解压所需版本
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42); // 本地头偏移
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/* ------------------------------------------------------------------ */
/* 体检                                                                */
/* ------------------------------------------------------------------ */

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

function preflight(manifest, pkg) {
  // 1. 版本号：manifest 与 package.json 必须同号，否则商店里显示的版本和仓库对不上
  if (manifest.version !== pkg.version) {
    fail(`版本号不一致：manifest.json=${manifest.version}，package.json=${pkg.version}`);
  }
  if (!/^\d+(\.\d+){0,3}$/.test(manifest.version || '')) {
    fail(`manifest.version "${manifest.version}" 不是商店要求的点分数字（如 1.3.0）`);
  }

  // 2. manifest 基本要件
  if (manifest.manifest_version !== 3) fail('manifest_version 必须是 3（MV2 已停止受理）');
  if (!manifest.name) fail('manifest 缺少 name');
  if (!manifest.description) fail('manifest 缺少 description');
  if ((manifest.name || '').length > NAME_MAX) fail(`name 超过 ${NAME_MAX} 字符`);
  if ((manifest.description || '').length > DESC_MAX) {
    warn(`description 有 ${manifest.description.length} 字符，超过商店短描述上限 ${DESC_MAX}，提交时会被要求精简`);
  }

  // 3. 图标：商店列表需要 128，浏览器工具栏需要 16/32，扩展页需要 48
  const icons = manifest.icons || {};
  for (const size of ['16', '48', '128']) {
    if (!icons[size]) fail(`icons 缺少 ${size}×${size}（商店必填 128，工具栏需要 16/32）`);
  }

  // 4. 远程代码：MV3 明令禁止。这里盯住 CSP 与外部脚本两种典型形态。
  const csp = JSON.stringify(manifest.content_security_policy || {});
  if (/unsafe-eval|unsafe-inline/.test(csp)) {
    fail(`content_security_policy 放宽了（${csp}）：商店会直接判定为远程代码风险`);
  }
  const htmlFiles = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(html?|js)$/.test(ent.name)) htmlFiles.push(p);
    }
  };
  for (const d of INCLUDE_DIRS) walk(path.join(ROOT, d));
  for (const f of htmlFiles) {
    const src = fs.readFileSync(f, 'utf8');
    const remote = src.match(/<script[^>]+src=["']https?:\/\//i);
    if (remote) fail(`${path.relative(ROOT, f)} 引用了远程脚本：${remote[0]}（MV3 禁止远程代码）`);
  }

  // 5. 权限：能不申请的就不申请。这里的提醒是给提交时「权限用途」栏准备素材的。
  const perms = manifest.permissions || [];
  for (const p of perms) {
    if (p === '<all_urls>' || p === 'tabs' || p === 'webRequest') {
      warn(`permissions 里含 ${p}，审核大概率要你说明用途，能去掉就去掉`);
    }
  }

  // 6. 密钥别混进包里
  for (const f of htmlFiles.concat(['manifest.json'])) {
    const src = fs.readFileSync(f, 'utf8');
    if (/sk-[A-Za-z0-9]{16,}/.test(src)) fail(`${path.relative(ROOT, f)} 疑似写入了明文 API Key`);
  }
}

function collect() {
  const entries = [];
  const add = (abs, rel) => {
    entries.push({ name: rel.split(path.sep).join('/'), data: fs.readFileSync(abs) });
  };

  for (const f of INCLUDE_FILES) {
    const abs = path.join(ROOT, f);
    if (fs.existsSync(abs)) add(abs, f);
  }
  for (const d of INCLUDE_DIRS) {
    const absDir = path.join(ROOT, d);
    if (!fs.existsSync(absDir)) {
      fail(`缺少目录 ${d}/`);
      continue;
    }
    for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        for (const sub of fs.readdirSync(path.join(absDir, ent.name))) {
          add(path.join(absDir, ent.name, sub), path.join(d, ent.name, sub));
        }
      } else {
        add(path.join(absDir, ent.name), path.join(d, ent.name));
      }
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function main() {
  const manifest = readJson('manifest.json');
  const pkg = readJson('package.json');

  console.log(`打包前体检 · ai-reader v${manifest.version}\n`);
  preflight(manifest, pkg);

  const entries = collect();

  // manifest 里引用的文件必须真的在包里 —— 少一个就是装上就报错
  const names = new Set(entries.map((e) => e.name));
  const must = [
    manifest.background?.service_worker,
    ...(manifest.content_scripts || []).flatMap((c) => c.js || []),
    manifest.action?.default_popup,
    manifest.options_ui?.page,
    ...Object.values(manifest.icons || {}),
  ].filter(Boolean);
  for (const m of must) {
    if (!names.has(m.replace(/^\.?\//, ''))) fail(`manifest 引用了 ${m}，但它不在打包清单里`);
  }

  const total = entries.reduce((n, e) => n + e.data.length, 0);

  if (warnings.length) {
    console.log('提醒：');
    for (const w of warnings) console.log(`  ! ${w}`);
    console.log('');
  }

  if (problems.length) {
    console.log('体检未通过：');
    for (const p of problems) console.log(`  ✗ ${p}`);
    console.log(`\n结果：${problems.length} 项必须修复，未生成 zip`);
    process.exit(1);
  }

  console.log(`体检通过：${entries.length} 个文件，原始体积 ${(total / 1024).toFixed(1)} KB`);
  for (const e of entries) console.log(`  · ${e.name}  ${(e.data.length / 1024).toFixed(1)} KB`);

  if (CHECK_ONLY) {
    console.log('\n（--check 模式，未生成 zip）');
    return;
  }

  const zip = makeZip(entries);
  const outDir = path.join(ROOT, 'dist');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `ai-reader-${manifest.version}.zip`);
  fs.writeFileSync(outFile, zip);

  const sha = crypto.createHash('sha256').update(zip).digest('hex');
  console.log(`\n已生成：${path.relative(ROOT, outFile)}`);
  console.log(`  压缩后 ${(zip.length / 1024).toFixed(1)} KB　sha256 ${sha.slice(0, 16)}…`);
  console.log('\n下一步：把这个 zip 上传到开发者后台（Chrome Web Store / Edge Partner Center）。');
  console.log('流程与填表答案见 docs/PUBLISH.md。');
}

main();
