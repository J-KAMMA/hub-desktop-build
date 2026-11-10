import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import * as panels from './rail-panels.mjs';
import {createRailSubTabs} from './rail-subtabs.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const app=readFileSync(new URL('./app.js',import.meta.url),'utf8');
const RAIL_VIEWS=JSON.parse(app.match(/const RAIL_VIEWS = (\[.*?\]);/)[1]);
const doc=new JSDOM(html).window.document;
const dom=t=>{const w=new JSDOM('<!doctype html><body></body>').window;t.after(()=>w.close());return w.document;};

test('rail marks: notifications, messages, timeline, music, video on top; browser, AI, wallet in the bottom group (calls has no mark yet)',()=>{
 const order=[...doc.querySelectorAll('.rail-marks .rail-view-button')].map(b=>b.dataset.railView).filter(v=>v!=='search');
 assert.deepEqual(order,['notifications','messages','posts','music','video','browser','ai','wallet']);
 assert.equal(doc.querySelector('.rail-marks .rail-view-button[data-rail-view="posts"]').getAttribute('aria-label'),'タイムライン');
 assert.ok(doc.querySelector('.rail-mark--bottom[data-rail-view="browser"]'),'the bottom group starts at the browser mark');
 const all=[...doc.querySelectorAll('.rail-marks .rail-view-button')].map(b=>b.dataset.railView);
 assert.ok(all.indexOf('browser')>all.indexOf('video'),'browser, AI and wallet come after the top group');
 assert.equal(doc.querySelectorAll('.rail-mark--bottom').length,1);
 assert.ok(!doc.querySelector('[data-rail-view="calls"]'),'no calls panel until a calls feature exists');
 assert.match(html,/通話: 通話の機能がまだ無い/);
 for(const button of doc.querySelectorAll('.rail-marks .rail-mark'))assert.ok(button.getAttribute('aria-label'),'every mark has an aria-label');
});

test('every rail mark has a panel and app.js knows it',()=>{
 for(const button of doc.querySelectorAll('.rail-marks .rail-view-button')){
  const name=button.dataset.railView;
  assert.ok(doc.querySelector(`section.rail-view[data-rail-view="${name}"]`),`panel ${name}`);
  assert.ok(RAIL_VIEWS.includes(name),`RAIL_VIEWS has ${name}`);
 }
});

test('messages hold DM and mail behind one switch, each on its own data path',t=>{
 assert.ok(doc.querySelector('[data-rail-view="messages"] #rail-messages-tabs'));
 assert.ok(doc.querySelector('[data-rail-view="messages"] #rail-messages'));
 assert.ok(doc.querySelector('[data-rail-view="messages"] #rail-mail[hidden]'));
 assert.match(app,/invoke\("mail_messages", \{ folder: "inbox"/);
 assert.match(app,/invoke\("hub_client", \{ name: "conversations" \}\)/);
 const document=dom(t),seen=[];
 const tabs=createRailSubTabs(document,{label:'x',tabs:[['dm','DM'],['mail','メール']],selected:'dm',onSelect:k=>seen.push(k)});
 document.body.append(tabs.element);
 const [dm,mail]=tabs.element.querySelectorAll('[role=tab]');
 assert.equal(dm.getAttribute('aria-selected'),'true');assert.equal(mail.tabIndex,-1);
 mail.click();assert.deepEqual(seen,['mail']);assert.equal(mail.getAttribute('aria-selected'),'true');
 mail.click();assert.deepEqual(seen,['mail'],'re-selecting does not notify');
 mail.dispatchEvent(new document.defaultView.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
 assert.deepEqual(seen,['mail','dm'],'arrow keys wrap and select');
 tabs.set('mail');assert.deepEqual(seen,['mail','dm'],'set() is silent');
});

test('mail rows: sender, subject, unread dot only for unopened inbound; empty state',t=>{
 const document=dom(t),opened=[];
 const rows=panels.railMailRows(document,{messages:[
  {id:'m1',direction:'inbound',sender:'a@example.com',subject:'こんにちは',createdAt:'2026-10-17T11:00:00Z',readAt:null},
  {id:'m2',direction:'outbound',recipient:'b@example.com',subject:'',createdAt:'2026-10-17T10:00:00Z'},
  {subject:'no id'}]},{relTime:()=>'1時間前',onOpen:(item,row)=>opened.push([item.id,row])});
 assert.equal(rows.length,2);
 assert.equal(rows[0].querySelector('strong').textContent,'a@example.com');
 assert.equal(rows[0].querySelector('.rail-item-text').textContent,'こんにちは');
 assert.ok(rows[0].querySelector('.rail-row-dot'));
 assert.equal(rows[1].querySelector('strong').textContent,'宛先: b@example.com');
 assert.equal(rows[1].querySelector('.rail-item-text').textContent,'（件名なし）');
 assert.equal(rows[1].querySelector('.rail-row-dot'),null);
 rows[0].click();assert.equal(opened[0][0],'m1');assert.equal(opened[0][1],rows[0]);
 assert.equal(panels.railMailRows(document,{messages:[]},{relTime(){return '';},onOpen(){}})[0].classList.contains('rail-empty'),true);
});
