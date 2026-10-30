const accepted = new Set(['submitted', 'paid', 'partially_refunded', 'refunded', 'payment_failed']);
const presignErrors = new Set(['wallet_user_rejected', 'wallet_confirm_busy', 'wallet_confirm_unavailable', 'wallet_fee_unavailable', 'wallet_fee_expired', 'wallet_fee_stale']);
const error = (code) => new Error(code);
const text = (value) => typeof value === 'string' && value.length > 0;
const id = (value) => text(value) && value.length <= 200 && !/[^A-Za-z0-9_-]/.test(value);
const hex = (value, bytes) => typeof value === 'string' && value.startsWith('0x') && value.length === bytes * 2 + 2 && !/[^\da-f]/i.test(value.slice(2));
const hash = (value) => hex(value, 32);
const address = (value) => hex(value, 20);
const data = (value) => typeof value === 'string' && value.length <= 65538 && value.startsWith('0x') && value.length % 2 === 0 && !/[^\da-f]/i.test(value.slice(2));

export function shopAtomicHex(value) {
  if (typeof value !== 'string' || value.length > 39 || !/^(0|[1-9]\d*)$/.test(value) || /\s/.test(value)) throw error('shop_payment_invalid');
  const atomic = BigInt(value);
  if (atomic > (1n << 128n) - 1n) throw error('shop_payment_invalid');
  return `0x${atomic.toString(16)}`;
}

function reviewed(line) {
  const { product, quantity, order } = line ?? {};
  if (!product || !order || !id(product.id) || !id(order.id) || !text(product.title) ||
      order.productId !== product.id || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 20 || order.quantity !== quantity ||
      !text(order.accessToken) || !text(order.currency) || !Number.isSafeInteger(order.chainId) || order.chainId <= 0 ||
      order.status !== 'awaiting_payment' || order.transactionHash != null || !text(order.expiresAt) || !Number.isFinite(Date.parse(order.expiresAt))) throw error('shop_payment_invalid');
  if (order.gasPayer === 'merchant' || !order.escrow) throw error('shop_payment_unsupported');
  if (order.gasPayer !== 'buyer') throw error('shop_payment_invalid');
  const escrow = order.escrow;
  if (!address(escrow.contractAddress) || escrow.state !== 'awaiting_lock' || !data(order.transferData)) throw error('shop_payment_invalid');
  const amount = shopAtomicHex(order.amountAtomic);
  const valueWei = shopAtomicHex(order.valueAtomic);
  if (amount === '0x0') throw error('shop_payment_invalid');
  let approval = null;
  if (order.assetKind === 'native') {
    if (order.tokenContract != null || escrow.approval != null || order.valueAtomic !== order.amountAtomic) throw error('shop_payment_invalid');
  } else if (order.assetKind === 'erc20') {
    if (order.valueAtomic !== '0' || !address(order.tokenContract) || !escrow.approval ||
        !address(escrow.approval.tokenContract) || escrow.approval.tokenContract.toLowerCase() !== order.tokenContract.toLowerCase() ||
        !data(escrow.approval.data)) throw error('shop_payment_invalid');
    approval = { tokenContract: escrow.approval.tokenContract, data: escrow.approval.data };
  } else throw error('shop_payment_unsupported');
  return { id: order.id, productId: product.id, title: product.title, quantity, accessToken: order.accessToken,
    currency: order.currency, chainId: order.chainId, assetKind: order.assetKind, tokenContract: order.tokenContract ?? null,
    amountAtomic: order.amountAtomic, valueWei, transferData: order.transferData, contractAddress: escrow.contractAddress,
    approval, expiresAt: order.expiresAt };
}

function approvalArgs(snapshot) {
  if (snapshot.assetKind !== 'erc20') throw error('shop_payment_unsupported');
  const expected = `0x095ea7b3${snapshot.contractAddress.slice(2).toLowerCase().padStart(64, '0')}${BigInt(snapshot.amountAtomic).toString(16).padStart(64, '0')}`;
  if (snapshot.approval.data.toLowerCase() !== expected) throw error('shop_payment_invalid');
  return { orderId: snapshot.id, chainId: snapshot.chainId, tokenContract: snapshot.approval.tokenContract,
    spender: snapshot.contractAddress, amountAtomic: snapshot.amountAtomic, approvalData: snapshot.approval.data };
}

