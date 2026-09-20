/**
 * LLM 客户端 —— 只运行在 service worker 中（唯一持有 host 权限、唯一发起网络请求的地方）。
 *
 * 支持两套协议：
 *   - openai    : /v1/chat/completions，SSE 的 data 行为 choices[0].delta.content
 *   - anthropic : /v1/messages，SSE 事件为 content_block_delta.text_delta
 *
 * 数据流：fetch -> res.body.getReader() -> 按 SSE 事件边界切分 -> 解析出文本增量 -> onDelta(text, full)
 */

import { t } from './i18n.js';

/**
 * 协议显示名。
 * 做成函数而不是常量对象：常量会在 import 时求值一次就冻住，
 * 用户在设置页切了语言，这里的名字还是旧语言的（这类「一半翻译」最难发现）。
 */
export function protocolLabel(id) {
  const key = id === 'anthropic' ? 'protoAnthropic' : 'protoOpenai';
  return t(key);
}

/**
 * 常见服务商预设，供设置页一键填充。
 *
 * 刻意**不带显示名**：名字要从字典里取（见 presetLabel），
 * 硬编码在这里就锁死了一种语言。
 */
export const PRESETS = [
  {
    id: 'deepseek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'moonshot',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'dashscope',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    keyUrl: 'https://bailian.console.aliyun.com/',
  },
  {
    id: 'zhipu',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'siliconflow',
    protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'openai',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-3-5-haiku-latest',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'ollama',
    protocol: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
    keyUrl: 'https://ollama.com/download',
  },
  {
    id: 'lmstudio',
    protocol: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    model: 'local-model',
    keyUrl: 'https://lmstudio.ai/',
  },
];

/** 服务商显示名；字典里没有的 id 退回 id 本身，不显示一个空的选项 */
export function presetLabel(id) {
  const known = PRESETS.some((p) => p.id === id);
  return known ? t(`provider_${id}`) : String(id || '');
}

/**
 * 把用户填的 Base URL 补全成真正的请求地址。
 * 用户可能填 https://api.deepseek.com 、.../v1 、甚至完整的 .../v1/chat/completions，都要能吃下。
 */
export function buildEndpoint(protocol, baseUrl) {
  const u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) throw new Error(t('llmNoBaseUrl'));

  if (protocol === 'anthropic') {
    if (/\/v1\/messages$/.test(u)) return u;
    if (/\/v1$/.test(u)) return `${u}/messages`;
    return `${u}/v1/messages`;
  }

  if (/\/chat\/completions$/.test(u)) return u;
  if (/\/v\d+$/.test(u)) return `${u}/chat/completions`;
  return `${u}/v1/chat/completions`;
}

/** 从 Base URL 推出需要在浏览器里申请权限的 origin，例如 https://api.deepseek.com/* */
export function originPatternOf(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.origin}/*`;
  } catch {
    return null;
  }
}

/** 把各家的错误响应体抽出一句人话 */
function extractErrorDetail(bodyText) {
  const raw = String(bodyText || '').trim();
  if (!raw) return '';
  try {
    const j = JSON.parse(raw);
    const msg =
      j?.error?.message ||
      j?.error?.type ||
      (typeof j?.error === 'string' ? j.error : '') ||
      j?.message ||
      j?.msg ||
      j?.detail ||
      '';
    if (msg) return String(msg).slice(0, 400);
  } catch {
    /* 不是 JSON，当纯文本处理 */
  }
  return raw.slice(0, 400);
}

/** HTTP 状态码 -> 用户能对症下药的提示 */
export function friendlyHttpError(status, detail, url) {
  // 服务端原文（detail）与请求地址不翻译 —— 那是用户要去比对的原始信息
  const tail = detail ? t('llmResponseTail', { detail }) : '';
  const where = url ? t('llmWhere', { url }) : '';
  if (status === 401 || status === 403) return `${t('llmHttp401', { status })}${tail}${where}`;
  if (status === 404) return `${t('llmHttp404')}${tail}${where}`;
  if (status === 400) return `${t('llmHttp400')}${tail}${where}`;
  if (status === 429) return `${t('llmHttp429')}${tail}${where}`;
  if (status >= 500) return `${t('llmHttp5xx', { status })}${tail}${where}`;
  return `${t('llmHttpOther', { status })}${tail}${where}`;
}

/** 解析一段 SSE 事件文本，返回其中的文本增量（没有则返回空串） */
function parseSseEvent(chunk, protocol) {
  const lines = String(chunk).split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;

    let j;
    try {
      j = JSON.parse(data);
    } catch {
      continue;
    }

    if (protocol === 'anthropic') {
      if (j.type === 'error') throw new Error(j.error?.message || t('llmAnthropicUnknown'));
      if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') {
        return j.delta.text || '';
      }
      return '';
    }

    if (j.error) {
      throw new Error(typeof j.error === 'string' ? j.error : j.error.message || t('llmModelError'));
    }
    const choice = j.choices?.[0];
    const delta = choice?.delta;
    if (delta) {
      if (typeof delta.content === 'string') return delta.content;
      // 部分服务商把 content 拆成数组形式的 content parts
      if (Array.isArray(delta.content)) {
        return delta.content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('');
      }
    }
    if (typeof choice?.text === 'string') return choice.text;
    if (typeof choice?.message?.content === 'string') return choice.message.content;
    return '';
  }
  return '';
}

