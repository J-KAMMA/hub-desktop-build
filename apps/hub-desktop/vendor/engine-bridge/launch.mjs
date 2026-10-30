// The engine's world: a fresh run folder, a small environment and the jail. Nothing from the
// operator's environment is copied except what Windows itself needs, so keys and tokens in the
// user's environment never reach the engine.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const DEAD_END_PROXY = "http://127.0.0.1:9";
const SUBDIRS = ["scratch", "home", "appdata", "localappdata", "config", "data", "cache", "state", "tmp", "engine"];

/** `<run>\e\...` (Low integrity once the jail labels it) and the jail's files beside it. */
export function prepareRunDir(runDir) {
  if (!runDir) throw new Error("engine_run_dir_required");
  const root = join(runDir, "e");
  const paths = { run: runDir, root, stats: join(runDir, "jail-stats.json") };
  for (const name of SUBDIRS) {
    paths[name] = join(root, name);
    mkdirSync(paths[name], { recursive: true });
  }
  return paths;
}

export function engineEnv(paths, extra = {}) {
  const pick = (name) => process.env[name] ?? process.env[name.toUpperCase()];
  const systemRoot = pick("SystemRoot") ?? "C:\\Windows";
  const env = {
    SystemRoot: systemRoot, SystemDrive: pick("SystemDrive") ?? "C:", windir: systemRoot,
    OS: pick("OS") ?? "Windows_NT", NUMBER_OF_PROCESSORS: pick("NUMBER_OF_PROCESSORS") ?? "4",
    PROCESSOR_ARCHITECTURE: pick("PROCESSOR_ARCHITECTURE") ?? "AMD64", PATHEXT: ".COM;.EXE",
    PATH: `${systemRoot}\\System32`,
    HOME: paths.home, USERPROFILE: paths.home, APPDATA: paths.appdata, LOCALAPPDATA: paths.localappdata,
    XDG_CONFIG_HOME: paths.config, XDG_DATA_HOME: paths.data, XDG_CACHE_HOME: paths.cache, XDG_STATE_HOME: paths.state,
    TEMP: paths.tmp, TMP: paths.tmp,
    // Not a barrier (PLAN.md decision 5): anything that honours proxy variables meets a dead end.
    HTTP_PROXY: DEAD_END_PROXY, HTTPS_PROXY: DEAD_END_PROXY, ALL_PROXY: DEAD_END_PROXY,
    http_proxy: DEAD_END_PROXY, https_proxy: DEAD_END_PROXY, all_proxy: DEAD_END_PROXY,
    NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1", NODE_USE_ENV_PROXY: "1",
    DO_NOT_TRACK: "1",
  };
  return { ...env, ...extra };
}

/** Starts `program args` through `hub-local-runner.exe --hub-engine-jail`. */
export function launchJailed({ jail, program, args, paths, env }) {
  if (!jail) throw new Error("engine_jail_unavailable");
  const lowDirs = [paths.root, ...SUBDIRS.map((name) => paths[name])].flatMap((dir) => ["--low-dir", dir]);
  return spawn(jail, ["--hub-engine-jail", "--parent", String(process.pid), "--cwd", paths.scratch, "--stats", paths.stats,
    ...lowDirs, "--", program, ...args], { env, cwd: paths.scratch, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
}
