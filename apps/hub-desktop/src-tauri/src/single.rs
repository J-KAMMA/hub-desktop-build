use tauri::{AppHandle, Manager};

/// このアプリが1つだけ動くようにする。
///
/// 二重起動は実測で起きていた。窓が2つ並び、どちらも「Hub」と名乗る。港は
/// 先に取ったほうが握っているので、**2つ目は窓だけあってサーバが無い**。
/// ハブから届かないのに画面は正常に見えるので、原因が分からない。
///
/// 鍵には港そのものを使う。このアプリが必ず1つだけ持つ資源で、窓の状態にも
/// プラグインの都合にも依存しない。取れたら自分が本体、取れなければ先客がいる。

/// 港を先に取る。取れなければ、既にこのアプリが動いている。
pub fn claim(port: u16) -> Option<std::net::TcpListener> {
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).ok()?;
    let _ = listener.set_nonblocking(true);
    Some(listener)
}

/// 先客に姿を見せてもらう。届かなくても構わない。
///
/// 返事を待ってから帰る。書いた直後に終わると、相手が読む前に接続が消えて
/// 何も起きない。実測でそうなっていた。
pub fn ask_the_running_one_to_show(port: u16) {
    use std::io::{Read, Write};
    let Ok(mut stream) = std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)) else {
        return;
    };
    let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(2)));
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(3)));
    let _ = write!(
        stream,
        "POST /show HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let _ = stream.flush();
    let mut reply = [0u8; 64];
    let _ = stream.read(&mut reply);
}

/// アプリの手掛かり。ループバックのHTTPを受けているのは Tauri の外側なので、
/// そこから窓へ触るにはこれが要る。
static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

pub fn remember(app: AppHandle) {
    let _ = APP.set(app);
}

/// 動いているアプリへ、もう一度開かれたことを届ける。
///
/// 2つ目の起動は「使いたい」の合図だが、作業中の前面を奪う理由にはならない。
/// 最小化されていれば元に戻し、そうでなければタスクバーで知らせるだけにし、
/// 前面に出すかは窓を選ぶ利用者へ委ねる。
///
/// **主スレッドへ渡してから触る。** HTTPを受けているのは別のスレッドで、
/// そこから直接呼んでも Windows では黙って何も起きない。
pub fn show_running() {
    let Some(app) = APP.get() else { return };
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("main") {
            if window.is_minimized().unwrap_or(false) {
                let _ = window.unminimize();
            } else {
                let _ = window
                    .request_user_attention(Some(tauri::UserAttentionType::Informational));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_port_is_the_lock() {
        // 取れるうちは取れる。取られていれば取れない。
        let first = claim(43191).expect("最初は取れる");
        assert!(claim(43191).is_none(), "取られている港は取れない");
        drop(first);
    }

    /// 2つ目は、窓を出す前に譲る。
    ///
    /// 取れないまま窓だけ出すと、サーバの無いアプリが立ち、どちらが本物か
    /// 画面から分からない。実測でその状態になっていた。
    #[test]
    fn the_second_one_gives_way_before_showing_anything() {
        let lib = include_str!("lib.rs");
        assert!(
            lib.contains("single::claim"),
            "港を取れたかで本体を決めること"
        );
        assert!(
            !lib.contains(concat!("expect(\"bind ", "loopback\")")),
            "取れなかったときに落ちるのではなく、譲ること"
        );
        // 譲る判断は、窓を作るより先に済ませる。
        let claim_at = lib.find("single::claim").expect("claim");
        let builder_at = lib.find("tauri::Builder::default()").expect("builder");
        assert!(claim_at < builder_at, "窓を作る前に決めること");
    }

    #[test]
    fn relaunch_notifies_the_original_hub_without_stealing_focus() {
        let source = include_str!("single.rs");
        let body = source
            .split("pub fn show_running()")
            .nth(1)
            .expect("show_running")
            .split("#[cfg(test)]")
            .next()
            .expect("show_running body");
        assert!(body.contains("get_webview_window(\"main\")"));
        assert!(!body.contains("set_focus"), "再起動で焦点を奪わないこと");
        assert!(
            body.contains("request_user_attention"),
            "前面の代わりにタスクバーで知らせること"
        );
        assert!(!body.contains("show_local"));
    }
}
