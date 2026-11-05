use anyhow::Result;

pub const CAPABILITY: &str = "java-utf8-launch-v2";
pub const LEGACY_CAPABILITY: &str = "java-utf8-launch-v1";
#[cfg(windows)]
mod agent;
#[cfg(windows)]
const LIMIT: usize = 16 * 1024 * 1024;

#[cfg(windows)]
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Payload {
    program: std::path::PathBuf,
    arguments: Vec<String>,
    #[serde(default)]
    cache: Option<std::path::PathBuf>,
}

pub(crate) struct Prepared {
    pub executable: std::path::PathBuf,
    pub payload: Vec<u8>,
    #[cfg(windows)]
    _cache: Option<Cache>,
}
#[cfg(windows)]
struct Cache {
    _ownership: std::fs::File,
    directory: tempfile::TempDir,
}
#[cfg(not(windows))]
pub(crate) fn prepare(
    _step: &crate::tasks::Step,
    _root: &std::path::Path,
) -> Result<Option<Prepared>> {
    Ok(None)
}
#[cfg(windows)]
pub(crate) fn prepare(
    step: &crate::tasks::Step,
    root: &std::path::Path,
) -> Result<Option<Prepared>> {
    if !step.windows_java_utf8
        || (step.program.as_os_str().as_encoded_bytes().is_ascii()
            && step.directory.as_os_str().as_encoded_bytes().is_ascii()
            && step.arguments.iter().all(|value| value.is_ascii()))
    {
        return Ok(None);
    }
    let home = step
        .program
        .parent()
        .and_then(std::path::Path::parent)
        .ok_or_else(|| anyhow::anyhow!("JAVA_UTF8_JDK_INVALID"))?;
    let version = windows::version(home)?;
    let legacy = version.as_bytes().starts_with(b"1.8.") || version.as_bytes().starts_with(b"8.");
    let cache = if legacy {
        let cache = windows::cache_jdk8(root, home)?;
        // Java 8 loads native bootstrap libraries before premain can repair its locale-decoded paths.
        // Java 8 在 premain 能修复区域解码路径前就加载原生启动库。
        anyhow::ensure!(
            cache
                .directory
                .path()
                .as_os_str()
                .as_encoded_bytes()
                .is_ascii(),
            "JAVA_UTF8_JDK8_CACHE_PATH_UNSUPPORTED"
        );
        Some(cache)
    } else {
        None
    };
    let executable = if let Some(cache) = &cache {
        use std::io::Write;
        let mut agent = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(
                cache
                    .directory
                    .path()
                    .join("bin/uterm-java8-encoding-agent.jar"),
            )?;
        agent.write_all(agent::JAR)?;
        let target = cache
            .directory
            .path()
            .join("bin")
            .join(format!("uterm-java-utf8-{}.exe", uuid::Uuid::new_v4()));
        windows::copy_new(&std::env::current_exe()?, &target)?;
        target
    } else {
        std::env::current_exe()?
    };
    let bytes = serde_json::to_vec(&Payload {
        program: step.program.clone(),
        arguments: step.arguments.clone(),
        cache: cache
            .as_ref()
            .map(|cache| cache.directory.path().to_owned()),
    })?;
    anyhow::ensure!(bytes.len() <= LIMIT, "JAVA_UTF8_ARGUMENTS_INVALID");
    Ok(Some(Prepared {
        executable,
        payload: bytes,
        _cache: cache,
    }))
}

#[cfg(any(windows, test))]
fn quoted_command(arguments: &[String]) -> Result<Vec<u8>> {
    let mut command = String::new();
    for argument in arguments {
        anyhow::ensure!(!argument.contains('\0'), "JAVA_UTF8_ARGUMENTS_INVALID");
        if !command.is_empty() {
            command.push(' ');
        }
        command.push('"');
        let mut slashes = 0;
        for character in argument.chars() {
            if character == '\\' {
                slashes += 1;
                continue;
            }
            command.extend(std::iter::repeat_n(
                '\\',
                slashes * if character == '"' { 2 } else { 1 },
            ));
            slashes = 0;
            if character == '"' {
                command.push('\\');
            }
            command.push(character);
        }
        command.extend(std::iter::repeat_n('\\', slashes * 2));
        command.push('"');
    }
    Ok(std::ffi::CString::new(command)?.into_bytes_with_nul())
}

