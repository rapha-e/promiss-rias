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
  dividaTotal: number,
  numeroPagamento: number = 1
): {
  totalParcelas: number;
  numeroParcela: number;
  rotuloParcela: string;
  valorTotalCompra: number;
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
    };
  }

  // Caso padrão
  return {
    totalParcelas: 1,
    numeroParcela: 1,
    rotuloParcela: p ? (p.toLowerCase().startsWith("parcela") ? p : `Parcela ${p}`) : "Parcela 1/1",
    valorTotalCompra: dividaTotal,
  };
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
  let rotuloParcela = parcela.trim();
  if (rotuloParcela && !rotuloParcela.toLowerCase().startsWith("parcela")) {
    rotuloParcela = `Parcela ${rotuloParcela}`;
  }
  if (!rotuloParcela) rotuloParcela = "Parcela Única";

  // Linha do valor total da compra em X vezes, ex: "* *Valor total da compra:* 1.480,00 em 8x"
  let linhaValorTotalCompra = "";
  if (valorTotalCompra && valorTotalCompra > 0) {
    const totalQtd = totalParcelas
      ? String(totalParcelas).toLowerCase().replace(/[^0-9]/g, "")
      : "";
    const sufixoVezes = totalQtd ? ` em ${totalQtd}x` : "";
    linhaValorTotalCompra = `* *Valor total da compra:* ${formatarValorSemCifrao(valorTotalCompra)}${sufixoVezes}\n`;
  }

  let textoRestante = "";
  if (valorRestante <= 0) {
    textoRestante = "R$ 0,00 (Dívida 100% quitada! 🎉)";
  } else {
    textoRestante = money(valorRestante);
  }

  let linhasProximas = "";
  if (proximasParcelas && proximasParcelas.length > 0 && valorRestante > 0) {
    const listagem = proximasParcelas.slice(0, 6).map(p => {
      const v = p.vencimento ? dt(p.vencimento) : "A definir";
      return `* Parcela ${p.parcela}: ${money(p.valor)} (venc. ${v})`;
    });
    if (proximasParcelas.length > 6) {
      listagem.push(`* e mais ${proximasParcelas.length - 6} parcela(s)`);
    }
    linhasProximas = `\n\n*Próximos vencimentos:*\n${listagem.join("\n")}`;
  }

  return `*Comprovante de Pagamento — LeoÓticas.fin* 🧾\n\n` +
    `Olá, *${primeiroNome}*! Confirmamos o recebimento do seu pagamento com sucesso:\n\n` +
    `* *Pagador:* ${nome}\n` +
    linhaValorTotalCompra +
    `* *Valor pago:* ${money(valorPago)}\n` +
    `* *Parcela:* ${rotuloParcela}\n` +
    `* *Valor restante:* ${textoRestante}\n` +
    `* *Data do pagamento:* ${dataPagamento}` +
    `${linhasProximas}\n\n` +
    `Agradecemos a sua preferência e confiança!\n` +
    `Qualquer dúvida, estamos à disposição.`;
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
  const vencidas = abertas.filter(r => r.vencimento && r.vencimento < h);
  const totalVencido = vencidas.reduce((s, r) => s + r.saldo_devedor, 0);
  const totalPago = historico.reduce((s, r) => s + (r.valor_pago || 0), 0);

  let maiorAtrasoDias = 0;
  for (const r of vencidas) {
    if (r.vencimento) {
      const d = diffDias(h, r.vencimento);
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
    return {
      score: "C",
      selo: `🔴 Risco Alto (${maiorAtrasoDias}d)`,
      rotulo: "Inadimplente",
      cor: "var(--bad)",
      bgCor: "rgba(180, 35, 24, 0.12)",
      descricao: `Possui ${vencidas.length} promissória(s) vencida(s) totalizando ${money(totalVencido)}.`,
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

