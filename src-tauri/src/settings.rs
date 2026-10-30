//! Settings live in the app config directory, so the app can find the library
//! folder before it has one. A copy is also written into the library folder for
//! backups (M5).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub library_folder: String,
    pub server_port: u16,
    pub database_port: u16,
    /// The CLIP service Immich talks to. Loopback only.
    pub ml_port: u16,
    /// Where the bundled Postgres, Immich server and node live. Empty means the
    /// app's own resource directory, which is what packaging fills in (M6).
    pub runtime_root: String,
    pub allow_phones: bool,
    pub machine_learning: bool,
    /// Immich API key used by imports. Created at admin sign-up, and pasteable
    /// for installations that already exist.
    pub api_key: String,
    /// Folder whose new media is uploaded automatically; empty means nothing is
    /// watched.
    pub watch_folder: String,
    /// The look the hub wears. A plain string, not an enum: a settings file
    /// written by a newer build must load here, and an unknown value falls back
    /// to the default instead of leaving the window unstyled.
    pub ui_style: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            library_folder: default_library_folder(),
            server_port: 2283,
            database_port: 54329,
            ml_port: 3003,
            runtime_root: String::new(),
            allow_phones: true,
            machine_learning: false,
            api_key: String::new(),
            watch_folder: String::new(),
            ui_style: String::from(crate::DEFAULT_UI_STYLE),
        }
    }
}

fn default_library_folder() -> String {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| String::from("."));
    PathBuf::from(home)
        .join("Pictures")
        .join("Immich")
        .to_string_lossy()
        .into_owned()
}

impl Settings {
    /// Whether this installation actually carries the CLIP service and its
    /// models, which is what "machine learning" means here.
    pub fn has_ml(settings: &Settings) -> bool {
        Path::new(&settings.runtime_root).join("ml").join("index.mjs").is_file()
    }

    pub fn path(config_dir: &Path) -> PathBuf {
        config_dir.join("settings.json")
    }

    pub fn load(config_dir: &Path) -> Self {
        let path = Self::path(config_dir);
        let mut settings = match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|error| {
                eprintln!("settings at {} are unreadable: {error}", path.display());
                Settings::default()
            }),
            Err(_) => Settings::default(),
        };
        settings.normalise();
        settings
    }

    /// Paths written by an older build (or picked through a Windows dialog) can
    /// carry the `\\?\` verbatim prefix, which Postgres cannot start from.
    pub fn normalise(&mut self) {
        for field in [
            &mut self.library_folder,
            &mut self.runtime_root,
            &mut self.watch_folder,
        ] {
            *field = crate::layout::plain(Path::new(field));
        }
    }

    /// Write to a sibling temp file then rename, so a crash never leaves a
    /// half-written settings file behind.
    pub fn save(&self, config_dir: &Path) -> io::Result<()> {
        fs::create_dir_all(config_dir)?;
        let path = Self::path(config_dir);
        let temp = path.with_extension("json.tmp");
        fs::write(&temp, serde_json::to_string_pretty(self)?)?;
        fs::rename(temp, path)
    }
}

#[cfg(test)]
mod tests {
    use super::Settings;

    /// A settings file written before the hub had more than one look: the new
    /// field is absent, and the app has to open in the default look rather than
    /// unstyled or refusing to load.
    #[test]
    fn a_file_from_before_styles_loads_as_the_default() {
        let json = r#"{
            "libraryFolder": "/tmp/library",
            "serverPort": 2283,
            "databasePort": 54329,
            "mlPort": 3003,
            "runtimeRoot": "",
            "allowPhones": true,
            "machineLearning": false,
            "apiKey": "",
            "watchFolder": ""
        }"#;
        let settings: Settings = serde_json::from_str(json).expect("older settings load");
        assert_eq!(settings.ui_style, crate::DEFAULT_UI_STYLE);
        assert_eq!(settings.ui_style, "dark");
    }
}