#[cfg(any(windows, test))]
fn legacy_options(
    arguments: &[String],
    cache: &str,
    directory: &str,
    home: &str,
    default_classpath: &str,
) -> Result<String> {
    let mut classpath = default_classpath.to_owned();
    let mut properties = Vec::new();
    let mut index = 0;
    let target = loop {
        let Some(argument) = arguments.get(index) else {
            return Err(anyhow::anyhow!("JAVA_UTF8_ARGUMENTS_INVALID"));
        };
        if argument == "-cp" || argument == "-classpath" {
            index += 1;
            classpath = arguments
                .get(index)
                .ok_or_else(|| anyhow::anyhow!("JAVA_UTF8_ARGUMENTS_INVALID"))?
                .clone();
        } else if argument == "-jar" {
            index += 1;
            classpath = arguments
                .get(index)
                .ok_or_else(|| anyhow::anyhow!("JAVA_UTF8_ARGUMENTS_INVALID"))?
                .clone();
            break index;
        } else if !argument.starts_with('-') {
            break index;
        } else if let Some(property) = argument.strip_prefix("-D") {
            if let Some(value) = property.strip_prefix("java.class.path=") {
                classpath = value.into();
            }
            if property.starts_with("sun.java.command=") || property.starts_with("java.class.path=")
            {
                index += 1;
                continue;
            }
            properties.push(if property.contains('=') {
                property.to_owned()
            } else {
                format!("{property}=")
            });
        }
        index += 1;
    };
    let command = arguments[target..].join(" ");
    let mut values = vec![
        "1",
        cache,
        directory,
        home,
        classpath.as_str(),
        command.as_str(),
    ];
    values.extend(properties.iter().map(String::as_str));
    anyhow::ensure!(
        values.iter().all(|value| !value.contains('\0')),
        "JAVA_UTF8_ARGUMENTS_INVALID"
    );
    let bytes = values.join("\0").into_bytes();
    anyhow::ensure!(
        bytes.len() <= 16 * 1024 * 1024,
        "JAVA_UTF8_ARGUMENTS_INVALID"
    );
    Ok(bytes.iter().map(|value| format!("{value:02x}")).collect())
}

#[cfg(windows)]
pub fn run() -> Result<i32> {
    windows::run()
}

#[cfg(windows)]
mod windows {
    use super::*;
    use anyhow::{bail, Context};
    use std::{
        ffi::{c_char, c_int, c_void, CString},
        io::Read,
        os::windows::{ffi::OsStrExt, io::IntoRawHandle},
        path::{Path, PathBuf},
    };
    use windows_sys::Win32::{
        Foundation::HMODULE,
        Globalization::GetACP,
        System::{
            Console::{
                AttachConsole, GetConsoleCP, SetStdHandle, ATTACH_PARENT_PROCESS, STD_INPUT_HANDLE,
            },
            LibraryLoader::{
                AddDllDirectory, GetProcAddress, LoadLibraryExW, SetDefaultDllDirectories,
                LOAD_LIBRARY_SEARCH_DEFAULT_DIRS, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
            },
        },
    };

