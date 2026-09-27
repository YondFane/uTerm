use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AgentDefinition {
    pub id: String,
    pub name: String,
    pub program: String,
    #[serde(default)]
    pub arguments: Vec<String>,
}
pub fn validate(definitions: &[AgentDefinition]) -> Result<()> {
    let mut ids = std::collections::HashSet::new();
    if definitions.len() > 32 {
        bail!("最多可配置 32 个 Agent。");
    }
    for definition in definitions {
        if definition.id.is_empty()
            || definition.id.len() > 80
            || !definition
                .id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
            || !ids.insert(&definition.id)
        {
            bail!("Agent 标识无效或重复。");
        }
        if definition.name.trim().is_empty()
            || definition.name.len() > 120
            || definition.program.trim().is_empty()
            || definition.program.contains('\0')
            || definition.arguments.len() > 64
            || definition
                .arguments
                .iter()
                .any(|arg| arg.len() > 8192 || arg.contains('\0'))
        {
            bail!("请输入有效的 Agent 名称、程序和参数。");
        }
    }
    Ok(())
}
pub fn read(directory: &Path) -> Result<Vec<AgentDefinition>> {
    let path = directory.join("agents.json");
    match std::fs::read(path) {
        Ok(bytes) => {
            let definitions: Vec<AgentDefinition> =
                serde_json::from_slice(&bytes).context("Agent 配置无效，原文件已保留")?;
            validate(&definitions)?;
            Ok(definitions)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(error) => Err(error.into()),
    }
}
pub fn resolve(directory: &Path, id: &str) -> Result<(PathBuf, Vec<String>)> {
    if let Some(definition) = read(directory)?.into_iter().find(|item| item.id == id) {
        return Ok((
            crate::process::resolve_program(&definition.program)?,
            launch_arguments(id, definition.arguments, cfg!(windows)),
        ));
    }
    Ok((
        crate::agent_program(id)?,
        launch_arguments(id, vec![], cfg!(windows)),
    ))
}

pub fn launch_arguments(id: &str, mut arguments: Vec<String>, windows: bool) -> Vec<String> {
    if windows
        && id == "codex"
        && !arguments
            .iter()
            .take_while(|argument| argument.as_str() != "--")
            .any(|argument| argument == "--no-daemon")
    {
        arguments.insert(0, "--no-daemon".into());
    }
    arguments
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_codex_launch_disables_daemon_without_changing_other_agents_or_platforms() {
        assert_eq!(launch_arguments("codex", vec![], true), vec!["--no-daemon"]);
        let configured = vec!["--model".into(), "custom model".into()];
        assert_eq!(
            launch_arguments("codex", configured.clone(), true),
            vec!["--no-daemon", "--model", "custom model"]
        );
        assert_eq!(
            launch_arguments("codex", configured.clone(), false),
            configured
        );
        assert!(launch_arguments("claude", vec![], true).is_empty());
        let existing = vec!["--no-daemon".into(), "--model".into(), "custom".into()];
        assert_eq!(launch_arguments("codex", existing.clone(), true), existing);
        assert_eq!(
            launch_arguments("codex", vec!["--".into(), "--no-daemon".into()], true),
            vec!["--no-daemon", "--", "--no-daemon"]
        );
    }
}
