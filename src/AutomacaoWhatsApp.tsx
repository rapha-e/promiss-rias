import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";
import { dt, money, normalizarTelefones } from "./lib";

interface AutomacaoConfig {
  id: number;
  ativo: boolean;
  modo: "dry_run" | "whitelist" | "producao";
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

export default function AutomacaoWhatsApp({ isAdmin }: { isAdmin: boolean }) {
  const [config, setConfig] = useState<AutomacaoConfig | null>(null);
  const [fila, setFila] = useState<any[]>([]);
  const [pixList, setPixList] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [statusBackend, setStatusBackend] = useState<any>(null);
  const [qrCodeBase64, setQrCodeBase64] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<"fila" | "pix" | "logs" | "simulador">("fila");

  const [novoTelWhitelist, setNovoTelWhitelist] = useState("");
  const [simTel, setSimTel] = useState("");
  const [simTexto, setSimTexto] = useState("Oi, só consigo pagar dia 25 desse mês");
  const [busy, setBusy] = useState(false);
  const [aviso, setAviso] = useState<{ tipo: "ok" | "err"; msg: string } | null>(null);
  const [erroMigracao, setErroMigracao] = useState<string | null>(null);

  const getToken = async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token || "";
  };

  const chamarApi = async (path: string, method: "GET" | "POST" = "POST", body?: unknown) => {
    const token = await getToken();
    const resp = await fetch(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await resp.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Resposta inesperada da API (${resp.status}). Verifique se os endpoints /api foram implantados na Vercel.`);
    }
    if (!resp.ok) throw new Error(json?.error || `Erro HTTP ${resp.status}`);
    return json;
  };

  const carregarTudo = useCallback(async () => {
    setErroMigracao(null);
    const [cfgRes, filaRes, pixRes, logsRes] = await Promise.all([
      supabase.from("automacao_config").select("*").eq("id", 1).maybeSingle(),
      supabase.from("fila_disparos_whatsapp").select("*").order("id", { ascending: false }).limit(80),
      supabase.from("cobrancas_pix").select("*").order("id", { ascending: false }).limit(80),
      supabase.from("automacao_logs").select("*").order("id", { ascending: false }).limit(100),
    ]);

    if (cfgRes.error) {
      setErroMigracao(
        `As tabelas de automação ainda não foram criadas neste banco Supabase (${cfgRes.error.message}). Execute a migration 0005_automacao_whatsapp.sql no SQL Editor do banco de homologação.`
      );
      return;
    }

    if (cfgRes.data) setConfig(cfgRes.data as AutomacaoConfig);
    setFila(filaRes.data || []);
    setPixList(pixRes.data || []);
    setLogs(logsRes.data || []);

    try {
      const st = await chamarApi("/api/automacao/status", "GET");
      setStatusBackend(st);
    } catch {
      // Em `vite dev` local sem `vercel dev`, /api pode não estar ativo
      setStatusBackend(null);
    }
  }, []);

  useEffect(() => {
    carregarTudo();
  }, [carregarTudo]);

  const salvarConfig = async (patch: Partial<AutomacaoConfig>) => {
    if (!config || !isAdmin) return;
    if (patch.modo === "producao" && config.modo !== "producao") {
      const ok = window.confirm(
        "ATENÇÃO: Você está mudando para o modo PRODUÇÃO. Todos os clientes elegíveis passarão a receber cobranças reais no WhatsApp quando o interruptor estiver ligado. Confirma?"
      );
      if (!ok) return;
    }
    setBusy(true);
    setAviso(null);
    const { data, error } = await supabase
      .from("automacao_config")
      .update(patch)
      .eq("id", 1)
      .select()
      .single();
    setBusy(false);
    if (error) {
      setAviso({ tipo: "err", msg: error.message });
    } else if (data) {
      setConfig(data as AutomacaoConfig);
      setAviso({ tipo: "ok", msg: "Configurações salvas com sucesso." });
    }
  };

  const adicionarWhitelist = () => {
    if (!config) return;
    const nums = normalizarTelefones(novoTelWhitelist);
    if (nums.length === 0) {
      setAviso({ tipo: "err", msg: "Informe um telefone válido com DDD (ex: 61 99999-9999)." });
      return;
    }
    const atual = Array.from(new Set([...(config.whitelist_telefones || []), ...nums]));
    setNovoTelWhitelist("");
    salvarConfig({ whitelist_telefones: atual });
  };

  const removerWhitelist = (tel: string) => {
    if (!config) return;
    salvarConfig({
      whitelist_telefones: (config.whitelist_telefones || []).filter(t => t !== tel),
    });
  };

  const handlePrepararDia = async () => {
    setBusy(true);
    setAviso(null);
    try {
      const r = await chamarApi("/api/automacao/preparar-dia", "POST");
      setAviso({
        tipo: "ok",
        msg: `Lote preparado (${r.modo}): ${r.enfileirados} item(ns) na fila, ${r.ignorados_count} ignorado(s).`,
      });
      await carregarTudo();
    } catch (e: any) {
      setAviso({ tipo: "err", msg: e?.message || String(e) });
    } finally {
      setBusy(false);
    }
  };

  const handleProcessarUm = async () => {
    setBusy(true);
    setAviso(null);
    try {
      const r = await chamarApi("/api/automacao/processar-fila?forcar_teste=1", "POST", { forcar_teste: true });
      setAviso({
        tipo: "ok",
        msg: r.mensagem || `Processado(s): ${r.processados} | Resultado: ${r.resultado || r.status}`,
      });
      await carregarTudo();
    } catch (e: any) {
      setAviso({ tipo: "err", msg: e?.message || String(e) });
    } finally {
      setBusy(false);
    }
  };

  const handleBuscarQrCode = async () => {
    setBusy(true);
    setAviso(null);
    try {
      const st = await chamarApi("/api/automacao/status?qrcode=1", "GET");
      setStatusBackend(st);
      if (st?.qrcode?.base64) {
        setQrCodeBase64(st.qrcode.base64);
      } else if (st?.evolution?.conectado) {
        setQrCodeBase64(null);
        setAviso({ tipo: "ok", msg: "Instância Evolution API já está conectada!" });
      } else {
        setAviso({ tipo: "err", msg: st?.qrcode?.erro || "Não foi possível obter o QR Code da Evolution API." });
      }
    } catch (e: any) {
      setAviso({ tipo: "err", msg: e?.message || String(e) });
    } finally {
      setBusy(false);
    }
  };

  const handleSimularPagamento = async (cobrancaId: number) => {
    if (!window.confirm("Simular aprovação do pagamento Pix? Isso executará a baixa nessa promissória (use apenas no banco de homologação!).")) {
      return;
    }
    setBusy(true);
    setAviso(null);
    try {
      const r = await chamarApi("/api/webhooks/mercadopago", "POST", { simular_cobranca_id: cobrancaId });
      setAviso({
        tipo: "ok",
        msg: `Baixa automática concluída na promissória #${r.promissoria_id}! Status do comprovante: ${r.comprovante}.`,
      });
      await carregarTudo();
    } catch (e: any) {
      setAviso({ tipo: "err", msg: e?.message || String(e) });
    } finally {
      setBusy(false);
    }
  };

  const handleSimularMensagemCliente = async () => {
    if (!simTel.trim() || !simTexto.trim()) {
      setAviso({ tipo: "err", msg: "Preencha telefone e texto da mensagem simulada." });
      return;
    }
    setBusy(true);
    setAviso(null);
    try {
      const r = await chamarApi("/api/webhooks/evolution", "POST", {
        simular_mensagem: { telefone: simTel, texto: simTexto },
      });
      setAviso({
        tipo: "ok",
        msg: `Intenção: ${r.intencao} | Ação: ${r.acao}${r.data_promessa ? ` (Data: ${dt(r.data_promessa)})` : ""} | Resposta: ${r.status_resposta}`,
      });
      await carregarTudo();
    } catch (e: any) {
      setAviso({ tipo: "err", msg: e?.message || String(e) });
    } finally {
      setBusy(false);
    }
  };

  const handleCancelarItemFila = async (id: number) => {
    await supabase.from("fila_disparos_whatsapp").update({ status: "cancelado" }).eq("id", id);
    await carregarTudo();
  };

  if (erroMigracao) {
    return (
      <div className="card" style={{ borderLeft: "5px solid var(--warn)", display: "grid", gap: 10 }}>
        <h2 style={{ margin: 0 }}>Automação WhatsApp + Pix Mercado Pago (Setup Inicial)</h2>
        <div style={{ color: "var(--bad)", fontSize: 14 }}>{erroMigracao}</div>
        <div style={{ fontSize: 13, color: "var(--mut)" }}>
          Arquivo SQL pronto no repositório: <code className="mono">supabase/migrations/0005_automacao_whatsapp.sql</code>
        </div>
        <div>
          <button className="btn" onClick={carregarTudo}>Tentar novamente</button>
        </div>
      </div>
    );
  }

  if (!config) {
    return <div style={{ padding: 32, color: "var(--mut)" }}>Carregando módulo de automação…</div>;
  }

  const corModo =
    config.modo === "dry_run" ? "#0284c7" : config.modo === "whitelist" ? "var(--warn)" : "var(--brand)";
  const labelModo =
    config.modo === "dry_run"
      ? "🧪 MODO DRY-RUN (Simulação Segura — não envia mensagens reais)"
      : config.modo === "whitelist"
      ? "🛡️ MODO WHITELIST (Testes Fechados — envia apenas para números autorizados)"
      : "🚀 MODO PRODUÇÃO (Envio ativo para clientes)";

  const qtdPendente = fila.filter(f => f.status === "pendente").length;
  const qtdEnviado = fila.filter(f => f.status === "enviado").length;
  const qtdSimulado = fila.filter(f => f.status === "simulado").length;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* Banner de Segurança */}
      <div
        className="card"
        style={{
          borderLeft: `6px solid ${corModo}`,
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: corModo, textTransform: "uppercase" }}>
            {labelModo}
          </div>
          <h2 style={{ margin: "4px 0 2px", fontSize: 20 }}>Automação WhatsApp (Evolution API) & Pix Mercado Pago</h2>
          <div style={{ fontSize: 13, color: "var(--mut)" }}>
            Kill Switch:{" "}
            <b style={{ color: config.ativo ? "var(--brand)" : "var(--bad)" }}>
              {config.ativo ? "ATIVADO" : "PAUSADO (SEGURO)"}
            </b>
            {statusBackend?.evolution && (
              <>
                {" · "}Evolution API:{" "}
                <b style={{ color: statusBackend.evolution.conectado ? "var(--brand)" : "var(--warn)" }}>
                  {statusBackend.evolution.conectado
                    ? `Conectado (${config.evolution_instance})`
                    : statusBackend.evolution.estado}
                </b>
              </>
            )}
            {statusBackend?.ambiente && (
              <>
                {" · "}Mercado Pago:{" "}
                <b>
                  {statusBackend.ambiente.mp_configurado
                    ? statusBackend.ambiente.mp_modo_teste
                      ? "Token TESTE"
                      : "Token Configurado"
                    : "Simulação Offline"}
                </b>
              </>
            )}
          </div>
        </div>

        {isAdmin && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="btn"
              style={{ background: config.ativo ? "var(--bad)" : "var(--brand)" }}
              disabled={busy}
              onClick={() => salvarConfig({ ativo: !config.ativo })}
            >
              {config.ativo ? "⏸️ Pausar Tudo (Kill Switch)" : "▶️ Ativar Automação"}
            </button>
            <button className="btn ghost" disabled={busy} onClick={handleBuscarQrCode}>
              📱 Conectar WhatsApp / Status
            </button>
            <button className="btn ghost" disabled={busy} onClick={carregarTudo}>
              ↻ Atualizar
            </button>
          </div>
        )}
      </div>

      {aviso && (
        <div
          className="card"
          style={{
            borderLeft: `5px solid ${aviso.tipo === "ok" ? "var(--brand)" : "var(--bad)"}`,
            color: aviso.tipo === "ok" ? "var(--brand)" : "var(--bad)",
            fontWeight: 600,
            fontSize: 13.5,
          }}
        >
          {aviso.msg}
        </div>
      )}

      {qrCodeBase64 && (
        <div className="card" style={{ textAlign: "center" }}>
          <h3 style={{ margin: "0 0 8px" }}>Escaneie o QR Code na Evolution API ({config.evolution_instance})</h3>
          <img
            src={qrCodeBase64.startsWith("data:") ? qrCodeBase64 : `data:image/png;base64,${qrCodeBase64}`}
            alt="QR Code WhatsApp"
            style={{ maxWidth: 260, borderRadius: 12, border: "1px solid var(--line)" }}
          />
          <div style={{ marginTop: 8 }}>
            <button className="btn ghost" onClick={() => setQrCodeBase64(null)}>Fechar QR Code</button>
          </div>
        </div>
      )}

      {/* KPIs rápidos */}
      <div className="kpis">
        <div className="card">
          <small>Na Fila (Pendentes)</small>
          <b>{qtdPendente}</b>
        </div>
        <div className="card">
          <small>Enviados (Reais)</small>
          <b style={{ color: "var(--brand)" }}>{qtdEnviado}</b>
        </div>
        <div className="card">
          <small>Simulados (Dry-Run)</small>
          <b style={{ color: "#0284c7" }}>{qtdSimulado}</b>
        </div>
        <div className="card">
          <small>Teto Diário Anti-Ban</small>
          <b>{config.limite_diario}/dia</b>
        </div>
      </div>

      {/* Painel de Configuração + Whitelist + Ações de Teste */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 }}>
        <div className="card" style={{ display: "grid", gap: 10 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>🛡️ Modo de Operação & Regras Anti-Banimento</h3>

          <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
            <span>Modo de Execução</span>
            <select
              disabled={!isAdmin || busy}
              value={config.modo}
              onChange={e => salvarConfig({ modo: e.target.value as any })}
            >
              <option value="dry_run">🧪 Dry-Run (Simular tudo sem enviar no WhatsApp)</option>
              <option value="whitelist">🛡️ Whitelist (Enviar somente para números de teste)</option>
              <option value="producao">🚀 Produção (Disparo real para clientes)</option>
            </select>
          </label>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              <span>Limite Diário (Warm-up)</span>
              <input
                type="number"
                disabled={!isAdmin}
                value={config.limite_diario}
                onChange={e => setConfig({ ...config, limite_diario: Number(e.target.value) })}
              />
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              <span>Cooldown mesmo cliente (dias)</span>
              <input
                type="number"
                disabled={!isAdmin}
                value={config.cooldown_dias}
                onChange={e => setConfig({ ...config, cooldown_dias: Number(e.target.value) })}
              />
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              <span>Atraso mínimo (seg)</span>
              <input
                type="number"
                disabled={!isAdmin}
                value={config.intervalo_min_seg}
                onChange={e => setConfig({ ...config, intervalo_min_seg: Number(e.target.value) })}
              />
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              <span>Atraso máximo (seg)</span>
              <input
                type="number"
                disabled={!isAdmin}
                value={config.intervalo_max_seg}
                onChange={e => setConfig({ ...config, intervalo_max_seg: Number(e.target.value) })}
              />
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              <span>Janela Início (BRT)</span>
              <input
                type="text"
                disabled={!isAdmin}
                value={config.horario_inicio}
                onChange={e => setConfig({ ...config, horario_inicio: e.target.value })}
              />
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              <span>Janela Fim (BRT)</span>
              <input
                type="text"
                disabled={!isAdmin}
                value={config.horario_fim}
                onChange={e => setConfig({ ...config, horario_fim: e.target.value })}
              />
            </label>
          </div>

          <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                disabled={!isAdmin}
                checked={config.enviar_vencimento_dia}
                onChange={e => setConfig({ ...config, enviar_vencimento_dia: e.target.checked })}
              />
              Enviar Pix automático para vencimentos do dia
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                disabled={!isAdmin}
                checked={config.enviar_promessa_dia}
                onChange={e => setConfig({ ...config, enviar_promessa_dia: e.target.checked })}
              />
              Enviar lembrete nas promessas do dia
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                disabled={!isAdmin}
                checked={config.enviar_inadimplencia}
                onChange={e => setConfig({ ...config, enviar_inadimplencia: e.target.checked })}
              />
              Ativar régua de inadimplência (D+3, D+10, D+25, D+45, D+60+)
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                disabled={!isAdmin}
                checked={config.enviar_comprovante_auto}
                onChange={e => setConfig({ ...config, enviar_comprovante_auto: e.target.checked })}
              />
              Enviar comprovante no WhatsApp após baixa Pix automática
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                disabled={!isAdmin}
                checked={config.cadastrar_promessa_auto}
                onChange={e => setConfig({ ...config, cadastrar_promessa_auto: e.target.checked })}
              />
              Cadastrar promessa automática quando cliente informar previsão
            </label>
          </div>

          {isAdmin && (
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                salvarConfig({
                  limite_diario: config.limite_diario,
                  cooldown_dias: config.cooldown_dias,
                  intervalo_min_seg: config.intervalo_min_seg,
                  intervalo_max_seg: config.intervalo_max_seg,
                  horario_inicio: config.horario_inicio,
                  horario_fim: config.horario_fim,
                  enviar_vencimento_dia: config.enviar_vencimento_dia,
                  enviar_promessa_dia: config.enviar_promessa_dia,
                  enviar_inadimplencia: config.enviar_inadimplencia,
                  enviar_comprovante_auto: config.enviar_comprovante_auto,
                  cadastrar_promessa_auto: config.cadastrar_promessa_auto,
                })
              }
            >
              💾 Salvar Parâmetros
            </button>
          )}
        </div>

        {/* Card Whitelist + Ações de Teste */}
        <div className="card" style={{ display: "grid", gap: 12, alignContent: "start" }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>📱 Lista Branca de Testes (Whitelist)</h3>
          <div style={{ fontSize: 13, color: "var(--mut)" }}>
            Enquanto o modo estiver em <b>Whitelist</b>, nenhuma mensagem sai para números fora desta lista.
          </div>
          {isAdmin && (
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                placeholder="Ex: 61 99999-9999"
                value={novoTelWhitelist}
                onChange={e => setNovoTelWhitelist(e.target.value)}
                style={{ flex: 1 }}
              />
              <button className="btn" disabled={busy} onClick={adicionarWhitelist}>
                + Adicionar
              </button>
            </div>
          )}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(config.whitelist_telefones || []).length === 0 ? (
              <span style={{ fontSize: 12.5, color: "var(--mut)" }}>Nenhum número cadastrado na whitelist.</span>
            ) : (
              (config.whitelist_telefones || []).map(tel => (
                <span key={tel} className="filter-chip mono">
                  {tel}
                  {isAdmin && (
                    <button type="button" onClick={() => removerWhitelist(tel)} title="Remover">
                      ✕
                    </button>
                  )}
                </span>
              ))
            )}
          </div>

          <hr style={{ width: "100%", border: 0, borderTop: "1px solid var(--line)", margin: "4px 0" }} />

          <h3 style={{ margin: 0, fontSize: 16 }}>🧪 Execução Manual de Homologação</h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {isAdmin && (
              <>
                <button className="btn" disabled={busy} onClick={handlePrepararDia}>
                  1. Preparar Lote do Dia
                </button>
                <button className="btn ghost" disabled={busy} onClick={handleProcessarUm}>
                  2. Processar Próximo da Fila
                </button>
              </>
            )}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--mut)" }}>
            Em <b>Dry-Run</b>, o sistema gera os registros e simula os disparos sem enviar WhatsApp real. Em{" "}
            <b>Whitelist</b>, envia somente para os telefones listados acima.
          </div>
        </div>
      </div>

      {/* Sub-abas de Monitoramento */}
      <div className="chips">
        <button className={`chip ${subTab === "fila" ? "on" : ""}`} onClick={() => setSubTab("fila")}>
          Fila de Disparos ({fila.length})
        </button>
        <button className={`chip ${subTab === "pix" ? "on" : ""}`} onClick={() => setSubTab("pix")}>
          Cobranças Pix MP ({pixList.length})
        </button>
        <button className={`chip ${subTab === "logs" ? "on" : ""}`} onClick={() => setSubTab("logs")}>
          Logs de Auditoria ({logs.length})
        </button>
        <button className={`chip ${subTab === "simulador" ? "on" : ""}`} onClick={() => setSubTab("simulador")}>
          🤖 Simulador de Resposta WhatsApp
        </button>
      </div>

      {subTab === "fila" && (
        <div className="wrap">
          <table>
            <thead>
              <tr>
                <th>Cliente</th>
                <th>Tipo</th>
                <th>Telefone</th>
                <th>Status</th>
                <th>Agendado</th>
                <th>Prévia da Mensagem</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {fila.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", color: "var(--mut)", padding: 24 }}>
                    Nenhum item na fila ainda. Clique em "1. Preparar Lote do Dia" para testar.
                  </td>
                </tr>
              ) : (
                fila.map(item => (
                  <tr key={item.id}>
                    <td>{item.cliente_nome}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{item.tipo}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{item.telefone_normalizado}</td>
                    <td>
                      <span
                        className="filter-chip"
                        style={{
                          color:
                            item.status === "enviado"
                              ? "var(--brand)"
                              : item.status === "erro" || item.status === "bloqueado_whitelist"
                              ? "var(--bad)"
                              : item.status === "simulado"
                              ? "#0284c7"
                              : "var(--warn)",
                        }}
                      >
                        {item.status}
                      </span>
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {new Date(item.agendado_para).toLocaleString("pt-BR")}
                    </td>
                    <td style={{ maxWidth: 360, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={item.mensagem}>
                      {item.mensagem}
                    </td>
                    <td>
                      {isAdmin && item.status === "pendente" && (
                        <button className="btn ghost" onClick={() => handleCancelarItemFila(item.id)}>
                          Cancelar
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {subTab === "pix" && (
        <div className="wrap">
          <table>
            <thead>
              <tr>
                <th>Promissória</th>
                <th>Cliente</th>
                <th>Valor</th>
                <th>Status MP</th>
                <th>Baixa Auto</th>
                <th>ID MP</th>
                <th>Ação de Teste</th>
              </tr>
            </thead>
            <tbody>
              {pixList.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", color: "var(--mut)", padding: 24 }}>
                    Nenhuma cobrança Pix gerada ainda.
                  </td>
                </tr>
              ) : (
                pixList.map(px => (
                  <tr key={px.id}>
                    <td className="mono">#{px.promissoria_id}</td>
                    <td>{px.cliente_nome}</td>
                    <td className="n">{money(px.valor_centavos)}</td>
                    <td className="mono">{px.status}</td>
                    <td>{px.baixa_realizada ? "✅ Sim" : "⏳ Não"}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{px.mp_payment_id || "—"}</td>
                    <td>
                      {isAdmin && !px.baixa_realizada && config.modo !== "producao" && (
                        <button className="btn" disabled={busy} onClick={() => handleSimularPagamento(px.id)}>
                          Simular Pix Pago
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {subTab === "logs" && (
        <div className="wrap">
          <table>
            <thead>
              <tr>
                <th>Data/Hora</th>
                <th>Origem</th>
                <th>Nível</th>
                <th>Mensagem</th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ textAlign: "center", color: "var(--mut)", padding: 24 }}>
                    Nenhum log registrado ainda.
                  </td>
                </tr>
              ) : (
                logs.map(lg => (
                  <tr key={lg.id}>
                    <td className="mono" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                      {new Date(lg.created_at).toLocaleString("pt-BR")}
                    </td>
                    <td className="mono" style={{ fontSize: 12 }}>{lg.origem}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{lg.nivel}</td>
                    <td>{lg.mensagem}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {subTab === "simulador" && (
        <div className="card" style={{ display: "grid", gap: 10, maxWidth: 680 }}>
          <h3 style={{ margin: 0 }}>🤖 Simulador de Mensagem Recebida (Promessa / Pedido de Pix)</h3>
          <div style={{ fontSize: 13, color: "var(--mut)" }}>
            Teste o comportamento do robô quando um cliente envia uma mensagem no WhatsApp informando previsão de pagamento ou pedindo o Pix.
          </div>
          <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
            <span>Telefone de um cliente cadastrado no banco de homologação</span>
            <input
              type="text"
              placeholder="Ex: 61 99999-9999"
              value={simTel}
              onChange={e => setSimTel(e.target.value)}
            />
          </label>
          <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
            <span>Mensagem simulada do cliente</span>
            <input
              type="text"
              value={simTexto}
              onChange={e => setSimTexto(e.target.value)}
            />
          </label>
          <div>
            <button className="btn" disabled={busy || !isAdmin} onClick={handleSimularMensagemCliente}>
              Testar Interpretação & Fluxo
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
