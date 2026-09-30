import { localizeMessage } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";
import { tx } from "../lib/i18n";
import { AgentStatusIndicator, ToolbarIcon } from "./SidebarIcon";
import { themes } from "../lib/themes";
import { useEffect, useRef, useState } from "react";
import { binding, shortcutLabel } from "../lib/settings";
import { useSettings } from "../lib/SettingsContext";
import {
  attachTerminalPunctuationInput,
  isBareShiftTab,
  terminalClipboardAction,
  terminalPunctuationKey,
} from "../lib/terminal-input";
import { autoCloseAgent, closeAttachedSession } from "../lib/session-lifecycle";
import { decodeTerminalFrame } from "../lib/terminal-frame";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import type { DragEventHandler, PointerEventHandler } from "react";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { FitAddon } from "@xterm/addon-fit";
import type { PaneFrame, SessionConfig } from "../lib/workspace";
import "@xterm/xterm/css/xterm.css";

type Connection = {
  id: string;
  ready: Promise<void>;
  closed: boolean;
  exited: boolean;
  replaying: boolean;
  queue: Promise<void>;
  bytes: number;
};
const action = (id: string, action: string, values = {}) =>
  invoke<void>("session_action", { id, action, ...values });

export function TerminalView({
  directory,
  session,
  active,
  visible,
  frame,
  focusRequest,
  closeRequest,
  onFocus,
  onClosed,
  onAgentState,
  onDetectedAgent,
  agentState,
  dropEdge,
  onDragOver,
  onDragLeave,
  onDrop,
  onPaneDragStart,
}: {
  agentState?: string;
  onPaneDragStart: PointerEventHandler<HTMLElement>;
  onAgentState: (state: string, initial: boolean) => void;
  onDetectedAgent: (agent: string | null) => void;
  dropEdge?: string;
  onDragOver: DragEventHandler<HTMLElement>;
  onDragLeave: DragEventHandler<HTMLElement>;
  onDrop: DragEventHandler<HTMLElement>;
  directory: string;
  session: SessionConfig;
  active: boolean;
  visible: boolean;
  frame?: PaneFrame;
  focusRequest: string;
  closeRequest: number;
  onFocus: () => void;
  onClosed: () => void;
}) {
  const uiLanguage = useUiLanguage();

  const { settings, light } = useSettings();
  const preferences = useRef(settings);
  preferences.current = settings;
  const agentStateRef = useRef(onAgentState);
  agentStateRef.current = onAgentState;
  const detectedAgentRef = useRef(onDetectedAgent);
  detectedAgentRef.current = onDetectedAgent;
  const lastFrame = useRef<PaneFrame>({ x: 0, y: 0, width: 1, height: 1 });
  if (frame) lastFrame.current = frame;
  const position = lastFrame.current;
  const shell = session.shell;
  const activeRef = useRef(active);
  activeRef.current = active;
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const connection = useRef<Connection | null>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  const search = useRef<SearchAddon | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [matches, setMatches] = useState({ resultIndex: -1, resultCount: 0 });
  function find(previous = false, incremental = false) {
    if (!query) {
      search.current?.clearDecorations();
      setMatches({ resultIndex: -1, resultCount: 0 });
      return;
    }
    const options = {
      caseSensitive: matchCase,
      incremental,
      decorations: {
        matchBackground: "#655326",
        activeMatchBackground: "#946c25",
        matchOverviewRuler: "#655326",
        activeMatchColorOverviewRuler: "#946c25",
      },
    };
    try {
      if (previous) search.current?.findPrevious(query, options);
      else search.current?.findNext(query, options);
    } catch (reason) {
      setError(tx("搜索失败：{p0}", { p0: String(reason) }));
    }
  }
  useEffect(() => {
    if (searchOpen) {
      searchInput.current?.focus();
      find(false, true);
    } else search.current?.clearDecorations();
  }, [searchOpen, query, matchCase]);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!container.current) return;
    const term = new Terminal({
      allowTransparency: true,
      disableStdin: true,
      cursorBlink: true,
      screenReaderMode: true,
      allowProposedApi: true,
      fontSize: 14,
      fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
      fontWeight: settings.fontThicken ? 600 : "normal",
      scrollback: 3000,
      theme: { background: "#212121", foreground: "#c8cdd3" },
    });
    const fit = new FitAddon();
    fitAddon.current = fit;
    term.loadAddon(fit);
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    search.current = searchAddon;
    const searchListener = searchAddon.onDidChangeResults(setMatches);
    const openLink = (event: MouseEvent, uri: string) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      void invoke("open_external", { url: uri }).catch((reason) => setError(String(reason)));
    };
    term.loadAddon(new WebLinksAddon(openLink));
    term.options.linkHandler = { activate: openLink, allowNonHttpProtocols: false };
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === "keydown" || event.type === "keypress") {
        // Let the input method transform punctuation before accepting its committed text.
        // 先让输入法转换标点，再接收其提交的文本。
        if (terminalPunctuationKey(event)) return false;
      }
      if (event.type !== "keydown") return true;
      if (isBareShiftTab(event)) {
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      const clipboardAction = terminalClipboardAction(
        event,
        navigator.platform.startsWith("Mac"),
        term.hasSelection(),
      );
      if (clipboardAction) {
        event.preventDefault();
        event.stopPropagation();
        if (clipboardAction === "copy") {
          void navigator.clipboard
            .writeText(term.getSelection())
            .catch((reason) => setError(String(reason)));
        } else {
          const current = connection.current;
          if (
            !current ||
            current.closed ||
            current.exited ||
            current.replaying ||
            term.options.disableStdin
          )
            return false;
          // Clipboard reads may finish after reconnecting; never paste into another attachment.
          // 剪贴板读取可能在重连后才完成，不能将文本粘贴到另一个连接。
          void navigator.clipboard.readText().then(
            (text) => {
              if (
                connection.current !== current ||
                current.closed ||
                current.exited ||
                current.replaying ||
                term.options.disableStdin
              )
                return;
              term.paste(text);
            },
            (reason) => setError(String(reason)),
          );
        }
        return false;
      }
      return true;
    });
    term.open(container.current);
    terminal.current = term;
    const disposePunctuation = term.textarea
      ? attachTerminalPunctuationInput(
          term.textarea,
          (text) => term.input(text, true),
          () => !term.options.disableStdin,
        )
      : () => {};
    const send = (data: Uint8Array) => {
      const current = connection.current;
      if (!current || current.closed || current.replaying) return;
      if (current.bytes + data.length > 1024 * 1024) {
        setError(tx("输入过长，请分段粘贴。"));
        return;
      }
      current.bytes += data.length;
      current.queue = current.queue
        .then(async () => {
          await current.ready;
          for (let offset = 0; offset < data.length && !current.closed; offset += 16384)
            await action(current.id, "write", {
              data: Array.from(data.subarray(offset, offset + 16384)),
            });
        })
        .catch((reason: unknown) => {
          if (!current.closed) setError(String(reason));
        })
        .finally(() => {
          current.bytes -= data.length;
        });
    };
    // The host answers these even while detached; suppress duplicate WebView replies.
    const queryHandlers = [
      term.parser.registerCsiHandler({ final: "n" }, (parameters) =>
        [5, 6].includes(Number(parameters[0])),
      ),
      term.parser.registerCsiHandler(
        { prefix: "?", final: "n" },
        (parameters) => Number(parameters[0]) === 6,
      ),
      term.parser.registerCsiHandler({ final: "c" }, () => true),
      term.parser.registerCsiHandler({ prefix: ">", final: "c" }, () => true),
      term.parser.registerCsiHandler({ prefix: "?", intermediates: "$", final: "p" }, () => true),
      term.parser.registerCsiHandler({ final: "t" }, (parameters) => Number(parameters[0]) === 18),
      ...[10, 11].map((code) => term.parser.registerOscHandler(code, (data) => data === "?")),
    ];
    const selection = term.onSelectionChange(() => {
      if (preferences.current.copyOnSelect && term.hasSelection())
        void navigator.clipboard
          .writeText(term.getSelection())
          .catch((reason) => setError(String(reason)));
    });
    const input = term.onData((value) => send(new TextEncoder().encode(value)));
    const binary = term.onBinary((value) =>
      send(Uint8Array.from(value, (character) => character.charCodeAt(0))),
    );
    let resizeQueue = Promise.resolve();
    const resize = term.onResize(({ rows, cols }) => {
      const current = connection.current;
      if (!current || current.replaying) return;
      resizeQueue = resizeQueue
        .then(async () => {
          await current.ready;
          if (!current.closed) await action(current.id, "resize", { rows, cols });
        })
        .catch((reason: unknown) => {
          if (!current.closed) setError(String(reason));
        });
    });
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (container.current?.clientHeight && container.current?.clientWidth) fit.fit();
      });
    });
    observer.observe(container.current);
    return () => {
      const current = connection.current;
      connection.current = null;
      if (current) {
        current.closed = true;
        // Unmounting releases the view, not the daemon-owned shell.
        current.ready.then(() => action(current.id, "detach")).catch(console.error);
      }
      observer.disconnect();
      cancelAnimationFrame(frame);
      searchListener.dispose();
      search.current = null;
      queryHandlers.forEach((handler) => handler.dispose());
      selection.dispose();
      input.dispose();
      binary.dispose();
      resize.dispose();
      disposePunctuation();
      term.dispose();
      terminal.current = null;
    };
  }, []);

  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    const theme =
      [...themes, ...settings.customThemes].find(
        (theme) => theme.id === (light ? settings.lightTheme : settings.darkTheme),
      ) ?? themes[0];
    Object.assign(term.options, {
      fontFamily: settings.fontFamily,
      fontWeight: settings.fontThicken ? 600 : "normal",
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      cursorStyle: settings.cursorStyle,
      cursorBlink: settings.cursorBlink,
      scrollback: settings.scrollback,
      theme: { ...theme, background: "#00000000" },
    });
    fitAddon.current?.fit();
    Terminal.strings.promptLabel = tx("终端输入");
    Terminal.strings.tooMuchOutput = tx("输出过多，请移动到各行以读取。");
    container.current?.querySelector("textarea")?.setAttribute("aria-label", tx("终端输入"));
  }, [settings, light, uiLanguage]);
  useEffect(() => {
    const find = () => {
      if (activeRef.current) {
        setSearchOpen(true);
        searchInput.current?.focus();
      }
    };
    window.addEventListener("uterm-search", find);
    return () => window.removeEventListener("uterm-search", find);
  }, []);
  useEffect(() => {
    void start();
  }, []);
  useEffect(() => {
    if (active) terminal.current?.focus();
  }, [active, focusRequest]);

  async function start() {
    const term = terminal.current;
    if (!term || connection.current) return;
    detectedAgentRef.current(null);
    setError("");
    setStatus("starting");
    term.reset();
    const events = new Channel<ArrayBuffer>();
    const current: Connection = {
      id: crypto.randomUUID(),
      closed: false,
      exited: false,
      replaying: false,
      ready: Promise.resolve(),
      queue: Promise.resolve(),
      bytes: 0,
    };
    connection.current = current;
    events.onmessage = (payload) => {
      if (current.closed || connection.current !== current) return;
      let decoded;
      try {
        decoded = decodeTerminalFrame(payload);
      } catch (reason) {
        setError(String(reason));
        setStatus("disconnected");
        term.options.disableStdin = true;
        void action(current.id, "detach").catch((reason) => setError(String(reason)));
        return;
      }
      const { data, ...event } = decoded;
      if (event.agent_state) agentStateRef.current(event.agent_state, event.reset);
      if (event.foreground_agent !== undefined) detectedAgentRef.current(event.foreground_agent);
      if (event.error) {
        setError(event.error);
        if (!data.length && event.sequence === 0) {
          setStatus("disconnected");
          term.options.disableStdin = true;
          return;
        }
      }
      // Replay at the saved dimensions before fitting, so wrapped output stays intact.
      if (event.reset) {
        current.replaying = true;
        term.reset();
        term.resize(event.cols, event.rows);
      }
      term.write(data, () => {
        if (current.closed) return;
        if (event.reset) {
          current.replaying = false;
          fitAddon.current?.fit();
        }
        if (event.exited) {
          current.exited = true;
          term.options.disableStdin = true;
          setStatus("exited");
          if (!autoCloseAgent(session.agent, event.code))
            term.writeln(tx("\r\n[会话已退出：{p0}]", { p0: event.code ?? tx("未知") }));
        }
        // Acknowledge after xterm consumes the bytes to keep output backpressure bounded.
        current.ready
          .then(() => {
            if (!current.closed) return action(current.id, "ack", { sequence: event.sequence });
          })
          .then(() => {
            // Close agent chats only after consuming and acknowledging their final output.
            // 仅在消费并确认最后的输出后关闭 Agent 聊天。
            if (
              event.exited &&
              autoCloseAgent(session.agent, event.code) &&
              !event.error &&
              !current.closed &&
              connection.current === current
            )
              return closeRef.current();
          })
          .catch((reason: unknown) => {
            if (!current.closed) setError(String(reason));
          });
      });
    };
    current.ready = invoke<void>("start_session", {
      request: {
        id: session.id,
        attachment: current.id,
        directory,
        shell,
        agent: session.agent ?? null,
        rows: term.rows,
        cols: term.cols,
      },
      events,
    });
    try {
      await current.ready;
      if (!current.closed) {
        term.options.disableStdin = current.exited;
        setStatus((value) => (value === "starting" ? "running" : value));
        if (activeRef.current) term.focus();
      }
    } catch (reason) {
      if (!current.closed) {
        connection.current = null;
        setStatus("idle");
        setError(String(reason));
      }
    }
  }

  useEffect(() => {
    if (closeRequest > 0) void close();
  }, [closeRequest]);

  async function close() {
    const current = connection.current;
    if (current?.closed) return;
    if (!current) {
      onClosed();
      return;
    }
    setStatus("closing");
    if (terminal.current) terminal.current.options.disableStdin = true;
    try {
      if (!(await closeAttachedSession(current, () => action(current.id, "close")))) return;
      connection.current = null;
      setStatus("idle");
      onClosed();
    } catch (reason) {
      current.closed = false;
      setStatus("disconnected");
      setError(String(reason));
    }
  }

  async function reconnect() {
    const current = connection.current;
    if (current) {
      current.closed = true;
      try {
        await action(current.id, "detach");
      } catch (reason) {
        console.error(reason);
      }
      connection.current = null;
    }
    await start();
  }

  async function restart() {
    const current = connection.current;
    if (current) {
      try {
        await current.ready;
        await action(current.id, "close");
      } catch (reason) {
        setError(String(reason));
        return;
      }
      current.closed = true;
      connection.current = null;
    }
    await start();
  }

  return (
    <section
      data-session-id={session.id}
      className={`local-session session-panel${visible ? " visible" : ""}${active ? " active" : ""}`}
      aria-label={session.name}
      aria-hidden={!visible}
      inert={!visible}
      style={{
        left: `${position.x * 100}%`,
        top: `${position.y * 100}%`,
        width: `${position.width * 100}%`,
        height: `${position.height * 100}%`,
      }}
      onFocusCapture={onFocus}
      onPointerDown={onFocus}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dropEdge && <div className={`pane-drop-target ${dropEdge}`} aria-hidden="true" />}
      <div className="session-controls">
        <span
          className="session-directory"
          onPointerDown={onPaneDragStart}
          title={`${session.name} — ${directory}`}
        >
          {session.name}
        </span>
        <button
          className="toolbar-icon-button"
          aria-label={tx("搜索")}
          onClick={() => setSearchOpen((value) => !value)}
          title={
            tx("搜索 · ") +
            shortcutLabel(
              binding(settings, "terminalSearch", navigator.platform.startsWith("Mac")),
              navigator.platform.startsWith("Mac"),
            )
          }
        >
          <ToolbarIcon name="search" />
        </button>
        {session.issue && (
          <button
            className="toolbar-icon-button"
            aria-label={tx("关联条目 ↗")}
            title={session.issue.title}
            onClick={() =>
              void invoke("open_external", { url: session.issue?.url }).catch((reason) =>
                setError(String(reason)),
              )
            }
          >
            <ToolbarIcon name="link" />
          </button>
        )}
        {session.agent && status === "running" ? (
          <span className="terminal-status">
            <AgentStatusIndicator state={agentState} />
          </span>
        ) : (
          <span
            className={`terminal-status ${status}`}
            role="img"
            aria-label={
              {
                idle: tx("启动失败"),
                starting: tx("正在启动"),
                running: tx("运行中"),
                exited: tx("已退出"),
                closing: tx("正在关闭"),
                disconnected: tx("已断开"),
              }[status]
            }
            title={
              {
                idle: tx("启动失败"),
                starting: tx("正在启动"),
                running: tx("运行中"),
                exited: tx("已退出"),
                closing: tx("正在关闭"),
                disconnected: tx("已断开"),
              }[status]
            }
          >
            <span />
          </span>
        )}
        {status === "disconnected" && (
          <button
            className="toolbar-icon-button"
            aria-label={tx("重新连接")}
            onClick={() => void reconnect()}
            title={tx("重新连接")}
          >
            <ToolbarIcon name="restart" />
          </button>
        )}
        {(status === "idle" || status === "exited") && (
          <button
            className="toolbar-icon-button"
            aria-label={tx("重新启动")}
            onClick={() => void restart()}
            title={tx("重新启动")}
          >
            <ToolbarIcon name="restart" />
          </button>
        )}
      </div>
      {searchOpen && (
        <form
          className="terminal-search"
          onSubmit={(event) => {
            event.preventDefault();
            find();
          }}
        >
          <input
            ref={searchInput}
            aria-label={tx("搜索终端")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setSearchOpen(false);
                terminal.current?.focus();
              }
              if (event.key === "Enter" && event.shiftKey) {
                event.preventDefault();
                find(true);
              }
            }}
          />
          <button
            type="button"
            aria-pressed={matchCase}
            title={tx("区分大小写")}
            onClick={() => setMatchCase((value) => !value)}
          >
            Aa
          </button>
          <span aria-live="polite">
            {query ? `${matches.resultIndex + 1} / ${matches.resultCount}` : ""}
          </span>
          <button type="button" aria-label={tx("上一个匹配")} onClick={() => find(true)}>
            ↑
          </button>
          <button aria-label={tx("下一个匹配")}>↓</button>
          <button
            type="button"
            aria-label={tx("关闭搜索")}
            onClick={() => {
              setSearchOpen(false);
              terminal.current?.focus();
            }}
          >
            ×
          </button>
        </form>
      )}
      {error && <p role="alert">{localizeMessage(error)}</p>}
      <div ref={container} className="terminal" aria-label={tx("本地终端")} />
    </section>
  );
}
