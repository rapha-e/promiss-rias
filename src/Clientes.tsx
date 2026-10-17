import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";
import { dt, mensagemCobranca, money, normalizarTelefones } from "./lib";
import type { Row } from "./lib";
import { Editor, Painel, PerdidoDialog, StatusPill, VencCell, WhatsDialog } from "./Dialogs";

type Cli = {
  cliente: string; telefone: string; qtd: number; divida: number; pago: number; saldo: number;
  perdido: number; vencido: number; proximo_venc: string | null; total_clientes: number;
};
const PS = 30;

function Ficha({ c, isAdmin, onClose, onChanged }: { c: Cli; isAdmin: boolean; onClose: () => void; onChanged: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState<Row | undefined>(undefined);
  const [perdido, setPerdido] = useState<Row | null>(null);
  const [whats, setWhats] = useState(false);
  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("cliente_promissorias", { p_cliente: c.cliente });
    if (error) setErr(error.message); else setRows((data ?? []) as Row[]);
  }, [c.cliente]);
  useEffect(() => { load(); }, [load]);
  const abertos = rows.filter(r => !r.fundo_perdido && r.saldo_devedor > 0);
  const tot = rows.reduce((a, r) => ({ d: a.d + r.divida_total, p: a.p + r.valor_pago, s: a.s + (r.fundo_perdido ? 0 : r.saldo_devedor), f: a.f + (r.fundo_perdido ? r.saldo_devedor : 0) }), { d: 0, p: 0, s: 0, f: 0 });
  const refresh = () => { load(); onChanged(); };
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
          <div className="card hl"><small>Saldo a receber</small><b>{money(tot.s)}</b></div>
          <div className="card"><small>Total devido</small><b>{money(tot.d)}</b></div>
          <div className="card"><small>Total pago</small><b>{money(tot.p)}</b></div>
          <div className="card"><small>Promissórias</small><b>{rows.length}</b>{tot.f > 0 && <span className="ksub">Fundo perdido: {money(tot.f)}</span>}</div>
        </div>
        <div className="wrap">
          <table style={{ minWidth: 640 }}>
            <thead><tr><th>Vencimento</th><th>Parcelas</th><th className="n">Dívida</th><th className="n">Pago</th><th className="n">Saldo</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td><VencCell r={r} /></td>
                  <td className="mono">{r.parcelas || "—"}</td>
                  <td className="n">{money(r.divida_total)}</td>
                  <td className="n">{money(r.valor_pago)}</td>
                  <td className="n"><b>{money(r.saldo_devedor)}</b></td>
                  <td><StatusPill r={r} />{r.fundo_perdido && <div className="sub">{r.fundo_perdido_motivo}{r.fundo_perdido_em ? ` · ${dt(r.fundo_perdido_em.slice(0, 10))}` : ""}</div>}</td>
                  <td className="acts">
                    {isAdmin && <button className="ed" onClick={() => setEditing(r)}>Editar</button>}
                    {isAdmin && (r.fundo_perdido || r.saldo_devedor > 0) && <button className="ed" onClick={() => setPerdido(r)}>{r.fundo_perdido ? "Desfazer" : "Fundo perdido"}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
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
  const [abertos, setAbertos] = useState(true);
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState<Cli | null>(null);
  const [whats, setWhats] = useState<Cli | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const h = setTimeout(() => { setQd(q); setPage(0); }, 300);
    return () => clearTimeout(h);
  }, [q]);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("clientes_resumo", { p_busca: qd.trim(), p_somente_abertos: abertos, p_limit: PS, p_offset: page * PS });
    if (error) { setError(error.message); return; }
    const l = (data ?? []) as Cli[];
    setError(""); setList(l); setTotal(l[0]?.total_clientes ?? 0);
  }, [qd, abertos, page]);
  useEffect(() => { load(); }, [load]);

  const pages = Math.max(1, Math.ceil(total / PS));
  return (
    <>
      <div className="head2 noprint">
        <div><h1>Clientes</h1><div className="sub">Promissórias agrupadas por cliente; quem tem saldo em aberto aparece primeiro.</div></div>
      </div>
      {error && <div className="warn">Erro: {error}</div>}
      <div className="bar">
        <input type="search" placeholder="Buscar cliente ou telefone" value={q} onChange={e => setQ(e.target.value)} />
        <button className={`chip ${abertos ? "on" : ""}`} onClick={() => { setAbertos(!abertos); setPage(0); }}>Somente com saldo em aberto</button>
      </div>
      <div className="wrap">
        <table>
          <thead><tr><th>Cliente</th><th>Telefone</th><th className="n">Promissórias</th><th className="n">Total devido</th><th className="n">Total pago</th><th className="n">Saldo</th><th className="n">Vencido</th><th>Próx. vencimento</th><th /></tr></thead>
          <tbody>
            {list.map(c => (
              <tr key={c.cliente}>
                <td className={c.vencido > 0 ? "s-NÃO" : c.saldo > 0 ? "s-PAGANDO" : "s-QUITADO"}>{c.cliente}</td>
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
