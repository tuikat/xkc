use std::collections::HashMap;
use std::sync::Mutex;
use std::path::Path;
use tauri::{AppHandle, Manager, State};
use notify::{Watcher, RecursiveMode, Event, EventKind};
use serde_json::json;

const AUDIO_EXTS: &[&str] = &["mp3", "flac", "wav", "aiff", "aif", "m4a", "ogg", "opus", "aac"];

pub struct WatcherState {
    pub watchers: Mutex<HashMap<String, notify::RecommendedWatcher>>,
}

impl Default for WatcherState {
    fn default() -> Self {
        Self { watchers: Mutex::new(HashMap::new()) }
    }
}

// ── USB detection ──────────────────────────────────────────────────────────────

fn detect_usb_devices() -> Vec<String> {
    let mut found = Vec::new();

    #[cfg(target_os = "linux")]
    {
        // Check /proc/mounts
        if let Ok(contents) = std::fs::read_to_string("/proc/mounts") {
            for line in contents.lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 2 {
                    let mount = parts[1];
                    if !mount.starts_with("/sys")
                        && !mount.starts_with("/proc")
                        && mount != "/"
                        && mount != "/boot"
                    {
                        let pioneer = format!("{}/PIONEER/rekordbox", mount);
                        if Path::new(&pioneer).exists() && !found.contains(&mount.to_string()) {
                            found.push(mount.to_string());
                        }
                    }
                }
            }
        }
        // Also check common removable media directories
        for base in &["/media", "/mnt", "/run/media"] {
            if let Ok(entries) = std::fs::read_dir(base) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    scan_for_pioneer(&p, &mut found, 2);
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(entries) = std::fs::read_dir("/Volumes") {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.join("PIONEER").join("rekordbox").exists() {
                    found.push(p.to_string_lossy().to_string());
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        for letter in b'A'..=b'Z' {
            let drive = format!("{}:\\", letter as char);
            if Path::new(&drive).join("PIONEER").join("rekordbox").exists() {
                found.push(drive);
            }
        }
    }

    found.dedup();
    found
}

fn scan_for_pioneer(path: &Path, found: &mut Vec<String>, depth: u32) {
    if depth == 0 || !path.is_dir() {
        return;
    }
    if path.join("PIONEER").join("rekordbox").exists() {
        let s = path.to_string_lossy().to_string();
        if !found.contains(&s) {
            found.push(s);
        }
        return;
    }
    if depth > 1 {
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                scan_for_pioneer(&entry.path(), found, depth - 1);
            }
        }
    }
}

// ── Tauri commands ─────────────────────────────────────────────────────────────

#[tauri::command]
fn get_usb_devices() -> Vec<String> {
    detect_usb_devices()
}

#[tauri::command]
async fn open_folder_dialog(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let result = path.map(|p| match p {
            tauri_plugin_dialog::FilePath::Path(pb) => pb.to_string_lossy().to_string(),
            tauri_plugin_dialog::FilePath::Url(u) => u.to_string(),
        });
        let _ = tx.send(result);
    });
    rx.await.ok().flatten()
}

#[tauri::command]
async fn start_folder_watch(
    path: String,
    server_url: String,
    token: String,
    state: State<'_, WatcherState>,
) -> Result<(), String> {
    let path_clone = path.clone();
    let server_url_clone = server_url.clone();
    let token_clone = token.clone();

    let (tx, mut rx) = tokio::sync::mpsc::channel(32);

    let watcher = notify::recommended_watcher(move |res: Result<Event, _>| {
        if let Ok(event) = res {
            let _ = tx.blocking_send(event);
        }
    }).map_err(|e| e.to_string())?;

    {
        let mut w = watcher;
        w.watch(Path::new(&path), RecursiveMode::Recursive).map_err(|e| e.to_string())?;

        let mut watchers = state.watchers.lock().unwrap();
        watchers.insert(path.clone(), w);
    }

    // Spawn background task to handle events
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            if matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                for p in &event.paths {
                    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                    if AUDIO_EXTS.contains(&ext.as_str()) {
                        let _ = upload_file(p, &server_url_clone, &token_clone).await;
                    }
                }
            }
        }
    });

    log::info!("Watching folder: {}", path_clone);
    Ok(())
}

#[tauri::command]
fn stop_folder_watch(path: String, state: State<'_, WatcherState>) -> Result<(), String> {
    let mut watchers = state.watchers.lock().unwrap();
    watchers.remove(&path);
    log::info!("Stopped watching: {}", path);
    Ok(())
}

#[tauri::command]
fn get_watched_folders_status(state: State<'_, WatcherState>) -> serde_json::Value {
    let watchers = state.watchers.lock().unwrap();
    let paths: Vec<&String> = watchers.keys().collect();
    json!({ "watching": paths })
}

#[tauri::command]
async fn sync_usb(
    mount_point: String,
    server_url: String,
    token: String,
    playlist_ids: Vec<String>,
) -> Result<String, String> {
    let ids = playlist_ids.join(",");
    let url = format!("{}/api/sync/pioneer-export?playlist_ids={}", server_url.trim_end_matches('/'), ids);

    let client = reqwest::Client::new();
    let res = client
        .get(&url)
        .header("Cookie", format!("access_token={}", token))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("Server returned {}", res.status()));
    }

    // The response is a zip. Save it to a temp file and extract to USB.
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    let tmp_path = std::env::temp_dir().join("xkc_usb_export.zip");
    std::fs::write(&tmp_path, &bytes).map_err(|e| e.to_string())?;

    // Extract zip to USB mount point
    let file = std::fs::File::open(&tmp_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mount = Path::new(&mount_point);

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let outpath = mount.join(file.name());
        if file.name().ends_with('/') {
            std::fs::create_dir_all(&outpath).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = outpath.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut outfile = std::fs::File::create(&outpath).map_err(|e| e.to_string())?;
            std::io::copy(&mut file, &mut outfile).map_err(|e| e.to_string())?;
        }
    }

    std::fs::remove_file(&tmp_path).ok();
    Ok(format!("Sync complete to {}", mount_point))
}

// ── HTTP upload helper ─────────────────────────────────────────────────────────

async fn upload_file(path: &Path, server_url: &str, token: &str) -> Result<(), String> {
    let file_bytes = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
    let filename = path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "track".to_string());

    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(filename)
        .mime_str("application/octet-stream")
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new().part("file", part);

    let url = format!("{}/api/tracks/upload", server_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let res = client
        .post(&url)
        .header("Cookie", format!("access_token={}", token))
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if res.status().is_success() {
        log::info!("Uploaded: {:?}", path);
    } else {
        log::warn!("Upload failed for {:?}: {}", path, res.status());
    }
    Ok(())
}

// ── App entry point ────────────────────────────────────────────────────────────

pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .manage(WatcherState::default())
        .invoke_handler(tauri::generate_handler![
            get_usb_devices,
            open_folder_dialog,
            start_folder_watch,
            stop_folder_watch,
            get_watched_folders_status,
            sync_usb,
        ])
        .setup(|app| {
            // System tray
            use tauri::tray::{TrayIconBuilder, TrayIconEvent};
            use tauri::menu::{MenuBuilder, MenuItemBuilder};

            let show_item = MenuItemBuilder::with_id("show", "Show Window").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit XKC").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show_item, &quit_item]).build()?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().unwrap())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
