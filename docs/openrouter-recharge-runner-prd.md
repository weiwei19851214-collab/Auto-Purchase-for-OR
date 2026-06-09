# PRD: OpenRouter 充值执行器本地 Web 控制台

## Problem Statement

当前 OpenRouter 绑卡、验证充值、Auto top-up 配置曾依赖 Codex 在本地执行 `openrouter-recharge` skill。虽然核心流程已经稳定，但批量执行仍然依赖对话式操作，存在不可产品化的问题：任务提交、进度查看、失败记录、结果下载、权限边界和审计证据都没有统一界面。

需要把这些能力沉淀为一个脱离大模型、脱离 Codex skill 运行时依赖的本地执行系统，让操作者通过 Web 控制台上传 CSV、dry-run、启动 live run 或 no-purchase 测试、查看每行状态并下载 result CSV，而浏览器自动化由项目内确定性 Node.js worker 执行。

## Solution

构建一个本地 Web 控制台 + Node.js 执行器：

- 前台页面只负责上传 CSV、预检、启动任务、查看进度、下载结果。
- Node.js 后端使用项目内 `src/automation/` 自动化引擎，不在运行时调用 `~/.codex/skills/openrouter-recharge`。
- Worker 单线程顺序处理 AdsPower profile，避免浏览器/CDP 并发冲突。
- SQLite 保存 jobs、job rows、events、artifacts。
- 大模型不参与正式执行，只作为后续维护/诊断工具。

## User Stories

1. As an operator, I want to upload a recharge CSV, so that I can start from the same template already used by the current skill.
2. As an operator, I want to run dry-run before live execution, so that missing fields are found without opening browsers.
3. As an operator, I want to see per-row validation results, so that I know which profiles are ready and which need data fixes.
4. As an operator, I want to start a live batch only after dry-run, so that real payment actions are intentional.
5. As an operator, I want the system to process one AdsPower profile at a time, so that browser state stays stable.
6. As an operator, I want each row to show status, stage, message, balance before/after, card last4, and Auto top-up readback, so that failures are auditable.
7. As an operator, I want ordinary failures to be recorded and skipped, so that one bad account does not stop the whole batch.
8. As an operator, I want manual security blockers to stop the batch and leave the browser open, so that I can inspect the challenge.
9. As an operator, I want completed rows to generate a result CSV, so that downstream reconciliation can use the same contract.
10. As an operator, I want sensitive values masked in UI/logs, so that full card numbers, CVV, cookies, API keys, and credentials are never exposed.
11. As an operator, I want to download result CSV and diagnostic logs, so that I can archive the execution evidence.
12. As an operator, I want to rerun only non-completed rows, so that completed accounts are not accidentally charged again.
13. As an operator, I want clear status enums, so that reporting does not depend on free-text interpretation.
14. As an operator, I want the UI to show current worker activity, so that I know whether the system is idle, running, blocked, or failed.
15. As a maintainer, I want the browser automation isolated in a worker module, so that UI changes do not risk payment logic.
16. As a maintainer, I want the existing CLI behavior preserved, so that current batch commands remain usable during migration.
17. As a maintainer, I want state-machine events recorded, so that hard-to-debug UI/CDP failures can be diagnosed later.
18. As a maintainer, I want no LLM dependency in execution, so that batch runs are deterministic and repeatable.
19. As an operator, I want a no-purchase test mode, so that billing address, card binding, card removal, purchase amount entry, invoice checkbox handling, and Auto top-up can be tested without clicking the final Purchase button.
20. As a maintainer, I want the automation engine vendored in this project, so that runtime behavior does not depend on a mutable Codex skill directory.

## Implementation Decisions

- Product shape: local Web console, not SaaS, because AdsPower Local API and CDP require same-machine browser access.
- Backend: Node.js API server with a single local worker.
- Frontend: operational, table-first local UI with dense status information.
- Storage: SQLite for jobs, rows, events, and artifact metadata.
- Queue: first version uses SQLite-backed single-worker loop; Redis/BullMQ is out of scope until real parallelism is needed.
- Execution: run the project-owned `src/automation/bind_openrouter_card_cdp.mjs` engine and shared modules under `src/automation/lib/`.
- Skill reference: `openrouter-recharge` remains a migration reference only; production runtime must not import from or execute files under `~/.codex/skills/openrouter-recharge`.
- Test mode: no-purchase mode sets `confirmPurchase=false` and `preparePurchaseOnly=true`, allowing real browser input for the Purchase Credits amount and related controls while refusing to submit payment.
- Public API:
  - `POST /api/jobs/dry-run`
  - `POST /api/jobs`
  - `GET /api/jobs`
  - `GET /api/jobs/:jobId`
  - `GET /api/jobs/:jobId/rows`
  - `GET /api/jobs/:jobId/result.csv`
  - `POST /api/jobs/:jobId/cancel`
- Status contract remains:
  - `completed`
  - `missing_fields`
  - `login_required`
  - `identity_mismatch`
  - `payment_issue_card_declined`
  - `manual_security_blocker`
  - `purchase_unverified`
  - `failed`
- Security boundary: never show  CVV, cookies, sessions, passwords, API keys, AK, or raw browser storage in UI, logs, result CSV examples, or PRD examples.

## Testing Decisions

- Test at the highest seam possible: API dry-run, job creation, worker row execution adapter, result CSV output.
- Unit tests cover CSV validation, row planning, status classification, redaction, and result writing.
- Integration tests cover job lifecycle with mocked worker outcomes.
- Browser/CDP live tests remain manual or gated, because they can trigger real external state.

## Out of Scope

- OpenRouter account creation.
- API key creation / AK writeback.
- Refund appeals.
- Invoice screenshot capture.
- Multi-user SaaS permissions.
- Parallel browser execution.
- n8n workflow implementation.
- Replacing AdsPower with another browser provider.
- Using a large language model during production execution.
