create table if not exists public.orbit_state (
    id text primary key,
    data jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
);

alter table public.orbit_state
    drop constraint if exists orbit_state_id_check;

alter table public.orbit_state enable row level security;

revoke all on public.orbit_state from anon, authenticated;
grant all on public.orbit_state to service_role;

create or replace function public.touch_orbit_state_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists orbit_state_updated_at on public.orbit_state;
create trigger orbit_state_updated_at
before update on public.orbit_state
for each row execute function public.touch_orbit_state_updated_at();
