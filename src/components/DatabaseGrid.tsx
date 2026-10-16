import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { tx } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import {
  databaseCellText,
  databaseClipboard,
  type DatabaseResult,
  type DatabaseChange,
} from "../lib/database";
import { databaseDraftRows } from "../lib/database-data";

const noChanges: DatabaseChange[] = [];

export const DatabaseGrid = memo(function DatabaseGrid({
  result,
  report,
  changes = noChanges,
  editable = false,
  busy = false,
  change,
  remove,
  add,
}: {
  result: DatabaseResult | null;
  report: (message: string) => void;
  changes?: DatabaseChange[];
  editable?: boolean;
  busy?: boolean;
  change?: (row: number, column: number, value: string | null) => void;
  remove?: (row: number) => void;
  add?: () => void;
}) {
  useUiLanguage();
  const [anchor, setAnchor] = useState<[number, number] | null>(null);
  const [focus, setFocus] = useState<[number, number] | null>(null);
  const [widths, setWidths] = useState<Record<number, number>>({});
  const [value, setValue] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<[number, number] | null>(null);
  const [input, setInput] = useState("");
  const [nullValue, setNullValue] = useState(false);
  const [editError, setEditError] = useState("");
  const dragging = useRef(false);
  const detail = useRef<HTMLDialogElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, left: 0, height: 600, width: 800 });
  const frame = useRef<number | null>(null);
  const measure = useCallback(() => {
    frame.current = null;
    const element = grid.current;
    if (element)
      setViewport((previous) => {
        const next = {
          top: element.scrollTop,
          left: element.scrollLeft,
          height: element.clientHeight || previous.height,
          width: element.clientWidth || previous.width,
        };
        return Object.keys(next).every(
          (key) => next[key as keyof typeof next] === previous[key as keyof typeof previous],
        )
          ? previous
          : next;
      });
  }, []);
  useEffect(() => {
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (grid.current) observer?.observe(grid.current);
    return () => {
      observer?.disconnect();
      if (frame.current !== null) window.cancelAnimationFrame?.(frame.current);
    };
  }, [result, measure]);
  useEffect(() => {
    setAnchor(null);
    setFocus(null);
    setWidths({});
    setValue(null);
    setFilter("");
    setEditing(null);
    if (grid.current) {
      grid.current.scrollTop = 0;
      grid.current.scrollLeft = 0;
    }
    measure();
  }, [result]);
  useEffect(() => {
    if (value !== null) detail.current?.showModal();
    else detail.current?.close();
  }, [value]);
  const entries = useMemo(() => databaseDraftRows(result, changes), [result, changes]);
  const visible = useMemo(() => {
    const match = filter.toLocaleLowerCase();
    return match
      ? entries.filter((entry) =>
          entry.cells.some((cell) => databaseCellText(cell).toLocaleLowerCase().includes(match)),
        )
      : entries;
  }, [entries, filter]);
  const rows = useMemo(() => visible.map((entry) => entry.cells), [visible]);
  const copiedResult = useMemo(() => ({ ...result, rows }), [result, rows]);
  const columns = result?.columns ?? [];
  const edges = useMemo(() => {
    const edges = [44];
    for (let index = 0; index < columns.length; index++)
      edges.push(edges.at(-1)! + (widths[index] ?? 160));
    return edges;
  }, [columns, widths]);
  const firstRow = Math.min(
    Math.max(0, rows.length - 1),
    Math.max(0, Math.floor(Math.max(0, viewport.top - 44) / 32) - 4),
  );
  const lastRow = Math.min(rows.length, firstRow + Math.ceil(viewport.height / 32) + 10);
  const firstColumn = Math.max(0, edges.findIndex((edge) => edge >= viewport.left) - 2);
  const endColumn = edges.findIndex((edge) => edge >= viewport.left + viewport.width);
  const lastColumn =
    endColumn < 0
      ? columns.length
      : Math.min(columns.length, Math.max(firstColumn + 1, endColumn + 2));
  const shownColumns = columns
    .map((column, index) => ({ column, index }))
    .slice(firstColumn, lastColumn);
  const leftSpace = edges[firstColumn] - 44;
  const rightSpace = edges.at(-1)! - edges[lastColumn];
  const renderedColumns =
    shownColumns.length + 1 + (leftSpace > 0 ? 1 : 0) + (rightSpace > 0 ? 1 : 0);
  function reveal(row: number, column: number) {
    const element = grid.current;
    if (!element) return;
    const top = 44 + row * 32;
    if (top < element.scrollTop + 44) element.scrollTop = top - 44;
    else if (top + 32 > element.scrollTop + (element.clientHeight || viewport.height))
      element.scrollTop = top + 32 - (element.clientHeight || viewport.height);
    if (edges[column] < element.scrollLeft + 44) element.scrollLeft = edges[column] - 44;
    else if (edges[column + 1] > element.scrollLeft + (element.clientWidth || viewport.width))
      element.scrollLeft = edges[column + 1] - (element.clientWidth || viewport.width);
    measure();
  }
  const partialRows = useMemo(() => new Set(result?.partial?.map((cell) => cell[0])), [result]);
  function canEdit(row: number, column: number) {
    const entry = visible[row];
    const field = result?.table?.columns[column];
    return (
      editable &&
      !busy &&
      !!field &&
      !!entry &&
      entry.change?.kind !== "delete" &&
      !partialRows.has(entry.index) &&
      (entry.change?.kind === "insert" ? !field.generated : field.editable)
    );
  }
  function inspect(row: number, column: number) {
    const cell = rows[row]?.[column];
    if (cell === undefined) return;
    setEditing(canEdit(row, column) ? [visible[row].index, column] : null);
    setInput(cell === null ? "" : databaseCellText(cell));
    setNullValue(
      cell === null &&
        !!result?.table?.columns[column].nullable &&
        !(
          visible[row].change?.kind === "insert" &&
          !Object.hasOwn(visible[row].change!.values, columns[column].name)
        ),
    );
    setValue(databaseCellText(cell));
    setEditError("");
  }
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
      await navigator.clipboard.writeText(databaseClipboard(copiedResult, range, headers));
    } catch {
      report(tx("无法复制结果。"));
    }
  }
  return (
    <>
      <div className="database-grid-actions">
        <button disabled={!range} onClick={() => void copy()}>
          {tx("复制选区")}
        </button>
        <button disabled={!range} onClick={() => void copy(true)}>
          {tx("带表头复制")}
        </button>
        <input
          aria-label={tx("筛选本页已加载结果")}
          placeholder={tx("筛选本页已加载结果")}
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            setAnchor(null);
            setFocus(null);
            if (grid.current) grid.current.scrollTop = 0;
            measure();
          }}
        />
        {editable && (
          <>
            <button
              disabled={busy || !focus || !canEdit(focus[0], focus[1])}
              onClick={() => focus && inspect(...focus)}
            >
              {tx("编辑单元格")}
            </button>
            <button
              disabled={busy || !focus || !visible[focus[0]]}
              onClick={() => focus && visible[focus[0]] && remove?.(visible[focus[0]].index)}
            >
              {focus && visible[focus[0]]?.change?.kind === "delete"
                ? tx("恢复当前行")
                : tx("删除当前行")}
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setFilter("");
                add?.();
              }}
            >
              {tx("新增行")}
            </button>
          </>
        )}
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
        onScroll={() => {
          if (frame.current === null) {
            if (window.requestAnimationFrame) frame.current = window.requestAnimationFrame(measure);
            else measure();
          }
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
        onCopy={(event) => {
          if (result && range && !window.getSelection()?.toString()) {
            event.preventDefault();
            event.clipboardData.setData("text/plain", databaseClipboard(copiedResult, range));
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
            reveal(...next);
          } else if (event.key === "Enter" && focus) {
            event.preventDefault();
            inspect(...focus);
          }
        }}
      >
        {columns.length ? (
          <table
            aria-label={tx("查询结果")}
            style={{ width: edges.at(-1), minWidth: edges.at(-1) }}
            aria-rowcount={rows.length + 1}
            aria-colcount={columns.length + 1}
          >
            <thead>
              <tr>
                <th className="database-row-number">#</th>
                {leftSpace > 0 && (
                  <th
                    className="database-grid-spacer"
                    style={{ width: leftSpace }}
                    aria-hidden="true"
                  />
                )}
                {shownColumns.map(({ column, index }) => (
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
                {rightSpace > 0 && (
                  <th
                    className="database-grid-spacer"
                    style={{ width: rightSpace }}
                    aria-hidden="true"
                  />
                )}
              </tr>
            </thead>
            <tbody>
              {firstRow > 0 && (
                <tr className="database-grid-spacer" aria-hidden="true">
                  <td colSpan={renderedColumns} style={{ height: firstRow * 32 }} />
                </tr>
              )}
              {rows.slice(firstRow, lastRow).map((row, renderedRow) => {
                const rowIndex = firstRow + renderedRow;
                return (
                  <tr
                    key={rowIndex}
                    aria-rowindex={rowIndex + 2}
                    data-deleted={visible[rowIndex].change?.kind === "delete" || undefined}
                  >
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
                    {leftSpace > 0 && (
                      <td
                        className="database-grid-spacer"
                        style={{ width: leftSpace }}
                        aria-hidden="true"
                      />
                    )}
                    {shownColumns.map(({ index: columnIndex }) => {
                      const cell = row[columnIndex];
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
                          data-edited={
                            (visible[rowIndex].change &&
                              Object.hasOwn(
                                visible[rowIndex].change!.values,
                                columns[columnIndex].name,
                              )) ||
                            undefined
                          }
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
                          onDoubleClick={() => inspect(rowIndex, columnIndex)}
                          title={tx("双击查看已加载的完整值")}
                        >
                          {visible[rowIndex].change?.kind === "insert" &&
                          !Object.hasOwn(
                            visible[rowIndex].change!.values,
                            columns[columnIndex].name,
                          ) ? (
                            <em>{tx("默认值")}</em>
                          ) : cell === null ? (
                            <em>{"NULL"}</em>
                          ) : text === "" ? (
                            <em>{tx("空字符串")}</em>
                          ) : (
                            text
                          )}
                        </td>
                      );
                    })}
                    {rightSpace > 0 && (
                      <td
                        className="database-grid-spacer"
                        style={{ width: rightSpace }}
                        aria-hidden="true"
                      />
                    )}
                  </tr>
                );
              })}
              {lastRow < rows.length && (
                <tr className="database-grid-spacer" aria-hidden="true">
                  <td colSpan={renderedColumns} style={{ height: (rows.length - lastRow) * 32 }} />
                </tr>
              )}
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
        {editing ? (
          <>
            <label>
              <input
                type="checkbox"
                checked={nullValue}
                disabled={!result?.table?.columns[editing[1]].nullable}
                onChange={(event) => setNullValue(event.target.checked)}
              />
              {"NULL"}
            </label>
            <textarea
              aria-label={tx("编辑单元格值")}
              value={input}
              disabled={nullValue}
              maxLength={16384}
              onChange={(event) => setInput(event.target.value)}
            />
            <button
              disabled={busy}
              onClick={() => {
                try {
                  change?.(editing[0], editing[1], nullValue ? null : input);
                  setValue(null);
                } catch (error) {
                  const message = String(error).includes("DB_INPUT_LIMIT")
                    ? tx("修改超过大小限制，请减少修改后重试。")
                    : tx("单元格值无效。");
                  setEditError(message);
                  report(message);
                }
              }}
            >
              {tx("暂存单元格修改")}
            </button>
            {editError && <p role="alert">{editError}</p>}
          </>
        ) : (
          <pre>{value}</pre>
        )}
        <button onClick={() => setValue(null)}>{tx("关闭")}</button>
      </dialog>
    </>
  );
});
