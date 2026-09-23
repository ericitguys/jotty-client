// Desktop launcher branding: shadow the packaged .desktop with a user-level one
// (same desktop-file id, XDG precedence) carrying the server's name + icon.
// Android has no equivalent (launcher icon/label are compiled resources).
use serde::Serialize;

pub const DESKTOP_ID: &str = "jotty-desktop.desktop";
pub const BRANDING_MARKER: &str = "X-JottyBranded=true";

#[derive(Debug, PartialEq, Serialize, Clone)]
pub struct BrandingDesktopStatus {
    pub supported: bool,
    pub active: bool,
}

/// Resolve $XDG_DATA_HOME or $HOME/.local/share.
pub fn xdg_data_home() -> Option<std::path::PathBuf> {
    if let Ok(x) = std::env::var("XDG_DATA_HOME") {
        if !x.is_empty() {
            return Some(std::path::PathBuf::from(x));
        }
    }
    let home = std::env::var("HOME").ok()?;
    if home.is_empty() {
        return None;
    }
    Some(std::path::PathBuf::from(home).join(".local/share"))
}

/// Decode a `data:<mime>;base64,<payload>` URL into (extension, bytes).
pub fn decode_data_url(data_url: &str) -> Option<(String, Vec<u8>)> {
    use base64::Engine as _;
    let rest = data_url.strip_prefix("data:")?;
    let (meta, payload) = rest.split_once(',')?;
    let mime = meta.split(';').next().unwrap_or("");
    let ext = match mime {
        "image/jpeg" => "jpg",
        "image/svg+xml" => "svg",
        "image/webp" => "webp",
        "image/x-icon" | "image/vnd.microsoft.icon" => "ico",
        _ => "png",
    };
    let bytes = base64::engine::general_purpose::STANDARD.decode(payload.trim()).ok()?;
    Some((ext.to_string(), bytes))
}

