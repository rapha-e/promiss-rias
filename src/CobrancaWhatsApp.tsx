import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";
import { dt, getDDD, linkWhatsApp, money, normalizarTelefones, setDDD, titulo } from "./lib";
import type { Row } from "./lib";

type FiltroPeriodo = "hoje" | "proximos_3" | "vencidas_1_7" | "vencidas_8_30" | "vencidas_30_mais" | "todas";

type ClienteFila = {
  cliente: string;
  telefoneOriginal: string;
  telefoneFormatado: string;
  promissorias: Row[];
  valorTotal: number;
  vencimentoMaisUrgente: string | null;
  statusEnvio: "pendente" | "enviado" | "pulado";
};

const PIX_KEY = "leooticas_pix_chave";

function getHojeISO() {
  const agora = new Date();
  const d = new Date(agora.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  return d.toISOString().slice(0, 10);
}

function somaDiasStr(iso: string, dias: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function diffDias(hoje: string, venc: string): number {
  const tH = new Date(hoje + "T00:00:00Z").getTime();
  const tV = new Date(venc + "T00:00:00Z").getTime();
  return Math.round((tH - tV) / (1000 * 60 * 60 * 24));
}

export default function CobrancaWhatsApp() {
  const [todasPromissorias, setTodasPromissorias] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [filtro, setFiltro] = useState<FiltroPeriodo>("hoje");
  const [ddd, setDddLocal] = useState(getDDD());
  const [chavePix, setChavePix] = useState(() => {
    try {
      return localStorage.getItem(PIX_KEY) || "";
    } catch {
      return "";
    }
  });

  const [busca, setBusca] = useState("");
  const [statusFiltro, setStatusFiltro] = useState<"todos" | "pendente" | "enviado" | "pulado">("todos");
  const [estadosEnvio, setEstadosEnvio] = useState<Record<string, "enviado" | "pulado">>({});
  const [clienteFocoIndex, setClienteFocoIndex] = useState(0);

  // Carrega todas as promissórias com saldo em aberto
  const carregarDados = useCallback(async () => {
    setLoading(true);
    let todas: Row[] = [];
    const pageSize = 1000;
    let from = 0;

    while (true) {
      const { data, error } = await supabase
        .from("promissorias")
        .select("*")
        .eq("fundo_perdido", false)
        .gt("saldo_devedor", 0)
        .order("vencimento", { ascending: true })
        .range(from, from + pageSize - 1);

      if (error || !data) break;
      todas.push(...(data as Row[]));
      if (data.length < pageSize) break;
      from += pageSize;
    }

    setTodasPromissorias(todas);
    setLoading(false);
  }, []);

  useEffect(() => {
    carregarDados();
  }, [carregarDados]);

  const handleSalvarPix = (val: string) => {
    setChavePix(val);
    try {
      localStorage.setItem(PIX_KEY, val);
    } catch {
      // ignore
    }
  };

  const handleMudarDDD = (val: string) => {
    const limpo = val.replace(/\D/g, "").slice(0, 2);
    setDddLocal(limpo);
    if (limpo.length === 2) setDDD(limpo);
  };

  const hoje = getHojeISO();

  // Agrupa e filtra promissórias por cliente conforme a regra de período
  const filaCompleta: ClienteFila[] = useMemo(() => {
    // 1. Filtra as promissórias pelo critério de vencimento
    const filtradas = todasPromissorias.filter(r => {
      if (!r.vencimento) return filtro === "todas";
      const diasAtraso = diffDias(hoje, r.vencimento);

      switch (filtro) {
        case "hoje":
          return r.vencimento === hoje;
        case "proximos_3":
          return r.vencimento > hoje && r.vencimento <= somaDiasStr(hoje, 3);
        case "vencidas_1_7":
          return diasAtraso >= 1 && diasAtraso <= 7;
        case "vencidas_8_30":
          return diasAtraso >= 8 && diasAtraso <= 30;
        case "vencidas_30_mais":
          return diasAtraso > 30;
        case "todas":
        default:
          return true;
      }
    });

    // 2. Agrupa por cliente para unificar cobrança
    const mapa = new Map<string, Row[]>();
    for (const r of filtradas) {
      const chave = r.cliente_nome.trim().toUpperCase();
      if (!mapa.has(chave)) mapa.set(chave, []);
      mapa.get(chave)!.push(r);
    }

    const resultado: ClienteFila[] = [];
    for (const [chave, lista] of mapa.entries()) {
      const telOriginal = lista.find(p => p.telefone)?.telefone || "";
      const telefonesValidos = normalizarTelefones(telOriginal, ddd);
      const telFormatado = telefonesValidos[0] || "";
      const valorTotal = lista.reduce((s, p) => s + (p.saldo_devedor || 0), 0);
      const vencMaisUrgente = lista.map(p => p.vencimento).filter(Boolean).sort()[0] || null;

      resultado.push({
        cliente: lista[0].cliente_nome,
        telefoneOriginal: telOriginal,
        telefoneFormatado: telFormatado,
        promissorias: lista,
        valorTotal,
        vencimentoMaisUrgente: vencMaisUrgente,
        statusEnvio: estadosEnvio[chave] || "pendente",
      });
    }

    // Ordena: quem tem telefone válido primeiro, depois por valor total decrescente
    return resultado.sort((a, b) => {
      if (Boolean(a.telefoneFormatado) !== Boolean(b.telefoneFormatado)) {
        return a.telefoneFormatado ? -1 : 1;
      }
      return b.valorTotal - a.valorTotal;
    });
  }, [todasPromissorias, filtro, hoje, ddd, estadosEnvio]);

  // Lista com busca e filtro de status
  const filaExibicao = useMemo(() => {
    return filaCompleta.filter(item => {
      if (statusFiltro !== "todos" && item.statusEnvio !== statusFiltro) return false;
      if (busca.trim()) {
        const b = busca.trim().toLowerCase();
        const nomeOk = item.cliente.toLowerCase().includes(b);
        const telOk = item.telefoneOriginal.includes(b);
        return nomeOk || telOk;
      }
      return true;
    });
  }, [filaCompleta, statusFiltro, busca]);

  // Estatísticas
  const stats = useMemo(() => {
    const total = filaCompleta.length;
    const enviados = filaCompleta.filter(i => i.statusEnvio === "enviado").length;
    const pulados = filaCompleta.filter(i => i.statusEnvio === "pulado").length;
    const pendentes = filaCompleta.filter(i => i.statusEnvio === "pendente").length;
    const semTelefone = filaCompleta.filter(i => !i.telefoneFormatado).length;
    const valorTotalFila = filaCompleta.reduce((s, i) => s + i.valorTotal, 0);

    return { total, enviados, pulados, pendentes, semTelefone, valorTotalFila };
  }, [filaCompleta]);

  // Cliente atual em foco para disparo passo a passo
  const clienteAtual = useMemo(() => {
    // Procura o primeiro pendente com telefone a partir do índice ou pega o selecionado
    if (!filaExibicao.length) return null;
    if (clienteFocoIndex >= filaExibicao.length) return filaExibicao[0];
    return filaExibicao[clienteFocoIndex];
  }, [filaExibicao, clienteFocoIndex]);

  // Gera texto da mensagem
  const gerarMensagem = (item: ClienteFila): string => {
    const primeiroNome = titulo(item.cliente.trim().split(/\s+/)[0] || "Cliente");
    const linhas = item.promissorias.slice(0, 5).map(p => {
      const dias = p.vencimento ? diffDias(hoje, p.vencimento) : 0;
      let statusStr = "";
      if (p.vencimento) {
        if (dias > 0) statusStr = ` (vencida há ${dias} dias)`;
        else if (dias === 0) statusStr = " (vence hoje!)";
        else statusStr = ` (vence em ${-dias} dias)`;
      }
      return `• Parcela ${p.parcelas || "Única"}: ${money(p.saldo_devedor)}${p.vencimento ? " — venc. " + dt(p.vencimento) : ""}${statusStr}`;
    });

    if (item.promissorias.length > 5) {
      linhas.push(`• e mais ${item.promissorias.length - 5} parcela(s)`);
    }

    let texto = `Olá, ${primeiroNome}! Tudo bem? Esperamos que sim!\n\n`;
    texto += `Passando para lembrar referente à sua compra na *LeoÓticas*:\n\n`;
    texto += `${linhas.join("\n")}\n\n`;
    texto += `*Total em aberto:* ${money(item.valorTotal)}\n\n`;

    if (chavePix.trim()) {
      texto += `🔑 *Chave PIX:* \`${chavePix.trim()}\`\n\n`;
    }

    texto += `Caso já tenha efetuado o pagamento, por favor desconsidere este aviso.\n`;
    texto += `Se precisar de auxílio ou da 2ª via, é só nos responder aqui. Obrigado! 🙏`;

    return texto;
  };

  // Disparar WhatsApp e avançar
  const handleDispararEAvancar = (item: ClienteFila) => {
    if (!item.telefoneFormatado) {
      alert("Este cliente não possui um telefone celular válido para envio.");
      return;
    }

    const msg = gerarMensagem(item);
    const url = linkWhatsApp(item.telefoneFormatado, msg);
    window.open(url, "_blank");

    const chave = item.cliente.trim().toUpperCase();
    setEstadosEnvio(prev => ({ ...prev, [chave]: "enviado" }));

    // Avança para o próximo da lista exibida
    if (clienteFocoIndex < filaExibicao.length - 1) {
      setClienteFocoIndex(prev => prev + 1);
    }
  };

  const handlePular = (item: ClienteFila) => {
    const chave = item.cliente.trim().toUpperCase();
    setEstadosEnvio(prev => ({ ...prev, [chave]: "pulado" }));
    if (clienteFocoIndex < filaExibicao.length - 1) {
      setClienteFocoIndex(prev => prev + 1);
    }
  };

  const handleResetarFila = () => {
    if (window.confirm("Deseja reiniciar a fila e marcar todos como pendentes novamente?")) {
      setEstadosEnvio({});
      setClienteFocoIndex(0);
    }
  };

  // Exportar para CSV / Excel
  const handleExportarCSV = () => {
    if (!filaCompleta.length) {
      alert("Nenhum cliente na fila para exportar.");
      return;
    }

    const cabecalho = ["Cliente", "Telefone Original", "Telefone WhatsApp", "Qtd Promissorias", "Saldo Total (R$)", "Status Envio", "Mensagem Formatada"];
    const linhas = filaCompleta.map(c => [
      `"${c.cliente.replace(/"/g, '""')}"`,
      `"${c.telefoneOriginal}"`,
      `"${c.telefoneFormatado}"`,
      c.promissorias.length,
      (c.valorTotal / 100).toFixed(2).replace(".", ","),
      c.statusEnvio,
      `"${gerarMensagem(c).replace(/"/g, '""').replace(/\n/g, " ")}"`,
    ]);

    const csvContent = "\uFEFF" + [cabecalho.join(";"), ...linhas.map(l => l.join(";"))].join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `cobrancas_whatsapp_${filtro}_${hoje}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", paddingBottom: 40 }}>
      <div className="head2 noprint" style={{ marginBottom: 14 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>Cobrança Rápida via WhatsApp</h1>
          <div className="sub" style={{ marginTop: 2 }}>
            Fila assistida de disparos rápidos e seguros, sem risco de banimento do número da ótica.
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <button className="btn ghost" onClick={handleExportarCSV} title="Baixar lista em planilha para usar externamente">
            📥 Exportar para Excel (CSV)
          </button>
          <button className="btn ghost" onClick={handleResetarFila} title="Limpar marcações de enviado/pulado">
            🔄 Reiniciar Fila
          </button>
        </div>
      </div>

      {/* Barra de Configurações (DDD e Chave PIX) */}
      <div
        style={{
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: 12,
          padding: "12px 16px",
          display: "flex",
          gap: 16,
          flexWrap: "wrap",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <label className="inl" style={{ fontSize: 13, fontWeight: 600 }}>
          <span>DDD padrão:</span>
          <input
            value={ddd}
            onChange={e => handleMudarDDD(e.target.value)}
            style={{ width: 60, textAlign: "center", padding: "6px 8px" }}
            maxLength={2}
            placeholder="61"
          />
        </label>
        <label className="inl" style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 260 }}>
          <span>Chave PIX da loja:</span>
          <input
            value={chavePix}
            onChange={e => handleSalvarPix(e.target.value)}
            placeholder="CNPJ, telefone ou chave aleatória para incluir na mensagem"
            style={{ flex: 1, padding: "6px 10px" }}
          />
        </label>
      </div>

      {/* Seletor de Períodos de Cobrança */}
      <div className="chips" style={{ marginBottom: 16 }}>
        <button className={`chip ${filtro === "hoje" ? "on" : ""}`} onClick={() => { setFiltro("hoje"); setClienteFocoIndex(0); }}>
          🎯 Vencem Hoje
        </button>
        <button className={`chip ${filtro === "proximos_3" ? "on" : ""}`} onClick={() => { setFiltro("proximos_3"); setClienteFocoIndex(0); }}>
          📅 Vencem em até 3 dias
        </button>
        <button className={`chip ${filtro === "vencidas_1_7" ? "on" : ""}`} onClick={() => { setFiltro("vencidas_1_7"); setClienteFocoIndex(0); }}>
          ⚠️ Vencidas de 1 a 7 dias
        </button>
        <button className={`chip ${filtro === "vencidas_8_30" ? "on" : ""}`} onClick={() => { setFiltro("vencidas_8_30"); setClienteFocoIndex(0); }}>
          🚨 Vencidas de 8 a 30 dias
        </button>
        <button className={`chip ${filtro === "vencidas_30_mais" ? "on" : ""}`} onClick={() => { setFiltro("vencidas_30_mais"); setClienteFocoIndex(0); }}>
          🔴 Vencidas há mais de 30 dias
        </button>
        <button className={`chip ${filtro === "todas" ? "on" : ""}`} onClick={() => { setFiltro("todas"); setClienteFocoIndex(0); }}>
          📋 Todas com saldo em aberto
        </button>
      </div>

      {/* KPIs da Fila Atual */}
      <section className="kpis" style={{ marginBottom: 16 }}>
        <div className="card hl">
          <small>Valor a Cobrar na Fila</small>
          <b>{money(stats.valorTotalFila)}</b>
        </div>
        <div className="card">
          <small>Clientes na Fila</small>
          <b>{stats.total.toLocaleString("pt-BR")}</b>
          {stats.semTelefone > 0 && <span className="ksub" style={{ color: "var(--bad)" }}>⚠️ {stats.semTelefone} sem telefone válido</span>}
        </div>
        <div className="card">
          <small>Disparados / Enviados</small>
          <b style={{ color: "var(--brand)" }}>{stats.enviados.toLocaleString("pt-BR")}</b>
        </div>
        <div className="card">
          <small>Restantes / Pendentes</small>
          <b style={{ color: stats.pendentes > 0 ? "var(--warn)" : "var(--mut)" }}>{stats.pendentes.toLocaleString("pt-BR")}</b>
        </div>
      </section>

      {/* Barra de Progresso do Lote */}
      {stats.total > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 600, color: "var(--mut)", marginBottom: 6 }}>
            <span>Progresso da Fila: {stats.enviados} de {stats.total} contatados</span>
            <span>{Math.round((stats.enviados / stats.total) * 100)}% concluído</span>
          </div>
          <div style={{ background: "var(--line)", height: 8, borderRadius: 99, overflow: "hidden" }}>
            <div
              style={{
                background: "var(--brand)",
                height: "100%",
                width: `${Math.round((stats.enviados / stats.total) * 100)}%`,
                transition: "width 0.3s ease",
              }}
            />
          </div>
        </div>
      )}

      {/* CARD DO CLIENTE EM FOCO (DISPARO ASSISTIDO) */}
      {clienteAtual ? (
        <div
          style={{
            background: "var(--card)",
            border: "2px solid var(--brand)",
            borderRadius: 14,
            padding: 20,
            marginBottom: 24,
            boxShadow: "0 4px 20px rgba(0,0,0,0.06)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span
                style={{
                  background: "var(--brand)",
                  color: "#fff",
                  fontSize: 12,
                  fontWeight: 700,
                  padding: "3px 10px",
                  borderRadius: 99,
                  textTransform: "uppercase",
                }}
              >
                Próximo da fila ({clienteFocoIndex + 1} de {filaExibicao.length})
              </span>
              <span style={{ fontSize: 13, color: "var(--mut)" }}>
                Status: <b>{clienteAtual.statusEnvio.toUpperCase()}</b>
              </span>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="btn ghost"
                style={{ padding: "6px 12px", fontSize: 13 }}
                disabled={clienteFocoIndex === 0}
                onClick={() => setClienteFocoIndex(prev => Math.max(0, prev - 1))}
              >
                ⬅️ Anterior
              </button>
              <button
                type="button"
                className="btn ghost"
                style={{ padding: "6px 12px", fontSize: 13 }}
                disabled={clienteFocoIndex >= filaExibicao.length - 1}
                onClick={() => setClienteFocoIndex(prev => Math.min(filaExibicao.length - 1, prev + 1))}
              >
                Próximo ➡️
              </button>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 20 }}>
            {/* Lado Esquerdo: Dados do Cliente */}
            <div>
              <h2 style={{ margin: "0 0 6px", fontSize: 22 }}>{clienteAtual.cliente}</h2>
              <div style={{ fontSize: 14, color: "var(--mut)", marginBottom: 12 }}>
                Telefone: <strong style={{ color: clienteAtual.telefoneFormatado ? "var(--ink)" : "var(--bad)" }}>
                  {clienteAtual.telefoneOriginal || "Nenhum telefone cadastrado"}
                </strong>
                {clienteAtual.telefoneFormatado && (
                  <span style={{ marginLeft: 8, color: "var(--brand)", fontSize: 12 }}>
                    (WhatsApp: +{clienteAtual.telefoneFormatado})
                  </span>
                )}
              </div>

              <div style={{ background: "var(--soft)", padding: 12, borderRadius: 10, marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 13, color: "var(--mut)" }}>Valor total em aberto:</span>
                  <b className="mono" style={{ fontSize: 16, color: "var(--brand)" }}>{money(clienteAtual.valorTotal)}</b>
                </div>
                <div style={{ fontSize: 12, color: "var(--mut)" }}>
                  Promissórias em aberto: <b>{clienteAtual.promissorias.length}</b>
                  {clienteAtual.promissorias.map(p => (
                    <div key={p.id} style={{ marginTop: 3 }}>
                      • Parcela {p.parcelas || "1X"}: {money(p.saldo_devedor)} (venc. {p.vencimento ? dt(p.vencimento) : "sem data"})
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="btn"
                  style={{
                    flex: 1,
                    minWidth: 200,
                    padding: "12px 18px",
                    fontSize: 15,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                    background: "#25D366",
                    color: "#fff",
                  }}
                  disabled={!clienteAtual.telefoneFormatado}
                  onClick={() => handleDispararEAvancar(clienteAtual)}
                  title="Abre o WhatsApp Web com o texto pronto e avança automaticamente para o próximo"
                >
                  <span>💬 Enviar no WhatsApp & Próximo</span>
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => handlePular(clienteAtual)}
                  title="Pular este cliente e avançar para o próximo"
                >
                  Pular
                </button>
              </div>
            </div>

            {/* Lado Direito: Pré-visualização da Mensagem */}
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--mut)", textTransform: "uppercase", marginBottom: 6 }}>
                Pré-visualização da Mensagem:
              </div>
              <div
                style={{
                  background: "#EFEAE2",
                  color: "#111b21",
                  borderRadius: 10,
                  padding: "14px 16px",
                  fontSize: 13,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  fontFamily: "system-ui, sans-serif",
                  border: "1px solid #d1d7db",
                  maxHeight: 240,
                  overflowY: "auto",
                }}
              >
                {gerarMensagem(clienteAtual)}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ background: "var(--card)", padding: 24, textAlign: "center", borderRadius: 12, marginBottom: 20 }}>
          {loading ? "Carregando promissórias da base..." : "Nenhum cliente pendente para o filtro selecionado!"}
        </div>
      )}

      {/* Barra de Filtros e Busca na Tabela */}
      <div className="bar" style={{ marginBottom: 12, gap: 10, flexWrap: "wrap" }}>
        <input
          type="search"
          placeholder="Buscar por cliente ou telefone na fila..."
          value={busca}
          onChange={e => setBusca(e.target.value)}
          style={{ flex: 1, minWidth: 220 }}
        />
        <select value={statusFiltro} onChange={e => setStatusFiltro(e.target.value as any)}>
          <option value="todos">Todos os status da fila</option>
          <option value="pendente">⏳ Apenas Pendentes</option>
          <option value="enviado">✅ Apenas Enviados</option>
          <option value="pulado">⏭️ Apenas Pulados</option>
        </select>
      </div>

      {/* Tabela de Todos os Clientes da Fila */}
      <div className="wrap">
        <table style={{ width: "100%" }}>
          <thead>
            <tr>
              <th style={{ width: 40, textAlign: "center" }}>#</th>
              <th>Status</th>
              <th>Cliente</th>
              <th>Telefone</th>
              <th className="n">Saldo a Cobrar</th>
              <th>Vencimento</th>
              <th>Promissórias</th>
              <th style={{ textAlign: "right" }}>Ações Rápidas</th>
            </tr>
          </thead>
          <tbody>
            {filaExibicao.map((item, idx) => {
              const isFoco = clienteAtual?.cliente === item.cliente;
              return (
                <tr
                  key={item.cliente}
                  style={{
                    background: isFoco ? "rgba(21, 128, 61, 0.08)" : undefined,
                    cursor: "pointer",
                  }}
                  onClick={() => setClienteFocoIndex(idx)}
                >
                  <td style={{ textAlign: "center", color: "var(--mut)", fontSize: 12 }}>{idx + 1}</td>
                  <td>
                    {item.statusEnvio === "enviado" ? (
                      <span className="pill p-QUITADO" style={{ fontSize: 11, padding: "2px 8px" }}>✅ Enviado</span>
                    ) : item.statusEnvio === "pulado" ? (
                      <span className="pill" style={{ fontSize: 11, padding: "2px 8px", color: "var(--mut)" }}>⏭️ Pulado</span>
                    ) : (
                      <span className="pill p-PAGANDO" style={{ fontSize: 11, padding: "2px 8px" }}>⏳ Pendente</span>
                    )}
                  </td>
                  <td>
                    <b>{item.cliente}</b>
                  </td>
                  <td>
                    {item.telefoneFormatado ? (
                      <span className="mono">{item.telefoneOriginal}</span>
                    ) : (
                      <span style={{ color: "var(--bad)", fontSize: 12 }}>Sem telefone válido</span>
                    )}
                  </td>
                  <td className="n">
                    <b>{money(item.valorTotal)}</b>
                  </td>
                  <td>
                    <span className="mono">{item.vencimentoMaisUrgente ? dt(item.vencimentoMaisUrgente) : "—"}</span>
                  </td>
                  <td style={{ fontSize: 12, color: "var(--mut)" }}>
                    {item.promissorias.length} promissória{item.promissorias.length !== 1 ? "s" : ""}
                  </td>
                  <td className="acts" onClick={e => e.stopPropagation()}>
                    <button
                      className="btn-baixa"
                      style={{ background: "#25D366", fontSize: 12, padding: "4px 10px" }}
                      disabled={!item.telefoneFormatado}
                      onClick={() => handleDispararEAvancar(item)}
                      title="Abrir WhatsApp Web para este cliente"
                    >
                      Cobrar
                    </button>
                    {item.statusEnvio !== "enviado" && (
                      <button
                        className="ed"
                        style={{ fontSize: 12, padding: "4px 8px" }}
                        onClick={() => {
                          const chave = item.cliente.trim().toUpperCase();
                          setEstadosEnvio(prev => ({ ...prev, [chave]: "enviado" }));
                        }}
                        title="Marcar manualmente como já enviado"
                      >
                        ✓
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {!filaExibicao.length && (
              <tr>
                <td colSpan={8} style={{ textAlign: "center", padding: 30, color: "var(--mut)" }}>
                  {loading ? "Carregando clientes..." : "Nenhum cliente encontrado com os filtros aplicados."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
