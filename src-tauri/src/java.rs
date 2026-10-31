use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;
use utermd_local::daemon::{Client, Operation, Reply, SessionSpec, TaskSession};
use utermd_local::tasks::{Launch, Step, TaskInfo};

#[path = "java_jdks.rs"]
mod jdks;
#[path = "java_main_classes.rs"]
mod main_classes;

static CONFIG_LOCK: Mutex<()> = Mutex::new(());
const CONFIG_VERSION: u32 = 1;
const MAX_CONFIG_BYTES: usize = 2 * 1024 * 1024;
const MAX_SAVED_PROJECTS: usize = 1000;
const MAX_TEXT_BYTES: usize = 4096;
const MAX_ARGUMENTS: usize = 128;
const MAX_ARGUMENT_BYTES: usize = 16384;
const MAX_POM_BYTES: u64 = 1024 * 1024;
const MAX_PROJECT_MODULES: usize = 200;
const MAX_DISCOVERED_JARS: usize = 30;
const MAX_MAVEN_CONFIG_BYTES: u64 = 65536;
const MAX_WRAPPER_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_WRAPPER_EXTRACTED_BYTES: u64 = 128 * 1024 * 1024;
const SUPPORTED_JAVA_VERSIONS: &[u32] = &[8, 11, 17, 21];
const JDK_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const JDK_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct MavenConfig {
    pub distribution: String,
    pub home: String,
    pub settings: String,
    pub repository: String,
    pub wrapper: bool,
}
impl Default for MavenConfig {
    fn default() -> Self {
        Self {
            distribution: "local".into(),
            home: String::new(),
            settings: String::new(),
            repository: String::new(),
            wrapper: true,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ProjectConfig {
    pub maven_scope: String,
    pub maven_configured: bool,
    pub maven: MavenConfig,
    pub module: String,
    pub java_version: u32,
    pub java_home: String,
    pub mode: String,
    pub main_class: String,
    pub maven_profiles: String,
    pub spring_profiles: String,
    pub vm_arguments: Vec<String>,
    pub arguments: Vec<String>,
    pub jar: String,
    pub skip_tests: bool,
    pub offline: bool,
}
impl Default for ProjectConfig {
    fn default() -> Self {
        Self {
            maven_scope: "global".into(),
            maven_configured: false,
            maven: MavenConfig::default(),
            module: ".".into(),
            java_version: 21,
            java_home: String::new(),
            mode: "development".into(),
            main_class: String::new(),
            maven_profiles: String::new(),
            spring_profiles: String::new(),
            vm_arguments: vec![],
            arguments: vec![],
            jar: String::new(),
            skip_tests: false,
            offline: false,
        }
    }
}
#[derive(Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Store {
    version: u32,
    global: MavenConfig,
    projects: HashMap<String, ProjectConfig>,
}
#[derive(Serialize)]
pub struct Configuration {
    revision: String,
    global: MavenConfig,
    project: ProjectConfig,
    configured: bool,
    jdks: Vec<JavaHome>,
    maven_home: Option<String>,
}
#[derive(Clone, Serialize)]
pub struct JavaHome {
    pub home: String,
    pub version: u32,
    pub registered: bool,
    pub available: bool,
}
#[derive(Clone, Default, Serialize)]
pub struct Module {
    pub path: String,
    pub name: String,
    pub packaging: String,
    pub java_version: Option<u32>,
    pub boot: bool,
    pub jars: Vec<String>,
    pub main_classes: Vec<main_classes::MainClass>,
}
#[derive(Serialize)]
pub struct ProjectInfo {
    pub modules: Vec<Module>,
}

fn root(directory: &str) -> Result<PathBuf> {
    let path = Path::new(directory);
    if !path.is_absolute() || !path.is_dir() {
        bail!("JAVA_PROJECT_INVALID");
    }
    Ok(path.canonicalize()?)
}
fn path_text(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(value) = text.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{value}")
    } else {
        text.strip_prefix("\\\\?\\").unwrap_or(&text).into()
    }
}
fn inside(root: &Path, relative: &str) -> Result<PathBuf> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir | std::path::Component::Prefix(_)
            )
        })
    {
        bail!("JAVA_PROJECT_INVALID");
    }
    let target = root.join(path).canonicalize()?;
    if !target.starts_with(root) {
        bail!("JAVA_PROJECT_INVALID");
    }
    Ok(target)
}
fn configuration_path(app: &tauri::AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()?
        .join("java-build-v1")
        .join("configuration.json"))
}
fn read_store(path: &Path) -> Result<(Store, String)> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((
                Store {
                    version: CONFIG_VERSION,
                    ..Store::default()
                },
                "missing".into(),
            ))
        }
        Err(error) => return Err(error.into()),
    };
    if bytes.len() > MAX_CONFIG_BYTES {
        bail!("JAVA_CONFIG_INVALID");
    }
    let store: Store = serde_json::from_slice(&bytes).context("JAVA_CONFIG_INVALID")?;
    if store.version != CONFIG_VERSION {
        bail!("JAVA_CONFIG_INVALID");
    }
    Ok((store, format!("{:x}", Sha256::digest(&bytes))))
}
fn valid_text(value: &str) -> bool {
    value.len() <= MAX_TEXT_BYTES && !value.chars().any(char::is_control)
}
fn validate_maven(config: &MavenConfig) -> Result<()> {
    if !["local", "managed"].contains(&config.distribution.as_str())
        || [&config.home, &config.settings, &config.repository]
            .iter()
            .any(|value| !valid_text(value))
    {
        bail!("JAVA_CONFIG_INVALID");
    }
    Ok(())
}
fn validate_project(config: &ProjectConfig) -> Result<()> {
    validate_maven(&config.maven)?;
    if !config.main_class.is_empty()
        && (config.main_class.len() > MAX_TEXT_BYTES
            || !config.main_class.split('.').all(|part| {
                let mut chars = part.chars();
                chars
                    .next()
                    .is_some_and(|c| c.is_alphabetic() || c == '_' || c == '$')
                    && chars.all(|c| c.is_alphanumeric() || c == '_' || c == '$')
            }))
    {
        bail!("JAVA_MAIN_CLASS_INVALID");
    }
    if !["global", "project"].contains(&config.maven_scope.as_str())
        || !SUPPORTED_JAVA_VERSIONS.contains(&config.java_version)
        || !["development", "jar"].contains(&config.mode.as_str())
        || [
            &config.module,
            &config.java_home,
            &config.jar,
            &config.maven_profiles,
            &config.spring_profiles,
        ]
        .iter()
        .any(|value| !valid_text(value))
        || [&config.arguments, &config.vm_arguments]
            .iter()
            .any(|values| {
                values.len() > MAX_ARGUMENTS
                    || values
                        .iter()
                        .any(|value| value.len() > MAX_ARGUMENT_BYTES || value.contains('\0'))
            })
    {
        bail!("JAVA_CONFIG_INVALID");
    }
    Ok(())
}
fn save_store(
    path: &Path,
    revision: &str,
    global: Option<MavenConfig>,
    project: Option<(String, ProjectConfig)>,
) -> Result<()> {
    let _guard = CONFIG_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("JAVA_CONFIG_SAVE"))?;
    let (mut store, current) = read_store(path)?;
    if current != revision {
        bail!("JAVA_CONFIG_CONFLICT");
    }
    if let Some(global) = global {
        validate_maven(&global)?;
        store.global = global;
    }
    if let Some((key, mut value)) = project {
        if value.maven_scope == "project" {
            value.maven_configured = true;
        }
        validate_project(&value)?;
        if store.projects.len() >= MAX_SAVED_PROJECTS && !store.projects.contains_key(&key) {
            bail!("JAVA_CONFIG_INVALID");
        }
        store.projects.insert(key, value);
    }
    let parent = path.parent().context("JAVA_CONFIG_SAVE")?;
    let bytes = serde_json::to_vec_pretty(&store)?;
    if bytes.len() > MAX_CONFIG_BYTES {
        bail!("JAVA_CONFIG_INVALID");
    }
    fs::create_dir_all(parent)?;
    let mut staged = tempfile::NamedTempFile::new_in(parent)?;
    staged.write_all(&bytes)?;
    staged.as_file().sync_all()?;
    if read_store(path)?.1 != revision {
        bail!("JAVA_CONFIG_CONFLICT");
    }
    staged
        .persist(path)
        .map_err(|_| anyhow::anyhow!("JAVA_CONFIG_SAVE"))?;
    Ok(())
}

