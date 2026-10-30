#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `--hub-engine-jail`: this executable confines an external AI-work engine and exits
    // (engine_jail.rs). It never starts the app in that mode.
    if let Some(code) = hub_local_runner::engine_jail::dispatch() {
        std::process::exit(code);
    }
    hub_local_runner::run();
}
