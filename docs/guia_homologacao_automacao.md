# 🛡️ Guia de Implantação Segura em Homologação (Sem Afetar Produção)

Este guia descreve como testar toda a **Automação WhatsApp (Evolution API) + Pix Mercado Pago** na branch isolada `homolog/automacao-whatsapp` sem causar qualquer impacto na loja em produção (`main`).

---

## 1. Isolamento em 3 Camadas

1. **Git & Vercel Preview:**
   - Todo o código novo está na branch `homolog/automacao-whatsapp`.
   - Ao enviar essa branch para o GitHub (`git push -u origin homolog/automacao-whatsapp`), a **Vercel gera automaticamente uma URL de Preview separada** (sem alterar `https://promissorias-lyart.vercel.app/`).
2. **Supabase de Homologação:**
   - Crie um segundo projeto no Supabase (ex.: `leooticas-homolog`).
   - Execute primeiro o `supabase/schema_completo.sql` e depois o `supabase/migrations/0005_automacao_whatsapp.sql`.
   - Crie um usuário admin na tabela `profiles` (`role = 'admin'`) e insira de **5 a 10 promissórias fictícias** usando os **números de WhatsApp da própria equipe**.
3. **Environment Variables exclusivas de `Preview` na Vercel:**
   No painel do projeto na Vercel → *Settings → Environment Variables*, marque **apenas o escopo `Preview`** (nunca `Production`) para:
   - `VITE_SUPABASE_URL` / `SUPABASE_URL` → URL do projeto **homolog**
   - `VITE_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` → Chaves do projeto **homolog**
   - `MP_ACCESS_TOKEN` → Token de teste (`TEST-...`) ou token para Pix simbólico de R$ 1,00
   - `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE` → Evolution API na sua VPS
   - `CRON_SECRET` → Senha forte aleatória
   - `GEMINI_API_KEY` → Chave do Google Gemini (para transcrição de áudios e interpretação de promessas)
   - `APP_BASE_URL` → URL do Preview da Vercel

---

## 2. Roteiro de Testes na Aba "Automação WhatsApp"

### Etapa A — Teste em `DRY-RUN` (Zero mensagens enviadas)
1. Confirme que o banner superior exibe **`🧪 MODO DRY-RUN`**.
2. Clique em **1. Preparar Lote do Dia**: o sistema buscará vencimentos do dia e promessas do dia no banco de homologação e gerará os itens na `Fila de Disparos` já com atrasos aleatórios (anti-banimento).
3. Clique em **2. Processar Próximo da Fila**: o item muda para `simulado` e aparece em **Logs de Auditoria**, sem chamar a Evolution API.
4. Na sub-aba **Cobranças Pix MP**, clique em **Simular Pix Pago**: confirma se a RPC `registrar_baixa_pagamento` deu baixa na promissória fictícia, marcou eventual promessa como cumprida e gerou o comprovante.
5. Na sub-aba **🤖 Simulador de Resposta WhatsApp**, envie `"Só consigo pagar dia 25"` com o telefone de teste e confira na aba **Agendar Promessa** se a promessa foi criada automaticamente.

### Etapa B — Teste em `WHITELIST` (WhatsApp Real apenas para a equipe)
1. Adicione **apenas o seu WhatsApp** (e o de outro sócio/gerente) na **Lista Branca de Testes (Whitelist)**.
2. Mude o modo para **`🛡️ Whitelist`**.
3. Conecte o chip de teste na VPS clicando em **📱 Conectar WhatsApp / Status** e lendo o QR Code.
4. Ligue o botão **▶️ Ativar Automação (Kill Switch)** e execute o fluxo real (disparo do Pix → pagamento de R$ 1,00 → webhook Mercado Pago → baixa automática → recebimento do comprovante no seu WhatsApp → envio de áudio/texto combinando nova data).

---

## 3. Configuração do Agendador na VPS / n8n (Para rodar sozinho)

Quando for ativar a rotina automática diária na VPS:
- **Preparar lote matinal (08:30 seg–sáb):**
  `POST https://SUA-URL/api/automacao/preparar-dia` com header `x-cron-secret: SEU_CRON_SECRET`
- **Processar fila respeitando o jitter (a cada 1 minuto das 08:30 às 18:00):**
  `POST https://SUA-URL/api/automacao/processar-fila` com header `x-cron-secret: SEU_CRON_SECRET`
- **Webhook Evolution API (configurar na instância da Evolution):**
  Apontar `messages.upsert` para `https://SUA-URL/api/webhooks/evolution` (com header opcional `x-webhook-secret`).
