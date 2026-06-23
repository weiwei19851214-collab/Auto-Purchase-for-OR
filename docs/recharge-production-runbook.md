# Recharge x OPOM 生产运行手册

这份运行手册是操作员将 Recharge x OPOM 集成从本地验证推进到生产使用时的检查清单。它刻意不包含密钥、卡号、CVV、Cookie、Session Token、SSH 密码或 OPOM 管理员密码。

## 范围

包含：

- `/api/v1/recharge/*` 的 OPOM 生产部署准备。
- Recharge 本地执行器的生产就绪检查。
- 只读 OPOM 队列验证。
- no-purchase 沙箱验证。
- EJH 创建卡、OPOM 写回、AdsPower 状态写回、OpenRouter 真实充值的明确授权门。
- 回滚和停止点。

不包含：

- 创建 OpenRouter 账号。
- 创建 OpenRouter API Key。
- 退款或申诉流程。
- 银行流水对账实现变更。银行流水导入、对账和客户确认导出仍由 OPOM 负责。

## 授权门

没有当前任务中的用户明确授权，不得越过以下门槛继续操作：

1. `git push`。
2. OPOM 生产部署。
3. 修改 OPOM 生产 `.env`。
4. 运行 OPOM 生产 `db:push`。
5. 除文档化只读队列检查之外的任何 OPOM 生产写 API 调用。
6. 真实 EJH 创建卡。
7. OpenRouter 真实付款提交。
8. 未来任何通过 `group_move`、`remark_append`、`remark_append_v2` 或 AdsPower 原生标签 API 进行的 AdsPower 状态写回。除非用户明确重新启用 AdsPower 写入，否则当前发布默认豁免该门槛。

## 本地发布门

本地 Recharge server 运行时，在 `/Users/weiwei/project/Auto-Purchase-for-OR` 下执行：

```bash
npm run verify:integration -- --base http://127.0.0.1:4100
```

任何生产动作之前必须通过该检查。它会验证 Recharge API/UI smoke、Feishu result CSV handoff、目标就绪审计、发布清单、敏感信息静态审计、语法检查、全部 Recharge 测试、OPOM 临时 SQLite `db:push`、OPOM 生产构建、OPOM typecheck、OPOM lint、OPOM Recharge 路由/导入/迁移测试和空白字符检查。

普通就绪审计可以在仍存在人工或外部待办项时通过。如果要证明完整目标已经完成，而不仅是本地就绪，请运行：

```bash
npm run audit:completion
```

这个更严格的门槛会刻意失败，直到所有待授权项、操作员项、OPOM 生产部署/读取验证项以及外部 AdsPower 状态写回项都已解决。只有验证环境提供了以下任一信息时，OPOM 生产验证才会被标记为完成：来自成功只读 OPOM 队列读取的近期 preflight marker，或者 shell-only marker 变量 `OPOM_PRODUCTION_RECHARGE_API_VERIFIED=true` 和 `OPOM_PRODUCTION_PREFLIGHT_PASSED_AT`，并同时提供 OPOM 生产 base URL 和 recharge API token。

如需简洁的机器可读发布摘要：

```bash
npm run checklist:launch
npm run checklist:launch -- --json
```

该清单是只读的。它汇总就绪审计、剩余待办项、必需命令、明确授权门和第一轮操作顺序。

如果 Recharge server 未运行，只在本项目内本地启动：

```bash
PORT=4100 npm start
```

不要为了这条发布路径启动 OPOM 本地服务。

## OPOM 生产部署清单

使用 `/Users/weiwei/project/manager-openrouter/AGENTS.md` 中的 OPOM 生产约定：

- 生产 URL：通过 `OPOM_BASE_URL` 配置。
- 服务器：使用操作员批准的 OPOM 生产 SSH 主机。
- 持久 checkout：`~/manager-openrouter/repo`。
- 共享运行时数据：`~/manager-openrouter/shared`。
- 生产 `.env`：`~/manager-openrouter/shared/.env`。
- 生产 SQLite DB：`~/manager-openrouter/shared/dev.db`。
- 部署脚本：`~/manager-openrouter/deploy.sh`。

部署前：

1. 确认本地 OPOM 目录只包含预期的 Recharge 集成改动。
2. 确认本地 OPOM 检查已通过 `npm run verify:integration`。
3. 只有获得明确授权后才 commit 和 push。
4. 在服务器上备份 `~/manager-openrouter/shared/.env` 和 `~/manager-openrouter/shared/dev.db`。
5. 通过安全渠道把 `RECHARGE_API_TOKEN` 加入 `~/manager-openrouter/shared/.env`。不要把它粘贴进日志或 Git 跟踪文件。
6. 只有获得 push/deploy 授权后才运行 `~/manager-openrouter/deploy.sh`。
7. 确认部署保留了共享 `.env` 和共享 SQLite DB 的 symlink/路径。

