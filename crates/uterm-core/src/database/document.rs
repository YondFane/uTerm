use super::Config;
use reqwest::{header, Client, Method, Url};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::io::AsyncReadExt;

pub(super) struct Elasticsearch {
    client: Client,
    base: Url,
}

pub(super) fn validate(request: &Value, writable: bool) -> Result<(), String> {
    let action = request["action"].as_str().ok_or("DB_INVALID_REQUEST")?;
    if request["op"] != "document"
        || ![
            "databases",
            "collections",
            "query",
            "mapping",
            "writable",
            "insert",
            "replace",
            "delete",
        ]
        .contains(&action)
    {
        return Err("DB_INVALID_REQUEST".into());
    }
    if ["insert", "replace", "delete"].contains(&action)
        && (!writable || request["confirmed"] != true)
    {
        return Err("DB_DOCUMENT_READ_ONLY".into());
    }
    if action == "writable" && !request["enabled"].is_boolean() {
        return Err("DB_INVALID_REQUEST".into());
    }
    if action == "query"
        && request
            .get("offset")
            .is_some_and(|offset| offset.as_u64().is_none_or(|offset| offset > 9950))
    {
        return Err("DB_INPUT_LIMIT".into());
    }
    if serde_json::to_vec(request)
        .map_err(|_| "DB_INVALID_REQUEST")?
        .len()
        > 1048576
    {
        return Err("DB_INPUT_LIMIT".into());
    }
    for field in ["query", "document", "original", "identity"] {
        if request
            .get(field)
            .is_some_and(|value| value.as_str().is_none_or(|text| text.len() > 262144))
        {
            return Err("DB_INPUT_LIMIT".into());
        }
    }
    Ok(())
}

