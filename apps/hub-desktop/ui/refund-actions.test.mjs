import test from 'node:test';
import assert from 'node:assert/strict';
import { createRefundActions } from './refund-actions.mjs';

const orderId = 'order-1', quoteId = '12345678-1234-4234-8234-123456789abc';
const seller = `0x${'11'.repeat(20)}`, buyer = `0x${'22'.repeat(20)}`, token = `0x${'33'.repeat(20)}`, hash = `0x${'ab'.repeat(32)}`;
const phase = `refund:${quoteId}`, time = Date.parse('2026-10-04T00:00:00.000Z');
const op = () => ({ phase, quoteId, chainId: 137, transactionHash: hash });
const proof = () => ({ orderId, phase, transactionHash: hash, resolved: true, sellerTransferConfirmed: true });
const detail = () => ({ order: { id: orderId, status: 'paid', chainId: 137, assetKind: 'native', payoutWallet: seller, buyerWallet: buyer, tokenContract: null, currency: 'POL', paymentTokenDecimals: 18 }, physicalEscrow: null, refunds: [], refundAttempts: [] });
const quote = () => ({ refundQuote: { id: quoteId, orderId, expiresAt: '2026-10-04T00:10:00.000Z', remainingRefundAmountAtomic: '100', assetKind: 'native', currency: 'POL', paymentTokenDecimals: 18, sellerAddress: seller, grossRefundAmountAtomic: '100', sellerRefundAmountAtomic: '95', hubFeeRefundAmountAtomic: '5', sellerTransfer: { chainId: 137, to: buyer, value: '0x5f', data: '0x' }, hubFeeRefundRequired: true, completionRule: 'seller_and_hub_transfers_confirmed' } });
const ack = () => ({ refund: { id: 'refund-1', orderId, transactionHash: hash, amountAtomic: '100', sellerRefundAmountAtomic: '95', hubFeeRefundAmountAtomic: '5', hubFeeRefundRequired: true, status: 'submitted' } });
const request = () => ({ orderId, canConfirm: () => true });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(overrides = {}) {
  const calls = [];
  const defaults = { wallet_refund_begin: () => ({ orderId, operations: [] }), wallet_refund_pending: () => ({ orderId, operations: [op()] }), commerce_seller_order_detail: detail, wallet_status: () => ({ address: seller, chainId: 1 }), commerce_seller_refund_active_quote: quote, commerce_seller_refund_quote: quote, wallet_send_contract: () => hash, wallet_finish_refund: proof, commerce_seller_refund_submit: ack };
  const invoke = async (name, args) => { calls.push({ name, args }); return await (overrides[name] ?? defaults[name])(args); };
  return { helper: createRefundActions({ invoke, now: () => time }), calls, invoke };
}
const names = (f) => f.calls.map((c) => c.name);
const sent = (f) => f.calls.filter((c) => c.name === 'wallet_send_contract');

