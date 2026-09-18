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
3. 支付 **一次性 $5** 注册费（需境外信用卡；这是唯一的强制花费）
4. 补齐开发者资料（展示名、邮箱），邮箱要能收审核通知

### Edge 加载项

1. 用 Microsoft 账号登录 [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge)
2. 注册 Microsoft Edge 计划（**免费**），选「个人」账户类型即可，等验证邮件（通常 1~2 天）
3. 首次登录需补开发者信息（展示名、支持邮箱）

### 素材（两个商店共用）

```bash
node tools/package.mjs          # 产出 dist/ai-reader-<版本>.zip + 发布体检
python tools/make_icons.py --store      # 产出 store/logo-300.png（Edge 必填）
node tools/make_screenshots.mjs         # 产出 store/screenshot-*.png（1280×800）
```

需要手工准备的只剩：一个能公开访问的隐私政策 URL —— 本仓库的
`PRIVACY.md` 已经够用：`https://github.com/crossSulation/ai-reader/blob/main/PRIVACY.md`。
（推到 main 后确认该链接能匿名打开即可。）

---

## 第 1 步 · Chrome Web Store 提交

后台入口：<https://chrome.google.com/webstore/dev/dashboard>

1. **Upload**：点「New item」→ 上传 `dist/ai-reader-1.3.0.zip`
2. **Store listing**：
   - 名称 / 短描述自动取自 manifest，无需重填；详细描述粘贴 `docs/store-listing.md` 的「详细描述（中文）」
   - 上传 `icons/icon128.png` + `store/screenshot-1-selection.png`、`screenshot-2-panel.png`
   - 分类 **Productivity**，语言 简体中文
3. **Privacy**：
   - 隐私政策 URL：仓库里 PRIVACY.md 的链接
   - 「Data usage」表单逐项照抄 `docs/store-listing.md` 第四节的答案（收集 Website content、
     用途仅 App functionality、不出售、加密传输）
   - 权限说明：照抄同文档第二节的权限用途表
   - Single purpose：照抄同文档第三节
   - 数据用途认证勾选完成后**不要急着提交**，先核对第四节表格里的每一项
4. **Distribution**：选 Public（公开）；发布范围默认全部国家即可
5. **Submit for review**

**首次审核一般 3~7 天**（越小的扩展越快；权限说明写得清楚会明显加速）。

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
- **看数据**：Chrome 后台有安装量/评分/崩溃；Edge 在 Partner Center 的 Insights

## 商店外的分发（备选）

- Chrome 拒绝安装商店外的 crx（Windows/Mac 强制走商店）；让用户走「开发者模式加载」即可
- Edge 同理。所以仓库 README 的「开发者模式加载」说明保留即可，它就是商店外的正规安装途径
