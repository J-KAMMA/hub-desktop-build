const actions = {
  buyer: ['confirm', 'release', 'refund_unshipped', 'dispute', 'propose_resolution', 'accept_resolution', 'finalize_expired_dispute'],
  seller: ['ship', 'release', 'refund_by_seller', 'dispute', 'propose_resolution', 'accept_resolution', 'finalize_expired_dispute'],
};
const selectors = { confirm: '34539694', release: 'a42f2b0c', refund_unshipped: '9006b145', dispute: 'f08ef6cb', propose_resolution: '878d683d', accept_resolution: '2739489e', finalize_expired_dispute: '9d63a591', ship: '93ef8d21', refund_by_seller: '6c5be2a8' };
const presign = new Set(['wallet_user_rejected', 'wallet_confirm_busy', 'wallet_confirm_unavailable', 'wallet_fee_unavailable', 'wallet_fee_expired', 'wallet_fee_stale']);
const states = new Set(['funded', 'shipped', 'released', 'refunded', 'disputed']);
const fail = (code) => new Error(code);
const code = (cause) => typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : null;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const closed = (value, keys, exact = true) => object(value) && (!exact || Object.keys(value).length === keys.length) && Object.keys(value).every((key) => keys.includes(key));
const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[^A-Za-z0-9_-]/.test(value);
const role = (value) => value === 'buyer' || value === 'seller';
const action = (actor, value) => role(actor) && actions[actor].includes(value);
const hex = (value, bytes) => typeof value === 'string' && value.startsWith('0x') && value.length === bytes * 2 + 2 && !/[^\da-f]/i.test(value.slice(2));
const uuid = (value) => typeof value === 'string' && value.length === 36 && /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(value);
const MAX = (1n << 128n) - 1n;
function atomic(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 39 || /[^0-9]/.test(value) || value.length > 1 && value.startsWith('0') || BigInt(value) > MAX) throw fail('escrow_action_invalid');
  return BigInt(value);
}
function extraFor(name, extra) {
  const keys = name === 'propose_resolution' ? ['buyerAmountAtomic', 'sellerAmountAtomic'] : [];
  if (!closed(extra, keys)) throw fail('escrow_action_invalid');
  if (keys.length) {
    const sum = atomic(extra.buyerAmountAtomic) + atomic(extra.sellerAmountAtomic);
    if (sum === 0n || sum > MAX) throw fail('escrow_action_invalid');
  }
  return Object.freeze(keys.length ? { buyerAmountAtomic: extra.buyerAmountAtomic, sellerAmountAtomic: extra.sellerAmountAtomic } : {});
}
function identity(input, keys = ['orderId', 'role']) {
  if (!closed(input, keys, false) || !id(input.orderId) || !role(input.role)) throw fail('escrow_action_invalid');
}
function operation(value) {
  if (!closed(value, ['phase', 'role', 'action', 'chainId', 'transactionHash', 'extra']) || !action(value.role, value.action) || !Number.isSafeInteger(value.chainId) || value.chainId <= 0 || !hex(value.transactionHash, 32)) throw fail('escrow_action_status_mismatch');
  const parts = typeof value.phase === 'string' ? value.phase.split(':') : [];
  if (parts.length !== 4 || parts[0] !== 'escrow' || parts[1] !== value.role || parts[2] !== value.action || !uuid(parts[3])) throw fail('escrow_action_status_mismatch');
  let extra;
  try { extra = extraFor(value.action, value.extra); } catch { throw fail('escrow_action_status_mismatch'); }
  return Object.freeze({ ...value, extra });
}
function pending(body, orderId) {
  if (!closed(body, ['orderId', 'operations']) || body.orderId !== orderId || !Array.isArray(body.operations) || body.operations.length > 1) throw fail('escrow_action_status_mismatch');
  return body.operations.length ? operation(body.operations[0]) : null;
}
function prepared(body, expected, extra, actor) {
  const call = body?.action;
  if (!closed(body, ['action', 'proposal'], false) || !closed(call, ['action', 'chainId', 'to', 'data', 'value']) || call.action !== expected || !Number.isSafeInteger(call.chainId) || call.chainId <= 0 || !hex(call.to, 20) || !['0', '0x0'].includes(call.value) ||
      typeof call.data !== 'string' || !call.data.startsWith('0x') || call.data.length > 65538 || call.data.length % 2 || /[^\da-f]/i.test(call.data.slice(2))) throw fail('escrow_action_invalid');
  const count = expected === 'propose_resolution' ? 3 : expected === 'accept_resolution' ? 5 : 1;
  if (call.data.length !== 10 + count * 64 || call.data.slice(2, 10).toLowerCase() !== selectors[expected]) throw fail('escrow_action_invalid');
  const words = Array.from({ length: count }, (_, i) => call.data.slice(10 + i * 64, 74 + i * 64));
  if (count > 1) {
    if (BigInt(`0x${words[1]}`) > MAX || BigInt(`0x${words[2]}`) > MAX) throw fail('escrow_action_invalid');
    if (expected === 'propose_resolution' && (BigInt(`0x${words[1]}`).toString() !== extra.buyerAmountAtomic || BigInt(`0x${words[2]}`).toString() !== extra.sellerAmountAtomic)) throw fail('escrow_action_invalid');
    if (expected === 'accept_resolution' && BigInt(`0x${words[3]}`) > (1n << 64n) - 1n) throw fail('escrow_action_invalid');
  }
  if (body.proposal !== undefined) {
    const proposal = body.proposal;
    if (expected !== 'accept_resolution' || !closed(proposal, ['proposedBy', 'buyerAmountAtomic', 'sellerAmountAtomic']) || !role(proposal.proposedBy) || proposal.proposedBy === actor || atomic(proposal.buyerAmountAtomic).toString() !== BigInt(`0x${words[1]}`).toString() || atomic(proposal.sellerAmountAtomic).toString() !== BigInt(`0x${words[2]}`).toString()) throw fail('escrow_action_invalid');
  }
  return Object.freeze({ ...call, allocation: expected === 'accept_resolution' ? `購入者へ ${BigInt(`0x${words[1]}`)}・店舗へ ${BigInt(`0x${words[2]}`)}（最小単位）` : null });
}
const sameOperation = (a, b) => a.phase === b.phase && a.role === b.role && a.action === b.action && a.chainId === b.chainId && a.transactionHash.toLowerCase() === b.transactionHash.toLowerCase() && JSON.stringify(a.extra) === JSON.stringify(b.extra);
const copyHistory = (list) => Object.freeze(list.map((op) => Object.freeze({ ...op, extra: Object.freeze({ ...op.extra }) })));
function history(body, orderId) {
  if (!closed(body, ['orderId', 'verifiedReverted']) || body.orderId !== orderId || !Array.isArray(body.verifiedReverted) || body.verifiedReverted.length > 100) throw fail('escrow_action_status_mismatch');
  const records = Array.from(body.verifiedReverted, operation);
  if (new Set(records.map((op) => op.phase)).size !== records.length || new Set(records.map((op) => op.transactionHash.toLowerCase())).size !== records.length) throw fail('escrow_action_status_mismatch');
  return Object.freeze({ orderId, verifiedReverted: copyHistory(records) });
}
const fresh = () => ({ busy: false, pending: false, unknown: false, operation: null, verifiedReverted: Object.freeze([]) });

