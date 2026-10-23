import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";
import {
  baixarCSV, dt, hoje, money, normalizarTelefones, obterPromessasPagamento, marcarPromessaCumprida,
  formatarMascaraMoeda, desmascararMoeda, mascaraTelefone,
} from "./lib";
import type { Row, Status, PromessaPagamento } from "./lib";
import { FichaCliente, WhatsDialog } from "./Dialogs";

type ResumoRPC = {
  total: number;
  divida: number;
  pago: number;
  saldo: number;
  perdido: number;
  status: Record<Status, number>;
  vencidas_qtd: number;
  vencidas_valor: number;
  proximas_qtd: number;
  proximas_valor: number;
  hoje_qtd?: number;
  hoje_valor?: number;
};

type PromissoriaResumida = {
  id: number;
  cliente_nome: string;
  telefone: string;
  saldo_devedor: number;
  divida_total: number;
  valor_pago: number;
  vencimento: string | null;
  dias_atraso: number;
};

type FaixaAging = {
  id: string;
  titulo: string;
  subtitulo: string;
  diasLabel: string;
  cor: string;
  bgCor: string;
  nivelRisco: "baixo" | "medio" | "alto" | "critico" | "perdido" | "hoje";
  qtd: number;
  valor: number;
  porcentagemDoVencido: number;
  estrategiaSugerida: string;
};

type TopDevedor = {
  cliente: string;
  telefone: string;
  qtdPromissorias: number;
  totalVencido: number;
  maiorAtrasoDias: number;
  vencimentoMaisAntigo: string | null;
};

function calcularDiasAtraso(dataHoje: string, venc: string | null): number {
  if (!venc) return 0;
  const tH = new Date(dataHoje + "T00:00:00Z").getTime();
  const tV = new Date(venc + "T00:00:00Z").getTime();
  return Math.round((tH - tV) / (1000 * 60 * 60 * 24));
}

const META_RECUPERACAO_KEY = "leooticas_meta_recuperacao_inadimplentes";
const META_GLOBAL_KEY = "leooticas_meta_arrecadacao_global";
const MODO_META_KEY = "leooticas_modo_meta_dashboard";

export type DadosRecuperacaoMes = {
  totalCaixa: number;
  totalInadimplencia: number;
  faixas: {
    ate30: number;
    d30a60: number;
    d60a90: number;
    d90a180: number;
    mais180: number;
    emDia: number;
  };
};

