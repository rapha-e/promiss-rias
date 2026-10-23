import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";
import {
  dt, getDDD, linkWhatsApp, money, normalizarTelefones, parse, setDDD, titulo, toBRL,
  gerarPayloadPix, calcularScoreCliente, salvarPromessaPagamento, PIX_CHAVE_OFICIAL,
  formatarMascaraMoeda, desmascararMoeda,
} from "./lib";
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
      const salvalocal = localStorage.getItem(PIX_KEY);
      if (salvalocal && salvalocal.trim()) return salvalocal;
      return PIX_CHAVE_OFICIAL;
    } catch {
      return PIX_CHAVE_OFICIAL;
    }
  });

  const [busca, setBusca] = useState("");
  const [statusFiltro, setStatusFiltro] = useState<"todos" | "pendente" | "enviado" | "pulado">("todos");
  const [estadosEnvio, setEstadosEnvio] = useState<Record<string, "enviado" | "pulado">>({});
  const [clienteFocoIndex, setClienteFocoIndex] = useState(0);

  // Parâmetros do Simulador de Renegociação
  const [tipoScript, setTipoScript] = useState<TipoScript>("binaria");
  const [descontoPercentual, setDescontoPercentual] = useState<number>(20);
  const [entradaValor, setEntradaValor] = useState<number>(0);
  const [entradaTexto, setEntradaTexto] = useState<string>("R$ 0,00");
  const [parcelasQtd, setParcelasQtd] = useState<number>(5);
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
  const [obsRepactuacao, setObsRepactuacao] = useState<string>("");

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
    const valorDesconto = Math.round((saldoTotal * descontoPercentual) / 100);
    const valorComDesconto = Math.max(0, saldoTotal - valorDesconto);

    // Opção B: Entrada + Parcelamento do saldo restante
    const entradaReal = Math.min(entradaValor, saldoTotal);
    const saldoRestante = Math.max(0, saldoTotal - entradaReal);
    const qtd = Math.max(1, parcelasQtd);
    const baseParcela = Math.floor(saldoRestante / qtd);
    const restoParcela = saldoRestante % qtd;
    const valorParcela = Math.round(saldoRestante / qtd);

    return {
      saldoTotal,
      valorDesconto,
      valorComDesconto,
      entradaReal,
      saldoRestante,
      baseParcela,
      restoParcela,
      valorParcela,
    };
  }, [clienteAtual, descontoPercentual, entradaValor, parcelasQtd]);

  // Gerador de mensagens especializadas de acordo com o script
  const gerarMensagem = (item: ClienteFila): string => {
    const primeiroNome = titulo(item.cliente.trim().split(/\s+/)[0] || "Cliente");
    const saldoTotal = item.valorTotal;
    const chaveAtual = (chavePix.trim() || PIX_CHAVE_OFICIAL).trim();

    // 1. SCRIPT DE OPÇÃO BINÁRIA (D+31 a D+60 - TÉCNICA DE ALTA CONVERSÃO)
    if (tipoScript === "binaria") {
      const textoOpcao2 = simulacao.entradaReal > 0
        ? `👉 *OPÇÃO 2 (Entrada Facilitada + Parcelamento Suave):* Dê uma pequena entrada de *${money(simulacao.entradaReal)}* hoje para travar o acordo e dividimos todo o restante em *${parcelasQtd}x de ${money(simulacao.valorParcela)}* para o dia ${diaVencimentoParcelas}, sem juros adicionais.\n\n`
        : `👉 *OPÇÃO 2 (Parcelamento Facilitado sem Entrada):* Dividimos todo o seu saldo em *${parcelasQtd}x de ${money(simulacao.valorParcela)}* sem entrada, com o 1º vencimento apenas para o dia ${diaVencimentoParcelas}.\n\n`;

      return (
        `Olá, ${primeiroNome}! Tudo bem? Espero de coração que sim! 👓✨\n\n` +
        `Aqui é da equipe da *LeoÓticas*. Estou entrando em contato diretamente com você porque valorizamos muito a confiança e a amizade que construímos desde a sua compra.\n\n` +
        `Sabemos que imprevistos e momentos apertados acontecem na vida de todo mundo — ninguém deixa de acertar uma promissória porque quer. Nosso objetivo não é te cobrar, mas sim te ajudar a ficar com a mente leve e seu cadastro 100% honrado conosco. Consta em aberto o valor de *${money(saldoTotal)}*.\n\n` +
        `Para facilitar de verdade e caber com conforto no seu momento, preparamos duas soluções especiais:\n\n` +
        `👉 *OPÇÃO 1 (Quitação Imediata com Super Desconto):* Pague apenas *${money(simulacao.valorComDesconto)}* à vista via Pix (desconto direto de ${money(simulacao.valorDesconto)}) e damos baixa total e definitiva na sua pendência hoje mesmo!\n\n` +
        textoOpcao2 +
        `Para sua facilidade, você pode escanear o QR Code acima ou copiar o código Pix oficial abaixo:\n\n` +
        `📋 *Pix Copia e Cola Oficial da LeoÓticas:*\n\`${chaveAtual}\`\n\n` +
        `Qual dessas duas opções fica mais confortável para o seu orçamento hoje? Me dá uma resposta aqui que já formalizo tudo para você! 🤝🙏`
      );
    }

    // 2. SCRIPT DE RESGATE COM DESCONTO À VISTA (D+61+ e FUNDO PERDIDO / RECUPERAÇÃO CRÍTICA)
    if (tipoScript === "desconto_vista") {
      return (
        `Olá, ${primeiroNome}! Tudo bem? Espero que sim! 👓\n\n` +
        `Aqui é da diretoria da *LeoÓticas*. Estou te mandando esta mensagem de forma muito transparente, pessoal e exclusiva.\n\n` +
        `Estamos realizando hoje o fechamento do nosso balanço semestral de contas e fui pessoalmente autorizado a entrar em contato com os nossos clientes com pendências mais antigas para oferecermos uma saída honrosa e definitiva para o seu saldo em aberto de *${money(saldoTotal)}*.\n\n` +
        `Sabemos que os últimos tempos foram desafiadores e não queremos de forma alguma que essa pendência continue gerando desgaste, bloqueios ou tirando a sua paz. Por isso, a diretoria liberou uma *CONDIÇÃO EXTRAORDINÁRIA DE BAIXA TOTAL*:\n\n` +
        `🎯 *Quitação definitiva por apenas ${money(simulacao.valorComDesconto)} via Pix!* (Você economiza ${money(simulacao.valorDesconto)} com ${descontoPercentual}% de desconto concedido).\n\n` +
        `Com esse valor, damos baixa 100% nas promissórias, cancelamos qualquer pendência no seu nome e reabilitamos o seu crédito para você voltar a comprar de portas abertas quando quiser.\n\n` +
        `Basta escanear o QR Code oficial acima ou usar o código Pix Copia e Cola abaixo:\n\n` +
        `📋 *Pix Copia e Cola Oficial da LeoÓticas:*\n\`${chaveAtual}\`\n\n` +
        `${primeiroNome}, essa condição foi autorizada exclusivamente para o fechamento de hoje. Queremos muito te ajudar a virar essa página e dormir com a certeza de que está tudo 100% honrado.\n\n` +
        `Posso emitir o seu comprovante e termo de quitação agora? Me responde aqui, por favor! 🙏🌟`
      );
    }

    // 3. SCRIPT DE CONTATO ATIVO & ESCUTA (D+6 a D+30)
    if (tipoScript === "contato_ativo") {
      return (
        `Oi, ${primeiroNome}! Tudo bem? Aqui é da equipe da *LeoÓticas*. 🙏👓\n\n` +
        `Notei aqui no sistema que a sua parcela no valor de *${money(saldoTotal)}* acabou vencendo há alguns dias e ainda não acusou a baixa.\n\n` +
        `Aconteceu algum imprevisto? A gente sabe muito bem que a correria do dia a dia é pesada e imprevistos acontecem com todo mundo. Você é um cliente super especial para a nossa loja e nós valorizamos demais a sua preferência.\n\n` +
        `Queremos muito encontrar um caminho amigável para te ajudar a manter tudo em dia sem apertar o seu orçamento.\n\n` +
        `Se já quiser deixar resolvido agora pelo celular com total rapidez, basta usar o QR Code acima ou o Pix Copia e Cola abaixo:\n\n` +
        `📋 *Pix Copia e Cola Oficial da LeoÓticas:*\n\`${chaveAtual}\`\n\n` +
        `Caso precise combinar uma data melhor ou dividir, me responde por aqui com sinceridade? Estou aqui de braços abertos para te ajudar! Um abraço carinhoso! 🤝✨`
      );
    }

    // 4. SCRIPT DE LEMBRETE AMIGÁVEL & CORTÊS (D-3 a D+5)
    if (tipoScript === "lembrete_cortes") {
      const vencStr = item.vencimentoMaisUrgente ? `vencida em ${dt(item.vencimentoMaisUrgente)}` : "em aberto";
      return (
        `Olá, ${primeiroNome}! Tudo bem? Esperamos que você esteja tendo um excelente dia! 👓✨\n\n` +
        `Passando apenas para um lembrete amigo referente à sua promissória na *LeoÓticas* no valor de *${money(saldoTotal)}* (${vencStr}).\n\n` +
        `Sabemos que a rotina é corrida e a gente acaba deixando passar sem perceber — se já efetuou o pagamento, pode desconsiderar este aviso com total tranquilidade! 👍\n\n` +
        `Para facilitar e você resolver direto do celular em menos de 1 minuto, basta escanear o QR Code acima ou usar o código Pix Copia e Cola abaixo:\n\n` +
        `📋 *Pix Copia e Cola Oficial da LeoÓticas:*\n\`${chaveAtual}\`\n\n` +
        `Qualquer dúvida ou se precisar de auxílio, é só dar um alô aqui. Um abraço carinhoso da nossa equipe! 🙏😊`
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
      `Olá, ${primeiroNome}! Tudo bem? Esperamos que sim! 👓\n\n` +
      `Passando para alinhar referente à sua compra na *LeoÓticas*:\n\n` +
      `${linhas.join("\n")}\n\n` +
      `*Total em aberto:* ${money(item.valorTotal)}\n\n` +
      `Para sua comodidade, você pode pagar direto pelo código Pix Copia e Cola abaixo ou escanear o QR Code oficial anexado:\n\n` +
      `📋 *Pix Copia e Cola Oficial da LeoÓticas:*\n\`${chaveAtual}\`\n\n` +
      `Caso já tenha efetuado o pagamento, por favor desconsidere este aviso. Se precisar de ajuda ou negociação de data, estamos à sua disposição por aqui! 🙏😊`
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
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <label style={{ fontSize: 12, fontWeight: 700, margin: 0 }}>
                        Sinal de Entrada:
                      </label>
                      <span style={{ fontSize: 11, color: "var(--brand)", fontWeight: 700 }}>
                        {simulacao.entradaReal > 0 ? money(simulacao.entradaReal) : "Sem entrada"}
                      </span>
                    </div>

                    {/* Botões Rápidos de Entrada */}
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {[
                        { label: "Sem Entrada", valor: 0 },
                        { label: "R$ 30", valor: 3000 },
                        { label: "R$ 50", valor: 5000 },
                        { label: "R$ 100", valor: 10000 },
                        { label: "R$ 150", valor: 15000 },
                        { label: "R$ 200", valor: 20000 },
                      ].map(item => (
                        <button
                          key={item.valor}
                          type="button"
                          className={`btn ghost ${entradaValor === item.valor ? "on" : ""}`}
                          style={{ flex: "1 1 auto", padding: "4px 6px", fontSize: 11 }}
                          onClick={() => {
                            setEntradaValor(item.valor);
                            setEntradaTexto(formatarMascaraMoeda(item.valor));
                          }}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>

                    {/* Digitar entrada livremente + Selecionar parcelas */}
                    <div style={{ display: "flex", gap: 10, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <label className="inl" style={{ fontSize: 11 }}>
                        Entrada livre (R$):
                        <input
                          type="text"
                          placeholder="R$ 0,00"
                          value={entradaTexto}
                          onChange={e => {
                            const formatado = formatarMascaraMoeda(e.target.value, true);
                            setEntradaTexto(formatado);
                            setEntradaValor(desmascararMoeda(formatado));
                          }}
                          inputMode="numeric"
                          style={{ width: 105, padding: "3px 6px", fontSize: 11, textAlign: "right", fontWeight: 600 }}
                        />
                      </label>

                      <label className="inl" style={{ fontSize: 11 }}>
                        Parcelas:
                        <select
                          value={parcelasQtd}
                          onChange={e => setParcelasQtd(Math.max(1, Number(e.target.value)))}
                          style={{ padding: "3px 8px", fontSize: 11, fontWeight: 700 }}
                        >
                          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 18, 24].map(q => (
                            <option key={q} value={q}>{q}x</option>
                          ))}
                        </select>
                      </label>

                      <span style={{ fontSize: 11, color: "var(--mut)", marginLeft: "auto" }}>
                        Saldo: {parcelasQtd}x de <b style={{ color: "var(--brand)", fontSize: 12 }}>{money(simulacao.valorParcela)}</b>
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* CARD QR CODE PIX OFICIAL */}
            <div
              style={{
                background: "linear-gradient(135deg, rgba(37, 211, 102, 0.08) 0%, rgba(30, 64, 175, 0.06) 100%)",
                border: "1px dashed #25D366",
                borderRadius: 10,
                padding: "10px 12px",
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <img
                src="/pix_qrcode.png"
                alt="QR Code Pix LeoÓticas"
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 6,
                  border: "1px solid #d1d5db",
                  background: "#fff",
                  padding: 2,
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)", display: "flex", alignItems: "center", gap: 6 }}>
                  <span>QR Code Pix Oficial</span>
                  <span style={{ fontSize: 10, background: "#25D366", color: "#fff", padding: "1px 6px", borderRadius: 99 }}>
                    Ativo
                  </span>
                </div>
                <div style={{ fontSize: 11, color: "var(--mut)", marginTop: 2, lineHeight: 1.3 }}>
                  Envie a imagem junto com o texto no WhatsApp para pagamentos instantâneos.
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <a
                    href="/pix_qrcode.png"
                    download="qrcode_pix_leooticas.png"
                    className="btn ghost"
                    style={{ fontSize: 11, padding: "2px 8px", textDecoration: "none" }}
                    title="Baixar imagem do QR Code para anexar no WhatsApp"
                  >
                    📥 Baixar QR Code
                  </a>
                  <button
                    type="button"
                    className="btn ghost"
                    style={{ fontSize: 11, padding: "2px 8px" }}
                    onClick={() => {
                      navigator.clipboard.writeText(chavePix.trim() || PIX_CHAVE_OFICIAL);
                      alert("Chave Pix Copia e Cola copiada para a área de transferência!");
                    }}
                  >
                    📋 Copiar Código Pix
                  </button>
                </div>
              </div>
            </div>

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
                  setPromessaValor(formatarMascaraMoeda(simulacao.saldoTotal));
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
                  type="text"
                  value={promessaValor}
                  onChange={e => setPromessaValor(formatarMascaraMoeda(e.target.value, true))}
                  inputMode="numeric"
                  placeholder={formatarMascaraMoeda(clienteAtual.valorTotal)}
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
                      valor: desmascararMoeda(promessaValor) || clienteAtual.valorTotal,
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
          <div
            className="panel"
            onClick={e => e.stopPropagation()}
            style={{ width: "min(680px, 96vw)", maxHeight: "92vh", overflowY: "auto", margin: "auto", borderRadius: 16, padding: 22 }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 19, color: "var(--brand)", display: "flex", alignItems: "center", gap: 8 }}>
                  <span>📝</span> Formalizar Acordo de Repactuação
                </h2>
                <div className="sub" style={{ marginTop: 4 }}>
                  Os débitos anteriores serão baixados e novas parcelas com novos vencimentos serão geradas com auditoria completa.
                </div>
              </div>
              <button
                type="button"
                className="btn ghost"
                disabled={repactuando}
                onClick={() => setModalRepactuacao(false)}
                style={{ padding: "4px 10px", fontSize: 12 }}
              >
                ✕ Fechar
              </button>
            </div>

            {/* Resumo da Operação em Cartões */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(135px, 1fr))",
                gap: 8,
                marginBottom: 16,
              }}
            >
              <div style={{ background: "var(--soft)", padding: "10px 12px", borderRadius: 10 }}>
                <div style={{ fontSize: 11, color: "var(--mut)", textTransform: "uppercase" }}>Cliente</div>
                <div style={{ fontWeight: 700, fontSize: 13, color: "var(--ink)" }}>{clienteAtual.cliente}</div>
                <div style={{ fontSize: 11, color: "var(--mut)" }}>{clienteAtual.telefoneOriginal || "Sem telefone"}</div>
              </div>

              <div style={{ background: "rgba(220, 38, 38, 0.08)", padding: "10px 12px", borderRadius: 10, border: "1px solid rgba(220, 38, 38, 0.2)" }}>
                <div style={{ fontSize: 11, color: "var(--bad)", textTransform: "uppercase", fontWeight: 700 }}>Dívida Anterior</div>
                <div style={{ fontWeight: 800, fontSize: 16, color: "var(--bad)" }}>{money(simulacao.saldoTotal)}</div>
                <div style={{ fontSize: 11, color: "var(--bad)" }}>{clienteAtual.promissorias.length} título(s) antigo(s)</div>
              </div>

              <div style={{ background: "rgba(16, 185, 129, 0.08)", padding: "10px 12px", borderRadius: 10, border: "1px solid rgba(16, 185, 129, 0.2)" }}>
                <div style={{ fontSize: 11, color: "#10b981", textTransform: "uppercase", fontWeight: 700 }}>Entrada</div>
                <div style={{ fontWeight: 800, fontSize: 16, color: "#10b981" }}>
                  {simulacao.entradaReal > 0 ? money(simulacao.entradaReal) : "R$ 0,00"}
                </div>
                <div style={{ fontSize: 11, color: "var(--mut)" }}>{simulacao.entradaReal > 0 ? "Com entrada" : "Sem entrada"}</div>
              </div>

              <div style={{ background: "rgba(234, 88, 12, 0.08)", padding: "10px 12px", borderRadius: 10, border: "1px solid rgba(234, 88, 12, 0.2)" }}>
                <div style={{ fontSize: 11, color: "var(--brand)", textTransform: "uppercase", fontWeight: 700 }}>Novo Saldo</div>
                <div style={{ fontWeight: 800, fontSize: 16, color: "var(--brand)" }}>{money(simulacao.saldoRestante)}</div>
                <div style={{ fontSize: 11, color: "var(--brand)", fontWeight: 700 }}>
                  {parcelasQtd}x de {money(simulacao.valorParcela)}
                </div>
              </div>
            </div>

            {/* Seção de Ajuste das Condições */}
            <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, padding: 14, marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
                <span>⚙️</span> Condições do Novo Parcelamento:
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <label style={{ fontSize: 12 }}>
                  Quantidade de Parcelas:
                  <select
                    value={parcelasQtd}
                    onChange={e => setParcelasQtd(Math.max(1, Number(e.target.value)))}
                    style={{ width: "100%", padding: "7px 10px", fontSize: 13, fontWeight: 700, marginTop: 4, borderRadius: 8 }}
                  >
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 18, 24].map(q => (
                      <option key={q} value={q}>{q}x ({money(simulacao.saldoRestante > 0 ? Math.round(simulacao.saldoRestante / q) : 0)} cada)</option>
                    ))}
                  </select>
                </label>

                <label style={{ fontSize: 12 }}>
                  Data do 1º Vencimento:
                  <input
                    type="date"
                    value={primeiroVencRepactuacao}
                    onChange={e => setPrimeiroVencRepactuacao(e.target.value)}
                    required
                    style={{ width: "100%", padding: "6px 10px", fontSize: 13, marginTop: 4, borderRadius: 8 }}
                  />
                </label>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 10 }}>
                <label style={{ fontSize: 12 }}>
                  Sinal de Entrada (R$):
                  <input
                    type="text"
                    value={entradaTexto}
                    placeholder="R$ 0,00"
                    onChange={e => {
                      const formatado = formatarMascaraMoeda(e.target.value, true);
                      setEntradaTexto(formatado);
                      setEntradaValor(desmascararMoeda(formatado));
                    }}
                    inputMode="numeric"
                    style={{ width: "100%", padding: "6px 10px", fontSize: 13, marginTop: 4, borderRadius: 8, fontWeight: 600 }}
                  />
                </label>

                <label style={{ fontSize: 12 }}>
                  Observações do Acordo (opcional):
                  <input
                    type="text"
                    value={obsRepactuacao}
                    placeholder="Ex: Cliente solicitou pagar em 5x..."
                    onChange={e => setObsRepactuacao(e.target.value)}
                    style={{ width: "100%", padding: "6px 10px", fontSize: 13, marginTop: 4, borderRadius: 8 }}
                  />
                </label>
              </div>
            </div>

            {/* Títulos Anteriores que Serão Baixados */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--mut)", textTransform: "uppercase", marginBottom: 6 }}>
                Títulos que serão baixados ({clienteAtual.promissorias.length}):
              </div>
              <div
                style={{
                  maxHeight: 120,
                  overflowY: "auto",
                  border: "1px solid var(--line)",
                  borderRadius: 8,
                  fontSize: 12,
                  background: "var(--soft)",
                }}
              >
                {clienteAtual.promissorias.map(p => (
                  <div
                    key={p.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      padding: "6px 10px",
                      borderBottom: "1px solid var(--line)",
                    }}
                  >
                    <span>
                      <b>#{p.id}</b> · {p.parcelas || "Única"} · Venc: {p.vencimento ? dt(p.vencimento) : "—"}
                    </span>
                    <span>
                      Saldo: <b style={{ color: "var(--bad)" }}>{money(p.saldo_devedor)}</b>
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Box Informativo de Auditoria */}
            <div
              style={{
                background: "rgba(10, 124, 76, 0.08)",
                border: "1px solid rgba(10, 124, 76, 0.25)",
                borderRadius: 10,
                padding: "10px 14px",
                fontSize: 12,
                color: "var(--ink)",
                lineHeight: 1.5,
                marginBottom: 16,
              }}
            >
              <b>🛡️ Auditoria & Registro Permanente de Log:</b>
              <br />
              Esta operação gravará o registro completo da repactuação na tabela de auditoria e no histórico de cada título com:
              identificação do <b>operador logado</b>, <b>data/hora exata</b>, valores renegociados e vínculo entre os títulos antigos baixados e as <b>{parcelasQtd} novas parcelas</b> geradas.
            </div>

            {/* Botões de Ação */}
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                type="button"
                className="btn ghost"
                disabled={repactuando}
                onClick={() => setModalRepactuacao(false)}
                style={{ padding: "10px 18px" }}
              >
                Cancelar
              </button>

              <button
                type="button"
                className="btn"
                disabled={repactuando || simulacao.saldoRestante < 0}
                onClick={async () => {
                  setRepactuando(true);
                  try {
                    // 1. Obter usuário logado para auditoria
                    const { data: userData } = await supabase.auth.getUser();
                    const operadorEmail = userData.user?.email || "operador@leoticas.fin";
                    const operadorId = userData.user?.id || null;
                    const agoraIso = new Date().toISOString();

                    const titulosAntigosIds = clienteAtual.promissorias.map(p => p.id);
                    const titulosAntigosDesc = clienteAtual.promissorias
                      .map(p => `#${p.id} (${p.parcelas || "1X"} - Saldo ${money(p.saldo_devedor)})`)
                      .join(", ");

                    const obsFinal = obsRepactuacao.trim();
                    const detalhesLogAcordo = `Acordo de Repactuação em ${parcelasQtd}x formalizado por ${operadorEmail} em ${new Date().toLocaleString("pt-BR")}. ` +
                      `Saldo total renegociado: ${money(simulacao.saldoTotal)} de ${clienteAtual.promissorias.length} título(s) antigo(s) [${titulosAntigosDesc}]. ` +
                      (simulacao.entradaReal > 0 ? `Entrada: ${money(simulacao.entradaReal)}. ` : `Sem entrada (R$ 0,00). `) +
                      `Novo saldo de ${money(simulacao.saldoRestante)} parcelado em ${parcelasQtd}x de ${money(simulacao.valorParcela)}, com 1º vencimento em ${dt(primeiroVencRepactuacao)}.` +
                      (obsFinal ? ` Obs: ${obsFinal}` : "");

                    // 2. Dar baixa nas promissórias antigas e registrar logs
                    for (const p of clienteAtual.promissorias) {
                      // 2.1 Preservar histórico anterior se existir
                      let logsArray: any[] = [];
                      if (p.origem) {
                        try {
                          const parsed = JSON.parse(p.origem);
                          if (Array.isArray(parsed)) logsArray = parsed;
                        } catch (_) {}
                      }

                      logsArray.push({
                        data: agoraIso,
                        valor: 0, // Baixa contábil por novação de dívida (sem entrada em dinheiro no caixa)
                        saldoRepactuado: p.saldo_devedor,
                        operador: operadorEmail,
                        detalhes: detalhesLogAcordo,
                        acordo: {
                          tipo: "REPACTUACAO_BAIXA",
                          parcelasQtd,
                          saldoTotalAnterior: simulacao.saldoTotal,
                          entrada: simulacao.entradaReal,
                          novoSaldo: simulacao.saldoRestante,
                          valorParcela: simulacao.valorParcela,
                          primeiroVencimento: primeiroVencRepactuacao,
                          titulosEnvolvidos: titulosAntigosIds,
                          observacoes: obsFinal || undefined,
                        },
                      });

                      // 2.2 Atualiza promissória antiga para QUITADA com o log completo em origem
                      const { error: errUpd } = await supabase
                        .from("promissorias")
                        .update({
                          valor_pago: p.divida_total,
                          origem: JSON.stringify(logsArray),
                        })
                        .eq("id", p.id);

                      if (errUpd) throw new Error(`Erro ao baixar título #${p.id}: ${errUpd.message}`);

                      // 2.3 Grava auditoria na tabela promissoria_pagamentos
                      try {
                        await supabase.from("promissoria_pagamentos").insert({
                          promissoria_id: p.id,
                          valor_pago: p.saldo_devedor,
                          operador_email: operadorEmail,
                          operador_id: operadorId,
                          data_pagamento: agoraIso,
                          detalhes: detalhesLogAcordo,
                        });
                      } catch (ePay) {
                        console.warn("Aviso ao gravar promissoria_pagamentos:", ePay);
                      }

                      // 2.4 Grava evento em promissoria_eventos se existir
                      try {
                        await supabase.from("promissoria_eventos").insert({
                          promissoria_id: p.id,
                          tipo: "BAIXA",
                          motivo: `Repactuado em ${parcelasQtd}x. ${detalhesLogAcordo.slice(0, 200)}`,
                          saldo_na_data: p.saldo_devedor,
                          usuario_id: operadorId,
                        });
                      } catch (_) {}
                    }

                    // 3. Gerar as novas promissórias com divisão centavo a centavo e log gravado
                    const novas = [];
                    const baseCentavos = Math.floor(simulacao.saldoRestante / parcelasQtd);
                    const restoCentavos = simulacao.saldoRestante % parcelasQtd;

                    for (let i = 1; i <= parcelasQtd; i++) {
                      const valorDestaParcela = baseCentavos + (i === 1 ? restoCentavos : 0);
                      const d = new Date(primeiroVencRepactuacao + "T00:00:00Z");
                      d.setUTCMonth(d.getUTCMonth() + (i - 1));
                      const vencStr = d.toISOString().slice(0, 10);

                      const logNovaPromissoria = [
                        {
                          data: agoraIso,
                          valor: 0,
                          operador: operadorEmail,
                          detalhes: `Promissória gerada por Acordo de Repactuação (${i}/${parcelasQtd}). ${detalhesLogAcordo}`,
                          acordo: {
                            tipo: "NOVA_PARCELA_REPACTUADA",
                            numeroParcela: i,
                            totalParcelas: parcelasQtd,
                            saldoTotalAnterior: simulacao.saldoTotal,
                            entrada: simulacao.entradaReal,
                            titulosOriginais: titulosAntigosIds,
                            observacoes: obsFinal || undefined,
                          },
                        },
                      ];

                      novas.push({
                        cliente_nome: clienteAtual.cliente,
                        telefone: clienteAtual.telefoneOriginal,
                        divida_total: valorDestaParcela,
                        valor_pago: 0,
                        vencimento: vencStr,
                        parcelas: `${i}/${parcelasQtd}`,
                        origem: JSON.stringify(logNovaPromissoria),
                        fundo_perdido: false,
                      });
                    }

                    const { data: dadosNovos, error: errIns } = await supabase
                      .from("promissorias")
                      .insert(novas)
                      .select("id");

                    if (errIns) throw new Error("Erro ao gerar novas promissórias: " + errIns.message);

                    // 4. Se houver entrada > 0, registrar o pagamento em promissoria_pagamentos
                    if (simulacao.entradaReal > 0 && dadosNovos && dadosNovos.length > 0) {
                      try {
                        await supabase.from("promissoria_pagamentos").insert({
                          promissoria_id: dadosNovos[0].id,
                          valor_pago: simulacao.entradaReal,
                          operador_email: operadorEmail,
                          operador_id: operadorId,
                          data_pagamento: agoraIso,
                          detalhes: `Sinal de Entrada (${money(simulacao.entradaReal)}) recebido no ato da repactuação em ${parcelasQtd}x.`,
                        });
                      } catch (_) {}
                    }

                    alert(
                      `✅ Acordo formalizado com sucesso no sistema!\n\n` +
                      `• ${clienteAtual.promissorias.length} título(s) anterior(es) quitado(s) com registro de auditoria.\n` +
                      `• ${parcelasQtd} nova(s) parcela(s) gerada(s) com sucesso!\n` +
                      `• Log permanente da operação registrado no histórico e na auditoria.`
                    );
                    setModalRepactuacao(false);
                    setObsRepactuacao("");
                    carregarDados();
                  } catch (err: any) {
                    alert("Erro ao formalizar acordo: " + (err.message || err));
                  } finally {
                    setRepactuando(false);
                  }
                }}
                style={{ padding: "10px 22px", fontWeight: 700 }}
              >
                {repactuando ? "Gravando no Banco…" : "Confirmar e Gravar Acordo"}
              </button>
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