impl Elasticsearch {
    pub(super) async fn new(
        config: &Config,
        password: &str,
        proxy_port: u16,
        token: &str,
    ) -> Result<Self, String> {
        use base64::Engine;
        let host = if config.host.contains(':') {
            format!("[{}]", config.host)
        } else {
            config.host.clone()
        };
        let base = Url::parse(&format!(
            "{}://{}:{}/",
            if config.tls { "https" } else { "http" },
            host,
            config.port
        ))
        .map_err(|_| "DB_INVALID_CONFIG")?;
        let mut headers = header::HeaderMap::new();
        let authorization = if config.auth_mode.as_deref() == Some("api_key") {
            if password.is_empty() {
                return Err("DB_HTTP_AUTH".into());
            }
            Some(format!("ApiKey {password}"))
        } else if !config.username.is_empty() || !password.is_empty() {
            Some(format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD
                    .encode(format!("{}:{password}", config.username))
            ))
        } else {
            None
        };
        if let Some(value) = authorization {
            let mut value =
                header::HeaderValue::from_str(&value).map_err(|_| "DB_INVALID_CONFIG")?;
            value.set_sensitive(true);
            headers.insert(header::AUTHORIZATION, value);
        }
        let mut builder = Client::builder()
            .no_proxy()
            .default_headers(headers)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(12))
            .timeout(Duration::from_secs(35));
        if proxy_port > 0 {
            builder = builder.proxy(
                reqwest::Proxy::all(format!("socks5h://127.0.0.1:{proxy_port}"))
                    .map_err(|_| "DB_TUNNEL")?
                    .basic_auth("uterm", token),
            );
        }
        if config.tls && !config.ca_file.is_empty() {
            let mut bytes = Vec::new();
            tokio::fs::File::open(&config.ca_file)
                .await
                .map_err(|_| "DB_CA_FAILED")?
                .take(1048577)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| "DB_CA_FAILED")?;
            if bytes.len() > 1048576 {
                return Err("DB_CA_FAILED".into());
            }
            let certificates =
                reqwest::Certificate::from_pem_bundle(&bytes).map_err(|_| "DB_CA_FAILED")?;
            if certificates.is_empty() {
                return Err("DB_CA_FAILED".into());
            }
            for certificate in certificates {
                builder = builder.add_root_certificate(certificate);
            }
        }
        Ok(Self {
            client: builder.build().map_err(|_| "DB_OPERATION_FAILED")?,
            base,
        })
    }

    async fn http(
        &self,
        method: Method,
        segments: &[&str],
        body: Option<Value>,
        parameters: &[(&str, String)],
    ) -> Result<Value, String> {
        let mut url = self.base.clone();
        if !segments.is_empty() {
            let mut path = url.path_segments_mut().map_err(|_| "DB_INVALID_REQUEST")?;
            path.clear();
            for segment in segments {
                path.push(segment);
            }
        }
        let mut request = self.client.request(method, url).query(parameters);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let mut response = request.send().await.map_err(|error| {
            if error.is_timeout() {
                "DB_TIMEOUT"
            } else {
                "DB_DISCONNECTED"
            }
        })?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(match status {
                401 | 403 => "DB_HTTP_AUTH",
                409 => "DB_DOCUMENT_CONFLICT",
                _ => "DB_HTTP_STATUS",
            }
            .into());
        }
        if response
            .content_length()
            .is_some_and(|size| size > 8 * 1024 * 1024)
        {
            return Err("DB_REPLY_LIMIT".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "DB_DISCONNECTED")? {
            if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
                return Err("DB_REPLY_LIMIT".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| "DB_HTTP_STATUS".into())
    }

    pub(super) async fn connect(&self) -> Result<Value, String> {
        let value = self.http(Method::GET, &[], None, &[]).await?;
        Ok(
            json!({"version": value["version"]["number"].as_str().unwrap_or("Elasticsearch"), "protocol": 1}),
        )
    }

    pub(super) async fn send(&self, request: &Value) -> Result<Value, String> {
        let action = request["action"].as_str().ok_or("DB_INVALID_REQUEST")?;
        if action == "writable" {
            return Ok(json!({"writable": request["enabled"] == true}));
        }
        if action == "collections" {
            let value = self
                .http(
                    Method::GET,
                    &["_resolve", "index", "*"],
                    None,
                    &[("expand_wildcards", "open".into())],
                )
                .await?;
            let names: Vec<_> = value["indices"]
                .as_array()
                .ok_or("DB_HTTP_STATUS")?
                .iter()
                .take(500)
                .filter_map(|item| item["name"].as_str())
                .collect();
            return Ok(json!({"names": names}));
        }
        let index = target(request["collection"].as_str().unwrap_or(""))?;
        match action {
            "mapping" => {
                let value = self
                    .http(Method::GET, &[index, "_mapping"], None, &[])
                    .await?;
                let metadata =
                    serde_json::to_string_pretty(&value).map_err(|_| "DB_REPLY_LIMIT")?;
                if metadata.len() > 1048576 {
                    return Err("DB_REPLY_LIMIT".into());
                }
                Ok(json!({"metadata": metadata}))
            }
            "query" => {
                let mut body = query(request["query"].as_str().unwrap_or(""))?;
                let offset = request
                    .get("offset")
                    .map(|value| value.as_u64().ok_or("DB_INPUT_LIMIT"))
                    .transpose()?
                    .unwrap_or(0);
                if offset > 9950 {
                    return Err("DB_INPUT_LIMIT".into());
                }
                let complete = body.get("_source").is_none_or(|value| value == true);
                body["from"] = offset.into();
                body["size"] = if offset < 9950 { 51 } else { 50 }.into();
                body["timeout"] = "30s".into();
                body["seq_no_primary_term"] = true.into();
                let mut response = self
                    .http(Method::POST, &[index, "_search"], Some(body), &[])
                    .await?;
                let hits = response["hits"]["hits"].take();
                let hits = hits.as_array().ok_or("DB_HTTP_STATUS")?;
                let mut budget = 0;
                let mut documents = Vec::new();
                for hit in hits.iter().take(50) {
                    let source = hit.get("_source");
                    let value = serde_json::to_string_pretty(source.unwrap_or(hit))
                        .map_err(|_| "DB_REPLY_LIMIT")?;
                    budget += value.len();
                    if value.len() > 262144 || budget > 1048576 {
                        return Err("DB_REPLY_LIMIT".into());
                    }
                    documents.push(json!({"value": value,
                        "identity": if complete && source.is_some() { hit["_id"].as_str().unwrap_or("") } else { "" },
                        "version": json!([hit["_seq_no"], hit["_primary_term"]]).to_string()}));
                }
                let metadata =
                    serde_json::to_string_pretty(&response).map_err(|_| "DB_REPLY_LIMIT")?;
                if metadata.len() + budget > 2 * 1048576 {
                    return Err("DB_REPLY_LIMIT".into());
                }
                Ok(
                    json!({"documents": documents, "more": hits.len() > 50 && offset < 9950, "metadata": metadata}),
                )
            }
            "insert" | "replace" | "delete" => {
                let body = if action == "delete" {
                    None
                } else {
                    Some(document(request["document"].as_str().unwrap_or(""))?)
                };
                let mut parameters = vec![("refresh", "wait_for".into())];
                if action == "insert" {
                    self.http(Method::POST, &[index, "_doc"], body, &parameters)
                        .await?;
                } else {
                    let id = request["identity"]
                        .as_str()
                        .filter(|id| !id.is_empty() && id.len() <= 2048)
                        .ok_or("DB_DOCUMENT_TARGET")?;
                    let version: Value =
                        serde_json::from_str(request["version"].as_str().unwrap_or(""))
                            .map_err(|_| "DB_DOCUMENT_CONFLICT")?;
                    let version = version
                        .as_array()
                        .filter(|items| items.len() == 2)
                        .ok_or("DB_DOCUMENT_CONFLICT")?;
                    let sequence = version[0].as_u64().ok_or("DB_DOCUMENT_CONFLICT")?;
                    let term = version[1].as_u64().ok_or("DB_DOCUMENT_CONFLICT")?;
                    parameters.extend([
                        ("if_seq_no", sequence.to_string()),
                        ("if_primary_term", term.to_string()),
                    ]);
                    self.http(
                        if action == "delete" {
                            Method::DELETE
                        } else {
                            Method::PUT
                        },
                        &[index, "_doc", id],
                        body,
                        &parameters,
                    )
                    .await?;
                }
                Ok(json!({"affected": 1}))
            }
            _ => Err("DB_INVALID_REQUEST".into()),
        }
    }
}

