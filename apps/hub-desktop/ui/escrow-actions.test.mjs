import test from 'node:test';
import assert from 'node:assert/strict';
import { createEscrowActions } from './escrow-actions.mjs';

const H = `0x${'ab'.repeat(32)}`, OTHER = `0x${'cd'.repeat(32)}`, TO = `0x${'12'.repeat(20)}`;
const UUID = '12345678-1234-4123-8123-123456789abc';
const ROLE_ACTIONS = {
  buyer: ['confirm', 'release', 'refund_unshipped', 'dispute', 'propose_resolution', 'accept_resolution', 'finalize_expired_dispute'],
  seller: ['ship', 'release', 'refund_by_seller', 'dispute', 'propose_resolution', 'accept_resolution', 'finalize_expired_dispute'],
};
const SELECTOR = { confirm: '34539694', release: 'a42f2b0c', refund_unshipped: '9006b145', dispute: 'f08ef6cb', propose_resolution: '878d683d', accept_resolution: '2739489e', finalize_expired_dispute: '9d63a591', ship: '93ef8d21', refund_by_seller: '6c5be2a8' };
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const split = { buyerAmountAtomic: '25', sellerAmountAtomic: '75' };
function calldata(action, extra = split) {
  return `0x${SELECTOR[action]}${'34'.repeat(32)}${action === 'propose_resolution' || action === 'accept_resolution' ? word(extra.buyerAmountAtomic) + word(extra.sellerAmountAtomic) : ''}${action === 'accept_resolution' ? word(1) + '56'.repeat(32) : ''}`;
}
const request = (role = 'buyer', action = 'confirm', extra = action === 'propose_resolution' ? split : {}) => ({ orderId: 'order_1', role, action, extra, summary: '操作の説明' });
const query = (role = 'buyer') => ({ orderId: 'order_1', role });
const op = (role = 'buyer', action = 'confirm', extra = action === 'propose_resolution' ? split : {}) => ({ phase: `escrow:${role}:${action}:${UUID}`, role, action, chainId: 137, transactionHash: H, extra });
const result = (phase, transactionHash = H) => ({ orderId: 'order_1', phase, transactionHash, resolved: true });
const fails = (promise, message) => assert.rejects(promise, (cause) => cause === message || cause instanceof Error && cause.message === message);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture(handler) {
  const f = { calls: [], record: null, hash: H };
  f.default = (command, args) => {
    if (command === 'wallet_escrow_begin' || command === 'wallet_escrow_pending') return { orderId: args.orderId, operations: f.record ? [f.record] : [] };
    if (command === 'commerce_escrow_prepare' || command === 'commerce_seller_escrow' && !args.submit) {
      return { action: { action: args.params.action, chainId: 137, to: TO, value: '0x0', data: calldata(args.params.action, args.params.action === 'propose_resolution' ? args.params : split) } };
    }
    if (command === 'wallet_send_contract') {
      const [, role, action] = args.recoveryPhase.split(':');
      const extra = action === 'propose_resolution' ? { buyerAmountAtomic: BigInt(`0x${args.data.slice(74, 138)}`).toString(), sellerAmountAtomic: BigInt(`0x${args.data.slice(138, 202)}`).toString() } : {};
      f.record = { phase: args.recoveryPhase, role, action, chainId: args.chainId, transactionHash: f.hash, extra };
      return f.hash;
    }
    if (command === 'wallet_finish_escrow') { const hash = f.record?.transactionHash ?? f.hash; f.record = null; return result(args.phase, hash); }
    return { escrow: { state: 'disputed', transactionHash: args.params.transactionHash } };
  };
  f.helper = createEscrowActions({ invoke: async (command, args) => { f.calls.push({ command, args }); return handler ? handler(command, args, f) : f.default(command, args); } });
  f.sends = () => f.calls.filter((c) => c.command === 'wallet_send_contract');
  return f;
}

test('all 7 buyer and 7 seller actions retain exact ABI, zero value and Native confirmation first', async () => {
  for (const role of ['buyer', 'seller']) for (const action of ROLE_ACTIONS[role]) {
    const f = fixture(); const input = request(role, action); const done = await f.helper.execute(input);
    assert.equal(done.resolved, true); assert.equal(done.transactionHash, H);
    const send = f.sends()[0].args;
    assert.equal(send.to, TO); assert.equal(send.valueWei, '0x0'); assert.equal(send.data, calldata(action));
    assert.match(send.recoveryPhase, new RegExp(`^escrow:${role}:${action}:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`));
    assert.equal(send.recoveryOrderId, input.orderId);
    assert.deepEqual(f.calls.map((c) => c.command), ['wallet_escrow_begin', role === 'buyer' ? 'commerce_escrow_prepare' : 'commerce_seller_escrow', 'wallet_send_contract', 'wallet_finish_escrow']);
    assert.deepEqual(f.helper.status(query(role)), { pending: false, unknown: false, transactionHash: H, action, busy: false, verifiedReverted: [] });
  }
});