fn java_major(version: &str) -> Option<u32> {
    let number = version.split('"').nth(1).unwrap_or(version).trim();
    let number = number.strip_prefix("1.").unwrap_or(number);
    number
        .split(|c: char| !c.is_ascii_digit())
        .next()?
        .parse()
        .ok()
}
fn resolve_jdk_home(home: &Path) -> PathBuf {
    let bundled = home.join("Contents/Home");
    if !home.join("bin").is_dir() && bundled.join("bin").is_dir() {
        bundled
    } else {
        home.into()
    }
}
pub(crate) fn probe(home: &Path) -> Result<JavaHome> {
    let home = resolve_jdk_home(home);
    let java = home
        .join("bin")
        .join(if cfg!(windows) { "java.exe" } else { "java" });
    let javac = home
        .join("bin")
        .join(if cfg!(windows) { "javac.exe" } else { "javac" });
    if !java.is_file() || !javac.is_file() {
        bail!("JAVA_JDK_REQUIRED");
    }
    let mut child = utermd_local::BackgroundChild::spawn(
        std::process::Command::new(java)
            .arg("-version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
    )?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() > JDK_PROBE_TIMEOUT {
            bail!("JAVA_JDK_REQUIRED");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    use std::io::Read;
    let mut text = String::new();
    if let Some(stderr) = child.take_stderr() {
        stderr.take(8192).read_to_string(&mut text)?;
    }
    let version = java_major(&text).context("JAVA_JDK_REQUIRED")?;
    if !status.success() || !SUPPORTED_JAVA_VERSIONS.contains(&version) {
        bail!("JAVA_JDK_REQUIRED");
    }
    Ok(JavaHome {
        home: path_text(&home.canonicalize()?),
        version,
        registered: false,
        available: true,
    })
}
pub(crate) fn managed_root(app: &tauri::AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()?
        .join("java-build-v1")
        .join("tools"))
}
fn find_jdks(app: &tauri::AppHandle) -> Result<Vec<JavaHome>> {
    let registry = jdks::read(&configuration_path(app)?.with_file_name("jdks.json"))?;
    let mut homes = Vec::new();
    if let Some(home) = std::env::var_os("JAVA_HOME") {
        homes.push(PathBuf::from(home));
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for path in std::env::split_paths(&paths) {
            if path
                .join(if cfg!(windows) { "javac.exe" } else { "javac" })
                .is_file()
            {
                if let Ok(executable) = path
                    .join(if cfg!(windows) { "javac.exe" } else { "javac" })
                    .canonicalize()
                {
                    if let Some(home) = executable.parent().and_then(Path::parent) {
                        homes.push(home.into());
                    }
                }
            }
        }
    }
    #[cfg(windows)]
    for variable in ["ProgramFiles", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(variable) {
            for vendor in [
                "Java",
                "Eclipse Adoptium",
                "Microsoft",
                "Amazon Corretto",
                "Programs/Eclipse Adoptium",
                "Programs/Java",
            ] {
                if let Ok(entries) = fs::read_dir(PathBuf::from(&base).join(vendor)) {
                    homes.extend(entries.flatten().take(30).map(|entry| entry.path()));
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    for base in [
        PathBuf::from("/Library/Java/JavaVirtualMachines"),
        PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
            .join("Library/Java/JavaVirtualMachines"),
    ] {
        if let Ok(entries) = fs::read_dir(base) {
            homes.extend(
                entries
                    .flatten()
                    .take(30)
                    .map(|entry| entry.path().join("Contents/Home")),
            );
        }
    }
    if let Ok(base) = managed_root(app) {
        for version in SUPPORTED_JAVA_VERSIONS {
            if let Ok(path) =
                fs::read_to_string(base.join(format!("jdk-{version}")).join("home.txt"))
            {
                homes.push(PathBuf::from(path.trim()));
            }
        }
    }
    let mut seen = HashSet::new();
    // Different detection sources can resolve to one home; retain the first match's priority.
    // 不同检测来源可能指向同一主目录，去重时保留首个匹配的优先级。
    let mut detected = HashSet::new();
    let started = Instant::now();
    let mut result: Vec<JavaHome> = homes
        .into_iter()
        .filter_map(|home| {
            if started.elapsed() > JDK_DISCOVERY_TIMEOUT || !seen.insert(home.clone()) {
                return None;
            }
            probe(&home).ok()
        })
        .filter(|jdk| {
            detected.insert(if cfg!(windows) {
                jdk.home.to_lowercase()
            } else {
                jdk.home.clone()
            })
        })
        .collect();
    for entry in registry {
        if let Some(jdk) = result
            .iter_mut()
            .find(|jdk| jdks::key(&jdk.home) == jdks::key(&entry.home))
        {
            jdk.registered = true;
            continue;
        }
        let verified = if started.elapsed() < JDK_DISCOVERY_TIMEOUT {
            probe(Path::new(&entry.home)).ok()
        } else {
            None
        };
        let mut jdk = verified.unwrap_or_else(|| jdks::stored(entry));
        jdk.registered = true;
        result.push(jdk);
    }
    Ok(result)
}
fn maven_home() -> Option<PathBuf> {
    for variable in ["MAVEN_HOME", "M2_HOME"] {
        if let Some(path) = std::env::var_os(variable).map(PathBuf::from) {
            if path
                .join("bin")
                .join(if cfg!(windows) { "mvn.cmd" } else { "mvn" })
                .is_file()
            {
                return Some(path);
            }
        }
    }
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .filter_map(|path| {
            let program = path
                .join(if cfg!(windows) { "mvn.cmd" } else { "mvn" })
                .canonicalize()
                .ok()?;
            program.parent()?.parent().map(Path::to_owned)
        })
        .next()
}
fn configuration(
    app: &tauri::AppHandle,
    directory: Option<&str>,
    discover: bool,
) -> Result<Configuration> {
    let (store, revision) = read_store(&configuration_path(app)?)?;
    let key = directory
        .map(root)
        .transpose()?
        .map(|path| path.to_string_lossy().into_owned());
    let project = key
        .as_ref()
        .and_then(|key| store.projects.get(key))
        .cloned();
    Ok(Configuration {
        revision,
        global: store.global,
        configured: project.is_some(),
        project: project.unwrap_or_default(),
        jdks: if discover { find_jdks(app)? } else { vec![] },
        maven_home: maven_home().map(|path| path.to_string_lossy().into_owned()),
    })
}

fn read_pom(root: &Path, folder: &Path) -> Result<(Module, Vec<String>)> {
    let path = folder.join("pom.xml").canonicalize()?;
    if !path.starts_with(root)
        || !fs::metadata(&path)?.is_file()
        || fs::metadata(&path)?.len() > MAX_POM_BYTES
    {
        bail!("JAVA_POM_INVALID");
    }
    let xml = fs::read_to_string(path)?;
    if xml.contains("<!DOCTYPE") || xml.contains("<!ENTITY") {
        bail!("JAVA_POM_INVALID");
    }
    let relative = folder
        .strip_prefix(root)?
        .to_string_lossy()
        .replace('\\', "/");
    let mut module = Module {
        path: if relative.is_empty() {
            ".".into()
        } else {
            relative
        },
        name: folder
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        packaging: "jar".into(),
        ..Module::default()
    };
    let mut modules = Vec::new();
    let mut stack = Vec::<String>::new();
    let mut reader = quick_xml::Reader::from_str(&xml);
    reader.config_mut().trim_text(true);
    loop {
        match reader.read_event()? {
            quick_xml::events::Event::Start(value) => {
                stack.push(String::from_utf8_lossy(value.local_name().as_ref()).into_owned())
            }
            quick_xml::events::Event::End(_) => {
                stack.pop();
            }
            quick_xml::events::Event::Text(value) => {
                let decoded = value.decode()?;
                let text = quick_xml::escape::unescape(&decoded)?.into_owned();
                match stack
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>()
                    .as_slice()
                {
                    ["project", "artifactId"] => module.name = text.clone(),
                    ["project", "packaging"] => module.packaging = text.clone(),
                    ["project", "modules", "module"] => modules.push(text.clone()),
                    ["project", "properties", key]
                        if [
                            "java.version",
                            "maven.compiler.release",
                            "maven.compiler.target",
                        ]
                        .contains(key) =>
                    {
                        if let Some(version) = java_major(&text) {
                            module.java_version = Some(version);
                        }
                    }
                    _ => {}
                }
                if text == "org.springframework.boot"
                    || text == "spring-boot-maven-plugin"
                    || text == "spring-boot-starter-parent"
                {
                    module.boot = true;
                }
            }
            quick_xml::events::Event::Eof => break,
            _ => {}
        }
    }
    if let Ok(target) = folder.join("target").canonicalize() {
        if target.starts_with(root) {
            if let Ok(entries) = fs::read_dir(target) {
                module.jars = entries
                    .flatten()
                    .filter(|entry| {
                        entry.file_type().is_ok_and(|kind| kind.is_file())
                            && entry.path().extension().is_some_and(|value| value == "jar")
                    })
                    .take(MAX_DISCOVERED_JARS)
                    .filter_map(|entry| {
                        entry
                            .path()
                            .strip_prefix(root)
                            .ok()
                            .map(|path| path.to_string_lossy().replace('\\', "/"))
                    })
                    .collect();
            }
        }
    }
    module.main_classes = main_classes::discover(root, folder)
        .map_err(|error| anyhow::anyhow!("JAVA_MAIN_SCAN_FAILED: {error}"))?;
    Ok((module, modules))
}
fn project_info(directory: &str) -> Result<ProjectInfo> {
    let root = root(directory)?;
    let mut queue = vec![root.clone()];
    let mut seen = HashSet::new();
    let mut modules = Vec::new();
    while let Some(folder) = queue.pop() {
        if !seen.insert(folder.clone()) {
            continue;
        }
        if modules.len() >= MAX_PROJECT_MODULES {
            bail!("JAVA_POM_LIMIT");
        }
        let (module, children) = read_pom(&root, &folder)
            .map_err(|error| anyhow::anyhow!("JAVA_POM_INVALID: {error}"))?;
        if modules.len() + queue.len() + children.len() > MAX_PROJECT_MODULES {
            bail!("JAVA_POM_LIMIT");
        }
        for child in children {
            let relative = folder.join(child);
            let child = relative.canonicalize()?;
            if !child.starts_with(&root) {
                bail!("JAVA_PROJECT_INVALID");
            }
            queue.push(child);
        }
        modules.push(module);
    }
    modules.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(ProjectInfo { modules })
}
fn quoted(values: &[String]) -> String {
    values
        .iter()
        .map(|value| format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join(" ")
}
fn split_arguments(text: &str) -> Result<Vec<String>> {
    let mut result = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut present = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\0' {
            bail!("JAVA_ARGUMENTS_INVALID");
        }
        if c == '\\'
            && quote.is_some()
            && chars
                .peek()
                .is_some_and(|next| Some(*next) == quote || *next == '\\')
        {
            word.push(chars.next().unwrap());
            present = true;
            continue;
        }
        if let Some(end) = quote {
            if c == end {
                quote = None;
            } else {
                word.push(c);
            }
            present = true;
        } else if c == '"' || c == '\'' {
            quote = Some(c);
            present = true;
        } else if c.is_whitespace() {
            if present {
                result.push(std::mem::take(&mut word));
                present = false;
            }
        } else {
            word.push(c);
            present = true;
        }
    }
    if quote.is_some() {
        bail!("JAVA_ARGUMENTS_INVALID");
    }
    if present {
        result.push(word);
    }
    Ok(result)
}
fn wrapper_home(
    app: &tauri::AppHandle,
    root: &Path,
    environment: &HashMap<String, String>,
    offline: bool,
) -> Result<PathBuf> {
    let properties =
        inside(root, ".mvn/wrapper/maven-wrapper.properties").context("JAVA_WRAPPER_INVALID")?;
    if !fs::metadata(&properties)?.is_file()
        || fs::metadata(&properties)?.len() > MAX_MAVEN_CONFIG_BYTES
    {
        bail!("JAVA_WRAPPER_INVALID");
    }
    let properties = fs::read_to_string(properties)?;
    let entries: HashMap<_, _> = properties
        .lines()
        .filter(|line| !line.trim_start().starts_with(['#', '!']))
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.trim().to_owned(), value.trim().replace("\\:", ":")))
        .collect();
    let url = entries
        .get("distributionUrl")
        .context("JAVA_WRAPPER_INVALID")?;
    let parsed = reqwest::Url::parse(url).context("JAVA_WRAPPER_INVALID")?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !parsed.path().ends_with(".zip")
    {
        bail!("JAVA_WRAPPER_INVALID");
    }
    let directory = crate::java::managed_root(app)?
        .join("wrappers")
        .join(format!("{:x}", Sha256::digest(url.as_bytes())));
    if let Ok(home) = fs::read_to_string(directory.join("home.txt")) {
        let home = PathBuf::from(home.trim());
        let verified = entries.get("distributionSha256Sum").is_none_or(|expected| {
            home.parent()
                .and_then(Path::file_name)
                .is_some_and(|hash| hash.to_string_lossy().eq_ignore_ascii_case(expected))
        });
        if home.starts_with(&directory) && verified && home.join("bin/m2.conf").is_file() {
            return Ok(home);
        }
    }
    if offline {
        bail!("JAVA_WRAPPER_OFFLINE");
    }
    fs::create_dir_all(&directory)?;
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .build()?;
    let mut request = client.get(parsed);
    if let Some(username) = environment
        .get("MVNW_USERNAME")
        .or_else(|| environment.get("MAVEN_USERNAME"))
    {
        request = request.basic_auth(username, environment.get("MVNW_PASSWORD"));
    }
    let mut response = request.send().context("DOWNLOAD_NETWORK")?;
    if !response.status().is_success()
        || response.url().scheme() != "https"
        || response
            .content_length()
            .is_some_and(|size| size > MAX_WRAPPER_ARCHIVE_BYTES)
    {
        bail!("JAVA_WRAPPER_INVALID");
    }
    let mut archive = tempfile::NamedTempFile::new_in(&directory)?;
    let count = std::io::copy(
        &mut response.by_ref().take(MAX_WRAPPER_ARCHIVE_BYTES + 1),
        &mut archive,
    )?;
    if count > MAX_WRAPPER_ARCHIVE_BYTES {
        bail!("JAVA_WRAPPER_INVALID");
    }
    use std::io::{Read, Seek};
    archive.rewind()?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let count = archive.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    let hash = format!("{:x}", digest.finalize());
    if entries
        .get("distributionSha256Sum")
        .is_some_and(|expected| !expected.eq_ignore_ascii_case(&hash))
    {
        bail!("DB_COMPONENT_HASH");
    }
    archive.rewind()?;
    let stage = tempfile::tempdir_in(&directory)?;
    crate::database_components::extract_bounded(
        &mut archive,
        "maven.zip",
        stage.path(),
        MAX_WRAPPER_EXTRACTED_BYTES,
        false,
    )?;
    let home = fs::read_dir(stage.path())?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .find(|home| home.join("bin/m2.conf").is_file())
        .context("JAVA_WRAPPER_INVALID")?;
    let relative = home.strip_prefix(stage.path())?.to_owned();
    let destination = directory.join(&hash);
    if !destination.exists() {
        fs::rename(stage.path(), &destination)?;
    }
    let home = destination.join(relative);
    let mut pointer = tempfile::NamedTempFile::new_in(&directory)?;
    pointer.write_all(path_text(&home).as_bytes())?;
    pointer.as_file().sync_all()?;
    pointer
        .persist(directory.join("home.txt"))
        .map_err(|_| anyhow::anyhow!("DOWNLOAD_STORAGE"))?;
    Ok(home)
}
fn maven_launcher(
    home: &Path,
    root: &Path,
    environment: &HashMap<String, String>,
) -> Result<Vec<String>> {
    if !home.is_absolute() || !home.join("bin/m2.conf").is_file() {
        bail!("JAVA_MAVEN_REQUIRED");
    }
    let boot = fs::read_dir(home.join("boot"))
        .context("JAVA_MAVEN_REQUIRED")?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name().is_some_and(|name| {
                name.to_string_lossy().starts_with("plexus-classworlds-")
                    && name.to_string_lossy().ends_with(".jar")
            })
        })
        .context("JAVA_MAVEN_REQUIRED")?;
    let opts = environment
        .get("MAVEN_OPTS")
        .cloned()
        .or_else(|| std::env::var("MAVEN_OPTS").ok())
        .unwrap_or_default();
    let mut args = log_jvm_arguments(&split_arguments(&opts)?);
    let jvm = root.join(".mvn/jvm.config");
    if jvm.exists() {
        let jvm = jvm.canonicalize()?;
        if !jvm.starts_with(root)
            || !jvm.is_file()
            || fs::metadata(&jvm)?.len() > MAX_MAVEN_CONFIG_BYTES
        {
            bail!("JAVA_PROJECT_INVALID");
        }
        args.extend(split_arguments(&fs::read_to_string(jvm)?)?);
    }
    args.extend([
        format!("-Dmaven.home={}", path_text(home)),
        format!("-Dmaven.conf={}", path_text(&home.join("conf"))),
        format!(
            "-Dclassworlds.conf={}",
            path_text(&home.join("bin/m2.conf"))
        ),
        format!("-Dmaven.multiModuleProjectDirectory={}", path_text(root)),
        "-classpath".into(),
        path_text(&boot),
        "org.codehaus.plexus.classworlds.launcher.Launcher".into(),
    ]);
    Ok(args)
}
fn select_jdk(app: &tauri::AppHandle, config: &ProjectConfig) -> Result<JavaHome> {
    let jdk = if config.java_home.is_empty() {
        find_jdks(app)?
            .into_iter()
            .find(|value| value.available && value.version == config.java_version)
            .context("JAVA_JDK_REQUIRED")?
    } else {
        probe(Path::new(&config.java_home))?
    };
    if jdk.version != config.java_version {
        bail!("JAVA_JDK_VERSION");
    }
    Ok(jdk)
}
fn task_environment(
    jdk: &JavaHome,
    mut environment: HashMap<String, String>,
) -> Result<HashMap<String, String>> {
    if environment
        .keys()
        .any(|key| key.to_ascii_uppercase().starts_with("UTERM_"))
    {
        bail!("JAVA_TASK_INVALID");
    }
    let custom_path = environment
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("PATH"))
        .map(|(_, value)| value.clone());
    // Remove alternate casing so Windows cannot retain a competing Java selection.
    // 移除不同大小写的键，避免 Windows 保留相互冲突的 Java 选择。
    environment.retain(|key, _| {
        !key.eq_ignore_ascii_case("JAVA_HOME") && !key.eq_ignore_ascii_case("PATH")
    });
    environment.insert("JAVA_HOME".into(), jdk.home.clone());
    let mut paths = vec![Path::new(&jdk.home).join("bin")];
    if let Some(path) = custom_path
        .map(std::ffi::OsString::from)
        .or_else(|| std::env::var_os("PATH"))
    {
        paths.extend(std::env::split_paths(&path));
    }
    environment.insert(
        "PATH".into(),
        std::env::join_paths(paths)?.to_string_lossy().into_owned(),
    );
    Ok(environment)
}
fn project_maven(app: &tauri::AppHandle, config: &ProjectConfig) -> Result<MavenConfig> {
    let (store, _) = read_store(&configuration_path(app)?)?;
    Ok(if config.maven_scope == "project" {
        config.maven.clone()
    } else {
        store.global
    })
}
fn resolve_maven_home(
    app: &tauri::AppHandle,
    root: &Path,
    maven: &MavenConfig,
    environment: &HashMap<String, String>,
    offline: bool,
) -> Result<PathBuf> {
    let wrapper = root.join(if cfg!(windows) { "mvnw.cmd" } else { "mvnw" });
    if maven.wrapper && wrapper.is_file() {
        let resolved = wrapper.canonicalize()?;
        if !resolved.starts_with(root) {
            bail!("JAVA_PROJECT_INVALID");
        }
        return wrapper_home(app, root, environment, offline);
    }
    if maven.distribution == "managed" {
        let home = fs::read_to_string(managed_root(app)?.join("maven").join("home.txt"))
            .context("JAVA_MAVEN_REQUIRED")?;
        Ok(PathBuf::from(home.trim()))
    } else if !maven.home.is_empty() {
        Ok(PathBuf::from(&maven.home))
    } else {
        maven_home().context("JAVA_MAVEN_REQUIRED")
    }
}
fn maven_options(config: &ProjectConfig, maven: &MavenConfig) -> Result<Vec<String>> {
    let mut options = vec!["-B".into()];
    if config.offline {
        options.push("-o".into());
    }
    if !maven.settings.is_empty() {
        if !Path::new(&maven.settings).is_absolute() || !Path::new(&maven.settings).is_file() {
            bail!("JAVA_SETTINGS_MISSING");
        }
        options.extend(["-s".into(), maven.settings.clone()]);
    }
    if !maven.repository.is_empty() {
        if !Path::new(&maven.repository).is_absolute() {
            bail!("JAVA_CONFIG_INVALID");
        }
        options.push(format!("-Dmaven.repo.local={}", maven.repository));
    }
    if !config.maven_profiles.trim().is_empty() {
        options.push(format!("-P{}", config.maven_profiles.trim()));
    }
    if config.skip_tests {
        options.push("-DskipTests".into());
    }
    Ok(options)
}
fn development_arguments(
    config: &ProjectConfig,
    module: &Path,
    mut options: Vec<String>,
) -> Vec<String> {
    options.extend(["-f".into(), path_text(&module.join("pom.xml"))]);
    if !config.spring_profiles.is_empty() {
        options.push(format!(
            "-Dspring-boot.run.profiles={}",
            config.spring_profiles
        ));
    }
    options.push(format!(
        "-Dspring-boot.run.jvmArguments={}",
        quoted(&log_jvm_arguments(&config.vm_arguments))
    ));
    if !config.arguments.is_empty() {
        options.push(format!(
            "-Dspring-boot.run.arguments={}",
            quoted(&config.arguments)
        ));
    }
    if !config.main_class.is_empty() {
        options.push(format!(
            "-Dspring-boot.run.main-class={}",
            config.main_class
        ));
    }
    options.push("spring-boot:run".into());
    options
}
fn jar_arguments(config: &ProjectConfig, jar: Option<&Path>) -> Vec<String> {
    let mut arguments = log_jvm_arguments(&config.vm_arguments);
    arguments.push("-jar".into());
    if let Some(jar) = jar {
        arguments.push(path_text(jar));
    }
    if !config.spring_profiles.is_empty() {
        arguments.push(format!(
            "--spring.profiles.active={}",
            config.spring_profiles
        ));
    }
    arguments.extend(config.arguments.clone());
    arguments
}
fn log_jvm_arguments(arguments: &[String]) -> Vec<String> {
    // Use UTF-8 for redirected Java streams, without changing application file encoding.
    // Java 标准流重定向时使用 UTF-8，不改变应用文件编码。
    let mut result = [
        "stdout.encoding",
        "stderr.encoding",
        "sun.stdout.encoding",
        "sun.stderr.encoding",
    ]
    .map(|property| format!("-D{property}=UTF-8"))
    .to_vec();
    result.extend_from_slice(arguments);
    result
}
fn existing_jar_step(
    root: &Path,
    module: &Path,
    config: &ProjectConfig,
    java: PathBuf,
    environment: HashMap<String, String>,
) -> Result<Step> {
    let jar = inside(root, &config.jar)?;
    if !jar.is_file() || jar.extension().is_none_or(|value| value != "jar") {
        bail!("JAVA_JAR_AMBIGUOUS");
    }
    Ok(Step {
        program: java,
        arguments: jar_arguments(config, Some(&jar)),
        directory: module.into(),
        environment,
        label: "Spring Boot JAR run".into(),
        jar_directory: None,
    })
}
fn task_launch(
    root: PathBuf,
    name: String,
    action: &str,
    steps: Vec<Step>,
) -> Result<(TaskInfo, Launch)> {
    let launch = Launch {
        root: root.clone(),
        steps,
    };
    launch.validate()?;
    let task = TaskInfo {
        root,
        name,
        action: action.into(),
        created: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis() as u64,
    };
    Ok((task, launch))
}
fn build_launch(
    app: &tauri::AppHandle,
    directory: &str,
    config: &ProjectConfig,
    action: &str,
    environment: HashMap<String, String>,
) -> Result<(TaskInfo, Launch)> {
    validate_project(config)?;
    if !["build", "test", "install", "run"].contains(&action) {
        bail!("JAVA_TASK_INVALID");
    }
    let root = root(directory)?;
    let module = inside(&root, &config.module)?;
    let info = project_info(directory)?;
    let selected = info
        .modules
        .iter()
        .find(|value| value.path == config.module)
        .context("JAVA_MODULE_INVALID")?;
    if action == "run" && selected.packaging == "pom" {
        bail!("JAVA_MODULE_INVALID");
    }
    let jdk = select_jdk(app, config)?;
    let java =
        Path::new(&jdk.home)
            .join("bin")
            .join(if cfg!(windows) { "java.exe" } else { "java" });
    let environment = task_environment(&jdk, environment)?;
    // Existing artifacts need only Java; resolving Maven here could trigger a Wrapper download.
    // 已有产物只需 Java；若提前解析 Maven，可能触发不必要的 Wrapper 下载。
    if action == "run" && config.mode == "jar" && !config.jar.is_empty() {
        let step = existing_jar_step(&root, &module, config, java, environment)?;
        return task_launch(root, selected.name.clone(), action, vec![step]);
    }
    let maven = project_maven(app, config)?;
    let home = resolve_maven_home(app, &root, &maven, &environment, config.offline)?;
    let launcher_arguments = maven_launcher(&home, &root, &environment)?;
    let common_options = maven_options(config, &maven)?;
    let maven_step = |arguments: Vec<String>, label: &str| Step {
        program: java.clone(),
        arguments: launcher_arguments
            .iter()
            .cloned()
            .chain(arguments)
            .collect(),
        directory: root.clone(),
        environment: environment.clone(),
        label: label.into(),
        jar_directory: None,
    };
    let mut reactor_arguments = common_options.clone();
    if config.module != "." {
        reactor_arguments.extend(["-pl".into(), config.module.clone(), "-am".into()]);
    }
    let mut steps = Vec::new();
    if action != "run" {
        reactor_arguments.push(
            match action {
                "test" => "test",
                "install" => "install",
                _ => "package",
            }
            .into(),
        );
        steps.push(maven_step(reactor_arguments, "Maven build"));
    } else if config.mode == "development" {
        if config.module != "." && info.modules.len() > 1 {
            let mut prepare = reactor_arguments;
            prepare.extend(["-DskipTests".into(), "install".into()]);
            steps.push(maven_step(prepare, "Prepare Maven modules"));
        }
        let mut resolved = config.clone();
        if resolved.main_class.is_empty() {
            resolved.main_class = main_classes::automatic(&selected.main_classes)?
                .unwrap_or("")
                .into();
        }
        steps.push(maven_step(
            development_arguments(&resolved, &module, common_options),
            "Spring Boot development run",
        ));
    } else {
        reactor_arguments.push("package".into());
        steps.push(maven_step(reactor_arguments, "Maven package"));
        let step = Step {
            program: java,
            arguments: jar_arguments(config, None),
            directory: module.clone(),
            environment: environment.clone(),
            label: "Spring Boot JAR run".into(),
            // The runner resolves the final artifact after packaging, without a shell glob.
            // 执行器在打包完成后解析最终产物，不通过 Shell 通配符查找。
            jar_directory: Some(module.join("target")),
        };
        steps.push(step);
    }
    task_launch(root, selected.name.clone(), action, steps)
}

