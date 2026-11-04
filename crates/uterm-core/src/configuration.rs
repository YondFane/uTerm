use anyhow::{bail, Context, Result};
use std::{fs, path::Path};

pub(crate) struct ConfigurationWriter(fs::File);
impl Drop for ConfigurationWriter {
    fn drop(&mut self) {
        loop {
            match self.0.unlock() {
                Ok(()) => break,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => {
                    eprintln!("Configuration writer unlock: {error}");
                    break;
                }
            }
        }
    }
}
impl ConfigurationWriter {
    pub(crate) fn acquire(path: &Path, busy: &str, save: &str) -> Result<Self> {
        let parent = path.parent().context(save.to_owned())?;
        fs::create_dir_all(parent)?;
        let file = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(parent.join("writer.lock"))?;
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(ConfigurationWriter(file)),
                Err(fs::TryLockError::Error(error))
                    if error.kind() == std::io::ErrorKind::Interrupted =>
                {
                    continue
                }
                Err(fs::TryLockError::WouldBlock) => bail!("{busy}"),
                Err(fs::TryLockError::Error(error)) => return Err(error.into()),
            }
        }
    }
}
