export function moneyCentavos(centavos: number): string {
  return (centavos / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

export function dtBR(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

export function primeiroNomeCliente(nome: string): string {
  const first = (nome || "Cliente").trim().split(/\s+/)[0] || "Cliente";
  return first.toLocaleLowerCase("pt-BR").replace(/(^|\s)\S/g, c => c.toLocaleUpperCase("pt-BR"));
}

/** Escolhe uma variação determinística ou aleatória de frase (Anti-Banimento / Spintax) */
function escolherVariacao<T>(opcoes: T[], seed?: number): T {
  const idx = seed != null ? Math.abs(seed) % opcoes.length : Math.floor(Math.random() * opcoes.length);
  return opcoes[idx];
}

export function montarMensagemVencimentoDia(params: {
  nome: string;
  parcelas: string;
  valorCentavos: number;
  vencimento: string;
  qrCodePix: string;
  seed?: number;
}): string {
  const { nome, parcelas, valorCentavos, vencimento, qrCodePix, seed } = params;
  const pNome = primeiroNomeCliente(nome);
  const saudacoes = [
    `Oiii, ${pNome}! Tudo bem? 😊`,
    `Olá, ${pNome}! Tudo joia por aí?`,
    `Bom dia, ${pNome}! Como você está?`,
    `Oi ${pNome}, tudo bem com você? ✨`,
  ];
  const aberturas = [
    `Passando só para lembrar que a sua promissória da *LeoÓticas* vence *hoje (${dtBR(vencimento)})*.`,
    `Lembrete amigável da *LeoÓticas*: sua parcela (${parcelas || "promissória"}) tem vencimento *hoje, dia ${dtBR(vencimento)}*.`,
    `Só passando pra facilitar seu dia: hoje (${dtBR(vencimento)}) vence a sua parcela aqui na *LeoÓticas*.`,
  ];
  const fechamentos = [
    `Se precisar combinar outra data ou tirar alguma dúvida, é só responder aqui mesmo ou mandar um áudio! 🙏`,
    `Caso não consiga pagar hoje e queira agendar uma previsão, basta responder por aqui com a data combinada. 😊`,
    `Assim que efetuar o pagamento pelo Pix acima, nosso sistema já identifica e envia seu comprovante automaticamente por aqui! 🧾`,
  ];

  return (
    `${escolherVariacao(saudacoes, seed)}\n\n` +
    `${escolherVariacao(aberturas, (seed || 0) + 1)}\n\n` +
    `• *Parcela:* ${parcelas || "1/1"}\n` +
    `• *Valor:* ${moneyCentavos(valorCentavos)}\n\n` +
    `Para pagar direto pelo celular em 1 minuto, copie o código *Pix Copia e Cola* abaixo:\n\n` +
    `\`\`\`${qrCodePix}\`\`\`\n\n` +
    `${escolherVariacao(fechamentos, (seed || 0) + 2)}`
  );
}

export function montarMensagemPromessaDia(params: {
  nome: string;
  valorCentavos: number;
  dataPromessa: string;
  qrCodePix?: string;
  seed?: number;
}): string {
  const { nome, valorCentavos, dataPromessa, qrCodePix, seed } = params;
  const pNome = primeiroNomeCliente(nome);
  const saudacoes = [
    `Bom dia, ${pNome}! Tudo bem? 😊`,
    `Olá, ${pNome}! Passando conforme combinamos.`,
    `Oi ${pNome}, tudo joia?`,
  ];

  const blocoPix = qrCodePix
    ? `\n\nPara agilizar, já deixei seu código *Pix Copia e Cola* pronto abaixo:\n\n\`\`\`${qrCodePix}\`\`\``
    : "";

  return (
    `${escolherVariacao(saudacoes, seed)}\n\n` +
    `Conforme combinado para hoje (*${dtBR(dataPromessa)}*), estou enviando o lembrete do seu pagamento na *LeoÓticas*` +
    `${valorCentavos > 0 ? ` no valor de *${moneyCentavos(valorCentavos)}*` : ""}.` +
    `${blocoPix}\n\n` +
    `Qualquer imprevisto, pode me avisar por aqui mesmo! 🙏`
  );
}

export function montarMensagemInadimplencia(params: {
  nome: string;
  parcelas: string;
  valorCentavos: number;
  vencimento: string;
  diasAtraso: number;
  qrCodePix: string;
  seed?: number;
}): string {
  const { nome, parcelas, valorCentavos, vencimento, diasAtraso, qrCodePix, seed } = params;
  const pNome = primeiroNomeCliente(nome);

  const saudacoes = [
    `Olá, ${pNome}! Tudo bem?`,
    `Oi, ${pNome}, como vai?`,
    `Bom dia, ${pNome}! Tudo certo?`,
  ];

  let corpo = "";
  if (diasAtraso <= 7) {
    corpo = `Notamos que sua parcela (${parcelas || "promissória"}) da *LeoÓticas* venceu em *${dtBR(vencimento)}* (${diasAtraso} dia(s)) e talvez tenha passado na correria do dia a dia.`;
  } else if (diasAtraso <= 29) {
    corpo = `Consta em aberto a sua parcela (${parcelas || "promissória"}) da *LeoÓticas* no valor de *${moneyCentavos(valorCentavos)}*, vencida em *${dtBR(vencimento)}*. Queremos te ajudar a regularizar de forma tranquila!`;
  } else {
    corpo = `Estamos passando com uma condição facilitada para regularizar sua pendência na *LeoÓticas* (venc. *${dtBR(vencimento)}*, ${moneyCentavos(valorCentavos)}). Se preferir combinar uma data ou negociar o saldo, responda esta mensagem.`;
  }

  return (
    `${escolherVariacao(saudacoes, seed)}\n\n` +
    `${corpo}\n\n` +
    `• *Valor em aberto:* ${moneyCentavos(valorCentavos)}\n\n` +
    `📋 *Pix Copia e Cola:*\n\`\`\`${qrCodePix}\`\`\`\n\n` +
    `Se já tiver pago, pode desconsiderar ou enviar o comprovante aqui. Caso precise agendar uma data para pagamento, basta responder informando o dia! 😊`
  );
}

export function montarComprovanteBaixa(params: {
  nome: string;
  valorTotalCompra: number;
  totalParcelas?: string;
  valorPago: number;
  parcela: string;
  valorRestante: number;
  dataPagamentoBR: string;
  proximasParcelas?: { parcela: string; valor: number; vencimento: string | null }[];
}): string {
  const {
    nome,
    valorTotalCompra,
    totalParcelas,
    valorPago,
    parcela,
    valorRestante,
    dataPagamentoBR,
    proximasParcelas,
  } = params;
  const pNome = primeiroNomeCliente(nome);
  const rotuloParcela = (parcela || "1/1").trim().replace(/^parcela\s+/i, "") || "1/1";

  let linhaValorTotalCompra = "";
  if (valorTotalCompra > 0) {
    const totalQtd = totalParcelas ? parseInt(String(totalParcelas).replace(/[^0-9]/g, ""), 10) || 0 : 0;
    const sufixoVezes = totalQtd > 1 ? ` em ${totalQtd} vezes` : totalQtd === 1 ? " à vista" : "";
    const semCifrao = (valorTotalCompra / 100).toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    linhaValorTotalCompra = `- Valor total da compra: ${semCifrao}${sufixoVezes}\n`;
  }

  if (valorRestante <= 0) {
    return (
      `Comprovante de Pagamento — LeoÓticas.fin 🧾\n\n` +
      `Oiii, ${pNome}! Tudo bem? \n\n` +
      `Recebi o seu pagamento via Pix aqui, muito obrigado mesmo🙏🏽✌️😊\n\n` +
      `- Pagador: ${nome}\n` +
      linhaValorTotalCompra +
      `- Valor pago agora: ${moneyCentavos(valorPago)}\n` +
      `- Parcela: ${rotuloParcela}\n` +
      `- Valor restante: R$ 0,00 (Dívida 100% quitada! Parabéns e muito obrigado(a) por fechar tudo certinho! 🥳🙌)\n` +
      `- Data do pagamento: ${dataPagamentoBR}\n\n` +
      `Ah, e tem mais: já que você quitou tudo por aqui, que tal dar uma passada na loja pra conferir as novidades? Estamos te esperando! 🕶️✨`
    );
  }

  let linhasProximas = "";
  if (proximasParcelas && proximasParcelas.length > 0) {
    const listagem = proximasParcelas.slice(0, 8).map(p => {
      const v = p.vencimento ? dtBR(p.vencimento) : "A definir";
      const pRot = (p.parcela || "").trim().replace(/^parcela\s+/i, "");
      return `- Parcela ${pRot}: ${moneyCentavos(p.valor)} (venc. ${v})`;
    });
    linhasProximas = `\n\nPra você se programar, os próximos vencimentos são:\n${listagem.join("\n")}`;
  }

  return (
    `Comprovante de Pagamento — LeoÓticas.fin 🧾\n\n` +
    `Oiii, ${pNome}! Tudo bem? \n\n` +
    `Recebi o seu pagamento via Pix aqui, muito obrigado mesmo🙏🏽✌️😊\n\n` +
    `- Pagador: ${nome}\n` +
    linhaValorTotalCompra +
    `- Valor pago agora: ${moneyCentavos(valorPago)}\n` +
    `- Parcela: ${rotuloParcela}\n` +
    `- Valor restante da parcela: ${moneyCentavos(valorRestante)}\n` +
    `- Data do pagamento: ${dataPagamentoBR}` +
    `${linhasProximas}\n\n` +
    `Qualquer dúvida é só me chamar por aqui, tenha um excelente dia!🙏😊`
  );
}

/** Parser simples determinístico em PT-BR (fallback quando sem GEMINI_API_KEY) */
export function extrairPrevisaoPagamentoSimples(texto: string, hojeIso: string): string | null {
  const norm = (texto || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // 1. Data explícita DD/MM/AAAA ou DD/MM
  const mFull = norm.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (mFull) {
    const d = Number(mFull[1]);
    const m = Number(mFull[2]);
    let y = mFull[3] ? Number(mFull[3]) : Number(hojeIso.slice(0, 4));
    if (y < 100) y += 2000;
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
      const cand = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      if (!mFull[3] && cand < hojeIso) {
        return `${String(y + 1).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      }
      return cand;
    }
  }

  // 2. "amanha"
  if (/\bamanha\b/.test(norm)) {
    const dt = new Date(`${hojeIso}T12:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + 1);
    return dt.toISOString().slice(0, 10);
  }

  // 3. "dia X" quando há contexto de pagamento
  const temIntencao = /(pag|receb|acerto|acerto|deposito|pix|promet|combin|consigo|so dia|ate dia|pro dia|para o dia)/.test(norm);
  const mDia = norm.match(/\bdia\s+(\d{1,2})\b/);
  if (temIntencao && mDia) {
    const dia = Number(mDia[1]);
    if (dia >= 1 && dia <= 31) {
      const [anoH, mesH, diaH] = hojeIso.split("-").map(Number);
      let ano = anoH;
      let mes = mesH;
      if (dia < diaH) {
        mes += 1;
        if (mes > 12) { mes = 1; ano += 1; }
      }
      const ultimoDiaMes = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
      const diaAjustado = Math.min(dia, ultimoDiaMes);
      return `${ano}-${String(mes).padStart(2, "0")}-${String(diaAjustado).padStart(2, "0")}`;
    }
  }

  return null;
}
