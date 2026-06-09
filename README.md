# OpenRouter Recharge Runner

Local Web console and deterministic Node.js worker for OpenRouter card binding,
no-purchase testing, validation recharge, and Auto top-up configuration through
AdsPower/CDP.

This project is intended to run on the same machine as AdsPower Local API. It is
not a SaaS service and does not use an LLM during production execution.

## Features

- Upload CSV or pull OPOM rows, then run automatic preflight before any browser
  automation starts.
- Pull OPOM `recharge` group accounts into a canonical local CSV through a
  machine API.
- Match OPOM accounts to AdsPower profiles through the AdsPower Local API
  without launching browsers.
- Process AdsPower profiles sequentially with a single worker.
- Bind or replace OpenRouter payment cards.
- Add billing address when the account requires it.
- Configure and read back Auto top-up.
- Prepare Purchase Credits amount in no-purchase test mode without clicking
  `Purchase`.
- Record job rows, events, and sanitized result CSVs in SQLite-backed local
  storage.
- Optionally write completed card bindings and per-row execution results back to
  OPOM when `opomWriteback` is enabled.
- Optionally write AdsPower execution state after each row through explicit
  `group_move`, `remark_append`, or `remark_append_v2` modes.
- Mask sensitive values in UI, logs, and result CSVs.

## Safety Boundaries

- The API server binds to `127.0.0.1`.
- All API calls require a local session token after page load.
- Execution requires an automatic preflight confirmation tied to the exact CSV,
  options, and purchase submission mode.
- No-purchase mode fills the purchase form but does not submit payment.
- Switching between no-purchase and Live Run invalidates the prior preflight
  confirmation; the next execution attempt runs preflight again.
- CVV, cookies, sessions, passwords, API keys, and raw browser
  storage must not be committed or shown in logs/results.
- Runtime files under `data/` are ignored except `.gitkeep` placeholders.
- OPOM writeback requires `OPOM_BASE_URL` and `OPOM_RECHARGE_TOKEN`.
- AdsPower status writes are disabled by default because the user waived this
  authorization gate. Result CSVs still record the waived status. Enable writes
  later only with explicit mode/group configuration.

## Quick Start

```bash
npm run check
npm test
npm start
```

Then open:

```text
http://127.0.0.1:4100
```

## CSV Template

Use [openrouter-recharge-input-template.csv](./openrouter-recharge-input-template.csv)
as the input shape. Replace placeholder values at runtime only; do not commit
real card numbers, CVV, or account credentials.

Required columns:

```csv
status,ID,username,amount,card_number,exp_month,exp_year,cvv,postal_code
```

Optional billing columns:

```csv
holder_name,country,address_line1,city,state
```

Optional balance-rule columns:

```csv
balance_threshold,amount_below_threshold,amount_at_or_above_threshold
```

Required Auto top-up columns for executable rows:

```csv
auto_topup_threshold,auto_topup_amount
```

Canonical OPOM-driven rows may use the newer field names:

```csv
opom_account_id,login_email,ads_power_user_id,ads_power_serial_number,opom_health_status,opom_health_reason,order_no,card_no,amount
```

The legacy `ID,username,card_number` columns remain supported for existing CSV
workflows. If `opom_health_status` is present and is not `ok`, dry-run blocks
that row before AdsPower or OpenRouter automation starts.

## OPOM Integration

Set:

```bash
export OPOM_BASE_URL="https://opom.example.internal"
export OPOM_RECHARGE_TOKEN="..."
```

The local console `Load OPOM group` button calls OPOM
`/api/v1/recharge/accounts` for `group=recharge`, converts the response into a
canonical CSV, and reuses the existing automatic preflight/live confirmation
flow. A live job writes OPOM only when job options include `opomWriteback`;
ordinary CSV jobs remain local-only.

For rows carrying `opom_account_id`, confirmed purchase mode requires
`opomWriteback=true` before preflight will mark the row ready. No-purchase mode
can still be used for local validation, but a real OPOM-sourced recharge is not
allowed to reach `completed` without OPOM card/result writeback.
OPOM card binding writeback requires an EJH `order_no`, card number, and card
expiration (`exp_month`/`exp_year` or equivalent allocation output); rows
missing those fields fail before any OPOM write request is sent.

