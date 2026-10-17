-- 0002: fundo perdido, histórico de baixas, alertas, ficha do cliente e relatório.
-- Execute DEPOIS de 0001_init.sql.

create function public.hoje_br() returns date language sql stable as $$
  select (now() at time zone 'America/Sao_Paulo')::date
$$;

-- Fundo perdido -------------------------------------------------------------
alter table public.promissorias
  add column fundo_perdido boolean not null default false,
  add column fundo_perdido_motivo text,
  add column fundo_perdido_em timestamptz,
  add column fundo_perdido_por uuid references auth.users (id) on delete set null;

alter table public.promissorias
  add constraint fundo_perdido_exige_motivo
  check (not fundo_perdido or char_length(btrim(coalesce(fundo_perdido_motivo, ''))) >= 3);

-- O status gerado passa a considerar o fundo perdido (recria a coluna).
alter table public.promissorias drop column status;
alter table public.promissorias add column status text generated always as (
  case when fundo_perdido then 'FUNDO PERDIDO'
       when greatest(divida_total - valor_pago, 0) = 0 then 'QUITADO'
       when valor_pago = 0 then 'NÃO PAGOU'
       else 'PAGANDO' end
) stored;
create index promissorias_status_idx on public.promissorias (status);

-- Histórico de baixas (nada é apagado; a baixa pode ser desfeita).
create table public.promissoria_eventos (
  id bigint generated always as identity primary key,
  promissoria_id bigint not null references public.promissorias (id) on delete cascade,
  tipo text not null check (tipo in ('FUNDO_PERDIDO', 'DESFEITO')),
  motivo text,
  saldo_na_data integer,
  usuario_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.promissoria_eventos enable row level security;
create policy "eventos: leitura" on public.promissoria_eventos for select to authenticated using (true);
-- sem policy de escrita: só as funções abaixo (security definer) gravam.

create function public.marcar_fundo_perdido(p_id bigint, p_motivo text)
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

create function public.desfazer_fundo_perdido(p_id bigint, p_motivo text default null)
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

revoke execute on function public.marcar_fundo_perdido(bigint, text) from public, anon;
revoke execute on function public.desfazer_fundo_perdido(bigint, text) from public, anon;
grant execute on function public.marcar_fundo_perdido(bigint, text) to authenticated;
grant execute on function public.desfazer_fundo_perdido(bigint, text) to authenticated;

-- Resumo do dashboard: saldo a receber e alertas ignoram o fundo perdido ----
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
      'NÃO PAGOU', count(*) filter (where status = 'NÃO PAGOU'),
      'FUNDO PERDIDO', count(*) filter (where status = 'FUNDO PERDIDO')),
    'vencidas_qtd', count(*) filter (where not fundo_perdido and saldo_devedor > 0 and vencimento < public.hoje_br()),
    'vencidas_valor', coalesce(sum(saldo_devedor) filter (where not fundo_perdido and vencimento < public.hoje_br()), 0),
    'proximas_qtd', count(*) filter (where not fundo_perdido and saldo_devedor > 0
                       and vencimento between public.hoje_br() and public.hoje_br() + 7),
    'proximas_valor', coalesce(sum(saldo_devedor) filter (where not fundo_perdido
                       and vencimento between public.hoje_br() and public.hoje_br() + 7), 0),
    'anos', coalesce((select jsonb_agg(a order by a desc)
                      from (select distinct ano as a from public.promissorias where ano is not null) x), '[]'::jsonb)
  ) from public.promissorias;
$$;

-- Ficha do cliente: agrupa pelo nome (sem diferenciar maiúsculas/espaços) ------
create function public.clientes_resumo(
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

create function public.cliente_promissorias(p_cliente text)
returns setof public.promissorias language sql stable security invoker set search_path = public as $$
  select * from public.promissorias
   where upper(btrim(cliente_nome)) = upper(btrim(p_cliente))
   order by vencimento desc nulls last, id desc;
$$;

-- Relatório de vencimentos (em aberto, sem fundo perdido) --------------------
create function public.relatorio_vencimentos(
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

grant execute on function public.clientes_resumo(text, boolean, integer, integer) to authenticated;
grant execute on function public.cliente_promissorias(text) to authenticated;
grant execute on function public.relatorio_vencimentos(date, date, text) to authenticated;
revoke execute on function public.clientes_resumo(text, boolean, integer, integer) from public, anon;
revoke execute on function public.cliente_promissorias(text) from public, anon;
revoke execute on function public.relatorio_vencimentos(date, date, text) from public, anon;
