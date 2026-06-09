# agents.md - Auto-Purchase-for-OR 工作规则

本目录只作为 OpenRouter 充值批量输入、结果文件和相关说明材料的工作区。
充值、绑卡、验证购买、Auto top-up 配置的执行规则，以当前安装的
`openrouter-recharge` skill 为准。

遇到无关请求时，说明本目录只处理 OpenRouter 充值 CSV 准备、充值闭环执行
和 `openrouter-recharge` skill 维护。

## 1. 必须使用的 skill

所有 OpenRouter 充值、换卡、账单地址、验证购买、Auto top-up、结果 CSV
任务，必须先读取并遵循：

```text
~/.codex/skills/openrouter-recharge/SKILL.md
```

正式执行真实充值前，还必须读取：

```text
~/.codex/skills/openrouter-recharge/references/standard-operation-manual.md
```

如果本机 skill 路径不同，先在当前 Codex skill 列表或 `$CODEX_HOME/skills`
下定位 `openrouter-recharge`，不要硬编码某台电脑的绝对路径。

该 skill 是充值流程唯一执行入口。不得绕过其中的安全边界、状态合同和
脚本约定。

参考资料只允许用于理解相邻流程，不得混入充值闭环：

- `create-ora-from-proton-with-ads`：账号创建。
- `create-openrouter-api-key-from-ads`：API key 创建。
- `openrouter-recharge`：充值、换卡、Auto top-up。

除非用户明确切换任务，不得把账号创建、API key 创建、退款、发票截图或
AK 写回混入充值流程。

## 2. 触发语义

以下请求触发本项目充值流程：

- 用户提供 CSV 附件并要求批量充值、换卡、设置 Auto top-up。
- `给 XXX 账户充值 XX`。
- 其他明确要求为 OpenRouter 账号完成换卡 + 验证充值 + Auto top-up 的表达。

触发后按 `openrouter-recharge` skill 执行。

## 3. 数据来源

批量充值不再默认读取本目录的 `account.csv`。用户应在当前任务中提供 CSV
附件，Codex 使用附件落地后的真实路径执行：

```bash
node scripts/batch_recharge_openrouter_cards_cdp.mjs --dry-run --csv /path/to/attached-account.csv
node scripts/batch_recharge_openrouter_cards_cdp.mjs --csv /path/to/attached-account.csv
```

不得在没有用户提供 CSV 附件或明确 CSV 路径时，自动读取：

```text
本目录旧 account.csv
任何固定在某台电脑上的旧绝对路径
```

CSV 至少包含以下列：

```csv
status,ID,username,amount,card_number,exp_month,exp_year,cvv
```

可选余额规则列：

```csv
balance_threshold,amount_below_threshold,amount_at_or_above_threshold
```
可选Add billing address 列：

```csv
holder_name,country,postal_code,address_line1,city,state
```

可选 Auto top-up 列：

```csv
auto_topup_threshold,auto_topup_amount
```

字段含义：

- `status`：源表状态。已完成行会被跳过；脚本默认不覆盖源 CSV。
- `ID`：AdsPower profile 编号。
- `username`：期望登录的 OpenRouter 账号，必须与 Credits 页当前账号一致。
- `amount`：固定验证充值金额。若完整余额规则列存在，则余额规则优先。
- `card_number`、`exp_month`、`exp_year`、`cvv`：本次换入的新卡。
- `holder_name`、`country`、`postal_code`、`address_line1`、`city`、`state`：账单地址。
- `auto_topup_threshold`、`auto_topup_amount`：Auto top-up 显式配置值。


## 4. 标准闭环

批量模式必须先 dry-run：

1. 读取用户提供的 CSV 附件路径。
2. 运行 `--dry-run --csv <附件路径>`，只检查字段完整性和任务计划；不得打开浏览器。
3. 如果存在 `missing_fields`，先汇报缺失字段，不进入 live run。
4. 如果用户确认执行真实充值，运行 live batch。

每一行 live run 是一个闭环业务动作：

```text
打开 AdsPower profile
-> 进入 OpenRouter Credits
-> 校验已登录账号与 username 一致
-> 替换旧支付方式
-> 补齐 billing address
-> 保存新卡
-> 执行明确授权的 validation purchase
-> 验证余额增长
-> 配置并回读 Auto top-up
-> 写入新的 result CSV
```

不要把正常任务拆成“先绑卡、再充值”的两个用户入口。代码内部可以拆阶段，
但对操作者保持一次闭环命令。

批量脚本默认生成：

```text
<输入文件名>.result-<YYYYMMDD-HHMMSS>.csv
```

默认不覆盖用户提供的源 CSV。

## 4.1 执行效率规则

默认使用工程化快路径：

- 先 dry-run，一次性发现缺字段。
- live run 按行顺序执行，不按单个字段或单次点击逐次询问。
- 子流程输出保持简洁，最终汇报以结果 CSV 和汇总状态为准。
- 遇到普通失败行，按 skill 的 stop/continue 规则记录后继续。
- 遇到 `manual_security_blocker`，保留浏览器现场并停止批量。

用户已经明确要求执行充值且 CSV 中含完整金额或完整余额规则时，validation
purchase 属于本次闭环的一部分，不需要在每一行付款前重复询问。若用户只要求
dry-run、检查、预处理或未授权真实充值，则不得进入付款阶段。

## 5. 安全边界

- 不得绕过 CAPTCHA、Cloudflare、hCaptcha、Stripe 3DS、银行验证、短信/电话验证、风控、恢复流程或 passkey-only 登录。
- 不得输出CVV、密码、Cookie、Session、Token、TOTP seed、验证码、API key、AK。
- 日志和汇报只允许使用脱敏信息，例如AdsPower ID、卡片 last4、金额、状态、result CSV 路径。
- 卡号Cardno不属于敏感信息。
- 如果无法确认 AdsPower profile、OpenRouter 账号、付款卡片或金额匹配，必须停止该行并记录明确状态。

## 6. 状态合同

结果行只能使用 `openrouter-recharge` skill 定义的状态：

- `completed`
- `missing_fields`
- `login_required`
- `identity_mismatch`
- `payment_issue_card_declined`
- `manual_security_blocker`
- `purchase_unverified`
- `failed`

不要用自然语言状态替代这些枚举。不要因为看到旧交易、旧 invoice、余额页、AdsPower 标签，就推断本次充值完成。

## 7. 修改范围

允许修改：

- `~/.codex/skills/openrouter-recharge/` 下与本充值流程直接相关的脚本、模板或文档。
- 本项目中的说明性文件，例如本 `agents.md`。
- 用户明确提供的 CSV 附件副本或输出 result CSV。

禁止：

- 在没有用户明确授权时执行真实充值。
- 将敏感卡号、CVV、AK、Cookie、Session 写入文档、日志或最终回复。

## 8. 汇报要求

最终回复只说明：

- 本次做了什么。
- 使用了哪个用户提供的 CSV 路径。
- dry-run 或 live run 的汇总结果。
- 生成的 result CSV 路径。
- 哪些行需要人工处理，以及对应状态。

不得在最终回复中包含完整敏感凭据。
