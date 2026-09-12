#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! 桌面启动器：
//! 1. 启动打包在资源目录里的本地服务端（node 二进制 + sea.cjs bundle）
//! 2. 轮询 /health 就绪后，把主窗口导航到 http://127.0.0.1:{PORT}
//! 3. 应用退出时回收服务端进程

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::Manager;

const PORT: u16 = 8137;

fn http_ok(port: u16) -> bool {
    if let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)) {
        s.set_read_timeout(Some(Duration::from_millis(800))).ok();
        s.set_write_timeout(Some(Duration::from_millis(800))).ok();
        let req = format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
        if s.write_all(req.as_bytes()).is_ok() {
            let mut buf = String::new();
            if s.read_to_string(&mut buf).is_ok() {
                return buf.starts_with("HTTP/1.1 200");
            }
        }
    }
    false
}

fn wait_health(port: u16, secs: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if http_ok(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    false
}

fn set_executable(path: &PathBuf) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            let mut perm = meta.permissions();
            perm.set_mode(perm.mode() | 0o111);
            let _ = std::fs::set_permissions(path, perm);
        }
    }
}

fn report_status(window: &tauri::WebviewWindow, text: &str) {
    let js = format!(
        "document.getElementById('status') && (document.getElementById('status').textContent = {});",
        serde_json_like_string(text)
    );
    let _ = window.eval(&js);
}

// 简单的 JSON 字符串转义（避免引入 serde_json）
fn serde_json_like_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

struct ServerChild(Mutex<Option<Child>>);

fn kill_child(state: &ServerChild) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        *guard = None;
    }
}

fn main() {
    tauri::Builder::default()
        .manage(ServerChild(Mutex::new(None)))
        .setup(move |app| {
            let handle = app.handle().clone();
            let window = handle.get_webview_window("main").expect("main window");

            std::thread::spawn(move || {
                let res_dir = match handle.path().resource_dir() {
                    Ok(d) => d,
                    Err(e) => {
                        report_status(&window, &format!("资源目录解析失败: {e}"));
                        return;
                    }
                };
                let data_dir = handle
                    .path()
                    .app_data_dir()
                    .unwrap_or_else(|_| std::env::temp_dir().join("nihaixia"));
                let _ = std::fs::create_dir_all(&data_dir);

                let node_bin = res_dir.join("binaries").join("nihaixia-node");
                let sea_cjs = res_dir.join("binaries").join("sea.cjs");
                let knowledge = res_dir.join("knowledge");
                let web_dist = res_dir.join("web-dist");

                if !node_bin.exists() || !sea_cjs.exists() {
                    report_status(&window, "未找到内置服务端文件（安装包损坏？）");
                    return;
                }
                set_executable(&node_bin);

                // 服务已在跑（重复开应用）→ 直接复用
                if http_ok(PORT) {
                    let _ = window.eval(&format!(
                        "window.location.replace('http://127.0.0.1:{PORT}/')"
                    ));
                    return;
                }

                // APP_SECRET 首次生成并持久化，保证重启后登录态不丢
                let secret_file = data_dir.join("app_secret");
                let secret = match std::fs::read_to_string(&secret_file) {
                    Ok(s) if !s.trim().is_empty() => s.trim().to_string(),
                    _ => {
                        let s = uuid::Uuid::new_v4().to_string().replace('-', "") + &uuid::Uuid::new_v4().to_string().replace('-', "");
                        let _ = std::fs::write(&secret_file, &s);
                        s
                    }
                };

                let log_file = data_dir.join("server.log");
                let log = std::fs::OpenOptions::new()
                    .create(true).write(true).truncate(true)
                    .open(&log_file).ok();
                let err_log = log.as_ref().and_then(|_| std::fs::OpenOptions::new().create(true).write(true).truncate(true).open(&log_file).ok());

                report_status(&window, "正在启动本地服务…");

                let child = Command::new(&node_bin)
                    .arg(&sea_cjs)
                    .env("PORT", PORT.to_string())
                    .env("HOST", "127.0.0.1")
                    .env("DB_PATH", data_dir.join("nihaixia.db"))
                    .env("KNOWLEDGE_DIR", &knowledge)
                    .env("STATIC_DIR", &web_dist)
                    .env("APP_SECRET", secret)
                    .env("ALLOW_NO_LLM", "true")
                    .stdout(log.unwrap_or_else(|| std::fs::File::create("/dev/null").unwrap()))
                    .stderr(err_log.unwrap_or_else(|| std::fs::File::create("/dev/null").unwrap()))
                    .spawn();

                match child {
                    Ok(c) => {
                        if let Ok(mut guard) = handle.state::<ServerChild>().0.lock() {
                            *guard = Some(c);
                        }
                        if wait_health(PORT, 30) {
                            let _ = window.eval(&format!(
                                "window.location.replace('http://127.0.0.1:{PORT}/')"
                            ));
                        } else {
                            report_status(
                                &window,
                                &format!("本地服务启动失败，请查看日志：{}", log_file.display()),
                            );
                        }
                    }
                    Err(e) => report_status(&window, &format!("服务进程启动失败: {e}")),
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                kill_child(&app_handle.state::<ServerChild>());
            }
        });
}
