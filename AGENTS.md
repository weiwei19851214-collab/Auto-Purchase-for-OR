# AGENTS.md - Auto-Purchase-for-OR 工作规则

本项目是一个传统 coding 项目：本地 Web 控制台 + Node.js 执行器，用于
OpenRouter 充值批量 dry-run、no-purchase 测试、live run、OPOM 对接、
AdsPower 匹配、EJH 安全卡 CSV 分配、结果 CSV 生成和本地验证。

本仓库代码是运行时事实来源。`openrouter-recharge` skill 只可作为历史迁移
参考或流程背景，不是本项目的执行入口；生产/本地运行不得在运行时 import、
调用或依赖 `~/.codex/skills/openrouter-recharge` 下的脚本。

遇到任务时，按普通软件项目方式处理：阅读代码和文档、修改仓库内实现、
运行相关测试、汇报变更和验证结果。

## 1. 权威资料顺序

优先级从高到低：

1. 当前用户指令和更近目录的 `AGENTS.md`。
2. 本文件。
3. `README.md`。
4. `docs/recharge-production-runbook.md`。
5. `docs/openrouter-recharge-runner-prd.md`。
6. `package.json`、测试、源码和现有实现风格。

当文档和代码冲突时，先确认现有代码的真实行为，再用最小改动修正代码或文档
漂移。不要把旧 skill 规则当成覆盖本仓库代码的权威。

## 2. 项目边界

本项目负责：

- 本地操作台：`public/`。
- Node.js API / worker / SQLite 状态：`src/server/`。
- OpenRouter / AdsPower / CDP 自动化引擎：`src/automation/`。
- 本地验证、审计、smoke、preflight 脚本：`scripts/`。
- 输入模板、结果 CSV 合同、OPOM / EJH / AdsPower 对接逻辑和文档。

本项目不负责：

- 创建 OpenRouter 账号。
- 创建 OpenRouter API key / AK 写回。
- 退款、申诉、发票截图归档。
- 银行流水导入、银行对账实现和客户确认导出；这些由 OPOM 项目负责。
- 将本地执行器改造成多用户 SaaS，除非用户明确要求。

如果用户提出上述相邻任务，先说明边界，再在合适的项目或 workflow 中处理。

## 3. 代码结构和运行方式

- `src/automation/` 是浏览器自动化和充值闭环核心。
- `src/automation/lib/` 放 CSV、计划、状态、余额校验、AdsPower 等共享逻辑。
- `src/server/` 是本地 API、worker、OPOM/EJH/AdsPower 适配、本地存储和安全层。
- `public/` 是本地操作台前端。
- `scripts/` 是验证、审计、preflight、smoke 和交付检查。
- `data/uploads/`、`data/results/`、`data/logs/` 是运行时目录，只提交 `.gitkeep`
  或明确安全的示例文件。

常用命令：

```bash
npm run check
npm test
npm start
npm run smoke:local -- --base http://127.0.0.1:4100
npm run smoke:ui -- --base http://127.0.0.1:4100
npm run preflight:production
npm run audit:sensitive
npm run audit:readiness
npm run checklist:launch
```

涉及完整 Recharge x OPOM 集成时，优先运行：

```bash
npm run verify:integration -- --base http://127.0.0.1:4100
```

如果本地 server 未运行，可在本项目内启动：

```bash
PORT=4100 npm start
```

不要为了本项目验证擅自启动、重启或修改 OPOM 本地/生产服务。

## 4. 开发原则

- 默认按普通 coding 任务自主推进，保持改动范围收敛。
- 修改前先阅读相关源码、测试、README 和 runbook。
- 复用现有 Node.js ESM 风格、模块边界、状态枚举、CSV 工具和测试方式。
- 不引入新框架或新依赖，除非用户明确同意且项目确实需要。
- 不把临时脚本、CVV、认证凭据、运行日志或敏感输出提交进项目。卡号本身
  可按线下对账需要明文显示和记录，但不要提交无关运行产物。
- 不回滚用户或其他 agent 的改动；遇到冲突时先读 diff 再决定如何兼容。
- 对行为变更，同步更新测试和文档；对文档修正，确保不违背现有代码。
- 不把大模型放入正式执行链路。Codex 可以维护、诊断和测试代码，但 live
  run 应由项目内确定性 Node.js worker 执行。

## 5. CSV 和数据合同

默认使用项目内模板和 README 定义的字段：

- `openrouter-recharge-input-template.csv`：OpenRouter 充值输入模板。
- `reconciliation-card-import-template.csv`：OPOM 对账卡导入模板。

支持两类输入：

