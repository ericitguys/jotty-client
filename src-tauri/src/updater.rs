//! Self-update: check github releases, download the platform package, install.
//! Linux: detect the owning package family — the deb/rpm database that has
//! the app installed (dpkg vs rpm, strongest signal: how THIS copy got here),
//! falling back to package-manager presence; a running AppImage is a no-system
//! install (family None). .deb → pkexec apt-get, .rpm → pkexec dnf (polkit
//! prompts). Windows: the NSIS -setup.exe, silent (/S).
//!
//! Pure helpers (parse/compare) are unit-testable; I/O fns take injected
//! api base / client / command runner so tests never touch the network
//! (wiremock) or run real commands.
use serde::Deserialize;
use serde_json::Value;

pub const REPO: &str = "ericitguys/jotty-client";

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub available: bool,
    /// Platform-appropriate asset URL: the platform package — .deb/.rpm per
    /// the detected Linux family (None when no system install), NSIS
    /// -setup.exe (windows), .apk (android).
    pub download_url: Option<String>,
}

/// Which desktop package shape to offer. Runtime-determined (compile-time
/// target), but the picker below takes it as a PARAMETER so both arms are
/// unit-testable from any host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopFlavor {
    Linux,
    Windows,
}

/// The deb-vs-rpm family of a Linux install: decides WHICH release asset is
/// offered (check) and which installer runs (install). FIELD BUG 2026-10-18:
/// the updater was rpm/dnf-only — on Ubuntu (a .deb install), the rpm pick +
/// `pkexec /usr/bin/dnf` died with "Error accessing /usr/bin/dnf" (exit 127)
/// and no deb system could ever self-update.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinuxFamily {
    Deb,
    Rpm,
}

/// Pure family picker over the host probes. Order: a package database that
/// OWNS the running install wins (matches how this copy actually got here);
/// `dpkg_owns_app` = Some(true) → Deb, `rpm_owns_app` = Some(true) → Rpm.
/// When neither db claims the app (or the probe tool is missing — None),
/// fall back to manager presence: dnf → Rpm, apt → Deb. Both owners claiming
/// is container noise — DEB wins (the Ubuntu fleet is the user base). No
/// signal at all → None (AppImage run or unknown packaging: no system install
/// to feed; the caller offers nothing).
pub fn linux_family(
    dpkg_owns_app: Option<bool>,
    rpm_owns_app: Option<bool>,
    dnf_present: bool,
    apt_present: bool,
) -> Option<LinuxFamily> {
    if dpkg_owns_app == Some(true) {
        return Some(LinuxFamily::Deb);
    }
    if rpm_owns_app == Some(true) {
        return Some(LinuxFamily::Rpm);
    }
    if dnf_present {
        return Some(LinuxFamily::Rpm);
    }
    if apt_present {
        return Some(LinuxFamily::Deb);
    }
    None
}

fn probe_ok(program: &str, args: &[&str]) -> Option<bool> {
    use std::process::Stdio;
    std::process::Command::new(program)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .ok()
        .map(|s| s.success())
}

/// Host probe (runtime path; NOT unit-tested — thin over `linux_family`).
/// APPIMAGE env is set for ANY run from an AppImage (the mounted squashfs
/// binary still reports the env var), and for those a deb/rpm install would
/// be wrong — the family is None and the updater offers no in-app install.
pub fn linux_family_of_host() -> Option<LinuxFamily> {
    if std::env::var_os("APPIMAGE").is_some() {
        return None;
    }
    linux_family(
        probe_ok("dpkg", &["-s", "jotty-desktop"]),
        probe_ok("rpm", &["-q", "jotty-desktop"]),
        probe_ok("dnf", &["--version"]).unwrap_or(false),
        probe_ok("apt-get", &["--version"]).unwrap_or(false),
    )
}

pub fn desktop_flavor() -> DesktopFlavor {
    #[cfg(target_os = "windows")]
    { DesktopFlavor::Windows }
    #[cfg(not(target_os = "windows"))]
    { DesktopFlavor::Linux }
}

#[derive(Debug, Deserialize)]
pub(crate) struct GhAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    assets: Vec<GhAsset>,
    /// Only present on the /releases LIST endpoint; drafts must never be offered.
    #[serde(default)]
    draft: bool,
}

/// Compare "0.6.1" (app version) against a release tag "v0.6.2" / "0.6.2".
/// Malformed input is an Err, never a silent "no update".
pub(crate) fn is_newer(current: &str, latest_tag: &str) -> Result<bool, String> {
    let latest = latest_tag.strip_prefix('v').unwrap_or(latest_tag);
    let cur = semver::Version::parse(current)
        .map_err(|e| format!("bad current version {current:?}: {e}"))?;
    let lat = semver::Version::parse(latest)
        .map_err(|e| format!("bad release tag {latest_tag:?}: {e}"))?;
    Ok(lat > cur)
}

