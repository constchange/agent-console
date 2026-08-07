-- Agent Console remote-control discovery/synchronization metadata.
-- Local Core pairing state remains the authorization source of truth. This
-- schema intentionally contains no refresh token, pairing secret or private key.

create table public.agent_console_workstations (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 100),
  route_id uuid not null unique,
  protocol_version integer not null check (protocol_version >= 1),
  remote_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz,
  unique (id, user_id)
);

create table public.agent_console_devices (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 100),
  public_key_jwk jsonb not null check (
    jsonb_typeof(public_key_jwk) = 'object'
    and public_key_jwk ->> 'kty' = 'EC'
    and public_key_jwk ->> 'crv' = 'P-256'
    and (public_key_jwk ->> 'x') ~ '^[A-Za-z0-9_-]{43}$'
    and (public_key_jwk ->> 'y') ~ '^[A-Za-z0-9_-]{43}$'
    and not (public_key_jwk ? 'd')
    and public_key_jwk - array['kty', 'crv', 'x', 'y', 'ext', 'key_ops', 'alg'] = '{}'::jsonb
  ),
  key_fingerprint text not null check (key_fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz,
  unique (id, user_id),
  unique (user_id, key_fingerprint)
);

create table public.agent_console_workstation_devices (
  workstation_id uuid not null,
  device_id uuid not null,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  status text not null check (status in ('pending_sync', 'active', 'revoke_pending', 'revoked')),
  paired_at timestamptz not null,
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (workstation_id, device_id),
  unique (workstation_id, device_id, user_id),
  foreign key (workstation_id, user_id)
    references public.agent_console_workstations(id, user_id) on delete cascade,
  foreign key (device_id, user_id)
    references public.agent_console_devices(id, user_id) on delete cascade
);

create table public.agent_console_agent_grants (
  workstation_id uuid not null,
  device_id uuid not null,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  agent_id text not null check (agent_id ~ '^[a-zA-Z0-9_.:-]{1,160}$'),
  can_view boolean not null default false,
  can_message boolean not null default false,
  can_interrupt boolean not null default false,
  can_approve boolean not null default false,
  revision bigint not null check (revision >= 1),
  updated_at timestamptz not null default now(),
  primary key (workstation_id, device_id, agent_id),
  foreign key (workstation_id, device_id, user_id)
    references public.agent_console_workstation_devices(workstation_id, device_id, user_id)
    on delete cascade
);

create index agent_console_workstations_user_idx
  on public.agent_console_workstations(user_id, updated_at desc);
create index agent_console_devices_user_idx
  on public.agent_console_devices(user_id, updated_at desc);
create index agent_console_workstation_devices_user_idx
  on public.agent_console_workstation_devices(user_id, workstation_id, status);
create index agent_console_agent_grants_user_idx
  on public.agent_console_agent_grants(user_id, workstation_id, device_id);

alter table public.agent_console_workstations enable row level security;
alter table public.agent_console_devices enable row level security;
alter table public.agent_console_workstation_devices enable row level security;
alter table public.agent_console_agent_grants enable row level security;

create policy agent_console_workstations_owner_select
  on public.agent_console_workstations for select to authenticated
  using ((select auth.uid()) = user_id);
create policy agent_console_workstations_owner_insert
  on public.agent_console_workstations for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy agent_console_workstations_owner_update
  on public.agent_console_workstations for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy agent_console_workstations_owner_delete
  on public.agent_console_workstations for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy agent_console_devices_owner_select
  on public.agent_console_devices for select to authenticated
  using ((select auth.uid()) = user_id);
create policy agent_console_devices_owner_insert
  on public.agent_console_devices for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy agent_console_devices_owner_update
  on public.agent_console_devices for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy agent_console_devices_owner_delete
  on public.agent_console_devices for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy agent_console_workstation_devices_owner_select
  on public.agent_console_workstation_devices for select to authenticated
  using ((select auth.uid()) = user_id);
create policy agent_console_workstation_devices_owner_insert
  on public.agent_console_workstation_devices for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy agent_console_workstation_devices_owner_update
  on public.agent_console_workstation_devices for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy agent_console_workstation_devices_owner_delete
  on public.agent_console_workstation_devices for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy agent_console_agent_grants_owner_select
  on public.agent_console_agent_grants for select to authenticated
  using ((select auth.uid()) = user_id);
create policy agent_console_agent_grants_owner_insert
  on public.agent_console_agent_grants for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy agent_console_agent_grants_owner_update
  on public.agent_console_agent_grants for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy agent_console_agent_grants_owner_delete
  on public.agent_console_agent_grants for delete to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.agent_console_workstations to authenticated;
grant select, insert, update, delete on public.agent_console_devices to authenticated;
grant select, insert, update, delete on public.agent_console_workstation_devices to authenticated;
grant select, insert, update, delete on public.agent_console_agent_grants to authenticated;
