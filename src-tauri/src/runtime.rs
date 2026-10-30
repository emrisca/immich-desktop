//! The supervisor. It owns three children in dependency order — Postgres, then
//! the Immich server, then machine learning — and it is the only thing that
//! starts or stops them.
//!
//! Rules worth keeping:
//!  - Postgres starts first; the server is not spawned until Postgres answers.
//!  - A child that exits on its own is a crash: restart it, but give up after
//!    `MAX_RESTARTS` and say why, rather than looping forever behind a spinner.
//!  - `desired` is the user's intent. Nothing restarts while it is false, which
//!    is what makes Stop actually stick.
//!  - Children are killed as a process tree: `node dist/main.js` forks the API
//!    and the worker, so killing the parent alone would leak them.

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::layout::{check_folder, Layout};
use crate::probe;
use crate::settings::Settings;

const BOOT_TIMEOUT_DATABASE: Duration = Duration::from_secs(30);
const BOOT_TIMEOUT_SERVER: Duration = Duration::from_secs(120);
const MAX_RESTARTS: u32 = 3;

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Stopped,
    Starting,
    Running,
    Failed,
    Absent,
}

pub struct Service {
    pub id: &'static str,
    pub name: &'static str,
    pub state: State,
    pub detail: String,
    pub pid: Option<u32>,
    child: Option<Child>,
    restarts: u32,
    retry_at: Option<Instant>,
    started_at: Option<Instant>,
    error: Option<String>,
}

impl Service {
    fn new(id: &'static str, name: &'static str, detail: &str) -> Self {
        Self {
            id,
            name,
            state: State::Stopped,
            detail: detail.to_string(),
            pid: None,
            child: None,
            restarts: 0,
            retry_at: None,
            started_at: None,
            error: None,
        }
    }

    pub fn port(&self, settings: &Settings) -> Option<u16> {
        match self.id {
            "database" => Some(settings.database_port),
            "server" => Some(settings.server_port),
            "ml" => Some(settings.ml_port),
            _ => None,
        }
    }

    pub fn health_text(&self) -> String {
        match self.state {
            State::Running => self.detail.clone(),
            State::Failed => self
                .error
                .clone()
                .unwrap_or_else(|| "Stopped unexpectedly.".into()),
            _ => self.detail.clone(),
        }
    }
}