/// The desktop package pick for a release, per flavor + Linux family:
/// Linux = the family's package (.deb for Deb, .rpm for Rpm; family None =
/// nothing offered). Windows = prefer the NSIS `*-setup.exe`, fall back to
/// any .exe (blockmaps/other assets never match). Assets must carry the
/// app's filename prefix (p19/F5) — a non-app package riding the release
/// (debug symbols, plugin bundles) can never be offered. None = this release
/// carries no package of our kind (up to date, not an error).
pub(crate) fn pick_desktop_asset(
    assets: &[GhAsset],
    flavor: DesktopFlavor,
    family: Option<LinuxFamily>,
) -> Option<String> {
    let owned = assets.iter().filter(|a| a.name.starts_with("jotty-desktop"));
    match flavor {
        DesktopFlavor::Linux => {
            let ext = match family {
                Some(LinuxFamily::Deb) => ".deb",
                Some(LinuxFamily::Rpm) => ".rpm",
                None => return None,
            };
            owned
                .filter(|a| a.name.ends_with(ext))
                .next()
                .map(|a| a.browser_download_url.clone())
        }
        DesktopFlavor::Windows => {
            let exes: Vec<&GhAsset> = owned.filter(|a| a.name.ends_with(".exe")).collect();
            let picked = exes
                .iter()
                .find(|a| a.name.contains("-setup"))
                .or_else(|| exes.first());
            picked.map(|a| a.browser_download_url.clone())
        }
    }
}

/// Extract (tag_name, desktop package url) from a /releases/latest response
/// body, for THIS host's desktop flavor. No matching asset -> Ok with None
/// (a release without a package is "up to date" for our purposes but still
/// reports its tag).
pub(crate) fn parse_release(v: &Value) -> Result<(String, Option<String>), String> {
    parse_release_with(v, desktop_flavor(), linux_family_of_host())
}

/// The pure core of `parse_release` — flavor + family as parameters so the
/// asset pick is unit-testable from any host.
pub(crate) fn parse_release_with(
    v: &Value,
    flavor: DesktopFlavor,
    family: Option<LinuxFamily>,
) -> Result<(String, Option<String>), String> {
    let rel: GhRelease = serde_json::from_value(v.clone())
        .map_err(|e| format!("unexpected release payload: {e}"))?;
    let pkg = pick_desktop_asset(&rel.assets, flavor, family);
    Ok((rel.tag_name, pkg))
}

/// Pick the APK asset for this device: prefer arm64, fall back to the only
/// app-prefixed .apk (p19/F5: the jotty-desktop prefix keeps a non-app .apk
/// riding the release from ever being offered; the preview-era names carry it).
fn pick_apk_asset(assets: &[GhAsset]) -> Option<String> {
    let apks: Vec<&GhAsset> = assets
        .iter()
        .filter(|a| a.name.starts_with("jotty-desktop") && a.name.ends_with(".apk"))
        .collect();
    let picked = match apks.iter().find(|a| a.name.contains("arm64")) {
        Some(a) => a,
        None => apks.first()?,
    };
    Some(picked.browser_download_url.clone())
}

/// Walk a /releases list (GitHub returns newest first) and return the FIRST
/// release carrying an APK asset: (tag, apk_url). Drafts are skipped; releases
/// without an APK are desktop releases and skipped too. None = no android
/// release in the window (up to date, never an error).
fn parse_release_list(v: &Value) -> Result<Option<(String, String)>, String> {
    let rels: Vec<GhRelease> = serde_json::from_value(v.clone())
        .map_err(|e| format!("unexpected releases payload: {e}"))?;
    for rel in rels {
        if rel.draft {
            continue;
        }
        if let Some(url) = pick_apk_asset(&rel.assets) {
            return Ok(Some((rel.tag_name, url)));
        }
    }
    Ok(None)
}

fn updater_client() -> reqwest::Client {
    // GitHub API rejects requests without a User-Agent.
    reqwest::Client::builder()
        .user_agent(concat!("jotty-desktop-updater/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("updater client")
}

/// Check the repo's latest release against `current` (desktop: rpm assets,
/// /releases/latest — prereleases excluded by GitHub).
pub async fn check(
    api_base: &str,
    current: &str,
) -> Result<UpdateInfo, String> {
    let url = format!("{api_base}/repos/{REPO}/releases/latest");
    let resp = updater_client().get(&url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("release check failed: HTTP {status}"));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    let (tag, url) = parse_release(&v)?;
    let available = is_newer(current, &tag)?;
    Ok(UpdateInfo {
        current: current.to_string(),
        latest: tag,
        available,
        download_url: url,
    })
}

/// Android check: walk the releases LIST (prereleases included — android
/// previews ship as prereleases) and offer the newest release with an APK.
pub async fn check_apk(
    api_base: &str,
    current: &str,
) -> Result<UpdateInfo, String> {
    let url = format!("{api_base}/repos/{REPO}/releases?per_page=10");
    let resp = updater_client().get(&url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("release check failed: HTTP {status}"));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    let found = parse_release_list(&v)?;
    let Some((tag, apk_url)) = found else {
        return Ok(UpdateInfo {
            current: current.to_string(),
            latest: "none".into(),
            available: false,
            download_url: None,
        });
    };
    let available = is_newer(current, &tag)?;
    Ok(UpdateInfo {
        current: current.to_string(),
        latest: tag,
        available,
        download_url: Some(apk_url),
    })
}

/// Stream the asset at `url` into `dest_dir`, returning the written path.
/// The filename is derived from the URL's last segment.
pub async fn download(
    url: &str,
    dest_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let fname = url.rsplit('/').next().ok_or_else(|| format!("bad asset url {url:?}"))?;
    if fname.is_empty() {
        return Err(format!("bad asset url {url:?}"));
    }
    std::fs::create_dir_all(dest_dir).map_err(|e| format!("cannot create {}: {e}", dest_dir.display()))?;
    let dest = dest_dir.join(fname);
    let resp = updater_client().get(url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("download failed: HTTP {status}"));
    }
    // stream to a temp sibling first so a partial file is never mistaken for
    // a complete package
    let tmp = dest_dir.join(format!("{fname}.part"));
    {
        use tokio::io::AsyncWriteExt;
        let mut file = tokio::fs::File::create(&tmp)
            .await
            .map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
        let mut stream = resp;
        while let Some(chunk) = stream.chunk().await.map_err(|e| e.to_string())? {
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        }
        file.flush().await.map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &dest).map_err(|e| format!("cannot finalize {}: {e}", dest.display()))?;
    Ok(dest)
}

/// The package manager binary for a detected Linux family, probed at install
/// time (p19/F3, 2026-10-18 audit): an rpm-owned host can lack dnf (yum-only
/// installs) and a deb-owned host can lack apt-get — falling back (dnf→yum,
/// apt-get→apt) beats repeating the /usr/bin/<missing> exit-127 class; None
/// = refuse with a clear error instead of spawning a guaranteed 127.
/// Pure over its probes so the choice is unit-testable.
pub fn rpm_manager(dnf_present: bool, yum_present: bool) -> Option<&'static str> {
    if dnf_present { Some("/usr/bin/dnf") } else if yum_present { Some("/usr/bin/yum") } else { None }
}

