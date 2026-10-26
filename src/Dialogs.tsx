import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import { supabase } from "./supabase";
import {
  LBL, alerta, alertaTexto, cls, derive, deriveStatus, dt, dtHora, formatarTelefone,
  getDDD, hoje, linkWhatsApp, mascaraTelefone, mensagemCobranca, mensagemComprovanteBaixa, money, normalizarTelefones, parse, setDDD, somaDias, toBRL,
  calcularScoreCliente, extrairInfoParcelas, formatarValorSemCifrao,
  gerarParcelasDesmembradas, obterVencimentoEfetivo, somaMeses, ajustarApenasDia,
  identificarCompraAtual, separarComprasCliente,
  formatarMascaraMoeda, desmascararMoeda, ehRepactuada,
} from "./lib";
import type { Row, CreditScoreInfo, CompraGrupo } from "./lib";
import { SortIcon } from "./SortIcon";

export function Painel({ onClose, wide, style, children }: { onClose: () => void; wide?: boolean; style?: CSSProperties; children: ReactNode }) {
  return (
    <div className="ov" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={`panel ${wide ? "wide" : ""}`} style={style}>{children}</div>
    </div>
  );
}

export function StatusPill({ r }: { r: Row }) {
  if (ehRepactuada(r) && (r.saldo_devedor ?? 0) <= 0) {
    return (
      <span
        className="pill"
        style={{
          background: "rgba(147, 51, 234, 0.12)",
          color: "#7e22ce",
          borderColor: "#a855f7",
          fontWeight: 700,
        }}
        title="Título baixado por Acordo de Repactuação (substituído por novas parcelas)"
      >
        🔄 Repactuado
      </span>
    );
  }
  const s = deriveStatus(r);
  return <span className={`pill p-${cls(s)}`}>{LBL[s]}</span>;
}

export function VencCell({ r }: { r: Row }) {
  const a = alerta(r);
  const vReal = obterVencimentoEfetivo(r);
  const mudou = vReal && vReal !== r.vencimento;

  return (
    <>
      <span className="mono">{dt(vReal || r.vencimento)}</span>
      {mudou && (
        <div className="sub" style={{ fontSize: 10, color: "var(--brand)", fontWeight: 600 }} title={`Vencimento original da 1ª parcela: ${dt(r.vencimento)}. Avançado conforme parcelas já pagas do carnê.`}>
          Próx. venc. carnê
        </div>
      )}
      {a.tipo && <div><span className={`al al-${a.tipo}`}>{alertaTexto(a)}</span></div>}
    </>
  );
}

