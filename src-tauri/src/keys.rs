use crate::error::{AppError, AppResult};

pub trait KeyStore: Send + Sync {
    fn get(&self) -> AppResult<Option<String>>;
    fn set(&self, key: &str) -> AppResult<()>;
    fn delete(&self) -> AppResult<()>;
}

#[derive(Default)]
pub struct MockKeyStore(pub std::sync::Mutex<Option<String>>);

impl KeyStore for MockKeyStore {
    fn get(&self) -> AppResult<Option<String>> {
        Ok(self.0.lock().unwrap().clone())
    }
    fn set(&self, key: &str) -> AppResult<()> {
        *self.0.lock().unwrap() = Some(key.to_string());
        Ok(())
    }
    fn delete(&self) -> AppResult<()> {
        *self.0.lock().unwrap() = None;
        Ok(())
    }
}

pub struct OsKeyStore;

const SERVICE: &str = "jotty-desktop";
pub const ACCOUNT: &str = "api-key";
pub const AI_ACCOUNT: &str = "openwebui-key";

/// P10: migrate a legacy plaintext mobile_store file (`${SERVICE}-${account}.key`
/// under the app data dir) into the given keystore.
///
/// Law (spec §Failure posture): the plaintext file is the only copy until a
/// set-or-confirmed-existing succeeds — a failed set NEVER deletes it.
/// - keystore empty + file present  -> set the file's value, then delete file.
/// - keystore set + file present    -> stale copy: delete file, keystore value
///   PRESERVED (never clobbered by the stale plaintext).
/// - no file                        -> no-op (idempotent).
/// Returns the account name migrated (set happened) for logging; Ok(None) when
/// nothing was pending.
pub fn keys_migrate_legacy(
    dir: &std::path::Path,
    account: &str,
    ks: &dyn KeyStore,
) -> AppResult<Option<String>> {
    let path = dir.join(format!("{SERVICE}-{account}.key"));
    if !path.exists() {
        return Ok(None);
    }
    let contents = std::fs::read_to_string(&path)
        .map_err(|e| AppError::Keyring(format!("read legacy key store: {e}")))?;
    if ks.get()?.is_none() {
        ks.set(contents.as_str())?;
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(Some(account.to_string())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Some(account.to_string())),
            Err(e) => Err(AppError::Keyring(format!("delete legacy key store: {e}"))),
        }
    } else {
        // keystore already authoritative: the plaintext copy is redundant — remove it.
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(None),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(AppError::Keyring(format!("delete legacy key store: {e}"))),
        }
    }
}

/// Key storage (P10 shape, all platforms):
/// - desktop: platform keyring via `keyring` v3 (secret-service / Apple /
///   Windows native) — unchanged.
/// - android: `android-keyring` 0.2.0 installs a keyring-v3 CredentialBuilder
///   at startup (lib.rs, cfg android): the AES encryption key lives in the
///   SYSTEM AndroidKeyStore, credential blobs rest encrypted in app-private
///   prefs. No Java code, nothing in `gen/`. The same `entry()` path below
///   then serves BOTH platforms — the old plaintext-file `mobile_store`
///   fallback is DELETED; legacy files migrate once at startup
///   (see keys_migrate_legacy).
fn entry(account: &str) -> AppResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, account).map_err(|e| AppError::Keyring(e.to_string()))
}

fn get_for(account: &str) -> AppResult<Option<String>> {
    match entry(account)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(AppError::Keyring(e.to_string())),
    }
}

fn set_for(account: &str, key: &str) -> AppResult<()> {
    entry(account)?
        .set_password(key)
        .map_err(|e| AppError::Keyring(e.to_string()))
}

fn delete_for(account: &str) -> AppResult<()> {
    match entry(account)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Keyring(e.to_string())),
    }
}

impl KeyStore for OsKeyStore {
    fn get(&self) -> AppResult<Option<String>> {
        get_for(ACCOUNT)
    }
    fn set(&self, key: &str) -> AppResult<()> {
        set_for(ACCOUNT, key)
    }
    fn delete(&self) -> AppResult<()> {
        delete_for(ACCOUNT)
    }
}

/// Same service, AI account (spec §4: jotty-desktop / openwebui-key).
/// Untestable headlessly — desktop smoke check remains a release gate.
pub struct AiOsKeyStore;

