# 商店上架文案与填表答案

提交时直接从这里复制。所有字段都已按 Chrome Web Store / Edge Add-ons 的限制写好长度。

---

## 一、基本字段

| 字段 | Chrome | Edge | 填写内容 |
|---|---|---|---|
| 名称 Name | ≤ 45 字符 | ≤ 50 字符 | 取自 manifest：中文 `AI 阅读助手 · 划词即问`（14 字符）/ 英文 `AI Reader · Select to Ask`（25 字符）。**会按语言自动取对应的值，不用手填** |
| 短描述 Summary | ≤ 132 字符 | — | 见下方「短描述」（取自 manifest，中文 67 字符 / 英文 126 字符，两者都在限内） |
| 详细描述 Description | ≤ 16 000 字符 | 250 ~ 5 000 字符 | 见下方「详细描述（中文）」与「详细描述（English）」 |
| 分类 Category | 必填 | 必填 | **生产力工具（Productivity）**；次选「无障碍/工具」 |
| 主语言 | 必填 | — | 简体中文（zh-CN）；再加一门 **English**（见下） |
| 隐私政策 URL | **必填** | **必填** | `https://github.com/crossSulation/ai-reader/blob/main/PRIVACY.md` |
| 官网 URL | 选填 | 选填 | `https://github.com/crossSulation/ai-reader` |
| 支持邮箱/链接 | 建议填 | 建议填 | 仓库 Issues 链接（同上） |
| 搜索词 Search terms | — | ≤ 21 个词 | `划词 翻译 解释 AI 阅读 助手 大模型 追问 笔记 划词翻译 网页 阅读 助手 DeepSeek OpenAI` |

### 关于多语言

**扩展本身**的语言由包里的 `_locales/en` + `_locales/zh_CN` 决定，浏览器按系统语言自动选，
不用在后台做任何配置（这正是扩展管理页、工具栏提示、右键菜单会跟着变的原因）。

**商店页面**是另一回事：详细描述要每种语言各填一份。中英两版的详细描述都已备好，
在后台「Add language」里加一门 English 粘贴即可。名称与短描述不用填 ——
后台会读取包里该语言的 `__MSG_` 值。`default_locale` 是 `en`，所以
**浏览器语言既不是中文也不是英文时**，扩展与商店都会显示英文版。

**短描述**（中文 67 字符，直接使用 manifest 里的值，无需改动）：

```
阅读网页文档时选中或双击任意文字，用你自己的大模型即时解释、翻译、追问；结论先行、细节可展开，答案自动存档并可导出 Markdown。
```

英文版（126 字符，同样取自 manifest，用于 English listing）：

```
Select any text on a page to ask your own LLM: explain, translate, follow up. Answers are archived and exportable as Markdown.
```

### 详细描述（中文，约 1 100 字符）

```
阅读英文文档、论文、技术手册时，遇到看不懂的段落，不用再切换到另一个标签页去问 AI。
在网页上选中文字，答案就出现在右侧。

【怎么用】
· 划词 → 选区旁浮出一排动作：解释 / 翻译 / 举例 / 深入 / 总结 / 追问
· 双击一个生词 → 直接开始回答，连按钮都不用点
· 快捷键 Alt+Shift+E，或右键菜单「用 AI 解释」

【为什么这样设计】
· 答案在右侧全高面板里展开，不遮挡正文；面板宽度可拖，会自动记住
· 结论先行：第一屏只给一句话结论和 2~3 条要点，原理、例子、易错点收在「展开细节」后面，想看再点开
· 自动带上你所在段落作为背景，模型知道你在读什么，不会答非所问
· 多轮追问有上下文预算，聊多久都不会把请求撑爆；历史被压缩时会明确告诉你
· 每条回答都能「回看原文」，一键跳回页面上当时划词的位置

【自带密钥，没有中间商】
本插件不含任何服务器，也不提供模型额度。你在设置里填入自己的 API Key（DeepSeek、Kimi、
通义、智谱、硅基流动、OpenAI、Anthropic 或任意 OpenAI 兼容接口），请求由你的浏览器直接发往
你选择的模型服务商。密钥只保存在本机，不会同步到其他设备，也不会经过任何中转服务器。
也可以填本地 Ollama / LM Studio 的地址，数据完全不出本机。

【记录与导出】
每次问答自动存档（可关闭），按页面归档，可搜索、筛选、收藏。支持一键存进你自己的笔记库：
Obsidian（不需要装插件，填个库名就能用）或 Notion（用你自己的集成令牌写入你自己的页面），
也可以导出成 Markdown 文件。单条顺手存，也能把整批记录一次性推过去。

【隐私】
不提问就不会有任何内容离开你的浏览器；只在你主动划词提问时，选中的文字、所在段落和页面
标题才会发给你自己配置的模型服务商。不收集浏览历史、不读取其他标签页、不含任何统计代码。

【不支持的页面】
浏览器内置 PDF 阅读器与 chrome:// 内部页面（浏览器不允许任何扩展在这些页面运行）。

开源、无追踪、无需注册：https://github.com/crossSulation/ai-reader
```

