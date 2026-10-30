import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_UNAVAILABLE_TEXT, accountStateLabel, isAccountUnavailable } from './account-error.mjs';

test('account outages are recognised, enrolment failures are not', () => {
  for (const value of ['desktop_account_unavailable', 'desktop_account_network_unavailable', 'account_service_unavailable', new Error('desktop_account_unavailable')])
    assert.equal(isAccountUnavailable(value), true);
  for (const value of ['desktop_not_connected', 'desktop_account_not_registered', 'desktop_account_unauthorized', 'desktop_account_signed_out', '', undefined])
    assert.equal(isAccountUnavailable(value), false);
  assert.match(ACCOUNT_UNAVAILABLE_TEXT, /接続できません/);
});

test('settings label does not claim a clean connection after a failed check', () => {
  assert.equal(accountStateLabel({ registered: true, fault: false }), '接続済み');
  assert.equal(accountStateLabel({ registered: true, fault: true }), '接続済み（アカウントのサービスに接続できません）');
  assert.equal(accountStateLabel({ registered: false, pending: true, fault: true }), '承認待ち');
  assert.equal(accountStateLabel({ registered: false, expired: true }), '期限切れ');
  assert.equal(accountStateLabel({ registered: false }), '未接続');
});
