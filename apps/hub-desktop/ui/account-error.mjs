// Account-service availability, kept apart from "this device is not enrolled".
// "desktop_not_connected" (and its signed-out / unauthorized relatives) means the
// user has to connect. An unreachable or failing Account service does not.
export const ACCOUNT_UNAVAILABLE_TEXT = 'アカウントのサービスに接続できません。しばらくしてから再試行してください。';
const UNAVAILABLE = new Set([
  'desktop_account_unavailable',
  'desktop_account_network_unavailable',
  'desktop_account_request_failed',
  'desktop_account_response_invalid',
  'desktop_account_response_too_large',
  'account_service_unavailable',
]);
const code = error => {
  const value = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  return typeof value === 'string' ? value : '';
};
export function isAccountUnavailable(error) {
  const value = code(error);
  return UNAVAILABLE.has(value) || [...UNAVAILABLE].some(item => value.includes(item));
}
export function accountStateLabel({ registered, pending, expired, fault }) {
  if (registered) return fault ? '接続済み（アカウントのサービスに接続できません）' : '接続済み';
  return pending ? '承認待ち' : expired ? '期限切れ' : '未接続';
}
