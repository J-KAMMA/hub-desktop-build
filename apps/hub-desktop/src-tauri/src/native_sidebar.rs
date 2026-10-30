//! Fixed main-window sidebar rows; DOM buttons retain keyboard navigation.
#![deny(unreachable_patterns)]
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter};

const SAFE_REVISION: u64 = 9_007_199_254_740_991;
static REVISION: AtomicU64 = AtomicU64::new(0);
static EXHAUSTED: AtomicBool = AtomicBool::new(false);
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum View { Feed, Notifications, Market, Settings }
#[derive(Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rect { pub x:f64, pub y:f64, pub w:f64, pub h:f64 }
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Row { pub id:u8, pub label:String, pub selected:bool, pub rect:Rect }
#[derive(Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Colors { pub background:[u8;3], pub hover:[u8;3], pub selected:[u8;3], pub text:[u8;3], pub muted:[u8;3] }
#[derive(Clone, Copy)]
struct TextStyle { font_size:f64, padding_x:f64, radius:f64, font_weight:u16 }

fn belongs(view:View,id:u8) -> bool {
    match view { View::Feed => (1..=3).contains(&id), View::Notifications => (4..=8).contains(&id), View::Market => (9..=11).contains(&id), View::Settings => (12..=15).contains(&id) }
}
fn fixed_label(id:u8) -> Option<&'static str> {
    ["おすすめ","人気","フォロー中","すべて","未読","フィード","コミュニティ","お知らせ","商品","出品","販売者","Desktopアカウント","この端末","通知と受信","その他の設定"].get(id.checked_sub(1)? as usize).copied()
}
fn label_valid(label:&str) -> bool { !label.is_empty() && label.encode_utf16().count() <= 128 && !label.chars().any(char::is_control) }
fn geometry_valid(rect:Rect) -> bool {
    [rect.x,rect.y,rect.w,rect.h].iter().all(|n| n.is_finite() && *n >= 0.0 && *n <= 32767.0)
        && (1.0..=1000.0).contains(&rect.w) && (1.0..=100.0).contains(&rect.h)
}
fn style_valid(style:TextStyle) -> bool {
    style.font_size.is_finite() && (10.0..=24.0).contains(&style.font_size)
        && style.padding_x.is_finite() && (0.0..=32.0).contains(&style.padding_x)
        && style.radius.is_finite() && (0.0..=20.0).contains(&style.radius) && (100..=900).contains(&style.font_weight)
}
fn valid(view:View,revision:u64,rows:&[Row],style:TextStyle) -> bool {
    revision > 0 && revision <= SAFE_REVISION && style_valid(style) && rows.len() <= 5
        && rows.iter().all(|row| belongs(view,row.id) && label_valid(&row.label) && fixed_label(row.id) == Some(row.label.as_str()) && geometry_valid(row.rect))
        && rows.iter().enumerate().all(|(i,row)| rows[..i].iter().all(|other| other.id != row.id))
}
fn advance(counter:&AtomicU64,revision:u64) -> bool {
    revision > 0 && revision <= SAFE_REVISION && counter.fetch_update(Ordering::SeqCst,Ordering::SeqCst,|old| (revision > old).then_some(revision)).is_ok()
}
fn reset_floor(counter:&AtomicU64) -> Option<u64> {
    counter.fetch_update(Ordering::SeqCst,Ordering::SeqCst,|old|old.checked_add(1).filter(|next|*next<=SAFE_REVISION)).ok().map(|old|old+1)
}
fn action_current(pressed:Option<u64>,revision:u64,latest:u64) -> bool { revision > 0 && revision <= SAFE_REVISION && pressed == Some(revision) && revision == latest }
fn color(rgb:[u8;3]) -> u32 { rgb[0] as u32 | (rgb[1] as u32) << 8 | (rgb[2] as u32) << 16 }
fn ready(app:&AppHandle,revision:u64,ids:Vec<u8>) {
    let _ = app.emit_to("main","native-sidebar-ready",serde_json::json!({"revision":revision,"ids":ids}));
}