#[tauri::command]
pub async fn java_detect_jdks(app: tauri::AppHandle) -> Result<Vec<JavaHome>, String> {
    tauri::async_runtime::spawn_blocking(move || find_jdks(&app))
        .await
        .map_err(|_| "JAVA_OPERATION_FAILED".to_string())?
        .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
pub async fn java_register_jdk(
    app: tauri::AppHandle,
    home: String,
    remove: bool,
) -> Result<Vec<JavaHome>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<JavaHome>> {
        if !valid_text(&home) || !Path::new(&home).is_absolute() {
            bail!("JAVA_JDK_REQUIRED");
        }
        let jdk = if remove {
            None
        } else {
            Some(probe(Path::new(&home))?)
        };
        let key = jdk.as_ref().map(|jdk| jdk.home.as_str()).unwrap_or(&home);
        // Keep JDK records separate so registration cannot invalidate a Maven draft revision.
        // JDK 记录独立保存，避免添加记录使 Maven 草稿版本失效。
        jdks::update(
            &configuration_path(&app)?.with_file_name("jdks.json"),
            key,
            jdk.as_ref(),
        )?;
        use tauri::Emitter;
        app.emit("java-components-changed", ())?;
        find_jdks(&app)
    })
    .await
    .map_err(|_| "JAVA_OPERATION_FAILED".to_string())?
    .map_err(|error| format!("{error:#}"))
}

