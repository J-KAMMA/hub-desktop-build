import {createPersonalNodeReactivation} from './personal-node-reactivation.mjs';
import { createPersonalNodeRegistration } from './personal-node-registration.mjs';
const scopes = ['profile:write', 'post:write', 'content:write', 'follow:write', 'preference:write', 'agent:delegate', 'relay:receive'];
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
function origin(value) {
  if (!text(value, 2048)) return null;
  try { const url = new URL(value), host = url.hostname.toLowerCase().replace(/\.$/, ''); if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash || !host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return null; if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) { const [a, b] = host.split('.').map(Number); if ([0, 10, 127].includes(a) || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168) return null; } return url.origin; } catch { return null; }
}
function snapshot(value) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > 256 * 1024) throw Error('invalid_state');
  if (!id(value?.viewerId) || !Array.isArray(value.relays) || value.relays.length > 3 || !Array.isArray(value.devices) || value.devices.length > 256 || new Set(value.devices.map(device => device.deviceId)).size !== value.devices.length) throw Error('invalid_state');
  if (value.node !== null && (!origin(value.node?.nodeUrl) || !text(value.node.keyThumbprint, 128) || !['active', 'revoked'].includes(value.node.status))) throw Error('invalid_state');
  if (value.relays.some(relay => !origin(relay?.relayUrl) || !Number.isSafeInteger(relay.priority) || relay.priority < 0 || relay.priority > 2 || ![0, 1].includes(relay.enabled)) || new Set(value.relays.map(relay => origin(relay.relayUrl))).size !== value.relays.length) throw Error('invalid_state');
  if (value.devices.some(device => !id(device?.deviceId) || !text(device.label, 80) || !text(device.keyThumbprint, 128) || !['mobile', 'computer', 'server', 'backup', 'agent'].includes(device.deviceType) || !['active', 'revoked'].includes(device.status) || !Array.isArray(device.scopes) || device.scopes.length > 7 || device.scopes.some(scope => !scopes.includes(scope)))) throw Error('invalid_state');
  return value;
}

