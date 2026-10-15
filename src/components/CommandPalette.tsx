import { useUiLanguage } from "../lib/useUiLanguage";
import { tx } from "../lib/i18n";
import { useEffect, useRef, useState } from "react";
import { binding, commands, shortcutLabel } from "../lib/settings";
import type { CommandId } from "../lib/settings";
import { useSettings } from "../lib/SettingsContext";
export function CommandPalette({
  mac,
  available,
  run,
  close,
}: {
  mac: boolean;
  available: (id: CommandId) => boolean;
  run: (id: CommandId) => void;
  close: () => void;
}) {
  useUiLanguage();

  const { settings } = useSettings();
  const dialog = useRef<HTMLDialogElement>(null);
  const backdrop = useDialogBackdrop(close);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const matches = commands.filter(([id, title]) =>
    `${id} ${tx(title)}`.toLowerCase().includes(query.toLowerCase()),
  );
  useEffect(() => {
    dialog.current?.showModal();
    input.current?.focus();
  }, []);
  useEffect(() => {
    dialog.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  function execute(id: CommandId) {
    if (!available(id)) return;
    close();
    run(id);
  }
  return (
    <dialog
      {...backdrop}
      ref={dialog}
      className="name-dialog command-palette"
      aria-label={tx("命令面板")}
      onCancel={close}
    >
      <header>
        <input
          ref={input}
          aria-label={tx("搜索命令")}
          placeholder={tx("搜索命令…")}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setSelected((value) =>
                Math.max(
                  0,
                  Math.min(matches.length - 1, value + (event.key === "ArrowDown" ? 1 : -1)),
                ),
              );
            }
            if (event.key === "Enter" && matches[selected]) {
              event.preventDefault();
              execute(matches[selected][0]);
            }
          }}
        />
        <button aria-label={tx("关闭命令面板")} onClick={close}>
          ×
        </button>
      </header>
      <div className="command-results" role="listbox" aria-label={tx("命令")}>
        {matches.map(([id, title], index) => (
          <button
            role="option"
            aria-selected={index === selected}
            aria-disabled={!available(id)}
            key={id}
            onMouseMove={() => setSelected(index)}
            onClick={() => execute(id)}
          >
            <span>{tx(title)}</span>
            <kbd>{shortcutLabel(binding(settings, id, mac), mac)}</kbd>
          </button>
        ))}
        {!matches.length && <p>{tx("没有匹配的命令。")}</p>}
      </div>
    </dialog>
  );
}
import { useDialogBackdrop } from "../lib/useDialogBackdrop";
