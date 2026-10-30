//! Importing photos and videos from disk into the local Immich server.
//!
//! Uploads go through Immich's own `POST /api/assets` as multipart form data,
//! authenticated with an API key, so the existing pipeline (checksums, EXIF,
//! thumbnails, the job queue) does the real work. Re-importing the same folder is
//! safe: Immich answers `duplicate` and nothing is stored twice.

use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

const EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "heic", "heif", "avif", "webp", "gif", "tif", "tiff", "bmp", "dng", "raw",
    "cr2", "cr3", "nef", "arw", "orf", "rw2", "raf", "mp4", "mov", "m4v", "webm", "mkv", "avi",
    "3gp", "mts", "m2ts", "wmv", "flv", "mpeg", "mpg",
];

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub running: bool,
    pub total: usize,
    pub done: usize,
    pub imported: usize,
    pub duplicates: usize,
    pub failed: usize,
    pub current: String,
    pub last_error: Option<String>,
}

/// Every file under the dropped paths that Immich can actually store. Folders
/// are walked; unsupported files are left alone, and so is `own_media` — the
/// app's own stored copies, which are already in Immich.
pub fn collect(paths: &[String], own_media: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for raw in paths {
        let path = PathBuf::from(raw);
        if path.starts_with(own_media) {
            continue;
        }
        if path.is_dir() {
            walk(&path, own_media, &mut files, 0);
        } else if supported(&path) {
            files.push(path);
        }
    }
    files.sort();
    files.dedup();
    files
}

fn walk(dir: &Path, own_media: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    // Five levels is plenty for photo folders and stops a junction loop.
    if depth > 8 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.starts_with(own_media) {
            continue;
        }
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => walk(&path, own_media, out, depth + 1),
            Ok(kind) if kind.is_file() && supported(&path) => out.push(path),
            _ => {}
        }
    }
}

fn supported(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

pub enum Outcome {
    Created,
    Duplicate,
}

/// One asset, one request. The body is built in memory; a multi-gigabyte video
/// is refused rather than streamed, because a half-read body would leave the
/// server with a truncated asset.
pub fn upload(port: u16, api_key: &str, path: &Path) -> Result<Outcome, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("{}: {error}", path.display()))?;
    if metadata.len() > 2 * 1024 * 1024 * 1024 {
        return Err(format!("{} is larger than 2 GB", path.display()));
    }
    let mut data = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(path)
        .and_then(|mut file| file.read_to_end(&mut data))
        .map_err(|error| format!("{}: {error}", path.display()))?;

    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("upload");
    let stamp = iso8601(metadata.modified().unwrap_or(SystemTime::now()));
    let mime = mime_for(path);

    let mut body = Vec::with_capacity(data.len() + 1024);
    for (field, value) in [("fileCreatedAt", stamp.as_str()), ("fileModifiedAt", stamp.as_str()), ("filename", name)] {
        body.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
        body.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"{field}\"\r\n\r\n").as_bytes(),
        );
        body.extend_from_slice(value.as_bytes());
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
    body.extend_from_slice(
        format!("Content-Disposition: form-data; name=\"assetData\"; filename=\"{name}\"\r\n").as_bytes(),
    );
    body.extend_from_slice(format!("Content-Type: {mime}\r\n\r\n").as_bytes());
    body.extend_from_slice(&data);
    body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());

    let head = format!(
        "POST /api/assets HTTP/1.1\r\n\
         Host: 127.0.0.1:{port}\r\n\
         x-api-key: {api_key}\r\n\
         Accept: application/json\r\n\
         Content-Type: multipart/form-data; boundary={BOUNDARY}\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );

    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .map_err(|error| format!("the server is not reachable: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(120)))
        .and_then(|_| stream.set_write_timeout(Some(Duration::from_secs(120))))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(head.as_bytes())
        .and_then(|_| stream.write_all(&body))
        .and_then(|_| stream.flush())
        .map_err(|error| format!("upload of {name} failed: {error}"))?;

    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw);
    let text = String::from_utf8_lossy(&raw);
    let status = text
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);
    let payload = text.split_once("\r\n\r\n").map(|(_, rest)| rest).unwrap_or("");

    match status {
        200 | 201 => {
            if payload.contains("\"duplicate\"") {
                Ok(Outcome::Duplicate)
            } else {
                Ok(Outcome::Created)
            }
        }
        401 => Err("Immich rejected the API key. Create a new one in Settings → API Keys.".into()),
        _ => Err(format!("{name}: the server answered {status}")),
    }
}

const BOUNDARY: &str = "----immichdesktop7f3a1c";

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("heic") | Some("heif") => "image/heic",
        Some("avif") => "image/avif",
        Some("tif") | Some("tiff") => "image/tiff",
        Some("bmp") => "image/bmp",
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("webm") => "video/webm",
        Some("mkv") => "video/x-matroska",
        Some("avi") => "video/x-msvideo",
        Some("3gp") => "video/3gpp",
        _ => "application/octet-stream",
    }
}

/// `2026-10-28T09:14:05.000Z`, built by hand so the app needs no date crate.
fn iso8601(time: SystemTime) -> String {
    let secs = time
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Howard Hinnant's days-to-civil algorithm.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}