- 传统 CSV 字段：`ID`、`username`、`card_number`、`amount` 等。
- OPOM canonical 字段：`opom_account_id`、`login_email`、
  `ads_power_user_id`、`ads_power_serial_number`、`order_no`、`card_no` 等。

用户提供 CSV 附件或路径时，只处理该明确路径。不要静默读取旧
`account.csv`、历史绝对路径或其他固定本机文件。

结果 CSV 必须保持安全交付合同：

- 不包含 CVV、cookie、session、密码、API key、AK、OpenRouter key、
  raw browser storage 或 EJH 原始诊断 payload。
- 卡号用于短期充值和线下对账时，可以在 UI、日志和结果 CSV 中明文显示；
  不要把卡号误归类为必须脱敏的凭据。
- 账号、邮箱等身份信息按现有 redaction 规则输出；卡号脱敏与否以当前业务
  对账合同和字段定义为准。
- 公式风险单元格按现有 CSV 转义规则处理。
- 旧源表 `completed` 只能作为跳过依据，不能当成本次运行完成证据。

## 6. 执行和状态合同

充值执行必须遵守项目内状态合同，主要结果状态包括：

- `completed`
- `missing_fields`
- `login_required`
- `identity_mismatch`
- `payment_issue_card_declined`
- `manual_security_blocker`
- `purchase_unverified`
- `failed`

不要使用自由文本替代状态枚举。不要因为旧交易、旧 invoice、余额页、
AdsPower 标签、Feishu 手工状态或 OPOM 计划状态就推断本次闭环完成。

每个真实完成行需要尽量保留并输出可审计证据：账号匹配、AdsPower 匹配、
OpenRouter 身份匹配、卡绑定/替换、billing address、余额增长、Auto top-up
回读、OPOM 写回状态、AdsPower 状态处理或明确 waived、result CSV。

## 7. 安全与授权门

以下操作必须先得到用户在当前任务中的明确授权：

- `git push`。
- OPOM 生产部署。
- 修改 OPOM 生产 `.env`。
- 运行 OPOM 生产 `db:push`。
- 任何 OPOM 生产写 API，read-only queue check 除外。
- 真实 EJH 创建卡。
- OpenRouter live purchase submission。
- AdsPower 状态写回：`group_move`、`remark_append`、`remark_append_v2`
  或未来 native tag 写接口。
- 删除核心配置、大量文件或不可恢复运行数据。
- 安装、升级或替换会显著改变项目依赖的包。

允许在无额外确认下执行的安全动作：

- 阅读源码、文档、模板和本地非敏感运行状态。
- 运行 `npm run check`、`npm test`、read-only smoke/preflight/audit。
- 对明确用户提供的 CSV 路径做 dry-run 或静态字段检查。
- 启动本项目本地 server 进行开发验证，但不要重启用户正在使用的服务。

不得绕过 CAPTCHA、Cloudflare、hCaptcha、Stripe 3DS、银行验证、短信/电话
验证、风控、恢复流程或 passkey-only 登录。

## 8. 外部系统规则

OPOM：

- read-only queue verification 可按 runbook 执行。
- OPOM writeback 需要 `OPOM_BASE_URL`、`OPOM_RECHARGE_TOKEN` 和明确 job
  选项。
- OPOM-sourced confirmed purchase rows 不允许在缺少 OPOM writeback 时达到
  `completed`。

AdsPower：

- AdsPower Local API 匹配和 group discovery 可作为 read-only 验证。
- 状态写回默认视为 waived/disabled，除非用户明确启用具体模式和目标。
- group/name 解析必须唯一明确；失败不得影响已完成充值本身，但要写入结果
  CSV 的 AdsPower status 字段。

EJH：

- 正常交付只使用 safe card CSV 字段。
- `encryptedParam`、`requestPayload`、`rawResponse` 等原始诊断字段不得进入
  普通 handoff、文档或结果 CSV。
- 真实创建卡必须有当前任务授权。

OpenRouter：

- no-purchase mode 可以准备 Purchase Credits 表单，但不得提交付款。
- live purchase submission 必须有当前任务授权和有效 dry-run 证据。
- `manual_security_blocker` 必须停止批量并保留现场供人工处理。

## 9. 测试与验证

按改动风险选择最小有效验证：

- 语法或共享逻辑：`npm run check`。
- 业务逻辑、CSV、worker、OPOM/AdsPower/EJH 适配：`npm test`。
- 前端 selector 或页面交互：运行对应 `npm run smoke:ui*`。
- 本地 API / result CSV：`npm run smoke:local -- --base <url>`。
- 敏感数据、文档、模板、生产脚本：`npm run audit:sensitive`。
- 生产前只读检查：`npm run preflight:production`。
- 整体发布门：`npm run verify:integration -- --base <url>`。

