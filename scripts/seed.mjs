// Importa data/promissorias.json (idempotente: upsert por origem + source_row).
// Uso: npm run seed   (requer SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY em .env.local)
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY em .env.local");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });
const rows = JSON.parse(readFileSync(new URL("../data/promissorias.json", import.meta.url), "utf8"));

for (let i = 0; i < rows.length; i += 500) {
  const { error } = await sb.from("promissorias").upsert(rows.slice(i, i + 500), { onConflict: "origem,source_row" });
  if (error) { console.error("Falha no lote", i, error.message); process.exit(1); }
  console.log(`Importados ${Math.min(i + 500, rows.length)} de ${rows.length}`);
}
console.log("Importação concluída");
