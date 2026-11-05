-- Rostros de EcoRewards con InsightFace buffalo_l (512 valores).
-- La app web sube fotos temporales. El script de la máquina calcula el vector
-- en la GPU, lo guarda aquí y borra las fotos.
-- Pegar este archivo en el SQL Editor de https://ocarmdddmhtrrnlmupge.supabase.co

-- 1) Sesiones abiertas por reconocimiento facial
alter table public.recycling_sessions
  drop constraint if exists recycling_sessions_source_check;

alter table public.recycling_sessions
  add constraint recycling_sessions_source_check
  check (source in ('qr', 'keypad', 'face'));

-- 2) Consentimiento biométrico
alter table public.profiles
  add column if not exists face_consent_at timestamptz;

-- 3) Vectores. Si existía la tabla de SFace (128), se descartan esas filas:
--    no se pueden comparar con buffalo_l.
create table if not exists public.face_embeddings (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  embedding double precision[] not null,
  created_at timestamptz not null default now()
);

alter table public.face_embeddings
  add column if not exists model text not null default 'insightface/buffalo_l';

delete from public.face_embeddings
where array_length(embedding, 1) is distinct from 512;

alter table public.face_embeddings
  drop constraint if exists face_embeddings_dim;

alter table public.face_embeddings
  add constraint face_embeddings_dim check (array_length(embedding, 1) = 512);

create index if not exists idx_face_embeddings_user_id
  on public.face_embeddings(user_id);

alter table public.face_embeddings enable row level security;

drop policy if exists "Users can view own face embeddings" on public.face_embeddings;
create policy "Users can view own face embeddings"
  on public.face_embeddings for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can delete own face embeddings" on public.face_embeddings;
create policy "Users can delete own face embeddings"
  on public.face_embeddings for delete
  to authenticated
  using (auth.uid() = user_id);

-- 4) Trabajos de registro. La app inserta la ruta de las fotos; el script las procesa.
create table if not exists public.face_enrollment_jobs (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles(id) on delete cascade not null,
  status text not null default 'pending'
    check (status in ('pending', 'done', 'failed')),
  storage_paths text[] not null,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint face_enrollment_jobs_paths_not_empty check (cardinality(storage_paths) >= 1)
);

create index if not exists idx_face_enrollment_jobs_status
  on public.face_enrollment_jobs(status, created_at);

drop trigger if exists on_face_enrollment_job_updated on public.face_enrollment_jobs;
create trigger on_face_enrollment_job_updated
  before update on public.face_enrollment_jobs
  for each row execute function public.handle_updated_at();

alter table public.face_enrollment_jobs enable row level security;

drop policy if exists "Users can view own face enrollment jobs" on public.face_enrollment_jobs;
create policy "Users can view own face enrollment jobs"
  on public.face_enrollment_jobs for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can create own face enrollment jobs" on public.face_enrollment_jobs;
create policy "Users can create own face enrollment jobs"
  on public.face_enrollment_jobs for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and status = 'pending'
    and cardinality(storage_paths) between 1 and 8
    and (
      select bool_and(p ~ ('^' || auth.uid()::text || '/[A-Za-z0-9._-]+$'))
      from unnest(storage_paths) as p
    )
  );

drop policy if exists "Users can delete own pending face enrollment jobs" on public.face_enrollment_jobs;
create policy "Users can delete own pending face enrollment jobs"
  on public.face_enrollment_jobs for delete
  to authenticated
  using (auth.uid() = user_id and status = 'pending');

-- 5) Petición desde la app: la máquina debe verificar a esa persona.
create table if not exists public.face_requests (
  id uuid default gen_random_uuid() primary key,
  machine_id uuid references public.machines(id) on delete cascade not null,
  user_id uuid references public.profiles(id) on delete cascade not null,
  status text not null default 'pending'
    check (status in ('pending', 'matched', 'failed', 'expired')),
  session_id uuid references public.recycling_sessions(id) on delete set null,
  error text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '90 seconds'),
  updated_at timestamptz not null default now()
);

create index if not exists idx_face_requests_machine_status
  on public.face_requests(machine_id, status, created_at);

create unique index if not exists idx_face_requests_one_pending_per_user
  on public.face_requests(user_id)
  where status = 'pending';

drop trigger if exists on_face_request_updated on public.face_requests;
create trigger on_face_request_updated
  before update on public.face_requests
  for each row execute function public.handle_updated_at();

alter table public.face_requests enable row level security;

drop policy if exists "Users can view own face requests" on public.face_requests;
create policy "Users can view own face requests"
  on public.face_requests for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can create own face requests" on public.face_requests;
create policy "Users can create own face requests"
  on public.face_requests for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and status = 'pending'
    and session_id is null
    and exists (
      select 1
      from public.machines
      where machines.id = machine_id
        and machines.is_active = true
    )
  );

drop policy if exists "Users can delete own pending face requests" on public.face_requests;
create policy "Users can delete own pending face requests"
  on public.face_requests for delete
  to authenticated
  using (auth.uid() = user_id and status = 'pending');

-- 6) Fotos temporales. Solo el dueño escribe en su carpeta. El script usa la service role.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('face-inbox', 'face-inbox', false, 5242880, array['image/jpeg'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users upload own face inbox" on storage.objects;
create policy "Users upload own face inbox"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'face-inbox'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
    and storage.extension(name) = 'jpg'
  );

drop policy if exists "Users read own face inbox" on storage.objects;
create policy "Users read own face inbox"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'face-inbox'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

drop policy if exists "Users delete own face inbox" on storage.objects;
create policy "Users delete own face inbox"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'face-inbox'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

grant select, delete on table public.face_embeddings to authenticated;
grant select, insert, delete on table public.face_enrollment_jobs to authenticated;
grant select, insert, delete on table public.face_requests to authenticated;
grant all on table public.face_embeddings to service_role;
grant all on table public.face_enrollment_jobs to service_role;
grant all on table public.face_requests to service_role;

-- 7) La app escucha el resultado de la petición en vivo.
do $$
begin
  alter publication supabase_realtime add table public.face_requests;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.face_enrollment_jobs;
exception
  when duplicate_object then null;
end $$;
