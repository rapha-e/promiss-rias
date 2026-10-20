import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";
import { baixarCSV, diffDias, dt, hoje, mensagemCobranca, money, normalizarTelefones, somaDias, toBRL } from "./lib";
import { FichaCliente, WhatsDialog } from "./Dialogs";
import { SortIcon } from "./SortIcon";

type Rel = {
  id: number; cliente_nome: string; telefone: string; parcelas: string; divida_total: number;
  valor_pago: number; saldo_devedor: number; vencimento: string; dias_atraso: number;
};
type Sit = "vencidas" | "a_vencer" | "todas";
const SIT: Record<Sit, string> = { vencidas: "Vencidas", a_vencer: "A vencer", todas: "Todas em aberto" };
const faixas: [string, (d: number) => boolean][] = [
  ["1–30 dias", d => d >= 1 && d <= 30], ["31–90 dias", d => d >= 31 && d <= 90],
  ["91–365 dias", d => d >= 91 && d <= 365], ["Mais de 1 ano", d => d > 365],
];

const ANOS_DISPONIVEIS = Array.from({ length: 15 }, (_, i) => 2020 + i);

function ultimoDiaDoMes(yyyyMm: string): string {
  const [y, m] = yyyyMm.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

export default function Relatorio() {
  const [sit, setSit] = useState<Sit>("vencidas");
  const [tipoPeriodo, setTipoPeriodo] = useState<"dia" | "mes" | "ano">("dia");
  const [ini, setIni] = useState("");
  const [fim, setFim] = useState("");
  const [mesIni, setMesIni] = useState("");
  const [mesFim, setMesFim] = useState("");
  const [anoIni, setAnoIni] = useState("");
  const [anoFim, setAnoFim] = useState("");
  const [activePreset, setActivePreset] = useState<string>("vencidas");
  const [sortCol, setSortCol] = useState<string>("vencimento");
  const [sortAsc, setSortAsc] = useState<boolean>(true);
  const [rows, setRows] = useState<Rel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [whats, setWhats] = useState<Rel | null>(null);
  const [fichaCliente, setFichaCliente] = useState<{ cliente: string; telefone?: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    const acc: Rel[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .rpc("relatorio_vencimentos", { p_inicio: ini || null, p_fim: fim || null, p_situacao: sit })
        .range(from, from + 999);
      if (error) { setError(error.message); break; }
      acc.push(...((data ?? []) as Rel[]));
      if (!data || data.length < 1000) break;
    }
    setRows(acc); setLoading(false);
  }, [sit, ini, fim]);
  useEffect(() => { load(); }, [load]);

  const tot = useMemo(() => {
    const vencidas = rows.filter(r => r.dias_atraso > 0);
    return {
      saldo: rows.reduce((s, r) => s + r.saldo_devedor, 0),
      vencidoValor: vencidas.reduce((s, r) => s + r.saldo_devedor, 0),
      media: vencidas.length ? Math.round(vencidas.reduce((s, r) => s + r.dias_atraso, 0) / vencidas.length) : 0,
      faixas: faixas.map(([l, f]) => [l, rows.filter(r => f(r.dias_atraso))] as [string, Rel[]]),
    };
  }, [rows]);

  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      let va: any = a[sortCol as keyof Rel];
      let vb: any = b[sortCol as keyof Rel];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string") {
        const cmp = va.localeCompare(vb, "pt-BR", { sensitivity: "base" });
        return sortAsc ? cmp : -cmp;
      }
      return sortAsc ? va - vb : vb - va;
    });
  }, [rows, sortCol, sortAsc]);

  const handleSort = (col: string) => {
    if (sortCol === col) {
      setSortAsc(a => !a);
    } else {
      setSortCol(col);
      if (col === "divida_total" || col === "valor_pago" || col === "saldo_devedor") {
        setSortAsc(false);
      } else if (col === "dias_atraso") {
        setSortAsc(false);
      } else {
        setSortAsc(true);
      }
    }
  };

  function preset(p: "vencidas" | "7" | "30" | "mes" | "prox_mes" | "ano") {
    setActivePreset(p);
    const h = hoje();
    const y = +h.slice(0, 4);
    const m = +h.slice(5, 7);

    if (p === "vencidas") {
      setTipoPeriodo("dia");
      setSit("vencidas");
      setIni(""); setFim("");
      setMesIni(""); setMesFim("");
      setAnoIni(""); setAnoFim("");
    }
    if (p === "7") {
      setTipoPeriodo("dia");
      setSit("a_vencer");
      setIni(h); setFim(somaDias(h, 7));
      setMesIni(""); setMesFim("");
      setAnoIni(""); setAnoFim("");
    }
    if (p === "30") {
      setTipoPeriodo("dia");
      setSit("a_vencer");
      setIni(h); setFim(somaDias(h, 30));
      setMesIni(""); setMesFim("");
      setAnoIni(""); setAnoFim("");
    }
    if (p === "mes") {
      setTipoPeriodo("mes");
      setSit("todas");
      const ym = h.slice(0, 7);
      setMesIni(ym);
      setMesFim(ym);
      setIni(`${ym}-01`);
      setFim(new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10));
      setAnoIni(""); setAnoFim("");
    }
    if (p === "prox_mes") {
      setTipoPeriodo("mes");
      setSit("todas");
      const nextDate = new Date(Date.UTC(y, m, 1));
      const ny = nextDate.getUTCFullYear();
      const nm = String(nextDate.getUTCMonth() + 1).padStart(2, "0");
      const ym = `${ny}-${nm}`;
      setMesIni(ym);
      setMesFim(ym);
      setIni(`${ym}-01`);
      setFim(new Date(Date.UTC(ny, nextDate.getUTCMonth() + 1, 0)).toISOString().slice(0, 10));
      setAnoIni(""); setAnoFim("");
    }
    if (p === "ano") {
      setTipoPeriodo("ano");
      setSit("todas");
      const sy = String(y);
      setAnoIni(sy);
      setAnoFim(sy);
      setIni(`${sy}-01-01`);
      setFim(`${sy}-12-31`);
      setMesIni(""); setMesFim("");
    }
  }

  const limparPeriodo = () => {
    setIni("");
    setFim("");
    setMesIni("");
    setMesFim("");
    setAnoIni("");
    setAnoFim("");
    setActivePreset("");
  };

  const situacaoTxt = (r: Rel) => r.dias_atraso > 0 ? `${r.dias_atraso} ${r.dias_atraso === 1 ? "dia" : "dias"} de atraso`
    : (() => { const d = diffDias(r.vencimento, hoje()); return d === 0 ? "Vence hoje" : `Vence em ${d} ${d === 1 ? "dia" : "dias"}`; })();
  const periodo = `${SIT[sit]}${ini ? ` · de ${dt(ini)}` : ""}${fim ? ` até ${dt(fim)}` : ""}`;

  function exportar() {
    baixarCSV(`relatorio-vencimentos-${hoje()}.csv`,
      ["Cliente", "Telefone", "Parcelas", "Vencimento", "Dias de atraso", "Dívida (R$)", "Pago (R$)", "Saldo (R$)"],
      sortedRows.map(r => [r.cliente_nome, r.telefone, r.parcelas, dt(r.vencimento), r.dias_atraso, toBRL(r.divida_total), toBRL(r.valor_pago), toBRL(r.saldo_devedor)]));
  }

  return (
    <>
      <div className="head2 noprint">
        <div><h1>Relatório de vencimentos</h1><div className="sub">Promissórias em aberto (fundo perdido não entra), com dias de atraso.</div></div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn ghost" onClick={exportar} disabled={!rows.length}>Exportar CSV</button>
          <button className="btn" onClick={() => window.print()} disabled={!rows.length}>Imprimir</button>
        </div>
      </div>
      <div className="printonly"><h1>LeoÓticas.fin — Relatório de vencimentos</h1><div>{periodo} · emitido em {dt(hoje())}</div></div>
      {error && <div className="warn">Erro: {error}</div>}
      <div className="chips noprint">
        <button className={`chip ${activePreset === "vencidas" ? "on" : ""}`} onClick={() => preset("vencidas")}>Vencidas</button>
        <button className={`chip ${activePreset === "7" ? "on" : ""}`} onClick={() => preset("7")}>Próximos 7 dias</button>
        <button className={`chip ${activePreset === "30" ? "on" : ""}`} onClick={() => preset("30")}>Próximos 30 dias</button>
        <button className={`chip ${activePreset === "mes" ? "on" : ""}`} onClick={() => preset("mes")}>Mês atual</button>
        <button className={`chip ${activePreset === "prox_mes" ? "on" : ""}`} onClick={() => preset("prox_mes")}>Próximo mês</button>
        <button className={`chip ${activePreset === "ano" ? "on" : ""}`} onClick={() => preset("ano")}>Este ano</button>
      </div>
      <div className="bar noprint" style={{ flexWrap: "wrap", gap: 10 }}>
        <select value={sit} onChange={e => { setSit(e.target.value as Sit); setActivePreset(""); }} aria-label="Situação">
          {(Object.keys(SIT) as Sit[]).map(k => <option key={k} value={k}>{SIT[k]}</option>)}
        </select>
        <select
          value={tipoPeriodo}
          onChange={e => {
            setTipoPeriodo(e.target.value as "dia" | "mes" | "ano");
            setActivePreset("");
          }}
          aria-label="Tipo de intervalo"
          style={{ fontWeight: 600 }}
        >
          <option value="dia">📅 Intervalo em dias</option>
          <option value="mes">🗓️ Intervalo em meses</option>
          <option value="ano">📆 Intervalo em anos</option>
        </select>

        {tipoPeriodo === "dia" && (
          <>
            <label className="inl">De <input type="date" value={ini} onChange={e => { setIni(e.target.value); setActivePreset(""); }} /></label>
            <label className="inl">Até <input type="date" value={fim} onChange={e => { setFim(e.target.value); setActivePreset(""); }} /></label>
          </>
        )}

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
                  setActivePreset("");
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
                  setActivePreset("");
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
                  setActivePreset("");
                }}
              >
                <option value="">Selecione o ano</option>
                {ANOS_DISPONIVEIS.map(a => <option key={a} value={a}>{a}</option>)}
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
                  setActivePreset("");
                }}
              >
                <option value="">Selecione o ano</option>
                {ANOS_DISPONIVEIS.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
          </>
        )}

        {(ini || fim || mesIni || mesFim || anoIni || anoFim) && (
          <button className="btn ghost" onClick={limparPeriodo}>
            Limpar período
          </button>
        )}
      </div>
      <section className="kpis">
        <div className="card hl"><small>Saldo no filtro</small><b>{money(tot.saldo)}</b></div>
        <div className="card"><small>Promissórias</small><b>{rows.length.toLocaleString("pt-BR")}</b></div>
        <div className="card"><small>Valor vencido</small><b>{money(tot.vencidoValor)}</b></div>
        <div className="card"><small>Atraso médio</small><b>{tot.media} dias</b></div>
      </section>
      {tot.vencidoValor > 0 && (
        <div className="faixas">
          {tot.faixas.map(([l, rs]) => (
            <div key={l} className="card"><small>{l}</small><b>{money(rs.reduce((s, r) => s + r.saldo_devedor, 0))}</b><span className="ksub">{rs.length} promissória(s)</span></div>
          ))}
        </div>
      )}
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
              <th className={`sortable ${sortCol === "vencimento" ? "active" : ""}`} onClick={() => handleSort("vencimento")} title="Clique para ordenar por Vencimento">
                <span className="th-content">Vencimento <SortIcon col="vencimento" sortCol={sortCol} sortAsc={sortAsc} /></span>
              </th>
              <th className={`sortable ${sortCol === "dias_atraso" ? "active" : ""}`} onClick={() => handleSort("dias_atraso")} title="Clique para ordenar por Situação">
                <span className="th-content">Situação <SortIcon col="dias_atraso" sortCol={sortCol} sortAsc={sortAsc} /></span>
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
              <th className="noprint" />
            </tr>
          </thead>
          <tbody>
            {sortedRows.map(r => (
              <tr key={r.id}>
                <td className={r.dias_atraso > 0 ? "s-NÃO" : "s-PAGANDO"}>
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
                <td className="mono">{dt(r.vencimento)}</td>
                <td><span className={`al ${r.dias_atraso > 0 ? "al-vencida" : "al-proxima"}`}>{situacaoTxt(r)}</span></td>
                <td className="n">{money(r.divida_total)}</td>
                <td className="n">{money(r.valor_pago)}</td>
                <td className="n"><b>{money(r.saldo_devedor)}</b></td>
                <td className="acts noprint">{normalizarTelefones(r.telefone).length > 0 && <button className="ed" onClick={() => setWhats(r)}>WhatsApp</button>}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={8} style={{ textAlign: "center", color: "var(--mut)", padding: 30 }}>{loading ? "Carregando…" : "Nenhuma promissória neste filtro."}</td></tr>}
          </tbody>
        </table>
      </div>
      {whats && <WhatsDialog nome={whats.cliente_nome} telefone={whats.telefone} mensagem={mensagemCobranca(whats.cliente_nome, [{ valor: whats.saldo_devedor, vencimento: whats.vencimento }])} onClose={() => setWhats(null)} />}
      {fichaCliente && (
        <FichaCliente
          cliente={fichaCliente.cliente}
          telefone={fichaCliente.telefone}
          isAdmin={true}
          onClose={() => setFichaCliente(null)}
          onChanged={load}
        />
      )}
    </>
  );
}
