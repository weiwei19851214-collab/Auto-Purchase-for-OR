# OpenRouter 充值执行器

本项目提供一个本地 Web 控制台和确定性的 Node.js worker，用于通过
AdsPower/CDP 完成 OpenRouter 绑卡、no-purchase 测试、验证充值和 Auto top-up
配置。

本项目设计为运行在 AdsPower Local API 所在的同一台机器上。它不是 SaaS 服务，
生产执行链路中也不使用大模型。

## 功能

- 上传 CSV 或拉取 OPOM 行，并在任何浏览器自动化开始前运行自动 preflight。
- 通过机器 API 将 OPOM `recharge` 分组账号拉取成本地 canonical CSV。
- 通过 AdsPower Local API 匹配 OPOM 账号和 AdsPower 环境，无需启动浏览器。
- 使用单个 worker 顺序处理 AdsPower 环境。
- 绑定或替换 OpenRouter 支付卡。
- 在账号要求时补充 billing address。
- 配置并回读 Auto top-up。
- 在 no-purchase 测试模式下填写 Purchase Credits 金额，但不点击 `Purchase`。
- 在基于 SQLite 的本地存储中记录 job 行、事件和已脱敏的结果 CSV。
- 当启用 `opomWriteback` 时，可选择将已完成的绑卡信息和逐行执行结果写回 OPOM。
- 可选择通过显式的 `group_move`、`remark_append` 或 `remark_append_v2` 模式，在每行结束后写回 AdsPower 执行状态。
- 在 UI、日志和结果 CSV 中遮蔽敏感值。

## 安全边界

- API server 绑定到 `127.0.0.1`。
- 页面加载后，所有 API 调用都需要本地 session token。
- 执行前必须有自动 preflight 确认，且确认绑定到精确的 CSV、选项和付款提交模式。
- No-purchase 模式只填写购买表单，不提交付款。
- 在 no-purchase 和 Live Run 之间切换会使之前的 preflight 确认失效；下一次执行会重新运行 preflight。
- CVV、cookie、session、密码、API key 和 raw browser storage 不得提交，也不得出现在日志或结果中。
- `data/` 下的运行时文件默认忽略，只保留 `.gitkeep` 占位文件。
- OPOM writeback 需要 `OPOM_BASE_URL` 和 `OPOM_RECHARGE_TOKEN`。
- AdsPower 状态写回默认关闭，因为用户已 waived 这个授权门；结果 CSV 仍会记录 waived 状态。之后只有在明确配置 mode/group 后才启用写回。

## 快速开始

```bash
npm run check
npm test
npm start
```

然后打开：

```text
http://127.0.0.1:4100
```

## CSV 模板

使用 [openrouter-recharge-input-template.csv](./openrouter-recharge-input-template.csv)
作为输入格式。只在运行时替换占位值；不要提交真实卡号、CVV 或账号凭据。

必填列：

```csv
status,ID,username,amount,card_number,exp_month,exp_year,cvv,postal_code
```

可选 billing 列：

```csv
holder_name,country,address_line1,city,state
```

可选余额规则列：

```csv
balance_threshold,amount_below_threshold,amount_at_or_above_threshold
```

可执行行所需的 Auto top-up 列：

```csv
auto_topup_threshold,auto_topup_amount
```

OPOM 驱动的 canonical 行可以使用较新的字段名：

```csv
opom_account_id,login_email,ads_power_user_id,ads_power_serial_number,opom_health_status,opom_health_reason,order_no,card_no,amount
```

旧版 `ID,username,card_number` 列仍继续支持现有 CSV workflow。如果存在
`opom_health_status` 且其值不是 `ok`，dry-run 会在 AdsPower 或 OpenRouter
自动化开始前阻断该行。

## OPOM 集成

设置：

```bash
export OPOM_BASE_URL="https://opom.example.internal"
export OPOM_RECHARGE_TOKEN="..."
```

