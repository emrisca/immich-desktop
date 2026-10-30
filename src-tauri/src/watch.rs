//! A watched folder: whatever lands in it is uploaded without being asked.
//!
//! The scan is a poll rather than a filesystem notification. A folder filled by a
//! phone sync, a download or a camera import looks the same either way, and a poll
//! has no watcher handles to lose — inotify on Linux, the read-directory-change
//! API on macOS and `ReadDirectoryChangesW` on Windows all have their own failure
//! modes that a 2.5 second `read_dir` simply does not.
//!
//! Every file that has been sent is remembered with its size and modification
//! time in `watch.json`, so restarting the app does not re-upload the folder,
//! while a file that is rewritten is sent again (Immich deduplicates it by
//! checksum). The file is never moved or deleted: it is the user's, and the only
//! thing done to it is reading it.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use crate::import;

/// A file modified this recently may still be copying in. Leaving it until the
/// next pass is what stops a half-written photo from being uploaded.
const SETTLE: Duration = Duration::from_secs(3);

/// Beyond this the memory of what was sent is dropped and the folder is scanned
/// afresh; re-sending a duplicate is cheaper than an unbounded map.
const MAX_REMEMBERED: usize = 50_000;

/// How many times a file that the server refused is tried again before it is
/// left alone. A server that is down for a moment recovers inside this window;
/// a key the server will never accept stops instead of hammering it forever.
const RETRIES: u32 = 3;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchView {
    pub folder: String,
    /// False when no folder has been chosen.
    pub active: bool,
    /// Why nothing is moving even though a folder is set.
    pub waiting: Option<String>,
    pub uploaded: usize,
    pub duplicates: usize,
    pub failed: usize,
    pub last_file: String,
    pub last_error: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct Seen {
    files: HashMap<String, String>,
}

pub struct Watch {
    folder: String,
    seen: HashMap<String, String>,
    /// Failed attempts per path, kept in memory: it is about this run, not about
    /// what the folder contains.
    attempts: HashMap<String, u32>,
    dirty: bool,
    uploaded: usize,
    duplicates: usize,
    failed: usize,
    last_file: String,
    last_error: Option<String>,
    waiting: Option<String>,
}

impl Watch {
    pub fn load(config_dir: &Path) -> Self {
        let path = config_dir.join("watch.json");
        let seen = fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Seen>(&text).ok())
            .unwrap_or_default()
            .files;
        Self {
            folder: String::new(),
            seen,
            attempts: HashMap::new(),
            dirty: false,
            uploaded: 0,
            duplicates: 0,
            failed: 0,
            last_file: String::new(),
            last_error: None,
            waiting: None,
        }
    }

    /// Point the watcher at a folder (or at nothing). Changing folder starts the
    /// visible counters again, because "12 uploaded" from another folder would be
    /// a lie about this one; what was already sent stays remembered.
    pub fn sync(&mut self, folder: &str) {
        if self.folder != folder {
            self.folder = folder.to_string();
            self.uploaded = 0;
            self.duplicates = 0;
            self.failed = 0;
            self.last_file.clear();
            self.last_error = None;
        }
    }

    pub fn active(&self) -> bool {
        !self.folder.is_empty()
    }

    pub fn view(&self) -> WatchView {
        WatchView {
            folder: self.folder.clone(),
            active: !self.folder.is_empty(),
            waiting: if self.folder.is_empty() {
                None
            } else {
                self.waiting.clone()
            },
            uploaded: self.uploaded,
            duplicates: self.duplicates,
            failed: self.failed,
            last_file: self.last_file.clone(),
            last_error: self.last_error.clone(),
        }
    }

    pub fn set_waiting(&mut self, waiting: Option<String>) {
        self.waiting = waiting;
    }

    /// Files in the folder that have not been sent in this exact form yet.
    /// `own_media` is the app's own storage, which is skipped.
    pub fn scan(&self, own_media: &Path) -> Vec<PathBuf> {
        if self.folder.is_empty() {
            return Vec::new();
        }
        let now = SystemTime::now();
        import::collect(&[self.folder.clone()], own_media)
            .into_iter()
            .filter(|path| {
                let Some(meta) = fs::metadata(path).ok() else {
                    return false;
                };
                let settling = meta
                    .modified()
                    .ok()
                    .and_then(|at| now.duration_since(at).ok())
                    .is_some_and(|age| age < SETTLE);
                if settling {
                    return false;
                }
                match stamp_of(path) {
                    Some(stamp) => self.seen.get(&key(path)) != Some(&stamp),
                    None => false,
                }
            })
            .collect()
    }

    /// Shown while a file is in flight, so the hub says what it is doing.
    pub fn announce(&mut self, path: &Path) {
        self.last_file = name_of(path);
    }

    /// A file that went through is remembered at once. One that failed is not:
    /// the server may have been restarting, and losing that photo to a moment of
    /// downtime is exactly what this feature must not do. It is retried on the
    /// next pass, up to `RETRIES` times.
    pub fn record(&mut self, path: &Path, result: Result<import::Outcome, String>) {
        self.last_file = name_of(path);
        let id = key(path);
        let sent = match result {
            Ok(import::Outcome::Created) => {
                self.uploaded += 1;
                true
            }
            Ok(import::Outcome::Duplicate) => {
                self.duplicates += 1;
                true
            }
            Err(error) => {
                self.failed += 1;
                self.last_error = Some(error);
                let tries = self.attempts.entry(id.clone()).or_insert(0);
                *tries += 1;
                if *tries >= RETRIES {
                    self.attempts.remove(&id);
                    true
                } else {
                    false
                }
            }
        };
        if !sent {
            return;
        }
        if let Some(stamp) = stamp_of(path) {
            self.seen.insert(id, stamp);
            self.dirty = true;
        }
        if self.seen.len() > MAX_REMEMBERED {
            self.seen.clear();
            self.dirty = true;
        }
    }

    /// Write the memory of sent files, at most once per change. A failed write is
    /// logged and retried on the next pass rather than failing the upload.
    pub fn flush(&mut self, config_dir: &Path) {
        if !self.dirty {
            return;
        }
        let seen = Seen {
            files: self.seen.clone(),
        };
        let path = config_dir.join("watch.json");
        let temp = path.with_extension("json.tmp");
        let written = fs::create_dir_all(config_dir)
            .and_then(|_| fs::write(&temp, serde_json::to_string(&seen)?))
            .and_then(|_| fs::rename(&temp, &path));
        match written {
            Ok(()) => self.dirty = false,
            Err(error) => eprintln!("could not save the watched-folder memory: {error}"),
        }
    }
}

fn name_of(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string()
}

fn key(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Size and modification time, which together change whenever a file is replaced
/// by a different one with the same name.
fn stamp_of(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|at| at.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|delta| delta.as_secs())
        .unwrap_or(0);
    Some(format!("{}:{}", meta.len(), modified))
}