#[tauri::command]
pub fn native_sidebar_sync(app:AppHandle,webview:tauri::Webview,view:View,revision:u64,rows:Vec<Row>,colors:Colors,font_size:f64,padding_x:f64,radius:f64,font_weight:u16) -> Result<(),String> {
    let style=TextStyle{font_size,padding_x,radius,font_weight};
    if webview.label() != "main" { return Err("native_sidebar_unavailable".into()); }
    if EXHAUSTED.load(Ordering::SeqCst) { return Err("native_sidebar_exhausted".into()); }
    if !valid(view,revision,&rows,style) { return Err("native_sidebar_invalid".into()); }
    if !advance(&REVISION,revision) { return Err("native_sidebar_stale".into()); }
    #[cfg(windows)] { windows::sync(app,revision,rows,colors,style) }
    #[cfg(not(windows))] { let _=(rows,colors); ready(&app,revision,Vec::new()); Ok(()) }
}

#[tauri::command]
pub fn native_sidebar_reset(app:AppHandle,webview:tauri::Webview) -> Result<u64,String> {
    if webview.label() != "main" { return Err("native_sidebar_unavailable".into()); }
    let floor=reset_floor(&REVISION);
    if floor.is_none() { EXHAUSTED.store(true,Ordering::SeqCst); }
    #[cfg(windows)] windows::reset(app,floor)?;
    #[cfg(not(windows))] if let Some(floor)=floor { ready(&app,floor,Vec::new()); }
    floor.ok_or_else(||"native_sidebar_exhausted".into())
}

