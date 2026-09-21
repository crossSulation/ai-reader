/**
 * Background service worker
 *
 * 职责边界（这是整个扩展的安全底座）：
 *   - 唯一发起网络请求的地方（content script 碰不到模型服务，也就不受页面 CORS 干扰）
 *   - 唯一读写设置与历史的地方
 *   - 流式回答通过长连接 Port 推回页面：port 存活期间 SW 不会被回收，
 *     若改用一次性 sendMessage，长回答很容易撞上 SW 生命周期
 */

import { streamChat, chatOnce } from '../lib/llm.js';
import { buildRequest, buildPingMessages, createLayerSplitter } from '../lib/prompts.js';
import { t, setLocale, applyLanguageSetting } from '../lib/i18n.js';
import {
  getSettings,
  saveSettings,
  upsertHistory,
  updateHistory,
  deleteHistory,
  clearHistory,
  getHistory,
  recordId,
  domainOf,
  toMarkdown,
} from '../lib/store.js';
import {
  NOTION_API,
  NOTION_VERSION,
  OBSIDIAN_INLINE_LIMIT,
  buildSingleMarkdown,
  markdownFileName,
  resolveObsidianFolder,
  splitRichText,
  obsidianUri,
  obsidianFilePath,
  recordsToBlocks,
  chunkBlocks,
  notionPageTitle,
  notionPagePayload,
  notionErrorMessage,
  notionTitleOf,
  normalizeNotionId,
  looksLikeNotionId,
  ymdOf,
  sanitizeName,
} from '../lib/exporters.js';

/* ------------------------------------------------------------------ */
/* 界面语言                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把设置里的界面语言同步到本进程。
 *
 * service worker 是**独立进程**，内容脚本那边 setLocale 过不代表这里也切了 ——
 * 不显式同步的话，会出现「面板按钮是英文、出错时的提示却是中文」这种撕裂。
 * 每次读取设置后、以及每次要产生用户可见文案之前，都要走一次。
 */
async function syncLocale() {
  try {
    const s = await getSettings();
    applyLanguageSetting(s);
    return s;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 右键菜单                                                            */
/* ------------------------------------------------------------------ */

/** 菜单标题随界面语言重建（chrome.contextMenus 只能改，不能「动态取词」） */
const MENU_DEFS = [
  { id: 'arc-explain', key: 'swCmdExplain', mode: 'explain' },
  { id: 'arc-translate', key: 'swCmdTranslate', mode: 'translate' },
  { id: 'arc-ask', key: 'swCmdAsk', mode: 'ask' },
];

function menuTitle(def) {
  return t(def.key);
}

function installMenus() {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    for (const m of MENU_DEFS) {
      chrome.contextMenus.create(
        { id: m.id, title: menuTitle(m), contexts: ['selection'] },
        () => void chrome.runtime.lastError
      );
    }
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await syncLocale();
  installMenus();
  const current = await chrome.storage.local.get('arc_settings');
  if (!current.arc_settings) await saveSettings({});
});

chrome.runtime.onStartup.addListener(async () => {
  await syncLocale();
  installMenus();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const hit = MENU_DEFS.find((m) => m.id === info.menuItemId);
  if (!hit || !tab?.id) return;
  // 右键菜单能拿到 frameId，直接投递到真正持有选区的那个 frame
  chrome.tabs.sendMessage(
    tab.id,
    { type: 'arc:ask-selection', mode: hit.mode },
    { frameId: typeof info.frameId === 'number' ? info.frameId : 0 },
    () => void chrome.runtime.lastError
  );
});

/**
 * 设置变了就重建菜单。
 * 菜单标题是「建菜单那一刻」取的语言，不重建就一直是旧语言 ——
 * 用户切了界面语言却发现右键菜单还是中文，就是漏了这一步。
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.arc_settings) return;
  const next = changes.arc_settings.newValue || {};
  const prev = changes.arc_settings.oldValue || {};
  if ((next.language || 'auto') === (prev.language || 'auto')) return;
  setLocale(next.language || 'auto');
  installMenus();
});

/* ------------------------------------------------------------------ */
/* 快捷键                                                              */
/* ------------------------------------------------------------------ */

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'explain-selection') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  // 不带 frameId 广播：只有真正持有选区的那一个 frame 会弹气泡
  chrome.tabs.sendMessage(tab.id, { type: 'arc:ask-selection', mode: 'explain' }, () => {
    void chrome.runtime.lastError;
  });
});