pub struct Runtime {
    pub desired: bool,
    pub services: Vec<Service>,
    database_ready: bool,
    /// Set on the first spawn so `stop` can remove pid files without needing the
    /// settings that produced them.
    logs_dir: Option<PathBuf>,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            desired: false,
            services: vec![
                Service::new("database", "Database", "Embedded Postgres 17 · pgvector"),
                Service::new("server", "Immich server", "API and job worker"),
                Service::new("ml", "Machine learning", "Not installed"),
            ],
            database_ready: false,
            logs_dir: None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceView {
    pub id: String,
    pub name: String,
    pub state: State,
    pub detail: String,
    pub port: Option<u16>,
    pub pid: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusView {
    pub services: Vec<ServiceView>,
    pub folder: String,
    pub desired: bool,
    pub server_port: u16,
    pub lan_address: Option<String>,
    pub runtime_root: String,
    pub message: Option<String>,
    pub initialised: bool,
    /// Whether an Import API key is stored; the hub asks for one when it is not.
    pub api_key_set: bool,
    /// Whether the server listens beyond this machine.
    pub allow_phones: bool,
    /// Whether Windows will let the phone's packets reach the server.
    pub firewall: bool,
}

impl Runtime {
    pub fn view(&self, settings: &Settings, layout: &Layout, message: Option<String>) -> StatusView {
        StatusView {
            services: self
                .services
                .iter()
                .map(|service| ServiceView {
                    id: service.id.to_string(),
                    name: service.name.to_string(),
                    state: service.state,
                    detail: service.health_text(),
                    port: service.port(settings),
                    pid: service.pid,
                })
                .collect(),
            folder: settings.library_folder.clone(),
            desired: self.desired,
            server_port: settings.server_port,
            lan_address: probe::lan_address(),
            runtime_root: settings.runtime_root.clone(),
            message,
            initialised: layout.is_initialised(),
            api_key_set: !settings.api_key.is_empty(),
            allow_phones: settings.allow_phones,
            // Filled in by the shell, which owns the cached firewall state.
            firewall: false,
        }
    }

    /// Kill whatever a previous run left behind. Only the recorded pid is
    /// touched, and only when it still belongs to the expected executable, so a
    /// recycled pid cannot take an unrelated process down.
    pub fn reap(layout: &Layout) {
        // The pid file is named after the service id, not after its executable.
        for (name, expected) in [("database", "postgres"), ("server", "node"), ("ml", "node")] {
            let path = layout.pid_file(name);
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            if let Ok(pid) = text.trim().parse::<u32>() {
                let matches = process_name(pid)
                    .is_some_and(|actual| actual.trim_end_matches(".exe") == expected);
                if matches {
                    eprintln!("reaping orphaned {name} ({pid}) from a previous run");
                    kill_tree(pid);
                }
            }
            let _ = std::fs::remove_file(&path);
        }
    }

    pub fn start(&mut self) {
        for service in &mut self.services {
            service.restarts = 0;
            service.error = None;
            service.retry_at = None;
            if service.state == State::Failed {
                service.state = State::Stopped;
            }
        }
        self.desired = true;
    }

    /// Stop means stopped: children die now, and nothing restarts them.
    pub fn stop(&mut self) {
        self.desired = false;
        let logs = self.logs_dir.clone();
        for service in &mut self.services {
            Self::kill(service, logs.as_deref());
            service.detail = "Stopped".to_string();
        }
        self.database_ready = false;
    }

    fn kill(service: &mut Service, logs_dir: Option<&Path>) {
        if let Some(child) = service.child.take() {
            kill_tree(child.id());
        }
        if let Some(pid) = service.pid.take() {
            kill_tree(pid);
        }
        if let Some(dir) = logs_dir {
            let _ = std::fs::remove_file(dir.join(format!("{}.pid", service.id)));
        }
        service.state = State::Stopped;
        service.started_at = None;
    }

    /// One step of the state machine, called from the monitor thread.
    pub fn tick(&mut self, settings: &Settings, layout: &Layout) {
        if !Settings::has_ml(settings) {
            self.services[2].state = State::Absent;
            self.services[2].detail = "Not installed".to_string();
        }

        if !self.desired {
            return;
        }

        self.tick_database(settings, layout);
        // Before the server: Immich health-checks its ML server as soon as it
        // starts, and a service that is already listening logs no warnings.
        self.tick_ml(settings);
        self.tick_server(settings, layout);
    }

    fn tick_ml(&mut self, settings: &Settings) {
        match self.services[2].state {
            State::Running => {
                if let Some(code) = self.take_exit(2) {
                    self.on_crash(2, format!("Machine learning exited (code {code})."));
                }
            }
            State::Starting => {
                if probe::http_ok(settings.ml_port, "/ping") {
                    let service = &mut self.services[2];
                    service.state = State::Running;
                    service.detail = "CLIP ViT-B/32 · smart search".to_string();
                    service.restarts = 0;
                } else if self.services[2]
                    .started_at
                    .is_some_and(|at| at.elapsed() > BOOT_TIMEOUT_SERVER)
                {
                    self.kill_service(2);
                    self.on_crash(2, "Machine learning did not answer in time.".into());
                }
            }
            State::Absent => {}
            _ => {
                if self.can_restart(2) {
                    if let Err(error) = self.spawn_ml(settings) {
                        self.on_crash(2, format!("Could not start machine learning: {error}"));
                    }
                }
            }
        }
    }

    fn spawn_ml(&mut self, settings: &Settings) -> io::Result<()> {
        let dir = Layout::ml_dir(settings);
        let entry = dir.join("index.mjs");
        if !entry.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("model service missing at {}", entry.display()),
            ));
        }

        reclaim_port(settings.ml_port, "node");
        let log = self
            .logs_dir
            .clone()
            .map(|dir| {
                std::fs::create_dir_all(&dir)?;
                std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(dir.join("ml.log"))
            })
            .transpose()?;

        let mut command = Command::new(resolve_node(settings));
        command
            .arg(&entry)
            .current_dir(&dir)
            .env("ML_PORT", settings.ml_port.to_string())
            .env("NODE_ENV", "production")
            .stdin(Stdio::null());
        match &log {
            Some(file) => {
                command.stdout(Stdio::from(file.try_clone()?));
                command.stderr(Stdio::from(file.try_clone()?));
            }
            None => {
                command.stdout(Stdio::null());
                command.stderr(Stdio::null());
            }
        }
        no_console(&mut command);