/// The window's scale factor changed (moved to a monitor with another DPI): keep the rows over
/// their DOM buttons.
pub fn rescale(app:&AppHandle) {
    #[cfg(windows)] windows::rescale(app);
    #[cfg(not(windows))] let _=app;
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::{cell::{Cell,RefCell},ptr::null_mut,rc::Rc};
    use tauri::Manager;
    use windows_sys::Win32::{Foundation::{HWND,LPARAM,LRESULT,RECT,WPARAM},
        Graphics::Gdi::*, UI::{Input::KeyboardAndMouse::{GetCapture,IsWindowEnabled,ReleaseCapture,SetCapture,TrackMouseEvent,TRACKMOUSEEVENT,TME_LEAVE},
            Shell::{DefSubclassProc,RemoveWindowSubclass,SetWindowSubclass},WindowsAndMessaging::*}};
    const SUBCLASS:usize = 0x48554e;
    const SS_NOTIFY:u32 = 0x100;
    const WM_MOUSELEAVE:u32 = 0x02a3;
    thread_local! { static HANDLES:RefCell<[Option<Rc<Handle>>;15]> = RefCell::new(std::array::from_fn(|_|None)); }
    struct Handle { app:AppHandle,parent:HWND,hwnd:HWND,id:u8,alive:Cell<bool>,revision:Cell<u64>,row:RefCell<Row>,scale:Cell<f64>,colors:Cell<Colors>,style:Cell<TextStyle>,hover:Cell<bool>,pressed:Cell<Option<u64>> }
    unsafe fn retain(ptr:*const Handle) -> Rc<Handle> { Rc::increment_strong_count(ptr); Rc::from_raw(ptr) }
    fn current(handle:&Handle) -> bool {
        handle.alive.get() && HANDLES.with(|slots| slots.borrow()[handle.id as usize-1].as_ref().is_some_and(|h| Rc::as_ptr(h) == handle as *const Handle))
    }
    unsafe fn interactive(handle:&Handle) -> bool {
        current(handle) && !EXHAUSTED.load(Ordering::SeqCst) && handle.revision.get() == REVISION.load(Ordering::SeqCst)
            && IsWindow(handle.hwnd) != 0 && GetParent(handle.hwnd) == handle.parent && GetDlgCtrlID(handle.hwnd) == 4300 + handle.id as i32
            && IsWindowVisible(handle.hwnd) != 0 && IsWindowVisible(handle.parent) != 0 && IsWindowEnabled(handle.parent) != 0
    }
    unsafe fn inside(handle:&Handle,lp:LPARAM) -> bool {
        let x=lp as u16 as i16 as i32; let y=(lp>>16) as u16 as i16 as i32;
        let mut bounds:RECT=std::mem::zeroed();
        GetClientRect(handle.hwnd,&mut bounds) != 0 && x >= 0 && y >= 0 && x < bounds.right && y < bounds.bottom
    }
    unsafe fn cancel(handle:&Handle) {
        handle.pressed.set(None); handle.hover.set(false);
        if GetCapture() == handle.hwnd { ReleaseCapture(); }
        if current(handle) { InvalidateRect(handle.hwnd,std::ptr::null(),0); }
    }
    unsafe fn fill(dc:HDC,bounds:&RECT,rgb:[u8;3],radius:i32) {
        let brush=CreateSolidBrush(color(rgb));
        if brush.is_null() { return; }
        if radius == 0 { FillRect(dc,bounds,brush); }
        else {
            let region=CreateRoundRectRgn(bounds.left,bounds.top,bounds.right+1,bounds.bottom+1,radius*2,radius*2);
            if !region.is_null() { FillRgn(dc,region,brush); DeleteObject(region); }
        }
        DeleteObject(brush);
    }
    unsafe fn paint(handle:&Handle) {
        let mut ps:PAINTSTRUCT=std::mem::zeroed(); let dc=BeginPaint(handle.hwnd,&mut ps);
        if !dc.is_null() {
            let mut bounds:RECT=std::mem::zeroed();
            if GetClientRect(handle.hwnd,&mut bounds) != 0 {
                let row=handle.row.borrow().clone(); let colors=handle.colors.get(); let scale=handle.scale.get(); let style=handle.style.get();
                fill(dc,&bounds,colors.background,0);
                if row.selected || handle.hover.get() { fill(dc,&bounds,if row.selected {colors.selected} else {colors.hover},(style.radius*scale).round() as i32); }
                let face:Vec<u16>="Segoe UI\0".encode_utf16().collect();
                let font=CreateFontW(-(style.font_size*scale).round() as i32,0,0,0,style.font_weight as i32,0,0,0,DEFAULT_CHARSET as u32,OUT_DEFAULT_PRECIS as u32,CLIP_DEFAULT_PRECIS as u32,DEFAULT_QUALITY as u32,0,face.as_ptr());
                if !font.is_null() {
                    let previous=SelectObject(dc,font); SetBkMode(dc,TRANSPARENT as i32);
                    SetTextColor(dc,color(if row.selected || handle.hover.get() {colors.text} else {colors.muted}));
                    let pad=(style.padding_x*scale).round() as i32;
                    let mut text_bounds=RECT {left:pad,right:(bounds.right-pad).max(pad),..bounds};
                    let text:Vec<u16>=row.label.encode_utf16().collect();
                    DrawTextW(dc,text.as_ptr(),text.len() as i32,&mut text_bounds,DT_SINGLELINE|DT_VCENTER|DT_END_ELLIPSIS|DT_NOPREFIX);
                    if !previous.is_null() { SelectObject(dc,previous); }
                    DeleteObject(font);
                }
            }
        }
        EndPaint(handle.hwnd,&ps);
    }
    unsafe extern "system" fn procedure(hwnd:HWND,msg:u32,wp:WPARAM,lp:LPARAM,_:usize,data:usize) -> LRESULT {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(||procedure_inner(hwnd,msg,wp,lp,data)))
            .unwrap_or_else(|_|DefSubclassProc(hwnd,msg,wp,lp))
    }
    unsafe fn procedure_inner(hwnd:HWND,msg:u32,wp:WPARAM,lp:LPARAM,data:usize) -> LRESULT {
        let ptr=data as *const Handle;
        if ptr.is_null() { return DefSubclassProc(hwnd,msg,wp,lp); }
        let handle=retain(ptr);
        if hwnd != handle.hwnd { return DefSubclassProc(hwnd,msg,wp,lp); }
        if msg == WM_NCDESTROY {
            RemoveWindowSubclass(hwnd,Some(procedure),SUBCLASS); cancel(&handle); handle.alive.set(false);
            HANDLES.with(|slots| { let mut slots=slots.borrow_mut(); let slot=&mut slots[handle.id as usize-1]; if slot.as_ref().is_some_and(|h| Rc::as_ptr(h)==ptr) { *slot=None; } });
            let result=DefSubclassProc(hwnd,msg,wp,lp); drop(Rc::from_raw(ptr)); return result;
        }
        if !current(&handle) { return DefSubclassProc(hwnd,msg,wp,lp); }
        match msg {
            WM_PAINT => { paint(&handle); return 0; }
            WM_ERASEBKGND => return 1,
            WM_MOUSEACTIVATE => return MA_NOACTIVATE as isize,
            WM_SETCURSOR if interactive(&handle) => { let cursor=LoadCursorW(null_mut(),IDC_HAND); if !cursor.is_null() {SetCursor(cursor);return 1;} }
            WM_LBUTTONDOWN | WM_LBUTTONDBLCLK => {
                cancel(&handle);
                if interactive(&handle) && inside(&handle,lp) {
                    let revision=handle.revision.get(); SetCapture(hwnd);
                    if interactive(&handle) && handle.revision.get()==revision && GetCapture()==hwnd { handle.pressed.set(Some(revision)); }
                }
                return 0;
            }
            WM_LBUTTONUP => {
                let revision=handle.pressed.take(); let owned=GetCapture()==hwnd;
                if owned { ReleaseCapture(); }
                if owned && inside(&handle,lp) && interactive(&handle) && action_current(revision,handle.revision.get(),REVISION.load(Ordering::SeqCst)) {
                    let _=handle.app.emit_to("main","native-sidebar-action",serde_json::json!({"revision":handle.revision.get(),"id":handle.id}));
                }
                return 0;
            }
            WM_MOUSEMOVE if interactive(&handle) => {
                let hover=inside(&handle,lp);
                if handle.hover.replace(hover)!=hover {
                    if hover { let mut track=TRACKMOUSEEVENT {cbSize:std::mem::size_of::<TRACKMOUSEEVENT>() as u32,dwFlags:TME_LEAVE,hwndTrack:hwnd,dwHoverTime:0}; if TrackMouseEvent(&mut track)==0 {handle.hover.set(false);} }
                    InvalidateRect(hwnd,std::ptr::null(),0);
                }
                return 0;
            }
            WM_MOUSELEAVE => {handle.hover.set(false);InvalidateRect(hwnd,std::ptr::null(),0);return 0;}
            WM_CAPTURECHANGED | WM_CANCELMODE => {cancel(&handle);return 0;}
            WM_SHOWWINDOW if wp==0 => cancel(&handle),
            _=>{}
        }
        DefSubclassProc(hwnd,msg,wp,lp)
    }
    unsafe fn create(app:&AppHandle,parent:HWND,row:Row,revision:u64,colors:Colors,style:TextStyle,scale:f64) -> Option<Rc<Handle>> {
        let class:Vec<u16>="STATIC\0".encode_utf16().collect();
        let hwnd=CreateWindowExW(0,class.as_ptr(),std::ptr::null(),WS_CHILD|WS_CLIPSIBLINGS|SS_NOTIFY,0,0,0,0,parent,(4300+row.id as usize) as HMENU,null_mut(),null_mut());
        if hwnd.is_null() {return None;}
        let handle=Rc::new(Handle {app:app.clone(),parent,hwnd,id:row.id,alive:Cell::new(true),revision:Cell::new(revision),row:RefCell::new(row),scale:Cell::new(scale),colors:Cell::new(colors),style:Cell::new(style),hover:Cell::new(false),pressed:Cell::new(None)});
        let ptr=Rc::into_raw(handle.clone());
        if SetWindowSubclass(hwnd,Some(procedure),SUBCLASS,ptr as usize)==0 {drop(Rc::from_raw(ptr));DestroyWindow(hwnd);return None;}
        HANDLES.with(|slots|slots.borrow_mut()[handle.id as usize-1]=Some(handle.clone()));
        Some(handle)
    }
    pub(super) fn sync(app:AppHandle,revision:u64,rows:Vec<Row>,colors:Colors,style:TextStyle) -> Result<(),String> {
        let scheduler=app.clone();
        scheduler.run_on_main_thread(move ||unsafe {
            if EXHAUSTED.load(Ordering::SeqCst) || REVISION.load(Ordering::SeqCst)!=revision {return;}
            let main=app.get_window("main"); let parent=main.as_ref().and_then(|w|w.hwnd().ok()).map(|h|h.0 as HWND);
            let scale=main.as_ref().and_then(|w|w.scale_factor().ok()).unwrap_or(f64::NAN);
            let usable=parent.is_some_and(|h|!h.is_null()&&IsWindow(h)!=0&&IsWindowEnabled(h)!=0) && scale.is_finite()&&scale>0.0&&scale<=16.0;
            let mut ids=Vec::new();
            for id in 1..=15u8 {
                if EXHAUSTED.load(Ordering::SeqCst) || REVISION.load(Ordering::SeqCst)!=revision {return;}
                let row=rows.iter().find(|r|r.id==id).filter(|_|usable).cloned();
                let existing=HANDLES.with(|slots|slots.borrow()[id as usize-1].clone());
                let handle=existing.or_else(||row.clone().and_then(|r|create(&app,parent.unwrap(),r,revision,colors,style,scale)));
                if let Some(handle)=handle {
                    if !current(&handle) {continue;}
                    cancel(&handle);
                    if EXHAUSTED.load(Ordering::SeqCst) || REVISION.load(Ordering::SeqCst)!=revision || !current(&handle) {return;}
                    let Some(row)=row.filter(|_|Some(handle.parent)==parent) else {ShowWindow(handle.hwnd,SW_HIDE);continue;};
                    let rect=row.rect; *handle.row.borrow_mut()=row; handle.revision.set(revision); handle.colors.set(colors); handle.style.set(style); handle.scale.set(scale);
                    let px=|v:f64|(v*scale).round() as i32;
                    if SetWindowPos(handle.hwnd,HWND_TOP,px(rect.x),px(rect.y),px(rect.w).max(1),px(rect.h).max(1),SWP_NOACTIVATE|SWP_SHOWWINDOW)==0 {if current(&handle){ShowWindow(handle.hwnd,SW_HIDE);}continue;}
                    if interactive(&handle) {InvalidateRect(handle.hwnd,std::ptr::null(),0);ids.push(id);} else if current(&handle) {ShowWindow(handle.hwnd,SW_HIDE);}
                }
            }
            if !EXHAUSTED.load(Ordering::SeqCst) && REVISION.load(Ordering::SeqCst)==revision {ready(&app,revision,ids);}
        }).map_err(|_|"native_sidebar_unavailable".into())
    }
    /// Re-place the shown rows with the window's current scale (the CSS rects are unchanged).
    pub(super) fn rescale(app:&AppHandle) {
        let app=app.clone(); let scheduler=app.clone();
        let _=scheduler.run_on_main_thread(move ||unsafe {
            let Some(scale)=app.get_window("main").and_then(|w|w.scale_factor().ok()) else {return};
            let handles=HANDLES.with(|slots|slots.borrow().iter().flatten().cloned().collect::<Vec<_>>());
            for handle in handles {
                if !current(&handle) || IsWindowVisible(handle.hwnd)==0 || handle.scale.get()==scale {continue;}
                let rect=handle.row.borrow().rect;
                let Some((x,y,w,h))=crate::window_fit::physical_child(rect.x,rect.y,rect.w,rect.h,scale) else {continue};
                cancel(&handle);
                if SetWindowPos(handle.hwnd,HWND_TOP,x,y,w,h,SWP_NOACTIVATE)!=0 {handle.scale.set(scale);InvalidateRect(handle.hwnd,std::ptr::null(),0);}
            }
        });
    }
    pub(super) fn reset(app:AppHandle,floor:Option<u64>) -> Result<(),String> {
        let scheduler=app.clone();
        scheduler.run_on_main_thread(move ||unsafe {
            let handles=HANDLES.with(|slots|slots.borrow().iter().flatten().cloned().collect::<Vec<_>>());
            for handle in handles {
                // A delayed reset must not hide a newer document's applied row.
                if current(&handle) && floor.is_none_or(|floor|handle.revision.get()<=floor) {
                    cancel(&handle);
                    if current(&handle) && floor.is_none_or(|floor|handle.revision.get()<=floor) {ShowWindow(handle.hwnd,SW_HIDE);}
                }
            }
            if let Some(floor)=floor.filter(|floor|REVISION.load(Ordering::SeqCst)==*floor) {ready(&app,floor,Vec::new());}
        }).map_err(|_|"native_sidebar_unavailable".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn style() -> TextStyle {TextStyle{font_size:14.0,padding_x:12.0,radius:9.0,font_weight:400}}
    fn row(id:u8) -> Row {Row {id,label:fixed_label(id).unwrap_or("").into(),selected:false,rect:Rect{x:0.0,y:0.0,w:1.0,h:1.0}}}
    #[test] fn fixed_ids_labels_and_views_are_closed() {
        for (view,ids) in [(View::Feed,1..=3),(View::Notifications,4..=8),(View::Market,9..=11),(View::Settings,12..=15)] {
            let rows=ids.map(row).collect::<Vec<_>>(); assert!(valid(view,1,&rows,style()));
            let mut duplicate=rows.clone(); duplicate.push(rows[0].clone()); assert!(!valid(view,2,&duplicate,style()));
            let mut wrong=rows.clone(); wrong[0].label="different".into(); assert!(!valid(view,2,&wrong,style()));
        }
        assert!(!valid(View::Feed,1,&[row(4)],style())); assert!(!valid(View::Feed,1,&[row(0)],style())); assert!(!valid(View::Settings,1,&[row(16)],style()));
        assert!(valid(View::Feed,1,&[],style())); assert!(!valid(View::Notifications,1,&vec![row(4);6],style()));
    }
    #[test] fn label_utf16_controls_and_geometry_widths_are_bounded() {
        assert!(label_valid(&"😀".repeat(64))); assert!(!label_valid(&"😀".repeat(65)));
        for label in ["","a\0","a\n","\u{7f}","\u{85}"] {assert!(!label_valid(label));}
        let rect=row(1).rect; assert!(geometry_valid(Rect{x:32767.0,y:32767.0,w:1000.0,h:100.0}));
        for bad in [Rect{x:f64::NAN,..rect},Rect{y:-1.0,..rect},Rect{w:0.999,..rect},Rect{w:1000.001,..rect},Rect{h:0.999,..rect},Rect{h:100.001,..rect},Rect{x:32768.0,..rect}] {assert!(!geometry_valid(bad));}
    }
    #[test] fn fonts_revisions_and_rgb_do_not_wrap_or_admit_nonfinite_values() {
        let rows=[row(1)]; for font in [10.0,24.0] {assert!(valid(View::Feed,SAFE_REVISION,&rows,TextStyle{font_size:font,..style()}));}
        for font in [9.999,24.001,f64::NAN,f64::INFINITY] {assert!(!valid(View::Feed,1,&rows,TextStyle{font_size:font,..style()}));}
        for revision in [0,SAFE_REVISION+1,u64::MAX] {assert!(!valid(View::Feed,revision,&rows,style()));}
        let counter=AtomicU64::new(0); assert!(advance(&counter,1)); assert!(!advance(&counter,1)); assert!(!advance(&counter,0)); assert!(advance(&counter,3)); assert!(!advance(&counter,2)); assert!(advance(&counter,SAFE_REVISION)); assert!(!advance(&counter,SAFE_REVISION+1)); assert_eq!(counter.load(Ordering::SeqCst),SAFE_REVISION);
        assert_eq!(color([0x12,0x34,0x56]),0x563412);
    }
    #[test] fn measured_styles_reject_nonfinite_out_of_bounds_and_integer_overflow() {
        assert!(style_valid(TextStyle{padding_x:0.0,radius:0.0,font_weight:100,..style()}));
        assert!(style_valid(TextStyle{padding_x:32.0,radius:20.0,font_weight:900,..style()}));
        for bad in [TextStyle{padding_x:-0.001,..style()},TextStyle{padding_x:32.001,..style()},TextStyle{padding_x:f64::NAN,..style()},TextStyle{radius:-0.001,..style()},TextStyle{radius:20.001,..style()},TextStyle{radius:f64::INFINITY,..style()},TextStyle{font_weight:99,..style()},TextStyle{font_weight:901,..style()},TextStyle{font_weight:u16::MAX,..style()}] {assert!(!style_valid(bad));}
    }
    #[test] fn captured_actions_cannot_bind_to_newer_rows_or_revisions() {
        assert!(action_current(Some(1),1,1)); assert!(action_current(Some(SAFE_REVISION),SAFE_REVISION,SAFE_REVISION));
        for (pressed,revision,latest) in [(None,1,1),(Some(1),2,2),(Some(1),1,2),(Some(2),1,1),(Some(0),0,0),(Some(SAFE_REVISION+1),SAFE_REVISION+1,SAFE_REVISION+1)] {assert!(!action_current(pressed,revision,latest));}
    }
    #[test] fn document_reset_allocates_a_floor_and_invalidates_old_captured_actions() {
        let counter=AtomicU64::new(7); let floor=reset_floor(&counter).unwrap();
        assert_eq!(floor,8); assert!(!advance(&counter,7)); assert!(!advance(&counter,8));
        assert!(!action_current(Some(7),7,floor)); assert!(advance(&counter,floor+1));
        counter.store(SAFE_REVISION-1,Ordering::SeqCst); assert_eq!(reset_floor(&counter),Some(SAFE_REVISION));
        assert_eq!(reset_floor(&counter),None); assert_eq!(counter.load(Ordering::SeqCst),SAFE_REVISION);
        counter.store(u64::MAX,Ordering::SeqCst); assert_eq!(reset_floor(&counter),None);
    }
}