export default function Dashboard({ onNavegarAba }: { onNavegarAba?: (aba: string, filtro?: string) => void }) {
  const [resumo, setResumo] = useState<ResumoRPC | null>(null);
  const [abertas, setAbertas] = useState<PromissoriaResumida[]>([]);
  const [perdidas, setPerdidas] = useState<{ id: number; cliente_nome: string; saldo_devedor: number; divida_total: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [fichaCliente, setFichaCliente] = useState<{ cliente: string; telefone?: string } | null>(null);
  const [whats, setWhats] = useState<{ cliente: string; telefone: string; valor: number; vencimento?: string } | null>(null);
  const [menuExportar, setMenuExportar] = useState(false);
  const [promessas, setPromessas] = useState<PromessaPagamento[]>([]);
  
  // Modos de Meta: "inadimplentes" (crédito vencido recuperado) ou "global" (total recebido em caixa)
  const [modoMeta, setModoMeta] = useState<"inadimplentes" | "global">(() => {
    try {
      const s = localStorage.getItem(MODO_META_KEY);
      return s === "global" ? "global" : "inadimplentes";
    } catch {
      return "inadimplentes";
    }
  });

  const [metaRecuperacao, setMetaRecuperacao] = useState<number>(() => {
    try {
      const sal = localStorage.getItem(META_RECUPERACAO_KEY) || localStorage.getItem("leooticas_meta_recuperacao_mensal");
      if (!sal) return 1500000; // Padrão R$ 15.000,00
      const n = Number(sal);
      if (n > 0 && n < 100000) return n * 100;
      return n > 0 ? n : 1500000;
    } catch {
      return 1500000;
    }
  });

  const [metaGlobal, setMetaGlobal] = useState<number>(() => {
    try {
      const sal = localStorage.getItem(META_GLOBAL_KEY);
      if (!sal) return 3000000; // Padrão R$ 30.000,00
      const n = Number(sal);
      if (n > 0 && n < 100000) return n * 100;
      return n > 0 ? n : 3000000;
    } catch {
      return 3000000;
    }
  });

  const [dadosRecuperacao, setDadosRecuperacao] = useState<DadosRecuperacaoMes>({
    totalCaixa: 0,
    totalInadimplencia: 0,
    faixas: {
      ate30: 0,
      d30a60: 0,
      d60a90: 0,
      d90a180: 0,
      mais180: 0,
      emDia: 0,
    },
  });

  const [editandoMeta, setEditandoMeta] = useState(false);
  const [novaMetaStr, setNovaMetaStr] = useState("");

  const dataHoje = hoje();

  const carregarDados = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      // 1. Resumo agregado via RPC
      const qResumo = await supabase.rpc("promissorias_resumo");
      if (qResumo.error) throw new Error(qResumo.error.message);
      const res = { ...(qResumo.data as ResumoRPC) };

      // 2. Busca todas as promissórias com saldo em aberto (em lotes)
      const listaAbertas: PromissoriaResumida[] = [];
      const pageSize = 1000;
      let from = 0;

      while (true) {
        const { data, error } = await supabase
          .from("promissorias")
          .select("id, cliente_nome, telefone, saldo_devedor, divida_total, valor_pago, vencimento")
          .eq("fundo_perdido", false)
          .gt("saldo_devedor", 0)
          .range(from, from + pageSize - 1);

        if (error) throw new Error(error.message);
        if (!data || !data.length) break;

        for (const item of data) {
          const dias = calcularDiasAtraso(dataHoje, item.vencimento);
          listaAbertas.push({
            id: item.id,
            cliente_nome: item.cliente_nome || "Sem nome",
            telefone: item.telefone || "",
            saldo_devedor: item.saldo_devedor || 0,
            divida_total: item.divida_total || 0,
            valor_pago: item.valor_pago || 0,
            vencimento: item.vencimento,
            dias_atraso: dias,
          });
        }

        if (data.length < pageSize) break;
        from += pageSize;
      }

      // 3. Busca promissórias em fundo perdido para totalização
      const { data: dadosPerdidos } = await supabase
        .from("promissorias")
        .select("id, cliente_nome, saldo_devedor, divida_total")
        .eq("fundo_perdido", true);

      // 4. Busca recuperação do mês corrente e categoriza por tempo de atraso (Aging da Recuperação)
      const pagamentosMap = new Map<string, { valor: number; diasAtraso: number }>();
      const [anoAtual, mesAtual] = dataHoje.split("-");
      const mesAnoFiltro = `${anoAtual}-${mesAtual}`;
      const inicioMesIso = `${anoAtual}-${mesAtual}-01T00:00:00Z`;
      const proximoAno = Number(mesAtual) === 12 ? Number(anoAtual) + 1 : Number(anoAtual);
      const proximoMes = Number(mesAtual) === 12 ? 1 : Number(mesAtual) + 1;
      const inicioProxMesIso = `${proximoAno}-${String(proximoMes).padStart(2, "0")}-01T00:00:00Z`;

      // 4.1 Consulta tabela de pagamentos dedicada (se existir)
      try {
        const { data: pags, error: errPags } = await supabase
          .from("promissoria_pagamentos")
          .select("promissoria_id, valor_pago, data_pagamento, promissorias(vencimento)")
          .gte("data_pagamento", inicioMesIso)
          .lt("data_pagamento", inicioProxMesIso);

        if (!errPags && pags) {
          for (const p of pags) {
            const key = `${p.promissoria_id}_${p.data_pagamento}_${p.valor_pago}`;
            const dtPag = new Date((p.data_pagamento || "").slice(0, 10) + "T00:00:00Z").getTime();
            const venc = (p.promissorias as any)?.vencimento;
            const dtVenc = venc ? new Date(venc + "T00:00:00Z").getTime() : 0;
            const diasAtraso = dtVenc ? Math.round((dtPag - dtVenc) / 86400000) : 0;
            pagamentosMap.set(key, { valor: p.valor_pago || 0, diasAtraso });
          }
        }
      } catch (_) {}

      // 4.2 Consulta promissórias com baixas registradas em 'origem' no mês corrente
      try {
        const { data: baixasOrigem, error: errOrigem } = await supabase
          .from("promissorias")
          .select("id, vencimento, origem")
          .ilike("origem", `%${mesAnoFiltro}%`);

        if (!errOrigem && baixasOrigem) {
          for (const row of baixasOrigem) {
            if (!row.origem) continue;
            try {
              const parsed = JSON.parse(row.origem);
              if (Array.isArray(parsed)) {
                for (const item of parsed) {
                  if (item.data && typeof item.data === "string" && item.data.startsWith(mesAnoFiltro)) {
                    // Ignora baixas contábeis por novação/repactuação de dívida (sem entrada em dinheiro)
                    if (item.acordo?.tipo === "REPACTUACAO_BAIXA" || (typeof item.detalhes === "string" && item.detalhes.includes("Acordo de Repactuação"))) {
                      continue;
                    }
                    const val = item.valor || 0;
                    if (val <= 0) continue;
                    const key = `${row.id}_${item.data}_${val}`;
                    if (!pagamentosMap.has(key)) {
                      const dtPag = new Date(item.data.slice(0, 10) + "T00:00:00Z").getTime();
                      const dtVenc = row.vencimento ? new Date(row.vencimento + "T00:00:00Z").getTime() : 0;
                      const diasAtraso = dtVenc ? Math.round((dtPag - dtVenc) / 86400000) : 0;
                      pagamentosMap.set(key, { valor: val, diasAtraso });
                    }
                  }
                }
              }
            } catch (_) {}
          }
        }
      } catch (_) {}

      let totalCaixa = 0;
      let totalInadimplencia = 0;
      const faixas = {
        ate30: 0,
        d30a60: 0,
        d60a90: 0,
        d90a180: 0,
        mais180: 0,
        emDia: 0,
      };

      for (const item of pagamentosMap.values()) {
        totalCaixa += item.valor;
        if (item.diasAtraso <= 0) {
          faixas.emDia += item.valor;
        } else {
          totalInadimplencia += item.valor;
          if (item.diasAtraso <= 30) {
            faixas.ate30 += item.valor;
          } else if (item.diasAtraso <= 60) {
            faixas.d30a60 += item.valor;
          } else if (item.diasAtraso <= 90) {
            faixas.d60a90 += item.valor;
          } else if (item.diasAtraso <= 180) {
            faixas.d90a180 += item.valor;
          } else {
            faixas.mais180 += item.valor;
          }
        }
      }

      setDadosRecuperacao({
        totalCaixa,
        totalInadimplencia,
        faixas,
      });

      setResumo(res);
      setAbertas(listaAbertas);
      setPerdidas(dadosPerdidos || []);
      setPromessas(obterPromessasPagamento());
    } catch (e: any) {
      setError(e.message || "Erro ao carregar dados do dashboard.");
    } finally {
      setLoading(false);
    }
  }, [dataHoje]);

  useEffect(() => {
    carregarDados();
  }, [carregarDados]);

  // Cálculos consolidados
  const metricas = useMemo(() => {
    const totalDivida = resumo?.divida ?? 0;
    const totalPago = resumo?.pago ?? 0;
    const totalSaldo = resumo?.saldo ?? 0;
    const totalPerdido = resumo?.perdido ?? 0;
    const totalPromissorias = resumo?.total ?? 0;

    // Filtra vencidas (dias_atraso >= 1)
    const listaVencidas = abertas.filter(r => r.dias_atraso >= 1);
    const totalVencidoValor = listaVencidas.reduce((s, r) => s + r.saldo_devedor, 0);
    const totalVencidoQtd = listaVencidas.length;

    // Vencendo hoje
    const listaHoje = abertas.filter(r => r.vencimento === dataHoje);
    const hojeValor = listaHoje.reduce((s, r) => s + r.saldo_devedor, 0);
    const hojeQtd = listaHoje.length;

    // A vencer no futuro (em dia)
    const listaAVencer = abertas.filter(r => !r.vencimento || r.vencimento > dataHoje);
    const aVencerValor = listaAVencer.reduce((s, r) => s + r.saldo_devedor, 0);
    const aVencerQtd = listaAVencer.length;

    // Taxa de Inadimplência (% do saldo a receber que está vencido)
    const taxaInadimplencia = totalSaldo > 0 ? (totalVencidoValor / totalSaldo) * 100 : 0;

    // Taxa de Arrecadação / Eficiência de Quitação
    const taxaLiquidacao = totalDivida > 0 ? (totalPago / totalDivida) * 100 : 0;

    // Ticket Médio de Venda
    const ticketMedioVenda = totalPromissorias > 0 ? totalDivida / totalPromissorias : 0;

    // Ticket Médio de Saldo
    const ticketMedioSaldo = abertas.length > 0 ? totalSaldo / abertas.length : 0;

    // Total de Clientes Únicos com dívida
    const clientesComSaldo = new Set(abertas.map(r => r.cliente_nome.trim().toUpperCase())).size;

    return {
      totalDivida,
      totalPago,
      totalSaldo,
      totalPerdido,
      totalPromissorias,
      totalVencidoValor,
      totalVencidoQtd,
      hojeValor,
      hojeQtd,
      aVencerValor,
      aVencerQtd,
      taxaInadimplencia,
      taxaLiquidacao,
      ticketMedioVenda,
      ticketMedioSaldo,
      clientesComSaldo,
    };
  }, [resumo, abertas, dataHoje]);

  // Faixas do Aging da Inadimplência
  const faixasAging: FaixaAging[] = useMemo(() => {
    const totalVenc = metricas.totalVencidoValor || 1;

    // 1. Vencem Hoje
    const fHoje = abertas.filter(r => r.vencimento === dataHoje);
    const valHoje = fHoje.reduce((s, r) => s + r.saldo_devedor, 0);

    // 2. 1 a 7 dias
    const f1a7 = abertas.filter(r => r.dias_atraso >= 1 && r.dias_atraso <= 7);
    const val1a7 = f1a7.reduce((s, r) => s + r.saldo_devedor, 0);

    // 3. 8 a 30 dias
    const f8a30 = abertas.filter(r => r.dias_atraso >= 8 && r.dias_atraso <= 30);
    const val8a30 = f8a30.reduce((s, r) => s + r.saldo_devedor, 0);

    // 4. 31 a 60 dias
    const f31a60 = abertas.filter(r => r.dias_atraso >= 31 && r.dias_atraso <= 60);
    const val31a60 = f31a60.reduce((s, r) => s + r.saldo_devedor, 0);

    // 5. 61 a 90 dias
    const f61a90 = abertas.filter(r => r.dias_atraso >= 61 && r.dias_atraso <= 90);
    const val61a90 = f61a90.reduce((s, r) => s + r.saldo_devedor, 0);

    // 6. 90 a 180 dias
    const f90a180 = abertas.filter(r => r.dias_atraso >= 91 && r.dias_atraso <= 180);
    const val90a180 = f90a180.reduce((s, r) => s + r.saldo_devedor, 0);

    // 7. Acima de 180 dias (+180d)
    const fMais180 = abertas.filter(r => r.dias_atraso > 180);
    const valMais180 = fMais180.reduce((s, r) => s + r.saldo_devedor, 0);

    // 8. Fundo Perdido
    const valPerdido = perdidas.reduce((s, r) => s + r.saldo_devedor, 0);

    return [
      {
        id: "hoje",
        titulo: "Vencendo Hoje",
        subtitulo: "Projetado para receber hoje",
        diasLabel: "Vence hoje",
        cor: "var(--brand)",
        bgCor: "rgba(10, 124, 76, 0.08)",
        nivelRisco: "hoje",
        qtd: fHoje.length,
        valor: valHoje,
        porcentagemDoVencido: 0,
        estrategiaSugerida: "Lembrete gentil via WhatsApp pela manhã com chave PIX.",
      },
      {
        id: "1_7",
        titulo: "1 a 7 dias",
        subtitulo: "Atraso leve / Esquecimento",
        diasLabel: "1–7 dias",
        cor: "#0284c7",
        bgCor: "rgba(2, 132, 199, 0.08)",
        nivelRisco: "baixo",
        qtd: f1a7.length,
        valor: val1a7,
        porcentagemDoVencido: (val1a7 / totalVenc) * 100,
        estrategiaSugerida: "Lembrete amigável sem constrangimento. Chance de 90% de sucesso.",
      },
      {
        id: "8_30",
        titulo: "8 a 30 dias",
        subtitulo: "Atraso recente / Atenção",
        diasLabel: "8–30 dias",
        cor: "#d97706",
        bgCor: "rgba(217, 119, 6, 0.08)",
        nivelRisco: "medio",
        qtd: f8a30.length,
        valor: val8a30,
        porcentagemDoVencido: (val8a30 / totalVenc) * 100,
        estrategiaSugerida: "Contato ativo e escuta. Perguntar o que ocorreu e obter promessa de pagamento.",
      },
      {
        id: "31_60",
        titulo: "31 a 60 dias",
        subtitulo: "Atraso moderado / Repactuação",
        diasLabel: "31–60 dias",
        cor: "#ea580c",
        bgCor: "rgba(234, 88, 12, 0.08)",
        nivelRisco: "alto",
        qtd: f31a60.length,
        valor: val31a60,
        porcentagemDoVencido: (val31a60 / totalVenc) * 100,
        estrategiaSugerida: "Proposta binária: Entrada imediata de compromisso + parcelamento do saldo.",
      },
      {
        id: "61_90",
        titulo: "61 a 90 dias",
        subtitulo: "Atraso grave / Risco de perda",
        diasLabel: "61–90 dias",
        cor: "#dc2626",
        bgCor: "rgba(220, 38, 38, 0.08)",
        nivelRisco: "critico",
        qtd: f61a90.length,
        valor: val61a90,
        porcentagemDoVencido: (val61a90 / totalVenc) * 100,
        estrategiaSugerida: "Negociação firme. Desconto pontual para quitação ou renegociação com garantia.",
      },
      {
        id: "90_180",
        titulo: "90 a 180 dias",
        subtitulo: "Atraso severo / Renegociação",
        diasLabel: "90–180 dias",
        cor: "#b91c1c",
        bgCor: "rgba(185, 28, 28, 0.08)",
        nivelRisco: "critico",
        qtd: f90a180.length,
        valor: val90a180,
        porcentagemDoVencido: (val90a180 / totalVenc) * 100,
        estrategiaSugerida: "Proposta agressiva de repactuação com entrada facilitada ou desconto de 30% à vista.",
      },
      {
        id: "mais_180",
        titulo: "Acima de 180 dias",
        subtitulo: "Crítico / Alta inadimplência",
        diasLabel: "+180 dias",
        cor: "#7f1d1d",
        bgCor: "rgba(127, 29, 29, 0.1)",
        nivelRisco: "critico",
        qtd: fMais180.length,
        valor: valMais180,
        porcentagemDoVencido: (valMais180 / totalVenc) * 100,
        estrategiaSugerida: "Feirão de quitação: desconto agressivo à vista (40% a 50%) via PIX imediato.",
      },
      {
        id: "perdido",
        titulo: "Fundo Perdido",
        subtitulo: "Baixadas contabilmente",
        diasLabel: "Fundo Perdido",
        cor: "#64748b",
        bgCor: "rgba(100, 116, 139, 0.08)",
        nivelRisco: "perdido",
        qtd: perdidas.length,
        valor: valPerdido,
        porcentagemDoVencido: 0,
        estrategiaSugerida: "Campanha especial de reabilitação cadastral para resgatar caixa.",
      },
    ];
  }, [abertas, perdidas, dataHoje, metricas.totalVencidoValor]);

  // Top 5 Clientes com maior saldo vencido
  const topDevedores: TopDevedor[] = useMemo(() => {
    const mapa = new Map<string, { cliente: string; telefone: string; promissorias: PromissoriaResumida[] }>();

    for (const r of abertas) {
      if (r.dias_atraso < 1) continue;
      const chave = r.cliente_nome.trim().toUpperCase();
      if (!mapa.has(chave)) {
        mapa.set(chave, { cliente: r.cliente_nome, telefone: r.telefone, promissorias: [] });
      }
      mapa.get(chave)!.promissorias.push(r);
    }

    const lista: TopDevedor[] = [];
    for (const item of mapa.values()) {
      const totalVencido = item.promissorias.reduce((s, p) => s + p.saldo_devedor, 0);
      const maiorAtrasoDias = Math.max(...item.promissorias.map(p => p.dias_atraso));
      const vencMaisAntigo = item.promissorias.map(p => p.vencimento).filter(Boolean).sort()[0] || null;

      lista.push({
        cliente: item.cliente,
        telefone: item.telefone,
        qtdPromissorias: item.promissorias.length,
        totalVencido,
        maiorAtrasoDias,
        vencimentoMaisAntigo: vencMaisAntigo,
      });
    }

    return lista.sort((a, b) => b.totalVencido - a.totalVencido).slice(0, 5);
  }, [abertas]);

  // Exportar Excel
  const handleExportarExcel = () => {
    const cab = [
      "Faixa / Indicador",
      "Qtd Promissórias",
      "Valor Total (R$)",
      "% da Inadimplência",
      "Estratégia Recomendada",
    ];

    const linhas: (string | number)[][] = [
      ["RESUMO GERAL", "", "", "", ""],
      ["Total de Venda (Carteira)", metricas.totalPromissorias, metricas.totalDivida.toFixed(2), "", ""],
      ["Total Quitado / Pago", "", metricas.totalPago.toFixed(2), `${metricas.taxaLiquidacao.toFixed(1)}%`, ""],
      ["Saldo Total a Receber", abertas.length, metricas.totalSaldo.toFixed(2), "", ""],
      ["Total Vencido em Atraso", metricas.totalVencidoQtd, metricas.totalVencidoValor.toFixed(2), `${metricas.taxaInadimplencia.toFixed(1)}%`, ""],
      ["Saldo a Vencer (Em dia)", metricas.aVencerQtd, metricas.aVencerValor.toFixed(2), "", ""],
      ["", "", "", "", ""],
      ["AGING DE VENCIMENTO", "", "", "", ""],
      ...faixasAging.map(f => [
        f.titulo,
        f.qtd,
        f.valor.toFixed(2),
        f.porcentagemDoVencido > 0 ? `${f.porcentagemDoVencido.toFixed(1)}%` : "—",
        f.estrategiaSugerida,
      ]),
      ["", "", "", "", ""],
      ["TOP 5 MAIORES SALDOS EM ATRASO", "", "", "", ""],
      ...topDevedores.map(t => [
        t.cliente,
        t.qtdPromissorias,
        t.totalVencido.toFixed(2),
        `${t.maiorAtrasoDias} dias de atraso`,
        t.telefone,
      ]),
    ];

    baixarCSV(`dashboard-operacional-${dataHoje}.csv`, cab, linhas);
    setMenuExportar(false);
  };

  // Exportar PDF
  const handleExportarPDF = () => {
    setMenuExportar(false);
    window.print();
  };

  // Metadados do Mês Corrente (Dias, Ritmo, Projeção e Taxa de Resgate)
  const metaInfo = useMemo(() => {
    const [anoStr, mesStr, diaStr] = dataHoje.split("-");
    const ano = Number(anoStr) || 2026;
    const mes = Number(mesStr) || 10;
    const dia = Number(diaStr) || 1;

    const dataObj = new Date(ano, mes - 1, dia);
    const nomeMes = dataObj.toLocaleDateString("pt-BR", { month: "long" });
    const nomeMesCapitalizado = nomeMes.charAt(0).toUpperCase() + nomeMes.slice(1);

    const totalDiasMes = new Date(ano, mes, 0).getDate();
    const diasPassados = Math.min(dia, totalDiasMes);
    const diasRestantes = Math.max(0, totalDiasMes - diasPassados);

    const metaAtiva = modoMeta === "inadimplentes" ? metaRecuperacao : metaGlobal;
    const valorAtivo = modoMeta === "inadimplentes" ? dadosRecuperacao.totalInadimplencia : dadosRecuperacao.totalCaixa;

    const mediaDiaria = diasPassados > 0 ? valorAtivo / diasPassados : 0;
    const projecaoFechamento = diasPassados > 0 ? Math.round(mediaDiaria * totalDiasMes) : 0;
    const pct = metaAtiva > 0 ? (valorAtivo / metaAtiva) * 100 : 0;

    // Ideia 3: Taxa de Resgate da Inadimplência
    const totalVencidoAtual = metricas.totalVencidoValor || 0;
    const poolVencido = totalVencidoAtual + dadosRecuperacao.totalInadimplencia;
    const taxaResgate = poolVencido > 0 ? (dadosRecuperacao.totalInadimplencia / poolVencido) * 100 : 0;

    return {
      nomeMes: nomeMesCapitalizado,
      totalDiasMes,
      diasPassados,
      diasRestantes,
      metaAtiva,
      valorAtivo,
      mediaDiaria,
      projecaoFechamento,
      pct,
      taxaResgate,
      totalVencidoAtual,
      poolVencido,
    };
  }, [dataHoje, modoMeta, metaRecuperacao, metaGlobal, dadosRecuperacao, metricas.totalVencidoValor]);

  if (loading) {
    return (
      <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--mut)" }}>
        <div style={{ fontSize: 24, marginBottom: 12 }}>Carregando indicadores da operação...</div>
        <div>Calculando taxas de inadimplência, faixas de atraso e projeções de liquidez.</div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1300, margin: "0 auto", paddingBottom: 40 }}>
      {/* Cabeçalho da Página */}
      <div className="head2 noprint" style={{ alignItems: "center", marginBottom: 20 }}>
        <div>
          <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}>
            <span>📊</span> Dashboard Operacional & Financeiro
          </h1>
          <div className="sub" style={{ marginTop: 4 }}>
            Visão consolidada em tempo real da inadimplência, aging de vencimentos e desempenho do crediário.
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            type="button"
            className="btn ghost"
            onClick={carregarDados}
            title="Recarregar todos os indicadores"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <span>🔄</span> Atualizar
          </button>

          {/* Dropdown Exportar */}
          <div style={{ position: "relative" }}>
            <button
              type="button"
              className="btn"
              onClick={() => setMenuExportar(prev => !prev)}
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <span>📥</span> Exportar Relatório ▾
            </button>

            {menuExportar && (
              <>
                <div
                  style={{ position: "fixed", inset: 0, zIndex: 90 }}
                  onClick={() => setMenuExportar(false)}
                />
                <div
                  style={{
                    position: "absolute",
                    right: 0,
                    top: "calc(100% + 4px)",
                    background: "var(--card)",
                    border: "1px solid var(--line)",
                    borderRadius: 10,
                    boxShadow: "0 10px 25px rgba(0,0,0,0.15)",
                    zIndex: 100,
                    minWidth: 200,
                    padding: 6,
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  <button
                    type="button"
                    onClick={handleExportarExcel}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      width: "100%",
                      padding: "8px 12px",
                      background: "transparent",
                      border: 0,
                      borderRadius: 6,
                      cursor: "pointer",
                      textAlign: "left",
                      fontSize: 13,
                      fontWeight: 600,
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = "var(--soft)")}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                  >
                    <span>📗</span> Exportar para Excel (.csv)
                  </button>
                  <button
                    type="button"
                    onClick={handleExportarPDF}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      width: "100%",
                      padding: "8px 12px",
                      background: "transparent",
                      border: 0,
                      borderRadius: 6,
                      cursor: "pointer",
                      textAlign: "left",
                      fontSize: 13,
                      fontWeight: 600,
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = "var(--soft)")}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                  >
                    <span>📕</span> Exportar para PDF / Imprimir
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {error && <div className="warn" style={{ marginBottom: 20 }}>Erro: {error}</div>}

      {/* BLOCO 1: KPIs Principais de Governança Financeira */}
      <section className="kpis" style={{ marginBottom: 22 }}>
        {/* Card 1: Saldo a Receber */}
        <div className="card hl" style={{ borderLeftWidth: 4, borderLeftColor: "var(--brand)" }}>
          <small style={{ textTransform: "uppercase", letterSpacing: ".05em" }}>Saldo a Receber Ativo</small>
          <b style={{ fontSize: 24 }}>{money(metricas.totalSaldo)}</b>
          <div className="ksub">
            {abertas.length.toLocaleString("pt-BR")} promissórias de {metricas.clientesComSaldo.toLocaleString("pt-BR")} clientes
          </div>
        </div>

        {/* Card 2: Inadimplência Global (Destaque Crítico) */}
        <div
          className="card"
          style={{
            borderLeftWidth: 4,
            borderLeftColor: metricas.taxaInadimplencia > 30 ? "var(--bad)" : "var(--warn)",
            background: "color-mix(in srgb, var(--card) 92%, var(--soft))",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <small style={{ textTransform: "uppercase", letterSpacing: ".05em" }}>Inadimplência Global</small>
            <span
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: metricas.taxaInadimplencia > 30 ? "var(--bad)" : "var(--warn)",
                background: metricas.taxaInadimplencia > 30 ? "rgba(180, 35, 24, 0.1)" : "rgba(217, 119, 6, 0.1)",
                padding: "2px 8px",
                borderRadius: 99,
              }}
            >
              {metricas.taxaInadimplencia.toFixed(1)}% do saldo
            </span>
          </div>
          <b style={{ fontSize: 24, color: metricas.taxaInadimplencia > 30 ? "var(--bad)" : "var(--ink)" }}>
            {money(metricas.totalVencidoValor)}
          </b>
          <div className="ksub" style={{ color: "var(--bad)" }}>
            {metricas.totalVencidoQtd.toLocaleString("pt-BR")} promissórias em atraso
          </div>
        </div>

        {/* Card 3: Total de Venda */}
        <div className="card">
          <small style={{ textTransform: "uppercase", letterSpacing: ".05em" }}>Total de Venda (Carteira)</small>
          <b style={{ fontSize: 24 }}>{money(metricas.totalDivida)}</b>
          <div className="ksub">
            Ticket médio: {money(metricas.ticketMedioVenda)}
          </div>
        </div>

        {/* Card 4: Total Quitado & Eficiência */}
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <small style={{ textTransform: "uppercase", letterSpacing: ".05em" }}>Total Quitado</small>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--brand)" }}>
              {metricas.taxaLiquidacao.toFixed(1)}% quitado
            </span>
          </div>
          <b style={{ fontSize: 24, color: "var(--brand)" }}>{money(metricas.totalPago)}</b>
          <div className="ksub">
            Recuperado / recebido em caixa
          </div>
        </div>
      </section>

      {/* BLOCO EXTRA: META MENSAL DE RECUPERAÇÃO & PROMESSAS DE HOJE */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14, marginBottom: 22 }}>
        {/* Card Meta Mensal com Inteligência de Inadimplência & Aging */}
        <div className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Topo: Título + Botão Editar */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 13, textTransform: "uppercase", letterSpacing: ".05em" }}>
              {modoMeta === "inadimplentes" ? "🎯 Meta de Inadimplência Recuperada" : "💰 Meta de Arrecadação Global (Caixa)"} • {metaInfo.nomeMes}
            </span>
            <button
              type="button"
              className="btn ghost"
              style={{ fontSize: 11, padding: "2px 8px" }}
              onClick={() => {
                if (editandoMeta) {
                  const val = desmascararMoeda(novaMetaStr);
                  if (val > 0) {
                    if (modoMeta === "inadimplentes") {
                      setMetaRecuperacao(val);
                      try { localStorage.setItem(META_RECUPERACAO_KEY, String(val)); } catch {}
                    } else {
                      setMetaGlobal(val);
                      try { localStorage.setItem(META_GLOBAL_KEY, String(val)); } catch {}
                    }
                  }
                  setEditandoMeta(false);
                } else {
                  setNovaMetaStr(formatarMascaraMoeda(metaInfo.metaAtiva));
                  setEditandoMeta(true);
                }
              }}
            >
              {editandoMeta ? "Fechar" : "Editar Meta"}
            </button>
          </div>

          {/* Seletor de Modo (Ideia 4: Inadimplentes vs Global) */}
          <div style={{ display: "flex", background: "var(--soft)", padding: 3, borderRadius: 8, gap: 4, alignSelf: "flex-start" }}>
            <button
              type="button"
              style={{
                border: "none",
                cursor: "pointer",
                fontSize: 11.5,
                fontWeight: modoMeta === "inadimplentes" ? 700 : 500,
                padding: "4px 10px",
                borderRadius: 6,
                background: modoMeta === "inadimplentes" ? "var(--card)" : "transparent",
                color: modoMeta === "inadimplentes" ? "var(--brand)" : "var(--mut)",
                boxShadow: modoMeta === "inadimplentes" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                transition: "all .15s ease",
              }}
              onClick={() => {
                setModoMeta("inadimplentes");
                try { localStorage.setItem(MODO_META_KEY, "inadimplentes"); } catch {}
              }}
            >
              🎯 Inadimplência Recuperada
            </button>
            <button
              type="button"
              style={{
                border: "none",
                cursor: "pointer",
                fontSize: 11.5,
                fontWeight: modoMeta === "global" ? 700 : 500,
                padding: "4px 10px",
                borderRadius: 6,
                background: modoMeta === "global" ? "var(--card)" : "transparent",
                color: modoMeta === "global" ? "var(--brand)" : "var(--mut)",
                boxShadow: modoMeta === "global" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                transition: "all .15s ease",
              }}
              onClick={() => {
                setModoMeta("global");
                try { localStorage.setItem(MODO_META_KEY, "global"); } catch {}
              }}
            >
              💰 Arrecadação Global (Caixa)
            </button>
          </div>

          {/* Edição ou Exibição da Meta */}
          {editandoMeta ? (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="text"
                autoFocus
                value={novaMetaStr}
                onChange={e => setNovaMetaStr(formatarMascaraMoeda(e.target.value))}
                onKeyDown={e => {
                  if (e.key === "Enter") {
                    const val = desmascararMoeda(novaMetaStr);
                    if (val > 0) {
                      if (modoMeta === "inadimplentes") {
                        setMetaRecuperacao(val);
                        try { localStorage.setItem(META_RECUPERACAO_KEY, String(val)); } catch {}
                      } else {
                        setMetaGlobal(val);
                        try { localStorage.setItem(META_GLOBAL_KEY, String(val)); } catch {}
                      }
                    }
                    setEditandoMeta(false);
                  } else if (e.key === "Escape") {
                    setEditandoMeta(false);
                  }
                }}
                placeholder="R$ 0,00"
                style={{
                  flex: 1,
                  padding: "6px 10px",
                  fontSize: 14,
                  fontWeight: 700,
                  borderRadius: 6,
                  border: "1px solid var(--brand)",
                  background: "var(--bg)",
                  color: "var(--fg)",
                  fontFamily: "monospace",
                }}
              />
              <button
                type="button"
                className="btn primary"
                style={{ fontSize: 12, padding: "6px 12px" }}
                onClick={() => {
                  const val = desmascararMoeda(novaMetaStr);
                  if (val > 0) {
                    if (modoMeta === "inadimplentes") {
                      setMetaRecuperacao(val);
                      try { localStorage.setItem(META_RECUPERACAO_KEY, String(val)); } catch {}
                    } else {
                      setMetaGlobal(val);
                      try { localStorage.setItem(META_GLOBAL_KEY, String(val)); } catch {}
                    }
                  }
                  setEditandoMeta(false);
                }}
              >
                Salvar
              </button>
              <button
                type="button"
                className="btn ghost"
                style={{ fontSize: 12, padding: "6px 10px" }}
                onClick={() => setEditandoMeta(false)}
              >
                Cancelar
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div>
                <b style={{ fontSize: 24 }}>{money(metaInfo.metaAtiva)}</b>
                <span style={{ fontSize: 12, color: "var(--mut)", marginLeft: 6 }}>
                  {modoMeta === "inadimplentes" ? "alvo de recuperação" : "alvo de faturamento"}
                </span>
              </div>
              <span style={{
                fontSize: 13,
                fontWeight: 700,
                color: metaInfo.pct >= 100 ? "#10b981" : metaInfo.pct >= 70 ? "#0284c7" : "#d97706",
              }}>
                {metaInfo.pct.toFixed(1)}% da meta
              </span>
            </div>
          )}

          {/* Barra de Progresso da Meta */}
          <div style={{ height: 10, width: "100%", background: "var(--line)", borderRadius: 99, overflow: "hidden" }}>
            <div
              style={{
                height: "100%",
                width: `${Math.min(100, Math.max(0, metaInfo.pct))}%`,
                background: metaInfo.pct >= 100
                  ? "linear-gradient(90deg, #10b981, #059669)"
                  : metaInfo.pct >= 70
                  ? "linear-gradient(90deg, #0284c7, #10b981)"
                  : "linear-gradient(90deg, #f59e0b, #10b981)",
                borderRadius: 99,
                transition: "width .4s ease",
              }}
            />
          </div>

          {/* Valores Recuperado e Restante */}
          <div style={{ fontSize: 12, color: "var(--mut)", display: "flex", justifyContent: "space-between" }}>
            <span>
              {modoMeta === "inadimplentes" ? "Inadimplência Recuperada:" : "Entradas em Caixa:"}{" "}
              <b style={{ color: "var(--fg)" }}>{money(metaInfo.valorAtivo)}</b>
            </span>
            <span>
              Restante: <b style={{ color: "var(--fg)" }}>{money(Math.max(0, metaInfo.metaAtiva - metaInfo.valorAtivo))}</b>
            </span>
          </div>

          {/* Ideia 3: Taxa de Resgate da Inadimplência */}
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            background: "rgba(16, 185, 129, 0.08)",
            border: "1px solid rgba(16, 185, 129, 0.25)",
            borderRadius: 8,
            padding: "8px 10px",
            fontSize: 11.5,
          }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span>🛡️</span>
              <span><b>Taxa de Resgate:</b> {metaInfo.taxaResgate.toFixed(1)}% da inadimplência resgatada</span>
            </span>
            <span style={{ color: "var(--mut)", fontSize: 11 }}>
              {money(dadosRecuperacao.totalInadimplencia)} de {money(metaInfo.poolVencido)}
            </span>
          </div>

          {/* Ideia 2: Composição da Recuperação por Idade da Dívida */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 2 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--mut)" }}>
                📊 Idade da Dívida Recuperada (Aging)
              </span>
              <span style={{ fontSize: 10.5, color: "var(--mut)" }}>
                {modoMeta === "inadimplentes" ? "Base: dívidas vencidas" : "Entradas totais"}
              </span>
            </div>

            {/* Barra Multi-colorida Proporcional das Faixas */}
            {dadosRecuperacao.totalInadimplencia > 0 && (
              <div style={{ height: 8, width: "100%", background: "var(--line)", borderRadius: 99, display: "flex", overflow: "hidden" }}>
                {dadosRecuperacao.faixas.ate30 > 0 && (
                  <div
                    title={`Até 30 dias: ${money(dadosRecuperacao.faixas.ate30)}`}
                    style={{ width: `${(dadosRecuperacao.faixas.ate30 / (modoMeta === "inadimplentes" ? dadosRecuperacao.totalInadimplencia : dadosRecuperacao.totalCaixa)) * 100}%`, background: "#10b981" }}
                  />
                )}
                {dadosRecuperacao.faixas.d30a60 > 0 && (
                  <div
                    title={`30 a 60 dias: ${money(dadosRecuperacao.faixas.d30a60)}`}
                    style={{ width: `${(dadosRecuperacao.faixas.d30a60 / (modoMeta === "inadimplentes" ? dadosRecuperacao.totalInadimplencia : dadosRecuperacao.totalCaixa)) * 100}%`, background: "#0284c7" }}
                  />
                )}
                {dadosRecuperacao.faixas.d60a90 > 0 && (
                  <div
                    title={`60 a 90 dias: ${money(dadosRecuperacao.faixas.d60a90)}`}
                    style={{ width: `${(dadosRecuperacao.faixas.d60a90 / (modoMeta === "inadimplentes" ? dadosRecuperacao.totalInadimplencia : dadosRecuperacao.totalCaixa)) * 100}%`, background: "#f59e0b" }}
                  />
                )}
                {dadosRecuperacao.faixas.d90a180 > 0 && (
                  <div
                    title={`90 a 180 dias: ${money(dadosRecuperacao.faixas.d90a180)}`}
                    style={{ width: `${(dadosRecuperacao.faixas.d90a180 / (modoMeta === "inadimplentes" ? dadosRecuperacao.totalInadimplencia : dadosRecuperacao.totalCaixa)) * 100}%`, background: "#ea580c" }}
                  />
                )}
                {dadosRecuperacao.faixas.mais180 > 0 && (
                  <div
                    title={`+180 dias: ${money(dadosRecuperacao.faixas.mais180)}`}
                    style={{ width: `${(dadosRecuperacao.faixas.mais180 / (modoMeta === "inadimplentes" ? dadosRecuperacao.totalInadimplencia : dadosRecuperacao.totalCaixa)) * 100}%`, background: "#9333ea" }}
                  />
                )}
                {modoMeta === "global" && dadosRecuperacao.faixas.emDia > 0 && (
                  <div
                    title={`Em dia: ${money(dadosRecuperacao.faixas.emDia)}`}
                    style={{ width: `${(dadosRecuperacao.faixas.emDia / dadosRecuperacao.totalCaixa) * 100}%`, background: "#06b6d4" }}
                  />
                )}
              </div>
            )}

            {/* Grid com os 5 cards/pills com as margens solicitadas */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(115px, 1fr))", gap: 6, marginTop: 4 }}>
              <div style={{ background: "rgba(16, 185, 129, 0.08)", border: "1px solid rgba(16, 185, 129, 0.3)", borderRadius: 7, padding: "5px 7px" }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#10b981", textTransform: "uppercase" }}>Até 30 dias</div>
                <b style={{ fontSize: 12.5, color: "var(--fg)" }}>{money(dadosRecuperacao.faixas.ate30)}</b>
              </div>
              <div style={{ background: "rgba(2, 132, 199, 0.08)", border: "1px solid rgba(2, 132, 199, 0.3)", borderRadius: 7, padding: "5px 7px" }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#0284c7", textTransform: "uppercase" }}>30 a 60 dias</div>
                <b style={{ fontSize: 12.5, color: "var(--fg)" }}>{money(dadosRecuperacao.faixas.d30a60)}</b>
              </div>
              <div style={{ background: "rgba(245, 158, 11, 0.08)", border: "1px solid rgba(245, 158, 11, 0.3)", borderRadius: 7, padding: "5px 7px" }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#f59e0b", textTransform: "uppercase" }}>60 a 90 dias</div>
                <b style={{ fontSize: 12.5, color: "var(--fg)" }}>{money(dadosRecuperacao.faixas.d60a90)}</b>
              </div>
              <div style={{ background: "rgba(234, 88, 12, 0.08)", border: "1px solid rgba(234, 88, 12, 0.3)", borderRadius: 7, padding: "5px 7px" }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#ea580c", textTransform: "uppercase" }}>90 a 180 dias</div>
                <b style={{ fontSize: 12.5, color: "var(--fg)" }}>{money(dadosRecuperacao.faixas.d90a180)}</b>
              </div>
              <div style={{ background: "rgba(147, 51, 234, 0.08)", border: "1px solid rgba(147, 51, 234, 0.3)", borderRadius: 7, padding: "5px 7px" }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#9333ea", textTransform: "uppercase" }}>+180 dias (Antigas)</div>
                <b style={{ fontSize: 12.5, color: "var(--fg)" }}>{money(dadosRecuperacao.faixas.mais180)}</b>
              </div>
              {modoMeta === "global" && (
                <div style={{ background: "rgba(6, 182, 212, 0.08)", border: "1px solid rgba(6, 182, 212, 0.3)", borderRadius: 7, padding: "5px 7px" }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#06b6d4", textTransform: "uppercase" }}>Em dia / Adiant.</div>
                  <b style={{ fontSize: 12.5, color: "var(--fg)" }}>{money(dadosRecuperacao.faixas.emDia)}</b>
                </div>
              )}
            </div>
          </div>

          {/* Rodapé: Ritmo Diário e Projeção de Fechamento */}
          <div style={{
            fontSize: 11,
            color: "var(--mut)",
            paddingTop: 8,
            borderTop: "1px dashed var(--line)",
            display: "flex",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 6,
          }}>
            <span>Média: <b>{money(metaInfo.mediaDiaria)}/dia</b></span>
            <span>
              Projeção: <b style={{ color: metaInfo.projecaoFechamento >= metaInfo.metaAtiva ? "#10b981" : "inherit" }}>{money(metaInfo.projecaoFechamento)}</b> ({metaInfo.diasRestantes} dias rest.)
            </span>
            {modoMeta === "inadimplentes" && (
              <span style={{ width: "100%", fontSize: 10.5, color: "var(--mut)", borderTop: "1px solid var(--soft)", paddingTop: 4 }}>
                💳 Total em caixa no mês: <b>{money(dadosRecuperacao.totalCaixa)}</b> ({money(dadosRecuperacao.faixas.emDia)} em dia)
              </span>
            )}
          </div>
        </div>

        {/* Card Promessas de Pagamento (Dividido em Promessas para Hoje e Datas Posteriores) */}
        {(() => {
          const promessasNaoCumpridas = promessas.filter(p => !p.cumprida);
          const promessasHoje = promessasNaoCumpridas.filter(p => p.dataPromessa === dataHoje);
          const promessasPosteriores = promessasNaoCumpridas
            .filter(p => p.dataPromessa > dataHoje)
            .sort((a, b) => a.dataPromessa.localeCompare(b.dataPromessa));
          const promessasAtrasadas = promessasNaoCumpridas.filter(p => p.dataPromessa < dataHoje);

          const totalPrometidoHoje = promessasHoje.reduce((s, p) => s + p.valor, 0);
          const totalPrometidoPosterior = promessasPosteriores.reduce((s, p) => s + p.valor, 0);

          return (
            <div
              className="card"
              style={{
                padding: 16,
                borderLeft: "5px solid #d97706",
                display: "flex",
                flexDirection: "column",
                gap: 14,
                background: promessasHoje.length > 0 ? "rgba(217, 119, 6, 0.03)" : "var(--card)",
              }}
            >
              {/* SEÇÃO 1: PROMESSAS PARA HOJE */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 700, fontSize: 13, textTransform: "uppercase", letterSpacing: ".05em", color: "#d97706", display: "flex", alignItems: "center", gap: 6 }}>
                    <span>📅</span> PROMESSAS PARA HOJE ({promessasHoje.length})
                  </span>
                  <span style={{ fontSize: 11, color: "var(--mut)" }}>{dt(dataHoje)}</span>
                </div>

                {promessasHoje.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--mut)", padding: "4px 0" }}>
                    Nenhuma promessa de pagamento para hoje.
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {promessasHoje.map(p => (
                      <div
                        key={p.id}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          fontSize: 12.5,
                          padding: "8px 10px",
                          background: "var(--card)",
                          borderRadius: 8,
                          border: "1px solid var(--line)",
                          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                        }}
                      >
                        <div style={{ minWidth: 0, flex: 1, paddingRight: 8 }}>
                          <div style={{ fontWeight: 700, fontSize: 13, color: "var(--ink)" }}>{p.cliente}</div>
                          <div style={{ color: "var(--mut)", fontSize: 11, marginTop: 1 }}>{p.telefone ? mascaraTelefone(p.telefone) : "Sem tel"}</div>
                          {p.observacao && (
                            <div style={{ fontSize: 11, color: "var(--brand)", marginTop: 2, fontStyle: "italic", wordBreak: "break-word" }}>
                              Obs: {p.observacao}
                            </div>
                          )}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                          <span style={{ fontWeight: 700, color: "#d97706", fontSize: 13 }}>{money(p.valor)}</span>
                          {p.telefone && (
                            <button
                              type="button"
                              className="btn-baixa"
                              style={{ padding: "3px 8px", fontSize: 11, background: "#25D366" }}
                              onClick={() =>
                                setWhats({
                                  cliente: p.cliente,
                                  telefone: p.telefone,
                                  valor: p.valor,
                                })
                              }
                              title="Cobrar promessa no WhatsApp"
                            >
                              Cobrar
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn ghost"
                            style={{ padding: "3px 8px", fontSize: 11 }}
                            onClick={() => {
                              marcarPromessaCumprida(p.id);
                              setPromessas(obterPromessasPagamento());
                            }}
                            title="Marcar como cumprida"
                          >
                            ✓
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ fontSize: 11.5, color: "#d97706", fontWeight: 600 }}>
                  Total prometido para hoje: <b>{money(totalPrometidoHoje)}</b>
                </div>
              </div>

              {/* DIVISOR ELEGANTE */}
              <div style={{ borderTop: "1px dashed var(--line)" }} />

              {/* SEÇÃO 2: DEMAIS PROMESSAS (DATAS POSTERIORES) */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 700, fontSize: 13, textTransform: "uppercase", letterSpacing: ".05em", color: "#0284c7", display: "flex", alignItems: "center", gap: 6 }}>
                    <span>🗓️</span> DEMAIS PROMESSAS (DATAS POSTERIORES) ({promessasPosteriores.length})
                  </span>
                  <span style={{ fontSize: 11, color: "var(--mut)" }}>
                    Total: <b>{money(totalPrometidoPosterior)}</b>
                  </span>
                </div>

                {promessasPosteriores.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--mut)", padding: "4px 0" }}>
                    Nenhuma promessa futura cadastrada.
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {promessasPosteriores.map(p => {
                      const tHoje = new Date(dataHoje + "T00:00:00Z").getTime();
                      const tData = new Date(p.dataPromessa + "T00:00:00Z").getTime();
                      const diffDias = Math.round((tData - tHoje) / 86400000);
                      const labelPrazo = diffDias === 1 ? "Amanhã" : `Em ${diffDias} dias`;

                      return (
                        <div
                          key={p.id}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            fontSize: 12.5,
                            padding: "8px 10px",
                            background: "var(--card)",
                            borderRadius: 8,
                            border: "1px solid var(--line)",
                            boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                          }}
                        >
                          <div style={{ minWidth: 0, flex: 1, paddingRight: 8 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                              <span style={{ fontWeight: 700, fontSize: 13, color: "var(--ink)" }}>{p.cliente}</span>
                              <span
                                className="pill"
                                style={{
                                  fontSize: 10.5,
                                  padding: "1px 6px",
                                  background: "rgba(2, 132, 199, 0.1)",
                                  color: "#0369a1",
                                  borderColor: "#0284c7",
                                }}
                              >
                                {labelPrazo} ({dt(p.dataPromessa)})
                              </span>
                            </div>
                            <div style={{ color: "var(--mut)", fontSize: 11, marginTop: 1 }}>{p.telefone ? mascaraTelefone(p.telefone) : "Sem tel"}</div>
                            {p.observacao && (
                              <div style={{ fontSize: 11, color: "var(--mut)", marginTop: 2, fontStyle: "italic", wordBreak: "break-word" }}>
                                Obs: {p.observacao}
                              </div>
                            )}
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                            <span style={{ fontWeight: 700, color: "#0284c7", fontSize: 13 }}>{money(p.valor)}</span>
                            {p.telefone && (
                              <button
                                type="button"
                                className="btn-baixa"
                                style={{ padding: "3px 8px", fontSize: 11, background: "#25D366" }}
                                onClick={() =>
                                  setWhats({
                                    cliente: p.cliente,
                                    telefone: p.telefone,
                                    valor: p.valor,
                                  })
                                }
                                title="Cobrar promessa no WhatsApp"
                              >
                                Cobrar
                              </button>
                            )}
                            <button
                              type="button"
                              className="btn ghost"
                              style={{ padding: "3px 8px", fontSize: 11 }}
                              onClick={() => {
                                marcarPromessaCumprida(p.id);
                                setPromessas(obterPromessasPagamento());
                              }}
                              title="Marcar como cumprida"
                            >
                              ✓
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* RODAPÉ DO CARD */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  paddingTop: 8,
                  borderTop: "1px solid var(--line)",
                  fontSize: 11.5,
                  marginTop: "auto",
                }}
              >
                {promessasAtrasadas.length > 0 ? (
                  <span style={{ color: "var(--bad)", fontWeight: 600 }}>
                    ⚠️ {promessasAtrasadas.length} em atraso anterior
                  </span>
                ) : (
                  <span style={{ color: "var(--mut)" }}>
                    {promessasNaoCumpridas.length} compromisso{promessasNaoCumpridas.length > 1 ? "s" : ""} ativo{promessasNaoCumpridas.length > 1 ? "s" : ""}
                  </span>
                )}

                {onNavegarAba && (
                  <button
                    type="button"
                    className="link-cli"
                    onClick={() => onNavegarAba("promessas")}
                    style={{ fontSize: 12, color: "var(--brand)", fontWeight: 700 }}
                  >
                    Ver Central de Promessas →
                  </button>
                )}
              </div>
            </div>
          );
        })()}
      </div>

      {/* BLOCO 2: Termômetro da Carteira (Barra Gráfica de Saúde) */}
      <div
        className="card"
        style={{
          padding: 16,
          marginBottom: 24,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <div style={{ fontWeight: 700, fontSize: 13, textTransform: "uppercase", letterSpacing: ".05em" }}>
            Composição da Carteira de Crédito
          </div>
          <div style={{ fontSize: 12, color: "var(--mut)" }}>
            Base total: {money(metricas.totalDivida)} ({metricas.totalPromissorias.toLocaleString("pt-BR")} títulos)
          </div>
        </div>

        {/* Barra de Progresso Segmentada */}
        <div
          style={{
            height: 18,
            width: "100%",
            borderRadius: 8,
            overflow: "hidden",
            display: "flex",
            background: "var(--line)",
          }}
        >
          {/* Quitado */}
          <div
            style={{
              width: `${(metricas.totalPago / (metricas.totalDivida || 1)) * 100}%`,
              background: "#16a34a",
              transition: "width .3s ease",
            }}
            title={`Quitado: ${money(metricas.totalPago)} (${((metricas.totalPago / (metricas.totalDivida || 1)) * 100).toFixed(1)}%)`}
          />
          {/* A Vencer (Em dia) */}
          <div
            style={{
              width: `${(metricas.aVencerValor / (metricas.totalDivida || 1)) * 100}%`,
              background: "#0284c7",
              transition: "width .3s ease",
            }}
            title={`A vencer (em dia): ${money(metricas.aVencerValor)} (${((metricas.aVencerValor / (metricas.totalDivida || 1)) * 100).toFixed(1)}%)`}
          />
          {/* Vencido (Atraso) */}
          <div
            style={{
              width: `${(metricas.totalVencidoValor / (metricas.totalDivida || 1)) * 100}%`,
              background: "#dc2626",
              transition: "width .3s ease",
            }}
            title={`Em atraso: ${money(metricas.totalVencidoValor)} (${((metricas.totalVencidoValor / (metricas.totalDivida || 1)) * 100).toFixed(1)}%)`}
          />
          {/* Fundo Perdido */}
          <div
            style={{
              width: `${(metricas.totalPerdido / (metricas.totalDivida || 1)) * 100}%`,
              background: "#64748b",
              transition: "width .3s ease",
            }}
            title={`Fundo Perdido: ${money(metricas.totalPerdido)} (${((metricas.totalPerdido / (metricas.totalDivida || 1)) * 100).toFixed(1)}%)`}
          />
        </div>

        {/* Legenda da Barra */}
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: "#16a34a" }} />
            <span>Quitado: <b>{money(metricas.totalPago)}</b></span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: "#0284c7" }} />
            <span>Em dia (A vencer): <b>{money(metricas.aVencerValor)}</b></span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: "#dc2626" }} />
            <span>Em atraso: <b>{money(metricas.totalVencidoValor)}</b></span>
          </div>
          {metricas.totalPerdido > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: "#64748b" }} />
              <span>Fundo perdido: <b>{money(metricas.totalPerdido)}</b></span>
            </div>
          )}
        </div>
      </div>

      {/* BLOCO 3: Aging de Inadimplência (As 7 Faixas Estratégicas de Cobrança) */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div>
            <h2 style={{ fontSize: 17, margin: 0 }}>Régua de Envelhecimento & Risco (Aging da Dívida)</h2>
            <div className="sub" style={{ fontSize: 12.5 }}>
              Estratificação de atrasos para aplicação das réguas de negociação recomendadas.
            </div>
          </div>
          {onNavegarAba && (
            <button
              type="button"
              className="btn ghost"
              onClick={() => onNavegarAba("renegociacao")}
              style={{ fontSize: 12, padding: "5px 10px" }}
            >
              Abrir Central de Renegociação →
            </button>
          )}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 12,
          }}
        >
          {faixasAging.map(f => (
            <div
              key={f.id}
              className="card"
              style={{
                borderLeft: `5px solid ${f.cor}`,
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                padding: 14,
                gap: 10,
                position: "relative",
              }}
            >
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
                  <span style={{ fontWeight: 700, fontSize: 14, color: f.cor }}>{f.titulo}</span>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      padding: "1px 6px",
                      borderRadius: 99,
                      background: f.bgCor,
                      color: f.cor,
                    }}
                  >
                    {f.qtd} {f.qtd === 1 ? "título" : "títulos"}
                  </span>
                </div>
                <div style={{ fontSize: 11.5, color: "var(--mut)", marginBottom: 8 }}>{f.subtitulo}</div>

                <div style={{ fontSize: 20, fontWeight: 700, color: "var(--ink)" }}>{money(f.valor)}</div>

                {f.porcentagemDoVencido > 0 && (
                  <div style={{ fontSize: 11, color: "var(--mut)", marginTop: 2 }}>
                    Representa <b>{f.porcentagemDoVencido.toFixed(1)}%</b> do total vencido
                  </div>
                )}
              </div>

              <div
                style={{
                  borderTop: "1px solid var(--line)",
                  paddingTop: 8,
                  fontSize: 11.5,
                  color: "var(--mut)",
                  lineHeight: 1.35,
                }}
              >
                <b style={{ color: "var(--ink)" }}>Ação:</b> {f.estrategiaSugerida}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* BLOCO 4: Top 5 Maiores Inadimplentes */}
      <div className="card" style={{ padding: 18, marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16 }}>Top 5 Maiores Saldos Vencidos</h3>
            <div className="sub" style={{ fontSize: 12 }}>
              Clientes prioritários para contato direto e acordo estruturado.
            </div>
          </div>
          {onNavegarAba && (
            <button
              type="button"
              className="btn ghost"
              onClick={() => onNavegarAba("promissorias", "vencidas")}
              style={{ fontSize: 12, padding: "5px 10px" }}
            >
              Ver todas as vencidas →
            </button>
          )}
        </div>

        {topDevedores.length === 0 ? (
          <div style={{ textAlign: "center", padding: 20, color: "var(--mut)" }}>
            🎉 Nenhuma promissória vencida no momento! Parabéns pelo controle de inadimplência.
          </div>
        ) : (
          <div className="wrap" style={{ border: 0, boxShadow: "none" }}>
            <table>
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>Telefone</th>
                  <th style={{ textAlign: "center" }}>Títulos em Atraso</th>
                  <th style={{ textAlign: "right" }}>Maior Atraso</th>
                  <th style={{ textAlign: "right" }}>Total Vencido</th>
                  <th style={{ textAlign: "right" }}>Ações</th>
                </tr>
              </thead>
              <tbody>
                {topDevedores.map((td, idx) => (
                  <tr key={td.cliente}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span
                          style={{
                            width: 20,
                            height: 20,
                            borderRadius: 99,
                            background: "var(--soft)",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 11,
                            fontWeight: 700,
                            color: "var(--mut)",
                          }}
                        >
                          {idx + 1}
                        </span>
                        <button
                          type="button"
                          className="link-cli"
                          onClick={() => setFichaCliente({ cliente: td.cliente, telefone: td.telefone })}
                          title="Ver ficha completa do cliente"
                        >
                          {td.cliente}
                        </button>
                      </div>
                    </td>
                    <td className="mono">{td.telefone || "—"}</td>
                    <td style={{ textAlign: "center" }}>
                      <span className="pill p-NÃO">{td.qtdPromissorias}</span>
                    </td>
                    <td style={{ textAlign: "right", color: "var(--bad)", fontWeight: 600 }}>
                      {td.maiorAtrasoDias} dias
                    </td>
                    <td className="n" style={{ color: "var(--bad)", fontWeight: 700, fontSize: 14 }}>
                      {money(td.totalVencido)}
                    </td>
                    <td className="acts">
                      <button
                        className="ed"
                        onClick={() => setFichaCliente({ cliente: td.cliente, telefone: td.telefone })}
                      >
                        Ficha
                      </button>
                      {td.telefone && normalizarTelefones(td.telefone).length > 0 && (
                        <button
                          className="btn-baixa"
                          style={{ background: "#25D366" }}
                          onClick={() => setWhats({ cliente: td.cliente, telefone: td.telefone, valor: td.totalVencido, vencimento: td.vencimentoMaisAntigo || undefined })}
                          title="Cobrar via WhatsApp"
                        >
                          Cobrar
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modais */}
      {fichaCliente && (
        <FichaCliente
          cliente={fichaCliente.cliente}
          telefone={fichaCliente.telefone}
          onClose={() => setFichaCliente(null)}
          onChanged={carregarDados}
          isAdmin={true}
        />
      )}

      {whats && (
        <WhatsDialog
          nome={whats.cliente}
          telefone={whats.telefone}
          mensagem={`Olá, ${whats.cliente}! Passando para conversar sobre suas promissórias em aberto na LeoÓticas no valor total de ${money(whats.valor)}. Conseguimos uma condição especial para regularizar hoje. Podemos conversar?`}
          onClose={() => setWhats(null)}
        />
      )}
    </div>
  );
}
