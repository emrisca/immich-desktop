//! The folder layout lives entirely inside the library folder, and the checks
//! below run before Postgres is initialised — a cluster on a synced or network
//! folder corrupts, and finding that out after the first import is too late.

use std::fs;
use std::path::{Path, PathBuf};

use crate::settings::Settings;

const SYNCED: [&str; 7] = [
    "onedrive",
    "dropbox",
    "icloud",
    "google drive",
    "googledrive",
    // A synced Desktop & Documents lives in `Mobile Documents/com~apple~CloudDocs`
    // on macOS: neither name says "iCloud", and a cluster in there corrupts the
    // same way as one in `iCloud Drive` proper.
    "clouddocs",
    "mobile documents",
];

#[derive(Clone, Debug)]
pub struct Layout {
    pub root: PathBuf,
    pub media: PathBuf,
    pub database: PathBuf,
    pub logs: PathBuf,
}

impl Layout {
    pub fn new(library_folder: &Path) -> Self {
        let root = library_folder.join("immich");
        Self {
            media: root.join("media"),
            database: root.join("database"),
            logs: root.join("logs"),
            root,
        }
    }

    pub fn server_dir(settings: &Settings) -> PathBuf {
        Path::new(&settings.runtime_root).join("immich").join("server")
    }

    /// The CLIP service and its downloaded models, beside the server.
    pub fn ml_dir(settings: &Settings) -> PathBuf {
        Path::new(&settings.runtime_root).join("ml")
    }

    /// Where this app keeps its own copies. Imports refuse to read from here —
    /// those files are already stored — but everything else under the library
    /// folder is fair game. That matters for anyone whose library folder is an
    /// older Immich upload location: their originals sit in `upload/` beside it,
    /// not in our `immich/media`.
    pub fn own_media(library_folder: &Path) -> PathBuf {
        library_folder.join("immich").join("media")
    }

    /// Every directory Immich expects under `UPLOAD_LOCATION`.
    pub fn create(&self) -> std::io::Result<()> {
        for dir in [
            &self.media,
            &self.database,
            &self.logs,
            &self.media.join("upload"),
            &self.media.join("library"),
            &self.media.join("thumbs"),
            &self.media.join("encoded-video"),
            &self.media.join("profile"),
            &self.media.join("backups"),
            &self.root.join("ml"),
        ] {
            fs::create_dir_all(dir)?;
        }
        Ok(())
    }

    /// Records the child's pid so a relaunch after a hard kill can clean up
    /// what the crashed instance left behind.
    pub fn pid_file(&self, name: &str) -> PathBuf {
        self.logs.join(format!("{name}.pid"))
    }

    pub fn log_file(&self, name: &str) -> std::io::Result<fs::File> {
        fs::create_dir_all(&self.logs)?;
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.logs.join(format!("{name}.log")))
    }

    pub fn is_initialised(&self) -> bool {
        self.database.join("PG_VERSION").is_file()
    }
}

/// A plain path for anything that leaves Rust.
///
/// Windows reports some paths — Tauri's resource directory, most visibly — in
/// the `\\?\` verbatim form. Postgres' `initdb` asks `cmd.exe` to run its own
/// sibling executable, and cmd cannot parse that prefix, so it fails with
/// "The system cannot find the path specified" on a machine where nothing is
/// installed yet. Strip the prefix before the path is stored or passed on.
pub fn plain(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        text.into_owned()
    }
}

/// Rejects a folder that would put the database somewhere it cannot live.
pub fn check_folder(folder: &Path) -> Result<(), String> {
    if folder.as_os_str().is_empty() {
        return Err("Choose a folder for the library.".into());
    }

    let text = folder.to_string_lossy();
    if text.starts_with(r"\\") || text.starts_with("//") {
        return Err(
            "That is a network share. Postgres corrupts on a network folder — pick a local disk."
                .into(),
        );
    }
    if !folder.is_absolute() {
        return Err("Choose an absolute path.".into());
    }

    if let Some(part) = synced_component(folder) {
        return Err(format!(
            "“{part}” looks like a cloud-synced folder. A sync client will corrupt the database — pick a folder outside it."
        ));
    }

    // The folder itself may not exist yet; the parent has to.
    if !folder.exists() {
        if let Some(parent) = folder.parent() {
            if !parent.exists() {
                return Err(format!(
                    "“{}” does not exist. Create it first, or choose a folder that does.",
                    parent.display()
                ));
            }
        }
    }

    Ok(())
}

/// The first path component that belongs to a sync client, if any. Plain names
/// catch OneDrive and Dropbox; the macOS entries catch a synced Desktop and
/// Documents, which live under `Mobile Documents/com~apple~CloudDocs` — a path
/// that never spells "iCloud".
fn synced_component(folder: &Path) -> Option<String> {
    folder.components().find_map(|part| {
        let text = part.as_os_str().to_string_lossy();
        let name = text.to_lowercase();
        SYNCED
            .iter()
            .any(|marker| name.contains(marker))
            .then(|| text.into_owned())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_sync_clients() {
        // A synced Desktop & Documents on macOS, which contains neither the word
        // "iCloud" nor a name anyone would recognise as a cloud folder.
        assert_eq!(
            synced_component(Path::new("/Users/me/Library/Mobile Documents/com~apple~CloudDocs/Immich")),
            Some("Mobile Documents".to_string())
        );
        assert!(synced_component(Path::new("/Users/me/Pictures/Immich")).is_none());
        assert!(synced_component(Path::new("/Users/me/Dropbox/Immich")).is_some());
    }
}
