import React from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { FilePanel } from "../src/components/FilePanel";
import { setUiLanguage } from "../src/lib/i18n";
import "../src/styles.css";
setUiLanguage("zh-Hans");
let copied = false;
mockIPC((command, args) => {
  if (command === "file_copy") {
    copied = true;
    return null;
  }
  if (command === "files_list")
    return {
      entries: args.path
        ? copied
          ? [{ path: "folder/index.html", name: "index.html", directory: false, symlink: false }]
          : []
        : [
            { path: "folder", name: "folder", directory: true, symlink: false },
            { path: "index.html", name: "index.html", directory: false, symlink: false },
          ],
      partial: false,
      skipped: 0,
    };
  return null;
});
createRoot(document.getElementById("root")!).render(
  <div style={{ width: 360, height: "100vh", marginLeft: "auto" }}>
    <FilePanel
      resizeHandle={null}
      headerActions={null}
      directory="C:/fixture"
      mode="tree"
      request={0}
      setMode={() => {}}
      open={() => {}}
      beforeMutation={(action) => action()}
    />
  </div>,
);
