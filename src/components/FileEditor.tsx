import { localizeMessage } from "../lib/i18n";
import { editorPhrases } from "../lib/editor-i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { tx } from "../lib/i18n";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSettings } from "../lib/SettingsContext";
import { invoke } from "@tauri-apps/api/core";
import { basicSetup } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { openSearchPanel, searchPanelOpen, gotoLine } from "@codemirror/search";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import { htmlPreview } from "../lib/html-preview";
import { isDirty, editorText, documentText } from "../lib/file-document";
import type { OpenFile } from "../lib/file-document";
import type { useFileDocument } from "../lib/useFileDocument";

const markdown = new MarkdownIt({ html: false, linkify: false, breaks: false });
const PdfReader = lazy(() =>
  import("./PdfReader").then((module) => ({ default: module.PdfReader })),
);
markdown.renderer.rules.image = (tokens, index) =>
  `<span class="preview-image-label">${markdown.utils.escapeHtml(tx("[图片：{p0}]", { p0: tokens[index].content }))}</span>`;
function CodeEditor({
  document,
  blocked,
  change,
  save,
  close,
  controls,
}: {
  document: OpenFile;
  blocked: boolean;
  change: (text: string) => void;
  save: () => void;
  close: () => void;
  controls: React.RefObject<EditorView | null>;
}) {
  const uiLanguage = useUiLanguage();

  const { light, settings } = useSettings();
  const appearance = useRef(new Compartment());
  const locale = useRef(new Compartment());
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef({ change, save, close });
  latest.current = { change, save, close };
  const editable = useRef(new Compartment());
  const language = useRef(new Compartment());
  const [position, setPosition] = useState({ line: 1, column: 1 });
  const [languageError, setLanguageError] = useState("");
  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: editorText(document.text),
        extensions: [
          basicSetup,
          appearance.current.of(light ? [] : oneDark),
          EditorView.lineWrapping,
          language.current.of([]),
          editable.current.of([
            EditorState.readOnly.of(document.readonly || blocked),
            EditorView.editable.of(!document.readonly && !blocked),
          ]),
          locale.current.of([
            EditorView.contentAttributes.of({
              "aria-label": tx("编辑 {p0}", { p0: document.path }),
              spellcheck: "false",
            }),
            EditorState.phrases.of(editorPhrases()),
          ]),
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                latest.current.save();
                return true;
              },
            },
            { key: "Mod-h", run: openSearchPanel },
            {
              key: "Escape",
              run: (view) => {
                if (searchPanelOpen(view.state)) return false;
                latest.current.close();
                return true;
              },
            },
            indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              latest.current.change(
                documentText(update.state.doc.toString(), document.line_ending),
              );
            if (update.selectionSet || update.docChanged) {
              const line = update.state.doc.lineAt(update.state.selection.main.head);
              setPosition({
                line: line.number,
                column: update.state.selection.main.head - line.from + 1,
              });
            }
          }),
          EditorView.theme({
            "&": {
              height: "100%",
              backgroundColor: "transparent",
              fontSize: "var(--file-font-size, 14px)",
            },
            ".cm-scroller": {
              overflow: "auto",
              fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
            },
            ".cm-gutters": { backgroundColor: "transparent", borderRight: "1px solid #8884" },
            ".cm-content": { padding: "12px 0" },
            ".cm-line": { padding: "0 12px" },
          }),
        ],
      }),
    });
    controls.current = view;
    if (document.text.length < 256 * 1024) {
      const mode = LanguageDescription.matchFilename(languages, document.path);
      if (mode)
        void mode
          .load()
          .then((support) => {
            if (!disposed) view.dispatch({ effects: language.current.reconfigure(support) });
          })
          .catch((reason) => {
            if (!disposed) setLanguageError(tx("语法高亮未加载：{p0}", { p0: String(reason) }));
          });
    }
    view.focus();
    return () => {
      disposed = true;
      controls.current = null;
      view.destroy();
    };
  }, [document.id]);
  useEffect(() => {
    controls.current?.dispatch({
      effects: locale.current.reconfigure([
        EditorState.phrases.of(editorPhrases()),
        EditorView.contentAttributes.of({
          "aria-label": tx("编辑 {p0}", { p0: document.path }),
          spellcheck: "false",
        }),
      ]),
    });
  }, [uiLanguage, document.path]);
  useEffect(() => {
    controls.current?.dispatch({ effects: appearance.current.reconfigure(light ? [] : oneDark) });
  }, [light]);
  useEffect(() => {
    controls.current?.requestMeasure();
  }, [settings.fileFontSize, document.id]);
  useEffect(() => {
    controls.current?.dispatch({
      effects: editable.current.reconfigure([
        EditorState.readOnly.of(document.readonly || blocked),
        EditorView.editable.of(!document.readonly && !blocked),
      ]),
    });
  }, [blocked, document.readonly]);
  useEffect(() => {
    const view = controls.current;
    if (!view || !document.line) return;
    const line = view.state.doc.line(Math.min(view.state.doc.lines, Math.max(1, document.line)));
    view.dispatch({
      selection: { anchor: line.from, head: line.to },
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
    view.focus();
  }, [document.id, document.line, document.jump]);
  return (
    <>
      <div className="code-editor-host" ref={host} />
      {languageError && <p role="alert">{localizeMessage(languageError)}</p>}
      <footer className="editor-status">
        <span>{tx("行 {p0}，列 {p1}", { p0: position.line, p1: position.column })}</span>
        <span>
          {document.line_ending === "\r\n" ? "CRLF" : document.line_ending === "\r" ? "CR" : "LF"} ·
          UTF-8{document.bom ? " BOM" : ""}
          {document.readonly ? tx(" · 只读") : ""}
        </span>
      </footer>
    </>
  );
}
export function FileEditor({ editor }: { editor: ReturnType<typeof useFileDocument> }) {
  const uiLanguage = useUiLanguage();

  const { document } = editor;
  const view = useRef<EditorView | null>(null);
  const [preview, setPreview] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewSource, setPreviewSource] = useState("");
  const isMarkdown = !!document && /\.(md|markdown|mdown)$/i.test(document.path);
  const isHtml = !!document && /\.html?$/i.test(document.path);
  const htmlDocument = useMemo(
    () => (isHtml && preview ? htmlPreview(previewSource) : null),
    [isHtml, preview, previewSource],
  );
  useEffect(() => {
    setPreview((isMarkdown || isHtml) && !document?.line);
    setPreviewSource(document?.text ?? "");
    setPreviewError("");
  }, [document?.id]);
  useEffect(() => {
    if (document?.line) setPreview(false);
  }, [document?.jump]);
  const html = useMemo(
    () =>
      DOMPurify.sanitize(markdown.render(previewSource), {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ["img", "iframe", "style", "form"],
        FORBID_ATTR: ["style"],
      }),
    [previewSource, uiLanguage],
  );
  if (!document) return null;
  return (
    <section className="file-editor" aria-label={tx("文件编辑器 {p0}", { p0: document.path })}>
      <header className="editor-header">
        <div title={`${document.directory}/${document.path}`}>
          <strong>{document.path.split(/[\\/]/).at(-1)}</strong>
          <small>
            {document.directory}/{document.path}
          </small>
        </div>
        <span className="editor-save-state" role="status">
          {editor.saving
            ? tx("正在保存…")
            : isDirty(document)
              ? tx("未保存")
              : document.readonly
                ? tx("只读")
                : tx("已保存")}
        </span>
        {(isMarkdown || isHtml) && (
          <button
            aria-pressed={preview}
            onClick={() => {
              if (!preview) setPreviewSource(document.text);
              setPreview(!preview);
            }}
          >
            {preview ? tx("编辑") : tx("预览")}
          </button>
        )}
        {document.kind === "text" && (
          <>
            <button
              disabled={preview}
              onClick={() => {
                if (view.current) openSearchPanel(view.current);
              }}
            >
              {tx("查找/替换")}
            </button>
            <button
              disabled={preview}
              onClick={() => {
                if (view.current) gotoLine(view.current);
              }}
            >
              {tx("跳转行")}
            </button>
            <button
              disabled={
                document.readonly || editor.saving || editor.transitioning || !isDirty(document)
              }
              onClick={() => void editor.save()}
            >
              {tx("保存")}
            </button>
          </>
        )}
        <button disabled={editor.transitioning} onClick={() => void editor.reload()}>
          {tx("重新读取")}
        </button>
      </header>
      {document.notice && <p className="editor-notice">{localizeMessage(document.notice)}</p>}
      {editor.error && (
        <div className="editor-error" role="alert">
          {localizeMessage(editor.error)}
          {editor.conflict && (
            <button disabled={editor.saving} onClick={() => void editor.save(true)}>
              {tx("覆盖磁盘版本")}
            </button>
          )}
        </div>
      )}
      {previewError && (
        <p className="editor-error" role="alert">
          {localizeMessage(previewError)}
        </p>
      )}
      {document.kind === "image" ? (
        <div className="image-preview">
          <img src={document.text} alt={document.path} />
        </div>
      ) : document.kind === "pdf" ? (
        <Suspense fallback={<p>{tx("正在加载 PDF 阅读器…")}</p>}>
          <PdfReader key={document.id} document={document} />
        </Suspense>
      ) : (
        <>
          <div className={`editor-code${preview ? " concealed" : ""}`} inert={preview}>
            <CodeEditor
              document={document}
              blocked={editor.transitioning || editor.pending}
              change={editor.change}
              save={() => void editor.save()}
              close={() => void editor.close()}
              controls={view}
            />
          </div>
          {preview && isHtml && (
            <>
              {htmlDocument?.limited && (
                <p className="editor-notice" role="status">
                  {tx(
                    "HTML 静态预览不运行脚本或加载外部资源。若页面空白，请通过项目开发服务器预览。",
                  )}
                </p>
              )}
              <iframe
                className="html-preview"
                title={tx("HTML 预览 {p0}", { p0: document.path })}
                sandbox=""
                referrerPolicy="no-referrer"
                srcDoc={htmlDocument?.html}
              />
            </>
          )}
          {preview && !isHtml && (
            <article
              className="markdown-preview"
              onClick={(event) => {
                const link = (event.target as HTMLElement).closest("a");
                if (!link) return;
                event.preventDefault();
                const href = link.getAttribute("href") ?? "";
                if (/^https?:\/\//i.test(href))
                  void invoke("open_external", { url: href }).catch((reason) =>
                    setPreviewError(String(reason)),
                  );
                else if (!href.startsWith("#")) {
                  try {
                    const parts = document.path.split("/").slice(0, -1);
                    for (const part of decodeURIComponent(href.split("#")[0]).split("/")) {
                      if (part === "..") {
                        if (!parts.length) throw new Error(tx("链接不在项目目录内。"));
                        parts.pop();
                      } else if (part && part !== ".") parts.push(part);
                    }
                    if (href.startsWith("/") || /^[a-z]+:/i.test(href))
                      throw new Error(tx("此链接无法在编辑器中打开。"));
                    void editor.open(document.directory, parts.join("/"));
                  } catch (reason) {
                    setPreviewError(String(reason));
                  }
                }
              }}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </>
      )}
    </section>
  );
}
export function UnsavedDialog({ editor }: { editor: ReturnType<typeof useFileDocument> }) {
  useUiLanguage();

  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (editor.pending) dialog.current?.showModal();
    else dialog.current?.close();
  }, [editor.pending]);
  return (
    <dialog
      ref={dialog}
      className="name-dialog"
      aria-labelledby="unsaved-title"
      onCancel={(event) => {
        event.preventDefault();
        editor.cancel();
      }}
    >
      <h2 id="unsaved-title">{tx("保留未保存的修改？")}</h2>
      <p>{tx("继续操作会放弃当前文件的未保存修改。")}</p>
      <div className="unsaved-actions">
        <button onClick={editor.cancel} autoFocus>
          {tx("保留编辑")}
        </button>
        <button onClick={() => void editor.discard()}>{tx("放弃修改并继续")}</button>
      </div>
    </dialog>
  );
}
