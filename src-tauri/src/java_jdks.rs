use super::{path_text, valid_text, JavaHome, CONFIG_LOCK, SUPPORTED_JAVA_VERSIONS};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::Path};

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Registry {
    version: u32,
    homes: Vec<Entry>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Entry {
    pub home: String,
    pub version: u32,
}
pub(super) fn key(home: &str) -> String {
    if cfg!(windows) {
        home.to_lowercase()
    } else {
        home.into()
    }
}
pub(super) fn read(path: &Path) -> Result<Vec<Entry>> {
    if !path.try_exists()? {
        return Ok(vec![]);
    }
    if fs::metadata(path)?.len() > 512 * 1024 {
        bail!("JAVA_JDK_REGISTRY_INVALID");
    }
    let registry: Registry =
        serde_json::from_slice(&fs::read(path)?).context("JAVA_JDK_REGISTRY_INVALID")?;
    if registry.version != 1
        || registry.homes.len() > 64
        || registry.homes.iter().any(|entry| {
            !valid_text(&entry.home)
                || !Path::new(&entry.home).is_absolute()
                || !SUPPORTED_JAVA_VERSIONS.contains(&entry.version)
        })
    {
        bail!("JAVA_JDK_REGISTRY_INVALID");
    }
    Ok(registry.homes)
}
pub(super) fn update(path: &Path, home: &str, jdk: Option<&JavaHome>) -> Result<()> {
    let _guard = CONFIG_LOCK
        .lock()
        .map_err(|_| anyhow::anyhow!("JAVA_CONFIG_SAVE"))?;
    let mut homes = read(path)?;
    homes.retain(|entry| key(&entry.home) != key(home));
    if let Some(jdk) = jdk {
        if homes.len() >= 64 {
            bail!("JAVA_JDK_LIMIT");
        }
        homes.push(Entry {
            home: jdk.home.clone(),
            version: jdk.version,
        });
    }
    let parent = path.parent().context("JAVA_CONFIG_SAVE")?;
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(&serde_json::to_vec_pretty(&Registry { version: 1, homes })?)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(path)
        .map_err(|_| anyhow::anyhow!("JAVA_CONFIG_SAVE"))?;
    Ok(())
}
pub(super) fn stored(entry: Entry) -> JavaHome {
    JavaHome {
        home: path_text(Path::new(&entry.home)),
        version: entry.version,
        registered: true,
        available: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registry_persists_deduplicates_and_removes_only_records() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("jdks.json");
        let home = folder.path().join("JDK 中文");
        fs::create_dir(&home).unwrap();
        let jdk = JavaHome {
            home: path_text(&home),
            version: 21,
            registered: false,
            available: true,
        };
        assert!(read(&path).unwrap().is_empty());
        update(&path, &jdk.home, Some(&jdk)).unwrap();
        update(&path, &jdk.home, Some(&jdk)).unwrap();
        assert_eq!(read(&path).unwrap().len(), 1);
        let configuration = folder.path().join("configuration.json");
        fs::write(&configuration, b"untouched").unwrap();
        update(&path, &jdk.home, None).unwrap();
        assert!(read(&path).unwrap().is_empty());
        assert!(home.is_dir());
        assert_eq!(fs::read(configuration).unwrap(), b"untouched");
    }
    #[test]
    fn invalid_registry_is_preserved() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("jdks.json");
        for bytes in [b"broken".as_slice(), br#"{"version":2,"homes":[]}"#] {
            fs::write(&path, bytes).unwrap();
            assert!(update(&path, "unused", None).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
    }
}
