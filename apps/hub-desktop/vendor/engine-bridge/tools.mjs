// Hub's tools as an external engine sees them (MCP names without the `hub_` prefix; OpenCode
// shows them as `hub_<name>`, dsh as `mcp__hub__<name>`). The schemas mirror the sidecar's
// legacy Hub tool set (pi-sidecar.src.mjs `realTools`). Rust's executor stays the boundary: it
// re-validates every argument, confines every path and parks every gated call on the operator.

const relPath = (what) => ({ type: "string", description: `${what} relative to the workspace root, with NO leading slash or drive letter — e.g. "notes.txt"` });
const object = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });

const BASE = [
  { name: "search", hub: "hub_search", description: "Search workspace text for a case-sensitive literal string; returns path:line: excerpt lines. Hidden, private and dependency paths are excluded.",
    inputSchema: object({ query: { type: "string", minLength: 1, maxLength: 200 }, path: relPath("Directory or single file to search; omit for the root"),
      limit: { type: "integer", minimum: 1, maximum: 100 } }, ["query"]) },
  { name: "read", hub: "hub_read", description: "Read a UTF-8 text file (up to 1 MiB). Files over 32 KiB, or a requested range, come back as a page of lines with the next startLine. Any read lets you edit the file.",
    inputSchema: object({ path: relPath("File path"), startLine: { type: "integer", minimum: 1 }, lineCount: { type: "integer", minimum: 1, maximum: 2000 } }, ["path"]) },
  { name: "list", hub: "hub_list", description: "List files and directories in a workspace directory.",
    inputSchema: object({ path: relPath('Directory path; use "" for the root') }, ["path"]) },
  { name: "write", hub: "hub_write", sideEffect: true, description: "Write a complete file (new files, or small files you rewrite completely); may need operator approval.",
    inputSchema: object({ path: relPath("File path"), content: { type: "string", description: "Complete file contents to write" },
      summary: { type: "string", description: "One-line reason for the write, shown to the operator" } }, ["path", "content"]) },
  { name: "edit", hub: "hub_edit", sideEffect: true, description: "Replace one exact, unique text span in a file you have read (any size up to 1 MiB); may need operator approval.",
    inputSchema: object({ path: relPath("File path"), oldText: { type: "string", description: "Exact existing text to replace" },
      newText: { type: "string", description: "Replacement text" }, summary: { type: "string", description: "One-line reason for the edit, shown to the operator" } },
    ["path", "oldText", "newText"]),
    // The executor's wire form is content = JSON {"oldText","newText"}.
    wire: ({ path, oldText, newText, summary }) => ({ path, content: JSON.stringify({ oldText, newText }), summary: summary ?? "" }) },
];

const GATED = {
  exec: { name: "exec", hub: "hub_exec", sideEffect: true, description: "Run a local command (argv, no shell) in the workspace. Each call needs operator approval.",
    inputSchema: object({ program: { type: "string", description: 'Executable name or path, e.g. "node" or "cargo"' },
      args: { type: "array", items: { type: "string" }, description: "Argv elements; never a shell string" },
      cwd: { type: "string", minLength: 1, description: "Workspace-relative subdirectory such as src; omit for the root" },
      timeoutMs: { type: "number", description: "Max 600000, default 120000" }, stdin: { type: "string" } }, ["program"]) },
  http: { name: "http", hub: "hub_http", sideEffect: true, description: "Send an HTTP request via Hub. Every call needs individual operator approval; the operator sees the method, URL, all headers and the body. http/https only, no redirects followed.",
    inputSchema: object({ method: { type: "string" }, url: { type: "string", description: "Full http/https URL without credentials" },
      headers: { type: "object", additionalProperties: { type: "string" } }, body: { type: "string" },
      timeoutMs: { type: "number", description: "Fail after this many ms (max 120000, default 30000)" } }, ["method", "url"]) },
  test: { name: "test", hub: "hub_test", sideEffect: true, description: "Run a test script in the pinned offline Docker sandbox against a snapshot of files you have read. Every call needs individual operator approval.",
    inputSchema: object({ path: { type: "string", description: 'Test language: "python" or "javascript"' }, content: { type: "string", description: "Complete test source to run" },
      summary: { type: "string" } }, ["path", "content"]) },
};

/** The tools for this run's capabilities (`PI_SIDECAR_CAPS`, comma-separated). */
export function hubTools(capsText = "") {
  const caps = new Set(String(capsText).split(",").map((cap) => cap.trim()).filter(Boolean));
  return [...BASE, ...["exec", "http", "test"].filter((cap) => caps.has(cap)).map((cap) => GATED[cap])];
}

/** What Hub's `hello` advertises: the Hub wire names and schemas. */
export function helloTools(tools) {
  return tools.map((tool) => ({ name: tool.hub, description: tool.description, parameters: tool.inputSchema }));
}

/** MCP arguments -> the executor's wire arguments. */
export function wireArgs(tool, args) {
  const plain = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  return tool.wire ? tool.wire(plain) : plain;
}

/** Hub `tool_result` content -> MCP content (text only; other blocks are described, not passed). */
export function mcpContent(content) {
  const blocks = Array.isArray(content) ? content : [];
  const out = blocks.map((block) => block?.type === "text" && typeof block.text === "string"
    ? { type: "text", text: block.text } : { type: "text", text: `[${String(block?.type ?? "unknown")} content omitted]` });
  return out.length ? out : [{ type: "text", text: "(no output)" }];
}