function buildRequest({ protocol, baseUrl, apiKey, model, messages, temperature, maxTokens, stream }) {
  const endpoint = buildEndpoint(protocol, baseUrl);
  const key = String(apiKey || '').trim();
  if (!key) throw new Error(t('llmNoKey'));
  if (!model) throw new Error(t('llmNoModel'));

  const headers = { 'Content-Type': 'application/json' };
  let payload;

  if (protocol === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    // 直连浏览器必须显式声明，否则 Anthropic 会拒绝
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    payload = {
      model,
      max_tokens: maxTokens,
      stream,
      messages: messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    };
    if (system) payload.system = system;
  } else {
    headers.Authorization = `Bearer ${key}`;
    payload = { model, messages, stream, max_tokens: maxTokens };
  }
  if (typeof temperature === 'number' && Number.isFinite(temperature)) {
    payload.temperature = temperature;
  }
  return { endpoint, headers, payload };
}

/** 用户主动取消：带上稳定标记，别让上层靠「文案里有没有『已取消』」来判断 —— 那样一翻译就失效 */
function abortedError() {
  const e = new Error(t('llmAborted'));
  e.code = 'ABORTED';
  return e;
}

/**
 * 流式对话
 * @param {object} opts
 * @param {(text:string, full:string)=>void} opts.onDelta 每收到一段增量就回调
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<string>} 完整回答
 */
export async function streamChat(opts) {
  const {
    protocol = 'openai',
    baseUrl,
    apiKey,
    model,
    messages,
    temperature,
    maxTokens = 1200,
    signal,
    onDelta,
    onController,
  } = opts;

  const { endpoint, headers, payload } = buildRequest({
    protocol,
    baseUrl,
    apiKey,
    model,
    messages,
    temperature,
    maxTokens,
    stream: true,
  });

  // 自己建 controller，方便上层随时取消；同时透传外部 signal
  const ac = new AbortController();
  if (onController) onController(ac);
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', () => ac.abort(), { once: true });
  }

  // 首字节超时：连不上或鉴权卡住时不要无限等
  let firstByteTimer = setTimeout(() => ac.abort(new Error(t('llmTimeout30'))), 30000);

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(firstByteTimer);
    if (err?.name === 'AbortError') {
      if (signal?.aborted) throw abortedError();
      throw new Error(err.message || t('llmTimeoutShort'));
    }
    throw new Error(t('llmConnectFailed', { msg: err?.message || err }) + t('llmConnectHint'));
  }

  if (!res.ok) {
    clearTimeout(firstByteTimer);
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(friendlyHttpError(res.status, extractErrorDetail(bodyText), endpoint));
  }

  if (!res.body) {
    clearTimeout(firstByteTimer);
    throw new Error(t('llmEmptyBody'));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByteTimer) {
        clearTimeout(firstByteTimer);
        firstByteTimer = null;
      }
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || '';
      for (const evt of events) {
        const delta = parseSseEvent(evt, protocol);
        if (delta) {
          full += delta;
          if (onDelta) onDelta(delta, full);
        }
      }
    }
    // 收尾：最后一段可能没有以空行结束
    if (buffer.trim()) {
      const delta = parseSseEvent(buffer, protocol);
      if (delta) {
        full += delta;
        if (onDelta) onDelta(delta, full);
      }
    }
  } finally {
    if (firstByteTimer) clearTimeout(firstByteTimer);
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  return full;
}

/**
 * 非流式单轮对话 —— 给「保存并测试」用。
 * 测试必须真的打一次模型服务：只检查 Key 非空是查不出问题的。
 */
export async function chatOnce(opts) {
  const {
    protocol = 'openai',
    baseUrl,
    apiKey,
    model,
    messages,
    temperature,
    maxTokens = 24,
    timeoutMs = 30000,
  } = opts;

  const { endpoint, headers, payload } = buildRequest({
    protocol,
    baseUrl,
    apiKey,
    model,
    messages,
    temperature,
    maxTokens,
    stream: false,
  });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
  } catch (err) {
    throw new Error(
      err?.name === 'AbortError'
        ? t('llmTimeoutMs', { sec: timeoutMs / 1000 })
        : `${t('llmConnectFailed', { msg: err?.message || err })}${t('llmRequestUrl', { url: endpoint })}`
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(friendlyHttpError(res.status, extractErrorDetail(bodyText), endpoint));
  }

  const json = await res.json();
  if (protocol === 'anthropic') {
    const text = (json.content || []).map((c) => c?.text || '').join('').trim();
    if (!text && !json.content) throw new Error(t('llmNoContent'));
    return { text, model: json.model || model, endpoint };
  }
  const text = json.choices?.[0]?.message?.content;
  if (typeof text !== 'string' && !json.choices) {
    throw new Error(t('llmNoChoices'));
  }
  return { text: text || '', model: json.model || model, endpoint };
}
