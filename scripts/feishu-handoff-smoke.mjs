#!/usr/bin/env node
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseCsv, rowObject} from '../src/automation/lib/csv.mjs';
import {writeResultCsv} from '../src/server/automation-adapter.mjs';
import {redact} from '../src/server/redact.mjs';

const STABLE_COLUMNS = [
  'run_id',
  'row_number',
  'opom_account_id',
  'profile_id',
  'ads_power_user_id',
  'ads_power_serial_number',
  'username',
  'login_email',
  'opom_health_status',
  'opom_health_reason',
  'ejh_order_no',
  'card_no_last4',
  'task_status',
  'task_message',
  'purchase_status',
  'purchase_amount',
  'balance_before',
  'balance_after',
  'card_last4',
  'auto_topup_status',
  'auto_topup_threshold',
  'auto_topup_amount',
  'opom_card_writeback_status',
  'opom_result_writeback_status',
  'adspower_tag_status',
  'adspower_status_mode',
  'adspower_status_target',
  'adspower_status_reason',
  'completion_evidence_status',
  'completion_evidence_missing',
];

const SENSITIVE_PATTERN = /5257970000000001|,456,|card_number|^card_no$|cvv|requestPayload|encryptedParam|rawResponse/im;
const FORMULA_PATTERN = /(?:^|,|\r?\n)"?[=+\-@][^,\r\n"]*/;

const checks = [];
function add(label, ok, status = '') {
  checks.push({label, ok: Boolean(ok), status: String(status || (ok ? 'ok' : 'failed'))});
}

const dir = mkdtempSync(join(tmpdir(), 'or-runner-feishu-smoke-'));
try {
  const sourceCsvPath = join(dir, 'source.csv');
  const resultCsvPath = join(dir, 'result.csv');
  writeFileSync(sourceCsvPath, `status,opom_account_id,login_email,ads_power_user_id,ads_power_serial_number,opom_health_status,opom_health_reason,ads_match_status,order_no,amount,card_no,exp_month,exp_year,cvv,postal_code,auto_topup_threshold,auto_topup_amount
,acct_1,finance.owner@example.com,profile_1,1415,ok,=IMPORTXML("http://example.invalid"),matched,ejh_order_1,10,5257970000000001,06,28,456,97001,2,25
`, 'utf8');

  await writeResultCsv({
    csvPath: sourceCsvPath,
    resultCsvPath,
    runId: 'run_feishu_smoke',
    rowsByRawIndex: [{
      rawIndex: 0,
      status: 'completed',
      message: '+spreadsheet_formula_payload',
      details: {
        purchaseStatus: 'verified',
        purchaseAmount: '10',
        balanceBefore: '20',
        balanceAfter: '30',
        cardLast4: '0001',
        autoTopupStatus: 'updated',
        autoTopupThreshold: '2',
        autoTopupAmount: '25',
        opomCardWritebackStatus: 'written',
        opomResultWritebackStatus: 'written',
        adspowerTagStatus: 'skipped_user_waived',
        adspowerStatusMode: 'disabled',
        adspowerStatusTarget: 'waived_by_user',
        adspowerStatusReason: 'user_waived_status_writeback',
      },
    }],
  });

  const text = readFileSync(resultCsvPath, 'utf8');
  const parsed = parseCsv(text);
  const header = parsed[0] || [];
  const row = rowObject(header, parsed[1] || []);
  add('result CSV exists', text.length > 0, 'written');
  add('header columns are unique', new Set(header).size === header.length, `columns=${header.length}`);
  const missingColumns = STABLE_COLUMNS.filter((column) => !header.includes(column));
  add('stable Feishu handoff columns', missingColumns.length === 0, missingColumns.length ? `missing:${missingColumns.join(',')}` : 'present');
  add('source card secrets are not exported', !SENSITIVE_PATTERN.test(text), 'no_sensitive_fields');
  add('login email is plain text', row.login_email === 'finance.owner@example.com' && row.username === 'finance.owner@example.com', row.login_email || 'missing');
  add('card last4 only', row.card_last4 === '0001', row.card_last4 || 'missing');
  add('card_no_last4 is exported', row.card_no_last4 === '0001', row.card_no_last4 || 'missing');
  add('formula-like cells are escaped', !FORMULA_PATTERN.test(text), 'spreadsheet_safe');
  add('status is structured', row.task_status === 'completed' && row.purchase_status === 'verified', `${row.task_status}/${row.purchase_status}`);
  add('completion evidence is explicit', row.completion_evidence_status === 'production_complete', row.completion_evidence_status || 'missing');
  add('AdsPower status waiver is explicit', row.adspower_tag_status === 'skipped_user_waived' && row.adspower_status_target === 'waived_by_user', `${row.adspower_tag_status}/${row.adspower_status_target}`);
} catch (error) {
  add('Feishu handoff smoke exception', false, redact(error.message || 'unknown error'));
} finally {
  rmSync(dir, {recursive: true, force: true});
}

const failed = checks.filter((check) => !check.ok);
const result = {ok: failed.length === 0, failed: failed.length, checks};
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  for (const check of checks) {
    console.log(`${check.ok ? 'OK' : 'FAIL'} ${check.label}: ${check.status}`);
  }
  console.log(result.ok ? 'Feishu handoff smoke passed' : `Feishu handoff smoke failed: ${failed.length} check(s)`);
}
process.exitCode = result.ok ? 0 : 1;
