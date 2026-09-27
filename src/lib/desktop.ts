import { invoke, isTauri } from "@tauri-apps/api/core";

export interface RuntimeInfo {
  platform: string;
  architecture: string;
  version: string;
  home: string;
  agents: string[];
  agent_definitions: AgentDefinition[];
  debug: boolean;
  chat_directory: string;
}

export function isDesktop(): boolean {
  return isTauri();
}

export function getRuntimeInfo(): Promise<RuntimeInfo> {
  return invoke<RuntimeInfo>("runtime_info");
}

export interface AgentDefinition {
  id: string;
  name: string;
  program: string;
  arguments: string[];
}
