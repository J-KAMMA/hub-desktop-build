// スマホから自分のPCのAI接続を使う（PC側）。
// 既存のペアリング（暗号化された接続情報の交換 + 両画面の確認番号）で張ったWebRTCデータチャネル "hub-ai-v1" で受け、
// 実行はRustの byok_remote_* だけが行う。許可・上限・CLIの制限はRust側で決まり、ここは運ぶだけ。
// 鍵・CLIのログイン情報・パス・環境はスマホにもHubにも送らない。依頼と返答は保存しない。
import { PeerTransfer } from './p2p-transfer.mjs';
import { settingHeader } from './settings-view.mjs';
import { initP2PTransfer } from './p2p-transfer-panel.mjs';
import { LABEL, FRAME_MAX, CHUNK_CHARS, RunAssembler, chunkText, frame, parseFrame, safeCode } from './remote-ai-protocol.mjs';

const BUFFER_HIGH = 262144;

export class RemoteAiHostPeer extends PeerTransfer {
  constructor(configuration, onChange, { invoke, listen, onActivity = () => {} } = {}) {
    super(configuration, onChange, { label: LABEL });
    this.invoke = invoke; this.listen = listen; this.onActivity = onActivity;
    this.assembler = null; this.run = null; this.live = false; this.outbox = Promise.resolve(); this.unlisten = null;
  }
  update(patch) {
    super.update(patch);
    if (this.closed) { void this.end(); return; }
    if (this.state.ready && !this.live) void this.begin();
  }
  async begin() {
    this.live = true;
    try {
      this.unlisten = await this.listen?.('byok-remote', (event) => this.forward(event.payload));
      await this.invoke('byok_remote_session', { active: true });
      if (this.closed) { await this.end(); return; }
    } catch { this.close('スマホ接続を開始できませんでした。'); return; }
    this.notify();
  }
  async end() {
    const had = this.live; this.live = false;
    try { this.unlisten?.(); } catch { /* ignore */ }
    this.unlisten = null; this.assembler = null; this.run = null;
    if (had) { try { await this.invoke('byok_remote_session', { active: false }); } catch { /* the session flag is also cleared by the app on exit */ } }
    this.onActivity({ session: false, runs: [] });
  }
  async notify() {
    try { const active = await this.invoke('byok_remote_active', {}); this.onActivity({ session: this.live, runs: Array.isArray(active?.runs) ? active.runs : [] }); }
    catch { this.onActivity({ session: this.live, runs: [] }); }
  }
  stopAll() { return this.invoke('byok_remote_stop_all', {}); }

  // ---- 送信（小さなフレームだけ。バッファが溜まれば待つ）
  send(message) {
    this.outbox = this.outbox.then(async () => {
      if (this.closed || this.channel?.readyState !== 'open') return;
      if (this.channel.bufferedAmount > BUFFER_HIGH) {
        await new Promise((resolve, reject) => {
          const done = () => { clearTimeout(timer); this.channel.removeEventListener('bufferedamountlow', done); resolve(); };
          const timer = setTimeout(() => { this.channel.removeEventListener('bufferedamountlow', done); reject(Error('slow')); }, 10000);
          this.channel.addEventListener('bufferedamountlow', done);
        });
      }
      this.channel.send(frame(message));
    }).catch(() => this.close('スマホへの送信が滞ったため、接続を終了しました。'));
    return this.outbox;
  }

  // ---- Rustからのイベント -> スマホ
  forward(payload) {
    const run = this.run;
    if (!run) return;
    if (run.requestId === null) { if (run.early.length < 200) run.early.push(payload); return; }
    if (payload?.requestId !== run.requestId) return;
    if (payload.type === 'delta' && typeof payload.text === 'string') {
      for (const text of chunkText(payload.text)) this.send({ type: 'ai.out', id: run.id, seq: run.seq++, text });
    } else if (payload.type === 'done') {
      this.send({ type: 'ai.end', id: run.id, cancelled: payload.cancelled === true });
      this.run = null; void this.notify();
    } else if (payload.type === 'error') {
      this.send({ type: 'ai.error', id: run.id, code: safeCode(payload.code) });
      this.run = null; void this.notify();
    }
  }