        let child = command.spawn()?;
        let service = &mut self.services[2];
        service.pid = Some(child.id());
        service.child = Some(child);
        service.state = State::Starting;
        service.detail = "Loading CLIP".to_string();
        service.started_at = Some(Instant::now());
        service.retry_at = None;
        Ok(())
    }

    fn tick_database(&mut self, settings: &Settings, layout: &Layout) {
        let port = settings.database_port;

        match self.services[0].state {
            State::Running => {
                if let Some(code) = self.take_exit(0) {
                    self.database_ready = false;
                    self.on_crash(0, format!("Postgres exited (code {code})."));
                }
            }
            State::Starting => {
                if probe::tcp_open(port) {
                    let service = &mut self.services[0];
                    service.state = State::Running;
                    service.detail = "Embedded Postgres 17 · pgvector".to_string();
                    service.restarts = 0;
                } else if self.services[0]
                    .started_at
                    .is_some_and(|at| at.elapsed() > BOOT_TIMEOUT_DATABASE)
                {
                    self.kill_service(0);
                    self.on_crash(0, "Postgres did not accept connections in time.".into());
                }
            }
            _ => {
                if self.can_restart(0) {
                    if let Err(error) = self.spawn_database(settings, layout) {
                        self.on_crash(0, format!("Could not start Postgres: {error}"));
                    }
                }
            }
        }
    }

    fn tick_server(&mut self, settings: &Settings, layout: &Layout) {
        let database_running = self.services[0].state == State::Running;

        if database_running && !self.database_ready {
            match ensure_database(settings) {
                Ok(true) => self.database_ready = true,
                // The port is open but the cluster is still replaying its WAL.
                // That is normal after a hard stop: wait instead of failing.
                Ok(false) => {
                    let waited = self.services[0].started_at.map(|at| at.elapsed());
                    if waited.is_some_and(|elapsed| elapsed > BOOT_TIMEOUT_DATABASE) {
                        self.kill_service(0);
                        self.on_crash(0, "Postgres never accepted connections.".into());
                    }
                    self.services[1].detail = "Waiting for the database".to_string();
                    return;
                }
                Err(error) => {
                    self.on_crash(1, format!("Could not prepare the database: {error}"));
                    return;
                }
            }
        }

        let port = settings.server_port;

        match self.services[1].state {
            State::Running => {
                if let Some(code) = self.take_exit(1) {
                    self.on_crash(1, format!("The server exited (code {code})."));
                }
            }
            State::Starting => {
                if probe::http_ok(port, "/api/server/ping") {
                    let service = &mut self.services[1];
                    service.state = State::Running;
                    service.detail = "API and job worker".to_string();
                    service.restarts = 0;
                } else if self.services[1]
                    .started_at
                    .is_some_and(|at| at.elapsed() > BOOT_TIMEOUT_SERVER)
                {
                    self.kill_service(1);
                    self.on_crash(
                        1,
                        "The server did not answer on its port in time. Check logs/server.log.".into(),
                    );
                }
            }
            _ => {
                if database_running && self.database_ready && self.can_restart(1) {
                    if let Err(error) = self.spawn_server(settings, layout) {
                        self.on_crash(1, format!("Could not start the server: {error}"));
                    }
                }
            }
        }
    }

    /// Reap a child that has exited, returning its exit code as text.
    fn take_exit(&mut self, index: usize) -> Option<String> {
        let service = &mut self.services[index];
        let status = service.child.as_mut()?.try_wait().ok().flatten()?;
        service.child = None;
        service.pid = None;
        Some(
            status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "signal".into()),
        )
    }

    fn kill_service(&mut self, index: usize) {
        let logs = self.logs_dir.clone();
        Self::kill(&mut self.services[index], logs.as_deref());
    }

    fn can_restart(&mut self, index: usize) -> bool {
        let service = &mut self.services[index];
        if service.state == State::Running || service.state == State::Starting {
            return false;
        }
        if service.restarts > MAX_RESTARTS {
            service.state = State::Failed;
            service.error.get_or_insert_with(|| {
                format!("Gave up after {} restarts.", MAX_RESTARTS)
            });
            return false;
        }
        match service.retry_at {
            Some(at) => Instant::now() >= at,
            None => true,
        }
    }

    /// Record a crash, then either back off for a retry or give up loudly.
    fn on_crash(&mut self, index: usize, error: String) {
        let service = &mut self.services[index];
        eprintln!("{}: {error}", service.name);
        service.error = Some(error);
        service.restarts += 1;
        service.started_at = None;

        if service.restarts > MAX_RESTARTS {
            service.state = State::Failed;
            service.detail = service
                .error
                .clone()
                .unwrap_or_else(|| "Failed.".to_string());
            service.retry_at = None;
        } else {
            let backoff = Duration::from_secs(1u64 << (service.restarts - 1).min(4));
            service.state = State::Stopped;
            service.detail = "Restarting".to_string();
            service.retry_at = Some(Instant::now() + backoff);
        }
    }

    fn spawn_database(&mut self, settings: &Settings, layout: &Layout) -> io::Result<()> {
        layout.create()?;
        self.logs_dir = Some(layout.logs.clone());
        reclaim_port(settings.database_port, "postgres");
        if !layout.is_initialised() {
            init_cluster(settings, layout)?;
        }

        let bin = pg_bin(settings);
        let mut command = Command::new(exe(&bin, "postgres"));
        command
            .arg("-D")
            .arg(&layout.database)
            .arg("-p")
            .arg(settings.database_port.to_string())
            .current_dir(&bin)
            .stdin(Stdio::null())
            .stdout(Stdio::from(layout.log_file("postgres")?))
            .stderr(Stdio::from(layout.log_file("postgres")?))
            // Launched from Finder the app inherits no locale, and PostgreSQL 17
            // on macOS then aborts with "postmaster became multithreaded during
            // startup" before it ever opens the port — a dead database with a
            // stack trace that says nothing about locales. The cluster is made
            // with `--locale=C`, so C is both the matching value and one that is
            // always valid wherever the app is run.
            .env("LC_ALL", "C")
            .env("LANG", "C");
        no_console(&mut command);

        let child = command.spawn()?;
        let _ = std::fs::write(layout.pid_file("database"), child.id().to_string());
        let service = &mut self.services[0];
        service.pid = Some(child.id());
        service.child = Some(child);
        service.state = State::Starting;
        service.detail = "Starting".to_string();
        service.started_at = Some(Instant::now());
        service.retry_at = None;
        Ok(())
    }

    fn spawn_server(&mut self, settings: &Settings, layout: &Layout) -> io::Result<()> {
        layout.create()?;
        self.logs_dir = Some(layout.logs.clone());
        let server_dir = Layout::server_dir(settings);
        let entry = server_dir.join("dist").join("main.js");
        if !entry.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("server build missing at {}", entry.display()),
            ));
        }

        reclaim_port(settings.server_port, "node");

        // Immich serves its web app from `$IMMICH_BUILD_DATA/www`, and only when
        // that folder exists; without it the server is API-only. The desktop app
        // ships the built web UI beside the runtime for exactly this.
        let build_data = Path::new(&settings.runtime_root).to_path_buf();
        let has_web = build_data.join("www").join("index.html").is_file();

        let node = resolve_node(settings);
        let mut command = Command::new(node);
        command
            .arg(&entry)
            .current_dir(&server_dir)
            .env("NODE_ENV", "production")
            // Phones need this bound to every interface; otherwise the server is
            // only reachable from this machine and the address on the hub is a
            // lie. Postgres stays on loopback either way.
            .env(
                "IMMICH_HOST",
                if settings.allow_phones { "0.0.0.0" } else { "127.0.0.1" },
            )
            .env("IMMICH_PORT", settings.server_port.to_string())
            .env("IMMICH_MEDIA_LOCATION", &layout.media)
            .env("DB_HOSTNAME", "127.0.0.1")
            .env("DB_PORT", settings.database_port.to_string())
            .env("DB_USERNAME", "postgres")
            .env("DB_PASSWORD", "postgres")
            .env("DB_DATABASE_NAME", "immich")
            .env("DB_VECTOR_EXTENSION", "pgvector")
            .stdin(Stdio::null())
            .stdout(Stdio::from(layout.log_file("server")?))
            .stderr(Stdio::from(layout.log_file("server")?));
        no_console(&mut command);

        if has_web {
            command.env("IMMICH_BUILD_DATA", &build_data);
        }

        // Immich finds ffmpeg and ffprobe by bare name, so whatever is on the
        // machine's PATH wins — and a stale or unrelated ffprobe there makes every
        // video thumbnail fail. The runtime's own pair goes first.
        let ffmpeg_bin = Path::new(&settings.runtime_root).join("ffmpeg").join("bin");
        if ffmpeg_bin.is_dir() {
            if let Some(path) = prepend_path(&ffmpeg_bin) {
                command.env("PATH", path);
            }
        }

        // Without the ML service every smart-search, face and OCR job would be
        // queued and fail on connection refused, once per asset, forever.
        if Settings::has_ml(settings) {
            command
                .env("IMMICH_MACHINE_LEARNING_ENABLED", "true")
                .env(
                    "IMMICH_MACHINE_LEARNING_URL",
                    format!("http://127.0.0.1:{}", settings.ml_port),
                );
        } else {
            command.env("IMMICH_MACHINE_LEARNING_ENABLED", "false");
        }

        let child = command.spawn()?;
        let _ = std::fs::write(layout.pid_file("server"), child.id().to_string());
        let service = &mut self.services[1];
        service.pid = Some(child.id());
        service.child = Some(child);
        service.state = State::Starting;
        service.detail = "Starting".to_string();
        service.started_at = Some(Instant::now());
        service.retry_at = None;
        Ok(())
    }

    /// Apply a new library folder: validate, create the layout, and stop the
    /// runtime so nothing is running against the old path.
    pub fn set_folder(&mut self, folder: &Path) -> Result<(), String> {
        check_folder(folder)?;
        let layout = Layout::new(folder);
        layout
            .create()
            .map_err(|error| format!("Could not create the folder layout: {error}"))?;
        self.stop();
        Ok(())
    }
}

