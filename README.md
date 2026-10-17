# LeoÓticas.fin — Promissórias Loja (Supabase + Vercel)

Vite + React no frontend; Supabase (Postgres, Auth, RLS) no backend; deploy na Vercel.
Saldo, ano e status são **colunas geradas no banco**: o navegador nunca define esses valores.
Só `admin` grava (garantido por RLS e pelas funções do banco); os demais usuários têm leitura.

## Funcionalidades
- **Promissórias**: dashboard, filtros (em aberto, quitado, pagando, não pagou, fundo perdido, ano), busca, cadastro/edição.
- **Alertas**: banner com vencidas e a vencer em 7 dias (clique para filtrar) e selo por linha ("Vencida há N dias", "Vence em N dias").
- **Clientes (ficha)**: promissórias agrupadas pelo nome do cliente (sem diferenciar maiúsculas/espaços), com total devido,
  total pago, saldo e todas as promissórias; quem tem saldo em aberto vem primeiro (os mais atrasados no topo).
- **Relatório**: vencidas / a vencer / todas em aberto, por período, com dias de atraso, faixas de atraso, **Exportar CSV** e **Imprimir**.
- **Fundo perdido** (somente admin): exige motivo, registra data e usuário; sai do saldo a receber e dos alertas, mas
  permanece no histórico (tabela `promissoria_eventos`). Pode ser desfeito.
- **WhatsApp (link manual)**: botão de cobrança por promissória, por cliente e no relatório. Abre o WhatsApp com a mensagem
  pronta (editável); o envio é feito por você. O telefone é normalizado para `55 + DDD + número`.
  Números sem DDD usam o **DDD padrão** (informado no diálogo, padrão 61, salvo no navegador). Campos com dois números
  ("9999/8888") viram uma lista para escolher.

## 1. Supabase
1. Crie um projeto em supabase.com.
2. **SQL Editor**: execute, nesta ordem, `supabase/migrations/0001_init.sql` e `supabase/migrations/0002_fundo_perdido_alertas.sql`.
3. **Authentication → Users → Add user**: crie os usuários (e-mail + senha, marque *Auto Confirm*).
   Em **Authentication → Providers → Email**, desative *Enable sign ups* para impedir cadastros abertos.
4. Promova o administrador (SQL Editor):
   ```sql
   update public.profiles set role = 'admin' where email = 'voce@empresa.com';
   ```
5. Importe os 7.141 registros, escolhendo **uma** opção:
   - **Script**: copie `.env.example` para `.env.local`, preencha `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`
     (Project Settings → API), depois `npm install && npm run seed` (idempotente).
   - **Painel**: Table Editor → `promissorias` → *Import data from CSV* → `data/promissorias.csv`.

## 2. Rodar localmente
```bash
npm install
npm run dev     # precisa de VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY em .env.local
```

## 3. Vercel
1. Suba esta pasta para um repositório no GitHub.
2. Vercel → *Add New Project* → importe o repositório (o preset Vite é detectado).
3. **Environment Variables**: `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` (Project Settings → API → *anon public*).
   **Não** cadastre a service role key na Vercel.
4. Faça o deploy. Depois, em Supabase → Authentication → URL Configuration, informe a URL da Vercel em *Site URL*.

## Segurança
- A *anon key* é pública por design; a proteção real é a RLS das migrações.
- A *service role key* ignora a RLS: use apenas localmente para o seed e nunca a versione.
- Datas de vencimento/alertas usam o fuso de Brasília (`America/Sao_Paulo`).