部署后，在 OPOM 服务器或部署 shell 中运行：

```bash
cd ~/manager-openrouter/repo
npm run db:generate
npm run db:push
npm run build
npm run typecheck
npm run lint
npm test -- test/recharge-api-routes.test.ts test/admin-routes.test.ts test/setup-db-migration.test.ts
```

`scripts/setup-db.mjs` 应该增量添加 `Account.adsPowerUserId` 和 `Account.adsPowerSerialNumber`。它不得替换生产账号数据。

## 只读生产验证

在 Recharge 本地执行器机器上运行：

```bash
export OPOM_BASE_URL="https://opom.example.internal"
export OPOM_RECHARGE_TOKEN="<from secure channel>"
npm run preflight:production -- --with-opom-read --marker-file ./var/production-preflight-marker.json
```

OPOM 读取检查通过后，使用不含敏感信息的 marker 文件执行严格完成审计：

```bash
npm run audit:completion -- --preflight-marker ./var/production-preflight-marker.json
```

marker 文件只记录验证时间戳、OPOM base URL、分组和已清洗的检查摘要。它不得包含 OPOM token、卡号、CVV、Cookie 或 EJH 原始诊断 payload。

也支持单 shell 验证的环境 marker 路径：

```bash
export OPOM_PRODUCTION_RECHARGE_API_VERIFIED=true
export OPOM_PRODUCTION_PREFLIGHT_PASSED_AT="<timestamp from preflight output>"
```

该检查可能会为 `RECHARGE_ACCOUNTS_READ` 创建普通 OPOM 读取审计日志。它不得调用：

- `PUT /api/v1/recharge/accounts/:opomAccountId/card-binding`
- `POST /api/v1/recharge/runs/:runId/results`
- EJH 创建卡
- OpenRouter 浏览器自动化
- AdsPower 状态写回

当 `ADSPOWER_STATUS_MODE=group_move` 时，同一个 preflight 会读取一次 AdsPower `/api/v1/group/list`，并解析精确的分组名称目标。它只检查已配置的成功/失败/阻断目标是否可用；它不会调用 `/api/v1/user/regroup`，也不会更新 profile 备注。

如果后续明确重新启用 AdsPower 状态写回，`npm run adspower:status-targets -- --json` 是对应的只读发现步骤。它会列出当前 AdsPower 分组，解析已配置的 `ADSPOWER_*_GROUP_ID` 或 `ADSPOWER_*_GROUP_NAME` 值，并在候选分组明显时打印建议的 env exports。为了操作员可读性，优先使用 `name:<exact group name>` 或 `ADSPOWER_*_GROUP_NAME`；preflight 仍会在任何 live run 使用前验证该名称只解析到一个分组。操作台的 `Discover groups` 按钮使用同样的只读查询，针对当前屏幕上的目标字段进行验证，因此操作员不需要切换到终端也能确认目标。`Use discovered targets` 只会把已解析或候选 group ID 复制到本地 `group_move` 表单字段，并强制下一次执行尝试重新运行 preflight；它不会调用 AdsPower 写端点。

如果候选 CSV 已存在，可以只读验证：

```bash
npm run preflight:production -- --csv /path/to/recharge-candidate.csv
```

CSV 门槛会拒绝缺失字段，以及 `encryptedParam`、`requestPayload`、`rawResponse` 等 EJH 原始诊断列。

## 第一轮操作验证顺序

OPOM 生产只读验证通过后，按以下顺序执行：

1. 操作员准备 AdsPower profiles，并将符合条件的 OPOM 账号移动到 `group=recharge`。
2. 在 Recharge 中点击 `Load OPOM group`。
3. 检查待处理行和 OPOM 健康状态。
4. 点击 `Match AdsPower`。
5. 输入本轮金额或余额规则、Auto top-up 值，以及任何 billing address 映射 CSV。
6. 勾选执行确认并启动运行；控制台会先自动运行 preflight。任何浏览器自动化启动前，都要解决所有 `missing_fields`、`identity_mismatch` 和 AdsPower 匹配失败。
7. 对一行运行 no-purchase mode。它可以打开 AdsPower/OpenRouter 并准备购买表单，但不得点击最终 Purchase。
8. 如果有测试数据，验证一行预期的 `identity_mismatch`。
9. 只有存在安全的阻断场景时，才验证一行预期的 `manual_security_blocker`。保留浏览器打开，供人工检查。
10. 获得明确授权后，创建 EJH 卡批次，并验证 safe card CSV 路径。
11. 获得明确授权后，运行一行小额真实充值。
12. 确认该行拥有所有完成证据：OPOM 账号已匹配、AdsPower profile 已匹配、OpenRouter 账号已匹配、新卡绑定已写入 OPOM、余额增长已验证、Auto top-up 回读匹配、result CSV 已生成、AdsPower 状态处理已记录。

