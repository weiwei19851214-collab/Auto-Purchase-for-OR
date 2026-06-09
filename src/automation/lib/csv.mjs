import {basename, dirname, extname, join} from 'node:path';

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((item) => item.some((cell) => cell !== ''));
}

export function csvEscape(value) {
  const text = spreadsheetSafeValue(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function spreadsheetSafeValue(value) {
  const text = String(value ?? '');
  if (!text || text.startsWith("'")) return text;
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

export function stringifyCsv(rows) {
  return `${rows.map((row) => row.map(csvEscape).join(',')).join('\r\n')}\r\n`;
}

export function rowObject(header, row) {
  return Object.fromEntries(header.map((key, index) => [key, row[index] ?? '']));
}

export function setCell(header, row, key, value) {
  let index = header.indexOf(key);
  if (index === -1) {
    header.push(key);
    index = header.length - 1;
  }
  while (row.length < header.length) row.push('');
  row[index] = value == null ? '' : String(value);
}

export function ensureColumns(header, columns) {
  for (const column of columns) {
    if (!header.includes(column)) header.push(column);
  }
}

export function padRows(rows, width) {
  for (const row of rows) {
    while (row.length < width) row.push('');
  }
}

export function defaultOutputCsv(inputCsv) {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  const ext = extname(inputCsv) || '.csv';
  const name = basename(inputCsv, ext);
  return join(dirname(inputCsv), `${name}.result-${stamp}${ext}`);
}