本地控制台的 `Load OPOM group` 按钮会调用 OPOM
`/api/v1/recharge/accounts`，使用 `group=recharge`，将响应转换为 canonical
CSV，并复用现有的自动 preflight/live 确认流程。Live job 只有在 job options
包含 `opomWriteback` 时才写 OPOM；普通 CSV job 仍只在本地执行。

对于带有 `opom_account_id` 的行，confirmed purchase 模式要求
`opomWriteback=true`，preflight 才会把该行标记为 ready。No-purchase 模式仍可用于本地验证，但真实 OPOM 来源的充值在没有 OPOM card/result writeback
时不允许达到 `completed`。OPOM 绑卡写回需要 EJH `order_no`、卡号和卡有效期
（`exp_month`/`exp_year` 或等价分配输出）；缺少这些字段的行会在发送任何 OPOM
写请求前失败。

OPOM queue 会把 Credits 401 阻断的账号排除在可执行的 `needs_recharge` 和
`failed_retryable` 队列之外。`status=all` 仍可以展示这些账号，并带上
`opom_health_status` 和 `opom_health_reason` 供操作员查看。如果 OPOM 返回
`nextCursor`，使用 `Load next page` 追加下一页队列；操作台会在 AdsPower 匹配和
卡分配后，继续把 `opom_health_status` 和 `opom_health_reason` 保留在重新生成的
canonical CSV 中。

点击 `Load OPOM group` 之前，操作员可以输入本次运行的充值默认值：

- 固定 `amount`，或余额规则组合
  `balance_threshold,amount_below_threshold,amount_at_or_above_threshold`
- `auto_topup_threshold` 和 `auto_topup_amount`
- 默认 billing address 字段

可以粘贴 CSV 形式的逐账号 billing address 覆盖值：

```csv
opom_account_id,login_email,holder_name,country,postal_code,address_line1,city,state
acct_1,user@example.com,Example User,US,97001,1 Main St,Portland,OR
```

行会优先按 `opom_account_id` 匹配，其次按 `login_email` 匹配。映射值会在
preflight 校验前覆盖默认 billing address。

## EJH 创建卡

`ejh_create_cards.py` 保留原有交互模式，同时支持非交互式安全 CSV 输出：

```bash
EJH_APP_KEY="..." EJH_APP_SECRET="..." \
python3 ejh_create_cards.py --non-interactive \
  --count 10 --amount 20 --active-date 2026-12-31 \
  --cardholder recharge-20260607 --output data/results/ejh_cards.csv
```

默认输出使用安全卡批次 schema，并省略加密请求 payload、原始 provider 响应等旧版 raw 字段。仅在本地诊断时使用 `--unsafe-raw-output`。

本地控制台也可以从粘贴的安全 EJH CSV 分配卡。分配步骤会把已完成的卡行一对一映射到 OPOM canonical 行，然后重新生成可执行充值 CSV。从控制台真实创建 EJH
卡需要明确的浏览器确认，并且仍会先写安全 CSV。

## AdsPower 状态写回

AdsPower 状态写回通过 job options 或环境变量选择性启用：

```bash
export ADSPOWER_STATUS_MODE="group_move"
export ADSPOWER_SUCCESS_GROUP_ID="..."
export ADSPOWER_FAILURE_GROUP_ID="..."
export ADSPOWER_BLOCKER_GROUP_ID="..."
# Or resolve by exact AdsPower group name:
export ADSPOWER_SUCCESS_GROUP_NAME="Recharge Success"
export ADSPOWER_FAILURE_GROUP_NAME="Recharge Failed"
export ADSPOWER_BLOCKER_GROUP_NAME="Recharge Blocked"
```

选择 group target 前，先在本地 runner 机器列出当前 AdsPower groups，或在操作台点击
`Discover groups`：

```bash
npm run adspower:status-targets -- --json
```