在 result CSV 中，`completion_evidence_status=production_complete` 是真实闭环行的交付信号。`test_mode_complete` 只表示 no-purchase 演练，`incomplete` 必须通过 `completion_evidence_missing` 解决。OPOM 来源行在 confirmed purchase mode 中，必须启用 OPOM writeback，preflight 才能把它们标记为可执行。

## AdsPower 状态处理

默认模式是 `disabled`，因为用户已为当前发布豁免 AdsPower 状态写回；result CSV 记录：

```text
adspower_tag_status=skipped_user_waived
adspower_status_target=waived_by_user
```

只有在获得明确授权并配置了分组目标或备注策略时，才使用 `group_move`、`remark_append` 或 `remark_append_v2`。对于 `group_move`，目标可以是 AdsPower group id、`id:<group_id>`、`name:<exact group name>` 或 `ADSPOWER_*_GROUP_NAME` 环境变量；按精确名称解析时，必须解析到一个分组后才能 regroup。把这些视为操作标记，而不是 AdsPower 原生标签。在官方 AdsPower Local API 暴露已确认的标签写入端点前，不要声称支持原生标签写回。

只有在明确重新启用 AdsPower 状态写回时，才在生产 preflight 前使用 `npm run adspower:status-targets -- --json`。它会发现 group id，并验证已配置目标名称没有歧义；该命令是只读的，不会调用 regroup 或 profile update 端点。result CSV 会在 `adspower_status_target` 中记录具体标记目标，例如 `group:success:<group_id>`、`group:failure:<group_id>`、`group:blocker:<group_id>`、`remark:v1` 或 `remark:v2`。

## 回滚

如果 OPOM 部署在 `db:push` 前失败：

1. 停止，不要运行 writeback 或 live recharge。
2. 通过服务器部署机制重新运行上一个已部署版本，或按照 OPOM 运维实践恢复上一个发布。
3. 保留日志和失败构建输出。

如果 OPOM 部署在 `db:push` 后失败：

1. 停止 Recharge 操作。
2. 保留 `~/manager-openrouter/shared/dev.db`。
3. 只有在获得用户明确授权后，才恢复部署前的 SQLite 备份。
4. 如果需要移除 `RECHARGE_API_TOKEN` 或其他环境变更，则恢复部署前的 `.env` 备份。
5. 恢复前重新运行 OPOM 只读健康检查。

如果 Recharge live execution 失败：

1. 出现 `payment_issue_card_declined` 后，不要重试同一张卡。
2. 出现 `manual_security_blocker` 时停止批次，并保留浏览器状态供人工检查。
3. 使用生成的 result CSV 和 OPOM run-result audit 识别需要人工处理的行。
4. 不要从旧 invoice、旧交易、Feishu 手工状态或 OPOM 计划状态推断完成。

## 完成标准

只有每个必需行都能证明以下事项时，集成才算生产完成：

- OPOM 账号、AdsPower profile 和 OpenRouter 登录身份匹配。
- EJH 卡分配具有 `orderNo`，普通交付中只使用 safe card CSV 字段。
- OpenRouter 付款卡已替换或绑定。
- 需要时 billing address 存在。
- 验证付款的余额增长已确认。
- Auto top-up 阈值和金额已回读，并与请求值一致。
- OPOM 来源的 confirmed purchase 行执行时已启用 OPOM writeback。
- OPOM card binding writeback 成功。
- OPOM row result writeback 成功。
- Result CSV 已生成，且不包含 CVV、Cookie、Session、Token、AK 或 EJH 原始诊断 payload。
- AdsPower 状态写回要么明确豁免，并带有 `adspower_tag_status=skipped_user_waived` 和 `adspower_status_target=waived_by_user`，要么通过明确授权的操作模式（`group_move`、`remark_append` 或 `remark_append_v2`）写入，并且具体 `adspower_status_target` 在 result CSV 中可见。
