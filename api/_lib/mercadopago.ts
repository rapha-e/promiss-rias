import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hojeBR, registrarLog } from "./supabaseAdmin.js";

export interface CobrancaPixResult {
  id: number;
  mp_payment_id: string | null;
  qr_code: string;
  qr_code_base64?: string | null;
  ticket_url?: string | null;
  status: string;
  simulado: boolean;
}

export async function obterOuCriarPixPromissoria(params: {
  supabase: SupabaseClient;
  promissoriaId: number;
  clienteNome: string;
  telefone: string;
  valorCentavos: number;
  descricao: string;
  forcarSimulacao?: boolean;
}): Promise<CobrancaPixResult> {
  const { supabase, promissoriaId, clienteNome, telefone, valorCentavos, descricao, forcarSimulacao } = params;
  const hoje = hojeBR();

  // 1. Idempotência: já existe cobrança ativa para esta promissória hoje no mesmo valor?
  const { data: existente } = await supabase
    .from("cobrancas_pix")
    .select("*")
    .eq("promissoria_id", promissoriaId)
    .eq("data_referencia", hoje)
    .maybeSingle();

  if (existente && existente.qr_code && existente.status !== "cancelled" && existente.status !== "rejected") {
    return {
      id: existente.id,
      mp_payment_id: existente.mp_payment_id,
      qr_code: existente.qr_code,
      qr_code_base64: existente.qr_code_base64,
      ticket_url: existente.ticket_url,
      status: existente.status,
      simulado: existente.status === "dry_run",
    };
  }

  const externalReference = `promissoria:${promissoriaId}`;
  const mpToken = process.env.MP_ACCESS_TOKEN || "";

  // 2. Se for simulação explícita (dry_run sem token real ou teste offline)
  if (forcarSimulacao || !mpToken) {
    const fakePaymentId = `DRY-${promissoriaId}-${hoje.replace(/-/g, "")}`;
    const fakeQrCode = `00020126580014BR.GOV.BCB.PIX0136SIMULACAO-LEOOTICAS-${promissoriaId}5204000053039865406${(valorCentavos / 100).toFixed(2)}5802BR5910Leo Oticas6008Brasilia62070503***6304ABCD`;
    const { data: inserido, error } = await supabase
      .from("cobrancas_pix")
      .upsert(
        {
          promissoria_id: promissoriaId,
          cliente_nome: clienteNome,
          telefone,
          data_referencia: hoje,
          valor_centavos: valorCentavos,
          mp_payment_id: fakePaymentId,
          external_reference: externalReference,
          qr_code: fakeQrCode,
          status: "dry_run",
        },
        { onConflict: "promissoria_id,data_referencia" }
      )
      .select()
      .single();

    if (error || !inserido) throw new Error(error?.message || "Erro ao salvar cobrança Pix simulada.");
    return {
      id: inserido.id,
      mp_payment_id: inserido.mp_payment_id,
      qr_code: inserido.qr_code,
      status: "dry_run",
      simulado: true,
    };
  }

  // 3. Chamada real na API do Mercado Pago / Mercado Livre (POST /v1/payments)
  const idempotencyKey = crypto
    .createHash("sha256")
    .update(`${promissoriaId}:${hoje}:${valorCentavos}`)
    .digest("hex");

  const baseUrl = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  const primeiroNome = (clienteNome || "Cliente").trim().split(/\s+/)[0] || "Cliente";
  const sobrenome = (clienteNome || "").trim().split(/\s+/).slice(1).join(" ") || "LeoOticas";

  const body: Record<string, unknown> = {
    transaction_amount: Number((valorCentavos / 100).toFixed(2)),
    description: descricao.slice(0, 180),
    payment_method_id: "pix",
    external_reference: externalReference,
    payer: {
      email: `cliente.${promissoriaId}@leooticas.com.br`,
      first_name: primeiroNome,
      last_name: sobrenome,
    },
    date_of_expiration: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };

  if (baseUrl) {
    body.notification_url = `${baseUrl}/api/webhooks/mercadopago`;
  }

  const resp = await fetch("https://api.mercadopago.com/v1/payments", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mpToken}`,
      "Content-Type": "application/json",
      "X-Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });

  const mpData: any = await resp.json();
  if (!resp.ok) {
    await registrarLog(supabase, "mercadopago", "error", `Falha ao gerar Pix MP para promissória #${promissoriaId}`, promissoriaId, mpData);
    throw new Error(mpData?.message || `Mercado Pago retornou HTTP ${resp.status}`);
  }

  const txData = mpData?.point_of_interaction?.transaction_data || {};
  const qrCode = txData.qr_code || "";
  if (!qrCode) {
    throw new Error("Mercado Pago não retornou point_of_interaction.transaction_data.qr_code");
  }

  const { data: saved, error: saveErr } = await supabase
    .from("cobrancas_pix")
    .upsert(
      {
        promissoria_id: promissoriaId,
        cliente_nome: clienteNome,
        telefone,
        data_referencia: hoje,
        valor_centavos: valorCentavos,
        mp_payment_id: String(mpData.id),
        external_reference: externalReference,
        qr_code: qrCode,
        qr_code_base64: txData.qr_code_base64 || null,
        ticket_url: txData.ticket_url || null,
        status: mpData.status || "pending",
        expira_em: mpData.date_of_expiration || null,
        payload_raw: mpData,
      },
      { onConflict: "promissoria_id,data_referencia" }
    )
    .select()
    .single();

  if (saveErr || !saved) {
    throw new Error(saveErr?.message || "Erro ao persistir cobrança Pix.");
  }

  return {
    id: saved.id,
    mp_payment_id: saved.mp_payment_id,
    qr_code: saved.qr_code,
    qr_code_base64: saved.qr_code_base64,
    ticket_url: saved.ticket_url,
    status: saved.status,
    simulado: false,
  };
}

export async function consultarPagamentoMercadoPago(paymentId: string): Promise<any> {
  const mpToken = process.env.MP_ACCESS_TOKEN || "";
  if (!mpToken) {
    throw new Error("MP_ACCESS_TOKEN não configurado.");
  }
  const resp = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: {
      Authorization: `Bearer ${mpToken}`,
    },
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error((data as any)?.message || `Erro MP HTTP ${resp.status}`);
  }
  return data;
}
