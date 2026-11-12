import { avaliarPermissaoEnvio, enviarTextoEvolution } from "../_lib/evolution.js";
import {
  autorizarAdminOuCron,
  carregarConfigAutomacao,
  dentroJanelaComercial,
  getSupabaseAdmin,
  hojeBR,
  registrarLog,
} from "../_lib/supabaseAdmin.js";

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
    const forcarTesteManual = auth.via === "admin" && (req.body?.forcar_teste === true || req.query?.forcar_teste === "1");

    if (!config.ativo && !(forcarTesteManual && config.modo === "dry_run")) {
      return res.status(200).json({
        ok: true,
        processados: 0,
        status: "pausado",
        mensagem: "Automação pausada (Kill Switch desligado). Ative o interruptor para processar envios.",
      });
    }

    const hoje = hojeBR();
    const inicioDiaIso = `${hoje}T00:00:00-03:00`;

    // 1. Verificar teto diário anti-banimento
    const { count: enviadosHoje } = await supabase
      .from("fila_disparos_whatsapp")
      .select("*", { count: "exact", head: true })
      .gte("enviado_em", inicioDiaIso)
      .eq("status", "enviado");

    if ((enviadosHoje || 0) >= config.limite_diario) {
      return res.status(200).json({
        ok: true,
        processados: 0,
        status: "limite_diario",
        mensagem: `Limite diário anti-banimento atingido (${enviadosHoje}/${config.limite_diario}).`,
      });
    }

    // 2. Buscar próximo item vencido na agenda (prioridade menor = mais urgente)
    const agoraIso = new Date().toISOString();
    let query = supabase
      .from("fila_disparos_whatsapp")
      .select("*")
      .eq("status", "pendente")
      .order("prioridade", { ascending: true })
      .order("agendado_para", { ascending: true })
      .limit(1);

    // Em teste manual de homologação (dry_run/whitelist), admin pode processar o próximo mesmo agendado para minutos depois
    if (!forcarTesteManual) {
      query = query.lte("agendado_para", agoraIso);
    }

    const { data: candidatos, error: qErr } = await query;
    if (qErr) throw new Error(qErr.message);

    const item = candidatos?.[0];
    if (!item) {
      return res.status(200).json({
        ok: true,
        processados: 0,
        status: "vazia",
        mensagem: "Nenhum item pendente pronto para envio no momento.",
      });
    }

    // 3. Validar janela comercial (comprovantes de Pix recém-pagos têm prioridade 1 e não ficam bloqueados pela janela)
    const isComprovanteOuAtendimento = item.tipo === "COMPROVANTE" || item.tipo === "ATENDIMENTO";
    if (!isComprovanteOuAtendimento && !(forcarTesteManual && config.modo !== "producao")) {
      const janela = dentroJanelaComercial(config.horario_inicio, config.horario_fim);
      if (!janela.permitido) {
        return res.status(200).json({
          ok: true,
          processados: 0,
          status: "fora_janela",
          mensagem: janela.motivo,
        });
      }
    }

    // 4. Trava otimista simples
    const { data: locked, error: lockErr } = await supabase
      .from("fila_disparos_whatsapp")
      .update({ status: "processando", tentativas: (item.tentativas || 0) + 1 })
      .eq("id", item.id)
      .eq("status", "pendente")
      .select()
      .maybeSingle();

    if (lockErr || !locked) {
      return res.status(200).json({ ok: true, processados: 0, status: "concorrencia" });
    }

    // 5. Avaliar travas de segurança (Dry-Run / Whitelist / Kill Switch)
    const permissao =
      forcarTesteManual && config.modo === "dry_run"
        ? { permitido: false, acao: "dry_run" as const, motivo: "Simulação manual em modo DRY-RUN." }
        : avaliarPermissaoEnvio(config, item.telefone_normalizado);

    if (permissao.acao === "dry_run") {
      await supabase
        .from("fila_disparos_whatsapp")
        .update({ status: "simulado", enviado_em: new Date().toISOString() })
        .eq("id", item.id);

      await registrarLog(
        supabase,
        "processar_fila",
        "dry_run",
        `[DRY-RUN] Simulou ${item.tipo} para ${item.cliente_nome} (${item.telefone_normalizado})`,
        item.id,
        { preview_mensagem: item.mensagem.slice(0, 220) }
      );

      return res.status(200).json({
        ok: true,
        processados: 1,
        resultado: "simulado",
        item_id: item.id,
        cliente: item.cliente_nome,
      });
    }

    if (permissao.acao === "bloqueado_whitelist" || permissao.acao === "pausado") {
      await supabase
        .from("fila_disparos_whatsapp")
        .update({
          status: permissao.acao === "bloqueado_whitelist" ? "bloqueado_whitelist" : "pendente",
          ultimo_erro: permissao.motivo,
        })
        .eq("id", item.id);

      await registrarLog(supabase, "processar_fila", "warn", permissao.motivo, item.id);
      return res.status(200).json({
        ok: true,
        processados: 1,
        resultado: permissao.acao,
        mensagem: permissao.motivo,
      });
    }

    // 6. Disparo REAL via Evolution API
    const envio = await enviarTextoEvolution({
      telefone: item.telefone_normalizado,
      mensagem: item.mensagem,
      instanceOverride: config.evolution_instance,
    });

    if (!envio.ok) {
      await supabase
        .from("fila_disparos_whatsapp")
        .update({ status: "erro", ultimo_erro: envio.erro || "Erro desconhecido" })
        .eq("id", item.id);

      if (envio.numeroInvalido) {
        await supabase.from("whatsapp_contatos_controle").upsert({
          telefone_normalizado: item.telefone_normalizado,
          cliente_nome: item.cliente_nome,
          whatsapp_invalido: true,
        });
      }

      await registrarLog(
        supabase,
        "processar_fila",
        "error",
        `Falha ao enviar para ${item.cliente_nome}: ${envio.erro}`,
        item.id
      );

      return res.status(200).json({
        ok: false,
        processados: 1,
        resultado: "erro",
        erro: envio.erro,
      });
    }

    // Sucesso!
    const agoraEnvio = new Date().toISOString();
    await supabase
      .from("fila_disparos_whatsapp")
      .update({
        status: "enviado",
        enviado_em: agoraEnvio,
        evolution_message_id: envio.messageId || null,
        ultimo_erro: null,
      })
      .eq("id", item.id);

    // Atualiza cooldown se foi cobrança ativa
    const isCobrancaAtiva = item.tipo === "VENCIMENTO_DIA" || item.tipo === "INADIMPLENCIA" || item.tipo === "PROMESSA_DIA";
    const { data: ctrlAtual } = await supabase
      .from("whatsapp_contatos_controle")
      .select("total_envios")
      .eq("telefone_normalizado", item.telefone_normalizado)
      .maybeSingle();

    await supabase.from("whatsapp_contatos_controle").upsert({
      telefone_normalizado: item.telefone_normalizado,
      cliente_nome: item.cliente_nome,
      total_envios: (ctrlAtual?.total_envios || 0) + 1,
      ...(isCobrancaAtiva ? { ultimo_disparo_cobranca_em: agoraEnvio } : {}),
    });

    // Registra na trilha oficial de cobranças da loja
    await supabase.from("cobranca_interacoes").insert({
      cliente_nome: item.cliente_nome,
      telefone: item.telefone_normalizado,
      canal: "WHATSAPP",
      mensagem: `[AUTO:${item.tipo}] ${item.mensagem.slice(0, 280)}`,
      usuario_email: "automacao@leooticas.fin",
    });

    await registrarLog(
      supabase,
      "processar_fila",
      "info",
      `Mensagem ${item.tipo} enviada para ${item.cliente_nome} (${item.telefone_normalizado})`,
      item.id,
      { message_id: envio.messageId }
    );

    return res.status(200).json({
      ok: true,
      processados: 1,
      resultado: "enviado",
      item_id: item.id,
      cliente: item.cliente_nome,
      message_id: envio.messageId,
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
