//! A loopback-only HTTP client, just enough to talk to the Immich server we
//! started ourselves.
//!
//! Why not use `fetch` from the webview: Immich calls `enableCors()` only in dev
//! mode, so a production server refuses cross-origin requests from
//! `localhost:1420`. Talking to `127.0.0.1` from here sidesteps CORS entirely,
//! and the admin password never leaves this process.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

pub struct Response {
    pub status: u16,
    pub body: String,
}

/// One request, one connection. Every call is short-lived and local, so pooling
/// would cost more than it saves.
pub fn request(port: u16, method: &str, path: &str, body: Option<&str>) -> std::io::Result<Response> {
    request_with(port, method, path, body, &[])
}

/// Same, plus extra request headers (the API key and bearer token paths).
pub fn request_with(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&str>,
    headers: &[(&str, &str)],
) -> std::io::Result<Response> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))?;
    stream.set_read_timeout(Some(Duration::from_secs(15)))?;
    stream.set_write_timeout(Some(Duration::from_secs(15)))?;

    let payload = body.unwrap_or("");
    let extra: String = headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect();
    let head = format!(
        "{method} {path} HTTP/1.1\r\n\
         Host: 127.0.0.1:{port}\r\n\
         Accept: application/json\r\n\
         Content-Type: application/json\r\n\
         {extra}\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n",
        payload.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(payload.as_bytes())?;
    stream.flush()?;

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw)?;
    let text = String::from_utf8_lossy(&raw).into_owned();

    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((text.as_str(), ""));
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);

    // Nest sets Content-Length for JSON, but a chunked reply would otherwise be
    // left with its size markers in the body.
    let chunked = head
        .lines()
        .any(|line| line.to_ascii_lowercase().replace(' ', "").starts_with("transfer-encoding:chunked"));

    Ok(Response {
        status,
        body: if chunked { dechunk(body) } else { body.to_string() },
    })
}

fn dechunk(body: &str) -> String {
    let mut out = String::new();
    let mut rest = body;
    loop {
        let Some((size_line, tail)) = rest.split_once("\r\n") else {
            break;
        };
        let size = usize::from_str_radix(size_line.trim(), 16).unwrap_or(0);
        if size == 0 {
            break;
        }
        if tail.len() < size {
            out.push_str(tail);
            break;
        }
        out.push_str(&tail[..size]);
        rest = tail[size..].trim_start_matches("\r\n");
    }
    out
}
