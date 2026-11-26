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

export interface RecebimentoRecente {
  id: string | number;
  promissoriaId?: number;
  clienteNome: string;
  telefone?: string;
  iniciais: string;
  corAvatar: string;
  descricao: string;
  valor: number;
  data: string;
  tempoRelativo: string;
  detalhes?: string;
}

const PALETA_AVATARES = [
  "#2d6a4f", // verde floresta escuro
  "#c97a1e", // mostarda dourada
  "#475569", // ardósia escuro
  "#9e5a52", // terracota bordô
  "#0284c7", // azul oceano
  "#7c3aed", // violeta nobre
  "#0d9488", // verde petróleo
  "#b45309", // âmbar
  "#be123c", // carmesim
];

function obterIniciaisNome(nome: string): string {
  if (!nome) return "CL";
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return "CL";
  if (partes.length === 1) {
    return partes[0].slice(0, 2).toUpperCase();
  }
  return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
}

function obterCorAvatar(nome: string): string {
  let hash = 0;
  for (let i = 0; i < nome.length; i++) {
    hash = (hash << 5) - hash + nome.charCodeAt(i);
    hash |= 0;
  }
  const idx = Math.abs(hash) % PALETA_AVATARES.length;
  return PALETA_AVATARES[idx];
}

function formatarTempoRelativo(dataIso: string): string {
  if (!dataIso) return "";
  const agora = Date.now();
  const d = new Date(dataIso);
  const dataMs = d.getTime();
  if (isNaN(dataMs)) return dataIso.slice(0, 10);
  const diffSeg = Math.max(0, Math.floor((agora - dataMs) / 1000));
  const diffMin = Math.floor(diffSeg / 60);
  const diffHoras = Math.floor(diffMin / 60);
  const diffDias = Math.floor(diffHoras / 24);

  if (diffMin < 1) return "agora mesmo";
  if (diffMin < 60) return `há ${diffMin} min`;
  if (diffHoras < 24) return `há ${diffHoras} h`;
  if (diffDias === 1) return "ontem";
  if (diffDias < 7) return `há ${diffDias} dias`;
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function deduzirDescricaoRecebimento(
  detalhes?: string,
  parcelas?: string,
  saldoDevedor?: number
): string {
  let forma = "Pix";
  const dLow = (detalhes || "").toLowerCase();
  if (dLow.includes("dinheiro")) forma = "Dinheiro";
  else if (dLow.includes("cartão") || dLow.includes("cartao") || dLow.includes("crédito") || dLow.includes("debito") || dLow.includes("débito")) forma = "Cartão";
  else if (dLow.includes("ted") || dLow.includes("transfer")) forma = "TED";
  else if (dLow.includes("pix")) forma = "Pix";

  if (saldoDevedor !== undefined && saldoDevedor <= 0) {
    return `Quitação · ${forma}`;
  }
  if (parcelas) {
    return `Parcela ${parcelas} · ${forma}`;
  }
  if (dLow.includes("sinal") || dLow.includes("entrada")) {
    return `Entrada · ${forma}`;
  }
  return `Parcela · ${forma}`;
}

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
  const [recebimentos, setRecebimentos] = useState<RecebimentoRecente[]>([]);
  const [loadingRecebimentos, setLoadingRecebimentos] = useState(false);
  const [modalTodosRecebimentos, setModalTodosRecebimentos] = useState(false);
  const [buscaRecebimento, setBuscaRecebimento] = useState("");
  const carregarPromessasDashboard = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from("promessas_pagamento")
        .select("*")
        .order("data_promessa", { ascending: true });

      if (!error && data) {
        setPromessas(data.map((d: any) => ({
          id: String(d.id),
          cliente: d.cliente || "",
          telefone: d.telefone || "",
          dataPromessa: d.data_promessa ? String(d.data_promessa).slice(0, 10) : "",
          valor: Number(d.valor) || 0,
          observacao: d.observacao || undefined,
          criadaEm: d.created_at || new Date().toISOString(),
          cumprida: Boolean(d.cumprida),
        })));
      } else {
        setPromessas(obterPromessasPagamento());
      }
    } catch {
      setPromessas(obterPromessasPagamento());
    }
  }, []);

  const handleCumprirPromessaDashboard = async (id: string) => {
    try {
      await supabase
        .from("promessas_pagamento")
        .update({ cumprida: true, cumprida_em: new Date().toISOString() })
        .eq("id", id);
    } catch (_) {}
    marcarPromessaCumprida(id);
    await carregarPromessasDashboard();
  };

  const carregarRecebimentosRecentes = useCallback(async () => {
    setLoadingRecebimentos(true);
    try {
      const lista: RecebimentoRecente[] = [];
      const chavesVistas = new Set<string>();

      // 1. Consulta promissoria_pagamentos com relação a promissorias
      try {
        const { data: pags, error: errPags } = await supabase
          .from("promissoria_pagamentos")
          .select(`
            id,
            promissoria_id,
            valor_pago,
            data_pagamento,
            detalhes,
            operador_email,
            promissorias (
              id,
              cliente_nome,
              telefone,
              parcelas,
              divida_total,
              valor_pago,
              saldo_devedor,
              origem
            )
          `)
          .order("data_pagamento", { ascending: false })
          .limit(40);

        if (!errPags && pags) {
          for (const p of pags) {
            if (p.detalhes && (
              p.detalhes.includes("Troca por produto") ||
              p.detalhes.includes("Troca por óculos") ||
              p.detalhes.includes("Unificação e reparcelamento") ||
              p.detalhes.includes("REPACTUACAO_BAIXA") ||
              p.detalhes.includes("Acordo de Repactuação")
            )) {
              continue;
            }
            const prom = (p.promissorias as any);
            const nome = prom?.cliente_nome?.trim() || "Cliente";
            const chave = `${p.promissoria_id}_${p.data_pagamento}_${p.valor_pago}`;
            if (chavesVistas.has(chave)) continue;
            chavesVistas.add(chave);

            lista.push({
              id: p.id,
              promissoriaId: p.promissoria_id,
              clienteNome: nome,
              telefone: prom?.telefone,
              iniciais: obterIniciaisNome(nome),
              corAvatar: obterCorAvatar(nome),
              descricao: deduzirDescricaoRecebimento(p.detalhes, prom?.parcelas, prom?.saldo_devedor),
              valor: Number(p.valor_pago) || 0,
              data: p.data_pagamento || new Date().toISOString(),
              tempoRelativo: formatarTempoRelativo(p.data_pagamento),
              detalhes: p.detalhes,
            });
          }
        }
      } catch (_) {}

      // 2. Fallback / Complemento: promissórias com baixas registradas em 'origem'
      if (lista.length < 15) {
        try {
          const { data: baixasOrigem } = await supabase
            .from("promissorias")
            .select("id, cliente_nome, telefone, parcelas, saldo_devedor, divida_total, valor_pago, origem")
            .gt("valor_pago", 0)
            .order("id", { ascending: false })
            .limit(30);

          if (baixasOrigem) {
            for (const row of baixasOrigem) {
              const nome = row.cliente_nome?.trim() || "Cliente";
              if (row.origem) {
                try {
                  const logs = JSON.parse(row.origem);
                  if (Array.isArray(logs)) {
                    for (const log of logs) {
                      if (log.valor && log.valor > 0 && log.data) {
                        if (log.acordo?.tipo === "REPACTUACAO_BAIXA" || log.acordo?.tipo === "TROCA_PRODUTO_MENOR_VALOR" || log.acordo?.tipo === "TROCA_PRODUTO") continue;
                        const chave = `${row.id}_${log.data}_${log.valor}`;
                        if (chavesVistas.has(chave)) continue;
                        chavesVistas.add(chave);
                        lista.push({
                          id: `origem_${chave}`,
                          promissoriaId: row.id,
                          clienteNome: nome,
                          telefone: row.telefone,
                          iniciais: obterIniciaisNome(nome),
                          corAvatar: obterCorAvatar(nome),
                          descricao: deduzirDescricaoRecebimento(log.detalhes, row.parcelas, row.saldo_devedor),
                          valor: Number(log.valor) || 0,
                          data: log.data,
                          tempoRelativo: formatarTempoRelativo(log.data),
                          detalhes: log.detalhes,
                        });
                      }
                    }
                  }
                } catch (_) {}
              }
            }
          }
        } catch (_) {}
      }

      lista.sort((a, b) => new Date(b.data).getTime() - new Date(a.data).getTime());
      setRecebimentos(lista);
    } finally {
      setLoadingRecebimentos(false);
    }
  }, []);
  
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
          .select("promissoria_id, valor_pago, data_pagamento, detalhes, promissorias(vencimento)")
          .gte("data_pagamento", inicioMesIso)
          .lt("data_pagamento", inicioProxMesIso);

        if (!errPags && pags) {
          for (const p of pags) {
            // Ignora baixas contábeis de troca/repactuação (não representam dinheiro em caixa)
            if (p.detalhes && (
              p.detalhes.includes("Troca por produto") ||
              p.detalhes.includes("Troca por óculos") ||
              p.detalhes.includes("Unificação e reparcelamento") ||
              p.detalhes.includes("REPACTUACAO_BAIXA") ||
              p.detalhes.includes("Acordo de Repactuação")
            )) {
              continue;
            }
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
                    if (item.acordo?.tipo === "REPACTUACAO_BAIXA" || item.acordo?.tipo === "TROCA_PRODUTO_MENOR_VALOR" || item.acordo?.tipo === "TROCA_PRODUTO" || (typeof item.detalhes === "string" && (item.detalhes.includes("Acordo de Repactuação") || item.detalhes.includes("Troca por produto") || item.detalhes.includes("Troca por óculos") || item.detalhes.includes("Unificação e reparcelamento")))) {
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
      try {
        await carregarPromessasDashboard();
      } catch (_) {
        setPromessas(obterPromessasPagamento());
      }
      try {
        await carregarRecebimentosRecentes();
      } catch (_) {}
    } catch (e: any) {
      setError(e.message || "Erro ao carregar dados do dashboard.");
    } finally {
      setLoading(false);
    }
  }, [dataHoje, carregarRecebimentosRecentes, carregarPromessasDashboard]);

  useEffect(() => {
    carregarDados();
  }, [carregarDados]);

  const recebimentosFiltrados = useMemo(() => {
    if (!buscaRecebimento.trim()) return recebimentos;
    const b = buscaRecebimento.trim().toLowerCase();
    return recebimentos.filter(r => r.clienteNome.toLowerCase().includes(b) || r.descricao.toLowerCase().includes(b));
  }, [recebimentos, buscaRecebimento]);

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

    // 7. 180 a 360 dias
    const f180a360 = abertas.filter(r => r.dias_atraso >= 181 && r.dias_atraso <= 360);
    const val180a360 = f180a360.reduce((s, r) => s + r.saldo_devedor, 0);

    // 8. Acima de 360 dias (+360d)
    const fMais360 = abertas.filter(r => r.dias_atraso > 360);
    const valMais360 = fMais360.reduce((s, r) => s + r.saldo_devedor, 0);

    // 9. Fundo Perdido
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
        id: "180_360",
        titulo: "180 a 360 dias",
        subtitulo: "Atraso crítico / Cobrança intensiva",
        diasLabel: "180–360 dias",
        cor: "#991b1b",
        bgCor: "rgba(153, 27, 27, 0.08)",
        nivelRisco: "critico",
        qtd: f180a360.length,
        valor: val180a360,
        porcentagemDoVencido: (val180a360 / totalVenc) * 100,
        estrategiaSugerida: "Feirão de quitação: desconto agressivo à vista (40% a 50%) via PIX ou notificação extrajudicial.",
      },
      {
        id: "mais_360",
        titulo: "Acima de 360 dias",
        subtitulo: "Inadimplência crônica / Pré-perda",
        diasLabel: "+360 dias",
        cor: "#7f1d1d",
        bgCor: "rgba(127, 29, 29, 0.1)",
        nivelRisco: "critico",
        qtd: fMais360.length,
        valor: valMais360,
        porcentagemDoVencido: (valMais360 / totalVenc) * 100,
        estrategiaSugerida: "Última tentativa de resgate com desconto máximo (50% a 60%) ou avaliação para lançamento em fundo perdido.",
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

  const promessasNaoCumpridas = useMemo(() => (promessas || []).filter(p => !p.cumprida), [promessas]);
  const promessasHoje = useMemo(() => promessasNaoCumpridas.filter(p => p.dataPromessa === dataHoje), [promessasNaoCumpridas, dataHoje]);
  const promessasHojeTotal = useMemo(() => promessasHoje.reduce((s, p) => s + p.valor, 0), [promessasHoje]);
  const promessasPosteriores = useMemo(() => promessasNaoCumpridas.filter(p => p.dataPromessa > dataHoje).sort((a, b) => a.dataPromessa.localeCompare(b.dataPromessa)), [promessasNaoCumpridas, dataHoje]);

  if (loading) {
    return (
      <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--mut)" }}>
        <div style={{ fontSize: 24, marginBottom: 12 }}>Carregando indicadores da operação...</div>
        <div>Calculando taxas de inadimplência, faixas de atraso e projeções de liquidez.</div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1360, margin: "0 auto", paddingBottom: 40 }}>
      {/* Cabeçalho da Página - Visão Executiva Limpa */}
      <div className="head2 noprint" style={{ alignItems: "center", marginBottom: 16 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: "-0.025em", color: "var(--ink)" }}>
              Visão Geral Operacional
            </h1>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                background: "rgba(16, 185, 129, 0.1)",
                color: "#059669",
                fontSize: 11,
                fontWeight: 700,
                padding: "2px 8px",
                borderRadius: 99,
                letterSpacing: "0.01em",
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#10b981", display: "inline-block" }} />
              Tempo Real
            </span>
          </div>
          <div className="sub" style={{ marginTop: 3, fontSize: 12, color: "var(--mut)" }}>
            Controle financeiro do crediário, entradas do dia e radar de cobrança prioritária.
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button
            type="button"
            className="btn ghost"
            onClick={carregarDados}
            title="Recarregar todos os dados"
            style={{ fontSize: 13, padding: "8px 14px", fontWeight: 600 }}
          >
            🔄 Atualizar
          </button>

          {/* Dropdown Exportar */}
          <div style={{ position: "relative" }}>
            <button
              type="button"
              className="btn"
              onClick={() => setMenuExportar(prev => !prev)}
              style={{ fontSize: 13, padding: "8px 15px", fontWeight: 600 }}
            >
              📥 Exportar ▾
            </button>
            {menuExportar && (
              <>
                <div style={{ position: "fixed", inset: 0, zIndex: 90 }} onClick={() => setMenuExportar(false)} />
                <div
                  style={{
                    position: "absolute",
                    right: 0,
                    top: "calc(100% + 6px)",
                    background: "var(--card)",
                    border: "1px solid var(--line)",
                    borderRadius: 10,
                    boxShadow: "0 10px 25px -5px rgba(0,0,0,0.12)",
                    zIndex: 100,
                    minWidth: 210,
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
                      color: "var(--ink)",
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = "var(--soft)")}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                  >
                    <span>📗</span> Planilha Excel (.csv)
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
                      color: "var(--ink)",
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = "var(--soft)")}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                  >
                    <span>📕</span> Relatório PDF / Imprimir
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {error && <div className="warn" style={{ marginBottom: 20 }}>Erro: {error}</div>}

      {/* 4 CARDS KPIS EXECUTIVOS */}
      <section className="kpis" style={{ marginBottom: 22 }}>
        {/* Card 1: Saldo a Receber */}
        <div className="card" style={{ borderLeft: "4px solid var(--brand)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <small>CARTEIRA ATIVA (SALDO)</small>
            <span style={{ fontSize: 11.5, color: "var(--mut)", fontWeight: 600 }}>
              {metricas.clientesComSaldo.toLocaleString("pt-BR")} clientes
            </span>
          </div>
          <b>{money(metricas.totalSaldo)}</b>
          <div style={{ fontSize: 12, color: "var(--mut)", marginTop: 4 }}>
            {abertas.length.toLocaleString("pt-BR")} promissórias em aberto
          </div>
        </div>

        {/* Card 2: Arrecadação no Mês */}
        <div className="card" style={{ borderLeft: "4px solid #10b981" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <small>ARRECADADO NO MÊS</small>
            <span style={{
              fontSize: 11,
              fontWeight: 700,
              color: "#059669",
              background: "rgba(16, 185, 129, 0.1)",
              padding: "2px 7px",
              borderRadius: 99,
            }}>
              {metaInfo.pct.toFixed(0)}% da meta
            </span>
          </div>
          <b style={{ color: "#059669" }}>{money(dadosRecuperacao.totalCaixa)}</b>
          <div style={{ fontSize: 12, color: "var(--mut)", marginTop: 4 }}>
            Meta: {money(metaInfo.metaAtiva)} ({metaInfo.nomeMes})
          </div>
        </div>

        {/* Card 3: Inadimplência em Atraso */}
        <div className="card" style={{
          borderLeft: `4px solid ${metricas.taxaInadimplencia > 30 ? "var(--bad)" : "var(--warn)"}`,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <small>INADIMPLÊNCIA VENCIDA</small>
            <span style={{
              fontSize: 11,
              fontWeight: 700,
              color: metricas.taxaInadimplencia > 30 ? "var(--bad)" : "var(--warn)",
              background: metricas.taxaInadimplencia > 30 ? "rgba(220, 38, 38, 0.1)" : "rgba(217, 119, 6, 0.1)",
              padding: "2px 7px",
              borderRadius: 99,
            }}>
              {metricas.taxaInadimplencia.toFixed(1)}% do saldo
            </span>
          </div>
          <b style={{ color: metricas.taxaInadimplencia > 30 ? "var(--bad)" : "var(--ink)" }}>
            {money(metricas.totalVencidoValor)}
          </b>
          <div style={{ fontSize: 12, color: "var(--bad)", marginTop: 4 }}>
            {metricas.totalVencidoQtd.toLocaleString("pt-BR")} promissórias em atraso
          </div>
        </div>

        {/* Card 4: Entradas Previstas Hoje */}
        <div className="card" style={{ borderLeft: "4px solid #0284c7" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <small>ENTRADAS PREVISTAS HOJE</small>
            <span style={{
              fontSize: 11,
              fontWeight: 700,
              color: "#0284c7",
              background: "rgba(2, 132, 199, 0.1)",
              padding: "2px 7px",
              borderRadius: 99,
            }}>
              {promessasHoje.length} promessas
            </span>
          </div>
          <b style={{ color: "#0284c7" }}>{money(metricas.hojeValor + promessasHojeTotal)}</b>
          <div style={{ fontSize: 12, color: "var(--mut)", marginTop: 4 }}>
            {metricas.hojeQtd > 0 ? `${money(metricas.hojeValor)} em vencimentos de hoje` : "Agendados e vencimentos de hoje"}
          </div>
        </div>
      </section>

      {/* GRID DINÂMICO DE 2 COLUNAS (60% / 40%) */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 18, marginBottom: 24, alignItems: "start" }}>
        
        {/* COLUNA ESQUERDA: Fluxo Financeiro & Metas */}
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          
          {/* Card: Fluxo de Caixa / Recebimentos Recentes */}
          <div
            className="card"
            style={{
              padding: "16px 18px",
              background: "var(--card)",
              borderRadius: 14,
              border: "1px solid var(--line)",
              boxShadow: "var(--shadow-xs)",
            }}
          >
            {/* Topo do Card */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "var(--mut)", textTransform: "uppercase" }}>
                  FLUXO DE CAIXA
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, color: "var(--ink)", marginTop: 2, letterSpacing: "-0.02em" }}>
                  Recebimentos recentes
                </div>
              </div>
              <button
                type="button"
                className="btn ghost"
                onClick={() => carregarRecebimentosRecentes()}
                style={{ padding: "2px 6px", fontSize: 14, color: "var(--mut)", borderRadius: 6, lineHeight: 1 }}
                title="Atualizar recebimentos"
              >
                ⋯
              </button>
            </div>

            {/* Lista dos 5 últimos recebimentos */}
            {loadingRecebimentos && recebimentos.length === 0 ? (
              <div style={{ padding: "20px 0", textAlign: "center", color: "var(--mut)", fontSize: 12 }}>
                Carregando recebimentos…
              </div>
            ) : recebimentos.length === 0 ? (
              <div style={{ padding: "20px 0", textAlign: "center", color: "var(--mut)", fontSize: 12 }}>
                Nenhum recebimento registrado recentemente.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {recebimentos.slice(0, 5).map((rec, idx, arr) => (
                  <div
                    key={rec.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "9px 0",
                      borderBottom: idx === arr.length - 1 ? "none" : "1px solid var(--line)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                      <div
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: "50%",
                          backgroundColor: rec.corAvatar,
                          color: "#ffffff",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontWeight: 700,
                          fontSize: 11,
                          letterSpacing: "0.02em",
                          flexShrink: 0,
                        }}
                      >
                        {rec.iniciais}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            fontWeight: 600,
                            fontSize: 12.5,
                            color: "var(--ink)",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            cursor: "pointer",
                          }}
                          title={rec.clienteNome}
                          onClick={() => setFichaCliente({ cliente: rec.clienteNome, telefone: rec.telefone })}
                        >
                          {rec.clienteNome}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--mut)", marginTop: 1 }}>
                          {rec.descricao}
                        </div>
                      </div>
                    </div>

                    <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 10 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: "var(--ink)" }}>
                        {money(rec.valor)}
                      </div>
                      <div style={{ fontSize: 10.5, color: "var(--mut)", marginTop: 1 }}>
                        {rec.tempoRelativo}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ paddingTop: 10, marginTop: 2, borderTop: recebimentos.length > 0 ? "1px solid var(--line)" : "none" }}>
              <button
                type="button"
                onClick={() => setModalTodosRecebimentos(true)}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  color: "var(--ink)",
                  fontWeight: 700,
                  fontSize: 11.5,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  cursor: "pointer",
                }}
              >
                Ver todos os recebimentos ↗
              </button>
            </div>
          </div>

          {/* Card: Desempenho de Metas do Mês (Clean & Funcional) */}
          <div
            className="card"
            style={{
              padding: "16px 18px",
              background: "var(--card)",
              borderRadius: 14,
              border: "1px solid var(--line)",
              boxShadow: "var(--shadow-xs)",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "var(--mut)", textTransform: "uppercase" }}>
                  META MENSAL DE CRÉDITO • {metaInfo.nomeMes}
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, color: "var(--ink)", marginTop: 2, letterSpacing: "-0.02em" }}>
                  {modoMeta === "inadimplentes" ? "Recuperação de Inadimplência" : "Arrecadação Global"}
                </div>
              </div>
              <button
                type="button"
                className="btn ghost"
                style={{ fontSize: 11, padding: "3px 8px", borderRadius: 6 }}
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

            {/* Seletor de modo simplificado */}
            <div style={{ display: "flex", background: "var(--soft)", padding: 2, borderRadius: 6, gap: 3, width: "fit-content" }}>
              <button
                type="button"
                onClick={() => { setModoMeta("inadimplentes"); try { localStorage.setItem(MODO_META_KEY, "inadimplentes"); } catch {} }}
                style={{
                  border: 0,
                  cursor: "pointer",
                  fontSize: 11,
                  padding: "3px 8px",
                  borderRadius: 5,
                  fontWeight: modoMeta === "inadimplentes" ? 700 : 500,
                  background: modoMeta === "inadimplentes" ? "var(--card)" : "transparent",
                  color: modoMeta === "inadimplentes" ? "var(--brand)" : "var(--mut)",
                  boxShadow: modoMeta === "inadimplentes" ? "var(--shadow-xs)" : "none",
                }}
              >
                Recuperação Inadimplentes
              </button>
              <button
                type="button"
                onClick={() => { setModoMeta("global"); try { localStorage.setItem(MODO_META_KEY, "global"); } catch {} }}
                style={{
                  border: 0,
                  cursor: "pointer",
                  fontSize: 11,
                  padding: "3px 8px",
                  borderRadius: 5,
                  fontWeight: modoMeta === "global" ? 700 : 500,
                  background: modoMeta === "global" ? "var(--card)" : "transparent",
                  color: modoMeta === "global" ? "var(--brand)" : "var(--mut)",
                  boxShadow: modoMeta === "global" ? "var(--shadow-xs)" : "none",
                }}
              >
                Caixa Global
              </button>
            </div>

            {/* Progresso visual */}
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                <div>
                  <span style={{ fontSize: 18, fontWeight: 700, color: "var(--ink)" }}>{money(metaInfo.valorAtivo)}</span>
                  <span style={{ fontSize: 11, color: "var(--mut)", marginLeft: 6 }}>de {money(metaInfo.metaAtiva)}</span>
                </div>
                <span style={{ fontSize: 12, fontWeight: 700, color: metaInfo.pct >= 100 ? "#10b981" : "#0f766e" }}>
                  {metaInfo.pct.toFixed(1)}% atingido
                </span>
              </div>
              <div style={{ height: 6, width: "100%", background: "var(--line)", borderRadius: 99, overflow: "hidden" }}>
                <div
                  style={{
                    height: "100%",
                    width: `${Math.min(100, Math.max(0, metaInfo.pct))}%`,
                    background: metaInfo.pct >= 100 ? "#10b981" : "linear-gradient(90deg, #0f766e, #14b8a6)",
                    borderRadius: 99,
                    transition: "width .4s ease",
                  }}
                />
              </div>
            </div>

            {/* Métricas-chave em linha */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, paddingTop: 8, borderTop: "1px solid var(--line)" }}>
              <div>
                <div style={{ fontSize: 10.5, color: "var(--mut)" }}>Média diária</div>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)", marginTop: 1 }}>{money(metaInfo.mediaDiaria)}/dia</div>
              </div>
              <div>
                <div style={{ fontSize: 10.5, color: "var(--mut)" }}>Projeção no mês</div>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: metaInfo.projecaoFechamento >= metaInfo.metaAtiva ? "#059669" : "var(--ink)", marginTop: 1 }}>
                  {money(metaInfo.projecaoFechamento)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 10.5, color: "var(--mut)" }}>Taxa de resgate</div>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: "#059669", marginTop: 1 }}>
                  {metaInfo.taxaResgate.toFixed(1)}% do vencido
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* COLUNA DIREITA: Ações Operacionais & Radar de Cobrança */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          
          {/* Card: Promessas para Hoje (Ação Rápida) */}
          <div
            className="card"
            style={{
              padding: "16px 18px",
              background: "var(--card)",
              borderRadius: 14,
              border: "1px solid var(--line)",
              borderTop: "3px solid #d97706",
              boxShadow: "var(--shadow-xs)",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "#d97706", textTransform: "uppercase" }}>
                  AÇÃO IMEDIATA
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, color: "var(--ink)", marginTop: 2, letterSpacing: "-0.02em" }}>
                  Promessas de Hoje ({promessasHoje.length})
                </div>
              </div>
              {onNavegarAba && (
                <button
                  type="button"
                  className="link-cli"
                  onClick={() => onNavegarAba("promessas")}
                  style={{ fontSize: 11.5, color: "var(--brand)", fontWeight: 700 }}
                >
                  Central →
                </button>
              )}
            </div>

            {promessasHoje.length === 0 ? (
              <div style={{ padding: "14px 0", textAlign: "center", color: "var(--mut)", fontSize: 12 }}>
                ✨ Nenhuma promessa agendada para hoje.
                <div style={{ marginTop: 2, fontSize: 11 }}>
                  {promessasPosteriores.length} compromissos agendados nos próximos dias.
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {promessasHoje.slice(0, 5).map(p => (
                  <div
                    key={p.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "8px 10px",
                      background: "var(--soft)",
                      borderRadius: 8,
                      border: "1px solid var(--line)",
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1, paddingRight: 8 }}>
                      <div style={{ fontWeight: 600, fontSize: 12.5, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {p.cliente}
                      </div>
                      <div style={{ fontSize: 10.5, color: "var(--mut)", marginTop: 1 }}>
                        {p.telefone ? mascaraTelefone(p.telefone) : "Sem telefone"} {p.observacao ? `· ${p.observacao}` : ""}
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
                      <span style={{ fontWeight: 600, color: "#0284c7", fontSize: 12.5 }}>{money(p.valor)}</span>
                      {p.telefone && (
                        <button
                          type="button"
                          className="btn-baixa"
                          style={{ padding: "2px 7px", fontSize: 11, background: "#25D366" }}
                          onClick={() => setWhats({ cliente: p.cliente, telefone: p.telefone, valor: p.valor })}
                          title="Cobrar no WhatsApp"
                        >
                          Cobrar
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn ghost"
                        style={{ padding: "2px 7px", fontSize: 11 }}
                        onClick={() => handleCumprirPromessaDashboard(p.id)}
                        title="Marcar como cumprida"
                      >
                        ✓
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Card: Top 5 Clientes com Maior Saldo Vencido */}
          <div
            className="card"
            style={{
              padding: "16px 18px",
              background: "var(--card)",
              borderRadius: 14,
              border: "1px solid var(--line)",
              boxShadow: "var(--shadow-xs)",
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "var(--bad)", textTransform: "uppercase" }}>
                  PRIORIDADE DE RECUPERAÇÃO
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, color: "var(--ink)", marginTop: 2, letterSpacing: "-0.02em" }}>
                  Top Devedores Vencidos
                </div>
              </div>
              {onNavegarAba && (
                <button
                  type="button"
                  className="link-cli"
                  onClick={() => onNavegarAba("promissorias", "vencidas")}
                  style={{ fontSize: 11.5, color: "var(--brand)", fontWeight: 700 }}
                >
                  Ver todos →
                </button>
              )}
            </div>

            {topDevedores.length === 0 ? (
              <div style={{ padding: "14px 0", textAlign: "center", color: "var(--mut)", fontSize: 12 }}>
                🎉 Nenhuma promissória vencida no momento!
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {topDevedores.slice(0, 5).map(td => (
                  <div
                    key={td.cliente}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "7px 10px",
                      background: "var(--soft)",
                      borderRadius: 8,
                      border: "1px solid var(--line)",
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1, paddingRight: 8 }}>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 12.5,
                          color: "var(--ink)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          cursor: "pointer",
                        }}
                        onClick={() => setFichaCliente({ cliente: td.cliente, telefone: td.telefone })}
                        title="Ver ficha do cliente"
                      >
                        {td.cliente}
                      </div>
                      <div style={{ fontSize: 10.5, color: "var(--bad)", marginTop: 1, display: "flex", alignItems: "center", gap: 4 }}>
                        <span>⚠️ {td.maiorAtrasoDias}d atraso</span>
                        <span>• {td.qtdPromissorias} {td.qtdPromissorias === 1 ? "título" : "títulos"}</span>
                      </div>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
                      <span style={{ fontWeight: 700, color: "var(--bad)", fontSize: 12.5 }}>{money(td.totalVencido)}</span>
                      <button
                        type="button"
                        className="btn ghost"
                        style={{ padding: "2px 6px", fontSize: 11 }}
                        onClick={() => setFichaCliente({ cliente: td.cliente, telefone: td.telefone })}
                      >
                        Ficha
                      </button>
                      {td.telefone && (
                        <button
                          type="button"
                          className="btn-baixa"
                          style={{ padding: "2px 7px", fontSize: 11, background: "#25D366" }}
                          onClick={() => setWhats({ cliente: td.cliente, telefone: td.telefone, valor: td.totalVencido, vencimento: td.vencimentoMaisAntigo || undefined })}
                          title="Cobrar no WhatsApp"
                        >
                          Cobrar
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* SEÇÃO INFERIOR: RÉGUA DE ENVELHECIMENTO DA CARTEIRA (AGING COMPACTO E ESTRATÉGICO) */}
      <div
        className="card"
        style={{
          padding: "16px 18px",
          background: "var(--card)",
          borderRadius: 14,
          border: "1px solid var(--line)",
          boxShadow: "var(--shadow-xs)",
          marginBottom: 24,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "var(--mut)", textTransform: "uppercase" }}>
              ESTRATIFICAÇÃO DE RISCO
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--ink)", marginTop: 2, letterSpacing: "-0.02em" }}>
              Régua de Envelhecimento da Inadimplência (Aging)
            </div>
          </div>
          {onNavegarAba && (
            <button
              type="button"
              className="btn ghost"
              onClick={() => onNavegarAba("renegociacao")}
              style={{ fontSize: 11.5, padding: "4px 10px" }}
            >
              Abrir Central de Renegociação →
            </button>
          )}
        </div>

        {/* Mini cards compactos das faixas de atraso */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8 }}>
          {faixasAging.filter(f => f.id !== "hoje").map(f => (
            <div
              key={f.id}
              style={{
                background: "var(--soft)",
                borderRadius: 8,
                border: "1px solid var(--line)",
                borderLeft: `3px solid ${f.cor}`,
                padding: "8px 10px",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, color: f.cor }}>{f.diasLabel}</span>
                <span style={{ fontSize: 10, color: "var(--mut)", fontWeight: 600 }}>{f.qtd} tit.</span>
              </div>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)", marginTop: 2 }}>
                {money(f.valor)}
              </div>
              <div style={{ fontSize: 10, color: "var(--mut)", marginTop: 1 }}>
                {f.porcentagemDoVencido > 0 ? `${f.porcentagemDoVencido.toFixed(1)}% do vencido` : "—"}
              </div>
            </div>
          ))}
        </div>
      </div>{/* Modais */}
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
          onTelefoneAtualizado={() => carregarDados()}
        />
      )}

      {/* MODAL: Todos os Recebimentos Recentes */}
      {modalTodosRecebimentos && (
        <div className="modal-backdrop" onClick={() => setModalTodosRecebimentos(false)}>
          <div
            className="modal"
            onClick={e => e.stopPropagation()}
            style={{ maxWidth: 640, width: "100%", maxHeight: "85vh", display: "flex", flexDirection: "column" }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: 12, borderBottom: "1px solid var(--line)" }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", color: "var(--mut)", textTransform: "uppercase" }}>
                  FLUXO DE CAIXA
                </div>
                <h3 style={{ margin: "2px 0 0 0", fontSize: 18 }}>Todos os Recebimentos Recentes</h3>
              </div>
              <button type="button" className="btn ghost" onClick={() => setModalTodosRecebimentos(false)}>✕</button>
            </div>

            <div style={{ padding: "12px 0", display: "flex", gap: 10, alignItems: "center" }}>
              <input
                type="search"
                placeholder="Filtrar por nome de cliente..."
                value={buscaRecebimento}
                onChange={e => setBuscaRecebimento(e.target.value)}
                style={{ flex: 1 }}
              />
              <div style={{ fontSize: 12, color: "var(--mut)", whiteSpace: "nowrap" }}>
                Total: <b>{money(recebimentosFiltrados.reduce((acc, r) => acc + r.valor, 0))}</b> ({recebimentosFiltrados.length})
              </div>
            </div>

            <div style={{ overflowY: "auto", flex: 1, paddingRight: 4 }}>
              {recebimentosFiltrados.length === 0 ? (
                <div style={{ textAlign: "center", padding: 30, color: "var(--mut)" }}>
                  Nenhum recebimento encontrado.
                </div>
              ) : (
                recebimentosFiltrados.map((rec, idx) => (
                  <div
                    key={rec.id || idx}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "12px 0",
                      borderBottom: idx === recebimentosFiltrados.length - 1 ? "none" : "1px solid #f1f5f9",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                      <div
                        style={{
                          width: 38,
                          height: 38,
                          borderRadius: "50%",
                          backgroundColor: rec.corAvatar,
                          color: "#fff",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontWeight: 700,
                          fontSize: 12.5,
                          flexShrink: 0,
                        }}
                      >
                        {rec.iniciais}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            fontWeight: 700,
                            fontSize: 13.5,
                            color: "var(--ink)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            cursor: "pointer",
                          }}
                          onClick={() => {
                            setModalTodosRecebimentos(false);
                            setFichaCliente({ cliente: rec.clienteNome, telefone: rec.telefone });
                          }}
                        >
                          {rec.clienteNome}
                        </div>
                        <div style={{ fontSize: 11.5, color: "var(--mut)", marginTop: 1 }}>
                          {rec.descricao} {rec.telefone ? `· ${mascaraTelefone(rec.telefone)}` : ""}
                        </div>
                      </div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 12 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: "var(--ink)" }}>
                        {money(rec.valor)}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--mut)", marginTop: 1 }}>
                        {rec.tempoRelativo}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 12, borderTop: "1px solid var(--line)" }}>
              <button type="button" className="btn" onClick={() => setModalTodosRecebimentos(false)}>Fechar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
