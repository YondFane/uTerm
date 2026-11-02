use crate::{state, string, CoreError, Result};
use serde_json::{json, Value};

struct Roster {
    id: String,
    workspace: String,
    project: Option<String>,
    sessions: String,
    splits: String,
}
fn rosters(w: &Value) -> Vec<Roster> {
    let mut rows = Vec::new();
    for (i, p) in w["projects"].as_array().into_iter().flatten().enumerate() {
        rows.push(Roster {
            id: p["id"].as_str().unwrap().into(),
            workspace: p["workspaceId"].as_str().unwrap().into(),
            project: Some(p["id"].as_str().unwrap().into()),
            sessions: format!("/projects/{i}/sessions"),
            splits: format!("/projects/{i}/splitGroups"),
        });
    }
    for (i, g) in w["groups"].as_array().into_iter().flatten().enumerate() {
        for (kind, splits) in [("terminals", "terminalSplits"), ("chats", "chatSplits")] {
            rows.push(Roster {
                id: format!("{kind}:{}", g["id"].as_str().unwrap()),
                workspace: g["id"].as_str().unwrap().into(),
                project: None,
                sessions: format!("/groups/{i}/{kind}"),
                splits: format!("/groups/{i}/{splits}"),
            });
        }
        for (j, c) in g["sshConnections"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
        {
            rows.push(Roster {
                id: format!("ssh:{}", c["id"].as_str().unwrap()),
                workspace: g["id"].as_str().unwrap().into(),
                project: None,
                sessions: format!("/groups/{i}/sshConnections/{j}/sessions"),
                splits: format!("/groups/{i}/sshConnections/{j}/splitGroups"),
            });
        }
    }
    rows
}
fn sessions<'a>(w: &'a Value, r: &Roster) -> &'a [Value] {
    w.pointer(&r.sessions)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}
fn owner(w: &Value, id: &str) -> Option<Roster> {
    rosters(w)
        .into_iter()
        .find(|r| sessions(w, r).iter().any(|s| s["id"] == id))
}
fn assign(w: &mut Value, path: &str, value: Value) {
    let (parent, key) = path.rsplit_once('/').unwrap();
    w.pointer_mut(parent).unwrap()[key] = value;
}
fn select(w: &mut Value, r: &Roster, id: &str) {
    let tree = sessions(w, r)
        .iter()
        .find(|s| s["id"] == id)
        .and_then(|s| s.get("worktreeId"))
        .cloned()
        .unwrap_or(Value::Null);
    state::switch_workspace(w, &r.workspace);
    w["selectedProject"] = json!(r.project);
    w["selectedSession"] = json!(id);
    w["selectedWorktree"] = tree;
}
fn enabled(settings: &Value, agent: &Value) -> Result<()> {
    if !agent.is_null()
        && !settings["enabledAgents"]
            .as_array()
            .unwrap()
            .contains(agent)
    {
        return Err(CoreError::new(
            "AGENT_DISABLED",
            "Enable the Agent before creating a session",
        ));
    }
    Ok(())
}
fn contains(node: &Value, id: &str) -> bool {
    if node["kind"] == "leaf" {
        node["session"] == id
    } else {
        contains(&node["first"], id) || contains(&node["second"], id)
    }
}
fn remove(node: &Value, id: &str) -> Option<Value> {
    if node["kind"] == "leaf" {
        return (node["session"] != id).then(|| node.clone());
    }
    match (remove(&node["first"], id), remove(&node["second"], id)) {
        (Some(a), Some(b)) => {
            let mut n = node.clone();
            n["first"] = a;
            n["second"] = b;
            Some(n)
        }
        (Some(n), None) | (None, Some(n)) => Some(n),
        (None, None) => None,
    }
}
fn leaves(node: &Value) -> Vec<String> {
    if node["kind"] == "leaf" {
        vec![node["session"].as_str().unwrap().into()]
    } else {
        let mut ids = leaves(&node["first"]);
        ids.extend(leaves(&node["second"]));
        ids
    }
}
fn sibling(node: &Value, id: &str) -> Option<String> {
    if node["kind"] == "leaf" {
        return None;
    }
    if node["first"]["kind"] == "leaf" && node["first"]["session"] == id {
        return leaves(&node["second"]).into_iter().next();
    }
    if node["second"]["kind"] == "leaf" && node["second"]["session"] == id {
        return leaves(&node["first"]).into_iter().next();
    }
    sibling(&node["first"], id).or_else(|| sibling(&node["second"], id))
}
fn insert(node: &Value, anchor: &str, new: &Value) -> Value {
    if node["kind"] == "leaf" {
        return if node["session"] == anchor {
            new.clone()
        } else {
            node.clone()
        };
    }
    let mut n = node.clone();
    n["first"] = insert(&node["first"], anchor, new);
    n["second"] = insert(&node["second"], anchor, new);
    n
}
fn resize(node: &mut Value, id: &str, ratio: f64) {
    if node["kind"] != "split" {
        return;
    }
    if node["id"] == id {
        node["ratio"] = json!(ratio);
    }
    resize(&mut node["first"], id, ratio);
    resize(&mut node["second"], id, ratio);
}

