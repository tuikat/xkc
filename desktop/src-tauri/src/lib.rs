use std::collections::HashMap;
use std::sync::Mutex;
use std::path::Path;
use std::io::{Read, Write};
use tauri::{AppHandle, Emitter, Manager, State};
use notify::{Watcher, RecursiveMode, Event, EventKind};
use serde_json::{json, Value};
use futures_util::StreamExt;

fn mb(bytes: u64) -> f64 {
    bytes as f64 / 1_048_576.0
}

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

fn make_device(path: &Path) -> Option<Value> {
    if !path.is_dir() { return None; }
    let name = path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());
    if name.is_empty() || name == "." { return None; }
    let mount_point = path.to_string_lossy().to_string();
    let is_pioneer = path.join("PIONEER").join("rekordbox").exists();
    Some(json!({ "mount_point": mount_point, "name": name, "is_pioneer": is_pioneer }))
}

fn detect_usb_devices() -> Vec<Value> {
    let mut found: Vec<Value> = Vec::new();

    #[cfg(target_os = "macos")]
    {
        if let Ok(entries) = std::fs::read_dir("/Volumes") {
            for entry in entries.flatten() {
                let p = entry.path();
                let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                // Skip the macOS boot volume
                if name == "Macintosh HD" || name.is_empty() { continue; }
                if let Some(dev) = make_device(&p) { found.push(dev); }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        for letter in b'C'..=b'Z' {
            let drive = format!("{}:\\", letter as char);
            let p = Path::new(&drive);
            if p.exists() {
                if let Some(dev) = make_device(p) { found.push(dev); }
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        for base in &["/media", "/mnt", "/run/media"] {
            if let Ok(top) = std::fs::read_dir(base) {
                for entry in top.flatten() {
                    let p = entry.path();
                    if !p.is_dir() { continue; }
                    // /run/media/<user>/<drive> — descend one level
                    let children_count = std::fs::read_dir(&p).map(|r| r.count()).unwrap_or(0);
                    // If first child looks like a mountpoint (not just files), try children
                    let mut found_children = false;
                    if let Ok(children) = std::fs::read_dir(&p) {
                        for child in children.flatten() {
                            if child.path().is_dir() {
                                if let Some(dev) = make_device(&child.path()) {
                                    found.push(dev);
                                    found_children = true;
                                }
                            }
                        }
                    }
                    if !found_children && children_count == 0 {
                        // Directly a mountpoint (e.g. /mnt/usb)
                        if let Some(dev) = make_device(&p) { found.push(dev); }
                    }
                }
            }
        }
    }

    found
}

// ── Tauri commands ─────────────────────────────────────────────────────────────

#[tauri::command]
fn get_usb_devices() -> Vec<Value> {
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
fn get_watched_folders_status(state: State<'_, WatcherState>) -> Value {
    let watchers = state.watchers.lock().unwrap();
    let paths: Vec<&String> = watchers.keys().collect();
    json!({ "watching": paths })
}

fn emit_sync_progress(app: &AppHandle, mount_point: &str, stage: &str, detail: &str) {
    log::info!("USB sync [{}]: {} -- {}", mount_point, stage, detail);
    let _ = app.emit("usb-sync-progress", json!({
        "mount_point": mount_point, "stage": stage, "detail": detail,
    }));
}

#[tauri::command]
async fn sync_usb(
    app: AppHandle,
    mount_point: String,
    server_url: String,
    token: String,
    playlist_ids: Vec<String>,
) -> Result<String, String> {
    let base = server_url.trim_end_matches('/');
    let client = reqwest::Client::new();

    // 1. Create export job
    emit_sync_progress(&app, &mount_point, "requesting", "Requesting export from server...");
    let body = json!({ "playlist_ids": playlist_ids, "format": "pioneer" });
    let res = client
        .post(format!("{}/api/export/", base))
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("Export request failed: {}", res.status()));
    }

    let resp: Value = res.json().await.map_err(|e| e.to_string())?;
    let job_id = resp["job_id"].as_str().ok_or("No job_id in response")?.to_string();

    // 2. Poll for completion, surfacing the server's reported stage/progress
    // (e.g. "copying tracks", "building database") as it goes.
    loop {
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        let status_res = client
            .get(format!("{}/api/export/{}", base, job_id))
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status: Value = status_res.json().await.map_err(|e| e.to_string())?;
        let stage = status["stage"].as_str().unwrap_or("building");
        let pct = status["progress"].as_u64().unwrap_or(0);
        match status["status"].as_str().unwrap_or("unknown") {
            "complete" => break,
            "failed" => {
                let err = status["error"].as_str().unwrap_or("unknown").to_string();
                emit_sync_progress(&app, &mount_point, "failed", &err);
                return Err(format!("Export failed: {}", err));
            }
            _ => {
                emit_sync_progress(&app, &mount_point, "building", &format!("{} ({}%)", stage, pct));
                continue;
            }
        }
    }

    // 3. Download zip
    emit_sync_progress(&app, &mount_point, "downloading", "Downloading export from server...");
    let zip_res = client
        .get(format!("{}/api/export/{}/download", base, job_id))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !zip_res.status().is_success() {
        return Err(format!("Download failed: {}", zip_res.status()));
    }

    // Stream the download so we can report real progress instead of blocking
    // silently until the whole (potentially very large, thousands-of-tracks)
    // zip has arrived.
    let total_size = zip_res.content_length().unwrap_or(0);
    let tmp_path = std::env::temp_dir().join("xkc_usb_export.zip");
    {
        let mut tmp_file = std::fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
        let mut stream = zip_res.bytes_stream();
        let mut downloaded: u64 = 0;
        let mut last_emit = std::time::Instant::now();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            downloaded += chunk.len() as u64;
            tmp_file.write_all(&chunk).map_err(|e| e.to_string())?;
            if last_emit.elapsed().as_millis() >= 200 || downloaded >= total_size {
                last_emit = std::time::Instant::now();
                let detail = if total_size > 0 {
                    let pct = (downloaded * 100 / total_size).min(100);
                    format!("Downloading: {}% ({:.1}/{:.1} MB)", pct, mb(downloaded), mb(total_size))
                } else {
                    format!("Downloading: {:.1} MB", mb(downloaded))
                };
                emit_sync_progress(&app, &mount_point, "downloading", &detail);
            }
        }
    }

    // 4. Extract to USB mount point, tracking real bytes written (not just
    // file count) since track files vary wildly in size and USB write speed
    // is what actually makes this slow.
    let file = std::fs::File::open(&tmp_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mount = Path::new(&mount_point);
    let total_files = archive.len();

    let mut total_bytes: u64 = 0;
    for i in 0..total_files {
        if let Ok(zf) = archive.by_index(i) {
            total_bytes += zf.size();
        }
    }
    emit_sync_progress(&app, &mount_point, "extracting",
        &format!("Writing {} files ({:.1} MB) to USB...", total_files, mb(total_bytes)));

    let mut written_bytes: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    let mut buf = [0u8; 65536];
    for i in 0..total_files {
        let mut zf = archive.by_index(i).map_err(|e| e.to_string())?;
        let outpath = mount.join(zf.name());
        if zf.name().ends_with('/') {
            std::fs::create_dir_all(&outpath).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = outpath.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut outfile = std::fs::File::create(&outpath)
            .map_err(|e| format!("Failed to write {} to USB: {}", zf.name(), e))?;
        loop {
            let n = zf.read(&mut buf)
                .map_err(|e| format!("Failed to read {} from export: {}", zf.name(), e))?;
            if n == 0 {
                break;
            }
            outfile.write_all(&buf[..n])
                .map_err(|e| format!("Failed to write {} to USB: {}", zf.name(), e))?;
            written_bytes += n as u64;
            if last_emit.elapsed().as_millis() >= 200 {
                last_emit = std::time::Instant::now();
                let pct = if total_bytes > 0 { (written_bytes * 100 / total_bytes).min(100) } else { 0 };
                emit_sync_progress(&app, &mount_point, "extracting",
                    &format!("Writing to USB: {}% (file {} of {})", pct, i + 1, total_files));
            }
        }
    }

    std::fs::remove_file(&tmp_path).ok();
    emit_sync_progress(&app, &mount_point, "complete", "Sync complete");
    Ok(format!("Sync complete to {}", mount_point))
}

#[tauri::command]
fn eject_usb(mount_point: String) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("diskutil")
            .args(["eject", &mount_point])
            .output()
            .map_err(|e| e.to_string())?;
        if output.status.success() {
            return Ok(format!("Ejected {}", mount_point));
        } else {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("umount").arg(&mount_point).output();
        return Ok(format!("Unmounted {}", mount_point));
    }
    #[cfg(target_os = "windows")]
    {
        return Ok(format!("Eject {}: use system tray to safely remove hardware", mount_point));
    }
    #[allow(unreachable_code)]
    Err("Eject not supported on this platform".to_string())
}

#[tauri::command]
fn format_usb(mount_point: String) -> Result<String, String> {
    let mount = Path::new(&mount_point);
    let pioneer_dir = mount.join("PIONEER").join("rekordbox");
    let contents_dir = mount.join("Contents");

    std::fs::create_dir_all(&pioneer_dir).map_err(|e| format!("Cannot create PIONEER dir: {}", e))?;
    std::fs::create_dir_all(&contents_dir).map_err(|e| format!("Cannot create Contents dir: {}", e))?;

    let xml = r#"<?xml version='1.0' encoding='UTF-8'?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="6.8.5" Company="Pioneer DJ"/>
  <COLLECTION Entries="0"/>
  <PLAYLISTS><NODE Name="ROOT" Type="0" Count="0"/></PLAYLISTS>
</DJ_PLAYLISTS>"#;

    let xml_path = pioneer_dir.join("rekordbox.xml");
    std::fs::write(&xml_path, xml).map_err(|e| format!("Cannot write rekordbox.xml: {}", e))?;

    Ok(format!("Formatted {} as Pioneer USB", mount_point))
}

#[tauri::command]
async fn sync_playlist_to_folder(
    folder: String,
    playlist_id: String,
    server_url: String,
    token: String,
) -> Result<String, String> {
    let base = server_url.trim_end_matches('/');
    let client = reqwest::Client::new();

    let tracks_res = client
        .get(format!("{}/api/tracks/?playlist_id={}", base, playlist_id))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !tracks_res.status().is_success() {
        return Err(format!("Failed to get tracks: {}", tracks_res.status()));
    }

    let tracks: Vec<Value> = tracks_res.json().await.map_err(|e| e.to_string())?;
    let total = tracks.len();
    let folder_path = Path::new(&folder);
    std::fs::create_dir_all(folder_path).map_err(|e| e.to_string())?;

    let mut synced = 0usize;
    for track in &tracks {
        let id = match track["id"].as_str() {
            Some(id) => id,
            None => continue,
        };
        let artist = track["artist"].as_str().unwrap_or("Unknown Artist");
        let title = track["title"].as_str().unwrap_or("Unknown Title");
        let fmt = track["file_format"].as_str().unwrap_or("mp3");
        let raw_name = format!("{} - {}.{}", artist, title, fmt);
        let safe_name: String = raw_name.chars()
            .map(|c| if c.is_alphanumeric() || " \\-_.".contains(c) { c } else { '_' })
            .collect();

        let dest = folder_path.join(&safe_name);
        if dest.exists() {
            synced += 1;
            continue;
        }

        let stream_res = client
            .get(format!("{}/api/tracks/{}/stream", base, id))
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if stream_res.status().is_success() {
            let bytes = stream_res.bytes().await.map_err(|e| e.to_string())?;
            std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
            synced += 1;
        }
    }

    Ok(format!("Synced {}/{} tracks to {}", synced, total, folder))
}

// ── HTTP upload helper ─────────────────────────────────────────────────────────

async fn upload_file(path: &Path, server_url: &str, token: &str) -> Result<(), String> {
    // Staged logging mirrors the web upload pipeline (preparing/reading -> uploading ->
    // saved) so desktop folder-watch behaves consistently with the browser import flow.
    // Reading a file that's a cloud-storage placeholder (iCloud Drive/OneDrive) can
    // block here for a while as the OS materialises it — log before and after so a
    // stall is visible in the desktop log instead of looking hung.
    log::info!("Reading file: {:?}", path);
    let read_started = std::time::Instant::now();
    let file_bytes = tokio::fs::read(path).await.map_err(|e| {
        log::warn!("Failed to read {:?}: {}", path, e);
        e.to_string()
    })?;
    let read_elapsed = read_started.elapsed();
    if read_elapsed.as_secs() >= 2 {
        log::info!("Read {:?} ({} bytes) after {:.1}s — possibly a cloud-synced file that needed to download", path, file_bytes.len(), read_elapsed.as_secs_f32());
    }

    let filename = path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "track".to_string());

    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(filename)
        .mime_str("application/octet-stream")
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new().part("file", part);

    log::info!("Uploading: {:?}", path);
    let url = format!("{}/api/tracks/upload", server_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let res = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .multipart(form)
        .send()
        .await
        .map_err(|e| {
            log::warn!("Upload network error for {:?}: {}", path, e);
            e.to_string()
        })?;

    if res.status().is_success() {
        log::info!("Saved: {:?} (server queued it for analysis)", path);
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
            eject_usb,
            format_usb,
            sync_playlist_to_folder,
        ])
        .setup(|app| {
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
