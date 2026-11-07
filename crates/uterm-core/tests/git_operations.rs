use serde_json::{json, Value};
use std::{collections::BTreeSet, path::Path};
use uterm_core::{Core, Response};

fn git(root: &Path, args: &[&str]) -> String {
    String::from_utf8(uterm_core::git::run(root.to_str().unwrap(), args).unwrap())
        .unwrap()
        .trim_end_matches(['\r', '\n'])
        .to_owned()
}
fn commit(root: &Path) {
    git(root, &["add", "--all"]);
    git(
        root,
        &[
            "-c",
            "core.hooksPath=",
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--no-gpg-sign",
            "-m",
            "isolated contract fixture",
        ],
    );
}
fn execute(core: &Core, method: &str, params: Value) -> Response {
    core.execute(
        &serde_json::to_vec(
            &json!({"version":1,"id":"git-operation-qa","method":method,"params":params}),
        )
        .unwrap(),
    )
}
fn call(core: &Core, methods: &mut BTreeSet<String>, method: &str, params: Value) -> Value {
    let response = execute(core, method, params);
    assert!(response.error.is_none(), "{method}: {:?}", response.error);
    methods.insert(method.into());
    response.result.unwrap()
}

#[test]
fn serialized_git_contract_keeps_selected_repository_worktree_and_failed_writes_isolated() {
    let temporary = tempfile::tempdir().unwrap();
    let selected = temporary.path().join("selected 中文");
    let other = temporary.path().join("unselected");
    let remote = temporary.path().join("remote.git");
    for root in [&selected, &other, &remote] {
        std::fs::create_dir(root).unwrap();
    }
    for root in [&selected, &other] {
        git(root, &["init", "--initial-branch=main"]);
        git(root, &["config", "core.autocrlf", "false"]);
        std::fs::write(root.join("tracked.txt"), "original 中文\n").unwrap();
        commit(root);
    }
    git(&remote, &["init", "--bare", "--initial-branch=main"]);
    git(
        &selected,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&selected, &["push", "-u", "origin", "main"]);
    git(
        &selected,
        &["push", "origin", "main:refs/heads/remote-feature"],
    );
    let unselected_head = git(&other, &["rev-parse", "HEAD"]);
    let unselected_bytes = std::fs::read(other.join("tracked.txt")).unwrap();
    let core = Core::open(temporary.path().join("state")).unwrap();
    let mut methods = BTreeSet::new();
    let snapshot = call(
        &core,
        &mut methods,
        "git.snapshot",
        json!({"directory":selected}),
    );
    let head = snapshot["head"].as_str().unwrap().to_owned();
    assert_eq!(snapshot["branch"], "main");
    assert_eq!(
        call(
            &core,
            &mut methods,
            "git.branch",
            json!({"directory":selected})
        ),
        "main"
    );
    for method in ["git.branches", "git.references", "git.remoteBranches"] {
        call(&core, &mut methods, method, json!({"directory":selected}));
    }
    let history = call(
        &core,
        &mut methods,
        "git.history",
        json!({"directory":selected,"skip":0,"reference":"HEAD"}),
    );
    assert_eq!(history.as_array().unwrap().len(), 1);
    assert!(!call(
        &core,
        &mut methods,
        "git.files",
        json!({"directory":selected,"reference":"HEAD","compare":false})
    )
    .as_array()
    .unwrap()
    .is_empty());
    std::fs::write(selected.join("tracked.txt"), "staged change 中文\n").unwrap();
    git(&selected, &["add", "tracked.txt"]);
    std::fs::write(selected.join("tracked.txt"), "working change 中文\n").unwrap();
    std::fs::write(selected.join("keep.txt"), "untracked must survive\n").unwrap();
    call(
        &core,
        &mut methods,
        "git.fileStatus",
        json!({"directory":selected}),
    );
    let diff = call(
        &core,
        &mut methods,
        "git.diff",
        json!({"directory":selected,"path":"tracked.txt","mode":"working","reference":null}),
    );
    assert!(diff["text"].as_str().unwrap().contains("working change"));
    let staged = call(
        &core,
        &mut methods,
        "git.diff",
        json!({"directory":selected,"path":"tracked.txt","mode":"staged","reference":null}),
    );
    assert!(staged["text"].as_str().unwrap().contains("staged change"));
    assert!(!staged["text"].as_str().unwrap().contains("working change"));
    assert!(!call(
        &core,
        &mut methods,
        "git.workingComparison",
        json!({"directory":selected,"reference":"HEAD"})
    )
    .as_array()
    .unwrap()
    .is_empty());
    let snapshot = call(
        &core,
        &mut methods,
        "git.snapshot",
        json!({"directory":selected}),
    );
    let change = snapshot["changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["path"] == "tracked.txt")
        .unwrap();
    call(
        &core,
        &mut methods,
        "git.rollbackFile",
        json!({"directory":selected,"expected":change,"head":head}),
    );
    assert_eq!(
        std::fs::read(selected.join("tracked.txt")).unwrap(),
        "original 中文\n".as_bytes()
    );
    assert_eq!(
        std::fs::read(selected.join("keep.txt")).unwrap(),
        b"untracked must survive\n"
    );

    for action in ["fetch", "pull", "push"] {
        call(
            &core,
            &mut methods,
            "git.branchAction",
            json!({"directory":selected,"action":action,"expected":"main"}),
        );
    }
    call(
        &core,
        &mut methods,
        "git.switchRemoteBranch",
        json!({"directory":selected,"remote":"origin","branch":"remote-feature","expected":"main"}),
    );
    call(
        &core,
        &mut methods,
        "git.switchBranch",
        json!({"directory":selected,"branch":"main","expected":"remote-feature"}),
    );
    for (action, reference, name, remote_name, branch) in [
        ("create", "HEAD", Some("qa/new"), None, None),
        (
            "rename",
            "refs/heads/qa/new",
            Some("qa/renamed"),
            None,
            None,
        ),
        (
            "upstream",
            "refs/heads/qa/renamed",
            None,
            Some("origin"),
            Some("main"),
        ),
        (
            "push",
            "refs/heads/qa/renamed",
            None,
            Some("origin"),
            Some("qa-pushed"),
        ),
    ] {
        call(
            &core,
            &mut methods,
            "git.referenceAction",
            json!({"directory":selected,"target":{"action":action,"reference":reference,"oid":head,"current":"main","name":name,"remote":remote_name,"branch":branch}}),
        );
    }
    assert_eq!(
        git(&selected, &["rev-parse", "refs/heads/qa/renamed"]),
        head
    );
    assert_eq!(git(&remote, &["rev-parse", "refs/heads/qa-pushed"]), head);
    let stale = execute(
        &core,
        "git.referenceAction",
        json!({"directory":selected,"target":{"action":"create","reference":"HEAD","oid":"0".repeat(40),"name":"must-not-exist"}}),
    );
    assert_eq!(stale.error.unwrap().code, "GIT_ERROR");
    assert!(uterm_core::git::run(
        selected.to_str().unwrap(),
        &["show-ref", "--verify", "refs/heads/must-not-exist"]
    )
    .is_err());

    git(&selected, &["switch", "-c", "conflicting"]);
    std::fs::write(selected.join("tracked.txt"), "other committed writer\n").unwrap();
    // Keep the unrelated untracked file out of the fixture commit.
    // 无关的未跟踪文件不进入夹具提交。
    git(&selected, &["add", "tracked.txt"]);
    git(
        &selected,
        &[
            "-c",
            "core.hooksPath=",
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--no-gpg-sign",
            "-m",
            "conflicting content",
        ],
    );
    git(&selected, &["switch", "main"]);
    let dirty = "unsaved selected writer 中文\n".as_bytes();
    std::fs::write(selected.join("tracked.txt"), dirty).unwrap();
    for expected in ["stale-branch", "main"] {
        let refused = execute(
            &core,
            "git.switchBranch",
            json!({"directory":selected,"branch":"conflicting","expected":expected}),
        );
        assert_eq!(refused.error.unwrap().code, "GIT_ERROR");
        assert_eq!(std::fs::read(selected.join("tracked.txt")).unwrap(), dirty);
        assert_eq!(git(&selected, &["symbolic-ref", "--short", "HEAD"]), "main");
    }

    let tree = temporary.path().join("worktree 中文");
    let suggestion = call(
        &core,
        &mut methods,
        "git.worktrees.suggestion",
        json!({"directory":selected,"reference":"refs/heads/main"}),
    );
    assert!(suggestion["branch"]
        .as_str()
        .unwrap()
        .starts_with("main-worktree-"));
    call(
        &core,
        &mut methods,
        "git.worktrees.create",
        json!({"directory":selected,"reference":"refs/heads/main","oid":head,"branch":"qa/tree","path":tree}),
    );
    call(
        &core,
        &mut methods,
        "git.worktrees.list",
        json!({"directory":tree}),
    );
    call(
        &core,
        &mut methods,
        "git.referenceAction",
        json!({"directory":tree,"target":{"action":"create","reference":"HEAD","oid":head,"name":"qa/from-tree"}}),
    );
    assert_eq!(git(&tree, &["symbolic-ref", "--short", "HEAD"]), "qa/tree");
    assert_eq!(git(&selected, &["symbolic-ref", "--short", "HEAD"]), "main");
    std::fs::write(tree.join("retain.txt"), dirty).unwrap();
    let refused = execute(
        &core,
        "git.worktrees.delete",
        json!({"directory":selected,"path":tree}),
    );
    assert_eq!(refused.error.unwrap().code, "GIT_ERROR");
    assert_eq!(std::fs::read(tree.join("retain.txt")).unwrap(), dirty);
    std::fs::remove_file(tree.join("retain.txt")).unwrap();
    call(
        &core,
        &mut methods,
        "git.worktrees.delete",
        json!({"directory":selected,"path":tree}),
    );
    assert!(!tree.exists());
    assert_eq!(std::fs::read(selected.join("tracked.txt")).unwrap(), dirty);
    assert_eq!(git(&other, &["rev-parse", "HEAD"]), unselected_head);
    assert_eq!(
        std::fs::read(other.join("tracked.txt")).unwrap(),
        unselected_bytes
    );
    assert_eq!(git(&other, &["status", "--porcelain"]), "");
    assert_eq!(methods.len(), 19);
    if let Some(path) = std::env::var_os("UTERM_GIT_CORE_REPORT") {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"));
        let tested = git(source, &["rev-parse", "HEAD"]);
        std::fs::write(path, serde_json::to_vec_pretty(&json!({
            "passed":true,"sourceHeadSHA":std::env::var("PR_HEAD_SHA").unwrap_or_else(|_|tested.clone()),
            "testedMergeSHA":tested,"sourceTreeDirty":!git(source,&["status","--porcelain","--untracked-files=no"]).is_empty(),
            "platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,"gitVersion":git(source,&["--version"]),
            "operations":methods,"actualLocalGitProcesses":true,"remote":"isolated disposable bare repository; no network credentials",
            "staleReferenceRefused":true,"staleBranchRefused":true,"checkoutConflictRetainedBytes":true,
            "rollbackRetainedUnrelatedFile":true,"selectedWorktreeRetainedMainCheckout":true,"dirtyWorktreeRefused":true,
            "workingAndStagedDiffDistinct":true,
            "unselectedRepositoryUnchanged":true,"cleanWorktreeDeleted":true,"guiAcceptance":false
        })).unwrap()).unwrap();
    }
}
