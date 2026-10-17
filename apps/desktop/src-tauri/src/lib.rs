#[derive(serde::Serialize)]
struct AppInfo {
  name: &'static str,
  version: &'static str,
  os: &'static str,
  arch: &'static str,
}

#[tauri::command]
fn app_info() -> AppInfo {
  log::info!("app_info requested by webview");
  AppInfo {
    name: "Kingu",
    version: env!("CARGO_PKG_VERSION"),
    os: std::env::consts::OS,
    arch: std::env::consts::ARCH,
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![app_info])
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
