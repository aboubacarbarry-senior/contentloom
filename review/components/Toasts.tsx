'use client';
import { createContext, ReactNode, useCallback, useContext, useMemo, useRef, useState } from 'react';

interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
  action?: { label: string; run: () => void };
}

interface ToastApi {
  info: (text: string, action?: Toast['action']) => void;
  error: (e: unknown) => void;
}

const Ctx = createContext<ToastApi>({ info: () => undefined, error: () => undefined });

export function useToast(): ToastApi {
  return useContext(Ctx);
}

/** Short-lived notices in the corner. Errors stay longer; an optional action (e.g. Undo) is offered. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = next.current++;
      setToasts((ts) => [...ts.slice(-3), { ...t, id }]);
      setTimeout(() => dismiss(id), t.kind === 'error' ? 8000 : 4000);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      info: (text, action) => push({ text, kind: 'info', action }),
      error: (e) => push({ text: e instanceof Error ? e.message : String(e), kind: 'error' }),
    }),
    [push],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`}>
            <span className="grow">{t.text}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
                style={{ fontSize: 13, textDecoration: 'underline', opacity: 1 }}
              >
                {t.action.label}
              </button>
            )}
            <button aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
