import { localizeMessage } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { tx } from "../lib/i18n";
import { useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist";
import worker from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type { OpenFile } from "../lib/file-document";
import { boundedPdfScale } from "../lib/pdf-limits";
import { usePdfMarks } from "../lib/usePdfMarks";

GlobalWorkerOptions.workerSrc = worker;
type Outline = { title: string; dest: unknown; items: Outline[] };

function PageCanvas({
  pdf,
  page,
  scale,
  report,
}: {
  pdf: PDFDocumentProxy;
  page: number;
  scale: number;
  report: (message: string) => void;
}) {
  const uiLanguage = useUiLanguage();

  const canvas = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(scale >= 0.5);
  useEffect(() => {
    if (scale >= 0.5 || !canvas.current) return;
    // Render thumbnails near the viewport and release offscreen backing buffers.
    // 仅渲染视口附近的缩略图，并释放离屏画布缓冲区。
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      rootMargin: "160px",
    });
    observer.observe(canvas.current);
    return () => observer.disconnect();
  }, [scale]);
  useEffect(() => {
    canvas.current
      ?.querySelector("canvas")
      ?.setAttribute("aria-label", tx("第 {p0} 页", { p0: page }));
  }, [uiLanguage, page]);
  useEffect(() => {
    if (!visible && scale < 0.5) return;
    let disposed = false;
    let cancel: (() => void) | undefined;
    let rendering = false;
    const target = window.document.createElement("canvas");
    target.setAttribute("aria-label", tx("第 {p0} 页", { p0: page }));
    canvas.current?.replaceChildren(target);
    void pdf
      .getPage(page)
      .then(async (value) => {
        if (disposed || !canvas.current) return;
        const base = value.getViewport({ scale: 1 });
        const viewport = value.getViewport({
          scale: boundedPdfScale(base.width, base.height, scale, scale < 0.5),
        });
        target.width = viewport.width;
        target.height = viewport.height;
        const context = target.getContext("2d");
        if (!context) throw new Error(tx("无法创建 PDF 画布。"));
        const task = value.render({ canvasContext: context, canvas: target, viewport });
        rendering = true;
        cancel = () => task.cancel();
        try {
          await task.promise;
          if (!disposed) target.dataset.rendered = "true";
        } finally {
          rendering = false;
          value.cleanup();
          if (disposed) {
            target.width = 0;
            target.height = 0;
          }
        }
      })
      .catch((reason) => {
        if (!disposed) report(String(reason));
      });
    return () => {
      disposed = true;
      cancel?.();
      target.remove();
      if (!rendering) {
        target.width = 0;
        target.height = 0;
      }
    };
  }, [pdf, page, scale, report, visible]);
  return <div ref={canvas} style={scale < 0.5 ? { minHeight: 160 } : undefined} />;
}

