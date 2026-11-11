#![recursion_limit = "256"]

use std::io::{self, BufRead, Write};
use uterm_core::{
    store::{Document, Import, Snapshot},
    Core, CoreError, Event, Request, Response,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let askpass = uterm_core::ssh::run_askpass_if_requested();
    if askpass >= 0 {
        std::process::exit(askpass);
    }
    let mut args = std::env::args().skip(1);
    let mode = args.next();
    if mode.as_deref() == Some("--schema") {
        let schemas = serde_json::json!({
            "InputControl":schemars::schema_for!(uterm_core::terminal::InputControl),
            "SshInfo":schemars::schema_for!(uterm_core::ssh::Info),
            "SshResolution":schemars::schema_for!(uterm_core::ssh::Resolution),
            "SshOperation":schemars::schema_for!(uterm_core::ssh::service::Operation),
            "DatabaseOperation":schemars::schema_for!(uterm_core::database::service::Operation),
            "RedisOperation":schemars::schema_for!(uterm_core::redis::service::Operation),
            "SshProgress":schemars::schema_for!(uterm_core::ssh::service::Progress),
            "SshTrustPrompt":schemars::schema_for!(uterm_core::ssh::service::TrustPrompt),
            "JavaMavenConfig":schemars::schema_for!(uterm_core::java::MavenConfig),
            "JavaProjectConfig":schemars::schema_for!(uterm_core::java::ProjectConfig),
            "JavaConfiguration":schemars::schema_for!(uterm_core::java::Configuration),
            "JavaHome":schemars::schema_for!(uterm_core::java::JavaHome),
            "JavaComponentItem":schemars::schema_for!(uterm_core::java_components::Item),
            "JavaComponentCatalog":schemars::schema_for!(uterm_core::java_components::Status),
            "JavaComponentOperation":schemars::schema_for!(uterm_core::java_components::service::Operation),
            "JavaComponentProgress":schemars::schema_for!(uterm_core::java_components::service::Progress),
            "JavaModule":schemars::schema_for!(uterm_core::java::Module),
            "JavaMainClass":schemars::schema_for!(uterm_core::java::MainClass),
            "JavaProjectInfo":schemars::schema_for!(uterm_core::java::ProjectInfo),
            "PythonRunConfig":schemars::schema_for!(uterm_core::python::RunConfig),
            "PythonConfiguration":schemars::schema_for!(uterm_core::python::Configuration),
            "PythonInterpreter":schemars::schema_for!(uterm_core::python::Interpreter),
            "PythonCandidate":schemars::schema_for!(uterm_core::python::Candidate),
            "PythonProjectInfo":schemars::schema_for!(uterm_core::python::ProjectInfo),
            "EditorDraft":schemars::schema_for!(uterm_core::store::EditorDraft),
            "EditorDraftEntry":schemars::schema_for!(uterm_core::store::EditorDraftEntry),
            "EditorDraftCollection":schemars::schema_for!(uterm_core::store::EditorDraftCollection),
            "EditorDraftDocument":schemars::schema_for!(uterm_core::store::EditorDraftDocument),
            "EditorDraftSnapshot":schemars::schema_for!(uterm_core::store::EditorDraftSnapshot),
            "RollbackArchive":schemars::schema_for!(uterm_core::store::RollbackArchive),
            "LegacyDraftCandidate":schemars::schema_for!(uterm_core::store::LegacyDraftCandidate),
            "EditorRecoveryCatalog":schemars::schema_for!(uterm_core::store::EditorRecoveryCatalog),
            "GitChange":schemars::schema_for!(uterm_core::git::Change),
            "GitSnapshot":schemars::schema_for!(uterm_core::git::Snapshot),
            "GitFileStatus":schemars::schema_for!(uterm_core::git::FileStatus),
            "GitDiff":schemars::schema_for!(uterm_core::git::Diff),
            "GitCommit":schemars::schema_for!(uterm_core::git::Commit),
            "GitBranches":schemars::schema_for!(uterm_core::git::Branches),
            "GitRemoteBranch":schemars::schema_for!(uterm_core::git::RemoteBranch),
            "GitRemoteBranches":schemars::schema_for!(uterm_core::git::RemoteBranches),
            "GitReference":schemars::schema_for!(uterm_core::git::Reference),
            "GitReferences":schemars::schema_for!(uterm_core::git::References),
            "GitFavorites":schemars::schema_for!(uterm_core::store::GitFavorites),
            "GitFavoriteRepository":schemars::schema_for!(uterm_core::store::GitFavoriteRepository),
            "GitFavoriteDocument":schemars::schema_for!(uterm_core::store::GitFavoriteDocument),
            "GitFavoriteRecoveryCatalog":schemars::schema_for!(uterm_core::store::GitFavoriteRecoveryCatalog),
            "GitFavoriteRecoverySnapshot":schemars::schema_for!(uterm_core::store::GitFavoriteRecoverySnapshot),
            "GitReferenceAction":schemars::schema_for!(uterm_core::git::ReferenceAction),
            "GitWorktree":schemars::schema_for!(uterm_core::worktrees::Worktree),
            "GitWorktreeSuggestion":schemars::schema_for!(uterm_core::worktrees::WorktreeSuggestion),
            "ProjectContext":schemars::schema_for!(uterm_core::state::ProjectContext),
            "FileDocument":schemars::schema_for!(uterm_core::files::FileDocument),
            "FileEntry":schemars::schema_for!(uterm_core::files::FileEntry),
            "FileListing":schemars::schema_for!(uterm_core::files::FileListing),
            "FileMatch":schemars::schema_for!(uterm_core::files::FileMatch),
            "FileSearch":schemars::schema_for!(uterm_core::files::FileSearch),
            "CoreError":schemars::schema_for!(CoreError),
            "Request":schemars::schema_for!(Request),
            "Response":schemars::schema_for!(Response),
            "Event":schemars::schema_for!(Event),
            "Document":schemars::schema_for!(Document),
            "Import":schemars::schema_for!(Import),
            "Snapshot":schemars::schema_for!(Snapshot)
            ,"TerminalHeader":schemars::generate::SchemaSettings::default().for_serialize().into_generator().into_root_schema_for::<uterm_core::terminal::TerminalHeader>()
            ,"ActivityEvent":schemars::schema_for!(uterm_core::terminal::ActivityEvent)
            ,"SessionEntry":schemars::schema_for!(uterm_core::session_state::Entry)
            ,"ViewSnapshot":schemars::schema_for!(uterm_core::ViewSnapshot)
        });
        println!("{}", serde_json::to_string(&schemas)?);
        return Ok(());
    }
    let root = args
        .next()
        .ok_or("Usage: uterm-core-contract --schema | --serve ROOT | --hold-store-lock ROOT")?;
    if mode.as_deref() == Some("--hold-store-lock") {
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(std::path::Path::new(&root).join("writer.lock"))?;
        file.lock()?;
        println!("locked");
        io::stdout().flush()?;
        io::stdin().lock().read_line(&mut String::new())?;
        file.unlock()?;
        return Ok(());
    }
    if mode.as_deref() != Some("--serve") {
        return Err("Unknown contract fixture mode".into());
    }
    let core = Core::open(root.into())?;
    for line in io::stdin().lock().lines() {
        println!(
            "{}",
            serde_json::to_string(&core.execute(line?.as_bytes()))?
        );
    }
    Ok(())
}
