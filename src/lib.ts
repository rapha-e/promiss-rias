export type Status = "QUITADO" | "PAGANDO" | "NÃO PAGOU" | "A VENCER" | "FUNDO PERDIDO";
export type Row = {
  id: number; cliente_nome: string; telefone: string; divida_total: number; parcelas: string;
  valor_pago: number; saldo_devedor: number; vencimento: string | null; ano: number | null; status: Status;
  fundo_perdido: boolean; fundo_perdido_motivo: string | null; fundo_perdido_em: string | null;
  origem?: string; created_at?: string; updated_at?: string;
};
export type Item = { valor: number; vencimento: string | null };

const fmt = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
export const money = (c: number) => fmt.format(c / 100);
export const toBRL = (c: number) => (c / 100).toFixed(2).replace(".", ",");
export const LBL: Record<Status, string> = {
  QUITADO: "Quitado",
  PAGANDO: "Pagando",
  "NÃO PAGOU": "Não pagou",
  "A VENCER": "A vencer",
  "FUNDO PERDIDO": "Fundo perdido"
};
export const cls = (s: Status) => (s === "A VENCER" ? "VENCER" : s.split(" ")[0]);
export const dt = (d: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "Sem vencimento");
export const dtHora = (iso?: string | null) => {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
};

export function deriveStatus(r: {
  status?: string;
  fundo_perdido?: boolean;
  divida_total: number;
  valor_pago: number;
  saldo_devedor?: number;
  vencimento?: string | null;
}): Status {
  if (r.fundo_perdido) return "FUNDO PERDIDO";
  const saldo = r.saldo_devedor ?? Math.max(r.divida_total - r.valor_pago, 0);
  if (saldo <= 0) return "QUITADO";
  if (r.valor_pago > 0) return "PAGANDO";
  const h = hoje();
  if (r.vencimento && r.vencimento < h) return "NÃO PAGOU";
  return "A VENCER";
}

export const derive = (t: number, g: number, d?: string | null): Status =>
  deriveStatus({ divida_total: t, valor_pago: g, vencimento: d });

export function mascaraTelefone(v: string): string {
  if (!v) return "";
  if (/[\/;]/.test(v)) {
    return v.split(/([\/;])/).map(part => (part === "/" || part === ";" ? part : mascaraTelefone(part.trim()))).join(" ");
  }
  const d = v.replace(/\D/g, "");
  if (!d) return "";
  if (d.length <= 2) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6, 10)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7, 11)}`;
}

export function parse(v: string) {
  v = v.trim();
  if (!v) return 0;
  if (v.includes(",")) v = v.replace(/\./g, "").replace(",", ".");
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : NaN;
}

// Datas (fuso de Brasília) ----------------------------------------------------
export const hoje = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
const utc = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
export const diffDias = (a: string, b: string) => Math.round((utc(a) - utc(b)) / 86400000);
export const somaDias = (s: string, n: number) => new Date(utc(s) + n * 86400000).toISOString().slice(0, 10);

export type Alerta = { tipo: "vencida" | "proxima" | null; dias: number };
export function alerta(r: { vencimento: string | null; saldo_devedor: number; fundo_perdido: boolean }): Alerta {
  if (!r.vencimento || r.fundo_perdido || r.saldo_devedor <= 0) return { tipo: null, dias: 0 };
  const d = diffDias(hoje(), r.vencimento);
  if (d > 0) return { tipo: "vencida", dias: d };
  if (d >= -7) return { tipo: "proxima", dias: -d };
  return { tipo: null, dias: 0 };
}
export const alertaTexto = (a: Alerta) =>
  a.tipo === "vencida" ? `Vencida há ${a.dias} ${a.dias === 1 ? "dia" : "dias"}`
  : a.tipo === "proxima" ? (a.dias === 0 ? "Vence hoje" : `Vence em ${a.dias} ${a.dias === 1 ? "dia" : "dias"}`) : "";

// WhatsApp ---------------------------------------------------------------------
const DDD_KEY = "gf_ddd_padrao";
export const getDDD = () => { try { return localStorage.getItem(DDD_KEY) || "61"; } catch { return "61"; } };
export const setDDD = (v: string) => { try { localStorage.setItem(DDD_KEY, v); } catch { /* ignore */ } };

/** Extrai todos os números válidos do campo (aceita "a/b", "(62)9...", "9... mãe") e devolve 55+DDD+número. */
export function normalizarTelefones(texto: string, ddd = getDDD()): string[] {
  const out: string[] = [];
  for (const parte of (texto || "").split(/[\/;,|]| e | ou /i)) {
    let d = parte.replace(/\D/g, "").replace(/^0+/, "");
    if (d.length >= 12 && d.startsWith("55")) d = d.slice(2);
    if (d.length === 9 && d[0] === "9") d = ddd + d;
    else if (d.length === 8) d = ddd + d;
    const ok = (d.length === 11 && d[2] === "9") || d.length === 10;
    if (ok && +d.slice(0, 2) >= 11 && !out.includes("55" + d)) out.push("55" + d);
  }
  return out;
}
export const formatarTelefone = (n: string) => `+${n.slice(0, 2)} (${n.slice(2, 4)}) ${n.slice(4, n.length - 4)}-${n.slice(-4)}`;
export const linkWhatsApp = (numero: string, msg: string) => `https://wa.me/${numero}?text=${encodeURIComponent(msg)}`;

const titulo = (s: string) => s.toLocaleLowerCase("pt-BR").replace(/(^|\s)\S/g, c => c.toLocaleUpperCase("pt-BR"));
export function mensagemCobranca(nome: string, itens: Item[]): string {
  const abertos = itens.filter(i => i.valor > 0).sort((a, b) => (a.vencimento ?? "").localeCompare(b.vencimento ?? ""));
  const total = abertos.reduce((s, i) => s + i.valor, 0);
  const primeiro = titulo(nome.trim().split(/\s+/)[0] || "cliente");
  const linhas = abertos.slice(0, 8).map(i => {
    const a = i.vencimento ? diffDias(hoje(), i.vencimento) : 0;
    const sit = !i.vencimento ? "" : a > 0 ? ` (vencida há ${a} ${a === 1 ? "dia" : "dias"})` : a === 0 ? " (vence hoje)" : "";
    return `• ${money(i.valor)}${i.vencimento ? " — venc. " + dt(i.vencimento) : ""}${sit}`;
  });
  if (abertos.length > 8) linhas.push(`• e mais ${abertos.length - 8} promissória(s)`);
  return `Olá, ${primeiro}! Tudo bem?\n\nPassando para lembrar que consta em aberto ${abertos.length > 1 ? "os seguintes valores" : "o seguinte valor"}:\n${linhas.join("\n")}\n\nTotal: ${money(total)}\n\nSe já realizou o pagamento, por favor desconsidere esta mensagem. Qualquer dúvida, estou à disposição!`;
}

// CSV --------------------------------------------------------------------------
export function baixarCSV(nome: string, cab: string[], linhas: (string | number)[][]) {
  const cel = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const txt = "\uFEFF" + [cab, ...linhas].map(l => l.map(cel).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob([txt], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = nome; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
