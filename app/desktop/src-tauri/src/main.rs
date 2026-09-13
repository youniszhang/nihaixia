#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! 桌面启动器：
//! 1. 启动打包在资源目录里的本地服务端（node 二进制 + sea.cjs bundle）
//! 2. 轮询 /health 就绪后，把主窗口导航到 http://127.0.0.1:{PORT}
//! 3. 监听 "ds-login-open" 事件：打开内嵌 DeepSeek 登录窗口，
//!    轮询其 localStorage 的 userToken（经 window.title 中转），
//!    拿到后走内部通道（x-internal-token）交给服务端注入专用浏览器
//! 4. 应用退出时回收服务端进程

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Listener, Manager};

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
        json_string(text)
    );
    let _ = window.eval(&js);
}

// 简单的 JSON 字符串转义（避免引入 serde_json）
fn json_string(s: &str) -> String {
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

// —— 应用内 DeepSeek 登录 —— //

fn read_title_token(app: &tauri::AppHandle) -> String {
    let Some(w) = app.get_webview_window("dslogin") else {
        return String::new();
    };
    let _ = w.eval(
        "try{document.title='__DSTK__'+(localStorage.getItem('userToken')||'')}catch(e){document.title='__DSTK__'};1",
    );
    std::thread::sleep(Duration::from_millis(250));
    let title = w.title().unwrap_or_default();
    if let Some(t) = title.strip_prefix("__DSTK__") {
        let t = t.trim().to_string();
        if !t.is_empty() {
            return t;
        }
    }
    String::new()
}

fn http_post_internal(path: &str, body: &str, internal_token: &str) -> Option<String> {
    if let Ok(mut s) = TcpStream::connect(("127.0.0.1", PORT)) {
        s.set_read_timeout(Some(Duration::from_secs(120))).ok();
        s.set_write_timeout(Some(Duration::from_secs(30))).ok();
        let req = format!(
            "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nx-internal-token: {internal_token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        if s.write_all(req.as_bytes()).is_ok() {
            let mut buf = String::new();
            let _ = s.read_to_string(&mut buf);
            return Some(buf);
        }
    }
    None
}

fn main() {
    tauri::Builder::default()
        .manage(ServerChild(Mutex::new(None)))
        .setup(move |app| {
            let handle = app.handle().clone();
            let window = handle.get_webview_window("main").expect("main window");

            // —— 应用内登录事件：前端 emit("ds-login-open") 触发 —— //
            let h_login = handle.clone();
            handle.listen("ds-login-open", move |_| {
                let app = h_login.clone();
                std::thread::spawn(move || {
                    use tauri::{WebviewUrl, WebviewWindowBuilder};
                    if let Some(w) = app.get_webview_window("dslogin") {
                        let _ = w.close();
                        std::thread::sleep(Duration::from_millis(400));
                    }
                    let url: tauri::Url = match "https://chat.deepseek.com/sign_in".parse() {
                        Ok(u) => u,
                        Err(_) => return,
                    };
                    if tauri::WebviewWindowBuilder::new(&app, "dslogin", WebviewUrl::External(url))
                        .title("DeepSeek 网页版登录 · 登录后自动生效")
                        .inner_size(1100.0, 800.0)
                        .build()
                        .is_err()
                    {
                        return;
                    }
                    let internal_token = std::env::var("INTERNAL_TOKEN").unwrap_or_default();
                    if internal_token.is_empty() {
                        return;
                    }
                    // 轮询登录窗口的 userToken，拿到后走内部通道注入并验证（最长 5 分钟）
                    for _ in 0..150 {
                        std::thread::sleep(Duration::from_millis(2000));
                        if app.get_webview_window("dslogin").is_none() {
                            break; // 用户手动关了窗口
                        }
                        let token = read_title_token(&app);
                        if token.is_empty() {
                            continue;
                        }
                        let body = format!("{{\"token\":{}}}", json_string(&token));
                        if let Some(resp) = http_post_internal(
                            "/internal/dsweb-inject",
                            &body,
                            &internal_token,
                        ) {
                            if resp.contains("\"state\":\"success\"") {
                                if let Some(w) = app.get_webview_window("dslogin") {
                                    let _ = w.close();
                                }
                                break;
                            }
                        }
                    }
                });
            });

            // —— 服务端启动 —— //
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

                if http_ok(PORT) {
                    let _ = window.eval(&format!(
                        "window.location.replace('http://127.0.0.1:{PORT}/')"
                    ));
                    return;
                }

                let secret_file = data_dir.join("app_secret");
                let secret = match std::fs::read_to_string(&secret_file) {
                    Ok(s) if !s.trim().is_empty() => s.trim().to_string(),
                    _ => {
                        let s = uuid::Uuid::new_v4().to_string().replace('-', "")
                            + &uuid::Uuid::new_v4().to_string().replace('-', "");
                        let _ = std::fs::write(&secret_file, &s);
                        s
                    }
                };
                // 内部通道令牌（Rust ↔ 服务端），每次启动随机
                let internal_token = uuid::Uuid::new_v4().to_string().replace('-', "")
                    + &uuid::Uuid::new_v4().to_string().replace('-', "");
                std::env::set_var("INTERNAL_TOKEN", &internal_token);

                let log_file = data_dir.join("server.log");
                let log = std::fs::OpenOptions::new()
                    .create(true)
                    .write(true)
                    .truncate(true)
                    .open(&log_file)
                    .ok();
                let err_log = log
                    .as_ref()
                    .and_then(|_| {
                        std::fs::OpenOptions::new()
                            .create(true)
                            .write(true)
                            .truncate(true)
                            .open(&log_file)
                            .ok()
                    });

                report_status(&window, "正在启动本地服务…");

                let child = Command::new(&node_bin)
                    .arg(&sea_cjs)
                    .env("PORT", PORT.to_string())
                    // 0.0.0.0：允许同一 Wi-Fi 下的 iPhone/iPad 通过 PWA 访问
                    .env("HOST", "0.0.0.0")
                    .env("DB_PATH", data_dir.join("nihaixia.db"))
                    .env("KNOWLEDGE_DIR", &knowledge)
                    .env("STATIC_DIR", &web_dist)
                    .env("APP_SECRET", secret)
                    .env("INTERNAL_TOKEN", &internal_token)
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