test('only exact Native not-confirmed permits one role-correct Commerce submit then Native finish', async () => {
  for (const role of ['buyer', 'seller']) for (const failure of ['wallet_escrow_not_confirmed', new Error('wallet_escrow_not_confirmed')]) {
    let finishes = 0;
    const f = fixture((command, args, self) => {
      if (command === 'wallet_finish_escrow' && ++finishes === 1) {
        assert.equal(self.helper.status(query(role)).transactionHash, H); throw failure;
      }
      return self.default(command, args);
    });
    await f.helper.execute(request(role, 'propose_resolution'));
    const commands = f.calls.map((c) => c.command);
    assert.deepEqual(commands.slice(-3), ['wallet_finish_escrow', role === 'buyer' ? 'commerce_escrow_submit' : 'commerce_seller_escrow', 'wallet_finish_escrow']);
    const submit = f.calls.at(-2).args;
    assert.deepEqual(submit.params, { action: 'propose_resolution', ...split, transactionHash: H });
    if (role === 'buyer') assert.equal(submit.accessToken, ''); else assert.equal(submit.submit, true);
    assert.equal(f.sends().length, 1);
  }
});

test('Native finish unavailable or lookalikes never call Commerce submit and retain known hash', async () => {
  for (const cause of ['rpc_failed', 'wallet_escrow_not_confirmed\n', 'prefix_wallet_escrow_not_confirmed', { message: 'wallet_escrow_not_confirmed' }, new String('wallet_escrow_not_confirmed')]) {
    const f = fixture((command, args, self) => { if (command === 'wallet_finish_escrow') throw cause; return self.default(command, args); });
    await assert.rejects(f.helper.execute(request()));
    assert.equal(f.helper.status(query()).transactionHash, H); assert.equal(f.helper.status(query()).unknown, true);
    assert.equal(f.helper.status(query()).pending, true); assert.equal(f.calls.length, 4);
    await fails(f.helper.execute(request('seller', 'ship')), 'escrow_action_pending'); assert.equal(f.calls.length, 4);
  }
});

test('unknown wallet result never resends, and Native pending recovery sends/prepares zero times', async () => {
  let lost = false;
  const f = fixture((command, args, self) => {
    if (command === 'wallet_send_contract' && !lost) { lost = true; self.default(command, args); throw new Error('response_lost'); }
    return self.default(command, args);
  });
  await fails(f.helper.execute(request()), 'escrow_action_unknown');
  await fails(f.helper.execute(request()), 'escrow_action_pending');
  const before = f.calls.length; await f.helper.recover(query());
  assert.deepEqual(f.calls.slice(before).map((c) => c.command), ['wallet_escrow_pending', 'wallet_finish_escrow']);
  assert.equal(f.sends().length, 1); assert.equal(f.helper.status(query()).unknown, false);
});

test('restart recover replays durable proposal amounts only; never new prepare or wallet confirmation', async () => {
  for (const role of ['buyer', 'seller']) {
    let first = true;
    const f = fixture((command, args, self) => {
      if (command === 'wallet_finish_escrow' && first) { first = false; throw 'wallet_escrow_not_confirmed'; }
      return self.default(command, args);
    });
    f.record = op(role, 'propose_resolution', { buyerAmountAtomic: '0', sellerAmountAtomic: '100' });
    await f.helper.recover(query(role));
    assert.equal(f.sends().length, 0); assert.equal(f.calls.length, 4);
    assert.deepEqual(f.calls[2].args.params, { action: 'propose_resolution', buyerAmountAtomic: '0', sellerAmountAtomic: '100', transactionHash: H });
    assert.equal(f.calls.filter((c) => c.command === 'commerce_escrow_prepare').length, 0);
  }
});

test('proposal extra property order is canonical across execute snapshot and Native recovery', async () => {
  let offline = true;
  const f = fixture((command, args, self) => {
    if (command === 'wallet_finish_escrow' && offline) throw new Error('offline');
    return self.default(command, args);
  });
  await fails(f.helper.execute(request('buyer', 'propose_resolution', { sellerAmountAtomic: '75', buyerAmountAtomic: '25' })), 'offline');
  assert.deepEqual(Object.keys(f.record.extra), ['buyerAmountAtomic', 'sellerAmountAtomic']);
  offline = false; await f.helper.recover(query());
  assert.equal(f.helper.status(query()).unknown, false); assert.equal(f.sends().length, 1);
  const g = fixture(); g.record = op('buyer', 'propose_resolution', { sellerAmountAtomic: '75', buyerAmountAtomic: '25' });
  await g.helper.recover(query()); assert.equal(g.sends().length, 0);
});

test('confirmed repeated proposals use fresh UUID and amount snapshot, preserving valid repeated actions', async () => {
  const f = fixture(); await f.helper.execute(request('seller', 'propose_resolution'));
  f.hash = OTHER; await f.helper.execute(request('seller', 'propose_resolution', { buyerAmountAtomic: '50', sellerAmountAtomic: '50' }));
  const sends = f.sends(); assert.equal(sends.length, 2);
  assert.notEqual(sends[0].args.recoveryPhase, sends[1].args.recoveryPhase); assert.notEqual(sends[0].args.data, sends[1].args.data);
  assert.equal(f.helper.status(query('seller')).transactionHash, OTHER);
});

