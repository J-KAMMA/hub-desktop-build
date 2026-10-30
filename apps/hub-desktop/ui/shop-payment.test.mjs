import test from 'node:test';
import assert from 'node:assert/strict';
import { createShopPayment, shopAtomicHex } from './shop-payment.mjs';

const H = `0x${'ab'.repeat(32)}`, A = `0x${'cd'.repeat(32)}`, OTHER = `0x${'ef'.repeat(32)}`;
const CONTRACT = `0x${'12'.repeat(20)}`, TOKEN = `0x${'34'.repeat(20)}`;
const reservedCodes = ['wallet_confirm_busy', 'wallet_confirm_unavailable', 'wallet_fee_unavailable', 'wallet_fee_expired', 'wallet_fee_stale'];
function line(erc20 = false) {
  return { product: { id: 'prod_1', title: '商品' }, quantity: 2, order: {
    id: 'order_1', productId: 'prod_1', quantity: 2, accessToken: 'fixture-token', currency: erc20 ? 'JPYC' : 'POL', chainId: 137,
    status: 'awaiting_payment', gasPayer: 'buyer', expiresAt: '2099-01-01T00:00:00.000Z', assetKind: erc20 ? 'erc20' : 'native',
    amountAtomic: '100', valueAtomic: erc20 ? '0' : '100', tokenContract: erc20 ? TOKEN : null, transferData: '0xaabb',
    escrow: { contractAddress: CONTRACT, state: 'awaiting_lock', approval: erc20 ? { tokenContract: TOKEN, data: '0x1122' } : null },
  } };
}
const ack = (status = 'submitted', transactionHash = H, id = 'order_1') => ({ order: { id, status, transactionHash } });
function fixture(handler, onSent) {
  const calls = [];
  const payment = createShopPayment({ onSent, invoke: async (command, args) => {
    calls.push({ command, args });
    if (handler) return handler(command, args, calls);
    return command === 'wallet_send_contract' ? H : ack();
  } });
  return { payment, calls, wallets: () => calls.filter((c) => c.command === 'wallet_send_contract') };
}
const fails = (promise, code) => assert.rejects(promise, { message: code });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('atomic decimal is exact through u128, rejecting noncanonical representations and width overflow', () => {
  assert.equal(shopAtomicHex('0'), '0x0'); assert.equal(shopAtomicHex('100'), '0x64');
  assert.equal(shopAtomicHex('9007199254740993'), '0x20000000000001');
  assert.equal(shopAtomicHex('340282366920938463463374607431768211455'), `0x${'f'.repeat(32)}`);
  for (const value of ['340282366920938463463374607431768211456', '9'.repeat(40), '00', '01', '-1', '+1', '1.0', '1e2', '0x64', ' 1', '1\n', '', null, 100, 100n]) assert.throws(() => shopAtomicHex(value), { message: 'shop_payment_invalid' });
});

test('native order forwards reviewed calldata/address and decimal100 becomes hex64; hash exists before callback/submit', async () => {
  const l = line(); let f;
  f = fixture(null, (seen, hash) => {
    assert.equal(seen, l); assert.equal(hash, H); assert.equal(l.transactionHash, H);
    assert.equal(f.payment.status(l).transactionHash, H); assert.equal(f.calls.length, 1);
  });
  assert.deepEqual(await f.payment.pay(l), { transactionHash: H, order: ack().order });
  assert.deepEqual(f.wallets()[0].args, { chainId: 137, to: CONTRACT, valueWei: '0x64', data: '0xaabb', summary: '商品 × 2 の代金を受取確認までロック', recoveryOrderId: 'order_1', recoveryPhase: 'payment' });
  assert.equal(f.payment.discardable(l), false); assert.equal(f.payment.status(l).busy, false);
});

test('ERC20 approval hash is retained before deposit and both calls carry zero native value', async () => {
  const l = line(true);
  const f = fixture((command, args, calls) => {
    if (command !== 'wallet_send_contract') return ack();
    if (calls.length === 1) return A;
    assert.equal(l.approvalHash, A); assert.equal(f.payment.status(l).approvalHash, A); return H;
  });
  await f.payment.pay(l);
  assert.deepEqual(f.wallets().map((c) => [c.args.to, c.args.data, c.args.valueWei]), [[TOKEN, '0x1122', '0x0'], [CONTRACT, '0xaabb', '0x0']]);
  assert.deepEqual(f.wallets().map((c) => [c.args.recoveryOrderId, c.args.recoveryPhase]), [['order_1', 'approval'], ['order_1', 'payment']]);
});

test('submit failure retries only same hash after authoritative null-hash status; success retry only reads', async () => {
  let submits = 0, recorded = false;
  const f = fixture((command) => {
    if (command === 'wallet_send_contract') return H;
    if (command === 'commerce_order_status') return recorded ? ack('paid') : ack('awaiting_payment', null);
    if (++submits === 1) throw new Error('submit_down');
    recorded = true; return ack();
  });
  const l = line(); await fails(f.payment.pay(l), 'submit_down');
  assert.equal(f.payment.status(l).unknown, false);
  await f.payment.pay(l); await f.payment.pay(structuredClone(l));
  assert.equal(f.wallets().length, 1); assert.equal(submits, 2);
  assert.deepEqual(f.calls.map((c) => c.command), ['wallet_send_contract', 'commerce_order_submit', 'commerce_order_status', 'commerce_order_submit', 'commerce_order_status']);
  assert.ok(f.calls.filter((c) => c.command === 'commerce_order_submit').every((c) => c.args.transactionHash === H));
});

