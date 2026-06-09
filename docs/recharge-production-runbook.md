# Recharge x OPOM Production Runbook

This runbook is the operator checklist for taking the Recharge x OPOM
integration from local verification to production use. It intentionally does
not contain secrets, card numbers, CVV, cookies, session tokens, SSH passwords,
or OPOM admin passwords.

## Scope

Covered:

- OPOM production deployment preparation for `/api/v1/recharge/*`.
- Recharge local runner production-readiness checks.
- Read-only OPOM queue verification.
- No-purchase sandbox validation.
- Explicit authorization gates for EJH card creation, OPOM writeback,
  AdsPower status writeback, and OpenRouter live recharge.
- Rollback and stop points.

Not covered:

- Creating OpenRouter accounts.
- Creating OpenRouter API keys.
- Refund or appeal workflows.
- Bank statement reconciliation implementation changes. OPOM keeps owning bank
  statement import, reconciliation, and customer confirmation exports.

## Authorization Gates

Do not proceed past these gates without explicit user approval in the current
task:

1. `git push`.
2. OPOM production deployment.
3. Editing OPOM production `.env`.
4. Running OPOM production `db:push`.
5. Any OPOM production write API call beyond the documented read-only queue
   check.
6. Real EJH card creation.
7. OpenRouter live purchase submission.
8. Any future AdsPower status writeback through `group_move`, `remark_append`,
   `remark_append_v2`, or a native AdsPower tag API. This gate is waived for
   the current launch unless the user explicitly re-enables AdsPower writes.

## Local Release Gate

Run from `/Users/weiwei/project/Auto-Purchase-for-OR` while the local Recharge
server is running:

```bash
npm run verify:integration -- --base http://127.0.0.1:4174
```

This must pass before any production action. It verifies Recharge API/UI smoke,
Feishu result CSV handoff, goal readiness audit, launch checklist, sensitive
static audit, syntax checks, all Recharge tests, OPOM temporary-SQLite
`db:push`, OPOM production build, OPOM typecheck, OPOM lint, OPOM Recharge
route/import/migration tests, and whitespace checks.

The normal readiness audit can pass with pending manual or external items. To
prove the full objective is complete rather than merely locally ready, run:

```bash
npm run audit:completion
```

This stricter gate intentionally fails until all pending authorization,
operator, OPOM production deployment/read-verification, and external AdsPower
status-writeback items have been resolved. OPOM production verification is
marked complete only when the verification environment provides
either a recent preflight marker from a successful read-only OPOM queue read or
the shell-only marker variables
`OPOM_PRODUCTION_RECHARGE_API_VERIFIED=true` and
`OPOM_PRODUCTION_PREFLIGHT_PASSED_AT` together with an OPOM production base URL
and recharge API token.

For a concise machine-readable launch summary:

```bash
npm run checklist:launch
npm run checklist:launch -- --json
```

The checklist is read-only. It summarizes the readiness audit, remaining
pending items, required commands, explicit authorization gates, and the first
operational sequence.

If the Recharge server is not running, start it locally only in this project:

```bash
PORT=4174 npm start
```

Do not start the OPOM local service for this release path.

## OPOM Production Deployment Checklist

Use the OPOM production convention from
`/Users/weiwei/project/manager-openrouter/AGENTS.md`:

- Production URL: configure through `OPOM_BASE_URL`.
- Server: use the operator-approved OPOM production SSH host.
- Persistent checkout: `~/manager-openrouter/repo`.
- Shared runtime data: `~/manager-openrouter/shared`.
- Production `.env`: `~/manager-openrouter/shared/.env`.
- Production SQLite DB: `~/manager-openrouter/shared/dev.db`.
- Deploy script: `~/manager-openrouter/deploy.sh`.

Before deployment:

1. Confirm the local OPOM tree contains only intended Recharge integration
   changes.
2. Confirm local OPOM checks passed through `npm run verify:integration`.
3. Commit and push only after explicit authorization.
4. On the server, back up `~/manager-openrouter/shared/.env` and
   `~/manager-openrouter/shared/dev.db`.
