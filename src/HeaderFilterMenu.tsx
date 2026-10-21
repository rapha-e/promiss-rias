import React, { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { SortIcon } from "./SortIcon";

export type FilterOption = {
  label: string;
  value: string;
  active: boolean;
  badge?: number | string;
};

interface HeaderFilterMenuProps {
  title: string;
  col: string;
  sortCol: string;
  sortAsc: boolean;
  onSort: (col: string, asc?: boolean) => void;
  isFiltered: boolean;
  align?: "left" | "right";
  options?: FilterOption[];
  onSelectOption?: (val: string) => void;
  customFilterContent?: ReactNode;
  onClearFilter?: () => void;
  filterLabel?: string;
}

export function HeaderFilterMenu({
  title,
  col,
  sortCol,
  sortAsc,
  onSort,
  isFiltered,
  align = "left",
  options,
  onSelectOption,
  customFilterContent,
  onClearFilter,
  filterLabel,
}: HeaderFilterMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const isCurrentSort = col === sortCol;

  // Fecha o menu ao pressionar Escape
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  return (
    <th
      className={`sortable ${isCurrentSort ? "active" : ""} ${align === "right" ? "n" : ""}`}
      style={{ position: "relative", userSelect: "none" }}
    >
      <div
        className="th-content"
        onClick={() => setOpen(prev => !prev)}
        title={`Clique para filtrar ou ordenar por ${title}`}
        style={{
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          justifyContent: align === "right" ? "flex-end" : "flex-start",
        }}
      >
        <span>{title}</span>
        <SortIcon col={col} sortCol={sortCol} sortAsc={sortAsc} />

        {/* Ícone de filtro */}
        <span
          className={`filter-btn-icon ${isFiltered ? "active" : ""}`}
          title={isFiltered ? `Filtro ativo: ${filterLabel || "Sim"}` : `Filtrar por ${title}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 18,
            height: 18,
            borderRadius: 4,
            background: isFiltered ? "var(--brand)" : "transparent",
            color: isFiltered ? "var(--brand-ink)" : "var(--mut)",
            transition: "all .15s ease",
            marginLeft: 2,
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill={isFiltered ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
          </svg>
        </span>
      </div>

      {/* Dropdown Menu */}
      {open && (
        <>
          {/* Backdrop para fechar ao clicar fora */}
          <div
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 99,
              cursor: "default",
            }}
            onClick={e => {
              e.stopPropagation();
              setOpen(false);
            }}
          />

          <div
            ref={menuRef}
            onClick={e => e.stopPropagation()}
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              [align === "right" ? "right" : "left"]: 0,
              zIndex: 100,
              background: "var(--card)",
              border: "1px solid var(--line)",
              borderRadius: 12,
              padding: 10,
              boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
              minWidth: 230,
              maxWidth: 300,
              color: "var(--ink)",
              fontWeight: "normal",
              textTransform: "none",
              letterSpacing: "normal",
              fontSize: 13,
              display: "flex",
              flexDirection: "column",
              gap: 8,
              animation: "in .2s ease both",
            }}
          >
            {/* Cabeçalho do Menu */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                borderBottom: "1px solid var(--line)",
                paddingBottom: 6,
                fontWeight: 700,
                fontSize: 12,
                color: "var(--mut)",
                textTransform: "uppercase",
                letterSpacing: ".05em",
              }}
            >
              <span>{title}</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                style={{
                  background: "none",
                  border: 0,
                  cursor: "pointer",
                  color: "var(--mut)",
                  padding: "0 4px",
                  fontSize: 14,
                  lineHeight: 1,
                }}
              >
                ✕
              </button>
            </div>

            {/* Seção 1: Ordenação */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--mut)", marginBottom: 4, textTransform: "uppercase" }}>
                Ordenar:
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                <button
                  type="button"
                  className={`btn ghost ${isCurrentSort && sortAsc ? "on" : ""}`}
                  style={{
                    flex: 1,
                    padding: "6px 8px",
                    fontSize: 12,
                    textAlign: "center",
                    borderRadius: 8,
                    background: isCurrentSort && sortAsc ? "var(--brand)" : "transparent",
                    color: isCurrentSort && sortAsc ? "var(--brand-ink)" : "inherit",
                    borderColor: isCurrentSort && sortAsc ? "var(--brand)" : "var(--line)",
                  }}
                  onClick={() => {
                    onSort(col, true);
                    setOpen(false);
                  }}
                >
                  ▲ {col === "cliente_nome" ? "A → Z" : col === "vencimento" ? "Antigo" : "Crescente"}
                </button>
                <button
                  type="button"
                  className={`btn ghost ${isCurrentSort && !sortAsc ? "on" : ""}`}
                  style={{
                    flex: 1,
                    padding: "6px 8px",
                    fontSize: 12,
                    textAlign: "center",
                    borderRadius: 8,
                    background: isCurrentSort && !sortAsc ? "var(--brand)" : "transparent",
                    color: isCurrentSort && !sortAsc ? "var(--brand-ink)" : "inherit",
                    borderColor: isCurrentSort && !sortAsc ? "var(--brand)" : "var(--line)",
                  }}
                  onClick={() => {
                    onSort(col, false);
                    setOpen(false);
                  }}
                >
                  ▼ {col === "cliente_nome" ? "Z → A" : col === "vencimento" ? "Recente" : "Decrescente"}
                </button>
              </div>
            </div>

            {/* Seção 2: Filtros */}
            {(options && options.length > 0 || customFilterContent) && (
              <div style={{ borderTop: "1px solid var(--line)", paddingTop: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "var(--mut)", marginBottom: 6, textTransform: "uppercase" }}>
                  Filtrar por {title}:
                </div>

                {customFilterContent}

                {options && options.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight: 200, overflowY: "auto" }}>
                    {options.map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => {
                          onSelectOption?.(opt.value);
                          setOpen(false);
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          width: "100%",
                          textAlign: "left",
                          padding: "6px 8px",
                          borderRadius: 8,
                          border: 0,
                          background: opt.active ? "var(--soft)" : "transparent",
                          color: opt.active ? "var(--brand)" : "var(--ink)",
                          fontWeight: opt.active ? 700 : 500,
                          cursor: "pointer",
                          fontSize: 12.5,
                          transition: "background .15s ease",
                        }}
                      >
                        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ width: 14, textAlign: "center" }}>{opt.active ? "✓" : ""}</span>
                          <span>{opt.label}</span>
                        </span>
                        {opt.badge !== undefined && (
                          <span
                            style={{
                              fontSize: 11,
                              color: "var(--mut)",
                              background: "rgba(0,0,0,0.05)",
                              padding: "1px 6px",
                              borderRadius: 99,
                            }}
                          >
                            {opt.badge}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Seção 3: Limpar Filtro */}
            {isFiltered && onClearFilter && (
              <div style={{ borderTop: "1px solid var(--line)", paddingTop: 6, marginTop: 2 }}>
                <button
                  type="button"
                  onClick={() => {
                    onClearFilter();
                    setOpen(false);
                  }}
                  style={{
                    width: "100%",
                    padding: "6px 8px",
                    background: "rgba(180, 35, 24, 0.08)",
                    border: "1px solid rgba(180, 35, 24, 0.2)",
                    borderRadius: 8,
                    color: "var(--bad)",
                    cursor: "pointer",
                    fontSize: 12,
                    fontWeight: 600,
                    textAlign: "center",
                  }}
                >
                  ✕ Limpar filtro de {title}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </th>
  );
}
