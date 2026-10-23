import { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "./supabase";
import {
  obterPromessasPagamento, salvarPromessaPagamento, marcarPromessaCumprida, excluirPromessa,
  formatarMascaraMoeda, desmascararMoeda, money, dt, hoje, somaDias, mascaraTelefone,
  PIX_CHAVE_OFICIAL,
} from "./lib";
import type { PromessaPagamento, CreditScoreInfo } from "./lib";
import { FichaCliente } from "./Dialogs";

export default function PromessasPagamento() {
  const [promessas, setPromessas] = useState<PromessaPagamento[]>([]);
  const [busca, setBusca] = useState("");
  const [filtroStatus, setFiltroStatus] = useState<"todas" | "hoje" | "atrasadas" | "futuras" | "cumpridas">("todas");
  const [modalNovo, setModalNovo] = useState(false);
  const [fichaCliente, setFichaCliente] = useState<{ cliente: string; telefone?: string } | null>(null);

  // Estados do formulário de nova promessa
  const [novoCliente, setNovoCliente] = useState("");
  const [novoTelefone, setNovoTelefone] = useState("");
  const [novaData, setNovaData] = useState(() => somaDias(hoje(), 1));
  const [novoValor, setNovoValor] = useState("");
  const [novaObs, setNovaObs] = useState("");
  const [saldoClienteEncontrado, setSaldoClienteEncontrado] = useState<number | null>(null);

  // Autocomplete inteligente de clientes do banco
  const [sugestoesClientes, setSugestoesClientes] = useState<{ nome: string; telefone: string; saldo: number }[]>([]);
  const [mostrarSugestoes, setMostrarSugestoes] = useState(false);
  const [buscandoSugestoes, setBuscandoSugestoes] = useState(false);

  // Carrega as promessas salvas
  const carregar = useCallback(() => {
    setPromessas(obterPromessasPagamento());
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  const hojeIso = hoje();

  // Autocomplete ao digitar o nome do cliente
  useEffect(() => {
    const termo = novoCliente.trim();
    if (termo.length < 2) {
      setSugestoesClientes([]);
      setMostrarSugestoes(false);
      return;
    }
    let cancelado = false;
    setBuscandoSugestoes(true);
    const timeout = setTimeout(async () => {
      try {
        const { data } = await supabase
          .from("promissorias")
          .select("cliente_nome, telefone, saldo_devedor")
          .ilike("cliente_nome", `%${termo}%`)
          .limit(30);

        if (cancelado || !data) return;

        // Agrupar por cliente para pegar telefone e saldo total aberto
        const map = new Map<string, { nome: string; telefone: string; saldo: number }>();
        for (const r of data) {
          const k = r.cliente_nome.trim().toUpperCase();
          const atual = map.get(k) || { nome: r.cliente_nome.trim(), telefone: r.telefone || "", saldo: 0 };
          atual.saldo += r.saldo_devedor || 0;
          if (!atual.telefone && r.telefone) atual.telefone = r.telefone;
          map.set(k, atual);
        }
        setSugestoesClientes(Array.from(map.values()).slice(0, 6));
        setMostrarSugestoes(true);
      } catch (_) {
      } finally {
        setBuscandoSugestoes(false);
      }
    }, 200);

    return () => {
      cancelado = true;
      clearTimeout(timeout);
    };
  }, [novoCliente]);

  const selecionarClienteSugerido = (c: { nome: string; telefone: string; saldo: number }) => {
    setNovoCliente(c.nome);
    if (c.telefone) setNovoTelefone(mascaraTelefone(c.telefone));
    if (c.saldo > 0) {
      setSaldoClienteEncontrado(c.saldo);
      setNovoValor(formatarMascaraMoeda(c.saldo));
    }
    setMostrarSugestoes(false);
  };

  const handleSalvarNovaPromessa = (e: React.FormEvent) => {
    e.preventDefault();
    if (!novoCliente.trim()) {
      alert("Informe o nome do cliente.");
      return;
    }
    if (!novaData) {
      alert("Informe a data prometida.");
      return;
    }

    const valorCentavos = desmascararMoeda(novoValor);

    salvarPromessaPagamento({
      cliente: novoCliente.trim(),
      telefone: (novoTelefone || "").replace(/\D/g, ""),
      dataPromessa: novaData,
      valor: valorCentavos,
      observacao: novaObs.trim() || undefined,
    });

    carregar();
    setModalNovo(false);
    // Limpar formulário
    setNovoCliente("");
    setNovoTelefone("");
    setNovaData(somaDias(hoje(), 1));
    setNovoValor("");
    setNovaObs("");
    setSaldoClienteEncontrado(null);
  };

  const handleAlternarCumprida = (p: PromessaPagamento) => {
    if (p.cumprida) {
      // Reabrir
      const todas = obterPromessasPagamento();
      const atualizadas = todas.map(item => (item.id === p.id ? { ...item, cumprida: false } : item));
      localStorage.setItem("leooticas_promessas_pagamento", JSON.stringify(atualizadas));
    } else {
      marcarPromessaCumprida(p.id);
    }
    carregar();
  };

  const handleExcluir = (p: PromessaPagamento) => {
    if (confirm(`Deseja realmente excluir a promessa de ${p.cliente} para ${dt(p.dataPromessa)}?`)) {
      excluirPromessa(p.id);
      carregar();
    }
  };

  const handleEnviarWhatsApp = (p: PromessaPagamento) => {
    const telLimpo = (p.telefone || "").replace(/\D/g, "");
    if (!telLimpo || telLimpo.length < 10) {
      alert(`Telefone de ${p.cliente} não cadastrado ou inválido.`);
      return;
    }

    const dataFormatada = dt(p.dataPromessa);
    const valorStr = money(p.valor);

    const texto =
      `Oi, ${p.cliente}! Tudo bem? Aqui é da equipe da *LeoÓticas*. 🙏👓\n\n` +
      `Passando para confirmar o agendamento do pagamento que combinamos para *${dataFormatada}* no valor de *${valorStr}*.\n\n` +
      `Caso queira antecipar ou acertar pelo celular agora, segue nossa chave PIX oficial:\n` +
      `🔑 *Chave PIX (CNPJ):* ${PIX_CHAVE_OFICIAL}\n` +
      `Titular: LeoÓticas\n\n` +
      (p.observacao ? `📝 _Anotação do compromisso: ${p.observacao}_\n\n` : "") +
      `Se precisar de qualquer apoio ou tiver alguma dúvida, estamos à disposição por aqui! Muito obrigado pela parceria e preferência! 💛`;

    const url = `https://api.whatsapp.com/send?phone=55${telLimpo}&text=${encodeURIComponent(texto)}`;
    window.open(url, "_blank");
  };

  // KPIs
  const kpis = useMemo(() => {
    let qtdHoje = 0;
    let valHoje = 0;
    let qtdAtrasada = 0;
    let valAtrasada = 0;
    let qtdFutura = 0;
    let valFutura = 0;
    let qtdCumprida = 0;
    let valCumprida = 0;

    for (const p of promessas) {
      if (p.cumprida) {
        qtdCumprida++;
        valCumprida += p.valor;
      } else if (p.dataPromessa === hojeIso) {
        qtdHoje++;
        valHoje += p.valor;
      } else if (p.dataPromessa < hojeIso) {
        qtdAtrasada++;
        valAtrasada += p.valor;
      } else {
        qtdFutura++;
        valFutura += p.valor;
      }
    }

    return {
      qtdHoje,
      valHoje,
      qtdAtrasada,
      valAtrasada,
      qtdFutura,
      valFutura,
      qtdCumprida,
      valCumprida,
      totalAbertas: qtdHoje + qtdAtrasada + qtdFutura,
      valTotalAbertas: valHoje + valAtrasada + valFutura,
    };
  }, [promessas, hojeIso]);

  // Lista filtrada
  const promessasFiltradas = useMemo(() => {
    return promessas.filter(p => {
      // Filtro de busca
      if (busca.trim()) {
        const t = busca.trim().toLowerCase();
        const matchNome = p.cliente.toLowerCase().includes(t);
        const matchTel = p.telefone.includes(t);
        const matchObs = (p.observacao || "").toLowerCase().includes(t);
        if (!matchNome && !matchTel && !matchObs) return false;
      }

      // Filtro de status
      if (filtroStatus === "hoje") {
        return !p.cumprida && p.dataPromessa === hojeIso;
      }
      if (filtroStatus === "atrasadas") {
        return !p.cumprida && p.dataPromessa < hojeIso;
      }
      if (filtroStatus === "futuras") {
        return !p.cumprida && p.dataPromessa > hojeIso;
      }
      if (filtroStatus === "cumpridas") {
        return p.cumprida;
      }

      return true;
    }).sort((a, b) => {
      // Prioridade: Não cumpridas primeiro, ordenadas por data crescente
      if (a.cumprida !== b.cumprida) return a.cumprida ? 1 : -1;
      return a.dataPromessa.localeCompare(b.dataPromessa);
    });
  }, [promessas, busca, filtroStatus, hojeIso]);

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto", paddingBottom: 40 }}>
      {/* Cabeçalho da Central de Promessas */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: 16,
          marginBottom: 20,
        }}
      >
        <div>
          <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: "0 0 6px 0" }}>
            <span>📅</span> Central de Agendamento de Promessas
          </h1>
          <div className="sub" style={{ fontSize: 13.5 }}>
            Controle de compromissos de pagamento, follow-up com clientes e disparo ágil no WhatsApp.
          </div>
        </div>

        <button
          type="button"
          className="btn"
          onClick={() => setModalNovo(true)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 18px",
            fontSize: 14,
            fontWeight: 700,
            boxShadow: "0 4px 14px rgba(15, 118, 110, 0.25)",
          }}
        >
          <span>➕</span> Agendar Nova Promessa
        </button>
      </div>

      {/* Cards de Resumo (KPIs) */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
          gap: 12,
          marginBottom: 20,
        }}
      >
        {/* Card Hoje */}
        <div
          className="card"
          onClick={() => setFiltroStatus(filtroStatus === "hoje" ? "todas" : "hoje")}
          style={{
            cursor: "pointer",
            borderLeft: "5px solid #eab308",
            background: filtroStatus === "hoje" ? "rgba(234, 179, 8, 0.08)" : "var(--card)",
            transition: "all .15s ease",
          }}
        >
          <small style={{ color: "#ca8a04", fontWeight: 700 }}>📌 Promessas de Hoje</small>
          <b style={{ color: "#a16207" }}>{money(kpis.valHoje)}</b>
          <div style={{ fontSize: 12, color: "var(--mut)", marginTop: 4 }}>
            <b>{kpis.qtdHoje}</b> compromisso{kpis.qtdHoje === 1 ? "" : "s"} para hoje
          </div>
        </div>

        {/* Card Atrasadas */}
        <div
          className="card"
          onClick={() => setFiltroStatus(filtroStatus === "atrasadas" ? "todas" : "atrasadas")}
          style={{
            cursor: "pointer",
            borderLeft: "5px solid var(--bad)",
            background: filtroStatus === "atrasadas" ? "rgba(180, 35, 24, 0.08)" : "var(--card)",
            transition: "all .15s ease",
          }}
        >
          <small style={{ color: "var(--bad)", fontWeight: 700 }}>⚠️ Em Atraso / Pendentes</small>
          <b style={{ color: "var(--bad)" }}>{money(kpis.valAtrasada)}</b>
          <div style={{ fontSize: 12, color: "var(--mut)", marginTop: 4 }}>
            <b>{kpis.qtdAtrasada}</b> promessa{kpis.qtdAtrasada === 1 ? "" : "s"} vencida{kpis.qtdAtrasada === 1 ? "" : "s"}
          </div>
        </div>

        {/* Card Futuras */}
        <div
          className="card"
          onClick={() => setFiltroStatus(filtroStatus === "futuras" ? "todas" : "futuras")}
          style={{
            cursor: "pointer",
            borderLeft: "5px solid #0284c7",
            background: filtroStatus === "futuras" ? "rgba(2, 132, 199, 0.08)" : "var(--card)",
            transition: "all .15s ease",
          }}
        >
          <small style={{ color: "#0284c7", fontWeight: 700 }}>🗓️ Próximas Promessas</small>
          <b style={{ color: "#0369a1" }}>{money(kpis.valFutura)}</b>
          <div style={{ fontSize: 12, color: "var(--mut)", marginTop: 4 }}>
            <b>{kpis.qtdFutura}</b> agendada{kpis.qtdFutura === 1 ? "" : "s"} para frente
          </div>
        </div>

        {/* Card Cumpridas */}
        <div
          className="card"
          onClick={() => setFiltroStatus(filtroStatus === "cumpridas" ? "todas" : "cumpridas")}
          style={{
            cursor: "pointer",
            borderLeft: "5px solid #16a34a",
            background: filtroStatus === "cumpridas" ? "rgba(22, 163, 74, 0.08)" : "var(--card)",
            transition: "all .15s ease",
          }}
        >
          <small style={{ color: "#16a34a", fontWeight: 700 }}>✅ Cumpridas / Honradas</small>
          <b style={{ color: "#15803d" }}>{money(kpis.valCumprida)}</b>
          <div style={{ fontSize: 12, color: "var(--mut)", marginTop: 4 }}>
            <b>{kpis.qtdCumprida}</b> paga{kpis.qtdCumprida === 1 ? "" : "s"} com sucesso
          </div>
        </div>

        {/* Total em Aberto */}
        <div className="card" style={{ borderLeft: "5px solid var(--brand)" }}>
          <small style={{ color: "var(--brand)", fontWeight: 700 }}>💼 Total Prometido Aberto</small>
          <b style={{ color: "var(--brand)" }}>{money(kpis.valTotalAbertas)}</b>
          <div style={{ fontSize: 12, color: "var(--mut)", marginTop: 4 }}>
            <b>{kpis.totalAbertas}</b> compromisso{kpis.totalAbertas === 1 ? "" : "s"} aguardando
          </div>
        </div>
      </div>

      {/* Barra de Busca e Filtros */}
      <div
        className="card"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 12,
          padding: "12px 16px",
          marginBottom: 16,
        }}
      >
        <div style={{ flex: 1, minWidth: 240, position: "relative" }}>
          <input
            type="search"
            value={busca}
            onChange={e => setBusca(e.target.value)}
            placeholder="🔍 Buscar por nome do cliente, telefone ou observação..."
            style={{ width: "100%", padding: "9px 12px" }}
          />
        </div>

        {/* Filtros em Chips */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            type="button"
            className={`chip ${filtroStatus === "todas" ? "on" : ""}`}
            onClick={() => setFiltroStatus("todas")}
          >
            Todas ({promessas.length})
          </button>
          <button
            type="button"
            className={`chip ${filtroStatus === "hoje" ? "on" : ""}`}
            onClick={() => setFiltroStatus("hoje")}
            style={{ borderColor: kpis.qtdHoje > 0 ? "#eab308" : undefined }}
          >
            📌 Hoje ({kpis.qtdHoje})
          </button>
          <button
            type="button"
            className={`chip ${filtroStatus === "atrasadas" ? "on" : ""}`}
            onClick={() => setFiltroStatus("atrasadas")}
            style={{ borderColor: kpis.qtdAtrasada > 0 ? "var(--bad)" : undefined }}
          >
            ⚠️ Atrasadas ({kpis.qtdAtrasada})
          </button>
          <button
            type="button"
            className={`chip ${filtroStatus === "futuras" ? "on" : ""}`}
            onClick={() => setFiltroStatus("futuras")}
          >
            🗓️ Futuras ({kpis.qtdFutura})
          </button>
          <button
            type="button"
            className={`chip ${filtroStatus === "cumpridas" ? "on" : ""}`}
            onClick={() => setFiltroStatus("cumpridas")}
          >
            ✅ Cumpridas ({kpis.qtdCumprida})
          </button>
        </div>
      </div>

      {/* Listagem de Promessas */}
      {promessasFiltradas.length === 0 ? (
        <div className="card" style={{ padding: 48, textAlign: "center", color: "var(--mut)" }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>📅</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "var(--ink)" }}>Nenhuma promessa de pagamento encontrada</div>
          <div className="sub" style={{ marginTop: 4, maxWidth: 440, margin: "4px auto 16px" }}>
            {busca.trim()
              ? "Nenhum resultado corresponde à sua pesquisa."
              : filtroStatus !== "todas"
              ? "Não há compromissos nesta categoria no momento."
              : "Cadastre novas promessas acordadas com seus clientes para receber lembretes e manter o follow-up organizado."}
          </div>
          <button type="button" className="btn" onClick={() => setModalNovo(true)}>
            <span>➕</span> Agendar Primeira Promessa
          </button>
        </div>
      ) : (
        <div className="wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 140 }}>Status</th>
                <th>Cliente & Contato</th>
                <th style={{ width: 130 }}>Data Prometida</th>
                <th className="n" style={{ width: 130 }}>Valor Prometido</th>
                <th>Observação / Compromisso</th>
                <th style={{ width: 110, fontSize: 11 }}>Registrado Em</th>
                <th style={{ width: 190, textAlign: "right" }}>Ações Rápidas</th>
              </tr>
            </thead>
            <tbody>
              {promessasFiltradas.map(p => {
                const ehHoje = !p.cumprida && p.dataPromessa === hojeIso;
                const atrasada = !p.cumprida && p.dataPromessa < hojeIso;
                const futura = !p.cumprida && p.dataPromessa > hojeIso;

                return (
                  <tr
                    key={p.id}
                    style={{
                      opacity: p.cumprida ? 0.65 : 1,
                      background: ehHoje ? "rgba(234, 179, 8, 0.05)" : atrasada ? "rgba(180, 35, 24, 0.03)" : undefined,
                    }}
                  >
                    <td>
                      {p.cumprida ? (
                        <span
                          className="pill"
                          style={{
                            background: "rgba(22, 163, 74, 0.12)",
                            color: "#15803d",
                            borderColor: "#16a34a",
                            fontWeight: 700,
                          }}
                        >
                          ✅ Cumprida
                        </span>
                      ) : ehHoje ? (
                        <span
                          className="pill"
                          style={{
                            background: "rgba(234, 179, 8, 0.15)",
                            color: "#a16207",
                            borderColor: "#eab308",
                            fontWeight: 700,
                          }}
                        >
                          📌 Vence Hoje
                        </span>
                      ) : atrasada ? (
                        <span
                          className="pill"
                          style={{
                            background: "rgba(180, 35, 24, 0.12)",
                            color: "var(--bad)",
                            borderColor: "var(--bad)",
                            fontWeight: 700,
                          }}
                        >
                          ⚠️ Em Atraso
                        </span>
                      ) : (
                        <span
                          className="pill"
                          style={{
                            background: "rgba(2, 132, 199, 0.1)",
                            color: "#0369a1",
                            borderColor: "#0284c7",
                            fontWeight: 600,
                          }}
                        >
                          🗓️ Agendada
                        </span>
                      )}
                    </td>

                    <td>
                      <div style={{ fontWeight: 700, color: "var(--ink)", fontSize: 14 }}>
                        <button
                          type="button"
                          className="link-cli"
                          onClick={() => setFichaCliente({ cliente: p.cliente, telefone: p.telefone })}
                          title="Clique para abrir o histórico completo do cliente"
                        >
                          {p.cliente}
                        </button>
                      </div>
                      <div style={{ fontSize: 12, color: "var(--mut)", marginTop: 2, display: "flex", gap: 6, alignItems: "center" }}>
                        <span>📱 {mascaraTelefone(p.telefone) || "Sem telefone"}</span>
                      </div>
                    </td>

                    <td>
                      <div className="mono" style={{ fontWeight: 700, fontSize: 13.5 }}>
                        {dt(p.dataPromessa)}
                      </div>
                      <div style={{ fontSize: 11, color: ehHoje ? "#a16207" : atrasada ? "var(--bad)" : "var(--mut)", marginTop: 1, fontWeight: ehHoje || atrasada ? 600 : 400 }}>
                        {ehHoje
                          ? "Hoje!"
                          : atrasada
                          ? "Vencida"
                          : `Em ${Math.ceil((new Date(p.dataPromessa).getTime() - new Date(hojeIso).getTime()) / (1000 * 3600 * 24))} dias`}
                      </div>
                    </td>

                    <td className="n">
                      <b style={{ color: p.cumprida ? "var(--mut)" : "var(--ink)", fontSize: 14 }}>
                        {money(p.valor)}
                      </b>
                    </td>

                    <td>
                      {p.observacao ? (
                        <div style={{ fontSize: 12.5, color: "var(--ink)", maxWidth: 320, wordBreak: "break-word" }}>
                          {p.observacao}
                        </div>
                      ) : (
                        <span style={{ fontSize: 12, color: "var(--mut)", fontStyle: "italic" }}>
                          Sem observação
                        </span>
                      )}
                    </td>

                    <td>
                      <span className="mono" style={{ fontSize: 11, color: "var(--mut)" }}>
                        {dt(p.criadaEm.slice(0, 10))}
                      </span>
                    </td>

                    <td style={{ textAlign: "right" }}>
                      <div className="acts">
                        {/* Botão WhatsApp */}
                        <button
                          type="button"
                          className="btn ghost"
                          onClick={() => handleEnviarWhatsApp(p)}
                          style={{
                            padding: "5px 9px",
                            fontSize: 12,
                            color: "#16a34a",
                            borderColor: "#86efac",
                            background: "rgba(22, 163, 74, 0.06)",
                          }}
                          title="Enviar lembrete amigável no WhatsApp com chave PIX"
                        >
                          💬 WhatsApp
                        </button>

                        {/* Botão Marcar Cumprida / Reabrir */}
                        <button
                          type="button"
                          className="btn ghost"
                          onClick={() => handleAlternarCumprida(p)}
                          style={{
                            padding: "5px 9px",
                            fontSize: 12,
                            color: p.cumprida ? "var(--mut)" : "#0f766e",
                          }}
                          title={p.cumprida ? "Reabrir promessa" : "Marcar promessa como cumprida"}
                        >
                          {p.cumprida ? "↺ Reabrir" : "✓ Cumprida"}
                        </button>

                        {/* Botão Excluir */}
                        <button
                          type="button"
                          className="btn ghost"
                          onClick={() => handleExcluir(p)}
                          style={{
                            padding: "5px 8px",
                            fontSize: 12,
                            color: "var(--bad)",
                            borderColor: "transparent",
                          }}
                          title="Excluir agendamento"
                        >
                          🗑️
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal Agendar Nova Promessa */}
      {modalNovo && (
        <div className="ov" onClick={() => setModalNovo(false)}>
          <div
            className="panel"
            onClick={e => e.stopPropagation()}
            style={{
              width: "min(500px, 95vw)",
              height: "auto",
              maxHeight: "92vh",
              overflowY: "auto",
              margin: "auto",
              borderRadius: 16,
              padding: 24,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
              <div>
                <h2 style={{ margin: "0 0 4px", fontSize: 19, display: "flex", alignItems: "center", gap: 8 }}>
                  <span>📅</span> Agendar Promessa de Pagamento
                </h2>
                <div className="sub" style={{ fontSize: 12.5 }}>
                  Cadastre o compromisso assumido pelo cliente para acompanhamento e lembretes.
                </div>
              </div>
              <button
                type="button"
                className="btn ghost"
                onClick={() => setModalNovo(false)}
                style={{ padding: "4px 8px", fontSize: 12 }}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSalvarNovaPromessa} style={{ display: "grid", gap: 14, padding: 0 }}>
              {/* Campo Cliente com Autocomplete */}
              <div style={{ position: "relative" }}>
                <label>
                  Nome do Cliente:
                  <input
                    type="text"
                    value={novoCliente}
                    onChange={e => setNovoCliente(e.target.value)}
                    placeholder="Digite o nome do cliente..."
                    required
                    autoFocus
                  />
                </label>

                {/* Dropdown de sugestões */}
                {mostrarSugestoes && sugestoesClientes.length > 0 && (
                  <div
                    style={{
                      position: "absolute",
                      top: "100%",
                      left: 0,
                      right: 0,
                      background: "var(--card)",
                      border: "1px solid var(--line)",
                      borderRadius: 10,
                      boxShadow: "0 8px 24px rgba(0,0,0,0.14)",
                      zIndex: 30,
                      maxHeight: 220,
                      overflowY: "auto",
                      marginTop: 4,
                    }}
                  >
                    {sugestoesClientes.map((sug, idx) => (
                      <div
                        key={idx}
                        onClick={() => selecionarClienteSugerido(sug)}
                        style={{
                          padding: "9px 12px",
                          borderBottom: idx < sugestoesClientes.length - 1 ? "1px solid var(--line)" : "none",
                          cursor: "pointer",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          fontSize: 13,
                        }}
                        onMouseEnter={e => (e.currentTarget.style.background = "var(--soft)")}
                        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                      >
                        <div>
                          <div style={{ fontWeight: 600, color: "var(--ink)" }}>{sug.nome}</div>
                          <div style={{ fontSize: 11, color: "var(--mut)" }}>
                            {sug.telefone ? mascaraTelefone(sug.telefone) : "Sem telefone"}
                          </div>
                        </div>
                        {sug.saldo > 0 && (
                          <div style={{ textAlign: "right", fontSize: 12, color: "var(--brand)", fontWeight: 700 }}>
                            {money(sug.saldo)}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {saldoClienteEncontrado && saldoClienteEncontrado > 0 && (
                <div
                  style={{
                    background: "rgba(15, 118, 110, 0.08)",
                    border: "1px solid var(--brand)",
                    borderRadius: 8,
                    padding: "8px 12px",
                    fontSize: 12,
                    color: "var(--brand)",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <span>Saldo devedor total em aberto:</span>
                  <b>{money(saldoClienteEncontrado)}</b>
                </div>
              )}

              {/* Campo Telefone */}
              <label>
                Telefone / WhatsApp:
                <input
                  type="tel"
                  value={novoTelefone}
                  onChange={e => setNovoTelefone(mascaraTelefone(e.target.value))}
                  placeholder="(61) 99999-9999"
                />
              </label>

              {/* Campo Data da Promessa com atalhos */}
              <div>
                <label>
                  Data Prometida para o Pagamento:
                  <input
                    type="date"
                    value={novaData}
                    onChange={e => setNovaData(e.target.value)}
                    required
                  />
                </label>

                {/* Atalhos rápidos de data */}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                  <button
                    type="button"
                    className="chip"
                    onClick={() => setNovaData(hoje())}
                    style={{ fontSize: 11.5, padding: "4px 8px" }}
                  >
                    Hoje
                  </button>
                  <button
                    type="button"
                    className="chip"
                    onClick={() => setNovaData(somaDias(hoje(), 1))}
                    style={{ fontSize: 11.5, padding: "4px 8px" }}
                  >
                    Amanhã
                  </button>
                  <button
                    type="button"
                    className="chip"
                    onClick={() => setNovaData(somaDias(hoje(), 3))}
                    style={{ fontSize: 11.5, padding: "4px 8px" }}
                  >
                    +3 dias
                  </button>
                  <button
                    type="button"
                    className="chip"
                    onClick={() => setNovaData(somaDias(hoje(), 7))}
                    style={{ fontSize: 11.5, padding: "4px 8px" }}
                  >
                    +7 dias
                  </button>
                  <button
                    type="button"
                    className="chip"
                    onClick={() => setNovaData(somaDias(hoje(), 15))}
                    style={{ fontSize: 11.5, padding: "4px 8px" }}
                  >
                    +15 dias
                  </button>
                </div>
              </div>

              {/* Campo Valor com Máscara BRL */}
              <label>
                Valor Prometido:
                <input
                  type="text"
                  value={novoValor}
                  onChange={e => setNovoValor(formatarMascaraMoeda(e.target.value, true))}
                  inputMode="numeric"
                  placeholder="R$ 0,00"
                />
              </label>

              {/* Observação */}
              <label>
                Observação / Detalhes do Compromisso:
                <textarea
                  value={novaObs}
                  onChange={e => setNovaObs(e.target.value)}
                  placeholder="Ex: Prometeu transferir no PIX após as 14h; recebe vale da empresa dia 20..."
                  rows={3}
                />
              </label>

              {/* Botões do formulário */}
              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <button
                  type="submit"
                  className="btn"
                  style={{ flex: 1, padding: "12px", fontSize: 14, fontWeight: 700 }}
                >
                  Salvar Promessa de Pagamento
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setModalNovo(false)}
                  style={{ padding: "12px 16px" }}
                >
                  Cancelar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Ficha do Cliente */}
      {fichaCliente && (
        <FichaCliente
          cliente={fichaCliente.cliente}
          telefone={fichaCliente.telefone}
          onClose={() => setFichaCliente(null)}
        />
      )}
    </div>
  );
}
