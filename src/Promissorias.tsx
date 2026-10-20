import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";
import { LBL, cls, deriveStatus, hoje, mensagemCobranca, money, somaDias } from "./lib";
import type { Row, Status } from "./lib";
import { Editor, FichaCliente, PerdidoDialog, StatusPill, VencCell, WhatsDialog, BaixaDialog, LogDialog } from "./Dialogs";

type Resumo = {
  total: number; divida: number; pago: number; saldo: number; perdido: number; status: Record<Status, number>;
  vencidas_qtd: number; vencidas_valor: number; proximas_qtd: number; proximas_valor: number;
  d1_qtd?: number; d1_valor?: number; d7_qtd?: number; d7_valor?: number; d30_qtd?: number; d30_valor?: number;
  anos: number[];
};
const PS = 50;

import { SortIcon } from "./SortIcon";

type VencFiltro = "" | "vencidas" | "d1" | "d7" | "d30";

export default function Promissorias({ isAdmin }: { isAdmin: boolean }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [count, setCount] = useState(0);
  const [resumo, setResumo] = useState<Resumo | null>(null);
  const [q, setQ] = useState("");
  const [qd, setQd] = useState("");
  const [status, setStatus] = useState("");
  const [venc, setVenc] = useState<VencFiltro>("");
  const [year, setYear] = useState("");
  const [sortCol, setSortCol] = useState("vencimento");
  const [sortAsc, setSortAsc] = useState(false);
  const [page, setPage] = useState(0);
  const [baixa, setBaixa] = useState<Row | null>(null);
  const [logRow, setLogRow] = useState<Row | null>(null);
  const [editing, setEditing] = useState<Row | null | undefined>(undefined);
  const [perdido, setPerdido] = useState<Row | null>(null);
  const [whats, setWhats] = useState<Row | null>(null);
  const [fichaCliente, setFichaCliente] = useState<{ cliente: string; telefone?: string } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const h = setTimeout(() => { setQd(q); setPage(0); }, 300);
    return () => clearTimeout(h);
  }, [q]);

  const loadResumo = useCallback(async () => {
    const { data, error } = await supabase.rpc("promissorias_resumo");
    if (error) { setError(error.message); return; }
    const res = { ...(data as Resumo) };
    const h = hoje();
    if (res.d1_qtd === undefined) {
      const [q1, q7, q30, qAVencer, qNaoPagou] = await Promise.all([
        supabase.from("promissorias").select("saldo_devedor").eq("fundo_perdido", false).gt("saldo_devedor", 0).gte("vencimento", h).lte("vencimento", somaDias(h, 1)),
        supabase.from("promissorias").select("saldo_devedor").eq("fundo_perdido", false).gt("saldo_devedor", 0).gte("vencimento", h).lte("vencimento", somaDias(h, 7)),
        supabase.from("promissorias").select("saldo_devedor").eq("fundo_perdido", false).gt("saldo_devedor", 0).gte("vencimento", h).lte("vencimento", somaDias(h, 30)),
        supabase.from("promissorias").select("id", { count: "exact", head: true }).eq("fundo_perdido", false).eq("valor_pago", 0).or(`vencimento.gte.${h},vencimento.is.null`),
        supabase.from("promissorias").select("id", { count: "exact", head: true }).eq("fundo_perdido", false).eq("valor_pago", 0).lt("vencimento", h),
      ]);
      const d1List = q1.data ?? [];
      const d7List = q7.data ?? [];
      const d30List = q30.data ?? [];
      res.d1_qtd = d1List.length;
      res.d1_valor = d1List.reduce((s, r) => s + (r.saldo_devedor ?? 0), 0);
      res.d7_qtd = d7List.length;
      res.d7_valor = d7List.reduce((s, r) => s + (r.saldo_devedor ?? 0), 0);
      res.d30_qtd = d30List.length;
      res.d30_valor = d30List.reduce((s, r) => s + (r.saldo_devedor ?? 0), 0);
      if (res.status) {
        res.status["A VENCER"] = qAVencer.count ?? 0;
        res.status["NÃO PAGOU"] = qNaoPagou.count ?? 0;
      }
    }
    setResumo(res);
  }, []);

  const loadRows = useCallback(async () => {
    let query = supabase.from("promissorias").select("*", { count: "exact" });
    const s = qd.replace(/[%,()*]/g, " ").trim();
    if (s) query = query.or(`cliente_nome.ilike.%${s}%,telefone.ilike.%${s}%`);
    const h = hoje();
    if (status === "ABERTO") query = query.eq("fundo_perdido", false).gt("saldo_devedor", 0);
    else if (status === "QUITADO") query = query.eq("fundo_perdido", false).lte("saldo_devedor", 0);
    else if (status === "PAGANDO") query = query.eq("fundo_perdido", false).gt("valor_pago", 0).gt("saldo_devedor", 0);
    else if (status === "A VENCER") query = query.eq("fundo_perdido", false).eq("valor_pago", 0).or(`vencimento.gte.${h},vencimento.is.null`);
    else if (status === "NÃO PAGOU") query = query.eq("fundo_perdido", false).eq("valor_pago", 0).lt("vencimento", h);
    else if (status === "FUNDO PERDIDO") query = query.eq("fundo_perdido", true);

    if (year) query = query.eq("ano", Number(year));

    if (venc === "vencidas") query = query.eq("fundo_perdido", false).gt("saldo_devedor", 0).lt("vencimento", h);
    else if (venc === "d1") query = query.eq("fundo_perdido", false).gt("saldo_devedor", 0).gte("vencimento", h).lte("vencimento", somaDias(h, 1));
    else if (venc === "d7") query = query.eq("fundo_perdido", false).gt("saldo_devedor", 0).gte("vencimento", h).lte("vencimento", somaDias(h, 7));
    else if (venc === "d30") query = query.eq("fundo_perdido", false).gt("saldo_devedor", 0).gte("vencimento", h).lte("vencimento", somaDias(h, 30));

    if (sortCol === "status") {
      query = query.order("fundo_perdido", { ascending: sortAsc }).order("status", { ascending: sortAsc });
    } else if (sortCol === "vencimento") {
      query = query.order("vencimento", { ascending: sortAsc, nullsFirst: false });
    } else {
      query = query.order(sortCol, { ascending: sortAsc });
    }
    const { data, count: c, error } = await query.order("id").range(page * PS, page * PS + PS - 1);
    if (error) { setError(error.message); return; }
    setError(""); setRows((data ?? []) as Row[]); setCount(c ?? 0);
  }, [qd, status, year, sortCol, sortAsc, page, venc]);

  useEffect(() => { loadResumo(); }, [loadResumo]);
  useEffect(() => { loadRows(); }, [loadRows]);
  const refresh = () => { loadRows(); loadResumo(); };

  const pages = Math.max(1, Math.ceil(count / PS));
  const st = resumo?.status;
  const chips: [string, string, number][] = [
    ["", "Todas", resumo?.total ?? 0],
    ["ABERTO", "Em aberto", (st?.PAGANDO ?? 0) + (st?.["NÃO PAGOU"] ?? 0) + (st?.["A VENCER"] ?? 0)],
    ["QUITADO", "Quitado", st?.QUITADO ?? 0],
    ["PAGANDO", "Pagando", st?.PAGANDO ?? 0],
    ["A VENCER", "A vencer", st?.["A VENCER"] ?? 0],
    ["NÃO PAGOU", "Não pagou", st?.["NÃO PAGOU"] ?? 0],
    ["FUNDO PERDIDO", "Fundo perdido", st?.["FUNDO PERDIDO"] ?? 0],
  ];
  const reset = () => setPage(0);

  const toggleVenc = (f: VencFiltro) => {
    if (venc === f) {
      setVenc("");
      setSortCol("vencimento");
      setSortAsc(false);
    } else {
      setVenc(f);
      setSortCol("vencimento");
      setSortAsc(f !== "vencidas");
    }
    reset();
  };

  const handleSort = (col: string) => {
    if (sortCol === col) {
      setSortAsc(a => !a);
    } else {
      setSortCol(col);
      if (col === "divida_total" || col === "valor_pago" || col === "saldo_devedor") {
        setSortAsc(false);
      } else if (col === "vencimento") {
        setSortAsc(venc && venc !== "vencidas");
      } else {
        setSortAsc(true);
      }
    }
    reset();
  };

  return (
    <>
      <div className="head2 noprint">
        <div>
          <h1>Acompanhe o que ainda falta receber</h1>
          <div className="sub">Saldo, status e projeções de recebimento calculados em tempo real.</div>
        </div>
        {isAdmin && <button className="btn" onClick={() => setEditing(null)}>+ Nova promissória</button>}
      </div>
      {error && <div className="warn">Erro: {error}</div>}
      <section className="kpis">
        <div className="card hl"><small>Saldo a receber</small><b>{money(resumo?.saldo ?? 0)}</b>
          {!!resumo?.perdido && <span className="ksub">Fundo perdido: {money(resumo.perdido)} (fora do saldo)</span>}</div>
        <div className="card"><small>Total da dívida</small><b>{money(resumo?.divida ?? 0)}</b></div>
        <div className="card"><small>Total pago</small><b>{money(resumo?.pago ?? 0)}</b></div>
        <div className="card"><small>Promissórias</small><b>{(resumo?.total ?? 0).toLocaleString("pt-BR")}</b></div>
      </section>

      {resumo && (
        <div className="alerts">
          <button
            type="button"
            className={`alertbtn bad ${venc === "vencidas" ? "on" : ""}`}
            onClick={() => toggleVenc("vencidas")}
            title="Filtrar promissórias vencidas"
          >
            <b>{resumo.vencidas_qtd.toLocaleString("pt-BR")} vencidas</b>
            <span>{money(resumo.vencidas_valor)} em atraso</span>
          </button>
          <button
            type="button"
            className={`alertbtn warn2 ${venc === "d1" ? "on" : ""}`}
            onClick={() => toggleVenc("d1")}
            title="Filtrar promissórias que vencem em até 1 dia (amanhã)"
          >
            <b>{(resumo.d1_qtd ?? 0).toLocaleString("pt-BR")} em até 1 dia</b>
            <span>{money(resumo.d1_valor ?? 0)} projetado</span>
          </button>
          <button
            type="button"
            className={`alertbtn warn2 ${venc === "d7" ? "on" : ""}`}
            onClick={() => toggleVenc("d7")}
            title="Filtrar promissórias que vencem em até 7 dias"
          >
            <b>{(resumo.d7_qtd ?? resumo.proximas_qtd ?? 0).toLocaleString("pt-BR")} em até 7 dias</b>
            <span>{money(resumo.d7_valor ?? resumo.proximas_valor ?? 0)} projetado</span>
          </button>
          <button
            type="button"
            className={`alertbtn info ${venc === "d30" ? "on" : ""}`}
            onClick={() => toggleVenc("d30")}
            title="Filtrar promissórias que vencem em até 30 dias"
          >
            <b>{(resumo.d30_qtd ?? 0).toLocaleString("pt-BR")} em até 30 dias</b>
            <span>{money(resumo.d30_valor ?? 0)} projetado</span>
          </button>
        </div>
      )}

      <div className="chips">
        {chips.map(([k, l, n]) => (
          <button key={k} className={`chip ${status === k ? "on" : ""}`} onClick={() => { setStatus(k); reset(); }}>{l} · {n.toLocaleString("pt-BR")}</button>
        ))}
      </div>
      <div className="bar">
        <input type="search" placeholder="Buscar por cliente ou telefone" value={q} onChange={e => setQ(e.target.value)} />
        <select value={year} onChange={e => { setYear(e.target.value); reset(); }}>
          <option value="">Todos os anos</option>
          {(resumo?.anos ?? []).map(y => <option key={y}>{y}</option>)}
        </select>
        <select
          value={`${sortCol}:${sortAsc ? "asc" : "desc"}`}
          onChange={e => {
            const [c, d] = e.target.value.split(":");
            setSortCol(c);
            setSortAsc(d === "asc");
            reset();
          }}
        >
          <option value="vencimento:desc">Vencimento (recente)</option>
          <option value="vencimento:asc">Vencimento (mais antigo / próximo)</option>
          <option value="saldo_devedor:desc">Maior saldo</option>
          <option value="saldo_devedor:asc">Menor saldo</option>
          <option value="divida_total:desc">Maior dívida</option>
          <option value="valor_pago:desc">Maior valor pago</option>
          <option value="cliente_nome:asc">Cliente (A–Z)</option>
          <option value="cliente_nome:desc">Cliente (Z–A)</option>
          <option value="telefone:asc">Telefone</option>
          <option value="status:asc">Status</option>
        </select>
      </div>
      <div className="wrap">
        <table>
          <thead>
            <tr>
              <th className={`sortable ${sortCol === "cliente_nome" ? "active" : ""}`} onClick={() => handleSort("cliente_nome")} title="Clique para ordenar por Cliente">
                <span className="th-content">Cliente <SortIcon col="cliente_nome" sortCol={sortCol} sortAsc={sortAsc} /></span>
              </th>
              <th className={`sortable ${sortCol === "telefone" ? "active" : ""}`} onClick={() => handleSort("telefone")} title="Clique para ordenar por Telefone">
                <span className="th-content">Telefone <SortIcon col="telefone" sortCol={sortCol} sortAsc={sortAsc} /></span>
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
              <th className={`sortable ${sortCol === "vencimento" ? "active" : ""}`} onClick={() => handleSort("vencimento")} title="Clique para ordenar por Vencimento">
                <span className="th-content">Vencimento <SortIcon col="vencimento" sortCol={sortCol} sortAsc={sortAsc} /></span>
              </th>
              <th className={`sortable ${sortCol === "status" ? "active" : ""}`} onClick={() => handleSort("status")} title="Clique para ordenar por Status">
                <span className="th-content">Status <SortIcon col="status" sortCol={sortCol} sortAsc={sortAsc} /></span>
              </th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td className={`s-${cls(deriveStatus(r))}`}>
                  <button
                    type="button"
                    className="link-cli"
                    title={`Ver todas as promissórias de ${r.cliente_nome}`}
                    onClick={() => setFichaCliente({ cliente: r.cliente_nome, telefone: r.telefone })}
                  >
                    {r.cliente_nome}
                  </button>
                </td>
                <td className="mono">{r.telefone || "—"}</td>
                <td className="n">{money(r.divida_total)}</td>
                <td className="n">{money(r.valor_pago)}</td>
                <td className="n"><b>{money(r.saldo_devedor)}</b></td>
                <td><VencCell r={r} /></td>
                <td><StatusPill r={r} />{r.fundo_perdido && r.fundo_perdido_motivo && <div className="sub" title={r.fundo_perdido_motivo}>{r.fundo_perdido_motivo.slice(0, 28)}</div>}</td>
                <td className="acts">
                  {isAdmin && !r.fundo_perdido && r.saldo_devedor > 0 && (
                    <button className="btn-baixa" onClick={() => setBaixa(r)} title="Registrar baixa / pagamento">
                      Baixar
                    </button>
                  )}
                  {r.valor_pago > 0 && (
                    <button className="ed" onClick={() => setLogRow(r)} title="Ver histórico e auditoria de pagamento">
                      Ver log
                    </button>
                  )}
                  {!r.fundo_perdido && r.saldo_devedor > 0 && <button className="ed" onClick={() => setWhats(r)}>WhatsApp</button>}
                  {isAdmin && <button className="ed" onClick={() => setEditing(r)}>Editar</button>}
                  {isAdmin && (r.fundo_perdido || r.saldo_devedor > 0) && <button className="ed" onClick={() => setPerdido(r)}>{r.fundo_perdido ? "Desfazer" : "Fundo perdido"}</button>}
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={8} style={{ textAlign: "center", color: "var(--mut)", padding: 30 }}>Nenhum registro encontrado.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="pager">
        <span>{count.toLocaleString("pt-BR")} registros · página {page + 1} de {pages}</span>
        <button className="btn ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>←</button>
        <button className="btn ghost" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>→</button>
      </div>
      {baixa && <BaixaDialog row={baixa} onClose={() => setBaixa(null)} onSaved={() => { setBaixa(null); refresh(); }} />}
      {logRow && <LogDialog row={logRow} onClose={() => setLogRow(null)} />}
      {editing !== undefined && <Editor row={editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); refresh(); }} />}
      {perdido && <PerdidoDialog row={perdido} onClose={() => setPerdido(null)} onDone={() => { setPerdido(null); refresh(); }} />}
      {whats && <WhatsDialog nome={whats.cliente_nome} telefone={whats.telefone} mensagem={mensagemCobranca(whats.cliente_nome, [{ valor: whats.saldo_devedor, vencimento: whats.vencimento }])} onClose={() => setWhats(null)} />}
      {fichaCliente && (
        <FichaCliente
          cliente={fichaCliente.cliente}
          telefone={fichaCliente.telefone}
          isAdmin={isAdmin}
          onClose={() => setFichaCliente(null)}
          onChanged={refresh}
        />
      )}
    </>
  );
}