### 详细描述（English，第二门语言必填 —— 不加的话英文用户看到的是中文）

```
Select text on any page and ask your own LLM about it — right in the page, without
switching tabs.

· Select text → a small toolbar appears (Explain / Translate / Example / Deeper / Summarize / Ask)
· Double-click a word → the answer starts immediately
· Alt+Shift+E or the right-click menu also work

Answers stream into a full-height side panel with an adjustable, remembered width.
The first screen gives you a one-line conclusion plus a few key points; details,
examples and pitfalls stay collapsed until you expand them. Each answer shows how the
context was compressed and can jump back to the exact spot you selected.

The whole interface is available in English and Chinese, detected from your browser
language. Answers come back in the same language as the interface.

Bring your own key: the extension has no server and provides no model quota. Paste your
own API key (DeepSeek, Moonshot/Kimi, OpenAI, Anthropic, or any OpenAI-compatible
endpoint — including local Ollama / LM Studio) and requests go straight from your browser
to the provider you chose. Your key never leaves your machine.

Q&A history is stored locally, searchable, and exportable. Send any answer straight to
your own Obsidian vault (no plugin needed) or your own Notion workspace (with your own
integration token), or export the whole archive as Markdown.

Open source: https://github.com/crossSulation/ai-reader
```

---

## 二、权限用途说明（Chrome「Permissions」页 / Edge「Justify permissions」）

审核员会逐条看这里的理由。**照抄下面的文字即可**，但要注意：文字必须与实际行为一致。

| 权限 | 直接粘贴的说明 |
|---|---|
| `storage` | 在本机保存用户设置（API Key、接口地址、模型名、交互偏好）与问答记录。不用于任何远程同步。 |
| `unlimitedStorage` | 问答记录会长期累积（默认上限 800 条，用户可调），使用 unlimitedStorage 以避免触发普通存储配额导致写入失败、用户丢记录。 |
| `contextMenus` | 提供右键菜单「用 AI 解释」「翻译」「就此追问」，让用户在不方便划词时也能触发。 |
| `downloads` | 用户在设置页点「导出 Markdown」时，把本地问答记录另存为 .md 文件。 |
| 内容脚本注入网页（`http/https/file`） | 唯一目的是读取用户**主动选中**的那段文字及其所在段落，用于提问；同时用于在选区旁渲染浮出按钮与右侧面板。扩展不会自动读取、上传或分析页面内容，只有用户划词并触发提问时才会发送数据。若不注入所有站点，则用户在任意网站都无法使用划词功能，这是本扩展的唯一功能。 |
| 可选站点权限（按需申请） | 仅向用户自己在设置页填写的那个接口域名申请联网权限（如 `https://api.deepseek.com/*`）。扩展不申请全站联网权限，也不访问用户填写的域名之外的任何地址。 |
| `https://api.notion.com/*`（可选，按需申请） | 用户可选的「导出到 Notion」功能：把问答写入**用户自己的** Notion 工作区，用的是用户自己创建的集成令牌。该权限**只在用户点击设置页「连接 Notion 并测试」时申请**；没有配置 Notion 的用户永远不会遇到这个请求，扩展也不会向 Notion 发起任何请求。 |

如审核问到「为什么不用 `activeTab`」：本扩展需要在**用户划词的那一刻**立即读取选区，
而 `activeTab` 只在点击扩展图标/右键菜单后才授予访问权，双击选词与快捷键路径都拿不到，
因此必须在 `content_scripts` 里声明匹配范围。

## 三、单一用途说明（Single purpose）

```
本扩展只有一个用途：让用户在阅读网页时，把选中的文字交给用户自己配置的大语言模型，
并把回答展示在页面右侧。所有功能（解释、翻译、举例、深入、总结、追问、记录，
以及把结果导出到用户自己的笔记库）都是这一个用途的组成部分。
```

## 四、数据使用声明（Chrome「Data usage」表单 / Edge「Certify your data usage practices」）

Chrome 会先问「你的扩展是否会收集或使用用户数据」，**必须选「是」**——因为选中的网页内容
会发给用户配置的第三方模型服务商。如实填写反而最容易过审，隐瞒会在抽查时被下架。

| 表单问题 | 怎么填 |
|---|---|
| Does your extension collect or use user data? | **Yes** |
| 收集哪些类别？ | 勾选 **Website content**（用户选中的文字与所在段落）。其余（PII、健康、金融、身份认证信息、个人通讯、位置、网页历史、用户活动）**一律不勾** |
| 数据用途 | 勾选 **App functionality**（提供扩展的核心功能，即把选中的文字交给用户配置的模型以生成回答）。**不勾** Advertising、Analytics、Personalization、Creditworthiness 等 |
| 是否出售数据给第三方？ | **No** |
| 是否将数据用于与扩展单一用途无关的目的？ | **No** |
| 是否将数据用于判定信用度或借贷？ | **No** |
| 数据传输是否加密？ | **Yes**（仅 HTTPS；若用户填 `http://localhost` 的本地模型则不出本机） |
| 隐私政策 URL | 见上文（必填） |
| 远程代码 | **不使用远程代码**（所有代码在安装包内，无 CDN、无 eval） |