这是只读发现命令。它调用 AdsPower `/api/v1/group/list`，展示已配置的 target
解析结果和候选 groups，并在能推断匹配时打印建议的 `ADSPOWER_*_GROUP_ID`
export。它不会调用 regroup、profile update、remark update、OPOM writeback、EJH
创建卡或 OpenRouter 自动化。控制台的 `Discover groups` 按钮使用同一个 server
模块和当前 target 字段，然后在本地渲染已解析 target 和候选项供操作员查看。
`Use discovered targets` 只会用 `id:<group_id>` 值填充本地 `group_move` target
输入框；它不会写 AdsPower 状态。

支持的模式：

- `disabled`：用户 waived AdsPower 状态写回后的默认值；结果 CSV 记录
  `adspower_tag_status=skipped_user_waived`、
  `adspower_status_target=waived_by_user`。
- `group_move`：行完成后调用 AdsPower Local API `/api/v1/user/regroup`，使用
  success/failure/blocker group targets。Targets 可以是原始 group id、
  `id:<group_id>`、`name:<exact group name>`，或
  `ADSPOWER_*_GROUP_NAME` 环境变量。名称解析使用 `/api/v1/group/list`，且只有在唯一精确匹配时才继续。
- `remark_append`：通过 AdsPower Local API `/api/v1/user/update` 向 profile
  remark 追加已清洗的短执行状态。
- `remark_append_v2`：通过 AdsPower Local API
  `/api/v2/browser-profile/update` 追加同样已清洗的执行状态。

截至 2026-06-07 的实现轮次，官方 Local API 文档列出了带 `remark` 字段的
profile update `/api/v1/user/update`、带 `remark` 字段的 V2 profile update
`/api/v2/browser-profile/update`，并通过 `/api/v1/user/regroup` 记录 profile
group movement，但没有暴露已确认的专用 tag-write endpoint。当前参考：

