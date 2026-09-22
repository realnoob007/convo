use crate::{credentials, providers};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const DEFAULT_URL: &str = "https://api.openai.com/v1";

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum ApiStyle {
    Responses,
    ChatCompletions,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub base_url: String,
    pub api_style: ApiStyle,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_URL.into(),
            api_style: ApiStyle::Responses,
        }
    }
}
impl Config {
    fn validated(mut self) -> Result<Self, String> {
        let url =
            reqwest::Url::parse(self.base_url.trim()).map_err(|_| "Enter a valid API base URL")?;
        let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if (url.scheme() != "https" && !(url.scheme() == "http" && local))
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(
                "Use HTTPS (or HTTP on localhost), without credentials, query or fragment".into(),
            );
        }
        self.base_url = url.to_string().trim_end_matches('/').to_owned();
        if self.base_url.ends_with("/responses") || self.base_url.ends_with("/chat/completions") {
            return Err(
                "Enter the base URL, e.g. https://api.openai.com/v1, without the endpoint suffix"
                    .into(),
            );
        }
        Ok(self)
    }
    fn local(&self) -> bool {
        self.base_url.starts_with("http://")
    }
}
fn load() -> Result<(Config, String), String> {
    if let Some((config, key)) = credentials::connection()? {
        return Ok((
            serde_json::from_str::<Config>(&config)
                .map_err(|_| "Invalid saved text connection")?
                .validated()?,
            key,
        ));
    }
    Ok((
        Config::default(),
        providers::credential("openai").unwrap_or_default(),
    ))
}
pub fn status() -> Result<Value, String> {
    let (config, key) = load()?;
    Ok(json!({"configured": !key.is_empty() || config.local(), "config":config}))
}
pub fn save(config: Config, key: String) -> Result<Value, String> {
    let config = config.validated()?;
    let (previous, old_key) = load()?;
    let key = if key.trim().is_empty() && config.base_url == previous.base_url {
        old_key
    } else {
        key.trim().to_owned()
    };
    if key.is_empty() && !config.local() {
        return Err(
            "Enter an API key for this endpoint. Keys are not reused across different addresses."
                .into(),
        );
    }
    credentials::save_connection(
        &serde_json::to_string(&config).map_err(|_| "Invalid connection")?,
        &key,
    )?;
    status()
}
fn chat_request(request: &Value) -> Value {
    let format = &request["text"]["format"];
    json!({
        "model":request["model"],
        "messages":[{"role":"system","content":request["instructions"]}, {"role":"user","content":request["input"]}],
        "max_completion_tokens":request["max_output_tokens"],
        "response_format":{"type":"json_schema","json_schema":{"name":format["name"],"strict":true,"schema":format["schema"]}}
    })
}
fn chat_response(body: Value) -> Result<Value, String> {
    let choice = &body["choices"][0];
    if choice["message"]["refusal"]
        .as_str()
        .is_some_and(|s| !s.is_empty())
    {
        return Err("Text provider declined this request".into());
    }
    if choice["finish_reason"] != "stop" {
        return Err(
            "Text provider returned an incomplete response; check model output limits".into(),
        );
    }
    let text = choice["message"]["content"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or("Text provider returned no text")?;
    Ok(json!({"status":"completed","output":[{"content":[{"type":"output_text","text":text}]}]}))
}
pub async fn request(client: &reqwest::Client, request: &Value) -> Result<Value, String> {
    let (config, key) = load()?;
    if key.is_empty() && !config.local() {
        return Err("Configure your text provider in Settings".into());
    }
    send(client, &config, &key, request).await
}
async fn send(
    client: &reqwest::Client,
    config: &Config,
    key: &str,
    request: &Value,
) -> Result<Value, String> {
    let (path, body) = match config.api_style {
        ApiStyle::Responses => ("responses", request.clone()),
        ApiStyle::ChatCompletions => ("chat/completions", chat_request(request)),
    };
    let mut req = client
        .post(format!("{}/{path}", config.base_url))
        .timeout(providers::SCRIPT_TIMEOUT)
        .json(&body);
    if !key.is_empty() {
        req = req.bearer_auth(key);
    }
    let response = req.send().await.map_err(providers::network_error)?;
    let body = providers::checked(response, "Text provider")
        .await?
        .json()
        .await
        .map_err(|_| "Invalid text provider response")?;
    match config.api_style {
        ApiStyle::Responses => Ok(body),
        ApiStyle::ChatCompletions => chat_response(body),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sends_both_protocols_to_configured_path() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        use std::io::{Read, Write};
        for style in [ApiStyle::Responses, ApiStyle::ChatCompletions] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let chat = style == ApiStyle::ChatCompletions;
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut buf = [0; 4096];
                loop {
                    let n = stream.read(&mut buf).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&buf[..n]);
                    if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                        let length: usize = headers
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length: "))
                            .unwrap()
                            .parse()
                            .unwrap();
                        if bytes.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                let raw = String::from_utf8(bytes).unwrap();
                assert!(raw.contains("authorization: Bearer test-key"));
                assert!(raw.starts_with(if chat {
                    "POST /gateway/v1/chat/completions "
                } else {
                    "POST /gateway/v1/responses "
                }));
                let request: Value =
                    serde_json::from_str(raw.split("\r\n\r\n").nth(1).unwrap()).unwrap();
                assert_eq!(request["model"], "custom-model");
                if chat {
                    assert!(request["messages"].is_array());
                } else {
                    assert_eq!(request["input"], "hello");
                }
                let body = if chat { json!({"choices":[{"finish_reason":"stop","message":{"content":"{}"}}]}) } else { json!({"status":"completed","output":[{"content":[{"type":"output_text","text":"{}"}]}]}) }.to_string();
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            });
            let config = Config {
                base_url: format!("http://{address}/gateway/v1"),
                api_style: style,
            };
            let request = json!({"model":"custom-model","input":"hello","instructions":"system","max_output_tokens":100,"text":{"format":{"name":"test","schema":{"type":"object"}}}});
            let response = rt
                .block_on(send(
                    &providers::client().unwrap(),
                    &config,
                    "test-key",
                    &request,
                ))
                .unwrap();
            assert_eq!(providers::response_text(&response).unwrap(), "{}");
            server.join().unwrap();
        }
    }
    #[test]
    fn validates_addresses() {
        for url in [
            "http://remote.example/v1",
            "https://user:pass@example.com/v1",
            "https://example.com/v1?key=secret",
            "https://example.com/v1#x",
            "https://example.com/v1/responses",
        ] {
            assert!(Config {
                base_url: url.into(),
                ..Config::default()
            }
            .validated()
            .is_err());
        }
        for url in [
            "http://localhost:1234/v1",
            "http://127.0.0.1:8080/v1",
            "http://[::1]:8080/v1",
            "https://example.com/custom/v1/",
        ] {
            assert!(Config {
                base_url: url.into(),
                ..Config::default()
            }
            .validated()
            .is_ok());
        }
    }
    #[test]
    fn preserves_schema_and_messages() {
        let r = json!({"model":"custom/model","instructions":"instructions","input":"cast", "max_output_tokens":4000,"text":{"format":{"name":"cast","schema":{"type":"object"}}}});
        let chat = chat_request(&r);
        assert_eq!(chat["model"], "custom/model");
        assert_eq!(chat["messages"][1]["content"], "cast");
        assert_eq!(
            chat["response_format"]["json_schema"]["schema"],
            r["text"]["format"]["schema"]
        );
        assert_eq!(chat["max_completion_tokens"], 4000);
    }
    #[test]
    fn rejects_truncation_refusals_and_missing_text() {
        for choice in [
            json!({"finish_reason":"length","message":{"content":"partial"}}),
            json!({"finish_reason":"stop","message":{"refusal":"no"}}),
            json!({"finish_reason":"stop","message":{}}),
        ] {
            assert!(chat_response(json!({"choices":[choice]})).is_err());
        }
        let r =
            chat_response(json!({"choices":[{"finish_reason":"stop","message":{"content":"{}"}}]}))
                .unwrap();
        assert_eq!(providers::response_text(&r).unwrap(), "{}");
    }
}
