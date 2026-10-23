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
export const dt = (d: string | null | undefined) => {
  if (!d) return "Sem vencimento";
  const str = String(d).trim();
  if (str.length === 7) return `${str.slice(5, 7)}/${str.slice(0, 4)}`;
  if (str.length === 4) return str;
  if (str.length >= 10) return `${str.slice(8, 10)}/${str.slice(5, 7)}/${str.slice(0, 4)}`;
  return str;
};
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
  parcelas?: string | null;
}): Status {
  if (r.fundo_perdido) return "FUNDO PERDIDO";
  const saldo = r.saldo_devedor ?? Math.max(r.divida_total - r.valor_pago, 0);
  if (saldo <= 0) return "QUITADO";
  const h = hoje();
  const vencReal = obterVencimentoEfetivo(r) || r.vencimento;
  if (vencReal && vencReal < h) return "NÃO PAGOU";
  if (r.valor_pago > 0) return "PAGANDO";
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

export const somaMeses = (dataIso: string | null | undefined, meses: number): string | null => {
  if (!dataIso) return null;
  const [ano, mes, dia] = dataIso.split("-").map(Number);
  if (!ano || !mes || !dia) return dataIso;

  const totalMeses = ano * 12 + (mes - 1) + meses;
  const targetAno = Math.floor(totalMeses / 12);
  const targetMes = (totalMeses % 12) + 1; // 1 a 12

  // Limitar ao último dia do mês alvo (ex.: 31 de janeiro -> 28/29 de fevereiro)
  const ultimoDia = new Date(Date.UTC(targetAno, targetMes, 0)).getUTCDate();
  const targetDia = Math.min(dia, ultimoDia);

  const mm = String(targetMes).padStart(2, "0");
  const dd = String(targetDia).padStart(2, "0");
  return `${targetAno}-${mm}-${dd}`;
};

export function obterVencimentoEfetivo(r: {
  parcelas?: string | null;
  divida_total?: number;
  valor_pago?: number;
  saldo_devedor?: number;
  vencimento?: string | null;
  fundo_perdido?: boolean;
}): string | null {
  if (!r.vencimento) return null;
  const saldo = r.saldo_devedor ?? Math.max(0, (r.divida_total ?? 0) - (r.valor_pago ?? 0));
  if (saldo <= 0) return r.vencimento;

  const p = (r.parcelas || "").trim().toUpperCase();
  const m = p.match(/^(\d+)\s*[xX]$/);
  if (!m) return r.vencimento;

  const totalParcelas = parseInt(m[1], 10);
  if (totalParcelas <= 1 || !r.divida_total || r.divida_total <= 0) return r.vencimento;

  const valorPago = r.valor_pago || 0;
  if (valorPago <= 0) return r.vencimento;

  const valorParcela = r.divida_total / totalParcelas;
  let parcelasPagas = 0;
  for (let k = 1; k <= totalParcelas; k++) {
    if (valorPago >= Math.floor(k * valorParcela * 0.95)) {
      parcelasPagas = k;
    } else {
      break;
    }
  }

  if (parcelasPagas === 0) return r.vencimento;
  return somaMeses(r.vencimento, parcelasPagas);
}

export function gerarParcelasDesmembradas(r: Row): {
  cliente_nome: string;
  telefone: string;
  divida_total: number;
  parcelas: string;
  valor_pago: number;
  saldo_devedor: number;
  vencimento: string | null;
  fundo_perdido: boolean;
  origem?: string;
}[] {
  const p = (r.parcelas || "").trim().toUpperCase();
  const m = p.match(/^(\d+)\s*[xX]$/);
  if (!m) return [];

  const total = parseInt(m[1], 10);
  if (total <= 1) return [];

  const base = Math.floor(r.divida_total / total);
  const resto = r.divida_total % total;
  let pagoRestante = r.valor_pago || 0;

  const resultado = [];
  for (let i = 1; i <= total; i++) {
    const valorParcela = base + (i === 1 ? resto : 0);
    const pagoNesta = Math.min(valorParcela, Math.max(0, pagoRestante));
    pagoRestante -= pagoNesta;
    const saldo = valorParcela - pagoNesta;
    const venc = somaMeses(r.vencimento, i - 1);

    resultado.push({
      cliente_nome: r.cliente_nome,
      telefone: r.telefone,
      divida_total: valorParcela,
      parcelas: `${i}/${total}`,
      valor_pago: pagoNesta,
      saldo_devedor: saldo,
      vencimento: venc,
      fundo_perdido: r.fundo_perdido || false,
      origem: r.origem,
    });
  }

  return resultado;
}

export type Alerta = { tipo: "vencida" | "proxima" | null; dias: number };
export function alerta(r: {
  vencimento: string | null;
  saldo_devedor: number;
  fundo_perdido: boolean;
  parcelas?: string | null;
  divida_total?: number;
  valor_pago?: number;
}): Alerta {
  if (!r.vencimento || r.fundo_perdido || r.saldo_devedor <= 0) return { tipo: null, dias: 0 };
  const vencReal = obterVencimentoEfetivo(r) || r.vencimento;
  const d = diffDias(hoje(), vencReal);
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

export const titulo = (s: string) => s.toLocaleLowerCase("pt-BR").replace(/(^|\s)\S/g, c => c.toLocaleUpperCase("pt-BR"));

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

export function formatarValorSemCifrao(c: number): string {
  return (c / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function extrairInfoParcelas(
  parcelasStr: string | null | undefined,
  dividaTotal: number = 0,
  numeroPagamento: number = 1
): {
  totalParcelas: number;
  numeroParcela: number;
  rotuloParcela: string;
  valorTotalCompra: number;
  ehCarnetAgrupado: boolean;
} {
  const p = (parcelasStr || "").trim();

  // Caso 1: formato "1/8" ou "Parcela 1/8"
  const mBarra = p.match(/(\d+)\/(\d+)/);
  if (mBarra) {
    const atual = parseInt(mBarra[1], 10) || 1;
    const total = parseInt(mBarra[2], 10) || 1;
    return {
      totalParcelas: total,
      numeroParcela: atual,
      rotuloParcela: `Parcela ${atual}/${total}`,
      valorTotalCompra: dividaTotal,
      ehCarnetAgrupado: false,
    };
  }

  // Caso 2: formato "8X" ou "8x" ou "8 X"
  const mX = p.match(/^(\d+)\s*[xX]$/);
  if (mX) {
    const total = parseInt(mX[1], 10) || 1;
    const atual = Math.min(total, Math.max(1, numeroPagamento));
    return {
      totalParcelas: total,
      numeroParcela: atual,
      rotuloParcela: `Parcela ${atual}/${total}`,
      valorTotalCompra: dividaTotal,
      ehCarnetAgrupado: total > 1,
    };
  }

  // Caso 3: número isolado "8"
  const mNum = p.match(/^(\d+)$/);
  if (mNum) {
    const total = parseInt(mNum[1], 10) || 1;
    const atual = Math.min(total, Math.max(1, numeroPagamento));
    return {
      totalParcelas: total,
      numeroParcela: atual,
      rotuloParcela: `Parcela ${atual}/${total}`,
      valorTotalCompra: dividaTotal,
      ehCarnetAgrupado: total > 1,
    };
  }

  // Caso padrão
  return {
    totalParcelas: 1,
    numeroParcela: 1,
    rotuloParcela: p ? (p.toLowerCase().startsWith("parcela") ? p : `Parcela ${p}`) : "Parcela 1/1",
    valorTotalCompra: dividaTotal,
    ehCarnetAgrupado: false,
  };
}

export interface CompraAtualInfo {
  promissoriasCompra: Row[];
  promissoriasOutras: Row[];
  totalVendaAtual: number;
  valorPagoVendaAtual: number;
  saldoReceberVendaAtual: number;
  totalParcelasCompra: number;
  parcelasPagasCompra: number;
  parcelasAbertasCompra: number;
  totalOutrasQuitadas: number;
  qtdOutrasQuitadas: number;
}

/**
 * Identifica a referida compra atual (em aberto) de um cliente, separando-a estritamente
 * das outras compras anteriores já quitadas no passado.
 * Inclui todas as parcelas da compra (inclusive as que já foram quitadas nela).
 */
export function identificarCompraAtual(rows: Row[]): CompraAtualInfo {
  if (!rows || rows.length === 0) {
    return {
      promissoriasCompra: [],
      promissoriasOutras: [],
      totalVendaAtual: 0,
      valorPagoVendaAtual: 0,
      saldoReceberVendaAtual: 0,
      totalParcelasCompra: 0,
      parcelasPagasCompra: 0,
      parcelasAbertasCompra: 0,
      totalOutrasQuitadas: 0,
      qtdOutrasQuitadas: 0,
    };
  }

  const abertas = rows.filter(r => !r.fundo_perdido && (r.saldo_devedor ?? 0) > 0);

  // Se não tem nenhuma promissória aberta, o cliente está 100% quitado
  if (abertas.length === 0) {
    const quitadas = rows.filter(r => !r.fundo_perdido);
    const totDivida = quitadas.reduce((s, r) => s + (r.divida_total ?? 0), 0);
    const totPago = quitadas.reduce((s, r) => s + (r.valor_pago ?? 0), 0);
    return {
      promissoriasCompra: rows,
      promissoriasOutras: [],
      totalVendaAtual: totDivida,
      valorPagoVendaAtual: totPago,
      saldoReceberVendaAtual: 0,
      totalParcelasCompra: rows.length,
      parcelasPagasCompra: rows.length,
      parcelasAbertasCompra: 0,
      totalOutrasQuitadas: 0,
      qtdOutrasQuitadas: 0,
    };
  }

  // Identificar carnês desmembrados em aberto (formato X/Y)
  const carnesAbertos = new Map<number, { minNum: number; maxNum: number; valorParcela: number; idsAbertos: Set<number> }>();

  for (const r of abertas) {
    const m = (r.parcelas || "").trim().match(/^(\d+)\/(\d+)$/);
    if (m) {
      const num = parseInt(m[1], 10);
      const denom = parseInt(m[2], 10);
      if (!carnesAbertos.has(denom)) {
        carnesAbertos.set(denom, {
          minNum: num,
          maxNum: num,
          valorParcela: r.divida_total,
          idsAbertos: new Set([r.id]),
        });
      } else {
        const c = carnesAbertos.get(denom)!;
        if (num < c.minNum) c.minNum = num;
        if (num > c.maxNum) c.maxNum = num;
        c.idsAbertos.add(r.id);
      }
    }
  }

  const compraIds = new Set<number>();
  for (const r of abertas) {
    compraIds.add(r.id);
  }

  // Buscar parcelas já quitadas que pertencem ao mesmo carnê em aberto
  for (const [denom, carne] of carnesAbertos.entries()) {
    for (let k = 1; k <= denom; k++) {
      const jaAberto = Array.from(carne.idsAbertos).some(id => {
        const rowObj = rows.find(x => x.id === id);
        return rowObj?.parcelas?.startsWith(`${k}/`);
      });
      if (jaAberto) continue;

      const candidatas = rows.filter(r => {
        if (r.fundo_perdido || (r.saldo_devedor ?? 0) > 0) return false;
        const m = (r.parcelas || "").trim().match(/^(\d+)\/(\d+)$/);
        return m && parseInt(m[1], 10) === k && parseInt(m[2], 10) === denom;
      });

      if (candidatas.length > 0) {
        candidatas.sort((a, b) => {
          const diffA = Math.abs(a.divida_total - carne.valorParcela);
          const diffB = Math.abs(b.divida_total - carne.valorParcela);
          if (diffA !== diffB) return diffA - diffB;
          return b.id - a.id;
        });
        compraIds.add(candidatas[0].id);
      }
    }
  }

  const promissoriasCompra: Row[] = [];
  const promissoriasOutras: Row[] = [];

  for (const r of rows) {
    if (compraIds.has(r.id)) {
      promissoriasCompra.push(r);
    } else {
      promissoriasOutras.push(r);
    }
  }

  const totalVendaAtual = promissoriasCompra.reduce((s, r) => s + (r.divida_total ?? 0), 0);
  const valorPagoVendaAtual = promissoriasCompra.reduce((s, r) => s + (r.valor_pago ?? 0), 0);
  const saldoReceberVendaAtual = promissoriasCompra.reduce((s, r) => s + (r.saldo_devedor ?? 0), 0);

  let totalParcelasCompra = 0;
  if (carnesAbertos.size > 0) {
    totalParcelasCompra = Array.from(carnesAbertos.keys()).reduce((s, d) => s + d, 0);
    const avulsas = promissoriasCompra.filter(r => !r.parcelas?.match(/^\d+\/\d+$/));
    for (const av of avulsas) {
      const info = extrairInfoParcelas(av.parcelas, av.divida_total);
      totalParcelasCompra += info.totalParcelas;
    }
  } else {
    for (const r of promissoriasCompra) {
      const info = extrairInfoParcelas(r.parcelas, r.divida_total);
      totalParcelasCompra += info.totalParcelas;
    }
  }

  const parcelasPagasCompra = promissoriasCompra.filter(r => (r.saldo_devedor ?? 0) <= 0).length;
  const parcelasAbertasCompra = promissoriasCompra.filter(r => (r.saldo_devedor ?? 0) > 0).length;

  const totalOutrasQuitadas = promissoriasOutras
    .filter(r => !r.fundo_perdido && (r.saldo_devedor ?? 0) <= 0)
    .reduce((s, r) => s + (r.divida_total ?? 0), 0);
  const qtdOutrasQuitadas = promissoriasOutras.filter(r => !r.fundo_perdido && (r.saldo_devedor ?? 0) <= 0).length;

  return {
    promissoriasCompra,
    promissoriasOutras,
    totalVendaAtual,
    valorPagoVendaAtual,
    saldoReceberVendaAtual,
    totalParcelasCompra: Math.max(promissoriasCompra.length, totalParcelasCompra),
    parcelasPagasCompra,
    parcelasAbertasCompra,
    totalOutrasQuitadas,
    qtdOutrasQuitadas,
  };
}

export interface CompraGrupo {
  id: string;
  titulo: string;
  rotuloParcelas: string; // Ex: "16x"
  totalParcelas: number;
  dividaTotal: number;
  valorPago: number;
  saldoDevedor: number;
  parcelasPagas: number;
  parcelasAbertas: number;
  proximoVencimento: string | null;
  status: Status;
  promissorias: Row[];
  proximaPromissoria: Row | null;
  emAberto: boolean;
}

export interface ClienteConsolidado {
  cliente_nome: string;
  telefone: string;
  compras: CompraGrupo[];
  compraPrincipal: CompraGrupo;
  temMultiplasComprasAbertas: boolean;
  qtdComprasAbertas: number;
  // Valores da compra atual / principal
  divida_total: number;
  valor_pago: number;
  saldo_devedor: number;
  parcelas_rotulo: string; // Ex: "16x"
  vencimento: string | null;
  status: Status;
  proximaPromissoria: Row | null;
  fundo_perdido: boolean;
  todasPromissorias: Row[];
}

/**
 * Separa com precisão as diferentes compras/parcelamentos de um cliente,
 * isolando carnês desmembrados (ex: 16x, 10x), compras avulsas e compras quitadas.
 */
export function separarComprasCliente(rows: Row[]): CompraGrupo[] {
  if (!rows || rows.length === 0) return [];

  // Agrupar carnês desmembrados por denominador Y
  const carnesMap = new Map<number, Row[]>();
  const avulsas: Row[] = [];

  for (const r of rows) {
    const m = (r.parcelas || "").trim().match(/^(\d+)\/(\d+)$/);
    if (m) {
      const denom = parseInt(m[2], 10);
      if (!carnesMap.has(denom)) carnesMap.set(denom, []);
      carnesMap.get(denom)!.push(r);
    } else {
      avulsas.push(r);
    }
  }

  const compras: CompraGrupo[] = [];

  for (const [denom, carnetRows] of carnesMap.entries()) {
    carnetRows.sort((a, b) => {
      const na = parseInt((a.parcelas || "").match(/^(\d+)/)?.[1] || "0", 10);
      const nb = parseInt((b.parcelas || "").match(/^(\d+)/)?.[1] || "0", 10);
      return na - nb;
    });

    const abertas = carnetRows.filter(r => !r.fundo_perdido && (r.saldo_devedor ?? 0) > 0);
    const pagas = carnetRows.filter(r => (r.saldo_devedor ?? 0) <= 0);

    const valorUnitario = carnetRows[0]?.divida_total || 0;
    const somaDividaReal = carnetRows.reduce((s, r) => s + (r.divida_total ?? 0), 0);
    const dividaTotal = Math.max(somaDividaReal, denom * valorUnitario);

    // Identificar quais números de parcelas estão presentes
    const nums = carnetRows.map(r => parseInt((r.parcelas || "").match(/^(\d+)/)?.[1] || "0", 10)).filter(n => n > 0);
    const minNum = nums.length > 0 ? Math.min(...nums) : 1;
    const maxNum = nums.length > 0 ? Math.max(...nums) : denom;

    // Se minNum > 1, as parcelas 1..(minNum - 1) não estão presentes e foram quitadas no passado (legado)
    const parcelasAnterioresQuitadas = Math.max(0, minNum - 1);
    const valorPagoAnterior = parcelasAnterioresQuitadas * valorUnitario;

    // Se maxNum < denom, as parcelas futuras ainda existem e continuam em aberto
    const parcelasPosterioresAbertas = Math.max(0, denom - maxNum);
    const saldoPosteriorAberto = parcelasPosterioresAbertas * valorUnitario;

    const saldoPresente = carnetRows.reduce((s, r) => s + (r.fundo_perdido ? 0 : (r.saldo_devedor ?? 0)), 0);
    const saldoDevedor = saldoPresente + saldoPosteriorAberto;

    const pagoPresente = carnetRows.reduce((s, r) => s + (r.valor_pago ?? 0), 0);
    const valorPago = pagoPresente + valorPagoAnterior;

    let proximoVencimento: string | null = null;
    let proximaPromissoria: Row | null = null;
    if (abertas.length > 0) {
      const abertasSorted = [...abertas].sort((a, b) => (a.vencimento ?? "").localeCompare(b.vencimento ?? ""));
      proximoVencimento = abertasSorted[0].vencimento;
      proximaPromissoria = abertasSorted[0];
    } else if (carnetRows.length > 0) {
      proximoVencimento = carnetRows[carnetRows.length - 1].vencimento;
    }

    const st = deriveStatus({
      divida_total: dividaTotal,
      valor_pago: valorPago,
      saldo_devedor: saldoDevedor,
      vencimento: proximoVencimento,
      fundo_perdido: carnetRows.every(r => r.fundo_perdido),
    });

    compras.push({
      id: `carne_${denom}_${carnetRows[0]?.id || 0}`,
      titulo: `Carnê em ${denom}x`,
      rotuloParcelas: `${denom}x`,
      totalParcelas: denom,
      dividaTotal,
      valorPago,
      saldoDevedor,
      parcelasPagas: Math.max(pagas.length, denom - abertas.length),
      parcelasAbertas: abertas.length,
      proximoVencimento,
      status: st,
      promissorias: carnetRows,
      proximaPromissoria,
      emAberto: saldoDevedor > 0,
    });
  }

  for (const r of avulsas) {
    const info = extrairInfoParcelas(r.parcelas, r.divida_total);
    const emAberto = (r.saldo_devedor ?? 0) > 0;
    const st = deriveStatus(r);
    const rotulo = info.totalParcelas > 1 ? `${info.totalParcelas}x` : "1x";
    const titulo = info.totalParcelas > 1 ? `Compra em ${info.totalParcelas}x` : "Promissória Única";

    compras.push({
      id: `avulsa_${r.id}`,
      titulo,
      rotuloParcelas: rotulo,
      totalParcelas: info.totalParcelas,
      dividaTotal: r.divida_total,
      valorPago: r.valor_pago,
      saldoDevedor: r.fundo_perdido ? 0 : r.saldo_devedor,
      parcelasPagas: emAberto ? 0 : 1,
      parcelasAbertas: emAberto ? 1 : 0,
      proximoVencimento: r.vencimento,
      status: st,
      promissorias: [r],
      proximaPromissoria: emAberto ? r : null,
      emAberto,
    });
  }

  compras.sort((a, b) => {
    if (a.emAberto !== b.emAberto) return a.emAberto ? -1 : 1;
    if (a.emAberto) {
      if (a.proximoVencimento && b.proximoVencimento) {
        return a.proximoVencimento.localeCompare(b.proximoVencimento);
      }
      return b.saldoDevedor - a.saldoDevedor;
    }
    return (b.proximoVencimento ?? "").localeCompare(a.proximoVencimento ?? "");
  });

  return compras;
}

/**
 * Consolida as informações de um cliente para exibição de uma única linha na tabela,
 * destacando sua compra atual em aberto sem misturar compras anteriores.
 */
export function consolidarCliente(clienteNome: string, telefone: string, rows: Row[]): ClienteConsolidado {
  const compras = separarComprasCliente(rows);
  const comprasAbertas = compras.filter(c => c.emAberto);
  const temMultiplasComprasAbertas = comprasAbertas.length > 1;
  const qtdComprasAbertas = comprasAbertas.length;

  const compraPrincipal: CompraGrupo = comprasAbertas[0] || compras[0] || {
    id: "vazio",
    titulo: "Sem compras",
    rotuloParcelas: "1x",
    totalParcelas: 1,
    dividaTotal: 0,
    valorPago: 0,
    saldoDevedor: 0,
    parcelasPagas: 0,
    parcelasAbertas: 0,
    proximoVencimento: null,
    status: "QUITADO",
    promissorias: [],
    proximaPromissoria: null,
    emAberto: false,
  };

  return {
    cliente_nome: clienteNome,
    telefone: telefone || compraPrincipal.promissorias.find(p => p.telefone)?.telefone || "",
    compras,
    compraPrincipal,
    temMultiplasComprasAbertas,
    qtdComprasAbertas,
    divida_total: compraPrincipal.dividaTotal,
    valor_pago: compraPrincipal.valorPago,
    saldo_devedor: compraPrincipal.saldoDevedor,
    parcelas_rotulo: compraPrincipal.rotuloParcelas,
    vencimento: compraPrincipal.proximoVencimento,
    status: compraPrincipal.status,
    proximaPromissoria: compraPrincipal.proximaPromissoria,
    fundo_perdido: rows.length > 0 && rows.every(r => r.fundo_perdido),
    todasPromissorias: rows,
  };
}

/**
 * Agrupa uma lista de promissórias em clientes consolidados únicos.
 */
export function agruparClientesParaListagem(rows: Row[]): ClienteConsolidado[] {
  if (!rows || rows.length === 0) return [];

  const grupos = new Map<string, { nome: string; tel: string; promissorias: Row[] }>();

  for (const r of rows) {
    const rawNome = (r.cliente_nome || "").trim();
    if (!rawNome) continue;
    const key = rawNome.toUpperCase();

    if (!grupos.has(key)) {
      grupos.set(key, {
        nome: rawNome,
        tel: r.telefone || "",
        promissorias: [],
      });
    }
    const g = grupos.get(key)!;
    g.promissorias.push(r);
    if (!g.tel && r.telefone) g.tel = r.telefone;
  }

  const consolidados: ClienteConsolidado[] = [];
  for (const g of grupos.values()) {
    consolidados.push(consolidarCliente(g.nome, g.tel, g.promissorias));
  }

  return consolidados;
}

/**
 * Gera mensagem de comprovante para envio no WhatsApp após registro de baixa.
 * Contém: nome do pagador, valor total da compra em X vezes, valor pago, parcela paga, valor restante e data de pagamento.
 */
export function mensagemComprovanteBaixa(params: {
  nome: string;
  valorTotalCompra?: number;
  totalParcelas?: number | string;
  valorPago: number;
  parcela: string;
  valorRestante: number;
  dataPagamento: string;
  proximasParcelas?: { parcela: string; valor: number; vencimento: string | null }[];
}): string {
  const { nome, valorTotalCompra, totalParcelas, valorPago, parcela, valorRestante, dataPagamento, proximasParcelas } = params;
  const primeiroNome = titulo(nome.trim().split(/\s+/)[0] || "Cliente");

  // Rótulo da parcela paga, ex: "Parcela 1/8"
  let rotuloParcela = (parcela || "").trim();
  if (rotuloParcela && !rotuloParcela.toLowerCase().startsWith("parcela")) {
    rotuloParcela = `Parcela ${rotuloParcela}`;
  }
  if (!rotuloParcela) rotuloParcela = "Parcela Única";

  // Linha do valor total da compra em X vezes, ex: "- Valor total da compra: 1.480,00 em 8x"
  let linhaValorTotalCompra = "";
  if (valorTotalCompra && valorTotalCompra > 0) {
    const totalQtd = totalParcelas
      ? String(totalParcelas).toLowerCase().replace(/[^0-9]/g, "")
      : "";
    const sufixoVezes = totalQtd ? ` em ${totalQtd}x` : "";
    linhaValorTotalCompra = `- Valor total da compra: ${formatarValorSemCifrao(valorTotalCompra)}${sufixoVezes}\n`;
  }

  // 2. QUANDO O CLIENTE QUITA TUDO (100% QUITADO)
  if (valorRestante <= 0) {
    return (
      `Comprovante de Pagamento — LeoÓticas.fin 🧾\n\n` +
      `Oiii, ${primeiroNome}! Tudo bem? \n\n` +
      `Recebi o seu pagamento, muito obrigado mesmo, estamos certos, se precisar estou aqui \n\n` +
      `- Pagador: ${nome}\n` +
      linhaValorTotalCompra +
      `- Valor pago: ${money(valorPago)}\n` +
      `- Parcela: ${rotuloParcela}\n` +
      `- Valor restante: R$ 0,00 (Dívida 100% quitada! Parabéns e muito obrigado(a) por fechar tudo certinho! 🥳🙌)\n` +
      `- Data do pagamento: ${dataPagamento}\n\n` +
      `Ah, e tem mais: já que você quitou tudo por aqui, que tal dar uma passada na loja pra vc conferir as novidades que acabaram de chegar? Estamos com modelos lindos esperando por você! 🕶️✨\n\n` +
      `Foi um prazer enorme caminhar junto com você nessa jornada, conta com a gente sempre que precisar. Um abraço! 🌟`
    );
  }

  // 1. QUANDO AINDA RESTAM PARCELAS
  let linhasProximas = "";
  if (proximasParcelas && proximasParcelas.length > 0) {
    const listagem = proximasParcelas.slice(0, 8).map(p => {
      const v = p.vencimento ? dt(p.vencimento) : "A definir";
      const rot = p.parcela.trim().toLowerCase().startsWith("parcela") ? p.parcela.trim() : `Parcela ${p.parcela.trim()}`;
      return `- ${rot}: ${money(p.valor)} (venc. ${v})`;
    });
    if (proximasParcelas.length > 8) {
      listagem.push(`- e mais ${proximasParcelas.length - 8} parcela(s)`);
    }
    linhasProximas = `\n\nPra vc se programar, os próximos vencimentos são:\n${listagem.join("\n")}`;
  }

  return (
    `Comprovante de Pagamento — LeoÓticas.fin 🧾\n\n` +
    `Oiii, ${primeiroNome}! Tudo bem? \n\n` +
    `Recebi o seu pagamento, muito obrigado mesmo, vou dar baixa aqui \n\n` +
    `- Pagador: ${nome}\n` +
    linhaValorTotalCompra +
    `- Valor pago: ${money(valorPago)}\n` +
    `- Parcela: ${rotuloParcela}\n` +
    `- Valor restante: ${money(valorRestante)}\n` +
    `- Data do pagamento: ${dataPagamento}` +
    `${linhasProximas}\n\n` +
    `Qualquer dúvida é só me chamar por aqui, tenha um excelente dia! 🙏😊`
  );
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

// PIX COPIA E COLA (PADRÃO BACEN BR CODE / EMVCO) -------------------------------
function emv(id: string, value: string): string {
  const len = String(value.length).padStart(2, "0");
  return `${id}${len}${value}`;
}

function crc16Ccitt(str: string): string {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).padStart(4, "0");
}

export function gerarPayloadPix({
  chave,
  nomeRecebedor = "LEO OTICAS",
  cidade = "FORTALEZA",
  valor,
  txid = "***",
}: {
  chave: string;
  nomeRecebedor?: string;
  cidade?: string;
  valor?: number;
  txid?: string;
}): string {
  const chaveLimpa = chave.trim();
  if (!chaveLimpa) return "";

  const nomeNorm = nomeRecebedor.normalize("NFD").replace(/[\u0300-\u036f]/g, "").slice(0, 25).toUpperCase();
  const cidNorm = cidade.normalize("NFD").replace(/[\u0300-\u036f]/g, "").slice(0, 15).toUpperCase();
  const txNorm = (txid || "***").slice(0, 25);

  let merchantAccount = emv("00", "br.gov.bcb.pix");
  merchantAccount += emv("01", chaveLimpa);

  let payload = "";
  payload += emv("00", "01"); // Payload Format Indicator
  payload += emv("01", "12"); // Point of Initiation
  payload += emv("26", merchantAccount);
  payload += emv("52", "0000"); // Merchant Category Code
  payload += emv("53", "986"); // Currency BRL

  if (valor && valor > 0) {
    payload += emv("54", valor.toFixed(2));
  }

  payload += emv("58", "BR"); // Country
  payload += emv("59", nomeNorm || "LEO OTICAS");
  payload += emv("60", cidNorm || "FORTALEZA");

  const additionalData = emv("05", txNorm);
  payload += emv("62", additionalData);

  // CRC16
  payload += "6304";
  const crc = crc16Ccitt(payload);
  return `${payload}${crc.toUpperCase()}`;
}

// SCORE INTERNO DE CRÉDITO (CREDIT SCORING LEOÓTICAS) ----------------------------
export type CreditScoreInfo = {
  score: "A" | "B" | "C" | "D";
  selo: string;
  rotulo: string;
  cor: string;
  bgCor: string;
  descricao: string;
  recomendacaoVenda: string;
  totalTitulos: number;
  totalVencido: number;
  totalPago: number;
  maiorAtrasoDias: number;
  temFundoPerdido: boolean;
};

export function calcularScoreCliente(historico: Row[]): CreditScoreInfo {
  if (!historico || historico.length === 0) {
    return {
      score: "A",
      selo: "🟢 Novo Cliente",
      rotulo: "Novo Cliente",
      cor: "var(--brand)",
      bgCor: "rgba(10, 124, 76, 0.1)",
      descricao: "Primeira compra no crediário da loja.",
      recomendacaoVenda: "Crédito sujeito à conferência cadastral inicial.",
      totalTitulos: 0,
      totalVencido: 0,
      totalPago: 0,
      maiorAtrasoDias: 0,
      temFundoPerdido: false,
    };
  }

  const h = hoje();
  const temFundoPerdido = historico.some(r => r.fundo_perdido);
  const abertas = historico.filter(r => !r.fundo_perdido && r.saldo_devedor > 0);
  const vencidas = abertas.filter(r => {
    const vReal = obterVencimentoEfetivo(r) || r.vencimento;
    return vReal && vReal < h;
  });
  const totalVencido = vencidas.reduce((s, r) => s + r.saldo_devedor, 0);
  const totalPago = historico.reduce((s, r) => s + (r.valor_pago || 0), 0);

  let maiorAtrasoDias = 0;
  for (const r of vencidas) {
    const vReal = obterVencimentoEfetivo(r) || r.vencimento;
    if (vReal) {
      const d = diffDias(h, vReal);
      if (d > maiorAtrasoDias) maiorAtrasoDias = d;
    }
  }

  if (temFundoPerdido) {
    return {
      score: "D",
      selo: "⛔ Fundo Perdido",
      rotulo: "Fundo Perdido",
      cor: "#64748b",
      bgCor: "rgba(100, 116, 139, 0.15)",
      descricao: "Possui promissórias anteriores marcadas como Fundo Perdido.",
      recomendacaoVenda: "⛔ BLOQUEADO: Exigir quitação das pendências antigas antes de liberar novo crediário.",
      totalTitulos: historico.length,
      totalVencido,
      totalPago,
      maiorAtrasoDias,
      temFundoPerdido: true,
    };
  }

  if (totalVencido > 0 || maiorAtrasoDias > 15) {
    if (maiorAtrasoDias <= 60) {
      return {
        score: "B",
        selo: `🟡 Em Atraso (${maiorAtrasoDias}d)`,
        rotulo: "Em Atraso",
        cor: "var(--warn)",
        bgCor: "rgba(217, 119, 6, 0.12)",
        descricao: `Possui ${vencidas.length} promissória(s) em atraso recente (${maiorAtrasoDias} dias) totalizando ${money(totalVencido)}.`,
        recomendacaoVenda: "Cobrar regularização das parcelas em atraso antes de liberar novo crediário.",
        totalTitulos: historico.length,
        totalVencido,
        totalPago,
        maiorAtrasoDias,
        temFundoPerdido: false,
      };
    }
    return {
      score: "C",
      selo: `🔴 Risco Alto (${maiorAtrasoDias}d)`,
      rotulo: "Inadimplente",
      cor: "var(--bad)",
      bgCor: "rgba(180, 35, 24, 0.12)",
      descricao: `Possui ${vencidas.length} promissória(s) vencida(s) há mais de 60 dias totalizando ${money(totalVencido)}.`,
      recomendacaoVenda: "⚠️ ATENÇÃO: Não liberar novo crediário sem entrada mínima de 50% ou quitação do atraso.",
      totalTitulos: historico.length,
      totalVencido,
      totalPago,
      maiorAtrasoDias,
      temFundoPerdido: false,
    };
  }

  if (maiorAtrasoDias > 0 || abertas.length > 2) {
    return {
      score: "B",
      selo: "🟡 Regular / Bom Pagador",
      rotulo: "Regular",
      cor: "var(--warn)",
      bgCor: "rgba(217, 119, 6, 0.12)",
      descricao: "Histórico de pagamentos consistente com pequenos atrasos operacionais.",
      recomendacaoVenda: "Crédito liberado alinhando o vencimento com a data de pagamento do cliente.",
      totalTitulos: historico.length,
      totalVencido: 0,
      totalPago,
      maiorAtrasoDias,
      temFundoPerdido: false,
    };
  }

  return {
    score: "A",
    selo: "🟢 Cliente Diamante",
    rotulo: "Diamante",
    cor: "var(--brand)",
    bgCor: "rgba(10, 124, 76, 0.12)",
    descricao: "Histórico exemplar! Quita no prazo e sem pendências ativas.",
    recomendacaoVenda: "⭐ Crédito 100% liberado com limite máximo da loja.",
    totalTitulos: historico.length,
    totalVencido: 0,
    totalPago,
    maiorAtrasoDias: 0,
    temFundoPerdido: false,
  };
}

// PROMESSAS DE PAGAMENTO (FOLLOW-UP) -------------------------------------------
export type PromessaPagamento = {
  id: string;
  cliente: string;
  telefone: string;
  dataPromessa: string; // YYYY-MM-DD
  valor: number;
  observacao?: string;
  criadaEm: string;
  cumprida: boolean;
};

const CHAVE_PROMESSAS = "leooticas_promessas_pagamento";

export function obterPromessasPagamento(): PromessaPagamento[] {
  try {
    const raw = localStorage.getItem(CHAVE_PROMESSAS);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function salvarPromessaPagamento(promessa: Omit<PromessaPagamento, "id" | "criadaEm" | "cumprida">): PromessaPagamento {
  const todas = obterPromessasPagamento();
  const nova: PromessaPagamento = {
    ...promessa,
    id: `prom_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    criadaEm: new Date().toISOString(),
    cumprida: false,
  };
  const atualizadas = [nova, ...todas];
  try {
    localStorage.setItem(CHAVE_PROMESSAS, JSON.stringify(atualizadas));
  } catch {}
  return nova;
}

export function marcarPromessaCumprida(id: string): void {
  const todas = obterPromessasPagamento();
  const atualizadas = todas.map(p => (p.id === id ? { ...p, cumprida: true } : p));
  try {
    localStorage.setItem(CHAVE_PROMESSAS, JSON.stringify(atualizadas));
  } catch {}
}

export function excluirPromessa(id: string): void {
  const todas = obterPromessasPagamento();
  const atualizadas = todas.filter(p => p.id !== id);
  try {
    localStorage.setItem(CHAVE_PROMESSAS, JSON.stringify(atualizadas));
  } catch {}
}