test('callback/storage failure keeps deposit hash; retry reads and retries persistence before submit', async () => {
  let notified = 0; const l = line();
  const f = fixture((cmd) => cmd === 'wallet_send_contract' ? H : cmd === 'commerce_order_status' ? ack('awaiting_payment', null) : ack(), () => { if (++notified === 1) throw new Error('storage_down'); });
  await fails(f.payment.pay(l), 'storage_down'); assert.equal(l.transactionHash, H); assert.equal(f.calls.length, 1);
  assert.equal(f.payment.status(l).transactionHash, H); assert.equal(f.payment.status(l).unknown, false);
  await f.payment.pay(l); assert.equal(f.wallets().length, 1); assert.equal(notified, 2);
});

test('exact rejection retries deposit only, never a successful approval', async () => {
  const l = line(true); let walletCount = 0;
  const f = fixture((cmd) => {
    if (cmd !== 'wallet_send_contract') return ack();
    if (++walletCount === 1) return A;
    if (walletCount === 2) throw new Error('wallet_user_rejected');
    return H;
  });
  await fails(f.payment.pay(l), 'wallet_user_rejected');
  assert.equal(f.payment.status(l).unknown, false); assert.equal(f.payment.discardable(l), false);
  await f.payment.pay(l); assert.deepEqual(f.wallets().map((c) => c.args.to), [TOKEN, CONTRACT, CONTRACT]);
  const g = fixture(() => { throw 'wallet_user_rejected'; }); await fails(g.payment.pay(line()), 'wallet_user_rejected'); assert.equal(g.payment.status(line()).unknown, false);
});

test('unknown errors and malformed wallet hash permanently block repeated wallet calls and copied lines', async () => {
  for (const result of [new Error('rpc_timeout'), new Error('prefix_wallet_user_rejected'), null, undefined, '0x1234', `${H.slice(0, -1)}\n`]) {
    const f = fixture(() => { if (result instanceof Error) throw result; return result; }); const l = line();
    await fails(f.payment.pay(l), 'shop_payment_unknown'); await fails(f.payment.pay(structuredClone(l)), 'shop_payment_unknown');
    assert.equal(f.wallets().length, 1); assert.equal(f.payment.status(l).unknown, true); assert.equal(f.payment.discardable(l), false);
    await fails(f.payment.recover({ orderId: l.order.id, transactionHash: H }), 'shop_payment_status_mismatch'); assert.equal(f.calls.length, 1);
  }
});

test('approval rejection may retry approval; unknown approval blocks both approval and deposit', async () => {
  let count = 0; const l = line(true);
  const f = fixture((cmd) => {
    if (cmd !== 'wallet_send_contract') return ack();
    if (++count === 1) throw 'wallet_user_rejected';
    return count === 2 ? A : H;
  });
  await fails(f.payment.pay(l), 'wallet_user_rejected'); assert.equal(l.approvalHash, undefined);
  await f.payment.pay(l); assert.deepEqual(f.wallets().map((c) => c.args.to), [TOKEN, TOKEN, CONTRACT]);
  const g = fixture(() => { throw new Error('approval_network_unknown'); }); const other = line(true);
  await fails(g.payment.pay(other), 'shop_payment_unknown'); await fails(g.payment.pay(other), 'shop_payment_unknown');
  assert.equal(g.calls.length, 1); assert.equal(g.payment.status(other).approvalHash, null);
});

test('known hash survives async callback rejection and busy remains until callback settles', async () => {
  const d = deferred(); const l = line(); const f = fixture(null, () => d.promise);
  const pending = f.payment.pay(l);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.payment.status(l).transactionHash, H); assert.equal(f.payment.status(l).busy, true);
  await fails(f.payment.pay(structuredClone(l)), 'shop_payment_busy'); assert.equal(f.calls.length, 1);
  d.reject(new Error('async_storage_down')); await fails(pending, 'async_storage_down');
  assert.equal(f.payment.status(l).transactionHash, H); assert.equal(f.payment.status(l).busy, false);
});

test('a different reviewed copy of the same order cannot sign or recover by paying', async () => {
  const l = line(); const f = fixture(); await f.payment.pay(l);
  for (const change of [(c) => c.product.title = '別商品', (c) => c.order.accessToken = 'different', (c) => c.order.currency = 'ETH', (c) => c.order.chainId = 1]) {
    const copy = structuredClone(l); change(copy); await fails(f.payment.pay(copy), 'shop_payment_invalid');
  }
  assert.equal(f.calls.length, 2); assert.equal(f.payment.status(l).transactionHash, H);
});

test('malformed or mismatched ACK is failure, retained hash blocks repayment', async () => {
  for (const response of [null, {}, ack('invented'), ack('submitted', OTHER), ack('submitted', H, 'other'), ack('awaiting_payment', H), ack('submitted', null)]) {
    const f = fixture((cmd) => cmd === 'wallet_send_contract' ? H : response); const l = line();
    await fails(f.payment.pay(l), 'shop_payment_status_mismatch'); await fails(f.payment.pay(l), 'shop_payment_status_mismatch');
    assert.equal(f.wallets().length, 1); assert.equal(f.calls.length, 3); assert.equal(f.payment.status(l).transactionHash, H);
  }
});

