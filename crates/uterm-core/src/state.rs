use crate::{string, CoreError, Result};
use serde_json::{json, Value};
use std::collections::HashSet;

pub fn defaults() -> Value {
    serde_json::from_str(include_str!("../../../shared/fixtures/legacy-state.json"))
        .expect("checked-in legacy fixture")
}
fn invalid(code: &str, message: &str) -> CoreError {
    CoreError::new(code, message)
}
fn text(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|s| !s.trim().is_empty())
}
fn identifier(value: Option<&Value>, ids: &mut HashSet<String>) -> Result<String> {
    let id = value
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| invalid("INVALID_WORKSPACE", "工作区数据无效，原数据已保留。"))?;
    if !ids.insert(id.into()) {
        return Err(invalid(
            "INVALID_WORKSPACE",
            "工作区数据无效，原数据已保留。",
        ));
    }
    Ok(id.into())
}
pub fn validate_workspace(value: &Value) -> Result<()> {
    let mut ids = HashSet::new();
    if value["version"] != 7 {
        return Err(invalid(
            "UNSUPPORTED_WORKSPACE",
            "Import a normalized version 7 workspace from the legacy client",
        ));
    }
    let groups = value["groups"]
        .as_array()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| invalid("INVALID_WORKSPACE", "工作区列表无效，原数据已保留。"))?;
    let projects = value["projects"]
        .as_array()
        .ok_or_else(|| invalid("INVALID_WORKSPACE", "工作区数据无效，原数据已保留。"))?;
    let mut group_ids = HashSet::new();
    for group in groups {
        group_ids.insert(identifier(group.get("id"), &mut ids)?);
        if !text(group.get("name")) {
            return Err(invalid(
                "INVALID_WORKSPACE",
                "工作区列表无效，原数据已保留。",
            ));
        }
        for kind in ["terminals", "chats"] {
            if let Some(sessions) = group.get(kind) {
                validate_sessions(sessions, &mut ids)?;
                for session in sessions.as_array().unwrap() {
                    if !text(session.get("directory"))
                        || session.get("worktreeId").is_some()
                        || session.get("ssh").is_some()
                        || kind == "chats" && !text(session.get("agent"))
                    {
                        return Err(invalid(
                            "INVALID_WORKSPACE",
                            "独立会话的启动目录或 Agent 无效。",
                        ));
                    }
                }
                validate_splits(
                    group.get(if kind == "terminals" {
                        "terminalSplits"
                    } else {
                        "chatSplits"
                    }),
                    sessions,
                )?;
            }
        }
        if let Some(connections) = group.get("sshConnections") {
            for connection in connections
                .as_array()
                .ok_or_else(|| invalid("INVALID_WORKSPACE", "SSH 连接数据无效，原数据已保留。"))?
            {
                identifier(connection.get("id"), &mut ids)?;
                if !crate::connections::ssh(connection, false) {
                    return Err(invalid(
                        "INVALID_WORKSPACE",
                        "SSH 连接数据无效，原数据已保留。",
                    ));
                }
                validate_sessions(&connection["sessions"], &mut ids)?;
                for session in connection["sessions"].as_array().unwrap() {
                    if !text(session.get("directory"))
                        || session.get("ssh").is_none()
                        || session["ssh"]["connection_id"] != connection["id"]
                        || session["ssh"]["workspace_id"] != group["id"]
                    {
                        return Err(invalid(
                            "INVALID_WORKSPACE",
                            "SSH 连接数据无效，原数据已保留。",
                        ));
                    }
                }
                validate_splits(connection.get("splitGroups"), &connection["sessions"])?;
            }
        }
        for kind in ["redisConnections", "databaseConnections"] {
            if let Some(connections) = group.get(kind) {
                for connection in connections
                    .as_array()
                    .ok_or_else(|| invalid("INVALID_WORKSPACE", "连接列表无效。"))?
                {
                    identifier(connection.get("id"), &mut ids)?;
                    if !(if kind == "redisConnections" {
                        crate::connections::redis(connection)
                    } else {
                        crate::connections::database(connection)
                    }) {
                        return Err(invalid("INVALID_WORKSPACE", "连接数据无效，原数据已保留。"));
                    }
                }
            }
        }
    }
    for project in projects {
        identifier(project.get("id"), &mut ids)?;
        if !text(project.get("name"))
            || !text(project.get("directory"))
            || !project["workspaceId"]
                .as_str()
                .is_some_and(|id| group_ids.contains(id))
        {
            return Err(invalid(
                "INVALID_WORKSPACE",
                "项目所属工作区不存在，原数据已保留。",
            ));
        }
        validate_sessions(&project["sessions"], &mut ids)?;
        let mut trees = HashSet::new();
        if let Some(worktrees) = project.get("worktrees") {
            for tree in worktrees
                .as_array()
                .ok_or_else(|| invalid("INVALID_WORKSPACE", "Worktree 列表无效。"))?
            {
                trees.insert(identifier(tree.get("id"), &mut ids)?);
                if !text(tree.get("name")) || !text(tree.get("path")) || !tree["branch"].is_string()
                {
                    return Err(invalid("INVALID_WORKSPACE", "Worktree 数据无效。"));
                }
            }
        }
        for session in project["sessions"].as_array().unwrap() {
            if session
                .get("worktreeId")
                .and_then(Value::as_str)
                .is_some_and(|id| !trees.contains(id))
            {
                return Err(invalid("INVALID_WORKSPACE", "会话所属 Worktree 不存在。"));
            }
            if session.get("ssh").is_some() {
                return Err(invalid(
                    "INVALID_WORKSPACE",
                    "SSH 连接数据无效，原数据已保留。",
                ));
            }
        }
        validate_splits(project.get("splitGroups"), &project["sessions"])?;
    }
    if !value["selectedWorkspace"]
        .as_str()
        .is_some_and(|s| group_ids.contains(s))
    {
        return Err(invalid(
            "INVALID_WORKSPACE",
            "Selected workspace does not exist",
        ));
    }
    for key in ["selectedProject", "selectedSession", "selectedWorktree"] {
        if let Some(v) = value.get(key) {
            if !v.is_null() && !v.is_string() {
                return Err(invalid(
                    "INVALID_WORKSPACE",
                    "Selection must retain its string/null representation",
                ));
            }
        }
    }
    Ok(())
}
fn validate_sessions(value: &Value, ids: &mut HashSet<String>) -> Result<()> {
    for session in value
        .as_array()
        .ok_or_else(|| invalid("INVALID_WORKSPACE", "会话列表无效，原数据已保留。"))?
    {
        identifier(session.get("id"), ids)?;
        if session.as_object().is_none_or(|s| {
            s.keys().any(|k| {
                ![
                    "id",
                    "name",
                    "shell",
                    "agent",
                    "directory",
                    "worktreeId",
                    "pinned",
                    "issue",
                    "ssh",
                ]
                .contains(&k.as_str())
            })
        }) {
            return Err(invalid("INVALID_WORKSPACE", "会话配置无效，原数据已保留。"));
        }
        if !text(session.get("name"))
            || !matches!(session["shell"].as_str(), Some("default" | "cmd"))
        {
            return Err(invalid("INVALID_WORKSPACE", "会话配置无效，原数据已保留。"));
        }
        if let Some(agent) = session.get("agent") {
            if !agent.as_str().is_some_and(agent_id) {
                return Err(invalid("INVALID_WORKSPACE", "会话配置无效，原数据已保留。"));
            }
        }
        for key in ["directory", "worktreeId"] {
            if session.get(key).is_some() && !text(session.get(key)) {
                return Err(invalid("INVALID_WORKSPACE", "会话配置无效，原数据已保留。"));
            }
        }
        if let Some(ssh) = session.get("ssh") {
            if !crate::connections::ssh(ssh, true)
                || session.get("agent").is_some()
                || session.get("worktreeId").is_some()
            {
                return Err(invalid("INVALID_WORKSPACE", "会话配置无效，原数据已保留。"));
            }
        }
        if let Some(issue) = session.get("issue") {
            if !issue["title"].is_string()
                || !issue["url"].as_str().is_some_and(|s| {
                    regex::Regex::new(
                        r"^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/(issues|pull)/\d+$",
                    )
                    .unwrap()
                    .is_match(s)
                })
            {
                return Err(invalid("INVALID_WORKSPACE", "会话关联链接无效。"));
            }
        }
    }
    Ok(())
}
fn validate_splits(value: Option<&Value>, sessions: &Value) -> Result<()> {
    let Some(value) = value else {
        return Ok(());
    };
    let error = || invalid("INVALID_WORKSPACE", "分组布局无效，原数据已保留。");
    let roots = value.as_array().ok_or_else(error)?;
    let sessions = sessions.as_array().ok_or_else(error)?;
    let mut used = HashSet::new();
    let mut branches = HashSet::new();
    fn node(
        v: &Value,
        depth: u32,
        sessions: &[Value],
        used: &mut HashSet<String>,
        branches: &mut HashSet<String>,
    ) -> Result<HashSet<String>> {
        let error = || {
            invalid(
                "INVALID_WORKSPACE",
                "分组布局包含重复或不存在的会话，原数据已保留。",
            )
        };
        if depth > 32 {
            return Err(error());
        }
        if v["kind"] == "leaf" {
            let id = v["session"].as_str().ok_or_else(error)?;
            let session = sessions.iter().find(|s| s["id"] == id).ok_or_else(error)?;
            if !used.insert(id.to_string()) {
                return Err(error());
            }
            return Ok(HashSet::from([session["worktreeId"]
                .as_str()
                .unwrap_or("root")
                .to_string()]));
        }
        let id = v["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(error)?;
        if v["kind"] != "split"
            || !branches.insert(id.to_string())
            || !matches!(v["axis"].as_str(), Some("horizontal" | "vertical"))
            || !v["ratio"].as_f64().is_some_and(f64::is_finite)
        {
            return Err(error());
        }
        let mut trees = node(&v["first"], depth + 1, sessions, used, branches)?;
        trees.extend(node(&v["second"], depth + 1, sessions, used, branches)?);
        Ok(trees)
    }
    for root in roots {
        if root["kind"] != "split" {
            return Err(error());
        }
        if node(root, 0, sessions, &mut used, &mut branches)?.len() != 1 {
            return Err(invalid("INVALID_WORKSPACE", "分组不能跨越 Worktree。"));
        }
    }
    Ok(())
}
fn agent_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

pub fn validate_settings(value: &Value) -> Result<()> {
    let error = || {
        invalid(
            "INVALID_SETTINGS",
            "设置文件无效，原数据已保留。请恢复默认设置后重试。",
        )
    };
    let object = value.as_object().ok_or_else(error)?;
    let baseline = defaults();
    let expected = baseline["settings"].as_object().unwrap();
    if value["version"] != 1
        || object.keys().any(|k| !expected.contains_key(k))
        || expected.keys().any(|k| !object.contains_key(k))
    {
        return Err(error());
    }
    for (key, default) in expected {
        let actual = &value[key];
        let valid = if default.is_boolean() {
            actual.is_boolean()
        } else if default.is_string() {
            actual.is_string()
        } else if default.is_number() {
            actual.as_f64().is_some_and(f64::is_finite)
        } else if default.is_array() {
            actual.is_array()
        } else {
            actual.is_object()
        };
        if !valid {
            return Err(error());
        }
    }
    for (key, min, max, integer) in [
        ("fileTabLimit", 1.0, 9007199254740991.0, true),
        ("breakInterval", 1.0, 1440.0, true),
        ("fontSize", 10.0, 32.0, false),
        ("fileFontSize", 10.0, 32.0, true),
        ("gitDiffFontSize", 10.0, 32.0, true),
        ("lineHeight", 1.0, 2.0, false),
        ("scrollback", 100.0, 100000.0, true),
        ("usageRefreshInterval", 10.0, 3600.0, true),
        ("interfaceSize", 10.0, 20.0, false),
        ("rowPadding", 0.0, 8.0, false),
        ("windowPadding", 0.0, 40.0, false),
        ("opacity", 0.3, 1.0, false),
    ] {
        let n = value[key].as_f64().ok_or_else(error)?;
        if n < min || n > max || integer && n.fract() != 0.0 {
            return Err(error());
        }
    }
    for (key, allowed) in [
        ("appearance", vec!["system", "dark", "light"]),
        ("inspectorPosition", vec!["left", "right"]),
        ("cursorStyle", vec!["block", "bar", "underline"]),
        ("defaultShell", vec!["default", "cmd"]),
        ("projectOrder", vec!["manual", "name"]),
        ("language", vec!["system", "zh-Hans", "en"]),
        ("sidebarStyle", vec!["navigation"]),
    ] {
        if !value[key].as_str().is_some_and(|s| allowed.contains(&s)) {
            return Err(error());
        }
    }
    for key in ["fontFamily", "interfaceFont"] {
        if !value[key]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty() && s.encode_utf16().count() <= 300)
        {
            return Err(error());
        }
    }
    if !value["defaultAgent"].as_str().is_some_and(agent_id) {
        return Err(error());
    }
    let enabled = value["enabledAgents"].as_array().unwrap();
    let mut agents = HashSet::new();
    for agent in enabled {
        let a = agent.as_str().filter(|a| agent_id(a)).ok_or_else(error)?;
        if !agents.insert(a) {
            return Err(error());
        }
    }
    let color = value["activeIconColor"].as_str().unwrap();
    if !color.is_empty()
        && !(color.len() == 7
            && color.starts_with('#')
            && color[1..].bytes().all(|c| c.is_ascii_hexdigit()))
    {
        return Err(error());
    }
    if !baseline["interfaceThemeIds"]
        .as_array()
        .unwrap()
        .contains(&value["interfaceTheme"])
    {
        return Err(error());
    }
    let custom = value["customThemes"].as_array().unwrap();
    if custom.len() > 30 {
        return Err(error());
    }
    for theme in custom {
        if !theme["id"]
            .as_str()
            .is_some_and(|s| s.starts_with("custom-"))
            || !theme["name"]
                .as_str()
                .is_some_and(|s| s.encode_utf16().count() <= 80)
        {
            return Err(error());
        }
        for key in baseline["paletteKeys"].as_array().unwrap() {
            let v = &theme[key.as_str().unwrap()];
            if !v.as_str().is_some_and(|s| {
                s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|c| c.is_ascii_hexdigit())
            }) {
                return Err(error());
            }
        }
    }
    for key in ["darkTheme", "lightTheme"] {
        if !baseline["themeIds"]
            .as_array()
            .unwrap()
            .contains(&value[key])
            && !custom.iter().any(|t| t["id"] == value[key])
        {
            return Err(error());
        }
    }
    for (key, binding) in value["shortcuts"].as_object().unwrap() {
        if !baseline["commandIds"]
            .as_array()
            .unwrap()
            .contains(&Value::String(key.clone()))
            || !binding.as_str().is_some_and(valid_binding)
        {
            return Err(error());
        }
    }
    Ok(())
}
fn valid_binding(value: &str) -> bool {
    if value.is_empty() {
        return true;
    }
    let Some(value) = value.strip_prefix("Mod+") else {
        return false;
    };
    let value = value.strip_prefix("Alt+").unwrap_or(value);
    let value = value.strip_prefix("Shift+").unwrap_or(value);
    value
        .strip_prefix("Key")
        .is_some_and(|s| s.len() == 1 && s.as_bytes()[0].is_ascii_uppercase())
        || value
            .strip_prefix("Digit")
            .is_some_and(|s| s.len() == 1 && s.as_bytes()[0].is_ascii_digit())
        || [
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
            "Comma",
            "Period",
            "Slash",
            "BracketLeft",
            "BracketRight",
            "Enter",
            "Backslash",
            "Minus",
            "Equal",
        ]
        .contains(&value)
}

