import React from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { SettingsProvider } from "../src/lib/SettingsContext";
import { FileEditor } from "../src/components/FileEditor";
import "../src/styles.css";

mockIPC(() => null);
const text =
  "<!doctype html><html><head><style>body{font:20px system-ui;padding:36px;background:#eef5ff;color:#123}h1{color:#267}</style></head><body><h1>HTML preview</h1><p>Head styles and document content are preserved.</p></body></html>";
const noop = async () => {};
createRoot(document.getElementById("root")!).render(
  <SettingsProvider>
    <div style={{ height: "100vh", display: "flex" }}>
      <FileEditor
        editor={
          {
            document: {
              id: 1,
              directory: "fixture",
              path: "index.html",
              kind: "text",
              text,
              saved: text,
              version: "1",
              line_ending: "\n",
              bom: false,
              readonly: false,
              notice: null,
              jump: 0,
            },
            saving: false,
            transitioning: false,
            pending: null,
            error: "",
            conflict: false,
            change: () => {},
            save: noop,
            reload: noop,
            close: noop,
          } as any
        }
      />
    </div>
  </SettingsProvider>,
);
