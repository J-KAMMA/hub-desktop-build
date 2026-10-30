use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// Desktopのメイン画面は同梱アプリ（ui/index.html）。アプリ内ブラウザは
/// 外部サイト専用でWeb版Hubは開かない——Web版は既定ブラウザで使うものとして
/// アプリと分ける。ここで決めるのは接続先HubのURLと、ローカル専用窓
/// （承認・ランチャー）の開閉だけ。

/// 既定の配信元。
///
/// 本番の hub.jkamma.com はまだDNSに無く、本番Workerも公開URLを持っていない。
/// **本番が公開されたらここを戻すこと。**
const DEFAULT_HUB_URL: &str = "http://localhost:3020";

/// 開いてよいURLか。
///
/// `HUB_APP_URL` は開発中に手元のハブへ向けるためにある。何でも通すと、
/// 環境変数1つでアプリが任意の宛先をブラウザに開かせる道具になるので、
/// https か、この端末のループバックだけに絞る。
pub fn hub_url(raw: Option<&str>) -> String {
    let candidate = raw.map(str::trim).unwrap_or("");
    let acceptable = candidate.starts_with("https://")
        || candidate.starts_with("http://localhost:")
        || candidate.starts_with("http://127.0.0.1:");
    if acceptable && !candidate.contains(' ') && !candidate.contains('"') {
        candidate.to_owned()
    } else {
        DEFAULT_HUB_URL.to_owned()
    }
}

/// 承認をHub本体のAI画面に出すために、アプリの手掛かりを1つだけ持っておく。
///
/// ループバックのHTTPを受けているのは Tauri の外側なので、そこから窓へ
/// 触るにはこれが要る。持たせるのは「前に出す」1つだけで、実行や書き込みは
/// 通さない。
static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

pub fn remember(app: AppHandle) {
    let _ = APP.set(app);
}

pub fn app_handle() -> Option<AppHandle> {
    APP.get().cloned()
}

/// ローカル操作と承認は、固定の同梱ページを使うHub本体で開く。
pub fn show_local() {
    let Some(app) = APP.get() else { return };
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(main) = handle.get_webview_window("main") else { return };
        let _ = main.show();
        let _ = crate::no_activate::guard(|| main.unminimize());
        let _ = crate::no_activate::guard(|| main.set_focus());
        let _ = main.emit("hub-open-harness", ());
    });
}

/// マーケットの「購入済み > ゲーム」からランチャーを前に出す。
/// HTTP側には一覧・パス・起動能力を渡さず、窓を開く合図だけを受ける。
pub fn show_games() {
    let Some(app) = APP.get() else { return };
    open_local_tool(app, "games", "ゲームランチャー", "games");
}

/// Work の固定ローカル窓から、アプリの主窓へ戻る。
///
/// URL の遷移や新しい窓は作らない。先に主窓を表示・前面化できた場合だけ、
/// Work 窓を隠す。
pub fn return_to_hub(app: &AppHandle, harness: &tauri::WebviewWindow) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or("hub_window_unavailable")?;
    main.show().map_err(|_| "hub_window_unavailable")?;
    crate::no_activate::guard(|| main.unminimize()).map_err(|_| "hub_window_unavailable")?;
    crate::no_activate::guard(|| main.set_focus()).map_err(|_| "hub_window_unavailable")?;
    harness.hide().map_err(|_| "hub_window_unavailable".to_owned())
}

fn open_local_tool(app: &AppHandle, label: &str, title: &str, tool: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.show();
        let _ = crate::no_activate::guard(|| window.unminimize());
        let _ = crate::no_activate::guard(|| window.set_focus());
        let event = if tool == "games" {
            "hub-open-games"
        } else {
            "hub-open-harness"
        };
        let _ = window.emit(event, ());
        return;
    }
    let url = WebviewUrl::App(format!("index.html?tool={tool}").into());
    let _ = WebviewWindowBuilder::new(app, label, url)
        .title(title)
        .inner_size(760.0, 760.0)
        .min_inner_size(420.0, 520.0)
        .build();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_https_or_this_machine_can_be_a_hub_api() {
        // 環境変数1つで、アプリが任意の宛先へ通信する道具にならない。
        assert_eq!(hub_url(None), DEFAULT_HUB_URL);
        assert_eq!(hub_url(Some("")), DEFAULT_HUB_URL);
        assert_eq!(hub_url(Some("http://example.com")), DEFAULT_HUB_URL);
        assert_eq!(hub_url(Some("file:///C:/whatever")), DEFAULT_HUB_URL);
        assert_eq!(hub_url(Some("javascript:alert(1)")), DEFAULT_HUB_URL);
        assert_eq!(hub_url(Some("https://a.example \"&calc")), DEFAULT_HUB_URL);

        assert_eq!(
            hub_url(Some("https://hub.jkamma.com")),
            "https://hub.jkamma.com"
        );
        assert_eq!(
            hub_url(Some("http://localhost:3030")),
            "http://localhost:3030"
        );
        assert_eq!(
            hub_url(Some(" http://127.0.0.1:3030 ")),
            "http://127.0.0.1:3030"
        );
    }

    #[test]
    fn the_hub_url_is_the_api_and_work_focuses_the_main_window() {
        assert_eq!(hub_url(None), "http://localhost:3020");
        let source = include_str!("hub_window.rs");
        let show = source
            .split("pub fn show_local()")
            .nth(1)
            .unwrap()
            .split("pub fn show_games()")
            .next()
            .unwrap();
        assert!(show.contains("run_on_main_thread"));
        assert!(show.contains("get_webview_window(\"main\")"));
        assert!(show.contains("main.emit(\"hub-open-harness\""));
        assert!(!show.contains("open_local_tool"));
        assert!(source.contains("index.html?tool={tool}"));
    }

    #[test]
    fn returning_from_work_focuses_the_existing_hub_before_hiding_work() {
        let source = include_str!("hub_window.rs");
        let body = source
            .split("pub fn return_to_hub")
            .nth(1)
            .expect("return helper")
            .split("fn open_local_tool")
            .next()
            .expect("return helper body");
        let focus = body.find("main.set_focus").expect("main focus");
        let hide = body.find("harness.hide").expect("harness hide");
        assert!(focus < hide, "主窓が使える前に Work 窓を隠さない");
        assert!(!body.contains("navigate"));
        assert!(!body.contains("WebviewWindowBuilder"));
    }

    #[test]
    fn the_hub_can_still_reach_this_machine() {
        // ブラウザで開いても、この端末の機能へは届く必要がある。
        let origins = crate::security::allowed_origins().expect("origins");
        assert!(
            origins.contains(DEFAULT_HUB_URL),
            "既定の配信元が許可されていない"
        );
        assert!(origins.contains("https://hub.jkamma.com"));
    }
}
