import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {appendContentShare, contentShareReference} from './content-share-contract.mjs';
import {renderContentReferenceLinks} from './content-reference-links.mjs';
const {JSDOM} = createRequire(new URL('../../../package.json',import.meta.url))('jsdom');

function fixture(t) {
  const dom = new JSDOM('<main><article><p></p></article></main>', {url:'https://fixture.invalid/'});
  t.after(() => dom.window.close());
  const host = dom.window.document.querySelector('p'), card = host.parentElement, opened = [];
  const f = {dom, host, card, opened, alive:true, parents:0};
  card.addEventListener('click', () => f.parents++);
  card.addEventListener('auxclick', () => f.parents++);
  f.currentGuard=()=>f.alive;
  f.options = {open:(reference,event)=>opened.push({reference,event}), isCurrent:()=>f.currentGuard()};
  f.render = text => renderContentReferenceLinks(host,text,f.options);
  f.event = (anchor,type='click',options={}) => {
    const event = new dom.window.MouseEvent(type,{bubbles:true,cancelable:true,...options});anchor.dispatchEvent(event);return event;
  };
  return f;
}

test('actual appendContentShare article, video, music and pinned research lines retain exact type, origin and version',t=>{
  const cases = [
    ['/v2/articles/article-a','article'],
    ['/v2/videos/video-a','video'],
    ['/v2/music/works/music%3A00000000-0000-4000-8000-000000000001','music'],
    ['/v2/research/project-a?document=doc-a&version=7','research'],
  ];
  for(const [path,kind] of cases) {
    const f=fixture(t),body=appendContentShare('紹介本文',path,'https://hub.example');
    assert.equal(f.render(body),true);assert.equal(f.host.textContent,body);assert.equal(f.opened.length,0);
    const anchors=f.host.querySelectorAll('a');assert.equal(anchors.length,1);
    const anchor=anchors[0],expected=contentShareReference('https://hub.example'+path),event=f.event(anchor);
    assert.equal(anchor.className,'content-reference-link');assert.equal(anchor.getAttribute('href'),expected.href);
    assert.equal(anchor.textContent,expected.href);assert.equal(event.defaultPrevented,true);assert.equal(f.parents,0);
    assert.deepEqual(f.opened[0].reference,expected);assert.equal(f.opened[0].reference.kind,kind);
    if(kind==='research')assert.equal(f.opened[0].reference.version,7);
    assert.deepEqual(Object.keys(expected).sort(),kind==='research'?['href','kind','origin','version']:['href','kind','origin']);
  }
});

test('the same content ID on two Hub origins remains two separate public references',t=>{
  const f=fixture(t);
  const body=appendContentShare(appendContentShare('二つの出典','/v2/articles/same','https://one.example'),'/v2/articles/same','https://two.example');
  f.render(body);const anchors=[...f.host.querySelectorAll('a')];assert.equal(anchors.length,2);assert.equal(f.host.textContent,body);
  anchors.forEach(anchor=>f.event(anchor));
  assert.deepEqual(f.opened.map(value=>value.reference.origin),['https://one.example','https://two.example']);
  assert.deepEqual(f.opened.map(value=>value.reference.href),['https://one.example/v2/articles/same','https://two.example/v2/articles/same']);
});

test('whitespace, mixed newlines, empty lines and surrounding plain text remain exact',t=>{
  const f=fixture(t),first='https://hub.example/v2/articles/a',second='https://hub.example/v2/videos/b';
  const body='  前書き <b>文字</b>\r\n\t'+first+'  \r\n\r  '+second+'\t\n\n末尾 ';
  assert.equal(f.render(body),true);assert.equal(f.host.textContent,body);
  assert.deepEqual([...f.host.querySelectorAll('a')].map(anchor=>anchor.textContent),[first,second]);
  assert.equal(f.host.querySelector('b'),null);assert.equal(f.host.childNodes[0].nodeType,3);
  assert.equal(f.render(''),true);assert.equal(f.host.textContent,'');assert.equal(f.host.querySelector('a'),null);
});

