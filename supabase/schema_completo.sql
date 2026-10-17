-- ==============================================================================
-- LeoÓticas.fin — Promissórias Loja
-- SCRIPT CONSOLIDADO COMPLETO PARA O SUPABASE (PostgreSQL + RLS + Funções)
-- ==============================================================================
-- Instruções:
-- 1. Abra o painel do seu projeto no Supabase (https://supabase.com).
-- 2. Vá no menu lateral esquerdo em "SQL Editor".
-- 3. Crie uma "New query", cole TODO este script e clique em "Run".
-- ==============================================================================

-- 1. Extensões
create extension if not exists pg_trgm with schema extensions;

-- 2. Função auxiliar de data no fuso de Brasília
create or replace function public.hoje_br() returns date language sql stable as $$
  select (now() at time zone 'America/Sao_Paulo')::date
$$;

-- 3. Perfis de Usuário e RBAC (Controle de Acesso)
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default now()
);

-- Trigger para criar perfil automaticamente quando um usuário é registrado no Supabase Auth
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users for each row execute function public.handle_new_user();

-- Função para checar se o usuário autenticado atual é administrador
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- 4. Tabela de Promissórias
-- Valores monetários em centavos (integer).
-- Saldo, ano e status são calculados SEMPRE no banco (colunas geradas).
create table if not exists public.promissorias (
  id bigint generated always as identity primary key,
  cliente_nome text not null check (char_length(btrim(cliente_nome)) >= 2),
  telefone text not null default '',
  divida_total integer not null check (divida_total >= 0),
  parcelas text not null default '',
  valor_pago integer not null default 0 check (valor_pago >= 0),
  saldo_devedor integer generated always as (greatest(divida_total - valor_pago, 0)) stored,
  vencimento date,
  ano integer generated always as (extract(year from vencimento)::integer) stored,
  fundo_perdido boolean not null default false,
  fundo_perdido_motivo text,
  fundo_perdido_em timestamptz,
  fundo_perdido_por uuid references auth.users (id) on delete set null,
  status text generated always as (
    case when fundo_perdido then 'FUNDO PERDIDO'
         when greatest(divida_total - valor_pago, 0) = 0 then 'QUITADO'
         when valor_pago = 0 then 'NÃO PAGOU'
         else 'PAGANDO' end
  ) stored,
  origem text not null default 'SISTEMA WEB',
  source_row integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fundo_perdido_exige_motivo check (not fundo_perdido or char_length(btrim(coalesce(fundo_perdido_motivo, ''))) >= 3),
  unique (origem, source_row)
);

-- Índices para alta performance em buscas e filtros
create index if not exists promissorias_vencimento_idx on public.promissorias (vencimento desc);
create index if not exists promissorias_status_idx on public.promissorias (status);
create index if not exists promissorias_ano_idx on public.promissorias (ano);
create index if not exists promissorias_cliente_trgm on public.promissorias using gin (cliente_nome extensions.gin_trgm_ops);
create index if not exists promissorias_telefone_trgm on public.promissorias using gin (telefone extensions.gin_trgm_ops);

-- Trigger de updated_at automático
create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists promissorias_updated_at on public.promissorias;
create trigger promissorias_updated_at
before update on public.promissorias
for each row execute function public.set_updated_at();

-- 5. Histórico e Auditoria de Baixas e Pagamentos
create table if not exists public.promissoria_pagamentos (
  id bigint generated always as identity primary key,
  promissoria_id bigint not null references public.promissorias (id) on delete cascade,
  valor_pago integer not null check (valor_pago > 0),
  operador_email text not null default '',
  operador_id uuid references auth.users (id) on delete set null,
  data_pagamento timestamptz not null default now(),
  detalhes text,
  created_at timestamptz not null default now()
);

create index if not exists promissoria_pagamentos_promissoria_id_idx on public.promissoria_pagamentos (promissoria_id);
create index if not exists promissoria_pagamentos_data_idx on public.promissoria_pagamentos (data_pagamento desc);

