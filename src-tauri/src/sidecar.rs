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
        if cfg!(debug_assertions) || backend_matches_current_build(app_handle, &health) {
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

fn start_dev_backend() -> Result<Child, std::io::Error> {
    let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has no parent directory");
    Command::new("python")
        .current_dir(project_root)
        .args([
            "-m",
            "uvicorn",
            "src.apps.comic_gen.api:app",
            "--host",
            "0.0.0.0",
            "--port",
            "17177",
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
        .map(|path| path.join("lumenx-backend/lumenx-backend"))
        .map_err(std::io::Error::other)
}

pub fn sidecar_log_path() -> std::path::PathBuf {
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(".lumen-x/logs/sidecar.log")
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
    let command = Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .unwrap_or_default();
    if !command.contains("lumenx-backend") {
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