The OPOM queue excludes accounts blocked by Credits 401 from executable
`needs_recharge` and `failed_retryable` queues. `status=all` can still display
them with `opom_health_status` and `opom_health_reason` for operator review.
If OPOM returns a `nextCursor`, use `Load next page` to append the next queue page;
the operator console keeps `opom_health_status` and `opom_health_reason` in the
regenerated canonical CSV after AdsPower matching and card allocation.

Before clicking `Load OPOM group`, the operator can enter this run's recharge
defaults:

- fixed `amount`, or the balance-rule set
  `balance_threshold,amount_below_threshold,amount_at_or_above_threshold`
- `auto_topup_threshold` and `auto_topup_amount`
- default billing address fields

Per-account billing address overrides can be pasted as CSV:

```csv
opom_account_id,login_email,holder_name,country,postal_code,address_line1,city,state
acct_1,user@example.com,Example User,US,97001,1 Main St,Portland,OR
```

Rows match by `opom_account_id` first, then `login_email`. Mapping values
override the default billing address before preflight validation.

## EJH Card Creation

`ejh_create_cards.py` keeps the original interactive mode and now also supports
non-interactive safe CSV output:

```bash
EJH_APP_KEY="..." EJH_APP_SECRET="..." \
python3 ejh_create_cards.py --non-interactive \
  --count 10 --amount 20 --active-date 2026-12-31 \
  --cardholder recharge-20260607 --output data/results/ejh_cards.csv
```

By default the output uses the safe card batch schema and omits legacy raw fields
such as encrypted request payloads and raw provider responses. Use
`--unsafe-raw-output` only for local diagnostics.

The local console can also allocate cards from a pasted safe EJH CSV. The
allocation step maps completed card rows one-to-one onto OPOM canonical rows and
then regenerates the executable recharge CSV. Real EJH creation from the console
requires an explicit browser confirmation and still writes the safe CSV first.

## AdsPower Status Writeback

AdsPower status writeback is opt-in through job options or environment:

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

Before choosing group targets, list the current AdsPower groups from the local
runner machine or click `Discover groups` in the operator console:

```bash
npm run adspower:status-targets -- --json
```

This is a read-only discovery command. It calls AdsPower
`/api/v1/group/list`, shows configured target resolution and candidate groups,
and prints suggested `ADSPOWER_*_GROUP_ID` exports when it can infer a match. It
does not call regroup, profile update, remark update, OPOM writeback, EJH card
creation, or OpenRouter automation. The console `Discover groups` button uses
the same server module and current target fields, then renders the resolved
targets and candidates locally for operator review. `Use discovered targets`
only fills the local `group_move` target inputs with `id:<group_id>` values; it
does not write AdsPower state.

Supported modes:

- `disabled`: default after the user waived AdsPower status writeback; result
  CSV records `adspower_tag_status=skipped_user_waived`,
  `adspower_status_target=waived_by_user`.
- `group_move`: calls AdsPower Local API `/api/v1/user/regroup` after row
  completion, using success/failure/blocker group targets. Targets may be raw
  group ids, `id:<group_id>`, `name:<exact group name>`, or the
  `ADSPOWER_*_GROUP_NAME` environment variables. Name resolution uses
  `/api/v1/group/list` and only proceeds on one exact match.
- `remark_append`: appends a sanitized short execution status to the profile
  remark through AdsPower Local API `/api/v1/user/update`.
- `remark_append_v2`: appends the same sanitized execution status through
  AdsPower Local API `/api/v2/browser-profile/update`.

As of the 2026-06-07 implementation pass, the official Local API documentation
lists profile update `/api/v1/user/update` with a `remark` field and the V2
profile update `/api/v2/browser-profile/update` with a `remark` field; it also
documents profile group movement through `/api/v1/user/regroup`, but does not
expose a confirmed dedicated tag-write endpoint. The current references are:

