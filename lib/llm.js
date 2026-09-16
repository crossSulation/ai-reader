/**
 * LLM 客户端 —— 只运行在 service worker 中（唯一持有 host 权限、唯一发起网络请求的地方）。
 *
 * 支持两套协议：
 *   - openai    : /v1/chat/completions，SSE 的 data 行为 choices[0].delta.content
 *   - anthropic : /v1/messages，SSE 事件为 content_block_delta.text_delta
 *
 * 数据流：fetch -> res.body.getReader() -> 按 SSE 事件边界切分 -> 解析出文本增量 -> onDelta(text, full)
 */

export const PROTOCOL_LABELS = {
  openai: 'OpenAI 兼容（DeepSeek / Kimi / 通义 / 智谱 / Ollama / OpenAI…）',
  anthropic: 'Anthropic 原生（Claude）',
};

/** 常见服务商预设，供设置页一键填充 */
export const PRESETS = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'moonshot',
    label: 'Kimi（月之暗面）',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'dashscope',
    label: '通义千问（阿里云百炼）',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    keyUrl: 'https://bailian.console.aliyun.com/',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-3-5-haiku-latest',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'ollama',
    label: 'Ollama（本机）',
    protocol: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
    keyUrl: 'https://ollama.com/download',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio（本机）',
    protocol: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    model: 'local-model',
    keyUrl: 'https://lmstudio.ai/',
  },
];

/**
 * 把用户填的 Base URL 补全成真正的请求地址。
 * 用户可能填 https://api.deepseek.com 、.../v1 、甚至完整的 .../v1/chat/completions，都要能吃下。
 */
export function buildEndpoint(protocol, baseUrl) {
  const u = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!u) throw new Error('未填写接口地址（Base URL）');

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
  const tail = detail ? `\n服务返回：${detail}` : '';
  const where = url ? `\n请求地址：${url}` : '';
  if (status === 401 || status === 403) {
    return `API Key 被拒绝（HTTP ${status}）。请检查 Key 是否填错、已过期、或余额不足。${tail}${where}`;
  }
  if (status === 404) {
    return `接口地址不存在（HTTP 404）。Base URL 可能多写或少写了 /v1。${tail}${where}`;
  }
  if (status === 400) {
    return `请求被拒绝（HTTP 400）。最常见原因是模型名拼写错误，或该模型不支持当前参数。${tail}${where}`;
  }
  if (status === 429) {
    return `请求过于频繁或额度用尽（HTTP 429），稍等一下再试。${tail}${where}`;
  }
  if (status >= 500) {
    return `模型服务端出错（HTTP ${status}），通常重试即可。${tail}${where}`;
  }
  return `请求失败（HTTP ${status}）。${tail}${where}`;
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
      if (j.type === 'error') throw new Error(j.error?.message || 'Anthropic 返回未知错误');
      if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') {
        return j.delta.text || '';
      }
      return '';
    }

    if (j.error) {
      throw new Error(typeof j.error === 'string' ? j.error : j.error.message || '模型服务返回错误');
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
  if (!key) throw new Error('未填写 API Key');
  if (!model) throw new Error('未填写模型名');

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
  let firstByteTimer = setTimeout(() => ac.abort(new Error('连接超时（30 秒内没有任何响应），请检查网络或接口地址')), 30000);

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
      if (signal?.aborted) throw new Error('已取消');
      throw new Error(err.message || '连接超时，请检查网络或接口地址');
    }
    throw new Error(
      `无法连接模型服务：${err?.message || err}\n` +
        `常见原因：接口地址写错、本机 Ollama/LM Studio 未启动、或该域名权限未授权（到插件设置页重新保存一次即可重新授权）。`
    );
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
    throw new Error('模型服务返回了空响应体（可能不支持流式输出）');
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
        ? `连接超时（${timeoutMs / 1000} 秒无响应）。检查网络、接口地址，本机模型确认已启动。`
        : `无法连接模型服务：${err?.message || err}\n请求地址：${endpoint}`
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
    if (!text && !json.content) throw new Error('响应结构异常，没有拿到 content 字段');
    return { text, model: json.model || model, endpoint };
  }
  const text = json.choices?.[0]?.message?.content;
  if (typeof text !== 'string' && !json.choices) {
    throw new Error('响应结构异常，没有拿到 choices 字段（该地址可能不是 OpenAI 兼容接口）');
  }
  return { text: text || '', model: json.model || model, endpoint };
}
