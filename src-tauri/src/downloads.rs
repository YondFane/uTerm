use anyhow::{bail, Context, Result};
use reqwest::{header, StatusCode};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

pub const LIMIT: u64 = 512 * 1024 * 1024;
pub const ATTEMPTS: usize = 3;

pub fn network_error(error: reqwest::Error) -> anyhow::Error {
    classify_network(&format!("{error:?}"), error.is_timeout())
}

pub fn classify_network(detail: &str, timeout: bool) -> anyhow::Error {
    let detail = detail.to_ascii_lowercase();
    let code = if detail.contains("certificate") || detail.contains("invalid peer") {
        "DOWNLOAD_TLS"
    } else if timeout {
        "DOWNLOAD_TIMEOUT"
    } else {
        "DOWNLOAD_NETWORK"
    };
    anyhow::anyhow!(code)
}

pub fn retryable(error: &anyhow::Error) -> bool {
    matches!(
        error.to_string().as_str(),
        "DOWNLOAD_TIMEOUT" | "DOWNLOAD_NETWORK" | "DOWNLOAD_SERVER" | "DOWNLOAD_RATE_LIMIT"
    )
}

pub async fn delay(attempt: usize, cancel: &AtomicBool) -> Result<()> {
    wait(Duration::from_secs(1 << attempt.min(3)), cancel).await
}

async fn wait(duration: Duration, cancel: &AtomicBool) -> Result<()> {
    tokio::select! {
        _ = cancelled(cancel) => bail!("DOWNLOAD_CANCELLED"),
        _ = tokio::time::sleep(duration) => Ok(()),
    }
}

