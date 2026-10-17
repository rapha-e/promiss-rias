-- 0003: Projeções de recebimento (D+1, D+7, D+30) e distinção entre "A VENCER" e "NÃO PAGOU"
-- Execute no SQL Editor do Supabase

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

revoke execute on function public.promissorias_resumo() from public, anon;
grant execute on function public.promissorias_resumo() to authenticated;