/* ------------------------------------------------------------------ */
/* 流式问答通道                                                        */
/* ------------------------------------------------------------------ */

/**
 * 把 token 级的高频增量合并成 25ms 一批，避免刷屏式 IPC。
 *
 * 结论层与展开层各有一个缓冲区，且**永远先发结论层**：
 * 两段在同一批里同时存在时（标记恰好落在这一批的边界上），
 * 先发 brief 才能保证 content script 收到的是正确的先后顺序。
 */
function createBatcher(flushFn, interval = 25) {
  let brief = '';
  let detail = '';
  let timer = null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (brief) {
      const text = brief;
      brief = '';
      flushFn(text, 'brief');
    }
    if (detail) {
      const text = detail;
      detail = '';
      flushFn(text, 'detail');
    }
  };

  return {
    push(text, part = 'brief') {
      if (!text) return;
      if (part === 'detail') detail += text;
      else brief += text;
      if (!timer) timer = setTimeout(flush, interval);
    },
    flush,
  };
}

function safePost(port, msg) {
  try {
    port.postMessage(msg);
    return true;
  } catch {
    // 页面已导航走 / 端口已断开，正常情况，不需要惊动用户
    return false;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'arc-ask') return;

  /** reqId -> AbortController */
  const pending = new Map();

  port.onDisconnect.addListener(() => {
    for (const ac of pending.values()) {
      try {
        ac.abort();
      } catch {
        /* ignore */
      }
    }
    pending.clear();
  });

  port.onMessage.addListener(async (msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'abort') {
      pending.get(msg.reqId)?.abort();
      return;
    }

    if (msg.type !== 'ask') return;
    const { reqId } = msg;

    // 同一时刻只允许一个进行中的请求，新的覆盖旧的
    for (const [id, ac] of pending) {
      ac.abort();
      pending.delete(id);
    }

    const settings = await getSettings();
    // 产生用户可见文案之前先对齐语言：本进程独立于内容脚本，不共享 setLocale 状态
    applyLanguageSetting(settings);

    if (!settings.apiKey) {
      safePost(port, {
        type: 'error',
        reqId,
        code: 'NO_KEY',
        message: t('swNoKey'),
      });
      return;
    }

    const payload = msg.payload || {};
    const layered = settings.layered !== false;
    let messages;
    let contextInfo;
    try {
      // 预算从设置项来：用户按自己模型的窗口大小在设置页里调
      ({ messages, contextInfo } = buildRequest({
        mode: payload.mode,
        selection: payload.selection,
        context: payload.context,
        page: payload.page,
        question: payload.question,
        history: payload.history,
        layered,
        budget: settings.contextBudget,
        // 回答语言跟随界面语言：界面切成英文的用户，要的是英文答案
        answerLang: settings.language === 'en' ? 'en' : 'zh',
        // 整页正文是否采集由内容脚本决定（它才知道划词处有没有可依附的段落），
        // 这里只负责透传；上限与截断在 lib/prompts.js 里按预算统一处理
        pageText: payload.pageText,
      }));
    } catch (err) {
      safePost(port, { type: 'error', reqId, message: t('swBuildFailed', { msg: err?.message || err }) });
      return;
    }

    // start 消息顺带告知本轮上下文被压缩成什么样，面板据此显示「带了多少历史」
    safePost(port, { type: 'start', reqId, model: settings.model, contextInfo });
    const startedAt = Date.now();
    const batcher = createBatcher((text, part) => safePost(port, { type: 'delta', reqId, text, part }));

    // 分层解析放在这里而不是 content script：
    // 这里是唯一能 import lib/prompts.js 的地方（content script 不是 ESM 环境），
    // 标记格式因此只有一份定义，不存在两边不同步的风险。
    const splitter = layered ? createLayerSplitter((text, part) => batcher.push(text, part)) : null;

    try {
      const answer = await streamChat({
        protocol: settings.protocol,
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        temperature: settings.temperature,
        messages,
        onController: (ac) => pending.set(reqId, ac),
        onDelta: (text) => (splitter ? splitter.push(text) : batcher.push(text, 'brief')),
      });

      // 注意顺序：finish() 会吐出被 hold 住的尾巴，必须先落定再 flush，否则最后一段丢掉
      const layers = splitter ? splitter.finish() : { brief: '', detail: '', hasDetail: false };
      batcher.flush();
      pending.delete(reqId);

      let clean = layers.brief;
      let detail = layers.detail;
      // 模型一个字没写结论层时，把展开层提上来当答案 —— 宁可退化成单层，也不能显示空
      if (!clean && detail) {
        clean = detail;
        detail = '';
      }
      if (!clean) clean = String(answer || '').trim();

      if (!clean) {
        safePost(port, {
          type: 'error',
          reqId,
          message: t('swEmptyReply'),
        });
        return;
      }

      const record = {
        id: recordId({
          url: payload.page?.url || '',
          mode: payload.mode || 'explain',
          question: payload.question || '',
          selection: payload.selection || '',
        }),
        url: payload.page?.url || '',
        title: payload.page?.title || '',
        domain: domainOf(payload.page?.url || ''),
        selection: payload.selection || '',
        context: payload.context || '',
        mode: payload.mode || 'explain',
        question: payload.question || '',
        answer: clean,
        detail,
        model: settings.model,
      };

      let saved = false;
      if (settings.autoSave) {
        try {
          await upsertHistory(record);
          saved = true;
        } catch (err) {
          // 存不下不该让用户丢答案，只标记未保存
          saved = false;
        }
      }

      safePost(port, {
        type: 'done',
        reqId,
        answer: clean,
        detail,
        saved,
        recordId: record.id,
        elapsed: Date.now() - startedAt,
        model: settings.model,
      });
    } catch (err) {
      batcher.flush();
      pending.delete(reqId);
      const message = String(err?.message || err);
      // 判「用户主动取消」只看稳定标记，不看文案 —— 文案是会随语言变的
      if (err?.code === 'ABORTED' || /aborted|AbortError/i.test(message)) {
        safePost(port, { type: 'aborted', reqId });
      } else {
        safePost(port, { type: 'error', reqId, message });
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* 导出到第三方笔记                                                     */
/* ------------------------------------------------------------------ */

const NOTION_ORIGIN = 'https://api.notion.com/*';
/** 分片数硬上限：约 18 万字符，再多就该让用户缩小筛选范围了 */
const MAX_OBSIDIAN_CHUNKS = 30;
const idle = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 把内容送进 Obsidian。
 *
 * 为什么用 obsidian:// 协议而不是直接写文件：扩展没有文件系统权限，
 * 而这个协议是 Obsidian 官方提供的唯一自动化入口。
 *
 * 分片是必须的 —— 正文要塞进 URI 参数，而系统向协议处理器传 URL 有长度上限，
 * 超了会被**静默截断**（笔记建出来了、内容少一半，比直接失败更难排查）。
 * 所以第一片负责新建、其余片带 append=true 追加到同一篇笔记。
 * 全程只开一个标签页反复导航，避免导出多条时刷出一屏标签。
 */
async function exportToObsidian(records) {
  const s = await getSettings();
  applyLanguageSetting(s);
  const single = records.length === 1;

  const name = single
    ? markdownFileName(records[0])
    : sanitizeName(`${t('appName')} · ${ymdOf(Date.now())}`, 60);
  const content = single ? buildSingleMarkdown(records[0]) : toMarkdown(records);

  const chunks = splitRichText(content, OBSIDIAN_INLINE_LIMIT);
  if (chunks.length > MAX_OBSIDIAN_CHUNKS) {
    return {
      ok: false,
      error: t('swExportTooLong', { n: content.length, chunks: chunks.length }),
    };
  }

  // 'auto' 哨兵在这里解析成当前语言的默认文件夹名（见 store.js 的 AUTO_FOLDER）
  const file = obsidianFilePath(resolveObsidianFolder(s.obsidianFolder), name);
  let tabId = null;
  for (let i = 0; i < chunks.length; i++) {
    const url = obsidianUri({
      vault: s.obsidianVault,
      file,
      content: chunks[i],
      append: i > 0,
    });
    if (i > 0) await idle(220); // Obsidian 处理上一次协议调用需要时间，连发会丢内容
    if (tabId) await chrome.tabs.update(tabId, { url });
    else tabId = (await chrome.tabs.create({ url }))?.id ?? null;
  }
  return { ok: true, target: 'obsidian', file, chunks: chunks.length };
}

async function notionFetch(path, token, init = {}) {
  const res = await fetch(`${NOTION_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 空响应体 */
  }
  if (!res.ok) throw new Error(notionErrorMessage(res.status, data));
  return data;
}

/**
 * 把记录写成一个新的 Notion 子页面。
 *
 * 内容结构由 lib/exporters.js 转成 blocks；这里负责三件 API 层面的事：
 * 先建页面（带上首批 blocks）、剩余批次用 PATCH 追加（单请求上限 100 块）、
 * 批间留间隔（每个集成限速 3 请求/秒，429 会更好睡）。
 */
async function exportToNotion(records) {
  const s = await getSettings();
  applyLanguageSetting(s);
  if (!s.notionToken) throw new Error(t('swNotionNoToken'));
  if (!looksLikeNotionId(s.notionParentId)) {
    throw new Error(t('swNotionBadId'));
  }
  if (!(await chrome.permissions.contains({ origins: [NOTION_ORIGIN] }))) {
    throw new Error(t('swNotionNoPerm'));
  }

  const title = notionPageTitle(records);
  const batches = chunkBlocks(recordsToBlocks(records));
  const [first, ...rest] = batches;

  const page = await notionFetch('/pages', s.notionToken, {
    method: 'POST',
    body: JSON.stringify(notionPagePayload({ parentId: s.notionParentId, title, blocks: first })),
  });

  for (const batch of rest) {
    await idle(350);
    await notionFetch(`/blocks/${page.id}/children`, s.notionToken, {
      method: 'PATCH',
      body: JSON.stringify({ children: batch }),
    });
  }

  return { ok: true, target: 'notion', url: page.url, pageId: page.id, batches: batches.length };
}

/** 导出目标当前是否可用（不回传任何凭据，只回状态） */
async function exportStatus() {
  const s = await getSettings();
  const granted = await chrome.permissions.contains({ origins: [NOTION_ORIGIN] });
  const notionConfigured = !!(s.notionToken && looksLikeNotionId(s.notionParentId));
  return {
    ok: true,
    obsidian: { vault: s.obsidianVault || '', folder: s.obsidianFolder || '' },
    notion: {
      configured: notionConfigured,
      granted,
      ready: notionConfigured && granted,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 一次性消息                                                          */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'settings:get':
          sendResponse({ ok: true, settings: await getSettings() });
          return;

        case 'settings:save':
          sendResponse({ ok: true, settings: await saveSettings(msg.patch || {}) });
          return;

        /**
         * 「保存并测试」的服务端一半。
         * 注意测试走的是 chatOnce —— 与真实问答同一个模块、同一个 SW 环境，
         * 只是把 stream 关掉、max_tokens 压到最小。这样才能测出真问题。
         */
        case 'settings:test': {
          const s = { ...(await getSettings()), ...(msg.config || {}) };
          const startedAt = Date.now();
          try {
            const r = await chatOnce({
              protocol: s.protocol,
              baseUrl: s.baseUrl,
              apiKey: s.apiKey,
              model: s.model,
              messages: buildPingMessages(),
              maxTokens: 24,
              timeoutMs: 30000,
            });
            sendResponse({
              ok: true,
              reply: r.text,
              model: r.model,
              endpoint: r.endpoint,
              elapsed: Date.now() - startedAt,
            });
          } catch (err) {
            sendResponse({ ok: false, error: String(err?.message || err) });
          }
          return;
        }

        case 'history:list':
          sendResponse({ ok: true, records: await getHistory() });
          return;

        // 自动存档关闭时，由气泡上的「收藏」按钮手动写入
        case 'history:upsert':
          sendResponse({ ok: true, record: await upsertHistory(msg.record || {}) });
          return;

        case 'history:update':
          sendResponse({ ok: true, record: await updateHistory(msg.id, msg.patch || {}) });
          return;

        case 'history:delete':
          sendResponse({ ok: true, count: await deleteHistory(msg.id) });
          return;

        case 'history:clear':
          sendResponse({ ok: true, count: await clearHistory({ keepFavorites: !!msg.keepFavorites }) });
          return;

        case 'history:export': {
          const records = Array.isArray(msg.records) ? msg.records : await getHistory();
          sendResponse({ ok: true, markdown: toMarkdown(records, { title: msg.title }) });
          return;
        }

        // 面板上「复制为 Markdown」用：格式与导出到笔记平台的完全一致
        case 'export:markdown': {
          const records = Array.isArray(msg.records) ? msg.records : [];
          if (!records.length) {
            sendResponse({ ok: false, error: t('swNoExportRecords') });
            return;
          }
          await syncLocale();
          sendResponse({
            ok: true,
            markdown: records.length === 1 ? buildSingleMarkdown(records[0]) : toMarkdown(records),
          });
          return;
        }

        case 'export:status':
          sendResponse(await exportStatus());
          return;

        case 'export:save': {
          const records = Array.isArray(msg.records) ? msg.records : [];
          if (!records.length) {
            sendResponse({ ok: false, error: t('swNoExportRecords') });
            return;
          }
          if (msg.target === 'obsidian') sendResponse(await exportToObsidian(records));
          else if (msg.target === 'notion') sendResponse(await exportToNotion(records));
          else sendResponse({ ok: false, error: t('swBadExportTarget', { target: msg.target }) });
          return;
        }

        /**
         * 「连接并测试」的服务端一半：令牌有效 + 父页面已分享给集成。
         *
         * 两步分开测是有意的 —— 这两种失败在 Notion 那边是 401 和 404，
         * 但用户看到的都是「导出失败」，分不清该改令牌还是该去分享页面。
         */
        case 'export:test-notion': {
          const s = await getSettings();
          applyLanguageSetting(s);
          const token = msg.token || s.notionToken;
          const parentId = normalizeNotionId(msg.parentId || s.notionParentId);
          if (!token) throw new Error(t('swNotionNoTokenShort'));
          if (!looksLikeNotionId(parentId)) {
            throw new Error(t('swNotionBadIdShort'));
          }
          if (!(await chrome.permissions.contains({ origins: [NOTION_ORIGIN] }))) {
            throw new Error(t('swNotionNoPermShort'));
          }
          const me = await notionFetch('/users/me', token);
          const parent = await notionFetch(`/pages/${parentId}`, token);
          sendResponse({
            ok: true,
            botName: me?.name || me?.bot?.workspace_name || t('swIntegrationName'),
            parentTitle: notionTitleOf(parent),
          });
          return;
        }

        case 'ui:open-options':
          chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          return;

        default:
          sendResponse({ ok: false, error: t('swUnknownMessage', { type: msg?.type }) });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();

  return true; // 保持消息通道开放以支持异步响应
});
