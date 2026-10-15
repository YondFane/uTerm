import { memo, useEffect, useRef, useState } from "react";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { databaseCellText, databaseClipboard, type DatabaseResult } from "../lib/database";

export const DatabaseGrid = memo(function DatabaseGrid({
  result,
  report,
}: {
  result: DatabaseResult | null;
  report: (message: string) => void;
}) {
  useUiLanguage();
  const [anchor, setAnchor] = useState<[number, number] | null>(null);
  const [focus, setFocus] = useState<[number, number] | null>(null);
  const [widths, setWidths] = useState<Record<number, number>>({});
  const [value, setValue] = useState<string | null>(null);
  const dragging = useRef(false);
  const detail = useRef<HTMLDialogElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setAnchor(null);
    setFocus(null);
    setWidths({});
    setValue(null);
  }, [result]);
  useEffect(() => {
    if (value !== null) detail.current?.showModal();
    else detail.current?.close();
  }, [value]);
  const range: [number, number, number, number] | null =
    anchor && focus
      ? [
          Math.min(anchor[0], focus[0]),
          Math.min(anchor[1], focus[1]),
          Math.max(anchor[0], focus[0]),
          Math.max(anchor[1], focus[1]),
        ]
      : null;
  async function copy(headers = false) {
    if (!result || !range) return;
    try {
      await navigator.clipboard.writeText(databaseClipboard(result, range, headers));
    } catch {
      report(tx("无法复制结果。"));
    }
  }
  const rows = result?.rows ?? [];
  const columns = result?.columns ?? [];
  return (
    <>
      <div className="database-grid-actions">
        <button disabled={!range} onClick={() => void copy()}>
          {tx("复制选区")}
        </button>
        <button disabled={!range} onClick={() => void copy(true)}>
          {tx("带表头复制")}
        </button>
        <span>
          {range
            ? tx("已选择 {rows} 行 × {columns} 列", {
                rows: range[2] - range[0] + 1,
                columns: range[3] - range[1] + 1,
              })
            : tx("拖动选择区域，双击查看值")}
        </span>
      </div>
      <div
        className="database-results"
        ref={grid}
        tabIndex={0}
        aria-label={tx("结果表格")}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
        onCopy={(event) => {
          if (result && range && !window.getSelection()?.toString()) {
            event.preventDefault();
            event.clipboardData.setData("text/plain", databaseClipboard(result, range));
          }
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === "a" &&
            rows.length &&
            columns.length
          ) {
            event.preventDefault();
            event.stopPropagation();
            setAnchor([0, 0]);
            setFocus([rows.length - 1, columns.length - 1]);
          } else if (
            ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) &&
            rows.length &&
            columns.length
          ) {
            event.preventDefault();
            event.stopPropagation();
            const next: [number, number] = [
              Math.max(
                0,
                Math.min(
                  rows.length - 1,
                  (focus?.[0] ?? 0) +
                    (event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0),
                ),
              ),
              Math.max(
                0,
                Math.min(
                  columns.length - 1,
                  (focus?.[1] ?? 0) +
                    (event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0),
                ),
              ),
            ];
            if (!event.shiftKey || !anchor) setAnchor(next);
            setFocus(next);
            grid.current
              ?.querySelector(`[data-cell="${next[0]}:${next[1]}"]`)
              ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
          } else if (event.key === "Enter" && focus) {
            event.preventDefault();
            setValue(databaseCellText(rows[focus[0]][focus[1]]));
          }
        }}
      >
        {columns.length ? (
          <table aria-label={tx("查询结果")}>
            <thead>
              <tr>
                <th className="database-row-number">#</th>
                {columns.map((column, index) => (
                  <th
                    key={index}
                    style={{
                      width: widths[index] ?? 160,
                      minWidth: widths[index] ?? 160,
                      maxWidth: widths[index] ?? 160,
                    }}
                    title={column.type}
                  >
                    <span>{column.name}</span>
                    <small>{column.type}</small>
                    <div
                      role="separator"
                      tabIndex={0}
                      aria-label={tx("调整列宽：{name}", { name: column.name })}
                      aria-orientation="vertical"
                      aria-valuemin={60}
                      aria-valuemax={800}
                      aria-valuenow={widths[index] ?? 160}
                      className="database-column-resizer"
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.currentTarget.focus();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        event.currentTarget.dataset.startX = String(event.clientX);
                        event.currentTarget.dataset.startWidth = String(widths[index] ?? 160);
                      }}
                      onPointerMove={(event) => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                          const width = Math.max(
                            60,
                            Math.min(
                              800,
                              Number(event.currentTarget.dataset.startWidth) +
                                event.clientX -
                                Number(event.currentTarget.dataset.startX),
                            ),
                          );
                          setWidths((previous) => ({
                            ...previous,
                            [index]: width,
                          }));
                        }
                      }}
                      onPointerUp={(event) => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId))
                          event.currentTarget.releasePointerCapture(event.pointerId);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                          event.preventDefault();
                          event.stopPropagation();
                          setWidths((previous) => ({
                            ...previous,
                            [index]: Math.max(
                              60,
                              Math.min(
                                800,
                                (previous[index] ?? 160) + (event.key === "ArrowRight" ? 20 : -20),
                              ),
                            ),
                          }));
                        }
                      }}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  <th scope="row">
                    <button
                      aria-label={tx("选择第 {row} 行", { row: rowIndex + 1 })}
                      onClick={() => {
                        setAnchor([rowIndex, 0]);
                        setFocus([rowIndex, columns.length - 1]);
                        grid.current?.focus();
                      }}
                    >
                      {rowIndex + 1}
                    </button>
                  </th>
                  {row.map((cell, columnIndex) => {
                    const text = databaseCellText(cell);
                    const selected =
                      !!range &&
                      rowIndex >= range[0] &&
                      rowIndex <= range[2] &&
                      columnIndex >= range[1] &&
                      columnIndex <= range[3];
                    return (
                      <td
                        key={columnIndex}
                        data-cell={`${rowIndex}:${columnIndex}`}
                        data-selected={selected || undefined}
                        style={{
                          width: widths[columnIndex] ?? 160,
                          maxWidth: widths[columnIndex] ?? 160,
                        }}
                        onPointerDown={(event) => {
                          if (event.button !== 0) return;
                          dragging.current = true;
                          if (!event.shiftKey || !anchor) setAnchor([rowIndex, columnIndex]);
                          setFocus([rowIndex, columnIndex]);
                          grid.current?.focus();
                        }}
                        onPointerEnter={(event) => {
                          if (dragging.current && event.buttons === 1)
                            setFocus([rowIndex, columnIndex]);
                          else if (!event.buttons) dragging.current = false;
                        }}
                        onDoubleClick={() => setValue(text)}
                        title={tx("双击查看已加载的完整值")}
                      >
                        {cell === null ? (
                          <em>{"NULL"}</em>
                        ) : text === "" ? (
                          <em>{tx("空字符串")}</em>
                        ) : (
                          text
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="database-empty">
            {result?.affected !== undefined
              ? tx("受影响行数：{count}", { count: result.affected })
              : result
                ? tx("没有返回数据")
                : tx("执行 SQL 或打开表查看数据")}
          </p>
        )}
      </div>
      <dialog ref={detail} className="database-value-dialog" onCancel={() => setValue(null)}>
        <h3>{tx("单元格值")}</h3>
        <pre>{value}</pre>
        <button onClick={() => setValue(null)}>{tx("关闭")}</button>
      </dialog>
    </>
  );
});
