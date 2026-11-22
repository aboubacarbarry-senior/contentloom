'use client';
import { DependencyList, useCallback, useEffect, useRef, useState } from 'react';
import type { AppEvent } from './types';

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (d: T | null | ((prev: T | null) => T | null)) => void;
}

/**
 * Load data on mount and whenever `deps` change. Stale responses (from an earlier deps value) are
 * dropped, so typing in a filter box never shows results for an older query.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const d = await fnRef.current();
      if (mine === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError(e as Error);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, reload, setData };
}

/** Run `fn` every `ms` while the tab is visible. */
export function useInterval(fn: () => void, ms: number | null) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') ref.current();
    }, ms);
    return () => clearInterval(id);
  }, [ms]);
}

/**
 * Subscribe to the API's Server-Sent Events. Reconnects with backoff when the connection drops (the
 * browser's own retry gives up after a proxy error).
 */
export function useEvents(types: AppEvent['type'][], onEvent: (e: AppEvent) => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const key = types.slice().sort().join(',');
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let source: EventSource | null = null;
    let retry = 1000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const open = () => {
      source = new EventSource(`/api/events?types=${encodeURIComponent(key)}`);
      source.onopen = () => {
        retry = 1000;
        setConnected(true);
      };
      const listener = (msg: MessageEvent) => {
        try {
          handler.current(JSON.parse(msg.data) as AppEvent);
        } catch {
          /* ignore malformed frames */
        }
      };
      for (const t of key.split(',')) source.addEventListener(t, listener as EventListener);
      source.onerror = () => {
        setConnected(false);
        source?.close();
        if (closed) return;
        timer = setTimeout(open, retry);
        retry = Math.min(retry * 2, 30_000);
      };
    };
    open();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      source?.close();
    };
  }, [key]);

  return connected;
}

export interface Hotkey {
  key: string;
  /** Require Ctrl (or Cmd on macOS). */
  mod?: boolean;
  description: string;
  run: () => void;
  /** Allow while typing in an input or textarea (only with mod keys, by default). */
  inInputs?: boolean;
}

/** Page-level keyboard shortcuts. Plain keys are ignored while the user is typing. */
export function useHotkeys(keys: Hotkey[]) {
  const ref = useRef(keys);
  ref.current = keys;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;
      for (const h of ref.current) {
        if (h.key.toLowerCase() !== e.key.toLowerCase()) continue;
        if (!!h.mod !== mod) continue;
        if (typing && !(h.inInputs ?? h.mod)) continue;
        e.preventDefault();
        h.run();
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** State mirrored to localStorage (per browser), e.g. a reviewer's saved queue filter. */
export function useStoredState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) setValue(JSON.parse(raw) as T);
    } catch {
      /* storage blocked or corrupt: keep the default */
    }
  }, [key]);
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        window.localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* ignore */
      }
    },
    [key],
  );
  return [value, set];
}

/** Read and write a URL query parameter without a full navigation. */
export function useQueryParam(name: string, initial = ''): [string, (v: string) => void] {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get(name);
    if (v !== null) setValue(v);
  }, [name]);
  const set = useCallback(
    (v: string) => {
      setValue(v);
      const url = new URL(window.location.href);
      if (v) url.searchParams.set(name, v);
      else url.searchParams.delete(name);
      window.history.replaceState(null, '', url.toString());
    },
    [name],
  );
  return [value, set];
}

/** Re-render every `ms` so relative times ("3 minutes ago") stay fresh. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
