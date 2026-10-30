//! タブ操作（他を閉じる・右を閉じる）の選別と、ページの右クリックメニュー。
//! 右クリックはWebView2の既定メニューを残し、開発者向け項目だけ外して
//! 「新しいタブでリンクを開く」を足す。COMのどこかが失敗したら既定のまま。

use tauri::AppHandle;

/// 一括で閉じるタブのid。ピン留めは対象外。基準のタブ自身も閉じない。
/// 基準idが無ければ何も閉じない。
pub(super) fn ids_to_close(tabs: &[(u64, bool)], keep: u64, to_right_only: bool) -> Vec<u64> {
    let Some(position) = tabs.iter().position(|(id, _)| *id == keep) else { return Vec::new() };
    tabs.iter()
        .enumerate()
        .filter(|(index, (id, pinned))| *id != keep && !*pinned && (!to_right_only || *index > position))
        .map(|(_, (id, _))| *id)
        .collect()
}

/// 一括クローズ。残すタブがアクティブでなければ、閉じる前に残す側へ切り替える
/// （閉じるたびに隣へ移って無駄に再描画するのを避ける）。
pub(super) fn close_many(app: &AppHandle, keep: u64, to_right_only: bool) -> Result<(), String> {
    let (ids, active) = super::with_tabs(|state| {
        let rows: Vec<(u64, bool)> = state.tabs.iter().map(|tab| (tab.id, tab.pinned)).collect();
        (rows.iter().any(|(id, _)| *id == keep).then(|| ids_to_close(&rows, keep, to_right_only)), state.active)
    })
    .ok_or("tab_not_found")?;
    let ids = ids.ok_or("tab_not_found")?;
    if ids.contains(&active) { super::activate(app, keep); }
    for id in ids { let _ = super::browser_close_tab(app.clone(), id); }
    Ok(())
}

/// 取り除く項目の添字（昇順）。開発者向け項目、リンクのときの「新しいウィンドウで開く」、
/// その結果できる先頭・末尾・連続の区切り線。
pub(super) fn items_to_remove(items: &[(String, bool)]) -> Vec<usize> {
    let hidden = |name: &str| {
        let name = name.to_ascii_lowercase();
        name.contains("inspect") || name.contains("source") || name.contains("openlinkin") || name.contains("devtools")
    };
    let mut remove = vec![false; items.len()];
    for (index, (name, separator)) in items.iter().enumerate() { remove[index] = !*separator && hidden(name); }
    let mut previous_separator = true; // 先頭の区切りは不要
    for (index, (_, separator)) in items.iter().enumerate() {
        if remove[index] { continue; }
        if *separator {
            if previous_separator { remove[index] = true; } else { previous_separator = true; }
        } else {
            previous_separator = false;
        }
    }
    // 末尾に残った区切りを落とす。
    for index in (0..items.len()).rev() {
        if remove[index] { continue; }
        if items[index].1 { remove[index] = true; } else { break; }
    }
    remove.iter().enumerate().filter(|(_, r)| **r).map(|(index, _)| index).collect()
}

/// 検索に回す選択文字列。制御文字と連続する空白は1つの空白にし、200文字で切る。空なら None。
pub(super) fn selection_query(text: &str) -> Option<String> {
    let joined = text.split(|c: char| c.is_whitespace() || c.is_control()).filter(|part| !part.is_empty()).collect::<Vec<_>>().join(" ");
    let query: String = joined.chars().take(200).collect();
    (!query.is_empty()).then_some(query)
}