test('busy covers copied line and recover while deferred wallet runs; tampering cannot change in-flight call', async () => {
  const d = deferred(); const l = line(true), copy = structuredClone(l);
  const f = fixture((cmd, args) => cmd === 'wallet_send_contract' ? args.to === TOKEN ? d.promise : H : ack());
  const first = f.payment.pay(l);
  assert.equal(f.payment.status(copy).busy, true); assert.equal(f.payment.discardable(copy), false);
  await fails(f.payment.pay(copy), 'shop_payment_busy'); await fails(f.payment.recover({ orderId: l.order.id, transactionHash: H }), 'shop_payment_busy');
  l.order.transferData = '0xffff'; l.order.escrow.contractAddress = TOKEN;
  d.resolve(A); await first;
  assert.equal(f.wallets()[1].args.to, CONTRACT); assert.equal(f.wallets()[1].args.data, '0xaabb');
  await fails(f.payment.pay(l), 'shop_payment_invalid'); await f.payment.pay(copy); assert.equal(f.wallets().length, 2);
});

test('validation and unsupported boundaries do not call wallet or Commerce', async () => {
  const changes = [
    (l) => l.order.gasPayer = 'merchant', (l) => delete l.order.escrow,
    (l) => delete l.order.gasPayer, (l) => l.order.assetKind = 'unknown',
    (l) => l.order.productId = 'different', (l) => l.order.quantity = 3, (l) => l.quantity = 0,
    (l) => l.quantity = 21, (l) => l.order.chainId = Number.MAX_SAFE_INTEGER + 1, (l) => l.order.chainId = 0,
    (l) => l.order.valueAtomic = '101', (l) => l.order.amountAtomic = '0', (l) => l.order.currency = '',
    (l) => l.order.escrow.contractAddress = `${CONTRACT.slice(0, -1)}\n`, (l) => l.order.transferData = '0xa\n',
    (l) => l.order.transferData = '0xabc', (l) => l.order.status = 'paid', (l) => l.order.transactionHash = H,
    (l) => l.order.expiresAt = 'not-a-date', (l) => l.order.accessToken = '', (l) => l.order.id = '../escape',
    (l) => l.order.assetKind = 'erc20', (l) => l.order.escrow.approval = { tokenContract: TOKEN, data: '0x00' },
  ];
  for (const change of changes) {
    const l = line(); change(l); const f = fixture();
    await assert.rejects(f.payment.pay(l), /shop_payment_(invalid|unsupported)/); assert.equal(f.calls.length, 0); assert.equal(f.payment.discardable(l), true);
  }
  for (const change of [(l) => l.order.valueAtomic = '1', (l) => l.order.escrow.approval.tokenContract = CONTRACT, (l) => l.order.escrow.approval.data = '0x0']) {
    const l = line(true); change(l); const f = fixture(); await fails(f.payment.pay(l), 'shop_payment_invalid'); assert.equal(f.calls.length, 0);
  }
});

test('expiry blocks every fresh signature, including deposit after delayed approval; sent recovery ignores expiry', async () => {
  const l = line(); l.order.expiresAt = '2000-01-01T00:00:00Z'; const f = fixture();
  await fails(f.payment.pay(l), 'shop_payment_expired'); assert.equal(f.calls.length, 0); assert.equal(f.payment.discardable(l), true);
  const original = Date.now; let now = original(); Date.now = () => now;
  try {
    const erc = line(true); erc.order.expiresAt = new Date(now + 1000).toISOString();
    const g = fixture((cmd) => { if (cmd === 'wallet_send_contract') { now += 2000; return A; } throw new Error('unexpected'); });
    await fails(g.payment.pay(erc), 'shop_payment_expired'); assert.equal(g.wallets().length, 1); assert.equal(g.payment.status(erc).approvalHash, A);
    const native = line(); native.order.expiresAt = new Date(now + 1000).toISOString(); let submitted = false;
    const h = fixture((cmd) => cmd === 'wallet_send_contract' ? H : cmd === 'commerce_order_status' ? ack('expired', null) : submitted ? ack() : (submitted = true, Promise.reject(new Error('down'))));
    await fails(h.payment.pay(native), 'down'); now += 2000; await h.payment.pay(native); assert.equal(h.wallets().length, 1);
  } finally { Date.now = original; }
});

test('restart recover uses keyring fallback, never wallet, and validates every accepted status/hash case', async () => {
  for (const state of ['submitted', 'paid', 'partially_refunded', 'refunded', 'payment_failed']) {
    const f = fixture(() => ack(state, `0x${'AB'.repeat(32)}`));
    assert.equal((await f.payment.recover({ orderId: 'order_1', transactionHash: H })).order.status, state);
    assert.deepEqual(f.calls, [{ command: 'commerce_order_status', args: { orderId: 'order_1', accessToken: '' } }]);
    await fails(f.payment.recover({ orderId: 'order_1', transactionHash: OTHER }), 'shop_payment_status_mismatch'); assert.equal(f.calls.length, 1);
  }
  for (const state of ['awaiting_payment', 'expired']) {
    const f = fixture((cmd) => cmd === 'commerce_order_status' ? ack(state, null) : ack());
    await f.payment.recover({ orderId: 'order_1', transactionHash: H }); assert.equal(f.wallets().length, 0);
    assert.deepEqual(f.calls[1], { command: 'commerce_order_submit', args: { orderId: 'order_1', accessToken: '', transactionHash: H } });
  }
});

