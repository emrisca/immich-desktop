//! The shell and its supervisor. The window is the frontend bundle; everything
//! that touches a process lives in `runtime`.

mod api;
mod firewall;
mod import;
mod layout;
mod library;
mod logs;
mod probe;
mod qr;
mod runtime;
mod settings;
mod watch;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{Manager, RunEvent, State};

use layout::Layout;
use runtime::{Runtime, StatusView};
use settings::Settings;

struct Shared {
    settings: Mutex<Settings>,
    runtime: Mutex<Runtime>,
    progress: Mutex<import::ImportProgress>,
    watch: Mutex<watch::Watch>,
    config_dir: PathBuf,
    /// Cached because the phone card polls every second and every check is a
    /// `netsh` process. Refreshed at startup and whenever the rule changes.
    firewall: Mutex<bool>,
}

fn snapshot(shared: &Shared, message: Option<String>) -> StatusView {
    let settings = shared.settings.lock().expect("settings lock").clone();
    let runtime = shared.runtime.lock().expect("runtime lock");
    let layout = Layout::new(Path::new(&settings.library_folder));
    let mut view = runtime.view(&settings, &layout, message);
    view.firewall = *shared.firewall.lock().expect("firewall lock");
    view
}

#[tauri::command]
fn runtime_status(state: State<'_, Arc<Shared>>) -> StatusView {
    snapshot(&state, None)
}

#[tauri::command]
fn runtime_start(state: State<'_, Arc<Shared>>) -> StatusView {
    state.runtime.lock().expect("runtime lock").start();
    snapshot(&state, None)
}

