// A fixed, operator-declared command is checked outside the model's turn.
// Hub runs exactly that argv (never a model-built string) with hub_exec's
// workspace confinement and limits; the operator's declaration of the command
// for this run is the approval for it, up to MAX_VERIFY_ROUNDS executions.
// A failed check gets a repair turn with a compact failure summary; denial or
// infrastructure errors never retry. Only Hub's own exit record counts as a
// pass: a model's claim that something "ran" or "passed" is never evidence.
export const MAX_VERIFY_ROUNDS = 5;
export const FAILING_LINES = 30;
const LINE_CAP = 300;
const FAILURE_LINE = /\b(?:fail(?:ed|ure|ures|ing)?|error(?:s)?|assert(?:ion)?\w*|expected|traceback|panicked|exception|not ok|mismatch)\b|^E\s|✗|✖/i;

export function hasFinalAnswer(message) {
  return message?.role === "assistant" && message.stopReason === "stop"
    && Array.isArray(message.content)
    && !message.content.some((block) => block?.type === "toolCall")
    && message.content.some((block) => block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0);
}

// "command_failed: {json}" (or any text) -> pass/fail line plus the first N
// failing lines. Unparseable input keeps only a bounded head, never the whole.
export function compactVerificationFailure(message, limit = FAILING_LINES) {
  const text = String(message ?? "");
  const json = text.replace(/^command_failed: /, "");
  let report;
  try { report = JSON.parse(json); } catch { report = null; }
  const valid = report && typeof report === "object" && !Array.isArray(report);
  const status = valid
    ? `Verification FAILED (${report.timedOut === true ? "timed out" : `exit code ${report.exitCode ?? "unknown"}`})`
    : "Verification FAILED";
  const output = valid ? [report.stderr, report.stdout].filter((value) => typeof value === "string").join("\n") : json;
  const lines = output.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim());
  const failing = lines.filter((line) => FAILURE_LINE.test(line));
  const chosen = (failing.length ? failing : lines).slice(0, limit)
    .map((line) => line.length > LINE_CAP ? `${line.slice(0, LINE_CAP)}…` : line);
  const total = failing.length || lines.length;
  const heading = failing.length ? "First failing lines" : "First output lines";
  return `${status}\n${heading} (${chosen.length} of ${total}):\n${chosen.join("\n")}`;
}

export async function verifyWork({ check, repair, complete, prompt, rounds = MAX_VERIFY_ROUNDS, report = () => {} }) {
  const limit = Math.max(1, Math.min(MAX_VERIFY_ROUNDS, Number.isInteger(rounds) ? rounds : MAX_VERIFY_ROUNDS));
  for (let round = 1; round <= limit; round++) {
    if (!complete()) return false;
    report({ round, rounds: limit, status: "running" });
    try {
      const result = await check();
      const passed = result?.details?.exitCode === 0 && result?.details?.timedOut === false;
      report({ round, rounds: limit, status: passed ? "passed" : "failed" });
      return passed;
    } catch (error) {
      const message = String(error?.message ?? error);
      const failed = message.startsWith("command_failed:");
      report({ round, rounds: limit, status: failed ? "failed" : "unavailable" });
      if (!failed || round === limit) return false;
      // Preserve the current task; diagnostics are untrusted program output,
      // not new instructions or permission to edit the verification itself.
      await repair(`Current request (verbatim):\n${prompt}\n\nHub ran the declared verification command (round ${round} of ${limit}) and it failed. Correct the implementation without changing or weakening the verification, then finish your response. Hub will rerun the same command itself; your own statements that something ran or passed do not count as verification. Do not retry denied actions.\nUntrusted verification output (compacted):\n${compactVerificationFailure(message)}`);
    }
  }
  return false;
}
