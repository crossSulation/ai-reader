/**
 * 界面文案字典 + 语言解析（简体中文 / English）。
 *
 * 为什么字典放在 .js 而不是官方的 _locales/messages.json：
 *   1. content script 不是 ESM 环境，import 不到 lib/*.js，但它**能**加载经典脚本。
 *      把字典写成经典脚本（挂到 globalThis），content script 就能同步取词 ——
 *      不必为了「该显示哪个字」去跟 service worker 走一次异步往返，
 *      也就不会出现「先渲染中文、再闪成英文」这种半成品状态。
 *   2. 同一个文件也能被 ESM `import`（没有 export 语句的模块是合法的），
 *      设置页 / 弹窗 / service worker 通过 lib/i18n.js 薄封装使用它。
 *   3. 字典是纯数据，测试可以直接 import 进来断言「中英键集一致」，
 *      这是 messages.json 做不到的（那份只能靠 chrome.i18n 读，Node 里没有）。
 *
 * manifest 的 name / description / 命令描述仍然走 _locales：
 *   那是 Chrome 规定的机制（__MSG_ 占位符），没有替代方案，也无法在运行时切换。
 *   所以「界面语言」这个概念只在运行时生效，manifest 元数据由 Chrome 按浏览器语言挑。
 *
 * 兼容性：本文件同时被
 *   - manifest 的 content_scripts（经典脚本，在隔离世界执行）
 *   - ESM `import '../lib/i18n.core.js'`（空导出，靠副作用赋值）
 * 加载，因此**不能**出现 export / import 语句，也不能依赖 DOM 一定存在。
 */