#[tauri::command]
fn runtime_stop(state: State<'_, Arc<Shared>>) -> StatusView {
    state.runtime.lock().expect("runtime lock").stop();
    snapshot(&state, Some("Stopped.".into()))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerSetup {
    initialised: bool,
}

/// Whether this fresh installation already has its admin account. Polled by the
/// first-run screen, which is the only thing standing between a new user and the
/// hub.
#[tauri::command]
fn server_setup(state: State<'_, Arc<Shared>>) -> Result<ServerSetup, String> {
    let port = state.settings.lock().expect("settings lock").server_port;
    let response = api::request(port, "GET", "/api/server/config", None)
        .map_err(|error| format!("The local server did not answer: {error}"))?;
    if response.status != 200 {
        return Err(api_message(&response));
    }
    let json: serde_json::Value = serde_json::from_str(&response.body)
        .map_err(|error| format!("Unexpected answer from the server: {error}"))?;
    Ok(ServerSetup {
        initialised: json["isInitialized"].as_bool().unwrap_or(false),
    })
}

/// Create the first admin. Immich only accepts this while `isInitialized` is
/// false, so the command is safe to expose: a second call is refused by the
/// server itself.
#[tauri::command]
fn create_admin(
    name: String,
    email: String,
    password: String,
    state: State<'_, Arc<Shared>>,
) -> Result<(), String> {
    let port = state.settings.lock().expect("settings lock").server_port;
    let payload = serde_json::json!({
        "name": name.trim(),
        "email": email.trim(),
        "password": password,
    })
    .to_string();

    let response = api::request(port, "POST", "/api/auth/admin-sign-up", Some(&payload))
        .map_err(|error| format!("The local server did not answer: {error}"))?;

    if !matches!(response.status, 200 | 201) {
        return Err(api_message(&response));
    }

    // The account exists from here on; everything below is best effort.
    if let Some(secret) = create_api_key(port, &payload, &response.body) {
        let mut settings = state.settings.lock().expect("settings lock");
        settings.api_key = secret;
        let _ = settings.save(&state.config_dir);
    }

    Ok(())
}

/// Swap a session for an API key the importer can keep using.
///
/// The sign-up response normally carries the token, but a login with the same
/// credentials is just as good and re-checks the account, so it is tried second.
fn create_api_key(port: u16, credentials: &str, sign_up_body: &str) -> Option<String> {
    let token = serde_json::from_str::<serde_json::Value>(sign_up_body)
        .ok()
        .and_then(|json| json["accessToken"].as_str().map(str::to_string))
        .or_else(|| {
            let login = api::request(port, "POST", "/api/auth/login", Some(credentials)).ok()?;
            let json: serde_json::Value = serde_json::from_str(&login.body).ok()?;
            json["accessToken"].as_str().map(str::to_string)
        })?;

    let auth = format!("Bearer {token}");
    // The next call can land while the server still has "not initialised" cached
    // from a moment ago, so give it a few tries before giving up.
    for attempt in 0..8 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
        let Ok(created) = api::request_with(
            port,
            "POST",
            "/api/api-keys",
            // `permissions` is required; "all" keeps the key working for any
            // future import path without a migration.
            Some(r#"{"name":"Immich Desktop","permissions":["all"]}"#),
            &[("Authorization", &auth)],
        ) else {
            continue;
        };
        if let Ok(key) = serde_json::from_str::<serde_json::Value>(&created.body) {
            if let Some(secret) = key["secret"].as_str() {
                return Some(secret.to_string());
            }
        }
        eprintln!(
            "api key attempt {attempt} failed: {} {}",
            created.status,
            created.body.trim()
        );
    }
    None
}

#[tauri::command]
fn set_api_key(key: String, state: State<'_, Arc<Shared>>) -> Result<StatusView, String> {
    {
        let mut settings = state.settings.lock().expect("settings lock");
        settings.api_key = key.trim().to_string();
        settings
            .save(&state.config_dir)
            .map_err(|error| format!("Could not save settings: {error}"))?;
    }
    Ok(snapshot(&state, Some("API key saved.".into())))
}

#[tauri::command]
fn import_status(state: State<'_, Arc<Shared>>) -> import::ImportProgress {
    state.progress.lock().expect("progress lock").clone()
}

/// Drop handler and folder picker both land here. The upload runs on its own
/// thread so the window never blocks on a folder of raw files.
#[tauri::command]
fn import_paths(
    paths: Vec<String>,
    state: State<'_, Arc<Shared>>,
) -> Result<import::ImportProgress, String> {
    let shared = state.inner().clone();
    {
        let progress = shared.progress.lock().expect("progress lock");
        if progress.running {
            return Err("An import is already running.".into());
        }
    }

    let settings = shared.settings.lock().expect("settings lock").clone();
    if settings.api_key.is_empty() {
        return Err("No API key yet — create one in the library under Settings → API Keys.".into());
    }

    let files = import::collect(&paths, &Layout::own_media(Path::new(&settings.library_folder)));
    if files.is_empty() {
        return Err("No photos or videos found there.".into());
    }

    let total = files.len();
    {
        let mut progress = shared.progress.lock().expect("progress lock");
        *progress = import::ImportProgress {
            running: true,
            total,
            ..Default::default()
        };
    }

    std::thread::spawn(move || {
        for file in files {
            {
                let mut progress = shared.progress.lock().expect("progress lock");
                progress.current = file
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_string();
            }

            let outcome = import::upload(settings.server_port, &settings.api_key, &file);

            let mut progress = shared.progress.lock().expect("progress lock");
            progress.done += 1;
            match outcome {
                Ok(import::Outcome::Created) => progress.imported += 1,
                Ok(import::Outcome::Duplicate) => progress.duplicates += 1,
                Err(error) => {
                    progress.failed += 1;
                    progress.last_error = Some(error);
                }
            }
            if progress.done >= progress.total {
                progress.running = false;
                progress.current.clear();
            }
        }
    });

    Ok(import_status(state))
}

/// Whether the server answers only this machine or the whole local network.
/// The listening address is fixed when the server starts, so a change restarts
/// it — a phone cannot reach a socket bound to loopback, however right the
/// address on the hub looks.
#[tauri::command]
fn set_allow_phones(enabled: bool, state: State<'_, Arc<Shared>>) -> Result<StatusView, String> {
    let changed = {
        let mut settings = state.settings.lock().expect("settings lock");
        if settings.allow_phones == enabled {
            false
        } else {
            settings.allow_phones = enabled;
            settings
                .save(&state.config_dir)
                .map_err(|error| format!("Could not save settings: {error}"))?;
            true
        }
    };

    if changed {
        let mut runtime = state.runtime.lock().expect("runtime lock");
        if runtime.desired {
            runtime.stop();
            runtime.start();
        }
    }

    // Turning the switch on is also the moment the phone starts depending on the
    // firewall, so that is when Windows is asked — not on a schedule.
    if enabled {
        let program = runtime::server_program(&state.settings.lock().expect("settings lock"));
        let allowed = firewall::install(&program);
        *state.firewall.lock().expect("firewall lock") = allowed;
    }

    Ok(snapshot(
        &state,
        Some(if enabled {
            "Phones on this network can connect.".into()
        } else {
            "Only this computer can connect.".into()
        }),
    ))
}

/// Ask Windows for the inbound rule the phone needs. This is the only part of
/// phone access that needs administrator rights, and it is why the switch can be
/// on while the phone still cannot reach anything.
#[tauri::command]
fn allow_firewall(state: State<'_, Arc<Shared>>) -> Result<StatusView, String> {
    let program = runtime::server_program(&state.settings.lock().expect("settings lock"));
    let allowed = firewall::install(&program);
    *state.firewall.lock().expect("firewall lock") = allowed;

    Ok(snapshot(
        &state,
        Some(if allowed {
            "Windows now allows this app on the local network.".into()
        } else {
            "Windows did not allow the app. The firewall prompt has to be accepted for phones to connect."
                .into()
        }),
    ))
}

/// The phone card's code, drawn from the address the app is already showing.
#[tauri::command]
fn phone_qr(url: String) -> Result<String, String> {
    qr::svg(&url)
}

#[tauri::command]
fn watch_status(state: State<'_, Arc<Shared>>) -> watch::WatchView {
    state.watch.lock().expect("watch lock").view()
}

/// Point the watcher at a folder, or pass an empty path to stop watching. The
/// folder is checked here rather than in the UI so a stored path is always one
/// that exists.
#[tauri::command]
fn set_watch_folder(
    path: String,
    state: State<'_, Arc<Shared>>,
) -> Result<watch::WatchView, String> {
    let chosen = path.trim();
    let folder = if chosen.is_empty() {
        String::new()
    } else {
        let folder = PathBuf::from(chosen);
        if !folder.is_dir() {
            return Err("That folder is not there any more.".into());
        }
        let library = PathBuf::from(&state.settings.lock().expect("settings lock").library_folder);
        // Only the app's own media folder is off limits: everything in it is
        // already stored, so watching it would re-upload every original. An
        // older Immich upload location inside the library folder is fine.
        if folder.starts_with(Layout::own_media(&library)) {
            return Err("Pick a folder outside the library's own media folder.".into());
        }
        folder.to_string_lossy().into_owned()
    };

    {
        let mut settings = state.settings.lock().expect("settings lock");
        settings.watch_folder = folder.clone();
        settings
            .save(&state.config_dir)
            .map_err(|error| format!("Could not save settings: {error}"))?;
    }

    let mut watch = state.watch.lock().expect("watch lock");
    watch.sync(&folder);
    Ok(watch.view())
}

/// The tail of a service's log file. `source` is `all`, `server` or `database`.
#[tauri::command]
fn logs_read(
    source: String,
    limit: Option<usize>,
    state: State<'_, Arc<Shared>>,
) -> Result<logs::LogView, String> {
    let folder = state.settings.lock().expect("settings lock").library_folder.clone();
    logs::read(&Layout::new(Path::new(&folder)), &source, limit)
}

/// Measured from the folder itself, so the Storage screen reports what is there
/// instead of a fixed number. The walk runs off the UI thread: a library with a
/// hundred thousand originals takes long enough to notice.
#[tauri::command]
async fn library_usage(state: State<'_, Arc<Shared>>) -> Result<library::Usage, String> {
    let folder = state.settings.lock().expect("settings lock").library_folder.clone();
    tauri::async_runtime::spawn_blocking(move || library::usage(Path::new(&folder)))
        .await
        .map_err(|error| format!("Could not measure the library: {error}"))
}

/// Immich answers validation failures with `{"message": ["..."]}`; a bare
/// string and an unparseable body are both possible, so fall back to the text.
fn api_message(response: &api::Response) -> String {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&response.body) else {
        let text = response.body.trim();
        return if text.is_empty() {
            format!("The server answered {}", response.status)
        } else {
            text.to_string()
        };
    };
    match &json["message"] {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Array(items) => {
            let joined: Vec<&str> = items.iter().filter_map(|item| item.as_str()).collect();
            if joined.is_empty() {
                format!("The server answered {}", response.status)
            } else {
                joined.join("\n")
            }
        }
        _ => format!("The server answered {}", response.status),
    }
}