pub fn deb_manager(apt_get_present: bool, apt_present: bool) -> Option<&'static str> {
    if apt_get_present { Some("/usr/bin/apt-get") } else if apt_present { Some("/usr/bin/apt") } else { None }
}

/// Rpm-family system install: pkexec → the manager with the FULL binary path
/// (polkit prompts for the root password in the desktop session). `runner`
/// executes (program, args) and returns the exit code — injected so tests
/// assert the exact command shape without touching pkexec/dnf. Non-zero exit
/// is an Err carrying stderr.
pub fn install_rpm_with(
    manager: &str,
    rpm_path: &std::path::Path,
    runner: &dyn Fn(&str, &[&str]) -> Result<std::process::Output, String>,
) -> Result<(), String> {
    run_pkexec_install(rpm_path, manager, "rpm install failed", runner)
}

/// Deb-family system install: pkexec → the manager with the FULL binary path.
/// apt-get (or apt) resolves the local package AND any missing dependencies
/// (dpkg -i would not); `-y` keeps it non-interactive under polkit. Same
/// injected runner contract as the rpm arm.
pub fn install_deb_with(
    manager: &str,
    deb_path: &std::path::Path,
    runner: &dyn Fn(&str, &[&str]) -> Result<std::process::Output, String>,
) -> Result<(), String> {
    run_pkexec_install(deb_path, manager, "deb install failed", runner)
}

