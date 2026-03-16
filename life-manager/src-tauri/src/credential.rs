/// クレデンシャルストア抽象化
/// - デスクトップ: OS キーチェーン (keyring クレート)
/// - Android: アプリデータ内の JSON ファイル

#[allow(unused_imports)]
use std::collections::HashMap;

pub struct CredentialEntry {
    service: String,
    key: String,
}

impl CredentialEntry {
    pub fn new(service: &str, key: &str) -> Result<Self, String> {
        Ok(Self {
            service: service.to_string(),
            key: key.to_string(),
        })
    }

    pub fn get_password(&self) -> Result<String, String> {
        platform::get_password(&self.service, &self.key)
    }

    pub fn set_password(&self, password: &str) -> Result<(), String> {
        platform::set_password(&self.service, &self.key, password)
    }

    pub fn delete_credential(&self) -> Result<(), String> {
        platform::delete_password(&self.service, &self.key)
    }
}

// --- Desktop: keyring ---
#[cfg(not(target_os = "android"))]
mod platform {
    pub fn get_password(service: &str, key: &str) -> Result<String, String> {
        let entry = keyring::Entry::new(service, key).map_err(|e| e.to_string())?;
        entry.get_password().map_err(|e| e.to_string())
    }

    pub fn set_password(service: &str, key: &str, password: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(service, key).map_err(|e| e.to_string())?;
        entry.set_password(password).map_err(|e| e.to_string())
    }

    pub fn delete_password(service: &str, key: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(service, key).map_err(|e| e.to_string())?;
        entry.delete_credential().map_err(|e| e.to_string())
    }
}

// --- Android: JSON file in app data ---
#[cfg(target_os = "android")]
mod platform {
    use super::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::sync::OnceLock;

    static FILE_LOCK: Mutex<()> = Mutex::new(());
    static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();

    /// アプリ起動時に Tauri の data_dir を設定する
    pub fn init_data_dir(path: PathBuf) {
        let _ = DATA_DIR.set(path);
    }

    fn store_path(service: &str) -> PathBuf {
        let base = DATA_DIR.get().cloned().unwrap_or_else(|| {
            // フォールバック: 一般的な Android アプリデータパス
            PathBuf::from("/data/data/com.y0zrin.lifemanager/files")
        });
        base.join(format!("{}.credentials.json", service))
    }

    fn read_store(service: &str) -> HashMap<String, String> {
        let path = store_path(service);
        if let Ok(data) = fs::read_to_string(&path) {
            serde_json::from_str(&data).unwrap_or_default()
        } else {
            HashMap::new()
        }
    }

    fn write_store(service: &str, store: &HashMap<String, String>) -> Result<(), String> {
        let path = store_path(service);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let data = serde_json::to_string(store).map_err(|e| e.to_string())?;
        fs::write(&path, data).map_err(|e| e.to_string())
    }

    pub fn get_password(service: &str, key: &str) -> Result<String, String> {
        let _lock = FILE_LOCK.lock().map_err(|e| e.to_string())?;
        let store = read_store(service);
        store.get(key).cloned().ok_or_else(|| "No entry found".to_string())
    }

    pub fn set_password(service: &str, key: &str, password: &str) -> Result<(), String> {
        let _lock = FILE_LOCK.lock().map_err(|e| e.to_string())?;
        let mut store = read_store(service);
        store.insert(key.to_string(), password.to_string());
        write_store(service, &store)
    }

    pub fn delete_password(service: &str, key: &str) -> Result<(), String> {
        let _lock = FILE_LOCK.lock().map_err(|e| e.to_string())?;
        let mut store = read_store(service);
        store.remove(key);
        write_store(service, &store)
    }
}

/// Android でデータディレクトリを初期化する（setup 時に呼ぶ）
#[cfg(target_os = "android")]
pub fn init_android_data_dir(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Ok(path) = app.path().app_data_dir() {
        platform::init_data_dir(path);
    }
}

#[cfg(not(target_os = "android"))]
pub fn init_android_data_dir(_app: &tauri::AppHandle) {
    // デスクトップでは何もしない
}
