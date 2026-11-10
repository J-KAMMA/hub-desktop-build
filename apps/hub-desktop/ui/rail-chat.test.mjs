import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createRailChat,publicChatMessages,privateChatMessages} from './rail-chat.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const dom=t=>{const w=new JSDOM('<!doctype html><body></body>').window;t.after(()=>w.close());return w.document;};
const tick=()=>new Promise(r=>setTimeout(r,0));
const flush=async()=>{for(let i=0;i<5;i++)await tick();};

const communityData=(extra=[])=>({viewerProfileId:'me',profiles:{me:{displayName:'私'},u1:{displayName:'Aki',handle:'aki'}},
 messages:[{id:'m2',authorProfileId:'u1',body:'二番目',createdAt:'2026-11-05T10:00:00Z',kind:'chat'},
  {id:'m1',authorProfileId:'me',body:'最初',createdAt:'2026-11-05T09:00:00Z',kind:'chat'},...extra]});
const dmData=(extra=[])=>({currentProfileId:'me',profiles:[{id:'me',displayName:'私'},{id:'u1',displayName:'Aki'}],
 messages:[{id:'d1',conversationId:'g1',senderProfileId:'u1',createdAt:'2026-11-05T09:00:00Z',previewText:'こんにちは'},
  {id:'d2',conversationId:'g1',senderProfileId:'me',createdAt:'2026-11-05T09:05:00Z',previewText:''},
  {id:'x',conversationId:'other',senderProfileId:'u1',createdAt:'2026-11-05T09:06:00Z',previewText:'別の会話'},...extra]});

test('public messages become chat lines oldest first with own lines marked',()=>{
 const lines=publicChatMessages(communityData());
 assert.deepEqual(lines.map(l=>l.id),['m1','m2']);
 assert.equal(lines[0].own,true);assert.equal(lines[1].name,'Aki');
 assert.deepEqual(publicChatMessages(null),[]);
});

test('private messages keep only the open conversation and never invent decrypted text',()=>{
 const lines=privateChatMessages(dmData(),'g1');
 assert.deepEqual(lines.map(l=>l.id),['d1','d2']);
 assert.equal(lines[0].text,'こんにちは');
 assert.match(lines[1].text,/暗号化/);
 assert.equal(lines[1].own,true);
});

function build(t,{data=communityData(),calls=[]}={}){
 const document=dom(t);
 let current=data;
 const invoke=async(name,args)=>{calls.push([name,args]);
  if(name==='hub_detail')return current;
  if(name==='hub_client')return current;
  throw new Error('unexpected '+name);};
 const central=[];
 const chat=createRailChat({document,invoke,deps:{relTime:()=>'1時間前',hubAsset(){},icon:n=>`<svg data-icon="${n}"></svg>`,paintAvatar(){},friendlyError:e=>String(e?.message??e),openCentral:g=>central.push(g.id)}});
 document.body.append(chat.element);
 return {document,chat,calls,central,set:v=>{current=v;}};
}

test('public group: chat stream, newest at the bottom, no lock',async t=>{
 const ctx=build(t);
 await ctx.chat.open({kind:'public',id:'c1',title:'写真クラブ',count:50});
 assert.equal(ctx.chat.isOpen,true);
 assert.deepEqual(ctx.calls.find(c=>c[1].name==='community_posts_kind'),['hub_detail',{name:'community_posts_kind',ids:['c1','chat']}]);
 const items=[...ctx.document.querySelectorAll('.rail-chat-msg')];
 assert.deepEqual(items.map(i=>i.dataset.messageId),['m1','m2']);
 assert.ok(items[0].classList.contains('is-own'));
 assert.equal(ctx.document.querySelector('.rail-chat-lock').hidden,true);
 assert.equal(ctx.document.querySelector('.rail-chat-sub').textContent,'50人');
});

test('private group: lock mark shown, read through the DM path only',async t=>{
 const ctx=build(t,{data:dmData()});
 await ctx.chat.open({kind:'private',id:'g1',title:'A、B',count:4});
 assert.equal(ctx.document.querySelector('.rail-chat-lock').hidden,false);
 assert.equal(ctx.document.querySelector('.rail-chat-lock').getAttribute('aria-label'),'非公開');
 assert.deepEqual(ctx.calls.map(c=>c[0]),['hub_client']);
 assert.equal(ctx.document.querySelectorAll('.rail-chat-msg').length,2);
 assert.equal(ctx.document.querySelector('.rail-chat-compose').hidden,false,'private groups can be written to from the rail');
});

