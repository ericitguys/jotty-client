// v0.30.2 DIAG: startup trace + panic捕获 for the Android insta-close that
// survived the v0.30.1 keyring fix. Writes an append-only trace to the app
// data root (next to jotty.db) and to the EXTERNAL app files dir
// (/sdcard/Android/data/page.jotty.desktop/files/ — PC-MTP readable), and
// installs a panic hook that appends the payload of EVERY panic to the same
// file. All android-only; desktop keeps the trace module compiled out.
#![allow(dead_code)]
use std::sync::Mutex;

pub static TRACE_LOCK: Mutex<()> = Mutex::new(());

fn base_dirs() -> Vec<std::path::PathBuf> {
    #[cfg(target_os = "android")]
    {
        let mut v = Vec::new();
        if let Some(d) = dirs_data_root() {
            v.push(d.join("jotty-startup-trace.log"));
        }
        if let Some(d) = dirs_external_files() {
            v.push(d.join("jotty-startup-trace.log"));
        }
        v
    }
    #[cfg(not(target_os = "android"))]
    {
        Vec::new()
    }
}

#[cfg(target_os = "android")]
fn dirs_data_root() -> Option<std::path::PathBuf> {
    // The app data root is also where jotty.db lives; derive it from the
    // RUNNING app via tauri only after setup — for the earliest (pre-setup)
    // traces, use the conventional data root via getExternalFilesDir's
    // sibling logic: /data/user/0/<pkg> == std::env::var("JOTTY_DATA_ROOT")
    // is NOT available; instead just use the external dir + later the real
    // db_dir once setup knows it. Return None here; main trace lives on the
    // external files dir + db_dir side.
    None
}

#[cfg(target_os = "android")]
fn dirs_external_files() -> Option<std::path::PathBuf> {
    // Context.getExternalFilesDir equivalent: on Android the external app
    // files dir is /sdcard/Android/data/<pkg>/files — writable by the app
    // without any permission, readable over PC-MTP.
    let pkg = "page.jotty.desktop";
    let candidates = [
        format!("/sdcard/Android/data/{pkg}/files"),
        format!("/storage/emulated/0/Android/data/{pkg}/files"),
    ];
    for c in candidates {
        let p = std::path::PathBuf::from(&c);
        if std::fs::create_dir_all(&p).is_ok() {
            return Some(p);
        }
    }
    None
}

pub fn install_panic_hook() {
    #[cfg(target_os = "android")]
    {
        let default = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let payload = info
                .payload()
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| {
                    info.payload()
                        .downcast_ref::<String>()
                        .cloned()
                })
                .unwrap_or_else(|| "<non-string payload>".to_string());
            let loc = info
                .location()
                .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                .unwrap_or_else(|| "<unknown>".to_string());
            trace(&format!("PANIC at {loc}: {payload}"));
            default(info);
        }));
    }
    #[cfg(not(target_os = "android"))]
    {
        // desktop: no-op (never wired)
    }
}

pub fn trace(msg: &str) {
    #[cfg(target_os = "android")]
    {
        let _g = TRACE_LOCK.lock();
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let line = format!("[{ts}] {msg}\n");
        use std::io::Write as _;
        for path in base_dirs() {
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
                let _ = f.write_all(line.as_bytes());
            }
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = msg;
    }
}

/// Where the trace ended up (for UI surfacing; the external path only).
#[cfg(target_os = "android")]
pub fn external_trace_path() -> Option<std::path::PathBuf> {
    dirs_external_files().map(|d| d.join("jotty-startup-trace.log"))
}