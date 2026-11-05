-- Local monthly ranking by department (city) in El Salvador.

create table if not exists public.cities (
  id uuid default gen_random_uuid() primary key,
  name text not null unique,
  slug text not null unique,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

insert into public.cities (name, slug, sort_order) values
  ('Ahuachapán', 'ahuachapan', 1),
  ('Cabañas', 'cabanas', 2),
  ('Chalatenango', 'chalatenango', 3),
  ('Cuscatlán', 'cuscatlan', 4),
  ('La Libertad', 'la-libertad', 5),
  ('La Paz', 'la-paz', 6),
  ('La Unión', 'la-union', 7),
  ('Morazán', 'morazan', 8),
  ('San Miguel', 'san-miguel', 9),
  ('San Salvador', 'san-salvador', 10),
  ('San Vicente', 'san-vicente', 11),
  ('Santa Ana', 'santa-ana', 12),
  ('Sonsonate', 'sonsonate', 13),
  ('Usulután', 'usulutan', 14)
on conflict (slug) do nothing;

alter table public.profiles
  add column if not exists city_id uuid references public.cities(id) on delete set null,
  add column if not exists monthly_eco_points integer not null default 0
    check (monthly_eco_points >= 0);

create index if not exists idx_profiles_city_id on public.profiles(city_id);
create index if not exists idx_profiles_monthly_eco_points
  on public.profiles(monthly_eco_points desc)
  where monthly_eco_points > 0;

create table if not exists public.monthly_competitions (
  id uuid default gen_random_uuid() primary key,
  year integer not null check (year >= 2020),
  month integer not null check (month between 1 and 12),
  status text not null default 'active'
    check (status in ('active', 'finalized')),
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  unique (year, month)
);

create table if not exists public.monthly_city_results (
  id uuid default gen_random_uuid() primary key,
  competition_id uuid references public.monthly_competitions(id) on delete cascade not null,
  city_id uuid references public.cities(id) on delete cascade not null,
  rank integer not null check (rank >= 1),
  total_eco_points integer not null default 0 check (total_eco_points >= 0),
  recycler_count integer not null default 0 check (recycler_count >= 0),
  unique (competition_id, city_id),
  unique (competition_id, rank)
);

create table if not exists public.monthly_user_results (
  id uuid default gen_random_uuid() primary key,
  competition_id uuid references public.monthly_competitions(id) on delete cascade not null,
  user_id uuid references public.profiles(id) on delete cascade not null,
  city_id uuid references public.cities(id) on delete set null,
  eco_points integer not null default 0 check (eco_points >= 0),
  rank_national integer not null check (rank_national >= 1),
  rank_in_city integer check (rank_in_city >= 1),
  medal_tier text not null default 'none'
    check (medal_tier in ('gold', 'silver', 'bronze', 'none')),
  unique (competition_id, user_id)
);

create index if not exists idx_monthly_city_results_competition
  on public.monthly_city_results(competition_id, rank);

create index if not exists idx_monthly_user_results_competition
  on public.monthly_user_results(competition_id, rank_national);

create index if not exists idx_monthly_user_results_user
  on public.monthly_user_results(user_id, competition_id desc);

-- Medal tier from monthly eco-points volume.
create or replace function public.compute_medal_tier(p_eco_points integer)
returns text
language sql
immutable
as $$
  select case
    when p_eco_points >= 300 then 'gold'
    when p_eco_points >= 150 then 'silver'
    when p_eco_points >= 50 then 'bronze'
    else 'none'
  end;
$$;

-- Live city battle standings.
create or replace view public.city_battle_current
with (security_invoker = true) as
select
  c.id as city_id,
  c.name as city_name,
  coalesce(sum(p.monthly_eco_points), 0)::integer as total_eco_points,
  count(p.id) filter (where p.monthly_eco_points > 0)::integer as recycler_count,
  rank() over (order by coalesce(sum(p.monthly_eco_points), 0) desc, c.sort_order asc)::integer as rank
from public.cities c
left join public.profiles p on p.city_id = c.id
group by c.id, c.name, c.sort_order;

-- Live per-city user leaderboard.
create or replace view public.city_leaderboard_current
with (security_invoker = true) as
select
  p.id as user_id,
  p.city_id,
  c.name as city_name,
  coalesce(nullif(trim(p.alias), ''), nullif(trim(p.full_name), ''), 'Recycler') as display_name,
  p.monthly_eco_points,
  rank() over (
    partition by p.city_id
    order by p.monthly_eco_points desc, p.created_at asc
  )::integer as rank_in_city
from public.profiles p
join public.cities c on c.id = p.city_id
where p.city_id is not null
  and p.monthly_eco_points > 0;

-- Live national user leaderboard.
create or replace view public.national_leaderboard_current
with (security_invoker = true) as
select
  p.id as user_id,
  p.city_id,
  c.name as city_name,
  coalesce(nullif(trim(p.alias), ''), nullif(trim(p.full_name), ''), 'Recycler') as display_name,
  p.monthly_eco_points,
  rank() over (
    order by p.monthly_eco_points desc, p.created_at asc
  )::integer as rank_national
from public.profiles p
left join public.cities c on c.id = p.city_id
where p.monthly_eco_points > 0;

-- Finalize a calendar month: snapshot standings, assign medals, reset monthly points.
create or replace function public.finalize_monthly_competition(p_year integer, p_month integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_competition_id uuid;
  v_city_count integer;
  v_user_count integer;
begin
  if p_month < 1 or p_month > 12 then
    raise exception 'Invalid month: %', p_month;
  end if;

  insert into public.monthly_competitions (year, month, status)
  values (p_year, p_month, 'active')
  on conflict (year, month) do nothing;

  select id into v_competition_id
  from public.monthly_competitions
  where year = p_year and month = p_month;

  if exists (
    select 1 from public.monthly_competitions
    where id = v_competition_id and status = 'finalized'
  ) then
    return jsonb_build_object(
      'success', false,
      'message', 'Competition already finalized',
      'year', p_year,
      'month', p_month
    );
  end if;

  insert into public.monthly_city_results (competition_id, city_id, rank, total_eco_points, recycler_count)
  select
    v_competition_id,
    city_id,
    rank,
    total_eco_points,
    recycler_count
  from public.city_battle_current
  on conflict (competition_id, city_id) do update
  set
    rank = excluded.rank,
    total_eco_points = excluded.total_eco_points,
    recycler_count = excluded.recycler_count;

  get diagnostics v_city_count = row_count;

  insert into public.monthly_user_results (
    competition_id,
    user_id,
    city_id,
    eco_points,
    rank_national,
    rank_in_city,
    medal_tier
  )
  select
    v_competition_id,
    ranked.user_id,
    ranked.city_id,
    ranked.monthly_eco_points,
    ranked.rank_national,
    city_ranks.rank_in_city,
    public.compute_medal_tier(ranked.monthly_eco_points)
  from public.national_leaderboard_current ranked
  left join public.city_leaderboard_current city_ranks
    on city_ranks.user_id = ranked.user_id
  on conflict (competition_id, user_id) do update
  set
    city_id = excluded.city_id,
    eco_points = excluded.eco_points,
    rank_national = excluded.rank_national,
    rank_in_city = excluded.rank_in_city,
    medal_tier = excluded.medal_tier;

  get diagnostics v_user_count = row_count;

  update public.profiles
  set monthly_eco_points = 0
  where monthly_eco_points <> 0;

  update public.monthly_competitions
  set status = 'finalized', finalized_at = now()
  where id = v_competition_id;

  return jsonb_build_object(
    'success', true,
    'year', p_year,
    'month', p_month,
    'competition_id', v_competition_id,
    'cities_recorded', v_city_count,
    'users_recorded', v_user_count
  );
end;
$$;

revoke all on function public.finalize_monthly_competition(integer, integer) from public;
grant execute on function public.finalize_monthly_competition(integer, integer) to service_role;

-- RLS
alter table public.cities enable row level security;
alter table public.monthly_competitions enable row level security;
alter table public.monthly_city_results enable row level security;
alter table public.monthly_user_results enable row level security;

drop policy if exists "Authenticated users can view cities" on public.cities;
create policy "Authenticated users can view cities"
  on public.cities for select
  to authenticated
  using (true);

drop policy if exists "Authenticated users can view profiles for rankings" on public.profiles;
create policy "Authenticated users can view profiles for rankings"
  on public.profiles for select
  to authenticated
  using (true);

drop policy if exists "Authenticated users can view monthly competitions" on public.monthly_competitions;
create policy "Authenticated users can view monthly competitions"
  on public.monthly_competitions for select
  to authenticated
  using (true);

drop policy if exists "Authenticated users can view monthly city results" on public.monthly_city_results;
create policy "Authenticated users can view monthly city results"
  on public.monthly_city_results for select
  to authenticated
  using (true);

drop policy if exists "Authenticated users can view monthly user results" on public.monthly_user_results;
create policy "Authenticated users can view monthly user results"
  on public.monthly_user_results for select
  to authenticated
  using (true);

grant select on public.city_battle_current to authenticated;
grant select on public.city_leaderboard_current to authenticated;
grant select on public.national_leaderboard_current to authenticated;

-- Seed current month competition row.
insert into public.monthly_competitions (year, month, status)
values (
  extract(year from timezone('America/El_Salvador', now()))::integer,
  extract(month from timezone('America/El_Salvador', now()))::integer,
  'active'
)
on conflict (year, month) do nothing;

-- Monthly reset: 00:05 on the 1st in El Salvador (06:05 UTC/GMT).
create extension if not exists pg_cron with schema pg_catalog;

select cron.unschedule(jobid)
from cron.job
where jobname = 'finalize-monthly-ranking';

select cron.schedule(
  'finalize-monthly-ranking',
  '5 6 1 * *',
  $$
  select public.finalize_monthly_competition(
    extract(year from timezone('America/El_Salvador', now() - interval '1 month'))::integer,
    extract(month from timezone('America/El_Salvador', now() - interval '1 month'))::integer
  );
  $$
);
