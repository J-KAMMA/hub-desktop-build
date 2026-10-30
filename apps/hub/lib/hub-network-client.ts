export const HUB_NETWORK_KINDS = ['post', 'research'] as const;
export type HubNetworkKind = typeof HUB_NETWORK_KINDS[number];
export type HubNetworkItem = {id:string; title:string; summary:string; path:string; updatedAt:string; origin:string};
const paths = {post:'posts', research:'research'};

export function hubCatalogResearchQuery(value:unknown):string {
  if(value === undefined) return '';
  if(typeof value !== 'string' || value.length > 100 || /[\u0000-\u001f\u007f-\u009f]/u.test(value))
    throw Error('研究の検索語は100文字・8語以内で入力してください。');
  try { encodeURIComponent(value); } catch { throw Error('研究の検索語を確認してください。'); }
  const query=value.trim();
  if(query.split(/\s+/u).filter(Boolean).length > 8) throw Error('研究の検索語は100文字・8語以内で入力してください。');
  return query;
}

export function normalizeHubOrigin(value:unknown):string {
  if(typeof value !== 'string' || value.length > 512) throw Error('HubのURLを確認してください。');
  const url = new URL(value.trim());
  if(url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))))
    throw Error('https:// から始まるHubのURLを入力してください。');
  return url.origin;
}

export function parseHubCatalog(body:unknown, origin:string, kind:HubNetworkKind, query=''):HubNetworkItem[] {
  query=hubCatalogResearchQuery(query);
  const catalog = body as {protocol?:unknown; kind?:unknown; items?:unknown; query?:unknown};
  if(!catalog || catalog.protocol !== 'hub.catalog.v1' || catalog.kind !== kind || !Array.isArray(catalog.items) || catalog.items.length > 30)
    throw Error('Hubの公開一覧を確認できません。');
  if(query && kind !== 'research') throw Error('検索する種類を確認してください。');
  if(kind === 'research' && (query || catalog.query !== undefined) && catalog.query !== query)
    throw Error('このHubの研究検索結果を確認できません。元のHubで確認してください。');
  const seen = new Set<string>();
  return catalog.items.map(item => {
    if(!item || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id) || seen.has(item.id) ||
      typeof item.title !== 'string' || item.title.length > 240 || typeof item.summary !== 'string' || item.summary.length > 5000 ||
      item.path !== `/v2/${paths[kind]}/${item.id}` || typeof item.updatedAt !== 'string' || item.updatedAt.length > 64)
      throw Error('Hubの公開一覧を確認できません。');
    seen.add(item.id);
    return {id:item.id, title:item.title, summary:item.summary, path:item.path, updatedAt:item.updatedAt, origin:normalizeHubOrigin(origin)};
  });
}

/** Direct public reads: credentials never leave the current Hub. */
export async function readHubCatalog(origin:string, kind:HubNetworkKind, signal?:AbortSignal, query=''):Promise<HubNetworkItem[]> {
  return parseHubCatalog(await readHubCatalogDocument(origin,kind,signal,query),origin,kind,query);
}
export async function readHubCatalogDocument(origin:string, kind:HubNetworkKind, signal?:AbortSignal, query=''):Promise<unknown> {
  query=hubCatalogResearchQuery(query);
  if(!HUB_NETWORK_KINDS.includes(kind) || (query && kind !== 'research')) throw Error('検索する種類を確認してください。');
  const params=new URLSearchParams({kind});
  if(query) params.set('q',query);
  return readPublicJson(`${normalizeHubOrigin(origin)}/api/network/v1/catalog?${params}`,1048576,signal);
}
export async function readHubPostManifest(origin:string,signal?:AbortSignal):Promise<unknown> {
  return readPublicJson(`${normalizeHubOrigin(origin)}/api/network/v1/catalog?kind=post&manifest=1`,4096,signal);
}
async function readPublicJson(url:string,limit:number,signal?:AbortSignal):Promise<unknown> {
  const response = await fetch(url, {
    credentials:'omit', redirect:'error', referrerPolicy:'no-referrer', cache:'no-store',
    signal:signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
  });
  if(!response.ok || !response.body) throw Error('Hubに接続できません。');
  const reader = response.body.getReader(), chunks:Uint8Array[] = [];
  let size = 0;
  try {
    while(true) {
      const {done, value} = await reader.read();
      if(done) break;
      size += value.byteLength;
      if(size > limit) {void reader.cancel().catch(()=>{}); throw Error('Hubの応答が大きすぎます。');}
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  return JSON.parse(await new Blob(chunks as BlobPart[]).text());
}

/** Keep the local ranking; place one remote item after every three local items. */
export function interleaveHubItems<T>(local:T[], remote:HubNetworkItem[]):Array<{local:T; remote?:never} | {remote:HubNetworkItem; local?:never}> {
  const result:Array<{local:T; remote?:never} | {remote:HubNetworkItem; local?:never}> = [];
  let next = 0;
  local.forEach((item, index) => {result.push({local:item}); if(index % 3 === 2 && next < remote.length) result.push({remote:remote[next++]});});
  return [...result, ...remote.slice(next).map(remote => ({remote}))];
}
