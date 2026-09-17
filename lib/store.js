/**
 * 设置与历史的持久化层。
 *
 * 两个刻意的选择：
 *   1. 全部走 chrome.storage.local（不是 sync）—— API Key 会同步到用户所有已登录设备，
 *      那等于把凭据分发出去。留在本机是唯一合理的选择。
 *   2. 所有历史写入串行化 —— 多个标签页可能同时写入，读-改-写不串行就会互相覆盖。
 */

export const SETTINGS_KEY = 'arc_settings';
export const HISTORY_KEY = 'arc_history_v1';

export const DEFAULT_SETTINGS = {
  // 模型接入
  preset: 'deepseek',
  protocol: 'openai',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.3,
  configured: false,

  // 交互
  trigger: 'chip', // chip = 划词后浮出气泡 | auto = 划词后立即提问 | off = 只用快捷键/右键
  selectedModes: ['explain', 'translate', 'example', 'deeper', 'ask'],
  minSelectionLength: 1,

  // 零动作触发：选中即问的两种「不用点气泡」的入口，与 trigger 相互独立
  // （所以「不要气泡、但要双击即问」这种组合也能表达出来）
  dblclickAsk: true,
  quickAskMode: 'explain',

  // 分层回答：结论层先行，展开层折叠
  layered: true,

  // 记录
  autoSave: true,
  maxHistory: 800,

  // 站点
  disabledDomains: [],
};

/* ------------------------------------------------------------------ */
/* 串行写队列                                                          */
/* ------------------------------------------------------------------ */

let queue = Promise.resolve();
function enqueue(fn) {
  const run = () => fn();
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

export async function getSettings() {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(got[SETTINGS_KEY] || {}) };
}

export async function saveSettings(patch) {
  return enqueue(async () => {
    const current = await getSettings();
    const merged = { ...current, ...patch };
    // 数组字段整体替换而非合并，否则用户删掉的项会"复活"
    await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
    return merged;
  });
}

/* ------------------------------------------------------------------ */
/* 历史                                                                */
/* ------------------------------------------------------------------ */

/** 稳定 id：同一页面 + 同一段文字 + 同一模式 + 同一问题 => 同一条记录 */
export function recordId({ url = '', mode = '', question = '', selection = '' }) {
  const raw = `${url}\u0001${mode}\u0001${question}\u0001${selection}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}`;
}

export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export async function getHistory() {
  const got = await chrome.storage.local.get(HISTORY_KEY);
  const list = got[HISTORY_KEY];
  return Array.isArray(list) ? list : [];
}

/** 新增或更新一条记录（同 id 视为同一条，覆盖答案而不是堆积重复项） */
export async function upsertHistory(record) {
  return enqueue(async () => {
    const settings = await getSettings();
    const list = await getHistory();
    const id = record.id || recordId(record);
    const now = Date.now();
    const idx = list.findIndex((r) => r.id === id);

    const entry = {
      id,
      ts: now,
      createdAt: idx >= 0 ? list[idx].createdAt : now,
      url: record.url || '',
      title: record.title || '',
      domain: record.domain || domainOf(record.url || ''),
      selection: record.selection || '',
      context: record.context || '',
      mode: record.mode || 'explain',
      question: record.question || '',
      answer: record.answer || '',
      // 分层回答的展开层。旧记录没有这个字段，一律当空串处理，不需要迁移。
      detail: record.detail || '',
      model: record.model || '',
      favorite: idx >= 0 ? !!list[idx].favorite : false,
    };

    if (idx >= 0) list[idx] = { ...list[idx], ...entry, favorite: entry.favorite };
    else list.unshift(entry);

    // 超限时淘汰最旧的，但收藏的永不淘汰
    const max = Math.max(50, Number(settings.maxHistory) || DEFAULT_SETTINGS.maxHistory);
    if (list.length > max) {
      const keep = [];
      let normal = 0;
      for (const r of list.sort((a, b) => b.ts - a.ts)) {
        if (r.favorite) keep.push(r);
        else if (normal < max) {
          normal++;
          keep.push(r);
        }
      }
      keep.sort((a, b) => b.ts - a.ts);
      list.length = 0;
      list.push(...keep);
    }

    await chrome.storage.local.set({ [HISTORY_KEY]: list });
    return entry;
  });
}

export async function updateHistory(id, patch) {
  return enqueue(async () => {
    const list = await getHistory();
    const idx = list.findIndex((r) => r.id === id);
    if (idx < 0) return null;
    list[idx] = { ...list[idx], ...patch };
    await chrome.storage.local.set({ [HISTORY_KEY]: list });
    return list[idx];
  });
}

export async function deleteHistory(id) {
  return enqueue(async () => {
    const list = await getHistory();
    const next = list.filter((r) => r.id !== id);
    await chrome.storage.local.set({ [HISTORY_KEY]: next });
    return next.length;
  });
}

export async function clearHistory({ keepFavorites = false } = {}) {
  return enqueue(async () => {
    if (!keepFavorites) {
      await chrome.storage.local.set({ [HISTORY_KEY]: [] });
      return 0;
    }
    const list = await getHistory();
    const next = list.filter((r) => r.favorite);
    await chrome.storage.local.set({ [HISTORY_KEY]: next });
    return next.length;
  });
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

function pad(n) {
  return String(n).padStart(2, '0');
}

export function formatTime(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ymd(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 引用块：逐行加 > ，避免多行内容破坏 Markdown 结构 */
function quote(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
}

/**
 * 生成 Markdown。按 域名 → 日期 → 条目 三级组织，
 * 这样导出的文件在 Obsidian / Typora 里直接就能当笔记用。
 */
export function toMarkdown(records, { title = 'AI 阅读助手 · 问答记录', groupByDomain = true } = {}) {
  const now = Date.now();
  const out = [];
  out.push(`# ${title}`);
  out.push('');
  out.push(`导出时间：${formatTime(now)}　·　共 ${records.length} 条`);
  out.push('');

  const domains = new Map();
  for (const r of records) {
    const key = groupByDomain ? r.domain || '未知来源' : '全部';
    if (!domains.has(key)) domains.set(key, []);
    domains.get(key).push(r);
  }

  for (const [domain, items] of domains) {
    if (groupByDomain) out.push(`## ${domain}`);
    const byDay = new Map();
    for (const r of items) {
      const day = ymd(r.ts);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(r);
    }
    for (const [day, dayItems] of byDay) {
      out.push(`### ${day}`);
      out.push('');
      for (const r of dayItems) {
        const link = r.url ? `[${r.title || r.url}](${r.url})` : r.title || '';
        out.push(`#### ${r.favorite ? '★ ' : ''}${r.mode}${r.question ? ` · ${r.question}` : ''}`);
        out.push('');
        if (link) out.push(`来源：${link}　·　${formatTime(r.ts)}`);
        if (r.model) out.push(`模型：${r.model}`);
        out.push('');
        out.push('**选中内容**');
        out.push('');
        out.push(quote(r.selection || '(无)'));
        out.push('');
        out.push('**回答**');
        out.push('');
        out.push((r.answer || '').trim() || '(空)');
        out.push('');
        // 面板里折叠着的展开层，导出时展开成普通正文 —— 笔记不需要折叠
        if (r.detail) {
          out.push('**展开**');
          out.push('');
          out.push(r.detail.trim());
          out.push('');
        }
        out.push('---');
        out.push('');
      }
    }
  }
  return out.join('\n');
}