export function PdfReader({
  document,
  annotationsEnabled = true,
}: {
  document: OpenFile;
  annotationsEnabled?: boolean;
}) {
  useUiLanguage();

  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [tab, setTab] = useState("contents");
  const [outline, setOutline] = useState<Outline[]>([]);
  const [error, setError] = useState("");
  const [marking, setMarking] = useState(false);
  const highlights = usePdfMarks(document, annotationsEnabled);
  const marks = highlights.marks;
  const start = useRef<{ x: number; y: number } | null>(null);
  const key = `uterm.pdf.marks:${document.directory}/${document.path}:${document.version}`;
  useEffect(() => {
    let disposed = false;
    setPdf(null);
    setPage(1);
    setOutline([]);
    setError("");
    start.current = null;
    let bytes: Uint8Array;
    try {
      const encoded = document.text.split(",", 2)[1];
      if (!encoded) throw new Error(tx("PDF 数据为空。"));
      bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    } catch (reason) {
      setError(String(reason));
      return;
    }
    const task = getDocument({
      data: bytes,
      useSystemFonts: true,
      cMapUrl: "/pdf-assets/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdf-assets/standard_fonts/",
      wasmUrl: "/pdf-assets/wasm/",
      maxImageSize: 16 * 1024 * 1024,
      canvasMaxAreaInBytes: 16 * 1024 * 1024,
    });
    void task.promise
      .then(async (value) => {
        if (disposed) return;
        setPdf(value);
        const contents = await value.getOutline();
        if (!disposed) setOutline(contents ?? []);
      })
      .catch((reason) => {
        if (!disposed) setError(String(reason));
      });
    return () => {
      disposed = true;
      void task.destroy().catch((reason) => console.error("PDF cleanup", reason));
    };
  }, [document.id, key, document.text, annotationsEnabled]);
  async function navigate(dest: unknown) {
    if (!pdf) return;
    try {
      const value = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
      if (!Array.isArray(value)) return;
      const index = typeof value[0] === "number" ? value[0] : await pdf.getPageIndex(value[0]);
      setPage(Math.max(1, Math.min(pdf.numPages, index + 1)));
    } catch (reason) {
      setError(String(reason));
    }
  }
  function contents(items: Outline[], depth = 0, budget = { remaining: 2000 }): React.ReactNode {
    if (depth > 20) return null;
    return (
      <ul className="pdf-outline">
        {items.slice(0, budget.remaining).map(
          (item, index) =>
            budget.remaining-- > 0 && (
              <li key={index}>
                <button onClick={() => void navigate(item.dest)}>{item.title}</button>
                {contents(item.items, depth + 1, budget)}
              </li>
            ),
        )}
      </ul>
    );
  }
  return (
    <section className="pdf-reader">
      <div className="pdf-controls">
        <button disabled={!pdf || page === 1} onClick={() => setPage(page - 1)}>
          {tx("上一页")}
        </button>
        <input
          aria-label={tx("PDF 页码")}
          type="number"
          min={1}
          max={pdf?.numPages ?? 1}
          value={page}
          onChange={(event) =>
            setPage(
              Math.max(
                1,
                Math.min(pdf?.numPages ?? 1, Math.floor(Number(event.target.value)) || 1),
              ),
            )
          }
        />
        <span>/ {pdf?.numPages ?? "…"}</span>
        <button disabled={!pdf || page === pdf.numPages} onClick={() => setPage(page + 1)}>
          {tx("下一页")}
        </button>
        <button disabled={scale <= 0.5} onClick={() => setScale(Math.max(0.5, scale - 0.25))}>
          {tx("缩小")}
        </button>
        <span>{Math.round(scale * 100)}%</span>
        <button disabled={scale >= 3} onClick={() => setScale(Math.min(3, scale + 0.25))}>
          {tx("放大")}
        </button>
        {annotationsEnabled && (
          <button
            disabled={!highlights.ready || highlights.busy || highlights.pending}
            aria-pressed={marking}
            onClick={() => setMarking(!marking)}
          >
            {tx("框选高亮")}
          </button>
        )}
      </div>
      {error && <p role="alert">{localizeMessage(error)}</p>}
      {annotationsEnabled && highlights.busy && (
        <p role="status">{highlights.ready ? tx("正在保存…") : tx("加载中…")}</p>
      )}
      {highlights.error && (
        <div className="pdf-marks-error">
          <p role="alert">{localizeMessage(highlights.error)}</p>
          <button disabled={highlights.busy} onClick={() => void highlights.retry()}>
            {tx("重试")}
          </button>
          {highlights.pending && (
            <button disabled={highlights.busy} onClick={highlights.discard}>
              {tx("取消")}
            </button>
          )}
        </div>
      )}
      {!pdf ? (
        <p>{tx("正在读取 PDF…")}</p>
      ) : (
        <div className="pdf-layout">
          <nav aria-label={tx("PDF 导航")}>
            <select
              aria-label={tx("PDF 导航模式")}
              value={tab}
              onChange={(event) => setTab(event.target.value)}
            >
              <option value="contents">{tx("目录")}</option>
              <option value="pages">{tx("缩略图")}</option>
              {annotationsEnabled && <option value="marks">{tx("高亮")}</option>}
            </select>
            {tab === "contents" &&
              (outline.length ? contents(outline) : <p>{tx("此文件没有目录。")}</p>)}
            {tab === "pages" &&
              Array.from(
                { length: Math.min(20, pdf.numPages - Math.floor((page - 1) / 20) * 20) },
                (_, index) => Math.floor((page - 1) / 20) * 20 + index + 1,
              ).map((number) => (
                <button key={number} aria-pressed={page === number} onClick={() => setPage(number)}>
                  <PageCanvas pdf={pdf} page={number} scale={0.18} report={setError} />
                  {number}
                </button>
              ))}
            {tab === "marks" &&
              marks.map((mark) => (
                <div key={mark.id}>
                  <button onClick={() => setPage(mark.page)}>
                    {tx("第 {p0} 页", { p0: mark.page })}
                  </button>
                  <button
                    disabled={highlights.busy || highlights.pending}
                    onClick={() => void highlights.remove(mark.id)}
                  >
                    {tx("删除高亮")}
                  </button>
                </div>
              ))}
            {annotationsEnabled && (
              <small>{tx("高亮仅保存在本机，不修改 PDF。文件内容变化后单独记录。")}</small>
            )}
          </nav>
          <div className="pdf-page-scroll">
            <div
              className="pdf-page"
              style={{
                cursor: marking ? "crosshair" : "auto",
                touchAction: marking ? "none" : "auto",
              }}
              onPointerDown={(event) => {
                if (
                  !annotationsEnabled ||
                  !marking ||
                  !highlights.ready ||
                  highlights.busy ||
                  highlights.pending ||
                  event.button !== 0
                )
                  return;
                const rect = event.currentTarget.getBoundingClientRect();
                start.current = {
                  x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
                  y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
                };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerCancel={() => {
                start.current = null;
              }}
              onPointerUp={(event) => {
                const from = start.current;
                start.current = null;
                if (!from) return;
                const rect = event.currentTarget.getBoundingClientRect();
                const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
                const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
                if (Math.abs(x - from.x) < 0.005 || Math.abs(y - from.y) < 0.005) return;
                void highlights.add({
                  id: crypto.randomUUID(),
                  page,
                  x: Math.min(x, from.x),
                  y: Math.min(y, from.y),
                  width: Math.abs(x - from.x),
                  height: Math.abs(y - from.y),
                });
              }}
            >
              <PageCanvas pdf={pdf} page={page} scale={scale} report={setError} />
              {marks
                .filter((mark) => mark.page === page)
                .map((mark) => (
                  <span
                    key={mark.id}
                    className="pdf-mark"
                    data-mark-id={mark.id}
                    style={{
                      left: `${mark.x * 100}%`,
                      top: `${mark.y * 100}%`,
                      width: `${mark.width * 100}%`,
                      height: `${mark.height * 100}%`,
                    }}
                  />
                ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
