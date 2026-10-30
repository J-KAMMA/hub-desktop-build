// Hub動画のスタジオ（apps/hub/components/native-video-studio.tsx のデスクトップ版）。
// 画面の組み立てと状態の決まりだけを持つ。この窓は CSP で外へ fetch できないので、通信は api（invoke の薄い包み）を通す。
// 変換の方針（所有者決定）：手元で変換できる道が既にあればアップロード前に手元で済ませ、サーバーは確認と詰め替えだけ行う。
// 今のデスクトップにはその変換の道（ffmpeg など）が無いので、planUpload は常に「そのまま送る」を返し、source は "desktop" とする。
import { isNativeVideo } from './native-video.mjs';

export const VISIBILITY_LABELS = {
  public: '公開',
  unlisted: '限定公開（URLを知っている人）',
  followers: 'フォロワーのみ',
  gated: 'ゲート付き（トークン保有者）',
};

export const STATE_LABELS = {
  upload_issued: 'アップロード待ち',
  processing: '処理中',
  ready: '公開できます',
  published: '公開中',
  unpublished: '非公開',
  rejected: '受け付けられませんでした',
  failed: '処理に失敗しました',
  deleted: '削除済み',
};

export const FAILURE_LABELS = {
  duration_mismatch: '申告した長さと実際の長さが大きく違いました。',
  upload_size_mismatch: '送ったファイルの大きさが申告と違いました。',
  upload_too_large: 'ファイルが大きすぎました。',
  unsupported: '対応していない形式です。',
};

const NATIVE_ERRORS = {
  minutes_cap_reached: '30日間のアップロード時間の上限に達しています。',
  too_many_uploads: '処理中のアップロードが多すぎます。終わるまで待ってください。',
  video_too_long: '動画は60分までです。',
  file_too_large: 'ファイルが大きすぎます。',
  storage_quota_exceeded: '保存容量の上限を超えます。',
  account_link_required: '動画のアップロードには共通アカウントとの連携が必要です。',
  upload_expired: 'アップロードの許可が切れました。最初からやり直してください。',
  upload_token_invalid: 'アップロードの許可が切れました。最初からやり直してください。',
  duration_mismatch: '申告した長さと実際の長さが大きく違うため、受け付けられませんでした。',
};

export const MAX_MINUTES_PER_VIDEO = 60;