test('exact presign errors require explicit retry, while malformed hash and lookalikes stay locked', async () => {
  for (const value of ['wallet_user_rejected', 'wallet_confirm_busy', 'wallet_confirm_unavailable', 'wallet_fee_unavailable', 'wallet_fee_expired', 'wallet_fee_stale']) {
    for (const cause of [value, new Error(value)]) {
      let first = true;
      const f = fixture((command, args, self) => { if (command === 'wallet_send_contract' && first) { first = false; throw cause; } return self.default(command, args); });
      await fails(f.helper.execute(request()), value);
      assert.equal(f.helper.status(query()).unknown, false); assert.equal(f.helper.status(query()).pending, false); assert.equal(f.sends().length, 1);
      await Promise.resolve(); assert.equal(f.sends().length, 1);
      await f.helper.execute(request()); assert.equal(f.sends().length, 2);
    }
  }
  for (const value of [null, undefined, '0x1234', `${H.slice(0, -1)}\n`]) {
    const f = fixture((command, args, self) => command === 'wallet_send_contract' ? value : self.default(command, args));
    await fails(f.helper.execute(request()), 'escrow_action_unknown'); await fails(f.helper.execute(request()), 'escrow_action_pending'); assert.equal(f.sends().length, 1);
  }
  const f = fixture((command, args, self) => { if (command === 'wallet_send_contract') throw { message: 'wallet_user_rejected' }; return self.default(command, args); });
  await fails(f.helper.execute(request()), 'escrow_action_unknown'); assert.equal(f.helper.status(query()).unknown, true);
});

test('Native pending first blocks new sends across roles and malformed or unreadable begin is not empty', async () => {
  const f = fixture(); f.record = op('seller', 'ship');
  await fails(f.helper.execute(request()), 'escrow_action_pending'); assert.deepEqual(f.calls.map((c) => c.command), ['wallet_escrow_begin']);
  assert.equal(f.helper.status(query()).transactionHash, H);
  for (const body of [null, { orderId: 'other', operations: [] }, { orderId: 'order_1', operations: [], extra: true }, { orderId: 'order_1', operations: [op(), op()] }]) {
    const g = fixture(() => body); await fails(g.helper.execute(request()), 'escrow_action_status_mismatch');
    await fails(g.helper.execute(request()), 'escrow_action_pending'); assert.equal(g.calls.length, 1);
  }
  const g = fixture(() => { throw new Error('journal_unavailable'); }); await fails(g.helper.execute(request()), 'journal_unavailable');
  assert.equal(g.helper.status(query()).unknown, true); assert.equal(g.sends().length, 0);
});

test('Native finish response must be exact confirmed identity/hash; Commerce ACK cannot clear journal', async () => {
  for (const mutate of [(r) => null, (r) => ({ ...r, orderId: 'other' }), (r) => ({ ...r, phase: `${r.phase}x` }),
    (r) => ({ ...r, transactionHash: OTHER }), (r) => ({ ...r, resolved: false }), (r) => ({ ...r, resolved: 1 }), (r) => ({ ...r, extra: true })]) {
    const f = fixture((command, args, self) => command === 'wallet_finish_escrow' ? mutate(result(args.phase)) : self.default(command, args));
    await fails(f.helper.execute(request()), 'escrow_action_status_mismatch'); assert.equal(f.calls.length, 4);
    assert.equal(f.helper.status(query()).pending, true); assert.equal(f.helper.status(query()).transactionHash, H);
  }
  for (const ack of [null, {}, { escrow: { state: 'invented', transactionHash: H } }, { escrow: { state: 'released', transactionHash: OTHER } }, { escrow: { state: 'released', transactionHash: H, extra: true } }]) {
    const f = fixture((command, args, self) => {
      if (command === 'wallet_finish_escrow') throw 'wallet_escrow_not_confirmed';
      if (command === 'commerce_escrow_submit') return ack;
      return self.default(command, args);
    });
    await fails(f.helper.execute(request()), 'escrow_action_status_mismatch'); assert.equal(f.calls.length, 5); assert.equal(f.helper.status(query()).unknown, true);
  }
});

test('each recovery attempt permits at most one submit, including not-confirmed after valid ACK', async () => {
  const f = fixture((command, args, self) => { if (command === 'wallet_finish_escrow') throw 'wallet_escrow_not_confirmed'; return self.default(command, args); });
  await fails(f.helper.execute(request()), 'wallet_escrow_not_confirmed');
  assert.equal(f.calls.filter((c) => c.command === 'commerce_escrow_submit').length, 1);
  assert.equal(f.helper.status(query()).pending, true);
  await fails(f.helper.recover(query()), 'wallet_escrow_not_confirmed');
  assert.equal(f.calls.filter((c) => c.command === 'commerce_escrow_submit').length, 2); assert.equal(f.sends().length, 1);
});

test('empty Native pending does not unlock unknown; same-instance original hash resolves only via exact Native proof', async () => {
  const fresh = fixture(); await fails(fresh.helper.recover(query()), 'escrow_action_unknown');
  await fails(fresh.helper.execute(request()), 'escrow_action_pending'); assert.equal(fresh.calls.length, 1);
  let lost = true;
  const f = fixture((command, args, self) => {
    if (command === 'wallet_finish_escrow' && lost) { lost = false; self.default(command, args); throw new Error('finish_response_lost'); }
    return self.default(command, args);
  });
  await fails(f.helper.execute(request()), 'finish_response_lost'); assert.equal(f.record, null);
  const before = f.calls.length; await f.helper.recover(query());
  assert.deepEqual(f.calls.slice(before).map((c) => c.command), ['wallet_escrow_pending', 'wallet_finish_escrow']);
  assert.equal(f.helper.status(query()).unknown, false); assert.equal(f.sends().length, 1);
  const g = fixture((command, args, self) => {
    if (command === 'wallet_finish_escrow') { self.record = null; throw 'wallet_escrow_not_confirmed'; }
    return self.default(command, args);
  });
  await fails(g.helper.execute(request()), 'wallet_escrow_not_confirmed');
  const count = g.calls.length; await fails(g.helper.recover(query()), 'wallet_escrow_not_confirmed');
  assert.deepEqual(g.calls.slice(count).map((c) => c.command), ['wallet_escrow_pending', 'wallet_finish_escrow']);
  assert.equal(g.helper.status(query()).unknown, true);
});