#[cfg(windows)]
pub(super) fn hook(app: &AppHandle, view: &tauri::Webview, id: u64) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_11, ICoreWebView2_2, ICoreWebView2Environment9, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND,
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
    };
    use windows_core::Interface;
    let handle = app.clone();
    let _ = view.with_webview(move |platform| unsafe {
        let Ok(core) = platform.controller().CoreWebView2() else { return };
        let Ok(core11) = core.cast::<ICoreWebView2_11>() else { return };
        let callback = webview2_com::ContextMenuRequestedEventHandler::create(Box::new(move |sender, args| {
            let (Some(sender), Some(args)) = (sender, args) else { return Ok(()) };
            // どこで失敗しても既定メニューのまま（部分的に変えた状態を残さないよう、読む段階で先に確かめる）。
            let Ok(menu) = args.MenuItems() else { return Ok(()) };
            let mut count = 0u32;
            if menu.Count(&mut count).is_err() || count > 64 { return Ok(()); }
            let mut rows: Vec<(String, bool)> = Vec::with_capacity(count as usize);
            for index in 0..count {
                let Ok(item) = menu.GetValueAtIndex(index) else { return Ok(()) };
                let mut name = windows_core::PWSTR::null();
                if item.Name(&mut name).is_err() { return Ok(()); }
                let name = webview2_com::take_pwstr(name);
                let mut kind = COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND(0);
                if item.Kind(&mut kind).is_err() { return Ok(()); }
                rows.push((name, kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR));
            }
            // リンクの上なら URL を取り、http/https だけ受ける（ナビゲーションと同じ検証）。
            let link = (|| {
                let target = args.ContextMenuTarget().ok()?;
                let mut has = windows_core::BOOL(0);
                target.HasLinkUri(&mut has).ok()?;
                if !has.as_bool() { return None; }
                let mut uri = windows_core::PWSTR::null();
                target.LinkUri(&mut uri).ok()?;
                let uri = webview2_com::take_pwstr(uri);
                super::popup_target(&uri).map(|url| url.to_string())
            })();
            for index in items_to_remove(&rows).into_iter().rev() { let _ = menu.RemoveValueAtIndex(index as u32); }
            let rail = super::rail::is_rail_id(id);
            // 選んだ文字列があれば「…をWebで検索」を足す（Chrome と同じ）。検索先は同梱UIの設定で決める。
            let selection = (|| {
                let target = args.ContextMenuTarget().ok()?;
                let mut has = windows_core::BOOL(0);
                target.HasSelection(&mut has).ok()?;
                if !has.as_bool() { return None; }
                let mut text = windows_core::PWSTR::null();
                target.SelectionText(&mut text).ok()?;
                selection_query(&webview2_com::take_pwstr(text))
            })();
            if link.is_none() && (rail || selection.is_none()) { return Ok(()); }
            let Ok(environment) = sender.cast::<ICoreWebView2_2>().and_then(|core| core.Environment()).and_then(|env| env.cast::<ICoreWebView2Environment9>()) else { return Ok(()) };
            if let Some(query) = selection.filter(|_| !rail) {
                let shown: String = query.chars().take(24).collect();
                let label = windows_core::HSTRING::from(format!("「{}{}」をWebで検索", shown, if query.chars().count() > 24 { "…" } else { "" }));
                if let Ok(item) = environment.CreateContextMenuItem(&label, None::<&windows::Win32::System::Com::IStream>, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND) {
                    let opener = handle.clone();
                    let chosen = webview2_com::CustomItemSelectedEventHandler::create(Box::new(move |_, _| {
                        let _ = tauri::Emitter::emit_to(&opener, super::MAIN_LABEL, "browser-search-selection", serde_json::json!({ "tabId": id, "text": query }));
                        Ok(())
                    }));
                    if item.add_CustomItemSelected(&chosen, &mut 0).is_ok() { let _ = menu.InsertValueAtIndex(0, &item); }
                }
            }
            let Some(link) = link else { return Ok(()) };
            let label = windows_core::HSTRING::from(if rail { "中央で開く" } else { "新しいタブでリンクを開く" });
            let Ok(item) = environment.CreateContextMenuItem(&label, None::<&windows::Win32::System::Com::IStream>, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND) else { return Ok(()) };
            let opener = handle.clone();
            let target = link.clone();
            let selected = webview2_com::CustomItemSelectedEventHandler::create(Box::new(move |_, _| {
                if rail {
                    // 右列のリンクは同梱UIが振り分ける（Hubの画面なら中央のHub、外部なら中央のタブ）。
                    let _ = tauri::Emitter::emit_to(&opener, super::MAIN_LABEL, "rail-browser-open-center", serde_json::json!({ "url": target }));
                    return Ok(());
                }
                // 新規タブの作り方はポップアップ・リンクと同じ経路。背景で開き、元タブがプライベートなら新タブもプライベート。
                let private = super::with_tabs(|state| state.tabs.iter().find(|tab| tab.id == id).map(|tab| tab.private)).flatten().unwrap_or(false);
                let _ = super::queue_tab_open(opener.clone(), Some(target.clone()), private, false, Some(id), None);
                Ok(())
            }));
            if item.add_CustomItemSelected(&selected, &mut 0).is_err() { return Ok(()); }
            // リンクを開く項目の位置（先頭）に差し込む。
            let _ = menu.InsertValueAtIndex(0, &item);
            // 通常タブのリンクには「右列で開く」も足す（右列自身には足さない）。
            if !rail {
                let label = windows_core::HSTRING::from("右列で開く");
                if let Ok(side) = environment.CreateContextMenuItem(&label, None::<&windows::Win32::System::Com::IStream>, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND) {
                    let opener = handle.clone();
                    let target = link.clone();
                    let chosen = webview2_com::CustomItemSelectedEventHandler::create(Box::new(move |_, _| {
                        let _ = tauri::Emitter::emit_to(&opener, super::MAIN_LABEL, "rail-browser-open-request", serde_json::json!({ "url": target }));
                        Ok(())
                    }));
                    if side.add_CustomItemSelected(&chosen, &mut 0).is_ok() { let _ = menu.InsertValueAtIndex(1, &side); }
                }
            }
            Ok(())
        }));
        let _ = core11.add_ContextMenuRequested(&callback, &mut 0);
    });
}

