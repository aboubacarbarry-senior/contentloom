-- ContentLoom schema. Items keep their full JSON document in `doc` and copy the fields that queries
-- filter or sort on into columns, so the review queue and search stay index-backed.

create table if not exists batches (
  id            uuid primary key,
  name          text        not null,
  created_by    text        not null,
  created_at    timestamptz not null,
  item_count    integer     not null check (item_count > 0),
  source        text        not null check (source in ('api', 'csv')),
  cancelled_at  timestamptz,
  cancelled_by  text
);

create index if not exists batches_created_idx on batches (created_at desc, id);
create index if not exists batches_creator_idx on batches (created_by, created_at desc);

create table if not exists items (
  id                uuid primary key,
  batch_id          uuid        not null references batches (id),
  sku               text        not null,
  locale            text        not null check (locale in ('en-US', 'es-US', 'fr-CA')),
  category          text        not null,
  status            text        not null,
  score_total       double precision,
  reviewer          text,
  variant           text,
  sampled           boolean     not null default false,
  lease_reviewer    text,
  lease_expires_at  timestamptz,
  created_at        timestamptz not null,
  updated_at        timestamptz not null,
  version           integer     not null default 0,
  doc               jsonb       not null
);

create index if not exists items_batch_idx on items (batch_id, created_at);
create index if not exists items_status_score_idx on items (status, score_total, created_at);
create index if not exists items_sku_idx on items (lower(sku), locale);
create index if not exists items_updated_idx on items (status, updated_at);
create index if not exists items_review_queue_idx on items (score_total, created_at) where status = 'in_review';
create index if not exists items_doc_idx on items using gin (doc jsonb_path_ops);

create table if not exists audit_log (
  id       uuid primary key,
  at       timestamptz not null,
  actor    text        not null,
  action   text        not null,
  subject  text        not null,
  detail   jsonb       not null default '{}'::jsonb
);

create index if not exists audit_subject_idx on audit_log (subject, at desc);
create index if not exists audit_actor_idx on audit_log (actor, at desc);
create index if not exists audit_at_idx on audit_log (at desc);

create table if not exists comments (
  id            uuid primary key,
  item_id       uuid        not null references items (id) on delete cascade,
  author        text        not null,
  body          text        not null check (length(body) between 1 and 2000),
  at            timestamptz not null,
  start_offset  integer,
  end_offset    integer,
  resolved      boolean     not null default false,
  check ((start_offset is null) = (end_offset is null)),
  check (start_offset is null or start_offset <= end_offset)
);

create index if not exists comments_item_idx on comments (item_id, at);

create table if not exists outbox (
  id               uuid primary key,
  event            text        not null,
  target           text        not null,
  payload          jsonb       not null,
  created_at       timestamptz not null,
  status           text        not null check (status in ('pending', 'delivered', 'dead')),
  attempts         integer     not null default 0,
  next_attempt_at  timestamptz not null,
  last_error       text,
  last_status      integer,
  delivered_at     timestamptz,
  locked_until     timestamptz
);

create index if not exists outbox_due_idx on outbox (next_attempt_at) where status = 'pending';
create index if not exists outbox_created_idx on outbox (created_at desc);

create table if not exists glossary (
  id              uuid primary key,
  locale          text        not null check (locale in ('*', 'en-US', 'es-US', 'fr-CA')),
  term            text        not null,
  kind            text        not null check (kind in ('forbidden', 'preferred', 'keep')),
  replacement     text,
  note            text,
  case_sensitive  boolean     not null default false,
  created_by      text        not null,
  created_at      timestamptz not null
);

create unique index if not exists glossary_term_uq on glossary (locale, lower(term));

create table if not exists usage_daily (
  day                 date primary key,
  calls               integer        not null default 0,
  input_tokens        bigint         not null default 0,
  output_tokens       bigint         not null default 0,
  cache_read_tokens   bigint         not null default 0,
  cache_write_tokens  bigint         not null default 0,
  cost_usd            numeric(14, 6) not null default 0
);
