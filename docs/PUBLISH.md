# 发布手册：上架 Chrome Web Store 与 Edge 加载项

两个商店收的是**同一个 zip**（`node tools/package.mjs` 产出），差别只在后台填表。
全程约 1~2 小时操作 + 数天审核。

```
准备账号 ──► 打包体检 ──► 各自后台上传 + 填表 ──► 提交审核 ──► 上线
   │             │              │
 $5 / 免费   tools/package.mjs   文案与答案都在 docs/store-listing.md
```

---

## 第 0 步 · 一次性准备（各做一次，以后不用再做）

### Chrome Web Store

1. 用你的 Google 账号登录 [开发者后台](https://chrome.google.com/webstore/dev/dashboard)
2. Google 账号**必须先开启两步验证**，否则无法注册开发者
3. 支付 **一次性 $5** 注册费（需 Visa/MasterCard 等外币信用卡）。
   注意三个细节：
   - **终身只付这一次**，无年费，且整个账号下以后发布的所有扩展共用，不再按个收费
   - 注册邮箱**以后不能改** —— 建议专门注册一个用于发布的 Google 账号，
     别绑个人常用邮箱（商店展示名、审核通知都走它）
   - 注册时会要求做 **EEA 交易者身份声明**（欧盟 DSA 要求）：
     个人免费项目选「**非交易者**」，不公开个人信息；
     一旦商业化收费（订阅/买断）就构成「交易者」，商店会**公开展示你的联系地址和电话**。
     先按非交易者发布，以后要收费时再回后台变更
4. 新注册账号默认只有 **2 个扩展的发布配额**（2026-08-20 新政，防低质泛滥）。
   后台显示「限额 2 个」属正常；发布质量稳定后可在后台申请提额，多数即时生效
5. 补齐开发者资料（展示名、邮箱），邮箱要能收审核通知

### Edge 加载项

1. 用 Microsoft 账号登录 [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge)
2. 注册 Microsoft Edge 计划（**免费**），选「个人」账户类型即可，等验证邮件（通常 1~2 天）
3. 首次登录需补开发者信息（展示名、支持邮箱）

### 素材（两个商店共用）

```bash
node tools/package.mjs          # 产出 dist/ai-reader-<版本>.zip + 发布体检
python tools/make_icons.py --store      # 产出 store/logo-300.png（Edge 必填）
node tools/make_screenshots.mjs         # 产出 store/screenshot-*.png（1280×800）
                                        # + store/tile-440.png（440×280 小宣传图）
```

素材对照表（尺寸都是硬要求）：

| 素材 | 尺寸 | 必需性 | Chrome / Edge |
|---|---|---|---|
| 商店图标 | 128×128 | 必需 | 两者共用 `icons/icon128.png` |
| 截图 | 1280×800 | 必需（1~5 张） | 两者共用 `store/screenshot-*.png` |
| 小宣传图 tile | 440×280 | 强烈建议（缺了排名靠后） | Chrome 必传位；`store/tile-440.png` |
| 商店 Logo | 300×300 | Edge 必填 | `store/logo-300.png` |

包里的语言目录（`_locales/en`、`_locales/zh_CN`）不用手工准备，`node tools/package.mjs` 会自动装进 zip，
并且体检会**解析 `__MSG_` 后**再量名称/描述长度、逐语言检查有没有漏译 ——
商店里显示成 `__MSG_appName__` 这种事故，在本地就会被打回。

需要手工准备的只剩：一个能公开访问的隐私政策 URL —— 本仓库的
`PRIVACY.md` 已经够用：`https://github.com/crossSulation/ai-reader/blob/main/PRIVACY.md`。
（推到 main 后确认该链接能匿名打开即可。）

---

## 第 1 步 · Chrome Web Store 提交

后台入口：<https://chrome.google.com/webstore/dev/dashboard>

1. **Upload**：点「New item」→ 上传 `dist/ai-reader-<版本>.zip`（体检脚本产出的那个）
2. **Store listing**：
   - 名称 / 短描述自动取自 manifest，无需重填；详细描述粘贴 `docs/store-listing.md` 的「详细描述（中文）」
   - 上传 `icons/icon128.png` + `store/screenshot-1-selection.png`、`screenshot-2-panel.png`，
     再传小宣传图 `store/tile-440.png`
   - 分类 **Productivity**，语言 简体中文
   - **多语言**：包里的 `_locales/en` + `_locales/zh_CN` 只让**扩展本身**（管理页、右键菜单、
     商店页自动读取的名称与短描述）按浏览器语言显示；**商店页面**的详细描述要另加一门语言：
     在后台 Store listing 里「Add language」选 English，粘贴 `docs/store-listing.md` 的
     English 版详细描述。中英各占一门语言，两边的名称/短描述会自动取该语言的 `__MSG_` 值
3. **Privacy**：
   - 隐私政策 URL：仓库里 PRIVACY.md 的链接
   - 「Data usage」表单逐项照抄 `docs/store-listing.md` 第四节的答案（收集 Website content、
     用途仅 App functionality、不出售、加密传输）
   - 权限说明：照抄同文档第二节的权限用途表
   - Single purpose：照抄同文档第三节
   - 数据用途认证勾选完成后**不要急着提交**，先核对第四节表格里的每一项
4. **Distribution**：选 Public（公开）；发布范围默认全部国家即可
5. **Submit for review**

**首次审核一般 3~7 天**（官方口径：多数 24 小时内出结果、90% 三天内，但首次提交和
权限较多的扩展会偏慢；权限说明写得清楚会明显加速）。上传 zip 时后台会先自动跑一遍
**安装测试**，装不上会在提交前就报错，等于多了一道免费预检。

> 2026-08-01 起商店政策收紧了两条与本扩展相关的红线：①收集的数据必须只用于
> 声明的单一用途；②禁止绕过 AI 服务的安全防护与使用限制。本项目如实申报 +
> 只调用户自己配置的官方接口，天然合规，但后续加功能时别碰这两条。

## 第 2 步 · Edge 加载项提交

后台入口：Partner Center → Edge 卡片 → **Create new extension**

1. **Packages**：上传同一个 zip，等自动校验通过
2. **Availability**：Public；市场全选即可（默认 241 个）
3. **Properties**：
   - 分类 **Productivity**
   - Privacy policy URL：同上
   - Website / 支持邮箱：仓库地址
4. **Store listing**：
   - 语言 zh-CN：详细描述粘贴中文版；**Store logo 必须上传 300×300**（`store/logo-300.png`，
     这是 Edge 与 Chrome 不同的硬性要求）
   - 截图上传 `store/screenshot-*.png`
   - 加一门 English：详细描述粘贴 English 版（边缘商店的列表页也支持多语言，同 Chrome）
5. **Notes for certification**：粘贴 `docs/store-listing.md` 第五节全文（含测试 Key 方案）
6. **Submit**

**审核最长 7 个工作日**，通常比 Chrome 快；同一份包可以两边同时提。

---

## 审核要点（本扩展特别需要注意的）

1. **BYO-key 是最大的卡点**。审核员没 Key 时会判「功能不可用」。对策：
   - 测试备注里必须写清「这是产品设计」，并给出无 Key 时也能验证的界面路径；
   - **强烈建议**给一个临时低额度 Key（Chrome 的认证备注框支持），审核通过后立刻吊销。
   空着手硬过，大概率被拒一次。
2. **内容脚本注入所有站点**会被追问。答案已备好（store-listing.md 第二节）：
   核心论点是「双击选词/快捷键路径拿不到 activeTab 授权，必须在 content_scripts 声明」。
3. **不要隐瞒数据传输**。选中的文字确实会发给第三方（用户自己配的模型商），Data usage
   必须如实勾「Website content」+「App functionality」。抽查发现隐瞒的下架且封号。
   1.6.0 起多了一条可选数据流向：「页面上下文」开启后会把当前页面正文一并发送。
   **它是出厂关闭的可选项**，答复口径照 `docs/store-listing.md` 第四节最后一段写，
   重点说清「默认关闭、仅提问时读取、不预采集、可随时关回」。
4. 文案里**不要出现**「ChatGPT」「官方」等品牌词或夸张措辞（"最好""第一"）；
   描述里我们只提「任意 OpenAI 兼容接口」，安全。
5. 包里不能有远程代码、`unsafe-eval` CSP、混淆代码 —— `tools/package.mjs` 的体检已替你挡住。

## 被拒了怎么办

| 拒绝理由 | 处理 |
|---|---|
| 功能无法验证 | 补测试 Key 到认证备注，重新提交 |
| 权限说明不充分 | 把第二节表格逐条贴进权限说明，再提交 |
| 隐私政策不完整 | 确认 PRIVACY.md 里有数据类别、用途、存储、用户权利、联系方式五要素（已含） |
| 单一用途不明确 | 用第三节那段原文 |

改完直接重新上传新包提交即可，**不用重新排队**，第二次审核通常更快。

## 上线之后

- **发新版本**：改代码 → 同步改 `manifest.json` 与 `package.json` 的版本号 →
  `node tools/package.mjs` → 两个后台上传新 zip → 填 Release notes（见 store-listing.md 第七节）
  → 重新过审（比首审快，Chrome 通常 1~3 天，Edge 数小时~2 天）
- **紧急止血**：后台点「Unpublish」立刻下架，修复后再发新版本
- **灰度/内测**：Chrome 在 Distribution 里选 Unlisted（仅链接可见）；Edge 选 Hidden。
  可以先 Unlisted 发给朋友试一周再转 Public
- **定时发布**：过审后可以不立刻上线，最迟延后 30 天自动发布，方便配合发布公告
- **看数据**：Chrome 后台有安装量/评分/崩溃；Edge 在 Partner Center 的 Insights

## 商店外的分发（备选）

- Chrome 拒绝安装商店外的 crx（Windows/Mac 强制走商店）；让用户走「开发者模式加载」即可
- Edge 同理。所以仓库 README 的「开发者模式加载」说明保留即可，它就是商店外的正规安装途径