const fresh = (snapshot = null) => ({ snapshot, chainId: snapshot?.chainId ?? null, busy: false, attempted: false, unknown: false, transactionHash: null, approvalHash: null, restoredApproval: false, notified: false });

export function createShopPayment({ invoke, onSent } = {}) {
  if (typeof invoke !== 'function' || (onSent != null && typeof onSent !== 'function')) throw error('shop_payment_invalid');
  const states = new Map();
  const status = (line) => {
    const state = states.get(line?.order?.id) ?? fresh();
    return { busy: state.busy, attempted: state.attempted, unknown: state.unknown, transactionHash: state.transactionHash, approvalHash: state.approvalHash };
  };
  const discardable = (line) => Object.values(status(line)).every((value) => !value);
  const notify = async (line, state) => {
    line.transactionHash = state.transactionHash;
    if (!state.notified) {
      await onSent?.(line, state.transactionHash);
      state.notified = true;
    }
  };
  const binding = (body, orderId, transactionHash) => {
    const order = body?.order;
    if (!order || order.id !== orderId || !hash(order.transactionHash) || order.transactionHash.toLowerCase() !== transactionHash.toLowerCase() || !accepted.has(order.status)) throw error('shop_payment_status_mismatch');
    return { transactionHash, order };
  };
  const submit = async (state, orderId, accessToken) => binding(await invoke('commerce_order_submit', { orderId, accessToken, transactionHash: state.transactionHash }), orderId, state.transactionHash);
  const recoverKnown = async (state, orderId, accessToken, line) => {
    let body;
    try { body = await invoke('commerce_order_status', { orderId, accessToken }); }
    catch { throw error('shop_payment_recovery_unavailable'); }
    const order = body?.order;
    if (!order || order.id !== orderId) throw error('shop_payment_status_mismatch');
    if (order.transactionHash !== null) {
      const result = binding(body, orderId, state.transactionHash);
      if (line) await notify(line, state);
      return result;
    }
    if (!['awaiting_payment', 'expired'].includes(order.status)) throw error('shop_payment_status_mismatch');
    if (line) await notify(line, state);
    return submit(state, orderId, accessToken);
  };
  const wallet = async (state, args) => {
    state.attempted = true;
    try {
      const result = await invoke('wallet_send_contract', args);
      if (!hash(result)) throw error('shop_payment_unknown');
      return result;
    } catch (cause) {
      const code = typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : null;
      if (presignErrors.has(code)) throw error(code);
      state.unknown = true;
      throw error('shop_payment_unknown');
    }
  };
  const live = (snapshot) => { if (Date.parse(snapshot.expiresAt) <= Date.now()) throw error('shop_payment_expired'); };
  const checkApproval = async (state, snapshot) => {
    try {
      const args = approvalArgs(snapshot);
      let proof;
      try { proof = await invoke('wallet_check_approval', args); }
      catch { throw error('shop_payment_recovery_unavailable'); }
      if (!proof || Object.keys(proof).length !== 4 || Object.keys(proof).some((key) => !['orderId', 'chainId', 'approvalHash', 'status'].includes(key)) ||
          proof.orderId !== snapshot.id || proof.chainId !== snapshot.chainId || !['missing', 'pending', 'failed', 'insufficient', 'ready'].includes(proof.status) ||
          (proof.status === 'missing' ? proof.approvalHash !== null : !hash(proof.approvalHash)) ||
          state.approvalHash && proof.approvalHash !== null && proof.approvalHash.toLowerCase() !== state.approvalHash.toLowerCase()) throw error('shop_payment_status_mismatch');
      if (proof.status !== 'ready') throw error('shop_payment_unknown');
      return proof.approvalHash;
    } catch (cause) { state.unknown = true; throw cause; }
  };
  return {
    status, discardable,
    async pay(line) {
      const snapshot = reviewed(line);
      let state = states.get(snapshot.id);
      if (state && JSON.stringify(state.snapshot) !== JSON.stringify(snapshot)) throw error('shop_payment_invalid');
      if (!state) { state = fresh(snapshot); states.set(snapshot.id, state); }
      if (state.busy) throw error('shop_payment_busy');
      if (state.unknown) throw error('shop_payment_unknown');
      state.busy = true;
      try {
        if (state.transactionHash) return await recoverKnown(state, snapshot.id, snapshot.accessToken, line);
        live(snapshot);
        if (snapshot.approval && !state.approvalHash) {
          state.approvalHash = await wallet(state, { chainId: snapshot.chainId, to: snapshot.approval.tokenContract, valueWei: '0x0', data: snapshot.approval.data, summary: `${snapshot.title}の支払い承認（approve）`, recoveryOrderId: snapshot.id, recoveryPhase: 'approval' });
          line.approvalHash = state.approvalHash;
        }
        live(snapshot);
        if (state.restoredApproval) { await checkApproval(state, snapshot); live(snapshot); }
        state.transactionHash = await wallet(state, { chainId: snapshot.chainId, to: snapshot.contractAddress, valueWei: snapshot.valueWei, data: snapshot.transferData, summary: `${snapshot.title} × ${snapshot.quantity} の代金を受取確認までロック`, recoveryOrderId: snapshot.id, recoveryPhase: 'payment' });
        await notify(line, state);
        return await submit(state, snapshot.id, snapshot.accessToken);
      } finally { state.busy = false; }
    },
    async recoverApproval(line) {
      const snapshot = reviewed(line);
      approvalArgs(snapshot);
      let state = states.get(snapshot.id);
      if (state?.busy) throw error('shop_payment_busy');
      if (state?.snapshot && JSON.stringify(state.snapshot) !== JSON.stringify(snapshot) || state?.chainId != null && state.chainId !== snapshot.chainId || state?.transactionHash) throw error('shop_payment_status_mismatch');
      if (!state) { state = fresh(snapshot); states.set(snapshot.id, state); }
      state.snapshot = snapshot;
      state.chainId = snapshot.chainId;
      state.busy = true;
      state.attempted = true;
      try {
        const approvalHash = await checkApproval(state, snapshot);
        state.approvalHash = approvalHash;
        state.restoredApproval = true;
        state.unknown = false;
        line.approvalHash = approvalHash;
        return { approvalHash };
      } finally { state.busy = false; }
    },
    async recoverUnknown(input) {
      const { orderId, chainId, onRecovered } = input ?? {};
      if (!id(orderId) || !Number.isSafeInteger(chainId) || chainId <= 0 || onRecovered !== undefined && typeof onRecovered !== 'function') throw error('shop_payment_invalid');
      let state = states.get(orderId);
      if (state?.busy) throw error('shop_payment_busy');
      if (state?.chainId != null && state.chainId !== chainId) throw error('shop_payment_status_mismatch');
      if (!state) { state = fresh(); states.set(orderId, state); }
      state.chainId = chainId;
      state.busy = true;
      state.attempted = true;
      try {
        if (!state.transactionHash) {
          state.unknown = true;
          let record;
          try { record = await invoke('wallet_recover_contract', { orderId, phase: 'payment' }); }
          catch { throw error('shop_payment_recovery_unavailable'); }
          if (!record || Object.keys(record).length !== 4 || Object.keys(record).some((key) => !['orderId', 'phase', 'chainId', 'transactionHash'].includes(key)) ||
              record.orderId !== orderId || record.phase !== 'payment') throw error('shop_payment_status_mismatch');
          if (record.chainId === null && record.transactionHash === null) throw error('shop_payment_unknown');
          if (record.chainId !== chainId || !hash(record.transactionHash)) throw error('shop_payment_status_mismatch');
          state.transactionHash = record.transactionHash;
          state.unknown = false;
        }
        await onRecovered?.(state.transactionHash);
        return await recoverKnown(state, orderId, state.snapshot?.accessToken ?? '');
      } finally { state.busy = false; }
    },
    async recover(input) {
      const { orderId, transactionHash } = input ?? {};
      if (!id(orderId) || !hash(transactionHash)) throw error('shop_payment_invalid');
      let state = states.get(orderId);
      if (state?.busy) throw error('shop_payment_busy');
      if (state?.transactionHash && state.transactionHash.toLowerCase() !== transactionHash.toLowerCase() || state?.unknown) throw error('shop_payment_status_mismatch');
      if (!state) { state = fresh(); states.set(orderId, state); }
      state.transactionHash = transactionHash;
      state.attempted = true;
      state.busy = true;
      try { return await recoverKnown(state, orderId, state.snapshot?.accessToken ?? ''); }
      finally { state.busy = false; }
    },
  };
}
