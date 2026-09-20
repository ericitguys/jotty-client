//! Self-update: check github releases, download the rpm, install via dnf+polkit.
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
    /// Platform-appropriate asset URL: the .rpm on desktop, the .apk on Android.
    pub download_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GhAsset {
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

/// Extract (tag_name, rpm download url) from a /releases/latest response body.
/// No .rpm asset -> Ok with None (a release without a package is "up to date"
/// for our purposes but still reports its tag).
pub(crate) fn parse_release(v: &Value) -> Result<(String, Option<String>), String> {
    let rel: GhRelease = serde_json::from_value(v.clone())
        .map_err(|e| format!("unexpected release payload: {e}"))?;
    let rpm = rel
        .assets
        .iter()
        .find(|a| a.name.ends_with(".rpm"))
        .map(|a| a.browser_download_url.clone());
    Ok((rel.tag_name, rpm))
}

/// Pick the APK asset for this device: prefer arm64, fall back to the only .apk.
fn pick_apk_asset(assets: &[GhAsset]) -> Option<String> {
    let apks: Vec<&GhAsset> = assets.iter().filter(|a| a.name.ends_with(".apk")).collect();
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

/// Run the system install. `runner` executes (program, args) and returns the
/// exit code — injected so tests assert the exact command shape without
/// touching pkexec/dnf. Non-zero exit is an Err carrying stderr.
pub fn install_with(
    rpm_path: &std::path::Path,
    runner: &dyn Fn(&str, &[&str]) -> Result<std::process::Output, String>,
) -> Result<(), String> {
    let out = runner(
        "pkexec",
        &["/usr/bin/dnf", "install", "-y", &rpm_path.to_string_lossy()],
    )
    .map_err(|e| format!("cannot launch installer: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "dnf install failed ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// The real runner: polkit prompts for the root password in the desktop session.
pub fn install(rpm_path: &std::path::Path) -> Result<(), String> {
    install_with(rpm_path, &|program, args| {
        std::process::Command::new(program)
            .args(args)
            .output()
            .map_err(|e| e.to_string())
    })
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
        let (tag, url) = parse_release(&release_json("v0.7.0", &[
            ("jotty-desktop_0.7.0_amd64.deb", "https://x/deb"),
            ("jotty-desktop-0.7.0-1.x86_64.rpm", "https://x/rpm"),
            ("jotty-desktop_0.7.0_amd64.AppImage", "https://x/ai"),
        ])).unwrap();
        assert_eq!(tag, "v0.7.0");
        assert_eq!(url.as_deref(), Some("https://x/rpm"));
    }

    #[test]
    fn parse_release_without_rpm_asset_reports_none() {
        let (tag, url) = parse_release(&release_json("v0.7.0", &[
            ("jotty-desktop_0.7.0_amd64.deb", "https://x/deb"),
        ])).unwrap();
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
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/repos/ericitguys/jotty-client/releases/latest"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(release_json(
                "v0.7.0",
                &[("jotty-desktop-0.7.0-1.x86_64.rpm", "https://x/rpm")],
            )))
            .mount(&server)
            .await;
        let info = check(&server.uri(), "0.6.1").await.unwrap();
        assert!(info.available);
        assert_eq!(info.latest, "v0.7.0");
        assert_eq!(info.current, "0.6.1");
        assert_eq!(info.download_url.as_deref(), Some("https://x/rpm"));
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

    #[test]
    fn install_runs_pkexec_dnf_with_the_full_path() {
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let calls2 = calls.clone();
        let runner = move |program: &str, args: &[&str]| {
            calls2.lock().unwrap().push((program.to_string(), args.iter().map(|s| s.to_string()).collect::<Vec<_>>()));
            Ok(std::process::Output { status: std::os::unix::process::ExitStatusExt::from_raw(0), stdout: vec![], stderr: vec![] })
        };
        install_with(std::path::Path::new("/tmp/x/jotty-0.7.0-1.x86_64.rpm"), &runner).unwrap();
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
        let err = install_with(std::path::Path::new("/tmp/x.rpm"), &runner).unwrap_err();
        assert!(err.contains("dnf install failed"));
        assert!(err.contains("nothing provides"));
    }
}