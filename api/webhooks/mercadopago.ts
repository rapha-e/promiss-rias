import crypto from "node:crypto";
import { avaliarPermissaoEnvio, enviarTextoEvolution } from "../_lib/evolution.js";
import { consultarPagamentoMercadoPago } from "../_lib/mercadopago.js";
import { dtBR, montarComprovanteBaixa } from "../_lib/mensagens.js";
import {
  autorizarAdminOuCron,
  carregarConfigAutomacao,
  getSupabaseAdmin,
  normalizarTelefoneWhatsApp,
  registrarLog,
} from "../_lib/supabaseAdmin.js";

function validarAssinaturaMP(req: any, dataId: string): boolean {
  const secret = process.env.MP_WEBHOOK_SECRET || "";
  if (!secret) return true; // Se não configurado, confiamos na consulta direta GET /v1/payments/{id}
  const xSignature = req.headers?.["x-signature"] as string | undefined;
  const xRequestId = req.headers?.["x-request-id"] as string | undefined;
  if (!xSignature || !xRequestId) return false;

  const partes: Record<string, string> = {};
  for (const item of xSignature.split(",")) {
    const [k, v] = item.split("=").map(s => s.trim());
    if (k && v) partes[k] = v;
  }
  if (!partes.ts || !partes.v1) return false;

  const manifest = `id:${dataId};request-id:${xRequestId};ts:${partes.ts};`;
  const hmac = crypto.createHmac("sha256", secret).update(manifest).digest("hex");
  return hmac === partes.v1;
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  try {
    const supabase = getSupabaseAdmin();
    const config = await carregarConfigAutomacao(supabase);

    // 1. Modo Simulação Segura (apenas Admin autenticado e fora do modo produção)
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    if (body?.simular_cobranca_id || body?.simular_promissoria_id) {
      const auth = await autorizarAdminOuCron(req, supabase);
      if (!auth.ok) {
        return res.status(401).json({ error: "Simulação restrita a administradores." });
      }
      if (config.modo === "producao") {
        return res.status(400).json({ error: "Simulação de webhook bloqueada enquanto o modo estiver em PRODUÇÃO." });
      }

      let cobranca: any = null;
      if (body.simular_cobranca_id) {
        const { data } = await supabase.from("cobrancas_pix").select("*").eq("id", body.simular_cobranca_id).maybeSingle();
        cobranca = data;
      } else if (body.simular_promissoria_id) {
        const { data } = await supabase
          .from("cobrancas_pix")
          .select("*")
          .eq("promissoria_id", body.simular_promissoria_id)
          .order("id", { ascending: false })
          .limit(1)
          .maybeSingle();
        cobranca = data;
      }

      if (!cobranca) {
        return res.status(404).json({ error: "Cobrança Pix de teste não encontrada para simular." });
      }

      return await processarPagamentoAprovado({
        supabase,
        config,
        res,
        promissoriaId: cobranca.promissoria_id,
        paymentId: cobranca.mp_payment_id || `SIM-${cobranca.id}`,
        valorCentavos: cobranca.valor_centavos,
        dataAprovacaoIso: new Date().toISOString(),
        simulado: true,
      });
    }

    // 2. Webhook real do Mercado Pago / Mercado Livre
    const topic = body?.type || body?.topic || req.query?.type || req.query?.topic;
    const paymentId = String(body?.data?.id || req.query?.["data.id"] || req.query?.id || "");

    if (topic && topic !== "payment") {
      return res.status(200).json({ ok: true, ignored: `topic:${topic}` });
    }
    if (!paymentId) {
      return res.status(200).json({ ok: true, ignored: "sem_payment_id" });
    }

    if (!validarAssinaturaMP(req, paymentId)) {
      await registrarLog(supabase, "webhook_mp", "warn", `Assinatura inválida para payment ${paymentId}`, paymentId);
      return res.status(401).json({ error: "Assinatura inválida" });
    }

    const pagamento = await consultarPagamentoMercadoPago(paymentId);
    const status = String(pagamento?.status || "");
    const externalRef = String(pagamento?.external_reference || "");

    if (status !== "approved") {
      await supabase
        .from("cobrancas_pix")
        .update({ status: status || "pending", payload_raw: pagamento })
        .eq("mp_payment_id", paymentId);
      return res.status(200).json({ ok: true, status, ignorado: "aguardando_aprovacao" });
    }

    let promissoriaId: number | null = null;
    const matchRef = externalRef.match(/^promissoria:(\d+)$/);
    if (matchRef) {
      promissoriaId = Number(matchRef[1]);
    } else {
      const { data: cob } = await supabase
        .from("cobrancas_pix")
        .select("promissoria_id")
        .eq("mp_payment_id", paymentId)
        .maybeSingle();
      if (cob) promissoriaId = cob.promissoria_id;
    }

    if (!promissoriaId) {
      await registrarLog(supabase, "webhook_mp", "warn", `Pagamento MP ${paymentId} aprovado sem promissória vinculada (${externalRef}).`, paymentId, pagamento);
      return res.status(200).json({ ok: true, ignored: "sem_promissoria_vinculada" });
    }

    const valorCentavos = Math.round(Number(pagamento.transaction_amount || 0) * 100);
    const dataAprovacaoIso = pagamento.date_approved || new Date().toISOString();

    return await processarPagamentoAprovado({
      supabase,
      config,
      res,
      promissoriaId,
      paymentId,
      valorCentavos,
      dataAprovacaoIso,
      simulado: false,
      payloadRaw: pagamento,
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

async function processarPagamentoAprovado(params: {
  supabase: any;
  config: any;
  res: any;
  promissoriaId: number;
  paymentId: string;
  valorCentavos: number;
  dataAprovacaoIso: string;
  simulado: boolean;
  payloadRaw?: any;
}) {
  const { supabase, config, res, promissoriaId, paymentId, valorCentavos, dataAprovacaoIso, simulado, payloadRaw } = params;

  // Idempotência: verificar se já baixamos este pagamento
  const { data: cobExistente } = await supabase
    .from("cobrancas_pix")
    .select("*")
    .eq("mp_payment_id", paymentId)
    .maybeSingle();

  if (cobExistente?.baixa_realizada) {
    return res.status(200).json({ ok: true, idempotente: true, mensagem: "Baixa já realizada anteriormente." });
  }

  // Buscar dados atuais da promissória
  const { data: prom } = await supabase
    .from("promissorias")
    .select("*")
    .eq("id", promissoriaId)
    .maybeSingle();

  if (!prom) {
    return res.status(404).json({ error: `Promissória #${promissoriaId} não encontrada.` });
  }

  const valorBaixa = Math.min(valorCentavos, prom.saldo_devedor || valorCentavos);
  if (valorBaixa <= 0) {
    return res.status(200).json({ ok: true, mensagem: "Promissória já estava quitada." });
  }

  // Em dry_run real (quando não há baixa desejada no banco) ou quando simulação explícita foi chamada em homologação:
  // Na homologação (banco separado), queremos validar a baixa real na RPC!
  const { data: baixaRes, error: baixaErr } = await supabase.rpc("registrar_baixa_pagamento", {
    p_promissoria_id: promissoriaId,
    p_valor: valorBaixa,
    p_data: dataAprovacaoIso,
    p_detalhes: `${simulado ? "[SIMULAÇÃO] " : ""}Pix automático Mercado Pago #${paymentId}`,
    p_operador_email: "pix-auto@leooticas.fin",
  });

  if (baixaErr) {
    await registrarLog(supabase, "webhook_mp", "error", `Erro na RPC registrar_baixa_pagamento: ${baixaErr.message}`, paymentId);
    throw new Error(baixaErr.message);
  }

  // Atualizar cobrancas_pix
  await supabase
    .from("cobrancas_pix")
    .update({
      status: "approved",
      baixa_realizada: true,
      baixa_em: new Date().toISOString(),
      pago_em: dataAprovacaoIso,
      ...(payloadRaw ? { payload_raw: payloadRaw } : {}),
    })
    .eq("promissoria_id", promissoriaId)
    .eq("mp_payment_id", paymentId);

  // Marcar eventual promessa em aberto como cumprida
  await supabase
    .from("promessas_pagamento")
    .update({ cumprida: true, cumprida_em: new Date().toISOString() })
    .ilike("cliente", prom.cliente_nome.trim())
    .eq("cumprida", false);

  await registrarLog(
    supabase,
    "webhook_mp",
    simulado ? "dry_run" : "info",
    `Baixa automática concluída para ${prom.cliente_nome} (Promissória #${promissoriaId}, Pix ${paymentId})`,
    paymentId,
    baixaRes
  );

  // Preparar envio do comprovante
  let envioComprovanteStatus = "desativado";
  if (config.enviar_comprovante_auto) {
    const telNorm = normalizarTelefoneWhatsApp(prom.telefone || "");
    if (telNorm) {
      // Buscar todas promissórias abertas do cliente após a baixa para listar próximas parcelas
      const { data: todasCli } = await supabase
        .from("promissorias")
        .select("*")
        .ilike("cliente_nome", prom.cliente_nome.trim())
        .eq("fundo_perdido", false)
        .gt("saldo_devedor", 0)
        .order("vencimento", { ascending: true });

      const saldoNovoProm = Math.max(0, (prom.saldo_devedor || 0) - valorBaixa);
      const proximas = (todasCli || [])
        .filter((x: any) => x.id !== promissoriaId)
        .map((x: any) => ({
          parcela: x.parcelas || "",
          valor: x.saldo_devedor,
          vencimento: x.vencimento,
        }));

      const msgComprovante = montarComprovanteBaixa({
        nome: prom.cliente_nome,
        valorTotalCompra: prom.divida_total || 0,
        totalParcelas: prom.parcelas,
        valorPago: valorBaixa,
        parcela: prom.parcelas || "1/1",
        valorRestante: saldoNovoProm,
        dataPagamentoBR: dtBR(dataAprovacaoIso.slice(0, 10)),
        proximasParcelas: proximas,
      });

      const permissao = avaliarPermissaoEnvio(config, telNorm);
      let statusFila = "pendente";
      let msgId: string | null = null;
      let erroEnvio: string | null = null;

      if (permissao.acao === "dry_run") {
        statusFila = "simulado";
        envioComprovanteStatus = "simulado_dry_run";
      } else if (permissao.acao === "bloqueado_whitelist") {
        statusFila = "bloqueado_whitelist";
        erroEnvio = permissao.motivo;
        envioComprovanteStatus = "bloqueado_whitelist";
      } else if (permissao.acao === "enviar") {
        const resEnvio = await enviarTextoEvolution({
          telefone: telNorm,
          mensagem: msgComprovante,
          instanceOverride: config.evolution_instance,
        });
        if (resEnvio.ok) {
          statusFila = "enviado";
          msgId = resEnvio.messageId || null;
          envioComprovanteStatus = "enviado";
        } else {
          statusFila = "erro";
          erroEnvio = resEnvio.erro || "Falha ao enviar comprovante";
          envioComprovanteStatus = "erro";
        }
      } else {
        envioComprovanteStatus = "enfileirado_pausado";
      }

      await supabase.from("fila_disparos_whatsapp").insert({
        tipo: "COMPROVANTE",
        prioridade: 1,
        promissoria_id: promissoriaId,
        cobranca_pix_id: cobExistente?.id || null,
        cliente_nome: prom.cliente_nome,
        telefone: prom.telefone || telNorm,
        telefone_normalizado: telNorm,
        mensagem: msgComprovante,
        status: statusFila,
        enviado_em: statusFila === "enviado" || statusFila === "simulado" ? new Date().toISOString() : null,
        evolution_message_id: msgId,
        ultimo_erro: erroEnvio,
      });
    }
  }

  return res.status(200).json({
    ok: true,
    promissoria_id: promissoriaId,
    valor_baixado: valorBaixa,
    comprovante: envioComprovanteStatus,
  });
}