export function createEscrowActions(options) {
  if (!closed(options, ['invoke']) || typeof options.invoke !== 'function') throw fail('escrow_action_invalid');
  const { invoke } = options;
  const orders = new Map();
  const status = (input) => {
    identity(input);
    const state = orders.get(input.orderId) ?? fresh();
    return { pending: state.pending, unknown: state.unknown, transactionHash: state.operation?.transactionHash ?? null, action: state.operation?.action ?? null, busy: state.busy, verifiedReverted: copyHistory(state.verifiedReverted) };
  };
  const commerce = (orderId, actor, name, extra, transactionHash) => actor === 'buyer'
    ? invoke(transactionHash ? 'commerce_escrow_submit' : 'commerce_escrow_prepare', { orderId, accessToken: '', params: { action: name, ...extra, ...(transactionHash ? { transactionHash } : {}) } })
    : invoke('commerce_seller_escrow', { orderId, submit: !!transactionHash, params: { action: name, ...extra, ...(transactionHash ? { transactionHash } : {}) } });
  const finish = async (orderId, state, submitAllowed = true) => {
    const op = state.operation;
    const check = (result) => {
      if (!closed(result, ['orderId', 'phase', 'transactionHash', 'resolved']) || result.orderId !== orderId || result.phase !== op.phase || !hex(result.transactionHash, 32) || result.transactionHash.toLowerCase() !== op.transactionHash.toLowerCase() || result.resolved !== true) throw fail('escrow_action_status_mismatch');
      state.pending = false; state.unknown = false;
      return result;
    };
    const read = () => invoke('wallet_finish_escrow', { orderId, phase: op.phase, accessToken: '' });
    let result;
    try { result = await read(); }
    catch (cause) {
      if (!submitAllowed || code(cause) !== 'wallet_escrow_not_confirmed') throw cause;
      const ack = await commerce(orderId, op.role, op.action, op.extra, op.transactionHash);
      if (!closed(ack, ['escrow']) || !closed(ack.escrow, ['state', 'transactionHash']) || !states.has(ack.escrow.state) || !hex(ack.escrow.transactionHash, 32) || ack.escrow.transactionHash.toLowerCase() !== op.transactionHash.toLowerCase()) throw fail('escrow_action_status_mismatch');
      result = await read();
    }
    return check(result);
  };
  return {
    status,
    async execute(input) {
      identity(input, ['orderId', 'role', 'action', 'extra', 'summary', 'canConfirm']);
      const { orderId, role: actor, action: name, summary, canConfirm } = input;
      const extra = extraFor(name, input.extra === undefined ? {} : input.extra);
      if (!action(actor, name) || typeof summary !== 'string' || !summary.trim().length || Array.from(summary).length > 200 || canConfirm !== undefined && typeof canConfirm !== 'function') throw fail('escrow_action_invalid');
      try { encodeURIComponent(summary); } catch { throw fail('escrow_action_invalid'); }
      const confirm = () => {
        if (canConfirm === undefined) return;
        const permitted = canConfirm();
        if (permitted && typeof permitted.then === 'function') Promise.resolve(permitted).catch(() => {});
        if (permitted !== true) throw fail('escrow_action_invalid');
      };
      let state = orders.get(orderId);
      if (!state) { state = fresh(); orders.set(orderId, state); }
      if (state.busy) throw fail('escrow_action_busy');
      if (state.unknown || state.pending) throw fail('escrow_action_pending');
      state.busy = true;
      try {
        confirm();
        state.unknown = true;
        const existing = pending(await invoke('wallet_escrow_begin', { orderId }), orderId);
        if (existing) { state.operation = existing; state.pending = true; throw fail('escrow_action_pending'); }
        state.unknown = false; state.operation = null;
        confirm();
        const call = prepared(await commerce(orderId, actor, name, extra), name, extra, actor);
        const reviewedSummary = call.allocation ? `${summary}\n${call.allocation}` : summary;
        if (Array.from(reviewedSummary).length > 200) throw fail('escrow_action_invalid');
        confirm();
        const operationId = globalThis.crypto?.randomUUID?.();
        if (!uuid(operationId)) throw fail('escrow_action_invalid');
        const phase = `escrow:${actor}:${name}:${operationId}`;
        state.pending = true; state.unknown = true;
        let transactionHash;
        try { transactionHash = await invoke('wallet_send_contract', { chainId: call.chainId, to: call.to, valueWei: '0x0', data: call.data, summary: reviewedSummary, recoveryOrderId: orderId, recoveryPhase: phase }); }
        catch (cause) {
          if (presign.has(code(cause))) { state.pending = false; state.unknown = false; throw fail(code(cause)); }
          throw fail('escrow_action_unknown');
        }
        if (!hex(transactionHash, 32)) throw fail('escrow_action_unknown');
        state.operation = Object.freeze({ phase, role: actor, action: name, chainId: call.chainId, transactionHash, extra });
        return await finish(orderId, state);
      } finally { state.busy = false; }
    },
    async recoverFailure(input) {
      identity(input);
      const { orderId, role: actor } = input;
      let state = orders.get(orderId);
      if (!state) { state = fresh(); orders.set(orderId, state); }
      if (state.busy) throw fail('escrow_action_busy');
      const uncertain = state.pending || state.unknown;
      const retained = uncertain ? state.operation : null;
      state.busy = true; state.unknown = true;
      const read = async (command, args) => {
        try { return await invoke(command, args); }
        catch { throw fail('escrow_action_recovery_unavailable'); }
      };
      try {
        const current = pending(await read('wallet_escrow_pending', { orderId }), orderId);
        if (current && retained && !sameOperation(current, retained)) throw fail('escrow_action_status_mismatch');
        const original = current ?? retained;
        if (original) {
          state.operation = original; state.pending = true;
          if (original.role !== actor) throw fail('escrow_action_status_mismatch');
          const proof = await read('wallet_check_escrow_failure', { orderId, phase: original.phase, accessToken: '' });
          if (!closed(proof, ['orderId', 'phase', 'transactionHash', 'status']) || proof.orderId !== orderId || proof.phase !== original.phase || proof.status !== 'reverted' || !hex(proof.transactionHash, 32) || proof.transactionHash.toLowerCase() !== original.transactionHash.toLowerCase()) throw fail('escrow_action_status_mismatch');
        }
        const verified = history(await read('wallet_escrow_history', { orderId }), orderId);
        state.verifiedReverted = verified.verifiedReverted;
        if (original && !verified.verifiedReverted.some((op) => sameOperation(op, original))) throw fail('escrow_action_status_mismatch');
        if (!original && (uncertain || !verified.verifiedReverted.some((op) => op.role === actor))) throw fail('escrow_action_unknown');
        state.pending = false; state.unknown = false;
        return verified;
      } finally { state.busy = false; }
    },
    async recover(input) {
      identity(input);
      const { orderId, role: actor } = input;
      let state = orders.get(orderId);
      if (!state) { state = fresh(); orders.set(orderId, state); }
      if (state.busy) throw fail('escrow_action_busy');
      const retained = state.pending ? state.operation : null;
      state.busy = true; state.unknown = true;
      try {
        let body;
        try { body = await invoke('wallet_escrow_pending', { orderId }); }
        catch { throw fail('escrow_action_recovery_unavailable'); }
        const op = pending(body, orderId);
        if (!op) {
          if (!state.operation || state.operation.role !== actor) throw fail('escrow_action_unknown');
          return await finish(orderId, state, false);
        }
        if (retained && (retained.phase !== op.phase || retained.transactionHash.toLowerCase() !== op.transactionHash.toLowerCase() || retained.chainId !== op.chainId || JSON.stringify(retained.extra) !== JSON.stringify(op.extra))) throw fail('escrow_action_status_mismatch');
        state.operation = op; state.pending = true;
        if (op.role !== actor) throw fail('escrow_action_status_mismatch');
        return await finish(orderId, state);
      } finally { state.busy = false; }
    },
  };
}
