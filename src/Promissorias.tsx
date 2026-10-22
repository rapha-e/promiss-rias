import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";
import {
  LBL, cls, deriveStatus, dt, hoje, mensagemCobranca, money, baixarCSV, extrairInfoParcelas,
  agruparClientesParaListagem,
} from "./lib";
import type { Row, Status, ClienteConsolidado } from "./lib";
import { Editor, FichaCliente, PerdidoDialog, StatusPill, VencCell, WhatsDialog, BaixaDialog, LogDialog, DesmembrarDialog, VarreduraParcelasDialog } from "./Dialogs";

type Resumo = {
  total: number; divida: number; pago: number; saldo: number; perdido: number; status: Record<Status, number>;
  vencidas_qtd: number; vencidas_valor: number; proximas_qtd: number; proximas_valor: number;
  hoje_qtd?: number; hoje_valor?: number;
  anos: number[];
};
const PS = 50;

import { SortIcon } from "./SortIcon";
import { HeaderFilterMenu } from "./HeaderFilterMenu";

type VencFiltro = "" | "vencidas" | "hoje" | "proximos_7";

const ANOS_DISPONIVEIS = Array.from({ length: 15 }, (_, i) => 2020 + i);

function ultimoDiaDoMes(yyyyMm: string): string {
  const [y, m] = yyyyMm.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

function getScoreFromLinha(r: Row) {
  if (r.fundo_perdido) {
    return {
      selo: "⛔ Fundo Perdido",
      rotulo: "Fundo Perdido",
      cor: "#64748b",
      bgCor: "rgba(100, 116, 139, 0.15)",
    };
  }
  const h = hoje();
  const vencida = r.saldo_devedor > 0 && !!r.vencimento && r.vencimento < h;
  if (vencida) {
    return {
      selo: "🔴 Risco Alto",
      rotulo: "Risco Alto (Inadimplente)",
      cor: "var(--bad)",
      bgCor: "rgba(180, 35, 24, 0.12)",
    };
  }
  if (r.saldo_devedor > 0) {
    return {
      selo: "🟡 Regular",
      rotulo: "Regular / Em dia",
      cor: "var(--warn)",
      bgCor: "rgba(217, 119, 6, 0.12)",
    };
  }
  return {
    selo: "🟢 Diamante",
    rotulo: "Cliente Diamante (Quitado)",
    cor: "var(--brand)",
    bgCor: "rgba(10, 124, 76, 0.12)",
  };
}

const TODOS_STATUS: { id: Status; label: string; desc: string; cor: string; bg: string }[] = [
  { id: "A VENCER", label: "A vencer", desc: "No prazo, aguardando data de vencimento", cor: "#0284c7", bg: "rgba(2, 132, 199, 0.12)" },
  { id: "PAGANDO", label: "Pagando", desc: "Com pagamentos parciais registrados", cor: "var(--warn)", bg: "rgba(217, 119, 6, 0.12)" },
  { id: "NÃO PAGOU", label: "Não pagou", desc: "Vencido e pendente de pagamento", cor: "var(--bad)", bg: "rgba(180, 35, 24, 0.12)" },
  { id: "FUNDO PERDIDO", label: "Fundo perdido", desc: "Promissórias baixadas / inadimplência", cor: "#64748b", bg: "rgba(100, 116, 139, 0.15)" },
  { id: "QUITADO", label: "Quitado", desc: "Dívida 100% paga e liquidada", cor: "var(--brand)", bg: "rgba(10, 124, 76, 0.12)" },
];

export default function Promissorias({ isAdmin }: { isAdmin: boolean }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [count, setCount] = useState(0);
  const [resumo, setResumo] = useState<Resumo | null>(null);
  const [q, setQ] = useState("");
  const [qd, setQd] = useState("");
  const [status, setStatus] = useState("");
  const [statusMultiplos, setStatusMultiplos] = useState<Status[]>([]);
  const [menuStatusOpen, setMenuStatusOpen] = useState(false);
  const [venc, setVenc] = useState<VencFiltro>("");
  const [filtroCliente, setFiltroCliente] = useState("");
  const [filtroClienteTemp, setFiltroClienteTemp] = useState("");
  const [filtroScore, setFiltroScore] = useState<"" | "diamante" | "regular" | "risco_alto" | "fundo_perdido">("");
  const [clientScores, setClientScores] = useState<Record<string, { selo: string; rotulo: string; cor: string; bgCor: string }>>({});
  const [filtroTelefone, setFiltroTelefone] = useState<"" | "com" | "sem">("");
  const [filtroDivida, setFiltroDivida] = useState("");
  const [filtroPago, setFiltroPago] = useState("");
  const [filtroSaldo, setFiltroSaldo] = useState("");
  const [tipoPeriodo, setTipoPeriodo] = useState<"todos" | "mes" | "ano" | "dia">("todos");
  const [ini, setIni] = useState("");
  const [fim, setFim] = useState("");
  const [mesIni, setMesIni] = useState("");
  const [mesFim, setMesFim] = useState("");
  const [anoIni, setAnoIni] = useState("");
  const [anoFim, setAnoFim] = useState("");
  const [projecaoPeriodo, setProjecaoPeriodo] = useState<{ qtd: number; valor: number } | null>(null);
  const [sortCol, setSortCol] = useState("vencimento");
  const [sortAsc, setSortAsc] = useState(false);
  const [page, setPage] = useState(0);
  const [baixa, setBaixa] = useState<Row | null>(null);
  const [logRow, setLogRow] = useState<Row | null>(null);
  const [editing, setEditing] = useState<Row | null | undefined>(undefined);
  const [perdido, setPerdido] = useState<Row | null>(null);
  const [whats, setWhats] = useState<Row | null>(null);
  const [fichaCliente, setFichaCliente] = useState<{ cliente: string; telefone?: string } | null>(null);
  const [desmembrarRow, setDesmembrarRow] = useState<Row | null>(null);
  const [varreduraOpen, setVarreduraOpen] = useState(false);
  const [error, setError] = useState("");
  const [sugestoesBusca, setSugestoesBusca] = useState<string[]>([]);

  useEffect(() => {
    const h = setTimeout(() => { setQd(q); setPage(0); }, 300);
    return () => clearTimeout(h);
  }, [q]);

  // Auto preenchimento inteligente ao digitar na barra de busca
  useEffect(() => {
    const val = q.trim();
    if (val.length < 2) {
      setSugestoesBusca([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const { data } = await supabase
          .from("promissorias")
          .select("cliente_nome")
          .ilike("cliente_nome", `%${val}%`)
          .limit(12);
        if (data) {
          const unicos = Array.from(new Set(data.map(d => d.cliente_nome.trim()))).slice(0, 8);
          setSugestoesBusca(unicos);
        }
      } catch { }
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  const loadResumo = useCallback(async () => {
    const { data, error } = await supabase.rpc("promissorias_resumo");
    if (error) { setError(error.message); return; }
    const res = { ...(data as Resumo) };
    const h = hoje();
    const [qHoje, qAVencer, qNaoPagou] = await Promise.all([
      supabase.from("promissorias").select("saldo_devedor").eq("fundo_perdido", false).gt("saldo_devedor", 0).eq("vencimento", h),
      supabase.from("promissorias").select("id", { count: "exact", head: true }).eq("fundo_perdido", false).eq("valor_pago", 0).or(`vencimento.gte.${h},vencimento.is.null`),
      supabase.from("promissorias").select("id", { count: "exact", head: true }).eq("fundo_perdido", false).eq("valor_pago", 0).lt("vencimento", h),
    ]);
    const hojeList = qHoje.data ?? [];
    res.hoje_qtd = hojeList.length;
    res.hoje_valor = hojeList.reduce((s, r) => s + (r.saldo_devedor ?? 0), 0);
    if (res.status) {
      res.status["A VENCER"] = qAVencer.count ?? 0;
      res.status["NÃO PAGOU"] = qNaoPagou.count ?? 0;
    }
    setResumo(res);
  }, []);

  const loadRows = useCallback(async () => {
    let query = supabase.from("promissorias").select("*", { count: "exact" });
    const s = qd.replace(/[%,()*]/g, " ").trim();
    if (s) query = query.or(`cliente_nome.ilike.%${s}%,telefone.ilike.%${s}%`);
    const h = hoje();
    if (statusMultiplos.length > 0) {
      const temQuitado = statusMultiplos.includes("QUITADO");
      const temAberto = statusMultiplos.some(s => s === "PAGANDO" || s === "A VENCER" || s === "NÃO PAGOU");
      const temPerdido = statusMultiplos.includes("FUNDO PERDIDO");

      if (!temQuitado && temAberto && !temPerdido) {
        query = query.eq("fundo_perdido", false).gt("saldo_devedor", 0);
      } else if (!temQuitado && temAberto && temPerdido) {
        query = query.or("saldo_devedor.gt.0,fundo_perdido.eq.true");
      } else if (!temQuitado && !temAberto && temPerdido) {
        query = query.eq("fundo_perdido", true);
      } else if (temQuitado && !temAberto && !temPerdido) {
        query = query.eq("fundo_perdido", false).lte("saldo_devedor", 0);
      }
    } else if (status === "ABERTO") query = query.eq("fundo_perdido", false).gt("saldo_devedor", 0);
    else if (status === "QUITADO") query = query.eq("fundo_perdido", false).lte("saldo_devedor", 0);
    else if (status === "PAGANDO") query = query.eq("fundo_perdido", false).gt("valor_pago", 0).gt("saldo_devedor", 0);
    else if (status === "A VENCER") query = query.eq("fundo_perdido", false).eq("valor_pago", 0).or(`vencimento.gte.${h},vencimento.is.null`);
    else if (status === "NÃO PAGOU") query = query.eq("fundo_perdido", false).eq("valor_pago", 0).lt("vencimento", h);
    else if (status === "FUNDO PERDIDO") query = query.eq("fundo_perdido", true);

    if (ini) query = query.gte("vencimento", ini);
    if (fim) query = query.lte("vencimento", fim);

    if (filtroCliente) query = query.ilike("cliente_nome", `%${filtroCliente.trim()}%`);

    if (filtroTelefone === "com") {
      query = query.not("telefone", "is", null).neq("telefone", "");
    } else if (filtroTelefone === "sem") {
      query = query.or("telefone.is.null,telefone.eq.''");
    }

    if (filtroDivida === "ate_200") query = query.lte("divida_total", 200);
    else if (filtroDivida === "200_500") query = query.gte("divida_total", 200).lte("divida_total", 500);
    else if (filtroDivida === "500_1000") query = query.gte("divida_total", 500).lte("divida_total", 1000);
    else if (filtroDivida === "mais_1000") query = query.gt("divida_total", 1000);

    if (filtroPago === "com") query = query.gt("valor_pago", 0);
    else if (filtroPago === "sem") query = query.eq("valor_pago", 0);

    if (filtroSaldo === "aberto") query = query.gt("saldo_devedor", 0);
    else if (filtroSaldo === "quitado") query = query.lte("saldo_devedor", 0);
    else if (filtroSaldo === "ate_500") query = query.gt("saldo_devedor", 0).lte("saldo_devedor", 500);
    else if (filtroSaldo === "mais_500") query = query.gt("saldo_devedor", 500);

    if (filtroScore === "diamante") {
      query = query.eq("fundo_perdido", false).lte("saldo_devedor", 0);
    } else if (filtroScore === "regular") {
      query = query.eq("fundo_perdido", false).gt("saldo_devedor", 0).or(`vencimento.gte.${h},vencimento.is.null`);
    } else if (filtroScore === "risco_alto") {
      query = query.eq("fundo_perdido", false).gt("saldo_devedor", 0).lt("vencimento", h);
    } else if (filtroScore === "fundo_perdido") {
      query = query.eq("fundo_perdido", true);
    }

    if (venc === "vencidas") query = query.eq("fundo_perdido", false).gt("saldo_devedor", 0).lt("vencimento", h);
    else if (venc === "hoje") query = query.eq("fundo_perdido", false).gt("saldo_devedor", 0).eq("vencimento", h);
    else if (venc === "proximos_7") {
      const d7 = new Date();
      d7.setDate(d7.getDate() + 7);
      const d7Str = d7.toISOString().slice(0, 10);
      query = query.eq("fundo_perdido", false).gt("saldo_devedor", 0).gte("vencimento", h).lte("vencimento", d7Str);
    }

    if (sortCol === "status") {
      query = query.order("fundo_perdido", { ascending: sortAsc }).order("status", { ascending: sortAsc });
    } else if (sortCol === "vencimento") {
      query = query.order("vencimento", { ascending: sortAsc, nullsFirst: false });
    } else {
      query = query.order(sortCol, { ascending: sortAsc });
    }
    const { data, count: c, error } = await query.order("id").limit(1000);
    if (error) { setError(error.message); return; }
    setError(""); setRows((data ?? []) as Row[]); setCount(c ?? 0);
  }, [qd, status, statusMultiplos, ini, fim, sortCol, sortAsc, venc, filtroCliente, filtroScore, filtroTelefone, filtroDivida, filtroPago, filtroSaldo]);

  const toggleStatusMultiplo = (st: Status) => {
    setStatus("");
    setStatusMultiplos(prev => {
      const next = prev.includes(st) ? prev.filter(x => x !== st) : [...prev, st];
      return next;
    });
    reset();
  };

  const selecionarTodosExcetoQuitado = () => {
    setStatus("");
    setStatusMultiplos(["A VENCER", "PAGANDO", "NÃO PAGOU", "FUNDO PERDIDO"]);
    setMenuStatusOpen(false);
    reset();
  };

  const selecionarTodosStatus = () => {
    setStatus("");
    setStatusMultiplos(["A VENCER", "PAGANDO", "NÃO PAGOU", "FUNDO PERDIDO", "QUITADO"]);
    reset();
  };

  const limparStatusMultiplos = () => {
    setStatusMultiplos([]);
    reset();
  };

  const clientesConsolidados = useMemo(() => {
    let list = agruparClientesParaListagem(rows);
    if (statusMultiplos.length > 0) {
      list = list.filter(cli => statusMultiplos.includes(cli.status));
    }
    return list;
  }, [rows, statusMultiplos]);

  const sortedClientes = useMemo(() => {
    return [...clientesConsolidados].sort((a, b) => {
      let va: any = a[sortCol as keyof ClienteConsolidado];
      let vb: any = b[sortCol as keyof ClienteConsolidado];
      if (sortCol === "status") {
        va = a.fundo_perdido ? "FUNDO PERDIDO" : a.status;
        vb = b.fundo_perdido ? "FUNDO PERDIDO" : b.status;
      }
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string") {
        const cmp = va.localeCompare(vb, "pt-BR", { sensitivity: "base" });
        return sortAsc ? cmp : -cmp;
      }
      return sortAsc ? va - vb : vb - va;
    });
  }, [clientesConsolidados, sortCol, sortAsc]);

  const totalPages = Math.max(1, Math.ceil(sortedClientes.length / PS));
  const clientesPaginados = useMemo(() => {
    return sortedClientes.slice(page * PS, (page + 1) * PS);
  }, [sortedClientes, page]);

  // Carrega a classificação real/completa dos clientes presentes na página
  useEffect(() => {
    if (rows.length === 0) {
      setClientScores({});
      return;
    }
    const uniqueNames = Array.from(new Set(rows.map(r => r.cliente_nome?.trim()).filter(Boolean))) as string[];
    if (uniqueNames.length === 0) return;

    let cancel = false;
    supabase
      .from("promissorias")
      .select("cliente_nome, saldo_devedor, vencimento, fundo_perdido")
      .in("cliente_nome", uniqueNames)
      .then(({ data, error }) => {
        if (cancel || error || !data) return;
        const h = hoje();
        const grouped: Record<string, { temFundoPerdido: boolean; temVencido: boolean; temAberto: boolean }> = {};

        for (const row of data) {
          const key = (row.cliente_nome || "").trim().toUpperCase();
          if (!key) continue;
          if (!grouped[key]) {
            grouped[key] = { temFundoPerdido: false, temVencido: false, temAberto: false };
          }
          if (row.fundo_perdido) grouped[key].temFundoPerdido = true;
          if ((row.saldo_devedor ?? 0) > 0) {
            grouped[key].temAberto = true;
            if (row.vencimento && row.vencimento < h) {
              grouped[key].temVencido = true;
            }
          }
        }

        const res: Record<string, { selo: string; rotulo: string; cor: string; bgCor: string }> = {};
        for (const [key, st] of Object.entries(grouped)) {
          if (st.temFundoPerdido) {
            res[key] = {
              selo: "⛔ Fundo Perdido",
              rotulo: "Fundo Perdido",
              cor: "#64748b",
              bgCor: "rgba(100, 116, 139, 0.15)",
            };
          } else if (st.temVencido) {
            res[key] = {
              selo: "🔴 Risco Alto",
              rotulo: "Risco Alto (Inadimplente)",
              cor: "var(--bad)",
              bgCor: "rgba(180, 35, 24, 0.12)",
            };
          } else if (st.temAberto) {
            res[key] = {
              selo: "🟡 Regular",
              rotulo: "Regular / Em dia",
              cor: "var(--warn)",
              bgCor: "rgba(217, 119, 6, 0.12)",
            };
          } else {
            res[key] = {
              selo: "🟢 Diamante",
              rotulo: "Cliente Diamante (Quitado)",
              cor: "var(--brand)",
              bgCor: "rgba(10, 124, 76, 0.12)",
            };
          }
        }
        setClientScores(res);
      });

    return () => { cancel = true; };
  }, [rows]);

  const loadProjecaoPeriodo = useCallback(async () => {
    if (!ini && !fim) {
      setProjecaoPeriodo(null);
      return;
    }
    let query = supabase
      .from("promissorias")
      .select("saldo_devedor")
      .eq("fundo_perdido", false)
      .gt("saldo_devedor", 0);
    if (ini) query = query.gte("vencimento", ini);
    if (fim) query = query.lte("vencimento", fim);
    const { data, error } = await query;
    if (error || !data) {
      setProjecaoPeriodo(null);
      return;
    }
    const valor = data.reduce((s, r) => s + (r.saldo_devedor ?? 0), 0);
    setProjecaoPeriodo({ qtd: data.length, valor });
  }, [ini, fim]);

  useEffect(() => { loadResumo(); }, [loadResumo]);
  useEffect(() => { loadRows(); }, [loadRows]);
  useEffect(() => { loadProjecaoPeriodo(); }, [loadProjecaoPeriodo]);
  const refresh = () => { loadRows(); loadResumo(); loadProjecaoPeriodo(); };

  const pages = Math.max(1, Math.ceil(count / PS));
  const st = resumo?.status;
  const chips: [string, string, number][] = [
    ["", "Todas", resumo?.total ?? 0],
    ["ABERTO", "Em aberto", (st?.PAGANDO ?? 0) + (st?.["NÃO PAGOU"] ?? 0) + (st?.["A VENCER"] ?? 0)],
    ["QUITADO", "Quitado", st?.QUITADO ?? 0],
    ["PAGANDO", "Pagando", st?.PAGANDO ?? 0],
    ["A VENCER", "A vencer", st?.["A VENCER"] ?? 0],
    ["NÃO PAGOU", "Não pagou", st?.["NÃO PAGOU"] ?? 0],
    ["FUNDO PERDIDO", "Fundo perdido", st?.["FUNDO PERDIDO"] ?? 0],
  ];
  const reset = () => setPage(0);

  const anosLista = Array.from(new Set([...(resumo?.anos ?? []), ...ANOS_DISPONIVEIS])).sort((a, b) => a - b);

  const limparPeriodo = () => {
    setTipoPeriodo("todos");
    setIni("");
    setFim("");
    setMesIni("");
    setMesFim("");
    setAnoIni("");
    setAnoFim("");
    setProjecaoPeriodo(null);
    reset();
  };

  const toggleVenc = (f: VencFiltro) => {
    if (venc === f) {
      setVenc("");
      setSortCol("vencimento");
      setSortAsc(false);
    } else {
      setVenc(f);
      setSortCol("vencimento");
      setSortAsc(f !== "vencidas");
    }
    reset();
  };

  const handleSort = (col: string, asc?: boolean) => {
    if (asc !== undefined) {
      setSortCol(col);
      setSortAsc(asc);
    } else if (sortCol === col) {
      setSortAsc(a => !a);
    } else {
      setSortCol(col);
      if (col === "divida_total" || col === "valor_pago" || col === "saldo_devedor") {
        setSortAsc(false);
      } else if (col === "vencimento") {
        setSortAsc(Boolean(venc && venc !== "vencidas"));
      } else {
        setSortAsc(true);
      }
    }
    reset();
  };

  const temFiltrosAtivos = Boolean(
    filtroCliente || filtroScore || filtroTelefone || filtroDivida || filtroPago || filtroSaldo || status || venc || statusMultiplos.length > 0
  );

  const limparTodosFiltros = () => {
    setFiltroCliente("");
    setFiltroClienteTemp("");
    setFiltroScore("");
    setFiltroTelefone("");
    setFiltroDivida("");
    setFiltroPago("");
    setFiltroSaldo("");
    setStatus("");
    setStatusMultiplos([]);
    setVenc("");
    reset();
  };

  const [menuExportar, setMenuExportar] = useState(false);
  const [exportando, setExportando] = useState(false);

  const exportarRelatorioExcel = async () => {
    setExportando(true);
    setMenuExportar(false);
    try {
      let query = supabase.from("promissorias").select("*");
      const s = qd.replace(/[%,()*]/g, " ").trim();
      if (s) query = query.or(`cliente_nome.ilike.%${s}%,telefone.ilike.%${s}%`);
      const h = hoje();
      if (status === "ABERTO") query = query.eq("fundo_perdido", false).gt("saldo_devedor", 0);
      else if (status === "QUITADO") query = query.eq("fundo_perdido", false).lte("saldo_devedor", 0);
      else if (status === "PAGANDO") query = query.eq("fundo_perdido", false).gt("valor_pago", 0).gt("saldo_devedor", 0);
      else if (status === "A VENCER") query = query.eq("fundo_perdido", false).eq("valor_pago", 0).or(`vencimento.gte.${h},vencimento.is.null`);
      else if (status === "NÃO PAGOU") query = query.eq("fundo_perdido", false).eq("valor_pago", 0).lt("vencimento", h);
      else if (status === "FUNDO PERDIDO") query = query.eq("fundo_perdido", true);

      if (filtroCliente) query = query.ilike("cliente_nome", `%${filtroCliente.trim()}%`);
      if (filtroTelefone === "com") query = query.not("telefone", "is", null).neq("telefone", "");
      else if (filtroTelefone === "sem") query = query.or("telefone.is.null,telefone.eq.''");

      if (filtroDivida === "ate_200") query = query.lte("divida_total", 200);
      else if (filtroDivida === "200_500") query = query.gte("divida_total", 200).lte("divida_total", 500);
      else if (filtroDivida === "500_1000") query = query.gte("divida_total", 500).lte("divida_total", 1000);
      else if (filtroDivida === "mais_1000") query = query.gt("divida_total", 1000);

      if (filtroPago === "com") query = query.gt("valor_pago", 0);
      else if (filtroPago === "sem") query = query.eq("valor_pago", 0);

      if (filtroSaldo === "aberto") query = query.gt("saldo_devedor", 0);
      else if (filtroSaldo === "quitado") query = query.lte("saldo_devedor", 0);
      else if (filtroSaldo === "ate_500") query = query.gt("saldo_devedor", 0).lte("saldo_devedor", 500);
      else if (filtroSaldo === "mais_500") query = query.gt("saldo_devedor", 500);

      if (ini) query = query.gte("vencimento", ini);
      if (fim) query = query.lte("vencimento", fim);

      if (venc === "vencidas") query = query.eq("fundo_perdido", false).gt("saldo_devedor", 0).lt("vencimento", h);
      else if (venc === "hoje") query = query.eq("fundo_perdido", false).gt("saldo_devedor", 0).eq("vencimento", h);
      else if (venc === "proximos_7") {
        const d7 = new Date();
        d7.setDate(d7.getDate() + 7);
        const d7Str = d7.toISOString().slice(0, 10);
        query = query.eq("fundo_perdido", false).gt("saldo_devedor", 0).gte("vencimento", h).lte("vencimento", d7Str);
      }

      if (sortCol === "status") {
        query = query.order("fundo_perdido", { ascending: sortAsc }).order("status", { ascending: sortAsc });
      } else if (sortCol === "vencimento") {
        query = query.order("vencimento", { ascending: sortAsc, nullsFirst: false });
      } else {
        query = query.order(sortCol, { ascending: sortAsc });
      }

      const { data, error: errQuery } = await query.range(0, 4999);
      if (errQuery) throw new Error(errQuery.message);

      const dadosParaExportar = (data || rows) as Row[];
      const cab = [
        "ID",
        "Cliente",
        "Telefone",
        "Parcela",
        "Total Venda (R$)",
        "Valor Pago (R$)",
        "Saldo Devedor (R$)",
        "Vencimento",
        "Status",
        "Fundo Perdido",
      ];

      const linhas = dadosParaExportar.map(r => [
        r.id,
        r.cliente_nome || "",
        r.telefone || "",
        r.parcelas || "Única",
        (r.divida_total || 0).toFixed(2),
        (r.valor_pago || 0).toFixed(2),
        (r.saldo_devedor || 0).toFixed(2),
        r.vencimento ? dt(r.vencimento) : "—",
        deriveStatus(r),
        r.fundo_perdido ? "SIM" : "NÃO",
      ]);

      baixarCSV(`relatorio-promissorias-${h}.csv`, cab, linhas);
    } catch (err: any) {
      alert("Erro ao exportar relatório: " + (err.message || err));
    } finally {
      setExportando(false);
    }
  };

  const exportarRelatorioPDF = () => {
    setMenuExportar(false);
    window.print();
  };

  return (
    <>
      {/* Cabeçalho de Impressão (visível apenas na impressão/PDF) */}
      <div className="printonly" style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>LeoÓticas — Relatório Operacional de Promissórias</h1>
        <div style={{ fontSize: 12, color: "#555", marginTop: 4 }}>
          Emitido em {dt(hoje())} · Base filtrada com {count} promissória{count !== 1 ? "s" : ""}
          {status && ` · Status: ${status}`}
          {venc && ` · Vencimento: ${venc}`}
          {ini && fim && ` · Período: ${dt(ini)} até ${dt(fim)}`}
        </div>
      </div>

      <div className="head2 noprint">
        <div>
          <h1>Acompanhe o que ainda falta receber</h1>
          <div className="sub">Saldo, status e projeções de recebimento calculados em tempo real.</div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {/* Menu Exportar Relatório */}
          <div style={{ position: "relative" }}>
            <button
              type="button"
              className="btn ghost"
              onClick={() => setMenuExportar(prev => !prev)}
              disabled={exportando}
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <span>📥</span> {exportando ? "Exportando…" : "Exportar Relatório ▾"}
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
                    minWidth: 210,
                    padding: 6,
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  <button
                    type="button"
                    onClick={exportarRelatorioExcel}
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
                    onClick={exportarRelatorioPDF}
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

          {isAdmin && (
            <button
              className="btn ghost"
              onClick={() => setVarreduraOpen(true)}
              title="Varredura do sistema para identificar e desmembrar carnês com pendências indevidas"
              style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}
            >
              <span>🔍</span> Varredura de Carnês
            </button>
          )}
          {isAdmin && <button className="btn" onClick={() => setEditing(null)}>+ Nova promissória</button>}
        </div>
      </div>
      {error && <div className="warn">Erro: {error}</div>}
      <section className="kpis">
        <div className="card hl"><small>Saldo a receber</small><b>{money(resumo?.saldo ?? 0)}</b>
          {!!resumo?.perdido && <span className="ksub">Fundo perdido: {money(resumo.perdido)} (fora do saldo)</span>}</div>
        <div className="card"><small>Total de venda</small><b>{money(resumo?.divida ?? 0)}</b></div>
        <div className="card"><small>Total pago</small><b>{money(resumo?.pago ?? 0)}</b></div>
        <div className="card"><small>Promissórias</small><b>{(resumo?.total ?? 0).toLocaleString("pt-BR")}</b></div>
      </section>

      {resumo && (
        <div className="alerts">
          <button
            type="button"
            className={`alertbtn bad ${venc === "vencidas" ? "on" : ""}`}
            onClick={() => toggleVenc("vencidas")}
            title="Filtrar promissórias vencidas"
          >
            <b>{resumo.vencidas_qtd.toLocaleString("pt-BR")} vencidas</b>
            <span>{money(resumo.vencidas_valor)} em atraso</span>
          </button>
          <button
            type="button"
            className={`alertbtn warn2 ${venc === "hoje" ? "on" : ""}`}
            onClick={() => toggleVenc("hoje")}
            title="Filtrar promissórias que vencem hoje"
          >
            <b>{(resumo.hoje_qtd ?? 0).toLocaleString("pt-BR")} hoje</b>
            <span>{money(resumo.hoje_valor ?? 0)} projetado</span>
          </button>

          <div className={`projecao-alert-card ${projecaoPeriodo !== null ? "active" : "empty"}`}>
            <div className="projecao-alert-left">
              <span className="projecao-alert-tag">Valor projetado no período</span>
              <div className="projecao-alert-main">
                <span className="projecao-alert-valor">
                  {projecaoPeriodo !== null ? money(projecaoPeriodo.valor) : "R$ —"}
                </span>
                <span className="projecao-alert-desc">
                  {projecaoPeriodo !== null ? "projetado a receber" : "selecione um período abaixo"}
                </span>
              </div>
            </div>
            <div className="projecao-alert-right">
              {projecaoPeriodo !== null ? (
                <>
                  <span className="projecao-alert-qtd">
                    <b>{projecaoPeriodo.qtd.toLocaleString("pt-BR")}</b> promissória{projecaoPeriodo.qtd !== 1 ? "s" : ""} com saldo
                  </span>
                  <span className="projecao-alert-periodo">
                    {ini && fim ? `Vencimentos de ${dt(ini)} até ${dt(fim)}` : ini ? `Vencimentos a partir de ${dt(ini)}` : `Vencimentos até ${dt(fim)}`}
                  </span>
                </>
              ) : (
                <span className="projecao-alert-periodo muted">Nenhum período selecionado</span>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="chips" style={{ position: "relative", alignItems: "center" }}>
        {chips.map(([k, l, n]) => (
          <button
            key={k}
            className={`chip ${status === k && statusMultiplos.length === 0 ? "on" : ""}`}
            onClick={() => {
              setStatusMultiplos([]);
              setStatus(k);
              reset();
            }}
          >
            {l} · {n.toLocaleString("pt-BR")}
          </button>
        ))}

        <div style={{ width: 1, height: 20, background: "var(--line)", margin: "0 4px" }} />

        {/* Botão Filtro Personalizado com Popover de Múltiplos Status */}
        <div style={{ position: "relative", display: "inline-block" }}>
          <button
            type="button"
            className={`chip ${statusMultiplos.length > 0 ? "on" : ""}`}
            onClick={() => setMenuStatusOpen(prev => !prev)}
            title="Selecionar múltiplos status para filtrar simultaneamente"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontWeight: statusMultiplos.length > 0 ? 700 : 600,
              border: statusMultiplos.length > 0 ? "1.5px solid var(--brand)" : undefined,
              boxShadow: statusMultiplos.length > 0 ? "0 0 0 2px rgba(10, 124, 76, 0.15)" : undefined,
            }}
          >
            <span>⚙️</span>
            <span>
              Filtro personalizado
              {statusMultiplos.length > 0 && ` (${statusMultiplos.length})`}
            </span>
            <span style={{ fontSize: 10, opacity: 0.7 }}>▾</span>
          </button>

          {menuStatusOpen && (
            <>
              {/* Backdrop para fechar ao clicar fora */}
              <div
                style={{ position: "fixed", inset: 0, zIndex: 90 }}
                onClick={() => setMenuStatusOpen(false)}
              />

              {/* Painel do Popover */}
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: "calc(100% + 8px)",
                  background: "var(--card)",
                  border: "1px solid var(--line)",
                  borderRadius: 12,
                  boxShadow: "0 12px 35px rgba(0,0,0,0.22)",
                  zIndex: 100,
                  width: 320,
                  padding: 14,
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                }}
              >
                {/* Cabeçalho */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13, color: "var(--ink)" }}>
                      Filtro Personalizado de Status
                    </div>
                    <div style={{ fontSize: 11, color: "var(--mut)", marginTop: 2 }}>
                      Escolha quais status deseja filtrar em conjunto
                    </div>
                  </div>
                  {statusMultiplos.length > 0 && (
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        background: "var(--brand)",
                        color: "var(--brand-ink)",
                        padding: "2px 8px",
                        borderRadius: 12,
                      }}
                    >
                      {statusMultiplos.length} selecionado{statusMultiplos.length > 1 ? "s" : ""}
                    </span>
                  )}
                </div>

                {/* Atalho Principal Solicitado: Todos exceto quitado */}
                <div
                  style={{
                    background: "rgba(10, 124, 76, 0.08)",
                    border: "1px dashed var(--brand)",
                    borderRadius: 8,
                    padding: 8,
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <button
                    type="button"
                    className="btn"
                    onClick={selecionarTodosExcetoQuitado}
                    style={{
                      width: "100%",
                      justifyContent: "center",
                      fontSize: 12,
                      padding: "6px 10px",
                      background: "var(--brand)",
                      color: "var(--brand-ink)",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    <span>⚡</span> <b>Todos exceto quitado</b>
                  </button>
                  <span style={{ fontSize: 10.5, color: "var(--mut)", textAlign: "center", lineHeight: 1.2 }}>
                    Mostra: A vencer, Pagando, Não pagou e Fundo perdido
                  </span>
                </div>

                {/* Ações rápidas: Selecionar todos / Limpar */}
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={selecionarTodosStatus}
                    style={{ flex: 1, fontSize: 11, padding: "4px 8px" }}
                  >
                    Marcar todos
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={limparStatusMultiplos}
                    style={{ flex: 1, fontSize: 11, padding: "4px 8px", color: "var(--bad)" }}
                  >
                    Limpar
                  </button>
                </div>

                <div style={{ height: 1, background: "var(--line)" }} />

                {/* Lista de Checkboxes de cada Status */}
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 250, overflowY: "auto" }}>
                  {TODOS_STATUS.map(stItem => {
                    const ativo = statusMultiplos.includes(stItem.id);
                    return (
                      <label
                        key={stItem.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "6px 8px",
                          borderRadius: 8,
                          cursor: "pointer",
                          background: ativo ? stItem.bg : "transparent",
                          transition: "background .15s ease",
                          userSelect: "none",
                        }}
                        onMouseEnter={e => {
                          if (!ativo) e.currentTarget.style.background = "var(--soft)";
                        }}
                        onMouseLeave={e => {
                          if (!ativo) e.currentTarget.style.background = "transparent";
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={ativo}
                          onChange={() => toggleStatusMultiplo(stItem.id)}
                          style={{
                            width: 16,
                            height: 16,
                            cursor: "pointer",
                            accentColor: stItem.cor,
                          }}
                        />
                        <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span
                              style={{
                                display: "inline-block",
                                width: 8,
                                height: 8,
                                borderRadius: "50%",
                                background: stItem.cor,
                              }}
                            />
                            <span style={{ fontWeight: 600, fontSize: 12.5, color: "var(--ink)" }}>
                              {stItem.label}
                            </span>
                          </div>
                          <span style={{ fontSize: 10.5, color: "var(--mut)", marginLeft: 14 }}>
                            {stItem.desc}
                          </span>
                        </div>
                      </label>
                    );
                  })}
                </div>

                {/* Rodapé */}
                <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 4 }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setMenuStatusOpen(false)}
                    style={{ fontSize: 11, padding: "5px 12px" }}
                  >
                    Fechar
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="bar" style={{ flexWrap: "wrap", gap: 10 }}>
        <input
          type="search"
          placeholder="Buscar por cliente ou telefone"
          value={q}
          onChange={e => setQ(e.target.value)}
          list="lista-clientes-promissorias"
          autoComplete="off"
        />
        <datalist id="lista-clientes-promissorias">
          {sugestoesBusca.map((s, idx) => (
            <option key={idx} value={s} />
          ))}
        </datalist>

        <select
          value={tipoPeriodo}
          onChange={e => {
            const t = e.target.value as "todos" | "mes" | "ano" | "dia";
            setTipoPeriodo(t);
            if (t === "todos") limparPeriodo();
            reset();
          }}
          aria-label="Tipo de período"
          style={{ fontWeight: 600 }}
        >
          <option value="todos">Todos os períodos</option>
          <option value="mes">🗓️ Intervalo em meses</option>
          <option value="ano">📆 Intervalo em anos</option>
          <option value="dia">📅 Intervalo em dias</option>
        </select>

        {tipoPeriodo === "mes" && (
          <>
            <label className="inl">
              De
              <input
                type="month"
                value={mesIni}
                onChange={e => {
                  const v = e.target.value;
                  setMesIni(v);
                  if (v) {
                    setIni(`${v}-01`);
                    if (!mesFim || mesFim < v) {
                      setMesFim(v);
                      setFim(ultimoDiaDoMes(v));
                    }
                  } else {
                    setIni("");
                  }
                  reset();
                }}
              />
            </label>
            <label className="inl">
              Até
              <input
                type="month"
                value={mesFim}
                onChange={e => {
                  const v = e.target.value;
                  setMesFim(v);
                  if (v) setFim(ultimoDiaDoMes(v));
                  else setFim("");
                  reset();
                }}
              />
            </label>
          </>
        )}

        {tipoPeriodo === "ano" && (
          <>
            <label className="inl">
              De
              <select
                value={anoIni}
                onChange={e => {
                  const a = e.target.value;
                  setAnoIni(a);
                  if (a) {
                    setIni(`${a}-01-01`);
                    if (!anoFim || anoFim < a) {
                      setAnoFim(a);
                      setFim(`${a}-12-31`);
                    }
                  } else {
                    setIni("");
                  }
                  reset();
                }}
              >
                <option value="">Selecione o ano</option>
                {anosLista.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
            <label className="inl">
              Até
              <select
                value={anoFim}
                onChange={e => {
                  const a = e.target.value;
                  setAnoFim(a);
                  if (a) setFim(`${a}-12-31`);
                  else setFim("");
                  reset();
                }}
              >
                <option value="">Selecione o ano</option>
                {anosLista.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
          </>
        )}

        {tipoPeriodo === "dia" && (
          <>
            <label className="inl">De <input type="date" value={ini} onChange={e => { setIni(e.target.value); reset(); }} /></label>
            <label className="inl">Até <input type="date" value={fim} onChange={e => { setFim(e.target.value); reset(); }} /></label>
          </>
        )}

        {(tipoPeriodo !== "todos" || ini || fim || mesIni || mesFim || anoIni || anoFim) && (
          <button className="btn ghost" onClick={limparPeriodo}>
            Limpar período
          </button>
        )}
        <select
          value={`${sortCol}:${sortAsc ? "asc" : "desc"}`}
          onChange={e => {
            const [c, d] = e.target.value.split(":");
            setSortCol(c);
            setSortAsc(d === "asc");
            reset();
          }}
        >
          <option value="vencimento:desc">Vencimento (recente)</option>
          <option value="vencimento:asc">Vencimento (mais antigo / próximo)</option>
          <option value="saldo_devedor:desc">Maior saldo</option>
          <option value="saldo_devedor:asc">Menor saldo</option>
          <option value="divida_total:desc">Maior dívida</option>
          <option value="valor_pago:desc">Maior valor pago</option>
          <option value="cliente_nome:asc">Cliente (A–Z)</option>
          <option value="cliente_nome:desc">Cliente (Z–A)</option>
          <option value="telefone:asc">Telefone</option>
          <option value="status:asc">Status</option>
        </select>
      </div>

      {temFiltrosAtivos && (
        <div className="active-filters-bar">
          <span style={{ fontWeight: 600, color: "var(--mut)" }}>Filtros ativos:</span>
          {filtroCliente && (
            <span className="filter-chip">
              Cliente: {filtroCliente}
              <button type="button" onClick={() => { setFiltroCliente(""); setFiltroClienteTemp(""); reset(); }} title="Remover filtro">✕</button>
            </span>
          )}
          {filtroScore && (
            <span className="filter-chip">
              Score: {
                filtroScore === "diamante" ? "🟢 Diamante" :
                  filtroScore === "regular" ? "🟡 Regular" :
                    filtroScore === "risco_alto" ? "🔴 Risco Alto" : "⛔ Fundo Perdido"
              }
              <button type="button" onClick={() => { setFiltroScore(""); reset(); }} title="Remover filtro">✕</button>
            </span>
          )}
          {filtroTelefone && (
            <span className="filter-chip">
              Telefone: {filtroTelefone === "com" ? "Com telefone" : "Sem telefone"}
              <button type="button" onClick={() => { setFiltroTelefone(""); reset(); }} title="Remover filtro">✕</button>
            </span>
          )}
          {filtroDivida && (
            <span className="filter-chip">
              Dívida: {
                filtroDivida === "ate_200" ? "Até R$ 200" :
                  filtroDivida === "200_500" ? "R$ 200 a R$ 500" :
                    filtroDivida === "500_1000" ? "R$ 500 a R$ 1.000" : "Acima de R$ 1.000"
              }
              <button type="button" onClick={() => { setFiltroDivida(""); reset(); }} title="Remover filtro">✕</button>
            </span>
          )}
          {filtroPago && (
            <span className="filter-chip">
              Pago: {filtroPago === "com" ? "Com pagamento" : "Sem pagamento"}
              <button type="button" onClick={() => { setFiltroPago(""); reset(); }} title="Remover filtro">✕</button>
            </span>
          )}
          {filtroSaldo && (
            <span className="filter-chip">
              Saldo: {
                filtroSaldo === "aberto" ? "Em aberto" :
                  filtroSaldo === "quitado" ? "Quitado" :
                    filtroSaldo === "ate_500" ? "Até R$ 500" : "Acima de R$ 500"
              }
              <button type="button" onClick={() => { setFiltroSaldo(""); reset(); }} title="Remover filtro">✕</button>
            </span>
          )}
          {venc && (
            <span className="filter-chip">
              Vencimento: {venc === "vencidas" ? "Vencidas" : venc === "hoje" ? "Hoje" : "Próximos 7 dias"}
              <button type="button" onClick={() => { setVenc(""); reset(); }} title="Remover filtro">✕</button>
            </span>
          )}
          {status && (
            <span className="filter-chip">
              Status: {status}
              <button type="button" onClick={() => { setStatus(""); reset(); }} title="Remover filtro">✕</button>
            </span>
          )}
          {statusMultiplos.length > 0 && (
            <span className="filter-chip">
              Status ({statusMultiplos.length}): {statusMultiplos.map(s => TODOS_STATUS.find(x => x.id === s)?.label || s).join(", ")}
              <button type="button" onClick={limparStatusMultiplos} title="Remover filtro de status">✕</button>
            </span>
          )}
          <button
            type="button"
            className="btn ghost"
            style={{ padding: "2px 8px", fontSize: 11, borderRadius: 99, color: "var(--bad)" }}
            onClick={limparTodosFiltros}
          >
            Limpar todos os filtros
          </button>
        </div>
      )}

      <div className="wrap">
        <table>
          <thead>
            <tr>
              <HeaderFilterMenu
                title="Cliente"
                col="cliente_nome"
                sortCol={sortCol}
                sortAsc={sortAsc}
                onSort={handleSort}
                isFiltered={Boolean(filtroCliente || filtroScore)}
                filterLabel={
                  filtroCliente
                    ? filtroCliente
                    : filtroScore === "diamante"
                      ? "🟢 Diamante"
                      : filtroScore === "regular"
                        ? "🟡 Regular"
                        : filtroScore === "risco_alto"
                          ? "🔴 Risco Alto"
                          : filtroScore === "fundo_perdido"
                            ? "⛔ Fundo Perdido"
                            : ""
                }
                onClearFilter={() => {
                  setFiltroCliente("");
                  setFiltroClienteTemp("");
                  setFiltroScore("");
                  reset();
                }}
                options={[
                  { label: "Todas as classificações", value: "", active: filtroScore === "" },
                  { label: "🟢 Diamante (Quitados)", value: "diamante", active: filtroScore === "diamante" },
                  { label: "🟡 Regular (Em dia)", value: "regular", active: filtroScore === "regular" },
                  { label: "🔴 Risco Alto (Vencidos)", value: "risco_alto", active: filtroScore === "risco_alto" },
                  { label: "⛔ Fundo Perdido", value: "fundo_perdido", active: filtroScore === "fundo_perdido" },
                ]}
                onSelectOption={val => {
                  setFiltroScore(val as any);
                  reset();
                }}
                customFilterContent={
                  <div style={{ display: "flex", gap: 4, marginTop: 4, marginBottom: 8 }}>
                    <input
                      type="text"
                      placeholder="Filtrar por nome..."
                      value={filtroClienteTemp}
                      onChange={e => setFiltroClienteTemp(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter") {
                          setFiltroCliente(filtroClienteTemp);
                          reset();
                        }
                      }}
                      style={{
                        flex: 1,
                        padding: "5px 8px",
                        fontSize: 12,
                        borderRadius: 6,
                        border: "1px solid var(--line)",
                        background: "var(--card)",
                        color: "var(--ink)",
                      }}
                    />
                    <button
                      type="button"
                      className="btn"
                      style={{ padding: "4px 8px", fontSize: 12 }}
                      onClick={() => {
                        setFiltroCliente(filtroClienteTemp);
                        reset();
                      }}
                    >
                      OK
                    </button>
                  </div>
                }
              />
              <HeaderFilterMenu
                title="Telefone"
                col="telefone"
                sortCol={sortCol}
                sortAsc={sortAsc}
                onSort={handleSort}
                isFiltered={Boolean(filtroTelefone)}
                filterLabel={filtroTelefone === "com" ? "Com telefone" : "Sem telefone"}
                onClearFilter={() => { setFiltroTelefone(""); reset(); }}
                options={[
                  { label: "Todos os telefones", value: "", active: filtroTelefone === "" },
                  { label: "Com telefone cadastrado", value: "com", active: filtroTelefone === "com" },
                  { label: "Sem telefone cadastrado", value: "sem", active: filtroTelefone === "sem" },
                ]}
                onSelectOption={val => { setFiltroTelefone(val as any); reset(); }}
              />
              <HeaderFilterMenu
                title="Dívida"
                col="divida_total"
                align="right"
                sortCol={sortCol}
                sortAsc={sortAsc}
                onSort={handleSort}
                isFiltered={Boolean(filtroDivida)}
                filterLabel={
                  filtroDivida === "ate_200" ? "Até R$ 200" :
                    filtroDivida === "200_500" ? "R$ 200 a R$ 500" :
                      filtroDivida === "500_1000" ? "R$ 500 a R$ 1.000" :
                        filtroDivida === "mais_1000" ? "Acima de R$ 1.000" : ""
                }
                onClearFilter={() => { setFiltroDivida(""); reset(); }}
                options={[
                  { label: "Qualquer valor de venda", value: "", active: filtroDivida === "" },
                  { label: "Até R$ 200", value: "ate_200", active: filtroDivida === "ate_200" },
                  { label: "R$ 200 a R$ 500", value: "200_500", active: filtroDivida === "200_500" },
                  { label: "R$ 500 a R$ 1.000", value: "500_1000", active: filtroDivida === "500_1000" },
                  { label: "Acima de R$ 1.000", value: "mais_1000", active: filtroDivida === "mais_1000" },
                ]}
                onSelectOption={val => { setFiltroDivida(val); reset(); }}
              />
              <HeaderFilterMenu
                title="Pago"
                col="valor_pago"
                align="right"
                sortCol={sortCol}
                sortAsc={sortAsc}
                onSort={handleSort}
                isFiltered={Boolean(filtroPago)}
                filterLabel={filtroPago === "com" ? "Com pagamento" : "Sem pagamento"}
                onClearFilter={() => { setFiltroPago(""); reset(); }}
                options={[
                  { label: "Todos", value: "", active: filtroPago === "" },
                  { label: "Com algum pagamento (> R$ 0)", value: "com", active: filtroPago === "com" },
                  { label: "Nenhum pagamento feito", value: "sem", active: filtroPago === "sem" },
                ]}
                onSelectOption={val => { setFiltroPago(val); reset(); }}
              />
              <HeaderFilterMenu
                title="Saldo"
                col="saldo_devedor"
                align="right"
                sortCol={sortCol}
                sortAsc={sortAsc}
                onSort={handleSort}
                isFiltered={Boolean(filtroSaldo)}
                filterLabel={
                  filtroSaldo === "aberto" ? "Em aberto" :
                    filtroSaldo === "quitado" ? "Quitado" :
                      filtroSaldo === "ate_500" ? "Até R$ 500" :
                        filtroSaldo === "mais_500" ? "Acima de R$ 500" : ""
                }
                onClearFilter={() => { setFiltroSaldo(""); reset(); }}
                options={[
                  { label: "Todos os saldos", value: "", active: filtroSaldo === "" },
                  { label: "Com saldo em aberto", value: "aberto", active: filtroSaldo === "aberto" },
                  { label: "Quitado (saldo zero)", value: "quitado", active: filtroSaldo === "quitado" },
                  { label: "Saldo até R$ 500", value: "ate_500", active: filtroSaldo === "ate_500" },
                  { label: "Saldo acima de R$ 500", value: "mais_500", active: filtroSaldo === "mais_500" },
                ]}
                onSelectOption={val => { setFiltroSaldo(val); reset(); }}
              />
              <HeaderFilterMenu
                title="Vencimento"
                col="vencimento"
                sortCol={sortCol}
                sortAsc={sortAsc}
                onSort={handleSort}
                isFiltered={Boolean(venc)}
                filterLabel={
                  venc === "vencidas" ? "Vencidas" :
                    venc === "hoje" ? "Vencem hoje" :
                      venc === "proximos_7" ? "Próximos 7 dias" : ""
                }
                onClearFilter={() => { setVenc(""); reset(); }}
                options={[
                  { label: "Todos os vencimentos", value: "", active: venc === "" },
                  { label: "Vencidas (em atraso)", value: "vencidas", active: venc === "vencidas", badge: resumo?.vencidas_qtd },
                  { label: "Vencem hoje", value: "hoje", active: venc === "hoje", badge: resumo?.hoje_qtd },
                  { label: "Próximos 7 dias", value: "proximos_7", active: venc === "proximos_7" },
                ]}
                onSelectOption={val => { toggleVenc(val as any); }}
              />
              <HeaderFilterMenu
                title="Status"
                col="status"
                sortCol={sortCol}
                sortAsc={sortAsc}
                onSort={handleSort}
                isFiltered={Boolean(status)}
                filterLabel={status || "Todas"}
                onClearFilter={() => { setStatus(""); reset(); }}
                options={[
                  { label: "Todas", value: "", active: status === "" },
                  { label: "Em aberto", value: "ABERTO", active: status === "ABERTO" },
                  { label: "Quitado", value: "QUITADO", active: status === "QUITADO" },
                  { label: "Pagando", value: "PAGANDO", active: status === "PAGANDO" },
                  { label: "A vencer", value: "A VENCER", active: status === "A VENCER" },
                  { label: "Não pagou", value: "NÃO PAGOU", active: status === "NÃO PAGOU" },
                  { label: "Fundo perdido", value: "FUNDO PERDIDO", active: status === "FUNDO PERDIDO" },
                ]}
                onSelectOption={val => { setStatus(val); reset(); }}
              />
              <th />
            </tr>
          </thead>
          <tbody>
            {clientesPaginados.map(cli => {
              const cliKey = cli.cliente_nome.trim().toUpperCase();
              const badge = clientScores[cliKey] || {
                selo: cli.fundo_perdido ? "⛔ Fundo Perdido" : cli.status === "NÃO PAGOU" ? "🔴 Risco Alto" : cli.status === "QUITADO" ? "🟢 Diamante" : "🟡 Regular",
                rotulo: cli.status,
                cor: cli.fundo_perdido ? "#64748b" : cli.status === "NÃO PAGOU" ? "var(--bad)" : cli.status === "QUITADO" ? "var(--brand)" : "var(--warn)",
                bgCor: cli.fundo_perdido ? "rgba(100, 116, 139, 0.15)" : cli.status === "NÃO PAGOU" ? "rgba(180, 35, 24, 0.12)" : cli.status === "QUITADO" ? "rgba(10, 124, 76, 0.12)" : "rgba(217, 119, 6, 0.12)",
              };

              const refRow: Row = cli.proximaPromissoria || cli.todasPromissorias[0] || {
                id: 0,
                cliente_nome: cli.cliente_nome,
                telefone: cli.telefone,
                divida_total: cli.divida_total,
                valor_pago: cli.valor_pago,
                saldo_devedor: cli.saldo_devedor,
                vencimento: cli.vencimento,
                parcelas: cli.parcelas_rotulo,
                status: cli.status,
                fundo_perdido: cli.fundo_perdido,
                fundo_perdido_motivo: null,
                fundo_perdido_em: null,
                ano: null,
              };

              return (
                <tr key={cli.cliente_nome}>
                  <td className={`s-${cls(cli.status)}`}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        className="link-cli"
                        title={`Ver detalhes e parcelamentos de ${cli.cliente_nome}`}
                        onClick={() => setFichaCliente({ cliente: cli.cliente_nome, telefone: cli.telefone })}
                        style={{ fontWeight: 600 }}
                      >
                        {cli.cliente_nome}
                      </button>
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          padding: "1px 6px",
                          borderRadius: 99,
                          background: badge.bgCor,
                          color: badge.cor,
                          whiteSpace: "nowrap",
                        }}
                        title={`Classificação de Crédito: ${badge.rotulo}`}
                      >
                        {badge.selo}
                      </span>
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: 800,
                          color: "var(--brand)",
                          padding: "2px 8px",
                          background: "rgba(10, 124, 76, 0.1)",
                          borderRadius: 6,
                          border: "1px solid rgba(10, 124, 76, 0.25)",
                          letterSpacing: "0.2px",
                        }}
                        title={`Dívida atual dividida em ${cli.parcelas_rotulo}`}
                      >
                        {cli.parcelas_rotulo}
                      </span>
                      {cli.temMultiplasComprasAbertas && (
                        <span
                          style={{
                            fontSize: 11,
                            fontWeight: 700,
                            padding: "2px 8px",
                            borderRadius: 99,
                            background: "#fef3c7",
                            color: "#b45309",
                            border: "1px solid #fde68a",
                            whiteSpace: "nowrap",
                            cursor: "pointer",
                          }}
                          onClick={() => setFichaCliente({ cliente: cli.cliente_nome, telefone: cli.telefone })}
                          title={`Este cliente possui ${cli.qtdComprasAbertas} compras/parcelamentos em aberto. Clique no nome para ver cada compra separadamente.`}
                        >
                          🏷️ +{cli.qtdComprasAbertas - 1} compra{cli.qtdComprasAbertas > 2 ? "s" : ""} ativa{cli.qtdComprasAbertas > 2 ? "s" : ""}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="mono">{cli.telefone || "—"}</td>
                  <td className="n">{money(cli.divida_total)}</td>
                  <td className="n">{money(cli.valor_pago)}</td>
                  <td className="n"><b>{money(cli.saldo_devedor)}</b></td>
                  <td><VencCell r={refRow} /></td>
                  <td><StatusPill r={refRow} /></td>
                  <td className="acts">
                    {isAdmin && !cli.fundo_perdido && cli.saldo_devedor > 0 && cli.proximaPromissoria && (
                      <button className="btn-baixa" onClick={() => setBaixa(cli.proximaPromissoria!)} title="Registrar baixa da próxima parcela">
                        Baixar
                      </button>
                    )}
                    {!cli.fundo_perdido && cli.saldo_devedor > 0 && (
                      <button className="ed" onClick={() => setWhats(refRow)} title="Cobrar por WhatsApp">
                        Whats
                      </button>
                    )}
                    {isAdmin && (
                      <button className="ed" onClick={() => setEditing(refRow)} title="Editar dados da promissória">
                        Editar
                      </button>
                    )}
                    {isAdmin && (cli.fundo_perdido || cli.saldo_devedor > 0) && (
                      <button className="ed" onClick={() => setPerdido(refRow)} title={cli.fundo_perdido ? "Desfazer fundo perdido" : "Marcar como fundo perdido"}>
                        {cli.fundo_perdido ? "Desfazer" : "F. Perdido"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {!clientesPaginados.length && <tr><td colSpan={8} style={{ textAlign: "center", color: "var(--mut)", padding: 30 }}>Nenhum cliente encontrado.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="pager">
        <span>{sortedClientes.length.toLocaleString("pt-BR")} clientes · página {page + 1} de {totalPages}</span>
        <button className="btn ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>←</button>
        <button className="btn ghost" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>→</button>
      </div>
      {baixa && <BaixaDialog row={baixa} onClose={() => setBaixa(null)} onSaved={() => { setBaixa(null); refresh(); }} />}
      {desmembrarRow && (
        <DesmembrarDialog
          row={desmembrarRow}
          onClose={() => setDesmembrarRow(null)}
          onSaved={() => {
            setDesmembrarRow(null);
            refresh();
          }}
        />
      )}
      {varreduraOpen && (
        <VarreduraParcelasDialog
          onClose={() => setVarreduraOpen(false)}
          onDone={() => {
            refresh();
          }}
        />
      )}
      {logRow && <LogDialog row={logRow} onClose={() => setLogRow(null)} />}
      {editing !== undefined && <Editor row={editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); refresh(); }} />}
      {perdido && <PerdidoDialog row={perdido} onClose={() => setPerdido(null)} onDone={() => { setPerdido(null); refresh(); }} />}
      {whats && <WhatsDialog nome={whats.cliente_nome} telefone={whats.telefone} mensagem={mensagemCobranca(whats.cliente_nome, [{ valor: whats.saldo_devedor, vencimento: whats.vencimento }])} onClose={() => setWhats(null)} />}
      {fichaCliente && (
        <FichaCliente
          cliente={fichaCliente.cliente}
          telefone={fichaCliente.telefone}
          isAdmin={isAdmin}
          onClose={() => setFichaCliente(null)}
          onChanged={refresh}
        />
      )}
    </>
  );
}
