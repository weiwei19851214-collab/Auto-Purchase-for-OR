# PRD：OPOM 驱动的自动换卡闭环

## 1. 背景

当前 Auto-Purchase-for-OR 已经具备本地 Web 控制台、AdsPower 匹配、OpenRouter 换卡/充值自动化、EJH 安全卡 CSV 分配、OPOM 写回和结果 CSV 输出能力。

下一阶段需要把“待换卡账号”也纳入闭环：当 OPOM 系统中出现待换卡账号后，本项目可以在本地充值系统中开启自动换卡监控，自动读取待换卡列表、计算新卡额度、调用 EJH 开卡、进入对应 AdsPower 浏览器完成 OpenRouter 换卡，并把结果写回 OPOM。

典型操作场景：

1. 用户单独准备一台电脑。
2. 浏览器打开两个标签页：一个是 OPOM/监控系统，一个是本地充值系统。
3. 用户在本地充值系统的“自动换卡”区域点击“启动换卡”开关。
4. 系统按用户在本地配置中填写的分钟间隔检测 OPOM 待换卡列表，默认每 18 分钟轮询一次，并根据“找到待换卡数据后自动执行”开关决定是否立即换卡。

## 2. 目标

- 自动发现 OPOM 待换卡账号。
- 自动计算合理的新卡额度，减少高消耗账号频繁换卡，同时降低低消耗账号资金占用。
- 在“自动创建 EJH 卡”开关开启时，自动调用 EJH 开卡，并生成本项目可消费的安全卡数据。
- 自动打开 AdsPower profile，进入 OpenRouter 页面完成换卡绑定。
- 换卡完成后自动写回 OPOM，并生成本地审计记录和结果 CSV。
- 遇到可恢复错误时支持单行重试；遇到安全/风控阻断时保留现场等待人工处理。

## 3. 非目标

- 不创建 OpenRouter 账号。
- 不创建 OpenRouter API key / AK 写回。
- 不实现银行流水导入、银行对账或客户确认导出。
- 不处理退款、申诉、发票截图归档。
- 不把本地执行器改造成多用户 SaaS。
- 不绕过 Stripe 3DS、银行验证、CAPTCHA、hCaptcha、Cloudflare、短信/电话验证、passkey-only 登录或其他风控。
- 不在未授权情况下触发真实 EJH 开卡、OpenRouter live purchase 或 OPOM 生产写 API。

## 4. 用户流程

1. 用户打开本地充值系统。
2. 用户在“本地配置”中确认 OPOM、AdsPower、EJH、超时、重试等配置已保存。
3. 用户进入独立的“自动换卡”区域，手动点击“查询 OPOM 待换卡列表”，或打开“启动换卡”开关让系统定时查询。
4. 系统开始轮询或拉取 OPOM 待换卡列表。
5. 系统展示待换卡账号列表：账号、OPOM id、AdsPower 编号、AdsPowerId、过去 3 天消耗、建议开卡额度、当前阶段、失败原因。
6. 系统根据固定第一版额度策略计算每个账号的新卡额度。
7. 如果“找到待换卡数据后自动执行”开关已开启，系统自动创建换卡任务；如果未开启，账号保留在待换卡列表中，直到下一次定时任务或用户手动触发。
8. 如果“自动创建 EJH 卡”开关已开启，系统按上方本地配置中的 EJH 参数和本次计算出的额度调用 Python 脚本创建卡；如果未开启，只停留在待开卡/待人工处理状态。
9. EJH 开卡成功后，系统获得 `order_no`、`card_no`、有效期、CVV 等换卡必需字段，并保存安全 CSV。
10. 系统通过 AdsPower 打开对应 OpenRouter 账号。
11. 系统完成身份校验、换卡绑定、billing address 保存。
12. 系统验证换卡结果。
13. 系统按现有自动充值写回 OPOM 的逻辑写回换卡结果。
14. 系统把本次开卡、换卡、充值相关产物写入配置好的本地归档目录，并按天创建文件夹。
15. 系统更新本地任务状态、事件流水、每日统计和结果 CSV。
16. 失败行支持从本行继续或手动重试。

## 5. 功能需求

### 5.1 启动换卡开关

