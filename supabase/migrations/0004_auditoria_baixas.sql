-- ==============================================================================
-- LeoÓticas.fin — Migration 0004: Auditoria de Baixas e Pagamentos
-- ==============================================================================

-- 1. Tabela de Pagamentos / Baixas com Auditoria
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

-- Índices para alta performance
create index if not exists promissoria_pagamentos_promissoria_id_idx on public.promissoria_pagamentos (promissoria_id);
create index if not exists promissoria_pagamentos_data_idx on public.promissoria_pagamentos (data_pagamento desc);

-- RLS (Segurança de Linha)
alter table public.promissoria_pagamentos enable row level security;

drop policy if exists "pagamentos: leitura" on public.promissoria_pagamentos;
create policy "pagamentos: leitura" on public.promissoria_pagamentos
  for select to authenticated using (true);

drop policy if exists "pagamentos: inserir (admin)" on public.promissoria_pagamentos;
create policy "pagamentos: inserir (admin)" on public.promissoria_pagamentos
  for insert to authenticated with check (public.is_admin());

-- 2. Atualizar constraint de promissoria_eventos para aceitar tipos de baixa/pagamento
alter table public.promissoria_eventos drop constraint if exists promissoria_eventos_tipo_check;
alter table public.promissoria_eventos add constraint promissoria_eventos_tipo_check
  check (tipo in ('FUNDO_PERDIDO', 'DESFEITO', 'BAIXA', 'PAGAMENTO'));
