// Paid AI execution (x402 pay-per-use through the device wallet) is switched off.
// Owner decision 2026-10-15: 「AIの有料実行っていらない」.
//
// The code stays behind this one constant so it can return without a rewrite.
// With it false: the "AI ツール" card in the AI view is hidden, the three native
// commands below are refused by the UI invoke guard, and therefore the wallet
// network-switch prompt can never be raised for an AI payment. Free and local
// AI (Pi work, local models, the right-rail AI hand-off) is unaffected.
export const AI_PAID_EXECUTION = false;

// Tauri commands that exist only for paid AI execution.
export const PAID_AI_COMMANDS = Object.freeze(["ai_catalog", "ai_call", "ai_pay_and_call"]);

export function isPaidAiCommand(name) {
  return PAID_AI_COMMANDS.includes(name);
}
