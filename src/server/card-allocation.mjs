import {mkdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import * as csv from '../automation/lib/csv.mjs';
import {RESULT_DIR} from './config.mjs';
import {createCardsWithEjh} from './card-provider-ejh.mjs';
import {canonicalCsvFromRows} from './opom-orchestrator.mjs';

const RAW_EJH_FIELDS = new Set(['requestPayload', 'encryptedParam', 'rawResponse']);
const DEFAULT_BILLING_FIELDS = ['postal_code', 'holder_name', 'country', 'address_line1', 'city', 'state'];

export function cardAllocationEligibleRows(rows = []) {
  return rows
    .map((row, index) => ({row, index}))
    .filter(({row}) => {
      const opomAccountId = row.opom_account_id || row.opomAccountId;
      const matchStatus = row.ads_match_status || row.adsMatchStatus || '';
      if (!opomAccountId && !matchStatus) return true;
      return matchStatus === 'matched';
    });
}

function trimObject(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, String(value ?? '').trim()]));
}

function firstValue(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (value) return value;
  }
  return '';
}

function normalizeYear(value) {
  const text = String(value || '').trim();
  if (/^\d{4}$/.test(text)) return text.slice(-2);
  return text;
}

function expiryParts(row) {
  const month = firstValue(row, ['expiry_month', 'exp_month']);
  const year = normalizeYear(firstValue(row, ['expiry_year', 'exp_year']));
  if (month || year) return {month, year};
  const validityDate = firstValue(row, ['validityDate', 'validity_date', 'expiry', 'expires', 'expires_at']);
  const compact = validityDate.replace(/\D/g, '');
  if (/^\d{4}$/.test(compact)) {
    return {month: compact.slice(0, 2), year: compact.slice(2, 4)};
  }
  if (/^\d{6}$/.test(compact)) {
    return {month: compact.slice(0, 2), year: compact.slice(-2)};
  }
  return {month: '', year: ''};
}

export function parseSafeCardCsv(cardCsvText = '') {
  const parsed = csv.parseCsv(cardCsvText);
  if (parsed.length < 2) return [];
  const header = parsed[0].map((key) => String(key || '').trim());

  return parsed.slice(1).map((line, index) => {
    const source = trimObject(csv.rowObject(header, line));
    const status = firstValue(source, ['open_status', 'success', 'status']);
    const completed = ['completed', 'true', 'success', 'ok'].includes(status.toLowerCase());
    const cardNo = firstValue(source, ['card_no', 'cardNo']);
    const expiry = expiryParts(source);
    return {
      sourceRowNumber: Number(source.row_number || source.index || index + 1),
      completed,
      openStatus: status,
      orderNo: firstValue(source, ['order_no', 'orderNo']),
      cardNo,
      expMonth: expiry.month,
      expYear: expiry.year,
      cvv: firstValue(source, ['cvv', 'cvvPassword']),
      postalCode: firstValue(source, ['postal_code', 'postalCode']),
      last4: source.pan_last4 || cardNo.slice(-4),
      errorCode: firstValue(source, ['error_code', 'code', 'raw_provider_code']),
      errorMessage: firstValue(source, ['error_message', 'msg']),
    };
  });
}

function validateUsableCard(card) {
  const missing = [];
  if (!card.completed) missing.push('open_status');
  if (!card.orderNo) missing.push('order_no');
  if (!card.cardNo) missing.push('card_no');
  if (!card.expMonth) missing.push('expiry_month');
  if (!card.expYear) missing.push('expiry_year');
  if (!card.cvv) missing.push('cvv');
  return missing;
}

