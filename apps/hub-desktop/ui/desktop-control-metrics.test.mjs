import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopControlMetrics} from './desktop-control-metrics.mjs';
import {readFile} from 'node:fs/promises';
const expectedPhases = ['workspace', 'agents', 'attach', 'lastSession', 'feed', 'node', 'games', 'browserFetch', 'browserRender', 'browserRefresh', 'feedReadyWait', 'feedLocal', 'feedConnected', 'feedDistributed', 'feedFederated', 'lastSessionRead', 'historyRender', 'workHistory'];
const expectedMarks = ['moduleReady', 'uiWired', 'feedReady', 'startupComplete', 'feedApplied', 'feedSuperseded', 'feedFailed'];

test('navigation origin marks and independent phases contain only bounded numeric DTO fields',()=>{
 let now=25;const metrics=createDesktopControlMetrics({now:()=>now});metrics.mark('moduleReady');now=50;metrics.mark('uiWired');const done=metrics.begin('feed');now=125;done();done();metrics.mark('feedReady');metrics.mark('feedReady');now=140;metrics.mark('startupComplete');
 const value=metrics.snapshot();assert.deepEqual(Object.keys(value),['elapsedMs','phases','marks']);assert.equal(value.elapsedMs,140);assert.deepEqual(value.marks,[{name:'moduleReady',atMs:25},{name:'uiWired',atMs:50},{name:'feedReady',atMs:125},{name:'startupComplete',atMs:140}]);assert.equal(value.phases.length,18);assert.deepEqual(value.phases.map(p=>p.name),expectedPhases);assert.deepEqual(value.phases.find(p=>p.name==='feed'),{name:'feed',calls:1,totalMs:75,busyMs:75,inFlight:0});
 assert.ok(value.phases.every(p=>Object.keys(p).join(',')==='name,calls,totalMs,busyMs,inFlight'));for(const name of expectedMarks)metrics.mark(name);assert.deepEqual(metrics.snapshot().marks,[...value.marks,...expectedMarks.slice(4).map(name=>({name,atMs:140}))]);assert.deepEqual(metrics.snapshot().marks.map(m=>m.name),expectedMarks);
 value.phases[0].totalMs=1234;value.marks[0].atMs=999;assert.equal(metrics.snapshot().phases[0].totalMs,0);assert.equal(metrics.snapshot().marks[0].atMs,25);
});
test('unknown/prototype/content names cannot expand or leak into snapshot',()=>{
 const metrics=createDesktopControlMetrics({now:()=>10});let reads=0;const hostile={toString(){reads++;throw Error();}};for(const name of ['__proto__','constructor','https://never.invalid/private','prompt body',hostile,null]){metrics.mark(name);metrics.begin(name)();}
 const value=metrics.snapshot();assert.equal(reads,0);assert.equal(value.marks.length,0);assert.equal(value.phases.length,18);assert.deepEqual(value.phases.map(p=>p.name),expectedPhases);assert.ok(value.phases.every(p=>p.calls===0&&p.totalMs===0&&p.busyMs===0));assert.equal(JSON.stringify(value).includes('private'),false);
});
test('invalid, decreasing and throwing clocks never change operation or produce invalid numbers',async()=>{
 let now=30;const metrics=createDesktopControlMetrics({now:()=>{if(now==='throw')throw Error('clock');return now;}});const done=metrics.begin('node');for(const value of [-1,NaN,Infinity,20,'throw']){now=value;assert.equal(metrics.snapshot().elapsedMs,30);}done();assert.equal(metrics.snapshot().phases.find(p=>p.name==='node').totalMs,0);now=100_000_000;metrics.mark('uiWired');assert.equal(metrics.snapshot().elapsedMs,86_400_000);assert.equal(metrics.snapshot().marks[0].atMs,86_400_000);
 const error=Error('same error');await assert.rejects(metrics.measure('workspace',()=>{throw error;}),e=>e===error);assert.deepEqual(await metrics.measure('agents',async()=>({ok:true})),{ok:true});
});
test('call and accumulated duration caps hold and completed observations are idempotent',()=>{
 let now=0;const metrics=createDesktopControlMetrics({now:()=>now});for(let i=0;i<1_000_001;i++)metrics.begin('browserFetch')();assert.equal(metrics.snapshot().phases.find(p=>p.name==='browserFetch').calls,1_000_000);
 const a=metrics.begin('browserRefresh'),b=metrics.begin('browserRefresh');now=86_400_000;a();b();assert.equal(metrics.snapshot().phases.find(p=>p.name==='browserRefresh').totalMs,86_400_000);assert.equal(metrics.snapshot().phases.find(p=>p.name==='browserRefresh').busyMs,86_400_000);
});
test('measure preserves sequential action order and failure stops later actions while counting the failed phase',async()=>{
 let now=0;const metrics=createDesktopControlMetrics({now:()=>now}),calls=[];const error=Error('stop');
 await assert.rejects(async()=>{await metrics.measure('workspace',async()=>{calls.push('workspace');now=4;});await metrics.measure('agents',async()=>{calls.push('agents');now=7;throw error;});await metrics.measure('attach',async()=>calls.push('attach'));},e=>e===error);
 assert.deepEqual(calls,['workspace','agents']);assert.deepEqual(metrics.snapshot().phases.slice(0,3),[{name:'workspace',calls:1,totalMs:4,busyMs:4,inFlight:0},{name:'agents',calls:1,totalMs:3,busyMs:3,inFlight:0},{name:'attach',calls:0,totalMs:0,busyMs:0,inFlight:0}]);
});

