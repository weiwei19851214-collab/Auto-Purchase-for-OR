# 项目结构说明：给 Java 程序员看的版本

这份文档按 Java 后端常见分层来解释本项目。项目不是 Spring Boot，而是一个
Node.js ESM 项目：本地 Web 控制台、Node.js HTTP API、SQLite 本地状态库、
后台 worker，以及通过 Chrome DevTools Protocol 操作 AdsPower/OpenRouter 的自动化脚本。

## 1. 先看运行入口

常用启动命令在 `package.json`：

```bash
npm start
```

对应入口是：

```text
src/server/index.mjs
```

可以把它理解成 Spring Boot 里的 `Application + Controller 路由注册`。它会：

- 打开 SQLite 数据库。
- 恢复上次中断任务状态。
- 启动后台 `JobWorker`。
- 创建本地 HTTP server。
- 暴露 `/api/...` 接口。
- 托管 `public/` 下的前端页面。

## 2. Java 分层对照表

| Java/Spring 习惯 | 本项目对应位置 | 说明 |
| --- | --- | --- |
| Controller | `src/server/index.mjs` | 所有 HTTP API 路由都在这里集中分发。 |
| Service | `src/server/jobs.mjs`、`src/server/worker.mjs`、`src/server/*-orchestrator.mjs` | 任务创建、dry-run、执行调度、OPOM/AdsPower/EJH 业务编排。 |
| Mapper / Repository | `src/server/db.mjs` | SQLite 表结构、迁移、查询、更新。没有 ORM，直接写 SQL。 |
| DTO / VO | `jobs.mjs` 里的 `publicJob()`、`publicRow()`，以及各 payload 函数返回值 | 返回给前端的对象一般在这些函数里组装。 |
| Client / Gateway | `src/server/opom-client.mjs`、`src/automation/lib/adspower.mjs` | 调外部系统 API。 |
| Batch / Worker | `src/server/worker.mjs` | 从数据库拿 queued job，逐行执行。 |
| Command / Job Runner | `src/automation/*.mjs` | 真正操作浏览器、OpenRouter、AdsPower 的执行器脚本。 |
| Util / Common | `src/automation/lib/*.mjs`、`src/server/http-utils.mjs`、`src/server/redact.mjs` | CSV、状态枚举、金额、脱敏、HTTP 工具等。 |
| Frontend | `public/index.html`、`public/app.js`、`public/styles.css` | 本地 Web 控制台，纯前端，没有 React/Vue。 |
| Tests | `src/test/*.test.mjs` | Node 内置 test runner。 |

## 3. 顶层目录怎么理解

```text
.
├── public/                 # 前端页面，浏览器里看到的操作台
├── src/
│   ├── server/             # 本地 Node.js API、worker、数据库、外部系统适配
│   ├── automation/         # 浏览器自动化执行器
│   └── test/               # 自动化测试
├── scripts/                # smoke、preflight、audit、交付检查脚本
├── docs/                   # PRD、runbook、说明文档
├── data/
│   ├── uploads/            # 上传的 CSV 运行时文件
│   ├── results/            # 结果 CSV 运行时文件
│   └── logs/               # 每行任务的调试日志和截图
├── openrouter-recharge-input-template.csv
├── reconciliation-card-import-template.csv
├── package.json
└── start-local.sh
```

`data/` 是运行时目录，不是主要源码目录。排查执行失败时常看 `data/logs/<job>/<row>/step-*.json`。

## 4. 前端在哪里

前端都在 `public/`：

```text
public/index.html   # 页面结构，类似 JSP/Thymeleaf 模板里的 HTML，但这里是静态 HTML
public/app.js       # 页面交互逻辑，负责读 CSV、调 API、渲染任务列表
public/styles.css   # 样式
```

前端没有构建步骤，也没有组件框架。浏览器打开页面后，`app.js` 直接通过 `fetch('/api/...')`
调用后端接口。

找前端代码的方法：

- 想改某个输入框默认值：先搜 `public/index.html` 里的 `id`。
- 想改按钮点击逻辑：搜按钮 id，然后到 `public/app.js` 找事件绑定。
- 想改表格显示字段：搜表头中文文案，通常在 `public/app.js` 的渲染函数里。

例如：

