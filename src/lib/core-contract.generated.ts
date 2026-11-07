// Generated from uterm-core Rust DTOs; run pnpm contracts:generate.
// 由 uterm-core Rust DTO 生成；执行 pnpm contracts:generate。
export type JSONValue =
  null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };

export interface CoreActivityEvent {
  id: string;
  kind: string;
  sequence: bigint;
  source: string;
}

export interface CoreCoreError {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface CoreDatabaseOperation {
  error?: string | null;
  generation: string;
  id: string;
  kind: string;
  result?: JSONValue;
  state: string;
}

export interface CoreDocument {
  legacy: Record<string, string>;
  migrationId: string;
  schemaVersion: number;
  settings: JSONValue;
  workspace: JSONValue;
}

export interface CoreEditorDraft {
  bom: boolean;
  directory: string;
  kind: string;
  line_ending: string;
  path: string;
  saved: string;
  text: string;
  version: string;
}

export interface CoreEditorDraftCollection {
  drafts: CoreEditorDraftEntry[];
  revision: string;
}

export interface CoreEditorDraftDocument {
  drafts: CoreEditorDraft[];
  schemaVersion: number;
  sourceDigest?: string | null;
}

export interface CoreEditorDraftEntry {
  draft: CoreEditorDraft;
  revision: string;
}

export interface CoreEditorDraftSnapshot {
  document: CoreEditorDraftDocument;
  revision: string;
}

export interface CoreEditorRecoveryCatalog {
  backups: string[];
  currentRevision?: string | null;
  sources: string[];
}

export interface CoreEvent {
  kind: string;
  operationId: string;
  revision: string;
  version: number;
}

export interface CoreFileDocument {
  bom: boolean;
  kind: string;
  line_ending: string;
  notice?: string | null;
  readonly: boolean;
  text: string;
  version: string;
}

export interface CoreFileEntry {
  directory: boolean;
  name: string;
  path: string;
  symlink: boolean;
}

export interface CoreFileListing {
  entries: CoreFileEntry[];
  partial: boolean;
  skipped: number;
}

export interface CoreFileMatch {
  line: number;
  path: string;
  text: string;
}

export interface CoreFileSearch {
  matches: CoreFileMatch[];
  partial: boolean;
  skipped: number;
}

export interface CoreGitBranches {
  current?: string | null;
  local: string[];
  upstream?: string | null;
}

export interface CoreGitChange {
  index: string;
  original?: string | null;
  path: string;
  working: string;
}

export interface CoreGitCommit {
  author: string;
  id: string;
  message: string;
  parents: string[];
  subject: string;
  timestamp: string;
}

export interface CoreGitDiff {
  text: string;
  truncated: boolean;
}

export interface CoreGitFavoriteDocument {
  repositories: Record<string, CoreGitFavoriteRepository>;
  schemaVersion: number;
}

export interface CoreGitFavoriteRecoveryCatalog {
  backups: string[];
  currentRevision?: string | null;
  sources: string[];
}

export interface CoreGitFavoriteRecoverySnapshot {
  document: CoreGitFavoriteDocument;
  revision: string;
}

export interface CoreGitFavoriteRepository {
  aliases: string[];
  references: string[];
  sourceDigest?: string | null;
}

export interface CoreGitFavorites {
  references: string[];
  repository: string;
  revision?: string | null;
  sourceDigest?: string | null;
}

export interface CoreGitFileStatus {
  changes: CoreGitChange[];
  root: string;
  truncated: boolean;
}

export interface CoreGitReference {
  ahead?: number | null;
  behind?: number | null;
  branch?: string | null;
  current: boolean;
  full_name: string;
  kind: string;
  name: string;
  oid?: string | null;
  remote?: string | null;
  upstream?: string | null;
  worktree?: string | null;
}

export interface CoreGitReferenceAction {
  action: string;
  branch?: string | null;
  current?: string | null;
  name?: string | null;
  oid?: string | null;
  reference: string;
  remote?: string | null;
}

export interface CoreGitReferences {
  current?: string | null;
  references: CoreGitReference[];
  remotes: string[];
  repository: string;
  root: string;
}

export interface CoreGitRemoteBranch {
  branch: string;
  remote: string;
}

export interface CoreGitRemoteBranches {
  branches: CoreGitRemoteBranch[];
  errors: string[];
}

export interface CoreGitSnapshot {
  branch: string;
  changes: CoreGitChange[];
  head?: string | null;
  references: string[];
  root: string;
  truncated: boolean;
}

export interface CoreGitWorktree {
  branch: string;
  missing: boolean;
  path: string;
}

export interface CoreGitWorktreeSuggestion {
  branch: string;
  path: string;
}

export interface CoreImport {
  legacy: Record<string, string>;
  settings: JSONValue;
  workspace: JSONValue;
}

export interface CoreInputControl {
  owned: boolean;
  owner?: string | null;
}

export interface CoreJavaConfiguration {
  configured: boolean;
  global: CoreJavaMavenConfig;
  jdks: CoreJavaHome[];
  maven_home?: string | null;
  project: CoreJavaProjectConfig;
  revision: string;
}

export interface CoreJavaHome {
  available: boolean;
  home: string;
  registered: boolean;
  version: number;
}

export interface CoreJavaMainClass {
  name: string;
  spring_boot: boolean;
}

export interface CoreJavaMavenConfig {
  distribution?: string;
  home?: string;
  repository?: string;
  settings?: string;
  wrapper?: boolean;
}

export interface CoreJavaModule {
  boot: boolean;
  jars: string[];
  java_version?: number | null;
  main_classes: CoreJavaMainClass[];
  name: string;
  packaging: string;
  path: string;
}

export interface CoreJavaProjectConfig {
  arguments?: string[];
  jar?: string;
  java_home?: string;
  java_version?: number;
  main_class?: string;
  maven?: CoreJavaMavenConfig;
  maven_configured?: boolean;
  maven_profiles?: string;
  maven_scope?: string;
  mode?: string;
  module?: string;
  offline?: boolean;
  skip_tests?: boolean;
  spring_profiles?: string;
  vm_arguments?: string[];
}

export interface CoreJavaProjectInfo {
  modules: CoreJavaModule[];
}

export interface CoreLegacyDraftCandidate {
  directory: string;
  path: string;
  value: string;
}

export interface CoreProjectContext {
  directory?: string | null;
  projectId?: string | null;
  revision: string;
  worktreeId?: string | null;
}

export interface CorePythonCandidate {
  mode: string;
  target: string;
  working_directory: string;
}

export interface CorePythonConfiguration {
  configured: boolean;
  project: CorePythonRunConfig;
  revision: string;
}

export interface CorePythonInterpreter {
  path: string;
  version: string;
  virtual_environment: boolean;
}

export interface CorePythonProjectInfo {
  candidates: CorePythonCandidate[];
  truncated: boolean;
}

export interface CorePythonRunConfig {
  arguments?: string[];
  host?: string;
  interpreter?: string;
  mode?: string;
  port?: number;
  reload?: boolean;
  target?: string;
  working_directory?: string;
}

export interface CoreRedisOperation {
  error?: string | null;
  generation: string;
  id: string;
  kind: string;
  result?: JSONValue;
  state: string;
}

export interface CoreRequest {
  id: string;
  method: string;
  params?: JSONValue;
  version: number;
}

export interface CoreResponse {
  error?: CoreCoreError | null;
  id: string;
  result?: JSONValue;
  version: number;
}

export interface CoreRollbackArchive {
  automaticRestoreAllowed: boolean;
  editor?: CoreEditorDraftSnapshot | null;
  legacyDraftCandidates: CoreLegacyDraftCandidate[];
  legacyRequiresDraftChoice: boolean;
  legacyValues: Record<string, string>;
  schemaVersion: number;
  snapshot: CoreSnapshot;
}

export interface CoreSessionEntry {
  directory: string;
  projectId?: string | null;
  rosterId: string;
  session: JSONValue;
  workspaceId: string;
}

export interface CoreSnapshot {
  document: CoreDocument;
  revision: string;
}

export interface CoreSshInfo {
  aliases: string[];
  available: boolean;
}

export interface CoreSshOperation {
  error?: string | null;
  generation: string;
  id: string;
  kind: string;
  progress?: CoreSshProgress | null;
  result?: JSONValue;
  state: string;
}

export interface CoreSshProgress {
  completed: string;
  name: string;
  total: string;
}

export interface CoreSshResolution {
  hostname: string;
  port: string;
  proxy: boolean;
  username: string;
}

export interface CoreSshTrustPrompt {
  id: string;
  message: string;
}

export interface CoreTerminalHeader {
  agent_activity_error: string | null;
  agent_events: CoreActivityEvent[] | null;
  agent_state: string | null;
  attachment?: string | null;
  code: number | null;
  cols: number;
  error: string | null;
  exited: boolean;
  foreground_agent: string | null;
  generation?: string | null;
  input_control?: CoreInputControl | null;
  reset: boolean;
  rows: number;
  sequence: bigint;
}

export interface CoreViewSnapshot {
  layout: JSONValue;
  sessions: CoreSessionEntry[];
  snapshot: CoreSnapshot;
}