- 页面新增独立的“自动换卡”区域，与现有手动充值/自动充值区域明显区分。
- 自动换卡区域新增“启动换卡”开关。
- 自动换卡区域新增“查询 OPOM 待换卡列表”按钮，允许用户手动触发一次 OPOM 查询。
- 自动换卡区域新增“找到待换卡数据后自动执行”开关。
- 自动换卡区域新增“自动创建 EJH 卡”开关；只有该开关开启时，系统才会调用 `ejh_create_cards.py` 创建真实 EJH 卡。
- 自动换卡区域新增“开卡成功后自动进入 AdsPower 换卡绑定”开关；只有该开关开启时，系统才会在创建可用卡后继续打开对应 AdsPower profile 并进入 OpenRouter 绑定流程。
- “启动换卡”开启后进入换卡监控模式，按配置周期读取 OPOM 待换卡列表。
- 配置周期单位为分钟，只允许填写正整数，默认值为 `18`。
- “找到待换卡数据后自动执行”开启时，发现待换卡账号后自动创建换卡任务；关闭时，只更新待换卡列表，不自动执行。
- “找到待换卡数据后自动执行”开关默认关闭。
- “自动创建 EJH 卡”开关默认关闭。
- “开卡成功后自动进入 AdsPower 换卡绑定”开关默认关闭。
- 开关关闭后停止拉取新任务，但不强制中断正在执行的安全步骤。
- UI 显示当前监控状态：未启动、监控中、执行中、暂停、异常。
- 自动换卡任务和现有充值任务完全分开：页面区域、任务列表、任务 id、日志路径、执行队列都要清晰区分。

### 5.2 OPOM 待换卡列表

- OPOM 待换卡/待充值账号列表接口已存在，自动换卡第一版直接对接当前 OPOM 队列接口。
- 接口基础地址通过配置读取：

```text
OPOM_BASE_URL=http://20.2.209.2:3000
```

- 认证使用固定机器 token，但 token 必须由用户安全配置，不能硬编码：

```text
OPOM_RECHARGE_TOKEN=<由用户安全提供>
```

- 请求接口：

```text
GET {OPOM_BASE_URL}/api/v1/recharge/accounts
```

- 请求 Header 支持两种方式，优先使用 `x-recharge-api-token`：

```text
x-recharge-api-token: {OPOM_RECHARGE_TOKEN}
Authorization: Bearer {OPOM_RECHARGE_TOKEN}
```

- 查询参数：
  - `group`：账号组，默认 `recharge`。
  - `status`：队列状态，默认 `needs_recharge`，可选 `needs_recharge`、`failed_retryable`、`all`。
  - `limit`：分页大小，默认 `50`，最大 `200`。
  - `cursor`：分页游标，使用上一次响应里的 `nextCursor`。

- 默认请求：

```text
GET /api/v1/recharge/accounts?group=recharge&status=needs_recharge&limit=50
```

- 响应结构：

```json
{
  "data": [
    {
      "opomAccountId": "string",
      "loginEmail": "string",
      "group": "string | null",
      "currentBalanceUsd": "number | null",
      "usageLast3Days": [
        {
          "date": "YYYY-MM-DD",
          "costUsd": "number"
        }
      ],
      "health": {
        "status": "ok | credits_401_blocked | balance_unknown",
        "eligible": "boolean",
        "reason": "string",
        "credits401BlockedAt": "string | null",
        "lastCollectedAt": "string | null",
        "lastCollectionAttemptAt": "string | null"
      },
      "adsPower": null,
      "rechargePolicy": {
        "useGlobalPolicy": "boolean",
        "balanceThresholdUsd": "number",
        "lowBalancePollingThresholdUsd": "number",
        "highBalanceThresholdUsd": "number",
        "stableDailyUsageThresholdUsd": "number",
        "pollIntervalSeconds": "number",
        "lowBalancePollIntervalSeconds": "number",
        "highBalancePollIntervalSeconds": "number"
      },
      "activeCard": null,
      "version": "string"
    }
  ],
  "nextCursor": "string | null"
}
```

- `adsPower` 非空时结构为：

```json
{
  "userId": "string | null",
  "serialNumber": "string | null",
  "groupName": "string | null"
}
```

- `activeCard` 非空时结构为：

```json
{
  "id": "string",
  "orderNo": "string | null",
  "panLast4": "string",
  "unboundAt": "string | null",
  "status": "string"
}
```

