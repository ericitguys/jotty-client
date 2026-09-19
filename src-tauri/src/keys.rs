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
const ACCOUNT: &str = "api-key";
pub const AI_ACCOUNT: &str = "openwebui-key";

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
    entry(account)?.set_password(key).map_err(|e| AppError::Keyring(e.to_string()))
}

fn delete_for(account: &str) -> AppResult<()> {
    match entry(account)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Keyring(e.to_string())),
    }
}

impl KeyStore for OsKeyStore {
    fn get(&self) -> AppResult<Option<String>> { get_for(ACCOUNT) }
    fn set(&self, key: &str) -> AppResult<()> { set_for(ACCOUNT, key) }
    fn delete(&self) -> AppResult<()> { delete_for(ACCOUNT) }
}

/// Same service, AI account (spec §4: jotty-desktop / openwebui-key).
/// Untestable headlessly — desktop smoke check remains a release gate.
pub struct AiOsKeyStore;

impl KeyStore for AiOsKeyStore {
    fn get(&self) -> AppResult<Option<String>> { get_for(AI_ACCOUNT) }
    fn set(&self, key: &str) -> AppResult<()> { set_for(AI_ACCOUNT, key) }
    fn delete(&self) -> AppResult<()> { delete_for(AI_ACCOUNT) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_keystore_roundtrip() {
        let ks = MockKeyStore::default();
        assert_eq!(ks.get().unwrap(), None);
        ks.set("ck_abc").unwrap();
        assert_eq!(ks.get().unwrap().as_deref(), Some("ck_abc"));
        ks.delete().unwrap();
        assert_eq!(ks.get().unwrap(), None);
    }
}
