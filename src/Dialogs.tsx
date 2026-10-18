import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { supabase } from "./supabase";
import {
  LBL, alerta, alertaTexto, cls, derive, deriveStatus, dt, dtHora, formatarTelefone,
  getDDD, hoje, linkWhatsApp, mascaraTelefone, mensagemCobranca, mensagemComprovanteBaixa, money, normalizarTelefones, parse, setDDD, somaDias, toBRL
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

  const saldoAParcelar = Math.max(0, T - G);

  // Cálculo e divisão das promissórias (a cada 30 dias após o 1º vencimento)
  // A entrada é abatida da dívida total antes da divisão entre as promissórias
  const parcelasCalculadas = useMemo(() => {
    if (!isNova || !ok || T <= 0 || qtd <= 0 || saldoAParcelar <= 0) return [];
    const base = Math.floor(saldoAParcelar / qtd);
    const resto = saldoAParcelar % qtd;

    return Array.from({ length: qtd }, (_, idx) => {
      const num = idx + 1;
      const valor = base + (idx === 0 ? resto : 0);
      const vencimento = d ? somaDias(d, idx * 30) : null;
      const rotulo = qtd === 1 ? "1X" : `${num}/${qtd}`;

      return {
        numero: num,
        parcela: rotulo,
        valor,
        pago: 0,
        saldo: valor,
        vencimento,
      };
    });
  }, [isNova, ok, T, qtd, saldoAParcelar, d]);

  const st = ok ? derive(T, G, d) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (n.trim().length < 2) return setErr("Informe o nome do cliente.");
    if (!ok) return setErr("Valores devem ser monetários e não negativos.");
    if (isNova && G >= T) return setErr("O valor da entrada não pode ser igual ou maior que o valor total da dívida.");
    if (isNova && parcelasCalculadas.length === 0) return setErr("Informe um valor total válido a parcelar.");
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

            {/* Aviso caso a entrada cubra ou ultrapasse a dívida */}
            {ok && T > 0 && G >= T && (
              <div style={{ background: "rgba(239, 68, 68, 0.1)", color: "#b91c1c", padding: "8px 12px", borderRadius: 8, fontSize: 12, marginTop: 6, fontWeight: 500 }}>
                A entrada ({money(G)}) é igual ou superior ao valor total ({money(T)}). Nenhuma promissória a parcelar.
              </div>
            )}

            {/* Pré-visualização de todas as promissórias calculadas */}
            {parcelasCalculadas.length > 0 && (
              <div
                style={{
                  background: "var(--soft)",
                  borderRadius: 10,
                  padding: "12px 14px",
                  border: "1px solid var(--line)",
                  marginTop: 6,
                  maxHeight: 220,
                  overflowY: "auto",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: G > 0 ? 4 : 8, fontSize: 12, fontWeight: 700, color: "var(--mut)" }}>
                  <span>PROMISSÓRIAS CALCULADAS ({qtd}x)</span>
                  <span>A CADA 30 DIAS</span>
                </div>
                {G > 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 11, color: "var(--mut)", background: "rgba(0,0,0,0.03)", padding: "4px 8px", borderRadius: 6 }}>
                    <span>Entrada: <strong style={{ color: "var(--fg)" }}>{money(G)}</strong></span>
                    <span>Saldo a parcelar: <strong className="mono" style={{ color: "var(--fg)" }}>{money(saldoAParcelar)}</strong></span>
                  </div>
                )}
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
  const [logRow, setLogRow] = useState<Row | null>(null);
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
                    {r.valor_pago > 0 && (
                      <button className="ed" onClick={() => setLogRow(r)} title="Ver histórico e auditoria de pagamento">
                        Ver log
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
      {logRow && <LogDialog row={logRow} onClose={() => setLogRow(null)} />}
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
  const [comprovante, setComprovante] = useState<{
    mensagem: string;
    telefone: string;
    nome: string;
  } | null>(null);
  const [msgEditavel, setMsgEditavel] = useState("");
  const [ddd, setDdd] = useState(getDDD());
  const [selTel, setSelTel] = useState(0);
  const [copiado, setCopiado] = useState(false);
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
      // Obter dados do operador autenticado para auditoria
      const { data: userData } = await supabase.auth.getUser();
      const operadorEmail = userData.user?.email || "operador@leoticas.fin";
      const operadorId = userData.user?.id || null;
      const agoraIso = new Date().toISOString();

      const detalhesOp = temRateio
        ? `Baixa quitada com recálculo e rateio de ${money(saldoRestante)} em ${parcelasRateio.length} parcela(s) restante(s).`
        : (parcelasRateio.length === 0 && V < row.saldo_devedor && opcaoSemRestantes === "quitar"
          ? `Quitação com desconto concedido (pago ${money(V)} de saldo ${money(row.saldo_devedor)}).`
          : (V < row.saldo_devedor
            ? `Abate parcial de ${money(V)}. Saldo restante: ${money(row.saldo_devedor - V)}.`
            : `Quitação integral no valor de ${money(V)}.`));

      // 1. Tentar gravar na tabela dedicada promissoria_pagamentos
      try {
        await supabase.from("promissoria_pagamentos").insert({
          promissoria_id: row.id,
          valor_pago: V,
          operador_email: operadorEmail,
          operador_id: operadorId,
          data_pagamento: agoraIso,
          detalhes: detalhesOp,
        });
      } catch (_) {}

      // 2. Preparar array de logs serializado para salvar em origem como redundância imediata
      let logsArray: any[] = [];
      if (row.origem) {
        try {
          const parsed = JSON.parse(row.origem);
          if (Array.isArray(parsed)) logsArray = parsed;
        } catch (_) {}
      }
      logsArray.push({
        data: agoraIso,
        valor: V,
        operador: operadorEmail,
        detalhes: detalhesOp,
      });
      const origemComLogs = JSON.stringify(logsArray);

      if (temRateio) {
        // 1. Quitar a promissória atual com o valor recebido nesta baixa
        const novaDividaAtual = row.valor_pago + V;
        const { error: errAtual } = await supabase
          .from("promissorias")
          .update({
            divida_total: novaDividaAtual,
            valor_pago: novaDividaAtual,
            origem: origemComLogs,
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
              origem: origemComLogs,
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
              origem: origemComLogs,
            })
            .eq("id", row.id);
          if (error) throw new Error(error.message);
        }
      }

      // Calcular saldo restante e gerar mensagem de comprovante para o WhatsApp
      const valorRestanteFinal = temRateio
        ? saldoRestante
        : (parcelasRateio.length === 0 && V < row.saldo_devedor && opcaoSemRestantes === "quitar"
          ? 0
          : Math.max(0, row.saldo_devedor - V));

      const proximasParcelasInfo = temRateio && saldoRestante > 0
        ? simulacao.map(item => ({ parcela: item.parcelas, valor: item.novoSaldo, vencimento: item.vencimento }))
        : undefined;

      const textoComprovante = mensagemComprovanteBaixa({
        nome: row.cliente_nome,
        valorPago: V,
        parcela: row.parcelas || "1X",
        valorRestante: valorRestanteFinal,
        dataPagamento: dtHora(agoraIso),
        proximasParcelas: proximasParcelasInfo,
      });

      setMsgEditavel(textoComprovante);
      setComprovante({
        mensagem: textoComprovante,
        telefone: row.telefone,
        nome: row.cliente_nome,
      });
      setBusy(false);
    } catch (e: any) {
      setBusy(false);
      setErr(e.message || "Erro ao registrar baixa.");
    }
  }

  // Tela de Comprovante de Pagamento (WhatsApp)
  if (comprovante) {
    const nums = normalizarTelefones(comprovante.telefone, ddd);
    const numero = nums[Math.min(selTel, nums.length - 1)];

    return (
      <Painel onClose={() => { onClose(); onSaved(); }}>
        <div style={{ padding: 20, display: "grid", gap: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ margin: 0, color: "var(--ink)", display: "flex", alignItems: "center", gap: 8 }}>
              <span>Comprovante WhatsApp</span>
            </h2>
            <span className="pill" style={{ background: "#15803d15", color: "#15803d", borderColor: "#15803d" }}>
              ✓ Baixa efetuada
            </span>
          </div>

          <div style={{ background: "#15803d15", border: "1px solid #15803d40", borderRadius: 10, padding: "10px 14px", fontSize: 13, color: "var(--ink)" }}>
            <b>Baixa registrada com sucesso!</b> O comprovante foi gerado automaticamente para envio ao WhatsApp do pagador.
          </div>

          <div>
            <b>{comprovante.nome}</b>
            <div className="sub mono">Telefone cadastrado: {comprovante.telefone || "—"}</div>
          </div>

          <label>DDD padrão (para números sem DDD)
            <input
              value={ddd}
              maxLength={2}
              inputMode="numeric"
              style={{ width: 80 }}
              onChange={e => {
                const val = e.target.value.replace(/\D/g, "");
                setDdd(val);
                if (val.length === 2) setDDD(val);
              }}
            />
          </label>

          {nums.length > 1 && (
            <label>Selecione o número de WhatsApp
              <select value={selTel} onChange={e => setSelTel(Number(e.target.value))}>
                {nums.map((x, k) => <option key={x} value={k}>{formatarTelefone(x)}</option>)}
              </select>
            </label>
          )}

          {nums.length === 1 && (
            <div className="sub">Enviar para <b className="mono">{formatarTelefone(nums[0])}</b></div>
          )}

          {!nums.length && (
            <div className="err">Nenhum telefone válido encontrado. Você pode copiar a mensagem abaixo para enviar manualmente.</div>
          )}

          <label>Mensagem do comprovante (revise ou edite antes de enviar):
            <textarea
              rows={12}
              value={msgEditavel}
              onChange={e => setMsgEditavel(e.target.value)}
              style={{ fontSize: 13, lineHeight: 1.45 }}
            />
          </label>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "space-between", alignItems: "center" }}>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                navigator.clipboard.writeText(msgEditavel);
                setCopiado(true);
                setTimeout(() => setCopiado(false), 2500);
              }}
            >
              {copiado ? "✓ Mensagem copiada!" : "Copiar mensagem"}
            </button>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  onClose();
                  onSaved();
                }}
              >
                Concluir
              </button>
              {numero ? (
                <a
                  className="btn"
                  style={{
                    background: "#15803d",
                    borderColor: "#15803d",
                    color: "#fff",
                    textDecoration: "none",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                  href={linkWhatsApp(numero, msgEditavel)}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => {
                    setTimeout(() => {
                      onClose();
                      onSaved();
                    }, 500);
                  }}
                >
                  Abrir WhatsApp
                </a>
              ) : (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    onClose();
                    onSaved();
                  }}
                >
                  Concluir
                </button>
              )}
            </div>
          </div>
        </div>
      </Painel>
    );
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