test('closed pending records require role/action/UUIDv4/chain/hash/extra and reject duplicates or conflicting private state', async () => {
  for (const mutate of [(r) => ({ ...r, phase: r.phase.toUpperCase() }), (r) => ({ ...r, phase: r.phase.replace('-4123-', '-1123-') }),
    (r) => ({ ...r, phase: `${r.phase}\n` }), (r) => ({ ...r, role: 'seller' }), (r) => ({ ...r, action: 'ship' }),
    (r) => ({ ...r, chainId: '137' }), (r) => ({ ...r, chainId: 0 }), (r) => ({ ...r, transactionHash: `${H}\n` }),
    (r) => ({ ...r, extra: { action: 'release' } }), (r) => ({ ...r, additional: true })]) {
    const f = fixture(); f.record = mutate(op()); await fails(f.helper.recover(query()), 'escrow_action_status_mismatch'); assert.equal(f.calls.length, 1);
  }
  const role = fixture(); role.record = op('seller', 'ship'); await fails(role.helper.recover(query()), 'escrow_action_status_mismatch'); assert.equal(role.calls.length, 1);
  assert.equal(role.helper.status(query()).transactionHash, H); assert.equal(role.helper.status(query()).pending, true);
  await role.helper.recover(query('seller')); assert.equal(role.sends().length, 0);
  const duplicate = fixture(() => ({ orderId: 'order_1', operations: [op(), op()] })); await fails(duplicate.helper.recover(query()), 'escrow_action_status_mismatch');
  const unavailable = fixture(() => { throw new Error('read_failed'); }); await fails(unavailable.helper.recover(query()), 'escrow_action_recovery_unavailable'); assert.equal(unavailable.helper.status(query()).unknown, true);
  const conflict = fixture((command, args, self) => { if (command === 'wallet_finish_escrow') throw new Error('offline'); return self.default(command, args); });
  await fails(conflict.helper.execute(request()), 'offline'); conflict.record = { ...conflict.record, transactionHash: OTHER };
  const count = conflict.calls.length; await fails(conflict.helper.recover(query()), 'escrow_action_status_mismatch'); assert.equal(conflict.calls.length, count + 1);
});

test('a previously resolved private operation cannot block a fresh authoritative Native pending phase', async () => {
  const f = fixture(); await f.helper.execute(request());
  f.record = { ...op('buyer', 'release'), transactionHash: OTHER };
  await f.helper.recover(query());
  assert.equal(f.helper.status(query()).transactionHash, OTHER); assert.equal(f.helper.status(query()).action, 'release');
  assert.equal(f.helper.status(query()).unknown, false); assert.equal(f.sends().length, 1);
});

test('strict execute inputs prohibit extra action override, malformed UTF16 and noncanonical u128 splits', async () => {
  for (const input of [null, {}, { ...request(), orderId: '../order' }, { ...request(), orderId: 'x'.repeat(201) },
    { ...request(), role: 'automation' }, { ...request(), action: 'ship' }, { ...request(), extra: { action: 'release' } },
    { ...request(), extra: null }, { ...request(), extra: [] }, { ...request(), summary: '' }, { ...request(), summary: '\ud800' },
    { ...request(), summary: 'a'.repeat(201) }, { ...request(), unexpected: true }, { ...request(), canConfirm: true }]) {
    const f = fixture(); await fails(f.helper.execute(input), 'escrow_action_invalid'); assert.equal(f.calls.length, 0);
  }
  for (const extra of [{}, { buyerAmountAtomic: '1', sellerAmountAtomic: '1', action: 'release' },
    { buyerAmountAtomic: '0', sellerAmountAtomic: '0' }, { buyerAmountAtomic: '01', sellerAmountAtomic: '1' },
    { buyerAmountAtomic: '1\n', sellerAmountAtomic: '1' }, { buyerAmountAtomic: 1, sellerAmountAtomic: '1' },
    { buyerAmountAtomic: '340282366920938463463374607431768211455', sellerAmountAtomic: '1' },
    { buyerAmountAtomic: '340282366920938463463374607431768211456', sellerAmountAtomic: '0' }]) {
    const f = fixture(); await fails(f.helper.execute(request('buyer', 'propose_resolution', extra)), 'escrow_action_invalid'); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); await f.helper.execute(request('buyer', 'propose_resolution', { buyerAmountAtomic: '340282366920938463463374607431768211455', sellerAmountAtomic: '0' }));
  assert.equal(f.sends().length, 1);
  assert.throws(() => createEscrowActions({ invoke() {}, extra: true }), { message: 'escrow_action_invalid' });
});

