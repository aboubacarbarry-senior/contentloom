import { tokenize } from './tokenize';

/**
 * Word-level diff (Myers' O(ND) algorithm) between the model's draft and what the reviewer approved.
 * Used for the review app's change view and for the "how much do reviewers edit" metric.
 */

export type DiffOp = { op: 'equal' | 'insert' | 'delete'; text: string };

/** Shortest edit script over two token sequences. Returns operations on token indices. */
export function myers<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean = (x, y) => x === y): { op: DiffOp['op']; aIndex: number; bIndex: number }[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && eq(a[x], b[y])) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  if (!found) trace.push(v.slice());
  // Walk the trace backwards to recover the path.
  const ops: { op: DiffOp['op']; aIndex: number; bIndex: number }[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const vv = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vv[offset + k - 1] < vv[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vv[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ op: 'equal', aIndex: x - 1, bIndex: y - 1 });
      x--;
      y--;
    }
    if (x === prevX) ops.push({ op: 'insert', aIndex: x, bIndex: y - 1 });
    else ops.push({ op: 'delete', aIndex: x - 1, bIndex: y });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ op: 'equal', aIndex: x - 1, bIndex: y - 1 });
    x--;
    y--;
  }
  return ops.reverse();
}

/** Diff two texts by words, spaces and punctuation; adjacent operations of the same kind are merged. */
export function diffWords(before: string, after: string): DiffOp[] {
  const a = tokenize(before).map((t) => t.text);
  const b = tokenize(after).map((t) => t.text);
  const raw = myers(a, b);
  const out: DiffOp[] = [];
  for (const r of raw) {
    const text = r.op === 'insert' ? b[r.bIndex] : a[r.aIndex];
    const last = out[out.length - 1];
    if (last && last.op === r.op) last.text += text;
    else out.push({ op: r.op, text });
  }
  return cleanupSemantic(out);
}

/**
 * Make diffs easier to read: a lone equal space between a delete and an insert is folded into both,
 * so "the [-red-] [+blue+] rug" reads as one replacement.
 */
function cleanupSemantic(ops: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = [];
  let del = '';
  let ins = '';
  let open = false;
  const flush = () => {
    if (del) out.push({ op: 'delete', text: del });
    if (ins) out.push({ op: 'insert', text: ins });
    del = '';
    ins = '';
    open = false;
  };
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    if (o.op === 'equal') {
      const next = ops[i + 1];
      // A space between two changes belongs to the change on both sides.
      if (open && /^\s+$/.test(o.text) && next && next.op !== 'equal') {
        del += o.text;
        ins += o.text;
        continue;
      }
      flush();
      const last = out[out.length - 1];
      if (last && last.op === 'equal') last.text += o.text;
      else out.push({ ...o });
    } else {
      open = true;
      if (o.op === 'delete') del += o.text;
      else ins += o.text;
    }
  }
  flush();
  return out;
}

export interface EditStats {
  wordsBefore: number;
  wordsAfter: number;
  wordsInserted: number;
  wordsDeleted: number;
  /** (inserted + deleted words) / words before, capped at 1. 0 means unchanged. */
  editRatio: number;
}

export function editStats(before: string, after: string): EditStats {
  const isWord = (s: string) => /[\p{L}\p{N}]/u.test(s);
  const a = tokenize(before).filter((t) => isWord(t.text)).map((t) => t.text.toLowerCase());
  const b = tokenize(after).filter((t) => isWord(t.text)).map((t) => t.text.toLowerCase());
  const ops = myers(a, b);
  const inserted = ops.filter((o) => o.op === 'insert').length;
  const deleted = ops.filter((o) => o.op === 'delete').length;
  const ratio = a.length ? Math.min(1, (inserted + deleted) / a.length) : b.length ? 1 : 0;
  return { wordsBefore: a.length, wordsAfter: b.length, wordsInserted: inserted, wordsDeleted: deleted, editRatio: Math.round(ratio * 1000) / 1000 };
}

/** Classic Levenshtein distance; used for short strings such as glossary terms and SKUs. */
export function levenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** Render a diff as a compact string, e.g. for audit notes: "a [-red-]{+blue+} rug". */
export function renderDiff(ops: DiffOp[]): string {
  return ops.map((o) => (o.op === 'equal' ? o.text : o.op === 'delete' ? `[-${o.text}-]` : `{+${o.text}+}`)).join('');
}

/** Rebuild either side from a diff (useful to verify diffs in tests). */
export function applySide(ops: DiffOp[], side: 'before' | 'after'): string {
  return ops.filter((o) => o.op === 'equal' || o.op === (side === 'before' ? 'delete' : 'insert')).map((o) => o.text).join('');
}