- [Update Profile Info](https://localapi-doc-en.adspower.com/docs/GMvym2)
- [Update Profile Info V2](https://localapi-doc-en.adspower.com/docs/Update-Profile-Info-V2)
- [Move Profile](https://localapi-doc-en.adspower.com/docs/bEfrZV)
- [Query Profile](https://localapi-doc-en.adspower.com/docs/u8m2Ie)

Treat both remark modes as operational status markers, not as native AdsPower
tags. The CSV column remains named `adspower_tag_status` for
compatibility with the original PRD, but its value describes the configured
status writeback mode.

AdsPower status writeback failures do not mark the recharge row failed; the row
result keeps the recharge outcome and records `adspower_tag_status=failed` for
manual follow-up. Result CSVs also include `adspower_status_mode`,
`adspower_status_target`, and `adspower_status_reason` so operators can
distinguish waived, skipped, regrouped, remark-updated, and failed status
writes. Example targets are `waived_by_user`, `group:success:<group_id>`,
`group:failure:<group_id>`, `group:blocker:<group_id>`, `remark:v1`, and
`remark:v2`.

## Result CSV / Feishu Handoff

Every job writes a sanitized result CSV under `data/results/`. This is the
temporary handoff for Feishu before direct API integration. The header is kept
unique so spreadsheet tools and Feishu imports do not need to disambiguate
duplicate column names.

Stable handoff columns include:

```csv
run_id,row_number,opom_account_id,profile_id,ads_power_user_id,ads_power_serial_number,username,login_email,opom_health_status,opom_health_reason,ejh_order_no,cardno,task_status,task_message,purchase_status,purchase_amount,balance_before,balance_after,card_last4,auto_topup_status,auto_topup_threshold,auto_topup_amount,opom_card_writeback_status,opom_result_writeback_status,adspower_tag_status,adspower_status_mode,adspower_status_target,adspower_status_reason,completion_evidence_status,completion_evidence_missing
```

The result CSV may contain the full short-lived card number in `cardno` for
offline reconciliation. It must not contain CVV, cookies, sessions,
OpenRouter keys, or raw EJH diagnostic payloads. Formula-like cells beginning
with `=`, `+`, `-`, or `@` are prefixed with `'` before CSV export so spreadsheet
imports do not evaluate operator-controlled text as formulas.
Use `completion_evidence_status` for Feishu/manual review:
`production_complete` means the row has the verified purchase evidence,
Auto top-up readback evidence (`updated` or `unchanged`), AdsPower status
writeback evidence or explicit `skipped_user_waived` evidence, and for
OPOM-sourced rows, OPOM card/result writeback evidence;
`test_mode_complete` means no-purchase rehearsal only; `incomplete` lists the
missing evidence keys in `completion_evidence_missing`.
Rows skipped because the source CSV already marked them completed are exported
with `task_status=skipped`, not `completed`, so old tracker state cannot be
misread as proof of a new recharge run.

To verify the Feishu handoff contract locally:

```bash
npm run smoke:feishu
```

The smoke test generates a temporary result CSV with formula-like source values,
then verifies unique headers, stable handoff columns, account data, full
`cardno` output, completion evidence, and no CVV or raw diagnostic columns.

To scan user-facing docs/templates and production scripts for accidental card,
CVV, token, OpenRouter key, or raw EJH diagnostic literals:

```bash
npm run audit:sensitive
```

The audit allows explicit fake fixtures under local smoke tests and unit tests,
but fails if those values appear in documentation, templates, public UI assets,
or production code paths.

## Production Preflight

Before production deployment or live validation, run the local read-only
preflight:

```bash
npm run preflight:production
```

It checks required local files, AdsPower Local API reachability, OPOM/EJH
environment variable presence, the current absence of a documented native
AdsPower tag-write endpoint, the user-waived AdsPower status writeback state,
and the live-payment safety boundary. It does not call OPOM write APIs, does
not create EJH cards, and does not start OpenRouter browser automation.
When `ADSPOWER_STATUS_MODE=group_move`, the preflight also reads AdsPower
`/api/v1/group/list` once and resolves any `name:<exact group name>` or
`ADSPOWER_*_GROUP_NAME` targets before live work. Raw `id:<group_id>` targets
are accepted as explicit operator-provided IDs.

To also verify the OPOM machine token and queue endpoint, explicitly opt into
the read check:

```bash
npm run preflight:production -- --with-opom-read --marker-file ./var/production-preflight-marker.json
```

That call reads `GET /api/v1/recharge/accounts?group=recharge&status=needs_recharge&limit=1`.
It may create a normal OPOM read audit log, but it does not write card bindings,
run results, or recharge facts.
When it passes against production, keep the generated marker file and pass it
to `audit:completion`:

```bash
npm run audit:completion -- --preflight-marker ./var/production-preflight-marker.json
```

The marker file records the read-only verification timestamp, OPOM base URL,
group, and sanitized check summaries. It does not store the OPOM token, card
numbers, CVV, cookies, or raw EJH diagnostic payloads.
For temporary shell-only verification, the older environment-marker path is
also supported:

```bash
export OPOM_PRODUCTION_RECHARGE_API_VERIFIED=true
export OPOM_PRODUCTION_PREFLIGHT_PASSED_AT="<timestamp from preflight output>"
```

To validate a candidate execution CSV before live work, include `--csv`:

```bash
npm run preflight:production -- --csv /path/to/recharge-candidate.csv
```

The CSV gate is still read-only. It parses the file through the same dry-run
contract used by the runner, fails if there are no ready rows or any
`missing_fields` rows, and rejects EJH raw diagnostic columns such as
`encryptedParam`, `requestPayload`, and `rawResponse`. The preflight output only
shows row counts and blocked row numbers; it does not print card numbers, CVV,
or raw payload values.

For local development without production integrations:

```bash
npm run preflight:production -- --no-opom --no-ejh --no-ads
```

To audit the end-to-end goal contract without writing to production systems:

```bash
npm run audit:readiness
```

This maps the requested 0-9 flow to local evidence: OPOM queue intake,
operator confirmation, AdsPower matching, recharge rules and billing mapping,
EJH safe card allocation, closed-loop OpenRouter execution, OPOM writeback,
AdsPower status handling, Feishu CSV handoff, bank reconciliation ownership,
and safety gates. `pending_manual_ops`,
`pending_opom_production_deploy`, and other
pending statuses are intentional non-failures: they mean the local code is
ready but the live operation still requires operator work or explicit
production authorization. AdsPower status writeback is currently recorded as
user-waived rather than pending.

To prove the overall objective is actually complete, use the stricter gate:

```bash
npm run audit:completion
```

This uses the same evidence matrix but exits non-zero while any
`pending_manual_ops`, `pending_opom_production_deploy`, or other pending
requirement remains. It is
meant to prevent a local MVP from being mistaken for a completed production
recharge closed loop.
The OPOM production item only clears when a recent preflight marker from a
successful read-only `preflight:production -- --with-opom-read` run is provided,
or when production base URL/token are configured together with a recent
`OPOM_PRODUCTION_PREFLIGHT_PASSED_AT` timestamp.

To print the production launch checklist without writing to any external
system:

```bash
npm run checklist:launch
```

This command summarizes the readiness audit, remaining pending items,
authorization gates, required verification commands, and the first operational
sequence. It exits non-zero only when a readiness item has failed; pending
manual/external items remain visible but do not fail the checklist.

For the production deployment, first-use validation, and rollback sequence, use
[docs/recharge-production-runbook.md](./docs/recharge-production-runbook.md).

To smoke-test a running local operator console without touching external
systems, start the server and run:

```bash
npm run smoke:local -- --base http://127.0.0.1:4100
```

The smoke test checks `/api/health`, local session auth, `/api/preflight`,
preflight behavior, an all-blocked job, and the downloadable result CSV. It uses a
missing-amount row so no browser automation, OPOM writeback, EJH card creation,
or AdsPower status write can run.

To check the operator console selector contract and required controls:

```bash
npm run smoke:ui -- --base http://127.0.0.1:4100
npm run smoke:ui:opom-flow -- --base http://127.0.0.1:4100
npm run smoke:ui:identity-mismatch -- --base http://127.0.0.1:4100
```

This verifies that the served HTML, JS, and CSS are reachable, every
`document.querySelector('#...')` target used by `app.js` exists in the page, and
the OPOM, AdsPower, EJH card allocation, automatic preflight/live execution, and
result CSV controls are present. The OPOM browser smokes also exercise the
happy-path `Load OPOM group -> Match AdsPower -> Allocate cards -> automatic
preflight` flow and the `identity_mismatch` path where preflight must block live
execution.

For a complete local integration gate across Recharge and OPOM, keep the local
Recharge server running and execute:

```bash
npm run verify:integration -- --base http://127.0.0.1:4100
```

This command runs the Recharge API/UI smoke tests, Recharge syntax checks and
unit tests, OPOM temporary-SQLite `db:push`, OPOM production build,
typecheck/lint, OPOM Recharge route/import/migration tests, and both worktree
whitespace checks. It restores OPOM `next-env.d.ts` if `next build` rewrites the
generated route-type reference. It does not write OPOM production data, create
EJH cards, start browser automation, or write AdsPower state.

## Development

The browser automation engine lives in `src/automation/`; the Web/API/worker
layer lives in `src/server/` and `public/`.

The runner no longer imports from or executes the Codex
`openrouter-recharge` skill directory at runtime.
