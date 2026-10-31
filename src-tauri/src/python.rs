use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;
use utermd_local::daemon::{Client, Operation, Reply, SessionSpec, TaskSession};
use utermd_local::tasks::{Launch, Step, TaskInfo};

static CONFIG_LOCK: Mutex<()> = Mutex::new(());
const MAX_CONFIG_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default, deny_unknown_fields)]
pub struct RunConfig {
    pub interpreter: String,
    pub mode: String,
    pub target: String,
    pub working_directory: String,
    pub arguments: Vec<String>,
    pub host: String,
    pub port: u16,
    pub reload: bool,
}
impl Default for RunConfig {
    fn default() -> Self {
        Self {
            interpreter: String::new(),
            mode: "script".into(),
            target: String::new(),
            working_directory: ".".into(),
            arguments: vec![],
            host: "127.0.0.1".into(),
            port: 8000,
            reload: false,
        }
    }
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Store {
    version: u32,
    projects: HashMap<String, RunConfig>,
}
#[derive(Debug, Serialize)]
pub struct Configuration {
    revision: String,
    configured: bool,
    project: RunConfig,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Interpreter {
    pub path: String,
    pub version: String,
    pub virtual_environment: bool,
}
#[derive(Clone, Serialize)]
pub struct Candidate {
    mode: String,
    target: String,
    working_directory: String,
}
#[derive(Serialize)]
pub struct ProjectInfo {
    candidates: Vec<Candidate>,
    truncated: bool,
}
fn root(directory: &str) -> Result<PathBuf> {
    let path = Path::new(directory);
    if !path.is_absolute() || !path.is_dir() {
        bail!("PYTHON_PROJECT_INVALID");
    }
    Ok(path.canonicalize()?)
}
fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(value) = text.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{value}")
    } else {
        text.strip_prefix("\\\\?\\").unwrap_or(&text).into()
    }
}
fn inside(root: &Path, value: &str) -> Result<PathBuf> {
    let path = Path::new(value);
    if path
        .components()
        .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        bail!("PYTHON_PROJECT_INVALID");
    }
    let path = if path.is_absolute() {
        path.to_owned()
    } else {
        root.join(path)
    }
    .canonicalize()?;
    if !path.starts_with(root) {
        bail!("PYTHON_PROJECT_INVALID");
    }
    Ok(path)
}
fn config_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()?
        .join("python-run-v1/configuration.json"))
}
fn read_store(path: &Path) -> Result<(Store, String)> {
    let bytes = match fs::read(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((
                Store {
                    version: 1,
                    ..Store::default()
                },
                "missing".into(),
            ));
        }
        Err(error) => return Err(error).context("PYTHON_CONFIG_INVALID"),
    };
    if bytes.len() > MAX_CONFIG_BYTES {
        bail!("PYTHON_CONFIG_INVALID");
    }
    let store: Store = serde_json::from_slice(&bytes).context("PYTHON_CONFIG_INVALID")?;
    if store.version != 1 {
        bail!("PYTHON_CONFIG_INVALID");
    }
    Ok((store, format!("{:x}", Sha256::digest(&bytes))))
}
fn configuration(path: &Path, root: &Path) -> Result<Configuration> {
    let (store, revision) = read_store(path)?;
    let value = store.projects.get(&root.to_string_lossy().to_string());
    Ok(Configuration {
        revision,
        configured: value.is_some(),
        project: value.cloned().unwrap_or_default(),
    })
}
fn valid_text(value: &str) -> bool {
    value.len() <= 4096 && !value.chars().any(char::is_control)
}
fn validate(config: &RunConfig) -> Result<()> {
    if !["script", "module", "fastapi", "flask", "django"].contains(&config.mode.as_str())
        || [
            &config.interpreter,
            &config.target,
            &config.working_directory,
            &config.host,
        ]
        .iter()
        .any(|value| !valid_text(value))
        || config.arguments.len() > 128
        || config
            .arguments
            .iter()
            .any(|value| value.len() > 16384 || value.contains('\0'))
        || (["fastapi", "flask", "django"].contains(&config.mode.as_str())
            && (config.port == 0 || config.host.parse::<std::net::IpAddr>().is_err()))
    {
        bail!("PYTHON_CONFIG_INVALID");
    }
    Ok(())
}
fn save_configuration(
    path: &Path,
    root: &Path,
    revision: &str,
    config: RunConfig,
) -> Result<Configuration> {
    validate(&config)?;
    let _lock = CONFIG_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("PYTHON_CONFIG_SAVE"))?;
    let (mut store, current) = read_store(path)?;
    if current != revision {
        bail!("PYTHON_CONFIG_CONFLICT");
    }
    let key = root.to_string_lossy().to_string();
    if store.projects.len() >= 1000 && !store.projects.contains_key(&key) {
        bail!("PYTHON_CONFIG_INVALID");
    }
    store.projects.insert(key, config);
    let bytes = serde_json::to_vec_pretty(&store)?;
    if bytes.len() > MAX_CONFIG_BYTES {
        bail!("PYTHON_CONFIG_INVALID");
    }
    let parent = path.parent().context("PYTHON_CONFIG_SAVE")?;
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(&bytes)?;
    temporary.as_file().sync_all()?;
    if read_store(path)?.1 != revision {
        bail!("PYTHON_CONFIG_CONFLICT");
    }
    temporary
        .persist(path)
        .map_err(|_| anyhow::anyhow!("PYTHON_CONFIG_SAVE"))?;
    configuration(path, root)
}
fn probe(path: &Path, packages: &[&str]) -> Result<Interpreter> {
    if !path.is_absolute() || !path.is_file() {
        bail!("PYTHON_INTERPRETER_REQUIRED");
    }
    // Keep the venv's executable path: resolving its symlink can select the base environment.
    // 保留虚拟环境的解释器路径：解析其符号链接可能会误选基础环境。
    let code = "import sys,json,importlib.util; print(json.dumps({'version':sys.version.split()[0],'major':sys.version_info[0],'virtual':sys.prefix!=sys.base_prefix,'missing':[p for p in sys.argv[1:] if importlib.util.find_spec(p) is None]}))";
    let mut child = utermd_local::BackgroundChild::spawn(
        Command::new(path)
            .args(["-I", "-c", code])
            .args(packages)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null()),
    )
    .context("PYTHON_INTERPRETER_REQUIRED")?;
    let deadline = Instant::now() + Duration::from_secs(3);
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            bail!("PYTHON_INTERPRETER_REQUIRED");
        }
        std::thread::sleep(Duration::from_millis(15));
    };
    let mut output = String::new();
    child
        .take_stdout()
        .context("PYTHON_INTERPRETER_REQUIRED")?
        .take(16384)
        .read_to_string(&mut output)?;
    let value: serde_json::Value =
        serde_json::from_str(output.trim()).context("PYTHON_INTERPRETER_REQUIRED")?;
    if !status.success() || value["major"] != 3 {
        bail!("PYTHON_INTERPRETER_REQUIRED");
    }
    if value["missing"]
        .as_array()
        .is_none_or(|values| !values.is_empty())
    {
        bail!("PYTHON_DEPENDENCY_MISSING: {}", value["missing"]);
    }
    Ok(Interpreter {
        path: display_path(path),
        version: value["version"]
            .as_str()
            .context("PYTHON_INTERPRETER_REQUIRED")?
            .into(),
        virtual_environment: value["virtual"].as_bool().unwrap_or(false),
    })
}
fn interpreters(root: &Path, selected: &str) -> Vec<Interpreter> {
    let mut paths = Vec::new();
    if !selected.is_empty() {
        paths.push(PathBuf::from(selected));
    }
    for folder in [".venv", "venv"] {
        paths.push(root.join(folder).join(if cfg!(windows) {
            "Scripts/python.exe"
        } else {
            "bin/python"
        }));
    }
    if let Some(path) = std::env::var_os("PATH") {
        for folder in std::env::split_paths(&path).filter(|folder| folder.is_absolute()) {
            for name in if cfg!(windows) {
                vec!["python.exe", "python3.exe"]
            } else {
                vec!["python3", "python"]
            } {
                paths.push(folder.join(name));
            }
        }
    }
    let mut seen = HashSet::new();
    let started = Instant::now();
    let mut values = Vec::new();
    for path in paths {
        let text = display_path(&path);
        let key = if cfg!(windows) {
            text.to_lowercase()
        } else {
            text
        };
        if seen.insert(key) && path.is_file() {
            if let Ok(value) = probe(&path, &[]) {
                values.push(value);
            }
        }
        if started.elapsed() >= Duration::from_secs(8) || values.len() >= 16 {
            break;
        }
    }
    values
}
fn module_name(value: &str) -> bool {
    !value.is_empty()
        && value.split('.').all(|part| {
            !part.is_empty()
                && part.chars().enumerate().all(|(index, c)| {
                    c == '_' || c.is_ascii_alphabetic() || (index > 0 && c.is_ascii_digit())
                })
        })
}
fn project_info(root: &Path) -> Result<ProjectInfo> {
    let mut pending = vec![(root.to_owned(), 0)];
    let mut candidates = Vec::new();
    let mut count = 0;
    let mut bytes = 0;
    let mut truncated = false;
    while let Some((folder, depth)) = pending.pop() {
        for entry in fs::read_dir(folder)? {
            count += 1;
            if count > 2000 || bytes >= 2 * 1024 * 1024 || candidates.len() >= 100 {
                truncated = true;
                break;
            }
            let entry = entry?;
            let kind = entry.file_type()?;
            let path = entry.path();
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                if depth < 5
                    && ![
                        ".git",
                        ".venv",
                        "venv",
                        "env",
                        "node_modules",
                        "target",
                        "dist",
                        "__pycache__",
                    ]
                    .contains(&entry.file_name().to_string_lossy().as_ref())
                {
                    pending.push((path, depth + 1));
                }
                continue;
            }
            if !kind.is_file() || path.extension().is_none_or(|ext| ext != "py") {
                continue;
            }
            let relative = path
                .strip_prefix(root)?
                .to_string_lossy()
                .replace('\\', "/");
            let working = path
                .parent()
                .unwrap()
                .strip_prefix(root)?
                .to_string_lossy()
                .replace('\\', "/");
            if entry.file_name() == "manage.py" {
                candidates.push(Candidate {
                    mode: "django".into(),
                    target: relative.clone(),
                    working_directory: if working.is_empty() {
                        ".".into()
                    } else {
                        working
                    },
                });
            }
            candidates.push(Candidate {
                mode: "script".into(),
                target: relative.clone(),
                working_directory: ".".into(),
            });
            if entry.metadata()?.len() > 128 * 1024 {
                continue;
            }
            let budget = (2 * 1024 * 1024 - bytes).min(128 * 1024 + 1);
            let mut source = Vec::new();
            fs::File::open(&path)?
                .take(budget as u64)
                .read_to_end(&mut source)?;
            bytes += source.len();
            if source.len() > 128 * 1024 {
                continue;
            }
            if source.len() == budget {
                truncated = true;
                break;
            }
            let Ok(source) = std::str::from_utf8(&source) else {
                continue;
            };
            let (module, cwd) = if let Some(value) = relative.strip_prefix("src/") {
                (value, "src")
            } else {
                (relative.as_str(), ".")
            };
            let module = module.trim_end_matches(".py").replace('/', ".");
            if !module_name(&module) {
                continue;
            }
            for line in source
                .lines()
                .filter(|line| !line.starts_with(char::is_whitespace))
            {
                let Some((name, value)) = line.split_once('=') else {
                    continue;
                };
                let name = name.trim();
                if !module_name(name) || name.contains('.') {
                    continue;
                }
                let mode = if value.trim_start().starts_with("FastAPI(") {
                    "fastapi"
                } else if value.trim_start().starts_with("Flask(") {
                    "flask"
                } else {
                    continue;
                };
                candidates.push(Candidate {
                    mode: mode.into(),
                    target: format!("{module}:{name}"),
                    working_directory: cwd.into(),
                });
            }
        }
        if truncated {
            break;
        }
    }
    candidates.sort_by(|a, b| a.mode.cmp(&b.mode).then(a.target.cmp(&b.target)));
    Ok(ProjectInfo {
        candidates,
        truncated,
    })
}
fn launch_arguments(root: &Path, config: &RunConfig) -> Result<Vec<String>> {
    validate(config)?;
    let mut arguments = vec!["-u".into()];
    match config.mode.as_str() {
        "script" | "django" => {
            let path = inside(root, &config.target).context("PYTHON_TARGET_INVALID")?;
            if !path.is_file() || path.extension().is_none_or(|ext| ext != "py") {
                bail!("PYTHON_TARGET_INVALID");
            }
            arguments.push(display_path(&path));
            if config.mode == "django" {
                arguments.extend([
                    "runserver".into(),
                    if config.host.contains(':') {
                        format!("[{}]:{}", config.host, config.port)
                    } else {
                        format!("{}:{}", config.host, config.port)
                    },
                ]);
                if config.host.contains(':') {
                    arguments.push("--ipv6".into());
                }
                if !config.reload {
                    arguments.push("--noreload".into());
                }
            }
        }
        "module" => {
            if !module_name(&config.target) {
                bail!("PYTHON_TARGET_INVALID");
            }
            arguments.extend(["-m".into(), config.target.clone()]);
        }
        "fastapi" | "flask" => {
            let (module, attribute) = config
                .target
                .split_once(':')
                .context("PYTHON_TARGET_INVALID")?;
            let attribute = if config.mode == "flask" {
                attribute.strip_suffix("()").unwrap_or(attribute)
            } else {
                attribute
            };
            if !module_name(module) || !module_name(attribute) {
                bail!("PYTHON_TARGET_INVALID");
            }
            if config.mode == "fastapi" {
                arguments.extend([
                    "-m".into(),
                    "uvicorn".into(),
                    config.target.clone(),
                    "--host".into(),
                    config.host.clone(),
                    "--port".into(),
                    config.port.to_string(),
                ]);
                if config.reload {
                    arguments.push("--reload".into());
                }
            } else {
                arguments.extend([
                    "-m".into(),
                    "flask".into(),
                    "--app".into(),
                    config.target.clone(),
                    "run".into(),
                    "--host".into(),
                    config.host.clone(),
                    "--port".into(),
                    config.port.to_string(),
                    "--no-debugger".into(),
                    if config.reload {
                        "--reload"
                    } else {
                        "--no-reload"
                    }
                    .into(),
                ]);
            }
        }
        _ => bail!("PYTHON_CONFIG_INVALID"),
    }
    arguments.extend(config.arguments.clone());
    Ok(arguments)
}
fn build_launch(
    root: &Path,
    config: &RunConfig,
    mut environment: HashMap<String, String>,
) -> Result<Launch> {
    let arguments = launch_arguments(root, config)?;
    let directory = inside(root, &config.working_directory)?;
    if !directory.is_dir() {
        bail!("PYTHON_PROJECT_INVALID");
    }
    let packages: &[&str] = match config.mode.as_str() {
        "fastapi" => &["fastapi", "uvicorn"],
        "flask" => &["flask"],
        "django" => &["django"],
        _ => &[],
    };
    probe(Path::new(&config.interpreter), packages)?;
    let mut names = HashSet::new();
    for name in environment.keys() {
        if !names.insert(name.to_uppercase()) || name.to_uppercase().starts_with("UTERM_") {
            bail!("PYTHON_ENVIRONMENT_INVALID");
        }
    }
    environment.retain(|key, _| {
        !["PYTHONIOENCODING", "PYTHONUNBUFFERED", "PYTHONUTF8"]
            .contains(&key.to_uppercase().as_str())
    });
    environment.insert("PYTHONIOENCODING".into(), "utf-8".into());
    environment.insert("PYTHONUNBUFFERED".into(), "1".into());
    environment.insert("PYTHONUTF8".into(), "1".into());
    let launch = Launch {
        root: root.to_owned(),
        steps: vec![Step {
            program: config.interpreter.clone().into(),
            arguments,
            directory,
            environment,
            label: format!("Python · {}", config.mode),
            jar_directory: None,
        }],
    };
    launch.validate()?;
    Ok(launch)
}
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| "PYTHON_OPERATION_FAILED".to_string())?
        .map_err(|error| format!("{error:#}"))
}
#[tauri::command]
pub async fn python_configuration(
    app: tauri::AppHandle,
    directory: String,
) -> Result<Configuration, String> {
    blocking(move || configuration(&config_path(&app)?, &root(&directory)?)).await
}
#[tauri::command]
pub async fn python_save_configuration(
    app: tauri::AppHandle,
    directory: String,
    revision: String,
    config: RunConfig,
) -> Result<Configuration, String> {
    blocking(move || save_configuration(&config_path(&app)?, &root(&directory)?, &revision, config))
        .await
}
#[tauri::command]
pub async fn python_detect_interpreters(
    directory: String,
    selected: String,
) -> Result<Vec<Interpreter>, String> {
    blocking(move || Ok(interpreters(&root(&directory)?, &selected))).await
}
#[tauri::command]
pub async fn python_project(directory: String) -> Result<ProjectInfo, String> {
    blocking(move || project_info(&root(&directory)?)).await
}
#[tauri::command]
pub async fn python_select_path(
    window: tauri::WebviewWindow,
    directory: String,
    kind: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    if !["interpreter", "script", "directory"].contains(&kind.as_str()) {
        return Err("PYTHON_CONFIG_INVALID".into());
    }
    blocking(move || {
        let root = root(&directory)?;
        let dialog = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_directory(&root);
        let file = match kind.as_str() {
            "directory" => dialog.blocking_pick_folder(),
            "script" => dialog.add_filter("Python", &["py"]).blocking_pick_file(),
            _ => dialog.blocking_pick_file(),
        };
        file.map(|file| {
            let path = file
                .into_path()
                .map_err(|_| anyhow::anyhow!("PYTHON_PROJECT_INVALID"))?;
            if kind == "interpreter" {
                Ok(display_path(&path))
            } else {
                let path = inside(&root, &path.to_string_lossy())?;
                Ok(path.strip_prefix(&root)?.to_string_lossy().to_string())
            }
        })
        .transpose()
    })
    .await
}
#[tauri::command]
pub async fn python_tasks(
    app: tauri::AppHandle,
    directory: String,
) -> Result<Vec<TaskSession>, String> {
    blocking(move || {
        let root = root(&directory)?;
        let path = crate::sessions::local_root(&app).map_err(anyhow::Error::msg)?;
        if !path.join("endpoint.json").exists() {
            return Ok(vec![]);
        }
        let client = Client::connect(&path)?;
        client.require_task_support()?;
        let Reply::Tasks(tasks) = client.request(Operation::TaskSnapshot)? else {
            bail!("PYTHON_OPERATION_FAILED");
        };
        Ok(tasks
            .into_iter()
            .filter(|task| task.task.root == root && task.task.action.starts_with("python:"))
            .collect())
    })
    .await
}
#[tauri::command]
pub async fn python_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<crate::sessions::Sessions>>,
    directory: String,
    config: RunConfig,
    environment: HashMap<String, String>,
) -> Result<TaskSession, String> {
    let state = state.inner().clone();
    blocking(move || {
        let root = root(&directory)?;
        let launch = build_launch(&root, &config, environment)?;
        let client = crate::sessions::local_client(&app, &state).map_err(anyhow::Error::msg)?;
        client.require_task_support()?;
        client.require_task_output_support()?;
        let spec = SessionSpec {
            id: uuid::Uuid::new_v4().to_string(),
            directory: root.clone(),
            shell: "default".into(),
            agent: None,
            ssh: None,
        };
        let action = if ["fastapi", "flask", "django"].contains(&config.mode.as_str()) {
            let host = match config.host.as_str() {
                "0.0.0.0" => "127.0.0.1",
                "::" => "::1",
                value => value,
            };
            let host = if host.contains(':') {
                format!("[{host}]")
            } else {
                host.into()
            };
            format!("python:run|http://{host}:{}", config.port)
        } else {
            "python:run".into()
        };
        let task = TaskInfo {
            root,
            name: config.target.clone(),
            action,
            created: chrono::Utc::now().timestamp_millis() as u64,
        };
        let Reply::Opened { generation } = client.request(Operation::OpenTask {
            spec: spec.clone(),
            task: task.clone(),
            launch,
            rows: 30,
            cols: 100,
        })?
        else {
            bail!("PYTHON_OPERATION_FAILED");
        };
        Ok(TaskSession {
            spec,
            generation,
            task,
            running: true,
            code: None,
        })
    })
    .await
}
#[tauri::command]
pub async fn python_stop(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<crate::sessions::Sessions>>,
    id: String,
    generation: String,
    force: bool,
) -> Result<(), String> {
    let state = state.inner().clone();
    blocking(move || {
        let client = crate::sessions::local_client(&app, &state).map_err(anyhow::Error::msg)?;
        client.require_task_support()?;
        client.request(Operation::StopTask {
            id,
            generation,
            force,
        })?;
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        fs::write(root.join("main 中文 & %.py"), "print('ok')").unwrap();
        (temp, root)
    }

    #[test]
    fn all_five_modes_build_literal_arguments_and_reload_flags() {
        let (_temp, root) = fixture();
        let mut config = RunConfig {
            target: "main 中文 & %.py".into(),
            arguments: vec!["literal & %PATH% 中文".into(), "".into()],
            ..RunConfig::default()
        };
        let args = launch_arguments(&root, &config).unwrap();
        assert_eq!(
            args,
            vec![
                "-u",
                &display_path(&root.join(&config.target)),
                "literal & %PATH% 中文",
                ""
            ]
        );
        config.mode = "django".into();
        assert!(launch_arguments(&root, &config)
            .unwrap()
            .contains(&"--noreload".into()));
        config.reload = true;
        assert!(!launch_arguments(&root, &config)
            .unwrap()
            .contains(&"--noreload".into()));
        config.host = "::1".into();
        let args = launch_arguments(&root, &config).unwrap();
        assert!(args.contains(&"[::1]:8000".into()));
        assert!(args.contains(&"--ipv6".into()));
        config.host = "127.0.0.1".into();
        config.mode = "module".into();
        config.target = "app.main".into();
        assert_eq!(
            &launch_arguments(&root, &config).unwrap()[..3],
            ["-u", "-m", "app.main"]
        );
        config.mode = "fastapi".into();
        config.target = "app.main:app".into();
        config.reload = false;
        let args = launch_arguments(&root, &config).unwrap();
        assert_eq!(&args[..4], ["-u", "-m", "uvicorn", "app.main:app"]);
        assert!(!args.contains(&"--reload".into()));
        config.reload = true;
        assert!(launch_arguments(&root, &config)
            .unwrap()
            .contains(&"--reload".into()));
        config.mode = "flask".into();
        config.target = "app:create_app()".into();
        config.reload = false;
        let args = launch_arguments(&root, &config).unwrap();
        assert_eq!(
            &args[..5],
            ["-u", "-m", "flask", "--app", "app:create_app()"]
        );
        assert!(args.contains(&"--no-debugger".into()));
        assert!(args.contains(&"--no-reload".into()));
    }

    #[test]
    fn invalid_targets_ports_and_root_escape_are_rejected() {
        let (_temp, root) = fixture();
        for value in ["-m", "app;echo", "../outside", "a..b", ""] {
            let config = RunConfig {
                mode: "module".into(),
                target: value.into(),
                ..RunConfig::default()
            };
            assert!(launch_arguments(&root, &config).is_err(), "{value}");
        }
        assert!(inside(&root, "../outside").is_err());
        assert!(inside(&root, &std::env::temp_dir().to_string_lossy()).is_err());
        let config = RunConfig {
            mode: "fastapi".into(),
            target: "app:app".into(),
            port: 0,
            ..RunConfig::default()
        };
        assert!(launch_arguments(&root, &config).is_err());
        let config = RunConfig {
            target: "../outside.py".into(),
            ..RunConfig::default()
        };
        assert!(launch_arguments(&root, &config).is_err());
    }

    #[test]
    fn configuration_round_trips_and_conflicts_preserve_the_original() {
        let (_temp, root) = fixture();
        let path = root.join("settings/configuration.json");
        let original = configuration(&path, &root).unwrap();
        assert_eq!(original.revision, "missing");
        let config = RunConfig {
            target: "main 中文 & %.py".into(),
            ..RunConfig::default()
        };
        let saved = save_configuration(&path, &root, &original.revision, config.clone()).unwrap();
        assert!(saved.configured);
        assert_eq!(saved.project, config);
        assert!(
            save_configuration(&path, &root, "missing", RunConfig::default())
                .unwrap_err()
                .to_string()
                .contains("PYTHON_CONFIG_CONFLICT")
        );
        assert_eq!(configuration(&path, &root).unwrap().project, config);
        let mut invalid = config.clone();
        invalid.arguments = vec!["x".repeat(MAX_CONFIG_BYTES)];
        assert!(save_configuration(&path, &root, &saved.revision, invalid).is_err());
        assert_eq!(configuration(&path, &root).unwrap().project, config);
        let mut value = serde_json::to_value(config).unwrap();
        value["environment"] = serde_json::json!({"SECRET": "never-save"});
        assert!(serde_json::from_value::<RunConfig>(value).is_err());
        fs::write(&path, "corrupted original").unwrap();
        assert!(configuration(&path, &root).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "corrupted original");
    }

    #[test]
    fn detection_reads_candidates_without_importing_sources_or_virtual_environments() {
        let (_temp, root) = fixture();
        fs::create_dir_all(root.join("src/app")).unwrap();
        fs::write(
            root.join("src/app/main.py"),
            "raise RuntimeError('must not run')\napp = FastAPI()\n",
        )
        .unwrap();
        fs::write(root.join("manage.py"), "raise RuntimeError('must not run')").unwrap();
        fs::write(root.join("web.py"), "app = Flask(__name__)\n").unwrap();
        fs::create_dir(root.join(".venv")).unwrap();
        fs::write(root.join(".venv/ignore.py"), "app = FastAPI()\n").unwrap();
        let info = project_info(&root).unwrap();
        assert!(!info.truncated);
        assert!(info.candidates.iter().any(|value| value.mode == "fastapi"
            && value.target == "app.main:app"
            && value.working_directory == "src"));
        assert!(info
            .candidates
            .iter()
            .any(|value| value.mode == "django" && value.target == "manage.py"));
        assert!(info
            .candidates
            .iter()
            .any(|value| value.mode == "flask" && value.target == "web:app"));
        assert!(!info
            .candidates
            .iter()
            .any(|value| value.target.contains("ignore")));
    }

    #[test]
    fn detection_reports_its_entry_limit() {
        let (_temp, root) = fixture();
        for index in 0..105 {
            fs::write(root.join(format!("module{index}.py")), "").unwrap();
        }
        let info = project_info(&root).unwrap();
        assert!(info.truncated);
        assert!(info.candidates.len() <= 100);
    }

    #[cfg(unix)]
    #[test]
    fn detection_and_script_selection_reject_external_symlinks() {
        let (_temp, root) = fixture();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("evil.py"), "app = FastAPI()\n").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("external")).unwrap();
        assert!(inside(&root, "external/evil.py").is_err());
        assert!(!project_info(&root)
            .unwrap()
            .candidates
            .iter()
            .any(|value| value.target.contains("evil")));
    }

    #[test]
    #[ignore = "Requires UTERM_PYTHON_TEST_INTERPRETER pointing to an isolated Python environment"]
    fn real_python_preserves_literal_values_and_emits_utf8() {
        let (_temp, root) = fixture();
        let interpreter = std::env::var("UTERM_PYTHON_TEST_INTERPRETER").unwrap();
        let detected = probe(Path::new(&interpreter), &[]).unwrap();
        assert_eq!(detected.path, interpreter);
        assert!(
            probe(Path::new(&interpreter), &["uterm_nonexistent_test_package"])
                .unwrap_err()
                .to_string()
                .contains("PYTHON_DEPENDENCY_MISSING")
        );
        fs::write(root.join("main 中文 & %.py"), "import sys,os\nprint(sys.argv[1])\nprint(os.environ['VALUE'])\nprint('stderr 中文',file=sys.stderr)\nsys.exit(7)\n").unwrap();
        let config = RunConfig {
            interpreter,
            target: "main 中文 & %.py".into(),
            arguments: vec!["literal & %PATH% 中文".into()],
            ..RunConfig::default()
        };
        let launch = build_launch(
            &root,
            &config,
            HashMap::from([("VALUE".into(), "环境 & %PATH%".into())]),
        )
        .unwrap();
        let step = &launch.steps[0];
        let output = Command::new(&step.program)
            .args(&step.arguments)
            .current_dir(&step.directory)
            .envs(&step.environment)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(7));
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert!(stdout.contains("literal & %PATH% 中文"));
        assert!(stdout.contains("环境 & %PATH%"));
        assert!(String::from_utf8(output.stderr)
            .unwrap()
            .contains("stderr 中文"));
        assert!(build_launch(
            &root,
            &config,
            HashMap::from([("UTERM_SECRET".into(), "no".into())])
        )
        .is_err());
    }
}