#[tauri::command]
pub async fn java_select_path(
    window: tauri::WebviewWindow,
    kind: String,
    directory: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    if !["home", "settings", "repository"].contains(&kind.as_str()) {
        return Err("JAVA_CONFIG_INVALID".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = window.dialog().file().set_parent(&window);
        let path = Path::new(&directory);
        let initial = if path.is_dir() {
            Some(path)
        } else {
            path.parent().filter(|parent| parent.is_dir())
        };
        if let Some(initial) = initial {
            dialog = dialog.set_directory(initial);
        }
        let selected = if kind == "settings" {
            dialog
                .add_filter("settings.xml", &["xml"])
                .blocking_pick_file()
        } else {
            dialog.blocking_pick_folder()
        };
        selected
            .map(|file| {
                file.into_path()
                    .map(|path| path_text(&path))
                    .map_err(|_| "JAVA_PROJECT_INVALID".to_string())
            })
            .transpose()
    })
    .await
    .map_err(|_| "JAVA_OPERATION_FAILED".to_string())?
}

#[tauri::command]
pub async fn java_configuration(
    app: tauri::AppHandle,
    directory: Option<String>,
) -> Result<Configuration, String> {
    tauri::async_runtime::spawn_blocking(move || configuration(&app, directory.as_deref(), true))
        .await
        .map_err(|_| "JAVA_OPERATION_FAILED")?
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn java_save_configuration(
    app: tauri::AppHandle,
    directory: Option<String>,
    revision: String,
    global: Option<MavenConfig>,
    project: Option<ProjectConfig>,
) -> Result<Configuration, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = directory
            .as_deref()
            .map(root)
            .transpose()?
            .map(|path| path.to_string_lossy().into_owned());
        let project = project
            .map(|value| Ok::<_, anyhow::Error>((key.context("JAVA_PROJECT_INVALID")?, value)))
            .transpose()?;
        save_store(&configuration_path(&app)?, &revision, global, project)?;
        configuration(&app, directory.as_deref(), false)
    })
    .await
    .map_err(|_| "JAVA_OPERATION_FAILED")?
    .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn java_project(directory: String) -> Result<ProjectInfo, String> {
    tauri::async_runtime::spawn_blocking(move || project_info(&directory))
        .await
        .map_err(|_| "JAVA_OPERATION_FAILED")?
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn java_tasks(
    app: tauri::AppHandle,
    directory: String,
) -> Result<Vec<TaskSession>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = root(&directory)?;
        let path = crate::sessions::local_root(&app).map_err(anyhow::Error::msg)?;
        if !path.join("endpoint.json").exists() {
            return Ok(vec![]);
        }
        let client = Client::connect(&path)?;
        client.require_task_support()?;
        let Reply::Tasks(tasks) = client.request(Operation::TaskSnapshot)? else {
            bail!("JAVA_OPERATION_FAILED")
        };
        Ok(tasks
            .into_iter()
            .filter(|task| task.task.root == root && !task.task.action.starts_with("python:"))
            .collect())
    })
    .await
    .map_err(|_| "JAVA_OPERATION_FAILED")?
    .map_err(|error: anyhow::Error| error.to_string())
}
#[tauri::command]
pub async fn java_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<crate::sessions::Sessions>>,
    directory: String,
    config: ProjectConfig,
    action: String,
    environment: HashMap<String, String>,
) -> Result<TaskSession, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (task, launch) = build_launch(&app, &directory, &config, &action, environment)?;
        let client = crate::sessions::local_client(&app, &state).map_err(anyhow::Error::msg)?;
        client.require_task_support()?;
        client.require_task_output_support()?;
        let spec = SessionSpec {
            id: uuid::Uuid::new_v4().to_string(),
            directory: task.root.clone(),
            shell: "default".into(),
            agent: None,
            ssh: None,
        };
        let Reply::Opened { generation } = client.request(Operation::OpenTask {
            spec: spec.clone(),
            task: task.clone(),
            launch,
            rows: 30,
            cols: 100,
        })?
        else {
            bail!("JAVA_OPERATION_FAILED")
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
    .map_err(|_| "JAVA_OPERATION_FAILED")?
    .map_err(|error: anyhow::Error| error.to_string())
}
#[tauri::command]
pub async fn java_stop(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<crate::sessions::Sessions>>,
    id: String,
    generation: String,
    force: bool,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
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
    .map_err(|_| "JAVA_OPERATION_FAILED")?
    .map_err(|error: anyhow::Error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn main_class_configuration_defaults_validates_and_reaches_maven() {
        let legacy: ProjectConfig = serde_json::from_str("{}").unwrap();
        assert!(legacy.main_class.is_empty());
        let mut config = ProjectConfig {
            main_class: "com.example.Application".into(),
            ..ProjectConfig::default()
        };
        validate_project(&config).unwrap();
        let args = development_arguments(&config, Path::new("."), vec![]);
        assert!(args.contains(&"-Dspring-boot.run.main-class=com.example.Application".into()));
        assert_eq!(args.last().unwrap(), "spring-boot:run");
        let copy: ProjectConfig =
            serde_json::from_str(&serde_json::to_string(&config).unwrap()).unwrap();
        assert_eq!(copy.main_class, config.main_class);
        for invalid in [
            "-Dother=value",
            "com..App",
            "com.App; echo bad",
            "com.1App",
            "com.App\n",
        ] {
            config.main_class = invalid.into();
            assert!(validate_project(&config).is_err(), "{invalid}");
        }
    }
    #[test]
    fn task_environment_replaces_case_variants_and_rejects_private_host_variables() {
        let directory = tempfile::tempdir().unwrap();
        let jdk = JavaHome {
            home: directory
                .path()
                .join("JDK 中文 & %")
                .to_string_lossy()
                .into(),
            version: 21,
            registered: false,
            available: true,
        };
        let custom_bin = directory.path().join("custom bin");
        let environment = HashMap::from([
            ("java_home".into(), "old-java".into()),
            (
                "Path".into(),
                std::env::join_paths([&custom_bin])
                    .unwrap()
                    .to_string_lossy()
                    .into(),
            ),
            ("QA_VALUE".into(), "中文 & %PATH%".into()),
        ]);
        let merged = task_environment(&jdk, environment).unwrap();
        assert_eq!(merged["JAVA_HOME"], jdk.home);
        assert!(!merged.contains_key("java_home"));
        assert!(!merged.contains_key("Path"));
        assert_eq!(merged["QA_VALUE"], "中文 & %PATH%");
        assert_eq!(
            std::env::split_paths(&merged["PATH"]).collect::<Vec<_>>(),
            [Path::new(&jdk.home).join("bin"), custom_bin]
        );
        assert!(task_environment(
            &jdk,
            HashMap::from([("uterm_task_id".into(), "private".into())]),
        )
        .is_err());
    }
    #[test]
    fn jdk_bundle_selection_resolves_contents_home_without_changing_direct_homes() {
        let directory = tempfile::tempdir().unwrap();
        let bundle = directory.path().join("temurin 中文.jdk");
        let nested = bundle.join("Contents/Home");
        fs::create_dir_all(nested.join("bin")).unwrap();
        assert_eq!(resolve_jdk_home(&bundle), nested);
        assert_eq!(resolve_jdk_home(&nested), nested);
        let direct = directory.path().join("jdk-21");
        fs::create_dir_all(direct.join("bin")).unwrap();
        assert_eq!(resolve_jdk_home(&direct), direct);
        let missing = directory.path().join("missing-jdk");
        assert_eq!(resolve_jdk_home(&missing), missing);
    }
    #[test]
    fn existing_jar_run_uses_only_java_and_keeps_literal_arguments_inside_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let jar = root.join("service 中文 & %.jar");
        fs::write(&jar, b"jar").unwrap();
        let config = ProjectConfig {
            mode: "jar".into(),
            jar: "service 中文 & %.jar".into(),
            maven: MavenConfig {
                home: "missing-maven".into(),
                settings: "missing-settings.xml".into(),
                ..MavenConfig::default()
            },
            vm_arguments: vec!["-Dliteral=a & b".into()],
            spring_profiles: "qa".into(),
            arguments: vec!["--literal=中文 & %PATH%".into()],
            ..ProjectConfig::default()
        };
        let java = root.join("java");
        let step = existing_jar_step(&root, &root, &config, java.clone(), HashMap::new()).unwrap();
        assert_eq!(step.program, java);
        assert_eq!(
            step.arguments,
            [
                "-Dstdout.encoding=UTF-8",
                "-Dstderr.encoding=UTF-8",
                "-Dsun.stdout.encoding=UTF-8",
                "-Dsun.stderr.encoding=UTF-8",
                "-Dliteral=a & b",
                "-jar",
                &path_text(&jar),
                "--spring.profiles.active=qa",
                "--literal=中文 & %PATH%"
            ]
        );
        assert!(step.jar_directory.is_none());
        let escaped = ProjectConfig {
            jar: "../outside.jar".into(),
            ..config
        };
        assert!(existing_jar_step(&root, &root, &escaped, java, HashMap::new()).is_err());
    }
    #[test]
    fn native_maven_arguments_preserve_paths_and_project_jvm_configuration() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        fs::create_dir_all(root.join("Maven 中文 & %PATH%/boot")).unwrap();
        fs::create_dir_all(root.join("Maven 中文 & %PATH%/bin")).unwrap();
        fs::create_dir_all(root.join(".mvn")).unwrap();
        fs::write(root.join("Maven 中文 & %PATH%/bin/m2.conf"), "").unwrap();
        fs::write(
            root.join("Maven 中文 & %PATH%/boot/plexus-classworlds-qa.jar"),
            "",
        )
        .unwrap();
        fs::write(root.join(".mvn/jvm.config"), "\"-Dqa.value=中文 & %PATH%\"").unwrap();
        let environment = HashMap::from([("MAVEN_OPTS".into(), "-Xmx128m".into())]);
        let args = maven_launcher(&root.join("Maven 中文 & %PATH%"), &root, &environment).unwrap();
        assert_eq!(&args[4..6], ["-Xmx128m", "-Dqa.value=中文 & %PATH%"]);
        assert!(args.iter().any(|arg| arg
            == &format!(
                "-Dmaven.home={}",
                path_text(&root.join("Maven 中文 & %PATH%"))
            )));
        assert_eq!(
            args.last().unwrap(),
            "org.codehaus.plexus.classworlds.launcher.Launcher"
        );
        assert_eq!(
            split_arguments(&quoted(&[
                "C:\\path with spaces\\".into(),
                "a\"b".into(),
                "".into()
            ]))
            .unwrap(),
            ["C:\\path with spaces\\", "a\"b", ""]
        );
    }
    #[test]
    fn java_stream_encoding_is_utf8_without_changing_file_encoding() {
        let config = ProjectConfig {
            vm_arguments: vec!["-Dfile.encoding=GBK".into()],
            ..ProjectConfig::default()
        };
        let jar = jar_arguments(&config, None);
        assert!(jar.contains(&"-Dstdout.encoding=UTF-8".into()));
        assert!(jar.contains(&"-Dsun.stderr.encoding=UTF-8".into()));
        assert!(jar.contains(&"-Dfile.encoding=GBK".into()));
        assert!(!jar.contains(&"-Dfile.encoding=UTF-8".into()));
        let development = development_arguments(&config, Path::new("."), vec![]);
        let arguments = development
            .iter()
            .find(|value| value.starts_with("-Dspring-boot.run.jvmArguments="))
            .unwrap();
        assert!(arguments.contains("-Dstdout.encoding=UTF-8"));
        assert!(arguments.contains("-Dfile.encoding=GBK"));
    }
    #[test]
    fn configuration_conflicts_preserve_independent_project_settings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let project = ProjectConfig {
            maven_scope: "project".into(),
            maven: MavenConfig {
                repository: "project-repository".into(),
                ..MavenConfig::default()
            },
            ..ProjectConfig::default()
        };
        save_store(&path, "missing", None, Some(("project".into(), project))).unwrap();
        assert!(save_store(&path, "missing", Some(MavenConfig::default()), None).is_err());
        let (store, revision) = read_store(&path).unwrap();
        assert_eq!(
            store.projects["project"].maven.repository,
            "project-repository"
        );
        save_store(
            &path,
            &revision,
            Some(MavenConfig {
                repository: "global-repository".into(),
                ..MavenConfig::default()
            }),
            None,
        )
        .unwrap();
        assert_eq!(
            read_store(&path).unwrap().0.projects["project"]
                .maven
                .repository,
            "project-repository"
        );
        fs::write(&path, "invalid").unwrap();
        assert!(read_store(&path).is_err());
    }
    #[test]
    fn oversized_configuration_save_preserves_the_readable_store() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        save_store(&path, "missing", Some(MavenConfig::default()), None).unwrap();
        let original = fs::read(&path).unwrap();
        let (_, revision) = read_store(&path).unwrap();
        let project = ProjectConfig {
            arguments: vec!["x".repeat(16384); 128],
            ..ProjectConfig::default()
        };
        assert!(save_store(&path, &revision, None, Some(("large".into(), project))).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        assert!(read_store(&path).unwrap().0.projects.is_empty());
    }
    #[test]
    fn project_discovery_rejects_external_modules_and_entities() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("pom.xml"),"<project><artifactId>demo</artifactId><modules><module>../external</module></modules></project>").unwrap();
        fs::create_dir(dir.path().join("external")).unwrap();
        assert!(project_info(root.to_str().unwrap()).is_err());
        fs::write(root.join("pom.xml"), "<!DOCTYPE project><project/>").unwrap();
        assert!(project_info(root.to_str().unwrap()).is_err());
        fs::write(root.join("pom.xml"),"<project><artifactId>demo</artifactId><properties><java.version>1.8</java.version></properties></project>").unwrap();
        let info = project_info(root.to_str().unwrap()).unwrap();
        assert_eq!(info.modules[0].java_version, Some(8));
    }
}