export function Editor({ row, onClose, onSaved }: { row: Row | null; onClose: () => void; onSaved: () => void }) {
  const [n, setN] = useState(row?.cliente_nome ?? "");
  const [p, setP] = useState(row ? mascaraTelefone(row.telefone) : "");
  const [t, setT] = useState(row ? formatarMascaraMoeda(row.divida_total) : "");
  const [g, setG] = useState(row && row.valor_pago > 0 ? formatarMascaraMoeda(row.valor_pago) : "");
  const [qtd, setQtd] = useState(1);
  const [i, setI] = useState(row?.parcelas ?? "1X");
  const [d, setD] = useState(row?.vencimento ?? somaDias(hoje(), 30));
  const [atualizarProximas, setAtualizarProximas] = useState(true);
  const [parcelasCarne, setParcelasCarne] = useState<Row[]>([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [scoreCliente, setScoreCliente] = useState<CreditScoreInfo | null>(null);

  // Modo de edição: "parcela" para ajustes pontuais na parcela individual, ou "compra_total" para unificar/reparcelar
  const [modoEdicao, setModoEdicao] = useState<"parcela" | "compra_total">("parcela");

  // Estados para Unificação / Reparcelamento da Dívida Total / Troca por Menor Valor
  const [todasPromissoriasCliente, setTodasPromissoriasCliente] = useState<Row[]>([]);
  const [carregandoTitulosCliente, setCarregandoTitulosCliente] = useState(false);
  const [escopoUnificacao, setEscopoUnificacao] = useState<"carne" | "todas_abertas">("carne");
  const [idsParcelasSelecionadas, setIdsParcelasSelecionadas] = useState<number[]>([]);
  const [tipoAjusteUnificacao, setTipoAjusteUnificacao] = useState<"padrao" | "troca_menor_valor">("padrao");
  const [novaCompra, setNovaCompra] = useState<string>("");
  const [abatimentoManual, setAbatimentoManual] = useState<string>("");
  const [valorNovoOculos, setValorNovoOculos] = useState<string>("");
  const [valorJaPagoAbater, setValorJaPagoAbater] = useState<string>("");
  const [jaPagoPreenchidoAuto, setJaPagoPreenchidoAuto] = useState<boolean>(false);
  const [entradaUnificacao, setEntradaUnificacao] = useState<string>("");
  const [qtdParcelasUnificacao, setQtdParcelasUnificacao] = useState<number>(4);
  const [vencimentoUnificacao, setVencimentoUnificacao] = useState<string>(somaDias(hoje(), 30));
  const [obsUnificacao, setObsUnificacao] = useState<string>("");

  // Informações sobre parcelamento de carnê (ex: 2/6, 3/10) para suporte a ajuste de dia em todo o carnê
  const infoCarne = useMemo(() => {
    if (!row || !row.parcelas) return null;
    const m = (row.parcelas || "").trim().match(/^(\d+)\/(\d+)$/);
    if (!m) return null;
    const num = parseInt(m[1], 10);
    const denom = parseInt(m[2], 10);
    if (denom <= 1) return null;
    return { num, denom, totalParcelas: denom };
  }, [row]);

  // Carrega todas as promissórias do cliente do Supabase para ter visão total das compras e parcelas
  useEffect(() => {
    if (!row || !n.trim()) return;
    setCarregandoTitulosCliente(true);
    let cancelado = false;
    supabase
      .from("promissorias")
      .select("*")
      .ilike("cliente_nome", n.trim())
      .order("vencimento", { ascending: true })
      .then(({ data }) => {
        if (cancelado) return;
        setCarregandoTitulosCliente(false);
        if (data) {
          setTodasPromissoriasCliente(data as Row[]);
        }
      });
    return () => { cancelado = true; };
  }, [row, n]);

  // Agrupa as compras do cliente
  const comprasCliente = useMemo(() => {
    if (!todasPromissoriasCliente || todasPromissoriasCliente.length === 0) return [];
    return separarComprasCliente(todasPromissoriasCliente);
  }, [todasPromissoriasCliente]);

  // Identifica a qual compra a parcela atual (row) pertence
  const compraDoRow = useMemo(() => {
    if (!row || comprasCliente.length === 0) return null;
    return comprasCliente.find(c => c.promissorias.some(p => p.id === row.id)) || null;
  }, [row, comprasCliente]);

  // Parcelas em aberto da compra do row
  const parcelasAbertasDestaCompra = useMemo(() => {
    if (!compraDoRow) {
      return parcelasCarne.filter(p => (p.saldo_devedor ?? 0) > 0 && !p.fundo_perdido);
    }
    return compraDoRow.promissorias.filter(p => (p.saldo_devedor ?? 0) > 0 && !p.fundo_perdido);
  }, [compraDoRow, parcelasCarne]);

  // Todas as parcelas em aberto do cliente em todas as compras
  const todasParcelasAbertasCliente = useMemo(() => {
    return todasPromissoriasCliente.filter(p => (p.saldo_devedor ?? 0) > 0 && !p.fundo_perdido);
  }, [todasPromissoriasCliente]);

  // Inicializa parcelas selecionadas para unificação conforme o escopo escolhido
  useEffect(() => {
    if (!row) return;
    if (escopoUnificacao === "carne") {
      if (parcelasAbertasDestaCompra.length > 0) {
        setIdsParcelasSelecionadas(parcelasAbertasDestaCompra.map(p => p.id));
      } else {
        setIdsParcelasSelecionadas([row.id]);
      }
    } else {
      if (todasParcelasAbertasCliente.length > 0) {
        setIdsParcelasSelecionadas(todasParcelasAbertasCliente.map(p => p.id));
      } else {
        setIdsParcelasSelecionadas([row.id]);
      }
    }
  }, [escopoUnificacao, parcelasAbertasDestaCompra, todasParcelasAbertasCliente, row]);

  // Inicializa quantidade de parcelas e vencimento sugerido para a unificação
  useEffect(() => {
    if (compraDoRow) {
      if (compraDoRow.totalParcelas && compraDoRow.totalParcelas > 1) {
        setQtdParcelasUnificacao(compraDoRow.totalParcelas);
      }
      if (compraDoRow.proximoVencimento) {
        setVencimentoUnificacao(compraDoRow.proximoVencimento);
      }
    }
  }, [compraDoRow]);

  // Cálculos matemáticos da unificação
  const parcelasParaUnificar = useMemo(() => {
    return todasPromissoriasCliente.filter(p =>
      idsParcelasSelecionadas.includes(p.id) && (p.saldo_devedor ?? 0) > 0 && !p.fundo_perdido
    );
  }, [todasPromissoriasCliente, idsParcelasSelecionadas]);

  const saldoAnteriorDevedor = useMemo(() => {
    return parcelasParaUnificar.reduce((acc, p) => acc + (p.saldo_devedor ?? 0), 0);
  }, [parcelasParaUnificar]);

  // Calcula o total já pago especificamente na compra do carnê atual (sem misturar com compras antigas)
  const valorPagoDetectadoCompra = useMemo(() => {
    // 1. Se identificou a compra à qual a parcela pertence, analisa EXCLUSIVAMENTE as promissórias desta compra
    if (compraDoRow && Array.isArray(compraDoRow.promissorias) && compraDoRow.promissorias.length > 0) {
      return compraDoRow.promissorias
        .filter(p => !ehRepactuada(p))
        .reduce((acc, p) => acc + (p.valor_pago || 0), 0);
    }

    // 2. Fallback apenas se houver parcelas do mesmo carnê específico carregadas
    if (parcelasCarne.length > 0) {
      return parcelasCarne
        .filter(p => !ehRepactuada(p))
        .reduce((acc, p) => acc + (p.valor_pago || 0), 0);
    }

    // 3. Fallback pontual: apenas a parcela atual, se foi parcialmente paga em dinheiro
    if (row && !ehRepactuada(row)) {
      return row.valor_pago || 0;
    }

    return 0;
  }, [compraDoRow, parcelasCarne, row]);

  // Reseta estado de auto preenchimento quando trocar a parcela selecionada
  useEffect(() => {
    setJaPagoPreenchidoAuto(false);
    if (valorPagoDetectadoCompra > 0) {
      setValorJaPagoAbater(formatarMascaraMoeda(valorPagoDetectadoCompra));
    } else {
      setValorJaPagoAbater("");
    }
  }, [row?.id, valorPagoDetectadoCompra]);

  const valorNovaCompraNum = parse(novaCompra) || 0;
  const valorAbatimentoManualNum = parse(abatimentoManual) || 0;
  const valorNovoOculosNum = parse(valorNovoOculos) || 0;
  const valorJaPagoAbaterNum = parse(valorJaPagoAbater) || 0;
  const valorEntradaUnificacaoNum = parse(entradaUnificacao) || 0;

  // Cálculo preciso do saldo final a reparcelar e eventual crédito a favor do cliente
  const { saldoFinalAParcelar, creditoClienteTroca } = useMemo(() => {
    if (tipoAjusteUnificacao === "troca_menor_valor") {
      if (valorNovoOculosNum <= 0) {
        return { saldoFinalAParcelar: 0, creditoClienteTroca: 0 };
      }
      // Valor do novo óculos - valor já pago - entrada adicional no ato
      const saldoLiq = valorNovoOculosNum - valorJaPagoAbaterNum - valorEntradaUnificacaoNum;
      if (saldoLiq < 0) {
        return { saldoFinalAParcelar: 0, creditoClienteTroca: Math.abs(saldoLiq) };
      }
      return { saldoFinalAParcelar: saldoLiq, creditoClienteTroca: 0 };
    }

    // Modo padrão: Saldo devedor anterior + nova compra - abatimento manual/desconto - entrada
    const saldoPadrao = Math.max(
      0,
      saldoAnteriorDevedor + valorNovaCompraNum - valorAbatimentoManualNum - valorEntradaUnificacaoNum
    );
    return { saldoFinalAParcelar: saldoPadrao, creditoClienteTroca: 0 };
  }, [
    tipoAjusteUnificacao,
    valorNovoOculosNum,
    valorJaPagoAbaterNum,
    valorEntradaUnificacaoNum,
    saldoAnteriorDevedor,
    valorNovaCompraNum,
    valorAbatimentoManualNum,
  ]);

  // Divisão das novas parcelas da unificação (centavo a centavo)
  const parcelasUnificadasCalculadas = useMemo(() => {
    if (saldoFinalAParcelar <= 0 || qtdParcelasUnificacao <= 0 || !vencimentoUnificacao) return [];
    const base = Math.floor(saldoFinalAParcelar / qtdParcelasUnificacao);
    const resto = saldoFinalAParcelar % qtdParcelasUnificacao;

    return Array.from({ length: qtdParcelasUnificacao }, (_, idx) => {
      const num = idx + 1;
      const valor = base + (idx === 0 ? resto : 0);
      const venc = somaMeses(vencimentoUnificacao, idx);
      const rotulo = qtdParcelasUnificacao === 1 ? "1X" : `${num}/${qtdParcelasUnificacao}`;
      return {
        numero: num,
        parcela: rotulo,
        valor,
        vencimento: venc,
      };
    });
  }, [saldoFinalAParcelar, qtdParcelasUnificacao, vencimentoUnificacao]);

  // Carrega todas as parcelas deste carnê para prévia e atualização em lote (inclusive anteriores e quitadas)
  useEffect(() => {
    if (!row || !infoCarne || !n.trim()) {
      setParcelasCarne([]);
      return;
    }
    let cancelado = false;
    supabase
      .from("promissorias")
      .select("id, cliente_nome, parcelas, vencimento, saldo_devedor, divida_total, valor_pago, origem")
      .ilike("cliente_nome", n.trim())
      .then(({ data }) => {
        if (cancelado || !data) return;
        const doCarne = data.filter(p => {
          const m = (p.parcelas || "").trim().match(/^(\d+)\/(\d+)$/);
          return (
            m &&
            parseInt(m[2], 10) === infoCarne.denom &&
            Math.abs(p.divida_total - (row.divida_total || 0)) <= Math.max(infoCarne.denom, 500)
          );
        });
        doCarne.sort((a, b) => {
          const na = parseInt((a.parcelas || "").match(/^(\d+)/)?.[1] || "0", 10);
          const nb = parseInt((b.parcelas || "").match(/^(\d+)/)?.[1] || "0", 10);
          return na - nb;
        });
        setParcelasCarne(doCarne);
      });
    return () => { cancelado = true; };
  }, [row, infoCarne, n]);

  // Estados do Auto Preenchimento Inteligente ao digitar (Autocomplete)
  const [sugestoes, setSugestoes] = useState<{
    nome: string;
    telefone: string;
    totalCompras: number;
    saldoAberto: number;
    temAtraso: boolean;
    scoreInfo?: CreditScoreInfo;
  }[]>([]);
  const [mostrarSugestoes, setMostrarSugestoes] = useState(false);
  const [sugestaoAtiva, setSugestaoAtiva] = useState(-1);
  const [buscandoSugestoes, setBuscandoSugestoes] = useState(false);
  const [sugestaoPorTelefone, setSugestaoPorTelefone] = useState<{ nome: string; telefone: string } | null>(null);

  const containerNomeRef = useRef<HTMLDivElement>(null);
  const inputNomeRef = useRef<HTMLInputElement>(null);
  const inputTelRef = useRef<HTMLInputElement>(null);
  const inputValorRef = useRef<HTMLInputElement>(null);

  // Selecionar cliente e auto preencher os campos instantaneamente
  const selecionarCliente = useCallback((sug: { nome: string; telefone: string; scoreInfo?: CreditScoreInfo }) => {
    setN(sug.nome);
    if (sug.telefone) {
      setP(mascaraTelefone(sug.telefone));
    }
    if (sug.scoreInfo) {
      setScoreCliente(sug.scoreInfo);
    }
    setMostrarSugestoes(false);
    setSugestaoAtiva(-1);
    setSugestaoPorTelefone(null);

    // Foco automático no próximo campo
    setTimeout(() => {
      if (!sug.telefone) {
        inputTelRef.current?.focus();
      } else {
        inputValorRef.current?.focus();
      }
    }, 60);
  }, []);

  // Fechar dropdown de sugestões ao clicar fora
  useEffect(() => {
    function handleClickOutside(ev: MouseEvent) {
      if (containerNomeRef.current && !containerNomeRef.current.contains(ev.target as Node)) {
        setMostrarSugestoes(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Busca e sugestões em tempo real ao digitar o nome do cliente
  useEffect(() => {
    const nome = n.trim();
    if (nome.length < 2) {
      setSugestoes([]);
      setMostrarSugestoes(false);
      setScoreCliente(null);
      return;
    }

    setBuscandoSugestoes(true);
    const timer = setTimeout(async () => {
      try {
        const { data } = await supabase
          .from("promissorias")
          .select("cliente_nome, telefone, divida_total, valor_pago, saldo_devedor, vencimento, fundo_perdido")
          .ilike("cliente_nome", `%${nome}%`)
          .order("vencimento", { ascending: false })
          .limit(40);

        if (!data || data.length === 0) {
          setSugestoes([]);
          setMostrarSugestoes(false);
          setScoreCliente(null);
          return;
        }

        // Agrupar por cliente único
        const mapa = new Map<string, {
          nome: string;
          telefones: string[];
          rows: Row[];
        }>();

        data.forEach(r => {
          const nomeNorm = r.cliente_nome.trim();
          if (!mapa.has(nomeNorm)) {
            mapa.set(nomeNorm, {
              nome: nomeNorm,
              telefones: [],
              rows: [],
            });
          }
          const item = mapa.get(nomeNorm)!;
          item.rows.push(r as Row);
          if (r.telefone && r.telefone.trim() && !item.telefones.includes(r.telefone.trim())) {
            item.telefones.push(r.telefone.trim());
          }
        });

        const lista: {
          nome: string;
          telefone: string;
          totalCompras: number;
          saldoAberto: number;
          temAtraso: boolean;
          scoreInfo?: CreditScoreInfo;
        }[] = [];
        const termoLower = nome.toLowerCase();

        mapa.forEach(item => {
          const score = calcularScoreCliente(item.rows);
          const telValido = item.telefones[0] || "";
          const saldoAberto = item.rows.reduce((acc, r) => acc + (r.fundo_perdido ? 0 : r.saldo_devedor), 0);
          const temAtraso = score.totalVencido > 0;

          lista.push({
            nome: item.nome,
            telefone: telValido,
            totalCompras: item.rows.length,
            saldoAberto,
            temAtraso,
            scoreInfo: score,
          });
        });

        // Ordenar: primeiro os que começam exatamente com o termo digitado
        lista.sort((a, b) => {
          const aStart = a.nome.toLowerCase().startsWith(termoLower);
          const bStart = b.nome.toLowerCase().startsWith(termoLower);
          if (aStart && !bStart) return -1;
          if (!aStart && bStart) return 1;
          return a.nome.localeCompare(b.nome, "pt-BR");
        });

        const topSugestoes = lista.slice(0, 8);
        setSugestoes(topSugestoes);
        setSugestaoAtiva(-1);

        // Se o nome digitado for exatamente o de algum cliente, ativa o score dele
        const matchExato = lista.find(s => s.nome.toLowerCase() === termoLower);
        if (matchExato && matchExato.scoreInfo) {
          setScoreCliente(matchExato.scoreInfo);
        }
      } catch (err) {
        console.error("Erro no autocomplete de clientes:", err);
      } finally {
        setBuscandoSugestoes(false);
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [n]);

  // Auto-preenchimento ao digitar no campo Telefone
  useEffect(() => {
    const nums = p.replace(/\D/g, "");
    if (nums.length >= 8 && (!n.trim() || n.trim().length < 3)) {
      const timer = setTimeout(async () => {
        try {
          const { data } = await supabase
            .from("promissorias")
            .select("cliente_nome, telefone")
            .ilike("telefone", `%${nums}%`)
            .order("id", { ascending: false })
            .limit(5);

          if (data && data.length > 0) {
            const primeiro = data[0];
            if (primeiro.cliente_nome && primeiro.cliente_nome.trim().toLowerCase() !== n.trim().toLowerCase()) {
              setSugestaoPorTelefone({
                nome: primeiro.cliente_nome.trim(),
                telefone: primeiro.telefone || p,
              });
            } else {
              setSugestaoPorTelefone(null);
            }
          } else {
            setSugestaoPorTelefone(null);
          }
        } catch {
          setSugestaoPorTelefone(null);
        }
      }, 250);
      return () => clearTimeout(timer);
    } else {
      setSugestaoPorTelefone(null);
    }
  }, [p, n]);

  const T = parse(t);
  const G = parse(g);
  const ok = !isNaN(T) && !isNaN(G);
  const isNova = !row;

  const saldoAParcelar = Math.max(0, T - G);

  // Cálculo e divisão das promissórias (a cada 30 dias após o 1º vencimento)
  // A entrada é abatida da dívida total antes da divisão entre as promissórias
  const parcelasCalculadas = useMemo(() => {
    if (!isNova || !ok || T <= 0 || qtd <= 0 || saldoAParcelar <= 0) return [];
    const base = Math.floor(saldoAParcelar / qtd);
    const resto = saldoAParcelar % qtd;

    return Array.from({ length: qtd }, (_, idx) => {
      const num = idx + 1;
      const valor = base + (idx === 0 ? resto : 0);
      const vencimento = d ? somaMeses(d, idx) : null;
      const rotulo = qtd === 1 ? "1X" : `${num}/${qtd}`;

      return {
        numero: num,
        parcela: rotulo,
        valor,
        pago: 0,
        saldo: valor,
        vencimento,
      };
    });
  }, [isNova, ok, T, qtd, saldoAParcelar, d]);

  const st = ok ? derive(T, G, d) : null;

  async function handleDelete() {
    if (!row) return;
    const confirmou = window.confirm(
      `Deseja realmente EXCLUIR permanentemente a promissória de ${row.cliente_nome} no valor de ${money(row.divida_total)}?\n\n` +
      `Atenção: Esta ação é definitiva e removerá este título do sistema e de todos os relatórios.`
    );
    if (!confirmou) return;

    setBusy(true);
    setErr("");
    const { error } = await supabase.from("promissorias").delete().eq("id", row.id);
    setBusy(false);
    if (error) return setErr("Não foi possível excluir: " + error.message);
    onSaved();
  }

  async function submitUnificacao() {
    if (tipoAjusteUnificacao === "troca_menor_valor") {
      if (valorNovoOculosNum <= 0) {
        setErr("Informe o valor total do novo produto.");
        return;
      }
      if (saldoFinalAParcelar <= 0 && creditoClienteTroca > 0) {
        setErr(`O valor já pago (${money(valorJaPagoAbaterNum)}) cobre todo o novo produto (${money(valorNovoOculosNum)}). O cliente possui um crédito/troco de ${money(creditoClienteTroca)}. Não há saldo devedor a reparcelar.`);
        return;
      }
    }

    if (parcelasParaUnificar.length === 0 && valorNovaCompraNum <= 0 && valorNovoOculosNum <= 0) {
      setErr("Selecione ao menos uma parcela em aberto ou informe o valor do novo produto / nova compra.");
      return;
    }
    if (saldoFinalAParcelar <= 0) {
      setErr("O saldo final a parcelar deve ser maior que zero (a entrada ou abatimento não pode cobrir todo o valor).");
      return;
    }
    if (!vencimentoUnificacao) {
      setErr("Informe a data do 1º vencimento.");
      return;
    }

    const confirmou = window.confirm(
      tipoAjusteUnificacao === "troca_menor_valor"
        ? `Confirmar TROCA POR PRODUTO DE MENOR VALOR e novo parcelamento para ${n.trim()}?\n\n` +
          `• Valor do novo produto: ${money(valorNovoOculosNum)}\n` +
          `• Abatimento do que já foi pago: - ${money(valorJaPagoAbaterNum)}\n` +
          (valorEntradaUnificacaoNum > 0 ? `• Entrada no ato (dinheiro/Pix): - ${money(valorEntradaUnificacaoNum)}\n` : "") +
          `• Novo saldo a reparcelar: ${money(saldoFinalAParcelar)} em ${qtdParcelasUnificacao}x de aprox. ${money(Math.round(saldoFinalAParcelar / qtdParcelasUnificacao))}\n` +
          `• 1º vencimento: ${dt(vencimentoUnificacao)}\n\n` +
          `As ${parcelasParaUnificar.length} parcelas em aberto anteriores serão baixadas por motivo de troca e ${qtdParcelasUnificacao} novas parcelas serão geradas.`
        : `Confirmar unificação e novo parcelamento para ${n.trim()}?\n\n` +
          `• Saldo em aberto anterior: ${money(saldoAnteriorDevedor)} (${parcelasParaUnificar.length} parcela(s) selecionada(s))\n` +
          (valorNovaCompraNum > 0 ? `• Nova compra adicionada: + ${money(valorNovaCompraNum)}\n` : "") +
          (valorAbatimentoManualNum > 0 ? `• Abatimento / Desconto aplicado: - ${money(valorAbatimentoManualNum)}\n` : "") +
          (valorEntradaUnificacaoNum > 0 ? `• Entrada recebida no ato: - ${money(valorEntradaUnificacaoNum)}\n` : "") +
          `• Novo saldo a parcelar: ${money(saldoFinalAParcelar)} em ${qtdParcelasUnificacao}x de aprox. ${money(Math.round(saldoFinalAParcelar / qtdParcelasUnificacao))}\n` +
          `• 1º vencimento: ${dt(vencimentoUnificacao)}\n\n` +
          `As parcelas anteriores selecionadas serão baixadas e ${qtdParcelasUnificacao} novas parcelas serão geradas com registro no histórico.`
    );
    if (!confirmou) return;

    setBusy(true);
    setErr("");

    try {
      const { data: userData } = await supabase.auth.getUser();
      const operadorEmail = userData?.user?.email || "sistema@leooticas.com";
      const operadorId = userData?.user?.id || null;
      const agoraIso = new Date().toISOString();
      const titulosAntigosIds = parcelasParaUnificar.map(pRow => pRow.id);
      const detalhesAcordo = tipoAjusteUnificacao === "troca_menor_valor"
        ? `Troca por produto de menor valor em ${qtdParcelasUnificacao}x realizada em ${new Date().toLocaleDateString("pt-BR")}. Valor do novo produto: ${money(valorNovoOculosNum)}, abatimento do já pago: ${money(valorJaPagoAbaterNum)}, entrada no ato: ${money(valorEntradaUnificacaoNum)}, novo saldo reparcelado: ${money(saldoFinalAParcelar)}. ${obsUnificacao.trim()}`
        : `Unificação e reparcelamento em ${qtdParcelasUnificacao}x realizado em ${new Date().toLocaleDateString("pt-BR")}. Saldo devedor anterior: ${money(saldoAnteriorDevedor)}, nova compra: ${money(valorNovaCompraNum)}, abatimento/desconto: ${money(valorAbatimentoManualNum)}, entrada: ${money(valorEntradaUnificacaoNum)}, novo total: ${money(saldoFinalAParcelar)}. ${obsUnificacao.trim()}`;

      // 1. Baixar as parcelas antigas selecionadas
      for (const pRow of parcelasParaUnificar) {
        let logsArray: any[] = [];
        if (pRow.origem) {
          try {
            const parsed = JSON.parse(pRow.origem);
            if (Array.isArray(parsed)) logsArray = parsed;
          } catch (_) {}
        }
        logsArray.push({
          data: agoraIso,
          valor: 0,
          saldoRepactuado: pRow.saldo_devedor,
          operador: operadorEmail,
          detalhes: detalhesAcordo,
          acordo: {
            tipo: tipoAjusteUnificacao === "troca_menor_valor" ? "TROCA_PRODUTO_MENOR_VALOR" : "REPACTUACAO_BAIXA",
            parcelasQtd: qtdParcelasUnificacao,
            saldoTotalAnterior: saldoAnteriorDevedor,
            novoOculos: tipoAjusteUnificacao === "troca_menor_valor" ? valorNovoOculosNum : undefined,
            jaPagoAbatido: tipoAjusteUnificacao === "troca_menor_valor" ? valorJaPagoAbaterNum : undefined,
            abatimento: valorAbatimentoManualNum > 0 ? valorAbatimentoManualNum : undefined,
            novaCompra: valorNovaCompraNum,
            entrada: valorEntradaUnificacaoNum,
            novoSaldo: saldoFinalAParcelar,
            primeiroVencimento: vencimentoUnificacao,
            titulosEnvolvidos: titulosAntigosIds,
            observacoes: obsUnificacao.trim() || undefined,
          },
        });

        const { error: errUpd } = await supabase
          .from("promissorias")
          .update({
            valor_pago: pRow.divida_total,
            origem: JSON.stringify(logsArray),
          })
          .eq("id", pRow.id);

        if (errUpd) throw new Error(`Erro ao baixar parcela #${pRow.id}: ${errUpd.message}`);

        // NOTA DE AUDITORIA: Não insere em promissoria_pagamentos porque não houve entrada física de dinheiro no caixa (é novação/troca contábil).
        try {
          // Remove qualquer lançamento de pagamento indevido prévio desta promissória baixada por repactuação
          await supabase
            .from("promissoria_pagamentos")
            .delete()
            .eq("promissoria_id", pRow.id)
            .ilike("detalhes", "%Troca por produto%");
        } catch (_) {}
      }

      // 1.1 Parcelas do mesmo carnê/compra que já estavam quitadas anteriormente:
      // Como o carnê foi repactuado e seu valor já pago foi abatido no novo carnê, essas parcelas anteriores
      // também são marcadas como repactuadas contábilmente para manter a coerência histórica total do carnê.
      const parcelasQuitadasMesmoCarne: Row[] = [];
      if (compraDoRow && Array.isArray(compraDoRow.promissorias)) {
        for (const p of compraDoRow.promissorias) {
          if (!parcelasParaUnificar.some(u => u.id === p.id) && !ehRepactuada(p)) {
            parcelasQuitadasMesmoCarne.push(p);
          }
        }
      } else if (parcelasCarne && parcelasCarne.length > 0) {
        for (const p of parcelasCarne) {
          if (!parcelasParaUnificar.some(u => u.id === p.id) && !ehRepactuada(p)) {
            parcelasQuitadasMesmoCarne.push(p);
          }
        }
      }

      for (const pQuitada of parcelasQuitadasMesmoCarne) {
        let logsArray: any[] = [];
        if (pQuitada.origem) {
          try {
            const parsed = JSON.parse(pQuitada.origem);
            if (Array.isArray(parsed)) logsArray = parsed;
            else logsArray.push({ origemOriginal: pQuitada.origem });
          } catch (_) {
            logsArray.push({ origemOriginal: pQuitada.origem });
          }
        }
        logsArray.push({
          data: agoraIso,
          valor: 0,
          saldoRepactuado: 0,
          operador: operadorEmail,
          detalhes: tipoAjusteUnificacao === "troca_menor_valor"
            ? `Parcela quitada anteriormente (${money(pQuitada.valor_pago)}), repactuada e abatida no novo carnê por motivo de troca por produto de menor valor em ${qtdParcelasUnificacao}x.`
            : `Parcela quitada anteriormente, repactuada contabilmente na unificação/reparcelamento do carnê em ${qtdParcelasUnificacao}x.`,
          acordo: {
            tipo: tipoAjusteUnificacao === "troca_menor_valor" ? "TROCA_PRODUTO_MENOR_VALOR" : "REPACTUACAO_BAIXA",
            subtipo: "PARCELA_QUITADA_REPACTUADA",
            parcelasQtd: qtdParcelasUnificacao,
            saldoTotalAnterior: saldoAnteriorDevedor,
            novoOculos: tipoAjusteUnificacao === "troca_menor_valor" ? valorNovoOculosNum : undefined,
            jaPagoAbatido: tipoAjusteUnificacao === "troca_menor_valor" ? valorJaPagoAbaterNum : undefined,
            novoSaldo: saldoFinalAParcelar,
            titulosEnvolvidos: [...titulosAntigosIds, pQuitada.id],
            observacoes: obsUnificacao.trim() || undefined,
          },
        });

        const { error: errQuitadaUpd } = await supabase
          .from("promissorias")
          .update({
            origem: JSON.stringify(logsArray),
          })
          .eq("id", pQuitada.id);

        if (errQuitadaUpd) {
          console.warn(`Aviso ao atualizar histórico de parcela quitada #${pQuitada.id}:`, errQuitadaUpd.message);
        }
      }

      // 2. Gerar as novas promissórias
      const loteId = tipoAjusteUnificacao === "troca_menor_valor" ? `TROCA_${Date.now()}` : `UNIF_${Date.now()}`;
      const novasPayload = parcelasUnificadasCalculadas.map(item => ({
        cliente_nome: n.trim(),
        telefone: p.trim(),
        divida_total: item.valor,
        valor_pago: 0,
        vencimento: item.vencimento,
        parcelas: item.parcela,
        origem: JSON.stringify([
          {
            data: agoraIso,
            valor: 0,
            operador: operadorEmail,
            detalhes: `Promissória gerada por ${tipoAjusteUnificacao === "troca_menor_valor" ? "troca de produto" : "unificação/reparcelamento"} (${item.parcela}). ${detalhesAcordo}`,
            acordo: {
              tipo: tipoAjusteUnificacao === "troca_menor_valor" ? "NOVA_PARCELA_TROCA_PRODUTO" : "NOVA_PARCELA_REPACTUADA",
              loteId,
              numeroParcela: item.numero,
              totalParcelas: qtdParcelasUnificacao,
              saldoTotalAnterior: saldoAnteriorDevedor,
              novoOculos: tipoAjusteUnificacao === "troca_menor_valor" ? valorNovoOculosNum : undefined,
              jaPagoAbatido: tipoAjusteUnificacao === "troca_menor_valor" ? valorJaPagoAbaterNum : undefined,
              abatimento: valorAbatimentoManualNum > 0 ? valorAbatimentoManualNum : undefined,
              novaCompra: valorNovaCompraNum,
              entrada: valorEntradaUnificacaoNum,
              titulosOriginais: titulosAntigosIds,
              observacoes: obsUnificacao.trim() || undefined,
            },
          },
        ]),
        fundo_perdido: false,
      }));

      const { data: novasGravadas, error: errIns } = await supabase
        .from("promissorias")
        .insert(novasPayload)
        .select("id");

      if (errIns) throw new Error("Erro ao criar novas promissórias: " + errIns.message);

      // 3. Registrar entrada no caixa / promissoria_pagamentos se houver
      if (valorEntradaUnificacaoNum > 0 && novasGravadas && novasGravadas.length > 0) {
        try {
          await supabase.from("promissoria_pagamentos").insert({
            promissoria_id: novasGravadas[0].id,
            valor_pago: valorEntradaUnificacaoNum,
            operador_email: operadorEmail,
            operador_id: operadorId,
            data_pagamento: agoraIso,
            detalhes: `Sinal de Entrada (${money(valorEntradaUnificacaoNum)}) recebido no ato da ${tipoAjusteUnificacao === "troca_menor_valor" ? "troca de produto" : "unificação"} em ${qtdParcelasUnificacao}x.`,
          });
        } catch (_) {}
      }

      setBusy(false);
      alert(
        tipoAjusteUnificacao === "troca_menor_valor"
          ? `✅ Troca por produto de menor valor realizada com sucesso!\n\n` +
            `• ${parcelasParaUnificar.length} parcela(s) antiga(s) baixada(s) por novação/troca.\n` +
            `• Abatimento aplicado do que já foi pago: ${money(valorJaPagoAbaterNum)}.\n` +
            `• ${qtdParcelasUnificacao} nova(s) parcela(s) gerada(s) totalizando ${money(saldoFinalAParcelar)}.\n` +
            `• 1º vencimento: ${dt(vencimentoUnificacao)}.`
          : `✅ Unificação e novo parcelamento realizados com sucesso!\n\n` +
            `• ${parcelasParaUnificar.length} parcela(s) antiga(s) quitada(s) por novação de dívida.\n` +
            `• ${qtdParcelasUnificacao} nova(s) parcela(s) gerada(s).\n` +
            `• Novo saldo total a receber: ${money(saldoFinalAParcelar)}.`
      );
      onSaved();
    } catch (err: any) {
      setBusy(false);
      setErr(err.message || "Erro desconhecido ao processar reparcelamento.");
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (row && modoEdicao === "compra_total") {
      return submitUnificacao();
    }
    if (n.trim().length < 2) return setErr("Informe o nome do cliente.");
    if (!ok) return setErr("Valores devem ser monetários e não negativos.");
    if (isNova && G >= T) return setErr("O valor da entrada não pode ser igual ou maior que o valor total da dívida.");
    if (isNova && parcelasCalculadas.length === 0) return setErr("Informe um valor total válido a parcelar.");
    if (!d) return setErr("Informe a data de vencimento.");

    setBusy(true);
    setErr("");

    if (row) {
      // Edição de promissória existente
      const payload = {
        cliente_nome: n.trim(),
        telefone: p.trim(),
        divida_total: T,
        parcelas: i.trim(),
        valor_pago: G,
        vencimento: d || null,
      };
      const { error } = await supabase.from("promissorias").update(payload).eq("id", row.id);
      if (error) {
        setBusy(false);
        return setErr("Não foi possível salvar: " + error.message);
      }

      // Repercutir novo dia de vencimento em todas as parcelas do carnê (anteriores e posteriores, inclusive quitadas), mantendo meses e anos inalterados
      if (atualizarProximas && infoCarne && d) {
        try {
          const novoDia = parseInt(d.slice(8, 10), 10);
          if (novoDia >= 1 && novoDia <= 31) {
            // Busca sempre no Supabase para garantir a lista completa, atualizada e com os logs de origem preservados
            const { data: todasDoCliente } = await supabase
              .from("promissorias")
              .select("id, parcelas, vencimento, saldo_devedor, divida_total, valor_pago, origem")
              .ilike("cliente_nome", n.trim());

            const listaAlvo = todasDoCliente || parcelasCarne;

            for (const pRow of listaAlvo) {
              if (pRow.id === row.id) continue; // Parcela atual já foi salva acima
              const mP = (pRow.parcelas || "").trim().match(/^(\d+)\/(\d+)$/);
              if (!mP) continue;
              const denomP = parseInt(mP[2], 10);

              // Pertence ao mesmo carnê (mesmo número total de parcelas e valor correspondente à compra)
              if (denomP === infoCarne.denom) {
                const diffValor = Math.min(
                  Math.abs(pRow.divida_total - (row.divida_total || 0)),
                  Math.abs(pRow.divida_total - T)
                );
                if (diffValor <= Math.max(denomP, 500) && pRow.vencimento) {
                  // Mantém o mês e ano originais da parcela e altera somente o dia
                  const novoVenc = ajustarApenasDia(pRow.vencimento, novoDia);

                  if (novoVenc && novoVenc !== pRow.vencimento) {
                    let logsArray: any[] = [];
                    if (pRow.origem) {
                      try {
                        const parsed = JSON.parse(pRow.origem);
                        if (Array.isArray(parsed)) logsArray = parsed;
                      } catch (_) {}
                    }
                    logsArray.push({
                      data: new Date().toISOString(),
                      operador: "alinhamento_dia_carne",
                      detalhes: `Dia de vencimento alinhado: alterado de ${pRow.vencimento} para ${novoVenc} (mantendo o mês/ano original e fixando o dia ${novoDia}).`,
                    });

                    await supabase
                      .from("promissorias")
                      .update({
                        vencimento: novoVenc,
                        origem: JSON.stringify(logsArray),
                      })
                      .eq("id", pRow.id);
                  }
                }
              }
            }
          }
        } catch (e: any) {
          console.warn("Aviso ao repercutir novo dia nas parcelas do carnê:", e);
        }
      }

      setBusy(false);
    } else {
      // Criação de novas promissórias com divisão automática como uma nova compra independente
      const loteId = `COMPRA_${Date.now()}`;
      const payload = parcelasCalculadas.map(item => ({
        cliente_nome: n.trim(),
        telefone: p.trim(),
        divida_total: item.valor,
        parcelas: item.parcela,
        valor_pago: item.pago,
        vencimento: item.vencimento,
        origem: `SISTEMA WEB (${loteId})`,
      }));
      const { error } = await supabase.from("promissorias").insert(payload);
      setBusy(false);
      if (error) return setErr("Não foi possível salvar: " + error.message);
    }

    onSaved();
  }

  return (
    <Painel onClose={onClose} wide={!isNova && modoEdicao === "compra_total"}>
      <form onSubmit={submit} autoComplete="off">
        <h2 style={{ margin: 0 }}>
          {row
            ? modoEdicao === "compra_total"
              ? (tipoAjusteUnificacao === "troca_menor_valor" ? "Troca por Menor Valor / Reparcelamento" : "Unificar / Reparcelar Dívida Total")
              : "Editar promissória"
            : "Nova promissória"}
        </h2>
        <div ref={containerNomeRef} style={{ position: "relative" }}>
          <label>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>Cliente</span>
              {buscandoSugestoes ? (
                <span style={{ fontSize: 11, color: "var(--brand)", fontWeight: 600 }}>
                  🔍 Buscando cliente...
                </span>
              ) : sugestoes.length > 0 && mostrarSugestoes ? (
                <span style={{ fontSize: 11, color: "var(--brand)", fontWeight: 600 }}>
                  ✨ {sugestoes.length} cliente(s) encontrado(s)
                </span>
              ) : null}
            </div>
            <div style={{ position: "relative", width: "100%" }}>
              <input
                ref={inputNomeRef}
                value={n}
                onChange={e => {
                  setN(e.target.value);
                  setMostrarSugestoes(true);
                }}
                onFocus={() => {
                  if (sugestoes.length > 0) setMostrarSugestoes(true);
                }}
                onKeyDown={e => {
                  if (!mostrarSugestoes || sugestoes.length === 0) return;
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSugestaoAtiva(prev => (prev < sugestoes.length - 1 ? prev + 1 : 0));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSugestaoAtiva(prev => (prev > 0 ? prev - 1 : sugestoes.length - 1));
                  } else if (e.key === "Enter") {
                    if (sugestaoAtiva >= 0 && sugestaoAtiva < sugestoes.length) {
                      e.preventDefault();
                      selecionarCliente(sugestoes[sugestaoAtiva]);
                    }
                  } else if (e.key === "Tab") {
                    if (sugestaoAtiva >= 0 && sugestaoAtiva < sugestoes.length) {
                      selecionarCliente(sugestoes[sugestaoAtiva]);
                    } else if (sugestoes.length > 0) {
                      selecionarCliente(sugestoes[0]);
                    }
                  } else if (e.key === "Escape") {
                    setMostrarSugestoes(false);
                  }
                }}
                maxLength={180}
                required
                placeholder="Digite o nome para auto preencher..."
                autoComplete="off"
              />
            </div>
          </label>

          {/* Menu Dropdown de Auto Preenchimento */}
          {mostrarSugestoes && sugestoes.length > 0 && (
            <div
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                right: 0,
                zIndex: 100,
                background: "var(--card)",
                border: "1px solid var(--line)",
                borderRadius: 10,
                boxShadow: "0 12px 30px rgba(0, 0, 0, 0.18)",
                marginTop: 4,
                overflow: "hidden",
                maxHeight: 280,
                overflowY: "auto",
              }}
            >
              <div
                style={{
                  padding: "6px 12px",
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: ".05em",
                  color: "var(--mut)",
                  background: "var(--soft)",
                  borderBottom: "1px solid var(--line)",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <span>Clientes Cadastrados (Clique ou Enter para preencher)</span>
                <span>{sugestoes.length}</span>
              </div>
              {sugestoes.map((sug, idx) => {
                const ativo = idx === sugestaoAtiva;
                return (
                  <div
                    key={sug.nome + idx}
                    onClick={() => selecionarCliente(sug)}
                    onMouseEnter={() => setSugestaoAtiva(idx)}
                    style={{
                      padding: "10px 14px",
                      cursor: "pointer",
                      background: ativo ? "var(--soft)" : "transparent",
                      borderBottom: "1px solid var(--line)",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 10,
                      transition: "background 0.12s ease",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 13.5, color: "var(--ink)", display: "flex", alignItems: "center", gap: 6 }}>
                        <span>👤</span>
                        <span style={{ textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>
                          {sug.nome}
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: 8, fontSize: 11.5, color: "var(--mut)", marginTop: 3, alignItems: "center", flexWrap: "wrap" }}>
                        {sug.telefone ? (
                          <span className="mono" style={{ color: "var(--brand)", fontWeight: 600 }}>
                            📞 {mascaraTelefone(sug.telefone)}
                          </span>
                        ) : (
                          <span>Sem telefone</span>
                        )}
                        <span>·</span>
                        <span>{sug.totalCompras} compra{sug.totalCompras !== 1 ? "s" : ""}</span>
                        {sug.saldoAberto > 0 && (
                          <>
                            <span>·</span>
                            <span style={{ color: sug.temAtraso ? "var(--bad)" : "var(--warn)", fontWeight: 600 }}>
                              Saldo: {money(sug.saldoAberto)}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    {sug.scoreInfo && (
                      <span
                        style={{
                          fontSize: 10.5,
                          fontWeight: 700,
                          padding: "2px 8px",
                          borderRadius: 99,
                          background: sug.scoreInfo.bgCor,
                          color: sug.scoreInfo.cor,
                          border: `1px solid ${sug.scoreInfo.cor}40`,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {sug.scoreInfo.selo}
                      </span>
                    )}
                  </div>
                );
              })}
              <div
                style={{
                  padding: "6px 12px",
                  fontSize: 11,
                  color: "var(--mut)",
                  background: "var(--soft)",
                  textAlign: "center",
                }}
              >
                💡 Dica: Use <b>↑ ↓</b> para navegar e <b>Enter</b> ou <b>Tab</b> para auto preencher
              </div>
            </div>
          )}
        </div>

        {scoreCliente && (
          <div
            style={{
              padding: "8px 12px",
              borderRadius: 8,
              background: scoreCliente.bgCor,
              border: `1px solid ${scoreCliente.cor}40`,
              fontSize: 12,
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <b style={{ color: scoreCliente.cor }}>Score LeoÓticas: {scoreCliente.selo}</b>
              <span style={{ fontSize: 11, color: "var(--mut)" }}>{scoreCliente.totalTitulos} compra(s) anteriores</span>
            </div>
            <div style={{ color: "var(--ink)", fontWeight: 500 }}>
              {scoreCliente.recomendacaoVenda}
            </div>
          </div>
        )}

        <div>
          <label>
            Telefone
            <input
              ref={inputTelRef}
              value={p}
              onChange={e => setP(mascaraTelefone(e.target.value))}
              inputMode="tel"
              maxLength={40}
              placeholder="(61) 99999-9999"
            />
          </label>
          {sugestaoPorTelefone && (
            <div
              style={{
                marginTop: 6,
                padding: "8px 12px",
                borderRadius: 8,
                background: "rgba(15, 118, 110, 0.08)",
                border: "1px solid var(--brand)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
              }}
            >
              <div>
                <span>💡 Cliente cadastrado com este telefone: </span>
                <b style={{ color: "var(--brand)" }}>{sugestaoPorTelefone.nome}</b>
              </div>
              <button
                type="button"
                className="btn"
                style={{ padding: "3px 8px", fontSize: 11, borderRadius: 6 }}
                onClick={() => {
                  setN(sugestaoPorTelefone.nome);
                  setSugestaoPorTelefone(null);
                  inputValorRef.current?.focus();
                }}
              >
                ⚡ Auto preencher
              </button>
            </div>
          )}
        </div>

        {/* Se for edição de promissória existente, oferece abas para editar parcela pontual ou unificar dívida total */}
        {!isNova && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, margin: "14px 0 16px 0" }}>
            <button
              type="button"
              className={`btn ghost ${modoEdicao === "parcela" ? "on" : ""}`}
              onClick={() => setModoEdicao("parcela")}
              style={{
                padding: "9px 12px",
                fontSize: 12.5,
                fontWeight: 700,
                borderRadius: 8,
                borderColor: modoEdicao === "parcela" ? "var(--brand)" : "var(--line)",
                background: modoEdicao === "parcela" ? "var(--soft)" : "transparent",
                color: modoEdicao === "parcela" ? "var(--brand)" : "var(--ink)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
              }}
            >
              <span>📝</span>
              <span>Editar Parcela Pontual ({row.parcelas})</span>
            </button>

            <button
              type="button"
              className={`btn ghost ${modoEdicao === "compra_total" ? "on" : ""}`}
              onClick={() => setModoEdicao("compra_total")}
              style={{
                padding: "9px 12px",
                fontSize: 12.5,
                fontWeight: 700,
                borderRadius: 8,
                borderColor: modoEdicao === "compra_total" ? "var(--brand)" : "var(--line)",
                background: modoEdicao === "compra_total" ? "rgba(15, 118, 110, 0.12)" : "transparent",
                color: modoEdicao === "compra_total" ? "var(--brand)" : "var(--ink)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
              }}
            >
              <span>🔀</span>
              <span>Reparcelar / Unificar Dívida Total</span>
            </button>
          </div>
        )}

        {isNova ? (
          <>
            <div className="r2">
              <label>
                Valor total da dívida (R$)
                <input
                  ref={inputValorRef}
                  value={t}
                  onChange={e => setT(formatarMascaraMoeda(e.target.value, true))}
                  inputMode="numeric"
                  placeholder="R$ 0,00"
                  required
                />
              </label>
              <label>
                Número de promissórias
                <select
                  value={qtd}
                  onChange={e => {
                    const q = Number(e.target.value);
                    setQtd(q);
                    setI(q === 1 ? "1X" : `${q}X`);
                  }}
                >
                  {Array.from({ length: 12 }, (_, idx) => idx + 1).map(num => (
                    <option key={num} value={num}>
                      {num === 1 ? "1x (Parcela única)" : `${num}x`}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="r2">
              <label>
                1º Vencimento
                <input type="date" value={d} onChange={e => setD(e.target.value)} required />
              </label>
              <label>
                Valor já pago / Entrada (R$)
                <input
                  value={g}
                  onChange={e => setG(formatarMascaraMoeda(e.target.value, true))}
                  inputMode="numeric"
                  placeholder="R$ 0,00"
                />
              </label>
            </div>

            {/* Aviso caso a entrada cubra ou ultrapasse a dívida */}
            {ok && T > 0 && G >= T && (
              <div style={{ background: "rgba(239, 68, 68, 0.1)", color: "#b91c1c", padding: "8px 12px", borderRadius: 8, fontSize: 12, marginTop: 6, fontWeight: 500 }}>
                A entrada ({money(G)}) é igual ou superior ao valor total ({money(T)}). Nenhuma promissória a parcelar.
              </div>
            )}

            {/* Pré-visualização de todas as promissórias calculadas */}
            {parcelasCalculadas.length > 0 && (
              <div
                style={{
                  background: "var(--soft)",
                  borderRadius: 10,
                  padding: "12px 14px",
                  border: "1px solid var(--line)",
                  marginTop: 6,
                  maxHeight: 220,
                  overflowY: "auto",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: G > 0 ? 4 : 8, fontSize: 12, fontWeight: 700, color: "var(--mut)" }}>
                  <span>PROMISSÓRIAS CALCULADAS ({qtd}x)</span>
                  <span>VENCIMENTO MENSAL (MESMO DIA)</span>
                </div>
                {G > 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 11, color: "var(--mut)", background: "rgba(0,0,0,0.03)", padding: "4px 8px", borderRadius: 6 }}>
                    <span>Entrada: <strong style={{ color: "var(--fg)" }}>{money(G)}</strong></span>
                    <span>Saldo a parcelar: <strong className="mono" style={{ color: "var(--fg)" }}>{money(saldoAParcelar)}</strong></span>
                  </div>
                )}
                <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse", minWidth: 0 }}>
                  <thead>
                    <tr style={{ color: "var(--mut)", fontSize: 11, borderBottom: "1px solid var(--line)" }}>
                      <th style={{ textAlign: "left", padding: "4px 0" }}>PARCELA</th>
                      <th style={{ textAlign: "right", padding: "4px 0" }}>VALOR</th>
                      <th style={{ textAlign: "right", padding: "4px 0" }}>VENCIMENTO</th>
                      <th style={{ textAlign: "right", padding: "4px 0" }}>STATUS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parcelasCalculadas.map(item => {
                      const stItem = derive(item.valor, item.pago, item.vencimento);
                      return (
                        <tr key={item.numero} style={{ borderTop: "1px solid var(--line)" }}>
                          <td style={{ padding: "6px 0", fontWeight: 600 }}>{item.parcela}</td>
                          <td style={{ padding: "6px 0", textAlign: "right" }} className="mono">{money(item.valor)}</td>
                          <td style={{ padding: "6px 0", textAlign: "right" }} className="mono">{dt(item.vencimento)}</td>
                          <td style={{ padding: "6px 0", textAlign: "right" }}>
                            <span className={`pill p-${cls(stItem)}`} style={{ fontSize: 11, padding: "2px 8px" }}>
                              {LBL[stItem]}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : modoEdicao === "compra_total" ? (
          /* MODO: REPARCELAR / UNIFICAR DÍVIDA TOTAL */
          <div style={{ display: "grid", gap: 14 }}>
            {/* Bloco 1: Seleção de Compras / Parcelas em Aberto a Unificar */}
            <div
              style={{
                background: "var(--soft)",
                borderRadius: 10,
                padding: "12px 14px",
                border: "1px solid var(--line)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
                <span style={{ fontWeight: 700, fontSize: 13, color: "var(--ink)", display: "flex", alignItems: "center", gap: 6 }}>
                  <span>📦</span> Parcelas em aberto selecionadas para unificação:
                </span>
                <span style={{ fontWeight: 800, fontSize: 14, color: "var(--brand)" }}>
                  Saldo: {money(saldoAnteriorDevedor)}
                </span>
              </div>

              {/* Seletor de Escopo de Unificação */}
              <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className={`chip ${escopoUnificacao === "carne" ? "on" : ""}`}
                  onClick={() => setEscopoUnificacao("carne")}
                  style={{
                    padding: "4px 10px",
                    fontSize: 11.5,
                    fontWeight: 600,
                    background: escopoUnificacao === "carne" ? "var(--brand)" : "var(--card)",
                    color: escopoUnificacao === "carne" ? "#fff" : "var(--ink)",
                    borderColor: escopoUnificacao === "carne" ? "var(--brand)" : "var(--line)",
                  }}
                >
                  Apenas parcelas deste carnê ({compraDoRow?.rotuloParcelas || row?.parcelas})
                </button>

                {comprasCliente.length > 1 && (
                  <button
                    type="button"
                    className={`chip ${escopoUnificacao === "todas_abertas" ? "on" : ""}`}
                    onClick={() => setEscopoUnificacao("todas_abertas")}
                    style={{
                      padding: "4px 10px",
                      fontSize: 11.5,
                      fontWeight: 600,
                      background: escopoUnificacao === "todas_abertas" ? "var(--brand)" : "var(--card)",
                      color: escopoUnificacao === "todas_abertas" ? "#fff" : "var(--ink)",
                      borderColor: escopoUnificacao === "todas_abertas" ? "var(--brand)" : "var(--line)",
                    }}
                  >
                    Unificar todas as compras em aberto ({todasParcelasAbertasCliente.length} parcelas)
                  </button>
                )}
              </div>

              {/* Lista com chips das parcelas incluídas */}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", maxHeight: 110, overflowY: "auto" }}>
                {(escopoUnificacao === "carne" ? parcelasAbertasDestaCompra : todasParcelasAbertasCliente).map(pItem => {
                  const sel = idsParcelasSelecionadas.includes(pItem.id);
                  return (
                    <label
                      key={pItem.id}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "3px 8px",
                        borderRadius: 6,
                        border: "1px solid",
                        borderColor: sel ? "var(--brand)" : "var(--line)",
                        background: sel ? "rgba(15, 118, 110, 0.1)" : "var(--card)",
                        fontSize: 11.5,
                        cursor: "pointer",
                        margin: 0,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={sel}
                        onChange={e => {
                          if (e.target.checked) {
                            setIdsParcelasSelecionadas(prev => [...prev, pItem.id]);
                          } else {
                            setIdsParcelasSelecionadas(prev => prev.filter(x => x !== pItem.id));
                          }
                        }}
                        style={{ width: 14, height: 14, accentColor: "var(--brand)" }}
                      />
                      <span><b>{pItem.parcelas}</b>: {money(pItem.saldo_devedor)} <span style={{ color: "var(--mut)", fontSize: 10.5 }}>({dt(pItem.vencimento)})</span></span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Seletor de Tipo de Operação: Unificação/Ajuste Padrão vs Troca por Menor Valor */}
            <div style={{ display: "flex", gap: 8, background: "var(--soft)", padding: 4, borderRadius: 8, border: "1px solid var(--line)" }}>
              <button
                type="button"
                onClick={() => setTipoAjusteUnificacao("padrao")}
                style={{
                  flex: 1,
                  padding: "7px 10px",
                  fontSize: 12,
                  fontWeight: 700,
                  borderRadius: 6,
                  border: tipoAjusteUnificacao === "padrao" ? "1px solid var(--brand)" : "1px solid transparent",
                  background: tipoAjusteUnificacao === "padrao" ? "var(--card)" : "transparent",
                  color: tipoAjusteUnificacao === "padrao" ? "var(--brand)" : "var(--mut)",
                  boxShadow: tipoAjusteUnificacao === "padrao" ? "0 2px 4px rgba(0,0,0,0.06)" : "none",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                }}
              >
                <span>⚖️</span>
                <span>Unificação Padrão / Ajustar Saldo</span>
              </button>

              <button
                type="button"
                onClick={() => setTipoAjusteUnificacao("troca_menor_valor")}
                style={{
                  flex: 1,
                  padding: "7px 10px",
                  fontSize: 12,
                  fontWeight: 700,
                  borderRadius: 6,
                  border: tipoAjusteUnificacao === "troca_menor_valor" ? "1px solid #0284c7" : "1px solid transparent",
                  background: tipoAjusteUnificacao === "troca_menor_valor" ? "var(--card)" : "transparent",
                  color: tipoAjusteUnificacao === "troca_menor_valor" ? "#0284c7" : "var(--mut)",
                  boxShadow: tipoAjusteUnificacao === "troca_menor_valor" ? "0 2px 4px rgba(0,0,0,0.06)" : "none",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                }}
              >
                <span>🔄</span>
                <span>Troca por Produto de Menor Valor</span>
              </button>
            </div>

            {/* Bloco 2: Inputs conforme o tipo selecionado */}
            {tipoAjusteUnificacao === "troca_menor_valor" ? (
              <div
                style={{
                  background: "rgba(2, 132, 199, 0.05)",
                  border: "1.5px solid rgba(2, 132, 199, 0.35)",
                  borderRadius: 10,
                  padding: "12px 14px",
                  display: "grid",
                  gap: 10,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: "#0369a1", display: "flex", alignItems: "center", gap: 6 }}>
                    <span>👓</span>
                    <span>Troca de Produto: Abater o já pago e reparcelar o novo produto</span>
                  </div>
                  {valorPagoDetectadoCompra > 0 && (
                    <span style={{ fontSize: 11, background: "rgba(21, 128, 61, 0.12)", color: "#15803d", padding: "2px 8px", borderRadius: 6, fontWeight: 700 }}>
                      ✓ Já pago identificado: {money(valorPagoDetectadoCompra)}
                    </span>
                  )}
                </div>

                <div className="r2">
                  <label>
                    <span style={{ color: "var(--ink)", fontWeight: 700 }}>Valor do NOVO produto (R$) *</span>
                    <input
                      value={valorNovoOculos}
                      onChange={e => setValorNovoOculos(formatarMascaraMoeda(e.target.value, true))}
                      inputMode="numeric"
                      placeholder="R$ 0,00"
                      style={{ borderColor: "#0284c7", fontWeight: 700, fontSize: 14 }}
                      autoFocus
                    />
                    <span className="sub" style={{ fontSize: 10.5 }}>Preço de venda do produto de menor valor.</span>
                  </label>

                  <label>
                    <span style={{ color: "var(--ink)", fontWeight: 700 }}>Valor já pago a abater (R$)</span>
                    <input
                      value={valorJaPagoAbater}
                      onChange={e => setValorJaPagoAbater(formatarMascaraMoeda(e.target.value, true))}
                      inputMode="numeric"
                      placeholder="R$ 0,00"
                    />
                    <span className="sub" style={{ fontSize: 10.5 }}>Valor das parcelas já pagas a descontar do novo produto.</span>
                  </label>
                </div>

                <label>
                  Valor pago de entrada / sinal no ato da troca (R$)
                  <input
                    value={entradaUnificacao}
                    onChange={e => setEntradaUnificacao(formatarMascaraMoeda(e.target.value, true))}
                    inputMode="numeric"
                    placeholder="R$ 0,00 (Opcional)"
                  />
                  <span className="sub" style={{ fontSize: 10.5 }}>Se o cliente pagar algum sinal adicional em dinheiro ou Pix hoje.</span>
                </label>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
                <label>
                  Adicionar nova compra (R$)
                  <input
                    value={novaCompra}
                    onChange={e => setNovaCompra(formatarMascaraMoeda(e.target.value, true))}
                    inputMode="numeric"
                    placeholder="R$ 0,00 (Opcional)"
                  />
                  <span className="sub" style={{ fontSize: 10.5 }}>Aumentar dívida (produtos novos).</span>
                </label>

                <label>
                  Abatimento / Desconto (R$)
                  <input
                    value={abatimentoManual}
                    onChange={e => setAbatimentoManual(formatarMascaraMoeda(e.target.value, true))}
                    inputMode="numeric"
                    placeholder="R$ 0,00 (Opcional)"
                  />
                  <span className="sub" style={{ fontSize: 10.5 }}>Diminuir valor da dívida.</span>
                </label>

                <label>
                  Entrada / Sinal (R$)
                  <input
                    value={entradaUnificacao}
                    onChange={e => setEntradaUnificacao(formatarMascaraMoeda(e.target.value, true))}
                    inputMode="numeric"
                    placeholder="R$ 0,00 (Opcional)"
                  />
                  <span className="sub" style={{ fontSize: 10.5 }}>Recebido no ato (dinheiro/Pix).</span>
                </label>
              </div>
            )}

            {/* Bloco 3: Card de Resumo da Nova Dívida Total */}
            {tipoAjusteUnificacao === "troca_menor_valor" ? (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                  gap: 10,
                  padding: "10px 14px",
                  borderRadius: 10,
                  background: "var(--card)",
                  border: "1.5px solid #0284c7",
                }}
              >
                <div>
                  <div style={{ fontSize: 11, color: "var(--mut)", textTransform: "uppercase" }}>Novo Produto</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>{money(valorNovoOculosNum)}</div>
                </div>

                <div>
                  <div style={{ fontSize: 11, color: "#16a34a", textTransform: "uppercase" }}>- Já Pago Abatido</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#16a34a" }}>- {money(valorJaPagoAbaterNum)}</div>
                </div>

                {valorEntradaUnificacaoNum > 0 && (
                  <div>
                    <div style={{ fontSize: 11, color: "#16a34a", textTransform: "uppercase" }}>- Entrada no Ato</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#16a34a" }}>- {money(valorEntradaUnificacaoNum)}</div>
                  </div>
                )}

                <div style={{ borderLeft: "2px solid var(--line)", paddingLeft: 10 }}>
                  <div style={{ fontSize: 11, color: "#0284c7", fontWeight: 700, textTransform: "uppercase" }}>SALDO A REPARCELAR</div>
                  <div style={{ fontSize: 17, fontWeight: 900, color: "#0284c7" }}>{money(saldoFinalAParcelar)}</div>
                </div>
              </div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
                  gap: 10,
                  padding: "10px 14px",
                  borderRadius: 10,
                  background: "var(--card)",
                  border: "1.5px solid var(--line)",
                }}
              >
                <div>
                  <div style={{ fontSize: 11, color: "var(--mut)", textTransform: "uppercase" }}>Saldo Anterior</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>{money(saldoAnteriorDevedor)}</div>
                </div>

                {valorNovaCompraNum > 0 && (
                  <div>
                    <div style={{ fontSize: 11, color: "var(--brand)", textTransform: "uppercase" }}>+ Nova Compra</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "var(--brand)" }}>+ {money(valorNovaCompraNum)}</div>
                  </div>
                )}

                {valorAbatimentoManualNum > 0 && (
                  <div>
                    <div style={{ fontSize: 11, color: "#dc2626", textTransform: "uppercase" }}>- Abatimento</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#dc2626" }}>- {money(valorAbatimentoManualNum)}</div>
                  </div>
                )}

                {valorEntradaUnificacaoNum > 0 && (
                  <div>
                    <div style={{ fontSize: 11, color: "#16a34a", textTransform: "uppercase" }}>- Entrada</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#16a34a" }}>- {money(valorEntradaUnificacaoNum)}</div>
                  </div>
                )}

                <div style={{ borderLeft: "2px solid var(--line)", paddingLeft: 10 }}>
                  <div style={{ fontSize: 11, color: "var(--brand)", fontWeight: 700, textTransform: "uppercase" }}>TOTAL A REPARCELAR</div>
                  <div style={{ fontSize: 17, fontWeight: 900, color: "var(--brand)" }}>{money(saldoFinalAParcelar)}</div>
                </div>
              </div>
            )}

            {/* Aviso se o cliente tiver crédito/troco a favor */}
            {creditoClienteTroca > 0 && (
              <div
                style={{
                  background: "rgba(234, 179, 8, 0.12)",
                  border: "1.5px solid #eab308",
                  color: "#854d0e",
                  padding: "10px 14px",
                  borderRadius: 8,
                  fontSize: 12.5,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span>⚠️</span>
                <div>
                  <b>Atenção:</b> O valor já pago ({money(valorJaPagoAbaterNum)}) é maior que o valor do novo produto ({money(valorNovoOculosNum)}). O cliente quitou integralmente o novo produto e possui um <b>crédito/troco de {money(creditoClienteTroca)}</b> a ser devolvido ou utilizado na loja.
                </div>
              </div>
            )}

            {/* Bloco 4: Novo Parcelamento (Qtd e 1º Vencimento) */}
            <div className="r2">
              <label>
                Novo número de parcelas
                <select
                  value={qtdParcelasUnificacao}
                  onChange={e => setQtdParcelasUnificacao(Number(e.target.value))}
                >
                  {Array.from({ length: 12 }, (_, idx) => idx + 1).map(num => (
                    <option key={num} value={num}>
                      {num === 1 ? "1x (Parcela única)" : `${num}x`}
                    </option>
                  ))}
                  <option value={15}>15x</option>
                  <option value={18}>18x</option>
                  <option value={24}>24x</option>
                </select>
              </label>

              <label>
                1º Novo Vencimento
                <input
                  type="date"
                  value={vencimentoUnificacao}
                  onChange={e => setVencimentoUnificacao(e.target.value)}
                  required
                />
              </label>
            </div>

            {/* Bloco 5: Prévia do Novo Carnê Unificado */}
            {parcelasUnificadasCalculadas.length > 0 && (
              <div
                style={{
                  background: "var(--soft)",
                  borderRadius: 10,
                  padding: "10px 14px",
                  border: "1px solid var(--line)",
                  maxHeight: 180,
                  overflowY: "auto",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 11.5, fontWeight: 700, color: "var(--mut)" }}>
                  <span>NOVO CARNÊ REPARCELADO ({qtdParcelasUnificacao}X)</span>
                  <span>VENCIMENTO MENSAL NO DIA {vencimentoUnificacao.slice(8, 10)}</span>
                </div>
                <table style={{ width: "100%", fontSize: 12.5, borderCollapse: "collapse", minWidth: 0 }}>
                  <thead>
                    <tr style={{ color: "var(--mut)", fontSize: 11, borderBottom: "1px solid var(--line)" }}>
                      <th style={{ textAlign: "left", padding: "4px 0" }}>PARCELA</th>
                      <th style={{ textAlign: "right", padding: "4px 0" }}>VALOR</th>
                      <th style={{ textAlign: "right", padding: "4px 0" }}>VENCIMENTO</th>
                      <th style={{ textAlign: "right", padding: "4px 0" }}>STATUS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parcelasUnificadasCalculadas.map(item => (
                      <tr key={item.numero} style={{ borderTop: "1px solid var(--line)" }}>
                        <td style={{ padding: "5px 0", fontWeight: 600 }}>{item.parcela}</td>
                        <td style={{ padding: "5px 0", textAlign: "right" }} className="mono">{money(item.valor)}</td>
                        <td style={{ padding: "5px 0", textAlign: "right" }} className="mono">{dt(item.vencimento)}</td>
                        <td style={{ padding: "5px 0", textAlign: "right" }}>
                          <span className="pill p-vencendo" style={{ fontSize: 10.5, padding: "1px 6px" }}>
                            A vencer
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Bloco 6: Observações da Unificação */}
            <div>
              <label>
                Motivo / Observações do Acordo (opcional)
                <input
                  value={obsUnificacao}
                  onChange={e => setObsUnificacao(e.target.value)}
                  placeholder={
                    tipoAjusteUnificacao === "troca_menor_valor"
                      ? "ex.: Cliente trocou por produto de menor valor, saldo recalculado abatendo o já pago"
                      : "ex.: Cliente comprou nova armação e solicitou unificação do parcelamento"
                  }
                  maxLength={250}
                />
              </label>
            </div>
          </div>
        ) : (
          /* MODO: EDITAR PARCELA PONTUAL */
          <>
            <div className="r2">
              <label>Dívida desta parcela (R$)<input value={t} onChange={e => setT(formatarMascaraMoeda(e.target.value, true))} inputMode="numeric" placeholder="R$ 0,00" required /></label>
              <label>Valor pago (R$)<input value={g} onChange={e => setG(formatarMascaraMoeda(e.target.value, true))} inputMode="numeric" placeholder="R$ 0,00" /></label>
            </div>
            <div className="r2">
              <label>Parcelas<input value={i} onChange={e => setI(e.target.value)} maxLength={40} placeholder="ex.: 1/3" /></label>
              <label>Vencimento<input type="date" value={d} onChange={e => setD(e.target.value)} /></label>
            </div>
            <div className="prev">
              <span>Saldo <b className="mono">{ok ? money(Math.max(T - G, 0)) : "—"}</b></span>
              {st && !row?.fundo_perdido && <span className={`pill p-${cls(st)}`}>{LBL[st]}</span>}
            </div>

            {infoCarne && d && (
              <div
                style={{
                  marginTop: 10,
                  padding: "10px 14px",
                  borderRadius: 10,
                  background: atualizarProximas ? "rgba(15, 118, 110, 0.08)" : "var(--soft)",
                  border: atualizarProximas ? "1px solid var(--brand)" : "1px solid var(--line)",
                  transition: "all .15s ease",
                }}
              >
                <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={atualizarProximas}
                    onChange={e => setAtualizarProximas(e.target.checked)}
                    style={{ marginTop: 2, accentColor: "var(--brand)", width: 17, height: 17 }}
                  />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13, color: "var(--ink)" }}>
                      🗓️ Repercutir novo dia de vencimento (dia {d.slice(8, 10)}) em todas as parcelas deste carnê
                    </div>
                    <div className="sub" style={{ fontSize: 11.5, marginTop: 2 }}>
                      Altera somente o dia para <b>{d.slice(8, 10)}</b> em todas as parcelas (inclusive já quitadas), mantendo os meses e anos já cadastrados sem alteração.
                    </div>
                  </div>
                </label>

                {atualizarProximas && (
                  <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px dashed var(--line)", fontSize: 11.5 }}>
                    <span style={{ fontWeight: 600, color: "var(--brand)" }}>
                      Prévia das parcelas mantendo os meses cadastrados (com vencimento no dia {d.slice(8, 10)}):
                    </span>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                      {(parcelasCarne.length > 0 ? parcelasCarne : [row]).map(pItem => {
                        const vencBase = pItem.id === row.id ? d : pItem.vencimento;
                        const novoVenc = ajustarApenasDia(vencBase, parseInt(d.slice(8, 10), 10));
                        const quitada = (pItem.saldo_devedor ?? 0) <= 0;
                        return (
                          <span
                            key={pItem.id}
                            className="pill"
                            style={{
                              fontSize: 11,
                              background: pItem.id === row.id
                                ? "rgba(15, 118, 110, 0.15)"
                                : quitada
                                ? "rgba(21, 128, 61, 0.1)"
                                : "var(--card)",
                              borderColor: pItem.id === row.id ? "var(--brand)" : "var(--line)",
                              color: quitada ? "#15803d" : "inherit",
                            }}
                          >
                            <b>{pItem.parcelas}</b>: {dt(novoVenc)} {quitada ? "✓ (Quitada)" : ""} {pItem.id === row.id ? "★ (Atual)" : ""}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        <div className="err">{err}</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginTop: 4 }}>
          {!isNova ? (
            modoEdicao === "compra_total" ? (
              <div style={{ fontSize: 12, color: "var(--mut)" }}>
                💡 As parcelas antigas em aberto serão baixadas com registro de novação.
              </div>
            ) : (
              <button
                type="button"
                className="btn ghost"
                style={{ color: "var(--bad)", borderColor: "var(--bad)", padding: "8px 12px", fontSize: 13 }}
                onClick={handleDelete}
                disabled={busy}
                title="Excluir promissória permanentemente"
              >
                Excluir promissória
              </button>
            )
          ) : <div />}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn ghost" onClick={onClose}>Cancelar</button>
            <button className="btn" disabled={busy}>
              {busy
                ? "Processando…"
                : !isNova && modoEdicao === "compra_total"
                ? (tipoAjusteUnificacao === "troca_menor_valor"
                    ? `Confirmar Troca e Reparcelar (${qtdParcelasUnificacao}x)`
                    : `Confirmar e Reparcelar (${qtdParcelasUnificacao}x)`)
                : isNova && qtd > 1
                ? `Salvar (${qtd} promissórias)`
                : "Salvar"}
            </button>
          </div>
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
  const [baixa, setBaixa] = useState<Row | null>(null);
  const [logRow, setLogRow] = useState<Row | null>(null);
  const [editing, setEditing] = useState<Row | undefined>(undefined);
  const [perdido, setPerdido] = useState<Row | null>(null);
  const [desmembrarRow, setDesmembrarRow] = useState<Row | null>(null);
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
  const comprasCliente = useMemo(() => separarComprasCliente(rows), [rows]);
  const comprasAbertas = useMemo(() => comprasCliente.filter(c => c.emAberto), [comprasCliente]);
  const comprasQuitadas = useMemo(() => comprasCliente.filter(c => !c.emAberto), [comprasCliente]);

  const [filtroAba, setFiltroAba] = useState<"compra_ativa" | "quitadas" | "todas">("compra_ativa");
  const [compraIdSelecionada, setCompraIdSelecionada] = useState<string>("");

  useEffect(() => {
    if (comprasAbertas.length > 0) {
      if (!compraIdSelecionada || !comprasCliente.some(c => c.id === compraIdSelecionada)) {
        setCompraIdSelecionada(comprasAbertas[0].id);
      }
    } else if (comprasCliente.length > 0 && !compraIdSelecionada) {
      setCompraIdSelecionada(comprasCliente[0].id);
    }
  }, [comprasCliente, comprasAbertas, compraIdSelecionada]);

  const compraAtiva = useMemo<CompraGrupo | null>(() => {
    return comprasCliente.find(c => c.id === compraIdSelecionada) || comprasAbertas[0] || comprasCliente[0] || null;
  }, [comprasCliente, comprasAbertas, compraIdSelecionada]);

  const promissoriasOutras = useMemo(() => {
    if (!compraAtiva) return [];
    return rows.filter(r => !compraAtiva.promissorias.some(p => p.id === r.id));
  }, [rows, compraAtiva]);

  const totalOutrasQuitadas = useMemo(() => {
    return promissoriasOutras.filter(r => !r.fundo_perdido && !ehRepactuada(r) && (r.saldo_devedor ?? 0) <= 0).reduce((s, r) => s + (r.divida_total ?? 0), 0);
  }, [promissoriasOutras]);

  const totalOutrasRepactuadas = useMemo(() => {
    return promissoriasOutras.filter(r => !r.fundo_perdido && ehRepactuada(r) && (r.saldo_devedor ?? 0) <= 0).reduce((s, r) => s + (r.divida_total ?? 0), 0);
  }, [promissoriasOutras]);

  const rowsFiltradas = useMemo(() => {
    if (filtroAba === "compra_ativa" && compraAtiva) {
      return compraAtiva.promissorias;
    }
    if (filtroAba === "quitadas") {
      const qRows = comprasQuitadas.flatMap(c => c.promissorias);
      return qRows.length > 0 ? qRows : promissoriasOutras;
    }
    return rows;
  }, [filtroAba, compraAtiva, comprasQuitadas, promissoriasOutras, rows]);

  const [sortCol, setSortCol] = useState<string>("vencimento");
  const [sortAsc, setSortAsc] = useState<boolean>(false);

  const sortedRows = useMemo(() => {
    return [...rowsFiltradas].sort((a, b) => {
      let va: any = a[sortCol as keyof Row];
      let vb: any = b[sortCol as keyof Row];
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
  }, [rowsFiltradas, sortCol, sortAsc]);

  const handleSort = (col: string) => {
    if (sortCol === col) {
      setSortAsc(a => !a);
    } else {
      setSortCol(col);
      if (col === "divida_total" || col === "valor_pago" || col === "saldo_devedor") {
        setSortAsc(false);
      } else {
        setSortAsc(true);
      }
    }
  };

  const refresh = () => {
    load();
    onChanged?.();
  };

  const score = useMemo(() => calcularScoreCliente(rows), [rows]);

  return (
    <Painel onClose={onClose} wide>
      <div style={{ padding: 20, display: "grid", gap: 14 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "start", flexWrap: "wrap" }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <h2 style={{ margin: 0 }}>{cliente}</h2>
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
              {comprasAbertas.length > 1 && (
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    padding: "2px 8px",
                    borderRadius: 99,
                    background: "#fef3c7",
                    color: "#b45309",
                    border: "1px solid #fde68a",
                  }}
                  title={`Cliente possui ${comprasAbertas.length} compras/parcelamentos em aberto`}
                >
                  🏷️ {comprasAbertas.length} compras ativas
                </span>
              )}
            </div>
            <div className="sub mono">
              {tel || "Sem telefone"} · <span style={{ color: "var(--ink)", fontWeight: 500 }}>{score.recomendacaoVenda}</span>
            </div>
          </div>
          {abertos.length > 0 && <button className="btn" onClick={() => setWhats(true)}>Cobrar por WhatsApp</button>}
          <button className="btn ghost" onClick={onClose}>Fechar</button>
        </div>
        {err && <div className="err">{err}</div>}

        {comprasAbertas.length > 1 && (
          <div style={{ padding: "8px 12px", background: "#fef3c7", borderRadius: 8, border: "1px solid #fde68a", fontSize: 12, color: "#92400e", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span>🏷️</span>
            <span><b>Múltiplos parcelamentos em aberto:</b> este cliente possui <b>{comprasAbertas.length} compras ativas</b>. Selecione uma compra abaixo para visualizar seu parcelamento isolado:</span>
          </div>
        )}

        <div className="kpis" style={{ margin: 0 }}>
          <div className="card hl">
            <small>SALDO A RECEBER</small>
            <b>{money(compraAtiva?.saldoDevedor ?? 0)}</b>
          </div>
          <div className="card">
            <small>TOTAL DA VENDA ATUAL</small>
            <b>{money(compraAtiva?.dividaTotal ?? 0)}</b>
          </div>
          <div className="card">
            <small>VALOR PAGO (VENDA ATUAL)</small>
            <b>{money(compraAtiva?.valorPago ?? 0)}</b>
          </div>
          <div className="card">
            <small>PARCELAS DA VENDA ATUAL</small>
            <b>{compraAtiva?.totalParcelas ?? 0}</b>
            {totalOutrasQuitadas > 0 ? (
              <span className="ksub" style={{ color: "var(--brand)", fontWeight: 600 }}>
                ✓ {money(totalOutrasQuitadas)} quitados em compras anteriores
              </span>
            ) : totalOutrasRepactuadas > 0 ? (
              <span className="ksub" style={{ color: "#7e22ce", fontWeight: 600 }}>
                🔄 {money(totalOutrasRepactuadas)} repactuados de compras anteriores
              </span>
            ) : (compraAtiva?.parcelasPagas ?? 0) > 0 ? (
              <span className="ksub" style={{ color: "var(--brand)", fontWeight: 600 }}>
                ✓ {compraAtiva?.parcelasPagas} pagas · {compraAtiva?.parcelasAbertas} em aberto
              </span>
            ) : null}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 2, marginBottom: -4 }}>
          {comprasAbertas.length > 1 ? (
            comprasAbertas.map((c, idx) => {
              const ativo = filtroAba === "compra_ativa" && compraAtiva?.id === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    setFiltroAba("compra_ativa");
                    setCompraIdSelecionada(c.id);
                  }}
                  style={{
                    padding: "6px 14px",
                    borderRadius: 99,
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: "pointer",
                    border: ativo ? "1.5px solid var(--brand)" : "1px solid var(--line)",
                    background: ativo ? "var(--brand)" : "var(--panel)",
                    color: ativo ? "#fff" : "var(--ink)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    transition: "all 0.15s ease",
                  }}
                >
                  <span>🟢</span> Compra {idx + 1}: {c.titulo} ({c.parcelasAbertas} {c.parcelasAbertas === 1 ? "parcela" : "parcelas"} · {money(c.saldoDevedor)})
                </button>
              );
            })
          ) : (
            <button
              type="button"
              onClick={() => {
                setFiltroAba("compra_ativa");
                if (comprasAbertas[0]) setCompraIdSelecionada(comprasAbertas[0].id);
              }}
              style={{
                padding: "6px 14px",
                borderRadius: 99,
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
                border: filtroAba === "compra_ativa" ? "1.5px solid var(--brand)" : "1px solid var(--line)",
                background: filtroAba === "compra_ativa" ? "var(--brand)" : "var(--panel)",
                color: filtroAba === "compra_ativa" ? "#fff" : "var(--ink)",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                transition: "all 0.15s ease",
              }}
            >
              <span>🟢</span> Venda Atual / Em Aberto ({compraAtiva?.parcelasAbertas ?? abertos.length} {((compraAtiva?.parcelasAbertas ?? abertos.length) === 1) ? "parcela" : "parcelas"})
            </button>
          )}

          {comprasQuitadas.length > 0 && (() => {
            const todasRepactuadas = comprasQuitadas.every(c => c.promissorias.every(ehRepactuada));
            const temRepactuada = comprasQuitadas.some(c => c.promissorias.some(ehRepactuada));
            const totalQtd = comprasQuitadas.reduce((s, c) => s + c.promissorias.length, 0);
            return (
              <button
                type="button"
                onClick={() => setFiltroAba("quitadas")}
                style={{
                  padding: "6px 14px",
                  borderRadius: 99,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                  border: filtroAba === "quitadas"
                    ? (todasRepactuadas ? "1.5px solid #a855f7" : "1.5px solid var(--brand)")
                    : "1px solid var(--line)",
                  background: filtroAba === "quitadas"
                    ? (todasRepactuadas ? "#7e22ce" : "var(--brand)")
                    : "var(--panel)",
                  color: filtroAba === "quitadas" ? "#fff" : (todasRepactuadas ? "#7e22ce" : "var(--ink)"),
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  transition: "all 0.15s ease",
                }}
              >
                <span>{todasRepactuadas ? "🔄" : "✓"}</span>{" "}
                {todasRepactuadas
                  ? `Vendas Repactuadas (${totalQtd})`
                  : temRepactuada
                  ? `Quitadas / Repactuadas (${totalQtd})`
                  : `Vendas Já Quitadas (${totalQtd})`}
              </button>
            );
          })()}

          <button
            type="button"
            onClick={() => setFiltroAba("todas")}
            style={{
              padding: "6px 14px",
              borderRadius: 99,
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
              border: filtroAba === "todas" ? "1.5px solid var(--brand)" : "1px solid var(--line)",
              background: filtroAba === "todas" ? "var(--brand)" : "var(--panel)",
              color: filtroAba === "todas" ? "#fff" : "var(--ink)",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              transition: "all 0.15s ease",
            }}
          >
            Todas as Promissórias ({rows.length})
          </button>
        </div>
        <div className="wrap">
          <table style={{ width: "100%" }}>
            <thead>
              <tr>
                <th className={`sortable ${sortCol === "vencimento" ? "active" : ""}`} onClick={() => handleSort("vencimento")} title="Clique para ordenar por Vencimento">
                  <span className="th-content">Vencimento <SortIcon col="vencimento" sortCol={sortCol} sortAsc={sortAsc} /></span>
                </th>
                <th className={`sortable ${sortCol === "parcelas" ? "active" : ""}`} onClick={() => handleSort("parcelas")} title="Clique para ordenar por Parcelas">
                  <span className="th-content">Parcelas <SortIcon col="parcelas" sortCol={sortCol} sortAsc={sortAsc} /></span>
                </th>
                <th className={`sortable n ${sortCol === "divida_total" ? "active" : ""}`} onClick={() => handleSort("divida_total")} title="Clique para ordenar por Dívida">
                  <span className="th-content">Dívida <SortIcon col="divida_total" sortCol={sortCol} sortAsc={sortAsc} /></span>
                </th>
                <th className={`sortable n ${sortCol === "valor_pago" ? "active" : ""}`} onClick={() => handleSort("valor_pago")} title="Clique para ordenar por Valor Pago">
                  <span className="th-content">Pago <SortIcon col="valor_pago" sortCol={sortCol} sortAsc={sortAsc} /></span>
                </th>
                <th className={`sortable n ${sortCol === "saldo_devedor" ? "active" : ""}`} onClick={() => handleSort("saldo_devedor")} title="Clique para ordenar por Saldo Devedor">
                  <span className="th-content">Saldo <SortIcon col="saldo_devedor" sortCol={sortCol} sortAsc={sortAsc} /></span>
                </th>
                <th className={`sortable ${sortCol === "status" ? "active" : ""}`} onClick={() => handleSort("status")} title="Clique para ordenar por Status">
                  <span className="th-content">Status <SortIcon col="status" sortCol={sortCol} sortAsc={sortAsc} /></span>
                </th>
                <th style={{ textAlign: "right" }}>Ações</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map(r => {
                const info = extrairInfoParcelas(r.parcelas);
                const podeDesmembrar = isAdmin && r.saldo_devedor > 0 && info.ehCarnetAgrupado && info.totalParcelas > 1 && !r.fundo_perdido;
                return (
                  <tr key={r.id}>
                    <td><VencCell r={r} /></td>
                    <td className="mono">{r.parcelas || "—"}</td>
                    <td className="n">{money(r.divida_total)}</td>
                    <td className="n">
                      {ehRepactuada(r) && (r.saldo_devedor ?? 0) <= 0 ? (
                        <span style={{ color: "#7e22ce", fontWeight: 600, fontSize: 12 }} title="Título baixado por repactuação / troca de produto (sem entrada em dinheiro)">
                          Repactuado
                        </span>
                      ) : (
                        money(r.valor_pago)
                      )}
                    </td>
                    <td className="n"><b>{money(r.saldo_devedor)}</b></td>
                    <td><StatusPill r={r} />{r.fundo_perdido && <div className="sub">{r.fundo_perdido_motivo}{r.fundo_perdido_em ? ` · ${dt(r.fundo_perdido_em.slice(0, 10))}` : ""}</div>}</td>
                    <td className="acts">
                      {isAdmin && !r.fundo_perdido && r.saldo_devedor > 0 && (
                        <button className="btn-baixa" onClick={() => setBaixa(r)} title="Registrar baixa / pagamento">
                          Baixar
                        </button>
                      )}
                      {podeDesmembrar && (
                        <button
                          className="ed"
                          onClick={() => setDesmembrarRow(r)}
                          title="Desmembrar este carnê em parcelas mensais individuais"
                          style={{ color: "var(--brand)", fontWeight: 600 }}
                        >
                          Desmembrar
                        </button>
                      )}
                      {r.valor_pago > 0 && (
                        <button className="ed" onClick={() => setLogRow(r)} title="Ver histórico e auditoria de pagamento">
                          Log
                        </button>
                      )}
                      {isAdmin && <button className="ed" onClick={() => setEditing(r)} title="Editar promissória">Editar</button>}
                      {isAdmin && (r.fundo_perdido || r.saldo_devedor > 0) && (
                        <button className="ed" onClick={() => setPerdido(r)} title={r.fundo_perdido ? "Desfazer fundo perdido" : "Marcar como fundo perdido"}>
                          {r.fundo_perdido ? "Desfazer" : "Fundo perdido"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={7} style={{ textAlign: "center", color: "var(--mut)", padding: 20 }}>Nenhuma promissória encontrada para este cliente.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {baixa && <BaixaDialog row={baixa} onClose={() => setBaixa(null)} onSaved={() => { setBaixa(null); refresh(); }} />}
      {desmembrarRow && <DesmembrarDialog row={desmembrarRow} onClose={() => setDesmembrarRow(null)} onSaved={() => { setDesmembrarRow(null); refresh(); }} />}
      {logRow && <LogDialog row={logRow} onClose={() => setLogRow(null)} />}
      {editing && <Editor row={editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); refresh(); }} />}
      {perdido && <PerdidoDialog row={perdido} onClose={() => setPerdido(null)} onDone={() => { setPerdido(null); refresh(); }} />}
      {whats && <WhatsDialog nome={cliente} telefone={tel} mensagem={mensagemCobranca(cliente, abertos.map(r => ({ valor: r.saldo_devedor, vencimento: r.vencimento })))} onClose={() => setWhats(false)} />}
    </Painel>
  );
}

/**
 * Modal para dar baixa em uma promissória com possibilidade de informar valor diferente
 * do calculado e recalcular automaticamente as promissórias restantes dividindo o saldo em aberto.
 */
export function BaixaDialog({
  row,
  onClose,
  onSaved,
}: {
  row: Row;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [valorStr, setValorStr] = useState(formatarMascaraMoeda(row.saldo_devedor));
  const [parcelaIdentificador, setParcelaIdentificador] = useState<string>(() => {
    let logsCount = 0;
    try {
      const logs = JSON.parse(row.origem || "[]");
      if (Array.isArray(logs)) logsCount = logs.length;
    } catch {}
    return extrairInfoParcelas(row.parcelas, row.divida_total, logsCount + 1).rotuloParcela;
  });
  const [valorTotalCompra, setValorTotalCompra] = useState<number>(() => {
    return extrairInfoParcelas(row.parcelas, row.divida_total, 1).valorTotalCompra;
  });
  const [totalParcelasCarnê, setTotalParcelasCarnê] = useState<number>(() => {
    return extrairInfoParcelas(row.parcelas, row.divida_total, 1).totalParcelas;
  });
  const [outras, setOutras] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [selecionadas, setSelecionadas] = useState<Set<number>>(new Set());
  const [modoDiferenca, setModoDiferenca] = useState<"abater_padrao" | "ratear" | "quitar_desconto">("abater_padrao");
  const [comprovante, setComprovante] = useState<{
    mensagem: string;
    telefone: string;
    nome: string;
  } | null>(null);
  const [msgEditavel, setMsgEditavel] = useState("");
  const [ddd, setDdd] = useState(getDDD());
  const [selTel, setSelTel] = useState(0);
  const [copiado, setCopiado] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // Carregar outras promissórias em aberto do cliente
  useEffect(() => {
    let active = true;
    let logsCount = 0;
    try {
      const logs = JSON.parse(row.origem || "[]");
      if (Array.isArray(logs)) logsCount = logs.length;
    } catch {}

    const info = extrairInfoParcelas(row.parcelas, row.divida_total, logsCount + 1);
    setParcelaIdentificador(info.rotuloParcela);
    setValorTotalCompra(info.valorTotalCompra);
    setTotalParcelasCarnê(info.totalParcelas);

    async function carregar() {
      setLoading(true);
      const { data, error } = await supabase
        .from("promissorias")
        .select("*")
        .eq("cliente_nome", row.cliente_nome)
        .order("id", { ascending: true });

      if (!active) return;
      setLoading(false);
      if (error) {
        setErr("Não foi possível carregar as outras promissórias: " + error.message);
        return;
      }

      const todasRows = (data || []) as Row[];
      const compras = separarComprasCliente(todasRows);
      const compraAtual = compras.find(c => c.promissorias.some(p => p.id === row.id)) || null;

      if (compraAtual) {
        setValorTotalCompra(compraAtual.dividaTotal);
        setTotalParcelasCarnê(compraAtual.totalParcelas);

        // Somente as outras promissórias EM ABERTO DESTA MESMA COMPRA (isolando de compras distintas)
        const outrasDestaCompra = compraAtual.promissorias.filter(
          p => p.id !== row.id && !p.fundo_perdido && (p.saldo_devedor ?? 0) > 0
        );

        const mAtual = (row.parcelas || "").trim().match(/^(\d+)\/(\d+)$/);
        const numParcelaAtual = mAtual ? parseInt(mAtual[1], 10) : 0;

        // Ordenar: primeiro as posteriores à parcela atual (ex: se pagando 1/10, vem 2/10, 3/10, 4/10...), ordenadas crescentemente
        outrasDestaCompra.sort((a, b) => {
          const na = parseInt((a.parcelas || "").match(/^(\d+)/)?.[1] || "0", 10);
          const nb = parseInt((b.parcelas || "").match(/^(\d+)/)?.[1] || "0", 10);
          if (numParcelaAtual > 0 && na > 0 && nb > 0) {
            const aPost = na > numParcelaAtual;
            const bPost = nb > numParcelaAtual;
            if (aPost !== bPost) return aPost ? -1 : 1;
            return na - nb;
          }
          const da = a.vencimento ? new Date(a.vencimento).getTime() : 0;
          const db = b.vencimento ? new Date(b.vencimento).getTime() : 0;
          return da - db;
        });

        setOutras(outrasDestaCompra);
        setSelecionadas(new Set(outrasDestaCompra.map(r => r.id)));
      } else {
        setOutras([]);
        setSelecionadas(new Set());
      }
    }

    carregar();
    return () => { active = false; };
  }, [row]);

  const V = parse(valorStr);
  const ok = !isNaN(V) && V >= 0;
  const isDiferente = ok && V !== row.saldo_devedor;

  const parcelasRateio = useMemo(
    () => outras.filter(r => selecionadas.has(r.id)),
    [outras, selecionadas]
  );

  const temRateio = isDiferente && modoDiferenca === "ratear" && parcelasRateio.length > 0;

  // Saldo devedor total em aberto do cliente somando a promissória atual + todas as outras
  const saldoTotalGrupo = useMemo(() => {
    return row.saldo_devedor + outras.reduce((acc, r) => acc + r.saldo_devedor, 0);
  }, [row.saldo_devedor, outras]);

  // Saldo que restará para dividir após o pagamento atual (no caso de rateio)
  const saldoRestanteRateio = Math.max(0, (row.saldo_devedor + parcelasRateio.reduce((acc, r) => acc + r.saldo_devedor, 0)) - (ok ? V : 0));

  // Simulação do novo valor para cada promissória restante no caso de rateio
  const simulacao = useMemo(() => {
    if (!temRateio || !ok || parcelasRateio.length === 0) return [];
    const k = parcelasRateio.length;
    const base = Math.floor(saldoRestanteRateio / k);
    const resto = saldoRestanteRateio % k;

    return parcelasRateio.map((item, idx) => {
      const novoSaldo = base + (idx === 0 ? resto : 0);
      return {
        ...item,
        saldoAnterior: item.saldo_devedor,
        novoSaldo,
        diferenca: novoSaldo - item.saldo_devedor,
      };
    });
  }, [temRateio, ok, parcelasRateio, saldoRestanteRateio]);

  // Simulação do cascateamento de abate das próximas parcelas (quando V > row.saldo_devedor no modo sem recalcular)
  const simulacaoAbateCascata = useMemo(() => {
    if (!ok || V <= row.saldo_devedor || outras.length === 0) return [];
    let excedente = V - row.saldo_devedor;

    return outras.map(p => {
      if (excedente <= 0) {
        return {
          ...p,
          valorAbatido: 0,
          novoValorPago: p.valor_pago,
          novoSaldo: p.saldo_devedor,
          quitada: false,
        };
      }
      const amortizar = Math.min(excedente, p.saldo_devedor);
      excedente -= amortizar;
      const novoValorPago = p.valor_pago + amortizar;
      const novoSaldo = p.saldo_devedor - amortizar;
      return {
        ...p,
        valorAbatido: amortizar,
        novoValorPago,
        novoSaldo,
        quitada: novoSaldo === 0,
      };
    });
  }, [ok, V, row.saldo_devedor, outras]);

  function toggleSelecionada(id: number) {
    setSelecionadas(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ok) return setErr("Informe um valor monetário válido.");
    if (V <= 0) return setErr("O valor pago deve ser maior que zero.");
    if (V > saldoTotalGrupo) {
      return setErr(`O valor informado (${money(V)}) não pode ser maior que o saldo total desta compra (${money(saldoTotalGrupo)}).`);
    }

    setBusy(true);
    setErr("");

    try {
      // Obter dados do operador autenticado para auditoria
      const { data: userData } = await supabase.auth.getUser();
      const operadorEmail = userData.user?.email || "operador@leoticas.fin";
      const operadorId = userData.user?.id || null;
      const agoraIso = new Date().toISOString();

      let detalhesOp = "";
      if (temRateio) {
        detalhesOp = `Baixa com recálculo e rateio de saldo de ${money(saldoRestanteRateio)} em ${parcelasRateio.length} parcela(s) restante(s).`;
      } else if (modoDiferenca === "quitar_desconto") {
        detalhesOp = `Quitação com desconto concedido (pago ${money(V)} de saldo ${money(row.saldo_devedor)}). Desconto: ${money(row.saldo_devedor - V)}.`;
      } else if (V < row.saldo_devedor) {
        detalhesOp = `Abate parcial de ${money(V)} (sem recalcular). Saldo restante da parcela: ${money(row.saldo_devedor - V)}.`;
      } else if (V > row.saldo_devedor) {
        detalhesOp = `Quitação integral com excedente de ${money(V - row.saldo_devedor)} abatido nas próximas parcelas (sem recalcular).`;
      } else {
        detalhesOp = `Quitação integral no valor de ${money(V)}.`;
      }

      // Preparar array de logs serializado para salvar em origem da promissória atual
      let logsArray: any[] = [];
      if (row.origem) {
        try {
          const parsed = JSON.parse(row.origem);
          if (Array.isArray(parsed)) logsArray = parsed;
        } catch (_) {}
      }
      logsArray.push({
        data: agoraIso,
        valor: V,
        operador: operadorEmail,
        detalhes: detalhesOp,
      });
      const origemComLogs = JSON.stringify(logsArray);

      // 1. Tentar gravar na tabela dedicada promissoria_pagamentos para a parcela atual
      const valorPagoNestaPromissoria = Math.min(V, row.saldo_devedor);
      try {
        await supabase.from("promissoria_pagamentos").insert({
          promissoria_id: row.id,
          valor_pago: (modoDiferenca === "abater_padrao" && V > row.saldo_devedor) ? valorPagoNestaPromissoria : V,
          operador_email: operadorEmail,
          operador_id: operadorId,
          data_pagamento: agoraIso,
          detalhes: detalhesOp,
        });
      } catch (_) {}

      if (temRateio) {
        // Quitar a promissória atual com o valor recebido nesta baixa
        const novaDividaAtual = row.valor_pago + V;
        const { error: errAtual } = await supabase
          .from("promissorias")
          .update({
            divida_total: novaDividaAtual,
            valor_pago: novaDividaAtual,
            origem: origemComLogs,
          })
          .eq("id", row.id);

        if (errAtual) throw new Error("Erro ao baixar promissória: " + errAtual.message);

        // Atualizar cada uma das promissórias restantes com o novo valor recalculado
        for (const item of simulacao) {
          const novaDivida = item.valor_pago + item.novoSaldo;
          const { error: errFilha } = await supabase
            .from("promissorias")
            .update({
              divida_total: novaDivida,
            })
            .eq("id", item.id);

          if (errFilha) throw new Error(`Erro ao atualizar parcela ${item.parcelas}: ` + errFilha.message);
        }
      } else if (modoDiferenca === "quitar_desconto") {
        // Quitação com desconto: ajusta divida_total para igualar ao valor já pago + V
        const novaDivida = row.valor_pago + V;
        const { error } = await supabase
          .from("promissorias")
          .update({
            divida_total: novaDivida,
            valor_pago: novaDivida,
            origem: origemComLogs,
          })
          .eq("id", row.id);
        if (error) throw new Error(error.message);
      } else if (modoDiferenca === "abater_padrao" && V > row.saldo_devedor) {
        // Excedente abatido nas próximas parcelas (SEM RECALCULAR)
        // 1. Quitar integralmente a promissória atual
        const novoPagoAtual = row.divida_total;
        const { error: errAtual } = await supabase
          .from("promissorias")
          .update({
            valor_pago: novoPagoAtual,
            origem: origemComLogs,
          })
          .eq("id", row.id);
        if (errAtual) throw new Error(errAtual.message);

        // 2. Abater das próximas parcelas por ordem cronológica (sem alterar divida_total)
        for (const item of simulacaoAbateCascata) {
          if (item.valorAbatido > 0) {
            let logsFilha: any[] = [];
            if (item.origem) {
              try {
                const parsed = JSON.parse(item.origem);
                if (Array.isArray(parsed)) logsFilha = parsed;
              } catch (_) {}
            }
            const detalheItem = `Abate de excedente (${money(item.valorAbatido)}) recebido junto da parcela ${parcelaIdentificador || row.parcelas}. Saldo restante: ${money(item.novoSaldo)}.`;
            logsFilha.push({
              data: agoraIso,
              valor: item.valorAbatido,
              operador: operadorEmail,
              detalhes: detalheItem,
            });

            const { error: errFilha } = await supabase
              .from("promissorias")
              .update({
                valor_pago: item.novoValorPago,
                origem: JSON.stringify(logsFilha),
              })
              .eq("id", item.id);
            if (errFilha) throw new Error(`Erro ao abater da parcela ${item.parcelas}: ` + errFilha.message);

            try {
              await supabase.from("promissoria_pagamentos").insert({
                promissoria_id: item.id,
                valor_pago: item.valorAbatido,
                operador_email: operadorEmail,
                operador_id: operadorId,
                data_pagamento: agoraIso,
                detalhes: detalheItem,
              });
            } catch (_) {}
          }
        }
      } else {
        // Abate parcial da parcela atual (sem recalcular) ou quitação com valor exato
        const novoPago = row.valor_pago + V;
        const { error } = await supabase
          .from("promissorias")
          .update({
            valor_pago: novoPago,
            origem: origemComLogs,
          })
          .eq("id", row.id);
        if (error) throw new Error(error.message);
      }

      // Calcular saldo restante e gerar mensagem de comprovante para o WhatsApp
      let valorRestanteFinal = 0;
      let proximasParcelasInfo: { parcela: string; valor: number; vencimento?: string }[] | undefined = undefined;

      if (temRateio) {
        valorRestanteFinal = saldoRestanteRateio;
        if (saldoRestanteRateio > 0) {
          proximasParcelasInfo = simulacao.map(item => ({
            parcela: item.parcelas,
            valor: item.novoSaldo,
            vencimento: item.vencimento,
          }));
        }
      } else if (modoDiferenca === "quitar_desconto") {
        valorRestanteFinal = outras.reduce((acc, r) => acc + r.saldo_devedor, 0);
        if (valorRestanteFinal > 0) {
          proximasParcelasInfo = outras.map(r => ({
            parcela: r.parcelas,
            valor: r.saldo_devedor,
            vencimento: r.vencimento,
          }));
        }
      } else if (modoDiferenca === "abater_padrao" && V > row.saldo_devedor) {
        valorRestanteFinal = simulacaoAbateCascata.reduce((acc, r) => acc + r.novoSaldo, 0);
        if (valorRestanteFinal > 0) {
          proximasParcelasInfo = simulacaoAbateCascata
            .filter(r => r.novoSaldo > 0)
            .map(r => ({
              parcela: r.parcelas,
              valor: r.novoSaldo,
              vencimento: r.vencimento,
            }));
        }
      } else {
        // V <= row.saldo_devedor (abate parcial na própria parcela atual ou quitação exata)
        const saldoDestaRestante = Math.max(0, row.saldo_devedor - V);
        const saldoOutrasAbertas = outras.reduce((acc, r) => acc + r.saldo_devedor, 0);
        valorRestanteFinal = saldoDestaRestante + saldoOutrasAbertas;

        if (valorRestanteFinal > 0) {
          proximasParcelasInfo = [
            ...(saldoDestaRestante > 0 ? [{ parcela: parcelaIdentificador || row.parcelas, valor: saldoDestaRestante, vencimento: row.vencimento }] : []),
            ...outras.map(r => ({ parcela: r.parcelas, valor: r.saldo_devedor, vencimento: r.vencimento })),
          ];
        }
      }

      const textoComprovante = mensagemComprovanteBaixa({
        nome: row.cliente_nome,
        valorTotalCompra,
        totalParcelas: totalParcelasCarnê,
        valorPago: V,
        parcela: parcelaIdentificador || row.parcelas || "1X",
        valorRestante: valorRestanteFinal,
        dataPagamento: dtHora(agoraIso),
        proximasParcelas: proximasParcelasInfo,
      });

      setMsgEditavel(textoComprovante);
      setComprovante({
        mensagem: textoComprovante,
        telefone: row.telefone,
        nome: row.cliente_nome,
      });
      setBusy(false);
    } catch (e: any) {
      setBusy(false);
      setErr(e.message || "Erro ao registrar baixa.");
    }
  }

  // Tela de Comprovante de Pagamento (WhatsApp)
  if (comprovante) {
    const nums = normalizarTelefones(comprovante.telefone, ddd);
    const numero = nums[Math.min(selTel, nums.length - 1)];

    return (
      <Painel onClose={() => { onClose(); onSaved(); }} style={{ width: "min(720px, 96vw)" }}>
        <div style={{ padding: 20, display: "grid", gap: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 style={{ margin: 0, color: "var(--ink)", display: "flex", alignItems: "center", gap: 8 }}>
              <span>Comprovante WhatsApp</span>
            </h2>
            <span className="pill" style={{ background: "#15803d15", color: "#15803d", borderColor: "#15803d" }}>
              ✓ Baixa efetuada
            </span>
          </div>

          <div style={{ background: "#15803d15", border: "1px solid #15803d40", borderRadius: 10, padding: "10px 14px", fontSize: 13, color: "var(--ink)" }}>
            <b>Baixa registrada com sucesso!</b> O comprovante foi gerado automaticamente para envio ao WhatsApp do pagador.
          </div>

          <div>
            <b>{comprovante.nome}</b>
            <div className="sub mono">Telefone cadastrado: {comprovante.telefone || "—"}</div>
          </div>

          <label>DDD padrão (para números sem DDD)
            <input
              value={ddd}
              maxLength={2}
              inputMode="numeric"
              style={{ width: 80 }}
              onChange={e => {
                const val = e.target.value.replace(/\D/g, "");
                setDdd(val);
                if (val.length === 2) setDDD(val);
              }}
            />
          </label>

          {nums.length > 1 && (
            <label>Selecione o número de WhatsApp
              <select value={selTel} onChange={e => setSelTel(Number(e.target.value))}>
                {nums.map((x, k) => <option key={x} value={k}>{formatarTelefone(x)}</option>)}
              </select>
            </label>
          )}

          {nums.length === 1 && (
            <div className="sub">Enviar para <b className="mono">{formatarTelefone(nums[0])}</b></div>
          )}

          {!nums.length && (
            <div className="err">Nenhum telefone válido encontrado. Você pode copiar a mensagem abaixo para enviar manualmente.</div>
          )}

          <label>Mensagem do comprovante (revise ou edite antes de enviar):
            <textarea
              rows={12}
              value={msgEditavel}
              onChange={e => setMsgEditavel(e.target.value)}
              style={{ fontSize: 13, lineHeight: 1.45 }}
            />
          </label>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "space-between", alignItems: "center" }}>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                navigator.clipboard.writeText(msgEditavel);
                setCopiado(true);
                setTimeout(() => setCopiado(false), 2500);
              }}
            >
              {copiado ? "✓ Mensagem copiada!" : "Copiar mensagem"}
            </button>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  onClose();
                  onSaved();
                }}
              >
                Concluir
              </button>
              {numero ? (
                <a
                  className="btn"
                  style={{
                    background: "#15803d",
                    borderColor: "#15803d",
                    color: "#fff",
                    textDecoration: "none",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                  href={linkWhatsApp(numero, msgEditavel)}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => {
                    setTimeout(() => {
                      onClose();
                      onSaved();
                    }, 500);
                  }}
                >
                  Abrir WhatsApp
                </a>
              ) : (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    onClose();
                    onSaved();
                  }}
                >
                  Concluir
                </button>
              )}
            </div>
          </div>
        </div>
      </Painel>
    );
  }

  return (
    <Painel onClose={onClose} style={{ width: "min(780px, 96vw)" }}>
      <form onSubmit={submit} autoComplete="off">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0, color: "var(--ink)" }}>Dar Baixa / Pagamento</h2>
          <span className="pill" style={{ background: "#15803d15", color: "#15803d", borderColor: "#15803d" }}>
            Operação de Caixa
          </span>
        </div>

        <div style={{ background: "var(--soft)", padding: "12px 14px", borderRadius: 10, border: "1px solid var(--line)" }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{row.cliente_nome}</div>
          <div className="sub mono" style={{ marginTop: 2 }}>{row.telefone || "Sem telefone"}</div>
          <div style={{ display: "flex", gap: 14, marginTop: 8, fontSize: 13, flexWrap: "wrap" }}>
            <span>Compra total: <b>{formatarValorSemCifrao(valorTotalCompra)} em {totalParcelasCarnê}x</b></span>
            <span>Parcela atual: <b>{parcelaIdentificador}</b></span>
            <span>Vencimento: <b>{dt(row.vencimento)}</b></span>
            <span>Saldo em aberto: <b className="mono">{money(row.saldo_devedor)}</b></span>
          </div>
          {outras.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 11.5, color: "#15803d", display: "flex", alignItems: "center", gap: 5 }}>
              <span>🔒</span>
              <span>Abatimento e recálculo vinculados <b>exclusivamente a esta compra</b> ({outras.length} {outras.length === 1 ? "parcela restante" : "parcelas restantes"}). Demais compras em aberto não são afetadas.</span>
            </div>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 6 }}>
          <label>
            <span style={{ fontWeight: 700, color: "var(--ink)", fontSize: 13 }}>
              Valor recebido nesta baixa (R$)
            </span>
            <input
              value={valorStr}
              onChange={e => setValorStr(formatarMascaraMoeda(e.target.value, true))}
              inputMode="numeric"
              placeholder="R$ 0,00"
              style={{ fontSize: 17, fontWeight: 600, padding: "8px 12px" }}
              autoFocus
              required
            />
            <span className="sub">
              {isDiferente
                ? V > row.saldo_devedor
                  ? `${money(V - row.saldo_devedor)} maior que o saldo.`
                  : `${money(row.saldo_devedor - V)} menor que o saldo.`
                : "Valor exato do saldo da parcela."}
            </span>
          </label>

          <label>
            <span style={{ fontWeight: 700, color: "var(--ink)", fontSize: 13 }}>
              Identificação da parcela paga
            </span>
            <input
              value={parcelaIdentificador}
              onChange={e => setParcelaIdentificador(e.target.value)}
              placeholder="Ex: Parcela 1/8"
              style={{ fontSize: 15, fontWeight: 500, padding: "8px 12px" }}
              required
            />
            <span className="sub">
              Identifica a parcela paga no comprovante.
            </span>
          </label>
        </div>

        {loading ? (
          <div className="sub" style={{ padding: 10 }}>Buscando outras promissórias do cliente…</div>
        ) : (
          <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12, display: "grid", gap: 12 }}>
            {/* Caso 1: Valor menor que o saldo devedor da parcela */}
            {isDiferente && V < row.saldo_devedor && (
              <div
                style={{
                  background: "var(--soft)",
                  border: "1px solid var(--line)",
                  borderRadius: 10,
                  padding: "12px 14px",
                  display: "grid",
                  gap: 10,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)", display: "flex", justifyContent: "space-between" }}>
                  <span>Pagamento menor que a parcela</span>
                  <span className="mono" style={{ color: "var(--bad)" }}>Faltam {money(row.saldo_devedor - V)}</span>
                </div>

                <div style={{ display: "grid", gap: 8 }}>
                  {/* Opção Padrão: Abater e manter saldo em aberto na parcela atual sem recalcular */}
                  <label
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      cursor: "pointer",
                      padding: "8px 10px",
                      background: modoDiferenca === "abater_padrao" ? "var(--card)" : "transparent",
                      border: modoDiferenca === "abater_padrao" ? "1px solid #15803d" : "1px solid transparent",
                      borderRadius: 8,
                    }}
                  >
                    <input
                      type="radio"
                      name="modoDiferencaMenor"
                      checked={modoDiferenca === "abater_padrao"}
                      onChange={() => setModoDiferenca("abater_padrao")}
                      style={{ marginTop: 2, accentColor: "#15803d" }}
                    />
                    <div style={{ fontSize: 13 }}>
                      <div style={{ fontWeight: 700, color: "var(--ink)" }}>
                        Abater desta parcela (Sem recalcular) <span className="pill" style={{ fontSize: 10, padding: "1px 6px", background: "#15803d15", color: "#15803d", borderColor: "#15803d" }}>Padrão</span>
                      </div>
                      <div className="sub" style={{ marginTop: 2 }}>
                        Registra o pagamento de <b>{money(V)}</b>. A parcela atual continuará constando em aberto com saldo de <b>{money(row.saldo_devedor - V)}</b>. As demais parcelas permanecem inalteradas.
                      </div>
                    </div>
                  </label>

                  {/* Opção 2: Quitar com desconto */}
                  <label
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      cursor: "pointer",
                      padding: "8px 10px",
                      background: modoDiferenca === "quitar_desconto" ? "var(--card)" : "transparent",
                      border: modoDiferenca === "quitar_desconto" ? "1px solid var(--brand)" : "1px solid transparent",
                      borderRadius: 8,
                    }}
                  >
                    <input
                      type="radio"
                      name="modoDiferencaMenor"
                      checked={modoDiferenca === "quitar_desconto"}
                      onChange={() => setModoDiferenca("quitar_desconto")}
                      style={{ marginTop: 2, accentColor: "var(--brand)" }}
                    />
                    <div style={{ fontSize: 13 }}>
                      <div style={{ fontWeight: 700, color: "var(--ink)" }}>
                        Quitar parcela com desconto concedido
                      </div>
                      <div className="sub" style={{ marginTop: 2 }}>
                        Dá a parcela atual como 100% quitada concedendo um desconto de <b>{money(row.saldo_devedor - V)}</b>.
                      </div>
                    </div>
                  </label>

                  {/* Opção 3: Ratear nas outras parcelas (se houver outras) */}
                  {outras.length > 0 && (
                    <label
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 8,
                        cursor: "pointer",
                        padding: "8px 10px",
                        background: modoDiferenca === "ratear" ? "var(--card)" : "transparent",
                        border: modoDiferenca === "ratear" ? "1px solid var(--brand)" : "1px solid transparent",
                        borderRadius: 8,
                      }}
                    >
                      <input
                        type="radio"
                        name="modoDiferencaMenor"
                        checked={modoDiferenca === "ratear"}
                        onChange={() => setModoDiferenca("ratear")}
                        style={{ marginTop: 2, accentColor: "var(--brand)" }}
                      />
                      <div style={{ fontSize: 13 }}>
                        <div style={{ fontWeight: 700, color: "var(--ink)" }}>
                          Recalcular e ratear o saldo restante nas demais promissórias ({outras.length} em aberto)
                        </div>
                        <div className="sub" style={{ marginTop: 2 }}>
                          Quita a parcela atual e redistribui a diferença de <b>{money(row.saldo_devedor - V)}</b> aumentando o saldo das parcelas seguintes.
                        </div>
                      </div>
                    </label>
                  )}
                </div>
              </div>
            )}

            {/* Caso 2: Valor maior que o saldo devedor da parcela */}
            {isDiferente && V > row.saldo_devedor && (
              <div
                style={{
                  background: "var(--soft)",
                  border: "1px solid var(--line)",
                  borderRadius: 10,
                  padding: "12px 14px",
                  display: "grid",
                  gap: 10,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)", display: "flex", justifyContent: "space-between" }}>
                  <span>Pagamento maior que a parcela</span>
                  <span className="mono" style={{ color: "#15803d" }}>Excedente de +{money(V - row.saldo_devedor)}</span>
                </div>

                <div style={{ display: "grid", gap: 8 }}>
                  {/* Opção Padrão: Abater das próximas parcelas sem recalcular */}
                  <label
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      cursor: "pointer",
                      padding: "8px 10px",
                      background: modoDiferenca === "abater_padrao" ? "var(--card)" : "transparent",
                      border: modoDiferenca === "abater_padrao" ? "1px solid #15803d" : "1px solid transparent",
                      borderRadius: 8,
                    }}
                  >
                    <input
                      type="radio"
                      name="modoDiferencaMaior"
                      checked={modoDiferenca === "abater_padrao"}
                      onChange={() => setModoDiferenca("abater_padrao")}
                      style={{ marginTop: 2, accentColor: "#15803d" }}
                    />
                    <div style={{ fontSize: 13 }}>
                      <div style={{ fontWeight: 700, color: "var(--ink)" }}>
                        Abater das próximas parcelas (Sem recalcular) <span className="pill" style={{ fontSize: 10, padding: "1px 6px", background: "#15803d15", color: "#15803d", borderColor: "#15803d" }}>Padrão</span>
                      </div>
                      <div className="sub" style={{ marginTop: 2 }}>
                        Quita esta parcela e abate o excedente de <b>{money(V - row.saldo_devedor)}</b> diretamente nas próximas parcelas por ordem cronológica, sem alterar os valores do carnê.
                      </div>
                    </div>
                  </label>

                  {/* Opção 2: Ratear nas outras parcelas (se houver outras) */}
                  {outras.length > 0 && (
                    <label
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 8,
                        cursor: "pointer",
                        padding: "8px 10px",
                        background: modoDiferenca === "ratear" ? "var(--card)" : "transparent",
                        border: modoDiferenca === "ratear" ? "1px solid var(--brand)" : "1px solid transparent",
                        borderRadius: 8,
                      }}
                    >
                      <input
                        type="radio"
                        name="modoDiferencaMaior"
                        checked={modoDiferenca === "ratear"}
                        onChange={() => setModoDiferenca("ratear")}
                        style={{ marginTop: 2, accentColor: "var(--brand)" }}
                      />
                      <div style={{ fontSize: 13 }}>
                        <div style={{ fontWeight: 700, color: "var(--ink)" }}>
                          Recalcular e ratear entre as parcelas restantes ({outras.length} em aberto)
                        </div>
                        <div className="sub" style={{ marginTop: 2 }}>
                          Quita esta parcela e recalcula as próximas parcelas diminuindo o valor nominal delas igualmente.
                        </div>
                      </div>
                    </label>
                  )}
                </div>

                {/* Prévia do abate cascata nas próximas parcelas quando modoDiferenca === "abater_padrao" */}
                {modoDiferenca === "abater_padrao" && simulacaoAbateCascata.length > 0 && (
                  <div style={{ marginTop: 4 }}>
                    <div className="sub" style={{ marginBottom: 6, fontWeight: 600 }}>
                      Demonstrativo de abatimento nas próximas parcelas:
                    </div>
                    <div
                      style={{
                        background: "var(--card)",
                        border: "1px solid var(--line)",
                        borderRadius: 8,
                        overflowX: "auto",
                        maxHeight: 220,
                        overflowY: "auto",
                      }}
                    >
                      <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse", minWidth: 540 }}>
                        <thead>
                          <tr style={{ background: "var(--soft)", color: "var(--mut)", fontSize: 11 }}>
                            <th style={{ textAlign: "left", padding: "8px 10px" }}>PARCELA</th>
                            <th style={{ textAlign: "left", padding: "8px 10px" }}>VENCIMENTO</th>
                            <th style={{ textAlign: "right", padding: "8px 10px" }}>SALDO ATUAL</th>
                            <th style={{ textAlign: "right", padding: "8px 10px" }}>VALOR ABATIDO</th>
                            <th style={{ textAlign: "right", padding: "8px 10px" }}>NOVO SALDO</th>
                          </tr>
                        </thead>
                        <tbody>
                          {simulacaoAbateCascata.map(p => (
                            <tr key={p.id} style={{ borderTop: "1px solid var(--line)" }}>
                              <td style={{ padding: "8px 10px", fontWeight: 600 }}>{p.parcelas || "—"}</td>
                              <td style={{ padding: "8px 10px" }}>{dt(p.vencimento)}</td>
                              <td style={{ padding: "8px 10px", textAlign: "right" }} className="mono">{money(p.saldo_devedor)}</td>
                              <td style={{ padding: "8px 10px", textAlign: "right", color: p.valorAbatido > 0 ? "#15803d" : "var(--mut)", fontWeight: p.valorAbatido > 0 ? 700 : 400 }} className="mono">
                                {p.valorAbatido > 0 ? `- ${money(p.valorAbatido)}` : "—"}
                              </td>
                              <td style={{ padding: "8px 10px", textAlign: "right" }} className="mono">
                                {p.quitada ? (
                                  <span className="pill" style={{ background: "#15803d15", color: "#15803d", borderColor: "#15803d", fontSize: 11 }}>
                                    ✓ Quitada
                                  </span>
                                ) : (
                                  <b>{money(p.novoSaldo)}</b>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Caso 3: Valor exato */}
            {!isDiferente && (
              <div style={{ background: "var(--soft)", padding: "10px 14px", borderRadius: 10, fontSize: 13, border: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: "#15803d", fontSize: 16 }}>✓</span>
                <div>
                  <b>Valor exato:</b> Este pagamento quita 100% da parcela <b>{parcelaIdentificador}</b>.
                  {outras.length > 0 && (
                    <span className="sub" style={{ display: "block" }}>
                      Restam ainda {outras.length} parcela(s) futuras em aberto do cliente.
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Tabela de rateio quando modoDiferenca === "ratear" */}
            {temRateio && (
              <div style={{ display: "grid", gap: 10, marginTop: 4 }}>
                <div className="sub">
                  Selecione quais promissórias futuras devem absorver a diferença do saldo:
                </div>
                <div
                  style={{
                    background: "var(--card)",
                    border: "1px solid var(--line)",
                    borderRadius: 10,
                    overflow: "hidden",
                    maxHeight: 220,
                    overflowY: "auto",
                  }}
                >
                  <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ background: "var(--soft)", color: "var(--mut)", fontSize: 11 }}>
                        <th style={{ width: 34, padding: "6px 8px" }} />
                        <th style={{ textAlign: "left", padding: "6px 8px" }}>PARCELA</th>
                        <th style={{ textAlign: "left", padding: "6px 8px" }}>VENCIMENTO</th>
                        <th style={{ textAlign: "right", padding: "6px 8px" }}>SALDO ATUAL</th>
                        <th style={{ textAlign: "right", padding: "6px 8px" }}>NOVO VALOR</th>
                      </tr>
                    </thead>
                    <tbody>
                      {outras.map(r => {
                        const sel = selecionadas.has(r.id);
                        const itemSim = simulacao.find(s => s.id === r.id);
                        return (
                          <tr
                            key={r.id}
                            style={{
                              borderTop: "1px solid var(--line)",
                              background: sel ? "transparent" : "var(--soft)",
                              opacity: sel ? 1 : 0.6,
                            }}
                          >
                            <td style={{ padding: "6px 8px", textAlign: "center" }}>
                              <input
                                type="checkbox"
                                checked={sel}
                                onChange={() => toggleSelecionada(r.id)}
                                style={{ accentColor: "#15803d" }}
                              />
                            </td>
                            <td style={{ padding: "6px 8px", fontWeight: 600 }}>{r.parcelas || "—"}</td>
                            <td style={{ padding: "6px 8px" }}>{dt(r.vencimento)}</td>
                            <td style={{ padding: "6px 8px", textAlign: "right" }} className="mono">{money(r.saldo_devedor)}</td>
                            <td style={{ padding: "6px 8px", textAlign: "right" }} className="mono">
                              {sel && itemSim ? (
                                <b style={{ color: itemSim.diferenca !== 0 ? (itemSim.diferenca > 0 ? "var(--bad)" : "var(--brand)") : "inherit" }}>
                                  {money(itemSim.novoSaldo)}
                                </b>
                              ) : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Resumo do recálculo */}
                {parcelasRateio.length > 0 && ok && (
                  <div
                    style={{
                      background: "var(--soft)",
                      borderRadius: 10,
                      padding: "10px 14px",
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: 8,
                      fontSize: 13,
                    }}
                  >
                    <div>
                      <span className="sub">Dívida total antes:</span>
                      <div className="mono" style={{ fontWeight: 600 }}>{money(saldoTotalGrupo)}</div>
                    </div>
                    <div>
                      <span className="sub">Valor pago agora:</span>
                      <div className="mono" style={{ fontWeight: 600, color: "#15803d" }}>- {money(V)}</div>
                    </div>
                    <div>
                      <span className="sub">Saldo restante:</span>
                      <div className="mono" style={{ fontWeight: 700 }}>{money(saldoRestanteRateio)}</div>
                    </div>
                    <div>
                      <span className="sub">Novo valor por parcela ({parcelasRateio.length}x):</span>
                      <div className="mono" style={{ fontWeight: 700, color: "var(--brand)" }}>
                        ~ {money(simulacao[0]?.novoSaldo || 0)}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="err">{err}</div>

        <div className="r2">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button
            className="btn"
            style={{ background: "#15803d", borderColor: "#15803d", color: "#fff" }}
            disabled={busy || !ok || V <= 0}
          >
            {busy
              ? "Gravando…"
              : temRateio
              ? "Confirmar Baixa e Recalcular"
              : modoDiferenca === "quitar_desconto"
              ? "Confirmar Quitação com Desconto"
              : modoDiferenca === "abater_padrao" && V > row.saldo_devedor
              ? "Confirmar Baixa e Abater Próximas"
              : modoDiferenca === "abater_padrao" && V < row.saldo_devedor
              ? "Confirmar Baixa Parcial"
              : "Confirmar Baixa"}
          </button>
        </div>
      </form>
    </Painel>
  );
}

/**
 * Modal para visualizar o histórico de auditoria e logs de baixa da promissória:
 * data, valor pago, operador autenticado e detalhes da operação.
 */
export function LogDialog({
  row,
  onClose,
}: {
  row: Row;
  onClose: () => void;
}) {
  const [logs, setLogs] = useState<{
    id?: number;
    data: string;
    valor: number;
    operador: string;
    detalhes?: string;
  }[]>([]);
  const [loading, setLoading] = useState(true);
  const [whatsLog, setWhatsLog] = useState<string | null>(null);

  useEffect(() => {
    async function carregarLogs() {
      setLoading(true);
      const lista: {
        id?: number;
        data: string;
        valor: number;
        operador: string;
        detalhes?: string;
      }[] = [];

      // 1. Tentar ler da tabela promissoria_pagamentos
      try {
        const { data, error } = await supabase
          .from("promissoria_pagamentos")
          .select("*")
          .eq("promissoria_id", row.id)
          .order("data_pagamento", { ascending: false });

        if (!error && data && data.length > 0) {
          for (const p of data) {
            lista.push({
              id: p.id,
              data: p.data_pagamento || p.created_at,
              valor: p.valor_pago,
              operador: p.operador_email || "Operador",
              detalhes: p.detalhes,
            });
          }
        }
      } catch (_) {}

      // 2. Tentar ler do JSON armazenado em row.origem
      if (row.origem) {
        try {
          const parsed = JSON.parse(row.origem);
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              const jaExiste = lista.some(
                x => Math.abs(new Date(x.data).getTime() - new Date(item.data).getTime()) < 3000 && x.valor === item.valor
              );
              if (!jaExiste) {
                lista.push({
                  data: item.data,
                  valor: item.valor,
                  operador: item.operador,
                  detalhes: item.detalhes,
                });
              }
            }
          }
        } catch (_) {}
      }

      // Ordenar do mais recente para o mais antigo
      lista.sort((a, b) => new Date(b.data).getTime() - new Date(a.data).getTime());
      setLogs(lista);
      setLoading(false);
    }

    carregarLogs();
  }, [row]);

  return (
    <Painel onClose={onClose} wide>
      <div style={{ padding: 20, display: "grid", gap: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", flexWrap: "wrap", gap: 10 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <h2 style={{ margin: 0 }}>Histórico de Auditoria da Promissória</h2>
              <StatusPill r={row} />
            </div>
            <div className="sub" style={{ marginTop: 4 }}>
              Registro de todas as baixas com data, valor e operador responsável
            </div>
          </div>
          <button className="btn ghost" onClick={onClose}>Fechar</button>
        </div>

        {/* Card com resumo da promissória */}
        <div style={{ background: "var(--soft)", padding: "12px 16px", borderRadius: 10, border: "1px solid var(--line)", display: "grid", gap: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <div>
              <span className="sub">Cliente:</span>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{row.cliente_nome}</div>
            </div>
            <div>
              <span className="sub">Telefone:</span>
              <div className="mono">{row.telefone || "—"}</div>
            </div>
            <div>
              <span className="sub">Parcela:</span>
              <div style={{ fontWeight: 600 }}>{row.parcelas || "1X"}</div>
            </div>
            <div>
              <span className="sub">Vencimento:</span>
              <div className="mono">{dt(row.vencimento)}</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 20, marginTop: 4, borderTop: "1px solid var(--line)", paddingTop: 8, fontSize: 13, flexWrap: "wrap" }}>
            <span>Dívida original: <b className="mono">{money(row.divida_total)}</b></span>
            <span>Total pago: <b className="mono" style={{ color: "#15803d" }}>{money(row.valor_pago)}</b></span>
            <span>Saldo devedor: <b className="mono">{money(row.saldo_devedor)}</b></span>
          </div>
        </div>

        {/* Lista de Registros */}
        <div>
          <h3 style={{ margin: "8px 0 10px", fontSize: 15 }}>Registros de Auditoria</h3>
          {loading ? (
            <div className="sub" style={{ padding: 14 }}>Carregando histórico de auditoria…</div>
          ) : logs.length > 0 ? (
            <div style={{ display: "grid", gap: 10 }}>
              {logs.map((item, idx) => (
                <div
                  key={idx}
                  style={{
                    background: "var(--card)",
                    border: "1px solid var(--line)",
                    borderRadius: 10,
                    padding: "12px 16px",
                    display: "grid",
                    gap: 6,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#15803d", background: "#15803d15", padding: "3px 10px", borderRadius: 99 }}>
                        Baixa de {money(item.valor)}
                      </span>
                      <span className="mono" style={{ fontSize: 13, color: "var(--ink)", fontWeight: 600 }}>
                        {dtHora(item.data)}
                      </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <div style={{ fontSize: 12, color: "var(--mut)" }}>
                        Operador: <b style={{ color: "var(--ink)" }}>{item.operador}</b>
                      </div>
                      <button
                        type="button"
                        className="ed"
                        style={{ fontSize: 11, padding: "2px 8px" }}
                        title="Enviar comprovante deste pagamento por WhatsApp"
                        onClick={() => {
                          const numPagamento = Math.max(1, logs.length - idx);
                          const info = extrairInfoParcelas(row.parcelas, row.divida_total, numPagamento);
                          const msg = mensagemComprovanteBaixa({
                            nome: row.cliente_nome,
                            valorTotalCompra: info.valorTotalCompra,
                            totalParcelas: info.totalParcelas,
                            valorPago: item.valor,
                            parcela: info.rotuloParcela,
                            valorRestante: row.saldo_devedor,
                            dataPagamento: dtHora(item.data),
                          });
                          setWhatsLog(msg);
                        }}
                      >
                        Comprovante WhatsApp
                      </button>
                    </div>
                  </div>
                  {item.detalhes && (
                    <div className="sub" style={{ fontSize: 13, color: "var(--mut)", marginTop: 2 }}>
                      {item.detalhes}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div
              style={{
                background: "var(--soft)",
                border: "1px dashed var(--line)",
                borderRadius: 10,
                padding: "18px 20px",
                textAlign: "center",
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
                Nenhum log detalhado encontrado
              </div>
              <div className="sub" style={{ fontSize: 13 }}>
                {row.valor_pago > 0
                  ? `Esta promissória possui R$ ${(row.valor_pago / 100).toFixed(2)} registrado como pago no cadastro (${row.origem || "SISTEMA ANTERIOR"}). Todas as baixas realizadas no sistema registram data, valor e operador automaticamente nesta aba.`
                  : "Nenhum pagamento foi registrado para esta promissória ainda."}
              </div>
            </div>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
          <button className="btn ghost" onClick={onClose}>Fechar</button>
        </div>
      </div>
      {whatsLog && (
        <WhatsDialog
          nome={row.cliente_nome}
          telefone={row.telefone}
          mensagem={whatsLog}
          onClose={() => setWhatsLog(null)}
        />
      )}
    </Painel>
  );
}

/**
 * Diálogo para desmembrar um carnê agrupado (ex: 8X) em parcelas mensais individuais (1/8 a 8/8)
 */
export function DesmembrarDialog({
  row,
  onClose,
  onSaved,
}: {
  row: Row;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const parcelas = useMemo(() => gerarParcelasDesmembradas(row), [row]);
  const info = useMemo(() => extrairInfoParcelas(row.parcelas), [row.parcelas]);

  const handleConfirmar = async () => {
    if (parcelas.length <= 1) {
      setErr("Esta promissória não é um carnê agrupado ou possui apenas 1 parcela.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      // 1. Atualizar a 1ª parcela mantendo o registro original (ID) para não quebrar referências
      const p1 = parcelas[0];
      const { error: err1 } = await supabase
        .from("promissorias")
        .update({
          parcelas: p1.parcelas,
          divida_total: p1.divida_total,
          valor_pago: p1.valor_pago,
          vencimento: p1.vencimento,
        })
        .eq("id", row.id);

      if (err1) throw err1;

      // 2. Inserir as demais parcelas (2/N até N/N)
      const demais = parcelas.slice(1).map(p => {
        return {
          cliente_nome: p.cliente_nome,
          telefone: p.telefone,
          divida_total: p.divida_total,
          valor_pago: p.valor_pago,
          parcelas: p.parcelas,
          vencimento: p.vencimento,
          origem: `DESMEMBRADO DO ID #${row.id} (${row.parcelas})`,
          fundo_perdido: false,
          fundo_perdido_motivo: null,
          fundo_perdido_em: null,
        };
      });

      const { error: err2 } = await supabase.from("promissorias").insert(demais);
      if (err2) throw err2;

      onSaved();
    } catch (e: any) {
      setErr(e.message || "Erro ao desmembrar parcelas no banco de dados.");
      setBusy(false);
    }
  };

  return (
    <Painel onClose={onClose} wide>
      <div style={{ padding: 22, display: "grid", gap: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 18, color: "var(--ink)" }}>
              ✂️ Desmembrar Carnê em Parcelas Individuais
            </h3>
            <div className="sub" style={{ marginTop: 4 }}>
              Cliente: <b>{row.cliente_nome}</b> {row.telefone ? `· ${row.telefone}` : ""}
            </div>
          </div>
          <button className="btn ghost" onClick={onClose} disabled={busy}>Fechar</button>
        </div>

        {err && <div className="err">{err}</div>}

        <div style={{
          background: "rgba(10, 124, 76, 0.08)",
          border: "1px solid rgba(10, 124, 76, 0.25)",
          borderRadius: 8,
          padding: "12px 16px",
          fontSize: 13,
          lineHeight: 1.5,
          color: "var(--ink)",
        }}>
          <b>💡 Como funciona o desmembramento:</b>
          <br />
          Esta venda foi registrada como uma única promissória de <b>{money(row.divida_total)}</b> em <b>{row.parcelas}</b>.
          Ao confirmar, o sistema transformará o registro atual na <b>Parcela 1/{info.totalParcelas}</b> e criará individualmente as parcelas <b>2/{info.totalParcelas}</b> até <b>{info.totalParcelas}/{info.totalParcelas}</b>, com seus respectivos vencimentos mês a mês.
          O valor pago (<b>{money(row.valor_pago)}</b>) será abatido ordenadamente, eliminando cobranças e status de vencido indevidos!
        </div>

        <div className="kpis" style={{ margin: 0 }}>
          <div className="card"><small>Dívida total do carnê</small><b>{money(row.divida_total)}</b></div>
          <div className="card"><small>Já pago pelo cliente</small><b style={{ color: "var(--brand)" }}>{money(row.valor_pago)}</b></div>
          <div className="card hl"><small>Saldo a receber</small><b>{money(row.saldo_devedor)}</b></div>
          <div className="card"><small>Novas parcelas</small><b>{parcelas.length} parcelas</b></div>
        </div>

        <div>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
            📋 Pré-visualização das parcelas que serão geradas:
          </div>
          <div className="wrap" style={{ maxHeight: 280, overflowY: "auto" }}>
            <table style={{ width: "100%", fontSize: 13 }}>
              <thead>
                <tr>
                  <th>Parcela</th>
                  <th>Vencimento</th>
                  <th className="n">Valor</th>
                  <th className="n">Pago</th>
                  <th className="n">Saldo</th>
                  <th>Status Previsto</th>
                </tr>
              </thead>
              <tbody>
                {parcelas.map((p, idx) => {
                  const s = deriveStatus(p);
                  return (
                    <tr key={idx} style={{ background: idx === 0 ? "var(--soft)" : "transparent" }}>
                      <td className="mono"><b>{p.parcelas}</b> {idx === 0 && <small style={{ color: "var(--mut)" }}>(ID #{row.id})</small>}</td>
                      <td className="mono">{dt(p.vencimento)}</td>
                      <td className="n">{money(p.divida_total)}</td>
                      <td className="n" style={{ color: p.valor_pago > 0 ? "var(--brand)" : "inherit" }}>{money(p.valor_pago)}</td>
                      <td className="n"><b>{money(p.saldo_devedor)}</b></td>
                      <td>
                        <span className={`pill p-${cls(s)}`}>
                          {LBL[s]}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
          <span className="sub" style={{ fontSize: 12 }}>
            A operação é segura e preserva histórico e registros de auditoria.
          </span>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn ghost" onClick={onClose} disabled={busy}>Cancelar</button>
            <button className="btn" onClick={handleConfirmar} disabled={busy || parcelas.length <= 1}>
              {busy ? "Desmembrando..." : `Confirmar Desmembramento (${parcelas.length}x)`}
            </button>
          </div>
        </div>
      </div>
    </Painel>
  );
}

/**
 * Assistente de Varredura do Sistema: identifica carnês agrupados (NX) que geram falsas pendências
 * e permite desmembrá-los individualmente ou em lote com 1 clique.
 */
export function VarreduraParcelasDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [carnes, setCarnes] = useState<Row[]>([]);
  const [busca, setBusca] = useState("");
  const [processandoLote, setProcessandoLote] = useState(false);
  const [progresso, setProgresso] = useState<{ total: number; atual: number; sucesso: number; erros: number } | null>(null);
  const [desmembrarIndividual, setDesmembrarIndividual] = useState<Row | null>(null);
  const [sucessoMsg, setSucessoMsg] = useState("");

  const carregarCarnes = useCallback(async () => {
    setLoading(true);
    setSucessoMsg("");
    try {
      // Buscar promissórias em aberto
      const { data, error } = await supabase
        .from("promissorias")
        .select("*")
        .gt("saldo_devedor", 0)
        .order("vencimento", { ascending: true });

      if (error) throw error;

      // Filtrar apenas as que são carnês agrupados NX (ex: 2X, 3X, 8X...)
      const agrupados = (data || []).filter(r => {
        if (r.fundo_perdido) return false;
        const info = extrairInfoParcelas(r.parcelas);
        return info.ehCarnetAgrupado && info.totalParcelas > 1;
      });

      setCarnes(agrupados as Row[]);
    } catch (e: any) {
      console.error("Erro ao carregar carnês:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    carregarCarnes();
  }, [carregarCarnes]);

  // Estatísticas calculadas
  const stats = useMemo(() => {
    let falsasPendencias = 0;
    let totalDivida = 0;
    let totalPago = 0;
    let totalSaldo = 0;

    carnes.forEach(c => {
      totalDivida += c.divida_total;
      totalPago += c.valor_pago;
      totalSaldo += c.saldo_devedor;

      const vencReal = obterVencimentoEfetivo(c);
      const hj = hoje();
      // Se a data original do carnê venceu, mas a data real com os pagamentos já feitos ainda NÃO venceu
      if (c.vencimento && c.vencimento < hj && vencReal && vencReal >= hj) {
        falsasPendencias++;
      }
    });

    return {
      totalCarnes: carnes.length,
      falsasPendencias,
      totalDivida,
      totalPago,
      totalSaldo,
    };
  }, [carnes]);

  const filtrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return carnes;
    return carnes.filter(c =>
      c.cliente_nome.toLowerCase().includes(q) ||
      (c.telefone && c.telefone.includes(q)) ||
      (c.parcelas && c.parcelas.toLowerCase().includes(q))
    );
  }, [carnes, busca]);

  // Desmembramento de um único registro
  const executarDesmembramento = async (row: Row) => {
    const parcelas = gerarParcelasDesmembradas(row);
    if (parcelas.length <= 1) return false;

    // 1. Atualizar parcela 1
    const p1 = parcelas[0];
    const { error: err1 } = await supabase
      .from("promissorias")
      .update({
        parcelas: p1.parcelas,
        divida_total: p1.divida_total,
        valor_pago: p1.valor_pago,
        vencimento: p1.vencimento,
      })
      .eq("id", row.id);

    if (err1) throw err1;

    // 2. Inserir demais parcelas
    const demais = parcelas.slice(1).map(p => {
      return {
        cliente_nome: p.cliente_nome,
        telefone: p.telefone,
        divida_total: p.divida_total,
        valor_pago: p.valor_pago,
        parcelas: p.parcelas,
        vencimento: p.vencimento,
        origem: `DESMEMBRADO DO ID #${row.id} (${row.parcelas})`,
        fundo_perdido: false,
        fundo_perdido_motivo: null,
        fundo_perdido_em: null,
      };
    });

    const { error: err2 } = await supabase.from("promissorias").insert(demais);
    if (err2) throw err2;

    return true;
  };

  // Desmembramento em lote
  const handleDesmembrarEmLote = async () => {
    if (carnes.length === 0) return;
    const ok = window.confirm(
      `Deseja desmembrar todos os ${carnes.length} carnês agrupados em parcelas mensais individuais?\n\nEsta operação regulariza os vencimentos mês a mês e remove pendências falsas de clientes que estão em dia.`
    );
    if (!ok) return;

    setProcessandoLote(true);
    let sucesso = 0;
    let erros = 0;
    const total = carnes.length;
    setProgresso({ total, atual: 0, sucesso: 0, erros: 0 });

    for (let i = 0; i < total; i++) {
      const c = carnes[i];
      try {
        await executarDesmembramento(c);
        sucesso++;
      } catch (e) {
        console.error(`Erro ao desmembrar carnê #${c.id}:`, e);
        erros++;
      }
      setProgresso({ total, atual: i + 1, sucesso, erros });
    }

    setProcessandoLote(false);
    setSucessoMsg(`🎉 Operação concluída com sucesso! ${sucesso} carnê(s) foram desmembrados em parcelas mensais.`);
    await carregarCarnes();
    onDone();
  };

  return (
    <Painel onClose={onClose} wide>
      <div style={{ padding: 22, display: "grid", gap: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", flexWrap: "wrap", gap: 10 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 20, color: "var(--ink)", display: "flex", alignItems: "center", gap: 8 }}>
              <span>🔍</span> Varredura de Carnês e Parcelamento
            </h2>
            <div className="sub" style={{ marginTop: 4 }}>
              Auditoria de promissórias agrupadas (ex: 8X) que necessitam de parcelamento mensal para evitar falsas pendências.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn"
              onClick={handleDesmembrarEmLote}
              disabled={loading || processandoLote || carnes.length === 0}
              style={{ background: "var(--brand)", color: "#fff", display: "flex", alignItems: "center", gap: 6 }}
            >
              <span>⚡</span> Desmembrar Todos ({carnes.length})
            </button>
            <button className="btn ghost" onClick={onClose} disabled={processandoLote}>Fechar</button>
          </div>
        </div>

        {sucessoMsg && (
          <div style={{
            background: "rgba(10, 124, 76, 0.12)",
            color: "var(--brand)",
            border: "1px solid var(--brand)",
            borderRadius: 8,
            padding: "12px 16px",
            fontWeight: 600,
            fontSize: 14,
          }}>
            {sucessoMsg}
          </div>
        )}

        {processandoLote && progresso && (
          <div style={{
            background: "var(--soft)",
            border: "1px solid var(--line)",
            borderRadius: 8,
            padding: 16,
            display: "grid",
            gap: 8,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 600 }}>
              <span>Desmembrando carnês em parcelas mensais...</span>
              <span>{progresso.atual} de {progresso.total} ({Math.round((progresso.atual / progresso.total) * 100)}%)</span>
            </div>
            <div style={{ width: "100%", height: 10, background: "var(--line)", borderRadius: 5, overflow: "hidden" }}>
              <div
                style={{
                  width: `${(progresso.atual / progresso.total) * 100}%`,
                  height: "100%",
                  background: "var(--brand)",
                  transition: "width 0.2s ease",
                }}
              />
            </div>
            <div style={{ fontSize: 12, color: "var(--mut)" }}>
              {progresso.sucesso} processados com sucesso · {progresso.erros} erros
            </div>
          </div>
        )}

        <div className="kpis" style={{ margin: 0 }}>
          <div className="card">
            <small>Carnês agrupados</small>
            <b>{stats.totalCarnes}</b>
            <span className="ksub">promissórias com formato NX</span>
          </div>
          <div className="card" style={{ borderLeft: "4px solid #b42318" }}>
            <small>Falsas pendências (em dia)</small>
            <b style={{ color: stats.falsasPendencias > 0 ? "#b42318" : "var(--brand)" }}>
              {stats.falsasPendencias} clientes
            </b>
            <span className="ksub">em dia, mas marcados com atraso</span>
          </div>
          <div className="card">
            <small>Já pago nesses carnês</small>
            <b style={{ color: "var(--brand)" }}>{money(stats.totalPago)}</b>
            <span className="ksub">total amortizado pelos clientes</span>
          </div>
          <div className="card hl">
            <small>Saldo a receber</small>
            <b>{money(stats.totalSaldo)}</b>
            <span className="ksub">distribuído nos meses futuros</span>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <input
            type="search"
            placeholder="Filtrar por nome do cliente ou telefone..."
            value={busca}
            onChange={e => setBusca(e.target.value)}
            style={{ maxWidth: 360 }}
          />
          <span className="sub" style={{ fontSize: 12 }}>
            Mostrando <b>{filtrados.length}</b> de <b>{carnes.length}</b> registros
          </span>
        </div>

        <div className="wrap" style={{ maxHeight: 380, overflowY: "auto" }}>
          <table style={{ width: "100%" }}>
            <thead>
              <tr>
                <th>Cliente / Telefone</th>
                <th>Carnê</th>
                <th>1º Vencimento</th>
                <th>Próx. Venc. Real</th>
                <th className="n">Dívida Total</th>
                <th className="n">Já Pago</th>
                <th className="n">Saldo</th>
                <th>Diagnóstico</th>
                <th style={{ textAlign: "right" }}>Ação</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={9} style={{ textAlign: "center", padding: 30, color: "var(--mut)" }}>
                    Carregando carnês do sistema...
                  </td>
                </tr>
              ) : filtrados.length === 0 ? (
                <tr>
                  <td colSpan={9} style={{ textAlign: "center", padding: 30, color: "var(--mut)" }}>
                    {busca ? "Nenhum carnê corresponde à busca." : "Nenhum carnê agrupado pendente encontrado!"}
                  </td>
                </tr>
              ) : (
                filtrados.map(c => {
                  const vencReal = obterVencimentoEfetivo(c);
                  const hj = hoje();
                  const falsoVencido = c.vencimento && c.vencimento < hj && vencReal && vencReal >= hj;

                  return (
                    <tr key={c.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{c.cliente_nome}</div>
                        <div className="sub mono" style={{ fontSize: 11 }}>{c.telefone || "Sem telefone"}</div>
                      </td>
                      <td className="mono"><b>{c.parcelas}</b></td>
                      <td className="mono">{dt(c.vencimento)}</td>
                      <td className="mono">
                        <span style={{
                          color: falsoVencido ? "var(--brand)" : "inherit",
                          fontWeight: falsoVencido ? 700 : 500,
                        }}>
                          {dt(vencReal)}
                        </span>
                      </td>
                      <td className="n">{money(c.divida_total)}</td>
                      <td className="n" style={{ color: c.valor_pago > 0 ? "var(--brand)" : "inherit" }}>
                        {money(c.valor_pago)}
                      </td>
                      <td className="n"><b>{money(c.saldo_devedor)}</b></td>
                      <td>
                        {falsoVencido ? (
                          <span
                            className="pill p-pago"
                            style={{ background: "rgba(10, 124, 76, 0.12)", color: "var(--brand)", fontSize: 11 }}
                            title="O cliente já pagou as parcelas que venceram e está rigorosamente EM DIA. A pendência é falsa devido ao carnê estar agrupado."
                          >
                            ⭐ Em dia (Falso atraso)
                          </span>
                        ) : (
                          <StatusPill r={c} />
                        )}
                      </td>
                      <td className="acts">
                        <button
                          className="ed"
                          onClick={() => setDesmembrarIndividual(c)}
                          disabled={processandoLote}
                          style={{ color: "var(--brand)", fontWeight: 600 }}
                          title="Desmembrar este carnê em parcelas mensais"
                        >
                          Desmembrar
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span className="sub" style={{ fontSize: 12 }}>
            💡 Dica: Após desmembrar, cada parcela terá seu próprio vencimento mês a mês e o score do cliente refletirá a pontualidade real.
          </span>
          <button className="btn ghost" onClick={onClose} disabled={processandoLote}>Fechar</button>
        </div>
      </div>

      {desmembrarIndividual && (
        <DesmembrarDialog
          row={desmembrarIndividual}
          onClose={() => setDesmembrarIndividual(null)}
          onSaved={() => {
            setDesmembrarIndividual(null);
            carregarCarnes();
            onDone();
          }}
        />
      )}
    </Painel>
  );
}