create table if not exists public.promissoria_eventos (
  id bigint generated always as identity primary key,
  promissoria_id bigint not null references public.promissorias (id) on delete cascade,
  tipo text not null check (tipo in ('FUNDO_PERDIDO', 'DESFEITO', 'BAIXA', 'PAGAMENTO')),
  motivo text,
  saldo_na_data integer,
  usuario_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

-- 6. Funções de Fundo Perdido (Apenas Admins)
create or replace function public.marcar_fundo_perdido(p_id bigint, p_motivo text)
returns public.promissorias language plpgsql security definer set search_path = public as $$
declare r public.promissorias;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem marcar fundo perdido' using errcode = '42501';
  end if;
  if p_motivo is null or char_length(btrim(p_motivo)) < 3 then
    raise exception 'Informe o motivo (mínimo 3 caracteres)';
  end if;
  update public.promissorias
     set fundo_perdido = true, fundo_perdido_motivo = btrim(p_motivo),
         fundo_perdido_em = now(), fundo_perdido_por = auth.uid()
   where id = p_id and not fundo_perdido and saldo_devedor > 0
   returning * into r;
  if not found then
    raise exception 'Promissória não encontrada, sem saldo ou já em fundo perdido';
  end if;
  insert into public.promissoria_eventos (promissoria_id, tipo, motivo, saldo_na_data, usuario_id)
  values (p_id, 'FUNDO_PERDIDO', btrim(p_motivo), r.saldo_devedor, auth.uid());
  return r;
end $$;

create or replace function public.desfazer_fundo_perdido(p_id bigint, p_motivo text default null)
returns public.promissorias language plpgsql security definer set search_path = public as $$
declare r public.promissorias;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem desfazer fundo perdido' using errcode = '42501';
  end if;
  update public.promissorias
     set fundo_perdido = false, fundo_perdido_motivo = null, fundo_perdido_em = null, fundo_perdido_por = null
   where id = p_id and fundo_perdido
   returning * into r;
  if not found then
    raise exception 'Promissória não encontrada ou não está em fundo perdido';
  end if;
  insert into public.promissoria_eventos (promissoria_id, tipo, motivo, saldo_na_data, usuario_id)
  values (p_id, 'DESFEITO', nullif(btrim(coalesce(p_motivo, '')), ''), r.saldo_devedor, auth.uid());
  return r;
end $$;

-- 7. Resumo Geral para o Dashboard
create or replace function public.promissorias_resumo() returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'total', count(*),
    'divida', coalesce(sum(divida_total), 0),
    'pago', coalesce(sum(valor_pago), 0),
    'saldo', coalesce(sum(saldo_devedor) filter (where not fundo_perdido), 0),
    'perdido', coalesce(sum(saldo_devedor) filter (where fundo_perdido), 0),
    'status', jsonb_build_object(
      'QUITADO', count(*) filter (where status = 'QUITADO'),
      'PAGANDO', count(*) filter (where status = 'PAGANDO'),
      'A VENCER', count(*) filter (where not fundo_perdido and valor_pago = 0 and (vencimento >= public.hoje_br() or vencimento is null)),
      'NÃO PAGOU', count(*) filter (where not fundo_perdido and valor_pago = 0 and vencimento < public.hoje_br()),
      'FUNDO PERDIDO', count(*) filter (where status = 'FUNDO PERDIDO')),
    'vencidas_qtd', count(*) filter (where not fundo_perdido and saldo_devedor > 0 and vencimento < public.hoje_br()),
    'vencidas_valor', coalesce(sum(saldo_devedor) filter (where not fundo_perdido and vencimento < public.hoje_br()), 0),
    'proximas_qtd', count(*) filter (where not fundo_perdido and saldo_devedor > 0
                       and vencimento between public.hoje_br() and public.hoje_br() + 7),
    'proximas_valor', coalesce(sum(saldo_devedor) filter (where not fundo_perdido
                       and vencimento between public.hoje_br() and public.hoje_br() + 7), 0),
    'd1_qtd', count(*) filter (where not fundo_perdido and saldo_devedor > 0
               and vencimento between public.hoje_br() and public.hoje_br() + 1),
    'd1_valor', coalesce(sum(saldo_devedor) filter (where not fundo_perdido
               and vencimento between public.hoje_br() and public.hoje_br() + 1), 0),
    'd7_qtd', count(*) filter (where not fundo_perdido and saldo_devedor > 0
               and vencimento between public.hoje_br() and public.hoje_br() + 7),
    'd7_valor', coalesce(sum(saldo_devedor) filter (where not fundo_perdido
               and vencimento between public.hoje_br() and public.hoje_br() + 7), 0),
    'd30_qtd', count(*) filter (where not fundo_perdido and saldo_devedor > 0
               and vencimento between public.hoje_br() and public.hoje_br() + 30),
    'd30_valor', coalesce(sum(saldo_devedor) filter (where not fundo_perdido
               and vencimento between public.hoje_br() and public.hoje_br() + 30), 0),
    'anos', coalesce((select jsonb_agg(a order by a desc)
                      from (select distinct ano as a from public.promissorias where ano is not null) x), '[]'::jsonb)
  ) from public.promissorias;