test('recovery missing/null/mismatched/network state is not authoritative absence and cannot submit', async () => {
  for (const response of [null, {}, { order: { id: 'order_1', status: 'awaiting_payment' } }, ack('cancelled', null), ack('expired', ''), ack('submitted', OTHER), ack('submitted', H, 'other')]) {
    const f = fixture(() => response); await fails(f.payment.recover({ orderId: 'order_1', transactionHash: H }), 'shop_payment_status_mismatch'); assert.equal(f.calls.length, 1);
  }
  const f = fixture(() => { throw new Error('read_timeout'); }); await fails(f.payment.recover({ orderId: 'order_1', transactionHash: H }), 'shop_payment_recovery_unavailable'); assert.equal(f.calls.length, 1);
  for (const params of [null, {}, { orderId: '', transactionHash: H }, { orderId: 'x'.repeat(201), transactionHash: H }, { orderId: 'order/1', transactionHash: H }, { orderId: 'order_1', transactionHash: `${H}\n` }]) {
    const g = fixture(); await fails(g.payment.recover(params), 'shop_payment_invalid'); assert.equal(g.calls.length, 0);
  }
});

test('exact reserved presign errors before approval wait for explicit retry, then approve and deposit once', async () => {
  for (const code of reservedCodes) {
    for (const failure of [code, new Error(code)]) {
      const l = line(true); let count = 0;
      const f = fixture((command) => {
        if (command !== 'wallet_send_contract') return ack();
        if (++count === 1) throw failure;
        return count === 2 ? A : H;
      });
      await fails(f.payment.pay(l), code);
      assert.deepEqual(f.payment.status(l), { busy: false, attempted: true, unknown: false, transactionHash: null, approvalHash: null });
      assert.equal(f.calls.length, 1); assert.equal(f.payment.discardable(l), false);
      await Promise.resolve(); assert.equal(f.calls.length, 1);
      await f.payment.pay(structuredClone(l));
      assert.deepEqual(f.wallets().map((call) => call.args.to), [TOKEN, TOKEN, CONTRACT]);
    }
  }
});

test('exact reserved presign errors after successful approval retry only deposit and retain approval hash', async () => {
  for (const code of reservedCodes) {
    for (const failure of [code, new Error(code)]) {
      const l = line(true); let count = 0;
      const f = fixture((command) => {
        if (command !== 'wallet_send_contract') return ack();
        if (++count === 1) return A;
        if (count === 2) throw failure;
        return H;
      });
      await fails(f.payment.pay(l), code);
      assert.equal(l.approvalHash, A); assert.equal(f.payment.status(l).approvalHash, A);
      assert.equal(f.payment.status(l).unknown, false); assert.equal(f.payment.status(l).transactionHash, null);
      assert.equal(f.calls.length, 2);
      await f.payment.pay(l);
      assert.deepEqual(f.wallets().map((call) => call.args.to), [TOKEN, CONTRACT, CONTRACT]);
      assert.equal(f.payment.status(l).approvalHash, A);
    }
  }
});

test('presign lookalikes/nonstring objects or returned codes stay unknown and block all later wallet calls', async () => {
  for (const code of reservedCodes) {
    for (const failure of [`prefix_${code}`, `${code}_suffix`, `${code}\n`, ` ${code}`, code.toUpperCase(),
      new Error(`prefix_${code}`), new Error(`${code}\n`), { message: code }, { code }, new String(code), null, undefined]) {
      const l = line(true); const f = fixture(() => { throw failure; });
      await fails(f.payment.pay(l), 'shop_payment_unknown');
      assert.equal(f.payment.status(l).unknown, true);
      await fails(f.payment.pay(structuredClone(l)), 'shop_payment_unknown');
      assert.equal(f.calls.length, 1);
    }
    const l = line(); const f = fixture(() => code);
    await fails(f.payment.pay(l), 'shop_payment_unknown'); await fails(f.payment.pay(l), 'shop_payment_unknown');
    assert.equal(f.calls.length, 1);
  }
});

test('reserved-looking submit failure after deposit still recovers by status and same hash without wallet replay', async () => {
  for (const code of reservedCodes) {
    const l = line(); let submitted = false;
    const f = fixture((command) => {
      if (command === 'wallet_send_contract') return H;
      if (command === 'commerce_order_status') return ack('awaiting_payment', null);
      if (!submitted) { submitted = true; throw new Error(code); }
      return ack();
    });
    await fails(f.payment.pay(l), code); assert.equal(f.payment.status(l).transactionHash, H);
    await f.payment.pay(l);
    assert.equal(f.wallets().length, 1);
    assert.deepEqual(f.calls.map((call) => call.command), ['wallet_send_contract', 'commerce_order_submit', 'commerce_order_status', 'commerce_order_submit']);
    assert.equal(f.calls.at(-1).args.transactionHash, H);
  }
});

test('transfer and approval calldata preserve empty and exact32768 bytes, rejecting32769 before wallet', async () => {
  for (const approval of [false, true]) {
    for (const bytes of [0, 32768, 32769]) {
      const l = line(approval), calldata = `0x${'ab'.repeat(bytes)}`;
      if (approval) l.order.escrow.approval.data = calldata;
      else l.order.transferData = calldata;
      const f = fixture();
      if (bytes > 32768) {
        await fails(f.payment.pay(l), 'shop_payment_invalid');
        assert.equal(f.calls.length, 0);
        assert.equal(f.payment.discardable(l), true);
      } else {
        await f.payment.pay(l);
        assert.equal(f.wallets()[0].args.data, calldata);
        assert.equal(f.wallets().length, approval ? 2 : 1);
      }
    }
  }
});