5. Add `RECHARGE_API_TOKEN` to `~/manager-openrouter/shared/.env` through a
   secure channel. Do not paste it into logs or Git-tracked files.
6. Run `~/manager-openrouter/deploy.sh` only after push/deploy authorization.
7. Confirm the deployment preserved the shared `.env` and shared SQLite DB
   symlink/paths.

After deployment, run on the OPOM server or through the deployment shell:

```bash
cd ~/manager-openrouter/repo
npm run db:generate
npm run db:push
npm run build
npm run typecheck
npm run lint
npm test -- test/recharge-api-routes.test.ts test/admin-routes.test.ts test/setup-db-migration.test.ts
```

`scripts/setup-db.mjs` should add `Account.adsPowerUserId` and
`Account.adsPowerSerialNumber` incrementally. It must not replace production
account data.

## Read-Only Production Verification

From the Recharge local runner machine:

```bash
export OPOM_BASE_URL="https://opom.example.internal"
export OPOM_RECHARGE_TOKEN="<from secure channel>"
npm run preflight:production -- --with-opom-read --marker-file ./var/production-preflight-marker.json
```

After the OPOM read check passes, use the non-sensitive marker file for the
strict completion audit:

```bash
npm run audit:completion -- --preflight-marker ./var/production-preflight-marker.json
```

The marker file records only the verification timestamp, OPOM base URL, group,
and sanitized check summaries. It must not contain the OPOM token, card numbers,
CVV, cookies, or raw EJH diagnostic payloads.
For one-shell verification, the environment-marker path is also supported:

```bash
export OPOM_PRODUCTION_RECHARGE_API_VERIFIED=true
export OPOM_PRODUCTION_PREFLIGHT_PASSED_AT="<timestamp from preflight output>"
```

This check may create a normal OPOM read audit log for
`RECHARGE_ACCOUNTS_READ`. It must not call:

- `PUT /api/v1/recharge/accounts/:opomAccountId/card-binding`
- `POST /api/v1/recharge/runs/:runId/results`
- EJH card creation
- OpenRouter browser automation
- AdsPower status writeback

When `ADSPOWER_STATUS_MODE=group_move`, the same preflight reads AdsPower
`/api/v1/group/list` once and resolves exact group-name targets. It only checks
whether the configured success/failure/blocker targets are usable; it does not
call `/api/v1/user/regroup` or update profile remarks.

If AdsPower status writeback is explicitly re-enabled later,
`npm run adspower:status-targets -- --json` is the matching read-only discovery
step. It lists current AdsPower groups, resolves configured `ADSPOWER_*_GROUP_ID`
or `ADSPOWER_*_GROUP_NAME` values, and prints suggested env exports when a
candidate group is obvious. Prefer `name:<exact group name>` or
`ADSPOWER_*_GROUP_NAME` for operator readability; the preflight will still
verify that the name resolves to exactly one group before any live run can use
it. The operator console `Discover groups` button uses the same read-only
lookup against the current on-screen target fields, so operators can verify the
targets without switching to a terminal. `Use discovered targets` only copies
resolved or candidate group IDs into the local `group_move` form fields and
forces a new dry-run; it does not call AdsPower write endpoints.

If a candidate CSV already exists, validate it read-only:

```bash
npm run preflight:production -- --csv /path/to/recharge-candidate.csv
```

The CSV gate rejects missing fields and raw EJH diagnostic columns such as
`encryptedParam`, `requestPayload`, and `rawResponse`.

## First Operational Validation Sequence

Use this order after OPOM production read-only verification passes:

1. Operator prepares AdsPower profiles and moves eligible OPOM accounts into
   `group=recharge`.
2. In Recharge, click `Ready to recharge`.
3. Review the pending rows and OPOM health status.
4. Click `Match AdsPower`.
5. Enter this run's amount or balance rule, Auto top-up values, and any billing
   address mapping CSV.
6. Run dry-run and resolve all `missing_fields`, `identity_mismatch`, and
   AdsPower match failures.
7. Run no-purchase mode for one row. This may open AdsPower/OpenRouter and
   prepare the purchase form, but it must not click final Purchase.