$$;

-- 8. Ficha de Clientes Agrupada
create or replace function public.clientes_resumo(
  p_busca text default '', p_somente_abertos boolean default false,
  p_limit integer default 30, p_offset integer default 0)
returns table (cliente text, telefone text, qtd bigint, divida bigint, pago bigint, saldo bigint,
               perdido bigint, vencido bigint, proximo_venc date, total_clientes bigint)
language sql stable security invoker set search_path = public as $$
  with g as (
    select upper(btrim(p.cliente_nome)) as cli,
           (array_agg(p.telefone order by (p.telefone <> '') desc, p.vencimento desc nulls last))[1] as tel,
           count(*) as qtd,
           sum(p.divida_total)::bigint as divida,
           sum(p.valor_pago)::bigint as pago,
           coalesce(sum(p.saldo_devedor) filter (where not p.fundo_perdido), 0)::bigint as saldo,
           coalesce(sum(p.saldo_devedor) filter (where p.fundo_perdido), 0)::bigint as perdido,
           coalesce(sum(p.saldo_devedor) filter (where not p.fundo_perdido and p.vencimento < public.hoje_br()), 0)::bigint as vencido,
           min(p.vencimento) filter (where not p.fundo_perdido and p.saldo_devedor > 0
                                     and p.vencimento >= public.hoje_br()) as prox
      from public.promissorias p
     group by upper(btrim(p.cliente_nome))
    having coalesce(p_busca, '') = ''
        or bool_or(p.cliente_nome ilike '%' || btrim(p_busca) || '%' or p.telefone ilike '%' || btrim(p_busca) || '%')
  )
  select cli, tel, qtd, divida, pago, saldo, perdido, vencido, prox, count(*) over ()
    from g
   where not p_somente_abertos or saldo > 0
   order by (saldo > 0) desc, vencido desc, saldo desc, cli
   limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0);
$$;

create or replace function public.cliente_promissorias(p_cliente text)
returns setof public.promissorias language sql stable security invoker set search_path = public as $$
  select * from public.promissorias
   where upper(btrim(cliente_nome)) = upper(btrim(p_cliente))
   order by vencimento desc nulls last, id desc;
$$;

-- 9. Relatório de Vencimentos
create or replace function public.relatorio_vencimentos(
  p_inicio date default null, p_fim date default null, p_situacao text default 'todas')
returns table (id bigint, cliente_nome text, telefone text, parcelas text, divida_total integer,
               valor_pago integer, saldo_devedor integer, vencimento date, dias_atraso integer)