export function createPersonalNodeDashboard(document, { invoke, isCurrent = () => true, getAccount }) {
  const element = document.createElement('section'); element.className = 'card detail-form'; element.setAttribute('aria-label', 'HubのPersonal Node登録');
  const heading = document.createElement('h3'); heading.textContent = 'HubのPersonal Node登録';
  const note = document.createElement('p'); note.className = 'meta'; note.setAttribute('role', 'status');
  const content = document.createElement('div');
  const reloadButton = document.createElement('button'); reloadButton.type = 'button'; reloadButton.className = 'head-action'; reloadButton.textContent = '登録状態を再読み込み';
  element.append(heading, content, reloadButton, note);
  let data = null, dataAccount = null, generation = 0, disposed = false, busy = false, textarea = null, registration = null, reactivation = null;
  const account = () => { const value = getAccount?.(); return typeof value === 'string' && value ? value : null; };
  const current = (turn, key) => !disposed && isCurrent() && generation === turn && account() === key;
  const button = (label, action) => { const node = document.createElement('button'); node.type = 'button'; node.className = 'head-action'; node.textContent = label; node.onclick = action; return node; };
  const paragraph = value => { const node = document.createElement('p'); node.className = 'meta'; node.textContent = value; return node; };
  const clear = message => { registration?.dispose(); registration = null; reactivation?.dispose(); reactivation=null; data = null; dataAccount = null; textarea = null; content.replaceChildren(); note.textContent = message; };
  function render() {
    registration?.dispose(); registration = null; reactivation?.dispose(); reactivation=null;
    content.replaceChildren();
    content.append(paragraph(data.node ? `${data.node.status === 'active' ? '登録済み' : '登録失効'} · ${data.node.nodeUrl}` : '未登録'));
    if (data.node) content.append(paragraph(`公開鍵の指紋 ${data.node.keyThumbprint}`));
    else {
      registration = createPersonalNodeRegistration(document, {invoke,
        getContext: () => data && ({viewerId:data.viewerId,node:data.node,account:account(),generation}),
        isCurrent: () => !disposed && isCurrent() && dataAccount === account(), onReload: viewer => reload(viewer)});
      content.append(registration.element);
    }
    if(data.node?.status==='revoked'){
      reactivation=createPersonalNodeReactivation(document,{invoke,
        getContext:()=>data&&({viewerId:data.viewerId,node:data.node,account:account(),generation}),
        isCurrent:()=>!disposed&&isCurrent()&&dataAccount===account(),onReload:readReactivationState});
      content.append(reactivation.element);
    }
    const relays = document.createElement('section'), relayHeading = document.createElement('h4'); relayHeading.textContent = 'Relay接続先'; relays.append(relayHeading);
    relays.append(paragraph(data.relays.length ? data.relays.map(relay => `${relay.relayUrl}（${relay.enabled ? '有効' : '無効'}）`).join(' · ') : 'Relayは登録されていません'));
    if (data.node?.status === 'active') {
      textarea = document.createElement('textarea'); textarea.rows = 3; textarea.maxLength = 6200; textarea.setAttribute('aria-label', 'Relay接続先（1行に1つ、最大3件）'); textarea.value = data.relays.map(relay => relay.relayUrl).join('\n');
      const preview = document.createElement('div');
      const show = button('接続先を確認', () => {
        if (busy || !isCurrent()) return;
        const raw = textarea.value.split(/\r?\n/u).map(line => line.trim()).filter(Boolean), next = raw.map(origin);
        preview.replaceChildren();
        if (raw.length > 3 || next.some(url => !url) || new Set(next).size !== next.length) { note.textContent = '公開HTTPSの接続先を最大3件、重複せず入力してください。パス・クエリ・認証情報は指定できません。'; return; }
        const draft = textarea.value, key = account(), turn = generation;
        preview.append(paragraph(`保存する接続先: ${next.length ? next.join(' · ') : '接続先をすべて解除'}`), button('確認して保存', () => {
          if (!current(turn, key) || textarea.value !== draft) { preview.replaceChildren(); return; }
          return mutate({ action: 'personal_node_relays', options: { relays: next } }, result => Array.isArray(result?.relays) && result.relays.length === next.length && result.relays.every((url, index) => origin(url) === next[index]));
        }), button('キャンセル', () => preview.replaceChildren()));
      });
      textarea.oninput = () => { preview.replaceChildren(); note.textContent = ''; };
      relays.append(textarea, show, preview);
    }
    content.append(relays);
    const devices = document.createElement('section'), deviceHeading = document.createElement('h4'); deviceHeading.textContent = '接続端末'; devices.append(deviceHeading);
    if (!data.devices.length) devices.append(paragraph('接続端末は登録されていません'));
    for (const device of data.devices) {
      const row = document.createElement('article'); row.className = 'card'; row.append(paragraph(`${device.label} · ${device.deviceType} · ${device.status === 'active' ? '有効' : '失効'}`), paragraph(`端末 ${device.deviceId} · 公開鍵の指紋 ${device.keyThumbprint}`), paragraph(`権限 ${device.scopes.join(' · ')}`));
      if (device.status === 'active' && data.node?.status === 'active') {
        const preview = document.createElement('div'), key = account(), turn = generation;
        row.append(button('この端末を失効', () => {
          if (busy || !current(turn, key)) return;
          preview.replaceChildren(paragraph(`${device.label}（${device.deviceId}）の鍵とHubへの権限を失効します。`), button('確認して端末を失効', () => mutate({ action: 'personal_node_device_revoke', target: device.deviceId }, result => result?.revoked === true && result.deviceId === device.deviceId)), button('キャンセル', () => preview.replaceChildren()));
        }), preview);
      }
      devices.append(row);
    }
    content.append(devices);
  }
  async function reload(expectedViewer = null) {
    if (disposed || !isCurrent()) return;
    const key = account(), turn = ++generation; busy = true; reloadButton.disabled = true; clear(key ? '登録状態を取得中…' : 'Hubへ接続すると登録状態を確認できます。');
    if (!key) { busy = false; reloadButton.disabled = false; return; }
    try {
      const result = await invoke('hub_client', { name: 'personal_node' });
      if (!current(turn, key)) return;
      const next = snapshot(result);
      if (expectedViewer && next.viewerId !== expectedViewer) throw Error('account_changed');
      data = next; dataAccount = key; render(); note.textContent = ''; return next;
    } catch { if (current(turn, key)) clear('登録状態を取得できませんでした。再読み込みしてください。'); return null; }
    finally { if (current(turn, key)) { busy = false; reloadButton.disabled = false; } }
  }
  async function readReactivationState(expectedViewer){
    const key=account(),turn=generation,source=data?.node;
    if(!source||!current(turn,key)||dataAccount!==key)return null;
    const expected={nodeUrl:source.nodeUrl,keyThumbprint:source.keyThumbprint};
    const result=await invoke('hub_client',{name:'personal_node'});if(!current(turn,key))return null;
    const next=snapshot(result);
    if(next.viewerId!==expectedViewer||next.node?.nodeUrl!==expected.nodeUrl||next.node.keyThumbprint!==expected.keyThumbprint)throw Error('reactivation_state_unconfirmed');
    data=next;dataAccount=key;render();note.textContent=next.node.status==='active'?'同じ接続先と鍵の登録は現在有効です。':'失効中の登録状態を確認しました。';return next;
  }
  async function mutate(args, accepted) {
    const key = account(), turn = generation, viewer = data?.viewerId;
    if (busy || !key || !current(turn, key) || key !== dataAccount || !viewer || data.node?.status !== 'active') return;
    busy = true; note.textContent = '保存中…'; const locked = [...element.querySelectorAll('button,textarea')].map(node => [node, node.disabled]); locked.forEach(([node]) => { node.disabled = true; });
    try {
      const result = await invoke('hub_client_action', args);
      if (!current(turn, key)) return;
      if (!accepted(result)) throw Error('unconfirmed_write');
      await reload(viewer);
      if (!disposed && isCurrent() && account() === key && data?.viewerId === viewer) note.textContent = '保存しました。';
    } catch { if (current(turn, key)) note.textContent = '保存結果を確認できませんでした。入力は保持しています。状態を確認して再試行してください。'; }
    finally { if (current(turn, key)) { busy = false; locked.forEach(([node, disabled]) => { node.disabled = disabled; }); } }
  }
  reloadButton.onclick = () => { if (!busy) return reload(); };
  function invalidate() { if(disposed)return; generation++; busy=false;clear('登録状態を再読み込みしてください。');reloadButton.disabled=false; }
  const accountChanged = () => { if(disposed)return; invalidate(); if(isCurrent())void reload(); };
  document.defaultView?.addEventListener('hub-account-changed', accountChanged);
  document.defaultView?.addEventListener('hub-origin-changed', accountChanged);
  const ready = reload();
  return { element, ready, reload, invalidate, dispose() { if(disposed)return;registration?.dispose();registration=null;reactivation?.dispose();reactivation=null;disposed = true; generation++; data = null; textarea = null; content.replaceChildren(); document.defaultView?.removeEventListener('hub-account-changed', accountChanged);document.defaultView?.removeEventListener('hub-origin-changed', accountChanged); } };
}
