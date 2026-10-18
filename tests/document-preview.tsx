import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { mockIPC } from "@tauri-apps/api/mocks";
import { DocumentWorkspace } from "../src/components/DocumentWorkspace";
import { DatabaseConnectionDialog } from "../src/components/DatabaseConnectionDialog";
import { SettingsProvider, useSettings } from "../src/lib/SettingsContext";
import { defaults, settingsKey } from "../src/lib/settings";
import { setUiLanguage } from "../src/lib/i18n";
import type { DatabaseConfig } from "../src/lib/database";
import "../src/styles.css";

localStorage.setItem(
  settingsKey,
  JSON.stringify({ ...defaults, language: "en", appearance: "dark" }),
);
const reply = (command: string, args: Record<string, unknown>) => {
  if (command === "database_connect") return { handle: "document-qa" };
  if (command === "database_request") {
    const request = args.request as { action: string; offset?: number };
    if (request.action === "databases") return { names: ["qa", "admin"] };
    if (request.action === "collections")
      return {
        names: Array.from(
          { length: 40 },
          (_, index) => `logs_${String(index + 1).padStart(2, "0")}`,
        ),
      };
    if (request.action === "mapping")
      return { metadata: '{"properties":{"message":{"type":"text"}}}' };
    if (request.action === "query")
      return {
        documents: Array.from({ length: 50 }, (_, index) => ({
          value: `{\n  "_id": { "$oid": "507f1f77bcf86cd799439011" },\n  "message": "中文与 English 文档 ${index + 1}",\n  "large": { "$numberLong": "9223372036854775807" },\n  "nested": { "active": true, "tags": ["terminal", "database"] }\n}`,
          identity: String(index + 1),
          version: "[3,1]",
        })),
        more: !request.offset,
      };
    return { affected: 1 };
  }
  if (command === "database_components") return { items: [], java: "QA", busy: false };
  return null;
};
Object.assign(globalThis, { __documentQaReply: reply });
if (!isTauri()) mockIPC(reply);
function Preview() {
  const { settings, save, light } = useSettings();
  const [kind, setKind] = useState<"elasticsearch" | "mongodb">("elasticsearch");
  const [dialog, setDialog] = useState(false);
  const config: DatabaseConfig = {
    id: "11111111-1111-4111-8111-111111111111",
    name: `${kind} QA`,
    kind,
    host: "127.0.0.1",
    port: kind === "elasticsearch" ? 9200 : 27017,
    database: "qa",
    username: "",
    tls: false,
    ca_file: "",
    credential_id: null,
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
      <div style={{ display: "flex", gap: 8, padding: 8, flexShrink: 0 }}>
        <select
          aria-label="Database type QA"
          value={kind}
          onChange={(event) => setKind(event.target.value as typeof kind)}
        >
          <option value="elasticsearch">Elasticsearch</option>
          <option value="mongodb">MongoDB</option>
        </select>
        <button onClick={() => setUiLanguage("en")}>English</button>
        <button onClick={() => setUiLanguage("zh-Hans")}>中文</button>
        <button onClick={() => save({ ...settings, appearance: light ? "dark" : "light" }, false)}>
          Light / Dark
        </button>
        <button onClick={() => setDialog(true)}>Connection dialog</button>
      </div>
      <DocumentWorkspace key={kind} config={config} active password="" />
      {dialog && (
        <DatabaseConnectionDialog
          connection={config}
          ssh={[]}
          workspaceId="qa"
          save={() => true}
          close={() => setDialog(false)}
          report={() => {}}
        />
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <SettingsProvider>
    <Preview />
  </SettingsProvider>,
);