/// Build the shadow .desktop text: start from the packaged/integrated entry when
/// readable (preserves its Exec), patch Name= and Icon=, drop locale Name[..] variants,
/// and mark the file as ours so `remove` never deletes files we did not write.
pub fn desktop_entry_text(packaged: Option<&str>, name: Option<&str>, icon_path: Option<&str>) -> String {
    let mut lines: Vec<String> = packaged
        .map(|t| t.lines().map(|l| l.trim_end().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default();
    if !lines.iter().any(|l| l.trim() == "[Desktop Entry]") {
        lines.insert(0, "[Desktop Entry]".into());
        lines.insert(1, "Type=Application".into());
        lines.insert(2, "Exec=jotty-client".into());
        lines.insert(3, "StartupWMClass=jotty-client".into());
        lines.insert(4, "Terminal=false".into());
    }
    lines.retain(|l| !(l.starts_with("Name[") || l.starts_with("Icon[") || l.starts_with("GenericName[")));
    let mut has_name = false;
    let mut has_icon = false;
    for line in lines.iter_mut() {
        if line.starts_with("Name=") {
            if let Some(n) = name {
                *line = format!("Name={n}");
                has_name = true;
            }
        } else if line.starts_with("Icon=") {
            if let Some(p) = icon_path {
                *line = format!("Icon={p}");
                has_icon = true;
            }
        }
    }
    if let Some(n) = name.filter(|_| !has_name) {
        lines.insert(1, format!("Name={n}"));
    }
    if let Some(p) = icon_path.filter(|_| !has_icon) {
        lines.insert(1, format!("Icon={p}"));
    }
    if !lines.iter().any(|l| l.starts_with("Name=")) {
        lines.insert(1, "Name=jotty-desktop".into());
    }
    if !lines.iter().any(|l| l.starts_with("Type=")) {
        lines.insert(1, "Type=Application".into());
    }
    if !lines.iter().any(|l| l.starts_with("Exec=")) {
        lines.insert(2, "Exec=jotty-client".into());
    }
    lines.push(BRANDING_MARKER.into());
    lines.join("\n") + "\n"
}

fn is_ours(text: &str) -> bool {
    text.lines().any(|l| l.trim() == BRANDING_MARKER)
}

/// Write the shadow entry + icon. Returns the .desktop path written.
pub fn apply_inner(
    data_dir: &std::path::Path,
    packaged_paths: &[std::path::PathBuf],
    name: Option<&str>,
    icon_data_url: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    let apps_dir = data_dir.join("applications");
    std::fs::create_dir_all(&apps_dir).map_err(|e| format!("create applications dir: {e}"))?;

    let icon_path = if let Some(data_url) = icon_data_url {
        let Some((ext, bytes)) = decode_data_url(data_url) else {
            return Err("branding icon: not a base64 data URL".into());
        };
        let icon_dir = data_dir.join("jotty-client");
        std::fs::create_dir_all(&icon_dir).map_err(|e| format!("create icon dir: {e}"))?;
        let icon_file = icon_dir.join(format!("branding-icon.{ext}"));
        std::fs::write(&icon_file, &bytes).map_err(|e| format!("write icon: {e}"))?;
        Some(icon_file.to_string_lossy().to_string())
    } else {
        None
    };

    // Base the patch on an existing entry: the user-level one first (AppImage
    // integration writes there), then the packaged candidates. Skip our own
    // shadow (marker) so re-branding doesn't read its own output as the base.
    let user_entry = data_dir.join("applications").join(DESKTOP_ID);
    let mut candidates: Vec<std::path::PathBuf> = vec![user_entry];
    candidates.extend_from_slice(packaged_paths);
    let packaged = candidates
        .iter()
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .find(|t| !is_ours(t));

    let text = desktop_entry_text(packaged.as_deref(), name, icon_path.as_deref());
    let out_path = apps_dir.join(DESKTOP_ID);
    std::fs::write(&out_path, &text).map_err(|e| format!("write .desktop: {e}"))?;
    Ok(out_path)
}

/// Remove the shadow entry + icon dir, but only the entry WE wrote (marker check).
pub fn remove_inner(data_dir: &std::path::Path) -> Result<bool, String> {
    let entry = data_dir.join("applications").join(DESKTOP_ID);
    let mut removed = false;
    if entry.exists() {
        let ours = std::fs::read_to_string(&entry).map(|t| is_ours(&t)).unwrap_or(false);
        if ours {
            std::fs::remove_file(&entry).map_err(|e| format!("remove .desktop: {e}"))?;
            removed = true;
        } else {
            return Err("existing launcher entry was not written by jotty — leaving it alone".into());
        }
    }
    let icon_dir = data_dir.join("jotty-client");
    if icon_dir.exists() {
        let _ = std::fs::remove_dir_all(&icon_dir); // best effort
    }
    Ok(removed)
}

pub fn status_inner(data_dir: &std::path::Path) -> BrandingDesktopStatus {
    let entry = data_dir.join("applications").join(DESKTOP_ID);
    let active = entry.exists()
        && std::fs::read_to_string(&entry).map(|t| is_ours(&t)).unwrap_or(false);
    BrandingDesktopStatus { supported: true, active }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tempdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("jotty-branding-test-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const PACKAGED: &str = "[Desktop Entry]\nType=Application\nExec=jotty-client\nStartupWMClass=jotty-client\nIcon=jotty-client\nName=jotty-desktop\nTerminal=false\n";

    #[test]
    fn decode_maps_mimes_and_rejects_garbage() {
        assert_eq!(decode_data_url(&format!("data:image/png;base64,{PNG_B64}")).unwrap().0, "png");
        assert_eq!(decode_data_url("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=").unwrap().0, "svg");
        assert_eq!(decode_data_url("data:image/jpeg;base64,AAAA").unwrap().0, "jpg");
        assert!(decode_data_url("not-a-data-url").is_none());
        assert!(decode_data_url("data:image/png;base64,!!!not base64!!!").is_none());
    }

    #[test]
    fn entry_text_patches_name_and_icon_and_keeps_exec() {
        let t = desktop_entry_text(Some(PACKAGED), Some("Acme Notes"), Some("/home/u/.local/share/jotty-client/branding-icon.png"));
        assert!(t.contains("Name=Acme Notes"));
        assert!(t.contains("Icon=/home/u/.local/share/jotty-client/branding-icon.png"));
        assert!(t.contains("Exec=jotty-client")); // inherited from the packaged entry
        assert!(t.contains(BRANDING_MARKER));
        assert!(!t.contains("Name=jotty-desktop\n"));
    }

    #[test]
    fn entry_text_drops_locale_variants_and_synthesizes_without_packaged() {
        let packaged = "[Desktop Entry]\nName=jotty-desktop\nName[de]=altes\nExec=jotty-client\nIcon=jotty-client\n";
        let t = desktop_entry_text(Some(packaged), Some("Acme"), None);
        assert!(t.contains("Name=Acme"));
        assert!(!t.contains("Name[de]"));
        let t2 = desktop_entry_text(None, None, Some("/icon.svg"));
        assert!(t2.contains("[Desktop Entry]"));
        assert!(t2.contains("Exec=jotty-client"));
        assert!(t2.contains("Icon=/icon.svg"));
        assert!(t2.contains("Name=jotty-desktop"));
    }

    #[test]
    fn apply_writes_icon_and_entry_reads_back_active_then_remove_clears() {
        let dir = tempdir("apply");
        let packaged = dir.join("packaged.desktop");
        std::fs::write(&packaged, PACKAGED).unwrap();
        let path = apply_inner(
            &dir,
            &[PathBuf::from("/nonexistent"), packaged.clone()],
            Some("Acme Notes"),
            Some(&format!("data:image/png;base64,{PNG_B64}")),
        )
        .unwrap();
        assert_eq!(path, dir.join("applications").join(DESKTOP_ID));
        let icon = dir.join("jotty-client").join("branding-icon.png");
        assert_eq!(std::fs::read(&icon).unwrap().len(), 70); // decoded 1px png
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("Name=Acme Notes"));
        assert!(text.contains(icon.to_string_lossy().as_ref()));
        assert!(text.contains("Exec=jotty-client"));
        // status + remove round-trip
        assert!(status_inner(&dir).active);
        assert!(remove_inner(&dir).unwrap());
        assert!(!path.exists());
        assert!(!icon.exists());
        assert!(!status_inner(&dir).active);
        // remove again: entry already gone -> Ok(false)
        assert!(!remove_inner(&dir).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn apply_with_name_only_keeps_packaged_icon_and_refuses_clobber_on_remove() {
        let dir = tempdir("name-only");
        // Simulate an AppImage-integrated user entry we did NOT write (no marker):
        let apps = dir.join("applications");
        std::fs::create_dir_all(&apps).unwrap();
        std::fs::write(apps.join(DESKTOP_ID), PACKAGED).unwrap();
        apply_inner(&dir, &[], Some("Acme"), None).unwrap();
        let text = std::fs::read_to_string(apps.join(DESKTOP_ID)).unwrap();
        assert!(text.contains("Name=Acme"));
        assert!(text.contains("Icon=jotty-client")); // icon untouched
        assert!(text.contains(BRANDING_MARKER));
        // foreign pre-existing file is protected: after removing OUR marker line it refuses
        std::fs::write(apps.join(DESKTOP_ID), PACKAGED).unwrap();
        assert!(remove_inner(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