(() => {
  'use strict';

  /** 兜底语言：浏览器语言既不是中文也不是英文时用它（与 manifest 的 default_locale 对齐） */
  const DEFAULT_LOCALE = 'en';

  const LOCALES = ['zh', 'en'];

  /** 语言标签 → <html lang> 值 */
  const HTML_LANG = { zh: 'zh-CN', en: 'en' };

  /* ================================================================
   * 字典
   *
   * 占位符写成 {name}，由 t(key, subs) 替换。文案里出现的 %s 是给
   * chrome.contextMenus 用的（它认这个记号），不要当成占位符改掉。
   * ================================================================ */

  const MESSAGES = {
    zh: {
      /* ---------- 品牌 ---------- */
      appName: 'AI 阅读助手',
      appTagline: '划词即问 · 用你自己的模型',

      /* ---------- 动作（气泡芯片 / 设置页下拉 / 弹窗标签共用） ---------- */
      mode_explain_label: '解释',
      mode_explain_hint: '把这段讲明白',
      mode_translate_label: '翻译',
      mode_translate_hint: '译成中文 / 英文',
      mode_example_label: '举例',
      mode_example_hint: '给个具体例子',
      mode_deeper_label: '深入',
      mode_deeper_hint: '背后的原理与延伸',
      mode_summarize_label: '总结',
      mode_summarize_hint: '提炼要点',
      mode_ask_label: '提问',
      mode_ask_hint: '输入自己的问题',

      /* ---------- 气泡与面板骨架 ---------- */
      bubbleOpenTitle: '展开 AI 阅读助手',
      panelResizeTitle: '拖动调整宽度',
      panelOptionsTitle: '打开设置',
      panelMinTitle: '最小化',
      panelCloseTitle: '结束对话 (Esc)',
      panelInputPlaceholder: '继续追问…（Enter 发送，Shift+Enter 换行）',
      panelSend: '发送',
      panelCopyAllLabel: '复制全部',
      panelCopyAllTitle: '复制整段对话',
      panelStarTitle: '收藏最后一条回答',
      starOn: '★ 已收藏',
      starOff: '☆ 收藏',
      quoteExpand: '展开',
      quoteCollapse: '收起',

      /* ---------- 状态行 ---------- */
      panelThinking: '正在思考…',
      statusSaved: '已存档',
      statusUnsaved: '未存档',
      statusError: '出错',
      statusCanceled: '已取消',

      /* ---------- 每条回答 ---------- */
      moreExpand: '展开细节',
      moreCollapse: '收起细节',
      moreStreaming: '补充中…',
      moreSize: '{n} 字',
      actCopy: '复制',
      actExport: '导出',
      actExportTitle: '存到 Obsidian / Notion，或复制为 Markdown',
      actRetry: '重答',
      anchorGoto: '↩ 回看原文',
      anchorGotoTitle: '跳回页面上这段划词的位置',
      anchorMissing: '这一轮没有原文位置',
      anchorLost: '原文位置已失效（页面内容已变化）',

      /* ---------- 上下文压缩说明 ---------- */
      ctxSummaryTurns: '摘要 {n} 轮',
      ctxOmittedTurns: '另有 {n} 轮已省略',
      ctxNote: '已压缩更早对话：{bits}',
      ctxNoteTitle:
        '多轮上下文按预算（{budget} 字符）压缩后随本轮请求发送：最近 {full} 轮完整保留，更早的轮次压成摘要。',

      /* ---------- 错误与提示（面板） ---------- */
      errGeneric: '出错了',
      errUnknown: '未知错误',
      errGoSettings: '去设置',
      errAborted: '已取消。',
      errDisconnected: '连接已断开（页面可能发生了跳转）。重新划词即可继续。',
      errBackend: '无法连接到扩展后台：{msg}\n请到 chrome://extensions 重新加载本扩展。',
      copied: '已复制到剪贴板',
      copyFailedManual: '复制失败，请手动选中复制',
      copiedAll: '已复制整段对话',
      copyFailed: '复制失败',
      savedOn: '已收藏',
      savedOff: '已取消收藏',
      opFailed: '操作失败：{msg}',
      questionPrefix: '**问：** {q}',
      historyAsk: '请{label}这段内容：{text}',

      /* ---------- 导出 ---------- */
      exportObsidian: '保存到 Obsidian',
      exportNotion: '保存到 Notion',
      exportClipboard: '复制为 Markdown',
      exportDownload: '下载 .md 文件',
      exportVaultRecent: '最近打开的库',
      exportAuthorizing: '待授权',
      exportUnconfigured: '未配置',
      exportWritingObsidian: '正在写入 Obsidian…',
      exportSavingNotion: '正在保存到 Notion…',
      exportFailed: '导出失败',
      exportFailedDetail: '导出失败：{msg}',
      exportMdFailed: '生成 Markdown 失败',
      exportCopiedMd: '已复制 Markdown',
      exportCopyFailed: '复制失败：{msg}',
      exportWrote: '已写入 {file}',
      exportWroteChunks: '已写入 {file}（分 {n} 段）',
      exportSavedNotion: '已保存到 Notion',
      exportNeedNotionAuth: '先去设置页授权 Notion',
      exportNeedNotionConfig: '先在设置页配置 Notion',

      /* ---------- Markdown / 笔记内容 ---------- */
      mdExportTitle: 'AI 阅读助手 · 问答记录',
      mdExportTime: '导出时间：{time}　·　共 {n} 条',
      mdUnknownSource: '未知来源',
      mdAllSources: '全部',
      mdSourceLine: '来源：{link}　·　{time}',
      mdModelLine: '模型：{model}',
      mdSelectionHeading: '**选中内容**',
      mdAnswerHeading: '**回答**',
      mdDetailHeading: '**展开**',
      mdNone: '(无)',
      mdEmpty: '(空)',
      exporterUntitled: '未命名',
      exporterModeFallback: '问答',
      exporterNoTitle: '无标题',
      exporterSelHeading: '## 选中内容',
      exporterAnswerHeading: '## 回答',
      exporterDetailHeading: '## 展开',
      exporterQuoteEmpty: '> (无)',
      notionSourceLabel: '来源：',
      notionSelHeading: '选中内容',
      notionAnswerHeading: '回答',
      notionDetailToggle: '展开',
      notionPageTitle: 'AI 阅读助手 · {n} 条 · {range}',
      notionUntitledPage: '(未命名页面)',
      notionErr401: 'Notion 令牌无效或已被撤销，请回设置页重新填写集成令牌',
      notionErr403: 'Notion 拒绝了请求：多半是目标页面没有分享给你的集成（页面右上角 ··· → 连接）',
      notionErr404: '找不到目标页面：检查 ID 是否正确，以及该页面是否已分享给集成',
      notionErr429: 'Notion 限流了（每个集成 3 请求/秒），稍等几秒再试',
      notionErr400Title: 'Notion 说页面标题不合法：{msg}',
      notionErrGeneric: 'Notion 返回 {status}{code}：{msg}',

      /* ---------- 服务商与网络错误（lib/llm.js） ---------- */
      protoOpenai: 'OpenAI 兼容（DeepSeek / Kimi / 通义 / 智谱 / Ollama / OpenAI…）',
      protoAnthropic: 'Anthropic 原生（Claude）',
      provider_deepseek: 'DeepSeek',
      provider_moonshot: 'Kimi（月之暗面）',
      provider_dashscope: '通义千问（阿里云百炼）',
      provider_zhipu: '智谱 GLM',
      provider_siliconflow: '硅基流动 SiliconFlow',
      provider_openai: 'OpenAI',
      provider_anthropic: 'Anthropic Claude',
      provider_ollama: 'Ollama（本机）',
      provider_lmstudio: 'LM Studio（本机）',
      llmNoBaseUrl: '未填写接口地址（Base URL）',
      llmNoKey: '未填写 API Key',
      llmNoModel: '未填写模型名',
      llmHttp401: 'API Key 被拒绝（HTTP {status}）。请检查 Key 是否填错、已过期、或余额不足。',
      llmHttp404: '接口地址不存在（HTTP 404）。Base URL 可能多写或少写了 /v1。',
      llmHttp400: '请求被拒绝（HTTP 400）。最常见原因是模型名拼写错误，或该模型不支持当前参数。',
      llmHttp429: '请求过于频繁或额度用尽（HTTP 429），稍等一下再试。',
      llmHttp5xx: '模型服务端出错（HTTP {status}），通常重试即可。',
      llmHttpOther: '请求失败（HTTP {status}）。',
      llmResponseTail: '\n服务返回：{detail}',
      llmWhere: '\n请求地址：{url}',
      llmTimeout30: '连接超时（30 秒内没有任何响应），请检查网络或接口地址',
      llmTimeoutShort: '连接超时，请检查网络或接口地址',
      llmAborted: '已取消',
      llmConnectFailed: '无法连接模型服务：{msg}',
      llmConnectHint:
        '\n常见原因：接口地址写错、本机 Ollama/LM Studio 未启动、或该域名权限未授权（到插件设置页重新保存一次即可重新授权）。',
      llmEmptyBody: '模型服务返回了空响应体（可能不支持流式输出）',
      llmTimeoutMs: '连接超时（{sec} 秒无响应）。检查网络、接口地址，本机模型确认已启动。',
      llmRequestUrl: '请求地址：{url}',
      llmNoContent: '响应结构异常，没有拿到 content 字段',
      llmNoChoices: '响应结构异常，没有拿到 choices 字段（该地址可能不是 OpenAI 兼容接口）',
      llmAnthropicUnknown: 'Anthropic 返回未知错误',
      llmModelError: '模型服务返回错误',

      /* ---------- service worker 用户可见文案 ---------- */
      swCmdExplain: '用 AI 解释「%s」',
      swCmdTranslate: '翻译「%s」',
      swCmdAsk: '就此追问 AI…',
      swNoKey: '还没有配置模型。打开插件设置，填入 API Key 后就能用了。',
      swBuildFailed: '组装请求失败：{msg}',
      swEmptyReply: '模型返回了空内容。可能是模型名不对，或该模型只输出推理内容。',
      swExportTooLong:
        '内容太长（约 {n} 字符，需分 {chunks} 次写入）。请缩小筛选范围，或改用「下载 .md 文件」。',
      swNoExportRecords: '没有可导出的记录',
      swBadExportTarget: '不支持的导出目标：{target}',
      swNotionNoToken: '还没填 Notion 集成令牌，请先到设置页「笔记集成」里配置',
      swNotionBadId: 'Notion 父页面 ID 看起来不对，请回设置页检查（可直接粘贴页面链接）',
      swNotionNoPerm: '还没授权访问 Notion，请到设置页「笔记集成」点一次「连接并测试」',
      swNotionNoTokenShort: '还没填写 Notion 集成令牌',
      swNotionBadIdShort: '父页面 ID 看起来不对，请粘贴页面链接或 32 位页面 ID',
      swNotionNoPermShort: '尚未授权访问 api.notion.com，请重试并在弹窗里允许',
      swIntegrationName: '集成',
      swUnknownMessage: '未知消息类型：{type}',
      swExportFileName: 'AI 阅读助手 · {date}',

      /* ---------- 弹窗 ---------- */
      popupLoading: '加载中…',
      popupNoModel: '还没有配置模型，填入 API Key 后就能用了。',
      popupGoSetup: '去配置',
      popupRecentTitle: '最近问答',
      popupRecentEmpty: '还没有记录。在网页上划一段文字试试。',
      popupAllHistory: '全部历史',
      popupSettings: '设置',
      popupKbdHint: '解释选中内容',
      popupReadFailed: '读取设置失败',
      popupReadFailedDetail: '无法读取设置：{msg}。点「设置」重试，或到扩展管理页重新加载一次插件。',
      popupMissingLine: '未配置 · 还差 {list}',
      popupMissingDetail: '还没有配置模型：缺少 {list}。填好后点「保存并测试连接」，弹窗这里就会认到。',
      popupReady: '{model} · {n} 条记录',
      popupBackendError: '后台返回异常',
      fieldBaseUrl: '接口地址',
      fieldApiKey: 'API Key',
      fieldModel: '模型名',
      noSelection: '(无选中内容)',
      unknownSource: '未知来源',
      timeNow: '刚刚',
      timeMinutes: '{n} 分钟前',
      timeHours: '{n} 小时前',
      timeDays: '{n} 天前',

      /* ---------- 设置页：静态骨架 ---------- */
      optDocTitle: 'AI 阅读助手 · 设置',
      optTabSettings: '设置',
      optTabHistory: '历史记录',
      optModelCardTitle: '模型接入',
      optModelCardDesc: '填一次就能用。密钥只存在这台电脑的浏览器里，不会同步到其他设备。',
      optProvider: '服务商',
      optProtocol: '接口协议',
      optProtocolOpenai: 'OpenAI 兼容',
      optProtocolAnthropic: 'Anthropic 原生',
      optModelName: '模型名',
      optBaseUrl: '接口地址（Base URL）',
      optBaseUrlHintHtml:
        '填到 <code>/v1</code> 即可，程序会自动补 <code>/chat/completions</code>；填完整地址也能识别。',
      optApiKey: 'API Key',
      optShowKey: '显示',
      optHideKey: '隐藏',
      optKeyHintSet: '密钥以明文保存在本机扩展存储中。建议单独申请一个低额度 Key 专供本插件使用。',
      optKeyHintEmpty: '还没有填密钥。密钥只存在本机，不会同步到其他设备。',
      optTemperature: '回答随机性',
      optTempHint: '越低越稳定保守，查知识建议 0.2~0.4。',
      optBudget: '上下文预算',
      optBudgetUnit: '字符',
      optBudgetHint:
        '多轮追问时，发给模型的全部内容（含历史压缩摘要）不超过这个量。模型窗口小就调低，窗口大想多带历史就调高。改动立即生效。',
      optSaveAndTest: '保存并测试连接',
      optTestOnly: '仅测试',
      optTestNote: '测试会真实发起一次极短的模型请求，能同时验证地址、密钥、模型名。',
      optDirtyHtml:
        '<b>这里有改动还没保存。</b>「仅测试」只用表单当前值发一次请求，不会写入配置—— 要点「保存并测试连接」，扩展才会用上这套配置。关掉本页也会丢失。',
      optInteractCardTitle: '交互方式',
      optInteractCardDesc: '控制气泡什么时候出现、回答时默认做什么。',
      optTriggerLabel: '划词后的行为',
      optTriggerChipTitle: '先浮出小气泡，等我选动作',
      optTriggerChipDesc: '最克制：选区旁给出一排动作按钮，点哪个就在右侧面板展开回答。',
      optTriggerAutoTitle: '划完直接在右侧面板回答',
      optTriggerAutoDesc: '最省事：选中即用默认动作开始回答，适合大段啃文档。',
      optTriggerOffTitle: '只响应快捷键 / 右键',
      optTriggerOffDescHtml:
        '最安静：划词后完全不会自动弹出，用 <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> 或右键菜单触发。（双击即问由下面单独的开关控制，不受这里影响。）',
      optDefaultMode: '默认动作',
      optBubbleModes: '小气泡上显示的动作',
      optBubbleModesHint:
        '回答统一在右侧对话面板里展开：全高显示、消息按轮次累积、可继续追问。面板宽度拖左侧边缘即可调整，会自动记住。',
      optLanguage: '界面语言',
      optLanguageHint: '默认跟随浏览器界面语言，切换后立即生效（面板下次打开时也用它）。',
      optLanguageAuto: '跟随浏览器',
      optLanguageChanged: '界面语言已切换',
      // 语言名用各自的语言写（endonym）：界面语言是英文时，「简体中文」也不该写成 Chinese
      langZh: '简体中文',
      langEn: 'English',
      optDblclickTitle: '双击选词直接提问',
      optDblclickDesc:
        '双击一个单词后立刻开始回答，连气泡都不用点。三击选中整段时仍会先给气泡，让你自己挑动作。',
      optQuickAskMode: '双击时用的动作',
      optLayeredTitle: '分层回答：先给结论，细节折叠',
      optLayeredDesc: '第一屏只放最关键的信息，想看细节再点「展开细节」。关掉后仍是一次性给出完整回答。',
      optRecordsCardTitle: '记录与存档',
      optRecordsCardDesc: '每段问答都能留在本地，随时导出成 Markdown 笔记。',
      optAutoSaveTitle: '自动存档每次问答',
      optAutoSaveDesc: '关闭后气泡上仍可手动点「收藏」保存。',
      optMaxHistory: '最多保留条数',
      optMaxHistoryHint: '超出后自动淘汰最旧的记录，被收藏的永不淘汰。',
      optIntegrateCardTitle: '笔记集成',
      optIntegrateCardDesc:
        '把面板上的单条回答，或历史里的整批存档，推进你的笔记库。内容从本机直接发往你配置的目标，不经过任何中转服务器。',
      optObsidianVault: 'Obsidian 库名',
      optObsidianVaultPlaceholder: '留空 = 用最近打开的库',
      optObsidianVaultHint:
        '填写 Obsidian 里「打开库」时显示的名字（区分大小写）。留空则由 Obsidian 自己决定写进哪个库。',
      optObsidianFolder: 'Obsidian 文件夹',
      optObsidianFolderPlaceholder: 'AI 阅读助手',
      optObsidianFolderHint:
        '库内的相对路径，不存在会自动创建。留空 = 写在库根目录。观察库根目录堆满文件的人建议填一个。',
      optNotionToken: 'Notion 集成令牌',
      optNotionTokenPlaceholder: 'ntn_… 或 secret_…',
      optNotionTokenHintHtml:
        '到 <a href="https://www.notion.so/my-integrations" target="_blank" rel="noreferrer">notion.so/my-integrations</a> 新建一个「内部集成」，把生成的令牌复制过来。和 API Key 一样只保存在本机。',
      optNotionParent: 'Notion 父页面',
      optNotionParentPlaceholder: '粘贴页面链接或页面 ID',
      optNotionParentHintHtml:
        '每批导出会在该页面下新建一个子页面。可以直接粘贴页面链接，ID 会自动提取。<b>务必把那个页面分享给集成</b>（页面右上角 ··· → 连接 → 选中你的集成），否则会报「找不到页面」。',
      optNotionConnect: '连接 Notion 并测试',
      optObsidianTest: '试写一篇 Obsidian 笔记',
      optPermCardTitle: '站点权限',
      optPermCardDesc: '只会向「接口地址」所在的域名申请联网权限，不会申请全站访问权。',
      optRefreshPerm: '刷新权限列表',
      optPermNote: '若测试时提示未授权，点此处重新授权。',
      optSafetyTitle: '安全说明',
      optSafetyItem1Html:
        '<b>密钥存放位置：</b>本机浏览器扩展存储（<code>chrome.storage.local</code>），明文保存，<b>不会</b>同步到你的其他设备，也不会发送给除你指定模型服务商以外的任何一方，更不经过任何中转服务器。',
      optSafetyItem2Html:
        '<b>页面内容：</b>只有你主动划词并提问时，选中的文字、所在段落与页面标题才会发给你配置的模型服务商。不提问就什么都不会发出去。',
      optSafetyItem3Html: '<b>建议：</b>给本插件单独申请一个低额度 Key，万一泄露损失可控。',
      optSafetyItem4Html:
        '<b>不支持：</b>浏览器内置 PDF 阅读器、<code>chrome://</code> 内部页面（浏览器不允许扩展在这些页面运行）。',
      optHistoryCardTitle: '问答存档',
      optHistoryCardDesc: '按页面归档。可搜索、筛选，导出后直接就是一篇可用的 Markdown 笔记。',
      optSearchPlaceholder: '搜索选中内容、问题或回答…',
      optAllSources: '全部来源',
      optOnlyStar: '只看收藏',
      optExportMd: '导出 Markdown',
      optExportObsidian: '发送到 Obsidian',
      optExportNotion: '发送到 Notion',
      optClear: '清空',
      optHistEmpty: '还没有记录。去网页上划一段文字试试。',

      /* ---------- 设置页：动态文案 ---------- */
      optCustomProvider: '自定义 / 其他服务商',
      optPermEmpty: '尚未授予任何接口域名的访问权限。填好模型配置后点「保存并测试」即可授权。',
      optPermGranted: '已授权',
      optPermPatternMissing: '接口地址无法解析。请填写完整地址，例如 https://api.deepseek.com/v1',
      optPermDenied:
        '未获得 {pattern} 的联网权限，请求会被浏览器拦截。请再点一次「保存并测试」，或在扩展详情页手动授予站点访问权限。',
      optPermRequestFailed: '申请权限失败：{msg}',
      optPermRefreshed: '已刷新权限列表',
      optSaveFailed: '保存失败',
      optSaveFailedDetail: '保存失败：{msg}',
      optIntegrateNoteNotionReady: 'Notion 已填写。点「连接 Notion 并测试」验证令牌和页面权限。',
      optIntegrateNoteNotionPartial: '令牌与父页面都填好之后才能导出到 Notion。',
      optIntegrateNoteIdle: 'Obsidian 无需授权，填好库名就能用；Notion 需要上面两项配置。',
      optNotionNeedToken: '先填写 Notion 集成令牌。',
      optNotionConnecting: '连接中…',
      optNotionPermFailed: '申请权限失败：{msg}',
      optNotionPermDenied: '未授予 api.notion.com 的访问权限，导出到 Notion 会被浏览器拦下。',
      optNotionConnectOk: '连接正常：集成「{bot}」· 父页面「{parent}」已就绪。',
      optNotionConnectFailed: '连接失败：{msg}',
      optObsidianTestTitle: 'AI 阅读助手 · 配置测试',
      optObsidianTestFile: '# 配置测试',
      optObsidianTestIntro: '能看到这篇笔记，说明 Obsidian 这条链路是通的。',
      optObsidianTestVault: '库名：{vault}',
      optObsidianTestFolder: '文件夹：{folder}',
      optObsidianTestVaultRecent: '(最近打开的库)',
      optObsidianTestFolderEmpty: '(库根目录)',
      optObsidianTestSent: '已发往 Obsidian，去库里看一眼有没有出现这篇测试笔记。',
      optObsidianTestFailed: '打开 Obsidian 失败：{msg}',
      optNoRecordsToSend: '没有可导出的记录',
      optBatchConfirm: '将把当前 {n} 条记录合并成一篇笔记写入 Obsidian。\n\n内容较长时会自动分成几次写入（每段都进同一篇笔记）。继续？',
      optSending: '发送中…',
      optSendFailed: '发送失败',
      optSendFailedDetail: '发送失败：{msg}',
      optSentObsidian: '已写入 Obsidian：{file}',
      optSentObsidianChunks: '已写入 Obsidian：{file}（分 {n} 段）',
      optSentNotion: '已在 Notion 新建页面，写入 {n} 条记录',
      optSaving: '保存中…',
      optTesting: '测试中…',
      optTestingNow: '正在向模型服务发起一次极短请求…',
      optTestOkHtml: '<b>✓ 连接正常</b>\n接口：{endpoint}\n模型：{model}　·　耗时 {ms}ms\n模型回复：{reply}',
      optTestNotSavedHtml:
        '\n\n⚠ 本次测试用的是<b>表单当前值</b>，尚未保存。请点「保存并测试连接」让配置真正生效。',
      optTestFailHtml: '<b>✗ 连接失败</b>\n{msg}',
      optTestEmptyReply: '(空)',
      optHistStatEmpty: '暂无记录',
      optHistStat: '共 {total} 条 · 收藏 {star} 条 · 当前筛选出 {shown} 条',
      optQuestionTag: '问：{q}',
      optStarTitle: '收藏',
      optDelTitle: '删除',
      optHistSource: '来源：{title}\n{url}',
      optHistLimit: '只显示了最近 {n} 条。用搜索或筛选缩小范围，或直接导出全部。',
      optDeleted: '已删除',
      optExportEmpty: '没有可导出的记录',
      optExportFailed: '导出失败：{msg}',
      optExportFileName: 'AI阅读助手-问答记录-{date}.md',
      optExported: '已导出 {n} 条',
      optDownloadFailed: '下载失败：{msg}',
      optClearConfirm:
        '共 {total} 条记录，其中 {star} 条已收藏。\n\n点「确定」= 只保留收藏（删除 {keep} 条）\n点「取消」= 什么都不做',
      optClearConfirmStar: '确定要连同 {star} 条收藏一起全部清空？此操作不可撤销。',
      optClearConfirmAll: '确定清空全部 {total} 条记录？此操作不可撤销。',
      optClearedKeep: '已清理，保留 {n} 条收藏',
      optCleared: '已清空',
      optUnknownError: '未知错误',
    },

    en: {
      /* ---------- brand ---------- */
      appName: 'AI Reader',
      appTagline: 'Select to ask · bring your own model',

      /* ---------- actions ---------- */
      mode_explain_label: 'Explain',
      mode_explain_hint: 'Make this clear to me',
      mode_translate_label: 'Translate',
      mode_translate_hint: 'Into Chinese or English',
      mode_example_label: 'Example',
      mode_example_hint: 'Give a concrete example',
      mode_deeper_label: 'Go deeper',
      mode_deeper_hint: 'The principles behind it',
      mode_summarize_label: 'Summarize',
      mode_summarize_hint: 'Pull out the key points',
      mode_ask_label: 'Ask',
      mode_ask_hint: 'Type your own question',

      /* ---------- bubble & panel chrome ---------- */
      bubbleOpenTitle: 'Open AI Reader',
      panelResizeTitle: 'Drag to resize',
      panelOptionsTitle: 'Open settings',
      panelMinTitle: 'Minimize',
      panelCloseTitle: 'End conversation (Esc)',
      panelInputPlaceholder: 'Ask a follow-up… (Enter to send, Shift+Enter for a new line)',
      panelSend: 'Send',
      panelCopyAllLabel: 'Copy all',
      panelCopyAllTitle: 'Copy the whole conversation',
      panelStarTitle: 'Save the last answer',
      starOn: '★ Saved',
      starOff: '☆ Save',
      quoteExpand: 'expand',
      quoteCollapse: 'collapse',

      /* ---------- status line ---------- */
      panelThinking: 'Thinking…',
      statusSaved: 'saved',
      statusUnsaved: 'not saved',
      statusError: 'error',
      statusCanceled: 'cancelled',

      /* ---------- per answer ---------- */
      moreExpand: 'Show details',
      moreCollapse: 'Hide details',
      moreStreaming: 'writing…',
      moreSize: '{n} chars',
      actCopy: 'Copy',
      actExport: 'Export',
      actExportTitle: 'Save to Obsidian / Notion, or copy as Markdown',
      actRetry: 'Redo',
      anchorGoto: '↩ Back to source',
      anchorGotoTitle: 'Jump back to where this text was selected',
      anchorMissing: 'No source location for this turn',
      anchorLost: 'Source location is gone (the page content changed)',

      /* ---------- context compaction ---------- */
      ctxSummaryTurns: '{n} turns summarized',
      ctxOmittedTurns: '{n} more omitted',
      ctxNote: 'Earlier turns compacted: {bits}',
      ctxNoteTitle:
        'Context is compacted to fit the {budget}-character budget: the most recent {full} turns are kept in full, earlier turns are summarized.',

      /* ---------- errors & toasts ---------- */
      errGeneric: 'Something went wrong',
      errUnknown: 'unknown error',
      errGoSettings: 'Open settings',
      errAborted: 'Cancelled.',
      errDisconnected: 'Connection lost (the page may have navigated). Select text again to continue.',
      errBackend: 'Cannot reach the extension background: {msg}\nReload the extension at chrome://extensions.',
      copied: 'Copied to clipboard',
      copyFailedManual: 'Copy failed — select the text and copy it manually',
      copiedAll: 'Conversation copied',
      copyFailed: 'Copy failed',
      savedOn: 'Saved',
      savedOff: 'Removed from saved',
      opFailed: 'Action failed: {msg}',
      questionPrefix: '**Q:** {q}',
      historyAsk: '{label} this: {text}',

      /* ---------- export ---------- */
      exportObsidian: 'Save to Obsidian',
      exportNotion: 'Save to Notion',
      exportClipboard: 'Copy as Markdown',
      exportDownload: 'Download .md file',
      exportVaultRecent: 'most recent vault',
      exportAuthorizing: 'needs approval',
      exportUnconfigured: 'not set up',
      exportWritingObsidian: 'Writing to Obsidian…',
      exportSavingNotion: 'Saving to Notion…',
      exportFailed: 'Export failed',
      exportFailedDetail: 'Export failed: {msg}',
      exportMdFailed: 'Could not build the Markdown',
      exportCopiedMd: 'Markdown copied',
      exportCopyFailed: 'Copy failed: {msg}',
      exportWrote: 'Written to {file}',
      exportWroteChunks: 'Written to {file} ({n} parts)',
      exportSavedNotion: 'Saved to Notion',
      exportNeedNotionAuth: 'Approve Notion access in settings first',
      exportNeedNotionConfig: 'Set up Notion in settings first',

      /* ---------- markdown / note content ---------- */
      mdExportTitle: 'AI Reader · Q&A archive',
      mdExportTime: 'Exported {time}　·　{n} items',
      mdUnknownSource: 'Unknown source',
      mdAllSources: 'All',
      mdSourceLine: 'Source: {link}　·　{time}',
      mdModelLine: 'Model: {model}',
      mdSelectionHeading: '**Selected text**',
      mdAnswerHeading: '**Answer**',
      mdDetailHeading: '**Details**',
      mdNone: '(none)',
      mdEmpty: '(empty)',
      exporterUntitled: 'Untitled',
      exporterModeFallback: 'Q&A',
      exporterNoTitle: 'Untitled',
      exporterSelHeading: '## Selected text',
      exporterAnswerHeading: '## Answer',
      exporterDetailHeading: '## Details',
      exporterQuoteEmpty: '> (none)',
      notionSourceLabel: 'Source: ',
      notionSelHeading: 'Selected text',
      notionAnswerHeading: 'Answer',
      notionDetailToggle: 'Details',
      notionPageTitle: 'AI Reader · {n} items · {range}',
      notionUntitledPage: '(untitled page)',
      notionErr401: 'The Notion token is invalid or revoked — add a valid integration token in settings',
      notionErr403:
        'Notion denied the request — most likely the target page is not shared with your integration (page ··· menu → Connections)',
      notionErr404:
        'Target page not found — check the ID and make sure that page is shared with your integration',
      notionErr429: 'Notion rate-limited the request (3 per second per integration) — retry in a few seconds',
      notionErr400Title: 'Notion rejected the page title: {msg}',
      notionErrGeneric: 'Notion returned {status}{code}: {msg}',

      /* ---------- providers & network errors ---------- */
      protoOpenai: 'OpenAI-compatible (DeepSeek / Kimi / Qwen / Zhipu / Ollama / OpenAI…)',
      protoAnthropic: 'Anthropic native (Claude)',
      provider_deepseek: 'DeepSeek',
      provider_moonshot: 'Kimi (Moonshot)',
      provider_dashscope: 'Qwen (Alibaba Cloud Bailian)',
      provider_zhipu: 'Zhipu GLM',
      provider_siliconflow: 'SiliconFlow',
      provider_openai: 'OpenAI',
      provider_anthropic: 'Anthropic Claude',
      provider_ollama: 'Ollama (local)',
      provider_lmstudio: 'LM Studio (local)',
      llmNoBaseUrl: 'No base URL set',
      llmNoKey: 'No API key set',
      llmNoModel: 'No model name set',
      llmHttp401:
        'The API key was rejected (HTTP {status}). Check that it is correct, not expired, and still has quota.',
      llmHttp404:
        'Endpoint not found (HTTP 404). The base URL probably has one /v1 too many or too few.',
      llmHttp400:
        'Request rejected (HTTP 400). The usual causes are a misspelled model name or parameters the model does not support.',
      llmHttp429: 'Rate limited or out of quota (HTTP 429) — wait a moment and retry.',
      llmHttp5xx: 'The model service failed (HTTP {status}). Retrying usually works.',
      llmHttpOther: 'Request failed (HTTP {status}).',
      llmResponseTail: '\nService response: {detail}',
      llmWhere: '\nRequest URL: {url}',
      llmTimeout30: 'Timed out — no response within 30 seconds. Check your network or the base URL.',
      llmTimeoutShort: 'Timed out — check your network or the base URL.',
      llmAborted: 'Cancelled',
      llmConnectFailed: 'Cannot reach the model service: {msg}',
      llmConnectHint:
        '\nCommon causes: a wrong base URL, a local Ollama/LM Studio that is not running, or a missing host permission (save the settings once to re-authorize).',
      llmEmptyBody: 'The model service returned an empty body (streaming may not be supported).',
      llmTimeoutMs: 'Timed out after {sec}s. Check your network and base URL, and make sure a local model is running.',
      llmRequestUrl: 'Request URL: {url}',
      llmNoContent: 'Unexpected response: no content field',
      llmNoChoices: 'Unexpected response: no choices field (this endpoint may not be OpenAI-compatible)',
      llmAnthropicUnknown: 'Anthropic returned an unknown error',
      llmModelError: 'The model service returned an error',

      /* ---------- service worker ---------- */
      swCmdExplain: 'Explain "%s" with AI',
      swCmdTranslate: 'Translate "%s"',
      swCmdAsk: 'Ask AI about this…',
      swNoKey: 'No model configured yet. Open the extension settings and add your API key.',
      swBuildFailed: 'Failed to build the request: {msg}',
      swEmptyReply:
        'The model returned nothing. The model name may be wrong, or it may only output reasoning tokens.',
      swExportTooLong:
        'Too much content (~{n} characters, would need {chunks} writes). Narrow the filter, or use "Download .md file" instead.',
      swNoExportRecords: 'Nothing to export',
      swBadExportTarget: 'Unsupported export target: {target}',
      swNotionNoToken: 'No Notion integration token yet — add one under Note integrations in settings',
      swNotionBadId: 'That Notion parent page ID looks wrong — check it in settings (pasting the page link works too)',
      swNotionNoPerm: 'Notion access is not authorized yet — click "Connect & test Notion" in settings',
      swNotionNoTokenShort: 'The Notion integration token is empty',
      swNotionBadIdShort: 'Parent page ID looks wrong — paste a page link or a 32-character page ID',
      swNotionNoPermShort: 'api.notion.com is not authorized yet — retry and allow it in the browser prompt',
      swIntegrationName: 'integration',
      swUnknownMessage: 'Unknown message type: {type}',
      swExportFileName: 'AI Reader · {date}',

      /* ---------- popup ---------- */
      popupLoading: 'Loading…',
      popupNoModel: 'No model configured yet — add your API key to get started.',
      popupGoSetup: 'Set up',
      popupRecentTitle: 'Recent',
      popupRecentEmpty: 'Nothing yet. Select some text on a page to try it.',
      popupAllHistory: 'All history',
      popupSettings: 'Settings',
      popupKbdHint: 'Explain the selected text',
      popupReadFailed: 'Could not read settings',
      popupReadFailedDetail:
        'Could not read settings: {msg}. Open Settings to retry, or reload the extension at chrome://extensions.',
      popupMissingLine: 'Not set up · missing {list}',
      popupMissingDetail:
        'No model yet: missing {list}. Save with "Save & test connection" and this popup will pick it up.',
      popupReady: '{model} · {n} records',
      popupBackendError: 'the background script returned an error',
      fieldBaseUrl: 'base URL',
      fieldApiKey: 'API key',
      fieldModel: 'model name',
      noSelection: '(no selection)',
      unknownSource: 'unknown source',
      timeNow: 'just now',
      timeMinutes: '{n} min ago',
      timeHours: '{n} h ago',
      timeDays: '{n} d ago',

      /* ---------- options: static chrome ---------- */
      optDocTitle: 'AI Reader · Settings',
      optTabSettings: 'Settings',
      optTabHistory: 'History',
      optModelCardTitle: 'Model',
      optModelCardDesc:
        'Set it up once. The key stays in this browser on this machine and is never synced to your other devices.',
      optProvider: 'Provider',
      optProtocol: 'API protocol',
      optProtocolOpenai: 'OpenAI-compatible',
      optProtocolAnthropic: 'Anthropic native',
      optModelName: 'Model name',
      optBaseUrl: 'Base URL',
      optBaseUrlHintHtml:
        'Stopping at <code>/v1</code> is enough — <code>/chat/completions</code> is appended automatically. A full endpoint URL works too.',
      optApiKey: 'API Key',
      optShowKey: 'Show',
      optHideKey: 'Hide',
      optKeyHintSet:
        'The key is stored in plain text in this browser\u2019s extension storage. A separate low-quota key is a good idea.',
      optKeyHintEmpty: 'No key yet. It stays on this machine and is never synced to other devices.',
      optTemperature: 'Randomness',
      optTempHint: 'Lower is steadier and more conservative. 0.2\u20130.4 works well for factual lookups.',
      optBudget: 'Context budget',
      optBudgetUnit: 'characters',
      optBudgetHint:
        'With follow-up questions, everything sent to the model (including the compacted history) stays under this size. Lower it for small context windows, raise it to carry more history. Takes effect immediately.',
      optSaveAndTest: 'Save & test connection',
      optTestOnly: 'Test only',
      optTestNote: 'The test sends one very short request, verifying the URL, key and model name at once.',
      optDirtyHtml:
        '<b>You have unsaved changes.</b> "Test only" sends one request with the <i>current form values</i> and writes nothing — click "Save & test connection" for the extension to actually use this configuration. Closing this page discards it.',
      optInteractCardTitle: 'Interaction',
      optInteractCardDesc: 'When the bubble appears, and what happens by default.',
      optTriggerLabel: 'After selecting text',
      optTriggerChipTitle: 'Show a small bubble and wait for me',
      optTriggerChipDesc:
        'The most restrained option: a row of action buttons next to the selection; clicking one opens the answer in the side panel.',
      optTriggerAutoTitle: 'Answer straight away in the side panel',
      optTriggerAutoDesc:
        'The least effort: selecting text starts the default action right away. Good for long documents.',
      optTriggerOffTitle: 'Only keyboard shortcut / right-click',
      optTriggerOffDescHtml:
        'The quietest option: nothing pops up on selection; use <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> or the context menu. (Double-click asking has its own switch below and is unaffected by this.)',
      optDefaultMode: 'Default action',
      optBubbleModes: 'Actions shown in the bubble',
      optBubbleModesHint:
        'Answers always open in the side panel: full height, accumulated turn by turn, ready for follow-ups. Drag the panel\u2019s left edge to resize; the width is remembered.',
      optLanguage: 'Interface language',
      optLanguageHint:
        'Follows your browser language by default. Changes apply immediately, and the panel uses it the next time it opens.',
      optLanguageAuto: 'Match browser',
      optLanguageChanged: 'Interface language switched',
      // Endonyms: the language names stay in their own language in both locales
      langZh: '简体中文',
      langEn: 'English',
      optDblclickTitle: 'Double-click a word to ask right away',
      optDblclickDesc:
        'Double-clicking a word starts an answer without touching the bubble. Triple-click still shows the bubble so you can pick an action yourself.',
      optQuickAskMode: 'Action for double-click',
      optLayeredTitle: 'Layered answers: conclusion first, details collapsed',
      optLayeredDesc:
        'The first screen holds only the essentials; click "Show details" for the rest. Turn it off to get the full answer in one go.',
      optRecordsCardTitle: 'Records',
      optRecordsCardDesc: 'Every Q&A can stay on this machine, ready to export as Markdown notes.',
      optAutoSaveTitle: 'Archive every Q&A automatically',
      optAutoSaveDesc: 'With this off you can still save individual answers with the ☆ button.',
      optMaxHistory: 'Records kept',
      optMaxHistoryHint: 'The oldest records are dropped first; saved ones are never dropped.',
      optIntegrateCardTitle: 'Note integrations',
      optIntegrateCardDesc:
        'Send a single answer from the panel, or a whole batch from history, into your notes. Content goes from this machine straight to the target you configured — no relay server involved.',
      optObsidianVault: 'Obsidian vault',
      optObsidianVaultPlaceholder: 'Blank = the most recently opened vault',
      optObsidianVaultHint:
        'The name shown in Obsidian\u2019s "Open vault" dialog (case-sensitive). Leave it blank and Obsidian decides which vault to use.',
      optObsidianFolder: 'Obsidian folder',
      optObsidianFolderPlaceholder: 'AI Reader',
      optObsidianFolderHint:
        'A path relative to the vault root; created if missing. Leave it blank to write at the vault root. Recommended if your root fills up with files.',
      optNotionToken: 'Notion integration token',
      optNotionTokenPlaceholder: 'ntn_… or secret_…',
      optNotionTokenHintHtml:
        'Create an internal integration at <a href="https://www.notion.so/my-integrations" target="_blank" rel="noreferrer">notion.so/my-integrations</a> and paste the token here. Like the API key, it is stored only on this machine.',
      optNotionParent: 'Notion parent page',
      optNotionParentPlaceholder: 'Paste a page link or page ID',
      optNotionParentHintHtml:
        'Each export creates a new child page under it. Pasting the page link is fine — the ID is extracted automatically. <b>The page must be shared with your integration</b> (page ··· menu → Connections), otherwise you will get "page not found".',
      optNotionConnect: 'Connect & test Notion',
      optObsidianTest: 'Write a test note to Obsidian',
      optPermCardTitle: 'Site access',
      optPermCardDesc:
        'Only the domain of your Base URL is requested; the extension never asks for access to every site.',
      optRefreshPerm: 'Refresh list',
      optPermNote: 'If a test reports missing permission, click here to grant it again.',
      optSafetyTitle: 'Security',
      optSafetyItem1Html:
        '<b>Where the key lives:</b> this browser\u2019s extension storage (<code>chrome.storage.local</code>), in plain text. It is <b>not</b> synced to your other devices, is never sent to anyone except the model provider you configured, and never passes through a relay server.',
      optSafetyItem2Html:
        '<b>Page content:</b> only when you select text and ask, the selection, its paragraph and the page title are sent to the model provider you configured. If you never ask, nothing is ever sent.',
      optSafetyItem3Html: '<b>Advice:</b> create a separate low-quota key for this extension so a leak stays cheap.',
      optSafetyItem4Html:
        '<b>Not supported:</b> the browser\u2019s built-in PDF viewer and <code>chrome://</code> pages (browsers do not allow extensions to run there).',
      optHistoryCardTitle: 'Archive',
      optHistoryCardDesc:
        'Grouped by page. Search and filter it, then export straight into a usable Markdown note.',
      optSearchPlaceholder: 'Search selections, questions, answers…',
      optAllSources: 'All sources',
      optOnlyStar: 'Saved only',
      optExportMd: 'Export Markdown',
      optExportObsidian: 'Send to Obsidian',
      optExportNotion: 'Send to Notion',
      optClear: 'Clear',
      optHistEmpty: 'No records yet. Select some text on a page to get started.',

      /* ---------- options: dynamic ---------- */
      optCustomProvider: 'Custom / other provider',
      optPermEmpty:
        'No API-domain permission granted yet. Fill in the model settings and click "Save & test" to grant it.',
      optPermGranted: 'granted',
      optPermPatternMissing: 'Could not parse the base URL. Please enter a full URL, e.g. https://api.deepseek.com/v1',
      optPermDenied:
        'Permission for {pattern} was not granted, so the browser will block the request. Click "Save & test" again, or grant site access manually on the extension details page.',
      optPermRequestFailed: 'Permission request failed: {msg}',
      optPermRefreshed: 'Permission list refreshed',
      optSaveFailed: 'Save failed',
      optSaveFailedDetail: 'Save failed: {msg}',
      optIntegrateNoteNotionReady:
        'Notion is filled in. Click "Connect & test Notion" to verify the token and page access.',
      optIntegrateNoteNotionPartial: 'Both the token and the parent page are needed to export to Notion.',
      optIntegrateNoteIdle:
        'Obsidian needs no authorization — just fill in the vault. Notion needs the two fields above.',
      optNotionNeedToken: 'Fill in the Notion integration token first.',
      optNotionConnecting: 'Connecting…',
      optNotionPermFailed: 'Permission request failed: {msg}',
      optNotionPermDenied:
        'Access to api.notion.com was not granted, so the browser will block exports to Notion.',
      optNotionConnectOk: 'Connected: integration "{bot}" · parent page "{parent}" is ready.',
      optNotionConnectFailed: 'Connection failed: {msg}',
      optObsidianTestTitle: 'AI Reader · setup test',
      optObsidianTestFile: '# Setup test',
      optObsidianTestIntro: 'If you can read this note, the Obsidian pipeline works.',
      optObsidianTestVault: 'Vault: {vault}',
      optObsidianTestFolder: 'Folder: {folder}',
      optObsidianTestVaultRecent: '(most recent vault)',
      optObsidianTestFolderEmpty: '(vault root)',
      optObsidianTestSent: 'Sent to Obsidian — check that the test note showed up in your vault.',
      optObsidianTestFailed: 'Could not open Obsidian: {msg}',
      optNoRecordsToSend: 'Nothing to export',
      optBatchConfirm:
        '{n} records will be merged into a single Obsidian note.\n\nLong content is written in several passes (all into the same note). Continue?',
      optSending: 'Sending…',
      optSendFailed: 'Send failed',
      optSendFailedDetail: 'Send failed: {msg}',
      optSentObsidian: 'Written to Obsidian: {file}',
      optSentObsidianChunks: 'Written to Obsidian: {file} ({n} parts)',
      optSentNotion: 'Created a new Notion page with {n} records',
      optSaving: 'Saving…',
      optTesting: 'Testing…',
      optTestingNow: 'Sending one very short request to the model service…',
      optTestOkHtml:
        '<b>✓ Connected</b>\nEndpoint: {endpoint}\nModel: {model}　·　{ms}ms\nReply: {reply}',
      optTestNotSavedHtml:
        '\n\n⚠ This test used the <b>current form values</b>, which are not saved yet. Click "Save & test connection" to apply them.',
      optTestFailHtml: '<b>✗ Connection failed</b>\n{msg}',
      optTestEmptyReply: '(empty)',
      optHistStatEmpty: 'No records',
      optHistStat: '{total} total · {star} saved · {shown} shown',
      optQuestionTag: 'Q: {q}',
      optStarTitle: 'Save',
      optDelTitle: 'Delete',
      optHistSource: 'Source: {title}\n{url}',
      optHistLimit: 'Showing the most recent {n} records. Narrow it with search or filters, or export everything.',
      optDeleted: 'Deleted',
      optExportEmpty: 'Nothing to export',
      optExportFailed: 'Export failed: {msg}',
      optExportFileName: 'ai-reader-archive-{date}.md',
      optExported: 'Exported {n} records',
      optDownloadFailed: 'Download failed: {msg}',
      optClearConfirm:
        '{total} records, of which {star} are saved.\n\nOK = keep only the saved ones (delete {keep})\nCancel = do nothing',
      optClearConfirmStar: 'Also delete the {star} saved records? This cannot be undone.',
      optClearConfirmAll: 'Delete all {total} records? This cannot be undone.',
      optClearedKeep: 'Cleared, {n} saved records kept',
      optCleared: 'Cleared',
      optUnknownError: 'unknown error',
    },
  };

  /* ================================================================
   * 解析
   * ================================================================ */

  /** 用户在设置页显式指定的语言；null = 跟随浏览器 */
  let override = null;
  /** 缓存当前生效语言，避免每次取词都重新探测 */
  let cached = null;

  /** 把任意语言标签归一化成我们支持的两个之一 */
  function normalize(tag) {
    const s = String(tag == null ? '' : tag).trim().toLowerCase().replace(/_/g, '-');
    if (s.startsWith('zh')) return 'zh';
    if (s.startsWith('en')) return 'en';
    return DEFAULT_LOCALE;
  }

  /** 浏览器语言：优先用扩展 API（它才是「浏览器界面语言」的权威来源），退到 navigator */
  function browserLocale() {
    try {
      const ui = globalThis.chrome?.i18n?.getUILanguage?.();
      if (ui) return ui;
    } catch {
      /* 普通网页里没有 chrome.i18n，正常 */
    }
    try {
      const nav = globalThis.navigator;
      if (nav?.languages?.length) return nav.languages[0];
      if (nav?.language) return nav.language;
    } catch {
      /* 某些沙箱里 navigator 不可枚举，忽略 */
    }
    return DEFAULT_LOCALE;
  }

  /**
   * 当前语言。
   * 顺序：显式指定 → 浏览器界面语言 → DEFAULT_LOCALE。
   * 结果缓存起来 —— 语言在一段时间内不会变，而 t() 会被高频调用。
   */
  function getLocale() {
    if (cached) return cached;
    cached = override || normalize(browserLocale());
    return cached;
  }

  /**
   * 指定语言。
   * @param {string|null} locale 'zh' | 'en' | 'auto' | null
   *   null / 'auto' / 非法值 = 恢复「跟随浏览器」。
   * 设置页保存后、content script 读到设置后都会调它。
   */
  function setLocale(locale) {
    override = locale && locale !== 'auto' ? normalize(locale) : null;
    cached = null;
    return getLocale();
  }

  /** 把 {name} 占位符替换掉；数组下标写法 {0} 也支持 */
  function fill(template, subs) {
    if (!subs) return template;
    return template.replace(/\{(\w+)\}/g, (whole, key) => {
      const v = Array.isArray(subs) ? subs[Number(key)] : subs[key];
      return v == null ? whole : String(v);
    });
  }

  /**
   * 取文案。
   * 找不到时退到 DEFAULT_LOCALE（与 manifest 的 default_locale 行为一致），
   * 再找不到就原样返回 key —— 界面上出现一个 key 名，比整句消失好排查得多。
   */
  function t(key, subs) {
    const locale = getLocale();
    const raw = MESSAGES[locale]?.[key] ?? MESSAGES[DEFAULT_LOCALE]?.[key];
    if (raw == null) return key;
    return fill(raw, subs);
  }

  /** 某个 key 在当前语言里的原文（测试与 data-* 应用都走 t，这里只是便捷出口） */
  function has(key) {
    return !!(MESSAGES.zh[key] || MESSAGES.en[key]);
  }

  /* ================================================================
   * DOM 应用
   * ================================================================ */

  /**
   * 把 data-i18n* 属性应用到一段 DOM（document、shadow root、任意元素都行）。
   *
   * 静态骨架用属性标注，动态拼出来的部分直接调 t() —— 两边的来源都是本文件，
   * 不会有第二份文案。
   */
  function applyDom(root) {
    const scope = root || globalThis.document;
    if (!scope?.querySelectorAll) return;

    for (const el of scope.querySelectorAll('[data-i18n]')) {
      el.textContent = t(el.getAttribute('data-i18n'));
    }
    for (const el of scope.querySelectorAll('[data-i18n-html]')) {
      // 文案来自本文件的字典，不含任何用户输入，innerHTML 在这里是安全的
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    }
    for (const el of scope.querySelectorAll('[data-i18n-title]')) {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
    }
    for (const el of scope.querySelectorAll('[data-i18n-placeholder]')) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
    }
    for (const el of scope.querySelectorAll('[data-i18n-aria-label]')) {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
    }

    // <html lang> 跟着走：屏幕阅读器与浏览器翻译都看它
    const doc = scope.ownerDocument || (scope.documentElement ? scope : null);
    if (doc?.documentElement) doc.documentElement.lang = HTML_LANG[getLocale()] || 'en';
  }

  /* ================================================================
   * 与语言相关的格式化
   * ================================================================ */

  /** 短日期：中文「9月20日」、英文「Sep 20」——两种语言的书写习惯不同，不能共用模板 */
  function formatDate(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    if (getLocale() === 'zh') return `${d.getMonth() + 1}月${d.getDate()}日`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  /** 相对时间：刚刚 / 3 分钟前 / 2 小时前 / 5 天前 / 9月20日 */
  function timeAgo(ts, now = Date.now()) {
    const m = Math.floor((now - ts) / 60000);
    if (m < 1) return t('timeNow');
    if (m < 60) return t('timeMinutes', { n: m });
    const h = Math.floor(m / 60);
    if (h < 24) return t('timeHours', { n: h });
    const d = Math.floor(h / 24);
    if (d < 30) return t('timeDays', { n: d });
    return formatDate(ts);
  }

  const api = {
    DEFAULT_LOCALE,
    LOCALES,
    MESSAGES,
    t,
    has,
    fill,
    normalize,
    browserLocale,
    getLocale,
    setLocale,
    applyDom,
    formatDate,
    timeAgo,
  };

  globalThis.AI_READER_I18N = api;
})();