#[derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(rename = "SessionEntry")]
pub struct Entry {
    pub session: Value,
    pub directory: String,
    pub workspace_id: String,
    pub project_id: Option<String>,
    pub roster_id: String,
}
pub fn entries(w: &Value) -> Vec<Entry> {
    let mut result = Vec::new();
    for r in rosters(w) {
        for session in sessions(w, &r) {
            let project = r.project.as_ref().and_then(|id| {
                w["projects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|p| p["id"] == *id)
            });
            let tree = project
                .and_then(|p| p["worktrees"].as_array())
                .and_then(|ts| ts.iter().find(|t| t["id"] == session["worktreeId"]));
            let directory = session["directory"]
                .as_str()
                .or_else(|| tree.and_then(|t| t["path"].as_str()))
                .or_else(|| project.and_then(|p| p["directory"].as_str()))
                .unwrap_or("")
                .to_string();
            result.push(Entry {
                session: session.clone(),
                directory,
                workspace_id: r.workspace.clone(),
                project_id: r.project.clone(),
                roster_id: r.id.clone(),
            });
        }
    }
    result
}
pub fn layout(w: &Value) -> Value {
    let Some(id) = w["selectedSession"].as_str() else {
        return Value::Null;
    };
    let Some(r) = owner(w, id) else {
        return Value::Null;
    };
    w.pointer(&r.splits)
        .and_then(Value::as_array)
        .and_then(|roots| roots.iter().find(|root| contains(root, id)))
        .cloned()
        .unwrap_or_else(|| json!({"kind":"leaf","session":id}))
}
pub fn transition(w: &mut Value, settings: &Value, method: &str, p: &Value) -> Result<()> {
    state::validate_workspace(w)?;
    match method {
        "session.create" => {
            let id = string(p, "id")?;
            let name = string(p, "name")?;
            let agent = p.get("agent").cloned().unwrap_or(Value::Null);
            enabled(settings, &agent)?;
            let project = p.get("projectId").unwrap_or(&w["selectedProject"]).as_str();
            let target = if let Some(project) = project {
                rosters(w)
                    .into_iter()
                    .find(|r| r.project.as_deref() == Some(project))
            } else {
                let kind = if agent.is_null() {
                    "terminals"
                } else {
                    "chats"
                };
                let target = format!("{kind}:{}", w["selectedWorkspace"].as_str().unwrap());
                rosters(w).into_iter().find(|r| r.id == target)
            }
            .ok_or_else(|| CoreError::new("INVALID_WORKSPACE", "Session roster does not exist"))?;
            let mut session =
                json!({"id":id,"name":name,"shell":settings["defaultShell"],"pinned":false});
            if !agent.is_null() {
                session["agent"] = agent;
            }
            if target.project.is_none() {
                session["directory"] = json!(string(p, "directory")?);
            } else if let Some(tree) = w["selectedWorktree"]
                .as_str()
                .filter(|_| w["selectedProject"] == json!(target.project))
            {
                session["worktreeId"] = json!(tree);
            }
            let mut items = sessions(w, &target).to_vec();
            items.push(session);
            assign(w, &target.sessions, json!(items));
            select(w, &target, &id);
        }
        "session.select" => {
            let id = string(p, "id")?;
            if let Some(r) = owner(w, &id) {
                select(w, &r, &id);
            }
        }
        "session.rename" => {
            let id = string(p, "id")?;
            let name = string(p, "name")?;
            if let Some(r) = owner(w, &id) {
                let mut items = sessions(w, &r).to_vec();
                for item in &mut items {
                    if item["id"] == id {
                        item["name"] = json!(name);
                    }
                }
                assign(w, &r.sessions, json!(items));
            }
        }
        "session.remove" | "session.ungroup" => {
            let id = string(p, "id")?;
            if let Some(r) = owner(w, &id) {
                let items = sessions(w, &r).to_vec();
                let target = items.iter().find(|s| s["id"] == id).unwrap();
                let peers: Vec<_> = items
                    .iter()
                    .filter(|s| s.get("worktreeId") == target.get("worktreeId"))
                    .collect();
                let index = peers.iter().position(|s| s["id"] == id).unwrap();
                let remaining: Vec<_> = peers.into_iter().filter(|s| s["id"] != id).collect();
                let roots = w
                    .pointer(&r.splits)
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let neighbor = roots
                    .iter()
                    .find(|n| contains(n, &id))
                    .and_then(|n| sibling(n, &id));
                let roots: Vec<_> = roots
                    .iter()
                    .filter_map(|n| remove(n, &id))
                    .filter(|n| n["kind"] == "split")
                    .collect();
                assign(w, &r.splits, json!(roots));
                if method == "session.remove" {
                    let next = neighbor.or_else(|| {
                        remaining
                            .get(index.min(remaining.len().saturating_sub(1)))
                            .and_then(|s| s["id"].as_str())
                            .map(String::from)
                    });
                    assign(
                        w,
                        &r.sessions,
                        json!(items.iter().filter(|s| s["id"] != id).collect::<Vec<_>>()),
                    );
                    if w["selectedSession"] == id {
                        w["selectedSession"] = json!(next);
                    }
                }
            }
        }
        "session.split" => {
            let anchor = string(p, "anchor")?;
            let id = string(p, "id")?;
            let split = string(p, "splitId")?;
            let axis = string(p, "axis")?;
            if !["horizontal", "vertical"].contains(&axis.as_str()) {
                return Err(CoreError::new("INVALID_ARGUMENT", "Invalid split axis"));
            }
            let r = owner(w, &anchor).ok_or_else(|| {
                CoreError::new("SESSION_MISSING", "Split anchor no longer exists")
            })?;
            let mut items = sessions(w, &r).to_vec();
            let mut next = items.iter().find(|s| s["id"] == anchor).unwrap().clone();
            if next.get("ssh").is_some() {
                return Err(CoreError::new(
                    "UNSUPPORTED",
                    "Remote splits require SSH service adoption",
                ));
            }
            if r.project.is_some() {
                next.as_object_mut().unwrap().remove("agent");
                next.as_object_mut().unwrap().remove("directory");
            }
            enabled(settings, &next["agent"])?;
            next["id"] = json!(id);
            next["name"] = json!(string(p, "name")?);
            next["pinned"] = json!(false);
            next["shell"] = settings["defaultShell"].clone();
            next.as_object_mut().unwrap().remove("issue");
            items.push(next);
            let branch = json!({"kind":"split","id":split,"axis":axis,"ratio":0.5,"first":{"kind":"leaf","session":anchor},"second":{"kind":"leaf","session":id}});
            let mut roots = w
                .pointer(&r.splits)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if let Some(root) = roots.iter_mut().find(|n| contains(n, &anchor)) {
                *root = insert(root, &anchor, &branch);
            } else {
                roots.push(branch);
            }
            assign(w, &r.sessions, json!(items));
            assign(w, &r.splits, json!(roots));
            select(w, &r, &id);
        }
        "session.resize" => {
            let id = string(p, "splitId")?;
            let roster = string(p, "rosterId")?;
            let ratio = p["ratio"]
                .as_f64()
                .filter(|n| n.is_finite())
                .ok_or_else(|| CoreError::new("INVALID_ARGUMENT", "Split ratio must be finite"))?
                .clamp(0.15, 0.85);
            if let Some(r) = rosters(w).into_iter().find(|r| r.id == roster) {
                let mut roots = w
                    .pointer(&r.splits)
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                for root in &mut roots {
                    resize(root, &id, ratio);
                }
                assign(w, &r.splits, json!(roots));
            }
        }
        _ => {
            return Err(CoreError::new(
                "UNKNOWN_METHOD",
                "Unknown session state operation",
            ))
        }
    }
    state::validate_workspace(w)
}
