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

            // Geometry comes from the launcher, which reads the config file. Parsing that
            // file here as well would mean two readers of one format; the launcher already
            // has to know where the window goes, so it passes the answer down.
            let number = |name: &str, fallback: f64| -> f64 {
                std::env::var(name).ok().and_then(|value| value.parse::<f64>().ok()).unwrap_or(fallback)
            };
            let (width, height) = (number("ACM_WINDOW_WIDTH", 380.0), number("ACM_WINDOW_HEIGHT", 600.0));
            let (x, y) = (number("ACM_WINDOW_X", 40.0), number("ACM_WINDOW_Y", 80.0));
            let on_top = std::env::var("ACM_ALWAYS_ON_TOP").map(|value| value != "0").unwrap_or(true);

            // The path is relative to THIS file, and icon.png lives in src-tauri/icons.
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))
                .expect("the bundled 512x512 icon should decode");

            // A widget that panics with "os error 5" tells the user nothing. In a
            // context with no interactive desktop — a service, an SSH session, a
            // background job — creating the webview is refused by Windows, and that
            // is worth saying in words rather than in a Rust backtrace.
            if let Err(error) = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(address))
                .title("agent-cost-monitor")
                // `.icon` returns a Result, so the chain has to unwrap it here.
                .icon(icon)?
                .inner_size(width, height)
                .position(x, y)
                .min_inner_size(300.0, 220.0)
                .always_on_top(on_top)
                .resizable(true)
                .build()
            {
                eprintln!(
                    "agent-cost-monitor: could not create the window: {error}\n\
                     This needs an interactive desktop session with the WebView2 runtime.\n\
                     Launched from a service, an SSH session or a background job, Windows\n\
                     refuses the window (reported as 'access denied', os error 5)."
                );
                std::process::exit(2);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("could not start the agent-cost-monitor window");
}