fn target(value: &str) -> Result<&str, String> {
    if value.is_empty()
        || value.len() > 255
        || value == "."
        || value == ".."
        || value
            .chars()
            .any(|c| c.is_control() || "/\\*?,#%".contains(c))
    {
        return Err("DB_DOCUMENT_TARGET".into());
    }
    Ok(value)
}
fn document(text: &str) -> Result<Value, String> {
    if text.len() > 262144 {
        return Err("DB_INPUT_LIMIT".into());
    }
    let value: Value = serde_json::from_str(text).map_err(|_| "DB_DOCUMENT_QUERY")?;
    if !value.is_object() {
        return Err("DB_DOCUMENT_QUERY".into());
    }
    Ok(value)
}
fn query(text: &str) -> Result<Value, String> {
    let body = document(text)?;
    let allowed = [
        "query",
        "sort",
        "aggs",
        "aggregations",
        "_source",
        "fields",
        "stored_fields",
        "track_total_hits",
        "min_score",
        "post_filter",
        "highlight",
    ];
    if body
        .as_object()
        .unwrap()
        .keys()
        .any(|key| !allowed.contains(&key.as_str()))
    {
        return Err("DB_DOCUMENT_QUERY".into());
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn document_commands_require_editing_confirmation_and_bounded_inputs() {
        let mut request =
            json!({"op":"document", "action":"replace", "document":"{}", "confirmed":true});
        assert_eq!(
            validate(&request, false).unwrap_err(),
            "DB_DOCUMENT_READ_ONLY"
        );
        request["confirmed"] = false.into();
        assert!(validate(&request, true).is_err());
        request["confirmed"] = true.into();
        assert!(validate(&request, true).is_ok());
        request["document"] = "x".repeat(262145).into();
        assert_eq!(validate(&request, true).unwrap_err(), "DB_INPUT_LIMIT");
        for offset in [json!(-1), json!(1.5), json!(9951)] {
            assert!(validate(
                &json!({"op":"document", "action":"query", "query":"{}", "offset":offset}),
                false
            )
            .is_err());
        }
        assert!(validate(&json!({"op":"query", "action":"query"}), false).is_err());
    }
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    async fn fixture(status: u16, body: &str) -> (Elasticsearch, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let body = body.to_owned();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = vec![0; 65536];
            let mut length = 0;
            loop {
                length += stream.read(&mut bytes[length..]).await.unwrap();
                if let Some(end) = bytes[..length]
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                {
                    let header = String::from_utf8_lossy(&bytes[..end]);
                    let size = header
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if length >= end + 4 + size {
                        break;
                    }
                }
            }
            let response = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            stream.write_all(response.as_bytes()).await.unwrap();
            String::from_utf8(bytes[..length].to_vec()).unwrap()
        });
        (
            Elasticsearch {
                client: Client::builder().no_proxy().build().unwrap(),
                base,
            },
            task,
        )
    }

    #[tokio::test]
    async fn search_bounds_pages_preserves_numbers_and_protects_projected_sources() {
        let body = r#"{"hits":{"hits":[{"_id":"a/b","_seq_no":3,"_primary_term":1,"_source":{"n":123456789012345678901234567890}}]}}"#;
        let (client, received) = fixture(200, body).await;
        let result = client
            .send(&json!({"action":"query","collection":"qa","query":"{}","offset":9950}))
            .await
            .unwrap();
        assert!(result["documents"][0]["value"]
            .as_str()
            .unwrap()
            .contains("123456789012345678901234567890"));
        let request = received.await.unwrap();
        assert!(request.starts_with("POST /qa/_search"));
        let payload: Value =
            serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(payload["size"], 50);
        assert_eq!(payload["from"], 9950);
        assert_eq!(payload["seq_no_primary_term"], true);
        let (client, received) = fixture(200, body).await;
        let result = client
            .send(&json!({"action":"query","collection":"qa","query":r#"{"_source":["n"]}"#}))
            .await
            .unwrap();
        assert_eq!(result["documents"][0]["identity"], "");
        received.await.unwrap();
    }

    #[tokio::test]
    async fn writes_encode_ids_and_use_server_versions_without_echoing_errors() {
        let (client, received) = fixture(409, r#"{"error":"secret document and token"}"#).await;
        assert_eq!(client.send(&json!({"action":"replace","collection":"qa","identity":"a/b?c","version":"[3,1]","document":"{}"})).await.unwrap_err(), "DB_DOCUMENT_CONFLICT");
        let request = received.await.unwrap();
        assert!(request.starts_with("PUT /qa/_doc/a%2Fb%3Fc?"));
        assert!(request.contains("if_seq_no=3") && request.contains("if_primary_term=1"));
        let (client, received) = fixture(401, "sensitive").await;
        assert_eq!(client.connect().await.unwrap_err(), "DB_HTTP_AUTH");
        received.await.unwrap();
    }
    #[test]
    fn requests_keep_exact_numbers_and_reject_unbounded_pagination_or_paths() {
        let body = query(r#"{"query":{"term":{"value":123456789012345678901234567890}}}"#).unwrap();
        assert!(body.to_string().contains("123456789012345678901234567890"));
        for input in [
            r#"{"size":1000000}"#,
            r#"{"search_after":[]}"#,
            "[]",
            "null",
        ] {
            assert!(query(input).is_err());
        }
        for index in ["", ".", "..", "a/b", "*", "a,b", "a%2fb"] {
            assert!(target(index).is_err());
        }
        assert_eq!(target("logs-2026.10").unwrap(), "logs-2026.10");
    }
}
