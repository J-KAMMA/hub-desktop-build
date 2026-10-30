import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import * as panels from './rail-panels.mjs';
const {JSDOM}=createRequire(new URL('../../../package.json',import.meta.url))('jsdom');
const NOW=Date.parse('2026-10-17T12:00:00Z');
const relTime=value=>panels.railRelativeTime(value,NOW);
function dom(t){const window=new JSDOM('<!doctype html><body></body>').window;t.after(()=>window.close());return window.document;}
const texts=(nodes,selector)=>nodes.flatMap(node=>[...node.querySelectorAll(selector)].map(item=>item.textContent));

test('relative time and counts read plainly',()=>{
 assert.equal(relTime('2026-10-17T11:59:40Z'),'たった今');
 assert.equal(relTime('2026-10-17T11:55:00Z'),'5分前');
 assert.equal(relTime('2026-10-17T09:00:00Z'),'3時間前');
 assert.equal(relTime('2026-10-15T12:00:00Z'),'2日前');
 assert.equal(relTime('nope'),'');
 assert.equal(panels.railCount(0),'');assert.equal(panels.railCount(3),'3');assert.equal(panels.railCount(250),'99+');assert.equal(panels.railCount(-1),'');
});

test('avatars load only Hub-relative images and fall back to an initial',t=>{
 const document=dom(t),seen=[];const asset=(img,url)=>seen.push(url);
 assert.equal(panels.railAvatar(document,{name:'さくら',url:'/avatars/a.png',asset}).querySelector('img')?.alt,'');
 assert.deepEqual(seen,['/avatars/a.png']);
 for(const url of ['https://evil.example/a.png','//evil.example/a.png','/a\\b'])assert.equal(panels.railAvatar(document,{name:'bob',url,asset}).textContent,'B');
 assert.equal(seen.length,1);
 assert.ok(panels.railAvatar(document,{icon:'bell'}).querySelector('svg'));
});

test('posts: avatar, name, relative time, body; selecting calls the reader with the row',t=>{
 const document=dom(t),opened=[];
 const rows=panels.railPostRows(document,[{id:'p1',authorName:'Aki',body:'hello',createdAt:'2026-10-17T11:00:00Z'},{body:'no id'}],{relTime,asset:()=>{},onOpen:(post,row)=>opened.push([post.id,row])});
 assert.equal(rows.length,1);
 assert.deepEqual(texts(rows,'.rail-item-head strong, .rail-item-head .meta, .rail-item-text'),['Aki','1時間前','hello']);
 assert.equal(rows[0].getAttribute('aria-expanded'),'false');
 assert.equal(rows[0].querySelector('.rail-row-facts'),null,'no counts → no facts line');
 const counted=panels.railPostRows(document,[{id:'p2',authorName:'Aki',body:'',createdAt:'2026-10-17T11:00:00Z',likeCount:1200,replyCount:0,images:[{},{}]}],{relTime,asset:()=>{},onOpen(){}});
 assert.equal(counted[0].querySelector('.rail-row-facts').textContent,'いいね 1,200 · 画像 2枚');
 assert.equal(counted[0].querySelector('.rail-item-text').textContent,'（画像のみ）');
 rows[0].click();assert.equal(opened[0][0],'p1');assert.equal(opened[0][1],rows[0]);
 const empty=panels.railPostRows(document,[],{relTime,onOpen(){}});
 assert.equal(empty[0].querySelector('strong').textContent,'公開投稿はまだありません');
});

test('notifications: unread dots, unread summary and a mark-all action that respects pending',t=>{
 const document=dom(t),calls=[];
 const data={unreadCount:1,actors:[{id:'a1',displayName:'Mio'}],notifications:[
  {id:'n1',isRead:false,actorProfileId:'a1',createdAt:'2026-10-17T11:58:00Z',text:'返信しました'},
  {id:'n2',isRead:true,createdAt:'2026-10-16T10:00:00Z',text:'お知らせ'}]};
 const groups=items=>items.map(item=>({latest:item,items:[item],actorIds:item.actorProfileId?[item.actorProfileId]:[],isRead:item.isRead}));
 const options={groups,textOf:group=>group.latest.text,relTime,asset:()=>{},onOpen:group=>calls.push(['open',group.latest.id]),onMarkAll:()=>calls.push(['all'])};
 const nodes=panels.railNotificationNodes(document,data,options);
 assert.equal(nodes[0].querySelector('.meta').textContent,'未読 1件');
 const rows=nodes.slice(1);
 assert.deepEqual(rows.map(row=>row.classList.contains('is-unread')),[true,false]);
 assert.ok(rows[0].querySelector('.rail-row-dot'));assert.ok(rows[1].querySelector('.rail-row-avatar svg'),'actorless rows use the bell');
 assert.match(rows[0].getAttribute('aria-label'),/^未読 Mio/);
 assert.equal(rows[0].querySelector('.rail-row-kind')?.className,'rail-row-kind rail-row-kind--bell','an untyped notification gets the bell badge');
 const liked=panels.railNotificationNodes(document,{unreadCount:0,actors:[{id:'a1',displayName:'Mio'},{id:'a2',displayName:'Ken'}],notifications:[{id:'n3',type:'social_reaction',isRead:true,actorProfileId:'a1',createdAt:'2026-10-17T11:00:00Z',text:'いいねしました'}]},{...options,groups:items=>[{latest:items[0],items,actorIds:['a1','a2'],isRead:true}]});
 assert.equal(liked[1].querySelector('.rail-item-head strong').textContent,'Mio ほか1人');
 assert.ok(liked[1].querySelector('.rail-row-kind--heart'));
 nodes[0].querySelector('button').click();rows[0].click();
 assert.deepEqual(calls,[['all'],['open','n1']]);
 assert.ok(panels.railNotificationNodes(document,data,{...options,pending:true})[0].querySelector('button').disabled);
 assert.ok(panels.railNotificationNodes(document,data,{...options,canMark:false})[0].querySelector('button').disabled);
 assert.ok(panels.railNotificationNodes(document,{...data,unreadCount:0},options)[0].querySelector('button').disabled);
 assert.equal(panels.railNotificationNodes(document,{notifications:[]},options)[0].querySelector('strong').textContent,'通知はありません');
});

