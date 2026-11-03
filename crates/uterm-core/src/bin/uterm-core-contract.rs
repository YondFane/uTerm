use std::io::{self, BufRead};
use uterm_core::{
    store::{Document, Import, Snapshot},
    Core, CoreError, Event, Request, Response,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some("--schema") {
        let schemas = serde_json::json!({
            "EditorDraft":schemars::schema_for!(uterm_core::store::EditorDraft),
            "EditorDraftEntry":schemars::schema_for!(uterm_core::store::EditorDraftEntry),
            "EditorDraftCollection":schemars::schema_for!(uterm_core::store::EditorDraftCollection),
            "EditorDraftDocument":schemars::schema_for!(uterm_core::store::EditorDraftDocument),
            "EditorDraftSnapshot":schemars::schema_for!(uterm_core::store::EditorDraftSnapshot),
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
        .ok_or("Usage: uterm-core-contract --schema | --serve ROOT")?;
    let core = Core::open(root.into())?;
    for line in io::stdin().lock().lines() {
        println!(
            "{}",
            serde_json::to_string(&core.execute(line?.as_bytes()))?
        );
    }
    Ok(())
}
