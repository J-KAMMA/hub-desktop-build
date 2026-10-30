import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {initRailTooltips} from './rail-tooltip.mjs';
function fixture() {
  const dom = new JSDOM('<nav class="icon-rail"><button aria-label="コミュニティ" title="コミュニティ" aria-describedby="hint"><svg><path/></svg></button></nav>');
  const {document} = dom.window, button = document.querySelector('button');
  Object.defineProperties(dom.window, {innerWidth:{value:150,configurable:true},innerHeight:{value:90,configurable:true}});
  button.getBoundingClientRect = () => ({right:130,top:80,height:38});
  const dispose = initRailTooltips(document, {delay:0}), tip = document.querySelector('[role="tooltip"]');
  Object.defineProperties(tip,{offsetWidth:{value:100},offsetHeight:{value:25}});
  return {dom,document,button,tip,dispose};
}
test('icon names appear on hover and stay within the window near its edges',()=>{
  const f=fixture();try {
    f.button.querySelector('path').dispatchEvent(new f.dom.window.Event('pointerover',{bubbles:true}));
    assert.equal(f.tip.hidden,false);assert.equal(f.tip.textContent,'コミュニティ');assert.equal(f.tip.style.left,'42px');assert.equal(f.tip.style.top,'57px');
    assert.equal(f.button.getAttribute('aria-describedby'),'hint rail-tooltip');assert.equal(f.button.hasAttribute('title'),false);
    f.button.dispatchEvent(new f.dom.window.MouseEvent('pointerout',{bubbles:true,relatedTarget:f.button.querySelector('svg')}));assert.equal(f.tip.hidden,false);
    f.button.dispatchEvent(new f.dom.window.MouseEvent('pointerout',{bubbles:true,relatedTarget:f.document.body}));assert.equal(f.tip.hidden,true);assert.equal(f.button.getAttribute('aria-describedby'),'hint');
  } finally {f.dispose();f.dom.window.close();}
});
test('keyboard focus shows the name; escape, scroll and cleanup dismiss it',()=>{
  const f=fixture();try {
    f.button.focus();assert.equal(f.tip.hidden,false);
    f.document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape'}));assert.equal(f.tip.hidden,true);
    f.button.blur();f.button.focus();assert.equal(f.tip.hidden,false);
    f.document.dispatchEvent(new f.dom.window.Event('scroll'));assert.equal(f.tip.hidden,true);
    f.dispose();assert.equal(f.document.querySelector('[role="tooltip"]'),null);f.button.blur();f.button.focus();assert.equal(f.document.querySelector('[role="tooltip"]'),null);
  } finally {f.dom.window.close();}
});

test('pointer hover waits for the delay; press and leave cancel it',async()=>{
  const dom=new JSDOM('<nav class="icon-rail"><button aria-label="A"><svg><path/></svg></button></nav>');
  const {document}=dom.window,button=document.querySelector('button'),d=initRailTooltips(document,{delay:30}),tip=document.querySelector('[role="tooltip"]');
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  try{
    button.dispatchEvent(new dom.window.Event('pointerover',{bubbles:true}));assert.equal(tip.hidden,true);
    await wait(80);assert.equal(tip.hidden,false);
    button.dispatchEvent(new dom.window.MouseEvent('mousedown',{bubbles:true}));assert.equal(tip.hidden,true);
    button.dispatchEvent(new dom.window.Event('pointerover',{bubbles:true}));await wait(80);assert.equal(tip.hidden,true);
    button.dispatchEvent(new dom.window.MouseEvent('pointerout',{bubbles:true,relatedTarget:document.body}));
    button.dispatchEvent(new dom.window.Event('pointerover',{bubbles:true}));
    button.dispatchEvent(new dom.window.MouseEvent('pointerout',{bubbles:true,relatedTarget:document.body}));await wait(80);assert.equal(tip.hidden,true);
  }finally{d();dom.window.close();}
});