const record = (transactionHash = H, chainId = 137) => ({ orderId: 'order_1', phase: 'payment', chainId, transactionHash });
const unknownInput = (onRecovered) => ({ orderId: 'order_1', chainId: 137, ...(onRecovered ? { onRecovered } : {}) });

test('reload recovery binds journal and retains hash before notification and Commerce; no wallet send', async () => {
  let f; const l = line();
  f = fixture((command) => command === 'wallet_recover_contract' ? record() : command === 'commerce_order_status' ? ack('expired', null) : ack());
  const result = await f.payment.recoverUnknown(unknownInput((value) => {
    assert.equal(value, H); assert.equal(f.payment.status(l).transactionHash, H); assert.equal(f.payment.status(l).unknown, false);
    assert.equal(f.calls.length, 1); assert.equal(f.payment.status(l).busy, true);
  }));
  assert.equal(result.transactionHash, H); assert.equal(f.wallets().length, 0);
  assert.deepEqual(f.calls, [
    { command: 'wallet_recover_contract', args: { orderId: 'order_1', phase: 'payment' } },
    { command: 'commerce_order_status', args: { orderId: 'order_1', accessToken: '' } },
    { command: 'commerce_order_submit', args: { orderId: 'order_1', accessToken: '', transactionHash: H } },
  ]);
  await f.payment.recoverUnknown(unknownInput());
  assert.equal(f.calls.filter((c) => c.command === 'wallet_recover_contract').length, 1);
  assert.equal(f.wallets().length, 0);
});

test('payment response loss recovers recorded hash using captured token, preserving completed approval and blocking repayment', async () => {
  let walletCount = 0; const l = line(true);
  const f = fixture((command) => {
    if (command === 'wallet_send_contract') { if (++walletCount === 1) return A; throw new Error('response_lost'); }
    if (command === 'wallet_recover_contract') return record();
    return ack('paid', `0x${'AB'.repeat(32)}`);
  });
  await fails(f.payment.pay(l), 'shop_payment_unknown'); assert.equal(f.payment.status(l).approvalHash, A);
  await f.payment.recoverUnknown(unknownInput());
  assert.equal(f.payment.status(l).unknown, false); assert.equal(f.payment.status(l).transactionHash, H); assert.equal(f.payment.status(l).approvalHash, A);
  assert.equal(f.calls.at(-1).args.accessToken, 'fixture-token');
  await f.payment.pay(l); assert.equal(f.wallets().length, 2);
});

test('missing payment record retains unknown even on explicit retry; approval-only record cannot authorize recovery', async () => {
  for (const response of [record(null, null), { ...record(A), phase: 'approval' }]) {
    const f = fixture(() => response); const expected = response.phase === 'payment' ? 'shop_payment_unknown' : 'shop_payment_status_mismatch';
    await fails(f.payment.recoverUnknown(unknownInput()), expected);
    assert.equal(f.payment.status(line()).unknown, true); assert.equal(f.payment.status(line()).transactionHash, null);
    assert.equal(f.payment.discardable(line()), false); await fails(f.payment.pay(line()), 'shop_payment_invalid');
    await fails(f.payment.recoverUnknown(unknownInput()), expected); assert.equal(f.wallets().length, 0);
    assert.ok(f.calls.every((c) => c.command === 'wallet_recover_contract'));
  }
});

test('journal errors and every malformed ID/phase/chain/hash binding block Commerce and preserve unknown', async () => {
  for (const response of [null, {}, [], { ...record(), orderId: 'other' }, { ...record(), phase: 'approval' }, record(H, 1), record(H, '137'),
    record(H, null), record(null, 137), record(`${H}\n`), { ...record(), extra: true }, { orderId: 'order_1', phase: 'payment', transactionHash: H }]) {
    const f = fixture(() => response); await fails(f.payment.recoverUnknown(unknownInput()), 'shop_payment_status_mismatch');
    assert.equal(f.calls.length, 1); assert.equal(f.payment.status(line()).unknown, true); assert.equal(f.payment.status(line()).transactionHash, null);
  }
  const f = fixture(() => { throw new Error('journal_read_failed'); });
  await fails(f.payment.recoverUnknown(unknownInput()), 'shop_payment_recovery_unavailable');
  assert.equal(f.calls.length, 1); assert.equal(f.payment.status(line()).unknown, true);
});

test('notification/storage failure retains recovered hash before any Commerce await, retry skips journal', async () => {
  const f = fixture((command) => command === 'wallet_recover_contract' ? record() : ack());
  await fails(f.payment.recoverUnknown(unknownInput(() => { throw new Error('persist_failed'); })), 'persist_failed');
  assert.equal(f.calls.length, 1); assert.equal(f.payment.status(line()).transactionHash, H); assert.equal(f.payment.status(line()).unknown, false);
  let notified = false;
  await f.payment.recoverUnknown(unknownInput((value) => { assert.equal(value, H); notified = true; }));
  assert.equal(notified, true); assert.equal(f.wallets().length, 0);
  assert.deepEqual(f.calls.map((c) => c.command), ['wallet_recover_contract', 'commerce_order_status']);
});

