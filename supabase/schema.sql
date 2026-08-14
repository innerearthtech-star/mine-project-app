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
  roof_level text,                    -- well data (free text, usually feet)
  casing_bottom text,
  mine_floor text,
  created_by text,
  author_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted boolean default false
);
-- keep existing projects in step when re-running this file
alter table boreholes add column if not exists roof_level text;
alter table boreholes add column if not exists casing_bottom text;
alter table boreholes add column if not exists mine_floor text;

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
  position text default '',            -- title / role (optional)
  created_by text,
  author_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted boolean default false
);
alter table contacts add column if not exists position text default '';

-- Shared: app settings (project/mine name)
create table if not exists app_settings (
  key text primary key,
  value text,
  updated_at timestamptz default now(),
  deleted boolean default false
);

-- Shared: roster of everyone using the app (one row per person)
create table if not exists users (
  id uuid primary key,
  first text not null,
  last text not null,
  name text not null,                  -- "first last", shown on pins/notes
  company text default '',
  position text default '',
  phone text default '',               -- 10 digits, no formatting
  pin text,                            -- sha256(id:pin) — guards tap-to-sign-in
  can_invite boolean default false,    -- retired (invite links replaced by approvals)
  can_videos boolean default false,    -- grant: can see inspection videos
  approved boolean default false,      -- grant: base access (map, notes, contacts)
  can_grant boolean default false,     -- owner-only grant: may approve/grant others
  can_job boolean default false,       -- grant: own private Job tab (their data only)
  can_upload boolean default false,    -- grant: may upload inspection videos
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted boolean default false        -- owner set this to remove someone
);
alter table users add column if not exists pin text;
alter table users add column if not exists can_invite boolean default false;
alter table users add column if not exists can_videos boolean default false;
alter table users add column if not exists approved boolean default false;
alter table users add column if not exists can_grant boolean default false;
alter table users add column if not exists can_job boolean default false;
alter table users add column if not exists can_upload boolean default false;

-- Shared: one-time invite links (each code admits exactly one sign-up)
create table if not exists invites (
  id uuid primary key,
  code text not null,
  created_by text,
  author_id text,
  used_by text,                        -- null until someone signs up with it
  used_by_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted boolean default false
);

-- Shared: video inspections (video files live in the 'videos' storage
-- bucket; screenshots live in the 'photos' bucket under screens/…)
create table if not exists videos (
  id uuid primary key,
  borehole_id uuid not null,
  ts timestamptz not null,             -- when the inspection was run
  note text default '',
  path text,                           -- storage path of the video file (may be null)
  size bigint default 0,
  screenshots jsonb default '[]',      -- array of screenshot storage paths
  uploaded_by text,
  author_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted boolean default false
);
-- keep existing projects in step when re-running this file
alter table videos add column if not exists screenshots jsonb default '[]';
alter table videos alter column path drop not null;

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

-- Private: field-hours shifts (leave hotel -> back at hotel)
create table if not exists shifts (
  id uuid primary key,
  start_ts timestamptz not null,
  end_ts timestamptz,
  owner_key text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted boolean default false
);

-- Private: night-stay periods (first night -> checkout)
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
  foreach t in array array['boreholes','notes','contacts','app_settings','users','runs','shifts','jobs','videos','invites']
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
  foreach t in array array['boreholes','notes','contacts','app_settings','users','runs','shifts','jobs','videos','invites']
  loop
    execute format('drop trigger if exists lww on %I', t);
    execute format('create trigger lww before update on %I for each row execute function lww_guard()', t);
  end loop;
end $$;

-- ── Realtime: everyone sees new pins/notes instantly ───────────────
do $$
declare t text;
begin
  foreach t in array array['boreholes','notes','contacts','app_settings','users','runs','shifts','jobs','videos','invites']
  loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ── Storage buckets: photos + video inspections ────────────────────
insert into storage.buckets (id, name, public)
values ('photos', 'photos', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('videos', 'videos', true)
on conflict (id) do nothing;

do $$
declare b text;
begin
  foreach b in array array['photos','videos']
  loop
    execute format('drop policy if exists "open %s read" on storage.objects', b);
    execute format('create policy "open %s read" on storage.objects for select using (bucket_id = %L)', b, b);
    execute format('drop policy if exists "open %s write" on storage.objects', b);
    execute format('create policy "open %s write" on storage.objects for insert with check (bucket_id = %L)', b, b);
    execute format('drop policy if exists "open %s update" on storage.objects', b);
    execute format('create policy "open %s update" on storage.objects for update using (bucket_id = %L)', b, b);
    execute format('drop policy if exists "open %s delete" on storage.objects', b);
    execute format('create policy "open %s delete" on storage.objects for delete using (bucket_id = %L)', b, b);
  end loop;
end $$;
