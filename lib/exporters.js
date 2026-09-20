/**
 * 导出到第三方笔记平台。
 *
 * 这里**只放纯函数**：把一条记录变成 Markdown / obsidian:// URI / Notion blocks。
 * 真正的网络请求与 chrome.* 调用留在 service worker —— 一来 SW 是唯一既 import 得到
 * 本模块、又有权限发跨域请求的地方，二来纯函数能在自测里直接跑（不需要 Key、不需要浏览器）。
 *
 * 两个平台的接入方式差别很大，所以策略也不同：
 *   · Obsidian 是**本地应用**，没有开放 API，靠 obsidian:// 协议把内容递过去。
 *     内容要塞进 URI，于是长度成了硬约束（见 OBSIDIAN_INLINE_LIMIT）。
 *   · Notion 是**云服务**，有正式 REST API，但结构约束不少：
 *     rich_text 单块 2000 字符、一次请求最多 100 个 block、每个集成 3 请求/秒。
 *     这些约束都在这里被消化掉，调用方只管把记录递进来。
 */

import { MODES } from './prompts.js';

export const NOTION_API = 'https://api.notion.com/v1';
/**
 * 固定 API 版本。Notion 用请求头做版本协商，不同版本的 parent / 定位语义会变
 * （2025-09-03 引入了 data source，2026-03-11 又改了插入位置参数），
 * 所以必须钉住一个自己验过的版本，不能跟着默认值走。
 */
export const NOTION_VERSION = '2025-09-03';

/** 单个 rich_text 对象的字符上限（Notion 硬限制） */
export const RICH_TEXT_LIMIT = 2000;
/** 单次请求携带的 block 上限（Notion 硬限制） */
export const BLOCK_BATCH = 100;
/**
 * obsidian:// URI 里内联正文的安全上限。
 *
 * Windows 向协议处理器传递 URL 的长度上限远小于浏览器地址栏（历史上是 2048，
 * 新系统放宽到 32767 但仍然不是无限的），超长 URI 会被静默截断 —— 表现为
 * 「笔记建出来了但内容缺一半」，比直接失败更难查。所以超过阈值就改走
 * 「剪贴板 + clipboard=true」，让 Obsidian 自己去读剪贴板。
 */
export const OBSIDIAN_INLINE_LIMIT = 6000;

export const EXPORT_KINDS = ['obsidian', 'notion', 'clipboard', 'download'];

export const EXPORT_LABELS = {
  obsidian: '保存到 Obsidian',
  notion: '保存到 Notion',
  clipboard: '复制为 Markdown',
  download: '下载 .md 文件',
};

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function pad(n) {
  return String(n).padStart(2, '0');
}

