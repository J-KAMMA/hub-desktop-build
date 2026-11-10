//! 背景タブを自動で休ませる方針（メモリ節約）。純粋な判断だけをここに置き、
//! WebView2 への実際の操作は `TabEngine` 越しに行う（テストでは偽物を差し込む）。
//!
//! 段階: 隠れた直後 MemoryUsageTargetLevel=Low（browser_window 側）→
//! 一定時間後 TrySuspend → さらに長く隠れる／メモリ逼迫で破棄（URL等は残す）。
//! 例外（休ませない）: 音声再生中・ダウンロード中・未保存の入力あり・固定・AI受け渡し中・プライベート。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

pub const DEFAULT_SUSPEND_MINUTES: u64 = 5;
pub const DEFAULT_DISCARD_MINUTES: u64 = 30;
/// メモリ逼迫のとき、隠れてからこの時間で破棄する。
pub const PRESSURE_GRACE: Duration = Duration::from_secs(30);

static SUSPEND_MINUTES: AtomicU64 = AtomicU64::new(DEFAULT_SUSPEND_MINUTES);
static DISCARD_MINUTES: AtomicU64 = AtomicU64::new(DEFAULT_DISCARD_MINUTES);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RestConfig { pub suspend_after: Duration, pub discard_after: Duration }

impl RestConfig {
    pub fn current() -> Self {
        // 検証用の秒指定（既存の HUB_BROWSER_DISCARD_SECS と同じ流儀）。
        let secs = |name: &str| std::env::var(name).ok().and_then(|v| v.parse::<u64>().ok()).filter(|v| *v > 0).map(Duration::from_secs);
        let suspend = secs("HUB_BROWSER_SUSPEND_SECS").unwrap_or_else(|| Duration::from_secs(SUSPEND_MINUTES.load(Ordering::Relaxed) * 60));
        let discard = secs("HUB_BROWSER_DISCARD_SECS").unwrap_or_else(|| Duration::from_secs(DISCARD_MINUTES.load(Ordering::Relaxed) * 60));
        Self { suspend_after: suspend, discard_after: discard.max(suspend) }
    }
}

/// 分単位の設定。1〜1440分、破棄は停止以上。範囲外は拒否。
pub fn set_minutes(suspend: u64, discard: u64) -> Result<(), &'static str> {
    if !(1..=1440).contains(&suspend) || !(1..=1440).contains(&discard) || discard < suspend { return Err("invalid_rest_minutes"); }
    SUSPEND_MINUTES.store(suspend, Ordering::Relaxed);
    DISCARD_MINUTES.store(discard, Ordering::Relaxed);
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exemption { Active, Private, Pinned, PlayingAudio, Downloading, UnsavedInput, AiHandoff }

#[derive(Clone, Copy, Debug)]
pub struct Facts {
    pub id: u64,
    pub active: bool,
    pub discarded: bool,
    pub private: bool,
    pub pinned: bool,
    pub playing_audio: bool,
    pub downloading: bool,
    pub ai_in_use: bool,
    /// None = まだ調べていない。
    pub unsaved_input: Option<bool>,
    pub hidden_for: Option<Duration>,
}