const POLL_STATES = new Set(['upload_issued', 'processing']);
export const isPolling = (state) => POLL_STATES.has(state);

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatClock(totalSeconds) {
  const total = Math.max(0, Math.round(totalSeconds));
  const pad = (value) => String(value).padStart(2, '0');
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(total % 60)}` : `${minutes}:${pad(total % 60)}`;
}

/** 課金される分数。始まった分は1分に数える（Hub と同じ切り上げ）。 */
export const declaredMinutes = (seconds) => Math.max(1, Math.ceil(seconds / 60));

/**
 * アップロード前の判断。file: { name, size, durationSeconds }。
 * 手元変換の道が無い間は convert を常に false にし、サーバーが確認と詰め替えをする。
 */
export function planUpload(file, quota, { localConversion = false } = {}) {
  const seconds = Number.isFinite(file?.durationSeconds) && file.durationSeconds > 0 ? file.durationSeconds : null;
  const minutes = seconds === null ? null : declaredMinutes(seconds);
  let blocked = null;
  if (!file || !Number.isFinite(file.size) || file.size <= 0) blocked = 'ファイルを選んでください。';
  else if (minutes === null) blocked = '動画の長さを読み取れませんでした。';
  else if (minutes > (quota?.maxMinutesPerVideo ?? MAX_MINUTES_PER_VIDEO)) blocked = `1本あたり ${quota?.maxMinutesPerVideo ?? MAX_MINUTES_PER_VIDEO} 分までです。`;
  else if (quota && minutes > quota.minutesRemaining) blocked = '30日間の残り時間を超えます。';
  return { source: 'desktop', convert: Boolean(localConversion), seconds, minutes, blocked };
}

/** 縦長で60秒以下の動画は kind を short にする（ショートの棚に並ぶ）。 */
export function uploadKind(seconds, width, height) {
  return seconds > 0 && seconds <= 60 && Number(height) > Number(width) ? 'short' : 'normal';
}

/** 一覧に出す並び：処理中・公開前を先に、あとは新しい順。 */
export function sortMine(videos) {
  const rank = (video) => (isPolling(video.state) ? 0 : video.state === 'ready' ? 1 : 2);
  return [...videos].sort((a, b) => rank(a) - rank(b) || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
}

/** エラーを利用者向けの文にする。未対応の命令（Rust 側が未実装）は専用の文にする。 */
export function studioError(error, fallback) {
  const text = typeof error === 'string' ? error : error?.message ?? '';
  if (/unknown command|not allowed|未対応/iu.test(text) && /native|video/iu.test(text)) return 'この版のデスクトップでは、動画の投稿はまだ使えません。';
  const code = /^native_video:([a-z_]+)$/u.exec(text)?.[1];
  if (code && NATIVE_ERRORS[code]) return NATIVE_ERRORS[code];
  if (text === 'desktop_not_connected') return 'Hubアカウントの登録が必要です。';
  return text.startsWith('native_video') ? fallback : text || fallback;
}

/** Rust の native_video_* 命令（固定の操作表）を呼ぶ薄い包み。ファイルの実パスは窓に渡らない（fileId だけ）。 */
export function createNativeVideoApi(invoke) {
  const call = (op, id, patch) => invoke('native_video_request', { op, id, patch });
  return {
    list: async () => {
      const body = await call('list');
      return { videos: Array.isArray(body?.videos) ? body.videos : [], quota: body?.quota ?? null };
    },
    get: async (id) => (await call('get', id))?.video,
    update: (id, patch) => call('update', id, patch),
    publish: (id) => call('publish', id),
    unpublish: (id) => call('unpublish', id),
    remove: (id) => call('delete', id),
    pickFile: () => invoke('native_video_pick_file'),
    upload: (input) => invoke('native_video_upload', { input }),
    // 再生札から作った絶対URLのプレイリスト。窓の CSP が変わるまで画面では使わない。
    play: (id) => invoke('native_video_play', { id }),
  };
}

const el = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function button(document, label, onClick, className = 'ui-button') {
  const node = el(document, 'button', className, label);
  node.type = 'button';
  node.onclick = onClick;
  return node;
}

function quotaCard(document, quota, loaded) {
  const card = el(document, 'section', 'nv-card nv-quota');
  card.setAttribute('aria-label', 'アップロードできる時間');
  if (!quota) {
    card.append(el(document, 'p', 'nv-note', loaded ? 'プランの残り時間を確かめられませんでした。共通アカウントとの連携が必要です。' : '残り時間を確かめています…'));
    return card;
  }
  const used = Math.min(quota.minutesCap, quota.minutesUsed);
  const percent = quota.minutesCap > 0 ? Math.round((used / quota.minutesCap) * 100) : 100;
  const head = el(document, 'div', 'nv-quota__head');
  head.append(el(document, 'span', '', '30日間の残り'), el(document, 'span', '', `${quota.minutesRemaining} 分 / ${quota.minutesCap} 分`));
  const meter = el(document, 'div', 'nv-meter');
  meter.setAttribute('role', 'progressbar');
  meter.setAttribute('aria-valuemin', '0');
  meter.setAttribute('aria-valuemax', String(quota.minutesCap));
  meter.setAttribute('aria-valuenow', String(used));
  meter.setAttribute('aria-label', '30日間に使った時間');
  const bar = el(document, 'span');
  bar.style.width = `${percent}%`;
  meter.append(bar);
  card.append(head, meter, el(document, 'p', 'nv-note', `1本あたり ${quota.maxMinutesPerVideo} 分まで。最大 ${quota.maxHeight}p で配信します。`));
  return card;
}

function videoRow(document, video, { busy, run, edit }) {
  const row = el(document, 'li', 'nv-item');
  const head = el(document, 'div', 'nv-item__head');
  head.append(el(document, 'strong', '', video.title || '無題'), el(document, 'span', `nv-state nv-state--${video.state}`, STATE_LABELS[video.state] ?? video.state));
  const meta = [VISIBILITY_LABELS[video.visibility], video.durationMs ? formatClock(video.durationMs / 1000) : '', video.storedBytes ? formatBytes(video.storedBytes) : ''].filter(Boolean).join(' · ');
  row.append(head, el(document, 'p', 'nv-note', meta));
  if (video.failure) row.append(el(document, 'p', 'nv-note nv-note--error', FAILURE_LABELS[video.failure] ?? '処理できませんでした。'));
  if (video.held) row.append(el(document, 'p', 'nv-note nv-note--error', '著作権の確認中のため、公開できません。'));
  const actions = el(document, 'div', 'nv-actions');
  if (video.state === 'ready' || video.state === 'unpublished') {
    const publish = button(document, '公開する', () => run(video, 'publish'), 'ui-button ui-button--primary');
    publish.disabled = busy || video.held;
    actions.append(publish);
  }
  if (video.state === 'published') actions.append(Object.assign(button(document, '非公開にする', () => run(video, 'unpublish')), { disabled: busy }));
  if (!isPolling(video.state) && video.state !== 'deleted') {
    actions.append(Object.assign(button(document, '編集', () => edit(video)), { disabled: busy }));
    actions.append(Object.assign(button(document, '削除', () => run(video, 'remove'), 'ui-button ui-button--danger'), { disabled: busy }));
  }
  row.append(actions);
  return row;
}

/**
 * スタジオを host に描く。deps: { document, api, confirm?, setTimer?, clearTimer? }。
 * 戻り値の destroy() で待ちの取得を止める。
 */
export function renderVideoStudio(host, { document, api, confirmDelete = () => true, setTimer = setInterval, clearTimer = clearInterval, pollMs = 5000 }) {
  const state = { videos: [], quota: null, loaded: false, gate: 'ok', busy: false, notice: '', error: '', upload: null, destroyed: false };
  let timer = null;

  const gateFrom = (error) => {
    const status = error?.status ?? (/401|authentication/iu.test(String(error?.message ?? error)) ? 401 : 0);
    return status === 401 || /desktop_not_connected/u.test(String(error?.message ?? error)) ? 'login' : status === 404 ? 'disabled' : 'error';
  };

  async function reload() {
    try {
      const result = await api.list();
      state.videos = sortMine(result.videos.filter((video) => video && video.state !== 'deleted'));
      state.quota = result.quota;
      state.gate = 'ok';
      state.error = '';
    } catch (error) {
      state.gate = gateFrom(error);
      state.error = studioError(error, '動画の一覧を読み込めませんでした。');
    }
    state.loaded = true;
    draw();
  }

  async function poll() {
    const waiting = state.videos.filter((video) => isPolling(video.state));
    if (!waiting.length) return;
    for (const video of waiting) {
      try {
        const fresh = await api.get(video.id);
        if (state.destroyed || !fresh) return;
        state.videos = state.videos.map((item) => (item.id === fresh.id ? fresh : item));
        if (!isPolling(fresh.state)) { await reload(); return; }
      } catch { /* 取得の失敗は動画の失敗ではない */ }
    }
    draw();
  }

  async function run(video, verb) {
    if (verb === 'remove' && !confirmDelete(video)) return;
    state.busy = true; state.error = ''; state.notice = ''; draw();
    try {
      await api[verb](video.id);
      state.notice = { publish: '公開しました。', unpublish: '非公開にしました。', remove: '削除しました。' }[verb];
    } catch (error) { state.error = studioError(error, '操作できませんでした。'); }
    state.busy = false;
    await reload();
  }

  async function startUpload(form) {
    const title = form.title.trim();
    const plan = planUpload(form.file, state.quota);
    if (!title) { state.error = '題名を入力してください。'; draw(); return; }
    if (plan.blocked) { state.error = plan.blocked; draw(); return; }
    state.busy = true; state.error = ''; state.notice = ''; state.upload = { percent: 0 }; draw();
    try {
      await api.upload({
        fileId: form.file.fileId, title, description: form.description.trim(), visibility: form.visibility,
        license: form.visibility === 'gated' ? 'arr' : form.license, ageRestricted: form.ageRestricted, commentsEnabled: form.commentsEnabled,
        durationSeconds: plan.seconds, source: plan.source, convert: plan.convert,
        kind: uploadKind(plan.seconds, form.file.width, form.file.height),
      });
      state.notice = 'アップロードできました。サーバーで確認と変換をしています。終わると一覧で公開できます。';
      form.file = null; form.title = ''; form.description = '';
    } catch (error) { state.error = studioError(error, 'アップロードできませんでした。'); }
    state.upload = null; state.busy = false;
    await reload();
  }

  const form = { file: null, title: '', description: '', visibility: 'public', license: 'arr', ageRestricted: false, commentsEnabled: true };
  let editing = null;

  function uploadCard() {
    const card = el(document, 'section', 'nv-card');
    card.append(el(document, 'h2', 'nv-card__title', '動画を投稿する'));
    const pick = button(document, form.file ? `${form.file.name}（${formatBytes(form.file.size)}・${formatClock(form.file.durationSeconds ?? 0)}）` : '動画ファイルを選ぶ', async () => {
      try {
        const picked = await api.pickFile();
        if (!picked) return;
        form.file = picked;
        if (!form.title.trim()) form.title = String(picked.name ?? '').replace(/\.[^.]+$/u, '').slice(0, 100);
        state.error = '';
      } catch (error) { state.error = studioError(error, 'ファイルを選べませんでした。'); }
      draw();
    }, 'nv-drop');
    pick.disabled = state.busy;
    const title = el(document, 'input', 'nv-input');
    title.type = 'text'; title.maxLength = 100; title.value = form.title; title.placeholder = '題名';
    title.setAttribute('aria-label', '題名');
    title.oninput = () => { form.title = title.value; };
    const description = el(document, 'textarea', 'nv-input');
    description.rows = 3; description.maxLength = 5000; description.value = form.description; description.placeholder = '説明';
    description.setAttribute('aria-label', '説明');
    description.oninput = () => { form.description = description.value; };
    const visibility = el(document, 'select', 'nv-input');
    visibility.setAttribute('aria-label', '公開範囲');
    for (const [value, label] of Object.entries(VISIBILITY_LABELS)) {
      const option = el(document, 'option', '', label); option.value = value; option.selected = value === form.visibility; visibility.append(option);
    }
    visibility.onchange = () => { form.visibility = visibility.value; };
    const checks = el(document, 'div', 'nv-checks');
    for (const [key, label] of [['ageRestricted', '年齢制限をかける'], ['commentsEnabled', 'コメントを受け付ける']]) {
      const wrap = el(document, 'label', 'nv-check');
      const box = el(document, 'input'); box.type = 'checkbox'; box.checked = form[key]; box.onchange = () => { form[key] = box.checked; };
      wrap.append(box, document.createTextNode(label)); checks.append(wrap);
    }
    const submit = button(document, state.upload ? 'アップロード中…' : 'アップロードする', () => void startUpload(form), 'ui-button ui-button--primary');
    submit.disabled = state.busy || !form.file;
    const actions = el(document, 'div', 'nv-actions'); actions.append(submit);
    card.append(pick, title, description, visibility, checks, actions);
    return card;
  }

  function editCard(video) {
    const card = el(document, 'section', 'nv-card');
    card.append(el(document, 'h2', 'nv-card__title', '動画を編集する'));
    const title = el(document, 'input', 'nv-input'); title.type = 'text'; title.maxLength = 100; title.value = video.title ?? ''; title.setAttribute('aria-label', '題名');
    const description = el(document, 'textarea', 'nv-input'); description.rows = 3; description.maxLength = 5000; description.value = video.description ?? ''; description.setAttribute('aria-label', '説明');
    const visibility = el(document, 'select', 'nv-input'); visibility.setAttribute('aria-label', '公開範囲');
    for (const [value, label] of Object.entries(VISIBILITY_LABELS)) {
      const option = el(document, 'option', '', label); option.value = value; option.selected = value === video.visibility; visibility.append(option);
    }
    const save = button(document, '保存する', async () => {
      state.busy = true; draw();
      try {
        await api.update(video.id, { title: title.value.trim(), description: description.value.trim(), visibility: visibility.value });
        editing = null; state.notice = '保存しました。';
      } catch (error) { state.error = studioError(error, '変更を保存できませんでした。'); }
      state.busy = false;
      await reload();
    }, 'ui-button ui-button--primary');
    save.disabled = state.busy;
    const actions = el(document, 'div', 'nv-actions'); actions.append(save, button(document, 'やめる', () => { editing = null; draw(); }));
    card.append(title, description, visibility, actions);
    return card;
  }

  function draw() {
    if (state.destroyed) return;
    const root = el(document, 'div', 'nv-studio');
    if (state.gate === 'login') {
      const card = el(document, 'section', 'nv-card');
      card.append(el(document, 'h2', 'nv-card__title', 'ログインが必要です'), el(document, 'p', 'nv-note', '動画を投稿するには、Hubアカウントの登録が必要です。'));
      root.append(card);
    } else if (state.gate === 'disabled') {
      const card = el(document, 'section', 'nv-card'); card.append(el(document, 'p', 'nv-note', 'このHubでは、動画の投稿は使えません。')); root.append(card);
    } else {
      root.append(quotaCard(document, state.quota, state.loaded));
      if (state.notice) { const note = el(document, 'p', 'nv-note', state.notice); note.setAttribute('role', 'status'); root.append(note); }
      if (state.error) { const note = el(document, 'p', 'nv-note nv-note--error', state.error); note.setAttribute('role', 'alert'); root.append(note); }
      root.append(editing ? editCard(editing) : uploadCard());
      const mine = el(document, 'section', 'nv-card');
      mine.append(el(document, 'h2', 'nv-card__title', '自分の動画'));
      if (!state.loaded) mine.append(el(document, 'p', 'nv-note', '読み込み中…'));
      else if (!state.videos.length && state.gate === 'ok') mine.append(el(document, 'p', 'nv-note', 'まだ動画がありません。上のフォームから投稿できます。'));
      const list = el(document, 'ul', 'nv-list');
      for (const video of state.videos) list.append(videoRow(document, video, { busy: state.busy, run, edit: (target) => { editing = target; draw(); } }));
      mine.append(list);
      root.append(mine);
    }
    host.replaceChildren(root);
  }

  draw();
  void reload();
  timer = setTimer(() => void poll(), pollMs);
  return { reload, destroy() { state.destroyed = true; if (timer !== null) clearTimer(timer); }, _state: state, _form: form };
}

export { isNativeVideo };
