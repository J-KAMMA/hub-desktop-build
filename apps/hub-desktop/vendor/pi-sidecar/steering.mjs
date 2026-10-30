const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KEYS = new Set(['type', 'requestId', 'text']);
const validId = value => typeof value === 'string' && value.length === 36 && UUID.test(value);
const validText = value => typeof value === 'string' && value.length <= 8000 && !!value.trim() && !/\0|\p{Surrogate}/u.test(value);
const ack = (requestId, accepted, code) => ({ type: 'steer_ack', requestId, accepted, ...(accepted ? {} : { code }) });

/** Private, bounded per-process state. ACK is SDK queue acceptance, never delivery or persistence. */
export function createSteeringController({ getSession, enabled = () => true, stopped = () => false }) {
  const requests = new Map(), acceptedTexts = []; let units = 0, closed = false;
  async function execute(requestId, text) {
    const rejected = code => ack(requestId, false, code);
    let accepted = false;
    try {
      if (!enabled()) return rejected('steer_unsupported');
      if (closed || stopped()) return rejected('steer_stopped');
      const session = getSession();
      if (!session || typeof session.prompt !== 'function') return rejected('steer_not_ready');
      if (session.isStreaming !== true) return rejected('steer_not_streaming');
      // The held factory disables extensions. Do not permit an input interceptor to transform/handle literal text.
      if (session.extensionRunner?.hasHandlers('input')) return rejected('steer_unsupported');
      await session.prompt(text, { streamingBehavior: 'steer', expandPromptTemplates: false,
        preflightResult(value) { if ((value === true || value === 'queued') && !accepted) { accepted = true; acceptedTexts.push(text); } } });
      return accepted ? ack(requestId, true) : rejected('steer_failed');
    } catch { return accepted ? ack(requestId, true) : rejected('steer_failed'); }
  }
  return {
    handle(frame) {
      // No valid routing ID means no ACK; never echo malformed input or caller text.
      if (!frame || typeof frame !== 'object' || !validId(frame.requestId)) return Promise.resolve(null);
      const id = frame.requestId;
      if (Array.isArray(frame) || frame.type !== 'steer' || Reflect.ownKeys(frame).length !== 3 || Reflect.ownKeys(frame).some(key => !KEYS.has(key))) return Promise.resolve(ack(id, false, 'steer_invalid_request'));
      const previous = requests.get(id);
      if (previous) return frame.text === previous.text ? previous.result : Promise.resolve(ack(id, false, 'steer_id_conflict'));
      if (!validText(frame.text)) return Promise.resolve(ack(id, false, 'steer_invalid_request'));
      if (requests.size === 16 || units + frame.text.length > 32768) return Promise.resolve(ack(id, false, 'steer_limit'));
      units += frame.text.length;
      const result = Promise.resolve().then(() => execute(id, frame.text));
      requests.set(id, { text: frame.text, result });
      return result;
    },
    currentGoal(initial) {
      return acceptedTexts.length ? `Initial request (verbatim):\n${initial}\n\nAdditional user instructions (chronological, latest overrides conflicting earlier requests; permissions are unchanged):\n${acceptedTexts.map((text, index) => `${index + 1}. User instruction (verbatim):\n${text}`).join('\n\n')}` : initial;
    },
    close() { closed = true; },
  };
}

/** Keep AI-owned checkpoint/model output transport intact; strip raw user content from diagnostic events. */
export function steeringEventMetadata(event) {
  if (event.type === 'queue_update') return { type: 'queue_update', steeringCount: event.steering?.length ?? 0, followUpCount: event.followUp?.length ?? 0 };
  const metadata = message => message?.role === 'user' ? { role: 'user', ...(typeof message.timestamp === 'number' ? { timestamp: message.timestamp } : {}) } : message;
  return { ...event, ...(event.message ? { message: metadata(event.message) } : {}),
    ...(Array.isArray(event.messages) ? { messages: event.messages.map(metadata) } : {}) };
}
