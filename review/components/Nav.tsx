'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { api } from '../lib/api';
import { classes } from '../lib/format';
import { useAsync, useEvents, useInterval } from '../lib/hooks';

const LINKS = [
  { href: '/', label: 'Review', match: (p: string) => p === '/' },
  { href: '/queue', label: 'Queue', match: (p: string) => p.startsWith('/queue') },
  { href: '/batches', label: 'Batches', match: (p: string) => p.startsWith('/batches') },
  { href: '/skus', label: 'Locales', match: (p: string) => p.startsWith('/skus') },
  { href: '/search', label: 'Search', match: (p: string) => p.startsWith('/search') || p.startsWith('/items') },
  { href: '/metrics', label: 'Metrics', match: (p: string) => p.startsWith('/metrics') },
  { href: '/glossary', label: 'Glossary', match: (p: string) => p.startsWith('/glossary') },
  { href: '/admin', label: 'Admin', match: (p: string) => p.startsWith('/admin') },
  { href: '/help', label: 'Help', match: (p: string) => p.startsWith('/help') },
];

export function Nav() {
  const path = usePathname() ?? '/';
  const health = useAsync(() => api.health(), []);
  const me = useAsync(() => api.whoami(), []);
  const [inReview, setInReview] = useState<number | null>(null);
  const counts = useAsync(async () => {
    const m = await api.metrics();
    setInReview(m.inReview);
    return m;
  }, []);
  useInterval(() => void health.reload(), 60_000);
  // Keep the review count fresh without polling the heavy metrics endpoint.
  const live = useEvents(['item.status'], (e) => {
    if (e.type !== 'item.status') return;
    setInReview((n) => {
      if (n === null) return n;
      let next = n;
      if (e.to === 'in_review') next++;
      if (e.from === 'in_review') next--;
      return Math.max(0, next);
    });
  });

  return (
    <nav className="sidebar" aria-label="Main">
      <div className="brand">
        Content<span>Loom</span>
      </div>
      {LINKS.filter((l) => l.href !== '/admin' || !me.data || me.data.roles.includes('admin')).map((l) => (
        <Link key={l.href} href={l.href} className={classes('navlink', l.match(path) && 'active')}>
          <span>{l.label}</span>
          {l.href === '/queue' && inReview !== null && inReview > 0 && <span className="badge tone-wait">{inReview}</span>}
        </Link>
      ))}
      <div className="sidebar-foot stack" style={{ gap: 4 }}>
        {me.data?.user && (
          <span title={me.data.roles.join(', ')}>
            Signed in as <strong>{me.data.user}</strong>
            <br />
            {me.data.roles.join(' · ') || 'no roles'}
          </span>
        )}
        <span className="row">
          <span className={classes('dot', live ? 'live' : 'down')} /> {live ? 'Live updates' : 'Reconnecting…'}
        </span>
        {health.data && (
          <>
            <span>
              API {health.data.ok ? 'healthy' : 'degraded'}
              {health.data.queue ? ` · ${health.data.queue.waiting} waiting` : ''}
            </span>
            {health.data.budget.limitUsd !== null && (
              <span>
                Budget ${health.data.budget.spentUsd.toFixed(2)} / ${health.data.budget.limitUsd.toFixed(2)}
              </span>
            )}
            <span className="mono">prompt {health.data.promptVersion}</span>
          </>
        )}
        {counts.error && <span>Metrics unavailable</span>}
      </div>
    </nav>
  );
}
