const MAX = (1n << 128n) - 1n;
const presign = new Set(['wallet_user_rejected', 'wallet_confirm_busy', 'wallet_confirm_unavailable', 'wallet_fee_unavailable', 'wallet_fee_expired', 'wallet_fee_stale']);
const errors = new Set(['refund_action_invalid', 'refund_action_busy', 'refund_action_pending', 'refund_action_unknown', 'refund_action_status_mismatch', 'refund_action_preparation_unavailable', 'refund_action_recovery_unavailable', ...presign]);
const fail = (code) => new Error(code);
const code = (cause) => typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : null;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const closed = (value, keys, exact = true) => object(value) && (!exact || Object.keys(value).length === keys.length) && Object.keys(value).every((key) => keys.includes(key));
const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[^A-Za-z0-9_-]/.test(value);
const hex = (value, bytes) => typeof value === 'string' && value.startsWith('0x') && value.length === bytes * 2 + 2 && !/[^\da-f]/i.test(value.slice(2));
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const uuid = (value) => typeof value === 'string' && value.length === 36 && /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/.test(value);
const chain = (value) => Number.isSafeInteger(value) && value > 0;
function atomic(value) {
  if (typeof value !== 'string' || !value.length || value.length > 39 || /[^0-9]/.test(value) || value.length > 1 && value.startsWith('0') || BigInt(value) > MAX) throw fail('refund_action_invalid');
  return BigInt(value);
}
function valueHex(value) {
  if (typeof value !== 'string' || value.length > 34 || !/^0x(?:0|[1-9a-f][\da-f]*)$/.test(value) || /[^\da-f]/.test(value.slice(2)) || BigInt(value) > MAX) throw fail('refund_action_invalid');
  return BigInt(value);
}
function identity(input, keys = ['orderId']) {
  if (!closed(input, keys, false) || !id(input.orderId)) throw fail('refund_action_invalid');
}
function operation(value) {
  if (!closed(value, ['phase', 'quoteId', 'chainId', 'transactionHash']) || !uuid(value.quoteId) || value.phase !== `refund:${value.quoteId}` || !chain(value.chainId) || !hex(value.transactionHash, 32)) throw fail('refund_action_status_mismatch');
  return Object.freeze({ ...value });
}
function pending(body, orderId) {
  if (!closed(body, ['orderId', 'operations']) || body.orderId !== orderId || !Array.isArray(body.operations) || body.operations.length > 1) throw fail('refund_action_status_mismatch');
  return body.operations.length ? operation(body.operations[0]) : null;
}
function refundable(body, orderId) {
  const order = body?.order;
  if (!object(order) || order.id !== orderId || body.physicalEscrow !== null || !['paid', 'partially_refunded'].includes(order.status) || !chain(order.chainId) || !['native', 'erc20'].includes(order.assetKind) || !hex(order.payoutWallet, 20) || !hex(order.buyerWallet, 20) || order.assetKind === 'erc20' && !hex(order.tokenContract, 20) || typeof order.currency !== 'string' || !order.currency.length || !Number.isSafeInteger(order.paymentTokenDecimals) || order.paymentTokenDecimals < 0 || order.paymentTokenDecimals > 255) throw fail('refund_action_invalid');
  for (const list of [body.refunds, body.refundAttempts]) {
    if (!Array.isArray(list) || list.length > 100 || Array.from(list).some((row) => !object(row) || !['submitted', 'confirmed', 'rejected'].includes(row.status))) throw fail('refund_action_invalid');
    if (list.some((row) => row.status === 'submitted')) throw fail('refund_action_pending');
  }
  return Object.freeze({ ...order });
}
const quoteKeys = ['id', 'orderId', 'expiresAt', 'remainingRefundAmountAtomic', 'assetKind', 'currency', 'paymentTokenDecimals', 'sellerAddress', 'grossRefundAmountAtomic', 'sellerRefundAmountAtomic', 'hubFeeRefundAmountAtomic', 'sellerTransfer', 'hubFeeRefundRequired', 'completionRule'];
function quote(body, order, wallet, time) {
  const q = body?.refundQuote;
  if (!closed(body, ['refundQuote']) || !closed(q, quoteKeys) || !uuid(q.id) || q.orderId !== order.id || q.assetKind !== order.assetKind || q.currency !== order.currency || q.paymentTokenDecimals !== order.paymentTokenDecimals || !hex(q.sellerAddress, 20) || !same(q.sellerAddress, order.payoutWallet) || !hex(wallet?.address, 20) || !same(wallet.address, order.payoutWallet) || typeof q.expiresAt !== 'string' || !Number.isFinite(Date.parse(q.expiresAt)) || new Date(q.expiresAt).toISOString() !== q.expiresAt || !Number.isFinite(time) || Date.parse(q.expiresAt) <= time) throw fail('refund_action_invalid');
  const gross = atomic(q.grossRefundAmountAtomic), seller = atomic(q.sellerRefundAmountAtomic), fee = atomic(q.hubFeeRefundAmountAtomic), remaining = atomic(q.remainingRefundAmountAtomic);
  if (!gross || !seller || gross > remaining || seller + fee !== gross || q.hubFeeRefundRequired !== (fee > 0n) || q.completionRule !== (fee > 0n ? 'seller_and_hub_transfers_confirmed' : 'seller_transfer_confirmed')) throw fail('refund_action_invalid');
  const call = q.sellerTransfer;
  if (!closed(call, ['chainId', 'to', 'value', 'data']) || call.chainId !== order.chainId || !hex(call.to, 20)) throw fail('refund_action_invalid');
  const value = valueHex(call.value);
  if (q.assetKind === 'native') {
    if (!same(call.to, order.buyerWallet) || value !== seller || call.data !== '0x') throw fail('refund_action_invalid');
  } else {
    if (!same(call.to, order.tokenContract) || value !== 0n || !hex(call.data, 68) || call.data.slice(2, 10).toLowerCase() !== 'a9059cbb' || call.data.slice(10, 34) !== '0'.repeat(24) || !same(`0x${call.data.slice(34, 74)}`, order.buyerWallet) || BigInt(`0x${call.data.slice(74)}`) !== seller) throw fail('refund_action_invalid');
  }
  return Object.freeze({ ...q, sellerTransfer: Object.freeze({ ...call }) });
}
function ack(body, orderId, op, reviewed) {
  const r = body?.refund;
  if (!closed(body, ['refund']) || !closed(r, ['id', 'orderId', 'transactionHash', 'amountAtomic', 'sellerRefundAmountAtomic', 'hubFeeRefundAmountAtomic', 'hubFeeRefundRequired', 'status', 'idempotent'], false) || !id(r.id) || r.orderId !== orderId || !hex(r.transactionHash, 32) || !same(r.transactionHash, op.transactionHash) || !['submitted', 'confirmed'].includes(r.status) || r.idempotent !== undefined && typeof r.idempotent !== 'boolean') throw fail('refund_action_status_mismatch');
  let gross, seller, fee;
  try { gross = atomic(r.amountAtomic); seller = atomic(r.sellerRefundAmountAtomic); fee = atomic(r.hubFeeRefundAmountAtomic); } catch { throw fail('refund_action_status_mismatch'); }
  if (!gross || !seller || gross !== seller + fee || r.hubFeeRefundRequired !== (fee > 0n) || reviewed && (r.amountAtomic !== reviewed.grossRefundAmountAtomic || r.sellerRefundAmountAtomic !== reviewed.sellerRefundAmountAtomic || r.hubFeeRefundAmountAtomic !== reviewed.hubFeeRefundAmountAtomic)) throw fail('refund_action_status_mismatch');
}
const fresh = () => ({ busy: false, pending: false, unknown: false, operation: null, quote: null });
export function createRefundActions(options) {
  if (!closed(options, ['invoke', 'now'], false) || typeof options.invoke !== 'function' || options.now !== undefined && typeof options.now !== 'function') throw fail('refund_action_invalid');
  const { invoke, now = Date.now } = options;
  const orders = new Map();
  const stateFor = (orderId) => { if (!orders.has(orderId)) orders.set(orderId, fresh()); return orders.get(orderId); };
  const finish = async (orderId, state, submitAllowed = true) => {
    const op = state.operation;
    const read = () => invoke('wallet_finish_refund', { orderId, phase: op.phase });
    let result;
    try { result = await read(); }
    catch (cause) {
      if (!submitAllowed || code(cause) !== 'wallet_refund_not_confirmed') throw fail('refund_action_recovery_unavailable');
      let body;
      try { body = await invoke('commerce_seller_refund_submit', { orderId, refundQuoteId: op.quoteId, transactionHash: op.transactionHash }); } catch { throw fail('refund_action_recovery_unavailable'); }
      ack(body, orderId, op, state.quote);
      try { result = await read(); } catch { throw fail('refund_action_recovery_unavailable'); }
    }
    if (!closed(result, ['orderId', 'phase', 'transactionHash', 'resolved', 'sellerTransferConfirmed']) || result.orderId !== orderId || result.phase !== op.phase || !hex(result.transactionHash, 32) || !same(result.transactionHash, op.transactionHash) || result.resolved !== true || result.sellerTransferConfirmed !== true) throw fail('refund_action_status_mismatch');
    state.pending = false; state.unknown = false;
    return Object.freeze({ ...result });
  };
  return {
    status(input) {
      identity(input);
      const state = orders.get(input.orderId) ?? fresh(), op = state.operation;
      return Object.freeze({ busy: state.busy, pending: state.pending, unknown: state.unknown, transactionHash: op?.transactionHash ?? null, phase: op?.phase ?? null, quoteId: op?.quoteId ?? null });
    },
    async execute(input) {
      identity(input, ['orderId', 'canConfirm']);
      const { orderId, canConfirm } = input;
      if (typeof canConfirm !== 'function') throw fail('refund_action_invalid');
      const confirm = () => {
        let permitted;
        try { permitted = canConfirm(); } catch { throw fail('refund_action_invalid'); }
        if (permitted && typeof permitted.then === 'function') Promise.resolve(permitted).catch(() => {});
        if (permitted !== true) throw fail('refund_action_invalid');
      };
      const state = stateFor(orderId);
      if (state.busy) throw fail('refund_action_busy');
      if (state.pending || state.unknown) throw fail('refund_action_pending');
      state.busy = true;
      let walletInvoked = false;
      try {
        confirm();
        state.operation = null; state.quote = null;
        let existing;
        try { existing = pending(await invoke('wallet_refund_begin', { orderId }), orderId); }
        catch (cause) { state.unknown = true; throw fail(code(cause) === 'refund_action_status_mismatch' ? code(cause) : 'refund_action_recovery_unavailable'); }
        if (existing) { state.operation = existing; state.pending = true; state.unknown = true; throw fail('refund_action_pending'); }
        confirm();
        const order = refundable(await invoke('commerce_seller_order_detail', { orderId }), orderId); confirm();
        const wallet = await invoke('wallet_status'); confirm();
        let body = await invoke('commerce_seller_refund_active_quote', { orderId }); confirm();
        if (!closed(body, ['refundQuote'])) throw fail('refund_action_invalid');
        if (body.refundQuote === null) { body = await invoke('commerce_seller_refund_quote', { orderId, amountAtomic: '' }); confirm(); }
        const reviewed = quote(body, order, wallet, now());
        const call = reviewed.sellerTransfer;
        const summary = `返金総額 ${reviewed.grossRefundAmountAtomic}・店舗送金 ${reviewed.sellerRefundAmountAtomic}（最小単位）・Hub手数料 ${reviewed.hubFeeRefundAmountAtomic} 照合待ち`;
        if (Array.from(summary).length > 200) throw fail('refund_action_invalid');
        confirm();
        const phase = `refund:${reviewed.id}`;
        state.quote = reviewed; state.pending = true; state.unknown = true; walletInvoked = true;
        let transactionHash;
        try { transactionHash = await invoke('wallet_send_contract', { chainId: call.chainId, to: call.to, valueWei: call.value, data: call.data, summary, recoveryOrderId: orderId, recoveryPhase: phase }); }
        catch (cause) {
          if (presign.has(code(cause))) { state.pending = false; state.unknown = false; state.quote = null; throw fail(code(cause)); }
          throw fail('refund_action_unknown');
        }
        if (!hex(transactionHash, 32)) throw fail('refund_action_unknown');
        state.operation = Object.freeze({ phase, quoteId: reviewed.id, chainId: call.chainId, transactionHash });
        return await finish(orderId, state);
      } catch (cause) {
        const error = code(cause);
        throw fail(errors.has(error) ? error : walletInvoked ? 'refund_action_unknown' : 'refund_action_preparation_unavailable');
      } finally { state.busy = false; }
    },
    async recover(input) {
      identity(input);
      const { orderId } = input, state = stateFor(orderId);
      if (state.busy) throw fail('refund_action_busy');
      const uncertain = state.pending || state.unknown, retained = uncertain ? state.operation : null;
      state.busy = true; state.unknown = true;
      try {
        let body;
        try { body = await invoke('wallet_refund_pending', { orderId }); } catch { throw fail('refund_action_recovery_unavailable'); }
        const current = pending(body, orderId);
        if (!current) {
          if (retained) return await finish(orderId, state, false);
          if (uncertain) throw fail('refund_action_unknown');
          state.unknown = false;
          return Object.freeze({ orderId, noPending: true });
        }
        if (retained && (current.phase !== retained.phase || current.chainId !== retained.chainId || !same(current.transactionHash, retained.transactionHash))) throw fail('refund_action_status_mismatch');
        if (uncertain && state.quote && (current.quoteId !== state.quote.id || current.chainId !== state.quote.sellerTransfer.chainId)) throw fail('refund_action_status_mismatch');
        if (!uncertain) state.quote = null;
        state.operation = current; state.pending = true;
        return await finish(orderId, state);
      } catch (cause) { throw fail(errors.has(code(cause)) ? code(cause) : 'refund_action_recovery_unavailable'); }
      finally { state.busy = false; }
    },
  };
}
