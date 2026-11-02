mod server;
pub use server::{Control, Request};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    path::PathBuf,
    time::Duration,
};
pub const LIMIT: u64 = 128 * 1024;
#[derive(Clone, Serialize, Deserialize)]
pub struct Endpoint {
    pub version: u8,
    pub port: u16,
    pub token: String,
}
pub fn read_message(stream: &mut TcpStream) -> Result<Value, String> {
    let mut bytes = Vec::new();
    BufReader::new(stream.take(LIMIT + 1))
        .read_until(b'\n', &mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > LIMIT || bytes.last() != Some(&b'\n') {
        return Err("Invalid or oversized control message".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
pub fn write_message(stream: &mut TcpStream, value: &Value) -> Result<(), String> {
    serde_json::to_writer(&mut *stream, value).map_err(|e| e.to_string())?;
    stream.write_all(b"\n").map_err(|e| e.to_string())
}
pub fn valid_link(value: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "会话链接无效。")?;
    if !["uterm", "uterm"].contains(&url.scheme())
        || url.host_str() != Some("session")
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err("会话链接无效。".into());
    }
    let id = url.path().strip_prefix('/').ok_or("会话链接无效。")?;
    if uuid::Uuid::parse_str(id).is_err() || id.len() != 36 {
        return Err("会话链接无效。".into());
    }
    Ok(id.into())
}
pub fn cli(mut args: Vec<String>) -> Result<Value, String> {
    if args.is_empty()
        || args == ["--help"]
        || (args.len() == 3 && args[0] == "--data-dir" && args[2] == "--help")
    {
        return Ok(
            json!({"usage":"uterm [--data-dir PATH] status | projects list | sessions list | sessions new DIRECTORY [AGENT] | sessions focus ID | sessions send ID TEXT [--enter] | sessions close ID | open URL","note":"Enable local control in Settings. The desktop app must be running. Send writes exactly the supplied text; --enter adds a carriage return."}),
        );
    }
    let directory = if args.first().is_some_and(|a| a == "--data-dir") {
        if args.len() < 3 {
            return Err("Missing data directory or command".into());
        }
        let path = PathBuf::from(args.remove(1));
        args.remove(0);
        path
    } else if let Some(path) = std::env::var_os("UTERM_DESKTOP_DATA") {
        path.into()
    } else {
        #[cfg(target_os = "macos")]
        let base = PathBuf::from(std::env::var_os("HOME").ok_or("Missing HOME")?)
            .join("Library/Application Support");
        #[cfg(windows)]
        let base = PathBuf::from(std::env::var_os("APPDATA").ok_or("Missing APPDATA")?);
        #[cfg(not(any(windows, target_os = "macos")))]
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/share")
            });
        base.join("sh.uterm.desktop.dev")
    };
    let (method, params) = parse_arguments(&args)?;
    let endpoint: Endpoint = serde_json::from_slice(
        &std::fs::read(directory.join("control-v1/endpoint.json")).map_err(|_| {
            "Local control endpoint not found; start the app and enable local control"
        })?,
    )
    .map_err(|e| e.to_string())?;
    if endpoint.version != 1 {
        return Err("Unsupported control protocol".into());
    }
    let mut stream = TcpStream::connect_timeout(
        &([127, 0, 0, 1], endpoint.port).into(),
        Duration::from_secs(2),
    )
    .map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(17)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    write_message(
        &mut stream,
        &json!({"version":1,"token":endpoint.token,"method":method,"params":params}),
    )?;
    let reply = read_message(&mut stream)?;
    if let Some(error) = reply["error"].as_str() {
        Err(error.into())
    } else {
        Ok(reply["result"].clone())
    }
}
pub fn parse_arguments(args: &[String]) -> Result<(&str, Value), String> {
    let values: Vec<&str> = args.iter().map(String::as_str).collect();
    match values.as_slice() {
        ["status"] => Ok(("status", json!({}))),
        ["projects", "list"] => Ok(("projects.list", json!({}))),
        ["sessions", "list"] => Ok(("sessions.list", json!({}))),
        ["sessions", "new", path] => Ok(("sessions.new", json!({"directory":path}))),
        ["sessions", "new", path, agent] => {
            Ok(("sessions.new", json!({"directory":path,"agent":agent})))
        }
        ["sessions", "focus", id] => Ok(("sessions.focus", json!({"id":id}))),
        ["sessions", "close", id] => Ok(("sessions.close", json!({"id":id}))),
        ["sessions", "send", id, text] => Ok(("sessions.send", json!({"id":id,"text":text}))),
        ["sessions", "send", id, text, "--enter"] => {
            Ok(("sessions.send", json!({"id":id,"text":format!("{text}\r")})))
        }
        ["open", url] => {
            valid_link(url)?;
            Ok(("open", json!({"url":url})))
        }
        _ => Err("Invalid arguments; use --help".into()),
    }
}