test('prepared selector/ABI/value/address/chain/echo and proposal split must match before wallet invocation', async () => {
  for (const mutate of [(c) => ({ ...c, action: 'release' }), (c) => ({ ...c, chainId: 0 }), (c) => ({ ...c, chainId: Number.MAX_SAFE_INTEGER + 1 }),
    (c) => ({ ...c, to: `${TO.slice(0, -1)}\n` }), (c) => ({ ...c, value: '0x00' }), (c) => ({ ...c, value: '1' }),
    (c) => ({ ...c, data: `0x${'a'.repeat(65538)}` }), (c) => ({ ...c, data: `${c.data}00` }), (c) => ({ ...c, data: c.data.slice(0, -2) }),
    (c) => ({ ...c, data: c.data.replace('34539694', 'a42f2b0c') }), (c) => ({ ...c, extra: true })]) {
    const f = fixture((command, args, self) => command === 'commerce_escrow_prepare' ? { action: mutate(self.default(command, args).action) } : self.default(command, args));
    await fails(f.helper.execute(request()), 'escrow_action_invalid'); assert.equal(f.sends().length, 0);
  }
  for (const action of ['propose_resolution', 'accept_resolution']) {
    const f = fixture((command, args, self) => {
      if (command === 'commerce_escrow_prepare') {
        const body = self.default(command, args); body.action.data = `${body.action.data.slice(0, 74)}${word(1n << 128n)}${body.action.data.slice(138)}`; return body;
      }
      return self.default(command, args);
    });
    await fails(f.helper.execute(request('buyer', action)), 'escrow_action_invalid'); assert.equal(f.sends().length, 0);
  }
  const splitMismatch = fixture((command, args, self) => command === 'commerce_escrow_prepare' ? { action: { ...self.default(command, args).action, data: calldata('propose_resolution', { buyerAmountAtomic: '26', sellerAmountAtomic: '74' }) } } : self.default(command, args));
  await fails(splitMismatch.helper.execute(request('buyer', 'propose_resolution')), 'escrow_action_invalid'); assert.equal(splitMismatch.sends().length, 0);
  const version = fixture((command, args, self) => {
    const body = self.default(command, args);
    if (command === 'commerce_escrow_prepare') body.action.data = `${body.action.data.slice(0, 202)}${word(1n << 64n)}${body.action.data.slice(266)}`;
    return body;
  });
  await fails(version.helper.execute(request('buyer', 'accept_resolution')), 'escrow_action_invalid'); assert.equal(version.sends().length, 0);
});

test('accept proposal role/amounts are ABI-bound and allocations appear within strict200 codepoint summary', async () => {
  for (const role of ['buyer', 'seller']) {
    const f = fixture((command, args, self) => {
      const body = self.default(command, args);
      if (body?.action) body.proposal = { proposedBy: role === 'buyer' ? 'seller' : 'buyer', ...split };
      return body;
    });
    await f.helper.execute(request(role, 'accept_resolution'));
    assert.equal(f.sends()[0].args.summary, '操作の説明\n購入者へ 25・店舗へ 75（最小単位）');
  }
  for (const proposal of [{ proposedBy: 'buyer', ...split }, { proposedBy: 'seller', buyerAmountAtomic: '26', sellerAmountAtomic: '75' }, { proposedBy: 'seller', ...split, extra: true }]) {
    const f = fixture((command, args, self) => { const body = self.default(command, args); if (body?.action) body.proposal = proposal; return body; });
    await fails(f.helper.execute(request('buyer', 'accept_resolution')), 'escrow_action_invalid'); assert.equal(f.sends().length, 0);
  }
  const accepted = fixture(); await accepted.helper.execute({ ...request(), summary: '😀'.repeat(200) }); assert.equal(accepted.sends()[0].args.summary, '😀'.repeat(200));
  const tooLong = fixture(); await fails(tooLong.helper.execute({ ...request('buyer', 'accept_resolution'), summary: 'x'.repeat(200) }), 'escrow_action_invalid'); assert.equal(tooLong.sends().length, 0);
});

test('canConfirm is synchronous and checked before/after Native begin and after prepare; stale views never send', async () => {
  for (const stop of [1, 2, 3]) {
    let checks = 0; const f = fixture();
    await fails(f.helper.execute({ ...request(), canConfirm: () => ++checks < stop }), 'escrow_action_invalid');
    assert.equal(f.sends().length, 0); assert.equal(f.calls.length, stop - 1); assert.equal(f.helper.status(query()).unknown, false);
  }
  const f = fixture(); await fails(f.helper.execute({ ...request(), canConfirm: async () => true }), 'escrow_action_invalid'); assert.equal(f.calls.length, 0);
  const g = fixture(); await fails(g.helper.execute({ ...request(), canConfirm: async () => { throw new Error('callback_failed'); } }), 'escrow_action_invalid');
  await Promise.resolve(); assert.equal(g.calls.length, 0);
});

test('deferred begin/prepare preserve original extra and context; busy excludes same order across roles', async () => {
  for (const phase of ['begin', 'prepare']) {
    const d = deferred(); let valid = true; const input = request('buyer', 'propose_resolution', { ...split });
    const f = fixture((command, args, self) => command === (phase === 'begin' ? 'wallet_escrow_begin' : 'commerce_escrow_prepare') ? d.promise : self.default(command, args));
    const promise = f.helper.execute({ ...input, canConfirm: () => valid });
    await Promise.resolve(); await Promise.resolve();
    await fails(f.helper.execute(request('seller', 'ship')), 'escrow_action_busy'); await fails(f.helper.recover(query()), 'escrow_action_busy');
    input.extra.buyerAmountAtomic = '99'; valid = false;
    d.resolve(phase === 'begin' ? { orderId: 'order_1', operations: [] } : { action: { action: 'propose_resolution', chainId: 137, to: TO, value: '0x0', data: calldata('propose_resolution') } });
    await fails(promise, 'escrow_action_invalid'); assert.equal(f.sends().length, 0); assert.equal(f.helper.status(query()).busy, false);
    if (phase === 'prepare') assert.equal(f.calls[1].args.params.buyerAmountAtomic, '25');
  }
});

