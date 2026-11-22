'use client';
import { useState } from 'react';
import { useToast } from './Toasts';
import { api } from '../lib/api';
import { plural } from '../lib/format';
import type { Item, Status } from '../lib/types';

type Action = 'publish' | 'regenerate' | 'reopen' | 'withdraw';

const ACTIONS: { id: Action; label: string; from: Status[]; reason: 'none' | 'optional' | 'required'; danger?: boolean }[] = [
  { id: 'publish', label: 'Publish', from: ['approved', 'auto_approved'], reason: 'none' },
  { id: 'reopen', label: 'Send back to review', from: ['approved', 'auto_approved'], reason: 'required' },
  { id: 'regenerate', label: 'Regenerate', from: ['failed', 'rejected', 'withdrawn'], reason: 'optional' },
  { id: 'withdraw', label: 'Withdraw', from: ['published'], reason: 'required', danger: true },
];

/**
 * Actions on the selected search results. Only actions that apply to at least one selected item are
 * offered, and the button says how many of the selection it will touch.
 */
export function BulkBar({ selected, onDone, onClear }: { selected: Item[]; onDone: () => void; onClear: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState<Action | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (!selected.length) return null;

  const eligible = (a: (typeof ACTIONS)[number]) => selected.filter((i) => a.from.includes(i.status));
  const current = ACTIONS.find((a) => a.id === open);

  async function run(a: (typeof ACTIONS)[number]) {
    const ids = eligible(a).map((i) => i.id);
    setBusy(true);
    try {
      const r = await api.bulk(a.id, ids, reason.trim() || undefined);
      toast.info(`${a.label}: ${r.done.length} done${r.failed.length ? `, ${r.failed.length} failed (${r.failed[0].error})` : ''}`);
      setOpen(null);
      setReason('');
      onDone();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card row" style={{ padding: '8px 12px', position: 'sticky', top: 8, zIndex: 5 }}>
      <strong>{plural(selected.length, 'item')} selected</strong>
      {!current &&
        ACTIONS.map((a) => {
          const n = eligible(a).length;
          if (!n) return null;
          return (
            <button key={a.id} className={`btn small ${a.danger ? 'danger' : ''}`} onClick={() => (a.reason === 'none' ? void run(a) : setOpen(a.id))} disabled={busy}>
              {a.label} {n}
            </button>
          );
        })}
      {current && (
        <>
          <input
            type="text"
            autoFocus
            placeholder={current.reason === 'required' ? 'Reason (required)' : 'Note for the writer (optional)'}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            style={{ minWidth: 260 }}
          />
          <button className={`btn small ${current.danger ? 'danger' : 'primary'}`} disabled={busy || (current.reason === 'required' && reason.trim().length < 5)} onClick={() => void run(current)}>
            {busy ? 'Working…' : `${current.label} ${eligible(current).length}`}
          </button>
          <button className="btn small ghost" onClick={() => setOpen(null)} disabled={busy}>
            Back
          </button>
        </>
      )}
      <span className="grow" />
      <button className="btn small ghost" onClick={onClear}>
        Clear selection
      </button>
    </div>
  );
}