    #[repr(C)]
    struct StdArg {
        value: *mut c_char,
        wildcard: u8,
    }
    type Launch = unsafe extern "system" fn(
        c_int,
        *mut *mut c_char,
        c_int,
        *const *const c_char,
        c_int,
        *const *const c_char,
        *const c_char,
        *const c_char,
        *const c_char,
        *const c_char,
        u8,
        u8,
        u8,
        c_int,
    ) -> c_int;
    type Init = unsafe extern "system" fn(u8, u8);
    type Parse = unsafe extern "system" fn(*mut c_char);
    type Count = unsafe extern "system" fn() -> c_int;
    type Args = unsafe extern "system" fn() -> *mut StdArg;

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain([0]).collect()
    }
    fn text_path(path: &Path) -> Result<String> {
        let value = path.to_str().context("JAVA_UTF8_ARGUMENTS_INVALID")?;
        Ok(if let Some(value) = value.strip_prefix("\\\\?\\UNC\\") {
            format!("\\\\{value}")
        } else {
            value.strip_prefix("\\\\?\\").unwrap_or(value).to_owned()
        })
    }
    pub(super) fn agent_path(agent: &Path, directory: &Path) -> Result<String> {
        let agent = PathBuf::from(text_path(agent)?);
        let directory = PathBuf::from(text_path(directory)?);
        let target: Vec<_> = agent.components().collect();
        let source: Vec<_> = directory.components().collect();
        let common = target
            .iter()
            .zip(&source)
            .take_while(|(left, right)| {
                left.as_os_str()
                    .as_encoded_bytes()
                    .eq_ignore_ascii_case(right.as_os_str().as_encoded_bytes())
            })
            .count();
        if common >= 2
            && !text_path(&agent)?
                .chars()
                .any(|value| value as u32 > 0xffff)
        {
            let mut relative = PathBuf::new();
            for _ in &source[common..] {
                relative.push("..");
            }
            for part in &target[common..] {
                relative.push(part.as_os_str());
            }
            if let Some(value) = relative.to_str().filter(|value| value.is_ascii()) {
                return Ok(value.into());
            }
        }
        let mut buffer = vec![0u16; 32768];
        let length = unsafe {
            windows_sys::Win32::Storage::FileSystem::GetShortPathNameW(
                wide(&agent).as_ptr(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
            )
        } as usize;
        if length > 0 && length < buffer.len() {
            let value = String::from_utf16(&buffer[..length])?;
            if value.is_ascii() {
                return Ok(value);
            }
        }
        let value = text_path(&agent)?;
        anyhow::ensure!(value.is_ascii(), "JAVA_UTF8_AGENT_PATH_UNSUPPORTED");
        Ok(value)
    }
    unsafe fn symbol(library: HMODULE, name: &'static [u8]) -> Result<*mut c_void> {
        GetProcAddress(library, name.as_ptr())
            .map(|value| value as *const () as *mut c_void)
            .context("JAVA_UTF8_JLI_UNSUPPORTED")
    }
    pub(super) fn version(home: &Path) -> Result<CString> {
        let release = std::fs::read_to_string(home.join("release")).or_else(|error| {
            if home.file_name().is_some_and(|name| name == "jre") {
                std::fs::read_to_string(
                    home.parent()
                        .context("JAVA_UTF8_JDK_INVALID")?
                        .join("release"),
                )
                .map_err(anyhow::Error::from)
            } else {
                Err(error.into())
            }
        })?;
        let value = ["JAVA_RUNTIME_VERSION=", "JAVA_VERSION="]
            .iter()
            .find_map(|key| {
                release
                    .lines()
                    .find_map(|line| line.strip_prefix(key))
                    .map(|value| value.trim_matches('"'))
            })
            .context("JAVA_UTF8_JDK_INVALID")?;
        anyhow::ensure!(
            !value.is_empty() && value.len() < 128,
            "JAVA_UTF8_JDK_INVALID"
        );
        Ok(CString::new(value)?)
    }
    const OWNER: &str = ".uterm-java-utf8-owner";
    const MARKER: &[u8] = b"uterm-java-utf8-cache-v1";
    pub(super) fn link_or_copy(source: &Path, target: &Path) -> Result<()> {
        if std::fs::hard_link(source, target).is_ok() {
            return Ok(());
        }
        copy_new(source, target)
    }
    pub(super) fn copy_new(source: &Path, target: &Path) -> Result<()> {
        let mut input = std::fs::File::open(source)?;
        let mut output = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(target)?;
        let length = input.metadata()?.len();
        anyhow::ensure!(length <= 2 * 1024 * 1024 * 1024, "JAVA_UTF8_JDK_INVALID");
        let copied = std::io::copy(&mut (&mut input).take(length + 1), &mut output)?;
        anyhow::ensure!(copied == length, "JAVA_UTF8_JDK_CHANGED");
        Ok(())
    }
    fn cache_owner(path: &Path) -> Result<std::fs::File> {
        let mut owner = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path.join(OWNER))?;
        let mut marker = Vec::new();
        (&mut owner).take(64).read_to_end(&mut marker)?;
        anyhow::ensure!(marker == MARKER, "JAVA_UTF8_CACHE_INVALID");
        Ok(owner)
    }
    pub(super) fn cleanup_stale(root: &Path, minimum_age: std::time::Duration) -> Result<()> {
        use std::os::windows::fs::MetadataExt;
        for entry in std::fs::read_dir(root)?.take(128) {
            let entry = entry?;
            if !entry
                .file_name()
                .to_string_lossy()
                .starts_with("java-utf8-jdk8-")
            {
                continue;
            }
            let metadata = std::fs::symlink_metadata(entry.path())?;
            if !metadata.is_dir()
                || metadata.file_attributes() & 0x400 != 0
                || metadata.modified()?.elapsed().unwrap_or_default() < minimum_age
            {
                continue;
            }
            if let Ok(owner) = cache_owner(&entry.path()) {
                if owner.try_lock().is_ok() {
                    drop(owner);
                    // Every cached entry is an owned directory or a file hardlink/copy, never a directory junction.
                    // 缓存仅包含自建目录和文件硬链接／副本，绝不包含目录联接。
                    if let Err(error) = std::fs::remove_dir_all(entry.path()) {
                        eprintln!("Java UTF-8 cache cleanup: {error}");
                    }
                }
            }
        }
        Ok(())
    }
    pub(super) fn cache_jdk8(root: &Path, home: &Path) -> Result<Cache> {
        use std::io::Write;
        cleanup_stale(root, std::time::Duration::from_secs(60))?;
        let directory = tempfile::Builder::new()
            .prefix("java-utf8-jdk8-")
            .tempdir_in(root)?;
        let mut ownership = std::fs::OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(directory.path().join(OWNER))?;
        ownership.write_all(MARKER)?;
        ownership.lock_shared()?;
        fn mirror(
            source: &Path,
            target: &Path,
            depth: usize,
            budget: &mut (usize, u64),
        ) -> Result<()> {
            use std::os::windows::fs::MetadataExt;
            anyhow::ensure!(depth <= 32, "JAVA_UTF8_JDK_INVALID");
            for entry in std::fs::read_dir(source)? {
                let entry = entry?;
                let metadata = std::fs::symlink_metadata(entry.path())?;
                budget.0 += 1;
                budget.1 = budget.1.saturating_add(metadata.len());
                anyhow::ensure!(
                    budget.0 <= 32768
                        && budget.1 <= 2 * 1024 * 1024 * 1024
                        && metadata.file_attributes() & 0x400 == 0,
                    "JAVA_UTF8_JDK_INVALID"
                );
                let destination = target.join(entry.file_name());
                if metadata.is_dir() {
                    std::fs::create_dir(&destination)?;
                    mirror(&entry.path(), &destination, depth + 1, budget)?;
                } else if metadata.is_file() {
                    link_or_copy(&entry.path(), &destination)?;
                } else {
                    bail!("JAVA_UTF8_JDK_INVALID");
                }
            }
            Ok(())
        }
        mirror(home, directory.path(), 0, &mut (0, 0))?;
        Ok(Cache {
            _ownership: ownership,
            directory,
        })
    }
    pub(super) fn run() -> Result<i32> {
        let mut bytes = Vec::new();
        std::io::stdin()
            .lock()
            .take((LIMIT + 1) as u64)
            .read_to_end(&mut bytes)?;
        anyhow::ensure!(bytes.len() <= LIMIT, "JAVA_UTF8_ARGUMENTS_INVALID");
        let payload: Payload =
            serde_json::from_slice(&bytes).context("JAVA_UTF8_ARGUMENTS_INVALID")?;
        let _cache_owner = payload
            .cache
            .as_ref()
            .map(|path| {
                anyhow::ensure!(
                    path.file_name()
                        .is_some_and(|name| name.to_string_lossy().starts_with("java-utf8-jdk8-")),
                    "JAVA_UTF8_CACHE_INVALID"
                );
                let owner = cache_owner(path)?;
                owner.lock_shared()?;
                Ok::<_, anyhow::Error>(owner)
            })
            .transpose()?;
        anyhow::ensure!(
            payload.program.is_absolute()
                && payload.program.is_file()
                && payload.program.file_name().is_some_and(|name| name
                    .to_str()
                    .is_some_and(|name| name.eq_ignore_ascii_case("java.exe")))
                && payload.arguments.len() <= 256
                && payload
                    .arguments
                    .iter()
                    .all(|argument| argument.len() <= 32768 && !argument.contains('\0')),
            "JAVA_UTF8_ARGUMENTS_INVALID"
        );
        let home = payload
            .program
            .parent()
            .and_then(Path::parent)
            .context("JAVA_UTF8_JDK_INVALID")?;
        let library_path = [home.join("bin/jli.dll"), home.join("jre/bin/jli.dll")]
            .into_iter()
            .find(|path| path.is_file())
            .context("JAVA_UTF8_JDK_INVALID")?;
        let bin = library_path.parent().context("JAVA_UTF8_JDK_INVALID")?;
        let version = version(home)?;
        unsafe {
            anyhow::ensure!(GetACP() == 65001, "JAVA_UTF8_PROCESS_UNSUPPORTED");
            if GetConsoleCP() == 0 && AttachConsole(ATTACH_PARENT_PROCESS) == 0 {
                return Err(std::io::Error::last_os_error()).context("JAVA_UTF8_CONSOLE_FAILED");
            }
            let input = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open("CONIN$")?;
            anyhow::ensure!(
                SetStdHandle(STD_INPUT_HANDLE, input.into_raw_handle()) != 0,
                "JAVA_UTF8_CONSOLE_FAILED"
            );
            anyhow::ensure!(
                SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS) != 0,
                "JAVA_UTF8_JDK_INVALID"
            );
            anyhow::ensure!(
                !AddDllDirectory(wide(bin).as_ptr()).is_null(),
                "JAVA_UTF8_JDK_INVALID"
            );
            let library = LoadLibraryExW(
                wide(&library_path).as_ptr(),
                std::ptr::null_mut(),
                LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
            );
            if library.is_null() {
                return Err(std::io::Error::last_os_error()).context("JAVA_UTF8_JLI_UNSUPPORTED");
            }
            // Keep the selected JDK library loaded for the child process lifetime; the host never loads a JVM.
            // 所选 JDK 动态库保留至子进程退出，宿主进程不加载 JVM。
            let launch: Launch = std::mem::transmute(symbol(library, b"JLI_Launch\0")?);
            let mut values = vec![payload
                .program
                .to_str()
                .context("JAVA_UTF8_JDK_INVALID")?
                .to_owned()];
            values.extend(payload.arguments);
            if let Some(cache) = &payload.cache {
                let agent = cache.join("bin/uterm-java8-encoding-agent.jar");
                let mut embedded = Vec::new();
                std::fs::File::open(&agent)?
                    .take((super::agent::JAR.len() + 1) as u64)
                    .read_to_end(&mut embedded)?;
                anyhow::ensure!(
                    embedded.as_slice() == super::agent::JAR,
                    "JAVA_UTF8_CACHE_INVALID"
                );
                let directory = std::env::current_dir()?;
                let classpath = std::env::var("CLASSPATH").unwrap_or_else(|_| ".".into());
                let options = legacy_options(
                    &values[1..],
                    &text_path(cache)?,
                    &text_path(&directory)?,
                    &text_path(home)?,
                    &classpath,
                )?;
                // Java 8 initializes VM properties before the -D encoding override takes effect.
                // Java 8 在 -D 编码覆盖生效前就初始化 VM 属性。
                values.insert(
                    1,
                    format!("-javaagent:{}={options}", agent_path(&agent, &directory)?),
                );
            }
            let legacy_values: Vec<CString> = values
                .iter()
                .map(|value| CString::new(value.as_str()))
                .collect::<std::result::Result<_, _>>()?;
            let mut argv;
            let argc;
            if payload.cache.is_some() {
                argc = legacy_values.len() as c_int;
                argv = legacy_values
                    .iter()
                    .map(|value| value.as_ptr() as *mut c_char)
                    .collect::<Vec<_>>();
            } else {
                let parse: Parse = std::mem::transmute(symbol(library, b"JLI_CmdToArgs\0")?);
                let count: Count = std::mem::transmute(symbol(library, b"JLI_GetStdArgc\0")?);
                let args: Args = std::mem::transmute(symbol(library, b"JLI_GetStdArgs\0")?);
                let initialize: Init =
                    std::mem::transmute(symbol(library, b"JLI_InitArgProcessing\0")?);
                initialize(0, 0);
                let mut command = quoted_command(&values)?;
                parse(command.as_mut_ptr().cast());
                argc = count();
                anyhow::ensure!(argc > 0 && argc <= 65536, "JAVA_UTF8_ARGUMENTS_INVALID");
                let raw = args();
                anyhow::ensure!(!raw.is_null(), "JAVA_UTF8_ARGUMENTS_INVALID");
                argv = (0..argc as usize)
                    .map(|index| (*raw.add(index)).value)
                    .collect::<Vec<_>>();
            }
            argv.push(std::ptr::null_mut());
            let name = c"java";
            let status = launch(
                argc,
                argv.as_mut_ptr(),
                0,
                std::ptr::null(),
                0,
                std::ptr::null(),
                version.as_ptr(),
                version.as_ptr(),
                name.as_ptr(),
                name.as_ptr(),
                0,
                1,
                0,
                0,
            );
            if status < 0 {
                bail!("JAVA_UTF8_LAUNCH_FAILED");
            }
            Ok(status)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_agent_receives_original_properties_and_launcher_classpath_precedence() {
        let decode = |arguments: &[&str]| {
            let values = arguments
                .iter()
                .map(|value| (*value).into())
                .collect::<Vec<_>>();
            let encoded =
                legacy_options(&values, "cache 中文", "project 😀", "jdk", "default").unwrap();
            let bytes = (0..encoded.len())
                .step_by(2)
                .map(|index| u8::from_str_radix(&encoded[index..index + 2], 16).unwrap())
                .collect();
            String::from_utf8(bytes)
                .unwrap()
                .split('\0')
                .map(str::to_owned)
                .collect::<Vec<_>>()
        };
        let values = decode(&[
            "-Dqa.value=属性 😀=literal",
            "-cp",
            "before",
            "-Djava.class.path=after",
            "-Dempty",
            "Main",
            "-Dapplication-only=kept",
        ]);
        assert_eq!(
            &values[..6],
            [
                "1",
                "cache 中文",
                "project 😀",
                "jdk",
                "after",
                "Main -Dapplication-only=kept"
            ]
        );
        assert_eq!(&values[6..], ["qa.value=属性 😀=literal", "empty="]);
        let jar = decode(&[
            "-Djava.class.path=ignored",
            "-Dsun.java.command=ignored",
            "-jar",
            "中文.jar",
            "",
        ]);
        assert_eq!(jar[4], "中文.jar");
        assert_eq!(jar[5], "中文.jar ");
        assert_eq!(jar.len(), 6);
        assert!(legacy_options(&["-cp".into()], "cache", "dir", "jdk", ".").is_err());
        assert!(legacy_options(
            &["Main".into(), "bad\0value".into()],
            "cache",
            "dir",
            "jdk",
            "."
        )
        .is_err());
    }
    #[cfg(windows)]
    #[test]
    fn jdk8_rejects_unicode_runtime_cache_before_launch_and_reclaims_its_owned_copy() {
        let temporary = tempfile::tempdir().unwrap();
        let home = temporary.path().join("selected-jdk");
        let root = temporary.path().join("应用数据");
        std::fs::create_dir_all(home.join("bin")).unwrap();
        std::fs::create_dir(&root).unwrap();
        std::fs::write(home.join("release"), "JAVA_VERSION=\"1.8.0_504\"\n").unwrap();
        std::fs::write(home.join("bin/java.exe"), b"selected executable").unwrap();
        let step = crate::tasks::Step {
            program: home.join("bin/java.exe"),
            arguments: vec!["-jar".into(), "中文.jar".into()],
            directory: temporary.path().to_owned(),
            environment: Default::default(),
            label: "Java QA".into(),
            windows_java_utf8: true,
            jar_directory: None,
        };
        assert_eq!(
            prepare(&step, &root).err().unwrap().to_string(),
            "JAVA_UTF8_JDK8_CACHE_PATH_UNSUPPORTED"
        );
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        assert_eq!(
            std::fs::read(home.join("bin/java.exe")).unwrap(),
            b"selected executable"
        );
    }
    #[cfg(windows)]
    #[test]
    fn legacy_agent_path_stays_ascii_when_its_parent_directory_contains_unicode() {
        let agent = std::path::Path::new(
            r"\\?\C:\project 中文\local-daemon-v1\java-utf8-jdk8-test\bin\uterm-java8-encoding-agent.jar",
        );
        let directory = std::path::Path::new(r"C:\project 中文\module 😀");
        assert_eq!(
            windows::agent_path(agent, directory).unwrap(),
            r"..\local-daemon-v1\java-utf8-jdk8-test\bin\uterm-java8-encoding-agent.jar"
        );
    }
    #[cfg(windows)]
    #[test]
    fn jdk8_cache_cleanup_respects_live_owners_and_retains_the_selected_jdk() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("selected");
        let host = temporary.path().join("host");
        std::fs::create_dir_all(source.join("bin")).unwrap();
        std::fs::create_dir_all(source.join("jre/lib")).unwrap();
        std::fs::create_dir(&host).unwrap();
        std::fs::write(source.join("bin/java.exe"), b"selected executable").unwrap();
        std::fs::write(source.join("jre/lib/rt.jar"), b"selected runtime").unwrap();
        let cache = windows::cache_jdk8(&host, &source).unwrap();
        let path = cache.directory.path().to_owned();
        windows::cleanup_stale(&host, std::time::Duration::ZERO).unwrap();
        assert!(
            path.join("jre/lib/rt.jar").is_file(),
            "A live cache must not be removed"
        );
        let Cache {
            _ownership,
            directory,
        } = cache;
        let retained = directory.keep();
        drop(_ownership);
        windows::cleanup_stale(&host, std::time::Duration::ZERO).unwrap();
        assert!(
            !retained.exists(),
            "A released orphan cache must be reclaimed"
        );
        assert_eq!(
            std::fs::read(source.join("jre/lib/rt.jar")).unwrap(),
            b"selected runtime"
        );
        assert_eq!(
            std::fs::read(source.join("bin/java.exe")).unwrap(),
            b"selected executable"
        );
    }
    #[cfg(windows)]
    #[test]
    fn oversized_jdk8_directory_depth_fails_without_retaining_partial_cache() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("selected");
        let host = temporary.path().join("host");
        let mut deepest = source.clone();
        for _ in 0..34 {
            deepest.push("d");
        }
        std::fs::create_dir_all(deepest).unwrap();
        std::fs::create_dir(&host).unwrap();
        assert!(windows::cache_jdk8(&host, &source).is_err());
        assert_eq!(std::fs::read_dir(&host).unwrap().count(), 0);
        assert!(source.is_dir());
    }
    #[test]
    fn quoted_values_preserve_empty_unicode_quotes_and_trailing_slashes() {
        let bytes = quoted_command(&[
            "java".into(),
            "".into(),
            "中文 😀 & %PATH% *.txt".into(),
            "q\"uote".into(),
            "path\\".into(),
        ])
        .unwrap();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            "\"java\" \"\" \"中文 😀 & %PATH% *.txt\" \"q\\\"uote\" \"path\\\\\"\0"
        );
        assert!(quoted_command(&["bad\0arg".into()]).is_err());
    }
}
