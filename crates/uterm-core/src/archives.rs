use anyhow::{bail, Context, Result};
use std::{
    fs,
    io::{Read, Seek},
    path::{Component, Path},
};

pub fn safe_entry(path: &Path) -> bool {
    !path.is_absolute()
        && path
            .components()
            .all(|part| matches!(part, Component::Normal(_) | Component::CurDir))
        && !path.to_string_lossy().contains(['\\', ':'])
}
pub fn extract_bounded(
    source: impl Read + Seek,
    name: &str,
    destination: &Path,
    limit: u64,
    links: bool,
) -> Result<()> {
    let mut total = 0u64;
    if name.ends_with(".zip") {
        let mut archive = zip::ZipArchive::new(source)?;
        if archive.len() > 20000 {
            bail!("DB_COMPONENT_HASH");
        }
        for index in 0..archive.len() {
            let mut file = archive.by_index(index)?;
            let path = file.enclosed_name().context("DB_COMPONENT_HASH")?;
            if !safe_entry(&path) || file.is_symlink() {
                bail!("DB_COMPONENT_HASH");
            }
            total = total
                .checked_add(file.size())
                .context("DB_COMPONENT_HASH")?;
            if total > limit {
                bail!("DB_COMPONENT_HASH");
            }
            let path = destination.join(path);
            if file.is_dir() {
                fs::create_dir_all(path)?;
            } else {
                fs::create_dir_all(path.parent().context("DB_COMPONENT_HASH")?)?;
                std::io::copy(&mut file, &mut fs::File::create(path)?)?;
            }
        }
    } else {
        let decoder = flate2::read::GzDecoder::new(source);
        let mut archive = tar::Archive::new(decoder);
        let mut pending_links = Vec::new();
        for (index, entry) in archive.entries()?.enumerate() {
            if index >= 20000 {
                bail!("DB_COMPONENT_HASH");
            }
            let mut entry = entry?;
            if !safe_entry(&entry.path()?) {
                bail!("DB_COMPONENT_HASH");
            }
            let kind = entry.header().entry_type();
            // Java archives may contain links; resolve allowed targets only after unpacking files.
            // Java 归档可能包含链接，仅在解压普通文件后解析允许的目标。
            if kind.is_symlink() || kind.is_hard_link() {
                if links {
                    pending_links.push((
                        entry.path()?.into_owned(),
                        entry
                            .link_name()?
                            .context("DB_COMPONENT_HASH")?
                            .into_owned(),
                        kind.is_hard_link(),
                    ));
                }
                continue;
            }
            if !kind.is_file() && !kind.is_dir() {
                bail!("DB_COMPONENT_HASH");
            }
            total = total
                .checked_add(entry.size())
                .context("DB_COMPONENT_HASH")?;
            if total > limit || !entry.unpack_in(destination)? {
                bail!("DB_COMPONENT_HASH");
            }
        }
        let mut pending_links: std::collections::VecDeque<_> = pending_links.into();
        let mut unresolved = 0;
        let canonical_destination = destination.canonicalize()?;
        while let Some((path, target, hard)) = pending_links.pop_front() {
            if target.is_absolute() {
                bail!("DB_COMPONENT_HASH");
            }
            let link = destination.join(path);
            // Relative targets containing .. require an existing parent directory on Unix.
            // Unix 解析含 .. 的相对目标时，要求链接的父目录已存在。
            let parent = link.parent().context("DB_COMPONENT_HASH")?;
            fs::create_dir_all(parent)?;
            if !parent.canonicalize()?.starts_with(&canonical_destination) {
                bail!("DB_COMPONENT_HASH");
            }
            let base = if hard { destination } else { parent };
            let resolved = match base.join(&target).canonicalize() {
                Ok(path) => path,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    pending_links.push_back((link.strip_prefix(destination)?.into(), target, hard));
                    unresolved += 1;
                    if unresolved >= pending_links.len() {
                        bail!("DB_COMPONENT_HASH");
                    }
                    continue;
                }
                Err(error) => return Err(error).context("DB_COMPONENT_HASH"),
            };
            unresolved = 0;
            if !resolved.starts_with(&canonical_destination) {
                bail!("DB_COMPONENT_HASH");
            }
            if resolved.is_file() {
                total = total
                    .checked_add(resolved.metadata()?.len())
                    .context("DB_COMPONENT_HASH")?;
                if total > limit {
                    bail!("DB_COMPONENT_HASH");
                }
                fs::copy(resolved, link)?;
            } else {
                #[cfg(unix)]
                std::os::unix::fs::symlink(target, link)?;
                #[cfg(not(unix))]
                bail!("DB_COMPONENT_HASH");
            }
        }
    }
    Ok(())
}
