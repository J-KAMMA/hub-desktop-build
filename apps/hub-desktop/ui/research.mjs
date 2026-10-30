import {researchPublicExport} from './research-public-export.mjs';
import {attachResearchContentShare} from './research-content-share.mjs';
import {createResearchForkChangeTransfer} from "./research-fork-change-transfer.mjs";
import {researchPdfs} from './research-pdfs.mjs';
import {researchFork} from './research-fork.mjs';
import {researchObjectEditor} from './research-object-editor.mjs';
import { createMediaSearch } from "./media-search.mjs";
import { projectCreation, projectWorkspace, documentWorkspace } from "./research-workspace.mjs";
import { bindSearchInput, matchesSearch } from "./search-input.mjs";
import { hubCatalogResearchQuery } from './hub-network.mjs';
export const researchGroups = [
  { id: "all", label: "すべて", types: [] },
  { id: "code", label: "コード", types: ["software", "model", "notebook"] },
  { id: "papers", label: "論文", types: ["paper", "review"] },
  { id: "data", label: "データ・実験", types: ["dataset", "experiment_run", "protocol", "preregistration", "replication"] },
  { id: "other", label: "その他", types: ["question", "hypothesis", "claim", "evidence", "license"] },
];
const labels = { public: "公開", confidential: "機密", restricted: "限定", embargoed: "公開猶予", controlled: "申請制", draft: "準備中", active: "進行中", paused: "中断中", completed: "完了", withdrawn: "撤回済み", paper: "論文", review: "レビュー", software: "ソフトウェア", model: "モデル", notebook: "ノートブック", dataset: "データセット", experiment_run: "実験記録", protocol: "手順", preregistration: "事前登録", replication: "追試", question: "研究課題", hypothesis: "仮説", claim: "主張", evidence: "根拠", license: "ライセンス", supported_by: "根拠が支持", contradicted_by: "根拠が反証", replicated_by: "追試で再現", supersedes: "新版として置換", derived_from: "派生元", uses_protocol: "手順を使用", included_in: "成果に収録", reviewed_by: "レビュー済み" };
const label = (value) => labels[value] ?? value ?? "";
const linkContexts = {
  article: {label: '記事', description: '解説・報告を読む'},
  video: {label: '動画', description: '実演・講義を見る'},
  music: {label:'音楽',description:'音源・制作を確認する'},
  thread: {label: 'スレッド', description: '質問・検証を続ける'},
  community: {label: 'コミュニティ', description: '継続して活動する'},
  hubpedia: {label: '資料・知識', description: '背景知識を確認する'},
};
export const researchLinkContext = kind => typeof kind === 'string' && Object.hasOwn(linkContexts, kind) ? {...linkContexts[kind]} : {label: 'その他', description: '関連する情報を確認する'};
function safeResearchLink(path) {
  if(typeof path==='string'&&path.startsWith('/v2/music/works/')) {
    try {const id=decodeURIComponent(path.slice(16));return encodeURIComponent(id)===path.slice(16)&&(/^[A-Za-z0-9_-]{1,128}$/.test(id)||/^music:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id));}catch{return false;}
  }
  if (typeof path !== 'string' || /[\\\s\u0000-\u001f\u007f]/u.test(path)) return false;
  if (/^\/v2\/community\/?\?/.test(path)) {
    const params = new URLSearchParams(path.split('?')[1].split('#')[0]);
    return params.getAll('community').length === 1 && /^[A-Za-z0-9_-]{1,80}$/.test(params.get('community'))
      && [...params.keys()].every(key => key === 'community' || key === 'channel')
      && (!params.has('channel') || (params.getAll('channel').length === 1 && /^[A-Za-z0-9_-]{1,80}$/.test(params.get('channel'))));
  }
  const match = path.match(/^\/v2\/(?:articles|videos|hubpedia|threads|community)\/([^/?#]+)\/?(?:[?#].*)?$/);
  if (!match) return false;
  try {
    const id = decodeURIComponent(match[1]);
    return id.length > 0 && id.length <= 240 && id !== '.' && id !== '..' && !/[/\\\u0000-\u001f\u007f]/u.test(id);
  } catch { return false; }
}
export const filterResearchObjects = (objects, group) => {
  const types = researchGroups.find((item) => item.id === group)?.types ?? [];
  return types.length ? objects.filter((item) => types.includes(item.objectType)) : objects;
};
export const searchResearchProjects = (projects, query) => {
  return projects.filter(item => matchesSearch(query, item.title, item.description));
};
function element(document, tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function emptyPanel(document, title, body) {
  const panel = element(document, "div", null, "state-panel");
  panel.setAttribute("role", "status");
  panel.append(element(document, "p", title, "state-title"));
  if (body) panel.append(element(document, "p", body, "state-body"));
  return panel;
}
export function initResearch({ document, invoke, openProject, changed, friendlyError, openWeb, openGitHub, network }) {
  const target = document.querySelector("#research-results");
  const state = document.querySelector("#research-state");
  const query = document.querySelector("#research-query");
  query.after(element(document, 'p', '検索語は選択したHubの公開研究検索へ送ります。', 'meta'));
  const github = element(document, 'button', 'GitHubの公開リポジトリを確認');
  github.className = 'ghost btn btn-ghost'; github.type = 'button'; github.disabled = typeof openGitHub !== 'function';
  github.onclick = () => { if (!github.disabled) return openGitHub(); };
  (document.querySelector('#research-head-actions') ?? document.querySelector('.research-index-tools')).prepend(github);
  let projects = [];
  let remote = [];
  let revision = 0;
  let currentPage = null;
  const more = element(document, "button", "続きを表示", "deny"); more.type = "button"; more.hidden = true; target.after(more);
  const render = () => {
    const found = projects;
    target.replaceChildren(...found.map((project) => {
      const card = element(document, "button", null, "research-project-card");
      card.type = "button";
      card.append(element(document, "span", `${label(project.visibility)} · ${label(project.status)}`, "meta"), element(document, "h3", project.title), element(document, "p", project.description || "説明はまだありません。"), element(document, "span", `${project.objectCount} 成果${project.defaultLicense ? ` · ${project.defaultLicense}` : ""}`, "meta"));
      const owner=revision;card.onclick = () => {if(owner===revision && card.isConnected)return openProject(project);};
      return card;
    }));
    const remoteFound=remote;
    if(network)target.append(...remoteFound.map(item=>network.card(item)));
    if (!found.length && !remoteFound.length && !currentPage?.loading && !currentPage?.error) target.append(emptyPanel(document, currentPage?.query ? "検索に一致するプロジェクトはありません。" : "表示できるプロジェクトはまだありません。", currentPage?.query ? "別の検索語で試してください。" : "プロジェクトを作成すると、ここに並びます。"));
    state.textContent = `${found.length+remoteFound.length}件`;
  };
  const controller = createMediaSearch({
    allowUnknownTotal: true,
    fetchPage: async ({query: term, offset}) => {
      const request = revision;
      await network?.ready;
      if (request !== revision) return {items: [], total: null, hasMore: false};
      const source = network?.context?.('research');
      const [local, connected] = await Promise.allSettled([
        !network || network.includePrimary("research") ? invoke("hub_resource", {resource: "research", query: term, offset}) : Promise.resolve({projects: [], hasMore: false}),
        offset === 0 && network ? network.load("research", term) : Promise.resolve(remote),
      ]);
      if (request !== revision || source !== network?.context?.('research')) return {items: [], total: null, hasMore: false};
      if (connected.status === "fulfilled") remote = connected.value;
      if (local.status === "rejected") throw local.reason;
      return {items: local.value.projects, total: null, hasMore: local.value.hasMore === true};
    },
    changed: page => {
      currentPage = page; projects = page.items; render();
      state.classList.toggle("warning", Boolean(page.error));
      if (page.loading) state.textContent = "検索しています…";
      if (page.error) {
        state.textContent = friendlyError(page.error);
        const retry = element(document, "button", "再試行"); retry.type = "button"; retry.onclick = () => controller.retry(); state.append(retry);
      }
      more.hidden = !page.hasMore || Boolean(page.error); more.disabled = page.loading;
      target.setAttribute("aria-busy", String(page.loading)); changed();
    },
  });
  more.onclick = () => controller.more();
  const invalidate = () => { revision++; controller.invalidate(); network?.invalidate?.('research'); remote = []; projects = []; target.replaceChildren(); more.hidden = true; state.classList.remove('warning'); };
  const load = () => {
    invalidate();
    try { return controller.search(hubCatalogResearchQuery(query.value), {}, true); }
    catch (error) { state.textContent = friendlyError(error); state.classList.add('warning'); return Promise.resolve(); }
  };
  const searchBinding = bindSearchInput(query, {search: load, invalidate: () => { invalidate(); state.textContent = "検索語を入力中…"; }});
  for(const event of ["hub-account-changed","hub-origin-changed"])document.defaultView?.addEventListener(event, () => { searchBinding.cancel(); state.textContent = "更新してプロジェクトを読み込んでください。"; });
  document.querySelector("#research-refresh").onclick = load;
  const creationHost = element(document, 'div', null, 'research-create-host'); document.querySelector('.research-index-tools').after(creationHost);
  let accountGeneration=0;
  const creationState = {}, creation = projectCreation(creationHost, {invoke:async(name,args)=>{const generation=accountGeneration;const result=await invoke(name,args);if(generation!==accountGeneration)throw new Error('接続が変わりました。もう一度確認してください。');return result;}, openProject, friendlyError, state:creationState});
  document.querySelector("#research-create-web").onclick = () => {creation.open=!creation.open; if(creation.open)creation.querySelector('input')?.focus();};
  for(const event of ['hub-account-changed','hub-origin-changed'])document.defaultView?.addEventListener(event,()=>{accountGeneration++;Object.keys(creationState).forEach(key=>delete creationState[key]);creation.querySelector('form').reset();creation.open=false;});
  return { load, projects: () => projects };
}
export function renderResearchProject(target, data, openDocument, openLink, openWeb, options = {}) {
  const document = target.ownerDocument;
  const { project, objects = [], relations = [] } = data;
  if (!project) throw new Error("研究プロジェクトを読み込めませんでした。");
  const root = element(document, "section", null, "research-project-detail");
  const filterState = options.state ?? {};
  const navigateLink = path => { if (safeResearchLink(path)) openLink?.(path); };
  root.append(element(document, "p", project.description || "説明はまだありません。"), element(document, "p", `${label(project.visibility)} · ${label(project.status)}${project.defaultLicense ? ` · ${project.defaultLicense}` : ""}`, "meta"));
  root.dataset.researchSection = '概要';
  const heading = (text) => {
    const node = element(document, 'h3', text);
    node.dataset.researchSection = text;
    return node;
  };
  if (openWeb || options.openGit || options.openGitManagement) {
    const files = element(document, 'div', null, 'research-group-filter');
    if(options.openGitManagement){const button=element(document,'button','Gitリポジトリの設定');button.type='button';button.onclick=()=>options.openGitManagement(project.id);files.append(button);}
    if(options.openGit){const button=element(document,'button','変更履歴と差分を見る');button.type='button';button.onclick=()=>options.openGit(project.id);files.append(button);}
    for (const [id, label] of openWeb?[...(options.invoke?[]:[['pdfs', '論文PDFをWebで開く']]), ...(options.openGitManagement?[]:[['git', options.openGit?'Gitの設定をWebで開く':'GitリポジトリをWebで開く']])]:[]) {
      const button = element(document, 'button', label);
      button.type = 'button';
      button.onclick = () => openWeb(`/v2/research/${encodeURIComponent(project.id)}#${id}`);
      files.append(button);
    }
    root.append(files);
  }
  if (data.workspace) {
    root.append(heading('文書・コード'));
    for (const item of data.workspace.documents ?? []) {
      const button = element(document, 'button', `${item.title} · v${item.head}`);
      button.type = 'button';
      button.onclick = () => openDocument?.(project.id, item);
      root.append(button);
    }
    if (!data.workspace.documents?.length) root.append(element(document, 'p', '文書はまだありません。', 'meta'));
    root.append(heading('資料・作品・議論'));
    if (openWeb && !options.invoke) {
      const references = element(document, 'button', '関連資料をWebで開く');
      references.type = 'button';
      references.onclick = () => openWeb(`/v2/research/${encodeURIComponent(project.id)}#references`);
      root.append(references);
    }
    const groups = new Map();
    for (const link of data.workspace.links ?? []) {
      if (!safeResearchLink(link.href)) continue;
      const kind = typeof link.kind === 'string' && Object.hasOwn(linkContexts, link.kind) ? link.kind : 'other';
      if (!groups.has(kind)) groups.set(kind, []);
      groups.get(kind).push(link);
    }
    const related = element(document, 'div', null, 'research-related-links');
    const linkFilters = element(document, 'div', null, 'research-group-filter');
    linkFilters.setAttribute('role', 'group'); linkFilters.setAttribute('aria-label', '関連先の種類');
    const sections = new Map();
    for (const kind of [...Object.keys(linkContexts), 'other'].filter(kind => groups.has(kind))) {
      const context = researchLinkContext(kind), section = element(document, 'section', null, 'research-related-group');
      section.dataset.researchLinkKind = kind;
      section.append(element(document, 'h4', context.label), element(document, 'p', context.description, 'meta research-related-purpose'));
      for (const link of groups.get(kind)) {
        const row = element(document, 'div', null, 'research-related-link'), anchor = element(document, 'a', link.title);
        anchor.href = link.href;
        anchor.onclick = event => { event.preventDefault(); navigateLink(link.href); };
        row.append(anchor); section.append(row);
      }
      sections.set(kind, section);
    }
    const selectLinks = kind => {
      filterState.linkGroup = sections.has(kind) ? kind : 'all';
      for (const button of linkFilters.children) button.setAttribute('aria-pressed', String(button.dataset.researchLinkGroup === filterState.linkGroup));
      for (const [key, section] of sections) section.hidden = filterState.linkGroup !== 'all' && key !== filterState.linkGroup;
    };
    if (sections.size) {
      for (const kind of ['all', ...sections.keys()]) {
        const button = element(document, 'button', kind === 'all' ? 'すべて' : researchLinkContext(kind).label);
        button.type = 'button'; button.dataset.researchLinkGroup = kind; button.onclick = () => selectLinks(kind); linkFilters.append(button);
      }
      related.append(linkFilters, ...sections.values()); selectLinks(filterState.linkGroup);
    } else {
      filterState.linkGroup = 'all'; related.append(element(document, 'p', '登録された関連先はありません。', 'meta'));
    }
    root.append(related);
  }
  const filters = element(document, "div", null, "research-group-filter");
  filters.setAttribute("role", "group");
  filters.setAttribute("aria-label", "成果の種類");
  const list = element(document, "div", null, "research-object-list");
  const paint = (group) => {
    for (const button of filters.children) button.setAttribute("aria-pressed", String(button.dataset.researchGroup === group));
    const found = filterResearchObjects(objects, group);
    list.replaceChildren(...found.map((object) => {
      const row = element(document, "article", null, "research-object-row");
      row.append(element(document, "span", label(object.objectType), "meta"), element(document, "h3", object.title), element(document, "p", `v${object.version} · ${label(object.visibility)}${object.license ? ` · ${object.license}` : ""}`, "meta"), element(document, "code", object.contentHash));
      return row;
    }));
    if (!found.length) list.append(element(document, "p", "この種類の成果はまだありません。", "meta"));
  };
  for (const group of researchGroups) {
    const button = element(document, "button", group.label);
    button.type = "button";
    button.dataset.researchGroup = group.id;
    button.onclick = () => paint(group.id);
    filters.append(button);
  }
  root.append(heading('研究成果'), filters, list, heading('主張と根拠'));
  const byId = new Map(objects.map((object) => [object.id, object]));
  const visibleRelations = relations.filter((relation) => byId.has(relation.fromObjectId) && byId.has(relation.toObjectId));
  root.append(...visibleRelations.map((relation) => element(document, "p", `${byId.get(relation.fromObjectId).title} → ${label(relation.relationType)} → ${byId.get(relation.toObjectId).title}`, "research-relation")));
  if (!visibleRelations.length) root.append(element(document, "p", "表示できる関係はまだありません。", "meta"));
  target.replaceChildren(root);
  projectWorkspace(root,data,{...options,openLink:navigateLink});
  for(const button of filters.children){const run=button.onclick;button.onclick=()=>{filterState.group=button.dataset.researchGroup;run();};}
  paint(filterState.group??"all");
  const editor=researchObjectEditor(root,data,options),fork=researchFork(root,data,options);
  const pdfs=options.invoke?researchPdfs(root,{projectId:project.id},{...options,state:filterState.pdfs??={}}):null;
  const publicExport=project.visibility==='public'&&project.status!=='withdrawn'?researchPublicExport(root,{projectId:project.id},options):null;
  const controls=[editor,fork,pdfs,publicExport].filter(Boolean);
  if(!controls.length)return null;
  return {...(fork??editor??pdfs??publicExport),dispose(){controls.forEach(control=>control.dispose?.());},invalidate(){controls.forEach(control=>control.invalidate?.());}};
}

export function renderResearchDocument(target, data, openWeb, options = {}) {
  const document = target.ownerDocument;
  const root = element(document, 'section', null, 'research-project-detail');
  root.append(element(document, 'h2', data.document.title), element(document, 'p', `第${data.revision.version}版 · ${data.revision.summary}`, 'meta'));
  const body = element(document, 'pre', data.revision.body, 'research-document-body');
  root.append(body, element(document, 'h3', '版履歴'));
  root.append(...data.history.map(item => element(document, 'p', `v${item.version} · ${item.summary}`, 'meta')));
  if (openWeb && !options.invoke) {
    const edit = element(document, 'button', '版を比較・編集する'); edit.type = 'button';
    edit.onclick = () => openWeb(`/v2/research/${encodeURIComponent(data.document.projectId)}?document=${encodeURIComponent(data.document.id)}`);
    root.append(edit);
  }
  target.replaceChildren(root);
  const sharing=attachResearchContentShare(root,data,{invoke:options.invoke,isCurrent:options.isCurrent,onShare:options.shareContent});
  const proposal=documentWorkspace(root,data,options);
  if(!data.signedIn||!options.invoke||!options.getScope)return sharing?{root,ready:proposal?.ready,dispose(){proposal?.dispose();sharing.dispose();},invalidate(){proposal?.invalidate();sharing.invalidate();}}:proposal;
  const transfer=createResearchForkChangeTransfer({document,data,invoke:options.invoke,getScope:options.getScope,
    isCurrent:()=>root.isConnected&&options.isCurrent?.()!==false,createP2P:options.createP2P,
    onImport:packet=>proposal?.importChange?.(packet)??false,
    onOpen:url=>typeof options.openSource==='function'?options.openSource(url):openWeb?.(url)});
  root.append(transfer.element);
  return {root,ready:Promise.all([proposal?.ready,transfer.ready]),
    dispose(){proposal?.dispose();transfer.destroy();sharing?.dispose();},
    invalidate(){proposal?.invalidate();transfer.destroy();sharing?.invalidate();}};

}