**关于「导出到笔记平台」这条数据流向**（审核可能追问，主动写进备注更省事）：

- 该功能**默认关闭且需用户自行配置**（填 Notion 集成令牌 + 父页面）；
- 只在用户点击「导出」时触发，无后台自动同步；
- 数据直接写入**用户自己的** Notion 工作区，走 Notion 官方 API，**不经过开发者服务器**（本扩展无服务端）；
- Obsidian 路径通过 `obsidian://` 交给本机应用，内容不出本机；
- 开发者无法访问这些数据。

## 五、审核测试说明（Chrome「Notes for certification」/ Edge「Notes for certification」）

**这是本扩展最容易被卡的一环**：审核员打开扩展后发现「没配 API Key，划词没反应」，
容易判为「功能不可用」。务必在测试备注里写清楚，并二选一提供凭据：

```
本扩展是 BYO-key（自带密钥）工具，不含任何服务端，也不提供模型额度——这是产品设计，
不是故障。测试方式如下：

方案 A（推荐，最稳）：在扩展设置页填入测试 Key
  1. 点扩展图标 → 设置
  2. 服务商选「DeepSeek」，已预填接口地址 https://api.deepseek.com/v1
  3. 模型名 deepseek-chat，API Key 填：<在此填入一个临时低额度 Key>
  4. 点「保存并测试连接」，应显示「✓ 连接正常」并返回「正常」两个字
  5. 打开任意 https 文章页，选中一段文字 → 选区旁浮出按钮 → 点「解释」→ 右侧面板流式输出
该 Key 为临时生成的低额度专用 Key，审核结束后会吊销。

无 Key 时也能验证的部分（界面与交互全部可用，只是模型返回会报「还没有配置模型」）：
  · 划词后浮出动作气泡、双击选词、面板展开与拖宽、设置页保存、历史记录与导出
  · 右键菜单与快捷键 Alt+Shift+E

注意事项：
  · 需在扩展详情页开启「允许访问文件网址」才能在本机 HTML 文件上使用（非必须）
  · 界面语言默认跟随浏览器语言（设置页可切中/英），与是否配置 Key 无关；
    英文环境下的扩展名称、描述、右键菜单都是英文版
  · 浏览器内置 PDF 阅读器与 chrome:// 页面不支持（浏览器不允许扩展注入），非本扩展缺陷
  · 无任何登录、无账号体系，不需要测试账号
```

> 换 Key 的替代做法：如果不想交出任何 Key，可改为在备注里说明「请在设置中填入任意
> OpenAI 兼容 Key 后测试」，并同时附上一段功能演示视频链接。经验上审核通过率会明显下降，
> 更常见的结果是「功能无法验证」被拒。**建议用临时低额度 Key，审核通过后立即吊销。**

## 六、图片素材

| 素材 | 尺寸 | 数量 | 生成方式 |
|---|---|---|---|
| 商店图标 | 128×128 PNG | 1（必填） | 已有：`icons/icon128.png`（可直接复用） |
| Edge 商店 Logo | 300×300 PNG | 1（Edge 必填） | `python tools/make_icons.py --store` → `store/logo-300.png` |
| 截图（中文） | 1280×800（或 640×400） | 1~5（至少 1） | `node tools/make_screenshots.mjs` → `store/screenshot-*.png` |
| 截图（英文） | 1280×800 | 建议与中文同数量 | `node tools/make_screenshots.mjs --lang=en` → `store/screenshot-*.en.png`（**English listing 专用**，别拿中文截图配英文页面） |
| 小促销图 | 440×280 PNG | 选填 | 未生成；用 128 图标居中放在浅色背景上即可（Chrome 后台标注为 optional） |
| YouTube 演示视频 | URL | 选填 | — |

截图建议顺序（也是脚本生成的顺序）：

1. `screenshot-1-selection(.en).png` —— 划词后选区旁浮出动作按钮，展示「不遮挡正文」
2. `screenshot-2-panel(.en).png` —— 右侧面板的分层回答：结论层 + 「展开细节」

> 截图是**真实渲染**出来的：`--lang=en` 让 chrome.i18n 桩返回英文，content.js 自己把界面切成英文。
> 所以英文 listing 的素材和界面是同源的，语言不会对不上。

## 七、版本更新说明（Release notes）

每个版本提交时填，用户会在更新后看到。示例（1.5.0）：

```
新增：界面中英双语，自动跟随浏览器语言（也可在设置页手动指定）；扩展名称与描述随系统语言显示；
回答语言与界面语言保持一致。
```

上一个版本的示例（1.3.0）：

```
新增：上下文预算可在设置页调节（适配不同模型的窗口大小）；历史被压缩时面板会明确提示；
新增「回看原文」，一键跳回页面上划词的位置。
```