8. Validate one expected `identity_mismatch` row if test data is available.
9. Validate one expected `manual_security_blocker` row only if a safe blocker
   scenario is available. Leave the browser open for manual inspection.
10. After explicit authorization, create the EJH card batch and verify the safe
    card CSV path.
11. After explicit authorization, run one small live recharge row.
12. Confirm the row has all completion evidence:
    OPOM account matched, AdsPower profile matched, OpenRouter account matched,
    new card binding written to OPOM, balance increase verified, Auto top-up
    readback matched, result CSV generated, and AdsPower status handling
    recorded.
    In the result CSV, `completion_evidence_status=production_complete` is the
    handoff signal for a real closed-loop row. `test_mode_complete` means a
    no-purchase rehearsal only, and `incomplete` must be resolved using
    `completion_evidence_missing`.
    OPOM-sourced rows in confirmed purchase mode must have OPOM writeback
    enabled before dry-run can mark them executable.

## AdsPower Status Handling

Default mode is `disabled` because the user waived AdsPower status writeback
for the current launch; result CSV records:

```text
adspower_tag_status=skipped_user_waived
adspower_status_target=waived_by_user
```

Use `group_move`, `remark_append`, or `remark_append_v2` only with explicit
authorization and configured group targets or remark policy. For `group_move`,
targets can be AdsPower group ids, `id:<group_id>`, `name:<exact group name>`,
or the `ADSPOWER_*_GROUP_NAME` environment variables; exact-name resolution
must resolve to one group before regrouping. Treat these as operational
markers, not native AdsPower tags. Do not claim native tag writeback until the
official AdsPower Local API exposes a confirmed tag-write endpoint.
Use `npm run adspower:status-targets -- --json` before production preflight
only when AdsPower status writeback is explicitly re-enabled. It discovers
group ids and verifies that configured target names are unambiguous; the
command is read-only and does not call regroup or profile update endpoints.
The result CSV records the concrete marker target in `adspower_status_target`,
for example `group:success:<group_id>`, `group:failure:<group_id>`,
`group:blocker:<group_id>`, `remark:v1`, or `remark:v2`.

## Rollback

If OPOM deployment fails before `db:push`:

1. Stop and do not run writeback or live recharge.
2. Re-run the previous deployed revision through the server deploy mechanism or
   restore the previous release according to OPOM operations practice.
3. Preserve logs and the failed build output.

If OPOM deployment fails after `db:push`:

1. Stop Recharge operations.
2. Preserve `~/manager-openrouter/shared/dev.db`.
3. Restore the pre-deploy SQLite backup only after explicit user approval.
4. Restore the pre-deploy `.env` backup if `RECHARGE_API_TOKEN` or other
   environment changes need to be removed.
5. Re-run OPOM read-only health checks before resuming.

If Recharge live execution fails:

1. Do not retry the same card after `payment_issue_card_declined`.
2. Stop the batch on `manual_security_blocker` and keep the browser state for
   manual inspection.
3. Use the generated result CSV and OPOM run-result audit to identify rows for
   manual handling.
4. Do not infer completion from old invoices, old transactions, Feishu manual
   state, or OPOM planning state.

## Completion Criteria

The integration is production-complete only when every required row can prove:

- OPOM account, AdsPower profile, and OpenRouter login identity match.
- EJH card allocation has an `orderNo` and only safe card CSV fields are used in
  normal handoff.
- OpenRouter payment card is replaced or bound.
- Billing address is present when required.
- Validation purchase balance increase is verified.
- Auto top-up threshold and amount are read back and match the requested values.
- OPOM-sourced confirmed purchase rows were executed with OPOM writeback
  enabled.
- OPOM card binding writeback succeeds.
- OPOM row result writeback succeeds.
- Result CSV is generated without CVV, cookies, sessions, tokens, AK,
  or raw EJH diagnostic payloads.
- AdsPower status writeback is either explicitly waived with
  `adspower_tag_status=skipped_user_waived` and
  `adspower_status_target=waived_by_user`, or written through an explicitly
  authorized operational mode (`group_move`, `remark_append`, or
  `remark_append_v2`) with the concrete `adspower_status_target` visible in the
  result CSV.