test('refresh appends only new messages at the bottom and keeps earlier nodes',async t=>{
 const ctx=build(t);
 await ctx.chat.open({kind:'public',id:'c1',title:'x',count:null});
 const first=ctx.document.querySelector('.rail-chat-msg');
 ctx.set(communityData([{id:'m3',authorProfileId:'u1',body:'新着',createdAt:'2026-11-05T11:00:00Z',kind:'chat'}]));
 await ctx.chat.refresh();
 const ids=[...ctx.document.querySelectorAll('.rail-chat-msg')].map(i=>i.dataset.messageId);
 assert.deepEqual(ids,['m1','m2','m3']);
 assert.equal(ctx.document.querySelector('.rail-chat-msg'),first);
 await ctx.chat.refresh();
 assert.equal(ctx.document.querySelectorAll('.rail-chat-msg').length,3,'no duplicates');
});

test('empty and failing groups say so; retry reloads',async t=>{
 const ctx=build(t,{data:{messages:[]}});
 await ctx.chat.open({kind:'public',id:'c1',title:'x',count:null});
 assert.match(ctx.document.querySelector('.rail-chat-status').textContent,/まだ書き込みはありません/);
 const document=dom(t);let fail=true;
 const chat=createRailChat({document,invoke:async()=>{if(fail)throw new Error('boom');return communityData();},deps:{relTime:()=>'',hubAsset(){},icon:()=>'',paintAvatar(){},friendlyError:e=>e.message,openCentral(){}}});
 document.body.append(chat.element);
 await chat.open({kind:'public',id:'c',title:'t',count:null});
 assert.match(document.querySelector('.rail-chat-status').textContent,/boom/);
 fail=false;document.querySelector('.rail-chat-retry').click();await flush();
 assert.equal(document.querySelectorAll('.rail-chat-msg').length,2);
});

test('back and write controls call out; close clears the stream',async t=>{
 const ctx=build(t);
 let backed=0;ctx.chat.onBack(()=>backed++);
 await ctx.chat.open({kind:'public',id:'c1',title:'x',count:null});
 ctx.document.querySelector('.rail-chat-back').click();assert.equal(backed,1);
 ctx.document.querySelector('.rail-chat-open').click();assert.deepEqual(ctx.central,['c1']);
 ctx.chat.close();
 assert.equal(ctx.chat.isOpen,false);assert.equal(ctx.document.querySelectorAll('.rail-chat-msg').length,0);
 assert.equal(ctx.chat.group,null);
});

test('the module reads no keys of the other side: public never touches conversations, private never touches community detail',()=>{
 const src=readFileSync(new URL('./rail-chat.mjs',import.meta.url),'utf8');
 assert.match(src,/group\.kind === "private"[\s\S]*conversations[\s\S]*community_posts/);
 assert.ok(!/localStorage|sessionStorage|send_message/.test(src),'drafts stay in memory and private sends go only through dm-controller');
 assert.match(src,/createDmController/);
});

const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const app=readFileSync(new URL('./app.js',import.meta.url),'utf8');
const css=readFileSync(new URL('./rail-timeline.css',import.meta.url),'utf8');

test('wiring: the chat mounts beside the timeline and opens for groups inside the rail',()=>{
 const doc=new JSDOM(html).window.document;
 assert.ok(doc.querySelector('section[data-rail-view="posts"] #rail-timeline'));
 assert.ok(doc.querySelector('section[data-rail-view="posts"] #rail-chat'));
 assert.match(app,/openGroup: \(group, row\) => void openRailGroup\(group, row\)/);
 assert.match(app,/function openRailGroup\(group\) \{[\s\S]*railNav\.visit\("posts", "g"[\s\S]*showRailChat\(group\)/);
 assert.match(app,/railNav\.handle\("posts", \(entry\) => \{[\s\S]*entry\.data\?\.group[\s\S]*showRailChat/);
 assert.match(app,/railChat\.isOpen \? railChat\.refresh\(\) : railTimeline\.refresh\(\)/,'refresh button follows the open chat');
 assert.match(app,/hub-account-changed", \(\) => hideRailChat\(\)/,'private chat is dropped on account change');
});

test('wiring: opening in the center goes to the community detail or the DM conversation',()=>{
 assert.match(app,/openCentral: \(group\) => group\.kind === "private"\s*\? navigateFrom\([\s\S]*openConversation\(group\.id\)\)\s*: openDetail\("community"/);
});

test('rail-only strings: the rail says グループ, not コミュニティ, in the timeline switch and chat',()=>{
 const tl=readFileSync(new URL('./rail-timeline.mjs',import.meta.url),'utf8')+readFileSync(new URL('./rail-chat.mjs',import.meta.url),'utf8');
 assert.ok(!/コミュニティ/.test(tl.split('\n').filter(l=>!l.trim().startsWith('//')).join('\n')),'user-facing strings in the rail modules avoid コミュニティ');
 assert.match(css,/\.rail-tl\[hidden\], \.rail-chat\[hidden\] \{ display: none; \}/);
});
