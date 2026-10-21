import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";
import { dt, getDDD, linkWhatsApp, money, normalizarTelefones, setDDD, titulo, gerarPayloadPix, calcularScoreCliente, salvarPromessaPagamento } from "./lib";
import type { Row } from "./lib";
import { FichaCliente } from "./Dialogs";

export type EstrategiaAging =
  | "fase1_lembrete"
  | "fase2_contato"
  | "fase3_repactuacao"
  | "fase4_resgate"
  | "fundo_perdido"
  | "todas";

type TipoScript = "binaria" | "desconto_vista" | "lembrete_cortes" | "contato_ativo" | "tradicional";

type ClienteFila = {
  cliente: string;
  telefoneOriginal: string;
  telefoneFormatado: string;
  promissorias: Row[];
  valorTotal: number;
  vencimentoMaisUrgente: string | null;
  maiorAtrasoDias: number;
  temFundoPerdido: boolean;
  statusEnvio: "pendente" | "enviado" | "pulado";
};

const PIX_KEY = "leooticas_pix_chave";

function getHojeISO() {
  const agora = new Date();
  const d = new Date(agora.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  return d.toISOString().slice(0, 10);
}

function somaDiasStr(iso: string, dias: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function diffDias(hojeStr: string, venc: string): number {
  const tH = new Date(hojeStr + "T00:00:00Z").getTime();
  const tV = new Date(venc + "T00:00:00Z").getTime();
  return Math.round((tH - tV) / (1000 * 60 * 60 * 24));
}

export default function RenegociacaoCobranca({
  estrategiaInicial = "fase2_contato",
}: {
  estrategiaInicial?: EstrategiaAging;
}) {
  const [todasPromissorias, setTodasPromissorias] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [estrategia, setEstrategia] = useState<EstrategiaAging>(estrategiaInicial);
  const [ddd, setDddLocal] = useState(getDDD());
  const [chavePix, setChavePix] = useState(() => {
    try {
      return localStorage.getItem(PIX_KEY) || "";
    } catch {
      return "";
    }
  });

  const [busca, setBusca] = useState("");
  const [statusFiltro, setStatusFiltro] = useState<"todos" | "pendente" | "enviado" | "pulado">("todos");
  const [estadosEnvio, setEstadosEnvio] = useState<Record<string, "enviado" | "pulado">>({});
  const [clienteFocoIndex, setClienteFocoIndex] = useState(0);

  // Parâmetros do Simulador de Renegociação
  const [tipoScript, setTipoScript] = useState<TipoScript>("binaria");
  const [descontoPercentual, setDescontoPercentual] = useState<number>(20);
  const [entradaValor, setEntradaValor] = useState<number>(50);
  const [parcelasQtd, setParcelasQtd] = useState<number>(2);
  const [diaPagamentoEntrada, setDiaPagamentoEntrada] = useState<string>("hoje");
  const [diaVencimentoParcelas, setDiaVencimentoParcelas] = useState<string>("dia 10 do próximo mês");

  // Modais adicionais
  const [fichaCliente, setFichaCliente] = useState<{ cliente: string; telefone?: string } | null>(null);
  const [modalPromessa, setModalPromessa] = useState(false);
  const [promessaData, setPromessaData] = useState(somaDiasStr(getHojeISO(), 3));
  const [promessaValor, setPromessaValor] = useState<string>("");
  const [promessaObs, setPromessaObs] = useState("");
  const [modalRepactuacao, setModalRepactuacao] = useState(false);
  const [repactuando, setRepactuando] = useState(false);
  const [primeiroVencRepactuacao, setPrimeiroVencRepactuacao] = useState(somaDiasStr(getHojeISO(), 30));

  const hoje = getHojeISO();

  // Carrega todas as promissórias com saldo em aberto OU fundo perdido
  const carregarDados = useCallback(async () => {
    setLoading(true);
    let todas: Row[] = [];
    const pageSize = 1000;
    let from = 0;

    while (true) {
      const { data, error } = await supabase
        .from("promissorias")
        .select("*")
        .gt("saldo_devedor", 0)
        .order("vencimento", { ascending: true })
        .range(from, from + pageSize - 1);

      if (error || !data) break;
      todas.push(...(data as Row[]));
      if (data.length < pageSize) break;
      from += pageSize;
    }

    setTodasPromissorias(todas);
    setLoading(false);
  }, []);

  useEffect(() => {
    carregarDados();
  }, [carregarDados]);

  const handleSalvarPix = (val: string) => {
    setChavePix(val);
    try {
      localStorage.setItem(PIX_KEY, val);
    } catch {
      // ignore
    }
  };

  const handleMudarDDD = (val: string) => {
    const limpo = val.replace(/\D/g, "").slice(0, 2);
    setDddLocal(limpo);
    if (limpo.length === 2) setDDD(limpo);
  };

  // Agrupa e filtra promissórias de acordo com a Estratégia de Aging
  const filaCompleta: ClienteFila[] = useMemo(() => {
    // 1. Filtragem das promissórias pela régua de negócio
    const filtradas = todasPromissorias.filter(r => {
      if (estrategia === "fundo_perdido") {
        return r.fundo_perdido === true;
      }

      // Para as outras fases, exclui fundo perdido
      if (r.fundo_perdido) return false;

      if (!r.vencimento) return estrategia === "todas";
      const diasAtraso = diffDias(hoje, r.vencimento);

      switch (estrategia) {
        case "fase1_lembrete":
          // D-3 até D+5 (vencimento próximo ou atraso leve de até 5 dias)
          return diasAtraso >= -3 && diasAtraso <= 5;
        case "fase2_contato":
          // D+6 até D+30 (atraso recente com foco em escuta ativa)
          return diasAtraso >= 6 && diasAtraso <= 30;
        case "fase3_repactuacao":
          // D+31 até D+60 (atraso moderado com repactuação e entrada)
          return diasAtraso >= 31 && diasAtraso <= 60;
        case "fase4_resgate":
          // D+61 em diante (alta inadimplência com foco em desconto agressivo)
          return diasAtraso > 60;
        case "todas":
        default:
          return true;
      }
    });

    // 2. Agrupamento por cliente
    const mapa = new Map<string, Row[]>();
    for (const r of filtradas) {
      const chave = r.cliente_nome.trim().toUpperCase();
      if (!mapa.has(chave)) mapa.set(chave, []);
      mapa.get(chave)!.push(r);
    }

    const resultado: ClienteFila[] = [];
    for (const [chave, lista] of mapa.entries()) {
      const telOriginal = lista.find(p => p.telefone)?.telefone || "";
      const telefonesValidos = normalizarTelefones(telOriginal, ddd);
      const telFormatado = telefonesValidos[0] || "";
      const valorTotal = lista.reduce((s, p) => s + (p.saldo_devedor || 0), 0);
      const vencMaisUrgente = lista.map(p => p.vencimento).filter(Boolean).sort()[0] || null;
      const maiorAtraso = lista.reduce((max, p) => {
        if (!p.vencimento) return max;
        const d = diffDias(hoje, p.vencimento);
        return d > max ? d : max;
      }, 0);

      resultado.push({
        cliente: lista[0].cliente_nome,
        telefoneOriginal: telOriginal,
        telefoneFormatado: telFormatado,
        promissorias: lista,
        valorTotal,
        vencimentoMaisUrgente: vencMaisUrgente,
        maiorAtrasoDias: maiorAtraso,
        temFundoPerdido: lista.some(p => p.fundo_perdido),
        statusEnvio: estadosEnvio[chave] || "pendente",
      });
    }

    // Ordena: quem tem telefone válido primeiro, depois por maior atraso e valor total
    return resultado.sort((a, b) => {
      if (Boolean(a.telefoneFormatado) !== Boolean(b.telefoneFormatado)) {
        return a.telefoneFormatado ? -1 : 1;
      }
      if (b.maiorAtrasoDias !== a.maiorAtrasoDias) {
        return b.maiorAtrasoDias - a.maiorAtrasoDias;
      }
      return b.valorTotal - a.valorTotal;
    });
  }, [todasPromissorias, estrategia, hoje, ddd, estadosEnvio]);

  // Lista com busca e filtro de status
  const filaExibicao = useMemo(() => {
    return filaCompleta.filter(item => {
      if (statusFiltro !== "todos" && item.statusEnvio !== statusFiltro) return false;
      if (busca.trim()) {
        const b = busca.trim().toLowerCase();
        const nomeOk = item.cliente.toLowerCase().includes(b);
        const telOk = item.telefoneOriginal.includes(b);
        return nomeOk || telOk;
      }
      return true;
    });
  }, [filaCompleta, statusFiltro, busca]);

  // Estatísticas
  const stats = useMemo(() => {
    const total = filaCompleta.length;
    const enviados = filaCompleta.filter(i => i.statusEnvio === "enviado").length;
    const pulados = filaCompleta.filter(i => i.statusEnvio === "pulado").length;
    const pendentes = filaCompleta.filter(i => i.statusEnvio === "pendente").length;
    const semTelefone = filaCompleta.filter(i => !i.telefoneFormatado).length;
    const valorTotalFila = filaCompleta.reduce((s, i) => s + i.valorTotal, 0);

    return { total, enviados, pulados, pendentes, semTelefone, valorTotalFila };
  }, [filaCompleta]);

  // Cliente atual em foco
  const clienteAtual = useMemo(() => {
    if (!filaExibicao.length) return null;
    if (clienteFocoIndex >= filaExibicao.length) return filaExibicao[0];
    return filaExibicao[clienteFocoIndex];
  }, [filaExibicao, clienteFocoIndex]);

  // Ajusta automaticamente a estratégia padrão do script conforme a fase selecionada
  useEffect(() => {
    if (estrategia === "fase1_lembrete") setTipoScript("lembrete_cortes");
    else if (estrategia === "fase2_contato") setTipoScript("contato_ativo");
    else if (estrategia === "fase3_repactuacao") setTipoScript("binaria");
    else if (estrategia === "fase4_resgate" || estrategia === "fundo_perdido") setTipoScript("desconto_vista");
  }, [estrategia]);

  // Cálculos do simulador de renegociação
  const simulacao = useMemo(() => {
    const saldoTotal = clienteAtual?.valorTotal || 0;

    // Opção A: Quitação à vista com desconto
    const valorDesconto = (saldoTotal * descontoPercentual) / 100;
    const valorComDesconto = Math.max(0, saldoTotal - valorDesconto);

    // Opção B: Entrada + Parcelamento do saldo restante
    const entradaReal = Math.min(entradaValor, saldoTotal);
    const saldoRestante = Math.max(0, saldoTotal - entradaReal);
    const valorParcela = parcelasQtd > 0 ? saldoRestante / parcelasQtd : 0;

    return {
      saldoTotal,
      valorDesconto,
      valorComDesconto,
      entradaReal,
      saldoRestante,
      valorParcela,
    };
  }, [clienteAtual, descontoPercentual, entradaValor, parcelasQtd]);

  // Gerador de mensagens especializadas de acordo com o script
  const gerarMensagem = (item: ClienteFila): string => {
    const primeiroNome = titulo(item.cliente.trim().split(/\s+/)[0] || "Cliente");
    const saldoTotal = item.valorTotal;
    const chavePixTxt = chavePix.trim() ? `\n🔑 *Chave PIX:* \`${chavePix.trim()}\`` : "";

    // Gera o código PIX Copia e Cola com o valor com desconto
    const pixCopiaColaVista = chavePix.trim()
      ? `\n📋 *PIX Copia e Cola (valor de ${money(simulacao.valorComDesconto)} já preenchido):*\n\`${gerarPayloadPix({
          chave: chavePix.trim(),
          valor: simulacao.valorComDesconto,
          txid: `RENEG${item.promissorias[0]?.id || "1"}`,
        })}\``
      : "";

    // 1. SCRIPT DE OPÇÃO BINÁRIA (TÉCNICA DE ALTA CONVERSÃO)
    if (tipoScript === "binaria") {
      return (
        `Olá, ${primeiroNome}! Tudo bem? Aqui é da equipe da *LeoÓticas*.\n\n` +
        `Estou entrando em contato referente à sua pendência conosco no valor total de *${money(saldoTotal)}*.\n\n` +
        `Sabemos que imprevistos acontecem e queremos muito te ajudar a regularizar sua situação hoje com tranquilidade. Preparamos duas opções facilitadas:\n\n` +
        `👉 *OPÇÃO 1 (Quitação com Desconto):* Pague apenas *${money(simulacao.valorComDesconto)}* à vista via PIX (desconto de ${money(simulacao.valorDesconto)}) e quitamos seu saldo hoje mesmo!${chavePixTxt}${pixCopiaColaVista}\n\n` +
        `👉 *OPÇÃO 2 (Entrada + Parcelamento):* Dê uma pequena entrada de *${money(simulacao.entradaReal)}* hoje para travar o acordo e dividimos o restante em *${parcelasQtd}x de ${money(simulacao.valorParcela)}* para ${diaVencimentoParcelas}.\n\n` +
        `Qual dessas duas opções fica mais confortável para o seu orçamento hoje? Podemos fechar?`
      );
    }

    // 2. SCRIPT DE RESGATE COM DESCONTO À VISTA (D+61+ e FUNDO PERDIDO)
    if (tipoScript === "desconto_vista") {
      return (
        `Olá, ${primeiroNome}! Oportunidade exclusiva de quitação na *LeoÓticas*!\n\n` +
        `Estamos fechando o balanço de cobranças e a gerência autorizou uma condição especial única para o seu saldo em aberto de *${money(saldoTotal)}*:\n\n` +
        `🎯 *Quitação total por apenas ${money(simulacao.valorComDesconto)} via PIX!* (Você economiza ${money(simulacao.valorDesconto)} com ${descontoPercentual}% de desconto).\n\n` +
        `Com isso, damos baixa total nas promissórias e seu cadastro fica 100% regularizado conosco.${chavePixTxt}${pixCopiaColaVista}\n\n` +
        `Essa condição é especial para regularização hoje. Posso emitir o recibo de quitação para você?`
      );
    }

    // 3. SCRIPT DE CONTATO ATIVO & ESCUTA (D+6 a D+30)
    if (tipoScript === "contato_ativo") {
      return (
        `Oi, ${primeiroNome}! Tudo bem? Aqui é da *LeoÓticas*.\n\n` +
        `Notei aqui no sistema que a sua parcela no valor de *${money(saldoTotal)}* acabou vencendo há alguns dias e ainda não acusou baixa.\n\n` +
        `Aconteceu algum imprevisto? Valorizamos muito você como cliente da nossa loja e queremos encontrar um caminho para te ajudar a manter tudo em dia sem pesar no bolso.\n\n` +
        `Consegue me responder por aqui para combinarmos uma data boa para você? Aguardo seu retorno! 🙏`
      );
    }

    // 4. SCRIPT DE LEMBRETE CORTÊS (D-3 a D+5)
    if (tipoScript === "lembrete_cortes") {
      const vencStr = item.vencimentoMaisUrgente ? `vencida em ${dt(item.vencimentoMaisUrgente)}` : "em aberto";
      const pixLembrete = chavePix.trim()
        ? `\n📋 *PIX Copia e Cola (valor de ${money(saldoTotal)}):*\n\`${gerarPayloadPix({
            chave: chavePix.trim(),
            valor: saldoTotal,
            txid: `VENC${item.promissorias[0]?.id || "1"}`,
          })}\``
        : "";
      return (
        `Olá, ${primeiroNome}! Tudo bem? Esperamos que sim!\n\n` +
        `Passando apenas para um lembrete cortês da sua promissória na *LeoÓticas* no valor de *${money(saldoTotal)}* (${vencStr}).\n\n` +
        `Caso já tenha efetuado o pagamento, por favor desconsidere este aviso.\n` +
        `Se precisar da chave PIX para quitar direto pelo celular com facilidade:${chavePixTxt}${pixLembrete}\n\n` +
        `Se precisar de auxílio ou da 2ª via, é só responder aqui. Um abraço da equipe LeoÓticas! 👓`
      );
    }

    // 5. SCRIPT TRADICIONAL DETALHADO POR PARCELAS
    const linhas = item.promissorias.slice(0, 5).map(p => {
      const dias = p.vencimento ? diffDias(hoje, p.vencimento) : 0;
      let statusStr = "";
      if (p.vencimento) {
        if (dias > 0) statusStr = ` (vencida há ${dias} dias)`;
        else if (dias === 0) statusStr = " (vence hoje!)";
        else statusStr = ` (vence em ${-dias} dias)`;
      }
      return `• Parcela ${p.parcelas || "Única"}: ${money(p.saldo_devedor)}${p.vencimento ? " — venc. " + dt(p.vencimento) : ""}${statusStr}`;
    });
    if (item.promissorias.length > 5) {
      linhas.push(`• e mais ${item.promissorias.length - 5} parcela(s)`);
    }

    return (
      `Olá, ${primeiroNome}! Tudo bem?\n\n` +
      `Passando para lembrar referente à sua compra na *LeoÓticas*:\n\n` +
      `${linhas.join("\n")}\n\n` +
      `*Total em aberto:* ${money(item.valorTotal)}\n` +
      `${chavePixTxt}\n\n` +
      `Caso já tenha efetuado o pagamento, por favor desconsidere. Se precisar de ajuda, é só nos responder aqui!`
    );
  };

  // Disparo via WhatsApp
  const handleDispararWhatsApp = (item: ClienteFila) => {
    if (!item.telefoneFormatado) {
      alert("Este cliente não possui um telefone celular válido cadastrado.");
      return;
    }

    const msg = gerarMensagem(item);
    const url = linkWhatsApp(item.telefoneFormatado, msg);
    window.open(url, "_blank");

    const chave = item.cliente.trim().toUpperCase();
    setEstadosEnvio(prev => ({ ...prev, [chave]: "enviado" }));

    // Avança para o próximo
    if (clienteFocoIndex < filaExibicao.length - 1) {
      setClienteFocoIndex(prev => prev + 1);
    }
  };

  const handleCopiarMensagem = (item: ClienteFila) => {
    const msg = gerarMensagem(item);
    navigator.clipboard.writeText(msg);
    alert("Mensagem copiada para a área de transferência!");
  };

  const handlePular = (item: ClienteFila) => {
    const chave = item.cliente.trim().toUpperCase();
    setEstadosEnvio(prev => ({ ...prev, [chave]: "pulado" }));
    if (clienteFocoIndex < filaExibicao.length - 1) {
      setClienteFocoIndex(prev => prev + 1);
    }
  };

  const handleResetarFila = () => {
    if (window.confirm("Deseja reiniciar a fila e marcar todos os envios como pendentes?")) {
      setEstadosEnvio({});
      setClienteFocoIndex(0);
    }
  };

  if (loading) {
    return (
      <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--mut)" }}>
        <div style={{ fontSize: 24, marginBottom: 12 }}>Carregando Central de Renegociação...</div>
        <div>Estruturando fila de cobrança e estratégias de aging da carteira.</div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1300, margin: "0 auto", paddingBottom: 40 }}>
      {/* Cabeçalho */}
      <div className="head2 noprint" style={{ alignItems: "center", marginBottom: 16 }}>
        <div>
          <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}>
            <span>🤝</span> Central de Renegociação & Cobrança WhatsApp
          </h1>
          <div className="sub" style={{ marginTop: 4 }}>
            Régua estratégica em 4 fases, psicologia de negociação binária e disparo ágil no WhatsApp.
          </div>
        </div>

        {/* Configurações de Chave PIX e DDD */}
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <label className="inl" style={{ fontSize: 12 }}>
            DDD padrão:
            <input
              type="text"
              value={ddd}
              onChange={e => handleMudarDDD(e.target.value)}
              placeholder="Ex: 85"
              style={{ width: 44, textAlign: "center", padding: "4px 6px", fontWeight: 700 }}
              maxLength={2}
            />
          </label>
          <label className="inl" style={{ fontSize: 12 }}>
            Chave PIX da loja:
            <input
              type="text"
              value={chavePix}
              onChange={e => handleSalvarPix(e.target.value)}
              placeholder="CNPJ, Celular ou E-mail"
              style={{ width: 170, padding: "4px 8px" }}
            />
          </label>
          <button type="button" className="btn ghost" onClick={carregarDados} title="Recarregar clientes">
            🔄 Atualizar
          </button>
        </div>
      </div>

      {/* SELETOR DE ESTRATÉGIAS DO AGING (AS 4 FASES DA COBRANÇA) */}
      <div
        className="card"
        style={{
          padding: 12,
          marginBottom: 16,
          background: "var(--card)",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--mut)", textTransform: "uppercase", letterSpacing: ".05em" }}>
          Selecione a Estratégia de Cobrança / Aging:
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8 }}>
          {/* Fase 1 */}
          <button
            type="button"
            className={`btn ghost ${estrategia === "fase1_lembrete" ? "on" : ""}`}
            onClick={() => { setEstrategia("fase1_lembrete"); setClienteFocoIndex(0); }}
            style={{
              padding: "8px 10px",
              textAlign: "left",
              display: "flex",
              flexDirection: "column",
              gap: 2,
              borderRadius: 10,
              borderLeftWidth: 4,
              borderLeftColor: "#0284c7",
              background: estrategia === "fase1_lembrete" ? "rgba(2, 132, 199, 0.12)" : "transparent",
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 12.5, color: "#0284c7" }}>1. Lembrete Amigável</div>
            <div style={{ fontSize: 11, color: "var(--mut)" }}>Vencendo / D-3 a D+5</div>
          </button>

          {/* Fase 2 */}
          <button
            type="button"
            className={`btn ghost ${estrategia === "fase2_contato" ? "on" : ""}`}
            onClick={() => { setEstrategia("fase2_contato"); setClienteFocoIndex(0); }}
            style={{
              padding: "8px 10px",
              textAlign: "left",
              display: "flex",
              flexDirection: "column",
              gap: 2,
              borderRadius: 10,
              borderLeftWidth: 4,
              borderLeftColor: "#d97706",
              background: estrategia === "fase2_contato" ? "rgba(217, 119, 6, 0.12)" : "transparent",
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 12.5, color: "#d97706" }}>2. Contato Ativo & Escuta</div>
            <div style={{ fontSize: 11, color: "var(--mut)" }}>Atraso recente / D+6 a D+30</div>
          </button>

          {/* Fase 3 */}
          <button
            type="button"
            className={`btn ghost ${estrategia === "fase3_repactuacao" ? "on" : ""}`}
            onClick={() => { setEstrategia("fase3_repactuacao"); setClienteFocoIndex(0); }}
            style={{
              padding: "8px 10px",
              textAlign: "left",
              display: "flex",
              flexDirection: "column",
              gap: 2,
              borderRadius: 10,
              borderLeftWidth: 4,
              borderLeftColor: "#ea580c",
              background: estrategia === "fase3_repactuacao" ? "rgba(234, 88, 12, 0.12)" : "transparent",
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 12.5, color: "#ea580c" }}>3. Proposta de Repactuação</div>
            <div style={{ fontSize: 11, color: "var(--mut)" }}>Entrada + Parcelas / D+31 a D+60</div>
          </button>

          {/* Fase 4 */}
          <button
            type="button"
            className={`btn ghost ${estrategia === "fase4_resgate" ? "on" : ""}`}
            onClick={() => { setEstrategia("fase4_resgate"); setClienteFocoIndex(0); }}
            style={{
              padding: "8px 10px",
              textAlign: "left",
              display: "flex",
              flexDirection: "column",
              gap: 2,
              borderRadius: 10,
              borderLeftWidth: 4,
              borderLeftColor: "#dc2626",
              background: estrategia === "fase4_resgate" ? "rgba(220, 38, 38, 0.12)" : "transparent",
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 12.5, color: "#dc2626" }}>4. Resgate com Desconto</div>
            <div style={{ fontSize: 11, color: "var(--mut)" }}>Quitação à vista / D+61+</div>
          </button>

          {/* Fundo Perdido */}
          <button
            type="button"
            className={`btn ghost ${estrategia === "fundo_perdido" ? "on" : ""}`}
            onClick={() => { setEstrategia("fundo_perdido"); setClienteFocoIndex(0); }}
            style={{
              padding: "8px 10px",
              textAlign: "left",
              display: "flex",
              flexDirection: "column",
              gap: 2,
              borderRadius: 10,
              borderLeftWidth: 4,
              borderLeftColor: "#64748b",
              background: estrategia === "fundo_perdido" ? "rgba(100, 116, 139, 0.12)" : "transparent",
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 12.5, color: "#64748b" }}>5. Fundo Perdido</div>
            <div style={{ fontSize: 11, color: "var(--mut)" }}>Campanha de reativação</div>
          </button>

          {/* Todas */}
          <button
            type="button"
            className={`btn ghost ${estrategia === "todas" ? "on" : ""}`}
            onClick={() => { setEstrategia("todas"); setClienteFocoIndex(0); }}
            style={{
              padding: "8px 10px",
              textAlign: "left",
              display: "flex",
              flexDirection: "column",
              gap: 2,
              borderRadius: 10,
              borderLeftWidth: 4,
              borderLeftColor: "var(--mut)",
              background: estrategia === "todas" ? "var(--soft)" : "transparent",
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 12.5 }}>Todas em Aberto</div>
            <div style={{ fontSize: 11, color: "var(--mut)" }}>Visão irrestrita</div>
          </button>
        </div>
      </div>

      {/* PAINEL DIVIDIDO: ESQUERDA (LISTA DE CLIENTES) | DIREITA (SIMULADOR & DISPARO) */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(320px, 420px) 1fr",
          gap: 16,
          alignItems: "start",
        }}
      >
        {/* COLUNA ESQUERDA: FILA DE CLIENTES */}
        <div className="card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Métricas da Fila */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--line)", paddingBottom: 8 }}>
            <div>
              <span style={{ fontWeight: 700, fontSize: 13 }}>Fila de Clientes ({filaExibicao.length})</span>
              <div style={{ fontSize: 11.5, color: "var(--mut)" }}>
                Total na fase: <b>{money(stats.valorTotalFila)}</b>
              </div>
            </div>
            <button
              type="button"
              className="btn ghost"
              onClick={handleResetarFila}
              style={{ fontSize: 11, padding: "3px 8px" }}
              title="Reiniciar status de envios"
            >
              Reiniciar
            </button>
          </div>

          {/* Campo de Busca & Filtro de Status */}
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="search"
              placeholder="Buscar cliente ou tel..."
              value={busca}
              onChange={e => setBusca(e.target.value)}
              style={{ flex: 1, padding: "5px 8px", fontSize: 12.5 }}
            />
            <select
              value={statusFiltro}
              onChange={e => setStatusFiltro(e.target.value as any)}
              style={{ padding: "5px 8px", fontSize: 12 }}
            >
              <option value="todos">Todos</option>
              <option value="pendente">Pendentes ({stats.pendentes})</option>
              <option value="enviado">Enviados ({stats.enviados})</option>
              <option value="pulado">Pulados ({stats.pulados})</option>
            </select>
          </div>

          {/* Lista com Scroll */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 520, overflowY: "auto", paddingRight: 4 }}>
            {filaExibicao.length === 0 ? (
              <div style={{ textAlign: "center", padding: 30, color: "var(--mut)", fontSize: 13 }}>
                Nenhum cliente encontrado nesta faixa com os filtros atuais.
              </div>
            ) : (
              filaExibicao.map((item, idx) => {
                const isSelected = clienteAtual?.cliente === item.cliente;
                return (
                  <div
                    key={item.cliente}
                    onClick={() => setClienteFocoIndex(idx)}
                    style={{
                      padding: 10,
                      borderRadius: 10,
                      border: `1px solid ${isSelected ? "var(--brand)" : "var(--line)"}`,
                      background: isSelected ? "var(--soft)" : "transparent",
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                      transition: "all .15s ease",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontWeight: 700, fontSize: 13, color: isSelected ? "var(--brand)" : "var(--ink)" }}>
                        {item.cliente}
                      </span>
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          padding: "1px 6px",
                          borderRadius: 99,
                          textTransform: "uppercase",
                          background:
                            item.statusEnvio === "enviado"
                              ? "rgba(16, 185, 129, 0.15)"
                              : item.statusEnvio === "pulado"
                              ? "rgba(100, 116, 139, 0.15)"
                              : "rgba(234, 88, 12, 0.15)",
                          color:
                            item.statusEnvio === "enviado"
                              ? "#10b981"
                              : item.statusEnvio === "pulado"
                              ? "#64748b"
                              : "#ea580c",
                        }}
                      >
                        {item.statusEnvio}
                      </span>
                    </div>

                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--mut)" }}>
                      <span className="mono">{item.telefoneOriginal || "Sem telefone"}</span>
                      <span style={{ fontWeight: 700, color: "var(--ink)" }}>{money(item.valorTotal)}</span>
                    </div>

                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--mut)" }}>
                      <span>
                        {item.promissorias.length} título{item.promissorias.length > 1 ? "s" : ""}
                        {item.temFundoPerdido && " · Fundo Perdido"}
                      </span>
                      <span style={{ color: item.maiorAtrasoDias > 0 ? "var(--bad)" : "inherit" }}>
                        {item.maiorAtrasoDias > 0 ? `Atraso: ${item.maiorAtrasoDias}d` : item.vencimentoMaisUrgente ? `Venc: ${dt(item.vencimentoMaisUrgente)}` : ""}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* COLUNA DIREITA: SIMULADOR DE RENEGOCIAÇÃO & DISPARADOR */}
        {clienteAtual ? (
          <div className="card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
            {/* Header do Cliente em Foco */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", borderBottom: "1px solid var(--line)", paddingBottom: 12, flexWrap: "wrap", gap: 10 }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <h2 style={{ margin: 0, fontSize: 18 }}>{clienteAtual.cliente}</h2>
                  {(() => {
                    const score = calcularScoreCliente(clienteAtual.promissorias);
                    return (
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          padding: "2px 8px",
                          borderRadius: 99,
                          background: score.bgCor,
                          color: score.cor,
                          border: `1px solid ${score.cor}40`,
                        }}
                        title={score.recomendacaoVenda}
                      >
                        {score.selo}
                      </span>
                    );
                  })()}
                  <button
                    type="button"
                    className="ed"
                    style={{ fontSize: 11, padding: "2px 8px" }}
                    onClick={() => setFichaCliente({ cliente: clienteAtual.cliente, telefone: clienteAtual.telefoneOriginal })}
                  >
                    Ver Ficha Completa
                  </button>
                </div>
                <div style={{ fontSize: 13, color: "var(--mut)", marginTop: 2 }}>
                  Telefone WhatsApp: <b className="mono">{clienteAtual.telefoneFormatado ? `+${clienteAtual.telefoneFormatado}` : "Não formatado / ausente"}</b>
                </div>
              </div>

              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 11, color: "var(--mut)", textTransform: "uppercase" }}>Saldo Devedor Total</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: "var(--bad)" }}>{money(clienteAtual.valorTotal)}</div>
                <div style={{ fontSize: 11, color: "var(--mut)" }}>{clienteAtual.promissorias.length} promissória(s)</div>
              </div>
            </div>

            {/* SELETOR DE MODELO DE MENSAGEM */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--mut)", textTransform: "uppercase", marginBottom: 6 }}>
                Abordagem de Negociação (Script):
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                <button
                  type="button"
                  className={`btn ghost ${tipoScript === "binaria" ? "on" : ""}`}
                  style={{ fontSize: 12, padding: "5px 10px" }}
                  onClick={() => setTipoScript("binaria")}
                >
                  ⭐ Opção Binária (Entrada vs À Vista)
                </button>
                <button
                  type="button"
                  className={`btn ghost ${tipoScript === "desconto_vista" ? "on" : ""}`}
                  style={{ fontSize: 12, padding: "5px 10px" }}
                  onClick={() => setTipoScript("desconto_vista")}
                >
                  🎯 Quitação com Desconto PIX
                </button>
                <button
                  type="button"
                  className={`btn ghost ${tipoScript === "contato_ativo" ? "on" : ""}`}
                  style={{ fontSize: 12, padding: "5px 10px" }}
                  onClick={() => setTipoScript("contato_ativo")}
                >
                  💬 Contato Ativo & Escuta
                </button>
                <button
                  type="button"
                  className={`btn ghost ${tipoScript === "lembrete_cortes" ? "on" : ""}`}
                  style={{ fontSize: 12, padding: "5px 10px" }}
                  onClick={() => setTipoScript("lembrete_cortes")}
                >
                  ✉️ Lembrete Amigável
                </button>
                <button
                  type="button"
                  className={`btn ghost ${tipoScript === "tradicional" ? "on" : ""}`}
                  style={{ fontSize: 12, padding: "5px 10px" }}
                  onClick={() => setTipoScript("tradicional")}
                >
                  📄 Detalhado por Parcelas
                </button>
              </div>
            </div>

            {/* PAINEL DE PARÂMETROS DO SIMULADOR (CASO SEJA OPÇÃO BINÁRIA OU DESCONTO) */}
            {(tipoScript === "binaria" || tipoScript === "desconto_vista") && (
              <div
                style={{
                  background: "var(--soft)",
                  borderRadius: 12,
                  padding: 12,
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                  gap: 12,
                }}
              >
                {/* Desconto à vista */}
                <div>
                  <label style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>
                    Desconto à Vista: {descontoPercentual}% ({money(simulacao.valorDesconto)})
                  </label>
                  <div style={{ display: "flex", gap: 4 }}>
                    {[10, 20, 30, 40, 50].map(pct => (
                      <button
                        key={pct}
                        type="button"
                        className={`btn ghost ${descontoPercentual === pct ? "on" : ""}`}
                        style={{ flex: 1, padding: "4px 0", fontSize: 11 }}
                        onClick={() => setDescontoPercentual(pct)}
                      >
                        {pct}%
                      </button>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--brand)", marginTop: 4, fontWeight: 600 }}>
                    Valor final à vista: {money(simulacao.valorComDesconto)}
                  </div>
                </div>

                {/* Opção Parcelada com Entrada */}
                {tipoScript === "binaria" && (
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>
                      Sinal de Entrada Mínimo:
                    </label>
                    <div style={{ display: "flex", gap: 4 }}>
                      {[30, 50, 100, 150].map(val => (
                        <button
                          key={val}
                          type="button"
                          className={`btn ghost ${entradaValor === val ? "on" : ""}`}
                          style={{ flex: 1, padding: "4px 0", fontSize: 11 }}
                          onClick={() => setEntradaValor(val)}
                        >
                          R$ {val}
                        </button>
                      ))}
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center" }}>
                      <label className="inl" style={{ fontSize: 11 }}>
                        Parcelas:
                        <select
                          value={parcelasQtd}
                          onChange={e => setParcelasQtd(Number(e.target.value))}
                          style={{ padding: "2px 6px", fontSize: 11 }}
                        >
                          <option value={2}>2x</option>
                          <option value={3}>3x</option>
                          <option value={4}>4x</option>
                        </select>
                      </label>
                      <span style={{ fontSize: 11, color: "var(--mut)" }}>
                        Saldo: {parcelasQtd}x de <b>{money(simulacao.valorParcela)}</b>
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* PREVIEW DA MENSAGEM DO WHATSAPP */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "var(--mut)", textTransform: "uppercase" }}>
                  Pré-visualização da Mensagem:
                </span>
                <button
                  type="button"
                  className="btn ghost"
                  style={{ fontSize: 11, padding: "2px 8px" }}
                  onClick={() => handleCopiarMensagem(clienteAtual)}
                >
                  📋 Copiar Texto
                </button>
              </div>

              <div
                style={{
                  background: "var(--card)",
                  border: "1px solid var(--line)",
                  borderRadius: 10,
                  padding: 12,
                  whiteSpace: "pre-wrap",
                  fontFamily: "inherit",
                  fontSize: 13,
                  lineHeight: 1.5,
                  maxHeight: 220,
                  overflowY: "auto",
                  color: "var(--ink)",
                }}
              >
                {gerarMensagem(clienteAtual)}
              </div>
            </div>

            {/* BOTÕES DE AÇÃO: DISPARAR NO WHATSAPP / PULAR / REPACTUAR / AGENDAR */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn-baixa"
                onClick={() => handleDispararWhatsApp(clienteAtual)}
                style={{
                  flex: "1 1 200px",
                  padding: "12px 18px",
                  fontSize: 14,
                  fontWeight: 700,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  background: "#25D366",
                  color: "#fff",
                  boxShadow: "0 4px 12px rgba(37, 211, 102, 0.25)",
                }}
              >
                <span>💬</span> Enviar no WhatsApp & Próximo →
              </button>

              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setPromessaValor(String(simulacao.saldoTotal));
                  setModalPromessa(true);
                }}
                style={{ padding: "12px 14px", display: "inline-flex", alignItems: "center", gap: 6 }}
                title="Agendar promessa de pagamento para follow-up"
              >
                <span>📅</span> Agendar Promessa
              </button>

              <button
                type="button"
                className="btn ghost"
                onClick={() => setModalRepactuacao(true)}
                style={{ padding: "12px 14px", display: "inline-flex", alignItems: "center", gap: 6, color: "var(--brand)" }}
                title="Formalizar e gravar novas parcelas no banco de dados"
              >
                <span>📝</span> Formalizar Acordo
              </button>

              <button
                type="button"
                className="btn ghost"
                onClick={() => handlePular(clienteAtual)}
                style={{ padding: "12px 14px" }}
                title="Pular este cliente por enquanto"
              >
                Pular
              </button>
            </div>
          </div>
        ) : (
          <div className="card" style={{ padding: 40, textAlign: "center", color: "var(--mut)" }}>
            Selecione um cliente na lista à esquerda para carregar a proposta de renegociação.
          </div>
        )}
      </div>

      {/* Modal Agendar Promessa */}
      {modalPromessa && clienteAtual && (
        <div className="ov" onClick={() => setModalPromessa(false)}>
          <div className="panel" onClick={e => e.stopPropagation()} style={{ width: "min(460px, 94vw)", height: "auto", margin: "auto", borderRadius: 14, padding: 20 }}>
            <h2 style={{ margin: "0 0 10px", fontSize: 18 }}>📅 Agendar Promessa de Pagamento</h2>
            <div className="sub" style={{ marginBottom: 16 }}>
              Anotar compromisso de pagamento para acompanhamento na data certa.
            </div>

            <div style={{ display: "grid", gap: 12 }}>
              <div>
                <b>Cliente:</b> {clienteAtual.cliente}
              </div>
              <label>
                Data prometida:
                <input
                  type="date"
                  value={promessaData}
                  onChange={e => setPromessaData(e.target.value)}
                  required
                />
              </label>
              <label>
                Valor prometido (R$):
                <input
                  type="number"
                  step="0.01"
                  value={promessaValor}
                  onChange={e => setPromessaValor(e.target.value)}
                  placeholder={String(clienteAtual.valorTotal)}
                />
              </label>
              <label>
                Observação (Ex: Salário dia do vale, pagar no PIX):
                <input
                  type="text"
                  value={promessaObs}
                  onChange={e => setPromessaObs(e.target.value)}
                  placeholder="Ex: Vai pagar pelo PIX após as 14h"
                />
              </label>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    salvarPromessaPagamento({
                      cliente: clienteAtual.cliente,
                      telefone: clienteAtual.telefoneOriginal,
                      dataPromessa: promessaData,
                      valor: Number(promessaValor) || clienteAtual.valorTotal,
                      observacao: promessaObs,
                    });
                    alert(`📅 Promessa de pagamento registrada para ${dt(promessaData)}! Ela aparecerá no Dashboard na data marcada.`);
                    setModalPromessa(false);
                    setPromessaObs("");
                  }}
                  style={{ flex: 1 }}
                >
                  Salvar Promessa
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setModalPromessa(false)}
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal Formalizar Acordo no Sistema */}
      {modalRepactuacao && clienteAtual && (
        <div className="ov" onClick={() => !repactuando && setModalRepactuacao(false)}>
          <div className="panel" onClick={e => e.stopPropagation()} style={{ width: "min(520px, 94vw)", height: "auto", margin: "auto", borderRadius: 14, padding: 20 }}>
            <h2 style={{ margin: "0 0 10px", fontSize: 18, color: "var(--brand)" }}>
              📝 Formalizar Acordo de Repactuação
            </h2>
            <div className="sub" style={{ marginBottom: 14 }}>
              As promissórias anteriores em atraso serão baixadas e novas parcelas com novas datas serão gravadas no banco de dados.
            </div>

            <div style={{ background: "var(--soft)", padding: 12, borderRadius: 10, marginBottom: 14, fontSize: 13, display: "grid", gap: 6 }}>
              <div><b>Cliente:</b> {clienteAtual.cliente}</div>
              <div><b>Saldo Anterior em Atraso:</b> <span style={{ color: "var(--bad)", fontWeight: 700 }}>{money(simulacao.saldoTotal)}</span> ({clienteAtual.promissorias.length} título(s))</div>
              <div><b>Entrada Negociada:</b> <b>{money(simulacao.entradaReal)}</b></div>
              <div><b>Novo Saldo a Parcelar:</b> <b style={{ color: "var(--brand)" }}>{money(simulacao.saldoRestante)}</b></div>
              <div><b>Novas Parcelas:</b> <b>{parcelasQtd}x de {money(simulacao.valorParcela)}</b></div>
            </div>

            <div style={{ display: "grid", gap: 12 }}>
              <label>
                Data de vencimento da 1ª nova parcela:
                <input
                  type="date"
                  value={primeiroVencRepactuacao}
                  onChange={e => setPrimeiroVencRepactuacao(e.target.value)}
                  required
                />
              </label>

              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button
                  type="button"
                  className="btn"
                  disabled={repactuando}
                  onClick={async () => {
                    setRepactuando(true);
                    try {
                      // 1. Quita as promissórias antigas marcando origem
                      for (const p of clienteAtual.promissorias) {
                        await supabase
                          .from("promissorias")
                          .update({
                            valor_pago: p.divida_total,
                            origem: `${p.origem || "app"} | REPACTUADO_${parcelasQtd}X`,
                          })
                          .eq("id", p.id);
                      }

                      // 2. Insere as novas promissórias
                      const novas = [];
                      for (let i = 1; i <= parcelasQtd; i++) {
                        const d = new Date(primeiroVencRepactuacao + "T00:00:00Z");
                        d.setUTCMonth(d.getUTCMonth() + (i - 1));
                        const vencStr = d.toISOString().slice(0, 10);

                        novas.push({
                          cliente_nome: clienteAtual.cliente,
                          telefone: clienteAtual.telefoneOriginal,
                          divida_total: simulacao.valorParcela,
                          valor_pago: 0,
                          vencimento: vencStr,
                          parcelas: `${i}/${parcelasQtd}`,
                          origem: `ACORDO_REPACTUADO`,
                          fundo_perdido: false,
                        });
                      }

                      const { error: errIns } = await supabase.from("promissorias").insert(novas);
                      if (errIns) throw new Error(errIns.message);

                      alert("✅ Acordo formalizado com sucesso no sistema! As promissórias antigas foram baixadas e as novas parcelas foram geradas com sucesso.");
                      setModalRepactuacao(false);
                      carregarDados();
                    } catch (err: any) {
                      alert("Erro ao formalizar acordo: " + (err.message || err));
                    } finally {
                      setRepactuando(false);
                    }
                  }}
                  style={{ flex: 1, padding: "10px 14px", fontWeight: 700 }}
                >
                  {repactuando ? "Gravando no Banco…" : "Confirmar e Gravar Acordo"}
                </button>

                <button
                  type="button"
                  className="btn ghost"
                  disabled={repactuando}
                  onClick={() => setModalRepactuacao(false)}
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal Ficha do Cliente */}
      {fichaCliente && (
        <FichaCliente
          cliente={fichaCliente.cliente}
          telefone={fichaCliente.telefone}
          onClose={() => setFichaCliente(null)}
          onChanged={carregarDados}
          isAdmin={true}
        />
      )}
    </div>
  );
}
