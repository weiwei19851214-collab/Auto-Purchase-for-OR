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
