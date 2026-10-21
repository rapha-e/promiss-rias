import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";
import { LBL, cls, deriveStatus, dt, hoje, mensagemCobranca, money } from "./lib";
import type { Row, Status } from "./lib";
import { Editor, FichaCliente, PerdidoDialog, StatusPill, VencCell, WhatsDialog, BaixaDialog, LogDialog } from "./Dialogs";

type Resumo = {
  total: number; divida: number; pago: number; saldo: number; perdido: number; status: Record<Status, number>;
  vencidas_qtd: number; vencidas_valor: number; proximas_qtd: number; proximas_valor: number;
  hoje_qtd?: number; hoje_valor?: number;
  anos: number[];
};
const PS = 50;

import { SortIcon } from "./SortIcon";
import { HeaderFilterMenu } from "./HeaderFilterMenu";

type VencFiltro = "" | "vencidas" | "hoje" | "proximos_7";

const ANOS_DISPONIVEIS = Array.from({ length: 15 }, (_, i) => 2020 + i);

function ultimoDiaDoMes(yyyyMm: string): string {
  const [y, m] = yyyyMm.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

export default function Promissorias({ isAdmin }: { isAdmin: boolean }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [count, setCount] = useState(0);
  const [resumo, setResumo] = useState<Resumo | null>(null);
  const [q, setQ] = useState("");
  const [qd, setQd] = useState("");
  const [status, setStatus] = useState("");
  const [venc, setVenc] = useState<VencFiltro>("");
  const [filtroCliente, setFiltroCliente] = useState("");
  const [filtroClienteTemp, setFiltroClienteTemp] = useState("");
  const [filtroTelefone, setFiltroTelefone] = useState<"" | "com" | "sem">("");
  const [filtroDivida, setFiltroDivida] = useState("");
  const [filtroPago, setFiltroPago] = useState("");
  const [filtroSaldo, setFiltroSaldo] = useState("");
  const [tipoPeriodo, setTipoPeriodo] = useState<"todos" | "mes" | "ano" | "dia">("todos");
  const [ini, setIni] = useState("");
  const [fim, setFim] = useState("");
  const [mesIni, setMesIni] = useState("");
  const [mesFim, setMesFim] = useState("");
  const [anoIni, setAnoIni] = useState("");
  const [anoFim, setAnoFim] = useState("");
  const [projecaoPeriodo, setProjecaoPeriodo] = useState<{ qtd: number; valor: number } | null>(null);
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
    const [qHoje, qAVencer, qNaoPagou] = await Promise.all([
      supabase.from("promissorias").select("saldo_devedor").eq("fundo_perdido", false).gt("saldo_devedor", 0).eq("vencimento", h),
      supabase.from("promissorias").select("id", { count: "exact", head: true }).eq("fundo_perdido", false).eq("valor_pago", 0).or(`vencimento.gte.${h},vencimento.is.null`),
      supabase.from("promissorias").select("id", { count: "exact", head: true }).eq("fundo_perdido", false).eq("valor_pago", 0).lt("vencimento", h),
    ]);
    const hojeList = qHoje.data ?? [];
    res.hoje_qtd = hojeList.length;
    res.hoje_valor = hojeList.reduce((s, r) => s + (r.saldo_devedor ?? 0), 0);
    if (res.status) {
      res.status["A VENCER"] = qAVencer.count ?? 0;
      res.status["NÃO PAGOU"] = qNaoPagou.count ?? 0;
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

    if (ini) query = query.gte("vencimento", ini);
    if (fim) query = query.lte("vencimento", fim);

    if (filtroCliente) query = query.ilike("cliente_nome", `%${filtroCliente.trim()}%`);

    if (filtroTelefone === "com") {
      query = query.not("telefone", "is", null).neq("telefone", "");
    } else if (filtroTelefone === "sem") {
      query = query.or("telefone.is.null,telefone.eq.''");
    }

    if (filtroDivida === "ate_200") query = query.lte("divida_total", 200);
    else if (filtroDivida === "200_500") query = query.gte("divida_total", 200).lte("divida_total", 500);
    else if (filtroDivida === "500_1000") query = query.gte("divida_total", 500).lte("divida_total", 1000);
    else if (filtroDivida === "mais_1000") query = query.gt("divida_total", 1000);

    if (filtroPago === "com") query = query.gt("valor_pago", 0);
    else if (filtroPago === "sem") query = query.eq("valor_pago", 0);

    if (filtroSaldo === "aberto") query = query.gt("saldo_devedor", 0);
    else if (filtroSaldo === "quitado") query = query.lte("saldo_devedor", 0);
    else if (filtroSaldo === "ate_500") query = query.gt("saldo_devedor", 0).lte("saldo_devedor", 500);
    else if (filtroSaldo === "mais_500") query = query.gt("saldo_devedor", 500);

    if (venc === "vencidas") query = query.eq("fundo_perdido", false).gt("saldo_devedor", 0).lt("vencimento", h);
    else if (venc === "hoje") query = query.eq("fundo_perdido", false).gt("saldo_devedor", 0).eq("vencimento", h);
    else if (venc === "proximos_7") {
      const d7 = new Date();
      d7.setDate(d7.getDate() + 7);
      const d7Str = d7.toISOString().slice(0, 10);
      query = query.eq("fundo_perdido", false).gt("saldo_devedor", 0).gte("vencimento", h).lte("vencimento", d7Str);
    }

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
  }, [qd, status, ini, fim, sortCol, sortAsc, page, venc, filtroCliente, filtroTelefone, filtroDivida, filtroPago, filtroSaldo]);

  const loadProjecaoPeriodo = useCallback(async () => {
    if (!ini && !fim) {
      setProjecaoPeriodo(null);
      return;
    }
    let query = supabase
      .from("promissorias")
      .select("saldo_devedor")
      .eq("fundo_perdido", false)
      .gt("saldo_devedor", 0);
    if (ini) query = query.gte("vencimento", ini);
    if (fim) query = query.lte("vencimento", fim);
    const { data, error } = await query;
    if (error || !data) {
      setProjecaoPeriodo(null);
      return;
    }
    const valor = data.reduce((s, r) => s + (r.saldo_devedor ?? 0), 0);
    setProjecaoPeriodo({ qtd: data.length, valor });
  }, [ini, fim]);

  useEffect(() => { loadResumo(); }, [loadResumo]);
  useEffect(() => { loadRows(); }, [loadRows]);
  useEffect(() => { loadProjecaoPeriodo(); }, [loadProjecaoPeriodo]);
  const refresh = () => { loadRows(); loadResumo(); loadProjecaoPeriodo(); };

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

  const anosLista = Array.from(new Set([...(resumo?.anos ?? []), ...ANOS_DISPONIVEIS])).sort((a, b) => a - b);

  const limparPeriodo = () => {
    setTipoPeriodo("todos");
    setIni("");
    setFim("");
    setMesIni("");
    setMesFim("");
    setAnoIni("");
    setAnoFim("");
    setProjecaoPeriodo(null);
    reset();
  };

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

  const handleSort = (col: string, asc?: boolean) => {
    if (asc !== undefined) {
      setSortCol(col);
      setSortAsc(asc);
    } else if (sortCol === col) {
      setSortAsc(a => !a);
    } else {
      setSortCol(col);
      if (col === "divida_total" || col === "valor_pago" || col === "saldo_devedor") {
        setSortAsc(false);
      } else if (col === "vencimento") {
        setSortAsc(Boolean(venc && venc !== "vencidas"));
      } else {
        setSortAsc(true);
      }
    }
    reset();
  };

  const temFiltrosAtivos = Boolean(filtroCliente || filtroTelefone || filtroDivida || filtroPago || filtroSaldo || status || venc);

  const limparTodosFiltros = () => {
    setFiltroCliente("");
    setFiltroClienteTemp("");
    setFiltroTelefone("");
    setFiltroDivida("");
    setFiltroPago("");
    setFiltroSaldo("");
    setStatus("");
    setVenc("");
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
        <div className="card"><small>Total de venda</small><b>{money(resumo?.divida ?? 0)}</b></div>
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
            className={`alertbtn warn2 ${venc === "hoje" ? "on" : ""}`}
            onClick={() => toggleVenc("hoje")}
            title="Filtrar promissórias que vencem hoje"
          >
            <b>{(resumo.hoje_qtd ?? 0).toLocaleString("pt-BR")} hoje</b>
            <span>{money(resumo.hoje_valor ?? 0)} projetado</span>
          </button>

          <div className={`projecao-alert-card ${projecaoPeriodo !== null ? "active" : "empty"}`}>
            <div className="projecao-alert-left">
              <span className="projecao-alert-tag">Valor projetado no período</span>
              <div className="projecao-alert-main">
                <span className="projecao-alert-valor">
                  {projecaoPeriodo !== null ? money(projecaoPeriodo.valor) : "R$ —"}
                </span>
                <span className="projecao-alert-desc">
                  {projecaoPeriodo !== null ? "projetado a receber" : "selecione um período abaixo"}
                </span>
              </div>
            </div>
            <div className="projecao-alert-right">
              {projecaoPeriodo !== null ? (
                <>
                  <span className="projecao-alert-qtd">
                    <b>{projecaoPeriodo.qtd.toLocaleString("pt-BR")}</b> promissória{projecaoPeriodo.qtd !== 1 ? "s" : ""} com saldo
                  </span>
                  <span className="projecao-alert-periodo">
                    {ini && fim ? `Vencimentos de ${dt(ini)} até ${dt(fim)}` : ini ? `Vencimentos a partir de ${dt(ini)}` : `Vencimentos até ${dt(fim)}`}
                  </span>
                </>
              ) : (
                <span className="projecao-alert-periodo muted">Nenhum período selecionado</span>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="chips">
        {chips.map(([k, l, n]) => (
          <button key={k} className={`chip ${status === k ? "on" : ""}`} onClick={() => { setStatus(k); reset(); }}>{l} · {n.toLocaleString("pt-BR")}</button>
        ))}
      </div>
      <div className="bar" style={{ flexWrap: "wrap", gap: 10 }}>
        <input type="search" placeholder="Buscar por cliente ou telefone" value={q} onChange={e => setQ(e.target.value)} />

        <select
          value={tipoPeriodo}
          onChange={e => {
            const t = e.target.value as "todos" | "mes" | "ano" | "dia";
            setTipoPeriodo(t);
            if (t === "todos") limparPeriodo();
            reset();
          }}
          aria-label="Tipo de período"
          style={{ fontWeight: 600 }}
        >
          <option value="todos">Todos os períodos</option>
          <option value="mes">🗓️ Intervalo em meses</option>
          <option value="ano">📆 Intervalo em anos</option>
          <option value="dia">📅 Intervalo em dias</option>
        </select>

        {tipoPeriodo === "mes" && (
          <>
            <label className="inl">
              De
              <input
                type="month"
                value={mesIni}
                onChange={e => {
                  const v = e.target.value;
                  setMesIni(v);
                  if (v) {
                    setIni(`${v}-01`);
                    if (!mesFim || mesFim < v) {
                      setMesFim(v);
                      setFim(ultimoDiaDoMes(v));
                    }
                  } else {
                    setIni("");
                  }
                  reset();
                }}
              />
            </label>
            <label className="inl">
              Até
              <input
                type="month"
                value={mesFim}
                onChange={e => {
                  const v = e.target.value;
                  setMesFim(v);
                  if (v) setFim(ultimoDiaDoMes(v));
                  else setFim("");
                  reset();
                }}
              />
            </label>
          </>
        )}

        {tipoPeriodo === "ano" && (
          <>
            <label className="inl">
              De
              <select
                value={anoIni}
                onChange={e => {
                  const a = e.target.value;
                  setAnoIni(a);
                  if (a) {
                    setIni(`${a}-01-01`);
                    if (!anoFim || anoFim < a) {
                      setAnoFim(a);
                      setFim(`${a}-12-31`);
                    }
                  } else {
                    setIni("");
                  }
                  reset();
                }}
              >
                <option value="">Selecione o ano</option>
                {anosLista.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
            <label className="inl">
              Até
              <select
                value={anoFim}
                onChange={e => {
                  const a = e.target.value;
                  setAnoFim(a);
                  if (a) setFim(`${a}-12-31`);
                  else setFim("");
                  reset();
                }}
              >
                <option value="">Selecione o ano</option>
                {anosLista.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
          </>
        )}

        {tipoPeriodo === "dia" && (
          <>
            <label className="inl">De <input type="date" value={ini} onChange={e => { setIni(e.target.value); reset(); }} /></label>
            <label className="inl">Até <input type="date" value={fim} onChange={e => { setFim(e.target.value); reset(); }} /></label>
          </>
        )}

        {(tipoPeriodo !== "todos" || ini || fim || mesIni || mesFim || anoIni || anoFim) && (
          <button className="btn ghost" onClick={limparPeriodo}>
            Limpar período
          </button>
        )}
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

      {temFiltrosAtivos && (
        <div className="active-filters-bar">
          <span style={{ fontWeight: 600, color: "var(--mut)" }}>Filtros ativos:</span>
          {filtroCliente && (
            <span className="filter-chip">
              Cliente: {filtroCliente}
              <button type="button" onClick={() => { setFiltroCliente(""); setFiltroClienteTemp(""); reset(); }} title="Remover filtro">✕</button>
            </span>
          )}
          {filtroTelefone && (
            <span className="filter-chip">
              Telefone: {filtroTelefone === "com" ? "Com telefone" : "Sem telefone"}
              <button type="button" onClick={() => { setFiltroTelefone(""); reset(); }} title="Remover filtro">✕</button>
            </span>
          )}
          {filtroDivida && (
            <span className="filter-chip">
              Dívida: {
                filtroDivida === "ate_200" ? "Até R$ 200" :
                filtroDivida === "200_500" ? "R$ 200 a R$ 500" :
                filtroDivida === "500_1000" ? "R$ 500 a R$ 1.000" : "Acima de R$ 1.000"
              }
              <button type="button" onClick={() => { setFiltroDivida(""); reset(); }} title="Remover filtro">✕</button>
            </span>
          )}
          {filtroPago && (
            <span className="filter-chip">
              Pago: {filtroPago === "com" ? "Com pagamento" : "Sem pagamento"}
              <button type="button" onClick={() => { setFiltroPago(""); reset(); }} title="Remover filtro">✕</button>
            </span>
          )}
          {filtroSaldo && (
            <span className="filter-chip">
              Saldo: {
                filtroSaldo === "aberto" ? "Em aberto" :
                filtroSaldo === "quitado" ? "Quitado" :
                filtroSaldo === "ate_500" ? "Até R$ 500" : "Acima de R$ 500"
              }
              <button type="button" onClick={() => { setFiltroSaldo(""); reset(); }} title="Remover filtro">✕</button>
            </span>
          )}
          {venc && (
            <span className="filter-chip">
              Vencimento: {venc === "vencidas" ? "Vencidas" : venc === "hoje" ? "Hoje" : "Próximos 7 dias"}
              <button type="button" onClick={() => { setVenc(""); reset(); }} title="Remover filtro">✕</button>
            </span>
          )}
          {status && (
            <span className="filter-chip">
              Status: {status}
              <button type="button" onClick={() => { setStatus(""); reset(); }} title="Remover filtro">✕</button>
            </span>
          )}
          <button
            type="button"
            className="btn ghost"
            style={{ padding: "2px 8px", fontSize: 11, borderRadius: 99, color: "var(--bad)" }}
            onClick={limparTodosFiltros}
          >
            Limpar todos os filtros
          </button>
        </div>
      )}

      <div className="wrap">
        <table>
          <thead>
            <tr>
              <HeaderFilterMenu
                title="Cliente"
                col="cliente_nome"
                sortCol={sortCol}
                sortAsc={sortAsc}
                onSort={handleSort}
                isFiltered={Boolean(filtroCliente)}
                filterLabel={filtroCliente}
                onClearFilter={() => { setFiltroCliente(""); setFiltroClienteTemp(""); reset(); }}
                customFilterContent={
                  <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                    <input
                      type="text"
                      placeholder="Filtrar por nome..."
                      value={filtroClienteTemp}
                      onChange={e => setFiltroClienteTemp(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter") {
                          setFiltroCliente(filtroClienteTemp);
                          reset();
                        }
                      }}
                      style={{
                        flex: 1,
                        padding: "5px 8px",
                        fontSize: 12,
                        borderRadius: 6,
                        border: "1px solid var(--line)",
                        background: "var(--card)",
                        color: "var(--ink)",
                      }}
                    />
                    <button
                      type="button"
                      className="btn"
                      style={{ padding: "4px 8px", fontSize: 12 }}
                      onClick={() => {
                        setFiltroCliente(filtroClienteTemp);
                        reset();
                      }}
                    >
                      OK
                    </button>
                  </div>
                }
              />
              <HeaderFilterMenu
                title="Telefone"
                col="telefone"
                sortCol={sortCol}
                sortAsc={sortAsc}
                onSort={handleSort}
                isFiltered={Boolean(filtroTelefone)}
                filterLabel={filtroTelefone === "com" ? "Com telefone" : "Sem telefone"}
                onClearFilter={() => { setFiltroTelefone(""); reset(); }}
                options={[
                  { label: "Todos os telefones", value: "", active: filtroTelefone === "" },
                  { label: "Com telefone cadastrado", value: "com", active: filtroTelefone === "com" },
                  { label: "Sem telefone cadastrado", value: "sem", active: filtroTelefone === "sem" },
                ]}
                onSelectOption={val => { setFiltroTelefone(val as any); reset(); }}
              />
              <HeaderFilterMenu
                title="Dívida"
                col="divida_total"
                align="right"
                sortCol={sortCol}
                sortAsc={sortAsc}
                onSort={handleSort}
                isFiltered={Boolean(filtroDivida)}
                filterLabel={
                  filtroDivida === "ate_200" ? "Até R$ 200" :
                  filtroDivida === "200_500" ? "R$ 200 a R$ 500" :
                  filtroDivida === "500_1000" ? "R$ 500 a R$ 1.000" :
                  filtroDivida === "mais_1000" ? "Acima de R$ 1.000" : ""
                }
                onClearFilter={() => { setFiltroDivida(""); reset(); }}
                options={[
                  { label: "Qualquer valor de venda", value: "", active: filtroDivida === "" },
                  { label: "Até R$ 200", value: "ate_200", active: filtroDivida === "ate_200" },
                  { label: "R$ 200 a R$ 500", value: "200_500", active: filtroDivida === "200_500" },
                  { label: "R$ 500 a R$ 1.000", value: "500_1000", active: filtroDivida === "500_1000" },
                  { label: "Acima de R$ 1.000", value: "mais_1000", active: filtroDivida === "mais_1000" },
                ]}
                onSelectOption={val => { setFiltroDivida(val); reset(); }}
              />
              <HeaderFilterMenu
                title="Pago"
                col="valor_pago"
                align="right"
                sortCol={sortCol}
                sortAsc={sortAsc}
                onSort={handleSort}
                isFiltered={Boolean(filtroPago)}
                filterLabel={filtroPago === "com" ? "Com pagamento" : "Sem pagamento"}
                onClearFilter={() => { setFiltroPago(""); reset(); }}
                options={[
                  { label: "Todos", value: "", active: filtroPago === "" },
                  { label: "Com algum pagamento (> R$ 0)", value: "com", active: filtroPago === "com" },
                  { label: "Nenhum pagamento feito", value: "sem", active: filtroPago === "sem" },
                ]}
                onSelectOption={val => { setFiltroPago(val); reset(); }}
              />
              <HeaderFilterMenu
                title="Saldo"
                col="saldo_devedor"
                align="right"
                sortCol={sortCol}
                sortAsc={sortAsc}
                onSort={handleSort}
                isFiltered={Boolean(filtroSaldo)}
                filterLabel={
                  filtroSaldo === "aberto" ? "Em aberto" :
                  filtroSaldo === "quitado" ? "Quitado" :
                  filtroSaldo === "ate_500" ? "Até R$ 500" :
                  filtroSaldo === "mais_500" ? "Acima de R$ 500" : ""
                }
                onClearFilter={() => { setFiltroSaldo(""); reset(); }}
                options={[
                  { label: "Todos os saldos", value: "", active: filtroSaldo === "" },
                  { label: "Com saldo em aberto", value: "aberto", active: filtroSaldo === "aberto" },
                  { label: "Quitado (saldo zero)", value: "quitado", active: filtroSaldo === "quitado" },
                  { label: "Saldo até R$ 500", value: "ate_500", active: filtroSaldo === "ate_500" },
                  { label: "Saldo acima de R$ 500", value: "mais_500", active: filtroSaldo === "mais_500" },
                ]}
                onSelectOption={val => { setFiltroSaldo(val); reset(); }}
              />
              <HeaderFilterMenu
                title="Vencimento"
                col="vencimento"
                sortCol={sortCol}
                sortAsc={sortAsc}
                onSort={handleSort}
                isFiltered={Boolean(venc)}
                filterLabel={
                  venc === "vencidas" ? "Vencidas" :
                  venc === "hoje" ? "Vencem hoje" :
                  venc === "proximos_7" ? "Próximos 7 dias" : ""
                }
                onClearFilter={() => { setVenc(""); reset(); }}
                options={[
                  { label: "Todos os vencimentos", value: "", active: venc === "" },
                  { label: "Vencidas (em atraso)", value: "vencidas", active: venc === "vencidas", badge: resumo?.vencidas_qtd },
                  { label: "Vencem hoje", value: "hoje", active: venc === "hoje", badge: resumo?.hoje_qtd },
                  { label: "Próximos 7 dias", value: "proximos_7", active: venc === "proximos_7" },
                ]}
                onSelectOption={val => { toggleVenc(val as any); }}
              />
              <HeaderFilterMenu
                title="Status"
                col="status"
                sortCol={sortCol}
                sortAsc={sortAsc}
                onSort={handleSort}
                isFiltered={Boolean(status)}
                filterLabel={status || "Todas"}
                onClearFilter={() => { setStatus(""); reset(); }}
                options={[
                  { label: "Todas", value: "", active: status === "" },
                  { label: "Em aberto", value: "ABERTO", active: status === "ABERTO" },
                  { label: "Quitado", value: "QUITADO", active: status === "QUITADO" },
                  { label: "Pagando", value: "PAGANDO", active: status === "PAGANDO" },
                  { label: "A vencer", value: "A VENCER", active: status === "A VENCER" },
                  { label: "Não pagou", value: "NÃO PAGOU", active: status === "NÃO PAGOU" },
                  { label: "Fundo perdido", value: "FUNDO PERDIDO", active: status === "FUNDO PERDIDO" },
                ]}
                onSelectOption={val => { setStatus(val); reset(); }}
              />
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
                      Log
                    </button>
                  )}
                  {!r.fundo_perdido && r.saldo_devedor > 0 && (
                    <button className="ed" onClick={() => setWhats(r)} title="Cobrar por WhatsApp">
                      Whats
                    </button>
                  )}
                  {isAdmin && <button className="ed" onClick={() => setEditing(r)} title="Editar promissória">Editar</button>}
                  {isAdmin && (r.fundo_perdido || r.saldo_devedor > 0) && (
                    <button className="ed" onClick={() => setPerdido(r)} title={r.fundo_perdido ? "Desfazer fundo perdido" : "Marcar como fundo perdido"}>
                      {r.fundo_perdido ? "Desfazer" : "F. Perdido"}
                    </button>
                  )}
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