/** 本地时间戳，形如 2026-09-20 09:45 */
export function stampOf(ts) {
  const d = new Date(ts || Date.now());
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ymdOf(ts) {
  const d = new Date(ts || Date.now());
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 清掉文件名/路径里的非法与保留字符。
 * `/` 在 Obsidian 里是目录分隔符，`#` `^` `|` `[` `]` 是链接语法，
 * 留着会让笔记生成到意外的地方或产生坏链接。
 */
export function sanitizeName(input, max = 60) {
  const s = String(input ?? '')
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '未命名';
  return s.length > max ? `${s.slice(0, max).trim()}…` : s;
}

/** YAML 标量：一律加引号并转义，避免 URL 里的冒号把 front-matter 弄坏 */
function yamlQuote(v) {
  const s = String(v ?? '');
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function quoteLines(text) {
  const body = String(text ?? '').trim();
  if (!body) return '';
  return body
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
}

/** 记录的可读标题：模式 + 问题（或选中的第一行） */
export function recordTitle(r) {
  const label = MODES[r?.mode]?.label || r?.mode || '问答';
  const q = String(r?.question || '').trim();
  const sel = String(r?.selection || '').trim().split(/\r?\n/)[0] || '';
  return sanitizeName(`${label} · ${q || sel || '无标题'}`, 60);
}

/* ------------------------------------------------------------------ */
/* Markdown                                                            */
/* ------------------------------------------------------------------ */

/**
 * 单条记录 → Markdown。
 *
 * front-matter 默认打开：Obsidian / Logseq 这类工具会把它当结构化元数据用，
 * 之后能按来源、时间过滤。关掉它就退化成一篇普通笔记。
 */
export function buildSingleMarkdown(r, { frontMatter = true } = {}) {
  const out = [];
  if (frontMatter) {
    out.push('---');
    if (r?.url) out.push(`source: ${yamlQuote(r.url)}`);
    if (r?.domain) out.push(`site: ${yamlQuote(r.domain)}`);
    if (r?.title) out.push(`title: ${yamlQuote(r.title)}`);
    out.push(`created: ${yamlQuote(stampOf(r?.ts))}`);
    out.push(`mode: ${yamlQuote(r?.mode || '')}`);
    if (r?.model) out.push(`model: ${yamlQuote(r.model)}`);
    out.push('tags:');
    out.push('  - ai-reader');
    out.push('---');
    out.push('');
  }

  out.push(`# ${recordTitle(r)}`);
  out.push('');
  out.push(r?.url ? `[${r.title || r.url}](${r.url})　·　${stampOf(r.ts)}` : stampOf(r?.ts));
  out.push('');
  out.push('## 选中内容');
  out.push('');
  out.push(quoteLines(r?.selection) || '> (无)');
  out.push('');
  out.push('## 回答');
  out.push('');
  out.push(String(r?.answer ?? '').trim() || '(空)');
  // 面板里折叠着的展开层，导出时展开成普通正文 —— 笔记不需要折叠
  if (r?.detail) {
    out.push('');
    out.push('## 展开');
    out.push('');
    out.push(String(r.detail).trim());
  }
  out.push('');
  return out.join('\n');
}

/** 单条记录的文件名 / 笔记名（不带扩展名） */
export function markdownFileName(r) {
  return sanitizeName(`${recordTitle(r)} · ${ymdOf(r?.ts)}`, 80);
}

/* ------------------------------------------------------------------ */
/* Obsidian                                                            */
/* ------------------------------------------------------------------ */

/**
 * obsidian://new URI。
 *
 * vault 留空时 Obsidian 会用「最近打开的库」，这样零配置也能用；
 * file 是库内相对路径（含文件夹），append=true 表示追加而不是新建。
 */
export function obsidianUri({ vault = '', file = '', content = '', append = false, silent = true, clipboard = false }) {
  const params = [];
  if (vault) params.push(['vault', vault]);
  if (file) params.push(['file', file]);
  if (clipboard) params.push(['clipboard', 'true']);
  else if (content) params.push(['content', content]);
  if (append) params.push(['append', 'true']);
  if (silent) params.push(['silent', 'true']);
  const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `obsidian://new?${query}`;
}

/** 库内相对路径：文件夹 + 文件名 */
export function obsidianFilePath(folder, name) {
  const dir = String(folder || '').trim().replace(/^\/+|\/+$/g, '');
  return dir ? `${dir}/${name}` : name;
}

/**
 * 决定正文怎么交给 Obsidian。
 * 短内容走 URI 内联（一步到位），长内容改走剪贴板（绕开长度上限）。
 */
export function planObsidianDelivery(content, { inlineLimit = OBSIDIAN_INLINE_LIMIT } = {}) {
  const text = String(content ?? '');
  if (text.length <= inlineLimit) return { mode: 'inline', content: text };
  return { mode: 'clipboard', content: text };
}

/* ------------------------------------------------------------------ */
/* Notion                                                              */
/* ------------------------------------------------------------------ */

/**
 * 按长度切分文本，尽量在段落/句子边界断开。
 *
 * **无损**：各段拼回来必须与原文逐字符相等。宁可让边界多一个换行，
 * 也不能悄悄吞掉字符 —— 笔记里的内容丢了是不会有人发现的。
 */
export function splitRichText(text, limit = RICH_TEXT_LIMIT) {
  const raw = String(text ?? '');
  if (raw.length <= limit) return [raw];

  const parts = [];
  let rest = raw;
  while (rest.length > limit) {
    const win = rest.slice(0, limit);
    const candidates = [
      win.lastIndexOf('\n\n'),
      win.lastIndexOf('\n'),
      win.lastIndexOf('。'),
      win.lastIndexOf('；'),
      win.lastIndexOf('. '),
      win.lastIndexOf(' '),
    ];
    let cut = Math.max(...candidates);
    // 断点太靠前就放弃了，硬切比切出一堆碎块好
    if (cut < limit * 0.5) cut = limit;
    else cut += 1;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}

function richText(text) {
  return splitRichText(text).map((t) => ({ type: 'text', text: { content: t } }));
}

function blockAt(type, payload) {
  return { object: 'block', type, [type]: payload };
}

export function paragraphBlock(text) {
  return blockAt('paragraph', { rich_text: richText(text) });
}

export function headingBlock(text, level = 2) {
  return blockAt(`heading_${level}`, { rich_text: richText(text) });
}

export function quoteBlock(text) {
  return blockAt('quote', { rich_text: richText(text) });
}

export function dividerBlock() {
  return blockAt('divider', {});
}

/** 一条记录 → Notion blocks（结构对齐面板里看到的样子） */
export function recordBlocks(r) {
  const out = [headingBlock(recordTitle(r), 2)];

  const meta = [];
  if (r?.url) {
    meta.push({ type: 'text', text: { content: '来源：' } });
    meta.push({ type: 'text', text: { content: r.title || r.url, link: { url: r.url } } });
    meta.push({ type: 'text', text: { content: `　·　${stampOf(r.ts)}` } });
  } else {
    meta.push({ type: 'text', text: { content: stampOf(r?.ts) } });
  }
  if (r?.model) meta.push({ type: 'text', text: { content: `　·　${r.model}` } });
  out.push(blockAt('paragraph', { rich_text: meta }));

  if (r?.selection) {
    out.push(headingBlock('选中内容', 3));
    out.push(quoteBlock(r.selection));
  }

  const answer = String(r?.answer ?? '').trim();
  if (answer) {
    if (r?.selection) out.push(headingBlock('回答', 3));
    out.push(paragraphBlock(answer));
  }

  if (r?.detail) {
    // toggle 呼应面板里的「展开」折叠区 —— 笔记里也保持收起来，不占版面
    out.push(
      blockAt('toggle', {
        rich_text: [{ type: 'text', text: { content: '展开' } }],
        children: splitRichText(String(r.detail).trim()).map((t) => paragraphBlock(t)),
      })
    );
  }

  out.push(dividerBlock());
  return out;
}

export function recordsToBlocks(records) {
  const out = [];
  for (const r of records || []) out.push(...recordBlocks(r));
  return out;
}

/** 按 Notion 的单请求上限切批 */
export function chunkBlocks(blocks, size = BLOCK_BATCH) {
  const out = [];
  for (let i = 0; i < blocks.length; i += size) out.push(blocks.slice(i, i + size));
  return out;
}

/** 新建页面的标题 */
export function notionPageTitle(records, now = Date.now()) {
  const list = records || [];
  if (list.length === 1) return recordTitle(list[0]);
  const range = list.length ? `${ymdOf(list[list.length - 1].ts)} ~ ${ymdOf(list[0].ts)}` : ymdOf(now);
  return `AI 阅读助手 · ${list.length} 条 · ${range}`;
}

/**
 * 从各种粘贴形式里取出 Notion ID。
 * 用户多半直接粘整条链接（`https://www.notion.so/页面名-1f2e…?v=…`），
 * 所以要去掉 query、并取路径里**最后**一段 ID（前面的可能是工作区或视图 ID）。
 */
export function normalizeNotionId(input) {
  const s = String(input ?? '').trim();
  if (!s) return '';
  const withoutQuery = s.split(/[?#]/)[0];
  const found = withoutQuery.match(
    /[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g
  );
  const pick = found && found.length ? found[found.length - 1] : s;
  return pick.replace(/-/g, '');
}

/** 判断输入看起来是不是一个可用的 Notion ID */
export function looksLikeNotionId(input) {
  const id = normalizeNotionId(input);
  return /^[0-9a-fA-F]{32}$/.test(id);
}

/** 从 Notion 的页面对象里取出标题（properties 里 type === 'title' 的那个属性） */
export function notionTitleOf(page) {
  const props = page?.properties || {};
  for (const key of Object.keys(props)) {
    if (props[key]?.type !== 'title') continue;
    const text = (props[key].title || []).map((t) => t.plain_text || '').join('');
    if (text) return text;
  }
  return '(未命名页面)';
}

/** 把 Notion 的报错翻译成用户能照着做的中文 */
export function notionErrorMessage(status, data) {
  const code = data?.code || '';
  const msg = data?.message || '';
  if (status === 401) return 'Notion 令牌无效或已被撤销，请回设置页重新填写集成令牌';
  if (status === 403) return 'Notion 拒绝了请求：多半是目标页面没有分享给你的集成（页面右上角 ··· → 连接）';
  if (status === 404) return '找不到目标页面：检查 ID 是否正确，以及该页面是否已分享给集成';
  if (status === 429) return 'Notion 限流了（每个集成 3 请求/秒），稍等几秒再试';
  if (status === 400 && /title/i.test(msg)) return `Notion 说页面标题不合法：${msg}`;
  return `Notion 返回 ${status}${code ? ` (${code})` : ''}：${msg || '未知错误'}`;
}

/** 新建页面的请求体 */
export function notionPagePayload({ parentId, title, blocks = [] }) {
  return {
    parent: { page_id: normalizeNotionId(parentId) },
    properties: { title: { title: [{ type: 'text', text: { content: title } }] } },
    children: blocks.slice(0, BLOCK_BATCH),
  };
}