test('unsupported, relative, inline, malformed or unsafe URLs and HTML/script text stay plain',t=>{
  const f=fixture(t),lines=[
    '/v2/articles/a','Read https://hub.example/v2/articles/a now','https://hub.example/v2/articles/a.',
    'https://hub.example/other/a','https://hub.example/v2/research/p?document=d',
    'https://hub.example/v2/research/p?document=d&version=9007199254740992',
    'https://hub.example/v2/research/p?version=1&document=d',
    'http://remote.example/v2/articles/a','https://user:pass@hub.example/v2/articles/a',
    'https://hub.example/v2/articles/a#private','https://hub.example/v2/articles/a?private=1',
    'javascript:alert(1)','data:text/html,<script>attack()</script>','<img src=x onerror=attack>',
    '<script>attack()</script>','https://hub.example/v2/market/products/valid','https://hub.example/v2/market/products/%2F',
    'https://hub.example/v2/articles/'+'a'.repeat(2048),
    'https://hub.example/v2/articles/a\u0000suffix',
  ],body=lines.join('\n');
  assert.equal(f.render(body),true);assert.equal(f.host.textContent,body);
  assert.equal(f.host.children.length,0);assert.equal(f.opened.length,0);
});

test('supported post, project and local loopback absolute references reuse the existing contract',t=>{
  const f=fixture(t),urls=['https://hub.example/v2/posts/p','https://hub.example/v2/research/project','http://127.0.0.1:3020/v2/articles/a'];
  f.render(urls.join('\n'));const anchors=[...f.host.querySelectorAll('a')];assert.equal(anchors.length,3);
  anchors.forEach(anchor=>f.event(anchor));assert.deepEqual(f.opened.map(value=>value.reference),urls.map(contentShareReference));
});

test('click and auxclick prevent Main and parent-card navigation while preserving modifier events for the callback',t=>{
  const f=fixture(t);f.render('https://hub.example/v2/articles/a');const anchor=f.host.querySelector('a');
  const click=f.event(anchor,'click',{ctrlKey:true,metaKey:true}),aux=f.event(anchor,'auxclick',{button:1,shiftKey:true});
  assert.equal(click.defaultPrevented,true);assert.equal(aux.defaultPrevented,true);assert.equal(f.parents,0);assert.equal(f.opened.length,2);
  assert.equal(f.opened[0].event,click);assert.equal(f.opened[1].event,aux);assert.equal(aux.button,1);assert.equal(aux.shiftKey,true);
  f.event(f.host);assert.equal(f.parents,1);assert.equal(f.opened.length,2);
});

test('detached host, removed anchor and superseded rendering callbacks never open a reference',t=>{
  for(const stale of [f=>f.host.remove(),f=>f.host.querySelector('a').remove(),f=>f.render('Replacement plain body')]){
    const f=fixture(t);f.render('https://hub.example/v2/articles/a');const anchor=f.host.querySelector('a');stale(f);
    const event=f.event(anchor);assert.equal(event.defaultPrevented,true);assert.equal(f.opened.length,0);
  }
  const f=fixture(t);f.host.remove();assert.equal(f.render('https://hub.example/v2/articles/a'),true);
  f.card.append(f.host);f.event(f.host.querySelector('a'));assert.equal(f.opened.length,1);
});

test('stale or throwing source guards suppress click and auxclick without changing the rendered body',t=>{
  for(const guard of [()=>false,()=>{throw Error('source lost');}]){
    const f=fixture(t),body='https://hub.example/v2/articles/a';f.render(body);const anchor=f.host.querySelector('a');
    f.currentGuard=guard;
    const click=f.event(anchor),aux=f.event(anchor,'auxclick',{button:1});
    assert.equal(click.defaultPrevented,true);assert.equal(aux.defaultPrevented,true);assert.equal(f.opened.length,0);assert.equal(f.parents,0);assert.equal(f.host.textContent,body);
  }
});

test('failed initial or final source checks leave existing host nodes untouched',t=>{
  for(const isCurrent of [()=>false,()=>{throw Error('source lost');},(()=>{let checks=0;return()=>++checks===1;})()]){
    const f=fixture(t),old=f.dom.window.document.createElement('span');old.textContent='Existing body';f.host.append(old);
    assert.equal(renderContentReferenceLinks(f.host,'https://hub.example/v2/articles/a',{open:f.options.open,isCurrent}),false);
    assert.equal(f.host.firstChild,old);assert.equal(f.host.textContent,'Existing body');assert.equal(f.opened.length,0);
  }
});