/// The library is Immich's own web app, opened in this window.
///
/// It has to be the same top-level page, not a frame and not a second window:
/// Immich's session cookies are `SameSite=Lax`, so a cross-site frame is treated
/// as third-party and never finishes a login, and a remote-URL window renders
/// blank on WebView2. Navigating here keeps the origin first-party, which is
/// what makes the account persist.
#[tauri::command]
fn open_library(app: tauri::AppHandle, state: State<'_, Arc<Shared>>) -> Result<(), String> {
    let port = state.settings.lock().expect("settings lock").server_port;
    let url = tauri::Url::parse(&format!("http://127.0.0.1:{port}/"))
        .map_err(|error| format!("Could not build the library address: {error}"))?;
    let window = app
        .get_webview_window("main")
        .ok_or("The main window is gone.")?;

    // Where the hub lives, captured before leaving it: the chip navigates back to
    // this address, because history belongs to whichever app is loaded.
    let hub = window.url().map(|current| hub_target(&current)).unwrap_or_default();

    window
        .navigate(url)
        .map_err(|error| format!("Could not open the library: {error}"))?;

    // The chip has to outlive the navigation that is still loading, so it is
    // re-applied for a few seconds; the script itself is idempotent.
    let script = BACK_CHIP.replace("__HUB__", &hub);
    let webview = window.clone();
    std::thread::spawn(move || {
        for _ in 0..20 {
            std::thread::sleep(std::time::Duration::from_millis(400));
            let _ = webview.eval(&script);
        }
    });

    Ok(())
}