/// `dir` followed by the inherited PATH, using the platform's separator.
fn prepend_path(dir: &Path) -> Option<std::ffi::OsString> {
    let existing = std::env::var_os("PATH").unwrap_or_default();
    std::env::join_paths(std::iter::once(dir.to_path_buf()).chain(std::env::split_paths(&existing))).ok()
}

fn pg_bin(settings: &Settings) -> PathBuf {
    Path::new(&settings.runtime_root).join("pg").join("bin")
}

fn exe(dir: &Path, name: &str) -> PathBuf {
    if cfg!(windows) {
        dir.join(format!("{name}.exe"))
    } else {
        dir.join(name)
    }
}

/// The executable that listens on the LAN, and therefore the program a firewall
/// rule has to name.
pub fn server_program(settings: &Settings) -> PathBuf {
    resolve_node(settings)
}

fn resolve_node(settings: &Settings) -> PathBuf {
    if !settings.runtime_root.is_empty() {
        let bundled = exe(&Path::new(&settings.runtime_root).join("node"), "node");
        if bundled.is_file() {
            return bundled;
        }
    }
    PathBuf::from("node")
}

/// `initdb` once per cluster. Trust auth on loopback only, which is why the
/// server also binds to 127.0.0.1.
fn init_cluster(settings: &Settings, layout: &Layout) -> io::Result<()> {
    layout.create()?;
    let bin = pg_bin(settings);
    let mut command = Command::new(exe(&bin, "initdb"));
    command
        .arg("-D")
        .arg(&layout.database)
        .args(["-U", "postgres", "-A", "trust", "-E", "UTF8", "--locale=C"])
        .current_dir(&bin)
        .stdin(Stdio::null())
        .stdout(Stdio::from(layout.log_file("postgres")?))
        .stderr(Stdio::from(layout.log_file("postgres")?));
    no_console(&mut command);

    let status = command.status()?;
    if !status.success() {
        return Err(io::Error::other(format!(
            "initdb failed with {status}; see logs/postgres.log"
        )));
    }
    Ok(())
}