/// Shared body of the two Linux arms: `pkexec <manager> install -y <pkg>`.
fn run_pkexec_install(
    pkg_path: &std::path::Path,
    manager: &str,
    fail_label: &str,
    runner: &dyn Fn(&str, &[&str]) -> Result<std::process::Output, String>,
) -> Result<(), String> {
    let out = runner(
        "pkexec",
        &[manager, "install", "-y", &pkg_path.to_string_lossy()],
    )
    .map_err(|e| format!("cannot launch installer: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{} ({}): {}",
            fail_label,
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// Windows install: the Tauri NSIS setup exe, silent (/S). The NSIS build
/// installs per-user (currentUser mode — no UAC prompt); the app's own
/// Restart button finishes the swap afterwards. Runner-injected like the
/// dnf arm, and NOT cfg-gated — the exact command shape is unit-tested from
/// any host (the tests fake the runner's exit status).
pub fn install_windows_with(
    setup_path: &std::path::Path,
    runner: &dyn Fn(&str, &[&str]) -> Result<std::process::Output, String>,
) -> Result<(), String> {
    let out = runner(&setup_path.to_string_lossy(), &["/S"])
        .map_err(|e| format!("cannot launch installer: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "installer failed ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// The real runner: on linux polkit prompts for the root password in the
/// desktop session; on windows the NSIS binary is executed directly.
fn plain_runner(
    program: &str,
    args: &[&str],
) -> Result<std::process::Output, String> {
    std::process::Command::new(program)
        .args(args)
        .output()
        .map_err(|e| e.to_string())
}

/// The real install dispatch (per host OS + detected Linux family). The
/// manager binary is probed HERE (p19/F3): dnf→yum / apt-get→apt fallbacks,
/// with a clear refusal when neither exists on the detected family.
pub fn install(pkg_path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        install_windows_with(pkg_path, &plain_runner)
    }
    #[cfg(not(target_os = "windows"))]
    {
        match linux_family_of_host() {
            Some(LinuxFamily::Deb) => {
                let manager = deb_manager(
                    probe_ok("apt-get", &["--version"]).unwrap_or(false),
                    probe_ok("apt", &["--version"]).unwrap_or(false),
                )
                .ok_or_else(|| {
                    "cannot update: this is a deb-managed system but neither apt-get nor apt was found — install the package from the release page instead".to_string()
                })?;
                install_deb_with(manager, pkg_path, &plain_runner)
            }
            Some(LinuxFamily::Rpm) => {
                let manager = rpm_manager(
                    probe_ok("dnf", &["--version"]).unwrap_or(false),
                    probe_ok("yum", &["--version"]).unwrap_or(false),
                )
                .ok_or_else(|| {
                    "cannot update: this is an rpm-managed system but neither dnf nor yum was found — install the package from the release page instead".to_string()
                })?;
                install_rpm_with(manager, pkg_path, &plain_runner)
            }
            None => Err(
                "cannot update: no deb/rpm system install detected on this machine \
                 (AppImage run or unknown packaging) — install the package from \
                 the release page instead"
                    .into(),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_patch_returns_true() {
        assert!(is_newer("0.6.1", "v0.6.2").unwrap());
    }

    #[test]
    fn same_version_is_not_newer() {
        assert!(!is_newer("0.6.1", "v0.6.1").unwrap());
        assert!(!is_newer("0.6.1", "0.6.1").unwrap());
    }

    #[test]
    fn minor_and_major_bumps_are_newer() {
        assert!(is_newer("0.6.1", "v0.7.0").unwrap());
        assert!(is_newer("0.6.1", "v1.0.0").unwrap());
    }

    #[test]
    fn older_release_is_not_newer() {
        assert!(!is_newer("0.7.0", "v0.6.1").unwrap());
    }

    #[test]
    fn malformed_tag_is_an_error_not_no_update() {
        assert!(is_newer("0.6.1", "banana").is_err());
        assert!(is_newer("garbage", "v0.6.1").is_err());
    }

    fn release_json(tag: &str, assets: &[(&str, &str)]) -> Value {
        serde_json::json!({
            "tag_name": tag,
            "assets": assets.iter().map(|(n, u)| serde_json::json!({
                "name": n, "browser_download_url": u
            })).collect::<Vec<_>>()
        })
    }

    #[test]
    fn parse_release_finds_the_rpm_asset() {
        let (tag, url) = parse_release_with(
            &release_json("v0.7.0", &[
                ("jotty-desktop_0.7.0_amd64.deb", "https://x/deb"),
                ("jotty-desktop-0.7.0-1.x86_64.rpm", "https://x/rpm"),
                ("jotty-desktop_0.7.0_amd64.AppImage", "https://x/ai"),
            ]),
            DesktopFlavor::Linux,
            Some(LinuxFamily::Rpm),
        ).unwrap();
        assert_eq!(tag, "v0.7.0");
        assert_eq!(url.as_deref(), Some("https://x/rpm"));
    }

    #[test]
    fn parse_release_without_rpm_asset_reports_none() {
        let (tag, url) = parse_release_with(
            &release_json("v0.7.0", &[
                ("jotty-desktop_0.7.0_amd64.deb", "https://x/deb"),
            ]),
            DesktopFlavor::Linux,
            Some(LinuxFamily::Rpm),
        ).unwrap();
        assert_eq!(tag, "v0.7.0");
        assert!(url.is_none());
    }

    #[test]
    fn parse_release_rejects_unexpected_payload() {
        assert!(parse_release(&serde_json::json!({"foo": 1})).is_err());
    }

    // ---- android: guided update (prereleases + apk asset pick) ----

    fn releases_list_json(entries: &[Value]) -> Value {
        Value::Array(entries.to_vec())
    }

    #[test]
    fn pick_apk_prefers_arm64_and_skips_non_apk_assets() {
        let v = release_json("v1", &[
            ("jotty-desktop-0.10.2-amd64.deb", "https://x/deb"),
            ("jotty-desktop-0.10.2-android-arm64.apk", "https://x/apk-arm64"),
        ]);
        let rel: GhRelease = serde_json::from_value(v).unwrap();
        assert_eq!(
            pick_apk_asset(&rel.assets).as_deref(),
            Some("https://x/apk-arm64")
        );
        let v2 = release_json("v1", &[("jotty-desktop_1_amd64.deb", "https://x/deb")]);
        let rel2: GhRelease = serde_json::from_value(v2).unwrap();
        assert!(pick_apk_asset(&rel2.assets).is_none());
    }

    #[test]
    fn parse_release_list_picks_newest_apk_release_and_skips_drafts_and_desktop_only() {
        let list = releases_list_json(&[
            // draft: never offered
            serde_json::json!({"tag_name": "v0.11.0", "draft": true, "assets": [
                {"name": "jotty-0.11.0-android-arm64.apk", "browser_download_url": "https://x/apk-draft"}]}),
            // desktop-only release: not for android
            serde_json::json!({"tag_name": "v0.11.0", "draft": false, "assets": [
                {"name": "jotty-0.11.0-1.x86_64.rpm", "browser_download_url": "https://x/rpm"}]}),
            // newest android release
            serde_json::json!({"tag_name": "v0.10.2-android-preview", "draft": false, "assets": [
                {"name": "jotty-desktop-0.10.2-android-arm64.apk", "browser_download_url": "https://x/apk-0102"}]}),
            // older android release: must NOT be picked
            serde_json::json!({"tag_name": "v0.10.1-android-preview", "draft": false, "assets": [
                {"name": "jotty-desktop-0.10.1-android-arm64.apk", "browser_download_url": "https://x/apk-0101"}]}),
        ]);
        let found = parse_release_list(&list).unwrap();
        assert_eq!(
            found,
            Some(("v0.10.2-android-preview".into(), "https://x/apk-0102".into()))
        );
        // no apk anywhere -> None (up to date, not an error)
        let empty = releases_list_json(&[serde_json::json!({"tag_name": "v0.10.0", "draft": false, "assets": []})]);
        assert_eq!(parse_release_list(&empty).unwrap(), None);
    }

    #[tokio::test]
    async fn check_apk_finds_a_newer_prerelease_with_an_apk() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/repos/ericitguys/jotty-client/releases"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(releases_list_json(&[
                serde_json::json!({"tag_name": "v0.10.2-android-preview", "draft": false, "assets": [
                    {"name": "jotty-desktop-0.10.2-android-arm64.apk", "browser_download_url": "https://x/apk-0102"}]}),
                serde_json::json!({"tag_name": "v0.10.0", "draft": false, "assets": [
                    {"name": "jotty-0.10.0-1.x86_64.rpm", "browser_download_url": "https://x/rpm"}]}),
            ])))
            .mount(&server)
            .await;
        let info = check_apk(&server.uri(), "0.10.1").await.unwrap();
        assert!(info.available);
        assert_eq!(info.latest, "v0.10.2-android-preview");
        assert_eq!(info.download_url.as_deref(), Some("https://x/apk-0102"));
    }

    #[tokio::test]
    async fn check_apk_is_up_to_date_when_running_the_newest_apk_release() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/repos/ericitguys/jotty-client/releases"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(releases_list_json(&[
                serde_json::json!({"tag_name": "v0.10.1-android-preview", "draft": false, "assets": [
                    {"name": "jotty-desktop-0.10.1-android-arm64.apk", "browser_download_url": "https://x/apk"}]}),
            ])))
            .mount(&server)
            .await;
        let info = check_apk(&server.uri(), "0.10.1").await.unwrap();
        assert!(!info.available);
    }

    #[tokio::test]
    async fn check_apk_surfaces_http_errors() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .respond_with(wiremock::ResponseTemplate::new(403))
            .mount(&server)
            .await;
        let err = check_apk(&server.uri(), "0.10.1").await.unwrap_err();
        assert!(err.contains("403"), "got: {err}");
    }

    #[tokio::test]
    async fn check_detects_an_update() {
        let server = wiremock::MockServer::start().await;
        // BOTH desktop packages ride the mock release: the host's detected
        // family decides the pick (rpm on dnf hosts, deb on apt hosts) —
        // pin only the family-consistent shape here, not a hard asset.
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/repos/ericitguys/jotty-client/releases/latest"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(release_json(
                "v0.7.0",
                &[
                    ("jotty-desktop_0.7.0_amd64.deb", "https://x/jotty-desktop_0.7.0_amd64.deb"),
                    ("jotty-desktop-0.7.0-1.x86_64.rpm", "https://x/jotty-desktop-0.7.0-1.x86_64.rpm"),
                ],
            )))
            .mount(&server)
            .await;
        let info = check(&server.uri(), "0.6.1").await.unwrap();
        assert!(info.available);
        assert_eq!(info.latest, "v0.7.0");
        assert_eq!(info.current, "0.6.1");
        let url = info.download_url.expect("a probed desktop host gets a package url");
        assert!(url.ends_with(".deb") || url.ends_with(".rpm"), "family-matched pick: {url}");
    }

    #[tokio::test]
    async fn check_reports_up_to_date() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/repos/ericitguys/jotty-client/releases/latest"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(release_json(
                "v0.6.1",
                &[("jotty-desktop-0.6.1-1.x86_64.rpm", "https://x/rpm")],
            )))
            .mount(&server)
            .await;
        let info = check(&server.uri(), "0.6.1").await.unwrap();
        assert!(!info.available);
    }

    #[tokio::test]
    async fn check_surfaces_http_errors() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .respond_with(wiremock::ResponseTemplate::new(403))
            .mount(&server)
            .await;
        let err = check(&server.uri(), "0.6.1").await.unwrap_err();
        assert!(err.contains("403"), "got: {err}");
    }

    #[tokio::test]
    async fn check_surfaces_malformed_tag_as_error() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(release_json(
                "banana",
                &[("jotty-desktop-0.7.0-1.x86_64.rpm", "https://x/rpm")],
            )))
            .mount(&server)
            .await;
        assert!(check(&server.uri(), "0.6.1").await.is_err());
    }

    #[tokio::test]
    async fn download_streams_the_asset_to_dest_dir() {
        let server = wiremock::MockServer::start().await;
        let body = b"fake rpm bytes 1234567890".to_vec();
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_bytes(body.clone()))
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let dest = download(&format!("{}/pkgs/jotty-0.7.0.rpm", server.uri()), dir.path()).await.unwrap();
        assert_eq!(dest.file_name().unwrap(), "jotty-0.7.0.rpm");
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        // no stray .part files left behind
        let entries: Vec<_> = std::fs::read_dir(dir.path()).unwrap().collect();
        assert_eq!(entries.len(), 1);
    }

    #[tokio::test]
    async fn download_surfaces_http_errors() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .respond_with(wiremock::ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let err = download(&format!("{}/pkgs/jotty-0.7.0.rpm", server.uri()), dir.path()).await.unwrap_err();
        assert!(err.contains("404"));
        // no partial files left behind
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn download_replaces_previous_package_cleanly() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_bytes(b"newer".to_vec()))
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let dest = download(&format!("{}/jotty-0.7.0.rpm", server.uri()), dir.path()).await.unwrap();
        std::fs::write(&dest, b"older").unwrap(); // simulate a previous download
        let dest2 = download(&format!("{}/jotty-0.7.0.rpm", server.uri()), dir.path()).await.unwrap();
        assert_eq!(std::fs::read(dest2).unwrap(), b"newer");
    }

    // ---- linux: family detection + deb arm (FIELD BUG 2026-10-18: the
    // updater was rpm/dnf-only — on Ubuntu, pkexec /usr/bin/dnf exits 127
    // and a deb install can never self-update) ----

    #[test]
    fn linux_family_owns_db_beats_everything_deb_wins_the_tie() {
        // the database that OWNS the running install is the strongest signal
        assert_eq!(linux_family(Some(true), None, false, false), Some(LinuxFamily::Deb));
        assert_eq!(linux_family(None, Some(true), true, true), Some(LinuxFamily::Rpm));
        // both db's claim the app: DEB wins (ruled — Ubuntu fleet is the user
        // base; a dpdb claim on an rpm-managed box is container noise)
        assert_eq!(linux_family(Some(true), Some(true), true, true), Some(LinuxFamily::Deb));
    }

    #[test]
    fn linux_family_falls_back_to_manager_presence_then_none() {
        // neither db reachable/claiming: dnf → rpm, apt → deb, nothing → None
        assert_eq!(linux_family(None, None, true, true), Some(LinuxFamily::Rpm));
        assert_eq!(linux_family(None, None, false, true), Some(LinuxFamily::Deb));
        assert_eq!(linux_family(Some(false), Some(false), false, false), None);
        assert_eq!(linux_family(None, None, false, false), None);
    }

    #[test]
    fn linux_pick_follows_the_family() {
        let rel: GhRelease = serde_json::from_value(release_json("v0.31.2", &[
            ("jotty-desktop_0.31.2_amd64.deb", "https://x/deb"),
            ("jotty-desktop-0.31.2-1.x86_64.rpm", "https://x/rpm"),
        ])).unwrap();
        assert_eq!(
            pick_desktop_asset(&rel.assets, DesktopFlavor::Linux, Some(LinuxFamily::Deb)).as_deref(),
            Some("https://x/deb")
        );
        assert_eq!(
            pick_desktop_asset(&rel.assets, DesktopFlavor::Linux, Some(LinuxFamily::Rpm)).as_deref(),
            Some("https://x/rpm")
        );
        // no family (AppImage run / unknown packaging): nothing is offered —
        // the deb/rpm arms would both be wrong for this install
        assert_eq!(pick_desktop_asset(&rel.assets, DesktopFlavor::Linux, None), None);
        // missing the family's asset -> None (release without that package)
        let deb_only: GhRelease = serde_json::from_value(release_json("v0.31.2", &[
            ("jotty-desktop_0.31.2_amd64.deb", "https://x/deb"),
        ])).unwrap();
        assert_eq!(pick_desktop_asset(&deb_only.assets, DesktopFlavor::Linux, Some(LinuxFamily::Rpm)), None);
    }

    #[test]
    fn parse_release_with_pins_flavor_and_family() {
        let rel = release_json("v0.31.2", &[
            ("jotty-desktop_0.31.2_amd64.deb", "https://x/deb"),
            ("jotty-desktop-0.31.2-1.x86_64.rpm", "https://x/rpm"),
        ]);
        let (tag, url) = parse_release_with(&rel, DesktopFlavor::Linux, Some(LinuxFamily::Deb)).unwrap();
        assert_eq!(tag, "v0.31.2");
        assert_eq!(url.as_deref(), Some("https://x/deb"));
        let (_, url_rpm) = parse_release_with(&rel, DesktopFlavor::Linux, Some(LinuxFamily::Rpm)).unwrap();
        assert_eq!(url_rpm.as_deref(), Some("https://x/rpm"));
        let (_, url_win) = parse_release_with(&rel, DesktopFlavor::Windows, None).unwrap();
        assert_eq!(url_win, None);
    }

    #[test]
    fn install_deb_runs_pkexec_aptget_with_the_full_path() {
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let calls2 = calls.clone();
        let runner = move |program: &str, args: &[&str]| {
            calls2.lock().unwrap().push((program.to_string(), args.iter().map(|s| s.to_string()).collect::<Vec<_>>()));
            Ok(std::process::Output { status: std::os::unix::process::ExitStatusExt::from_raw(0), stdout: vec![], stderr: vec![] })
        };
        install_deb_with("/usr/bin/apt-get", std::path::Path::new("/tmp/x/jotty-desktop_0.31.2_amd64.deb"), &runner).unwrap();
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "pkexec");
        assert_eq!(
            calls[0].1,
            vec!["/usr/bin/apt-get", "install", "-y", "/tmp/x/jotty-desktop_0.31.2_amd64.deb"]
        );
    }

    #[test]
    fn install_deb_surfaces_aptget_failure_with_stderr() {
        let runner = |_program: &str, _args: &[&str]| {
            Ok(std::process::Output {
                status: std::os::unix::process::ExitStatusExt::from_raw(256),
                stdout: vec![],
                stderr: b"dpkg error: dependency problems".to_vec(),
            })
        };
        let err = install_deb_with("/usr/bin/apt-get", std::path::Path::new("/tmp/x.deb"), &runner).unwrap_err();
        // manager-agnostic label since the p19 manager-fallback rework
        assert!(err.contains("deb install failed"), "got: {err}");
        assert!(err.contains("dpkg error: dependency problems"));
    }

    #[test]
    fn install_rpm_runs_pkexec_dnf_with_the_full_path() {
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let calls2 = calls.clone();
        let runner = move |program: &str, args: &[&str]| {
            calls2.lock().unwrap().push((program.to_string(), args.iter().map(|s| s.to_string()).collect::<Vec<_>>()));
            Ok(std::process::Output { status: std::os::unix::process::ExitStatusExt::from_raw(0), stdout: vec![], stderr: vec![] })
        };
        install_rpm_with("/usr/bin/dnf", std::path::Path::new("/tmp/x/jotty-0.7.0-1.x86_64.rpm"), &runner).unwrap();
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "pkexec");
        assert_eq!(calls[0].1, vec!["/usr/bin/dnf", "install", "-y", "/tmp/x/jotty-0.7.0-1.x86_64.rpm"]);
    }

    #[test]
    fn install_surfaces_dnf_failure_with_stderr() {
        let runner = |_program: &str, _args: &[&str]| {
            Ok(std::process::Output {
                status: std::os::unix::process::ExitStatusExt::from_raw(256), // exit code 1
                stdout: vec![],
                stderr: b"nothing provides".to_vec(),
            })
        };
        let err = install_rpm_with("/usr/bin/dnf", std::path::Path::new("/tmp/x.rpm"), &runner).unwrap_err();
        // manager-agnostic label since the p19 manager-fallback rework
        assert!(err.contains("rpm install failed"));
        assert!(err.contains("nothing provides"));
    }

    // ---- p19 audit follow-ups (2026-10-18): manager fallbacks + prefix pin ----

    #[test]
    fn rpm_manager_falls_back_to_yum_then_refuses() {
        assert_eq!(rpm_manager(true, false), Some("/usr/bin/dnf"));
        assert_eq!(rpm_manager(true, true), Some("/usr/bin/dnf"));
        assert_eq!(rpm_manager(false, true), Some("/usr/bin/yum"));
        assert_eq!(rpm_manager(false, false), None);
    }

    #[test]
    fn deb_manager_falls_back_to_apt_then_refuses() {
        assert_eq!(deb_manager(true, false), Some("/usr/bin/apt-get"));
        assert_eq!(deb_manager(false, true), Some("/usr/bin/apt"));
        assert_eq!(deb_manager(true, true), Some("/usr/bin/apt-get"));
        assert_eq!(deb_manager(false, false), None);
    }

    #[test]
    fn pick_desktop_asset_requires_the_jotty_desktop_prefix() {
        // a non-app package riding the release must never be offered (p19/F5)
        let rel: GhRelease = serde_json::from_value(release_json("v0.31.4", &[
            ("jotty-debug_0.31.4_amd64.deb", "https://x/stray-deb"),
            ("jotty-desktop_0.31.4_amd64.deb", "https://x/deb"),
            ("jotty-debug-0.31.4-1.x86_64.rpm", "https://x/stray-rpm"),
            ("jotty-desktop-0.31.4-1.x86_64.rpm", "https://x/rpm"),
        ])).unwrap();
        assert_eq!(
            pick_desktop_asset(&rel.assets, DesktopFlavor::Linux, Some(LinuxFamily::Deb)).as_deref(),
            Some("https://x/deb")
        );
        assert_eq!(
            pick_desktop_asset(&rel.assets, DesktopFlavor::Linux, Some(LinuxFamily::Rpm)).as_deref(),
            Some("https://x/rpm")
        );
        let win: GhRelease = serde_json::from_value(release_json("v0.31.4", &[
            ("other-tool-setup.exe", "https://x/stray"),
            ("jotty-desktop_0.31.4_x64-setup.exe", "https://x/setup"),
        ])).unwrap();
        assert_eq!(
            pick_desktop_asset(&win.assets, DesktopFlavor::Windows, None).as_deref(),
            Some("https://x/setup")
        );
    }

    #[test]
    fn pick_apk_asset_requires_the_jotty_desktop_prefix() {
        // a non-app .apk riding the release must never be offered (p19/F5)
        let stray_first: GhRelease = serde_json::from_value(release_json("v1", &[
            ("stray-thing-1.0-android-arm64.apk", "https://x/stray-apk"),
            ("jotty-desktop-0.10.2-android-arm64.apk", "https://x/apk-arm64"),
        ])).unwrap();
        assert_eq!(pick_apk_asset(&stray_first.assets).as_deref(), Some("https://x/apk-arm64"));
        // ONLY a stray apk -> None (no app package in the release)
        let stray_only: GhRelease = serde_json::from_value(release_json("v1", &[
            ("stray-thing-1.0-android-arm64.apk", "https://x/stray-apk"),
        ])).unwrap();
        assert_eq!(pick_apk_asset(&stray_only.assets), None);
    }

    #[test]
    fn windows_flavor_prefers_the_nsis_setup_exe() {
        let rel: GhRelease = serde_json::from_value(release_json("v0.23.0", &[
            ("jotty-desktop_0.23.0_amd64.deb", "https://x/deb"),
            ("jotty-desktop_0.23.0_x64-setup.exe", "https://x/setup"),
            ("jotty-desktop_0.23.0_amd64.AppImage", "https://x/ai"),
        ])).unwrap();
        assert_eq!(
            pick_desktop_asset(&rel.assets, DesktopFlavor::Windows, None).as_deref(),
            Some("https://x/setup")
        );
    }

    #[test]
    fn windows_flavor_falls_back_to_any_exe_but_never_non_exe_assets() {
        let rel: GhRelease = serde_json::from_value(release_json("v0.23.0", &[
            ("jotty-desktop_0.23.0_amd64.deb", "https://x/deb"),
            ("jotty-desktop_0.23.0_x64.exe", "https://x/plain-exe"),
            ("jotty-desktop_0.23.0_x64-setup.exe.blockmap", "https://x/blockmap"),
        ])).unwrap();
        // no -setup asset: the plain exe beats the (non-matching) blockmap
        assert_eq!(
            pick_desktop_asset(&rel.assets, DesktopFlavor::Windows, None).as_deref(),
            Some("https://x/plain-exe")
        );
        let none: GhRelease = serde_json::from_value(release_json("v0.23.0", &[
            ("jotty-desktop_0.23.0-1.x86_64.rpm", "https://x/rpm"),
        ])).unwrap();
        assert!(pick_desktop_asset(&none.assets, DesktopFlavor::Windows, None).is_none());
    }

    // runtime dispatch: parse_release consults THIS host (flavor + family
    // probe). On desktop hosts the family probe resolves (dev box: apt-family
    // or rpm-family — either way the deb+rpm release yields SOME package);
    // exe-only releases yield None on non-windows hosts either way.
    #[test]
    fn parse_release_uses_the_runtime_flavor_for_the_desktop_pick() {
        let exe_only = release_json("v0.31.2", &[
            ("jotty-desktop_0.31.2_x64-setup.exe", "https://x/setup"),
        ]);
        let with_deb_and_rpm = release_json("v0.31.2", &[
            ("jotty-desktop_0.31.2_amd64.deb", "https://x/jotty-desktop_0.31.2_amd64.deb"),
            ("jotty-desktop-0.31.2-1.x86_64.rpm", "https://x/jotty-desktop-0.31.2-1.x86_64.rpm"),
        ]);
        if cfg!(target_os = "windows") {
            assert_eq!(parse_release(&exe_only).unwrap().1.as_deref(), Some("https://x/setup"));
            assert_eq!(parse_release(&with_deb_and_rpm).unwrap().1.as_deref(), Some("https://x/setup"));
        } else {
            assert_eq!(parse_release(&exe_only).unwrap().1.as_deref(), None);
            let got = parse_release(&with_deb_and_rpm).unwrap().1;
            assert!(got.is_some(), "deb+rpm release must yield a package on a probed linux host");
            let got = got.unwrap();
            assert!(
                got.ends_with(".deb") || got.ends_with(".rpm"),
                "runtime pick must match the host family: {got:?}"
            );
        }
    }

    fn win_output(code: i32, stderr: &str) -> std::process::Output {
        // tests run on the dev linux box; the windows arm of install() is
        // never unit-run here — ExitStatusExt::from_raw encodes the exit code.
        #[cfg(unix)]
        return std::process::Output {
            status: std::os::unix::process::ExitStatusExt::from_raw(code << 8),
            stdout: vec![],
            stderr: stderr.as_bytes().to_vec(),
        };
        #[cfg(windows)]
        return std:: process::Output {
            status: std::os::windows::process::ExitStatusExt::from_raw(code as u32),
            stdout: vec![],
            stderr: stderr.as_bytes().to_vec(),
        };
    }

    #[test]
    fn install_windows_runs_the_setup_exe_silently() {
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let calls2 = calls.clone();
        let runner = move |program: &str, args: &[&str]| {
            calls2.lock().unwrap().push((program.to_string(), args.iter().map(|s| s.to_string()).collect::<Vec<_>>()));
            Ok(win_output(0, "installer stderr tail"))
        };
        install_windows_with(std::path::Path::new(r"C:\cache\updates\jotty-desktop_0.23.0_x64-setup.exe"), &runner).unwrap();
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, r"C:\cache\updates\jotty-desktop_0.23.0_x64-setup.exe");
        assert_eq!(calls[0].1, vec!["/S"]);
    }

    #[test]
    fn install_windows_surfaces_a_failed_installer_exit() {
        let runner = move |_p: &str, _a: &[&str]| Ok(win_output(1, "cannot write to dir"));
        let err = install_windows_with(std::path::Path::new("C:\\x\\setup.exe"), &runner).unwrap_err();
        assert!(err.contains("installer failed"), "got: {err}");
        assert!(err.contains("cannot write to dir"));
    }
}