import { useEffect, useRef, useState } from "react";
import { Menu, Submenu } from "@tauri-apps/api/menu";
import { listen } from "@tauri-apps/api/event";
import { buildMacosMenu } from "./macos-menu.ts";
import type { MacosMenuState } from "./macos-menu.ts";
import { tx } from "./i18n.ts";

/** Keeps the macOS menu synchronized and routes actions to the current UI. / 同步 macOS 菜单并将操作交给当前界面。 */
export function useMacosMenu(
  mac: boolean,
  state: MacosMenuState,
  act: (action: string) => void,
  report: (message: string) => void,
) {
  const latest = useRef({ act, report });
  latest.current = { act, report };
  const [revision, setRevision] = useState(0);
  const queue = useRef(Promise.resolve());
  const signature = JSON.stringify(mac ? buildMacosMenu(state) : null);
  useEffect(() => {
    if (!mac) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<string>("app-menu-action", (event) => {
      latest.current.act(event.payload);
      // Native check items toggle before dispatch, including reselecting the current entry.
      // 原生勾选项在分发前切换状态，重新选择当前条目时也需要恢复正确的勾选。
      setRevision((value) => value + 1);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((reason) => latest.current.report(tx("无法更新菜单栏：{p0}", { p0: String(reason) })));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [mac]);
  useEffect(() => {
    if (!mac) return;
    let disposed = false;
    queue.current = queue.current.then(async () => {
      if (disposed) return;
      let next: Menu | undefined;
      try {
        next = await Menu.new(JSON.parse(signature));
        if (disposed) return;
        const previous = await next.setAsAppMenu();
        try {
          for (const [id, role] of [
            ["app-menu-window", "window"],
            ["app-menu-help", "help"],
          ]) {
            const submenu = await next.get(id);
            if (submenu instanceof Submenu) {
              try {
                if (role === "window") await submenu.setAsWindowsMenuForNSApp();
                else await submenu.setAsHelpMenuForNSApp();
              } finally {
                await submenu.close();
              }
            }
          }
        } finally {
          await previous?.close();
        }
      } catch (reason) {
        latest.current.report(tx("无法更新菜单栏：{p0}", { p0: String(reason) }));
      } finally {
        await next
          ?.close()
          .catch((reason) =>
            latest.current.report(tx("无法更新菜单栏：{p0}", { p0: String(reason) })),
          );
      }
    });
    return () => {
      disposed = true;
    };
  }, [mac, signature, revision]);
}
