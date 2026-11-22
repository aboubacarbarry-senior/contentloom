import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Clock } from './clock';
import { AuditEntry, Page, Store, STORE } from './repository';
import { CLOCK } from './tokens';

/**
 * Who did what, outside the item state machine (whose history lives on the item): batch creation and
 * cancellation, glossary edits, policy changes, publishes and withdrawals, outbox retries.
 */
@Injectable()
export class AuditService {
  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async record(actor: string, action: string, subject: string, detail: Record<string, unknown> = {}): Promise<AuditEntry> {
    const entry: AuditEntry = { id: randomUUID(), at: this.clock.now().toISOString(), actor, action, subject, detail: redact(detail) };
    await this.store.audit.append(entry);
    return entry;
  }

  list(opts: { subject?: string; actor?: string; action?: string; limit?: number; cursor?: string | null }): Promise<Page<AuditEntry>> {
    return this.store.audit.list(opts);
  }
}

const SECRET_KEYS = /secret|token|password|api[_-]?key|authorization/i;

/** Never write secrets to the audit log, even if a caller passes a config object through. */
export function redact(detail: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (SECRET_KEYS.test(k)) out[k] = '[redacted]';
    else if (v && typeof v === 'object' && !Array.isArray(v) && depth < 4) out[k] = redact(v as Record<string, unknown>, depth + 1);
    else if (typeof v === 'string' && v.length > 2000) out[k] = `${v.slice(0, 2000)}…`;
    else out[k] = v;
  }
  return out;
}
