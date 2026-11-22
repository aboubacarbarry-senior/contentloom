/**
 * RFC 4180 CSV, with the quirks of spreadsheets that merchandisers export from: a UTF-8 byte-order
 * mark, CRLF or LF line endings, semicolon delimiters (French Excel), and quoted fields containing
 * delimiters, quotes and newlines.
 */

export interface CsvOptions {
  /** Field delimiter; detected from the header line when omitted. */
  delimiter?: ',' | ';' | '\t';
  /** Skip lines that are empty or contain only delimiters. */
  skipEmpty?: boolean;
}

export class CsvError extends Error {
  constructor(message: string, readonly line: number) {
    super(`line ${line}: ${message}`);
    this.name = 'CsvError';
  }
}

export function detectDelimiter(text: string): ',' | ';' | '\t' {
  const firstLine = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  const count = (ch: string) => {
    let n = 0;
    let quoted = false;
    for (const c of firstLine) {
      if (c === '"') quoted = !quoted;
      else if (!quoted && c === ch) n++;
    }
    return n;
  };
  const scores = { ',': count(','), ';': count(';'), '\t': count('\t') } as const;
  if (scores['\t'] > scores[','] && scores['\t'] >= scores[';']) return '\t';
  return scores[';'] > scores[','] ? ';' : ',';
}

/** Parse into rows of fields. Throws CsvError on an unterminated quote. */
export function parseCsv(text: string, opts: CsvOptions = {}): string[][] {
  const src = text.replace(/^﻿/, '');
  const delim = opts.delimiter ?? detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;
  let line = 1;
  let quoteLine = 1;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
      quoteLine = line;
      continue;
    }
    if (c === delim) {
      row.push(field);
      field = '';
      fieldStarted = false;
      continue;
    }
    if (c === '\r' && src[i + 1] === '\n') continue;
    if (c === '\n' || c === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldStarted = false;
      line++;
      continue;
    }
    field += c;
    fieldStarted = true;
  }
  if (quoted) throw new CsvError('unterminated quoted field', quoteLine);
  if (field !== '' || fieldStarted || row.length) {
    row.push(field);
    rows.push(row);
  }
  return opts.skipEmpty === false ? rows : rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/** Parse with the first row as headers. Header names are trimmed; duplicates are an error. */
export function parseCsvObjects(text: string, opts: CsvOptions = {}): { headers: string[]; records: Record<string, string>[] } {
  const rows = parseCsv(text, opts);
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim());
  const seen = new Set<string>();
  headers.forEach((h, i) => {
    if (!h) throw new CsvError(`column ${i + 1} has no header`, 1);
    if (seen.has(h.toLowerCase())) throw new CsvError(`duplicate header "${h}"`, 1);
    seen.add(h.toLowerCase());
  });
  const records = rows.slice(1).map((r, idx) => {
    if (r.length > headers.length && r.slice(headers.length).some((f) => f.trim())) {
      throw new CsvError(`${r.length} fields but ${headers.length} headers`, idx + 2);
    }
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => (rec[h] = (r[i] ?? '').trim()));
    return rec;
  });
  return { headers, records };
}

function quote(field: string, delim: string): string {
  if (field === '') return '';
  const needs = field.includes(delim) || /["\r\n]/.test(field) || /^\s|\s$/.test(field);
  // Neutralise spreadsheet formula injection: a cell starting with = + - @ is executed by Excel.
  const safe = /^[=+\-@]/.test(field) ? `'${field}` : field;
  return needs || safe !== field ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(headers: string[], records: Record<string, unknown>[], delimiter: ',' | ';' | '\t' = ','): string {
  const lines = [headers.map((h) => quote(h, delimiter)).join(delimiter)];
  for (const r of records) {
    lines.push(
      headers
        .map((h) => {
          const v = r[h];
          if (v === null || v === undefined) return '';
          return quote(typeof v === 'object' ? JSON.stringify(v) : String(v), delimiter);
        })
        .join(delimiter),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