/// The address the back chip returns to, given whatever URL the hub is showing.
///
/// A whole URL, never an origin. The hub is served over `tauri://localhost` on
/// macOS, which is not a special scheme, so the URL standard gives it an *opaque*
/// origin that serialises as the string `null`. Navigating to that resolves
/// against the Immich page that is loaded at the time and asks the server for
/// `/null`, which answers "Not found: /null - 404": a dead end, not the hub.
fn hub_target(current: &tauri::Url) -> String {
    let mut address = current.clone();
    address.set_query(None);
    address.set_fragment(None);
    let text = address.to_string();
    if text.is_empty() || text == "null" {
        String::new()
    } else {
        text
    }
}

/// Injected into every page this window loads; it draws nothing until the page is
/// the local server, where our own chrome no longer exists and the only way back
/// to the hub is history.
const BACK_CHIP: &str = r#"
(() => {
  const HUB = '__HUB__';
  if (!HUB || HUB === 'null') return;
  if (location.href.startsWith(HUB)) return;
  if (document.getElementById('hbd-back')) return;
  const chip = document.createElement('button');
  chip.id = 'hbd-back';
  chip.type = 'button';
  chip.textContent = '\u2190 Back to hub';
  chip.style.cssText = [
    'position:fixed','z-index:2147483647','bottom:14px','left:50%',
    'transform:translateX(-50%)',
    'padding:7px 12px','border-radius:999px','border:0','cursor:pointer',
    'font:500 12px/1 system-ui,sans-serif','color:#f4f2ff',
    'background:rgba(24,20,40,.82)','backdrop-filter:blur(10px)',
    'box-shadow:0 6px 20px rgba(0,0,0,.45),inset 0 0 0 1px rgba(255,255,255,.16)',
  ].join(';');
  chip.addEventListener('click', () => {
    try {
      location.href = HUB;
    } catch {
      location.replace(HUB);
    }
    // A WebKit build may refuse to leave an http page for a custom scheme without
    // raising anything. If that happened we are still on the server a moment
    // later, and the hub is the entry behind it in this window's history.
    setTimeout(() => { if (location.href.startsWith('http')) history.back(); }, 700);
  });
  const mount = () => document.body && document.body.appendChild(chip);
  document.body ? mount() : addEventListener('DOMContentLoaded', mount);
})();
"#;