test('Commerce read/submit/invalid acknowledgement failure keeps recovered hash and never repeats journal or wallet send', async () => {
  for (const failure of ['read', 'submit', 'ack']) {
    let failed = false;
    const f = fixture((command) => {
      if (command === 'wallet_recover_contract') return record();
      if (command === 'commerce_order_status') {
        if (failure === 'read' && !failed) { failed = true; throw new Error('read_timeout'); }
        return ack('awaiting_payment', null);
      }
      if (!failed) { failed = true; if (failure === 'submit') throw new Error('submit_timeout'); if (failure === 'ack') return ack('submitted', OTHER); }
      return ack();
    });
    await fails(f.payment.recoverUnknown(unknownInput()), failure === 'read' ? 'shop_payment_recovery_unavailable' : failure === 'submit' ? 'submit_timeout' : 'shop_payment_status_mismatch');
    assert.equal(f.payment.status(line()).transactionHash, H); assert.equal(f.payment.status(line()).unknown, false);
    await f.payment.recoverUnknown(unknownInput());
    assert.equal(f.calls.filter((c) => c.command === 'wallet_recover_contract').length, 1); assert.equal(f.wallets().length, 0);
    assert.ok(f.calls.filter((c) => c.command === 'commerce_order_submit').every((c) => c.args.transactionHash === H));
  }
});

test('recovery busy lock spans journal lookup and callback; later chain changes fail before calls', async () => {
  const lookup = deferred(), notification = deferred();
  const f = fixture((command) => command === 'wallet_recover_contract' ? lookup.promise : ack());
  const pending = f.payment.recoverUnknown(unknownInput(() => notification.promise));
  await fails(f.payment.recoverUnknown(unknownInput()), 'shop_payment_busy');
  await fails(f.payment.recover({ orderId: 'order_1', transactionHash: H }), 'shop_payment_busy');
  lookup.resolve(record()); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.payment.status(line()).transactionHash, H);
  await fails(f.payment.recoverUnknown(unknownInput()), 'shop_payment_busy'); assert.equal(f.calls.length, 1);
  notification.resolve(); await pending;
  await fails(f.payment.recoverUnknown({ orderId: 'order_1', chainId: 1 }), 'shop_payment_status_mismatch'); assert.equal(f.calls.length, 2);
});

test('recoverUnknown validates opaque ID, safe chain and callback before all IPC', async () => {
  for (const input of [null, {}, { orderId: 'x'.repeat(201), chainId: 137 }, { orderId: '../x', chainId: 137 },
    { orderId: 'order_1', chainId: 0 }, { orderId: 'order_1', chainId: 1.5 }, { orderId: 'order_1', chainId: Number.MAX_SAFE_INTEGER + 1 },
    { orderId: 'order_1', chainId: '137' }, { ...unknownInput(), onRecovered: null }, { ...unknownInput(), onRecovered: true }]) {
    const f = fixture(); await fails(f.payment.recoverUnknown(input), 'shop_payment_invalid'); assert.equal(f.calls.length, 0);
  }
  const l = line(); const f = fixture(() => { throw new Error('lost'); }); await fails(f.payment.pay(l), 'shop_payment_unknown');
  await fails(f.payment.recoverUnknown({ orderId: 'order_1', chainId: 1 }), 'shop_payment_status_mismatch'); assert.equal(f.calls.length, 1);
});

test('captured payment chain rejects wrong-chain recovery after known hash or unknown send without any additional IPC', async () => {
  for (const lost of [false, true]) {
    const l = line();
    const f = fixture((command) => {
      if (command === 'wallet_send_contract') { if (lost) throw new Error('response_lost'); return H; }
      return ack();
    });
    if (lost) await fails(f.payment.pay(l), 'shop_payment_unknown');
    else await f.payment.pay(l);
    const before = f.calls.length; let notified = false;
    await fails(f.payment.recoverUnknown({ orderId: l.order.id, chainId: 1, onRecovered: () => { notified = true; } }), 'shop_payment_status_mismatch');
    assert.equal(f.calls.length, before); assert.equal(notified, false);
    assert.equal(f.payment.status(l).unknown, lost); assert.equal(f.payment.status(l).transactionHash, lost ? null : H);
    assert.equal(f.wallets().length, 1);
  }
});

const APPROVE100 = `0x095ea7b3${'0'.repeat(24)}${CONTRACT.slice(2)}${'0'.repeat(62)}64`;
const approvalLine = () => { const l = line(true); l.order.escrow.approval.data = APPROVE100; return l; };
const approvalProof = (status = 'ready', approvalHash = A) => ({ orderId: 'order_1', chainId: 137, approvalHash, status });

test('approval inspection is read-only, binds exact ABI/decimal amount and restores hash without claiming payment', async () => {
  const l = approvalLine(), f = fixture(() => approvalProof());
  assert.deepEqual(await f.payment.recoverApproval(l), { approvalHash: A });
  assert.deepEqual(f.calls, [{ command: 'wallet_check_approval', args: { orderId: 'order_1', chainId: 137,
    tokenContract: TOKEN, spender: CONTRACT, amountAtomic: '100', approvalData: APPROVE100 } }]);
  assert.equal(l.approvalHash, A); assert.equal(f.payment.status(l).approvalHash, A);
  assert.equal(f.payment.status(l).transactionHash, null); assert.equal(f.payment.status(l).unknown, false);
  assert.equal(f.payment.status(l).attempted, true); assert.equal(f.payment.discardable(l), false);
});

