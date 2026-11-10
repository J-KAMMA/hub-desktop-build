import test from 'node:test';
import assert from 'node:assert/strict';
import {orderCommunityMessages,communityPopularity,normalizeCommunityOrder,normalizeTopPeriod,COMMUNITY_ORDERS,TOP_PERIODS,POPULAR_WINDOW_MS} from './community-order.mjs';

const NOW=Date.parse('2026-11-08T12:00:00Z');
const ago=ms=>new Date(NOW-ms).toISOString();
const H=3600e3,D=24*H;
const m=(id,age,extra={})=>({id,kind:'chat',createdAt:ago(age),reactions:[],...extra});
const ids=list=>list.map(x=>x.id);

test('orders are 新着, 人気, トップ and default to latest',()=>{
  assert.deepEqual(COMMUNITY_ORDERS.map(([k])=>k),['latest','popular','top']);
  assert.equal(normalizeCommunityOrder('top'),'top');
  assert.equal(normalizeCommunityOrder(undefined),'latest');
  assert.equal(normalizeCommunityOrder('recommended'),'latest');
  assert.equal(normalizeCommunityOrder('popular'),'popular');
});
test('latest sorts newest first with a stable id tiebreak',()=>{
  const list=[m('a',3*H),m('b',H),m('c',2*H),m('d',2*H)];
  assert.deepEqual(ids(orderCommunityMessages(list,{now:NOW})),['b','d','c','a']);
});
test('popularity is replies*2 + likes + reposts',()=>{
  assert.equal(communityPopularity({engagement:{replyCount:3,repostCount:2},reactions:[{count:4},{count:1}]}),13);
  assert.equal(communityPopularity({}),0);
});
test('popular ranks by weight within 7 days and ties break by newest',()=>{
  const list=[
    m('quiet',H),
    m('replied',2*H,{engagement:{replyCount:2}}),                 // 4
    m('liked',3*H,{reactions:[{emoji:'❤️',count:4}]}),            // 4, older than replied
    m('old',8*D,{engagement:{replyCount:50}}),                    // outside window -> 0
    m('edge',POPULAR_WINDOW_MS-1,{reactions:[{count:9}]}),        // 9
  ];
  assert.deepEqual(ids(orderCommunityMessages(list,{order:'popular',now:NOW})),['edge','replied','liked','quiet','old']);
});
test('kind chips combine with both orders',()=>{
  const list=[m('c1',H,{kind:'chat',reactions:[{count:1}]}),m('q1',2*H,{kind:'question',reactions:[{count:5}]}),m('q2',H,{kind:'question'}),m('p1',H,{kind:'party'})];
  assert.deepEqual(ids(orderCommunityMessages(list,{kind:'question',now:NOW})),['q2','q1']);
  assert.deepEqual(ids(orderCommunityMessages(list,{kind:'question',order:'popular',now:NOW})),['q1','q2']);
  assert.equal(orderCommunityMessages(list,{kind:null,now:NOW}).length,4);
});
test('pinned posts stay first in either order',()=>{
  const list=[m('new',H),m('pin',5*D,{pinnedAt:ago(D)}),m('hot',2*H,{reactions:[{count:9}]})];
  assert.equal(orderCommunityMessages(list,{now:NOW})[0].id,'pin');
  assert.equal(orderCommunityMessages(list,{order:'popular',now:NOW})[0].id,'pin');
});
test('does not mutate the input and tolerates bad input',()=>{
  const list=[m('a',2*H),m('b',H)];const copy=[...list];
  orderCommunityMessages(list,{now:NOW});assert.deepEqual(list,copy);
  assert.deepEqual(orderCommunityMessages(null),[]);
});

test('items without kind fall back to type for the chip filter',()=>{
  const list=[m('u1',H,{kind:undefined,type:'question'}),m('u2',H,{kind:undefined,type:'chat'})];
  assert.deepEqual(ids(orderCommunityMessages(list,{kind:'question',now:NOW})),['u1']);
});

test('unified posts from posts_place carry their counts in counts{}',()=>{
  assert.equal(communityPopularity({counts:{replies:2,likes:3,reposts:1}}),8);
});

test('トップ ranks by reactions inside the period (今日 / 今週 / 今月 / すべて); outside counts 0; default is 今週',()=>{
  assert.deepEqual(TOP_PERIODS.map(([k])=>k),['day','week','month','all']);
  assert.equal(normalizeTopPeriod('year'),'week');
  const list=[m('today',2*H,{reactions:[{count:2}]}),m('weekold',3*D,{reactions:[{count:9}]}),m('monthold',20*D,{reactions:[{count:30}]}),m('ancient',400*D,{reactions:[{count:99}]})];
  const top=period=>ids(orderCommunityMessages(list,{order:'top',period,now:NOW}));
  assert.deepEqual(top('day'),['today','weekold','monthold','ancient']);
  assert.deepEqual(top('week').slice(0,2),['weekold','today']);
  assert.deepEqual(top('month').slice(0,3),['monthold','weekold','today']);
  assert.deepEqual(top('all'),['ancient','monthold','weekold','today']);
  assert.deepEqual(top(undefined).slice(0,2),['weekold','today']);
  assert.deepEqual(ids(orderCommunityMessages(list,{order:'popular',now:NOW})).slice(0,2),['weekold','today'],'人気 stays 7 days');
});