pub fn exemption(f: &Facts) -> Option<Exemption> {
    if f.active || f.hidden_for.is_none() { Some(Exemption::Active) }
    else if f.private { Some(Exemption::Private) }
    else if f.pinned { Some(Exemption::Pinned) }
    else if f.playing_audio { Some(Exemption::PlayingAudio) }
    else if f.downloading { Some(Exemption::Downloading) }
    else if f.ai_in_use { Some(Exemption::AiHandoff) }
    else if f.unsaved_input == Some(true) { Some(Exemption::UnsavedInput) }
    else { None }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step { Keep, Probe, Suspend, Discard }

/// 1枚のタブの次の一手。`suspended` はこちらが TrySuspend を発行済みか。
pub fn decide(f: &Facts, suspended: bool, cfg: RestConfig, pressure: bool) -> Step {
    if f.discarded || exemption(f).is_some() { return Step::Keep; }
    let hidden = f.hidden_for.unwrap_or_default();
    let due_discard = hidden >= cfg.discard_after || (pressure && hidden >= PRESSURE_GRACE);
    let due_suspend = !suspended && hidden >= cfg.suspend_after;
    if !(due_discard || due_suspend) { return Step::Keep; }
    if f.unsaved_input.is_none() { return Step::Probe; }
    if due_discard { Step::Discard } else { Step::Suspend }
}

/// WebView2 側の操作。実機では browser_window が実装し、テストは偽物。
pub trait TabEngine {
    fn probe_unsaved_input(&mut self, id: u64);
    fn try_suspend(&mut self, id: u64);
    fn resume(&mut self, id: u64);
    fn discard(&mut self, id: u64) -> bool;
}

#[derive(Default, Clone, Copy)]
struct TabRest { suspended: bool, unsaved: Option<bool>, probing: bool }

/// タブごとの休止状態。表の外（Tab 構造体）には持たない。
#[derive(Default)]
pub struct Rester { tabs: HashMap<u64, TabRest> }

impl Rester {
    pub fn is_suspended(&self, id: u64) -> bool { self.tabs.get(&id).is_some_and(|t| t.suspended) }
    pub fn unsaved(&self, id: u64) -> Option<bool> { self.tabs.get(&id).and_then(|t| t.unsaved) }
    /// 入力調査の結果。調べられなかったときは未保存ありとして守る。
    pub fn probe_result(&mut self, id: u64, dirty: Option<bool>) {
        let t = self.tabs.entry(id).or_default();
        t.probing = false;
        t.unsaved = Some(dirty.unwrap_or(true));
    }
    /// 表示へ戻った（または閉じた）。状態を捨てる。
    pub fn activated(&mut self, id: u64, engine: &mut dyn TabEngine) {
        if self.tabs.remove(&id).is_some_and(|t| t.suspended) { engine.resume(id); }
    }
    /// TrySuspend が拒否された。再試行はせず、破棄の時刻だけ待つ。
    pub fn suspend_failed(&mut self, id: u64) { if let Some(t) = self.tabs.get_mut(&id) { t.suspended = false; } }

    /// 定期点検。`facts` の unsaved_input は呼び出し側で空のままでよい（ここで補う）。
    pub fn tick(&mut self, facts: &[Facts], cfg: RestConfig, pressure: bool, engine: &mut dyn TabEngine) -> usize {
        let mut discarded = 0;
        let live: Vec<u64> = facts.iter().map(|f| f.id).collect();
        self.tabs.retain(|id, _| live.contains(id));
        for f in facts {
            let state = self.tabs.get(&f.id).copied().unwrap_or_default();
            if f.active || f.hidden_for.is_none() {
                self.activated(f.id, engine);
                continue;
            }
            if f.discarded { self.tabs.remove(&f.id); continue; }
            // 調査済みの結果は一度だけ有効。タブを再び隠す度に調べ直すので、ここで引き継ぐ。
            let mut f = *f;
            f.unsaved_input = state.unsaved;
            match decide(&f, state.suspended, cfg, pressure) {
                Step::Keep => {
                    // 未保存入力が見つかった間は休止済みでも起こしておく。
                    if state.suspended && exemption(&f).is_some() {
                        engine.resume(f.id);
                        self.tabs.entry(f.id).or_default().suspended = false;
                    }
                }
                Step::Probe => {
                    let t = self.tabs.entry(f.id).or_default();
                    if !t.probing { t.probing = true; engine.probe_unsaved_input(f.id); }
                }
                Step::Suspend => {
                    self.tabs.entry(f.id).or_default().suspended = true;
                    engine.try_suspend(f.id);
                }
                Step::Discard => {
                    if engine.discard(f.id) { self.tabs.remove(&f.id); discarded += 1; }
                }
            }
        }
        discarded
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Fake { log: Vec<String>, discard_ok: bool }
    impl TabEngine for Fake {
        fn probe_unsaved_input(&mut self, id: u64) { self.log.push(format!("probe {id}")); }
        fn try_suspend(&mut self, id: u64) { self.log.push(format!("suspend {id}")); }
        fn resume(&mut self, id: u64) { self.log.push(format!("resume {id}")); }
        fn discard(&mut self, id: u64) -> bool { self.log.push(format!("discard {id}")); self.discard_ok }
    }
    fn cfg() -> RestConfig { RestConfig { suspend_after: Duration::from_secs(300), discard_after: Duration::from_secs(1800) } }
    fn mins(m: u64) -> Option<Duration> { Some(Duration::from_secs(m * 60)) }
    fn facts(id: u64, hidden: Option<Duration>) -> Facts {
        Facts { id, active: false, discarded: false, private: false, pinned: false, playing_audio: false, downloading: false, ai_in_use: false, unsaved_input: None, hidden_for: hidden }
    }

    #[test]
    fn defaults_are_five_and_thirty_minutes() {
        assert_eq!(DEFAULT_SUSPEND_MINUTES, 5);
        assert_eq!(DEFAULT_DISCARD_MINUTES, 30);
        assert!(set_minutes(0, 30).is_err() && set_minutes(10, 5).is_err() && set_minutes(5, 2000).is_err());
    }

    #[test]
    fn nothing_happens_before_the_idle_time() {
        let mut r = Rester::default(); let mut e = Fake::default();
        r.tick(&[facts(1, mins(4))], cfg(), false, &mut e);
        assert!(e.log.is_empty());
    }

    #[test]
    fn probe_then_suspend_then_discard_in_order() {
        let mut r = Rester::default(); let mut e = Fake { discard_ok: true, ..Default::default() };
        r.tick(&[facts(1, mins(5))], cfg(), false, &mut e);
        assert_eq!(e.log, ["probe 1"]);
        r.tick(&[facts(1, mins(5))], cfg(), false, &mut e); // 結果待ち中は二重に調べない
        assert_eq!(e.log, ["probe 1"]);
        r.probe_result(1, Some(false));
        r.tick(&[facts(1, mins(6))], cfg(), false, &mut e);
        assert_eq!(e.log, ["probe 1", "suspend 1"]);
        assert!(r.is_suspended(1));
        r.tick(&[facts(1, mins(20))], cfg(), false, &mut e); // 休止中は繰り返さない
        assert_eq!(e.log.len(), 2);
        assert_eq!(r.tick(&[facts(1, mins(30))], cfg(), false, &mut e), 1);
        assert_eq!(e.log.last().unwrap(), "discard 1");
        assert!(!r.is_suspended(1));
    }

    #[test]
    fn memory_pressure_discards_after_a_short_grace() {
        let mut r = Rester::default(); let mut e = Fake { discard_ok: true, ..Default::default() };
        r.probe_result(1, Some(false));
        r.tick(&[facts(1, Some(Duration::from_secs(29)))], cfg(), true, &mut e);
        assert!(e.log.is_empty());
        r.tick(&[facts(1, Some(Duration::from_secs(30)))], cfg(), true, &mut e);
        assert_eq!(e.log, ["discard 1"]);
    }

    #[test]
    fn every_exemption_blocks_suspend_and_discard() {
        let cases: [(fn(&mut Facts), Exemption); 5] = [
            (|f| f.pinned = true, Exemption::Pinned),
            (|f| f.playing_audio = true, Exemption::PlayingAudio),
            (|f| f.downloading = true, Exemption::Downloading),
            (|f| f.ai_in_use = true, Exemption::AiHandoff),
            (|f| f.private = true, Exemption::Private),
        ];
        for (set, why) in cases {
            let mut f = facts(1, mins(120)); f.unsaved_input = Some(false); set(&mut f);
            assert_eq!(exemption(&f), Some(why));
            for pressure in [false, true] { assert_eq!(decide(&f, false, cfg(), pressure), Step::Keep, "{why:?}"); }
        }
        let mut dirty = facts(1, mins(120)); dirty.unsaved_input = Some(true);
        assert_eq!(exemption(&dirty), Some(Exemption::UnsavedInput));
        assert_eq!(decide(&dirty, false, cfg(), true), Step::Keep);
        let mut active = facts(1, mins(120)); active.active = true;
        assert_eq!(decide(&active, false, cfg(), true), Step::Keep);
        let mut gone = facts(1, mins(120)); gone.discarded = true;
        assert_eq!(decide(&gone, false, cfg(), true), Step::Keep);
    }

    #[test]
    fn unreadable_input_probe_protects_the_tab() {
        let mut r = Rester::default(); let mut e = Fake { discard_ok: true, ..Default::default() };
        r.probe_result(1, None);
        r.tick(&[facts(1, mins(60))], cfg(), true, &mut e);
        assert!(e.log.is_empty());
    }

    #[test]
    fn typing_while_suspended_wakes_the_tab_and_activation_resumes() {
        let mut r = Rester::default(); let mut e = Fake { discard_ok: true, ..Default::default() };
        r.probe_result(1, Some(false));
        r.tick(&[facts(1, mins(6))], cfg(), false, &mut e);
        assert!(r.is_suspended(1));
        let mut shown = facts(1, None); shown.active = true;
        r.tick(&[shown], cfg(), false, &mut e);
        assert_eq!(e.log, ["suspend 1", "resume 1"]);
        assert!(!r.is_suspended(1) && r.unsaved(1).is_none());
    }

    #[test]
    fn failed_suspend_and_failed_discard_leave_the_tab_alive() {
        let mut r = Rester::default(); let mut e = Fake { discard_ok: false, ..Default::default() };
        r.probe_result(1, Some(false));
        r.tick(&[facts(1, mins(6))], cfg(), false, &mut e);
        r.suspend_failed(1);
        assert!(!r.is_suspended(1));
        assert_eq!(r.tick(&[facts(1, mins(31))], cfg(), false, &mut e), 0); // 破棄に失敗しても数えない
        assert_eq!(e.log.last().unwrap(), "discard 1");
    }

    #[test]
    fn closed_tabs_are_forgotten() {
        let mut r = Rester::default(); let mut e = Fake::default();
        r.probe_result(1, Some(false)); r.probe_result(2, Some(false));
        r.tick(&[facts(2, mins(1))], cfg(), false, &mut e);
        assert_eq!(r.unsaved(1), None);
        assert_eq!(r.unsaved(2), Some(false));
    }

    #[test]
    fn config_never_discards_before_suspending() {
        let c = RestConfig::current();
        assert!(c.discard_after >= c.suspend_after);
    }
}
