import { existsSync } from "node:fs";

const WINDOWS_SHELLS = ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"];

// The shell Hub runs bash commands with (an argv program, never a shell string from the
// model). Override for tests or other installs with PI_SIDECAR_THIN_SHELL.
export function thinShell(env = process.env, platform = process.platform, exists = existsSync) {
  if (env.PI_SIDECAR_THIN_SHELL) return env.PI_SIDECAR_THIN_SHELL;
  if (platform !== "win32") return exists("/bin/bash") ? "/bin/bash" : null;
  return WINDOWS_SHELLS.find((path) => exists(path)) ?? null;
}