test('same-phase overlap contributes summed duration and union wall time including in-flight snapshots',()=>{
 let now=0;const metrics=createDesktopControlMetrics({now:()=>now}),a=metrics.begin('browserRefresh');now=5;const b=metrics.begin('browserRefresh');now=15;a();a();now=20;assert.deepEqual(metrics.snapshot().phases.find(p=>p.name==='browserRefresh'),{name:'browserRefresh',calls:2,totalMs:15,busyMs:20,inFlight:1});now=25;b();assert.deepEqual(metrics.snapshot().phases.find(p=>p.name==='browserRefresh'),{name:'browserRefresh',calls:2,totalMs:35,busyMs:25,inFlight:0});now=30;const c=metrics.begin('browserRefresh');now=35;assert.equal(metrics.snapshot().phases.find(p=>p.name==='browserRefresh').busyMs,30);c();assert.equal(metrics.snapshot().phases.find(p=>p.name==='browserRefresh').busyMs,30);
});
test('overlap in different phases remains independent and snapshot does not settle active observations',()=>{
 let now=10;const metrics=createDesktopControlMetrics({now:()=>now}),a=metrics.begin('feedLocal');now=15;const b=metrics.begin('feedConnected');now=25;const first=metrics.snapshot();assert.equal(first.phases.find(p=>p.name==='feedLocal').busyMs,15);assert.equal(first.phases.find(p=>p.name==='feedConnected').busyMs,10);assert.equal(first.phases.find(p=>p.name==='feedLocal').totalMs,0);assert.deepEqual(metrics.snapshot(),first);now=30;a();b();assert.equal(metrics.snapshot().phases.find(p=>p.name==='feedLocal').busyMs,20);assert.equal(metrics.snapshot().phases.find(p=>p.name==='feedConnected').busyMs,15);
});

test('latest work can finish while obsolete work still keeps browser gauges nonzero',()=>{
 let now=0;const metrics=createDesktopControlMetrics({now:()=>now}),oldRefresh=metrics.begin('browserRefresh'),oldFetch=metrics.begin('browserFetch');
 now=5;const latestRefresh=metrics.begin('browserRefresh'),latestFetch=metrics.begin('browserFetch');now=15;latestFetch();const render=metrics.begin('browserRender');render();latestRefresh();
 let phases=metrics.snapshot().phases;for(const name of ['browserFetch','browserRefresh']){const phase=phases.find(p=>p.name===name);assert.equal(phase.calls,2);assert.equal(phase.inFlight,1);assert.equal(phase.totalMs,10);assert.equal(phase.busyMs,15);}assert.equal(phases.find(p=>p.name==='browserRender').inFlight,0);
 now=60;oldFetch();oldRefresh();oldFetch();oldRefresh();phases=metrics.snapshot().phases;for(const name of ['browserFetch','browserRefresh']){const phase=phases.find(p=>p.name===name);assert.equal(phase.inFlight,0);assert.equal(phase.totalMs,70);assert.equal(phase.busyMs,60);}
});
test('in-flight gauges remain numeric through backward clocks, unknown phases and idempotent finishes',()=>{
 let now=20;const metrics=createDesktopControlMetrics({now:()=>now}),done=metrics.begin('browserFetch');
 now=2;const value=metrics.snapshot();assert.equal(value.elapsedMs,20);assert.equal(value.phases.find(p=>p.name==='browserFetch').inFlight,1);metrics.begin('constructor')();
 done();done();assert.equal(metrics.snapshot().phases.find(p=>p.name==='browserFetch').inFlight,0);assert.ok(metrics.snapshot().phases.every(p=>Number.isInteger(p.inFlight)&&p.inFlight>=0&&p.inFlight<=p.calls));
});
test('gauge saturation stays nonzero and reflects pending work instead of completed call cap',async()=>{
 // Exercise the production module's exact clamp logic with a reduced cap;
 // existing test above independently exercises the actual million-call cap.
 const source=await readFile(new URL('./desktop-control-metrics.mjs',import.meta.url),'utf8');assert.equal(source.split('MAX_CALLS = 1_000_000').length,2);
 const {createDesktopControlMetrics:createScaled}=await import(`data:text/javascript;base64,${Buffer.from(source.replace('MAX_CALLS = 1_000_000','MAX_CALLS = 3')).toString('base64')}`);
 const metrics=createScaled({now:()=>10}),finish=Array.from({length:4},()=>metrics.begin('browserFetch'));
 const phase=()=>metrics.snapshot().phases.find(p=>p.name==='browserFetch');assert.equal(phase().calls,3);assert.equal(phase().inFlight,3);finish[0]();assert.equal(phase().inFlight,3);finish[1]();assert.equal(phase().inFlight,2);finish[2]();assert.equal(phase().inFlight,1);finish[3]();finish[3]();assert.equal(phase().inFlight,0);
 const done=metrics.begin('browserFetch');assert.equal(phase().calls,3);assert.equal(phase().inFlight,1);done();assert.equal(phase().inFlight,0);
});
