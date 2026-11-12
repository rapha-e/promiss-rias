import type { AutomacaoConfig } from "./supabaseAdmin.js";
import { equivalentesTelefoneBR, normalizarTelefoneWhatsApp } from "./supabaseAdmin.js";

function getEvolutionCreds(instanceOverride?: string) {
  const url = (process.env.EVOLUTION_API_URL || "").replace(/\/$/, "");
  const apiKey = process.env.EVOLUTION_API_KEY || "";
  const instance = instanceOverride || process.env.EVOLUTION_INSTANCE || "leooticas";
  return { url, apiKey, instance };
}

export function avaliarPermissaoEnvio(
  config: AutomacaoConfig,
  telefoneDestino: string
): { permitido: boolean; acao: "enviar" | "dry_run" | "bloqueado_whitelist" | "pausado"; motivo: string } {
  if (!config.ativo) {
    return {
      permitido: false,
      acao: "pausado",
      motivo: "Kill Switch: automacao_config.ativo está desligado (false).",
    };
  }

  if (config.modo === "dry_run") {
    return {
      permitido: false,
      acao: "dry_run",
      motivo: "Modo DRY-RUN ativo: envio simulado e registrado em log.",
    };
  }

  if (config.modo === "whitelist") {
    const autorizado = (config.whitelist_telefones || []).some(w =>
      equivalentesTelefoneBR(w, telefoneDestino)
    );
    if (!autorizado) {
      return {
        permitido: false,
        acao: "bloqueado_whitelist",
        motivo: `Modo WHITELIST ativo: telefone ${telefoneDestino} não está na lista autorizada.`,
      };
    }
    return {
      permitido: true,
      acao: "enviar",
      motivo: "Autorizado pela Whitelist de homologação.",
    };
  }

  return {
    permitido: true,
    acao: "enviar",
    motivo: "Modo Produção autorizado.",
  };
}

export async function checarConexaoEvolution(instanceOverride?: string): Promise<{
  configurado: boolean;
  conectado: boolean;
  estado: string;
  detalhes?: any;
}> {
  const { url, apiKey, instance } = getEvolutionCreds(instanceOverride);
  if (!url || !apiKey) {
    return {
      configurado: false,
      conectado: false,
      estado: "nao_configurado",
    };
  }

  try {
    const resp = await fetch(`${url}/instance/connectionState/${encodeURIComponent(instance)}`, {
      headers: { apikey: apiKey },
    });
    const data: any = await resp.json();
    const estado = data?.instance?.state || data?.state || (resp.ok ? "desconhecido" : `http_${resp.status}`);
    return {
      configurado: true,
      conectado: estado === "open" || estado === "connected",
      estado,
      detalhes: data,
    };
  } catch (e: any) {
    return {
      configurado: true,
      conectado: false,
      estado: "erro_conexao",
      detalhes: { erro: e?.message || String(e) },
    };
  }
}

export async function obterQrCodeEvolution(instanceOverride?: string): Promise<{
  base64?: string;
  code?: string;
  estado?: string;
  erro?: string;
}> {
  const { url, apiKey, instance } = getEvolutionCreds(instanceOverride);
  if (!url || !apiKey) {
    return { erro: "EVOLUTION_API_URL e EVOLUTION_API_KEY não configuradas no servidor." };
  }

  try {
    const resp = await fetch(`${url}/instance/connect/${encodeURIComponent(instance)}`, {
      headers: { apikey: apiKey },
    });
    const data: any = await resp.json();
    if (!resp.ok) {
      return { erro: data?.message || `Evolution HTTP ${resp.status}` };
    }
    return {
      base64: data?.base64 || data?.qrcode?.base64,
      code: data?.code || data?.qrcode?.code,
      estado: data?.instance?.state,
    };
  } catch (e: any) {
    return { erro: e?.message || String(e) };
  }
}

export async function enviarTextoEvolution(params: {
  telefone: string;
  mensagem: string;
  instanceOverride?: string;
}): Promise<{ ok: boolean; messageId?: string; erro?: string; numeroInvalido?: boolean }> {
  const { url, apiKey, instance } = getEvolutionCreds(params.instanceOverride);
  if (!url || !apiKey) {
    return { ok: false, erro: "EVOLUTION_API_URL ou EVOLUTION_API_KEY não configurada." };
  }

  const numeroLimpo = normalizarTelefoneWhatsApp(params.telefone) || params.telefone.replace(/\D/g, "");
  if (!numeroLimpo) {
    return { ok: false, erro: "Telefone inválido para WhatsApp.", numeroInvalido: true };
  }

  try {
    const resp = await fetch(`${url}/message/sendText/${encodeURIComponent(instance)}`, {
      method: "POST",
      headers: {
        apikey: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        number: numeroLimpo,
        text: params.mensagem,
        delay: 1500,
        linkPreview: false,
      }),
    });

    const data: any = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msgErr = JSON.stringify(data || {});
      const invalido = /exists.*false|not.*whatsapp|invalid.*number/i.test(msgErr);
      return {
        ok: false,
        erro: data?.message || data?.response?.message || `Evolution HTTP ${resp.status}`,
        numeroInvalido: invalido,
      };
    }

    const messageId = data?.key?.id || data?.id || null;
    return { ok: true, messageId: messageId ? String(messageId) : undefined };
  } catch (e: any) {
    return { ok: false, erro: e?.message || String(e) };
  }
}

export async function baixarMidiaBase64Evolution(
  messageKey: any,
  instanceOverride?: string
): Promise<{ base64?: string; mimetype?: string } | null> {
  const { url, apiKey, instance } = getEvolutionCreds(instanceOverride);
  if (!url || !apiKey || !messageKey) return null;

  try {
    const resp = await fetch(`${url}/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`, {
      method: "POST",
      headers: {
        apikey: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: { key: messageKey }, convertToMp4: false }),
    });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    if (!data?.base64) return null;
    return { base64: data.base64, mimetype: data.mimetype || "audio/ogg" };
  } catch {
    return null;
  }
}