/**
 * Modal para visualizar o histórico de auditoria e logs de baixa da promissória:
 * data, valor pago, operador autenticado e detalhes da operação.
 */
export function LogDialog({
  row,
  onClose,
}: {
  row: Row;
  onClose: () => void;
}) {
  const [logs, setLogs] = useState<{
    id?: number;
    data: string;
    valor: number;
    operador: string;
    detalhes?: string;
  }[]>([]);
  const [loading, setLoading] = useState(true);
  const [whatsLog, setWhatsLog] = useState<string | null>(null);

  useEffect(() => {
    async function carregarLogs() {
      setLoading(true);
      const lista: {
        id?: number;
        data: string;
        valor: number;
        operador: string;
        detalhes?: string;
      }[] = [];

      // 1. Tentar ler da tabela promissoria_pagamentos
      try {
        const { data, error } = await supabase
          .from("promissoria_pagamentos")
          .select("*")
          .eq("promissoria_id", row.id)
          .order("data_pagamento", { ascending: false });

        if (!error && data && data.length > 0) {
          for (const p of data) {
            lista.push({
              id: p.id,
              data: p.data_pagamento || p.created_at,
              valor: p.valor_pago,
              operador: p.operador_email || "Operador",
              detalhes: p.detalhes,
            });
          }
        }
      } catch (_) {}

      // 2. Tentar ler do JSON armazenado em row.origem
      if (row.origem) {
        try {
          const parsed = JSON.parse(row.origem);
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              const jaExiste = lista.some(
                x => Math.abs(new Date(x.data).getTime() - new Date(item.data).getTime()) < 3000 && x.valor === item.valor
              );
              if (!jaExiste) {
                lista.push({
                  data: item.data,
                  valor: item.valor,
                  operador: item.operador,
                  detalhes: item.detalhes,
                });
              }
            }
          }
        } catch (_) {}
      }

      // Ordenar do mais recente para o mais antigo
      lista.sort((a, b) => new Date(b.data).getTime() - new Date(a.data).getTime());
      setLogs(lista);
      setLoading(false);
    }

    carregarLogs();
  }, [row]);

  return (
    <Painel onClose={onClose} wide>
      <div style={{ padding: 20, display: "grid", gap: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", flexWrap: "wrap", gap: 10 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h2 style={{ margin: 0 }}>Histórico de Auditoria da Promissória</h2>
              <StatusPill r={row} />
            </div>
            <div className="sub" style={{ marginTop: 4 }}>
              Registro de todas as baixas com data, valor e operador responsável
            </div>
          </div>
          <button className="btn ghost" onClick={onClose}>Fechar</button>
        </div>

        {/* Card com resumo da promissória */}
        <div style={{ background: "var(--soft)", padding: "12px 16px", borderRadius: 10, border: "1px solid var(--line)", display: "grid", gap: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <div>
              <span className="sub">Cliente:</span>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{row.cliente_nome}</div>
            </div>
            <div>
              <span className="sub">Telefone:</span>
              <div className="mono">{row.telefone || "—"}</div>
            </div>
            <div>
              <span className="sub">Parcela:</span>
              <div style={{ fontWeight: 600 }}>{row.parcelas || "1X"}</div>
            </div>
            <div>
              <span className="sub">Vencimento:</span>
              <div className="mono">{dt(row.vencimento)}</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 20, marginTop: 4, borderTop: "1px solid var(--line)", paddingTop: 8, fontSize: 13, flexWrap: "wrap" }}>
            <span>Dívida original: <b className="mono">{money(row.divida_total)}</b></span>
            <span>Total pago: <b className="mono" style={{ color: "#15803d" }}>{money(row.valor_pago)}</b></span>
            <span>Saldo devedor: <b className="mono">{money(row.saldo_devedor)}</b></span>
          </div>
        </div>

        {/* Lista de Registros */}
        <div>
          <h3 style={{ margin: "8px 0 10px", fontSize: 15 }}>Registros de Auditoria</h3>
          {loading ? (
            <div className="sub" style={{ padding: 14 }}>Carregando histórico de auditoria…</div>
          ) : logs.length > 0 ? (
            <div style={{ display: "grid", gap: 10 }}>
              {logs.map((item, idx) => (
                <div
                  key={idx}
                  style={{
                    background: "var(--card)",
                    border: "1px solid var(--line)",
                    borderRadius: 10,
                    padding: "12px 16px",
                    display: "grid",
                    gap: 6,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#15803d", background: "#15803d15", padding: "3px 10px", borderRadius: 99 }}>
                        Baixa de {money(item.valor)}
                      </span>
                      <span className="mono" style={{ fontSize: 13, color: "var(--ink)", fontWeight: 600 }}>
                        {dtHora(item.data)}
                      </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <div style={{ fontSize: 12, color: "var(--mut)" }}>
                        Operador: <b style={{ color: "var(--ink)" }}>{item.operador}</b>
                      </div>
                      <button
                        type="button"
                        className="ed"
                        style={{ fontSize: 11, padding: "2px 8px" }}
                        title="Enviar comprovante deste pagamento por WhatsApp"
                        onClick={() => {
                          const msg = mensagemComprovanteBaixa({
                            nome: row.cliente_nome,
                            valorPago: item.valor,
                            parcela: row.parcelas || "1X",
                            valorRestante: row.saldo_devedor,
                            dataPagamento: dtHora(item.data),
                          });
                          setWhatsLog(msg);
                        }}
                      >
                        Comprovante WhatsApp
                      </button>
                    </div>
                  </div>
                  {item.detalhes && (
                    <div className="sub" style={{ fontSize: 13, color: "var(--mut)", marginTop: 2 }}>
                      {item.detalhes}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div
              style={{
                background: "var(--soft)",
                border: "1px dashed var(--line)",
                borderRadius: 10,
                padding: "18px 20px",
                textAlign: "center",
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
                Nenhum log detalhado encontrado
              </div>
              <div className="sub" style={{ fontSize: 13 }}>
                {row.valor_pago > 0
                  ? `Esta promissória possui R$ ${(row.valor_pago / 100).toFixed(2)} registrado como pago no cadastro (${row.origem || "SISTEMA ANTERIOR"}). Todas as baixas realizadas no sistema registram data, valor e operador automaticamente nesta aba.`
                  : "Nenhum pagamento foi registrado para esta promissória ainda."}
              </div>
            </div>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
          <button className="btn ghost" onClick={onClose}>Fechar</button>
        </div>
      </div>
      {whatsLog && (
        <WhatsDialog
          nome={row.cliente_nome}
          telefone={row.telefone}
          mensagem={whatsLog}
          onClose={() => setWhatsLog(null)}
        />
      )}
    </Painel>
  );
}
