// Run-specific guidance and tool selection. Everything here only shapes what
// the model is told and offered; Hub's executor still enforces every boundary
// (a tool left out here is refused there too, and nothing here grants one).

export const VERIFY_TOOLS = Object.freeze(["hub_exec", "hub_test"]);
export const COMMERCE_TOOLS = Object.freeze(["hub_catalog_search", "hub_product_read", "hub_pay"]);

// Marketplace intent in the operator's own request. Kept narrow so ordinary
// coding prompts ("the product of two numbers", "go to the store and buy some
// more", "a shopping basket") do not match: it needs the marketplace itself,
// a cart action, a tool name, or a buy request aimed at Hub or a market.
const COMMERCE_INTENT = /\bmarket ?place\b|\badd (?:it |this )?to (?:my |the )?cart\b|\b(?:buy|purchase|order)\b[^.\n]{0,40}\b(?:on|from|in|at) (?:the )?(?:hub|market)\b|hub_catalog_search|hub_product_read|hub_pay|マーケット|購入して|購入したい|買って|買いたい|注文して|注文したい|通販/i;

function mentionsCommerce(value) {
  return typeof value === "string" && COMMERCE_INTENT.test(value);
}

// True when the run's purpose needs the marketplace tools: an explicit
// "commerce" capability, a request that asks for marketplace work, or a
// resumed conversation that already used them (or asked for them).
export function commerceNeeded({ caps = new Set(), prompt = "", entries = [] } = {}) {
  if (caps.has("commerce") || mentionsCommerce(prompt)) return true;
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => {
    const message = entry?.message;
    if (!message || !Array.isArray(message.content)) return mentionsCommerce(message?.content);
    return message.content.some((block) => (block?.type === "toolCall" && COMMERCE_TOOLS.includes(block.name))
      || (message.role === "user" && block?.type === "text" && mentionsCommerce(block.text)));
  });
}

// The system guidance for the tools this run actually has. Tool names that
// are not offered are never mentioned, so the model is not invited to call them.
export function buildGuidance(toolNames, { agentsFiles = true } = {}) {
  const tools = new Set(toolNames);
  const checks = VERIFY_TOOLS.filter((name) => tools.has(name));
  const verifyLines = checks.length ? [
    `After editing, use ${checks.join(" or ")} to check the changed behavior and implied boundary cases.`,
    "Treat nonzero exit codes, timeouts and tool errors as failures: use the diagnostics to correct the cause, then rerun the affected check.",
  ] : [
    "This run has no command or test tool. Check your change against every requirement and boundary case by reasoning over the code you wrote, then report it as unverified.",
    "Treat tool errors as failures: use the error to correct the cause.",
  ];
  return `
Keep responses short; prefer tool calls to commentary, and never paste file contents outside a write/edit call.
Locate code with hub_search (source symbols or text, not invented filenames; path may be a directory or one file). Read with hub_read; large files come back in pages, so pass startLine/lineCount for the part you need.
Edit with hub_edit (exact unique oldText) for focused changes; use hub_write only for new files or small files you rewrite completely. Preserve unrelated code, public interfaces, module format and dependencies.
For a multi-file change, inspect the affected modules and callers, then implement every required part.
${agentsFiles ? "Read applicable AGENTS.md instructions. " : ""}Read each file with hub_read (a page is enough) before editing it. Search excerpts are not file reads. After resuming, an earlier read counts only while the file is unchanged; if Hub answers read_before_write_required, read it again.
${verifyLines.join("\n")}
Do not repeat an unchanged failed operation or resubmit a denied action; Hub stops three repetitions of an unchanged tool-result cycle. Report unavailable or denied verification as unverified.
In the final answer distinguish changes made, checks actually passed, and remaining failures or unverified work.
`;
}

// AGENTS.md can only matter when the workspace may contain one: Hub's tools cannot read
// outside the workspace, so a complete map without it makes the instruction a dead read.
export function workspaceMayHaveAgentsFile(map) {
  if (!map || !Array.isArray(map.files) || map.truncated || map.unavailable) return true;
  return map.files.some((path) => typeof path === "string" && /(^|\/)AGENTS\.md$/i.test(path));
}

// Decides whether the one completion review is worth another model turn.
// Hub counts only its own tool results. The review is skipped when the last
// Hub result was a successful write/edit and the run has nothing to check
// with, or when every change was already followed by a successful check.
// A run that changed nothing keeps the review, so a claimed-but-missing edit
// is still caught.
export function createReviewGate() {
  let writes = 0, writesAtCheck = -1, lastWasWrite = false;
  return {
    record(name, ok) {
      if (name === "hub_finish" || name === "hub_todo") return;
      const write = name === "hub_write" || name === "hub_edit";
      if (ok && write) writes++;
      if (ok && VERIFY_TOOLS.includes(name)) writesAtCheck = writes;
      lastWasWrite = ok && write;
    },
    shouldReview({ verifyTools = false } = {}) {
      if (writes === 0) return true;
      if (writesAtCheck === writes) return false;
      return !(lastWasWrite && !verifyTools);
    },
  };
}
