import { obterOuCriarPixPromissoria } from "../_lib/mercadopago.js";
import {
  montarMensagemInadimplencia,
  montarMensagemPromessaDia,
  montarMensagemVencimentoDia,
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

function diffDiasIso(maior: string, menor: string): number {
  const a = Date.parse(`${maior.slice(0, 10)}T12:00:00Z`);
  const b = Date.parse(`${menor.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((a - b) / 86400000);
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  try {
    const supabase = getSupabaseAdmin();
    const auth = await autorizarAdminOuCron(req, supabase);
    if (!auth.ok) {
      return res.status(401).json({ error: auth.erro || "Não autorizado" });
    }

    const config = await carregarConfigAutomacao(supabase);
    const hoje = hojeBR();
    const forcarSimulacaoPix = config.modo === "dry_run";

    // 1. Buscar controles de contato (opt-out, inválido, cooldown)
    const { data: controles } = await supabase.from("whatsapp_contatos_controle").select("*");
    const mapaControle = new Map<string, any>();
    for (const c of controles || []) {
      mapaControle.set(c.telefone_normalizado, c);
    }

    // 2. Buscar promessas em aberto
    const { data: promessasAbertas } = await supabase
      .from("promessas_pagamento")
      .select("*")
      .eq("cumprida", false);

    const clientesComPromessaFutura = new Set<string>();
    const promessasHoje: any[] = [];
    for (const pr of promessasAbertas || []) {
      const dtP = String(pr.data_promessa || "").slice(0, 10);
      const nomeKey = String(pr.cliente || "").trim().toUpperCase();
      if (dtP > hoje && nomeKey) {
        clientesComPromessaFutura.add(nomeKey);
      } else if (dtP === hoje) {
        promessasHoje.push(pr);
      }
    }

    // 3. Evitar duplicação no mesmo dia na fila
    const inicioDiaIso = `${hoje}T00:00:00-03:00`;
    const { data: jaNaFilaHoje } = await supabase
      .from("fila_disparos_whatsapp")
      .select("promissoria_id, telefone_normalizado, tipo, status")
      .gte("created_at", inicioDiaIso)
      .neq("status", "cancelado");

    const jaEnfileiradoTelTipo = new Set<string>();
    const jaEnfileiradoPromissoria = new Set<number>();
    for (const item of jaNaFilaHoje || []) {
      jaEnfileiradoTelTipo.add(`${item.telefone_normalizado}:${item.tipo}`);
      if (item.promissoria_id) jaEnfileiradoPromissoria.add(item.promissoria_id);
    }

    // Buscar quantidade já enviada hoje para respeitar limite_diario
    const { count: enviadosHojeCount } = await supabase
      .from("fila_disparos_whatsapp")
      .select("*", { count: "exact", head: true })
      .gte("created_at", inicioDiaIso)
      .in("status", ["enviado", "pendente", "processando"]);

    let vagasRestantes = Math.max(0, config.limite_diario - (enviadosHojeCount || 0));
    const itensParaInserir: any[] = [];
    const ignorados: { cliente: string; motivo: string }[] = [];

    // Escalonador de horários (jitter anti-banimento)
    let cursorTempo = Date.now();
    let contadorBatch = 0;

    const proximoHorario = () => {
      if (contadorBatch === 0) {
        contadorBatch++;
        return new Date(cursorTempo).toISOString();
      }
      const minMs = config.intervalo_min_seg * 1000;
      const maxMs = Math.max(minMs, config.intervalo_max_seg * 1000);
      const jitter = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
      cursorTempo += jitter;
      if (contadorBatch % config.pausa_a_cada_n === 0) {
        cursorTempo += config.pausa_minutos * 60 * 1000;
      }
      contadorBatch++;
      return new Date(cursorTempo).toISOString();
    };

    const podeContatar = (telNorm: string | null, clienteNome: string, isInadimplencia: boolean): string | null => {
      if (!telNorm) return "Telefone ausente ou inválido";
      const ctrl = mapaControle.get(telNorm);
      if (ctrl?.opt_out) return "Cliente solicitou Opt-Out";
      if (ctrl?.whatsapp_invalido) return "Número marcado como WhatsApp inválido";
      if (ctrl?.pausa_robo_ate && new Date(ctrl.pausa_robo_ate).getTime() > Date.now()) {
        return "Atendimento pausado para humano";
      }
      if (config.modo === "whitelist") {
        const naWhitelist = (config.whitelist_telefones || []).some(w => equivalentesTelefoneBR(w, telNorm));
        if (!naWhitelist && forcarSimulacaoPix === false) {
          // Ainda permitimos enfileirar para mostrar bloqueio visível se for whitelist, ou já filtramos?
          // Melhor enfileirar só em dry_run ou se estiver na whitelist, evitando gerar Pix MP à toa para não-whitelist!
          return "Fora da Whitelist no modo Whitelist (Pix não gerado por segurança)";
        }
      }
      if (clientesComPromessaFutura.has(clienteNome.trim().toUpperCase())) {
        return "Cliente já possui promessa agendada para data futura";
      }
      if (isInadimplencia && ctrl?.ultimo_disparo_cobranca_em) {
        const diasDesdeUltimo = Math.floor(
          (Date.now() - new Date(ctrl.ultimo_disparo_cobranca_em).getTime()) / 86400000
        );
        if (diasDesdeUltimo < config.cooldown_dias) {
          return `Em cooldown de ${config.cooldown_dias} dias (último envio há ${diasDesdeUltimo}d)`;
        }
      }
      return null;
    };

    // 4. VENCIMENTOS DO DIA (Prioridade 2)
    if (config.enviar_vencimento_dia && vagasRestantes > 0) {
      const { data: vencendoHoje } = await supabase
        .from("promissorias")
        .select("*")
        .eq("fundo_perdido", false)
        .gt("saldo_devedor", 0)
        .eq("vencimento", hoje)
        .order("id", { ascending: true })
        .limit(200);

      for (const p of vencendoHoje || []) {
        if (vagasRestantes <= 0) break;
        const telNorm = normalizarTelefoneWhatsApp(p.telefone || "");
        if (jaEnfileiradoPromissoria.has(p.id)) continue;
        if (telNorm && jaEnfileiradoTelTipo.has(`${telNorm}:VENCIMENTO_DIA`)) continue;

        const bloqueio = podeContatar(telNorm, p.cliente_nome, false);
        if (bloqueio) {
          ignorados.push({ cliente: p.cliente_nome, motivo: bloqueio });
          continue;
        }

        const pix = await obterOuCriarPixPromissoria({
          supabase,
          promissoriaId: p.id,
          clienteNome: p.cliente_nome,
          telefone: telNorm!,
          valorCentavos: p.saldo_devedor,
          descricao: `LeoÓticas Promissória #${p.id} (${p.parcelas || "1/1"})`,
          forcarSimulacao: forcarSimulacaoPix,
        });

        const msg = montarMensagemVencimentoDia({
          nome: p.cliente_nome,
          parcelas: p.parcelas,
          valorCentavos: p.saldo_devedor,
          vencimento: p.vencimento,
          qrCodePix: pix.qr_code,
          seed: p.id,
        });

        itensParaInserir.push({
          tipo: "VENCIMENTO_DIA",
          prioridade: 2,
          promissoria_id: p.id,
          cobranca_pix_id: pix.id,
          cliente_nome: p.cliente_nome,
          telefone: p.telefone || telNorm!,
          telefone_normalizado: telNorm!,
          mensagem: msg,
          pix_copia_cola: pix.qr_code,
          regra_dias_atraso: 0,
          status: "pendente",
          agendado_para: proximoHorario(),
        });

        jaEnfileiradoPromissoria.add(p.id);
        jaEnfileiradoTelTipo.add(`${telNorm}:VENCIMENTO_DIA`);
        vagasRestantes--;
      }
    }

    // 5. PROMESSAS DO DIA (Prioridade 2)
    if (config.enviar_promessa_dia && vagasRestantes > 0) {
      for (const pr of promessasHoje) {
        if (vagasRestantes <= 0) break;
        const telNorm = normalizarTelefoneWhatsApp(pr.telefone || "");
        if (!telNorm || jaEnfileiradoTelTipo.has(`${telNorm}:PROMESSA_DIA`)) continue;

        // Tenta achar a promissória aberta mais próxima desse cliente para gerar Pix exato
        const { data: abertasCli } = await supabase
          .from("promissorias")
          .select("*")
          .ilike("cliente_nome", pr.cliente.trim())
          .eq("fundo_perdido", false)
          .gt("saldo_devedor", 0)
          .order("vencimento", { ascending: true })
          .limit(1);

        const promAlvo = abertasCli?.[0];
        if (config.modo === "whitelist") {
          const naWhitelist = (config.whitelist_telefones || []).some(w => equivalentesTelefoneBR(w, telNorm));
          if (!naWhitelist) {
            ignorados.push({ cliente: pr.cliente, motivo: "Promessa ignorada (fora da Whitelist)" });
            continue;
          }
        }

        let qrCodePix: string | undefined;
        let cobrancaPixId: number | null = null;
        if (promAlvo) {
          const valorCobranca = pr.valor > 0 ? Math.min(pr.valor, promAlvo.saldo_devedor) : promAlvo.saldo_devedor;
          const pix = await obterOuCriarPixPromissoria({
            supabase,
            promissoriaId: promAlvo.id,
            clienteNome: pr.cliente,
            telefone: telNorm,
            valorCentavos: valorCobranca,
            descricao: `LeoÓticas Promessa ${hoje} (${pr.cliente})`,
            forcarSimulacao: forcarSimulacaoPix,
          });
          qrCodePix = pix.qr_code;
          cobrancaPixId = pix.id;
        }

        const msg = montarMensagemPromessaDia({
          nome: pr.cliente,
          valorCentavos: pr.valor || promAlvo?.saldo_devedor || 0,
          dataPromessa: pr.data_promessa,
          qrCodePix,
          seed: pr.id,
        });

        itensParaInserir.push({
          tipo: "PROMESSA_DIA",
          prioridade: 2,
          promissoria_id: promAlvo?.id || null,
          cobranca_pix_id: cobrancaPixId,
          cliente_nome: pr.cliente,
          telefone: pr.telefone || telNorm,
          telefone_normalizado: telNorm,
          mensagem: msg,
          pix_copia_cola: qrCodePix || null,
          regra_dias_atraso: 0,
          status: "pendente",
          agendado_para: proximoHorario(),
        });

        jaEnfileiradoTelTipo.add(`${telNorm}:PROMESSA_DIA`);
        vagasRestantes--;
      }
    }

    // 6. RÉGUA DE INADIMPLÊNCIA (Prioridade 5 — somente quando habilitada e nos marcos exatos D+3, D+10, D+25, D+45, D+60+)
    if (config.enviar_inadimplencia && vagasRestantes > 0) {
      const { data: vencidas } = await supabase
        .from("promissorias")
        .select("*")
        .eq("fundo_perdido", false)
        .gt("saldo_devedor", 0)
        .lt("vencimento", hoje)
        .order("vencimento", { ascending: false })
        .limit(400);

      const marcosRegua = new Set([3, 10, 25, 45, 60, 90, 120]);
      const clientesJaProcessadosHoje = new Set<string>();

      for (const p of vencidas || []) {
        if (vagasRestantes <= 0) break;
        const nomeKey = (p.cliente_nome || "").trim().toUpperCase();
        if (!nomeKey || clientesJaProcessadosHoje.has(nomeKey)) continue;

        const diasAtraso = diffDiasIso(hoje, p.vencimento);
        if (!marcosRegua.has(diasAtraso)) continue;

        const telNorm = normalizarTelefoneWhatsApp(p.telefone || "");
        if (jaEnfileiradoPromissoria.has(p.id) || (telNorm && jaEnfileiradoTelTipo.has(`${telNorm}:INADIMPLENCIA`))) {
          continue;
        }

        const bloqueio = podeContatar(telNorm, p.cliente_nome, true);
        if (bloqueio) {
          ignorados.push({ cliente: p.cliente_nome, motivo: bloqueio });
          continue;
        }

        const pix = await obterOuCriarPixPromissoria({
          supabase,
          promissoriaId: p.id,
          clienteNome: p.cliente_nome,
          telefone: telNorm!,
          valorCentavos: p.saldo_devedor,
          descricao: `LeoÓticas Regularização #${p.id}`,
          forcarSimulacao: forcarSimulacaoPix,
        });

        const msg = montarMensagemInadimplencia({
          nome: p.cliente_nome,
          parcelas: p.parcelas,
          valorCentavos: p.saldo_devedor,
          vencimento: p.vencimento,
          diasAtraso,
          qrCodePix: pix.qr_code,
          seed: p.id,
        });

        itensParaInserir.push({
          tipo: "INADIMPLENCIA",
          prioridade: 5,
          promissoria_id: p.id,
          cobranca_pix_id: pix.id,
          cliente_nome: p.cliente_nome,
          telefone: p.telefone || telNorm!,
          telefone_normalizado: telNorm!,
          mensagem: msg,
          pix_copia_cola: pix.qr_code,
          regra_dias_atraso: diasAtraso,
          status: "pendente",
          agendado_para: proximoHorario(),
        });

        clientesJaProcessadosHoje.add(nomeKey);
        jaEnfileiradoPromissoria.add(p.id);
        jaEnfileiradoTelTipo.add(`${telNorm}:INADIMPLENCIA`);
        vagasRestantes--;
      }
    }

    if (itensParaInserir.length > 0) {
      const { error: insErr } = await supabase.from("fila_disparos_whatsapp").insert(itensParaInserir);
      if (insErr) throw new Error(insErr.message);
    }

    await registrarLog(
      supabase,
      "preparar_dia",
      config.modo === "dry_run" ? "dry_run" : "info",
      `Lote preparado (${config.modo}): ${itensParaInserir.length} item(ns) enfileirado(s), ${ignorados.length} ignorado(s).`,
      hoje,
      { enfileirados: itensParaInserir.length, ignorados: ignorados.slice(0, 30) }
    );

    return res.status(200).json({
      ok: true,
      modo: config.modo,
      hoje,
      enfileirados: itensParaInserir.length,
      ignorados_count: ignorados.length,
      ignorados: ignorados.slice(0, 30),
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
