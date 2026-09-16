// Sidecar management: start/stop/health-check the Python FastAPI backend

use std::fs::OpenOptions;
use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, UNIX_EPOCH};
use tauri::Manager;

/// The running backend process, shared with the window-close handler.
///
/// It lives in a slot rather than on the monitoring thread's stack because
/// shutdown has to reach it from the Tauri event loop — see `terminate_backend`.
pub type SharedChild = Arc<Mutex<Option<Child>>>;

fn show_main_window(app_handle: &tauri::AppHandle, reload: bool) {
    if let Some(window) = app_handle.get_webview_window("main") {
        if reload {
            let _ = window.reload();
        }
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Stop the backend, children included.
///
/// `Child::kill` only signals the direct child. PyInstaller's bootloader
/// re-execs itself, so the interpreter that actually serves 17177 can survive
/// as an orphan — the next launch then finds a stale backend answering
/// /health, which `start_backend` has to reason about (see the reuse guards
/// there). `taskkill /T` walks the tree instead.
fn terminate(process: &mut Child) {
    #[cfg(windows)]
    {
        let pid = process.id().to_string();
        let walked_tree = Command::new("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if walked_tree {
            let _ = process.wait();
            return;
        }
        // Fall through to the portable path when taskkill is unavailable.
    }

    let _ = process.kill();
    let _ = process.wait();
}

/// Stop the backend from outside the monitoring thread, on shutdown.
///
/// The monitor loop cannot be trusted for this. Closing the window ends the
/// Tauri event loop, and the process exits while that thread is still asleep in
/// its one-second poll interval, so a `running = false` check there never runs.
/// The backend then survives as an orphan holding port 17177: the next launch
/// finds a backend already answering /health, and — per the reuse rules in
/// `start_backend` — a stale release sidecar is exactly the thing that must not
/// be adopted, because it still holds the project list it read at its own
/// startup and would write that back over the real data.
///
/// Called synchronously from the window-close handler, before the process can
/// exit.
pub fn terminate_backend(child_slot: &SharedChild) {
    let taken = match child_slot.lock() {
        Ok(mut guard) => guard.take(),
        Err(_) => None,
    };
    if let Some(mut process) = taken {
        terminate(&mut process);
        println!("[sidecar] Backend process terminated on shutdown");
    }
}

/// Start the Python backend sidecar process
/// In dev mode: runs `python -m uvicorn src.apps.comic_gen.api:app --host 0.0.0.0 --port 17177`
/// In production: runs the bundled PyInstaller binary
pub fn start_backend(
    app_handle: &tauri::AppHandle,
    running: Arc<AtomicBool>,
    child_slot: SharedChild,
) {
    if let Some(health) = backend_health() {
        // "Healthy on 17177" is not the same as "the backend this build would
        // run". A leftover release sidecar — or an orphan whose app already
        // quit — answers /health too, and it serves whatever code it was built
        // from, plus the project list it read into memory back then; on its
        // next save that stale list is written back over the real data. So dev
        // adopts only a dev backend, release only a sidecar matching its own
        // mtime.
        let reusable = if cfg!(debug_assertions) {
            listener_is_dev_backend()
        } else {
            backend_matches_current_build(app_handle, &health)
        };
        if reusable {
            running.store(true, Ordering::SeqCst);
            println!("[sidecar] Reusing matching backend on port 17177");
            show_main_window(app_handle, cfg!(debug_assertions));
            return;
        }
        if !terminate_stale_backend(&health) {
            eprintln!(
                "[sidecar] Port 17177 is occupied by a backend that cannot be safely replaced"
            );
            show_main_window(app_handle, false);
            return;
        }
    }

    let child = if cfg!(debug_assertions) {
        // Dev mode: run Python directly
        start_dev_backend()
    } else {
        // Production: use bundled sidecar binary
        start_prod_backend(app_handle)
    };

    match child {
        Ok(process) => {
            running.store(true, Ordering::SeqCst);
            println!("[sidecar] Backend process started (pid: {})", process.id());
            if let Ok(mut guard) = child_slot.lock() {
                *guard = Some(process);
            }

            // The unpacked runtime should expose its health endpoint promptly.
            let ready = wait_for_backend_ready(150); // 150 * 200ms = 30s
            if ready {
                println!("[sidecar] Backend is ready!");
            } else {
                let message = "Backend failed to become ready within 30s";
                eprintln!("[sidecar] {message}");
                append_sidecar_log(message);
            }
            // Never reload here. This used to pass `ready`, so every launch
            // booted the frontend twice: once against a backend that was still
            // starting, then again after reload(). The second boot crashes the
            // Next.js App Router — createInitialRouterState reads a module-level
            // `initialParallelRoutes` that an effect nulls after the first
            // mount, and fillLazyItemsTillLeafWithHead calls .get() on it
            // without a null guard. The user sees "Application error: a
            // client-side exception has occurred" on a window that has no
            // console to check.
            //
            // The reload was redundant anyway: the frontend's BackendGate polls
            // the backend itself and renders the app once it answers. Dev keeps
            // its reload on the reuse path above, where a reset is actually
            // wanted.
            show_main_window(app_handle, false);

            // Backstop for a backend that dies on its own.
            //
            // This loop deliberately does NOT own shutdown: ending the window
            // ends the Tauri event loop, and the process exits while this
            // thread is still asleep in its poll interval — so a `running =
            // false` check here is never reached in time. The window handler
            // calls `terminate_backend` synchronously instead; all this has to
            // do is notice a backend that quit by itself and never hold the
            // lock across a sleep.
            loop {
                thread::sleep(Duration::from_secs(1));

                let mut guard = match child_slot.lock() {
                    Ok(guard) => guard,
                    Err(_) => break,
                };
                let Some(process) = guard.as_mut() else {
                    // Already terminated by the window handler.
                    break;
                };

                if !running.load(Ordering::SeqCst) {
                    terminate(process);
                    *guard = None;
                    println!("[sidecar] Backend process terminated");
                    break;
                }

                match process.try_wait() {
                    Ok(Some(status)) => {
                        *guard = None;
                        eprintln!("[sidecar] Backend exited with status: {:?}", status);
                        running.store(false, Ordering::SeqCst);
                        break;
                    }
                    Ok(None) => {}
                    Err(error) => {
                        eprintln!("[sidecar] Error checking backend status: {}", error);
                        break;
                    }
                }
            }
        }
        Err(e) => {
            eprintln!("[sidecar] Failed to start backend: {}", e);
            append_sidecar_log(&format!("Failed to start backend: {e}"));
            show_main_window(app_handle, false);
        }
    }
}

/// Mirrors `src/utils/__init__.py::get_user_data_dir`.
///
/// The backend resolves all of its runtime paths relatively (`output/projects.json`,
/// `output/assets/...`, the `/files` mounts), so its cwd has to be the user data
/// dir. Dev mode used to inherit the repo root instead, producing a second,
/// invisible `projects.json` that the packaged build never saw.
pub(crate) fn user_data_dir() -> std::path::PathBuf {
    let configured = std::env::var("ONEOKSTUDIO_DATA_DIR").unwrap_or_default();
    let trimmed = configured.trim();
    if let Some(rest) = trimmed.strip_prefix("~/") {
        if let Some(home) = home_dir() {
            return home.join(rest);
        }
    }
    if !trimmed.is_empty() {
        return std::path::PathBuf::from(trimmed);
    }
    home_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(".1okstudio")
}

/// The user's home directory, per platform.
///
/// `HOME` is a POSIX convention; Windows sets `USERPROFILE`, and `HOME` is
/// usually absent. Reading only `HOME` therefore sent the data dir to
/// `%TEMP%\.1okstudio` on Windows — the app came up looking like it had lost
/// every project, and the real data was still sitting in the profile.
fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
}

/// Interpreter used by `tauri dev`.
///
/// The repo's own venv comes first. A GUI-launched process inherits no shell
/// PATH, so on Windows a bare `python` is typically missing (the launcher is
/// `py`) and on macOS it resolves to the system python — neither has the
/// project's dependencies.
fn dev_python(project_root: &std::path::Path) -> std::path::PathBuf {
    let venv = if cfg!(windows) {
        project_root.join(".venv").join("Scripts").join("python.exe")
    } else {
        project_root.join(".venv").join("bin").join("python")
    };
    if venv.is_file() {
        return venv;
    }
    std::path::PathBuf::from(if cfg!(windows) { "python" } else { "python3" })
}

fn start_dev_backend() -> Result<Child, std::io::Error> {
    let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has no parent directory");
    let data_dir = user_data_dir();
    std::fs::create_dir_all(&data_dir)?;
    Command::new(dev_python(project_root))
        .current_dir(&data_dir)
        .args([
            "-m",
            "uvicorn",
            // cwd is the data dir now, so the repo has to be added to sys.path.
            "--app-dir",
        ])
        .arg(project_root)
        .args([
            "--host",
            "0.0.0.0",
            "--port",
            "17177",
            "src.apps.comic_gen.api:app",
        ])
        .spawn()
}

fn start_prod_backend(app_handle: &tauri::AppHandle) -> Result<Child, std::io::Error> {
    let log_path = sidecar_log_path();
    if let Some(parent) = log_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)?;
    let stderr = stdout.try_clone()?;

    let mut command = Command::new(prod_sidecar_path(app_handle)?);
    command
        .arg("--port")
        .arg("17177")
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));

    // The sidecar is a PyInstaller `--console` build. The main binary is
    // windows_subsystem = "windows", but a spawned process is not, so Windows
    // gives the backend a console window of its own and a black box appears
    // alongside the app. Output still reaches the log file via the handles
    // above; only the console is suppressed.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command.spawn()
}

