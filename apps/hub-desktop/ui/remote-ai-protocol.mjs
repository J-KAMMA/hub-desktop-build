// スマホ -> 自分のPCのAI。ペアリング済みのWebRTCデータチャネル "hub-ai-v1" だけで運ぶ、小さなJSONフレームの約束事。
// Hubサーバーは本文を受け取らない（シグナリングは暗号化された接続情報のみ）。鍵・CLIのログイン情報・パス・環境は一切載せない。
// このファイルは apps/hub/lib/remote-ai-protocol.mjs と同一内容に保つ（remote-ai-protocol.test で照合）。
export const LABEL = 'hub-ai-v1';
export const FRAME_MAX = 12000;      // 受信フレームの文字数上限（JSON文字列）
export const CHUNK_CHARS = 1500;     // 1フレームに入れる本文の最大文字数（制御文字が6倍に膨らんでも収まる）
export const LIMITS = Object.freeze({ messages: 20, messageChars: 8000, totalChars: 30000, outputChars: 100000, models: 30, sources: 20 });
const UUID = /^[-a-f0-9]{36}$/;
const SOURCE_ID = /^[-a-zA-Z0-9]{1,40}$/;
const CODE = /^byok_[a-z_]{1,40}$/;
const printable = (text, max) => typeof text === 'string' && text.length > 0 && [...text].length <= max && !/[\u0000-\u001f\u007f]/.test(text);

/** 絵文字などのサロゲートペアを割らずに分ける。 */
export function chunkText(text, size = CHUNK_CHARS) {
  const out = []; let current = '', count = 0;
  for (const character of String(text)) {
    current += character; count++;
    if (count >= size) { out.push(current); current = ''; count = 0; }
  }
  if (current) out.push(current);
  return out;
}

export function parseFrame(data) {
  if (typeof data !== 'string' || data.length > FRAME_MAX) throw Error('frame');
  const message = JSON.parse(data);
  if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string' || !message.type.startsWith('ai.')) throw Error('frame');
  return message;
}
export const frame = (message) => {
  const text = JSON.stringify(message);
  if (text.length > FRAME_MAX) throw Error('frame too large');
  return text;
};
export const safeCode = (code) => (typeof code === 'string' && CODE.test(code) ? code : 'byok_failed');

export function readSource(value) {
  if (!value || typeof value !== 'object') throw Error('source');
  const { source, id, name, models, defaultModel } = value;
  if (!['api', 'cli'].includes(source) || typeof id !== 'string' || !SOURCE_ID.test(id) && !UUID.test(id)) throw Error('source');
  if (!printable(name, 60) || !Array.isArray(models) || models.length > LIMITS.models || !models.every((m) => printable(m, 80))) throw Error('source');
  if (defaultModel !== null && defaultModel !== undefined && !printable(defaultModel, 80)) throw Error('source');
  return { source, id, name, models: [...models], defaultModel: defaultModel ?? null };
}

export function readRunHeader(message) {
  const { id, source, sourceId, model, messages } = message;
  if (!UUID.test(id) || !['api', 'cli'].includes(source) || typeof sourceId !== 'string' || !(SOURCE_ID.test(sourceId) || UUID.test(sourceId))) throw Error('run');
  if (model !== null && model !== undefined && !printable(model, 80)) throw Error('run');
  if (!Number.isSafeInteger(messages) || messages < 1 || messages > LIMITS.messages) throw Error('run');
  return { id, source, sourceId, model: model ?? null, messages };
}

/** PC側: ai.run -> ai.in ... -> ai.go を、上限を守りながら組み立てる。 */
export class RunAssembler {
  constructor(header) { this.header = readRunHeader(header); this.items = []; this.open = null; this.total = 0; }
  push(message) {
    const { id, m, role, text, end } = message;
    if (id !== this.header.id || this.items.length > this.header.messages) throw Error('in');
    if (!['user', 'assistant'].includes(role) || typeof text !== 'string' || [...text].length > CHUNK_CHARS || typeof end !== 'boolean') throw Error('in');
    if (!this.open) {
      if (m !== this.items.length || this.items.length >= this.header.messages) throw Error('in');
      this.open = { role, text: '' }; this.items.push(this.open);
    } else if (m !== this.items.length - 1 || role !== this.open.role) throw Error('in');
    this.open.text += text; this.total += [...text].length;
    if ([...this.open.text].length > LIMITS.messageChars || this.total > LIMITS.totalChars) throw Error('too large');
    if (end) this.open = null;
  }
  finish() {
    if (this.open || this.items.length !== this.header.messages || this.items.at(-1)?.role !== 'user' || this.items.some((i) => !i.text.trim())) throw Error('go');
    return { source: this.header.source, id: this.header.sourceId, model: this.header.model, messages: this.items.map(({ role, text }) => ({ role, content: text })) };
  }
}

/** スマホ側: 会話を送信フレームに分ける。 */
export function runFrames(id, { source, sourceId, model = null }, messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > LIMITS.messages) throw Error('メッセージの数が上限を超えています。');
  let total = 0;
  const frames = [{ type: 'ai.run', id, source, sourceId, model, messages: messages.length }];
  messages.forEach((message, index) => {
    const length = [...message.content].length;
    total += length;
    if (length > LIMITS.messageChars || total > LIMITS.totalChars || !message.content.trim()) throw Error('依頼が長すぎます。短くしてください。');
    const parts = chunkText(message.content);
    parts.forEach((text, part) => frames.push({ type: 'ai.in', id, m: index, role: message.role, text, end: part === parts.length - 1 }));
  });
  frames.push({ type: 'ai.go', id });
  return frames.map(frame);
}
