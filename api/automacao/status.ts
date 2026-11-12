import { checarConexaoEvolution, obterQrCodeEvolution } from "../_lib/evolution.js";
import {
  autorizarAdminOuCron,
  carregarConfigAutomacao,
  dentroJanelaComercial,
  getSupabaseAdmin,
} from "../_lib/supabaseAdmin.js";

export default async function handler(req: any, res: any) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  try {
    const supabase = getSupabaseAdmin();
    const auth = await autorizarAdminOuCron(req, supabase);
    if (!auth.ok) {
      return res.status(401).json({ error: auth.erro || "Não autorizado" });
    }

    const config = await carregarConfigAutomacao(supabase);
    const conexao = await checarConexaoEvolution(config.evolution_instance);
    const janela = dentroJanelaComercial(config.horario_inicio, config.horario_fim);

    let qrcode: any = null;
    if (req.query?.qrcode === "1" && !conexao.conectado) {
      qrcode = await obterQrCodeEvolution(config.evolution_instance);
    }

    return res.status(200).json({
      ok: true,
      ambiente: {
        mp_configurado: Boolean(process.env.MP_ACCESS_TOKEN),
        mp_modo_teste: (process.env.MP_ACCESS_TOKEN || "").startsWith("TEST-"),
        evolution_configurado: Boolean(process.env.EVOLUTION_API_URL && process.env.EVOLUTION_API_KEY),
        gemini_configurado: Boolean(process.env.GEMINI_API_KEY),
        cron_configurado: Boolean(process.env.CRON_SECRET),
      },
      janela,
      evolution: conexao,
      qrcode,
      config,
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
