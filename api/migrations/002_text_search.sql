-- Trigram index for the review app's free-text search over SKUs, drafts and final copy.
-- pg_trgm ships with PostgreSQL; on managed databases it may need to be allow-listed first.

create extension if not exists pg_trgm;

create index if not exists items_text_trgm_idx on items using gin (
  (lower(sku || ' ' || coalesce(doc ->> 'draft', '') || ' ' || coalesce(doc ->> 'finalText', ''))) gin_trgm_ops
);
