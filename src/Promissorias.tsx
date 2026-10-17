import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";
import { LBL, cls, hoje, mensagemCobranca, money, somaDias } from "./lib";
import type { Row, Status } from "./lib";
import { Editor, PerdidoDialog, StatusPill, VencCell, WhatsDialog } from "./Dialogs";

type Resumo = {
  total: number; divida: number; pago: number; saldo: number; perdido: number; status: Record<Status, number>;
  vencidas_qtd: number; vencidas_valor: number; proximas_qtd: number; proximas_valor: number; anos: number[];
};
const PS = 50;

export default function Promissorias({ isAdmin }: { isAdmin: boolean }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [count, setCount] = useState(0);
  const [resumo, setResumo] = useState<Resumo | null>(null);
  const [q, setQ] = useState("");
  const [qd, setQd] = useState("");
  const [status, setStatus] = useState("");
  const [venc, setVenc] = useState<"" | "vencidas" | "proximas">("");
  const [year, setYear] = useState("");
  const [sort, setSort] = useState("due");
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<Row | null | undefined>(undefined);
  const [perdido, setPerdido] = useState<Row | null>(null);
  const [whats, setWhats] = useState<Row | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const h = setTimeout(() => { setQd(q); setPage(0); }, 300);
    return () => clearTimeout(h);
  }, [q]);

  const loadResumo = useCallback(async () => {
    const { data, error } = await supabase.rpc("promissorias_resumo");
    if (error) setError(error.message); else setResumo(data as Resumo);
  }, []);

  const loadRows = useCallback(async () => {
    let query = supabase.from("promissorias").select("*", { count: "exact" });
    const s = qd.replace(/[%,()*]/g, " ").trim();
    if (s) query = query.or(`cliente_nome.ilike.%${s}%,telefone.ilike.%${s}%`);
    if (status === "ABERTO") query = query.neq("status", "QUITADO").neq("status", "FUNDO PERDIDO");
    else if (status) query = query.eq("status", status);
    if (year) query = query.eq("ano", Number(year));
    const h = hoje();
    if (venc === "vencidas") query = query.eq("fundo_perdido", false).gt("saldo_devedor", 0).lt("vencimento", h);
    if (venc === "proximas") query = query.eq("fundo_perdido", false).gt("saldo_devedor", 0).gte("vencimento", h).lte("vencimento", somaDias(h, 7));
    query = sort === "bal" ? query.order("saldo_devedor", { ascending: false })
      : sort === "nome" ? query.order("cliente_nome")
      : venc ? query.order("vencimento", { ascending: true })
      : query.order("vencimento", { ascending: false, nullsFirst: false });
    const { data, count: c, error } = await query.order("id").range(page * PS, page * PS + PS - 1);
    if (error) { setError(error.message); return; }
    setError(""); setRows((data ?? []) as Row[]); setCount(c ?? 0);
  }, [qd, status, year, sort, page, venc]);

  useEffect(() => { loadResumo(); }, [loadResumo]);
  useEffect(() => { loadRows(); }, [loadRows]);
  const refresh = () => { loadRows(); loadResumo(); };

  const pages = Math.max(1, Math.ceil(count / PS));
  const st = resumo?.status;
  const chips: [string, string, number][] = [
    ["", "Todas", resumo?.total ?? 0],
    ["ABERTO", "Em aberto", (st?.PAGANDO ?? 0) + (st?.["NÃO PAGOU"] ?? 0)],
    ["QUITADO", "Quitado", st?.QUITADO ?? 0],
    ["PAGANDO", "Pagando", st?.PAGANDO ?? 0],
    ["NÃO PAGOU", "Não pagou", st?.["NÃO PAGOU"] ?? 0],
    ["FUNDO PERDIDO", "Fundo perdido", st?.["FUNDO PERDIDO"] ?? 0],
  ];
  const reset = () => setPage(0);

  return (
    <>
      <div className="head2 noprint">
        <div>
          <h1>Acompanhe o que ainda falta receber</h1>
          <div className="sub">Saldo, status e fundo perdido são calculados no banco de dados.</div>
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
      {resumo && (resumo.vencidas_qtd > 0 || resumo.proximas_qtd > 0) && (
        <div className="alerts">
          <button className={`alertbtn bad ${venc === "vencidas" ? "on" : ""}`} onClick={() => { setVenc(venc === "vencidas" ? "" : "vencidas"); reset(); }}>
            <b>{resumo.vencidas_qtd.toLocaleString("pt-BR")} vencidas</b><span>{money(resumo.vencidas_valor)} em atraso</span>
          </button>
          <button className={`alertbtn warn2 ${venc === "proximas" ? "on" : ""}`} onClick={() => { setVenc(venc === "proximas" ? "" : "proximas"); reset(); }}>
            <b>{resumo.proximas_qtd.toLocaleString("pt-BR")} vencem em 7 dias</b><span>{money(resumo.proximas_valor)} a receber</span>
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
        <select value={sort} onChange={e => { setSort(e.target.value); reset(); }}>
          <option value="due">Vencimento (recente)</option><option value="bal">Maior saldo</option><option value="nome">Cliente (A–Z)</option>
        </select>
      </div>
      <div className="wrap">
        <table>
          <thead><tr><th>Cliente</th><th>Telefone</th><th className="n">Dívida</th><th className="n">Pago</th><th className="n">Saldo</th><th>Vencimento</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td className={`s-${cls(r.status)}`}>{r.cliente_nome}</td>
                <td className="mono">{r.telefone || "—"}</td>
                <td className="n">{money(r.divida_total)}</td>
                <td className="n">{money(r.valor_pago)}</td>
                <td className="n"><b>{money(r.saldo_devedor)}</b></td>
                <td><VencCell r={r} /></td>
                <td><StatusPill r={r} />{r.fundo_perdido && r.fundo_perdido_motivo && <div className="sub" title={r.fundo_perdido_motivo}>{r.fundo_perdido_motivo.slice(0, 28)}</div>}</td>
                <td className="acts">
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
      {editing !== undefined && <Editor row={editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); refresh(); }} />}
      {perdido && <PerdidoDialog row={perdido} onClose={() => setPerdido(null)} onDone={() => { setPerdido(null); refresh(); }} />}
      {whats && <WhatsDialog nome={whats.cliente_nome} telefone={whats.telefone} mensagem={mensagemCobranca(whats.cliente_nome, [{ valor: whats.saldo_devedor, vencimento: whats.vencimento }])} onClose={() => setWhats(null)} />}
    </>
  );
}
