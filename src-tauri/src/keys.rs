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

impl KeyStore for OsKeyStore {
    fn get(&self) -> AppResult<Option<String>> {
        let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| AppError::Keyring(e.to_string()))?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AppError::Keyring(e.to_string())),
        }
    }
    fn set(&self, key: &str) -> AppResult<()> {
        let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| AppError::Keyring(e.to_string()))?;
        entry.set_password(key).map_err(|e| AppError::Keyring(e.to_string()))
    }
    fn delete(&self) -> AppResult<()> {
        let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| AppError::Keyring(e.to_string()))?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::Keyring(e.to_string())),
        }
    }
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
