// One OK Studio - Tauri 2.0 Main Entry
// Implements: transparent titlebar, Traffic Light, vibrancy, sidecar management, API proxy

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

mod sidecar;
mod menu;

#[derive(Debug, Serialize, Deserialize)]
struct ApiProxyRequest {
    method: String,
    path: String,
    body: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ApiProxyResponse {
    status: u16,
    body: String,
}

/// IPC command: proxy API requests to the Python backend
#[tauri::command]
async fn api_proxy(method: String, path: String, body: Option<String>) -> Result<ApiProxyResponse, String> {
    let client = reqwest::Client::new();
    let url = format!("http://127.0.0.1:17177{}", path);

    let request = match method.to_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => {
            let mut req = client.post(&url);
            if let Some(ref b) = body {
                req = req.header("Content-Type", "application/json").body(b.clone());
            }
            req
        }
        "PUT" => {
            let mut req = client.put(&url);
            if let Some(ref b) = body {
                req = req.header("Content-Type", "application/json").body(b.clone());
            }
            req
        }
        "DELETE" => client.delete(&url),
        "PATCH" => {
            let mut req = client.patch(&url);
            if let Some(ref b) = body {
                req = req.header("Content-Type", "application/json").body(b.clone());
            }
            req
        }
        _ => return Err(format!("Unsupported HTTP method: {}", method)),
    };

    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|e| e.to_string())?;

    Ok(ApiProxyResponse { status, body })
}

/// IPC command: check if the Python backend is ready
#[tauri::command]
async fn check_backend_health() -> Result<bool, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;

    match client.get("http://127.0.0.1:17177/health").send().await {
        Ok(resp) => Ok(resp.status().is_success()),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
fn open_sidecar_log() -> Result<(), String> {
    open::that(sidecar::sidecar_log_path()).map_err(|error| error.to_string())
}

/// Resolve a backend media path to the file on disk.
///
/// Mirrors the frontend's `getMediaUrl`: the backend hands out paths that may or
/// may not carry an `output/` prefix, and the `/files` static mount serves
/// `<data_dir>/output`, so `output/playground/images/x.png` and
/// `playground/images/x.png` name the same file.
///
/// Anything that is not a plain relative path is rejected outright — this is a
/// trust boundary, and a `..` segment here would let the webview read or copy
/// arbitrary files.
fn media_file_path(media_path: &str) -> Result<std::path::PathBuf, String> {
    let cleaned = media_path.trim().replace('\\', "/");
    let cleaned = cleaned.trim_start_matches('/');
    let cleaned = cleaned.strip_prefix("output/").unwrap_or(cleaned);

    let is_plain_relative = !cleaned.is_empty()
        && std::path::Path::new(cleaned)
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)));
    if !is_plain_relative {
        return Err(format!("Invalid media path: {media_path}"));
    }

    let file = sidecar::user_data_dir().join("output").join(cleaned);
    if !file.is_file() {
        return Err(format!("Media file not found: {}", file.display()));
    }
    Ok(file)
}

#[cfg(target_os = "macos")]
fn reveal_in_file_manager(file: &std::path::Path) -> Result<(), String> {
    // `open -R` selects the file itself rather than just opening its folder,
    // which is the whole point of the button.
    std::process::Command::new("open")
        .arg("-R")
        .arg(file)
        .status()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "macos"))]
fn reveal_in_file_manager(file: &std::path::Path) -> Result<(), String> {
    let dir = file
        .parent()
        .ok_or_else(|| "Media file has no parent directory".to_string())?;
    open::that(dir).map_err(|error| error.to_string())
}

/// IPC command: copy a generated media file to a location the user picks.
///
/// The webview cannot do this on its own — WKWebView does not implement the
/// `<a download>` attribute, so the previous frontend approach was a silent
/// no-op. The file already lives in the user data dir, so this is a local copy
/// behind a native save dialog; no network involved.
///
/// Returns `Ok(None)` when the user cancels the dialog.
#[tauri::command]
async fn save_media(
    app: tauri::AppHandle,
    media_path: String,
) -> Result<Option<String>, String> {
    let source = media_file_path(&media_path)?;
    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download")
        .to_string();

    // `blocking_save_file` must not run on the main thread — park a worker and
    // wait for the picker to come back.
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_file_name(&file_name)
            .blocking_save_file()
    })
    .await
    .map_err(|error| error.to_string())?;

    let Some(target) = picked else {
        return Ok(None);
    };
    let target = target.into_path().map_err(|error| error.to_string())?;
    std::fs::copy(&source, &target).map_err(|error| error.to_string())?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

/// IPC command: show a generated media file in Finder / Explorer.
#[tauri::command]
fn reveal_media(media_path: String) -> Result<(), String> {
    let file = media_file_path(&media_path)?;
    reveal_in_file_manager(&file)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let backend_running = Arc::new(AtomicBool::new(false));
    let backend_running_clone = backend_running.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            // Use webview.eval() for reliable JS execution (bypasses event system)
            if let Some(window) = app.get_webview_window("main") {
                let js = match id {
                    "preferences" => Some("window.location.hash = '#/settings';".to_string()),
                    "new_project" => Some("window.location.hash='#/new-project';".to_string()),
                    "open_project" => Some("window.location.hash = '#/';".to_string()),
                    "zoom_in" => Some("(function(){var s=parseFloat(getComputedStyle(document.documentElement).fontSize);document.documentElement.style.fontSize=(s+1)+'px';})()".to_string()),
                    "zoom_out" => Some("(function(){var s=parseFloat(getComputedStyle(document.documentElement).fontSize);document.documentElement.style.fontSize=Math.max(10,s-1)+'px';})()".to_string()),
                    "zoom_reset" => Some("document.documentElement.style.fontSize='81.25%';".to_string()),
                    _ => None,
                };
                if let Some(code) = js {
                    let _ = window.eval(&code);
                }
            }
            // External links: open in default browser
            match id {
                "docs" => { let _ = open::that("https://github.com/liuyunlong2021-wq/1ok-studio#readme"); }
                "release_notes" => { let _ = open::that("https://github.com/liuyunlong2021-wq/1ok-studio/releases"); }
                "report_issue" => { let _ = open::that("https://github.com/liuyunlong2021-wq/1ok-studio/issues/new"); }
                _ => {}
            }
        })
        .setup(move |app| {
            // Set up native macOS menu bar
            let native_menu = menu::build_menu(app.handle())?;
            app.set_menu(native_menu)?;

            let _window = app.get_webview_window("main").unwrap();

            // macOS titlebar styling: using decorations:false for custom titlebar.
            // The drag region is handled via CSS data-tauri-drag-region in the frontend.
            // No manual cocoa manipulation needed for basic setup.

            // Start Python sidecar in background
            let app_handle = app.handle().clone();
            let running = backend_running_clone.clone();
            std::thread::spawn(move || {
                sidecar::start_backend(&app_handle, running);
            });

            Ok(())
        })
        .on_window_event(move |_window, event| {
            // Clean up sidecar on window close
            if let tauri::WindowEvent::Destroyed = event {
                backend_running.store(false, Ordering::SeqCst);
            }
        })
        .invoke_handler(tauri::generate_handler![
            api_proxy,
            check_backend_health,
            open_sidecar_log,
            save_media,
            reveal_media,
        ])
        .run(tauri::generate_context!())
        .expect("error while running One OK Studio");
}