test('hash is retained through deferred finish and submit failure; late confirmation cannot unlock via arbitrary result', async () => {
  const d = deferred();
  const f = fixture((command, args, self) => command === 'wallet_finish_escrow' ? d.promise : self.default(command, args));
  const promise = f.helper.execute(request()); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.helper.status(query()).transactionHash, H); assert.equal(f.helper.status(query()).busy, true);
  await fails(f.helper.recover(query()), 'escrow_action_busy');
  d.resolve({ ...result(f.sends()[0].args.recoveryPhase), resolved: false }); await fails(promise, 'escrow_action_status_mismatch');
  assert.equal(f.helper.status(query()).transactionHash, H); assert.equal(f.helper.status(query()).unknown, true);
  const g = fixture((command, args, self) => {
    if (command === 'wallet_finish_escrow') throw 'wallet_escrow_not_confirmed';
    if (command === 'commerce_escrow_submit') throw new Error('submit_failed');
    return self.default(command, args);
  });
  await fails(g.helper.execute(request()), 'submit_failed'); assert.equal(g.helper.status(query()).transactionHash, H); assert.equal(g.sends().length, 1);
});

function failureDefault(command, args, self) {
  if (command === 'wallet_check_escrow_failure') {
    const original = self.record?.phase === args.phase ? self.record : self.history.find((r) => r.phase === args.phase);
    if (!original) throw new Error('missing_original');
    if (!self.history.some((r) => r.phase === original.phase)) self.history.push(original);
    self.record = null;
    return { orderId: args.orderId, phase: args.phase, transactionHash: original.transactionHash, status: 'reverted' };
  }
  if (command === 'wallet_escrow_history') return { orderId: args.orderId, verifiedReverted: self.history };
  return self.default(command, args);
}
function failureFixture(handler) {
  const f = fixture((command, args, self) => handler ? handler(command, args, self) : failureDefault(command, args, self));
  f.history = [];
  return f;
}

test('failure inspection for all buyer/seller actions uses only pending/check/history and retains exact durable proof', async () => {
  for (const role of ['buyer', 'seller']) for (const action of ROLE_ACTIONS[role]) {
    const f = failureFixture(); f.record = op(role, action);
    const verified = await f.helper.recoverFailure(query(role));
    assert.deepEqual(verified, { orderId: 'order_1', verifiedReverted: [op(role, action)] });
    assert.deepEqual(f.calls.map((c) => c.command), ['wallet_escrow_pending', 'wallet_check_escrow_failure', 'wallet_escrow_history']);
    assert.deepEqual(f.calls[1].args, { orderId: 'order_1', phase: op(role, action).phase, accessToken: '' });
    assert.equal(f.sends().length, 0); assert.equal(f.helper.status(query(role)).pending, false); assert.equal(f.helper.status(query(role)).unknown, false);
  }
});

test('known pending failure unlocks only original proof, and separate explicit action uses a fresh phase and confirmation', async () => {
  const f = failureFixture((command, args, self) => {
    if (command === 'wallet_finish_escrow' && !self.history.length) throw new Error('not_confirmed_yet');
    return failureDefault(command, args, self);
  });
  await fails(f.helper.execute(request('seller', 'propose_resolution')), 'not_confirmed_yet');
  const original = f.sends()[0].args.recoveryPhase;
  await f.helper.recoverFailure(query('seller')); assert.equal(f.sends().length, 1);
  f.hash = OTHER; await f.helper.execute(request('seller', 'propose_resolution', { buyerAmountAtomic: '50', sellerAmountAtomic: '50' }));
  assert.equal(f.sends().length, 2); assert.notEqual(f.sends()[1].args.recoveryPhase, original);
  assert.equal(f.helper.status(query('seller')).verifiedReverted[0].phase, original);
});

test('lost failure result or failed history read retains original operation and freshly rechecks exact phase', async () => {
  for (const loss of ['proof', 'history']) {
    let first = true;
    const f = failureFixture((command, args, self) => {
      if (command === (loss === 'proof' ? 'wallet_check_escrow_failure' : 'wallet_escrow_history') && first) {
        first = false;
        if (loss === 'proof') failureDefault(command, args, self);
        throw new Error('lost_result');
      }
      return failureDefault(command, args, self);
    });
    f.record = op();
    await fails(f.helper.recoverFailure(query()), 'escrow_action_recovery_unavailable');
    assert.equal(f.helper.status(query()).transactionHash, H); assert.equal(f.helper.status(query()).unknown, true);
    assert.equal(f.record, null);
    const before = f.calls.length; await f.helper.recoverFailure(query());
    assert.deepEqual(f.calls.slice(before).map((c) => c.command), ['wallet_escrow_pending', 'wallet_check_escrow_failure', 'wallet_escrow_history']);
    assert.equal(f.calls[before + 1].args.phase, op().phase); assert.equal(f.sends().length, 0); assert.equal(f.helper.status(query()).unknown, false);
  }
});

