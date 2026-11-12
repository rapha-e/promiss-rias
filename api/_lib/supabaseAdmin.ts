import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type ModoAutomacao = "dry_run" | "whitelist" | "producao";

export interface AutomacaoConfig {
  id: number;
  ativo: boolean;
  modo: ModoAutomacao;
  whitelist_telefones: string[];
  limite_diario: number;
  intervalo_min_seg: number;
  intervalo_max_seg: number;
  pausa_a_cada_n: number;
  pausa_minutos: number;
  horario_inicio: string;
  horario_fim: string;
  cooldown_dias: number;
  enviar_vencimento_dia: boolean;
  enviar_promessa_dia: boolean;
  enviar_inadimplencia: boolean;
  enviar_comprovante_auto: boolean;
  cadastrar_promessa_auto: boolean;
  evolution_instance: string;
}

export function getSupabaseAdmin(): SupabaseClient {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !serviceKey) {
    throw new Error("Variáveis SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY não configuradas no servidor.");
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function autorizarAdminOuCron(
  req: any,
  supabase: SupabaseClient
): Promise<{ ok: boolean; via: "cron" | "admin" | "none"; email?: string; erro?: string }> {
  const cronSecret = process.env.CRON_SECRET || "";
  const headerSecret =
    (req.headers?.["x-cron-secret"] as string | undefined) ||
    (req.query?.secret as string | undefined) ||
    "";

  if (cronSecret && headerSecret === cronSecret) {
    return { ok: true, via: "cron", email: "cron@leooticas.fin" };
  }

  const authHeader = (req.headers?.authorization as string | undefined) || "";
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (cronSecret && token === cronSecret) {
      return { ok: true, via: "cron", email: "cron@leooticas.fin" };
    }
    const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
    if (!userErr && userRes?.user) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", userRes.user.id)
        .maybeSingle();
      if (profile?.role === "admin") {
        return { ok: true, via: "admin", email: userRes.user.email || "admin" };
      }
      return { ok: false, via: "none", erro: "Acesso restrito a administradores." };
    }
  }

  return { ok: false, via: "none", erro: "Não autorizado." };
}

/** Normaliza telefone brasileiro para formato 55+DDD+número */
export function normalizarTelefoneWhatsApp(texto: string, dddPadrao = "61"): string | null {
  for (const parte of (texto || "").split(/[\/;,|]| e | ou /i)) {
    let d = parte.replace(/\D/g, "").replace(/^0+/, "");
    if (d.length >= 12 && d.startsWith("55")) d = d.slice(2);
    if (d.length === 9 && d[0] === "9") d = dddPadrao + d;
    else if (d.length === 8) d = dddPadrao + d;
    const ok = (d.length === 11 && d[2] === "9") || d.length === 10;
    if (ok && Number(d.slice(0, 2)) >= 11) return "55" + d;
  }
  return null;
}

/** Compara telefone flexivelmente (com/sem 9º dígito após DDD) para Whitelist e busca */
export function equivalentesTelefoneBR(telA: string, telB: string): boolean {
  const a = normalizarTelefoneWhatsApp(telA) || telA.replace(/\D/g, "");
  const b = normalizarTelefoneWhatsApp(telB) || telB.replace(/\D/g, "");
  if (!a || !b) return false;
  if (a === b) return true;
  // Trata eventual ausência/presença do 9º dígito no mesmo DDD
  const ultimos8A = a.slice(-8);
  const ultimos8B = b.slice(-8);
  const dddA = a.slice(0, 4);
  const dddB = b.slice(0, 4);
  return dddA === dddB && ultimos8A === ultimos8B;
}

export function hojeBR(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function dentroJanelaComercial(inicioHHMM = "08:30", fimHHMM = "18:00"): {
  permitido: boolean;
  motivo?: string;
} {
  const agora = new Date();
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(agora);

  const weekday = partes.find(p => p.type === "weekday")?.value || "";
  const hh = Number(partes.find(p => p.type === "hour")?.value || 0);
  const mm = Number(partes.find(p => p.type === "minute")?.value || 0);
  const minAtual = hh * 60 + mm;

  if (weekday === "Sun") {
    return { permitido: false, motivo: "Domingo bloqueado pela política anti-banimento." };
  }

  const [iniH, iniM] = inicioHHMM.split(":").map(Number);
  const [fimH, fimM] = fimHHMM.split(":").map(Number);
  const minIni = (iniH || 8) * 60 + (iniM || 30);
  const minFim = weekday === "Sat" ? Math.min((fimH || 18) * 60 + (fimM || 0), 13 * 60) : (fimH || 18) * 60 + (fimM || 0);

  if (minAtual < minIni || minAtual > minFim) {
    return {
      permitido: false,
      motivo: `Fora da janela comercial (${inicioHHMM}–${weekday === "Sat" ? "13:00" : fimHHMM} BRT).`,
    };
  }
  return { permitido: true };
}

export async function registrarLog(
  supabase: SupabaseClient,
  origem: string,
  nivel: "info" | "warn" | "error" | "dry_run",
  mensagem: string,
  referenciaId?: string | number | null,
  detalhes?: unknown
) {
  try {
    await supabase.from("automacao_logs").insert({
      origem,
      nivel,
      mensagem,
      referencia_id: referenciaId != null ? String(referenciaId) : null,
      detalhes: detalhes ?? null,
    });
  } catch (e) {
    console.error("Falha ao registrar automacao_logs:", e);
  }
}

export async function carregarConfigAutomacao(supabase: SupabaseClient): Promise<AutomacaoConfig> {
  const { data, error } = await supabase
    .from("automacao_config")
    .select("*")
    .eq("id", 1)
    .single();
  if (error || !data) {
    throw new Error("Tabela automacao_config não encontrada. Execute a migration 0005_automacao_whatsapp.sql.");
  }
  return data as AutomacaoConfig;
}
