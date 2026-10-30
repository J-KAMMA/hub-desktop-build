import { createHash } from "node:crypto";

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  : value;
const digest = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const actionKey = (name, args) => {
  const { summary: _summary, ...action } = args ?? {};
  return digest([name, action]);
};
const mutations = new Set(["hub_write", "hub_edit", "hub_exec", "hub_test", "hub_http", "hub_pay"]);

// Per-run progress only. Retain hashes, never file contents, and never carry
// denial decisions or observations into a resumed run. Successful mutations
// break a cycle; changed read/error results are also a different observation.
export class RunProgress {
  reason = null;
  history = [];
  denied = new Set();
  names = [];
  advised = new Set();
  advisory = null;

  before(name, args) {
    if (this.denied.has(actionKey(name, args))) this.reason ??= "denied_action_repeated";
    return this.reason;
  }

  after(name, args, ok, result) {
    const key = actionKey(name, args);
    if (!ok && result === "approval_denied") {
      this.denied.add(key);
      if (this.denied.size >= 256) this.reason ??= "too_many_denied_actions";
    }
    if (ok && mutations.has(name)) {
      this.history = [];
      this.names = [];
      return;
    }
    this.history.push(digest([key, ok, result]));
    this.history = this.history.slice(-9);
    this.names = [...this.names, name].slice(-9);
    for (const width of [1, 2, 3]) {
      if (this.history.length < width * 3) continue;
      const tail = this.history.slice(-width * 3);
      if (tail.every((entry, index) => entry === tail[index % width])) {
        this.reason ??= "repeated_tool_cycle";
        break;
      }
    }
    if (!this.reason) this.#advise();
  }

  // One step before the hard stop: a 1-3 call cycle has now repeated twice.
  // Advise once per distinct cycle; the hard stop above is unchanged.
  #advise() {
    for (const width of [1, 2, 3]) {
      if (this.history.length < width * 2) continue;
      const tail = this.history.slice(-width * 2);
      if (!tail.every((entry, index) => entry === tail[index % width])) continue;
      const cycle = digest([...new Set(tail)].sort()); // order-free: a phase-shifted cycle is the same cycle
      if (!this.advised.has(cycle) && this.advised.size < 256) {
        this.advised.add(cycle);
        this.advisory = { tools: [...new Set(this.names.slice(-width))] };
      }
      return;
    }
  }

  // Returns the pending advisory once, then clears it.
  takeAdvisory() {
    const advisory = this.advisory;
    this.advisory = null;
    return advisory;
  }
}
