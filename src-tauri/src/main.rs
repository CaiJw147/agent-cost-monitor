// The window, in Rust.
//
// It loads the local daemon over HTTP rather than bundling the UI, so the renderer
// stays one file that Claude Code, Codex and DSH all read from. `--tauri` exists
// because the browser-app fallback cannot drop its chrome; this can.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{WebviewUrl, WebviewWindowBuilder};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let port = std::env::var("ACM_WINDOW_PORT").unwrap_or_else(|_| "7420".to_string());
            let address: tauri::Url = format!("http://127.0.0.1:{port}/")
                .parse()
                .expect("ACM_WINDOW_PORT produced an unusable address");

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(address))
                .title("agent-cost-monitor")
                .inner_size(380.0, 600.0)
                .min_inner_size(300.0, 260.0)
                .always_on_top(true)
                .resizable(true)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("could not start the agent-cost-monitor window");
}
