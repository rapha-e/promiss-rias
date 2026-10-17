-- LeoÓticas.fin — Promissórias Loja (Supabase / Postgres)
-- Execute no SQL Editor do Supabase (ou via supabase db push).

create extension if not exists pg_trgm with schema extensions;

-- Perfis e papéis ---------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default now()
);

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email) on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
after insert on auth.users for each row execute function public.handle_new_user();

create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- Promissórias --------------------------------------------------------------
-- Valores em centavos. Saldo, ano e status são derivados SEMPRE no banco.
create table public.promissorias (
  id bigint generated always as identity primary key,
  cliente_nome text not null check (char_length(btrim(cliente_nome)) >= 2),
  telefone text not null default '',
  divida_total integer not null check (divida_total >= 0),
  parcelas text not null default '',
  valor_pago integer not null default 0 check (valor_pago >= 0),
  saldo_devedor integer generated always as (greatest(divida_total - valor_pago, 0)) stored,
  vencimento date,
  ano integer generated always as (extract(year from vencimento)::integer) stored,
  status text generated always as (
    case when greatest(divida_total - valor_pago, 0) = 0 then 'QUITADO'
         when valor_pago = 0 then 'NÃO PAGOU'
         else 'PAGANDO' end
  ) stored,
  origem text not null default 'SISTEMA WEB',
  source_row integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (origem, source_row)
);

create index promissorias_vencimento_idx on public.promissorias (vencimento desc);
create index promissorias_status_idx on public.promissorias (status);
create index promissorias_ano_idx on public.promissorias (ano);
create index promissorias_cliente_trgm on public.promissorias using gin (cliente_nome extensions.gin_trgm_ops);
create index promissorias_telefone_trgm on public.promissorias using gin (telefone extensions.gin_trgm_ops);

create function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger promissorias_updated_at before update on public.promissorias
for each row execute function public.set_updated_at();

-- Resumo para o dashboard ----------------------------------------------------
create function public.promissorias_resumo() returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'total', count(*),
    'divida', coalesce(sum(divida_total), 0),
    'pago', coalesce(sum(valor_pago), 0),
    'saldo', coalesce(sum(saldo_devedor), 0),
    'status', jsonb_build_object(
      'QUITADO', count(*) filter (where status = 'QUITADO'),
      'PAGANDO', count(*) filter (where status = 'PAGANDO'),
      'NÃO PAGOU', count(*) filter (where status = 'NÃO PAGOU')),
    'anos', coalesce((select jsonb_agg(a order by a desc)
                      from (select distinct ano as a from public.promissorias where ano is not null) x), '[]'::jsonb)
  ) from public.promissorias;
$$;

revoke execute on function public.promissorias_resumo() from public, anon;
grant execute on function public.promissorias_resumo() to authenticated;

-- RLS: leitura para autenticados; escrita só para admin ---------------------
alter table public.profiles enable row level security;
alter table public.promissorias enable row level security;

create policy "perfil: ler o próprio" on public.profiles
  for select to authenticated using (id = auth.uid());

create policy "promissorias: leitura" on public.promissorias
  for select to authenticated using (true);
create policy "promissorias: inserir (admin)" on public.promissorias
  for insert to authenticated with check (public.is_admin());
create policy "promissorias: editar (admin)" on public.promissorias
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "promissorias: excluir (admin)" on public.promissorias
  for delete to authenticated using (public.is_admin());