如果测试无法运行，最终回复必须说明原因、已做的替代验证和剩余风险。

## 10. 汇报要求

最终回复保持简洁，说明：

- 做了什么。
- 修改了哪些关键文件。
- 运行了哪些验证。
- 未完成事项或仍需用户授权的风险点。

不得在最终回复、日志或文档中输出完整 CVV、密码、Cookie、Session、Token、
TOTP seed、验证码、API key、AK 或其他认证凭据。卡号可按本项目对账需要
明文出现，不属于此处禁止输出的认证凭据。

## 11. 近期沉淀的业务规则和排障提示词

以下规则来自最近连续本地联调、上线前测试和用户反馈，后续处理本项目问题时
应优先纳入判断。

### 本地配置和启动

- 本项目面向普通本地用户使用，不要求用户通过 shell 长期维护环境变量。凡是
  AdsPower、OPOM、EJH、超时、重试、Python 命令等运行参数，优先通过本地
  Web 控制台顶部“本地配置”填写和保存。
- 本地配置保存一次后应可长期复用。只有配置确实缺失或当前浏览器存储被清空
  时才提示用户重新确认；不要因为完成任务、刷新任务状态或 worker 状态轮询
  就把配置标记为未保存。
- `OPOM_BASE_URL` 默认值为 `http://20.2.209.2:3000`。测试本地 OPOM 时允许
  用户改成本地地址；项目应按当前页面配置发送到对应 OPOM 系统。
- 根目录启动脚本应优先照顾非技术用户：发现本项目端口被占用时，按脚本约定
  清理/替换本项目旧进程后再启动，不要求用户手工查端口。
- worker 状态轮询不要过密：running 时约 3 秒一次，idle 时约 30 秒一次即可。

### OPOM 对接

- OPOM 基础地址必须配置化，不能在代码中固定只访问本地或只访问生产地址。
- 绑卡写回和充值结果写回都要携带 AdsPower 浏览器 id。字段语义使用
  `ads_power_user_id`；如果同时有浏览器编号，也同步写 `ads_power_serial_number`。
- 自动充值系统后续可能切换到 `manager-openrouter` 或 `openrouter-operator`
  的 URL。与 OPOM writeback 相关的字段、负余额、AdsPower id 入库逻辑，两边
  项目都要保持兼容。
- 成功后写回 OPOM 是用户在页面上显式选择的选项。OPOM-sourced confirmed
  purchase rows 在勾选写回时，写回失败不能被算作本次完全 `completed`；如果
  OPOM 实际写入成功但本项目判断失败，要优先检查响应格式、HTTP 状态和错误
  文本解析，而不是直接重跑充值。
- OPOM 余额允许为负数。审计和写回时要保留真实负余额，不能用非负约束或
  UI 格式化把负余额吞掉。
- 批量匹配 OPOM 账号时，优先使用批量 resolve 接口一次提交当前清单中的账号
  信息并返回匹配结果。50 条以内不应逐账号请求 OPOM，也不应扫描大表后本地
  猜测；未返回的账号显示匹配失败并保留原因。
- OPOM resolve 接口如果返回 401/Unauthorized，不得显示“匹配成功”。应明确
  标记 `opom_resolve_failed` 或等价失败状态，并提示机器 token / 本地 OPOM
  token 配置不匹配。

### AdsPower 匹配和浏览器 id

- AdsPower 浏览器匹配最终应以 8 位字母数字组合的 `ads_power_user_id` 为准，
  不再以 4 位编号作为主要身份。页面展示应同时显示 AdsPower 编号和
  AdsPowerId，例如编号后面展示 `k1dglko5`。
- 兼容旧数据：如果取不到 `ads_power_user_id`，允许回退使用
  `ads_power_serial_number` 查询；一旦查到 id，必须懒更新到本项目和 OPOM
  对应字段。编号和 id 两个字段都应尽量写入，最后匹配以 id 为准。
- AdsPower Local API 按 id 或编号精确查找时不需要分页扫描：
  `/api/v1/user/list?user_id=<ads_power_user_id>&page=1&page_size=100` 和
  `/api/v1/user/list?serial_number=<ads_power_serial_number>&page=1&page_size=100`
  属于精确全局查询。只有 id 和编号都没有时，才分页扫描。
