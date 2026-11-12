import {
  avaliarPermissaoEnvio,
  baixarMidiaBase64Evolution,
  enviarTextoEvolution,
} from "../_lib/evolution.js";
import { obterOuCriarPixPromissoria } from "../_lib/mercadopago.js";
import {
  dtBR,
  extrairPrevisaoPagamentoSimples,
  moneyCentavos,
  primeiroNomeCliente,
} from "../_lib/mensagens.js";
import {
  autorizarAdminOuCron,
  carregarConfigAutomacao,
  equivalentesTelefoneBR,
  getSupabaseAdmin,
  hojeBR,
  normalizarTelefoneWhatsApp,
  registrarLog,
} from "../_lib/supabaseAdmin.js";

async function analisarMensagemComGemini(params: {
  hoje: string;
  texto?: string;
  audioBase64?: string;
  audioMime?: string;
}): Promise<{
  transcricao: string;
  intencao: "promessa" | "pedir_pix" | "opt_out" | "ja_paguei" | "outro";
  data_promessa: string | null;
} | null> {
  const apiKey = process.env.GEMINI_API_KEY || "";
  if (!apiKey) return null;

  const parts: any[] = [
    {
      text: `Você é um analisador de mensagens do atendimento financeiro da LeoÓticas.
Hoje é ${params.hoje} (YYYY-MM-DD).
Analise a mensagem (texto ou áudio) do cliente e responda EXCLUSIVAMENTE em JSON válido, sem markdown, com as chaves:
{
  "transcricao": "texto literal ou transcrito do áudio",
  "intencao": "promessa" | "pedir_pix" | "opt_out" | "ja_paguei" | "outro",
  "data_promessa": "YYYY-MM-DD ou null"
}
Regras:
- Se o cliente informar quando vai pagar/acertar (ex: "só recebo dia 25", "pago sexta", "dia 10 eu pago"), intencao="promessa" e calcule a data YYYY-MM-DD futura mais próxima a partir de ${params.hoje}.
- Se pedir código pix, valor da parcela ou 2a via, intencao="pedir_pix".
- Se pedir para parar de receber mensagens, intencao="opt_out".
- Se disser que já pagou, intencao="ja_paguei".`,
    },
  ];

  if (params.texto) {
    parts.push({ text: `Mensagem do cliente: "${params.texto}"` });
  }
  if (params.audioBase64) {
    parts.push({
      inline_data: {
        mime_type: params.audioMime || "audio/ogg",
        data: params.audioBase64,
      },
    });
  }

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
        }),
      }
    );
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const parsed = JSON.parse(rawText);
    return {
      transcricao: String(parsed.transcricao || params.texto || ""),
      intencao: parsed.intencao || "outro",
      data_promessa: parsed.data_promessa || null,
    };
  } catch {
    return null;
  }
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  try {
    const supabase = getSupabaseAdmin();
    const config = await carregarConfigAutomacao(supabase);
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

    let telBruto = "";
    let textoRecebido = "";
    let messageKey: any = null;
    let temAudio = false;
    let isSimulacaoAdmin = false;

    // 1. Modo Simulação Segura pelo Admin (para testar IA + Cadastro de Promessa sem precisar mandar WhatsApp real)
    if (body?.simular_mensagem) {
      const auth = await autorizarAdminOuCron(req, supabase);
      if (!auth.ok) return res.status(401).json({ error: "Não autorizado." });
      telBruto = String(body.simular_mensagem.telefone || "");
      textoRecebido = String(body.simular_mensagem.texto || "");
      isSimulacaoAdmin = true;
    } else {
      // 2. Webhook real Evolution API
      const webhookSecret = process.env.EVOLUTION_WEBHOOK_SECRET || "";
      if (webhookSecret && req.headers?.["x-webhook-secret"] !== webhookSecret && req.query?.secret !== webhookSecret) {
        return res.status(401).json({ error: "Webhook secret inválido." });
      }

      const event = String(body?.event || "").toLowerCase();
      if (event && event !== "messages.upsert") {
        return res.status(200).json({ ok: true, ignored: event });
      }

      const msgData = body?.data || {};
      const key = msgData?.key || {};
      if (key.fromMe) return res.status(200).json({ ok: true, ignored: "fromMe" });

      const remoteJid = String(key.remoteJid || "");
      if (!remoteJid || remoteJid.endsWith("@g.us")) {
        return res.status(200).json({ ok: true, ignored: "grupo_ou_vazio" });
      }

      telBruto = remoteJid.split("@")[0];
      const message = msgData?.message || {};
      textoRecebido =
        message.conversation ||
        message.extendedTextMessage?.text ||
        message.imageMessage?.caption ||
        "";
      temAudio = Boolean(message.audioMessage);
      messageKey = key;
    }

    const telNorm = normalizarTelefoneWhatsApp(telBruto);
    if (!telNorm) {
      return res.status(200).json({ ok: true, ignored: "telefone_nao_identificado" });
    }

    // Segurança em modo whitelist: nunca processar nem responder números reais fora da whitelist
    if (!isSimulacaoAdmin && config.modo === "whitelist") {
      const naWhitelist = (config.whitelist_telefones || []).some(w => equivalentesTelefoneBR(w, telNorm));
      if (!naWhitelist) {
        return res.status(200).json({ ok: true, ignored: "fora_whitelist" });
      }
    }

    const hoje = hojeBR();
    let audioData: { base64?: string; mimetype?: string } | null = null;
    if (temAudio && messageKey) {
      audioData = await baixarMidiaBase64Evolution(messageKey, config.evolution_instance);
    }

    // Analisar com Gemini ou fallback determinístico
    const ia = await analisarMensagemComGemini({
      hoje,
      texto: textoRecebido,
      audioBase64: audioData?.base64,
      audioMime: audioData?.mimetype,
    });

    const textoFinal = ia?.transcricao || textoRecebido || "";
    if (!textoFinal && !temAudio) {
      return res.status(200).json({ ok: true, ignored: "sem_conteudo_textual" });
    }

    let intencao = ia?.intencao || "outro";
    let dataPromessa = ia?.data_promessa || null;

    if (!ia) {
      const norm = textoFinal.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      if (/\b(parar|sair|cancelar|nao mande|pare de mandar)\b/.test(norm)) {
        intencao = "opt_out";
      } else {
        const dtExtraida = extrairPrevisaoPagamentoSimples(textoFinal, hoje);
        if (dtExtraida) {
          intencao = "promessa";
          dataPromessa = dtExtraida;
        } else if (/\b(pix|codigo|parcela|valor|quanto|devo|vence|pagar|segunda via|2 via)\b/.test(norm)) {
          intencao = "pedir_pix";
        } else if (/\b(ja paguei|paguei|comprovante|transferi)\b/.test(norm)) {
          intencao = "ja_paguei";
        }
      }
    }

    // Buscar promissórias abertas desse telefone
    const { data: promissoriasAbertas } = await supabase
      .from("promissorias")
      .select("*")
      .eq("fundo_perdido", false)
      .gt("saldo_devedor", 0)
      .order("vencimento", { ascending: true })
      .limit(500);

    const doCliente = (promissoriasAbertas || []).filter(
      (p: any) => p.telefone && equivalentesTelefoneBR(p.telefone, telNorm)
    );

    const clienteNome = doCliente[0]?.cliente_nome || "Cliente";
    const proxPromissoria = doCliente[0] || null;
    let resposta = "";
    let acaoExecutada = "nenhuma";

    if (intencao === "opt_out") {
      await supabase.from("whatsapp_contatos_controle").upsert({
        telefone_normalizado: telNorm,
        cliente_nome: clienteNome,
        opt_out: true,
      });
      acaoExecutada = "opt_out_registrado";
      resposta = "Tudo bem! Já registrei aqui para você não receber mais lembretes automáticos por este canal. Qualquer coisa que precisar, nossa equipe na loja segue à disposição. 🙏";
    } else if (intencao === "promessa" && dataPromessa && config.cadastrar_promessa_auto) {
      const saldoTotal = doCliente.reduce((s: number, x: any) => s + (x.saldo_devedor || 0), 0);
      const valorPromessa = proxPromissoria?.saldo_devedor || saldoTotal || 0;

      if (doCliente.length > 0) {
        await supabase.from("promessas_pagamento").insert({
          cliente: clienteNome,
          telefone: telNorm,
          data_promessa: dataPromessa,
          valor: valorPromessa,
          observacao: `Previsão cadastrada via WhatsApp (${temAudio ? "áudio" : "texto"}): "${textoFinal.slice(0, 140)}"`,
          cumprida: false,
        });
        acaoExecutada = "promessa_cadastrada";
        resposta =
          `Combinado, ${primeiroNomeCliente(clienteNome)}! 😊\n\n` +
          `Já deixei registrada sua previsão de pagamento para o dia *${dtBR(dataPromessa)}*` +
          `${valorPromessa > 0 ? ` (${moneyCentavos(valorPromessa)})` : ""}.\n\n` +
          `Assim evitamos novos avisos antes dessa data, e no dia combinado eu envio um lembrete amigável com seu Pix por aqui! 🙏`;
      } else {
        acaoExecutada = "cliente_nao_encontrado_com_saldo";
      }
    } else if (intencao === "pedir_pix" && proxPromissoria) {
      const pix = await obterOuCriarPixPromissoria({
        supabase,
        promissoriaId: proxPromissoria.id,
        clienteNome,
        telefone: telNorm,
        valorCentavos: proxPromissoria.saldo_devedor,
        descricao: `LeoÓticas Parcela ${proxPromissoria.parcelas || "1/1"}`,
        forcarSimulacao: config.modo === "dry_run",
      });
      acaoExecutada = "pix_enviado";
      resposta =
        `Oi, ${primeiroNomeCliente(clienteNome)}! Segue a parcela mais próxima em aberto na *LeoÓticas*:\n\n` +
        `• *Parcela:* ${proxPromissoria.parcelas || "1/1"}\n` +
        `• *Vencimento:* ${dtBR(proxPromissoria.vencimento)}\n` +
        `• *Valor:* ${moneyCentavos(proxPromissoria.saldo_devedor)}\n\n` +
        `📋 *Pix Copia e Cola:*\n\`\`\`${pix.qr_code}\`\`\`\n\n` +
        `Assim que pagar, seu comprovante já chega automaticamente por aqui! 🧾`;
    } else if (intencao === "ja_paguei") {
      // Pausa o robô por 24h para um humano conferir caso tenha sido pago fora do Pix MP
      await supabase.from("whatsapp_contatos_controle").upsert({
        telefone_normalizado: telNorm,
        cliente_nome: clienteNome,
        pausa_robo_ate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });
      acaoExecutada = "pausado_para_atendimento_humano";
      resposta = `Obrigado por avisar! Vou encaminhar sua mensagem para nossa equipe conferir aqui no sistema rapidinho e já te confirmamos. 😊`;
    }

    // Enviar ou simular resposta
    let statusEnvio = "sem_resposta";
    if (resposta) {
      const permissao = avaliarPermissaoEnvio(config, telNorm);
      let statusFila = "pendente";
      let msgId: string | null = null;
      let erro: string | null = null;

      if (isSimulacaoAdmin && config.modo === "dry_run") {
        statusFila = "simulado";
        statusEnvio = "simulado";
      } else if (permissao.acao === "dry_run") {
        statusFila = "simulado";
        statusEnvio = "simulado";
      } else if (permissao.acao === "bloqueado_whitelist" || permissao.acao === "pausado") {
        statusFila = permissao.acao === "bloqueado_whitelist" ? "bloqueado_whitelist" : "pendente";
        statusEnvio = permissao.acao;
        erro = permissao.motivo;
      } else {
        const resEnv = await enviarTextoEvolution({
          telefone: telNorm,
          mensagem: resposta,
          instanceOverride: config.evolution_instance,
        });
        statusFila = resEnv.ok ? "enviado" : "erro";
        statusEnvio = statusFila;
        msgId = resEnv.messageId || null;
        erro = resEnv.erro || null;
      }

      await supabase.from("fila_disparos_whatsapp").insert({
        tipo: "ATENDIMENTO",
        prioridade: 1,
        promissoria_id: proxPromissoria?.id || null,
        cliente_nome: clienteNome,
        telefone: telNorm,
        telefone_normalizado: telNorm,
        mensagem: resposta,
        status: statusFila,
        enviado_em: statusFila === "enviado" || statusFila === "simulado" ? new Date().toISOString() : null,
        evolution_message_id: msgId,
        ultimo_erro: erro,
      });
    }

    await registrarLog(
      supabase,
      "webhook_evolution",
      config.modo === "dry_run" ? "dry_run" : "info",
      `Recebido de ${clienteNome} (${telNorm}) | Intenção: ${intencao} | Ação: ${acaoExecutada}`,
      telNorm,
      { texto: textoFinal.slice(0, 200), data_promessa: dataPromessa, status_resposta: statusEnvio }
    );

    return res.status(200).json({
      ok: true,
      cliente: clienteNome,
      intencao,
      data_promessa: dataPromessa,
      acao: acaoExecutada,
      status_resposta: statusEnvio,
      resposta_gerada: resposta || null,
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
