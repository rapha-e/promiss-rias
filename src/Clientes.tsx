import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";
import { dt, mensagemCobranca, money, normalizarTelefones, identificarCompraAtual } from "./lib";
import type { Row } from "./lib";
import { Editor, Painel, PerdidoDialog, StatusPill, VencCell, WhatsDialog, BaixaDialog, LogDialog } from "./Dialogs";
import { SortIcon } from "./SortIcon";

type Cli = {
  cliente: string; telefone: string; qtd: number; divida: number; pago: number; saldo: number;
  perdido: number; vencido: number; proximo_venc: string | null; total_clientes: number;
};
const PS = 30;

function Ficha({ c, isAdmin, onClose, onChanged }: { c: Cli; isAdmin: boolean; onClose: () => void; onChanged: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState("");
  const [baixa, setBaixa] = useState<Row | null>(null);
  const [logRow, setLogRow] = useState<Row | null>(null);
  const [editing, setEditing] = useState<Row | undefined>(undefined);
  const [perdido, setPerdido] = useState<Row | null>(null);
  const [whats, setWhats] = useState(false);
  const [sortCol, setSortCol] = useState<string>("vencimento");
  const [sortAsc, setSortAsc] = useState<boolean>(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("cliente_promissorias", { p_cliente: c.cliente });
    if (error) setErr(error.message); else setRows((data ?? []) as Row[]);
  }, [c.cliente]);
  useEffect(() => { load(); }, [load]);
  const abertos = rows.filter(r => !r.fundo_perdido && r.saldo_devedor > 0);
  const compraInfo = useMemo(() => identificarCompraAtual(rows), [rows]);
  const [filtroAba, setFiltroAba] = useState<"compra_atual" | "quitadas" | "todas">("compra_atual");

  const rowsFiltradas = useMemo(() => {
    if (filtroAba === "compra_atual") {
      return compraInfo.promissoriasCompra.length > 0 ? compraInfo.promissoriasCompra : rows;
    }
    if (filtroAba === "quitadas") {
      return compraInfo.promissoriasOutras.length > 0 ? compraInfo.promissoriasOutras : [];
    }
    return rows;
  }, [filtroAba, compraInfo, rows]);

  const refresh = () => { load(); onChanged(); };

  const sortedRows = useMemo(() => {
    return [...rowsFiltradas].sort((a, b) => {
      let va: any = a[sortCol as keyof Row];
      let vb: any = b[sortCol as keyof Row];
      if (sortCol === "status") {
        va = a.fundo_perdido ? "FUNDO PERDIDO" : a.status;
        vb = b.fundo_perdido ? "FUNDO PERDIDO" : b.status;
      }
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string") {
        const cmp = va.localeCompare(vb, "pt-BR", { sensitivity: "base" });
        return sortAsc ? cmp : -cmp;
      }
      return sortAsc ? va - vb : vb - va;
    });
  }, [rowsFiltradas, sortCol, sortAsc]);

  const handleSort = (col: string) => {
    if (sortCol === col) {
      setSortAsc(a => !a);
    } else {
      setSortCol(col);
      if (col === "divida_total" || col === "valor_pago" || col === "saldo_devedor") {
        setSortAsc(false);
      } else {
        setSortAsc(true);
      }
    }
  };

  return (
    <Painel onClose={onClose} wide>
      <div style={{ padding: 20, display: "grid", gap: 14 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "start", flexWrap: "wrap" }}>
          <div style={{ flex: 1 }}><h2 style={{ margin: 0 }}>{c.cliente}</h2><div className="sub mono">{c.telefone || "Sem telefone"}</div></div>
          {abertos.length > 0 && <button className="btn" onClick={() => setWhats(true)}>Cobrar por WhatsApp</button>}
          <button className="btn ghost" onClick={onClose}>Fechar</button>
        </div>
        {err && <div className="err">{err}</div>}
        <div className="kpis" style={{ margin: 0 }}>
          <div className="card hl">
            <small>SALDO A RECEBER</small>
            <b>{money(compraInfo.saldoReceberVendaAtual)}</b>
          </div>
          <div className="card">
            <small>TOTAL DA VENDA ATUAL</small>
            <b>{money(compraInfo.totalVendaAtual)}</b>
          </div>
          <div className="card">
            <small>VALOR PAGO (VENDA ATUAL)</small>
            <b>{money(compraInfo.valorPagoVendaAtual)}</b>
          </div>
          <div className="card">
            <small>PARCELAS DA VENDA ATUAL</small>
            <b>{compraInfo.totalParcelasCompra}</b>
            {compraInfo.totalOutrasQuitadas > 0 ? (
              <span className="ksub" style={{ color: "var(--brand)", fontWeight: 600 }}>
                ✓ {money(compraInfo.totalOutrasQuitadas)} quitados em compras anteriores
              </span>
            ) : compraInfo.parcelasPagasCompra > 0 ? (
              <span className="ksub" style={{ color: "var(--brand)", fontWeight: 600 }}>
                ✓ {compraInfo.parcelasPagasCompra} pagas · {compraInfo.parcelasAbertasCompra} em aberto
              </span>
            ) : null}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 2, marginBottom: -4 }}>
          <button
            type="button"
            onClick={() => setFiltroAba("compra_atual")}
            style={{
              padding: "6px 14px",
              borderRadius: 99,
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
              border: filtroAba === "compra_atual" ? "1.5px solid var(--brand)" : "1px solid var(--line)",
              background: filtroAba === "compra_atual" ? "var(--brand)" : "var(--panel)",
              color: filtroAba === "compra_atual" ? "#fff" : "var(--ink)",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              transition: "all 0.15s ease",
            }}
          >
            <span>🟢</span> Venda Atual / Em Aberto ({compraInfo.parcelasAbertasCompra} {compraInfo.parcelasAbertasCompra === 1 ? "parcela" : "parcelas"})
          </button>
          {compraInfo.qtdOutrasQuitadas > 0 && (
            <button
              type="button"
              onClick={() => setFiltroAba("quitadas")}
              style={{
                padding: "6px 14px",
                borderRadius: 99,
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
                border: filtroAba === "quitadas" ? "1.5px solid var(--brand)" : "1px solid var(--line)",
                background: filtroAba === "quitadas" ? "var(--brand)" : "var(--panel)",
                color: filtroAba === "quitadas" ? "#fff" : "var(--ink)",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                transition: "all 0.15s ease",
              }}
            >
              <span>✓</span> Vendas Já Quitadas ({compraInfo.qtdOutrasQuitadas})
            </button>
          )}
          <button
            type="button"
            onClick={() => setFiltroAba("todas")}
            style={{
              padding: "6px 14px",
              borderRadius: 99,
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
              border: filtroAba === "todas" ? "1.5px solid var(--brand)" : "1px solid var(--line)",
              background: filtroAba === "todas" ? "var(--brand)" : "var(--panel)",
              color: filtroAba === "todas" ? "#fff" : "var(--ink)",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              transition: "all 0.15s ease",
            }}
          >
            Todas as Promissórias ({rows.length})
          </button>
        </div>
        <div className="wrap">
          <table style={{ width: "100%" }}>
            <thead>
              <tr>
                <th className={`sortable ${sortCol === "vencimento" ? "active" : ""}`} onClick={() => handleSort("vencimento")} title="Clique para ordenar por Vencimento">
                  <span className="th-content">Vencimento <SortIcon col="vencimento" sortCol={sortCol} sortAsc={sortAsc} /></span>
                </th>
                <th className={`sortable ${sortCol === "parcelas" ? "active" : ""}`} onClick={() => handleSort("parcelas")} title="Clique para ordenar por Parcelas">
                  <span className="th-content">Parcelas <SortIcon col="parcelas" sortCol={sortCol} sortAsc={sortAsc} /></span>
                </th>
                <th className={`sortable n ${sortCol === "divida_total" ? "active" : ""}`} onClick={() => handleSort("divida_total")} title="Clique para ordenar por Dívida">
                  <span className="th-content">Dívida <SortIcon col="divida_total" sortCol={sortCol} sortAsc={sortAsc} /></span>
                </th>
                <th className={`sortable n ${sortCol === "valor_pago" ? "active" : ""}`} onClick={() => handleSort("valor_pago")} title="Clique para ordenar por Valor Pago">
                  <span className="th-content">Pago <SortIcon col="valor_pago" sortCol={sortCol} sortAsc={sortAsc} /></span>
                </th>
                <th className={`sortable n ${sortCol === "saldo_devedor" ? "active" : ""}`} onClick={() => handleSort("saldo_devedor")} title="Clique para ordenar por Saldo Devedor">
                  <span className="th-content">Saldo <SortIcon col="saldo_devedor" sortCol={sortCol} sortAsc={sortAsc} /></span>
                </th>
                <th className={`sortable ${sortCol === "status" ? "active" : ""}`} onClick={() => handleSort("status")} title="Clique para ordenar por Status">
                  <span className="th-content">Status <SortIcon col="status" sortCol={sortCol} sortAsc={sortAsc} /></span>
                </th>
                <th style={{ textAlign: "right" }}>Ações</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map(r => (
                <tr key={r.id}>
                  <td><VencCell r={r} /></td>
                  <td className="mono">{r.parcelas || "—"}</td>
                  <td className="n">{money(r.divida_total)}</td>
                  <td className="n">{money(r.valor_pago)}</td>
                  <td className="n"><b>{money(r.saldo_devedor)}</b></td>
                  <td><StatusPill r={r} />{r.fundo_perdido && <div className="sub">{r.fundo_perdido_motivo}{r.fundo_perdido_em ? ` · ${dt(r.fundo_perdido_em.slice(0, 10))}` : ""}</div>}</td>
                  <td className="acts">
                    {isAdmin && !r.fundo_perdido && r.saldo_devedor > 0 && (
                      <button className="btn-baixa" onClick={() => setBaixa(r)} title="Registrar baixa / pagamento">
                        Baixar
                      </button>
                    )}
                    {r.valor_pago > 0 && (
                      <button className="ed" onClick={() => setLogRow(r)} title="Ver histórico e auditoria de pagamento">
                        Log
                      </button>
                    )}
                    {isAdmin && <button className="ed" onClick={() => setEditing(r)} title="Editar promissória">Editar</button>}
                    {isAdmin && (r.fundo_perdido || r.saldo_devedor > 0) && (
                      <button className="ed" onClick={() => setPerdido(r)} title={r.fundo_perdido ? "Desfazer fundo perdido" : "Marcar como fundo perdido"}>
                        {r.fundo_perdido ? "Desfazer" : "Fundo perdido"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {baixa && <BaixaDialog row={baixa} onClose={() => setBaixa(null)} onSaved={() => { setBaixa(null); refresh(); }} />}
      {logRow && <LogDialog row={logRow} onClose={() => setLogRow(null)} />}
      {editing && <Editor row={editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); refresh(); }} />}
      {perdido && <PerdidoDialog row={perdido} onClose={() => setPerdido(null)} onDone={() => { setPerdido(null); refresh(); }} />}
      {whats && <WhatsDialog nome={c.cliente} telefone={c.telefone} mensagem={mensagemCobranca(c.cliente, abertos.map(r => ({ valor: r.saldo_devedor, vencimento: r.vencimento })))} onClose={() => setWhats(false)} />}
    </Painel>
  );
}

export default function Clientes({ isAdmin }: { isAdmin: boolean }) {
  const [list, setList] = useState<Cli[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [qd, setQd] = useState("");
  const [abertos, setAbertos] = useState(false);
  const [sortCol, setSortCol] = useState<string>("saldo");
  const [sortAsc, setSortAsc] = useState<boolean>(false);
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState<Cli | null>(null);
  const [whats, setWhats] = useState<Cli | null>(null);
  const [error, setError] = useState("");
  const [sugestoesBusca, setSugestoesBusca] = useState<string[]>([]);

  useEffect(() => {
    const h = setTimeout(() => { setQd(q); setPage(0); }, 300);
    return () => clearTimeout(h);
  }, [q]);

  // Auto preenchimento ao digitar na barra de busca de clientes
  useEffect(() => {
    const val = q.trim();
    if (val.length < 2) {
      setSugestoesBusca([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const { data } = await supabase
          .from("promissorias")
          .select("cliente_nome")
          .ilike("cliente_nome", `%${val}%`)
          .limit(12);
        if (data) {
          const unicos = Array.from(new Set(data.map(d => d.cliente_nome.trim()))).slice(0, 8);
          setSugestoesBusca(unicos);
        }
      } catch {}
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("clientes_resumo", { p_busca: qd.trim(), p_somente_abertos: abertos, p_limit: PS, p_offset: page * PS });
    if (error) { setError(error.message); return; }
    const l = (data ?? []) as Cli[];
    setError(""); setList(l); setTotal(l[0]?.total_clientes ?? 0);
  }, [qd, abertos, page]);
  useEffect(() => { load(); }, [load]);

  const sortedList = useMemo(() => {
    return [...list].sort((a, b) => {
      let va: any = a[sortCol as keyof Cli];
      let vb: any = b[sortCol as keyof Cli];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string") {
        const cmp = va.localeCompare(vb, "pt-BR", { sensitivity: "base" });
        return sortAsc ? cmp : -cmp;
      }
      return sortAsc ? va - vb : vb - va;
    });
  }, [list, sortCol, sortAsc]);

  const handleSort = (col: string) => {
    if (sortCol === col) {
      setSortAsc(a => !a);
    } else {
      setSortCol(col);
      if (col === "divida" || col === "pago" || col === "saldo" || col === "vencido" || col === "qtd") {
        setSortAsc(false);
      } else {
        setSortAsc(true);
      }
    }
  };

  const pages = Math.max(1, Math.ceil(total / PS));
  return (
    <>
      <div className="head2 noprint">
        <div><h1>Clientes</h1><div className="sub">Promissórias agrupadas por cliente; quem tem saldo em aberto aparece primeiro.</div></div>
      </div>
      {error && <div className="warn">Erro: {error}</div>}
      <div className="bar">
        <input
          type="search"
          placeholder="Buscar cliente ou telefone"
          value={q}
          onChange={e => setQ(e.target.value)}
          list="lista-clientes-busca-tab"
          autoComplete="off"
        />
        <datalist id="lista-clientes-busca-tab">
          {sugestoesBusca.map((s, idx) => (
            <option key={idx} value={s} />
          ))}
        </datalist>
        <button className={`chip ${abertos ? "on" : ""}`} onClick={() => { setAbertos(!abertos); setPage(0); }}>Somente com saldo em aberto</button>
      </div>
      <div className="wrap">
        <table>
          <thead>
            <tr>
              <th className={`sortable ${sortCol === "cliente" ? "active" : ""}`} onClick={() => handleSort("cliente")} title="Clique para ordenar por Cliente">
                <span className="th-content">Cliente <SortIcon col="cliente" sortCol={sortCol} sortAsc={sortAsc} /></span>
              </th>
              <th className={`sortable ${sortCol === "telefone" ? "active" : ""}`} onClick={() => handleSort("telefone")} title="Clique para ordenar por Telefone">
                <span className="th-content">Telefone <SortIcon col="telefone" sortCol={sortCol} sortAsc={sortAsc} /></span>
              </th>
              <th className={`sortable n ${sortCol === "qtd" ? "active" : ""}`} onClick={() => handleSort("qtd")} title="Clique para ordenar por Promissórias">
                <span className="th-content">Promissórias <SortIcon col="qtd" sortCol={sortCol} sortAsc={sortAsc} /></span>
              </th>
              <th className={`sortable n ${sortCol === "divida" ? "active" : ""}`} onClick={() => handleSort("divida")} title="Clique para ordenar por Total Devido">
                <span className="th-content">Total devido <SortIcon col="divida" sortCol={sortCol} sortAsc={sortAsc} /></span>
              </th>
              <th className={`sortable n ${sortCol === "pago" ? "active" : ""}`} onClick={() => handleSort("pago")} title="Clique para ordenar por Total Pago">
                <span className="th-content">Total pago <SortIcon col="pago" sortCol={sortCol} sortAsc={sortAsc} /></span>
              </th>
              <th className={`sortable n ${sortCol === "saldo" ? "active" : ""}`} onClick={() => handleSort("saldo")} title="Clique para ordenar por Saldo">
                <span className="th-content">Saldo <SortIcon col="saldo" sortCol={sortCol} sortAsc={sortAsc} /></span>
              </th>
              <th className={`sortable n ${sortCol === "vencido" ? "active" : ""}`} onClick={() => handleSort("vencido")} title="Clique para ordenar por Valor Vencido">
                <span className="th-content">Vencido <SortIcon col="vencido" sortCol={sortCol} sortAsc={sortAsc} /></span>
              </th>
              <th className={`sortable ${sortCol === "proximo_venc" ? "active" : ""}`} onClick={() => handleSort("proximo_venc")} title="Clique para ordenar por Próximo Vencimento">
                <span className="th-content">Próx. vencimento <SortIcon col="proximo_venc" sortCol={sortCol} sortAsc={sortAsc} /></span>
              </th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sortedList.map(c => (
              <tr key={c.cliente}>
                <td className={c.vencido > 0 ? "s-NÃO" : c.saldo > 0 ? "s-PAGANDO" : "s-QUITADO"}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="link-cli"
                      title={`Ver todas as promissórias de ${c.cliente}`}
                      onClick={() => setSel(c)}
                    >
                      {c.cliente}
                    </button>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        padding: "1px 6px",
                        borderRadius: 99,
                        background: c.vencido > 0 ? "rgba(180, 35, 24, 0.12)" : c.saldo > 0 ? "rgba(217, 119, 6, 0.12)" : "rgba(10, 124, 76, 0.12)",
                        color: c.vencido > 0 ? "var(--bad)" : c.saldo > 0 ? "var(--warn)" : "var(--brand)",
                      }}
                    >
                      {c.vencido > 0 ? "🔴 Risco Alto" : c.saldo > 0 ? "🟡 Regular" : "🟢 Diamante"}
                    </span>
                  </div>
                </td>
                <td className="mono">{c.telefone || "—"}</td>
                <td className="n">{c.qtd}</td>
                <td className="n">{money(c.divida)}</td>
                <td className="n">{money(c.pago)}</td>
                <td className="n"><b>{money(c.saldo)}</b></td>
                <td className="n" style={{ color: c.vencido > 0 ? "var(--bad)" : undefined }}>{c.vencido > 0 ? money(c.vencido) : "—"}</td>
                <td className="mono">{c.proximo_venc ? dt(c.proximo_venc) : "—"}</td>
                <td className="acts">
                  <button className="ed" onClick={() => setSel(c)}>Ficha</button>
                  {c.saldo > 0 && normalizarTelefones(c.telefone).length > 0 && <button className="ed" onClick={() => setWhats(c)}>WhatsApp</button>}
                </td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={9} style={{ textAlign: "center", color: "var(--mut)", padding: 30 }}>Nenhum cliente encontrado.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="pager">
        <span>{total.toLocaleString("pt-BR")} clientes · página {page + 1} de {pages}</span>
        <button className="btn ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>←</button>
        <button className="btn ghost" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>→</button>
      </div>
      {sel && <Ficha c={sel} isAdmin={isAdmin} onClose={() => setSel(null)} onChanged={load} />}
      {whats && <CobrancaCliente c={whats} onClose={() => setWhats(null)} />}
    </>
  );
}

/** Carrega as promissórias abertas do cliente para montar a mensagem completa. */
function CobrancaCliente({ c, onClose }: { c: Cli; onClose: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    supabase.rpc("cliente_promissorias", { p_cliente: c.cliente }).then(({ data }) => {
      const itens = ((data ?? []) as Row[]).filter(r => !r.fundo_perdido && r.saldo_devedor > 0).map(r => ({ valor: r.saldo_devedor, vencimento: r.vencimento }));
      setMsg(mensagemCobranca(c.cliente, itens));
    });
  }, [c.cliente]);
  if (msg === null) return null;
  return <WhatsDialog nome={c.cliente} telefone={c.telefone} mensagem={msg} onClose={onClose} />;
}
