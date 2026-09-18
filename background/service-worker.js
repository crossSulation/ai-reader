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

/* ------------------------------------------------------------------ */
/* 右键菜单                                                            */
/* ------------------------------------------------------------------ */

const MENUS = [
  { id: 'arc-explain', title: '用 AI 解释「%s」', mode: 'explain' },
  { id: 'arc-translate', title: '翻译「%s」', mode: 'translate' },
  { id: 'arc-ask', title: '就此追问 AI…', mode: 'ask' },
];

function installMenus() {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    for (const m of MENUS) {
      chrome.contextMenus.create(
        { id: m.id, title: m.title, contexts: ['selection'] },
        () => void chrome.runtime.lastError
      );
    }
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  installMenus();
  const current = await chrome.storage.local.get('arc_settings');
  if (!current.arc_settings) await saveSettings({});
});

chrome.runtime.onStartup.addListener(installMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const hit = MENUS.find((m) => m.id === info.menuItemId);
  if (!hit || !tab?.id) return;
  // 右键菜单能拿到 frameId，直接投递到真正持有选区的那个 frame
  chrome.tabs.sendMessage(
    tab.id,
    { type: 'arc:ask-selection', mode: hit.mode },
    { frameId: typeof info.frameId === 'number' ? info.frameId : 0 },
    () => void chrome.runtime.lastError
  );
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
    if (!settings.apiKey) {
      safePost(port, {
        type: 'error',
        reqId,
        code: 'NO_KEY',
        message: '还没有配置模型。打开插件设置，填入 API Key 后就能用了。',
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
      }));
    } catch (err) {
      safePost(port, { type: 'error', reqId, message: `组装请求失败：${err?.message || err}` });
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
          message: '模型返回了空内容。可能是模型名不对，或该模型只输出推理内容。',
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
      if (/已取消|aborted|AbortError/i.test(message)) {
        safePost(port, { type: 'aborted', reqId });
      } else {
        safePost(port, { type: 'error', reqId, message });
      }
    }
  });
});

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

        case 'ui:open-options':
          chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          return;

        default:
          sendResponse({ ok: false, error: `未知消息类型：${msg?.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();

  return true; // 保持消息通道开放以支持异步响应
});
