// Invalidate immediately, but never search a partially composed IME value.
export function bindSearchInput(input, { search, invalidate = () => {}, form, delay = 250 }) {
  let composing = false, timer;
  const cancel = () => { clearTimeout(timer); invalidate(); };
  const run = () => { clearTimeout(timer); if (!composing) void search(input.value); };
  input.addEventListener("compositionstart", () => { composing = true; cancel(); });
  input.addEventListener("compositionend", () => { composing = false; cancel(); timer = setTimeout(run, delay); });
  input.addEventListener("input", event => { cancel(); if (!composing && !event.isComposing) timer = setTimeout(run, delay); });
  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && (composing || event.isComposing || event.keyCode === 229)) event.preventDefault();
    else if (event.key === "Enter" && !form && !input.form) { event.preventDefault(); run(); }
  });
  if (form) form.onsubmit = event => { event.preventDefault(); run(); };
  return { composing: () => composing, cancel };
}
export function matchesSearch(query, ...fields) {
  const normalize = value => String(value ?? "").normalize("NFKC").toLocaleLowerCase();
  const haystack = normalize(fields.join(" "));
  return normalize(query).trim().split(/\s+/u).filter(Boolean).every(term => haystack.includes(term));
}