- AdsPower 返回 “profile is being used by another user / not allowed to open”
  通常表示该浏览器当前被其他账号或会话占用，不应简单归因于网络慢。应把
  原始 AdsPower 错误写入任务消息，允许用户稍后对失败子任务手动重试。
- 任务全部完成后，failed 子任务必须支持“从本行继续/手动重试”，尤其是
  AdsPower 占用、CDP navigation timeout、临时网络失败这类可恢复错误。

### OpenRouter 页面自动化

- OpenRouter 充值页面会更新 DOM。选择器必须优先基于可见文本、模态标题、
  SVG/icon 语义、按钮位置和页面状态组合判断，避免只依赖单个 class。
- Purchase Credits 页面里“新增新卡”可能是只有加号 SVG 的按钮，没有文字。
  当前 DOM 特征包含 lucide plus 路径 `M12 4.5v15m7.5-7.5h-15`、按钮区域在
  支付卡片右侧。不要再因为找不到文字按钮误报 `Stripe payment iframe target not found`。
- 进入充值页后不要预先关闭 Auto Top-Up 规则。这个逻辑当前收益低、误判率高，
  已从主流程移除。
- 余额判断模式的默认业务逻辑：小于 145 时充值到 150，余额大于等于 145 时
  充值 10。低余额补足金额使用向上取整，例如余额 `-2.62` 要充 `153`；
  余额 `140` 要充 `10`。
- 自动充值规则金额默认 `150`。页面文案要用中文解释“固定充值”和“按余额补足”
  的区别，避免直接暴露难懂的英文输入框。
- Purchase Credits 的 Billing address 处理：如果找到 Country 栏且当前不是
  美国，不需要查找/取消复选框，直接选择美国、输入邮编并点击
  `Save payment method`。
- `/api/internal/v1/stripe` 是 OpenRouter 自己页面的辅助接口，不属于本项目
  主流程。如果该接口 404/500 导致页面显示 `Error 500 / Internal Server Error`，
  确认主流程不依赖它时应屏蔽为 ignored/non-fatal：保留低噪声诊断，
  不把它算成 `hasServerError` 或任务失败，并尽量关闭页面上的错误弹层。
- 任何 Stripe 3DS、银行验证、风控、CAPTCHA、短信/电话验证或 passkey-only
  登录都不能绕过；遇到时标记人工阻断并保留现场。

### 页面操作台体验

- 页面按钮必须有前提条件：未上传账号 CSV 时不可点击 Match AdsPower；未完成
  dry-run/预检或未确认授权时不可启动 live purchase；缺少 EJH 文件时不可分配
  卡或创建卡。
- “规则与地址”区域要简洁：固定充值只展示固定充值金额和地址相关内容；按余额
  判断只展示余额判断相关设置和地址相关内容。不要同时铺开所有字段。
- “任务来源”“规则与地址”“开卡与执行范围”三个大块高度应尽量接近，不要因为
  个别区域差一点就强制出现不必要的竖向滚动条。
- 地址绑定支持上传美国地址 CSV，字段示例包括 `LastName`、`FirstName`、
  `Street`、`City`、`State`、`Zip`、`PhoneNumber`。用户上传账号文件后，
  页面应根据待执行清单行数自动生成或分配所需地址。地址列表区域固定高度，
  超出时内部滚动。
- 本地配置的“Discover groups”表示读取 AdsPower 分组，帮助用户选择成功/失败/
  阻断分组；这不是必须步骤，只有启用 AdsPower 状态写回或需要自动填分组时才用。

### 日志和排障

- 浏览器自动化每个关键步骤都应写结构化 step 日志：当前 URL、标题、关键页面
  文本摘要、是否出现支付错误、是否出现 server error、最近网络失败、截图路径
  或明确说明未截图。
- 日志用于测试和排障，不需要长期保存，也不要提交到仓库。日志必须脱敏认证
  凭据；卡号可按对账合同保留。
- 用户截图询问页面错误时，优先查 `data/logs/<job>/<row>/step-*.json` 中的
  `recentNetworkFailures`、`ignoredNetworkFailures`、`hasPaymentIssue`、
  `hasServerError`、`ignoredServerError` 和对应截图，而不是先猜测。
- 如果任务结果是 failed，但用户确认 OPOM 或 OpenRouter 实际成功，应优先检查
  “成功后写回/验证响应判断”逻辑，包括 HTTP 状态、响应体字段、超时和重试；
  不要默认再次提交付款。
- 对 OpenRouter 页面 500、Stripe iframe、CDP navigation timeout 这类问题，
  日志必须能说明“在哪一步、哪个 URL、哪个网络请求、是否影响主流程”。如果
  不能说明，就先补日志，再改业务判断。