/// Create the `immich` database the first time; Immich migrates its own schema.
///
/// Returns `false` while the cluster is still coming up. A Postgres that has
/// opened its port can still answer "the database system is starting up", and
/// treating that as "no database" used to run `createdb` into a cluster that was
/// not ready — which then reported "database already exists" and failed the row.
fn ensure_database(settings: &Settings) -> io::Result<bool> {
    let bin = pg_bin(settings);
    let port = settings.database_port.to_string();

    match database_exists(&bin, &port)? {
        Some(true) => return Ok(true),
        None => return Ok(false),
        Some(false) => {}
    }

    let mut create = Command::new(exe(&bin, "createdb"));
    create
        .args(["-h", "127.0.0.1", "-p", &port, "-U", "postgres", "immich"])
        .stdin(Stdio::null());
    no_console(&mut create);
    let output = create.output()?;
    if output.status.success() {
        return Ok(true);
    }

    // Losing the race is not fatal if the database is there now.
    match database_exists(&bin, &port)? {
        Some(true) => Ok(true),
        None => Ok(false),
        Some(false) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(io::Error::other(format!(
                "createdb failed: {}",
                stderr.trim()
            )))
        }
    }
}

/// `Some(true)` the database exists, `Some(false)` it does not, `None` the
/// cluster is not accepting connections yet.
fn database_exists(bin: &Path, port: &str) -> io::Result<Option<bool>> {
    let mut query = Command::new(exe(bin, "psql"));
    query
        .args([
            "-h",
            "127.0.0.1",
            "-p",
            port,
            "-U",
            "postgres",
            "-d",
            "postgres",
            "-tAc",
            "SELECT 1 FROM pg_database WHERE datname='immich'",
        ])
        .stdin(Stdio::null());
    no_console(&mut query);

    let output = query.output()?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let warming_up = stderr.contains("starting up")
            || stderr.contains("not yet accepting")
            || stderr.contains("the database system is");
        if warming_up {
            return Ok(None);
        }
        return Err(io::Error::other(format!(
            "psql could not reach the database: {}",
            stderr.trim()
        )));
    }
    Ok(Some(String::from_utf8_lossy(&output.stdout).trim() == "1"))
}

