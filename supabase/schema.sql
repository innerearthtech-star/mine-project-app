-- ── Coal Mine App · Supabase schema ────────────────────────────────
-- Paste this whole file into the Supabase SQL Editor and click Run.
-- Safe to run more than once.

-- Shared: borehole pins
create table if not exists boreholes (
  id uuid primary key,
  name text not null,
  lat double precision not null,
  lng double precision not null,
  photo text,                         -- storage path of surface photo
  created_by text,
  author_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted boolean default false
);

-- Shared: notes on each borehole (photos = array of storage paths)
create table if not exists notes (
  id uuid primary key,
  borehole_id uuid not null,
  text text default '',
  photos jsonb default '[]',
  author text,
  author_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted boolean default false
);

-- Shared: mine contacts
create table if not exists contacts (
  id uuid primary key,
  company text not null,
  name text not null,
  phone text not null,
  created_by text,
  author_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted boolean default false
);

-- Shared: app settings (project/mine name)
create table if not exists app_settings (
  key text primary key,
  value text,
  updated_at timestamptz default now(),
  deleted boolean default false
);

-- Private (owner only): runs per borehole
create table if not exists runs (
  id uuid primary key,
  borehole_id uuid not null,
  ts timestamptz not null,
  note text default '',
  owner_key text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted boolean default false
);

-- Private: field-hours shifts (leave hotel → back at hotel)
create table if not exists shifts (
  id uuid primary key,
  start_ts timestamptz not null,
  end_ts timestamptz,
  owner_key text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted boolean default false
);

-- Private: night-stay periods (first night → checkout)
create table if not exists jobs (
  id uuid primary key,
  night_start date not null,
  night_end date,
  owner_key text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted boolean default false
);

-- ── Open access policies ───────────────────────────────────────────
-- The app is shared by link with no logins, so the anon key can read
-- and write. Do not reuse this Supabase project for anything else.
do $$
declare t text;
begin
  foreach t in array array['boreholes','notes','contacts','app_settings','runs','shifts','jobs']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "open access" on %I', t);
    execute format('create policy "open access" on %I for all using (true) with check (true)', t);
  end loop;
end $$;

-- ── Last-write-wins guard ──────────────────────────────────────────
-- A phone that was offline can push an old snapshot after someone
-- else already saved a newer edit; this trigger makes the database
-- keep whichever row is newest instead of whichever arrived last.
create or replace function lww_guard() returns trigger language plpgsql as $$
begin
  if new.updated_at is not null and old.updated_at is not null
     and new.updated_at <= old.updated_at then
    return null;  -- incoming row is older: keep what we have
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['boreholes','notes','contacts','app_settings','runs','shifts','jobs']
  loop
    execute format('drop trigger if exists lww on %I', t);
    execute format('create trigger lww before update on %I for each row execute function lww_guard()', t);
  end loop;
end $$;

-- ── Realtime: everyone sees new pins/notes instantly ───────────────
do $$
declare t text;
begin
  foreach t in array array['boreholes','notes','contacts','app_settings','runs','shifts','jobs']
  loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ── Storage bucket for photos ──────────────────────────────────────
insert into storage.buckets (id, name, public)
values ('photos', 'photos', true)
on conflict (id) do nothing;

drop policy if exists "open photo read" on storage.objects;
create policy "open photo read" on storage.objects
  for select using (bucket_id = 'photos');
drop policy if exists "open photo write" on storage.objects;
create policy "open photo write" on storage.objects
  for insert with check (bucket_id = 'photos');
drop policy if exists "open photo update" on storage.objects;
create policy "open photo update" on storage.objects
  for update using (bucket_id = 'photos');
