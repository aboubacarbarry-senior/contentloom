import { wordShingles } from './tokenize';

/**
 * Near-duplicate detection across SKUs. Thousands of variants of one product (colours, sizes) tend to
 * get almost identical copy, which search engines treat as duplicate content. MinHash signatures with
 * locality-sensitive hashing (bands of rows) find candidate pairs without comparing every pair.
 */

/** 32-bit FNV-1a. Stable across processes, so signatures can be stored. */
export function fnv1a(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic pseudo-random generator (mulberry32) for the hash coefficients. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRIME = 4294967311; // smallest prime above 2^32

export class MinHasher {
  private readonly a: number[];
  private readonly b: number[];

  constructor(readonly numHashes = 64, seed = 42) {
    const rnd = mulberry32(seed);
    this.a = Array.from({ length: numHashes }, () => 1 + Math.floor(rnd() * (PRIME - 2)));
    this.b = Array.from({ length: numHashes }, () => Math.floor(rnd() * (PRIME - 1)));
  }

  signature(shingles: Iterable<string>): Uint32Array {
    const sig = new Uint32Array(this.numHashes).fill(0xffffffff);
    let any = false;
    for (const sh of shingles) {
      any = true;
      const x = fnv1a(sh);
      for (let i = 0; i < this.numHashes; i++) {
        // (a·x + b) mod p, kept exact with BigInt-free splitting: a, x < 2^32 so use Number on the high/low parts.
        const h = mulMod(this.a[i], x, this.b[i]);
        if (h < sig[i]) sig[i] = h;
      }
    }
    if (!any) sig.fill(0);
    return sig;
  }
}

/** (a * x + b) mod PRIME without losing precision: split x into 16-bit halves. */
function mulMod(a: number, x: number, b: number): number {
  const xh = Math.floor(x / 65536);
  const xl = x % 65536;
  let r = (a * xh) % PRIME;
  r = (r * 65536) % PRIME;
  r = (r + a * xl) % PRIME;
  r = (r + b) % PRIME;
  return r >>> 0;
}

export function estimateJaccard(a: Uint32Array, b: Uint32Array): number {
  if (a.length !== b.length) throw new Error('signatures differ in length');
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

export function jaccard<T>(a: Iterable<T>, b: Iterable<T>): number {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export interface DuplicateMatch {
  key: string;
  similarity: number;
}

/**
 * LSH index: signatures are cut into `bands` bands of `rows` rows; documents sharing any band are
 * candidates, and candidates are confirmed with exact Jaccard on the shingles. With 16 bands of 4 rows,
 * pairs at 0.8 similarity are found ~99.96% of the time and pairs at 0.3 rarely become candidates.
 */
export class DuplicateIndex {
  private readonly hasher: MinHasher;
  private readonly buckets = new Map<string, Set<string>>();
  private readonly docs = new Map<string, { shingles: string[]; sig: Uint32Array }>();

  constructor(
    readonly bands = 16,
    readonly rows = 4,
    readonly shingleSize = 3,
  ) {
    this.hasher = new MinHasher(bands * rows);
  }

  get size(): number {
    return this.docs.size;
  }

  add(key: string, text: string): void {
    this.remove(key);
    const shingles = wordShingles(text, this.shingleSize);
    const sig = this.hasher.signature(shingles);
    this.docs.set(key, { shingles, sig });
    for (const bk of this.bandKeys(sig)) {
      let set = this.buckets.get(bk);
      if (!set) this.buckets.set(bk, (set = new Set()));
      set.add(key);
    }
  }

  remove(key: string): void {
    const doc = this.docs.get(key);
    if (!doc) return;
    for (const bk of this.bandKeys(doc.sig)) {
      const set = this.buckets.get(bk);
      set?.delete(key);
      if (set && !set.size) this.buckets.delete(bk);
    }
    this.docs.delete(key);
  }

  /** Documents at least `threshold` similar to `text`, most similar first. `exclude` skips the document itself. */
  query(text: string, threshold = 0.8, exclude?: string): DuplicateMatch[] {
    const shingles = wordShingles(text, this.shingleSize);
    const sig = this.hasher.signature(shingles);
    const candidates = new Set<string>();
    for (const bk of this.bandKeys(sig)) for (const k of this.buckets.get(bk) ?? []) candidates.add(k);
    const out: DuplicateMatch[] = [];
    for (const key of candidates) {
      if (key === exclude) continue;
      const doc = this.docs.get(key)!;
      const sim = jaccard(shingles, doc.shingles);
      if (sim >= threshold) out.push({ key, similarity: Math.round(sim * 1000) / 1000 });
    }
    return out.sort((a, b) => b.similarity - a.similarity || a.key.localeCompare(b.key));
  }

  /** Every pair at or above the threshold, each pair once. */
  pairs(threshold = 0.8): { a: string; b: string; similarity: number }[] {
    const seen = new Set<string>();
    const out: { a: string; b: string; similarity: number }[] = [];
    for (const [key, doc] of this.docs) {
      for (const bk of this.bandKeys(doc.sig)) {
        for (const other of this.buckets.get(bk) ?? []) {
          if (other === key) continue;
          const [a, b] = key < other ? [key, other] : [other, key];
          const id = `${a}\u0000${b}`;
          if (seen.has(id)) continue;
          seen.add(id);
          const sim = jaccard(doc.shingles, this.docs.get(other)!.shingles);
          if (sim >= threshold) out.push({ a, b, similarity: Math.round(sim * 1000) / 1000 });
        }
      }
    }
    return out.sort((x, y) => y.similarity - x.similarity);
  }

  private bandKeys(sig: Uint32Array): string[] {
    const keys: string[] = [];
    for (let b = 0; b < this.bands; b++) {
      const part = Array.from(sig.subarray(b * this.rows, (b + 1) * this.rows));
      keys.push(`${b}:${part.join(',')}`);
    }
    return keys;
  }
}

/** Probability that a pair with Jaccard similarity `s` becomes an LSH candidate. */
export function candidateProbability(s: number, bands: number, rows: number): number {
  return 1 - Math.pow(1 - Math.pow(s, rows), bands);
}