```bash
rg "defaultAmountAtOrAbove" public
rg "从本行继续" public
```

## 5. 后端 API 在哪里

后端入口是：

```text
src/server/index.mjs
```

这里没有 Express/Koa，直接使用 Node 内置 `node:http`。所以你会看到类似：

```js
if (req.method === 'POST' && pathname === '/api/jobs/dry-run') {
  const payload = await readJsonBody(req);
  sendJson(res, 200, await dryRunPayload(payload));
  return;
}
```

这就相当于 Java 里的：

```java
@PostMapping("/api/jobs/dry-run")
public DryRunResponse dryRun(@RequestBody DryRunRequest payload) { ... }
```

主要 API：

| API | 后端处理函数 | 用途 |
| --- | --- | --- |
| `GET /api/health` | `index.mjs` | 健康检查、worker 状态。 |
| `POST /api/preflight` | `environmentPreflight()` | 本地环境预检。 |
| `POST /api/jobs/dry-run` | `dryRunPayload()` | 解析 CSV，生成执行预览，不真正充值。 |
| `POST /api/jobs` | `createJob()` | 创建正式任务，写入数据库，交给 worker 执行。 |
| `GET /api/jobs` | `jobsList()` | 任务列表。 |
| `GET /api/jobs/:id` | `jobDetails()` | 任务详情、行详情、事件日志。 |
| `POST /api/jobs/:id/resume` | `resumeJob()` | 从失败行继续。 |
| `GET /api/jobs/:id/result.csv` | `sendFile()` | 下载结果 CSV。 |
| `POST /api/opom/ready` | `readyToRechargePayload()` | 从 OPOM 获取待充值数据。 |
| `POST /api/opom/resolve` | `resolveOpomAccountsPayload()` | 批量匹配 OPOM 账号。 |
| `POST /api/adspower/match` | `matchAdsPowerPayload()` | 匹配 AdsPower 浏览器。 |
| `POST /api/cards/allocate` | `allocateCardsPayload()` | 分配安全卡 CSV。 |

## 6. 业务逻辑在哪里

### 任务创建、预检、详情

```text
src/server/jobs.mjs
```

类似 Java 的 `JobService`。核心函数：

- `dryRunPayload(payload)`：CSV 预览，不创建任务。
- `createJob(db, payload)`：创建任务，保存 CSV，写 `jobs` 和 `job_rows`。
- `jobDetails(db, jobId)`：查询任务详情。
- `resumePreview()` / `resumeJob()`：失败行重试。
- `repairOpomWriteback()`：修复 OPOM 写回。

### 后台执行任务

```text
src/server/worker.mjs
```

类似 Java 里的定时任务、队列消费者、`@Scheduled` worker。它会：

1. 定时扫描数据库里 `status = 'queued'` 的 job。
2. 把 job 改为 `running`。
3. 逐行执行 `job_rows`。
4. 调用 `executeRow()` 运行浏览器自动化。
5. 把执行结果写回数据库。
6. 输出结果 CSV。

### 前端参数到执行器参数的转换

```text
src/server/automation-adapter.mjs
```

这个文件很重要，可以把它理解成 `JobService` 和外部命令执行器之间的 Adapter。

它负责：

- `runnerArgs(options)`：把页面配置转换成统一运行参数。
- `parsePlan(csvText, options)`：解析 CSV、检查字段、生成 dry-run 计划。
- `makeJobFiles()`：保存上传 CSV 和结果 CSV 路径。
- `executeRow()`：真正调用单行自动化脚本。
- `writeResultCsv()`：写结果 CSV。

## 7. 数据库在哪里

```text
src/server/db.mjs
```

类似 Java 的 `Mapper + migration`。本项目使用 Node 内置 SQLite：

```js
import {DatabaseSync} from 'node:sqlite';
```

主要表：

| 表 | 作用 |
| --- | --- |
| `jobs` | 一次上传/执行任务。 |
| `job_rows` | CSV 中每一行账号的执行状态。 |
| `events` | 任务和行的事件日志。 |
| `artifacts` | 运行产物记录。 |

常用函数：