/// A hard kill of the app (Task Manager, a panic, a power cut) can leave a
/// child holding its port, and the next launch then cannot bind. Before each
/// spawn, take our own port back — but only from a process whose image is the
/// one we started, so an unrelated app on a recycled port is never killed.
fn reclaim_port(port: u16, expected: &str) {
    let Some(pid) = listener_pid(port) else {
        return;
    };
    let ours = match process_name(pid) {
        Some(name) => name.trim_end_matches(".exe") == expected,
        // Windows always answers; elsewhere there is no cheap image lookup we can
        // rely on across glibc and macOS, and the port is ours by contract.
        None => !cfg!(windows),
    };
    if !ours {
        eprintln!("port {port} is held by pid {pid}, which is not {expected}; leaving it alone");
        return;
    }
    eprintln!("reclaiming port {port} from a stale {expected} ({pid})");
    kill_tree(pid);
    std::thread::sleep(Duration::from_millis(300));
}

#[cfg(windows)]
fn listener_pid(port: u16) -> Option<u32> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = Command::new("netstat")
        .args(["-ano", "-p", "TCP"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let wanted = format!(":{port}");
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 5 || !cols[0].eq_ignore_ascii_case("TCP") {
            continue;
        }
        if cols[1].ends_with(&wanted) && cols[3].eq_ignore_ascii_case("LISTENING") {
            return cols[4].parse().ok();
        }
    }
    None
}

#[cfg(not(windows))]
fn listener_pid(port: u16) -> Option<u32> {
    // `ss` ships with iproute2 on every distribution we target; macOS has lsof.
    let attempts: [(&str, Vec<String>); 2] = [
        ("ss", vec!["-ltnpH".into(), format!("sport = :{port}")]),
        (
            "lsof",
            vec!["-nP".into(), format!("-iTCP:{port}"), "-sTCP:LISTEN".into(), "-t".into()],
        ),
    ];
    for (program, args) in attempts {
        let Ok(output) = Command::new(program).args(&args).output() else {
            continue;
        };
        let text = String::from_utf8_lossy(&output.stdout);
        if program == "lsof" {
            if let Some(pid) = text.lines().next().and_then(|line| line.trim().parse().ok()) {
                return Some(pid);
            }
            continue;
        }
        if let Some(idx) = text.find("pid=") {
            let digits: String = text[idx + 4..]
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if let Ok(pid) = digits.parse() {
                return Some(pid);
            }
        }
    }
    None
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

#[cfg(not(windows))]
fn kill_tree(pid: u32) {
    let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
}

/// Only used to make sure a recorded pid still belongs to the process we started.
#[cfg(windows)]
fn process_name(pid: u32) -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next()?.trim();
    Some(line.split('"').nth(1)?.to_lowercase())
}

#[cfg(not(windows))]
fn process_name(_pid: u32) -> Option<String> {
    None
}

#[cfg(windows)]
fn no_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn no_console(_command: &mut Command) {}
