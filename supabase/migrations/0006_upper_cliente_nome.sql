-- ==============================================================================
-- LeoÓticas.fin — Migration 0006: Garantir cliente_nome sempre em MAIÚSCULO
-- ==============================================================================

create or replace function public.forcar_cliente_nome_upper()
returns trigger language plpgsql as $$
begin
  if new.cliente_nome is not null then
    new.cliente_nome = upper(btrim(new.cliente_nome));
  end if;
  return new;
end $$;

drop trigger if exists trg_promissorias_cliente_nome_upper on public.promissorias;
create trigger trg_promissorias_cliente_nome_upper
  before insert or update of cliente_nome on public.promissorias
  for each row execute function public.forcar_cliente_nome_upper();

-- Padronizar registros existentes no banco
update public.promissorias
   set cliente_nome = upper(btrim(cliente_nome))
 where cliente_nome is not null
   and cliente_nome <> upper(btrim(cliente_nome));