- `openDatabase()`：打开数据库并迁移表。
- `getJob()`：查单个任务。
- `listJobs()`：任务列表。
- `listRows()`：任务行列表。
- `listEvents()`：事件列表。
- `updateJobCounts()`：刷新任务统计。
- `recoverInterruptedWork()`：服务重启后把 running 行标记为需人工确认。

没有 ORM，也没有 MyBatis XML。SQL 都直接写在 `.mjs` 文件里。

## 8. 自动化执行器在哪里

```text
src/automation/
```

这是项目最特殊的一层。它不是普通业务 service，而是“打开浏览器并操作网页”的执行器。

### 单行执行器

```text
src/automation/bind_openrouter_card_cdp.mjs
```

这是最核心、最长的文件。它负责一行账号的闭环操作：

- 启动或连接 AdsPower 浏览器。
- 打开 OpenRouter Credits 页面。
- 校验登录账号是否匹配。
- 绑定/替换卡。
- 填 billing address。
- 按余额规则充值。
- 配置 Auto Top-Up。
- 记录 step 日志、截图、网络错误。
- 返回结构化结果。

如果你要排查“页面按钮没点到”“等待太久”“500 弹框没关”“Auto Top Up 没开”，基本都在这个文件里找。

### 批量命令行执行器

```text
src/automation/batch_recharge_openrouter_cards_cdp.mjs
```

这是老式命令行批处理入口。现在 Web 控制台主要通过 `src/server/worker.mjs`
调用 `automation-adapter.mjs`，再调用单行执行器。这个文件仍可用于 dry-run 或脚本化批量运行。

### 自动化共享库

```text
src/automation/lib/
```

| 文件 | 作用 |
| --- | --- |
| `recharge-plan.mjs` | CSV 行解析、执行计划、充值规则、结果字段。 |
| `status-contract.mjs` | 状态枚举和错误分类。 |
| `balance-verification.mjs` | 余额增长验证。 |
| `csv.mjs` | CSV 解析和输出。 |
| `adspower.mjs` | AdsPower Local API。 |
| `child-runner.mjs` | 子进程执行和超时控制。 |
| `common.mjs` | 金额、卡号、脱敏等工具。 |

## 9. 外部系统适配在哪里

| 外部系统 | 文件 | 类比 |
| --- | --- | --- |
| OPOM | `src/server/opom-client.mjs`、`src/server/opom-orchestrator.mjs` | Java 里的第三方 HTTP Client + Service 编排。 |
| AdsPower 匹配 | `src/server/adspower-match.mjs`、`src/automation/lib/adspower.mjs` | AdsPower 查询和匹配逻辑。 |
| AdsPower 状态写回 | `src/server/adspower-status.mjs`、`src/server/adspower-status-targets.mjs` | 成功/失败后移动分组或备注等。 |
| EJH 卡 | `src/server/card-provider-ejh.mjs`、`src/server/card-allocation.mjs`、`ejh_create_cards.py` | 卡供应和 CSV 分配。 |

## 10. 一次充值任务的完整调用链

下面是从页面点击到浏览器执行的大致流程：

```text
用户在页面上传 CSV / 选择配置
        |
        v
public/app.js
        |
        | fetch('/api/jobs/dry-run')
        v
src/server/index.mjs
        |
        v
src/server/jobs.mjs -> dryRunPayload()
        |
        v
src/server/automation-adapter.mjs -> parsePlan()
        |
        v
src/automation/lib/recharge-plan.mjs
```

正式执行时：

```text
public/app.js
        |
        | fetch('/api/jobs')
        v
src/server/index.mjs
        |
        v
src/server/jobs.mjs -> createJob()
        |
        v
src/server/db.mjs 写 jobs/job_rows
        |
        v
src/server/worker.mjs 自动扫描 queued job
        |
        v
src/server/automation-adapter.mjs -> executeRow()
        |
        v
src/automation/bind_openrouter_card_cdp.mjs
        |
        v
AdsPower 浏览器 + OpenRouter 页面
        |
        v
返回结果 -> worker 写 job_rows/events/result.csv
```

## 11. 常见需求应该从哪里找

### 改页面默认值

先看：

```text
public/index.html
```

再搜对应 id 在：

```text
public/app.js
scripts/ui-smoke.mjs
README.md
```

### 改某个 API 行为

先在 `src/server/index.mjs` 搜接口路径，例如：