test('unknown approval recovers then explicit payment rechecks proof immediately before deposit, never reapproves', async () => {
  const l = approvalLine(); let checkCount = 0;
  const f = fixture((command, args) => {
    if (command === 'wallet_check_approval') { checkCount++; return approvalProof(); }
    if (command === 'wallet_send_contract') { if (args.recoveryPhase === 'approval') throw new Error('lost_approval_response'); return H; }
    return ack();
  });
  await fails(f.payment.pay(l), 'shop_payment_unknown');
  await f.payment.recoverApproval(l); assert.equal(f.wallets().length, 1);
  await f.payment.pay(l); assert.equal(checkCount, 2);
  assert.deepEqual(f.calls.map((c) => c.command), ['wallet_send_contract', 'wallet_check_approval', 'wallet_check_approval', 'wallet_send_contract', 'commerce_order_submit']);
  assert.deepEqual(f.wallets().map((c) => c.args.recoveryPhase), ['approval', 'payment']);
  await f.payment.pay(l); assert.equal(f.wallets().length, 2); assert.equal(checkCount, 2);
});

test('missing/pending/failed/insufficient approval proof never restores permission, submits, or retries automatically', async () => {
  for (const status of ['missing', 'pending', 'failed', 'insufficient']) {
    const l = approvalLine(), f = fixture(() => approvalProof(status, status === 'missing' ? null : A));
    await fails(f.payment.recoverApproval(l), 'shop_payment_unknown');
    assert.equal(f.payment.status(l).unknown, true); assert.equal(f.payment.status(l).approvalHash, null);
    await fails(f.payment.pay(l), 'shop_payment_unknown');
    assert.equal(f.calls.length, 1); assert.equal(f.wallets().length, 0);
  }
});

test('restored proof is invalidated by nonready recheck; retained hash cannot cause approval replay or deposit', async () => {
  for (const status of ['missing', 'pending', 'failed', 'insufficient']) {
    const l = approvalLine(); let count = 0;
    const f = fixture(() => ++count === 1 ? approvalProof() : approvalProof(status, status === 'missing' ? null : A));
    await f.payment.recoverApproval(l);
    await fails(f.payment.pay(l), 'shop_payment_unknown');
    assert.equal(f.payment.status(l).approvalHash, A); assert.equal(f.payment.status(l).unknown, true);
    await fails(f.payment.pay(l), 'shop_payment_unknown'); assert.equal(f.calls.length, 2); assert.equal(f.wallets().length, 0);
  }
});

test('rejected restored payment may explicitly retry only with a fresh ready proof; successful approval is never replayed', async () => {
  const l = approvalLine(); let paymentCalls = 0;
  const f = fixture((command) => {
    if (command === 'wallet_check_approval') return approvalProof();
    if (command === 'wallet_send_contract') { if (++paymentCalls === 1) throw 'wallet_user_rejected'; return H; }
    return ack();
  });
  await f.payment.recoverApproval(l); await fails(f.payment.pay(l), 'wallet_user_rejected');
  assert.equal(f.payment.status(l).unknown, false); assert.equal(f.payment.status(l).approvalHash, A);
  await f.payment.pay(l);
  assert.equal(f.calls.filter((c) => c.command === 'wallet_check_approval').length, 3);
  assert.ok(f.wallets().every((c) => c.args.recoveryPhase === 'payment'));
});

test('Native approval read errors and existing-payment block remain unknown with zero wallet sends', async () => {
  for (const cause of ['wallet_payment_record_exists', new Error('rpc_failed'), 'wallet_fee_unavailable']) {
    const l = approvalLine(), f = fixture(() => { throw cause; });
    await fails(f.payment.recoverApproval(l), 'shop_payment_recovery_unavailable');
    await fails(f.payment.pay(l), 'shop_payment_unknown'); assert.equal(f.calls.length, 1);
    assert.equal(f.payment.status(l).unknown, true);
  }
});

test('lost payment with a journal payment record cannot recover approval or broadcast another deposit', async () => {
  const l = approvalLine(); let walletCount = 0;
  const f = fixture((command) => {
    if (command === 'wallet_send_contract') { if (++walletCount === 1) return A; throw new Error('lost_payment_response'); }
    if (command === 'wallet_check_approval') throw 'wallet_payment_record_exists';
    throw new Error('unexpected_command');
  });
  await fails(f.payment.pay(l), 'shop_payment_unknown');
  assert.equal(f.payment.status(l).approvalHash, A);
  await fails(f.payment.recoverApproval(l), 'shop_payment_recovery_unavailable');
  await fails(f.payment.pay(l), 'shop_payment_unknown');
  assert.equal(f.payment.status(l).approvalHash, A); assert.equal(f.payment.status(l).unknown, true);
  assert.equal(f.wallets().length, 2); assert.equal(f.calls.length, 3);
});