async fn cancelled(cancel: &AtomicBool) {
    loop {
        if cancel.load(Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[derive(Default, Serialize, Deserialize)]
struct Metadata {
    total: Option<u64>,
    etag: Option<String>,
    complete: bool,
}

pub fn cache_path(directory: &Path, key: &str) -> PathBuf {
    directory.join(format!("{key}.part"))
}

pub async fn discard(directory: &Path, key: &str) {
    for path in [
        cache_path(directory, key),
        directory.join(format!("{key}.json")),
    ] {
        let _ = tokio::fs::remove_file(path).await;
    }
}

pub async fn prune(directory: &Path, keep: &Path) -> Result<()> {
    tokio::fs::create_dir_all(directory)
        .await
        .context("DOWNLOAD_STORAGE")?;
    let mut entries = tokio::fs::read_dir(directory)
        .await
        .context("DOWNLOAD_STORAGE")?;
    let mut files = Vec::new();
    while let Some(entry) = entries.next_entry().await.context("DOWNLOAD_STORAGE")? {
        let path = entry.path();
        if path == keep || path.extension().and_then(|value| value.to_str()) != Some("part") {
            continue;
        }
        let metadata = entry.metadata().await.context("DOWNLOAD_STORAGE")?;
        if metadata.is_file() {
            files.push((
                metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
                path,
                metadata.len(),
            ));
        }
    }
    files.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    let mut size = tokio::fs::metadata(keep)
        .await
        .map(|value| value.len())
        .unwrap_or(0);
    let mut retained = 0;
    for (modified, path, length) in files {
        if retained >= 3
            || size.saturating_add(length) > LIMIT
            || modified.elapsed().unwrap_or_default() > Duration::from_secs(7 * 86400)
        {
            tokio::fs::remove_file(&path)
                .await
                .context("DOWNLOAD_STORAGE")?;
            let _ = tokio::fs::remove_file(path.with_extension("json")).await;
        } else {
            retained += 1;
            size += length;
        }
    }
    Ok(())
}

pub async fn fetch(
    directory: &Path,
    key: &str,
    url: &str,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<PathBuf> {
    let path = cache_path(directory, key);
    prune(directory, &path).await?;
    let metadata_path = path.with_extension("json");
    let mut metadata: Metadata = tokio::fs::read(&metadata_path)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&path)
        .await
        .context("DOWNLOAD_STORAGE")?;
    let mut received = file.metadata().await.context("DOWNLOAD_STORAGE")?.len();
    if cancel.load(Ordering::SeqCst) {
        bail!("DOWNLOAD_CANCELLED");
    }
    if received > LIMIT || metadata.total.is_some_and(|total| received > total) {
        file.set_len(0).await.context("DOWNLOAD_STORAGE")?;
        received = 0;
        metadata = Metadata::default();
    }
    progress(received, metadata.total);
    if metadata.complete && metadata.total == Some(received) {
        return Ok(path);
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!("uTerm/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(network_error)?;
    let mut last = anyhow::anyhow!("DOWNLOAD_NETWORK");
    for attempt in 0..ATTEMPTS {
        let mut retry_after = None;
        let result: Result<()> = async {
            let mut reset_range = false;
            let (mut response, end) = loop {
                let mut request = client.get(url).header(header::ACCEPT_ENCODING, "identity");
                if received > 0 {
                    request = request.header(header::RANGE, format!("bytes={received}-"));
                    if let Some(etag) = &metadata.etag { request = request.header(header::IF_RANGE, etag); }
                }
                let response = tokio::select! {
                    _ = cancelled(cancel) => bail!("DOWNLOAD_CANCELLED"),
                    response = request.send() => response.map_err(network_error)?,
                };
                let status = response.status();
                if status == StatusCode::TOO_MANY_REQUESTS || status == StatusCode::SERVICE_UNAVAILABLE {
                    retry_after = response.headers().get(header::RETRY_AFTER).and_then(|value| value.to_str().ok()).and_then(|value| {
                        value.parse::<u64>().ok().or_else(|| chrono::DateTime::parse_from_rfc2822(value).ok()
                            .map(|date| (date.timestamp() - chrono::Utc::now().timestamp()).max(0) as u64))
                    });
                    bail!(if status == StatusCode::TOO_MANY_REQUESTS { "DOWNLOAD_RATE_LIMIT" } else { "DOWNLOAD_SERVER" });
                }
                if status == StatusCode::NOT_FOUND { bail!("DOWNLOAD_NOT_FOUND"); }
                if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN { bail!("DOWNLOAD_ACCESS"); }
                if status == StatusCode::REQUEST_TIMEOUT { bail!("DOWNLOAD_TIMEOUT"); }
                if status.is_server_error() { bail!("DOWNLOAD_SERVER"); }
                if status == StatusCode::OK {
                    received = 0;
                    file.set_len(0).await.context("DOWNLOAD_STORAGE")?;
                    metadata.total = response.content_length();
                    break (response, metadata.total);
                }
                if status == StatusCode::PARTIAL_CONTENT {
                    let parsed = response.headers().get(header::CONTENT_RANGE).and_then(|value| value.to_str().ok())
                        .and_then(|value| value.strip_prefix("bytes ")).and_then(|value| value.split_once('/'))
                        .and_then(|(bounds, total)| bounds.split_once('-').and_then(|(start, end)| Some((start.parse::<u64>().ok()?, end.parse::<u64>().ok()?, total.parse::<u64>().ok()?))));
                    if let Some((start, end, total)) = parsed {
                        if start == received && end >= start && end < total && total <= LIMIT
                            && metadata.total.is_none_or(|old| old == total)
                            && metadata.etag.as_ref().is_none_or(|old| response.headers().get(header::ETAG).is_none_or(|new| new.as_bytes() == old.as_bytes())) {
                            metadata.total = Some(total);
                            break (response, Some(end + 1));
                        }
                    }
                }
                if received > 0 && !reset_range && (status == StatusCode::RANGE_NOT_SATISFIABLE || status == StatusCode::PARTIAL_CONTENT) {
                    reset_range = true;
                    received = 0;
                    metadata = Metadata::default();
                    file.set_len(0).await.context("DOWNLOAD_STORAGE")?;
                    continue;
                }
                bail!("DOWNLOAD_RESPONSE");
            };
            if metadata.total.is_some_and(|total| total > LIMIT) { bail!("DOWNLOAD_RESPONSE"); }
            metadata.etag = response.headers().get(header::ETAG).and_then(|value| value.to_str().ok())
                .filter(|value| !value.starts_with("W/")).map(str::to_owned);
            metadata.complete = false;
            tokio::fs::write(&metadata_path, serde_json::to_vec(&metadata)?).await.context("DOWNLOAD_STORAGE")?;
            file.seek(std::io::SeekFrom::Start(received)).await.context("DOWNLOAD_STORAGE")?;
            progress(received, metadata.total);
            let mut reported = std::time::Instant::now();
            loop {
                let chunk = tokio::select! {
                    _ = cancelled(cancel) => bail!("DOWNLOAD_CANCELLED"),
                    response = tokio::time::timeout(Duration::from_secs(30), response.chunk()) => response.context("DOWNLOAD_TIMEOUT")?.map_err(network_error)?,
                };
                let Some(chunk) = chunk else { break; };
                if received.saturating_add(chunk.len() as u64) > end.unwrap_or(LIMIT) { bail!("DOWNLOAD_RESPONSE"); }
                file.write_all(&chunk).await.context("DOWNLOAD_STORAGE")?;
                received += chunk.len() as u64;
                if reported.elapsed() >= Duration::from_millis(100) { progress(received, metadata.total); reported = std::time::Instant::now(); }
            }
            if metadata.total.is_some_and(|total| received != total) { bail!("DOWNLOAD_NETWORK"); }
            metadata.total = Some(received);
            metadata.complete = true;
            Ok(())
        }.await;
        file.flush().await.context("DOWNLOAD_STORAGE")?;
        prune(directory, &path).await?;
        match result {
            Ok(()) => {
                file.sync_all().await.context("DOWNLOAD_STORAGE")?;
                tokio::fs::write(&metadata_path, serde_json::to_vec(&metadata)?)
                    .await
                    .context("DOWNLOAD_STORAGE")?;
                progress(received, Some(received));
                return Ok(path);
            }
            Err(error)
                if retryable(&error)
                    && attempt + 1 < ATTEMPTS
                    && retry_after.is_none_or(|seconds| seconds <= 30) =>
            {
                last = error;
                wait(
                    Duration::from_secs(retry_after.unwrap_or(1 << attempt).max(1)),
                    cancel,
                )
                .await?;
            }
            Err(error) => return Err(error),
        }
    }
    Err(last)
}

#[cfg(test)]
#[path = "downloads_tests.rs"]
mod tests;