impl KeyStore for AiOsKeyStore {
    fn get(&self) -> AppResult<Option<String>> {
        get_for(AI_ACCOUNT)
    }
    fn set(&self, key: &str) -> AppResult<()> {
        set_for(AI_ACCOUNT, key)
    }
    fn delete(&self) -> AppResult<()> {
        delete_for(AI_ACCOUNT)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn mock_keystore_roundtrip() {
        let ks = MockKeyStore::default();
        assert_eq!(ks.get().unwrap(), None);
        ks.set("ck_abc").unwrap();
        assert_eq!(ks.get().unwrap().as_deref(), Some("ck_abc"));
        ks.delete().unwrap();
        assert_eq!(ks.get().unwrap(), None);
    }

    // ---- P10: legacy plaintext migration (android), v0.30.1 hotfix shape ----
    // Registration law since v0.30.1: lib.rs must NOT call
    // set_android_keyring_credential_builder() — the ndk-context path —
    // because tao 0.35 / wry 0.55 never initialize ndk-context and the
    // context getter PANICS (v0.30.0 field report: app opens and instantly
    // closes). The builder registers from Kotlin: MainActivity.onCreate
    // calls the android-keyring JNI export (io.crates.keyring.Keyring
    // shim, loadLibrary("jotty_client_lib")) BEFORE super.onCreate(), so
    // it is installed before this Tauri runtime starts. lib.rs's law: the
    // BOTH-accounts legacy migration runs BEFORE AppState::new
    // (restore_connection then reads migrated credentials). The
    // gen/android fences skip on hosts without the generated project
    // (gen/ is gitignored; only the android build host carries it).
    // Comment bodies are stripped first (root-cause comments carry the
    // asserted literals — repo precedent).
    #[test]
    fn android_keyring_registration_shape_kotlin_before_rust_startup() {
        let src = std::fs::read_to_string("src/lib.rs").unwrap();
        let code: String = src
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            code.find("set_android_keyring_credential_builder").is_none(),
            "lib.rs must NOT call the ndk-context registration (tao/wry never initialize ndk-context — it panics; v0.30.0 crash)"
        );
        assert!(
            code.contains("ANDROID_KEYRING_JNI_HOLD"),
            "lib.rs must hold the android-keyring JNI symbol via the link-hold static (nothing else references the crate; archive granularity drops its code object — symbol vanishes from the cdylib and the Kotlin shim gets UnsatisfiedLinkError)"
        );
        assert!(
            code.contains("\"keyring-builder-status\""),
            "lib.rs must gate the legacy plaintext migration on the keyring-builder-status marker"
        );
        assert!(
            code.contains("marker == \"ok\""),
            "the marker read must fail-CLOSED (any non-ok value = migration skipped, plaintext kept)"
        );
        let migrate_at = code
            .find("keys_migrate_legacy")
            .expect("lib.rs must wire the legacy plaintext migration");
        // BOTH accounts migrate.
        assert!(code.contains("(keys::ACCOUNT, \"api-key\")"), "api-key account must be in the migration list");
        assert!(code.contains("(keys::AI_ACCOUNT, \"openwebui-key\")"), "openwebui-key account must be in the migration list");
        let appstate_at = code
            .find("state::AppState::new(")
            .expect("lib.rs must construct AppState");
        assert!(
            migrate_at < appstate_at,
            "legacy migration must run BEFORE AppState::new (restore_connection then reads migrated keys)"
        );

        // gen/android fences (android build host only — gen/ is gitignored).
        let main_activity =
            std::path::Path::new("gen/android/app/src/main/java/page/jotty/desktop/MainActivity.kt");
        if !main_activity.exists() {
            return;
        }
        let kt_src = std::fs::read_to_string(main_activity).unwrap();
        let kt: String = kt_src
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");
        let reg_at = kt
            .find("Keyring.setAndroidKeyringCredentialBuilder")
            .expect("MainActivity must call the Keyring shim registration");
        let super_at = kt
            .find("super.onCreate")
            .expect("MainActivity must call super.onCreate");
        assert!(
            reg_at < super_at,
            "keyring builder must be registered BEFORE super.onCreate (the Rust runtime starts inside it)"
        );
        assert!(
            kt.contains(r#"writeKeyringMarker("ok")"#) && kt.contains(r#"writeKeyringMarker("failed")"#),
            "MainActivity must write the keyring-builder-status marker on BOTH outcomes (gates lib.rs's migration)"
        );
        let keyring_kt =
            std::path::Path::new("gen/android/app/src/main/java/io/crates/keyring/Keyring.kt");
        let ksrc_src = std::fs::read_to_string(keyring_kt)
            .expect("io.crates.keyring.Keyring shim must exist (native binding to the crate's JNI export)");
        let ksrc: String = ksrc_src
            .lines()
            .map(|l| l.split("//").next().unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            ksrc.contains(r#"System.loadLibrary("jotty_client_lib")"#),
            "Keyring.kt must load the cdylib jotty_client_lib (where the crate's JNI export lives)"
        );
        assert!(
            ksrc.contains("external fun setAndroidKeyringCredentialBuilder(context: Context)"),
            "Keyring.kt must declare the crate's JNI entry point"
        );
    }

    fn legacy_file(dir: &PathBuf, account: &str) -> PathBuf {
        dir.join(format!("{SERVICE}-{account}.key"))
    }

    #[test]
    fn migrate_empty_keystore_moves_key_and_deletes_plaintext() {
        let dir = tempdir();
        let f = legacy_file(&dir, ACCOUNT);
        fs::write(&f, "ck_legacy_plaintext").unwrap();
        let ks = MockKeyStore::default();
        assert_eq!(ks.get().unwrap(), None); // sanity: keystore empty

        keys_migrate_legacy(&dir, ACCOUNT, &ks).unwrap();

        assert_eq!(ks.get().unwrap().as_deref(), Some("ck_legacy_plaintext"));
        assert!(!f.exists(), "plaintext file must be deleted after successful set");
    }

    #[test]
    fn migrate_keystore_already_set_deletes_stale_plaintext_without_overwrite() {
        let dir = tempdir();
        let f = legacy_file(&dir, ACCOUNT);
        fs::write(&f, "ck_OLD_STALE_COPY").unwrap();
        let ks = MockKeyStore::default();
        ks.set("ck_LIVE_KEYSTORE_VALUE").unwrap();

        keys_migrate_legacy(&dir, ACCOUNT, &ks).unwrap();

        // stale plaintext must NOT clobber the live keystore value
        assert_eq!(ks.get().unwrap().as_deref(), Some("ck_LIVE_KEYSTORE_VALUE"));
        assert!(!f.exists(), "stale plaintext copy must be removed");
    }

    #[test]
    fn migrate_without_plaintext_file_is_a_noop() {
        let dir = tempdir();
        let f = legacy_file(&dir, AI_ACCOUNT);
        let ks = MockKeyStore::default();
        ks.set("ck_untouched").unwrap();

        keys_migrate_legacy(&dir, AI_ACCOUNT, &ks).unwrap();

        assert_eq!(ks.get().unwrap().as_deref(), Some("ck_untouched"));
        assert!(!f.exists());
    }

    #[test]
    fn migrate_is_idempotent_second_run_touches_nothing() {
        let dir = tempdir();
        let f = legacy_file(&dir, ACCOUNT);
        fs::write(&f, "ck_once").unwrap();
        let ks = MockKeyStore::default();
        keys_migrate_legacy(&dir, ACCOUNT, &ks).unwrap();
        assert_eq!(ks.get().unwrap().as_deref(), Some("ck_once"));
        // second run: file gone, keystore value unchanged
        keys_migrate_legacy(&dir, ACCOUNT, &ks).unwrap();
        assert_eq!(ks.get().unwrap().as_deref(), Some("ck_once"));
        assert!(!f.exists());
    }

    #[test]
    fn migrate_keystore_failure_keeps_plaintext_file() {
        // data preservation law: a failed set never deletes the only copy.
        // MockKeyStore always succeeds, so this failure arm is fenced at the
        // call-site level via the set error type — simulated with a failing
        // store inline.
        struct Failing;
        impl KeyStore for Failing {
            fn get(&self) -> AppResult<Option<String>> { Ok(None) }
            fn set(&self, _key: &str) -> AppResult<()> {
                Err(AppError::Keyring("simulated keystore failure".into()))
            }
            fn delete(&self) -> AppResult<()> { Ok(()) }
        }
        let dir = tempdir();
        let f = legacy_file(&dir, ACCOUNT);
        fs::write(&f, "ck_only_copy").unwrap();

        let res = keys_migrate_legacy(&dir, ACCOUNT, &Failing);
        assert!(res.is_err(), "set failure must propagate as Err");
        assert!(f.exists(), "plaintext file must SURVIVE a failed set");
    }

    fn tempdir() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "jotty-p10-mig-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }
}