test('invalid rendering input does not replace existing content or perform an operation',t=>{
  const f=fixture(t);f.host.textContent='Original';const old=f.host.firstChild;
  for(const [text,options] of [[null,f.options],['safe',{}],['safe',{open:()=>{},isCurrent:true}]]){
    assert.equal(renderContentReferenceLinks(f.host,text,options),false);assert.equal(f.host.firstChild,old);
  }
  assert.equal(f.opened.length,0);
});

test('GitHub public references retain exact repository, issue, PR and full OID without using Hub paths', t => {
  const repo = 'https://github.com/owner/repo';
  const cases = [
    { href: repo, resource: 'repository' },
    { href: repo + '/issues/1', resource: 'issue', number: 1 },
    { href: repo + '/pull/' + Number.MAX_SAFE_INTEGER, resource: 'pull_request', number: Number.MAX_SAFE_INTEGER },
    ...[40, 64].map(width => ({ href: repo + '/commit/' + 'a'.repeat(width), resource: 'commit', commit: 'a'.repeat(width) })),
  ];
  for (const value of cases) {
    const expected = { kind: 'github', origin: 'https://github.com', ...value }, f = fixture(t);
    assert.deepEqual(contentShareReference(value.href), expected);
    const draft = '  Existing draft\n', body = appendContentShare(draft, value.href, 'https://hub.example');
    assert.equal(body, draft + '\n\n' + value.href);
    assert.equal(appendContentShare(body, value.href, 'https://hub.example'), body);
    assert.equal(appendContentShare('x'.repeat(500 - value.href.length - 2), value.href, 'https://hub.example').length, 500);
    assert.throws(() => appendContentShare('x'.repeat(501 - value.href.length - 2), value.href, 'https://hub.example'), /content_share_full/);
    assert.equal(f.render(body), true); assert.equal(f.host.textContent, body);
    const anchor = f.host.querySelector('a'); assert.ok(anchor); f.event(anchor);
    assert.deepEqual(f.opened[0].reference, expected);
  }
  assert.ok(contentShareReference('https://github.com/' + 'a'.repeat(39) + '/' + 'z'.repeat(100)));
});

test('GitHub contract rejects ambiguous targets, unsafe numbers and OIDs, and fake Hub public paths', () => {
  const repo = 'https://github.com/owner/repo', oid = 'a'.repeat(40);
  const invalid = [repo + '/', repo + '?q=1', repo + '?', repo + '#', repo + '#discussion', repo + '/issues', repo + '/issues/0', repo + '/issues/01',
    repo + '/issues/-1', repo + '/issues/1.5', repo + '/issues/1e2', repo + '/issues/9007199254740992', repo + '/pull/1/', repo + '/issues/1/comments',
    repo + '/issues/1?x=1', repo + '/commit/' + oid.toUpperCase(), repo + '/commit/' + oid.slice(1), repo + '/commit/' + 'a'.repeat(65),
    repo + '/commit/%61' + oid.slice(1), repo + '/commit/' + oid + '#diff', repo + '/commit/' + oid + '/diff',
    'https://github.com/Owner/repo', 'https://github.com/owner/Repo', 'https://GITHUB.com/owner/repo', 'http://github.com/owner/repo',
    'https://github.com:443/owner/repo', 'https://github.com:8443/owner/repo', 'https://user:secret@github.com/owner/repo',
    'https://github.com/owner/%72epo', 'https://github.com/owner/..', 'https://github.com/owner/./repo', 'https://github.com/owner%2Frepo',
    'https://github.com/owner/repo\\issues\\1', 'https://github.com/v2/articles/a', 'https://github.com/v2/posts/p', 'https://github.com/v2/research/p',
    'https://github.com:8443/v2/articles/a', 'https://github.com/' + 'a'.repeat(40) + '/r', 'https://github.com/o/' + 'a'.repeat(101), repo + '\n'];
  for (const href of invalid) assert.equal(contentShareReference(href), null, href);
  assert.deepEqual(contentShareReference('https://other.example/v2/articles/a'), { kind: 'article', href: 'https://other.example/v2/articles/a', origin: 'https://other.example' });
});