```bash
rg "/api/jobs/dry-run" src/server
```

然后顺着调用函数去 `jobs.mjs`、`automation-adapter.mjs`。

### 改 CSV 字段或充值规则

重点看：

```text
src/automation/lib/recharge-plan.mjs
src/server/automation-adapter.mjs
public/app.js
```

`recharge-plan.mjs` 是规则事实来源。比如余额规则、必填字段、结果列，都在这里附近。

### 改任务状态

重点看：

```text
src/automation/lib/status-contract.mjs
src/server/worker.mjs
src/server/db.mjs
```

状态不要随便写自由文本，项目有固定状态合同。

### 改浏览器页面操作

重点看：

```text
src/automation/bind_openrouter_card_cdp.mjs
```

建议用关键词搜页面文案或步骤名：

```bash
rg "Add a Payment Method|Auto Top|Billing Address|Save payment" src/automation
```

### 改 OPOM 对接

重点看：

```text
src/server/opom-client.mjs
src/server/opom-orchestrator.mjs
src/test/opom-integration.test.mjs
```

### 改 AdsPower 匹配

重点看：

```text
src/server/adspower-match.mjs
src/automation/lib/adspower.mjs
```

### 改测试或验证

重点看：

```text
src/test/
scripts/
```

## 12. Node.js 语法快速对照

### import/export

Java：

```java
import com.example.JobService;
```

本项目：

```js
import {createJob} from './jobs.mjs';
```

导出函数：

```js
export async function createJob(db, payload) {
  // ...
}
```

### async/await

Java 里你可能习惯同步写法或 `CompletableFuture`。Node 里异步操作常用：

```js
const payload = await readJsonBody(req);
const result = await createJob(db, payload);
```

`await` 只能在 `async function` 里使用。

### 没有类也可以是 Service

很多文件直接导出函数，不一定写 class。例如 `jobs.mjs` 就像一组 service 方法：

```js
export async function dryRunPayload(payload) {}
export async function createJob(db, payload) {}
export function jobDetails(db, jobId) {}
```

### SQL 直接写在代码里

类似 JDBC 或 MyBatis 注解，不是 ORM：

```js
db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
```

## 13. 推荐阅读顺序

如果你要系统学习这个项目，建议按这个顺序：

1. `README.md`：先理解业务和运行方式。
2. `public/index.html`：知道页面有哪些配置。
3. `public/app.js`：知道按钮如何调用 API。
4. `src/server/index.mjs`：知道 API 路由。
5. `src/server/jobs.mjs`：知道任务如何创建和展示。
6. `src/server/db.mjs`：知道数据表。
7. `src/server/worker.mjs`：知道任务如何被后台执行。
8. `src/server/automation-adapter.mjs`：知道 Web 任务如何变成自动化命令。
9. `src/automation/lib/recharge-plan.mjs`：知道 CSV 和充值计划。
10. `src/automation/bind_openrouter_card_cdp.mjs`：最后看浏览器自动化细节。

## 14. 常用命令

```bash
npm run check
npm test
npm start
npm run smoke:local -- --base http://127.0.0.1:4100
npm run smoke:ui -- --base http://127.0.0.1:4100
```

开发时至少跑：

```bash
npm run check
```

改业务逻辑时再跑：

```bash
npm test
```

改前端页面或 API 时，服务启动后跑：

```bash
npm run smoke:ui -- --base http://127.0.0.1:4100
```

## 15. 一个实用找代码方法

这个项目没有 IDE 自动帮你从 Controller 跳 Service，所以推荐用 `rg`：

```bash
rg "接口路径或页面文案" .
rg "函数名" src
rg "字段名" public src scripts docs
```

比如你要找“余额大于等于阈值时充值”：

```bash
rg "余额大于等于|amount_at_or_above_threshold|defaultAmountAtOrAbove" public src scripts docs README.md
```

一般会同时找到：

- 页面输入框：`public/index.html`
- 前端读写逻辑：`public/app.js`
- smoke 测试：`scripts/ui-smoke.mjs`
- 文档：`README.md`
- 规则解析：`src/automation/lib/recharge-plan.mjs`

这就是本项目里最接近 Java “从 Controller 到 Service 到 Mapper” 的追代码方式。