test('fresh restart imports requested-role durable history without any failure check or send; empty/other-role history is not success', async () => {
  for (const role of ['buyer', 'seller']) {
    const f = failureFixture(); f.history = [op(role, role === 'buyer' ? 'confirm' : 'ship')];
    const result = await f.helper.recoverFailure(query(role));
    assert.equal(result.verifiedReverted.length, 1); assert.equal(f.helper.status(query(role)).unknown, false);
    assert.deepEqual(f.calls.map((c) => c.command), ['wallet_escrow_pending', 'wallet_escrow_history']);
  }
  for (const list of [[], [op('seller', 'ship')]]) {
    const f = failureFixture(); f.history = list;
    await fails(f.helper.recoverFailure(query()), 'escrow_action_unknown'); assert.equal(f.helper.status(query()).unknown, true);
    await fails(f.helper.execute(request()), 'escrow_action_pending'); assert.equal(f.sends().length, 0);
  }
});

test('unrelated prior history cannot clear unknown new attempt without an original known operation, across roles', async () => {
  for (const inspectRole of ['buyer', 'seller']) {
    const f = failureFixture((command, args, self) => {
      if (command === 'wallet_send_contract') throw new Error('send_result_unknown');
      return failureDefault(command, args, self);
    });
    f.history = [{ ...op('buyer', 'release'), transactionHash: OTHER }, { ...op('seller', 'ship'), transactionHash: `0x${'ef'.repeat(32)}` }];
    await fails(f.helper.execute(request()), 'escrow_action_unknown');
    await fails(f.helper.recoverFailure(query(inspectRole)), 'escrow_action_unknown');
    assert.equal(f.helper.status(query()).unknown, true); assert.equal(f.helper.status(query()).pending, true); assert.equal(f.helper.status(query()).transactionHash, null);
    assert.equal(f.helper.status(query()).verifiedReverted.length, 2);
    assert.equal(f.calls.filter((c) => c.command === 'wallet_check_escrow_failure').length, 0); assert.equal(f.sends().length, 1);
    await fails(f.helper.execute(request('seller', 'ship')), 'escrow_action_pending'); assert.equal(f.sends().length, 1);
  }
});

test('wrong role or changed pending phase/chain/hash/extra cannot rebind retained unknown operation', async () => {
  for (const change of [(r) => ({ ...r, phase: `${r.phase.slice(0, -36)}${r.phase.at(-36) === 'a' ? 'b' : 'a'}${r.phase.slice(-35)}` }),
    (r) => ({ ...r, chainId: 1 }), (r) => ({ ...r, transactionHash: OTHER }),
    (r) => ({ ...r, extra: { buyerAmountAtomic: '26', sellerAmountAtomic: '74' } })]) {
    const f = failureFixture((command, args, self) => { if (command === 'wallet_finish_escrow') throw new Error('offline'); return failureDefault(command, args, self); });
    await fails(f.helper.execute(request('buyer', 'propose_resolution')), 'offline');
    f.record = change(f.record);
    const before = f.calls.length; await fails(f.helper.recoverFailure(query()), 'escrow_action_status_mismatch');
    assert.equal(f.calls.length, before + 1); assert.equal(f.helper.status(query()).transactionHash, H); assert.equal(f.helper.status(query()).unknown, true);
  }
  const f = failureFixture(); f.record = op();
  await fails(f.helper.recoverFailure(query('seller')), 'escrow_action_status_mismatch');
  assert.equal(f.calls.length, 1); assert.equal(f.helper.status(query()).pending, true);
  await f.helper.recoverFailure(query()); assert.equal(f.sends().length, 0);
});

test('failure proof must be exact original identity/hash and reverted status before requesting history', async () => {
  for (const mutate of [(r) => null, (r) => ({ ...r, orderId: 'other' }), (r) => ({ ...r, phase: `${r.phase}x` }),
    (r) => ({ ...r, transactionHash: OTHER }), (r) => ({ ...r, status: 'confirmed' }), (r) => ({ ...r, status: 'reverted\n' }),
    (r) => ({ ...r, extra: true }), (r) => ({ orderId: r.orderId, phase: r.phase, status: r.status })]) {
    const f = failureFixture((command, args, self) => command === 'wallet_check_escrow_failure' ? mutate({ orderId: 'order_1', phase: args.phase, transactionHash: H, status: 'reverted' }) : failureDefault(command, args, self));
    f.record = op(); await fails(f.helper.recoverFailure(query()), 'escrow_action_status_mismatch');
    assert.equal(f.calls.length, 2); assert.equal(f.helper.status(query()).transactionHash, H); assert.equal(f.helper.status(query()).unknown, true);
  }
  for (const command of ['wallet_escrow_pending', 'wallet_check_escrow_failure', 'wallet_escrow_history']) {
    const f = failureFixture((name, args, self) => { if (name === command) throw new Error('unavailable'); return failureDefault(name, args, self); });
    f.record = op(); await fails(f.helper.recoverFailure(query()), 'escrow_action_recovery_unavailable');
    assert.equal(f.helper.status(query()).busy, false); assert.equal(f.helper.status(query()).unknown, true); assert.equal(f.sends().length, 0);
  }
});

