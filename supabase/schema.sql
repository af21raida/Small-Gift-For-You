-- =============================================================================
-- My Love For You — Supabase schema
--
-- Run once in the Supabase SQL editor (or `psql`). Safe to re-run (idempotent) — re-run it whenever this file changes
-- (it also upgrades an existing install: e.g. 2026-11 added song uploads: table audio_files + bucket gift-audio).
--
-- SECURITY MODEL
--   * The browser NEVER talks to Supabase directly. All access goes through Netlify Functions,
--     which use the service-role key (kept only in Netlify environment variables).
--   * Every table has Row Level Security enabled and NO policies => the `anon` and
--     `authenticated` roles (i.e. anyone holding the public anon key) can read/write nothing.
--   * All privileges are revoked from anon/authenticated; the helper functions are executable by
--     `service_role` only.
--   * Gift codes (20 chars, 100 bits) are bearer secrets: whoever has the link can view the gift.
--   * The creator receives a separate secret "manage key" (256 bits). Only its SHA-256 hash is
--     stored, so a database leak does not allow deleting gifts.
--   * Photos live in a PRIVATE storage bucket and are served through short-lived signed URLs.
-- =============================================================================

-- (gen_random_uuid() is built into PostgreSQL 13+, so no extension is required.)

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.gifts (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,                       -- 20 chars, Crockford base32
  message          text not null default '',
  songs            jsonb not null default '[]'::jsonb,         -- [{title, artist, url}]
  photos           jsonb not null default '[]'::jsonb,         -- [{type:'stored',id} | {type:'external',url}]
  manage_key_hash  text not null,                              -- sha256 hex of the manage key
  idempotency_hash text unique,                                -- sha256 hex of the client's idempotency key
  created_at       timestamptz not null default now(),
  expires_at       timestamptz,                                -- null = never expires
  deleted_at       timestamptz,                                -- tombstone: content is wiped on delete
  constraint gifts_code_format   check (code ~ '^[0-9A-HJKMNP-TV-Z]{20}$'),
  constraint gifts_message_len   check (char_length(message) <= 10000),
  constraint gifts_songs_array   check (jsonb_typeof(songs) = 'array'  and jsonb_array_length(songs)  <= 10),
  constraint gifts_photos_array  check (jsonb_typeof(photos) = 'array' and jsonb_array_length(photos) <= 5)
);

create table if not exists public.photos (
  id            uuid primary key default gen_random_uuid(),
  storage_path  text not null unique,
  mime          text not null check (mime in ('image/jpeg','image/png','image/webp')),
  bytes         integer not null check (bytes > 0 and bytes <= 1500000),
  gift_id       uuid references public.gifts(id) on delete set null,   -- null until the gift is saved
  created_at    timestamptz not null default now()
);
create index if not exists photos_gift_id_idx on public.photos (gift_id);
create index if not exists photos_orphans_idx on public.photos (created_at) where gift_id is null;