test('closed approval proof fields and exact order/chain/hash/status are required, including unchanged restored hash', async () => {
  for (const response of [null, {}, [], { ...approvalProof(), orderId: 'other' }, { ...approvalProof(), chainId: '137' },
    { ...approvalProof(), chainId: 1 }, approvalProof('invented'), approvalProof('ready', null), approvalProof('missing', A),
    approvalProof('ready', `${A}\n`), { ...approvalProof(), extra: true }, { orderId: 'order_1', chainId: 137, status: 'ready' }]) {
    const l = approvalLine(), f = fixture(() => response);
    await fails(f.payment.recoverApproval(l), 'shop_payment_status_mismatch'); assert.equal(f.calls.length, 1);
    assert.equal(f.payment.status(l).unknown, true); assert.equal(f.payment.status(l).approvalHash, null);
  }
  let count = 0; const l = approvalLine(), f = fixture(() => ++count === 1 ? approvalProof() : approvalProof('ready', OTHER));
  await f.payment.recoverApproval(l); await fails(f.payment.pay(l), 'shop_payment_status_mismatch');
  assert.equal(f.payment.status(l).approvalHash, A); assert.equal(f.payment.status(l).unknown, true); assert.equal(f.wallets().length, 0);
});

test('exact approve selector, padded spender, amount and ABI width reject malformed/extra/unlimited data before IPC', async () => {
  for (const change of [
    (l) => l.order.escrow.approval.data = APPROVE100.replace('095ea7b3', 'a9059cbb'),
    (l) => l.order.escrow.approval.data = `${APPROVE100}00`, (l) => l.order.escrow.approval.data = APPROVE100.slice(0, -2),
    (l) => l.order.escrow.approval.data = APPROVE100.replace(CONTRACT.slice(2), TOKEN.slice(2)),
    (l) => l.order.escrow.approval.data = `${APPROVE100.slice(0, -64)}${'f'.repeat(64)}`,
    (l) => l.order.escrow.approval.data = `${APPROVE100.slice(0, -2)}65`,
    (l) => l.order.escrow.approval.data = `0x095ea7b3${'f'.repeat(24)}${CONTRACT.slice(2)}${'0'.repeat(62)}64`,
    (l) => l.order.escrow.approval.data = `${APPROVE100}\n`, (l) => l.order.amountAtomic = '0',
    (l) => l.order.amountAtomic = '340282366920938463463374607431768211456',
  ]) {
    const l = approvalLine(); change(l); const f = fixture();
    await fails(f.payment.recoverApproval(l), 'shop_payment_invalid'); assert.equal(f.calls.length, 0);
  }
  const native = fixture(); await fails(native.payment.recoverApproval(line()), 'shop_payment_unsupported'); assert.equal(native.calls.length, 0);
  const max = approvalLine(); max.order.amountAtomic = '340282366920938463463374607431768211455';
  max.order.escrow.approval.data = `${APPROVE100.slice(0, -64)}${'0'.repeat(32)}${'f'.repeat(32)}`;
  const valid = fixture(() => approvalProof()); await valid.payment.recoverApproval(max);
  assert.equal(valid.calls[0].args.amountAtomic, max.order.amountAtomic);
});

test('identity/chain/payment-hash guards block approval inspection before IPC', async () => {
  const l = approvalLine(), f = fixture((command) => command === 'wallet_check_approval' ? approvalProof() : command === 'wallet_send_contract' ? H : ack());
  await f.payment.recoverApproval(l);
  for (const change of [(copy) => copy.product.title = 'changed', (copy) => copy.order.chainId = 1, (copy) => copy.order.currency = 'other']) {
    const copy = structuredClone(l); change(copy); await fails(f.payment.recoverApproval(copy), 'shop_payment_status_mismatch');
    await fails(f.payment.pay(copy), 'shop_payment_invalid');
  }
  assert.equal(f.calls.length, 1); await f.payment.pay(l);
  const before = f.calls.length; await fails(f.payment.recoverApproval(l), 'shop_payment_status_mismatch'); assert.equal(f.calls.length, before);
});

test('deferred approval inspection shares busy lock with all recovery/pay paths and freezes checked arguments', async () => {
  const d = deferred(), l = approvalLine(), copy = structuredClone(l), f = fixture(() => d.promise);
  const pending = f.payment.recoverApproval(l);
  await fails(f.payment.recoverApproval(copy), 'shop_payment_busy'); await fails(f.payment.pay(copy), 'shop_payment_busy');
  await fails(f.payment.recoverUnknown(unknownInput()), 'shop_payment_busy');
  await fails(f.payment.recover({ orderId: 'order_1', transactionHash: H }), 'shop_payment_busy');
  l.order.escrow.approval.data = '0x';
  assert.equal(f.calls[0].args.approvalData, APPROVE100); d.resolve(approvalProof()); await pending;
  assert.equal(f.payment.status(copy).approvalHash, A); assert.equal(f.payment.status(copy).busy, false);
  await fails(f.payment.pay(l), 'shop_payment_invalid'); assert.equal(f.calls.length, 1);
});

test('expiry during restored readiness recheck blocks deposit after asynchronous read', async () => {
  const original = Date.now; let now = original(); Date.now = () => now;
  try {
    const l = approvalLine(); l.order.expiresAt = new Date(now + 1000).toISOString(); let count = 0;
    const f = fixture(() => { if (++count === 2) now += 2000; return approvalProof(); });
    await f.payment.recoverApproval(l); await fails(f.payment.pay(l), 'shop_payment_expired'); assert.equal(f.wallets().length, 0);
    assert.equal(f.payment.status(l).approvalHash, A);
  } finally { Date.now = original; }
});