- [Update Profile Info](https://localapi-doc-en.adspower.com/docs/GMvym2)
- [Update Profile Info V2](https://localapi-doc-en.adspower.com/docs/Update-Profile-Info-V2)
- [Move Profile](https://localapi-doc-en.adspower.com/docs/bEfrZV)
- [Query Profile](https://localapi-doc-en.adspower.com/docs/u8m2Ie)

请把两个 remark 模式都视为运营状态标记，而不是 AdsPower 原生 tags。CSV 列名为了兼容原始 PRD 仍叫 `adspower_tag_status`，但它的值描述的是已配置的状态写回模式。

AdsPower 状态写回失败不会把充值行标为失败；行结果保留充值 outcome，并记录
`adspower_tag_status=failed` 以便人工跟进。结果 CSV 还包含
`adspower_status_mode`、`adspower_status_target` 和 `adspower_status_reason`，
因此操作员可以区分 waived、skipped、regrouped、remark-updated 和 failed
status writes。示例 target 包括 `waived_by_user`、
`group:success:<group_id>`、`group:failure:<group_id>`、
`group:blocker:<group_id>`、`remark:v1` 和 `remark:v2`。

## 结果 CSV / Feishu 交接

每个 job 都会在 `data/results/` 下写入已清洗的结果 CSV。这是直接 API 集成前给
Feishu 的临时交接物。表头保持唯一，因此电子表格工具和 Feishu 导入不需要处理重复列名。

稳定交接列包括：

```csv
run_id,row_number,opom_account_id,profile_id,ads_power_user_id,ads_power_serial_number,username,login_email,opom_health_status,opom_health_reason,ejh_order_no,cardno,task_status,task_message,purchase_status,purchase_amount,balance_before,balance_after,card_last4,auto_topup_status,auto_topup_threshold,auto_topup_amount,opom_card_writeback_status,opom_result_writeback_status,adspower_tag_status,adspower_status_mode,adspower_status_target,adspower_status_reason,completion_evidence_status,completion_evidence_missing
```

结果 CSV 可以在 `cardno` 中包含短期使用的完整卡号，用于线下对账。它不得包含
CVV、cookie、session、OpenRouter key 或原始 EJH 诊断 payload。以 `=`、`+`、
`-` 或 `@` 开头的公式风险单元格会在 CSV 导出前加上 `'` 前缀，防止电子表格导入时把操作员可控文本作为公式执行。

使用 `completion_evidence_status` 进行 Feishu/人工复核：
`production_complete` 表示该行具有已验证的 purchase 证据、Auto top-up 回读证据
（`updated` 或 `unchanged`）、AdsPower 状态写回证据或明确的
`skipped_user_waived` 证据，并且 OPOM 来源行还具有 OPOM card/result writeback
证据；`test_mode_complete` 表示仅完成 no-purchase rehearsal；`incomplete` 会在
`completion_evidence_missing` 中列出缺失的证据 key。因为源 CSV 已标记 completed
而跳过的行会导出为 `task_status=skipped`，而不是 `completed`，这样旧 tracker
状态不会被误读为本次新充值运行的证明。

本地验证 Feishu 交接合同：

```bash
npm run smoke:feishu
```

smoke 测试会生成一个包含公式风险源值的临时结果 CSV，然后验证唯一表头、稳定交接列、账号数据、完整 `cardno` 输出、completion evidence，以及不存在 CVV 或 raw
diagnostic 列。

扫描面向用户的文档/模板和生产脚本，检查是否意外出现卡号、CVV、token、
OpenRouter key 或 raw EJH diagnostic 字面值：

```bash
npm run audit:sensitive
```

audit 允许本地 smoke 测试和单元测试中出现显式 fake fixtures，但如果这些值出现在文档、模板、public UI assets 或生产代码路径中则会失败。

## 生产 Preflight

生产部署或 live validation 前，运行本地只读 preflight：

```bash
npm run preflight:production
```

它会检查所需本地文件、AdsPower Local API 可达性、OPOM/EJH 环境变量是否存在、当前缺少已记录的 AdsPower 原生 tag-write endpoint、用户 waived AdsPower 状态写回状态，以及 live-payment 安全边界。它不会调用 OPOM 写 API，不会创建 EJH 卡，也不会启动 OpenRouter 浏览器自动化。当 `ADSPOWER_STATUS_MODE=group_move` 时，preflight
还会读取一次 AdsPower `/api/v1/group/list`，并在 live work 前解析任何
`name:<exact group name>` 或 `ADSPOWER_*_GROUP_NAME` targets。原始
`id:<group_id>` targets 会被视为操作员明确提供的 ID。

如需同时验证 OPOM machine token 和 queue endpoint，需要显式选择 read check：

```bash
npm run preflight:production -- --with-opom-read --marker-file ./var/production-preflight-marker.json
```

该调用会读取 `GET /api/v1/recharge/accounts?group=recharge&status=needs_recharge&limit=1`。
它可能创建普通 OPOM read audit log，但不会写绑卡、运行结果或充值事实。生产环境通过后，保留生成的 marker file，并传给 `audit:completion`：

```bash
npm run audit:completion -- --preflight-marker ./var/production-preflight-marker.json
```

marker file 记录只读验证时间戳、OPOM base URL、group 和已清洗的检查摘要。它不存储 OPOM token、卡号、CVV、cookie 或 raw EJH diagnostic payload。对于临时 shell-only 验证，也支持旧版环境 marker 路径：

```bash
export OPOM_PRODUCTION_RECHARGE_API_VERIFIED=true
export OPOM_PRODUCTION_PREFLIGHT_PASSED_AT="<timestamp from preflight output>"
```

如需在 live work 前验证候选执行 CSV，传入 `--csv`：

```bash
npm run preflight:production -- --csv /path/to/recharge-candidate.csv
```

CSV gate 仍然只读。它会通过 runner 使用的同一套 dry-run 合同解析文件；如果没有 ready 行，或存在任何 `missing_fields` 行，就会失败；同时会拒绝
`encryptedParam`、`requestPayload`、`rawResponse` 等 EJH raw diagnostic
列。preflight 输出只展示行数和被阻断的行号，不打印卡号、CVV 或 raw payload 值。

不带生产集成的本地开发可运行：

```bash
npm run preflight:production -- --no-opom --no-ejh --no-ads
```

在不写任何生产系统的情况下审计端到端目标合同：

```bash
npm run audit:readiness
```

该命令把请求的 0-9 流程映射到本地证据：OPOM queue intake、操作员确认、
AdsPower 匹配、充值规则和 billing mapping、EJH 安全卡分配、闭环 OpenRouter
执行、OPOM writeback、AdsPower 状态处理、Feishu CSV 交接、银行对账归属和安全门。`pending_manual_ops`、`pending_opom_production_deploy` 等 pending
状态是有意的非失败状态：它们表示本地代码已准备好，但 live operation 仍需要操作员工作或明确的生产授权。AdsPower 状态写回目前记录为 user-waived，而不是 pending。

要证明整体目标确实完成，使用更严格的 gate：

```bash
npm run audit:completion
```

它使用同一个 evidence matrix，但只要存在任何 `pending_manual_ops`、
`pending_opom_production_deploy` 或其他 pending requirement，就会以非零状态退出。该命令用于防止把本地 MVP 误认为已完成的生产充值闭环。OPOM 生产项只有在提供最近一次成功只读 `preflight:production -- --with-opom-read` 生成的 preflight
marker，或生产 base URL/token 已配置且带有最近的
`OPOM_PRODUCTION_PREFLIGHT_PASSED_AT` 时间戳时，才会清除。

打印生产启动 checklist，且不写任何外部系统：

```bash
npm run checklist:launch
```

该命令总结 readiness audit、剩余 pending items、授权门、所需验证命令和第一段运营序列。只有 readiness item 失败时才会非零退出；pending manual/external items
会继续显示，但不会让 checklist 失败。

生产部署、首次使用验证和 rollback 序列见
[docs/recharge-production-runbook.md](./docs/recharge-production-runbook.md)。

要在不触碰外部系统的情况下 smoke-test 正在运行的本地操作台，启动 server 后运行：

```bash
npm run smoke:local -- --base http://127.0.0.1:4100
```

smoke 测试会检查 `/api/health`、本地 session auth、`/api/preflight`、preflight
行为、全阻断 job 和可下载结果 CSV。它使用缺少 amount 的行，因此不会运行浏览器自动化、OPOM writeback、EJH 创建卡或 AdsPower 状态写回。

检查操作台 selector 合同和必需控件：

```bash
npm run smoke:ui -- --base http://127.0.0.1:4100
npm run smoke:ui:opom-flow -- --base http://127.0.0.1:4100
npm run smoke:ui:identity-mismatch -- --base http://127.0.0.1:4100
```

这些测试会验证已服务的 HTML、JS 和 CSS 可达，`app.js` 中使用的每个
`document.querySelector('#...')` target 都存在于页面中，并且 OPOM、AdsPower、
EJH 卡分配、自动 preflight/live execution 和结果 CSV 控件都存在。OPOM browser
smokes 还会覆盖 happy-path `Load OPOM group -> Match AdsPower -> Allocate cards -> automatic preflight` 流程，以及 preflight 必须阻断 live execution 的
`identity_mismatch` 路径。

要跨 Recharge 和 OPOM 运行完整本地 integration gate，保持本地 Recharge server
运行并执行：

```bash
npm run verify:integration -- --base http://127.0.0.1:4100
```

该命令会运行 Recharge API/UI smoke tests、Recharge 语法检查和单元测试、OPOM
临时 SQLite `db:push`、OPOM production build、typecheck/lint、OPOM Recharge
route/import/migration tests，以及两个 worktree 的 whitespace checks。如果
`next build` 重写生成的 route-type reference，它会恢复 OPOM `next-env.d.ts`。它不会写 OPOM 生产数据、创建 EJH 卡、启动浏览器自动化或写 AdsPower 状态。

## 开发

浏览器自动化引擎位于 `src/automation/`；Web/API/worker 层位于 `src/server/`
和 `public/`。

runner 在运行时不再从 Codex `openrouter-recharge` skill 目录 import 或执行代码。
