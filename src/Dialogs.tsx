import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { supabase } from "./supabase";
import {
  LBL, alerta, alertaTexto, cls, derive, deriveStatus, dt, formatarTelefone,
  getDDD, hoje, linkWhatsApp, mascaraTelefone, mensagemCobranca, money, normalizarTelefones, parse, setDDD, somaDias, toBRL
} from "./lib";
import type { Row } from "./lib";

export function Painel({ onClose, wide, children }: { onClose: () => void; wide?: boolean; children: ReactNode }) {
  return (
    <div className="ov" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={`panel ${wide ? "wide" : ""}`}>{children}</div>
    </div>
  );
}

export function StatusPill({ r }: { r: Row }) {
  const s = deriveStatus(r);
  return <span className={`pill p-${cls(s)}`}>{LBL[s]}</span>;
}

export function VencCell({ r }: { r: Row }) {
  const a = alerta(r);
  return (
    <>
      <span className="mono">{dt(r.vencimento)}</span>
      {a.tipo && <div><span className={`al al-${a.tipo}`}>{alertaTexto(a)}</span></div>}
    </>
  );
}

export function Editor({ row, onClose, onSaved }: { row: Row | null; onClose: () => void; onSaved: () => void }) {
  const [n, setN] = useState(row?.cliente_nome ?? "");
  const [p, setP] = useState(row ? mascaraTelefone(row.telefone) : "");
  const [t, setT] = useState(row ? toBRL(row.divida_total) : "");
  const [g, setG] = useState(row ? toBRL(row.valor_pago) : "");
  const [qtd, setQtd] = useState(1);
  const [i, setI] = useState(row?.parcelas ?? "1X");
  const [d, setD] = useState(row?.vencimento ?? somaDias(hoje(), 30));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const T = parse(t);
  const G = parse(g);
  const ok = !isNaN(T) && !isNaN(G);
  const isNova = !row;

  // Cálculo e divisão das promissórias (a cada 30 dias após o 1º vencimento)
  const parcelasCalculadas = useMemo(() => {
    if (!isNova || !ok || T <= 0 || qtd <= 0) return [];
    const base = Math.floor(T / qtd);
    const resto = T % qtd;
    let restantePago = G;

    return Array.from({ length: qtd }, (_, idx) => {
      const num = idx + 1;
      const valor = base + (idx === 0 ? resto : 0);
      const pago = Math.min(restantePago, valor);
      restantePago = Math.max(0, restantePago - pago);
      const vencimento = d ? somaDias(d, idx * 30) : null;
      const rotulo = qtd === 1 ? "1X" : `${num}/${qtd}`;

      return {
        numero: num,
        parcela: rotulo,
        valor,
        pago,
        saldo: Math.max(0, valor - pago),
        vencimento,
      };
    });
  }, [isNova, ok, T, qtd, G, d]);

  const st = ok ? derive(T, G, d) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (n.trim().length < 2) return setErr("Informe o nome do cliente.");
    if (!ok) return setErr("Valores devem ser monetários e não negativos.");
    if (!d) return setErr("Informe a data de vencimento.");

    setBusy(true);
    setErr("");

    if (row) {
      // Edição de promissória existente
      const payload = {
        cliente_nome: n.trim(),
        telefone: p.trim(),
        divida_total: T,
        parcelas: i.trim(),
        valor_pago: G,
        vencimento: d || null,
      };
      const { error } = await supabase.from("promissorias").update(payload).eq("id", row.id);
      setBusy(false);
      if (error) return setErr("Não foi possível salvar: " + error.message);
    } else {
      // Criação de novas promissórias com divisão automática
      const payload = parcelasCalculadas.map(item => ({
        cliente_nome: n.trim(),
        telefone: p.trim(),
        divida_total: item.valor,
        parcelas: item.parcela,
        valor_pago: item.pago,
        vencimento: item.vencimento,
      }));
      const { error } = await supabase.from("promissorias").insert(payload);
      setBusy(false);
      if (error) return setErr("Não foi possível salvar: " + error.message);
    }

    onSaved();
  }

  return (
    <Painel onClose={onClose}>
      <form onSubmit={submit} autoComplete="off">
        <h2 style={{ margin: 0 }}>{row ? "Editar promissória" : "Nova promissória"}</h2>
        <label>
          Cliente
          <input value={n} onChange={e => setN(e.target.value)} maxLength={180} required placeholder="Nome do cliente" />
        </label>
        <label>
          Telefone
          <input value={p} onChange={e => setP(mascaraTelefone(e.target.value))} inputMode="tel" maxLength={40} placeholder="(61) 99999-9999" />
        </label>

        {isNova ? (
          <>
            <div className="r2">
              <label>
                Valor total da dívida (R$)
                <input value={t} onChange={e => setT(e.target.value)} inputMode="decimal" placeholder="0,00" required />
              </label>
              <label>
                Número de promissórias
                <select
                  value={qtd}
                  onChange={e => {
                    const q = Number(e.target.value);
                    setQtd(q);
                    setI(q === 1 ? "1X" : `${q}X`);
                  }}
                >
                  {Array.from({ length: 12 }, (_, idx) => idx + 1).map(num => (
                    <option key={num} value={num}>
                      {num === 1 ? "1x (Parcela única)" : `${num}x`}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="r2">
              <label>
                1º Vencimento
                <input type="date" value={d} onChange={e => setD(e.target.value)} required />
              </label>
              <label>
                Valor já pago / Entrada (R$)
                <input value={g} onChange={e => setG(e.target.value)} inputMode="decimal" placeholder="0,00" />
              </label>
            </div>

            {/* Pré-visualização de todas as promissórias calculadas */}
            {parcelasCalculadas.length > 0 && (
              <div
                style={{
                  background: "var(--soft)",
                  borderRadius: 10,
                  padding: "12px 14px",
                  border: "1px solid var(--line)",
                  marginTop: 4,
                  maxHeight: 220,
                  overflowY: "auto",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 12, fontWeight: 700, color: "var(--mut)" }}>
                  <span>PROMISSÓRIAS CALCULADAS ({qtd}x)</span>
                  <span>A CADA 30 DIAS</span>
                </div>
                <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse", minWidth: 0 }}>
                  <thead>
                    <tr style={{ color: "var(--mut)", fontSize: 11, borderBottom: "1px solid var(--line)" }}>
                      <th style={{ textAlign: "left", padding: "4px 0" }}>PARCELA</th>
                      <th style={{ textAlign: "right", padding: "4px 0" }}>VALOR</th>
                      <th style={{ textAlign: "right", padding: "4px 0" }}>VENCIMENTO</th>
                      <th style={{ textAlign: "right", padding: "4px 0" }}>STATUS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parcelasCalculadas.map(item => {
                      const stItem = derive(item.valor, item.pago, item.vencimento);
                      return (
                        <tr key={item.numero} style={{ borderTop: "1px solid var(--line)" }}>
                          <td style={{ padding: "6px 0", fontWeight: 600 }}>{item.parcela}</td>
                          <td style={{ padding: "6px 0", textAlign: "right" }} className="mono">{money(item.valor)}</td>
                          <td style={{ padding: "6px 0", textAlign: "right" }} className="mono">{dt(item.vencimento)}</td>
                          <td style={{ padding: "6px 0", textAlign: "right" }}>
                            <span className={`pill p-${cls(stItem)}`} style={{ fontSize: 11, padding: "2px 8px" }}>
                              {LBL[stItem]}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="r2">
              <label>Dívida (R$)<input value={t} onChange={e => setT(e.target.value)} inputMode="decimal" placeholder="0,00" required /></label>
              <label>Valor pago (R$)<input value={g} onChange={e => setG(e.target.value)} inputMode="decimal" placeholder="0,00" /></label>
            </div>
            <div className="r2">
              <label>Parcelas<input value={i} onChange={e => setI(e.target.value)} maxLength={40} placeholder="ex.: 1/3" /></label>
              <label>Vencimento<input type="date" value={d} onChange={e => setD(e.target.value)} /></label>
            </div>
            <div className="prev">
              <span>Saldo <b className="mono">{ok ? money(Math.max(T - G, 0)) : "—"}</b></span>
              {st && !row?.fundo_perdido && <span className={`pill p-${cls(st)}`}>{LBL[st]}</span>}
            </div>
          </>
        )}

        <div className="err">{err}</div>
        <div className="r2">
          <button type="button" className="btn ghost" onClick={onClose}>Cancelar</button>
          <button className="btn" disabled={busy}>
            {busy ? "Salvando…" : isNova && qtd > 1 ? `Salvar (${qtd} promissórias)` : "Salvar"}
          </button>
        </div>
      </form>
    </Painel>
  );
}

/** Marcar como fundo perdido (exige motivo) ou desfazer. Só administradores (também validado no banco). */
export function PerdidoDialog({ row, onClose, onDone }: { row: Row; onClose: () => void; onDone: () => void }) {
  const desfazer = row.fundo_perdido;
  const [motivo, setMotivo] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  async function go(e: FormEvent) {
    e.preventDefault();
    if (!desfazer && motivo.trim().length < 3) return setErr("Informe o motivo (mínimo 3 caracteres).");
    setBusy(true);
    const { error } = desfazer
      ? await supabase.rpc("desfazer_fundo_perdido", { p_id: row.id, p_motivo: motivo || null })
      : await supabase.rpc("marcar_fundo_perdido", { p_id: row.id, p_motivo: motivo });
    setBusy(false);
    if (error) return setErr(error.message);
    onDone();
  }
  return (
    <Painel onClose={onClose}>
      <form onSubmit={go}>
        <h2 style={{ margin: 0 }}>{desfazer ? "Desfazer fundo perdido" : "Marcar como fundo perdido"}</h2>
        <div><b>{row.cliente_nome}</b><div className="sub">Saldo {money(row.saldo_devedor)} · venc. {dt(row.vencimento)}</div></div>
        {desfazer
          ? <div className="sub">Registrado em {row.fundo_perdido_em ? dt(row.fundo_perdido_em.slice(0, 10)) : "—"}. Motivo: {row.fundo_perdido_motivo}. O saldo volta a ser contado como a receber.</div>
          : <div className="sub">O valor sai do saldo a receber e dos alertas, mas continua no histórico. A baixa pode ser desfeita.</div>}
        <label>{desfazer ? "Observação (opcional)" : "Motivo"}
          <textarea rows={3} value={motivo} onChange={e => setMotivo(e.target.value)} maxLength={300} />
        </label>
        <div className="err">{err}</div>
        <div className="r2">
          <button type="button" className="btn ghost" onClick={onClose}>Cancelar</button>
          <button className="btn" disabled={busy}>{busy ? "Salvando…" : desfazer ? "Desfazer" : "Confirmar"}</button>
        </div>
      </form>
    </Painel>
  );
}

/** Cobrança via link wa.me: o usuário revisa a mensagem e envia manualmente no WhatsApp. */
export function WhatsDialog({ nome, telefone, mensagem, onClose }: { nome: string; telefone: string; mensagem: string; onClose: () => void }) {
  const [ddd, setDdd] = useState(getDDD());
  const [msg, setMsg] = useState(mensagem);
  const nums = normalizarTelefones(telefone, ddd);
  const [sel, setSel] = useState(0);
  const numero = nums[Math.min(sel, nums.length - 1)];
  return (
    <Painel onClose={onClose}>
      <div style={{ padding: 20, display: "grid", gap: 12 }}>
        <h2 style={{ margin: 0 }}>Cobrança por WhatsApp</h2>
        <div><b>{nome}</b><div className="sub">Telefone cadastrado: {telefone || "—"}</div></div>
        <label>DDD padrão (para números sem DDD)
          <input value={ddd} maxLength={2} inputMode="numeric" style={{ width: 80 }}
            onChange={e => { const v = e.target.value.replace(/\D/g, ""); setDdd(v); if (v.length === 2) setDDD(v); }} />
        </label>
        {nums.length > 1 && (
          <label>Número
            <select value={sel} onChange={e => setSel(Number(e.target.value))}>
              {nums.map((x, k) => <option key={x} value={k}>{formatarTelefone(x)}</option>)}
            </select>
          </label>
        )}
        {nums.length === 1 && <div className="sub">Enviar para <b className="mono">{formatarTelefone(nums[0])}</b></div>}
        {!nums.length && <div className="err">Telefone inválido ou ausente. Corrija o cadastro para enviar.</div>}
        <label>Mensagem (revise antes de enviar)
          <textarea rows={11} value={msg} onChange={e => setMsg(e.target.value)} />
        </label>
        <div className="r2">
          <button type="button" className="btn ghost" onClick={onClose}>Fechar</button>
          {numero
            ? <a className="btn" style={{ textAlign: "center", textDecoration: "none" }} href={linkWhatsApp(numero, msg)} target="_blank" rel="noopener noreferrer">Abrir WhatsApp</a>
            : <button className="btn" disabled>Abrir WhatsApp</button>}
        </div>
        <div className="sub">O WhatsApp abre com a mensagem pronta; o envio é feito por você.</div>
      </div>
    </Painel>
  );
}

/** Exibe a ficha completa com todas as promissórias cadastradas do cliente em uma gaveta lateral. */
export function FichaCliente({
  cliente,
  telefone,
  isAdmin = false,
  onClose,
  onChanged,
}: {
  cliente: string;
  telefone?: string;
  isAdmin?: boolean;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [err, setErr] = useState("");
  const [baixa, setBaixa] = useState<Row | null>(null);
  const [editing, setEditing] = useState<Row | undefined>(undefined);
  const [perdido, setPerdido] = useState<Row | null>(null);
  const [whats, setWhats] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("cliente_promissorias", { p_cliente: cliente });
    if (error) setErr(error.message);
    else setRows((data ?? []) as Row[]);
  }, [cliente]);

  useEffect(() => {
    load();
  }, [load]);

  const tel = telefone || rows.find(r => r.telefone)?.telefone || "";
  const abertos = rows.filter(r => !r.fundo_perdido && r.saldo_devedor > 0);
  const tot = rows.reduce(
    (a, r) => ({
      d: a.d + r.divida_total,
      p: a.p + r.valor_pago,
      s: a.s + (r.fundo_perdido ? 0 : r.saldo_devedor),
      f: a.f + (r.fundo_perdido ? r.saldo_devedor : 0),
    }),
    { d: 0, p: 0, s: 0, f: 0 }
  );

  const refresh = () => {
    load();
    onChanged?.();
  };

  return (
    <Painel onClose={onClose} wide>
      <div style={{ padding: 20, display: "grid", gap: 14 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "start", flexWrap: "wrap" }}>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0 }}>{cliente}</h2>
            <div className="sub mono">{tel || "Sem telefone"}</div>
          </div>
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
            <thead>
              <tr><th>Vencimento</th><th>Parcelas</th><th className="n">Dívida</th><th className="n">Pago</th><th className="n">Saldo</th><th>Status</th><th /></tr>
            </thead>
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
                    {isAdmin && !r.fundo_perdido && r.saldo_devedor > 0 && (
                      <button className="btn-baixa" onClick={() => setBaixa(r)} title="Registrar baixa / pagamento">
                        Baixar
                      </button>
                    )}
                    {isAdmin && <button className="ed" onClick={() => setEditing(r)}>Editar</button>}
                    {isAdmin && (r.fundo_perdido || r.saldo_devedor > 0) && <button className="ed" onClick={() => setPerdido(r)}>{r.fundo_perdido ? "Desfazer" : "Fundo perdido"}</button>}
                  </td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={7} style={{ textAlign: "center", color: "var(--mut)", padding: 20 }}>Nenhuma promissória encontrada para este cliente.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {baixa && <BaixaDialog row={baixa} onClose={() => setBaixa(null)} onSaved={() => { setBaixa(null); refresh(); }} />}
      {editing && <Editor row={editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); refresh(); }} />}
      {perdido && <PerdidoDialog row={perdido} onClose={() => setPerdido(null)} onDone={() => { setPerdido(null); refresh(); }} />}
      {whats && <WhatsDialog nome={cliente} telefone={tel} mensagem={mensagemCobranca(cliente, abertos.map(r => ({ valor: r.saldo_devedor, vencimento: r.vencimento })))} onClose={() => setWhats(false)} />}
    </Painel>
  );
}

/**
 * Modal para dar baixa em uma promissória com possibilidade de informar valor diferente
 * do calculado e recalcular automaticamente as promissórias restantes dividindo o saldo em aberto.
 */
export function BaixaDialog({
  row,
  onClose,
  onSaved,
}: {
  row: Row;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [valorStr, setValorStr] = useState(toBRL(row.saldo_devedor));
  const [outras, setOutras] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [selecionadas, setSelecionadas] = useState<Set<number>>(new Set());
  const [recalcular, setRecalcular] = useState(true);
  const [opcaoSemRestantes, setOpcaoSemRestantes] = useState<"abater" | "quitar">("abater");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // Carregar outras promissórias em aberto do cliente
  useEffect(() => {
    let active = true;
    async function carregar() {
      setLoading(true);
      const { data, error } = await supabase
        .from("promissorias")
        .select("*")
        .eq("cliente_nome", row.cliente_nome)
        .eq("fundo_perdido", false)
        .gt("saldo_devedor", 0)
        .neq("id", row.id)
        .order("vencimento", { ascending: true })
        .order("id", { ascending: true });

      if (!active) return;
      setLoading(false);
      if (error) {
        setErr("Não foi possível carregar as outras promissórias: " + error.message);
        return;
      }

      const lista = (data || []) as Row[];
      setOutras(lista);

      // Prioriza selecionar promissórias do mesmo carnê (ex: "/3") com vencimento igual ou posterior
      const m = row.parcelas?.match(/(\d+)\/(\d+)/);
      if (m) {
        const totalCarnê = m[2];
        const doMesmoCarnê = lista.filter(r => r.parcelas?.includes(`/${totalCarnê}`));
        if (doMesmoCarnê.length > 0) {
          setSelecionadas(new Set(doMesmoCarnê.map(r => r.id)));
          return;
        }
      }
      // Se não identificar formato X/Y específico, seleciona todas as outras em aberto
      setSelecionadas(new Set(lista.map(r => r.id)));
    }

    carregar();
    return () => { active = false; };
  }, [row]);

  const V = parse(valorStr);
  const ok = !isNaN(V) && V >= 0;

  const parcelasRateio = useMemo(
    () => outras.filter(r => selecionadas.has(r.id)),
    [outras, selecionadas]
  );

  const temRateio = recalcular && parcelasRateio.length > 0;

  // Saldo devedor total somando a promissória atual + as promissórias selecionadas
  const saldoTotalGrupo = useMemo(() => {
    return row.saldo_devedor + (temRateio ? parcelasRateio.reduce((acc, r) => acc + r.saldo_devedor, 0) : 0);
  }, [row.saldo_devedor, temRateio, parcelasRateio]);

  // Saldo que restará para dividir após o pagamento atual
  const saldoRestante = Math.max(0, saldoTotalGrupo - (ok ? V : 0));

  // Simulação do novo valor para cada promissória restante
  const simulacao = useMemo(() => {
    if (!temRateio || !ok || parcelasRateio.length === 0) return [];
    const k = parcelasRateio.length;
    const base = Math.floor(saldoRestante / k);
    const resto = saldoRestante % k;

    return parcelasRateio.map((item, idx) => {
      const novoSaldo = base + (idx === 0 ? resto : 0);
      return {
        ...item,
        saldoAnterior: item.saldo_devedor,
        novoSaldo,
        diferenca: novoSaldo - item.saldo_devedor,
      };
    });
  }, [temRateio, ok, parcelasRateio, saldoRestante]);

  function toggleSelecionada(id: number) {
    setSelecionadas(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ok) return setErr("Informe um valor monetário válido.");
    if (V <= 0) return setErr("O valor pago deve ser maior que zero.");
    if (V > saldoTotalGrupo) {
      return setErr(`O valor informado (${money(V)}) não pode ser maior que o saldo total (${money(saldoTotalGrupo)}).`);
    }

    setBusy(true);
    setErr("");

    try {
      if (temRateio) {
        // 1. Quitar a promissória atual com o valor recebido nesta baixa
        const novaDividaAtual = row.valor_pago + V;
        const { error: errAtual } = await supabase
          .from("promissorias")
          .update({
            divida_total: novaDividaAtual,
            valor_pago: novaDividaAtual,
          })
          .eq("id", row.id);

        if (errAtual) throw new Error("Erro ao baixar promissória: " + errAtual.message);

        // 2. Atualizar cada uma das promissórias restantes com o novo valor recalculado
        for (const item of simulacao) {
          const novaDivida = item.valor_pago + item.novoSaldo;
          const { error: errFilha } = await supabase
            .from("promissorias")
            .update({
              divida_total: novaDivida,
            })
            .eq("id", item.id);

          if (errFilha) throw new Error(`Erro ao atualizar parcela ${item.parcelas}: ` + errFilha.message);
        }
      } else {
        // Baixa individual sem rateio
        if (parcelasRateio.length === 0 && V < row.saldo_devedor && opcaoSemRestantes === "quitar") {
          // Quitação total com desconto
          const novaDivida = row.valor_pago + V;
          const { error } = await supabase
            .from("promissorias")
            .update({
              divida_total: novaDivida,
              valor_pago: novaDivida,
            })
            .eq("id", row.id);
          if (error) throw new Error(error.message);
        } else {
          // Abate de valor
          const novoPago = row.valor_pago + V;
          const { error } = await supabase
            .from("promissorias")
            .update({
              valor_pago: novoPago,
            })
            .eq("id", row.id);
          if (error) throw new Error(error.message);
        }
      }

      setBusy(false);
      onSaved();
    } catch (e: any) {
      setBusy(false);
      setErr(e.message || "Erro ao registrar baixa.");
    }
  }

  const isDiferente = ok && V !== row.saldo_devedor;

  return (
    <Painel onClose={onClose} wide={temRateio}>
      <form onSubmit={submit} autoComplete="off">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, color: "var(--ink)" }}>Dar Baixa / Pagamento</h2>
          <span className="pill" style={{ background: "#15803d15", color: "#15803d", borderColor: "#15803d" }}>
            Operação de Caixa
          </span>
        </div>

        <div style={{ background: "var(--soft)", padding: "12px 14px", borderRadius: 10, border: "1px solid var(--line)" }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{row.cliente_nome}</div>
          <div className="sub mono" style={{ marginTop: 2 }}>{row.telefone || "Sem telefone"}</div>
          <div style={{ display: "flex", gap: 14, marginTop: 8, fontSize: 13, flexWrap: "wrap" }}>
            <span>Parcela: <b>{row.parcelas || "1X"}</b></span>
            <span>Vencimento: <b>{dt(row.vencimento)}</b></span>
            <span>Saldo original da parcela: <b className="mono">{money(row.saldo_devedor)}</b></span>
          </div>
        </div>

        <label style={{ marginTop: 4 }}>
          <span style={{ fontWeight: 700, color: "var(--ink)", fontSize: 14 }}>
            Valor recebido nesta baixa (R$)
          </span>
          <input
            value={valorStr}
            onChange={e => setValorStr(e.target.value)}
            inputMode="decimal"
            placeholder="0,00"
            style={{ fontSize: 18, fontWeight: 600, padding: "10px 12px" }}
            autoFocus
            required
          />
          <span className="sub">
            {isDiferente
              ? V > row.saldo_devedor
                ? `Valor recebido é R$ ${(Math.abs(V - row.saldo_devedor) / 100).toFixed(2)} MAIOR que o valor calculado da parcela.`
                : `Valor recebido é R$ ${(Math.abs(V - row.saldo_devedor) / 100).toFixed(2)} MENOR que o valor calculado da parcela.`
              : "Valor exato do vencimento calculado."}
          </span>
        </label>

        {loading ? (
          <div className="sub" style={{ padding: 10 }}>Buscando outras promissórias do cliente…</div>
        ) : outras.length > 0 ? (
          <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12, display: "grid", gap: 10 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>
              <input
                type="checkbox"
                checked={recalcular}
                onChange={e => setRecalcular(e.target.checked)}
                style={{ width: 18, height: 18, accentColor: "#15803d" }}
              />
              Recalcular e ratear o saldo restante nas demais promissórias ({outras.length} em aberto)
            </label>

            {recalcular && (
              <>
                <div className="sub">
                  Selecione quais promissórias futuras devem absorver a diferença do saldo:
                </div>
                <div
                  style={{
                    background: "var(--card)",
                    border: "1px solid var(--line)",
                    borderRadius: 10,
                    overflow: "hidden",
                    maxHeight: 240,
                    overflowY: "auto",
                  }}
                >
                  <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ background: "var(--soft)", color: "var(--mut)", fontSize: 11 }}>
                        <th style={{ width: 34, padding: "6px 8px" }} />
                        <th style={{ textAlign: "left", padding: "6px 8px" }}>PARCELA</th>
                        <th style={{ textAlign: "left", padding: "6px 8px" }}>VENCIMENTO</th>
                        <th style={{ textAlign: "right", padding: "6px 8px" }}>SALDO ATUAL</th>
                        <th style={{ textAlign: "right", padding: "6px 8px" }}>NOVO VALOR</th>
                      </tr>
                    </thead>
                    <tbody>
                      {outras.map(r => {
                        const sel = selecionadas.has(r.id);
                        const itemSim = simulacao.find(s => s.id === r.id);
                        return (
                          <tr
                            key={r.id}
                            style={{
                              borderTop: "1px solid var(--line)",
                              background: sel ? "transparent" : "var(--soft)",
                              opacity: sel ? 1 : 0.6,
                            }}
                          >
                            <td style={{ padding: "6px 8px", textAlign: "center" }}>
                              <input
                                type="checkbox"
                                checked={sel}
                                onChange={() => toggleSelecionada(r.id)}
                                style={{ accentColor: "#15803d" }}
                              />
                            </td>
                            <td style={{ padding: "6px 8px", fontWeight: 600 }}>{r.parcelas || "—"}</td>
                            <td style={{ padding: "6px 8px" }}>{dt(r.vencimento)}</td>
                            <td style={{ padding: "6px 8px", textAlign: "right" }} className="mono">{money(r.saldo_devedor)}</td>
                            <td style={{ padding: "6px 8px", textAlign: "right" }} className="mono">
                              {sel && itemSim ? (
                                <b style={{ color: itemSim.diferenca !== 0 ? (itemSim.diferenca > 0 ? "var(--bad)" : "var(--brand)") : "inherit" }}>
                                  {money(itemSim.novoSaldo)}
                                </b>
                              ) : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Resumo do recálculo */}
                {parcelasRateio.length > 0 && ok && (
                  <div
                    style={{
                      background: "var(--soft)",
                      borderRadius: 10,
                      padding: "10px 14px",
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: 8,
                      fontSize: 13,
                    }}
                  >
                    <div>
                      <span className="sub">Dívida total antes:</span>
                      <div className="mono" style={{ fontWeight: 600 }}>{money(saldoTotalGrupo)}</div>
                    </div>
                    <div>
                      <span className="sub">Valor pago agora:</span>
                      <div className="mono" style={{ fontWeight: 600, color: "#15803d" }}>- {money(V)}</div>
                    </div>
                    <div>
                      <span className="sub">Saldo restante:</span>
                      <div className="mono" style={{ fontWeight: 700 }}>{money(saldoRestante)}</div>
                    </div>
                    <div>
                      <span className="sub">Novo valor por parcela ({parcelasRateio.length}x):</span>
                      <div className="mono" style={{ fontWeight: 700, color: "var(--brand)" }}>
                        ~ {money(simulacao[0]?.novoSaldo || 0)}
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          /* Sem outras promissórias abertas */
          ok && V < row.saldo_devedor && (
            <div style={{ background: "var(--soft)", padding: 12, borderRadius: 10, border: "1px solid var(--line)" }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                O valor pago é menor que o saldo devedor ({money(row.saldo_devedor)}). Como deseja registrar?
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                <input
                  type="radio"
                  name="opcaoSemRestantes"
                  checked={opcaoSemRestantes === "abater"}
                  onChange={() => setOpcaoSemRestantes("abater")}
                />
                Abater pagamento (continua em aberto com saldo de {money(row.saldo_devedor - V)})
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, marginTop: 4 }}>
                <input
                  type="radio"
                  name="opcaoSemRestantes"
                  checked={opcaoSemRestantes === "quitar"}
                  onChange={() => setOpcaoSemRestantes("quitar")}
                />
                Quitar promissória (conceder desconto e finalizar)
              </label>
            </div>
          )
        )}

        <div className="err">{err}</div>

        <div className="r2">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button
            className="btn"
            style={{ background: "#15803d", borderColor: "#15803d", color: "#fff" }}
            disabled={busy || !ok || V <= 0}
          >
            {busy ? "Gravando…" : temRateio ? "Confirmar Baixa e Recalcular" : "Confirmar Baixa"}
          </button>
        </div>
      </form>
    </Painel>
  );
}