#[tauri::command]
fn set_library_folder(path: String, state: State<'_, Arc<Shared>>) -> Result<StatusView, String> {
    let path = layout::plain(Path::new(&path));
    let folder = PathBuf::from(&path);
    // Someone who was running keeps running: the switch stops the old library and
    // starts the new one, so a folder change is not also a server stop.
    let was_running = state.runtime.lock().expect("runtime lock").desired;
    state
        .runtime
        .lock()
        .expect("runtime lock")
        .set_folder(&folder)?;

    {
        let mut settings = state.settings.lock().expect("settings lock");
        settings.library_folder = path;
        // The key belongs to an account in the old library. Carrying it over would
        // make imports fail against the new server while hiding the field that
        // asks for a working one; a fresh library issues its own key at sign-up.
        settings.api_key.clear();
        settings
            .save(&state.config_dir)
            .map_err(|error| format!("Could not save settings: {error}"))?;
    }

    if was_running {
        state.runtime.lock().expect("runtime lock").start();
    }

    Ok(snapshot(&state, Some("Library folder updated.".into())))
}

/// Whether a runtime root really contains something to run.
fn holds_runtime(root: &str) -> bool {
    let root = Path::new(root);
    root.join("pg").join("bin").is_dir()
        && root.join("immich").join("server").join("dist").join("main.js").is_file()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // A second launch focuses the first window instead of starting a rival
        // supervisor over the same data directory.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| PathBuf::from("."));

            let mut settings = Settings::load(&config_dir);
            // An install ships its own runtime beside the executable. A saved
            // path is only kept when it still holds one, so a build that moved
            // on, or a leftover path from a development copy, cannot leave the
            // app pointing at binaries that are not there any more.
            if let Ok(resources) = app.path().resource_dir() {
                let bundled = layout::plain(&resources.join("runtime"));
                if holds_runtime(&bundled) && !holds_runtime(&settings.runtime_root) {
                    settings.runtime_root = bundled;
                }
            }

            let layout = Layout::new(Path::new(&settings.library_folder));
            if let Err(error) = layout.create() {
                eprintln!("could not create the library layout: {error}");
            }

            // A previous hard kill leaves Postgres and node behind; take our own
            // children back before starting a new set.
            Runtime::reap(&layout);

            let mut watcher = watch::Watch::load(&config_dir);
            watcher.sync(&settings.watch_folder);

            let server_program = runtime::server_program(&settings);
            let shared = Arc::new(Shared {
                settings: Mutex::new(settings),
                runtime: Mutex::new(Runtime::default()),
                progress: Mutex::new(import::ImportProgress::default()),
                watch: Mutex::new(watcher),
                config_dir,
                firewall: Mutex::new(firewall::allowed(&server_program)),
            });
            app.manage(shared.clone());


            // The point of the app is that it is already running when it opens.
            shared.runtime.lock().expect("runtime lock").start();

            // The watched folder runs on its own thread: an upload can take a
            // while, and the supervisor's 400 ms tick must not wait for it.
            let watcher = shared.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_millis(2500));

                let settings = watcher.settings.lock().expect("settings lock").clone();
                let server_up = watcher
                    .runtime
                    .lock()
                    .expect("runtime lock")
                    .services
                    .iter()
                    .any(|service| service.id == "server" && service.state == runtime::State::Running);

                let pending = {
                    let mut watch = watcher.watch.lock().expect("watch lock");
                    watch.sync(&settings.watch_folder);
                    let waiting = if !watch.active() {
                        None
                    } else if !server_up {
                        Some("Waiting for the server to start.".to_string())
                    } else if settings.api_key.is_empty() {
                        Some("Waiting for an API key.".to_string())
                    } else {
                        None
                    };
                    let blocked = waiting.is_some();
                    watch.set_waiting(waiting);
                    if blocked {
                        Vec::new()
                    } else {
                        watch.scan(&Layout::own_media(Path::new(&settings.library_folder)))
                    }
                };

                for file in pending {
                    {
                        let mut watch = watcher.watch.lock().expect("watch lock");
                        watch.announce(&file);
                    }
                    // No lock is held across the request: the hub polls this
                    // state, and a 120 second upload would freeze its screen.
                    let outcome = import::upload(settings.server_port, &settings.api_key, &file);
                    let mut watch = watcher.watch.lock().expect("watch lock");
                    watch.record(&file, outcome);
                    watch.flush(&watcher.config_dir);
                }
            });

            let monitor = shared.clone();
            std::thread::spawn(move || loop {
                {
                    let settings = monitor.settings.lock().expect("settings lock").clone();
                    let layout = Layout::new(Path::new(&settings.library_folder));
                    if let Ok(mut runtime) = monitor.runtime.lock() {
                        runtime.tick(&settings, &layout);
                    }
                }
                std::thread::sleep(Duration::from_millis(400));
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            runtime_status,
            runtime_start,
            runtime_stop,
            set_library_folder,
            server_setup,
            create_admin,
            open_library,
            set_api_key,
            import_status,
            import_paths,
            logs_read,
            library_usage,
            watch_status,
            set_watch_folder,
            set_allow_phones,
            allow_firewall,
            phone_qr
        ])
        .build(tauri::generate_context!())
        .expect("error while building Immich Desktop")
        .run(|app_handle, event| {
            if matches!(event, RunEvent::Exit) {
                if let Some(shared) = app_handle.try_state::<Arc<Shared>>() {
                    if let Ok(mut runtime) = shared.runtime.lock() {
                        runtime.stop();
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::hub_target;

    /// The chip used to carry `origin()`, which is the literal string `null` for
    /// the `tauri:` scheme — the bug that sent the library to `/null` on the
    /// server, where the only thing waiting was a 404.
    #[test]
    fn the_hub_address_is_a_url_not_an_opaque_origin() {
        let hub = tauri::Url::parse("tauri://localhost/index.html").expect("parses");
        assert_eq!(hub_target(&hub), "tauri://localhost/index.html");
        assert_ne!(hub_target(&hub), "null");
    }

    /// A hash route belongs to the hub's own router; carrying it back would land
    /// on a page the user never visited from the library.
    #[test]
    fn the_hub_address_drops_query_and_fragment() {
        let hub = tauri::Url::parse("http://tauri.localhost/#/overview?tab=1").expect("parses");
        assert_eq!(hub_target(&hub), "http://tauri.localhost/");
    }
}
