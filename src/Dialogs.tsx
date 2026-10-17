import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { supabase } from "./supabase";
import {
  LBL, alerta, alertaTexto, cls, derive, deriveStatus, dt, formatarTelefone,
  getDDD, linkWhatsApp, mascaraTelefone, mensagemCobranca, money, normalizarTelefones, parse, setDDD, toBRL
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
  const [i, setI] = useState(row?.parcelas ?? "");
  const [d, setD] = useState(row?.vencimento ?? "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const T = parse(t), G = parse(g), ok = !isNaN(T) && !isNaN(G);
  const st = ok ? derive(T, G, d) : null;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (n.trim().length < 2) return setErr("Informe o nome do cliente.");
    if (!ok) return setErr("Valores devem ser monetários e não negativos.");
    setBusy(true);
    const payload = { cliente_nome: n.trim(), telefone: p.trim(), divida_total: T, parcelas: i.trim(), valor_pago: G, vencimento: d || null };
    const { error } = row
      ? await supabase.from("promissorias").update(payload).eq("id", row.id)
      : await supabase.from("promissorias").insert(payload);
    setBusy(false);
    if (error) return setErr("Não foi possível salvar: " + error.message);
    onSaved();
  }
  return (
    <Painel onClose={onClose}>
      <form onSubmit={submit} autoComplete="off">
        <h2 style={{ margin: 0 }}>{row ? "Editar promissória" : "Nova promissória"}</h2>
        <label>Cliente<input value={n} onChange={e => setN(e.target.value)} maxLength={180} required /></label>
        <label>Telefone<input value={p} onChange={e => setP(mascaraTelefone(e.target.value))} inputMode="tel" maxLength={40} placeholder="(61) 99999-9999" /></label>
        <div className="r2">
          <label>Dívida total (R$)<input value={t} onChange={e => setT(e.target.value)} inputMode="decimal" placeholder="0,00" required /></label>
          <label>Valor pago (R$)<input value={g} onChange={e => setG(e.target.value)} inputMode="decimal" placeholder="0,00" /></label>
        </div>
        <div className="r2">
          <label>Parcelas<input value={i} onChange={e => setI(e.target.value)} maxLength={40} placeholder="ex.: 6X" /></label>
          <label>Vencimento<input type="date" value={d} onChange={e => setD(e.target.value)} /></label>
        </div>
        <div className="prev">
          <span>Saldo <b className="mono">{ok ? money(Math.max(T - G, 0)) : "—"}</b></span>
          {st && !row?.fundo_perdido && <span className={`pill p-${cls(st)}`}>{LBL[st]}</span>}
        </div>
        <div className="err">{err}</div>
        <div className="r2">
          <button type="button" className="btn ghost" onClick={onClose}>Cancelar</button>
          <button className="btn" disabled={busy}>{busy ? "Salvando…" : "Salvar"}</button>
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
      {editing && <Editor row={editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); refresh(); }} />}
      {perdido && <PerdidoDialog row={perdido} onClose={() => setPerdido(null)} onDone={() => { setPerdido(null); refresh(); }} />}
      {whats && <WhatsDialog nome={cliente} telefone={tel} mensagem={mensagemCobranca(cliente, abertos.map(r => ({ valor: r.saldo_devedor, vencimento: r.vencimento })))} onClose={() => setWhats(false)} />}
    </Painel>
  );
}