- 字段说明：
  - `opomAccountId`：OPOM 账号 ID，后续写回 OPOM 时使用。
  - `loginEmail`：OpenRouter 登录邮箱。
  - `currentBalanceUsd`：当前余额，可为负数，必须保留真实值。
  - `usageLast3Days`：过去 3 个 Asia/Shanghai 自然日的每日消耗金额，包含今天和前两天；用于计算建议开卡额度或判断近期消耗趋势。
  - `health.eligible=false` 的账号不能执行自动换卡/充值。
  - `adsPower.userId` / `adsPower.serialNumber` 用于匹配 AdsPower profile。
  - `activeCard` 只返回脱敏卡信息，不返回完整卡号、CVV 或 panBin6。
  - `nextCursor` 不为空时继续请求下一页，直到 `nextCursor=null`。

- 实现要求：
  - `OPOM_BASE_URL` 和 `OPOM_RECHARGE_TOKEN` 必须可配置，不要硬编码 token。
  - 401/Unauthorized 时要明确提示 OPOM token 无效或缺失，不要当成空列表。
  - 分页读取时使用 `nextCursor`，直到 `nextCursor=null`。
  - 不要在日志、CSV、UI 中输出 token。
  - 默认读取 `group=recharge&status=needs_recharge`。

### 5.3 AdsPower 匹配

- 最终匹配以 8 位字母数字 `ads_power_user_id` 为准。
- 兼容旧数据：取不到 id 时回退 `ads_power_serial_number`。
- 查到 id 后要懒更新本项目和 OPOM 相关字段。
- 页面展示同时包含 AdsPower 编号和 AdsPowerId。
- AdsPower profile 被占用时，任务标记为可重试失败，不归因于网络慢。

### 5.4 EJH 自动开卡

- 复用根目录 `ejh_create_cards.py` 。
- 是否自动调用 EJH 开卡完全由“自动创建 EJH 卡”开关控制。
- “自动创建 EJH 卡”关闭时，系统只展示待开卡账号、建议额度和可操作状态，不调用 Python 脚本。
- “自动创建 EJH 卡”开启时，系统调用 `ejh_create_cards.py`，开卡参数来自：
  - 本地配置中的 EJH app key / app secret。
  - 本地配置中的 Python 命令。
  - 本地配置中的 `cardType`。
  - 本地配置中的新卡有效期天数。
  - 固定 `supportedMccGroup=trv`。
  - 固定 `useTime=1`。
  - 系统根据 `usageLast3Days` 计算出的本次开卡额度。
  - 当前任务生成的 `cardholder` / `card_batch_id` / 输出路径。
- 本项目现有脚本当前使用：
  - 认证接口：`https://www.ejhcard.com/api/v3/authenticate`
  - 开卡接口：`https://www.ejhcard.com/api/v3/card`
  - 业务方法：`card.open.info`
  - 版本：`3.0`
  - DES ECB Base64 加密 `param`
  - 默认安全 CSV 输出
- 官方开卡文档要求 `card.open.info` 的核心业务参数包括：
  - `cardType`
  - `cardAmount`
  - `cardCurrency`
  - `billCurrency`
  - `useTime`
  - `activeDate`
  - `supportedMccGroup`
- 官方响应字段包括：
  - `orderNo`
  - `cardNo`
  - `validityDate`
  - `cvvPassword`
  - `cardType`
  - `cardAmount`
  - `billAmount`
  - `status`
- 自动换卡第一版确认以下业务默认值：
  - `cardType` 不写死在代码中，从本地配置读取，由用户在页面上方配置。
  - `useTime=1`，确认使用多次卡。
  - `supportedMccGroup=trv`，OpenRouter 业务固定使用 `trv`。
  - `activeDate` 从本地配置读取“有效期天数”，值为数字；例如配置 `3` 表示使用当前 Asia/Shanghai 日期加 3 天后的日期，并格式化为 `yyyy-MM-dd`。
  - `companyRate` 暂按现有脚本默认值 `0.01`，后续如 EJH 规则变化再配置化。
- EJH 开卡成功但 OpenRouter 绑定失败时，新卡进入“异常卡池”，等待人工处理，不自动丢弃或重复开卡。
- 异常卡池中的卡不允许再次自动绑定到原账号；系统只把该卡写入异常卡池文件和列表，后续是否复用必须由人工在系统外确认。
- 异常卡池必须支持导出 CSV；同时每出现一张异常卡，系统都要在解析后的当天产物目录下自动新增一个异常卡 CSV 文件，不需要用户手动导出。
- 异常卡 CSV 文件名必须包含时间、OPOM 账号或任务行标识、EJH order no 或卡后四位，避免覆盖，例如 `exception_card_YYYYMMDD_HHmmss_<opom_account_id>_<last4>.csv`。
- EJH 开卡成功和失败都必须分别进入列表，并生成 CSV 文件：
  - 成功开卡列表：记录可用于后续换卡/充值的卡。
  - 开卡失败列表：记录失败原因、OPOM 账号、请求摘要和可重试建议。
