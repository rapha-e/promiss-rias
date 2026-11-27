-- Migration 0007: Políticas de RLS para auditoria de exclusões de promissórias em automacao_logs
-- Garante que administradores autenticados possam gravar e consultar logs de EXCLUSAO_PROMISSORIA
-- sem risco de perda por ON DELETE CASCADE da tabela promissorias.

do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'automacao_logs'
  ) then
    alter table public.automacao_logs enable row level security;

    drop policy if exists "automacao_logs: leitura autenticados" on public.automacao_logs;
    create policy "automacao_logs: leitura autenticados"
      on public.automacao_logs
      for select
      to authenticated
      using (true);

    drop policy if exists "automacao_logs: inserir exclusao admin" on public.automacao_logs;
    create policy "automacao_logs: inserir exclusao admin"
      on public.automacao_logs
      for insert
      to authenticated
      with check (origem = 'EXCLUSAO_PROMISSORIA' and public.is_admin());
  end if;
end $$;