test('matching Native proof cannot unlock without history matching every original operation field', async () => {
  for (const change of [(r) => [], (r) => [{ ...r, chainId: 1 }], (r) => [{ ...r, transactionHash: OTHER }],
    (r) => [{ ...r, extra: { sellerAmountAtomic: '74', buyerAmountAtomic: '26' } }]]) {
    const f = failureFixture((command, args, self) => {
      const result = failureDefault(command, args, self);
      if (command === 'wallet_escrow_history') result.verifiedReverted = change(self.history[0]);
      return result;
    });
    f.record = op('buyer', 'propose_resolution');
    await fails(f.helper.recoverFailure(query()), 'escrow_action_status_mismatch');
    assert.equal(f.helper.status(query()).pending, true); assert.equal(f.helper.status(query()).unknown, true); assert.equal(f.sends().length, 0);
  }
});

test('history is closed, bounded and dense with unique phase and case-insensitive hash identities', async () => {
  for (const body of [null, {}, { orderId: 'other', verifiedReverted: [op()] }, { orderId: 'order_1', verifiedReverted: [op()], extra: true },
    { orderId: 'order_1', verifiedReverted: null }, { orderId: 'order_1', verifiedReverted: [undefined] },
    { orderId: 'order_1', verifiedReverted: new Array(1) }, { orderId: 'order_1', verifiedReverted: [op(), op()] },
    { orderId: 'order_1', verifiedReverted: [op(), { ...op(), transactionHash: OTHER }] },
    { orderId: 'order_1', verifiedReverted: [op(), { ...op('buyer', 'release'), transactionHash: `0x${'AB'.repeat(32)}` }] },
    { orderId: 'order_1', verifiedReverted: [{ ...op(), chainId: '137' }] }, { orderId: 'order_1', verifiedReverted: [{ ...op(), extra: { action: 'release' } }] }]) {
    const f = failureFixture((command, args, self) => command === 'wallet_escrow_history' ? body : failureDefault(command, args, self));
    await fails(f.helper.recoverFailure(query()), 'escrow_action_status_mismatch'); assert.equal(f.helper.status(query()).unknown, true);
  }
  const entries = Array.from({ length: 101 }, (_, index) => ({ ...op(), phase: `escrow:buyer:confirm:12345678-1234-4123-8123-${index.toString(16).padStart(12, '0')}`, transactionHash: `0x${(index + 1).toString(16).padStart(64, '0')}` }));
  const max = failureFixture(); max.history = entries.slice(0, 100); await max.helper.recoverFailure(query()); assert.equal(max.helper.status(query()).verifiedReverted.length, 100);
  const over = failureFixture(); over.history = entries; await fails(over.helper.recoverFailure(query()), 'escrow_action_status_mismatch');
});

test('verifiedReverted snapshots are immutable copied arrays/records/extras detached from Native input', async () => {
  const f = failureFixture(); const original = op('buyer', 'propose_resolution', { ...split }); f.history = [original];
  const result = await f.helper.recoverFailure(query()); const first = f.helper.status(query()).verifiedReverted, next = f.helper.status(query()).verifiedReverted;
  assert.notEqual(first, next); assert.notEqual(first[0], next[0]); assert.notEqual(first[0].extra, next[0].extra);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(first[0])); assert.ok(Object.isFrozen(first[0].extra));
  assert.throws(() => first.push(op()), TypeError); assert.throws(() => first[0].action = 'release', TypeError); assert.throws(() => first[0].extra.buyerAmountAtomic = '99', TypeError);
  original.extra.buyerAmountAtomic = '99'; original.chainId = 1; f.history.push(op('seller', 'ship'));
  assert.equal(f.helper.status(query()).verifiedReverted.length, 1); assert.equal(f.helper.status(query()).verifiedReverted[0].chainId, 137);
  assert.equal(f.helper.status(query()).verifiedReverted[0].extra.buyerAmountAtomic, '25');
});

test('failure busy lock covers pending/proof/history awaits and excludes all overlapping action methods', async () => {
  for (const blocked of ['wallet_escrow_pending', 'wallet_check_escrow_failure', 'wallet_escrow_history']) {
    const d = deferred();
    const f = failureFixture((command, args, self) => command === blocked ? d.promise : failureDefault(command, args, self));
    f.record = op(); const call = f.helper.recoverFailure(query());
    for (let i = 0; i < 6; i++) await Promise.resolve();
    assert.equal(f.helper.status(query()).busy, true);
    await fails(f.helper.execute(request('seller', 'ship')), 'escrow_action_busy');
    await fails(f.helper.recover(query()), 'escrow_action_busy'); await fails(f.helper.recoverFailure(query()), 'escrow_action_busy');
    const args = f.calls.find((c) => c.command === blocked).args;
    d.resolve(failureDefault(blocked, args, f)); await call;
    assert.equal(f.helper.status(query()).busy, false); assert.equal(f.sends().length, 0);
  }
});

test('recoverFailure rejects invalid input/unknown fields before IPC and restores busy after unexpected parser exceptions', async () => {
  for (const input of [null, {}, { ...query(), orderId: '../x' }, { ...query(), role: 'automation' }, { ...query(), phase: op().phase }]) {
    const f = failureFixture(); await fails(f.helper.recoverFailure(input), 'escrow_action_invalid'); assert.equal(f.calls.length, 0);
  }
  const f = failureFixture((command, args, self) => {
    if (command === 'wallet_escrow_history') return { orderId: 'order_1', get verifiedReverted() { throw new Error('parser_failed'); } };
    return failureDefault(command, args, self);
  });
  await fails(f.helper.recoverFailure(query()), 'parser_failed'); assert.equal(f.helper.status(query()).busy, false); assert.equal(f.helper.status(query()).unknown, true);
});