pub fn transition(workspace: &mut Value, method: &str, params: &Value) -> Result<()> {
    validate_workspace(workspace)?;
    match method {
        "workspace.create" => {
            let id = string(params, "id")?;
            let name = string(params, "name")?;
            workspace["groups"].as_array_mut().unwrap().push(json!({"id":id,"name":name,"selectedProject":null,"selectedSession":null,"selectedWorktree":null,"redisConnections":[],"databaseConnections":[],"sshConnections":[],"terminals":[],"chats":[],"terminalSplits":[],"chatSplits":[],"terminalsCollapsed":false,"chatsCollapsed":false}));
        }
        "workspace.rename" => {
            let id = string(params, "id")?;
            let name = string(params, "name")?;
            for g in workspace["groups"].as_array_mut().unwrap() {
                if g["id"] == id {
                    g["name"] = Value::String(name.clone());
                }
            }
        }
        "workspace.switch" => {
            switch_workspace(workspace, &string(params, "id")?);
        }
        "project.select" => {
            let id = string(params, "id")?;
            if let Some(project) = workspace["projects"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["id"] == id)
            {
                let worktree = params.get("worktreeId").cloned().unwrap_or(Value::Null);
                let candidates: Vec<_> = project["sessions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|s| s.get("worktreeId").unwrap_or(&Value::Null) == &worktree)
                    .collect();
                let selected = candidates
                    .iter()
                    .find(|s| s["id"] == workspace["selectedSession"])
                    .or_else(|| candidates.first())
                    .map_or(Value::Null, |s| s["id"].clone());
                workspace["selectedProject"] = json!(id);
                workspace["selectedWorktree"] = worktree;
                workspace["selectedSession"] = selected;
            }
        }
        "workspace.remove" => {
            let id = string(params, "id")?;
            let groups = workspace["groups"].as_array().unwrap();
            let Some(group) = groups.iter().find(|g| g["id"] == id) else {
                return Ok(());
            };
            if groups.len() == 1
                || workspace["projects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|p| p["workspaceId"] == id)
                || [
                    "terminals",
                    "chats",
                    "sshConnections",
                    "databaseConnections",
                    "redisConnections",
                ]
                .iter()
                .any(|k| group[*k].as_array().is_some_and(|a| !a.is_empty()))
            {
                return Ok(());
            }
            if workspace["selectedWorkspace"] == id {
                let target = workspace["groups"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|g| g["id"] != id)
                    .unwrap()["id"]
                    .as_str()
                    .unwrap()
                    .to_string();
                switch_workspace(workspace, &target);
            }
            workspace["groups"]
                .as_array_mut()
                .unwrap()
                .retain(|g| g["id"] != id);
        }
        "project.add" => {
            let id = string(params, "id")?;
            let name = string(params, "name")?;
            let directory = string(params, "directory")?;
            let group = string(params, "workspaceId")?;
            if workspace["projects"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p["directory"] == directory)
            {
                return Err(invalid(
                    "PROJECT_EXISTS",
                    "Project directory already exists",
                ));
            }
            workspace["projects"].as_array_mut().unwrap().push(json!({"id":id,"name":name,"directory":directory,"workspaceId":group,"sessions":[],"splitGroups":[],"worktrees":[],"pinned":false,"collapsed":false}));
        }
        "project.rename" => {
            let id = string(params, "id")?;
            let name = string(params, "name")?;
            for p in workspace["projects"].as_array_mut().unwrap() {
                if p["id"] == id {
                    p["name"] = Value::String(name.clone());
                }
            }
        }
        "project.remove" => {
            let id = string(params, "id")?;
            workspace["projects"].as_array_mut().unwrap().retain(|p| {
                p["id"] != id || p["sessions"].as_array().is_some_and(|s| !s.is_empty())
            });
            normalize_selection(workspace);
        }
        "project.move" => {
            let id = string(params, "id")?;
            let target = string(params, "workspaceId")?;
            if workspace["groups"]
                .as_array()
                .unwrap()
                .iter()
                .any(|g| g["id"] == target)
            {
                for project in workspace["projects"].as_array_mut().unwrap() {
                    if project["id"] == id {
                        project["workspaceId"] = json!(target);
                    }
                }
                normalize_selection(workspace);
            }
        }
        "selection.set" => {
            for key in [
                "selectedWorkspace",
                "selectedProject",
                "selectedSession",
                "selectedWorktree",
            ] {
                if let Some(v) = params.get(key) {
                    workspace[key] = v.clone();
                }
            }
        }
        _ => {
            return Err(invalid(
                "UNKNOWN_METHOD",
                "Workspace operation is not implemented",
            ))
        }
    }
    validate_workspace(workspace)
}

fn switch_workspace(workspace: &mut Value, id: &str) {
    let Some(target) = workspace["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["id"] == id)
        .cloned()
    else {
        return;
    };
    if workspace["selectedWorkspace"] == id {
        return;
    }
    let previous = workspace["selectedWorkspace"].clone();
    let selection = [
        workspace["selectedProject"].clone(),
        workspace["selectedSession"].clone(),
        workspace["selectedWorktree"].clone(),
    ];
    for group in workspace["groups"].as_array_mut().unwrap() {
        if group["id"] == previous {
            for (index, key) in ["selectedProject", "selectedSession", "selectedWorktree"]
                .iter()
                .enumerate()
            {
                group[*key] = selection[index].clone();
            }
        }
    }
    workspace["selectedWorkspace"] = json!(id);
    for key in ["selectedProject", "selectedSession", "selectedWorktree"] {
        workspace[key] = target.get(key).cloned().unwrap_or(Value::Null);
    }
    normalize_selection(workspace);
}
fn normalize_selection(workspace: &mut Value) {
    let selected = workspace["selectedWorkspace"].clone();
    let session = workspace["selectedSession"].clone();
    let group = workspace["groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["id"] == selected)
        .unwrap();
    let mut loose = Vec::new();
    for connection in group["sshConnections"].as_array().into_iter().flatten() {
        loose.extend(connection["sessions"].as_array().into_iter().flatten());
    }
    for kind in ["terminals", "chats"] {
        loose.extend(group[kind].as_array().into_iter().flatten());
    }
    if loose.iter().any(|s| s["id"] == session) {
        workspace["selectedProject"] = Value::Null;
        workspace["selectedWorktree"] = Value::Null;
        return;
    }
    let projects = workspace["projects"].as_array().unwrap();
    let project = projects
        .iter()
        .find(|p| p["id"] == workspace["selectedProject"] && p["workspaceId"] == selected)
        .or_else(|| projects.iter().find(|p| p["workspaceId"] == selected));
    let (project, tree, session) = if let Some(project) = project {
        let tree = project["worktrees"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|t| t["id"] == workspace["selectedWorktree"])
            .map_or(Value::Null, |t| t["id"].clone());
        let candidates: Vec<_> = project["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|s| s.get("worktreeId").unwrap_or(&Value::Null) == &tree)
            .collect();
        let session = candidates
            .iter()
            .find(|s| s["id"] == session)
            .or_else(|| candidates.first())
            .map_or(Value::Null, |s| s["id"].clone());
        (project["id"].clone(), tree, session)
    } else {
        (
            Value::Null,
            Value::Null,
            loose.first().map_or(Value::Null, |s| s["id"].clone()),
        )
    };
    workspace["selectedProject"] = project;
    workspace["selectedWorktree"] = tree;
    workspace["selectedSession"] = session;
}