language sql stable security invoker set search_path = public as $$
  select p.id, p.cliente_nome, p.telefone, p.parcelas, p.divida_total, p.valor_pago, p.saldo_devedor,
         p.vencimento, greatest(public.hoje_br() - p.vencimento, 0)
    from public.promissorias p
   where not p.fundo_perdido and p.saldo_devedor > 0 and p.vencimento is not null
     and p.vencimento between coalesce(p_inicio, date '1900-01-01') and coalesce(p_fim, date '2999-12-31')
     and (p_situacao = 'todas'
          or (p_situacao = 'vencidas' and p.vencimento < public.hoje_br())
          or (p_situacao = 'a_vencer' and p.vencimento >= public.hoje_br()))
   order by p.vencimento, p.id;
$$;

-- 10. Políticas de Segurança (Row Level Security - RLS)
alter table public.profiles enable row level security;
alter table public.promissorias enable row level security;
alter table public.promissoria_eventos enable row level security;

-- Profiles: cada usuário autenticado pode ler apenas o seu perfil
drop policy if exists "perfil: ler o próprio" on public.profiles;
create policy "perfil: ler o próprio" on public.profiles
  for select to authenticated using (id = auth.uid());

-- Promissórias: leitura para qualquer usuário autenticado; escrita restrita a admins
drop policy if exists "promissorias: leitura" on public.promissorias;
create policy "promissorias: leitura" on public.promissorias
  for select to authenticated using (true);

drop policy if exists "promissorias: inserir (admin)" on public.promissorias;
create policy "promissorias: inserir (admin)" on public.promissorias
  for insert to authenticated with check (public.is_admin());

drop policy if exists "promissorias: editar (admin)" on public.promissorias;
create policy "promissorias: editar (admin)" on public.promissorias
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "promissorias: excluir (admin)" on public.promissorias;
create policy "promissorias: excluir (admin)" on public.promissorias
  for delete to authenticated using (public.is_admin());

-- Eventos: leitura para autenticados; escrita via funções security definer
alter table public.promissoria_pagamentos enable row level security;

drop policy if exists "pagamentos: leitura" on public.promissoria_pagamentos;
create policy "pagamentos: leitura" on public.promissoria_pagamentos
  for select to authenticated using (true);

drop policy if exists "pagamentos: inserir (admin)" on public.promissoria_pagamentos;
create policy "pagamentos: inserir (admin)" on public.promissoria_pagamentos
  for insert to authenticated with check (public.is_admin());

drop policy if exists "eventos: leitura" on public.promissoria_eventos;
create policy "eventos: leitura" on public.promissoria_eventos
  for select to authenticated using (true);

-- 11. Permissões de Execução (Grants / Revokes)
revoke execute on function public.promissorias_resumo() from public, anon;
grant execute on function public.promissorias_resumo() to authenticated;

revoke execute on function public.marcar_fundo_perdido(bigint, text) from public, anon;
revoke execute on function public.desfazer_fundo_perdido(bigint, text) from public, anon;
grant execute on function public.marcar_fundo_perdido(bigint, text) to authenticated;
grant execute on function public.desfazer_fundo_perdido(bigint, text) to authenticated;

revoke execute on function public.clientes_resumo(text, boolean, integer, integer) from public, anon;
revoke execute on function public.cliente_promissorias(text) from public, anon;
revoke execute on function public.relatorio_vencimentos(date, date, text) from public, anon;
grant execute on function public.clientes_resumo(text, boolean, integer, integer) to authenticated;
grant execute on function public.cliente_promissorias(text) to authenticated;
grant execute on function public.relatorio_vencimentos(date, date, text) to authenticated;

-- ==============================================================================
-- DICA: Como promover seu usuário para Administrador
-- Após cadastrar o seu primeiro usuário na aba Authentication do Supabase,
-- execute a query abaixo com o seu e-mail:
--
-- UPDATE public.profiles SET role = 'admin' WHERE email = 'seu-email@dominio.com';
-- ==============================================================================