test('native value unchanged, begin first, fee summary and exact durable result', async () => {
  const f = fixture();
  assert.deepEqual(await f.helper.execute(request()), proof());
  assert.equal(names(f)[0], 'wallet_refund_begin');
  assert.equal(names(f).includes('commerce_seller_refund_quote'), false);
  assert.equal(sent(f)[0].args.valueWei, '0x5f');
  assert.equal(sent(f)[0].args.recoveryPhase, phase);
  assert.equal(sent(f)[0].args.recoveryOrderId, orderId);
  assert.match(sent(f)[0].args.summary, /100.*95.*5.*照合待ち/);
  assert.deepEqual(f.helper.status({ orderId }), { busy: false, pending: false, unknown: false, transactionHash: hash, phase, quoteId });
  assert.ok(Object.isFrozen(f.helper.status({ orderId })));
});
test('POST only exact null, active quote reused after lost POST response', async () => {
  let active = null;
  const f = fixture({ commerce_seller_refund_active_quote: () => ({ refundQuote: active }), commerce_seller_refund_quote: () => { active = quote().refundQuote; throw new Error('private detail'); } });
  await assert.rejects(f.helper.execute(request()), /refund_action_preparation_unavailable/);
  assert.equal(sent(f).length, 0); assert.equal(f.helper.status({ orderId }).unknown, false);
  await f.helper.execute(request());
  assert.equal(names(f).filter((n) => n === 'commerce_seller_refund_quote').length, 1);
});
test('ERC20 ABI recipient and amount accepted with zero value', async () => {
  const d = detail(), q = quote(); d.order.assetKind = q.refundQuote.assetKind = 'erc20'; d.order.tokenContract = token;
  q.refundQuote.sellerTransfer = { chainId: 137, to: token, value: '0x0', data: `0xa9059cbb${buyer.slice(2).padStart(64, '0')}${95n.toString(16).padStart(64, '0')}` };
  const f = fixture({ commerce_seller_order_detail: () => d, commerce_seller_refund_active_quote: () => q });
  await f.helper.execute(request()); assert.equal(sent(f)[0].args.valueWei, '0x0');
});
test('u128 maximum is accepted, implied overflow and canonical decimal bounds rejected', async () => {
  const max = ((1n << 128n) - 1n).toString();
  const q = quote(); Object.assign(q.refundQuote, { remainingRefundAmountAtomic: max, grossRefundAmountAtomic: max, sellerRefundAmountAtomic: max, hubFeeRefundAmountAtomic: '0', hubFeeRefundRequired: false, completionRule: 'seller_transfer_confirmed' }); q.refundQuote.sellerTransfer.value = `0x${BigInt(max).toString(16)}`;
  await fixture({ commerce_seller_refund_active_quote: () => q }).helper.execute(request());
  for (const value of ['00', '01', '-1', '1\n', '', 100, (1n << 128n).toString(), '9'.repeat(40)]) {
    const bad = quote(); bad.refundQuote.grossRefundAmountAtomic = value;
    const f = fixture({ commerce_seller_refund_active_quote: () => bad });
    await assert.rejects(f.helper.execute(request()), /refund_action_invalid/); assert.equal(sent(f).length, 0);
  }
});
test('quote identities, asset/chain, wallet, expiry, sum and hex bounds fail before wallet', async () => {
  const changes = [q => q.id += '\n', q => q.id = q.id.toUpperCase(), q => q.id = q.id.replace('-4', '-1'), q => q.orderId = 'other', q => q.assetKind = 'erc20', q => q.sellerAddress = buyer, q => q.currency = 'other', q => q.paymentTokenDecimals = 6, q => q.expiresAt = '2026-10-04T00:00:00.000Z', q => q.expiresAt = 'nonsense', q => q.grossRefundAmountAtomic = '101', q => q.hubFeeRefundAmountAtomic = '4', q => q.hubFeeRefundRequired = false, q => q.completionRule = 'seller_transfer_confirmed', q => q.extra = true, q => q.sellerTransfer.chainId = 1, q => q.sellerTransfer.to = seller, q => q.sellerTransfer.data = '0x00', q => q.sellerTransfer.value = '95', q => q.sellerTransfer.value = '0x05f', q => q.sellerTransfer.value = '0x5F', q => q.sellerTransfer.value = '0x5f\n', q => q.sellerTransfer.value = `0x${'f'.repeat(33)}`, q => q.sellerTransfer.value = '0x0', q => q.sellerTransfer.extra = true];
  for (const change of changes) {
    const q = quote(); change(q.refundQuote); const f = fixture({ commerce_seller_refund_active_quote: () => q });
    await assert.rejects(f.helper.execute(request()), /refund_action_invalid/); assert.equal(sent(f).length, 0);
  }
  for (const address of [buyer, null, `${seller}\n`]) { const f = fixture({ wallet_status: () => ({ address }) }); await assert.rejects(f.helper.execute(request()), /refund_action_invalid/); assert.equal(sent(f).length, 0); }
});
test('ERC20 rejects incorrect padding/amount/selector/length/value/contract', async () => {
  const good = `0xa9059cbb${buyer.slice(2).padStart(64, '0')}${95n.toString(16).padStart(64, '0')}`;
  for (const mutate of [c => c.data = good.replace('a9059cbb', '095ea7b3'), c => c.data += '00', c => c.data = good.slice(0, -2), c => c.data = good.slice(0, 10) + '1' + good.slice(11), c => c.data = good.slice(0, 74) + 'f'.repeat(64), c => c.value = '0x1', c => c.to = buyer]) {
    const d = detail(), q = quote(); d.order.assetKind = q.refundQuote.assetKind = 'erc20'; d.order.tokenContract = token;
    const c = { chainId: 137, to: token, value: '0x0', data: good }; mutate(c); q.refundQuote.sellerTransfer = c;
    const f = fixture({ commerce_seller_order_detail: () => d, commerce_seller_refund_active_quote: () => q }); await assert.rejects(f.helper.execute(request()), /refund_action_invalid/); assert.equal(sent(f).length, 0);
  }
});
test('order escrow/status/pending and 100/101 or sparse rows rejected safely', async () => {
  for (const mutate of [d => d.physicalEscrow = {}, d => d.order.status = 'refunded', d => d.order.id = 'other', d => d.order.chainId = 0, d => d.refunds = [{ status: 'submitted' }], d => d.refundAttempts = [{ status: 'submitted' }], d => d.refunds = Array(1), d => d.refunds = Array.from({ length: 101 }, () => ({ status: 'confirmed' }))]) {
    const d = detail(); mutate(d); const f = fixture({ commerce_seller_order_detail: () => d }); await assert.rejects(f.helper.execute(request()), /refund_action_(invalid|pending)/); assert.equal(sent(f).length, 0);
  }
  const d = detail(); d.refunds = Array.from({ length: 100 }, () => ({ status: 'confirmed' })); await fixture({ commerce_seller_order_detail: () => d }).helper.execute(request());
});
test('Native begin unresolved blocks every prepare and wallet call', async () => {
  const f = fixture({ wallet_refund_begin: () => ({ orderId, operations: [op()] }) });
  await assert.rejects(f.helper.execute(request()), /refund_action_pending/); assert.deepEqual(names(f), ['wallet_refund_begin']);
  await assert.rejects(f.helper.execute(request()), /refund_action_pending/);
});
test('begin error or malformed metadata stays unknown until valid recovery', async () => {
  for (const response of [null, { orderId, operations: Array(1) }, { orderId, operations: [op(), op()] }, { orderId, operations: [], extra: true }, { orderId: 'other', operations: [] }]) {
    const f = fixture({ wallet_refund_begin: () => response, wallet_refund_pending: () => ({ orderId, operations: [] }) }); await assert.rejects(f.helper.execute(request()), /refund_action_status_mismatch/); assert.equal(f.helper.status({ orderId }).unknown, true); await assert.rejects(f.helper.recover({ orderId }), /refund_action_unknown/); assert.equal(sent(f).length, 0);
  }
  const f = fixture({ wallet_refund_begin: () => { throw new Error('sensitive'); } }); await assert.rejects(f.helper.execute(request()), /^Error: refund_action_recovery_unavailable$/);
});
test('all six exact reserved string/Error presign codes allow manual retry only', async () => {
  for (const name of ['wallet_user_rejected', 'wallet_confirm_busy', 'wallet_confirm_unavailable', 'wallet_fee_unavailable', 'wallet_fee_expired', 'wallet_fee_stale']) for (const asError of [false, true]) {
    let count = 0;
    const f = fixture({ wallet_send_contract: () => { if (!count++) throw asError ? new Error(name) : name; return hash; } });
    await assert.rejects(f.helper.execute(request()), e => e.message === name); assert.equal(sent(f).length, 1); assert.equal(f.helper.status({ orderId }).unknown, false);
    await f.helper.execute(request()); assert.equal(sent(f).length, 2);
  }
});
test('lookalike failures/invalid returned hashes block resend and empty journal unlock', async () => {
  for (const cause of ['wallet_fee_stale ', { message: 'wallet_user_rejected' }, new Error('prefix wallet_confirm_busy')]) {
    const f = fixture({ wallet_send_contract: () => { throw cause; }, wallet_refund_pending: () => ({ orderId, operations: [] }) }); await assert.rejects(f.helper.execute(request()), /refund_action_unknown/); await assert.rejects(f.helper.execute(request()), /refund_action_pending/); await assert.rejects(f.helper.recover({ orderId }), /refund_action_unknown/); assert.equal(sent(f).length, 1);
  }
  for (const bad of [null, undefined, {}, hash + '\n', hash.slice(0, -1), 'wallet_user_rejected']) { const f = fixture({ wallet_send_contract: () => bad }); await assert.rejects(f.helper.execute(request()), /refund_action_unknown/); assert.equal(f.helper.status({ orderId }).pending, true); }
});
test('only exact not-confirmed allows one original submit, ACK alone cannot resolve', async () => {
  let finishes = 0;
  const f = fixture({ wallet_finish_refund: () => { finishes++; throw 'wallet_refund_not_confirmed'; } });
  await assert.rejects(f.helper.execute(request()), /refund_action_recovery_unavailable/); assert.equal(finishes, 2);
  assert.deepEqual(f.calls.find(c => c.name === 'commerce_seller_refund_submit').args, { orderId, refundQuoteId: quoteId, transactionHash: hash });
  assert.equal(f.helper.status({ orderId }).pending, true); await assert.rejects(f.helper.execute(request()), /refund_action_pending/); assert.equal(sent(f).length, 1);
  for (const cause of ['wallet_refund_not_confirmed ', { message: 'wallet_refund_not_confirmed' }, new Error('secret')]) { const bad = fixture({ wallet_finish_refund: () => { throw cause; } }); await assert.rejects(bad.helper.execute(request()), /refund_action_recovery_unavailable/); assert.equal(names(bad).includes('commerce_seller_refund_submit'), false); }
});
test('submit ACK strict sums, identities, booleans/status, known quote and fields', async () => {
  for (const mutate of [r => r.orderId = 'other', r => r.transactionHash = `0x${'cd'.repeat(32)}`, r => r.status = 'rejected', r => r.amountAtomic = '101', r => r.sellerRefundAmountAtomic = '94', r => r.hubFeeRefundRequired = 'true', r => r.idempotent = 'true', r => r.extra = true, r => delete r.id, r => r.amountAtomic = '01']) {
    let reads = 0; const body = ack(); mutate(body.refund); const f = fixture({ wallet_finish_refund: () => { if (!reads++) throw new Error('wallet_refund_not_confirmed'); return proof(); }, commerce_seller_refund_submit: () => body }); await assert.rejects(f.helper.execute(request()), /refund_action_status_mismatch/); assert.equal(reads, 1); assert.equal(f.helper.status({ orderId }).transactionHash, hash);
  }
});
test('exact finish proof mandatory and hash saved before finish/submit awaits', async () => {
  for (const mutate of [r => r.orderId = 'other', r => r.phase += 'x', r => r.transactionHash = `0x${'cd'.repeat(32)}`, r => r.resolved = false, r => r.sellerTransferConfirmed = false, r => r.extra = true, r => delete r.sellerTransferConfirmed]) {
    const p = proof(); mutate(p); const f = fixture({ wallet_finish_refund: () => p }); await assert.rejects(f.helper.execute(request()), /refund_action_status_mismatch/); assert.equal(f.helper.status({ orderId }).transactionHash, hash); assert.equal(f.helper.status({ orderId }).unknown, true);
  }
  const hold = deferred(), f = fixture({ wallet_finish_refund: () => hold.promise }); const execution = f.helper.execute(request());
  while (!names(f).includes('wallet_finish_refund')) await Promise.resolve();
  assert.equal(f.helper.status({ orderId }).transactionHash, hash); assert.equal(f.helper.status({ orderId }).busy, true); hold.resolve(proof()); await execution;
});
test('restart recovery no wallet/quote/preparation; original quote and hash only', async () => {
  let reads = 0; const f = fixture({ wallet_finish_refund: () => { if (!reads++) throw 'wallet_refund_not_confirmed'; return proof(); } });
  assert.deepEqual(await f.helper.recover({ orderId }), proof()); assert.deepEqual(names(f), ['wallet_refund_pending', 'wallet_finish_refund', 'commerce_seller_refund_submit', 'wallet_finish_refund']);
});
test('fresh empty returns noPending; uncertain empty retained and known lost finish only rechecks', async () => {
  const empty = fixture({ wallet_refund_pending: () => ({ orderId, operations: [] }) }); assert.deepEqual(await empty.helper.recover({ orderId }), { orderId, noPending: true });
  let reads = 0; const f = fixture({ wallet_finish_refund: () => { if (!reads++) throw 'lost saved response'; return proof(); }, wallet_refund_pending: () => ({ orderId, operations: [] }) });
  await assert.rejects(f.helper.execute(request()), /refund_action_recovery_unavailable/); await f.helper.recover({ orderId }); assert.equal(sent(f).length, 1); assert.equal(names(f).includes('commerce_seller_refund_submit'), false);
  const bad = fixture({ wallet_finish_refund: () => { throw 'wallet_refund_not_confirmed'; }, wallet_refund_pending: () => ({ orderId, operations: [] }) }); await assert.rejects(bad.helper.execute(request()), /refund_action_recovery_unavailable/); const before = names(bad).length; await assert.rejects(bad.helper.recover({ orderId }), /refund_action_recovery_unavailable/); assert.deepEqual(names(bad).slice(before), ['wallet_refund_pending', 'wallet_finish_refund']);
});
test('retained pending metadata mismatch never finishes or substitutes hash', async () => {
  for (const mutate of [o => o.chainId = 1, o => o.transactionHash = `0x${'cd'.repeat(32)}`, o => { o.quoteId = 'abcdefab-cdef-4abc-9abc-abcdefabcdef'; o.phase = `refund:${o.quoteId}`; }]) {
    const changed = op(); mutate(changed); const f = fixture({ wallet_finish_refund: () => { throw 'lost'; }, wallet_refund_pending: () => ({ orderId, operations: [changed] }) }); await assert.rejects(f.helper.execute(request())); const before = names(f).length; await assert.rejects(f.helper.recover({ orderId }), /refund_action_status_mismatch/); assert.deepEqual(names(f).slice(before), ['wallet_refund_pending']); assert.equal(f.helper.status({ orderId }).transactionHash, hash);
  }
});
test('mutating quote DTO during wallet await cannot substitute ACK binding', async () => {
  const q = quote(), hold = deferred(); let reads = 0;
  const f = fixture({ commerce_seller_refund_active_quote: () => q, wallet_send_contract: () => hold.promise, wallet_finish_refund: () => { if (!reads++) throw 'wallet_refund_not_confirmed'; return proof(); } });
  const execution = f.helper.execute(request()); while (!sent(f).length) await Promise.resolve(); q.refundQuote.grossRefundAmountAtomic = '1'; q.refundQuote.id = 'mutated'; hold.resolve(hash); await execution;
  assert.equal(f.calls.find(c => c.name === 'commerce_seller_refund_submit').args.refundQuoteId, quoteId);
});
test('same-order execute/recover mutex held across deferred await, other order independent', async () => {
  const hold = deferred(), f = fixture({ wallet_refund_begin: () => hold.promise }); const execution = f.helper.execute(request());
  await assert.rejects(f.helper.execute(request()), /refund_action_busy/); await assert.rejects(f.helper.recover({ orderId }), /refund_action_busy/); hold.resolve({ orderId, operations: [] }); await execution;
  const other = 'other'; const independent = fixture({ wallet_refund_pending: args => ({ orderId: args.orderId, operations: [] }) }); await independent.helper.recover({ orderId: other }); assert.equal(independent.helper.status({ orderId }).busy, false);
});
test('stale guard after each preparation await prevents signing; input mutation frozen', async () => {
  for (const blocked of ['wallet_refund_begin', 'commerce_seller_order_detail', 'wallet_status', 'commerce_seller_refund_active_quote', 'commerce_seller_refund_quote']) {
    let valid = true; const base = fixture(); const f = fixture({ [blocked]: async args => { const result = await base.invoke(blocked, args); valid = false; return result; }, ...(blocked === 'commerce_seller_refund_quote' ? { commerce_seller_refund_active_quote: () => ({ refundQuote: null }) } : {}) }); await assert.rejects(f.helper.execute({ orderId, canConfirm: () => valid }), /refund_action_invalid/); assert.equal(sent(f).length, 0); assert.equal(f.helper.status({ orderId }).unknown, false);
  }
  const f = fixture(); await assert.rejects(f.helper.execute({ orderId, canConfirm: async () => true }), /refund_action_invalid/); assert.equal(f.calls.length, 0);
});
test('strict arguments and ASCII id 0/200/201/newline, no raw callback errors', async () => {
  for (const value of ['', 'a'.repeat(201), 'a\n', 'a/b', 'é', null]) { const f = fixture(); await assert.rejects(f.helper.execute({ orderId: value, canConfirm: () => true }), /refund_action_invalid/); assert.equal(f.calls.length, 0); }
  const long = 'a'.repeat(200), f = fixture({ wallet_refund_pending: args => ({ orderId: args.orderId, operations: [] }) }); await f.helper.recover({ orderId: long });
  assert.throws(() => createRefundActions({ invoke: () => {}, extra: true }), /refund_action_invalid/);
  await assert.rejects(f.helper.execute({ orderId, canConfirm: () => { throw new Error('secret callback'); } }), /^Error: refund_action_invalid$/);
  await assert.rejects(f.helper.recover({ orderId, extra: true }), /refund_action_invalid/);
});
test('new begin failure cannot reuse previously resolved proof to clear uncertainty', async () => {
  let begins = 0;
  const f = fixture({ wallet_refund_begin: () => { if (begins++) throw 'lost begin'; return { orderId, operations: [] }; }, wallet_refund_pending: () => ({ orderId, operations: [] }) });
  await f.helper.execute(request()); await assert.rejects(f.helper.execute(request()), /refund_action_recovery_unavailable/);
  assert.equal(f.helper.status({ orderId }).transactionHash, null); const before = names(f).length;
  await assert.rejects(f.helper.recover({ orderId }), /refund_action_unknown/); assert.deepEqual(names(f).slice(before), ['wallet_refund_pending']);
});
test('lost wallet response binds recovered Native metadata to reviewed quote/chain', async () => {
  for (const mutate of [o => o.chainId = 1, o => { o.quoteId = 'abcdefab-cdef-4abc-9abc-abcdefabcdef'; o.phase = `refund:${o.quoteId}`; }]) {
    const changed = op(); mutate(changed); const f = fixture({ wallet_send_contract: () => { throw 'lost wallet response'; }, wallet_refund_pending: () => ({ orderId, operations: [changed] }) });
    await assert.rejects(f.helper.execute(request()), /refund_action_unknown/); const before = names(f).length; await assert.rejects(f.helper.recover({ orderId }), /refund_action_status_mismatch/); assert.deepEqual(names(f).slice(before), ['wallet_refund_pending']);
  }
  const f = fixture({ wallet_send_contract: () => { throw 'lost response'; } }); await assert.rejects(f.helper.execute(request())); await f.helper.recover({ orderId }); assert.equal(sent(f).length, 1);
});
test('new authoritative phase after resolved operation discards old quote binding', async () => {
  let newPhase = false, reads = 0;
  const nextId = 'abcdefab-cdef-4abc-9abc-abcdefabcdef';
  const f = fixture({ wallet_refund_pending: () => ({ orderId, operations: [{ ...op(), quoteId: nextId, phase: `refund:${nextId}` }] }), wallet_finish_refund: () => { if (newPhase && !reads++) throw 'wallet_refund_not_confirmed'; return { ...proof(), ...(newPhase ? { phase: `refund:${nextId}` } : {}) }; }, commerce_seller_refund_submit: () => ({ refund: { ...ack().refund, amountAtomic: '10', sellerRefundAmountAtomic: '10', hubFeeRefundAmountAtomic: '0', hubFeeRefundRequired: false } }) });
  await f.helper.execute(request()); newPhase = true; await f.helper.recover({ orderId }); assert.equal(f.helper.status({ orderId }).quoteId, nextId);
});
test('request copy is captured across async begin; hash letter case compares safely', async () => {
  const hold = deferred(), input = request(), f = fixture({ wallet_refund_begin: () => hold.promise, wallet_finish_refund: () => ({ ...proof(), transactionHash: `0x${hash.slice(2).toUpperCase()}` }) });
  const execution = f.helper.execute(input); input.orderId = 'changed'; input.canConfirm = () => false; hold.resolve({ orderId, operations: [] }); await execution;
  assert.equal(sent(f)[0].args.recoveryOrderId, orderId);
});
