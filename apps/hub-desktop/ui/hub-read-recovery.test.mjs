import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createReadRecovery} from './hub-read-recovery.mjs';
test('retries transient reads three times, deduplicates and resets the budget',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let count=0;
  const r=createReadRecovery({retry:()=>count++});t.after(r.reset);
  for(const delay of [1000,3000,8000]){assert.equal(r.schedule('network_timeout'),true);r.schedule('network_timeout');t.mock.timers.tick(delay-1);await Promise.resolve();const before=count;t.mock.timers.tick(1);await Promise.resolve();assert.equal(count,before+1);}
  assert.equal(count,3);assert.equal(r.schedule('network_timeout'),false);
  r.reset();assert.equal(r.schedule('service_unavailable'),true);t.mock.timers.tick(1000);await Promise.resolve();assert.equal(count,4);
});
test('auth and invalid data are terminal; inactivity and reset cancel queued callbacks',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let count=0,active=true;
  const r=createReadRecovery({retry:()=>count++,active:()=>active});t.after(r.reset);
  for(const error of ['account_required','desktop_not_connected','invalid_response','source_limit'])assert.equal(r.schedule(error),false);
  r.schedule('network_unavailable');active=false;t.mock.timers.tick(1000);await Promise.resolve();assert.equal(count,0);
  active=true;r.reset();r.schedule('network_unavailable');t.mock.timers.tick(1000);r.reset();await Promise.resolve();assert.equal(count,0);
});
