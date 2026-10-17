import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";
import { baixarCSV, diffDias, dt, hoje, mensagemCobranca, money, normalizarTelefones, somaDias, toBRL } from "./lib";
import { WhatsDialog } from "./Dialogs";

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

export default function Relatorio() {
  const [sit, setSit] = useState<Sit>("vencidas");
  const [ini, setIni] = useState("");
  const [fim, setFim] = useState("");
  const [rows, setRows] = useState<Rel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [whats, setWhats] = useState<Rel | null>(null);

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

  function preset(p: "vencidas" | "7" | "30" | "mes") {
    const h = hoje();
    if (p === "vencidas") { setSit("vencidas"); setIni(""); setFim(""); }
    if (p === "7") { setSit("a_vencer"); setIni(h); setFim(somaDias(h, 7)); }
    if (p === "30") { setSit("a_vencer"); setIni(h); setFim(somaDias(h, 30)); }
    if (p === "mes") {
      const y = +h.slice(0, 4), m = +h.slice(5, 7);
      setSit("todas"); setIni(`${h.slice(0, 7)}-01`); setFim(new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10));
    }
  }
  const situacaoTxt = (r: Rel) => r.dias_atraso > 0 ? `${r.dias_atraso} ${r.dias_atraso === 1 ? "dia" : "dias"} de atraso`
    : (() => { const d = diffDias(r.vencimento, hoje()); return d === 0 ? "Vence hoje" : `Vence em ${d} ${d === 1 ? "dia" : "dias"}`; })();
  const periodo = `${SIT[sit]}${ini ? ` · de ${dt(ini)}` : ""}${fim ? ` até ${dt(fim)}` : ""}`;

  function exportar() {
    baixarCSV(`relatorio-vencimentos-${hoje()}.csv`,
      ["Cliente", "Telefone", "Parcelas", "Vencimento", "Dias de atraso", "Dívida (R$)", "Pago (R$)", "Saldo (R$)"],
      rows.map(r => [r.cliente_nome, r.telefone, r.parcelas, dt(r.vencimento), r.dias_atraso, toBRL(r.divida_total), toBRL(r.valor_pago), toBRL(r.saldo_devedor)]));
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
      <div className="printonly"><h1>gestão.fin — Relatório de vencimentos</h1><div>{periodo} · emitido em {dt(hoje())}</div></div>
      {error && <div className="warn">Erro: {error}</div>}
      <div className="chips noprint">
        <button className="chip" onClick={() => preset("vencidas")}>Vencidas</button>
        <button className="chip" onClick={() => preset("7")}>Próximos 7 dias</button>
        <button className="chip" onClick={() => preset("30")}>Próximos 30 dias</button>
        <button className="chip" onClick={() => preset("mes")}>Mês atual</button>
      </div>
      <div className="bar noprint">
        <select value={sit} onChange={e => setSit(e.target.value as Sit)} aria-label="Situação">
          {(Object.keys(SIT) as Sit[]).map(k => <option key={k} value={k}>{SIT[k]}</option>)}
        </select>
        <label className="inl">De <input type="date" value={ini} onChange={e => setIni(e.target.value)} /></label>
        <label className="inl">Até <input type="date" value={fim} onChange={e => setFim(e.target.value)} /></label>
        {(ini || fim) && <button className="btn ghost" onClick={() => { setIni(""); setFim(""); }}>Limpar período</button>}
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
          <thead><tr><th>Cliente</th><th>Telefone</th><th>Vencimento</th><th>Situação</th><th className="n">Dívida</th><th className="n">Pago</th><th className="n">Saldo</th><th className="noprint" /></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td className={r.dias_atraso > 0 ? "s-NÃO" : "s-PAGANDO"}>{r.cliente_nome}</td>
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
    </>
  );
}
