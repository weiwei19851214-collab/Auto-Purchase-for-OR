# PRD：OpenRouter 充值执行器本地 Web 控制台

## 问题陈述

当前 OpenRouter 绑卡、验证充值、Auto top-up 配置曾依赖 Codex 在本地执行 `openrouter-recharge` skill。虽然核心流程已经稳定，但批量执行仍然依赖对话式操作，存在不可产品化的问题：任务提交、进度查看、失败记录、结果下载、权限边界和审计证据都没有统一界面。

需要把这些能力沉淀为一个脱离大模型、脱离 Codex skill 运行时依赖的本地执行系统，让操作者通过 Web 控制台上传 CSV、dry-run、启动 live run 或 no-purchase 测试、查看每行状态并下载 result CSV，而浏览器自动化由项目内确定性的 Node.js worker 执行。

## 方案

构建一个本地 Web 控制台 + Node.js 执行器：

- 前台页面只负责上传 CSV、预检、启动任务、查看进度、下载结果。
- Node.js 后端使用项目内 `src/automation/` 自动化引擎，不在运行时调用 `~/.codex/skills/openrouter-recharge`。
- Worker 单线程顺序处理 AdsPower profile，避免浏览器/CDP 并发冲突。
- SQLite 保存 jobs、job rows、events、artifacts。
- 大模型不参与正式执行，只作为后续维护/诊断工具。

## 用户故事

1. 作为操作员，我希望上传充值 CSV，这样就能继续使用当前 skill 已经使用过的同一模板开始执行。
2. 作为操作员，我希望 live execution 在运行前自动执行 preflight，这样不用打开浏览器也能发现缺失字段。
3. 作为操作员，我希望看到每行的验证结果，这样可以知道哪些 profile 已就绪，哪些需要修正数据。
4. 作为操作员，我希望只有 dry-run 后才能启动 live batch，这样真实付款动作是有意触发的。
5. 作为操作员，我希望系统一次只处理一个 AdsPower profile，这样浏览器状态保持稳定。
6. 作为操作员，我希望每行展示 status、stage、message、balance before/after、card last4 和 Auto top-up readback，这样失败可以被审计。
7. 作为操作员，我希望普通失败被记录并跳过，这样一个异常账号不会停止整个批次。
8. 作为操作员，我希望遇到人工安全阻断时停止批次并保留浏览器打开，这样我可以检查挑战页面。
9. 作为操作员，我希望 completed 行生成 result CSV，这样下游对账可以继续使用同一合同。
10. 作为操作员，我希望 UI/日志中敏感值被遮蔽，这样完整卡号、CVV、Cookie、API key 和凭据不会暴露。
11. 作为操作员，我希望下载 result CSV 和诊断日志，这样可以归档执行证据。
12. 作为操作员，我希望只重跑未完成行，这样已完成账号不会被意外再次扣款。
13. 作为操作员，我希望状态枚举清晰，这样报表不依赖自由文本解释。
14. 作为操作员，我希望 UI 展示当前 worker 活动，这样可以知道系统是 idle、running、blocked 还是 failed。
15. 作为维护者，我希望浏览器自动化隔离在 worker 模块中，这样 UI 改动不会影响付款逻辑。
16. 作为维护者，我希望保留现有 CLI 行为，这样迁移期间当前批处理命令仍然可用。
17. 作为维护者，我希望记录状态机事件，这样之后可以诊断难复现的 UI/CDP 失败。
18. 作为维护者，我希望执行链路没有 LLM 依赖，这样批量运行是确定且可重复的。
19. 作为操作员，我希望有 no-purchase test mode，这样可以在不点击最终 Purchase 按钮的情况下测试 billing address、绑卡、删卡、购买金额输入、invoice checkbox 处理和 Auto top-up。
20. 作为维护者，我希望自动化引擎内置在本项目中，这样运行时行为不依赖可变的 Codex skill 目录。

## 实现决策

- 产品形态：本地 Web 控制台，不做 SaaS，因为 AdsPower Local API 和 CDP 需要同机浏览器访问。
- 后端：Node.js API server + 单本地 worker。
- 前端：偏操作台的表格优先本地 UI，展示高密度状态信息。
- 存储：SQLite 保存 jobs、rows、events 和 artifact metadata。
- 队列：第一版使用 SQLite 支撑的单 worker 循环；真正需要并行前，Redis/BullMQ 不在范围内。
- 执行：运行项目自有的 `src/automation/bind_openrouter_card_cdp.mjs` 引擎，以及 `src/automation/lib/` 下的共享模块。
- Skill 参考：`openrouter-recharge` 只作为迁移参考；生产运行时不得 import 或执行 `~/.codex/skills/openrouter-recharge` 下的文件。
- 测试模式：no-purchase mode 设置 `confirmPurchase=false` 和 `preparePurchaseOnly=true`，允许在真实浏览器中输入 Purchase Credits 金额和相关控件，但拒绝提交付款。
- 公共 API：
  - `POST /api/jobs/dry-run`
  - `POST /api/jobs`
  - `GET /api/jobs`
  - `GET /api/jobs/:jobId`
  - `GET /api/jobs/:jobId/rows`
  - `GET /api/jobs/:jobId/result.csv`
  - `POST /api/jobs/:jobId/cancel`
- 状态合同保持为：
  - `completed`
  - `missing_fields`
  - `login_required`
  - `identity_mismatch`
  - `payment_issue_card_declined`
  - `manual_security_blocker`
  - `purchase_unverified`
  - `failed`
- 安全边界：绝不在 UI、日志、result CSV 示例或 PRD 示例中显示 CVV、Cookie、Session、密码、API key、AK 或 raw browser storage。

## 测试决策

- 在尽可能高的边界测试：API dry-run、job 创建、worker row execution adapter、result CSV 输出。
- 单元测试覆盖 CSV 验证、row planning、状态分类、脱敏和结果写入。
- 集成测试覆盖使用 mocked worker outcomes 的 job 生命周期。
- Browser/CDP live tests 保持人工或门控，因为它们可能触发真实外部状态。

## 不在范围内

- 创建 OpenRouter 账号。
- 创建 API key / AK 写回。
- 退款申诉。
- Invoice 截图捕获。
- 多用户 SaaS 权限。
- 并行浏览器执行。
- n8n workflow 实现。
- 用其他浏览器提供方替换 AdsPower。
- 在生产执行期间使用大语言模型。