-- Songs uploaded from the creator's device (private bucket `gift-audio`). A row is created when an upload is
-- authorised; `committed` flips to true once the server has checked the stored file.
create table if not exists public.audio_files (
  id            uuid primary key default gen_random_uuid(),
  storage_path  text not null unique,
  mime          text not null check (mime in ('audio/mpeg','audio/mp4','audio/aac','audio/ogg','audio/wav','audio/webm')),
  bytes         integer not null check (bytes > 0 and bytes <= 10000000),
  committed     boolean not null default false,
  gift_id       uuid references public.gifts(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists audio_files_gift_id_idx on public.audio_files (gift_id);
create index if not exists audio_files_orphans_idx on public.audio_files (created_at) where gift_id is null;

create table if not exists public.rate_limits (
  bucket       text not null,
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (bucket, window_start)
);

-- ---------------------------------------------------------------------------
-- Lock the tables down: RLS on, zero policies, no grants for the public roles
-- ---------------------------------------------------------------------------
alter table public.gifts       enable row level security;
alter table public.photos      enable row level security;
alter table public.rate_limits enable row level security;
alter table public.audio_files enable row level security;
alter table public.audio_files force row level security;
alter table public.gifts       force row level security;
alter table public.photos      force row level security;
alter table public.rate_limits force row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.gifts, public.photos, public.rate_limits, public.audio_files from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.gifts, public.photos, public.rate_limits, public.audio_files from authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Rate limiting (fixed window, atomic). Returns true when the call is ALLOWED.
-- ---------------------------------------------------------------------------
create or replace function public.rate_limit_hit(p_bucket text, p_window_seconds int, p_limit int)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  w timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  n int;
begin
  insert into public.rate_limits as r (bucket, window_start, hits)
  values (p_bucket, w, 1)
  on conflict (bucket, window_start) do update set hits = r.hits + 1
  returning r.hits into n;
  return n <= p_limit;
end $$;

-- ---------------------------------------------------------------------------
-- Photos
-- ---------------------------------------------------------------------------
create or replace function public.register_photo(p_id uuid, p_path text, p_mime text, p_bytes int)
returns uuid
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.photos (id, storage_path, mime, bytes) values (p_id, p_path, p_mime, p_bytes) returning id;
$$;

-- ---------------------------------------------------------------------------
-- Audio uploads
-- ---------------------------------------------------------------------------
create or replace function public.register_audio(p_id uuid, p_path text, p_mime text, p_bytes int, p_committed boolean)
returns uuid
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.audio_files (id, storage_path, mime, bytes, committed) values (p_id, p_path, p_mime, p_bytes, p_committed) returning id;
$$;

-- Look up an upload that is still usable (younger than 24 h).
create or replace function public.audio_info(p_id uuid)
returns table (path text, mime text, committed boolean, attached boolean)
language sql
security definer
set search_path = public, pg_temp
as $$
  select a.storage_path, a.mime, a.committed, a.gift_id is not null
    from public.audio_files a where a.id = p_id and a.created_at > now() - interval '24 hours';
$$;

create or replace function public.commit_audio(p_id uuid, p_bytes int)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.audio_files set committed = true, bytes = p_bytes where id = p_id and gift_id is null and committed = false;
  return found;
end $$;

-- Remove an upload that failed verification; returns its storage path (null if there was none).
create or replace function public.discard_audio(p_id uuid)
returns text
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from public.audio_files where id = p_id and gift_id is null returning storage_path;
$$;

-- ---------------------------------------------------------------------------
-- Create a gift (single transaction).
--   status 'ok'         -> created, code returned
--   status 'replay'     -> same idempotency key + same manage key: the earlier gift is returned
--   status 'collision'  -> code already used (caller retries with a fresh random code)
--   status 'idem_conflict' -> idempotency key used with a different manage key (rejected)
--   status 'bad_photo'  -> a referenced photo id is unknown, already attached, or older than 24 h
--   status 'photo_limit'-> more than 5 photos
--   status 'bad_audio'  -> an uploaded song is unknown, unverified, already attached, or older than 24 h
--   status 'audio_too_big' -> uploaded songs add up to more than 30 MB
-- ---------------------------------------------------------------------------
create or replace function public.create_gift(
  p_code text, p_message text, p_songs jsonb, p_photos jsonb,
  p_manage_hash text, p_idem_hash text
) returns table (status text, code text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  g_id uuid;
  existing record;
  stored_ids uuid[];
  audio_ids uuid[];
  audio_total bigint;
  found_count int;
  pos int := 0;
  item jsonb;
begin
  if jsonb_array_length(p_photos) > 5 then
    return query select 'photo_limit'::text, null::text; return;
  end if;

  if p_idem_hash is not null then
    select g.code, g.manage_key_hash, g.deleted_at into existing from public.gifts g where g.idempotency_hash = p_idem_hash;
    if found then
      if existing.manage_key_hash = p_manage_hash and existing.deleted_at is null then
        return query select 'replay'::text, existing.code; return;
      end if;
      return query select 'idem_conflict'::text, null::text; return;
    end if;
  end if;

  select coalesce(array_agg((e->>'id')::uuid), '{}') into stored_ids
    from jsonb_array_elements(p_photos) e where e->>'type' = 'stored';

  if array_length(stored_ids, 1) is not null then
    select count(*) into found_count from public.photos
      where id = any(stored_ids) and gift_id is null and created_at > now() - interval '24 hours';
    if found_count <> array_length(stored_ids, 1) then
      return query select 'bad_photo'::text, null::text; return;
    end if;
  end if;

  select coalesce(array_agg((e->>'id')::uuid), '{}') into audio_ids
    from jsonb_array_elements(p_songs) e where e->>'id' is not null;

  if array_length(audio_ids, 1) is not null then
    select count(*), coalesce(sum(a.bytes), 0) into found_count, audio_total from public.audio_files a
      where a.id = any(audio_ids) and a.gift_id is null and a.committed and a.created_at > now() - interval '24 hours';
    if found_count <> array_length(audio_ids, 1) then
      return query select 'bad_audio'::text, null::text; return;
    end if;
    if audio_total > 30000000 then
      return query select 'audio_too_big'::text, null::text; return;
    end if;
  end if;

  begin
    insert into public.gifts (code, message, songs, photos, manage_key_hash, idempotency_hash)
    values (p_code, p_message, p_songs, p_photos, p_manage_hash, p_idem_hash)
    returning id into g_id;
  exception when unique_violation then
    -- either the code collided or a concurrent request used the same idempotency key
    if p_idem_hash is not null then
      select g.code, g.manage_key_hash into existing from public.gifts g where g.idempotency_hash = p_idem_hash;
      if found then
        if existing.manage_key_hash = p_manage_hash then
          return query select 'replay'::text, existing.code; return;
        end if;
        return query select 'idem_conflict'::text, null::text; return;
      end if;
    end if;
    return query select 'collision'::text, null::text; return;
  end;

  if array_length(stored_ids, 1) is not null then
    update public.photos set gift_id = g_id where id = any(stored_ids) and gift_id is null;
  end if;
  if array_length(audio_ids, 1) is not null then
    update public.audio_files set gift_id = g_id where id = any(audio_ids) and gift_id is null;
  end if;
  return query select 'ok'::text, p_code;
end $$;

-- ---------------------------------------------------------------------------
-- Read a gift by code.  status: 'ok' | 'not_found' | 'gone'
-- Stored photos are returned with their private storage path so the function can sign them.
-- ---------------------------------------------------------------------------
create or replace function public.get_gift(p_code text)
returns table (status text, message text, songs jsonb, photos jsonb)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  g record;
  resolved jsonb;
  resolved_songs jsonb;
begin
  select * into g from public.gifts where code = p_code;
  if not found then
    return query select 'not_found'::text, null::text, null::jsonb, null::jsonb; return;
  end if;
  if g.deleted_at is not null or (g.expires_at is not null and g.expires_at < now()) then
    return query select 'gone'::text, null::text, null::jsonb, null::jsonb; return;
  end if;

  select coalesce(jsonb_agg(
           case when e.value->>'type' = 'stored'
                then jsonb_build_object('type','stored','id', e.value->>'id',
                                        'path', (select p.storage_path from public.photos p where p.id = (e.value->>'id')::uuid))
                else e.value end
           order by e.ord), '[]'::jsonb)
    into resolved
    from jsonb_array_elements(g.photos) with ordinality as e(value, ord);

  select coalesce(jsonb_agg(
           case when e.value->>'id' is not null
                then jsonb_build_object('title', e.value->'title', 'artist', e.value->'artist', 'type','stored', 'id', e.value->>'id',
                                        'path', (select a.storage_path from public.audio_files a where a.id = (e.value->>'id')::uuid))
                else e.value end
           order by e.ord), '[]'::jsonb)
    into resolved_songs
    from jsonb_array_elements(g.songs) with ordinality as e(value, ord);

  return query select 'ok'::text, g.message, resolved_songs, resolved;
end $$;

-- ---------------------------------------------------------------------------
-- Delete a gift (requires the manage-key hash). Wipes the content, keeps a tombstone so the
-- link answers "deleted" rather than "never existed". Returns the storage paths (photos, audio) to remove.
--   status: 'ok' | 'not_found' | 'forbidden' | 'gone'
-- ---------------------------------------------------------------------------
drop function if exists public.delete_gift(text, text);
create function public.delete_gift(p_code text, p_manage_hash text)
returns table (status text, paths text[], audio_paths text[])
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  g record;
  del_paths text[];
  del_audio text[];
begin
  select * into g from public.gifts where code = p_code for update;
  if not found then
    return query select 'not_found'::text, null::text[], null::text[]; return;
  end if;
  if g.manage_key_hash is null or g.manage_key_hash <> p_manage_hash then
    return query select 'forbidden'::text, null::text[], null::text[]; return;
  end if;
  if g.deleted_at is not null then
    return query select 'gone'::text, null::text[], null::text[]; return;
  end if;

  select coalesce(array_agg(p.storage_path), '{}') into del_paths from public.photos p where p.gift_id = g.id;
  select coalesce(array_agg(a.storage_path), '{}') into del_audio from public.audio_files a where a.gift_id = g.id;
  delete from public.photos where gift_id = g.id;
  delete from public.audio_files where gift_id = g.id;
  update public.gifts set message = '', songs = '[]'::jsonb, photos = '[]'::jsonb, deleted_at = now() where id = g.id;
  return query select 'ok'::text, del_paths, del_audio;
end $$;

-- ---------------------------------------------------------------------------
-- Housekeeping (called daily by the scheduled function): unattached uploads older than 24 h,
-- and old rate-limit rows. Returns the storage paths the caller must delete from the bucket.
-- ---------------------------------------------------------------------------
drop function if exists public.purge_orphans();
create function public.purge_orphans()
returns table (paths text[], audio_paths text[])
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  p text[];
  ap text[];
begin
  with gone as (
    delete from public.photos where gift_id is null and created_at < now() - interval '24 hours' returning storage_path
  ) select coalesce(array_agg(storage_path), '{}') into p from gone;
  with gone as (
    delete from public.audio_files where gift_id is null and created_at < now() - interval '24 hours' returning storage_path
  ) select coalesce(array_agg(storage_path), '{}') into ap from gone;
  delete from public.rate_limits where window_start < now() - interval '2 days';
  return query select p, ap;
end $$;

-- ---------------------------------------------------------------------------
-- Function privileges: service_role only
-- ---------------------------------------------------------------------------
revoke all on function public.rate_limit_hit(text,int,int)                        from public;
revoke all on function public.register_photo(uuid,text,text,int)                  from public;
revoke all on function public.create_gift(text,text,jsonb,jsonb,text,text)        from public;
revoke all on function public.get_gift(text)                                      from public;
revoke all on function public.delete_gift(text,text)                              from public;
revoke all on function public.purge_orphans()                                     from public;
revoke all on function public.register_audio(uuid,text,text,int,boolean)          from public;
revoke all on function public.audio_info(uuid)                                    from public;
revoke all on function public.commit_audio(uuid,int)                              from public;
revoke all on function public.discard_audio(uuid)                                 from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.rate_limit_hit(text,int,int)                 to service_role';
    execute 'grant execute on function public.register_photo(uuid,text,text,int)           to service_role';
    execute 'grant execute on function public.create_gift(text,text,jsonb,jsonb,text,text) to service_role';
    execute 'grant execute on function public.get_gift(text)                               to service_role';
    execute 'grant execute on function public.delete_gift(text,text)                       to service_role';
    execute 'grant execute on function public.purge_orphans()                              to service_role';
    execute 'grant execute on function public.register_audio(uuid,text,text,int,boolean)   to service_role';
    execute 'grant execute on function public.audio_info(uuid)                             to service_role';
    execute 'grant execute on function public.commit_audio(uuid,int)                       to service_role';
    execute 'grant execute on function public.discard_audio(uuid)                          to service_role';
    execute 'grant all on public.gifts, public.photos, public.rate_limits, public.audio_files to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Storage: private buckets for photos (gift-photos) and uploaded songs (gift-audio). No storage.objects policies are created, so only the
-- service role (which bypasses RLS) can read or write objects; browsers use signed URLs.
-- (On a plain Postgres without the Supabase `storage` schema this block is skipped.)
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('gift-photos', 'gift-photos', false, 1500000, array['image/jpeg','image/png','image/webp'])
    on conflict (id) do update set public = false, file_size_limit = 1500000,
      allowed_mime_types = array['image/jpeg','image/png','image/webp'];
    -- songs uploaded from the creator's device (private; played through signed URLs). 10 MB per file.
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('gift-audio', 'gift-audio', false, 10000000,
            array['audio/mpeg','audio/mp4','audio/aac','audio/ogg','audio/wav','audio/webm'])
    on conflict (id) do update set public = false, file_size_limit = 10000000,
      allowed_mime_types = array['audio/mpeg','audio/mp4','audio/aac','audio/ogg','audio/wav','audio/webm'];
  end if;
end $$;