fn prod_sidecar_path(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, std::io::Error> {
    // PyInstaller appends the platform's executable suffix, and the bundle
    // resource list has to name the same file (see build_tauri_windows.ps1).
    let relative = if cfg!(windows) {
        "1okstudio-backend/1okstudio-backend.exe"
    } else {
        "1okstudio-backend/1okstudio-backend"
    };
    app_handle
        .path()
        .resource_dir()
        .map(|path| path.join(relative))
        .map_err(std::io::Error::other)
}

pub fn sidecar_log_path() -> std::path::PathBuf {
    user_data_dir().join("logs/sidecar.log")
}

fn append_sidecar_log(message: &str) {
    if let Ok(mut log) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(sidecar_log_path())
    {
        let _ = writeln!(log, "[sidecar] {message}");
    }
}

fn backend_health() -> Option<serde_json::Value> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
        .ok()?;
    client
        .get("http://127.0.0.1:17177/health")
        .send()
        .ok()?
        .json()
        .ok()
}

fn same_build(reported: Option<f64>, expected: Option<f64>) -> bool {
    matches!((reported, expected), (Some(a), Some(b)) if (a - b).abs() < 1.0)
}

fn backend_matches_current_build(
    app_handle: &tauri::AppHandle,
    health: &serde_json::Value,
) -> bool {
    let reported = health.get("sidecar_mtime").and_then(|value| value.as_f64());
    let expected = prod_sidecar_path(app_handle)
        .ok()
        .and_then(|path| path.metadata().ok())
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs_f64());
    same_build(reported, expected)
}