test('messages: newest conversation first, last line and an unread count for the viewer only',t=>{
 const document=dom(t),opened=[];
 const data={currentProfileId:'me',profiles:[{id:'x',displayName:'Ren'},{id:'y',displayName:'Yu'}],
  conversations:[{id:'c1',participantIds:['me','x'],unreadCountByProfileId:{me:2,x:0}},{id:'c2',participantIds:['me','y'],unreadCountByProfileId:{y:5}}],
  messages:[{conversationId:'c1',createdAt:'2026-10-17T10:00:00Z',previewText:'またね'},{conversationId:'c2',createdAt:'2026-10-17T11:00:00Z',images:[{}]}]};
 const peerOf=(conversation,profiles,self)=>profiles.get(conversation.participantIds.find(id=>id!==self));
 const rows=panels.railConversationRows(document,data,{peerOf,relTime,asset:()=>{},onOpen:(conversation,peer,message,row)=>opened.push([conversation.id,row])});
 assert.deepEqual(texts(rows,'.rail-item-head strong'),['Yu','Ren']);
 assert.deepEqual(texts(rows,'.rail-item-text'),['（画像）','またね']);
 assert.equal(rows[0].querySelector('.rail-row-count'),null,'another participant’s unread count is not ours');
 assert.equal(rows[1].querySelector('.rail-row-count').textContent,'2');
 rows[1].click();assert.equal(opened[0][0],'c1');assert.equal(opened[0][1],rows[1]);
 assert.equal(panels.railConversationRows(document,{conversations:[]},{peerOf,relTime})[0].querySelector('strong').textContent,'会話はまだありません');
});

test('communities: joined first, then public; banned is not joined; no invented unread counts',t=>{
 const document=dom(t),opened=[];
 const data={communities:[{id:'a',name:'写真部',memberCount:12,category:'趣味'},{id:'b',name:'読書会'},{id:'c',name:'追放'}],
  memberships:[{communityId:'a',status:'active'},{communityId:'c',status:'banned'}]};
 const nodes=panels.railCommunityNodes(document,data,{asset:()=>{},signedIn:true,onOpen:(item,row)=>opened.push([item.id,row])});
 assert.deepEqual(nodes.map(node=>node.querySelector('h3')?.textContent??node.querySelector('strong')?.textContent),['参加中 · 1','写真部','公開コミュニティ','読書会','追放']);
 assert.ok(nodes[1].querySelector('.rail-item-text').textContent.startsWith('趣味 · 12人'));
 assert.equal(nodes.filter(node=>node.querySelector('.rail-row-count')).length,0);
 nodes[1].click();assert.equal(opened[0][0],'a');assert.equal(opened[0][1],nodes[1]);
 const signedOut=panels.railCommunityNodes(document,{communities:[{id:'b',name:'読書会'}]},{onOpen(){},connect:()=>opened.push('connect')});
 assert.ok(signedOut[0].classList.contains('rail-state--signedOut'));signedOut[0].querySelector('button').click();assert.equal(opened.at(-1),'connect');
 assert.equal(panels.railCommunityNodes(document,{},{onOpen(){}})[0].querySelector('strong').textContent,'公開コミュニティはまだありません');
});

test('states: loading skeleton is a status, errors are alerts, signed-out offers to connect',t=>{
 const document=dom(t);let connected=0;
 assert.equal(panels.railState(document,'loading').getAttribute('role'),'status');
 assert.equal(panels.railState(document,'error',{title:'x'}).getAttribute('role'),'alert');
 for(const name of ['notifications','messages']){const node=panels.railSignedOut(document,name,()=>connected++);node.querySelector('button').click();assert.ok(node.querySelector('strong').textContent.startsWith('接続すると'));}
 assert.equal(connected,2);
});

test('now playing forwards to the existing player controls only',t=>{
 const document=dom(t),calls=[];
 const card=panels.railNowPlaying(document,{track:{title:'曲',artist:'人'},paused:true,controls:[{glyph:'⏮',disabled:true,label:'前の曲',onClick:()=>calls.push('prev')},{glyph:'▶',primary:true,label:'再生',onClick:()=>calls.push('toggle')}]});
 assert.equal(card.querySelector('.rail-now-state').textContent,'一時停止中');
 const buttons=card.querySelectorAll('button');assert.ok(buttons[0].disabled);assert.ok(buttons[1].classList.contains('is-primary'));buttons[1].click();
 assert.deepEqual(calls,['toggle']);assert.equal(card.querySelector('iframe, video'),null);
});

test('the module and its stylesheet stay inside the colour and wallet rules',()=>{
 const css=readFileSync(new URL('./rail-panels.css',import.meta.url),'utf8').replace(/\/\*[\s\S]*?\*\//g,'');
 assert.doesNotMatch(css,/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|(?<![-\w])(white|black)(?![-\w])/i);
 const source=readFileSync(new URL('./rail-panels.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/swap|bridge|exchange|スワップ|両替|ブリッジ/i);
 assert.doesNotMatch(source,/innerHTML/);
 const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
 assert.match(html,/href="\.\/rail-panels\.css"/);
});