  // ---- スマホ -> PC
  async receive(data) {
    this.guard();
    if (typeof data !== 'string') throw Error('binary');
    if (data.length <= 4096 && data.includes('"verify"')) {
      let probe; try { probe = JSON.parse(data); } catch { probe = null; }
      if (probe?.type === 'verify') return super.receive(data);
    }
    if (!this.state.ready) throw Error('not ready');
    if (data.length > FRAME_MAX) throw Error('frame');
    await this.handle(parseFrame(data));
  }
  fail(id, code) { this.send({ type: 'ai.error', id: id ?? null, code: safeCode(code) }); }
  async handle(message) {
    switch (message.type) {
      case 'ai.list': {
        try {
          const result = await this.invoke('byok_remote_sources', {});
          const sources = Array.isArray(result?.sources) ? result.sources.slice(0, 20) : [];
          this.send({ type: 'ai.sources', total: sources.length });
          for (const source of sources) this.send({ type: 'ai.source', source });
        } catch (error) { this.fail(null, String(error?.message ?? error)); }
        return;
      }
      case 'ai.run': {
        if (this.run || this.assembler) { this.fail(message.id, 'byok_busy'); return; }
        try { this.assembler = new RunAssembler(message); } catch { this.fail(null, 'byok_invalid_request'); }
        return;
      }
      case 'ai.in': {
        if (!this.assembler) throw Error('in');
        try { this.assembler.push(message); }
        catch { const id = this.assembler.header.id; this.assembler = null; this.fail(id, 'byok_remote_too_large'); }
        return;
      }
      case 'ai.go': {
        const assembler = this.assembler;
        if (!assembler || assembler.header.id !== message.id) throw Error('go');
        this.assembler = null;
        let input;
        try { input = assembler.finish(); } catch { this.fail(message.id, 'byok_invalid_request'); return; }
        const run = { id: message.id, requestId: null, seq: 0, early: [] };
        this.run = run;
        try {
          run.requestId = await this.invoke('byok_remote_run', { input });
          void this.notify();
          const early = run.early; run.early = [];
          for (const payload of early) { if (payload?.requestId === run.requestId) this.forward(payload); }
        } catch (error) { this.run = null; this.fail(message.id, String(error?.message ?? error)); }
        return;
      }
      case 'ai.cancel': {
        if (this.assembler && this.assembler.header.id === message.id) { this.assembler = null; this.send({ type: 'ai.end', id: message.id, cancelled: true }); return; }
        if (this.run && this.run.id === message.id && this.run.requestId) await this.invoke('byok_remote_cancel', { requestId: this.run.requestId });
        return;
      }
      default: throw Error('unknown');
    }
  }
}

/** 画面の隅の小さな表示。スマホ接続中と、実行中の接続名、そして「停止」。 */
export function createRemoteAiIndicator({ document, onStop }) {
  const make = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const root = make('div', undefined, 'remote-ai-indicator'); root.hidden = true; root.setAttribute('role', 'status');
  const label = make('span'); const stop = make('button', '停止', 'deny'); stop.type = 'button';
  root.append(label, stop);
  stop.addEventListener('click', () => { stop.disabled = true; Promise.resolve(onStop?.()).finally(() => { stop.disabled = false; }); });
  return {
    element: root,
    update({ session, runs }) {
      root.hidden = !session;
      const names = (runs ?? []).map((r) => String(r.name ?? '').slice(0, 60)).filter(Boolean);
      label.textContent = names.length ? `スマホが「${names.join('・')}」でAIを実行中` : 'スマホとつながっています';
      stop.hidden = names.length === 0;
    },
  };
}

/** 設定の「スマホから使う」カード。接続はこの画面を開いて、確認番号を両方で照合したときだけ張られる。 */
export function createRemoteAiCard({ document, invoke, listen, isCurrent, peerOptions = {} }) {
  const make = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const card = make('div', undefined, 'card');
  card.append(
    settingHeader(document, { label: 'スマホから使う', desc: '上の接続のうち「スマホから使える」をオンにしたものだけを、スマホのHubから使えます。キー・ログイン情報・ファイルの場所は、スマホにもHubにも送りません。依頼と返答は端末どうしだけでやり取りし、保存しません。', keywords: 'スマホ 携帯 ペアリング 接続 コード QR リモート' }),
  );
  const host = make('div'); card.append(host);
  const indicator = createRemoteAiIndicator({ document, onStop: () => peers.at(-1)?.stopAll() });
  document.body?.append(indicator.element);
  const peers = [];
  const panel = initP2PTransfer(host, {
    invoke, isCurrent, purpose: 'ai', invitationPath: '/ai',
    peerFactory: (configuration, onChange) => {
      const peer = new RemoteAiHostPeer(configuration, onChange, { invoke, listen, onActivity: (state) => indicator.update(state), ...peerOptions });
      peers.push(peer);
      return peer;
    },
  });
  return { element: card, panel, indicator, peers, dispose() { panel.dispose(); indicator.element.remove(); } };
}
