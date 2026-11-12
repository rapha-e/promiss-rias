-- ==============================================================================
-- LeoÓticas.fin — Migration 0005: Automação WhatsApp (Evolution API) + Pix MP
-- ==============================================================================

-- 1. Configuração Singleton da Automação (com Travas de Segurança Dry-Run / Whitelist)
create table if not exists public.automacao_config (
  id integer primary key default 1 check (id = 1),
  ativo boolean not null default false, -- Kill Switch geral
  modo text not null default 'dry_run' check (modo in ('dry_run', 'whitelist', 'producao')),
  whitelist_telefones text[] not null default '{}',
  limite_diario integer not null default 30 check (limite_diario between 1 and 500),
  intervalo_min_seg integer not null default 45 check (intervalo_min_seg >= 10),
  intervalo_max_seg integer not null default 120 check (intervalo_max_seg >= 15),
  pausa_a_cada_n integer not null default 20 check (pausa_a_cada_n >= 5),
  pausa_minutos integer not null default 10 check (pausa_minutos >= 1),
  horario_inicio text not null default '08:30',
  horario_fim text not null default '18:00',
  cooldown_dias integer not null default 5 check (cooldown_dias >= 1),
  enviar_vencimento_dia boolean not null default true,
  enviar_promessa_dia boolean not null default true,
  enviar_inadimplencia boolean not null default false,
  enviar_comprovante_auto boolean not null default true,
  cadastrar_promessa_auto boolean not null default true,
  evolution_instance text not null default 'leooticas',
  updated_at timestamptz not null default now()
);

insert into public.automacao_config (id) values (1) on conflict (id) do nothing;

-- 2. Cobranças Pix Geradas via API Mercado Pago / Mercado Livre (Idempotência)
create table if not exists public.cobrancas_pix (
  id bigint generated always as identity primary key,
  promissoria_id bigint not null references public.promissorias (id) on delete cascade,
  cliente_nome text not null,
  telefone text not null default '',
  data_referencia date not null default public.hoje_br(),
  valor_centavos integer not null check (valor_centavos > 0),
  mp_payment_id text unique,
  external_reference text not null,
  qr_code text not null default '',
  qr_code_base64 text,
  ticket_url text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'cancelled', 'expired', 'rejected', 'dry_run')),
  baixa_realizada boolean not null default false,
  baixa_em timestamptz,
  pago_em timestamptz,
  expira_em timestamptz,
  payload_raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (promissoria_id, data_referencia)
);

create index if not exists cobrancas_pix_status_idx on public.cobrancas_pix (status);
create index if not exists cobrancas_pix_promissoria_idx on public.cobrancas_pix (promissoria_id);

-- 3. Fila de Disparos WhatsApp (Controle Anti-Banimento com Jitter e Janela)
create table if not exists public.fila_disparos_whatsapp (
  id bigint generated always as identity primary key,
  tipo text not null check (tipo in ('VENCIMENTO_DIA', 'PROMESSA_DIA', 'INADIMPLENCIA', 'COMPROVANTE', 'ATENDIMENTO')),
  prioridade integer not null default 5, -- 1 = mais urgente (ex: comprovante), 5 = normal
  promissoria_id bigint references public.promissorias (id) on delete set null,
  cobranca_pix_id bigint references public.cobrancas_pix (id) on delete set null,
  cliente_nome text not null,
  telefone text not null,
  telefone_normalizado text not null,
  mensagem text not null,
  pix_copia_cola text,
  regra_dias_atraso integer,
  status text not null default 'pendente'
    check (status in ('pendente', 'processando', 'enviado', 'simulado', 'bloqueado_whitelist', 'erro', 'cancelado')),
  agendado_para timestamptz not null default now(),
  enviado_em timestamptz,
  tentativas integer not null default 0,
  ultimo_erro text,
  evolution_message_id text,
  created_at timestamptz not null default now()
);

create index if not exists fila_disparos_status_agenda_idx
  on public.fila_disparos_whatsapp (status, prioridade, agendado_para);
create index if not exists fila_disparos_tel_idx
  on public.fila_disparos_whatsapp (telefone_normalizado, created_at desc);

-- 4. Controle de Contatos (Cooldown, Opt-Out, Número Inválido, Pausa para Humano)
create table if not exists public.whatsapp_contatos_controle (
  telefone_normalizado text primary key,
  cliente_nome text,
  opt_out boolean not null default false,
  whatsapp_invalido boolean not null default false,
  pausa_robo_ate timestamptz,
  ultimo_disparo_cobranca_em timestamptz,
  total_envios integer not null default 0,
  updated_at timestamptz not null default now()
);

-- 5. Logs Completos de Automação (Webhooks MP, Evolution, IA e Dry-Run)
create table if not exists public.automacao_logs (
  id bigint generated always as identity primary key,
  origem text not null, -- 'preparar_dia', 'processar_fila', 'webhook_mp', 'webhook_evolution', 'sistema'
  nivel text not null default 'info' check (nivel in ('info', 'warn', 'error', 'dry_run')),
  mensagem text not null,
  referencia_id text,
  detalhes jsonb,
  created_at timestamptz not null default now()
);

create index if not exists automacao_logs_created_idx on public.automacao_logs (created_at desc);

-- 6. Triggers de updated_at
drop trigger if exists automacao_config_updated_at on public.automacao_config;
create trigger automacao_config_updated_at before update on public.automacao_config
for each row execute function public.set_updated_at();

drop trigger if exists cobrancas_pix_updated_at on public.cobrancas_pix;
create trigger cobrancas_pix_updated_at before update on public.cobrancas_pix
for each row execute function public.set_updated_at();

drop trigger if exists whatsapp_contatos_updated_at on public.whatsapp_contatos_controle;
create trigger whatsapp_contatos_updated_at before update on public.whatsapp_contatos_controle
for each row execute function public.set_updated_at();

-- 7. Políticas RLS (Leitura autenticada; escrita administrativa; Backend usa Service Role)
alter table public.automacao_config enable row level security;
alter table public.cobrancas_pix enable row level security;
alter table public.fila_disparos_whatsapp enable row level security;
alter table public.whatsapp_contatos_controle enable row level security;
alter table public.automacao_logs enable row level security;

drop policy if exists "automacao_config: leitura" on public.automacao_config;
create policy "automacao_config: leitura" on public.automacao_config
  for select to authenticated using (true);
drop policy if exists "automacao_config: editar (admin)" on public.automacao_config;
create policy "automacao_config: editar (admin)" on public.automacao_config
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "cobrancas_pix: leitura" on public.cobrancas_pix;
create policy "cobrancas_pix: leitura" on public.cobrancas_pix
  for select to authenticated using (true);

drop policy if exists "fila_disparos: leitura" on public.fila_disparos_whatsapp;
create policy "fila_disparos: leitura" on public.fila_disparos_whatsapp
  for select to authenticated using (true);
drop policy if exists "fila_disparos: editar (admin)" on public.fila_disparos_whatsapp;
create policy "fila_disparos: editar (admin)" on public.fila_disparos_whatsapp
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "contatos_controle: leitura" on public.whatsapp_contatos_controle;
create policy "contatos_controle: leitura" on public.whatsapp_contatos_controle
  for select to authenticated using (true);
drop policy if exists "contatos_controle: editar (admin)" on public.whatsapp_contatos_controle;
create policy "contatos_controle: editar (admin)" on public.whatsapp_contatos_controle
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "automacao_logs: leitura" on public.automacao_logs;
create policy "automacao_logs: leitura" on public.automacao_logs
  for select to authenticated using (true);
