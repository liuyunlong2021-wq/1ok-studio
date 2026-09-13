// Sidecar management: start/stop/health-check the Python FastAPI backend

use std::fs::OpenOptions;
use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, UNIX_EPOCH};
use tauri::Manager;

fn show_main_window(app_handle: &tauri::AppHandle, reload: bool) {
    if let Some(window) = app_handle.get_webview_window("main") {
        if reload {
            let _ = window.reload();
        }
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Start the Python backend sidecar process
/// In dev mode: runs `python -m uvicorn src.apps.comic_gen.api:app --host 0.0.0.0 --port 17177`
/// In production: runs the bundled PyInstaller binary
pub fn start_backend(app_handle: &tauri::AppHandle, running: Arc<AtomicBool>) {
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
        Ok(mut process) => {
            running.store(true, Ordering::SeqCst);
            println!("[sidecar] Backend process started (pid: {})", process.id());

            // The unpacked runtime should expose its health endpoint promptly.
            let ready = wait_for_backend_ready(150); // 150 * 200ms = 30s
            if ready {
                println!("[sidecar] Backend is ready!");
            } else {
                let message = "Backend failed to become ready within 30s";
                eprintln!("[sidecar] {message}");
                append_sidecar_log(message);
            }
            show_main_window(app_handle, ready);

            // Keep monitoring the process
            loop {
                if !running.load(Ordering::SeqCst) {
                    // Application is shutting down, kill the backend
                    let _ = process.kill();
                    let _ = process.wait();
                    println!("[sidecar] Backend process terminated");
                    break;
                }

                // Check if process is still alive
                match process.try_wait() {
                    Ok(Some(status)) => {
                        eprintln!("[sidecar] Backend exited with status: {:?}", status);
                        running.store(false, Ordering::SeqCst);
                        break;
                    }
                    Ok(None) => {
                        // Still running, sleep a bit
                        thread::sleep(Duration::from_secs(1));
                    }
                    Err(e) => {
                        eprintln!("[sidecar] Error checking backend status: {}", e);
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
fn user_data_dir() -> std::path::PathBuf {
    let configured = std::env::var("ONEOKSTUDIO_DATA_DIR").unwrap_or_default();
    let trimmed = configured.trim();
    if let Some(rest) = trimmed.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return std::path::PathBuf::from(home).join(rest);
        }
    }
    if !trimmed.is_empty() {
        return std::path::PathBuf::from(trimmed);
    }
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(".1okstudio")
}

fn start_dev_backend() -> Result<Child, std::io::Error> {
    let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has no parent directory");
    let data_dir = user_data_dir();
    std::fs::create_dir_all(&data_dir)?;
    Command::new("python")
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
    Command::new(prod_sidecar_path(app_handle)?)
        .arg("--port")
        .arg("17177")
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
}

fn prod_sidecar_path(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, std::io::Error> {
    app_handle
        .path()
        .resource_dir()
        .map(|path| path.join("1okstudio-backend/1okstudio-backend"))
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