#[cfg(not(windows))]
pub(super) fn hook(_app: &AppHandle, _view: &tauri::Webview, _id: u64) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(name: &str) -> (String, bool) { (name.to_owned(), name.is_empty()) }

    #[test]
    fn close_others_keeps_base_and_pinned() {
        let tabs = [(1, true), (2, false), (3, false), (4, true), (5, false)];
        assert_eq!(ids_to_close(&tabs, 3, false), vec![2, 5]);
        assert_eq!(ids_to_close(&tabs, 1, false), vec![2, 3, 5]);
    }

    #[test]
    fn close_right_only_looks_right_of_base() {
        let tabs = [(1, false), (2, false), (3, true), (4, false), (5, false)];
        assert_eq!(ids_to_close(&tabs, 2, true), vec![4, 5]);
        assert_eq!(ids_to_close(&tabs, 5, true), Vec::<u64>::new());
        assert_eq!(ids_to_close(&tabs, 1, true), vec![2, 4, 5]);
    }

    #[test]
    fn unknown_base_or_single_tab_closes_nothing() {
        assert!(ids_to_close(&[(1, false), (2, false)], 9, false).is_empty());
        assert!(ids_to_close(&[(1, false)], 1, false).is_empty());
        assert!(ids_to_close(&[], 1, true).is_empty());
    }

    #[test]
    fn developer_and_new_window_items_go_with_stray_separators() {
        let items = [row("back"), row("reload"), row(""), row("openLinkInNewWindow"), row("copyLinkLocation"), row(""), row("inspectElement"), row("viewPageSource")];
        // openLinkInNewWindow(3), inspectElement(6), viewPageSource(7) と末尾の区切り(5)が落ちる。
        assert_eq!(items_to_remove(&items), vec![3, 5, 6, 7]);
    }

    #[test]
    fn separators_never_lead_or_double() {
        let items = [row("inspectElement"), row(""), row("print"), row(""), row("viewSource"), row(""), row("saveAs")];
        assert_eq!(items_to_remove(&items), vec![0, 1, 4, 5]);
    }

    #[test]
    fn selection_query_collapses_controls_and_caps_length() {
        assert_eq!(selection_query("  hello\r\n\tworld\u{0}x ").as_deref(), Some("hello world x"));
        assert_eq!(selection_query(" \n\t "), None);
        assert_eq!(selection_query(&"研".repeat(500)).map(|q| q.chars().count()), Some(200));
    }

    #[test]
    fn plain_menu_is_untouched() {
        let items = [row("back"), row("forward"), row(""), row("print")];
        assert!(items_to_remove(&items).is_empty());
    }
}
