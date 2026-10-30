const hints = {
  path_not_allowed: 'Refused: the path is outside the workspace or names a hidden/private file. Expected an allowed workspace-relative path with forward slashes, no leading slash, drive letter, dot segments or hidden/private files. Use hub_list with {"path":""} to discover allowed names; blocked paths remain blocked.',
  file_unavailable: 'The requested file could not be read. Use the workspace map or hub_list to find its actual relative path. This is not an operator approval decision.',
  directory_unavailable: 'The requested directory could not be read. Discover its actual relative path with hub_list; use {"path":""} for the workspace root.',
  invalid_action: 'Arguments must match the advertised tool schema. For hub_read/hub_list supply a path, not file content or proposed output.',
  invalid_search: 'hub_search expects query (a nonempty literal string, at most 200 characters), optional directory or file path and integer limit from 1 to 100. Omit path to search the workspace root.',
  invalid_read_range: 'hub_read expects a file path and optional integer startLine >= 1 and lineCount from 1 to 2000.',
  read_before_write_required: 'Hub has no current full read of this file (not read yet, or changed on disk since). Read it with hub_read before editing (a page with startLine/lineCount is enough). Old conversation text and search excerpts do not count.',
  file_changed_since_read: 'The file changed after it was read. Read its current contents with hub_read and revise the edit against that version.',
  resume_reread_required: 'The conversation was resumed and this file changed on disk since it was last read. Read its current contents (read) before overwriting it; earlier conversation text does not count.',
  file_changed_since_approval: 'The file changed after the approved preview. Read it again and propose a new edit; the previous approval cannot be reused.',
  edit_not_found: 'oldText did not match the current file. Read the file again and use an exact existing text span; no change was applied.',
  edit_ambiguous: 'oldText matched more than once. Include enough surrounding text to identify one exact occurrence; no change was applied.',
  line_out_of_range: 'startLine is past the end of the file. Use the totalLines from an earlier page, or omit startLine.',
  edit_no_change: 'The proposed edit does not change the file. Check the requested behavior before proposing a different edit.',
  // Refusals: a short reason plus the allowed next step. None of them can be lifted by the model.
  exec_not_permitted: 'Refused: command execution is not enabled for this run (an operator setting). Do not ask a subagent or another tool to run it. Next: finish the edits and state that the check was not run; Hub runs a declared verification command itself when one is set.',
  http_not_permitted: 'Refused: HTTP requests are not enabled for this run (an operator setting). Next: continue without the request and report what still needs network access.',
  test_not_permitted: 'Refused: the sandboxed test tool is not enabled for this run (an operator setting). Next: report the test as not run; do not describe it as passed.',
  write_not_permitted: 'Refused: file writes are not enabled for this run. Next: describe the intended change and report it as not applied.',
  approval_required: 'Refused: this action needs an operator decision and none is available in this run. Next: report the action as not performed.',
  linked_path_not_allowed: 'Refused: the path is a link or junction, which could leave the workspace. Next: use the real workspace-relative path shown by hub_list.',
  url_not_allowed: 'Refused: the Hub request policy does not allow this URL. Next: continue without it and report what was not fetched.',
  cwd_invalid: 'Refused: cwd must be an existing workspace-relative directory. Next: omit cwd to run at the workspace root.',
  path_unavailable: 'The path does not exist inside the workspace. Next: discover the actual relative path with hub_list or hub_search.',
  read_before_test_required: 'Refused: hub_test runs only against files you read with hub_read in this run. Next: read the files the test needs, then call hub_test again.',
  unknown_tool: 'Refused: this tool is not available in Hub. Next: use only the advertised hub_* tools.',
  approval_denied: 'The operator denied this action. Do not retry it, alter its explanation, or use another tool to bypass the decision. Report the uncompleted work.',
};

export function toolErrorMessage(message) {
  return Object.hasOwn(hints, message) ? `${message}\n${hints[message]}` : message;
}
