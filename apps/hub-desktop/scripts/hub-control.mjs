import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

/** Owns an explicitly launched Hub controller. Does not attach to another app. */
export class HubControl {
  constructor(app) {
    this.nextId = 0;
    this.pending = new Map();
    this.process = spawn(app, ['--control-stdio'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('controller_start_timeout')), 15_000);
      this.process.once('error', error => { clearTimeout(timeout); reject(error); });
      this.process.once('exit', () => { clearTimeout(timeout); reject(new Error('controller_exited')); });
      createInterface({ input: this.process.stdout }).on('line', line => {
        if (Buffer.byteLength(line) > 65_536) return;
        let reply;
        try { reply = JSON.parse(line); } catch { return; }
        if (reply.protocol === 1 && reply.ready === true) { clearTimeout(timeout); resolve(reply); }
        else if (reply.id === null && typeof reply.error === 'string') {
          for (const { reject, timeout } of this.pending.values()) { clearTimeout(timeout); reject(new Error(reply.error)); }
          this.pending.clear();
        }
        else if (this.pending.has(reply.id)) {
          const { resolve, reject, timeout } = this.pending.get(reply.id);
          this.pending.delete(reply.id); clearTimeout(timeout);
          if (reply.error) reject(new Error(reply.error)); else resolve(reply.result);
        }
      });
    });
    this.process.on('exit', () => {
      for (const { reject, timeout } of this.pending.values()) { clearTimeout(timeout); reject(new Error('controller_exited')); }
      this.pending.clear();
    });
    this.process.stdin.on('error', () => {});
  }
  async request(type, args = {}) {
    await this.ready;
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error('request_timeout')); }, 25_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.process.stdin.write(`${JSON.stringify({ id, action: { type, ...args } })}\n`, error => {
        if (error) { clearTimeout(timeout); this.pending.delete(id); reject(error); }
      });
    });
  }
  detach() { this.process.stdin.end(); this.process.stdout.destroy(); this.process.unref(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , flag, app] = process.argv;
  if (flag !== '--app' || !app || process.argv.length !== 4) {
    process.stderr.write('Usage: node hub-control.mjs --app <Hub executable>\nEnter one JSON action per line, e.g. {"type":"status"}.\n');
    process.exitCode = 2;
  } else {
    const hub = new HubControl(app);
    try {
      process.stdout.write(`${JSON.stringify(await hub.ready)}\n`);
      for await (const line of createInterface({ input: process.stdin })) {
        try {
          const action = JSON.parse(line);
          const { type, ...args } = action;
          process.stdout.write(`${JSON.stringify({ result: await hub.request(type, args) })}\n`);
          if (type === 'app_close') break;
        } catch (error) { process.stdout.write(`${JSON.stringify({ error: error.message })}\n`); }
      }
    } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
    finally { hub.detach(); }
  }
}