fn terminate_stale_backend(health: &serde_json::Value) -> bool {
    let pid = health
        .get("pid")
        .and_then(|value| value.as_u64())
        .or_else(listener_pid);
    let Some(pid) = pid else { return false };
    if !process_command(pid).contains("1okstudio-backend") {
        return false;
    }
    let Ok(status) = Command::new("/bin/kill").arg(pid.to_string()).status() else {
        return false;
    };
    if !status.success() {
        return false;
    }
    for _ in 0..50 {
        if backend_health().is_none() {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

fn listener_pid() -> Option<u64> {
    let output = Command::new("/usr/sbin/lsof")
        .args(["-tiTCP:17177", "-sTCP:LISTEN"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()?
        .parse()
        .ok()
}

fn process_command(pid: u64) -> String {
    Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .unwrap_or_default()
}

/// True when whatever holds 17177 is what `start_dev_backend` would have
/// spawned, i.e. a dev uvicorn. The bundled release sidecar is a PyInstaller
/// binary named `1okstudio-backend` and must never be adopted by a dev build.
fn listener_is_dev_backend() -> bool {
    let Some(pid) = listener_pid() else { return false };
    let command = process_command(pid);
    command.contains("uvicorn") && !command.contains("1okstudio-backend")
}

fn is_backend_ready() -> bool {
    backend_health().is_some()
}

fn wait_for_backend_ready(max_attempts: u32) -> bool {
    for _ in 0..max_attempts {
        if is_backend_ready() {
            return true;
        }
        thread::sleep(Duration::from_millis(200));
    }
    false
}

#[cfg(test)]
mod tests {
    use super::same_build;

    #[test]
    fn only_reuses_the_same_sidecar_build() {
        assert!(same_build(Some(100.0), Some(100.5)));
        assert!(!same_build(Some(100.0), Some(200.0)));
        assert!(!same_build(None, Some(100.0)));
    }
}