- 成功和失败 CSV 都写入解析后的当天产物目录，文件名必须清晰表达结果类型，例如 `ejh_create_cards_success_YYYYMMDD_HHmmss.csv` 和 `ejh_create_cards_failed_YYYYMMDD_HHmmss.csv`。
- 开卡失败列表不能丢失，后续需要可追溯当天失败了哪些账号、失败原因是什么。

参考文档：[EJH 开卡接口](https://www.ejhcard.com/docs/zh/api/create-card.html)。

### 5.5 OpenRouter 换卡执行

- 系统通过 AdsPower 打开对应 OpenRouter 账号。
- 必须校验当前 OpenRouter 登录账号与 OPOM/CSV 中账号一致。
- 进入 Credits / Purchase Credits / Add Payment Method 等页面时，应复用现有页面自动化能力。
- 换卡时需要支持 OpenRouter DOM 变化，选择器不能只依赖 class。
- 新增卡按钮可能只有加号 SVG，没有文字。
- 不能绕过 Stripe/银行/风控验证；遇到阻断时停下并保留现场。

### 5.6 OPOM 写回

- 自动换卡写回 OPOM 跟现有充值任务使用同一套写回逻辑，不为第一版新增独立写回语义。
- 换卡成功后，本项目不额外执行冻结/销毁旧卡等操作；旧卡状态由现有 OPOM 写回逻辑或 OPOM 后续处理负责。
- 换卡成功后写回：
  - OPOM account id
  - AdsPowerId
  - AdsPower 编号
  - EJH order no
  - 卡号/后四位
  - 有效期
  - 换卡状态
  - 本地 run id / job id
  - 失败原因或完成证据
- 写回失败时，不得把 OPOM-sourced 任务标记为完整 `completed`。
- 如果用户确认 OPOM 实际已写入成功，而本项目判断失败，应优先检查响应格式、HTTP 状态和返回体解析。

### 5.7 本地产物归档

- 本项目需要有一个可配置的“本地产物目录”，用于保存自动换卡和自动充值最终产物。
- 本地产物目录在运行时解析为“当天产物目录”。默认值为当前苹果电脑用户桌面下按 Asia/Shanghai 日期创建的目录，例如：

```text
~/Desktop/2026-06-24/
```

- 自动换卡任务日志根目录默认值为当天产物目录下的 `logs` 目录，例如：

```text
~/Desktop/2026-06-24/logs/
```

- 如果用户配置的是不含当天日期的基础目录，系统按 Asia/Shanghai 日期在该目录下创建当天文件夹，例如：

```text
<用户配置的基础目录>/2026-06-24/
```

- 当天所有自动换卡、EJH 开卡、自动充值结果文件都写入解析后的当天产物目录。
- 如果用户没有修改本地产物目录，则当天所有自动换卡、EJH 开卡、自动充值结果文件直接写入默认桌面日期目录，不再额外嵌套一层日期目录。
- 如果用户没有修改自动换卡任务日志根目录，则每个自动换卡任务的结构化日志、截图和排障文件都写入默认桌面日期目录下的 `logs` 子目录。
- 每一次自动充值完成后都必须生成一个新的 CSV 文件，不能覆盖当天之前的文件。
- 自动充值结果 CSV 文件名应包含时间和任务 id，例如：

```text
auto_recharge_result_20260624_153012_<job_id>.csv
```

- 自动充值结果 CSV 至少包含：
  - `gmail_email`：Gmail / OpenRouter 登录邮箱。
  - `ads_power_serial_number`：AdsPower 编号。
  - `ads_power_user_id`：AdsPowerId。
  - `card_no`：银行卡号。
  - `card_last4`：银行卡后四位。
  - `ejh_order_no`：EJH 订单号。
  - `opom_account_id`：OPOM 账号 ID。
  - `purchase_amount`：本次充值金额。
  - `balance_before`：充值前余额。
  - `balance_after`：充值后余额。
  - `replacement_job_id` / `recharge_job_id`：本地任务 id。
  - `status`：任务状态。
  - `message`：失败原因或完成说明。
  - `opom_writeback_status`：OPOM 写回状态。
  - `automation_log_dir`：本次自动化日志路径。
- EJH 开卡成功 CSV、开卡失败 CSV、异常卡池 CSV、自动充值结果 CSV 都必须落到解析后的当天产物目录。
- 异常卡池 CSV 同时支持两种形式：
  - 单卡自动 CSV：每出现一张异常卡立即自动生成一个新的 CSV 文件。
  - 汇总导出 CSV：用户在异常卡池页面点击导出时生成当前异常卡池汇总文件。
- 文件中不得包含 token、cookie、session、API key、AK。CVV 只允许出现在必要的受控安全卡 CSV 中，不进入普通结果 CSV。

### 5.8 每日统计和进度

- 系统需要按天记录统计信息，便于追溯今天一共做了什么。
- 每日统计至少包含：
  - 今天创建了多少张卡。
  - 今天开卡成功多少张。
  - 今天开卡失败多少张。
  - 今天进入异常卡池多少张。
  - 今天自动充值了多少个账户。
  - 每个自动充值账户的邮箱、AdsPower 编号、AdsPowerId、EJH 订单号、卡号/后四位、充值金额、执行状态、OPOM 写回状态。
  - 每次任务对应的结果 CSV 文件路径和日志路径。
- 每日统计应保存到解析后的当天产物目录中的汇总文件，建议命名：

```text
daily_summary_YYYYMMDD.json
daily_summary_YYYYMMDD.csv
```

- 页面上需要展示当天统计摘要。
- 每次执行自动充值或自动换卡任务时，页面需要有动态进度条，粗略显示百分比即可。
- 进度条不要求精确到每个 DOM 操作，但至少要覆盖：读取 OPOM、计算额度、创建卡、打开 AdsPower、绑定卡、验证结果、写回 OPOM、生成文件。

## 6. 额度策略

业务目标：高消耗账号少换卡，低消耗账号少占用资金。所有策略都必须满足：

- 最低额度：150
- 最高额度：10000
- 金额必须为整数
- 金额向上取整到 150 的倍数，例如计算结果为 320 时，实际开卡额度为 450
- 额度计算过程可在 UI 展示

### 第一版策略：固定 5 倍日均消耗

公式：

```text
raw_amount = avg_daily_spend_3d * 5
rounded_amount = ceil(raw_amount / 150) * 150
amount = min(max(rounded_amount, 150), 10000)
```

说明：

- `avg_daily_spend_3d` = 过去 3 天平均每日消耗。
- `usageLast3Days` 已由 OPOM 队列接口返回，包含今天和前两天的 Asia/Shanghai 自然日消耗。
- 如果 `usageLast3Days` 缺失或账号 `health.eligible=false`，该账号不能自动换卡。
- 额度必须为 150 的倍数。
- 示例：计算结果 320，实际额度 450；计算结果 80，实际额度 150；计算结果 10050，实际额度 10000。

第一版确认采用该策略。

### 后续可选策略 B：按消耗分层放大

规则：

```text
avg_daily_spend_3d < 30          => 150
30 <= avg_daily_spend_3d < 300  => avg * 5
300 <= avg_daily_spend_3d < 1000 => avg * 6
avg_daily_spend_3d >= 1000       => avg * 7
最终 clamp 到 150-10000
```

优点：

- 高消耗账号换卡次数更少。

缺点：

- 高消耗账号资金占用更大。

### 后续可选策略 C：覆盖天数可配置

公式：

```text
amount = clamp(ceil(avg_daily_spend_3d * cover_days), 150, 10000)
```

默认：

- `cover_days = 5`
- UI 可选择 3 天、5 天、7 天。

优点：

- 用户容易理解为“这张卡预计够用几天”。

缺点：

- UI 多一个配置项，用户可能需要理解策略差异。

### 后续可选策略 D：结合最近峰值

公式：

```text
amount = clamp(ceil(max(avg_daily_spend_3d * 5, max_daily_spend_3d * 2)), 150, 10000)
```

优点：

- 避免某天消耗突然升高导致刚换卡又不够。

缺点：

- 异常峰值可能导致额度偏大。

### 推荐方案

第一版使用固定 5 倍日均消耗策略，并按 150 的倍数向上取整。UI 可以保留“额度策略”位置，但第一版不需要开放多策略切换。

## 7. 安全和授权门

以下动作必须有用户明确授权：

- 真实 EJH 开卡。
- OpenRouter 提交真实换卡/付款相关动作。
- OPOM 生产写 API。
- AdsPower 状态写回。
- 删除核心配置或运行数据。
- 生产部署或生产 `.env` 修改。

建议 UI 拆成三个独立控制：

1. `启动换卡监控`：只读取 OPOM 待换卡列表。
2. `自动创建 EJH 卡`：开启后才真实调用 Python 脚本创建 EJH 卡。
3. `开卡成功后自动进入 AdsPower 换卡绑定`：开启后才打开 OpenRouter 并保存新卡。

第一版可以默认：

- 监控可开启。
- 找到待换卡数据后自动执行开关默认关闭。
- 自动创建 EJH 卡开关默认关闭，避免误开真实卡。
- 开卡成功后自动进入 AdsPower 换卡绑定开关默认关闭。

## 8. 本地配置和页面结构

上方“本地配置”区域需要重新分组，所有配置项列名改为中文，避免直接展示难懂的英文环境变量名。每个配置项可以在帮助文本或 tooltip 中展示实际环境变量名。

### 8.1 公共参数

公共参数用于手动充值、自动充值、自动换卡共用：

- OPOM 地址，对应 `OPOM_BASE_URL`，默认 `http://20.2.209.2:3000`。
- OPOM 机器 token，对应 `OPOM_RECHARGE_TOKEN`。
- AdsPower API 地址，对应 `ADSPOWER_API_BASE`。
- AdsPower API Key，对应 `ADSPOWER_API_KEY`。
- AdsPower 启动超时时间。
- OPOM 请求超时、重试次数、写回重试次数、重试间隔。
- Python 命令，对应 `PYTHON`。
- 任务日志根目录：自动换卡任务需要展示 job id 和日志路径，该路径应可在本地配置中设置；默认值为当前苹果电脑桌面当天目录下的 `logs` 目录，即 `~/Desktop/<YYYY-MM-DD>/logs/`。
- 本地产物目录：自动换卡、EJH 开卡、自动充值结果和每日统计都写入解析后的当天产物目录；默认值为当前苹果电脑桌面当天目录，即 `~/Desktop/<YYYY-MM-DD>/`。
- 并发数量：从“开卡与执行范围”区域移动到本地配置中，作为执行层公共参数。

### 8.2 手动充值参数

手动充值参数只影响现有手动上传 CSV / Load OPOM group 后发起的充值任务：

- 固定充值金额默认值。
- 余额判断阈值。
- 余额补足目标值。
- Billing address / 地址池相关默认值。
- 是否成功后写回 OPOM 的默认值。

### 8.3 自动充值参数

自动充值参数只影响现有自动充值能力：

- 自动充值规则金额，默认 150。
- 自动充值触发阈值。
- 自动充值轮询间隔。
- 自动充值成功/失败后的处理策略。
- 自动充值结果 CSV 输出目录使用公共参数中的“本地产物目录”，并按天归档。

### 8.4 自动换卡参数

自动换卡参数只影响本 PRD 的新能力：

- 是否启动换卡监控。
- 找到待换卡数据后是否自动执行。
- 是否自动创建 EJH 卡。
- 开卡成功后是否自动进入 AdsPower 换卡绑定。
- OPOM 待换卡列表查询间隔，单位分钟，只允许填写正整数，默认 `18`。
- OPOM 待换卡列表 group，默认 `recharge`。
- OPOM 待换卡列表 status，默认 `needs_recharge`。
- OPOM 待换卡列表 limit，默认 50，最大 200。
- EJH 开卡卡类型 `cardType`。
- EJH supported MCC group，固定默认 `trv`。
- EJH 新卡有效期天数，例如 `3` 表示当前日期 3 天后。
- 额度策略，第一版固定为“过去 3 天平均日消耗 × 5，按 150 倍数向上取整”。
- 异常卡池展示/导出入口。
- 异常卡池中的卡不得再次自动绑定到原账号；系统只自动写文件记录。

### 8.5 自动换卡 UI 区域

- 自动换卡必须拥有独立页面区域，不能混在现有手动充值任务来源、规则与地址、开卡与执行范围中。
- 自动换卡区域至少展示：
  - 启动换卡开关。
  - 找到待换卡数据后自动执行开关。
  - 自动创建 EJH 卡开关。
  - 开卡成功后自动进入 AdsPower 换卡绑定开关。
  - 查询 OPOM 待换卡列表按钮。
  - 当前换卡任务 id。
  - 当前换卡任务日志路径。
  - 当前任务动态进度条。
  - 待换卡列表。
  - 开卡成功列表。
  - 开卡失败列表。
  - 异常卡池入口。
  - 今日统计摘要。
  - 最近一次 OPOM 查询时间和结果。

## 9. 状态设计

建议新增或复用以下状态：

- `queued`
- `opom_loaded`
- `matched`
- `card_amount_planned`
- `ejh_creating`
- `ejh_created`
- `browser_starting`
- `binding_card`
- `binding_verified`
- `opom_writeback_pending`
- `completed`
- `failed`
- `manual_security_blocker`
- `identity_mismatch`
- `opom_writeback_failed`
- `exception_card_pool`

失败需要区分：

- 可重试失败：AdsPower 被占用、CDP timeout、临时网络失败、OPOM 临时错误。
- 不可自动重试失败：身份不匹配、安全验证、EJH 开卡成功但绑定状态不明。
- EJH 开卡成功但 OpenRouter 绑定失败时，新卡进入 `exception_card_pool`，等待人工处理。

## 10. 数据字段

建议本地任务行包含：

- `replacement_job_id`
- `opom_account_id`
- `login_email`
- `ads_power_user_id`
- `ads_power_serial_number`
- `replacement_reason`
- `avg_daily_spend_3d`
- `max_daily_spend_3d`
- `amount_strategy`
- `suggested_card_amount`
- `final_card_amount`
- `ejh_order_no`
- `card_no`
- `card_last4`
- `expiry_month`
- `expiry_year`
- `replacement_status`
- `opom_writeback_status`
- `failure_reason`
- `automation_log_dir`
- `result_csv_path`
- `exception_card_pool_status`

敏感字段规则：

- CVV 只允许进入必要的执行内存和受控安全 CSV，不进入普通日志和 PRD 示例。
- token、cookie、session、API key、AK、验证码不得输出。
- EJH raw payload、`encryptedParam`、`rawResponse` 不进入普通 handoff。
- 卡号可按对账合同短期展示和结果输出。

## 11. 日志和排障

每个账号每个关键步骤都写结构化日志：

- step 名称
- 时间
- OPOM 请求摘要
- EJH 请求摘要和响应状态
- AdsPower 打开结果
- OpenRouter URL 和标题
- 页面关键文本摘要
- 最近网络失败
- ignored OpenRouter internal error
- 截图路径
- 失败状态和可重试建议

遇到这些情况必须停止自动推进：

- Stripe 3DS
- 银行验证
- CAPTCHA / hCaptcha / Cloudflare
- 短信/电话验证
- passkey-only 登录
- OPOM / AdsPower / OpenRouter 账号身份不一致
- EJH 开卡成功但绑定失败且卡状态不明
- EJH 开卡成功但绑定失败时，必须写入异常卡池并展示给人工处理。
- 进入异常卡池的卡不允许再次自动绑定到原账号；系统只写入异常卡池记录和 CSV 文件。

## 12. 验收标准

- 页面存在“启动换卡”开关。
- 页面存在独立的“自动换卡”区域，与手动充值/自动充值明显区分。
- 页面存在“查询 OPOM 待换卡列表”按钮。
- 页面存在“找到待换卡数据后自动执行”开关。
- 页面存在“自动创建 EJH 卡”开关，关闭时不得调用 Python 开卡脚本。
- 开关开启后可以读取 OPOM 待换卡列表。
- 系统能展示待换卡账号、AdsPowerId、过去 3 天消耗和建议开卡额度。
- 额度计算满足最低 150、最高 10000，且按 150 的倍数向上取整。
- 第一版默认额度策略为“过去 3 天平均日消耗 × 5，按 150 倍数向上取整”。
- EJH 开卡脚本/适配器参数与官方文档校验一致。
- 成功开卡后能生成本项目可分配的安全卡 CSV。
- 成功换卡后能写回 OPOM。
- 换卡写回 OPOM 逻辑与现有充值任务写回逻辑保持一致。
- OPOM 写回失败时任务不标记为完整完成。
- 失败行有明确状态、原因、日志和截图。
- EJH 开卡成功但 OpenRouter 绑定失败时，新卡进入异常卡池。
- 异常卡池支持导出 CSV。
- 每出现一张异常卡，系统自动在解析后的当天产物目录中新增一个异常卡 CSV 文件，不需要用户手动导出。
- 异常卡池中的卡不会再次自动绑定到原账号。
- AdsPower 被占用、CDP timeout、临时网络失败支持单行重试。
- 日志和 CSV 不泄露 CVV、token、cookie、session、API key、AK。
- 遇到安全验证不绕过，保留现场等待人工处理。
- 自动换卡任务与现有充值任务完全分开，包含独立任务 id、日志路径、列表和执行队列。
- 上方本地配置区按公共参数、手动充值参数、自动充值参数、自动换卡参数分区展示，配置项列名为中文。
- 并发数量位于上方本地配置中。
- 自动换卡任务 id 和日志路径可在页面中看到，日志根目录可在本地配置中配置。
- 自动换卡任务日志根目录默认值为当前苹果电脑桌面当天目录下的 `logs` 目录。
- 本地产物目录可在本地配置中配置，系统解析出当天产物目录；默认值为当前苹果电脑桌面当天目录。
- EJH 开卡成功和失败都分别生成列表和 CSV 文件，并写入解析后的当天产物目录。
- 每一次自动充值完成后都生成新的结果 CSV，至少包含 Gmail 邮箱、AdsPower 编号、AdsPowerId、银行卡号、EJH 订单号、OPOM 账号、充值金额、余额前后、状态、写回状态和日志路径。
- 页面展示今天创建卡数、开卡成功/失败数、异常卡数、自动充值账户数，以及对应明细。
- 自动充值和自动换卡执行时展示动态进度条，粗略百分比即可。
- 开卡成功后是否自动进入 AdsPower 换卡绑定由独立开关控制，关闭时只创建卡和归档，不自动打开浏览器进入下一步。

## 13. 已确认实现约束

- OPOM 待换卡列表接口使用 `GET /api/v1/recharge/accounts`。
- OPOM 队列接口已返回过去 3 天每日消耗 `usageLast3Days`。
- 第一版额度策略采用固定 5 倍日均消耗。
- 额度向上取整到 150 的倍数。
- `cardType` 从本地配置读取。
- OpenRouter 业务的 `supportedMccGroup` 使用 `trv`。
- 新卡默认有效期使用本地配置中的数字天数，例如 `3` 表示当前日期 3 天后的日期。
- `useTime=1`，确认使用多次卡。
- 自动换卡和现有充值完全分开。
- 自动创建 EJH 卡由独立开关控制，开启后才调用 `ejh_create_cards.py`。
- EJH 开卡参数全部来自本地配置和本次额度计算，不要求用户在执行时重复输入。
- EJH 开卡成功但 OpenRouter 绑定失败时，新卡进入异常卡池。
- EJH 开卡失败也进入失败列表，并生成开卡失败 CSV。
- 写回 OPOM 跟现有充值任务一样的逻辑。
- 换卡成功后，本项目不额外处理旧卡；按现有 OPOM 写回和 OPOM 侧逻辑走。
- OPOM 待换卡列表查询间隔由本地配置控制，单位分钟，整数。
- OPOM 待换卡列表查询间隔默认 `18` 分钟。
- 找到待换卡数据后自动执行、自动创建 EJH 卡、开卡成功后自动进入 AdsPower 换卡绑定三个开关默认关闭。
- 异常卡池支持导出 CSV；每进入一张异常卡都自动生成单卡 CSV。
- 异常卡池中的卡不允许再次自动绑定到原账号。
- 自动换卡任务日志根目录默认 `~/Desktop/<YYYY-MM-DD>/logs/`。
- 自动充值最终产物写入配置好的本地产物目录，按天归档；本地产物目录默认 `~/Desktop/<YYYY-MM-DD>/`。

## 14. 已确认默认值

1. 自动换卡监控轮询间隔默认 `18` 分钟。
2. “找到待换卡数据后自动执行”开关默认关闭。
3. “自动创建 EJH 卡”开关默认关闭。
4. “开卡成功后自动进入 AdsPower 换卡绑定”开关默认关闭。
5. 异常卡池需要支持导出 CSV。
6. 每出现一张异常卡，系统都要在解析后的当天产物目录中自动新增一个单卡异常 CSV 文件，不需要人工手动导出。
7. 异常卡池中的卡不允许再次自动绑定到原账号，只能写入异常卡池文件和列表，后续由人工决定如何处理。
8. 自动换卡任务日志根目录默认值为当前苹果电脑桌面按 Asia/Shanghai 日期创建的目录下的 `logs` 目录，例如 `~/Desktop/2026-06-24/logs/`。
9. 本地产物目录默认值为当前苹果电脑桌面按 Asia/Shanghai 日期创建的目录，例如 `~/Desktop/2026-06-24/`。
