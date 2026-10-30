//! Readiness probes. Plain TCP and one HTTP GET are enough for
//! `pg_isready`/`/api/server/ping`, and a hand-rolled request avoids pulling an
//! HTTP client into the shell for two calls per second.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

pub fn tcp_open(port: u16) -> bool {
    let address = match ("127.0.0.1", port).to_socket_addrs() {
        Ok(mut addresses) => match addresses.next() {
            Some(address) => address,
            None => return false,
        },
        Err(_) => return false,
    };

    TcpStream::connect_timeout(&address, Duration::from_millis(400)).is_ok()
}

/// True when the endpoint answers with a 2xx status line.
pub fn http_ok(port: u16, path: &str) -> bool {
    let address = match ("127.0.0.1", port).to_socket_addrs() {
        Ok(mut addresses) => match addresses.next() {
            Some(address) => address,
            None => return false,
        },
        Err(_) => return false,
    };

    let mut stream = match TcpStream::connect_timeout(&address, Duration::from_millis(600)) {
        Ok(stream) => stream,
        Err(_) => return false,
    };

    let _ = stream.set_read_timeout(Some(Duration::from_millis(1200)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(600)));

    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nUser-Agent: immich-desktop\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut buffer = [0u8; 64];
    let read = stream.read(&mut buffer).unwrap_or(0);
    let head = String::from_utf8_lossy(&buffer[..read]);
    head.starts_with("HTTP/1.1 2") || head.starts_with("HTTP/1.0 2")
}

/// The address the machine would use to reach the network, without sending
/// anything: connecting a UDP socket only asks the routing table.
pub fn lan_address() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let address = socket.local_addr().ok()?.ip();
    if address.is_loopback() || address.is_unspecified() {
        return None;
    }
    Some(address.to_string())
}