export function allocateCardsToRows(rows = [], cardCsvText = '', defaults = {}) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('rows are required for card allocation');
  const eligibleRows = cardAllocationEligibleRows(rows);
  if (!eligibleRows.length) {
    throw new Error('No rows are eligible for card allocation; run AdsPower match first and resolve failed matches');
  }
  const cards = parseSafeCardCsv(cardCsvText);
  const usableCards = [];
  const rejectedCards = [];
  for (const card of cards) {
    const missing = validateUsableCard(card);
    if (missing.length) rejectedCards.push({...card, missing});
    else usableCards.push(card);
  }
  if (usableCards.length < eligibleRows.length) {
    throw new Error(`Not enough completed EJH cards for allocation: rows=${eligibleRows.length}, cards=${usableCards.length}`);
  }

  let cardIndex = 0;
  const eligibleIndexes = new Set(eligibleRows.map(({index}) => index));
  const allocatedRows = rows.map((row, index) => {
    if (!eligibleIndexes.has(index)) return {...row};
    const card = usableCards[cardIndex];
    cardIndex += 1;
    const next = {...row};
    next.order_no = card.orderNo;
    next.card_no = card.cardNo;
    next.exp_month = card.expMonth;
    next.exp_year = card.expYear;
    next.cvv = card.cvv;
    if (card.postalCode && !next.postal_code) next.postal_code = card.postalCode;
    for (const field of DEFAULT_BILLING_FIELDS) {
      if (!next[field] && defaults[field]) next[field] = defaults[field];
    }
    return next;
  });

  return {
    rows: allocatedRows,
    csvText: canonicalCsvFromRows(allocatedRows),
    summary: {
      requestedRows: rows.length,
      eligibleRows: eligibleRows.length,
      skippedNotMatched: rows.length - eligibleRows.length,
      inputCards: cards.length,
      allocated: eligibleRows.length,
      rejected: rejectedCards.length,
      firstRejected: rejectedCards[0] ? {
        rowNumber: rejectedCards[0].sourceRowNumber,
        missing: rejectedCards[0].missing,
        errorCode: rejectedCards[0].errorCode,
      } : null,
    },
    cards: usableCards.slice(0, eligibleRows.length).map((card, index) => ({
      index,
      sourceRowNumber: card.sourceRowNumber,
      orderNo: card.orderNo,
      last4: card.last4,
      openStatus: card.openStatus,
    })),
  };
}

function timestamp() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
}

export async function allocateCardsPayload(payload = {}) {
  let cardCsvText = String(payload.cardCsvText || '');
  let cardCsvPath = '';
  let ejhResult = null;

  if (payload.createCards) {
    if (!payload.confirmCreateCards) throw new Error('Real EJH card creation requires confirmCreateCards=true');
    const eligibleRows = cardAllocationEligibleRows(payload.rows || []);
    if (!eligibleRows.length) {
      throw new Error('No rows are eligible for EJH card creation; run AdsPower match first and resolve failed matches');
    }
    await mkdir(RESULT_DIR, {recursive: true});
    cardCsvPath = join(RESULT_DIR, `ejh_cards-${timestamp()}.csv`);
    ejhResult = await createCardsWithEjh({
      count: payload.count || eligibleRows.length,
      amount: payload.amount,
      activeDate: payload.activeDate,
      cardholder: payload.cardholder,
      cardBatchId: payload.cardBatchId,
      appKey: payload.ejhAppKey,
      appSecret: payload.ejhAppSecret,
      python: payload.python,
      output: cardCsvPath,
    });
    if (!ejhResult.ok) throw new Error(`EJH card creation failed: ${ejhResult.stderr || ejhResult.stdout || ejhResult.error || 'unknown error'}`);
    cardCsvText = await readFile(cardCsvPath, 'utf8');
  }

  if (!cardCsvText.trim()) throw new Error('cardCsvText is required unless createCards=true');
  const allocation = allocateCardsToRows(payload.rows || [], cardCsvText, payload.defaults || {});
  return {
    ok: true,
    cardCsvPath,
    ejhResult: ejhResult ? {
      ok: ejhResult.ok,
      success: ejhResult.result?.success,
      failed: ejhResult.result?.failed,
      csv: ejhResult.result?.csv || cardCsvPath,
    } : null,
    ...allocation,
  };
}
