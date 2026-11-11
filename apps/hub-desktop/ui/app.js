import {paintRailAvatar} from './rail-avatar.mjs';
import { dataImageToBlobUrl } from './blob-image.mjs';
import {avatarTint, displayInitial, createState, bindEdgeFade} from './state-view.mjs';
import {ownFirst} from './video-home.mjs';
import {sidebarIcon, channelAvatar, isShortVideo, renderChipRow, createSidebarRemote} from './sidebar-media.mjs';
import {createSidebarMine} from './sidebar-mine.mjs';
import {renderVideoStudio, createNativeVideoApi} from './video-studio.mjs';
import {createPublicationUpdates} from './publication-updates.mjs';
import {isRemoteProfile, remoteFollowForm} from './remote-follow.mjs';
import {createProfileBody, renderProfileActions, renderProfileFacts, renderProfileShortcuts, renderProfileStats} from './profile-view.mjs';
import {initNativeGitHub} from './research-github.mjs';
import {renderContentReferenceLinks} from './content-reference-links.mjs';
import { confirmLeave, addBaitRow } from "./outbound-link.mjs";
import { detectBait } from "./bait-warning.mjs";
import {renderArticleBodyNodes} from './article-body.mjs';
import {articleReadingMinutes, articleReadingLabel} from './article-reading.mjs';
import {openLicenseLabel} from './content-license.mjs';
import {isOwnArticle, parseLikeState, parseCommentPage, renderLikeSummary, renderLikeButton, renderCommentForm, renderCommentList} from './article-engagement.mjs';
import {parseDrafts, draftEditorPath, renderDraftList} from './article-drafts.mjs';
import {createYouTubePlayer as createArticleYouTubePlayer} from './youtube-embed.mjs';
import {contentShareReference} from './content-share-contract.mjs';
import {createContentShare, attachContentShare} from './content-share.mjs';
import {shareMusicWork} from './music-content-share.mjs';
import { musicMenuButton, registerMusicMenu } from './music-track-menu.mjs';
import { createMusicP2pDeclaration } from './music-p2p-declare.mjs';
import { attributionMessage, commerceProofFetcher, createProfileAttribution, musicProofFetcher } from './profile-attribution.mjs';
import {attachAiHandoff,buildPostDraftFromAnswer} from './ai-handoff.mjs';
import {createBrowserAiReference} from './browser-ai-reference.mjs';
import {createSocialStream} from './social-stream.mjs';
import {createFeedComposer} from './feed-composer.mjs';
import {createBrowserExternalOpen} from './browser-external-open.mjs';
import { hubMusicQuery } from "./hub-music-link.mjs";
import { createDmController } from "./dm-controller.mjs";
import { createYouTubeDock } from './yt-dock.mjs';
import { createMiniPlayer } from './mini-player.mjs';
import { unplayable as ytUnplayable } from './yt-unplayable.mjs';
import { createPlaybackOwner } from './playback-owner.mjs';
import { createLikeButton, createFollowButton, loadEngagement, setVideoLike } from './video-engagement.mjs';
import { createChannelState, renderChannelPage, isChannelHandle, parseChannelPage } from './video-channel-view.mjs';
import { createShortsFeed } from './video-shorts-feed.mjs';
import { createVideoThumbnail, createVideoCard, createVideoSkeletons, renderVideoHome, loadSavedVideos, resetVideoHome, stopVideoPlayer, createWatchStage, createWatchHeader, createRelatedList, rememberWatched } from "./video-home.mjs";
import { createCoverMedia, isAllowedImageUrl } from "./media-image.mjs";
import { peerVideoEntries } from "./peer-video.mjs";
import { createNotificationsController } from "./notifications-controller.mjs";
import { createCommunityPostComposer as createChannelComposer } from "./community-post-composer.mjs";
import { notificationTarget } from "./notification-targets.mjs";
import { createNotificationPopover } from "./notification-popover.mjs";
import { createWalletTipSettings } from "./wallet-tip-settings.mjs";
import { createOwnedEventListings } from "./owned-event-listings.mjs";
import { createThreadPostControls } from "./thread-post-controls.mjs";
import { createArticleComposer } from "./article-composer.mjs";
import * as musicQueue from "./music-queue.mjs";
import { createHarnessComparison } from "./harness-comparison.mjs";
import { createExternalMediaRegistration, createExternalMusicReport, validateExternalMediaCatalog } from './external-media-registration.mjs';
import { createCommunityNotifications } from "./community-notifications.mjs";
import { communityHoldingSettings } from "./community-holding.mjs";
import { createSharedTab } from "./community-channels.mjs";
import { COMMUNITY_ORDERS, TOP_PERIODS, normalizeCommunityOrder, normalizeTopPeriod, orderCommunityMessages } from "./community-order.mjs";
import { createCommunityHead, createCommunityAbout, joinView as communityJoinView } from "./community-head.mjs";
import { createCommunityRow, rowFromPost, rowFromMessage, messageThreads } from "./community-row.mjs";
import { buildReplyTree, renderReplyTree } from "./reply-tree.mjs";
import { subscribeGroup } from "./rail-group-live.mjs";
import { createCommunityPoints } from "./community-points.mjs";
import { createCommunityContentTabs, createCommunityPicker, createCommunityTalk, createThreadContentCard, linkToCommunity } from "./community-content.mjs";
import { createMediaPlaylists } from './media-playlists.mjs';
import { listRowsSkeleton as createListRowsSkeleton, listRowsError as createListRowsError, renderListsRows } from './lists-view.mjs';
import { createVideoPosts, createContentPosts } from './video-posts.mjs';
// 動画の下は「コメント」（動画に返信するポスト）。旧来の動画コメント表は撤去した。
function mountVideoPosts(options){
  const posts=createVideoPosts(document,options);
  const element=document.createElement('div');element.className='video-posts-stack';element.append(posts.element);
  return {element,destroy(){posts.destroy();}};
}
import { createOmnibox, omniboxAddress } from './omnibox.mjs';
import { getWebSearchEngine, webSearchUrl, webSearchLabel } from './web-search.mjs';
import { normalizeHubSearchFilters } from './hub-search-filters.mjs';
import { installShortcuts } from './shortcuts.mjs';
import { installContextMenu } from './context-menu.mjs';
import { attachContentSave, renderContentLibrary } from './content-library.mjs';
import { attachMusicFavorite, renderMusicLibrary } from './music-library.mjs';
import { isHubOriginalWork } from './music-originals-first.mjs';
import { initMusicQueueView } from './music-queue-view.mjs';
import { createMusicYoutubeSession, createArtwork as createMusicArtwork, youtubeSource } from './music-youtube.mjs';
import { createItemResolver } from './media-item-resolver.mjs';
import { renderMusicCollection } from './music-artist-album.mjs';
import { createRailMusic } from './rail-music.mjs';
import { musicDownloadAllowed, musicDownloadPageUrl } from './content-download.mjs';
import { createMusicHome, createMusicHistory, planShelfPlayback } from './music-home.mjs';
import { musicTreeModel, renderMusicTree } from './music-tree.mjs';
import { videoTreeModel, renderVideoTree } from './video-tree.mjs';
import { createVideoEmpty, emptyFor } from './video-tiles.mjs';
import { articleTreeModel, renderArticleTree } from './article-tree.mjs';
import { renderArticleHome, renderArticleEmpty } from './article-rows.mjs';
import { researchTreeModel, renderResearchTree } from './research-tree.mjs';
import { renderMusicPlaylist, renderMusicArtists } from './music-pages.mjs';
import { peerMusicEntries, peerYoutubeWork, createPeerAudio } from './peer-music.mjs';
import { createHubTrackAudio } from './hub-track-audio.mjs';
import { createMediaP2pSettings } from './media-p2p-settings.mjs';
import { createAppearanceSettings } from './appearance.mjs';
import {createLocalTranslator, attachTranslateAction} from './local-translate.mjs';
import {renderTranslateSettings} from './local-translate-settings.mjs';
import { createSettingsNav, visibleSection,createIdentityPanel, createCachePanel, createBrowserPanel, createAboutPanel, createStoragePanel, settingRow } from './settings-view.mjs';
import { createLocalDataPanel, createAiRecordsPanel } from './local-data-settings.mjs';
import { createSettingsSearch } from './settings-search.mjs';
import { createAiConnectionsPanel } from './byok-connections.mjs';
import { createConnectionChat, createConnectionModels, parseRef } from './byok-chat.mjs';
import { CONNECTION_NOTE, connectionChoices, renderConnectionPicker, syncConnectionModel } from './pi-work-connection.mjs';
import { createPersonalNodeDashboard } from './personal-node-dashboard.mjs';
import { createNodeSync } from "./node-sync.mjs";
import { createNodeStartup } from "./node-startup.mjs";
import { createThreadStateControls } from './thread-state-controls.mjs';
import { createThreadReplyTarget } from './thread-reply-target.mjs';
import { createWalletHistory } from './wallet-tip-history.mjs';
import { createRailWallet } from './rail-wallet.mjs';
import * as railPanels from './rail-panels.mjs';
import { createRailSubTabs } from './rail-subtabs.mjs';
import { createRailTimeline, rankThreads, rankGroups, groupModels } from './rail-timeline.mjs';
import { createRailChat } from './rail-chat.mjs';
import { createRailVideo } from './rail-video.mjs';
import { AI_PAID_EXECUTION } from './ai-paid-execution.mjs';
import { guardWalletChain, confirmNetworkSwitch, createWalletNetwork, createWalletTokens, networkNotice } from './wallet-network.mjs';
import { createMarketController, marketRef, normalizeListings, showDisclosure } from "./ai-market.mjs";
import { createApiMarketView } from "./api-market-view.mjs";
import { createPiModelPicker } from './pi-model-picker.mjs';
import { createPiPermissionPresets } from './pi-permission-presets.mjs';
import { initNativeSidebar, nativeSidebarId } from './native-sidebar.mjs';
import { initShellControl } from './shell-control.mjs';
import { initBrowserAiControl } from './browser-ai-control.mjs';
import {appendResearchBacklinks as renderResearchBacklinks, appendResearchUpdates} from './research-discovery.mjs';
import {researchFork} from './research-fork.mjs';
import {researchGitManagement} from './research-git-management.mjs';
import {communityGovernanceMutations} from './community-governance-mutations.mjs';
import { researchDiscussionReference, researchGitDiscussionReference } from './research-reference.mjs';
import { initBrowserWorkspace } from './browser-workspace.mjs';
import { createNodePostComposer } from "./node-post-composer.mjs";
import {communityMembershipRequests,communityMembershipReview,communityMembershipReviewRequest} from "./community-membership-review.mjs";
import {communityReports,communityReportReview,communityReportReviewRequest} from "./community-report-review.mjs";
import {communityAppeals,communityAppealReview,communityAppealReviewRequest} from "./community-appeal-review.mjs";
import {communityAppealForm} from "./community-appeal-form.mjs";
import { communityMembershipControls, communityMemberControls, communityPollCard, communityComposerTools } from "./community-controls.mjs";
import {communityGovernanceCatalog,communityGovernanceProposal,communityGovernanceSettings,communityGovernanceCreate,communityGovernanceRequest} from './community-governance.mjs';
import {communityAccessManagement} from "./community-access-management.mjs";
import { createThreadReader } from "./thread-reader.mjs";
import { applyThreadLinks } from "./thread-lines.mjs";
import { threadRowMeta } from "./thread-list-meta.mjs";
import { createPostRow, pointsBadge } from "./post-row.mjs";
import { createUnifiedRow, firstLines, isUnifiedPost } from "./unified-row.mjs";
import { renderUnifiedPostDetail, unwrapPost as unwrapUnifiedPost } from "./unified-detail.mjs";
import { createUnifiedComposer, LICENCE_LABELS } from "./unified-composer.mjs";
import { threadKnowledgeControls } from "./thread-knowledge-controls.mjs";
import { communityGuideCatalog, communityGuidePage, communityGuideRequest, communityGuideProposal } from "./community-guide-reader.mjs";
import { initRailTooltips } from "./rail-tooltip.mjs";
import { createBrowserPageHoles } from "./browser-page-holes.mjs";
import { createRailBrowser } from "./rail-browser.mjs";
import { createHubSearch, searchSources } from "./hub-search.mjs";
import { createHubSearchFilters } from "./hub-search-filter-panel.mjs";
import { createSavedSearches } from "./saved-searches.mjs";
import { createPiChanges } from "./pi-changes.mjs";
import { bindSearchInput, matchesSearch } from "./search-input.mjs";
import { createMediaSearch } from "./media-search.mjs";
import { createRailReader } from "./rail-reader.mjs";
import { createRailNav } from "./rail-nav.mjs";

import { bestOfEstimate, createPiWorkController, hubWorkHistoryEntries, pendingActionsOf, piWorkErrorText, piWorkIsTerminal, piWorkStatusLabel, toolCallsOf } from "./pi-work.mjs";
import { renderPiApproval } from "./pi-approval.mjs";
import { renderPiWorkHistory } from "./pi-work-history.mjs";
import * as piInterrupted from "./pi-work-interrupted.mjs";
import { createShopPayment, shopAtomicHex } from "./shop-payment.mjs";
import { createEscrowActions } from "./escrow-actions.mjs";
import { createRefundActions } from "./refund-actions.mjs";
import { createPiWorkDrafts, piWorkDraftLength } from "./pi-work-drafts.mjs";
import { initSubscriptionUsage } from "./subscription-usage.mjs";
import { researchDiscussion } from './research-discussion.mjs';
import { researchGitBrowser } from './research-git-browser.mjs';
import {researchGitProposals} from './research-git-proposals.mjs';
import { researchGitDiscussion } from './research-git-discussion.mjs';
import {researchProposalReview} from './research-proposal-review.mjs';
let researchDetailController=null;
let communityDetailController=null;
import {communityInvite} from './community-invite.mjs';
let communityInviteController=null;
import { templateFor } from "./desktop-template.mjs";
import { createNavCommunities } from "./nav-communities.mjs";
import { initResearch, renderResearchProject, renderResearchDocument } from "./research.mjs";
import { createReadRecovery, isTransientReadError, isReadAccessDenied, readWaitText } from './hub-read-recovery.mjs';
import { createHubNetwork } from "./hub-network.mjs";
import { ACCOUNT_UNAVAILABLE_TEXT, accountStateLabel, isAccountUnavailable } from "./account-error.mjs";
import { initHubPeers } from "./hub-peers.mjs";
import { createMaterialSync } from "./material-sync.mjs";
import { createFeedLive } from "./feed-live.mjs";
import { createDesktopControlMetrics } from "./desktop-control-metrics.mjs";
import { normalizeStoreGames } from "./games-view.mjs";
import { createMarketGames } from "./market-games.mjs";
import { createPcGames } from "./pc-games.mjs";
import { marketTreeModel, renderMarketTree } from "./market-tree.mjs";
import { createMarketBrowse } from "./market-browse.mjs";
import { installTextButtonIcons } from "./text-button-icons.mjs";
import { createMarketProductPage } from "./market-product.mjs";
import { renderCart as renderCartRows, createLibrary, createOrdersList, renderWebRows, WEB_ROWS } from "./market-me.mjs";
import { normalizeProduct } from "./market-model.mjs";
import { installI18n, createLanguageSetting } from "./i18n.mjs";
import * as localeEn from "./locales/en.mjs";
// 画面の文言の言語（i18n.mjs）。元の文言は日本語のまま書き、表示のときに辞書で置き換える。画面の文字で判断する所は __hubI18n.source() で元の日本語を読む。
const hubI18n = installI18n({ document, storage: (() => { try { return window.localStorage; } catch { return null; } })(), dictionaries: { en: { exact: localeEn.EXACT, patterns: localeEn.PATTERNS, scoped: localeEn.SCOPED } } });
window.__hubI18n = hubI18n;
const controlMetrics = createDesktopControlMetrics();
controlMetrics.mark("moduleReady");

const rawInvoke = (name, args) => window.__TAURI__.core.invoke(name === "hub_action" ? "hub_client_action" : name, args);
// A command that names a different wallet network than the selected one is refused natively
// (wallet_chain_switch_required:<id>). The user is asked once, explicitly; nothing switches silently.
const invoke = guardWalletChain(rawInvoke, (chainId) => confirmWalletNetworkSwitch(chainId), { paidAiExecution: AI_PAID_EXECUTION });
// 端末内翻訳（docs/hub-desktop-translate/DESIGN.md）。表示言語は日本語。共有は未接続（shareSink null）で、PLaMo の訳は表示が出来るまで共有しない。
const localTranslator = createLocalTranslator({ invoke, getLocale: () => "ja", getHubBase: () => invoke("hub_origin"), isSharingEnabled: () => false, shareSink: null });
async function confirmWalletNetworkSwitch(chainId) {
  const status = await rawInvoke("wallet_status");
  return confirmNetworkSwitch({
    document, invoke: rawInvoke, requested: chainId, status, describeError: friendlyError,
    onSwitched: () => { if (currentView === "wallet") void loadCatalog("wallet"); },
  });
}
invoke("desktop_build_mode").then((mode) => {
  document.querySelector(".environment").textContent = mode === "development" ? "開発版" : "ローカル";
}).catch(() => {});
// どの窓に載ったページか。無指定がメインのアプリ窓で、"harness"/"games"/
// "newtab"/"browser" は同梱の道具窓・バーwebview用の各モード。
const startupTool = new URLSearchParams(location.search).get("tool");
let legacyPiWorkController = null;
if (!startupTool) initRailTooltips(document);
// A frontend reload does not destroy native browser tab webviews. The main UI
// starts on the feed, so hide any tab left visible by the previous document.
if (!startupTool) void invoke("browser_exit").catch(() => {});
const runsNode = document.querySelector("#runs");
const writesNode = document.querySelector("#writes");
const devApprovalsNode = document.querySelector("#dev-approvals");
const isolationNode = document.querySelector("#isolation");
const subscriptionUsageController = initSubscriptionUsage({ invoke, document });
const ISOLATION_EVERY_MS = 30_000;
let isolationReady = false;
let isolationCheckedAt = 0;
let savedWorkspace = "";

let desktopAccount = { state: "signed_out" };
let desktopAccountLoaded = false;
let articleEditor = null;
let railActivityReady = false;
// 右列ブラウザ（rail-browser.mjs）。右列の配線ができるまで null。
let railBrowser = null;
// 右列の各表示の中での戻る・進む（上の行の右列の真上のボタン）。ブラウザは自分の履歴を使う。
const railNav = createRailNav({ onChange: () => paintRailNav() });
let railNavSeq = 0;
// 右列の音楽パネル（rail-music.mjs）。右列の中だけで検索・再生・掘り下げを完結させる。右列の配線ができるまで null。
let railMusic = null;
let railMusicTracks = [];
// 接続済みプロフィールのID。自分の投稿にだけ編集・削除を出す判定に使う。
let selfProfileId = null;
let selfProfileHandle = null;
let contentSharePreview=null;
let socialMode="legacy",socialFilter="post",socialScope="latest",socialVerifiedContext=null,socialStreamController=null,socialWantedScene=null,socialExternal=[];
// Initialized before the first account snapshot; helper declarations are hoisted.
let savedSearchPanel = null, verifiedSavedSearchScope = null, savedSearchScopeRequest = {}, savedSearchViewEpoch = {};
let feedComposer = null, feedComposerViewEpoch = {};
let feedInlineComposer = null, composerProfile = null;
var feedLive = null; // フィードの新着確認。var なので宣言前に読んでも落ちない

let mixedPublicationUpdates = null;
let homeAccountEpoch = {}, homeSummaryRequest = {}, homeExtrasRequest = {};
function homeAccountSnapshot() {
  return { account: desktopAccount, epoch: homeAccountEpoch, state: desktopAccount.state,
    deviceId: desktopAccount.deviceId ?? null, keyThumbprint: desktopAccount.keyThumbprint ?? null };
}
function homeAccountCurrent(snapshot) {
  return desktopAccountLoaded && snapshot.account === desktopAccount && snapshot.epoch === homeAccountEpoch
    && snapshot.state === desktopAccount.state && snapshot.deviceId === (desktopAccount.deviceId ?? null)
    && snapshot.keyThumbprint === (desktopAccount.keyThumbprint ?? null);
}
function homeNativeAccountMatches(snapshot, status) {
  return status?.state === snapshot.state && (status.deviceId ?? null) === snapshot.deviceId
    && (status.keyThumbprint ?? null) === snapshot.keyThumbprint;
}
function homeCanonicalOrigin(raw) {
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('home_scope_unavailable');
  return url.origin;
}
async function captureHomeScope(snapshot = homeAccountSnapshot()) {
  if (!homeAccountCurrent(snapshot) || !['registered', 'signed_out'].includes(snapshot.state)
    || snapshot.state === 'registered' && (!snapshot.deviceId || typeof snapshot.deviceId !== 'string')) return null;
  try {
    const [origin, status] = await Promise.all([invoke('hub_origin'), invoke('desktop_account_status')]);
    return homeAccountCurrent(snapshot) && homeNativeAccountMatches(snapshot, status)
      ? { ...snapshot, origin: homeCanonicalOrigin(origin) } : null;
  } catch { return null; }
}
async function confirmHomeScope(captured) {
  if (!captured || !homeAccountCurrent(captured)) return false;
  try {
    const [origin, status] = await Promise.all([invoke('hub_origin'), invoke('desktop_account_status')]);
    return homeAccountCurrent(captured) && homeNativeAccountMatches(captured, status) && homeCanonicalOrigin(origin) === captured.origin;
  } catch { return false; }
}
function validHomeProfileId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 && value.trim() === value
    && !/\p{Cc}|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}
const PERSON_AVATAR_SVG = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0"/></svg>';
function clearHomePrivateDom() {
  selfProfileId = null; selfProfileHandle = null;
  setBadge('nav-badge-notifications', 0); setBadge('nav-badge-messages', 0);
  for (const selector of ['#home-attention', '#home-notifications', '#home-messages', '#home-device', '#profile-posts']) document.querySelector(selector)?.replaceChildren();
  for (const selector of ['#composer-avatar', '#account-avatar', '#profile-avatar']) {
    const avatar = document.querySelector(selector); if (!avatar) continue;
    avatar.replaceChildren(); avatar.classList.remove('has-image'); avatar.removeAttribute('style');
    if (selector === '#composer-avatar') avatar.innerHTML = PERSON_AVATAR_SVG; else avatar.textContent = '?';
  }
  paintRailAvatar(document.querySelector('#rail-profile-avatar'), null, hubAsset);
  const accountName = document.querySelector('#account-name'); if (accountName) accountName.textContent = 'プロフィール';
  for (const selector of ['#profile-name', '#profile-handle', '#profile-stats', '#profile-bio', '#profile-facts', '#profile-actions']) { const node = document.querySelector(selector); if (node) node.textContent = ''; }
  const profileCard = document.querySelector('.profile-card'); if (profileCard) profileCard.hidden = true;
}
function invalidateSavedSearchScope() {
  savedSearchScopeRequest = {}; savedSearchViewEpoch = {}; verifiedSavedSearchScope = null;
  savedSearchPanel?.refreshScope();
}
function savedSearchScopeSnapshot() {
  const value = verifiedSavedSearchScope;
  return value && homeAccountCurrent(value) && value.viewEpoch === savedSearchViewEpoch
    ? { key: value.key, generation: value.viewEpoch } : null;
}
async function refreshSavedSearchScope() {
  if (!savedSearchPanel || currentView !== 'search') return false;
  const request = savedSearchScopeRequest = {}, viewEpoch = savedSearchViewEpoch, snapshot = homeAccountSnapshot();
  verifiedSavedSearchScope = null; savedSearchPanel.refreshScope();
  const current = () => request === savedSearchScopeRequest && viewEpoch === savedSearchViewEpoch && currentView === 'search' && homeAccountCurrent(snapshot);
  try {
    const captured = await captureHomeScope(snapshot); if (!captured || !current()) return false;
    let profileId = 'guest';
    if (captured.state === 'registered') {
      const me = await invoke('hub_client', { name: 'me' });
      if (!current() || !validHomeProfileId(me?.profile?.id)) return false;
      profileId = me.profile.id;
    }
    if (!current() || !await confirmHomeScope(captured) || !current()) return false;
    verifiedSavedSearchScope = { ...captured, viewEpoch, key: JSON.stringify([captured.origin, profileId]) };
    return savedSearchPanel.refreshScope();
  } catch { if (current()) { verifiedSavedSearchScope = null; savedSearchPanel.refreshScope(); } return false; }
}
function syncSavedSearchView(previousView, view) {
  if (!savedSearchPanel || previousView === view) return;
  invalidateSavedSearchScope();
  if (view === 'search') void refreshSavedSearchScope();
}
function invalidateHomeAccount() {
  homeAccountEpoch = {}; homeSummaryRequest = {}; homeExtrasRequest = {};
  clearHomePrivateDom(); invalidateSavedSearchScope();
  if (savedSearchPanel && currentView === 'search') void refreshSavedSearchScope();
}
window.addEventListener('hub-account-changed', invalidateHomeAccount);
window.addEventListener('hub-origin-changed', invalidateHomeAccount);


// 同梱SVGアイコン（24×24・stroke）。静的なものはindex.htmlへ直接書き、
// JSで組み立てる要素だけここから取る。
// Web版（components/v2/v2-icons.tsx）と同じ絵柄・同じパスに揃える。
const ICONS = {
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 3.5v3.7h-3.7"/>',
  // 2026-11-05 所有者「返信ボタンは吹き出しの方がいい」：矢印をやめて丸い吹き出し。
  reply: '<path d="M20.5 11.5a8.5 8.5 0 0 1-12.4 7.6L3.5 20.5l1.4-4.6A8.5 8.5 0 1 1 20.5 11.5Z"/>',
  repost: '<path d="M17 3l4 4-4 4M21 7H8a4 4 0 0 0-4 4v1M7 21l-4-4 4-4M3 17h13a4 4 0 0 0 4-4v-1"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z"/>',
  bookmark: '<path d="M7 4h10v16l-5-3.5L7 20V4Z"/>',
  share: '<path d="M12 3v12M8 7l4-4 4 4M5 13v6h14v-6"/>',
  flag: '<path d="M5 21V4m0 1c2-2 4-2 7 0s5 2 7 0v10c-2 2-4 2-7 0s-5-2-7 0"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.1-3.6-8.5S9.6 5.8 12 3.5Z"/>',
  people: '<circle cx="9" cy="9" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0M16 6.2a3.2 3.2 0 0 1 0 5.6M18 14.4A6 6 0 0 1 21 20"/>',
  more: '<circle cx="5.5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18.5" cy="12" r="1.4"/>',
  doc: '<path d="M7 3h7l4 4v14H7V3Z"/><path d="M14 3v4h4M10 12h5M10 16h5"/>',
  at: '<circle cx="12" cy="12" r="3.5"/><path d="M15.5 12v1.3a2.4 2.4 0 0 0 4.8 0V12a8.3 8.3 0 1 0-3.3 6.6"/>',
  userplus: '<path d="M10 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM3 21a7 7 0 0 1 14 0M19 8v6M16 11h6"/>',
  bubble: '<path d="M5 5h14v10H10l-4 4v-4H5V5Z"/>',
  compose: '<path d="M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 5-4.5 3.5 3 3-2.5 4.5 4"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  star: '<path d="m12 4 2.4 5 5.6.7-4.1 3.9 1 5.6-4.9-2.7-4.9 2.7 1-5.6L4 9.7l5.6-.7z"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.6c0-1 1-1.6 2.5-1.6s2.5.6 2.5 1.6-1 1.4-2.5 1.7-2.5.7-2.5 1.7 1 1.6 2.5 1.6 2.5-.6 2.5-1.6M12 6.8V8M12 16v1.2"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.3 2.4 2.4 4.6-5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0v4l2 3H4l2-3V9ZM10 19h4"/>',
  message: '<path d="M4 6h16v12H4zm0 1 8 6 8-6"/>',
  mail: '<path d="M4 6h16v12H4zm0 1 8 6 8-6"/>',
  alert: '<path d="M12 4 21 19.5H3z"/><path d="M12 10v4M12 16.8h.01"/>',
  clock: '<path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7v5l3 2"/>',
  user: '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0"/>',
  wallet: '<path d="M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm0 0V6a2 2 0 0 1 2-2h11M16 13h5v4h-5a2 2 0 0 1 0-4Z"/>',
  search: '<path d="M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Zm9.5 16-4.5-4.5"/>',
  cart: '<path d="M6 8h12l-1 12H7L6 8Z"/><path d="M9 8V7a3 3 0 0 1 6 0v1"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3V9Z"/>',
  poll: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
  quote: '<path d="M5 8h5v5H7a2 2 0 0 0 2 2M14 8h5v5h-3a2 2 0 0 0 2 2"/>',
  licence: '<circle cx="12" cy="12" r="8.5"/><path d="M14.5 9.8a3.2 3.2 0 1 0 0 4.4"/>',
  embed: '<path d="m9 8-4 4 4 4M15 8l4 4-4 4"/>',
  title: '<path d="M5 6V5h14v1M12 5v14M9 19h6"/>',
  paper: '<path d="M7 3h7l4 4v14H7V3Z"/><path d="M14 3v4h4M10 11h5M10 14h5M10 17h3"/>',
  music: '<path d="M9 17V5l10-2v12M9 7l10-2"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  // コミュニティの見出し・概要・固定（2026-11-10）。
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><path d="M12 7.6v.2"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="14" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  pin: '<path d="M9 4h6l-1 6 3 3.5H7L10 10 9 4Z"/><path d="M12 13.5V20"/>',
};
const icon = (name, filled = false) =>
  `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"${filled ? ' fill="currentColor" stroke="none"' : ""}>${ICONS[name]}</svg>`;

// 名前から安定した色相を出し、文字アバターの背景に使う。
function nameColor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 42% 36%)`;
}
function paintAvatar(node, seed) {
  // 頭字の顔の色は CSS が決める（2026-10-29）。ここは色を直接塗らず、Web と同じ 6 色のうちの番号だけを data-tint に置く
  // （31 倍のハッシュを 6 で割った余り。色は --avatar-N / --avatar-N-text の意味名の変数）。
  // 頭字は先頭の【…】・[…] の札を飛ばして取る。前に付いた塗りだけを消す。
  node.style.removeProperty("background");
  node.style.removeProperty("border-color");
  node.style.removeProperty("color");
  node.dataset.tint = String(avatarTint(seed));
  if (!node.querySelector("img")) node.textContent = displayInitial(seed);
}

// The last per-user call failed because the Account service was unreachable.
// Enrolment is local, so Settings must not read as a clean "connected" then.
let accountFault = false;
function markAccountFault(value) {
  if (accountFault === value) return;
  accountFault = value;
  if (value) document.documentElement.dataset.accountFault = "1"; else delete document.documentElement.dataset.accountFault;
  const registered = desktopAccount.state === "registered";
  const pending = desktopAccount.state === "pending";
  const expired = desktopAccount.state === "expired";
  for (const el of document.querySelectorAll('[data-account="state"]')) {
    el.textContent = accountStateLabel({ registered, pending, expired, fault: accountFault });
  }
}

function renderDesktopAccount(status) {
  const wasRegistered = desktopAccount.state === "registered";
  const accountChanged = !desktopAccountLoaded || desktopAccount.state !== status.state || desktopAccount.deviceId !== status.deviceId;
  desktopAccount = status;
  desktopAccountLoaded = true;
  queueMicrotask(() => void refreshSavedSearchScope());
  if (accountChanged) window.dispatchEvent(new Event("hub-account-changed"));
  const registered = status.state === "registered";
  const pending = status.state === "pending";
  const expired = status.state === "expired";
  // アカウント表示はフィード・設定で同じ。data-account属性で
  // まとめて更新する（どの画面が開いていても片方だけ古くならない）。
  for (const el of document.querySelectorAll('[data-account="title"]')) {
    el.textContent = registered ? "Desktop接続済み" : pending ? "端末の承認待ち" : "ログインが必要です";
  }
  for (const el of document.querySelectorAll('[data-account="copy"]')) {
    el.textContent = registered
      ? "端末鍵の所持証明で短時間の認証票を取得します。ブラウザCookieは使用しません。"
      : pending ? `確認コード ${status.userCode} を承認画面へ入力してください。` : "Hubプロフィールの機能を使うにはDesktop端末を接続してください。";
  }
  for (const el of document.querySelectorAll('[data-account="state"]')) {
    // Keep this self-contained (tests evaluate this function in isolation); the
    // fault flag lives on <html> and is set by markAccountFault.
    el.textContent = registered ? (document.documentElement.dataset.accountFault ? "接続済み（アカウントのサービスに接続できません）" : "接続済み") : pending ? "承認待ち" : expired ? "期限切れ" : "未接続";
  }
  for (const button of document.querySelectorAll('[data-account="login"]')) {
    button.textContent = registered ? "接続を確認" : pending ? "承認画面へ戻る" : expired ? "新しい登録コードを作る" : "Desktopを接続";
    // 設定の接続カード：状態にかかわらず二番手のボタンにする（PLAN 段階3）。
    if (button.closest("#view-settings")) { button.classList.remove("approve", "head-action"); button.classList.add("btn", "btn-secondary"); }
  }
  for (const button of document.querySelectorAll('[data-account="logout"]')) {
    button.hidden = status.state === "signed_out";
  }
  // 接続済みなら大きな案内帯は畳む——Web版のフィードにこの帯は無い。
  // 未接続・承認待ち・期限切れのときだけ残る（接続の入口なので）。
  const callout = document.querySelector("#desktop-account-callout");
  if (callout) callout.hidden = registered || document.querySelector("#composer-storage")?.value === "node";
  // 未接続なら入力欄ごと出さない——Web版もサインイン無しには投稿欄を
  // 出さない。無効化した欄と案内帳の2段は、同じことを二度言っている。
  const composerForm = document.querySelector("#composer");
  const composerText = document.querySelector("#composer-text");
  if (composerForm && composerText) {
    composerForm.hidden = false;
    const localPost = document.querySelector("#composer-storage")?.value === "node";
    composerForm.classList.toggle("locked", !registered && !localPost);
    composerText.disabled = !registered && !localPost;
    composerText.placeholder = localPost ? "自分のノードに残す公開投稿" : registered ? "いまどうしてる？" : "Desktopを接続すると投稿できます";
  }
  document.querySelector(".rail")?.classList.toggle("rail-account-ready", registered);
  for (const note of document.querySelectorAll("[data-rail-signin]")) note.hidden = registered;
  if (!registered && wasRegistered && railActivityReady) {
    for (const name of ["notifications", "messages"]) {
      railLoadRevision.set(name, (railLoadRevision.get(name) ?? 0) + 1);
      railLoaded.delete(name);
      document.querySelector(`#rail-${name}`)?.replaceChildren(railPanels.railSignedOut(document, name, () => void connectDesktopAccount()));
    }
  }
  if (registered && !wasRegistered && railActivityReady) void refreshRailActivity(true);
}

async function refreshDesktopAccount(poll = false) {
  try {
    const status = await invoke(poll ? "poll_desktop_account" : "desktop_account_status");
    renderDesktopAccount(status);
    return status;
  } catch {
    renderDesktopAccount({ state: "signed_out" });
    return null;
  }
}

async function connectDesktopAccount() {
  let status = desktopAccount;
  if (status.state === "signed_out" || status.state === "expired") status = await invoke("begin_desktop_account", { label: "このPC" });
  if (status.state === "registered") { await loadFeed(); return; }
  if (status.state !== "pending" || !status.approvalUrl || !status.userCode) return;
  if (!window.confirm(`確認コードは ${status.userCode} です。\n\n既定のブラウザで開く承認ページで端末名と鍵の指紋を確認し、この4桁を入力してください。`)) return;
  // 承認はWeb版のページなので既定ブラウザへ——アプリ内ブラウザは
  // Web版Hubを開かない。
  void invoke("open_external", { url: status.approvalUrl }).catch(() => undefined);
}

for (const button of document.querySelectorAll('[data-account="login"]')) {
  button.onclick = () => void connectDesktopAccount();
}
for (const button of document.querySelectorAll('[data-account="logout"]')) {
  button.onclick = async () => {
    if (!window.confirm("この端末に保存したDesktop認証鍵を削除してログアウトします。Account側の登録履歴と端末内データは削除されません。続けますか？")) return;
    await invoke("logout_desktop_account");
    await refreshDesktopAccount();
    await loadFeed();
    void loadHomeSummary();
  };
}
// アカウント状態はアプリ窓の画面だけが使う。道具窓・バーwebviewでは聞かない。
if (!startupTool) void refreshDesktopAccount(true);

// AIの作業面は同じHub窓のAI画面へ置く。既存の同梱dialogのDOMを再利用し、
// 専用窓向けの実行設定・履歴・承認UIを二重に持たない。
const dialogs = {
  harness: document.querySelector("#harness-dialog")
};
if (!startupTool) {
  const layout = document.querySelector("#harness-dialog .harness-layout");
  document.querySelector("#ai-workspace").append(layout);
  const moreContent = document.querySelector("#ai-more-content");
  const status = document.querySelector("#ai-status");
  for (const section of [...layout.querySelector(".harness-main").children].filter((node) => node.id !== "pi-work")) {
    moreContent.insertBefore(section, status);
  }
  moreContent.prepend(moreContent.querySelector(".workspace-card"));
  const moreDialog = document.querySelector("#ai-more");
  document.querySelector("#ai-more-open").onclick = () => moreDialog.showModal();
  document.querySelector("#ai-more-close").onclick = () => moreDialog.close();
  const history = layout.querySelector(".harness-history");
  const narrow = matchMedia("(max-width: 860px)");
  const placeHistory = () => {
    if (narrow.matches || document.querySelector("#rail-ai-workspace-host")?.contains(layout)) layout.prepend(history);
    else document.querySelector("#sidebar-ai-history").append(history);
  };
  placeHistory();
  narrow.addEventListener("change", placeHistory);
}

function openTool(name) {
  const dialog = dialogs[name];
  if (!dialog || dialog.open) return;
  dialog.showModal();
  if (name === "harness") void subscriptionUsageController?.refresh();
}

for (const button of document.querySelectorAll("[data-close]")) {
  button.onclick = () => document.querySelector(`#${button.dataset.close}`)?.close();
}
for (const dialog of Object.values(dialogs)) {
  dialog.onclick = (event) => { if (event.target === dialog) dialog.close(); };
}
// 外部のペア済みHub画面からの通知も、この同じ窓のAI画面へ案内する。
await window.__TAURI__.event.listen("hub-open-harness", () => {
  if (!startupTool) void navigateFrom(document.querySelector('#primary-nav [data-view="ai"]'));
  else if (startupTool === "harness") openTool("harness");
});
if (!startupTool) await window.__TAURI__.event.listen("hub-exit-save-failed", () => showNotice("タブを保存できないため終了を中止しました。もう一度お試しください。"));
// ウォレットへの署名・送金要求。ブラウザ内のHubページから来ても、
// ネイティブ面の操作から来ても、ここのモーダルだけが承認口になる。
// 応答は必ず返す（戻らないと要求側がタイムアウトまで待つ）。
{
  const dialog = document.querySelector("#wallet-confirm-dialog");
  const summary = document.querySelector("#wallet-confirm-summary");
  const detail = document.querySelector("#wallet-confirm-detail");
  const approve = document.querySelector("#wallet-confirm-approve");
  const deny = document.querySelector("#wallet-confirm-deny");
  const answered = new Map();
  const validId = (id) => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
  const validText = (text, limit) => typeof text === "string" && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text) && new TextEncoder().encode(text).length <= limit;
  let current = null;
  const send = (id, approved) => {
    if (answered.has(id)) return;
    answered.set(id, Date.now() + 120000);
    try { Promise.resolve(invoke("wallet_confirm_respond", { id, approved })).catch(() => undefined); }
    catch { /* Native側の期限とclosed通知でも確認を終了する。 */ }
  };
  const close = (request) => {
    if (current !== request) return;
    current = null;
    clearTimeout(request.timer);
    approve.disabled = deny.disabled = true;
    summary.textContent = detail.textContent = "";
    if (dialog.open) dialog.close();
  };
  const respond = (request, approved) => {
    if (!request || current !== request) return;
    const allowed = approved && Date.now() < request.expiresAt;
    close(request);
    send(request.id, allowed);
  };
  approve.disabled = deny.disabled = true;
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); respond(current, false); });
  dialog.addEventListener("close", () => { if (!dialog.open) respond(current, false); });
  window.addEventListener("pagehide", () => respond(current, false));
  await window.__TAURI__.event.listen("wallet-confirm-request", (event) => {
    const payload = event.payload ?? {};
    if (!validId(payload.id)) return;
    const now = Date.now();
    for (const [id, until] of answered) if (until <= now) answered.delete(id);
    if (answered.has(payload.id) || current?.id === payload.id) return;
    if (current || !validText(payload.summary, 8192) || !validText(payload.detail, 131072) ||
        !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= now || payload.expiresAt > now + 120000) {
      send(payload.id, false);
      return;
    }
    const request = { id: payload.id, expiresAt: payload.expiresAt, timer: null };
    current = request;
    summary.textContent = payload.summary;
    detail.textContent = payload.detail;
    approve.disabled = deny.disabled = false;
    approve.onclick = () => respond(request, true);
    deny.onclick = () => respond(request, false);
    request.timer = setTimeout(() => respond(request, false), request.expiresAt - now);
    try { dialog.showModal(); document.querySelector("#wallet-confirm-content").scrollTop = 0; deny.focus(); }
    catch { respond(request, false); }
  });
  await window.__TAURI__.event.listen("wallet-confirm-closed", (event) => {
    const payload = event.payload ?? {};
    if (current?.id !== payload.id || !["completed", "expired", "cancelled", "unavailable"].includes(payload.reason)) return;
    answered.set(current.id, Date.now() + 120000);
    close(current);
  });
}
const returnToHub = document.querySelector("#return-to-hub");
returnToHub.hidden = startupTool !== "harness";
returnToHub.onclick = async () => {
  returnToHub.disabled = true;
  try { await invoke("return_to_hub"); }
  catch { document.querySelector("#pi-work-error").textContent = "Hubへ戻れませんでした。Hubのメインウィンドウを確認してください。"; }
  finally { returnToHub.disabled = false; }
};
if (startupTool === "harness") {
  document.body.classList.add("native-tool");
  openTool(startupTool);
}

// ブラウザの操作面（ワークスペース型）。タブの一覧はサイドバーのタブ欄、
// 戻る/進む・アドレス・履歴などの操作はブラウザ面の上部ストリップが持つ。
// ページ本体は Rust 側の子webviewがステージ領域へ描く。
let browserAiReference=null,browserAiReferenceGeneration=0;
if(!startupTool){
  browserAiReference=createBrowserAiReference({document,host:document.querySelector('#rail-browser-reference'),open:url=>enterBrowser(url)});
  for(const event of ['hub-account-changed','hub-origin-changed','beforeunload'])window.addEventListener(event,()=>{browserAiReferenceGeneration++;browserAiReference.clear();});
}
let piWorkDraftHandler = null;
let syncPiChangesView = null;
async function stageBrowserAiDraft(draft, source) {
  const generation=researchAccountGeneration,account=desktopAccount,referenceGeneration=browserAiReferenceGeneration;
  const authority=()=>referenceGeneration===browserAiReferenceGeneration&&generation===researchAccountGeneration&&account===desktopAccount;
  const current=()=>authority()&&source?.isCurrent?.()!==false;
  if(!current())return false;
  if (!piWorkDraftHandler) throw new Error("ai_work_unavailable");
  let accepted=false,attempted=false;
  const result=await piWorkDraftHandler(draft,{isCurrent:current,onAccepted:()=>{if(attempted)return false;attempted=true;return accepted=current()&&browserAiReference?.show(source?.reference)===true;}});
  return result===true&&accepted&&authority()&&browserAiReference?.matches(source?.reference?.url)===true;
}
function initBrowserControls() { browserControls = initBrowserWorkspace({
  document, window, invoke, icon, enterBrowser,
  isActive: () => browserActive, getView: () => currentView,
  onAiDraft: stageBrowserAiDraft, onHubSearch: (term) => runHubSearch(term), metrics: controlMetrics,
  getHubHistory: () => Object.fromEntries([['back', '#toolbar-back'], ['forward', '#toolbar-forward']].map(([direction, selector]) => {
    const button = document.querySelector(selector);
    return [direction, { available: !button.disabled, label: button.title }];
  })),
  onHubHistory: (direction) => travelToolbar(direction),
});
}

// --- アプリの主要画面 ---
// Web の URL を WebView に詰めるのではなく、同じ目的地を Desktop の画面へ
// ブラウザでも十分な幅があるときは、別の作業を右列に並べる。
const rightRailAvailable = (view) => view !== "browser" || matchMedia("(min-width: 1180px)").matches;
// 既定は 1440 以上で開き、それ未満は閉じる（2026-11-01）。選んだ状態は hub.desktop.railOpen に残り、あれば既定より優先する。
let railUserChoice = matchMedia("(min-width: 1440px)").matches;
let browserRailChoice = false;
let sidebarCollapsedForRail = false;
const RAIL_VIEWS = ["browser", "posts", "search", "notifications", "messages", "music", "video", "wallet", "ai"];
const RAIL_VIEW_NAMES = { browser: "ブラウザ", posts: "タイムライン", search: "資料・検索", notifications: "通知", messages: "メッセージ", music: "音楽", video: "動画", wallet: "ウォレット", ai: "AI" };
// 右列の既定は「音楽」（2026-10-15 所有者決定。ブラウザは Hub を出さないので既定にしない）。選んだ表示は端末に保存される。
const RAIL_VIEW_KEY = "hub.desktop.railView.v2";
const MAIN_RAIL_VIEWS = { home: "posts", feed: "posts", search: "search", notifications: "notifications", messages: "messages", community: "posts", music: "music", ai: "ai" };
let railPreferredView = "music";
let railView = railPreferredView;
try {
  const saved = localStorage.getItem(RAIL_VIEW_KEY);
  if (RAIL_VIEWS.includes(saved)) railPreferredView = saved;
  railView = railPreferredView;
  const open = localStorage.getItem("hub.desktop.railOpen");
  if (open !== null) railUserChoice = open === "true";
  browserRailChoice = localStorage.getItem("hub.desktop.browserRailOpen") === "true";
} catch {}
// 右列の「コミュニティ」はタイムラインの「グループ」になった。以前の選択はタイムラインのグループ（参加中）へ引き継ぐ。
try {
  if (localStorage.getItem(RAIL_VIEW_KEY) === "community") {
    railPreferredView = railView = "posts";
    localStorage.setItem(RAIL_VIEW_KEY, "posts");
    localStorage.setItem("hub.desktop.railTimeline.v1", JSON.stringify({ kind: "groups", sorts: { groups: "joined" } }));
  }
} catch {}
const railChoiceFor = (view) => view === "browser" ? browserRailChoice : railUserChoice;
function saveRailChoice(open) {
  if (currentView === "browser") browserRailChoice = open;
  else railUserChoice = open;
  try { localStorage.setItem(currentView === "browser" ? "hub.desktop.browserRailOpen" : "hub.desktop.railOpen", String(open)); } catch {}
}
function syncSidebarForRail(open) {
  const shell = document.querySelector(".app-shell");
  const narrow = matchMedia("(min-width: 861px) and (max-width: 1179px)").matches;
  if (open && narrow && !shell.classList.contains("sidebar-collapsed")) {
    shell.classList.add("sidebar-collapsed");
    sidebarCollapsedForRail = true;
  } else if (sidebarCollapsedForRail && matchMedia("(min-width: 861px)").matches && (!open || !narrow)) {
    // 中身の無い画面では、右列を閉じても左の列は畳んだままにする（中身のある画面へ移れば開き直す）。
    if (sidebarEmptyView) sidebarCollapsedForEmpty = true;
    else shell.classList.remove("sidebar-collapsed");
    sidebarCollapsedForRail = false;
  }
}
let appsOpen = false;

const readingDirectory = new Map(["articles", "hubpedia", "community", "threads"].map(view => [view, { items: [], query: "", filter: "" }]));
const SIDEBAR_FAMILY = {
  home: "discovery", search: "discovery", hubpedia: "discovery", articles: "discovery", videos: "discovery",
  music: "discovery", books: "discovery", ranking: "discovery", services: "discovery",
  node: "discovery", compute: "discovery", community: "community", threads: "threads", bookmarks: "feed", lists: "feed",
  mail: "messages", contacts: "messages", purchased: "market", cart: "market", order: "market",
  profile: "account", settings: "account", wallet: "account",
};
const SIDEBAR_TITLES = { feed: "タイムライン", discovery: "コンテンツ", notifications: "通知", messages: "受信トレイ", market: "マーケット", account: "アカウント" };
const DETAIL_SIDEBAR_FAMILY = {
  saved_articles:"discovery",article_drafts:"discovery",video_library:"discovery",music_library:"discovery",video_playlists:"discovery",music_playlists:"discovery",music_playlist:"discovery",music_artists:"discovery",
  community_governance:'community',community_governance_proposal:'community',community_governance_settings:'community',community_governance_create_context:'community',community_governance_mutation_context:'community',
  research_project: "research",
  research_network_fork: "research",
  research_document: "research",
  research_revision: "research",
  research_discussion: "research", research_proposal: "research",
  research_git_management: "research", research_git_history: "research", research_git_commit: "research", research_git_compare: "research", research_git_proposals: "research", research_git_proposal: "research", research_git_discussion: "research",
  post: "feed", thread: "threads", community: "community", tag: "feed", list: "feed",
  ranking_item: "discovery", service_item: "discovery",
  article: "discovery", hubpedia_article: "discovery", book: "discovery", book_chapter: "discovery", video: "discovery", music_artist: "discovery", music_album: "discovery",
  listing: "market", commerce_product: "market",
  community_reports:"community", community_report:"community", community_appeals:"community", community_appeal:"community", community_appeal_history:"community", community_membership_requests:"community", community_membership_request:"community", community_members: "community", profile: "feed",
  community_guides: "community", community_guide: "community", community_guide_revisions: "community", community_guide_revision: "community",
  community_guide_proposals: "community", community_guide_proposal: "community",
};
const DETAIL_PARENT_VIEW = {
  saved_articles:'articles',article_drafts:'articles',video_library:'videos',music_library:'music',video_playlists:'videos',music_playlists:'music',music_playlist:'music',music_artists:'music',
  community_governance:'community',community_governance_proposal:'community',community_governance_settings:'community',community_governance_create_context:'community',community_governance_mutation_context:'community',
  research_project: "research",
  research_network_fork: "research",
  research_document: "research",
  research_revision: "research",
  research_discussion: "research", research_proposal: "research",
  research_git_management: "research", research_git_history: "research", research_git_commit: "research", research_git_compare: "research", research_git_proposals: "research", research_git_proposal: "research", research_git_discussion: "research",
  post: "feed", thread: "threads", community: "community", tag: "feed", list: "lists", profile: "feed",
  ranking_item: "ranking", service_item: "services",
  article: "articles", hubpedia_article: "hubpedia", book: "books", book_chapter: "books", video: "videos", music_artist: "music", music_album: "music",
  listing: "market", commerce_product: "market", community_reports:"community", community_report:"community", community_appeals:"community", community_appeal:"community", community_appeal_history:"community", community_membership_requests:"community", community_membership_request:"community", community_members: "community",
  community_guides: "community", community_guide: "community", community_guide_revisions: "community", community_guide_revision: "community",
  community_guide_proposals: "community", community_guide_proposal: "community",
};
// 「すべて」は、ほかから1手で行けない機能だけ（2026-11-07 所有者承認 docs/hub-desktop-ui-cost/IA.md）。
// 左の列：タイムライン・通知・メッセージ・コミュニティ・動画・音楽・記事・マーケット／右の列：ブラウザ・AI・ウォレット／上の欄：検索。
// スレッド・ブックマーク・リストはフィードの木、メール・連絡先はメッセージの木、プロフィール・設定は左の列の下。
const APP_GROUPS = [
  ["知識・制作", [["プロジェクトと研究", "research"], ["ゲーム", "games"], ["Hubpedia", "hubpedia"], ["本", "books"], ["コード", "code"]]],
  ["この端末", [["Personal Node", "node"], ["Compute", "compute"]]],
  ["その他", [["概要", "home"], ["ランキング", "ranking"], ["サービス", "services"]]],
];
const sidebarContext = document.querySelector("#sidebar-context");
{
  const shell = document.querySelector(".app-shell"), toggle = document.querySelector("#rail-expand-toggle");
  const apply = (expanded) => {
    shell.classList.toggle("rail-expanded", expanded);
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute("aria-label", expanded ? "メニューを狭める" : "メニューを広げる");
    toggle.title = toggle.getAttribute("aria-label");
  };
  let stored = false;
  try { stored = localStorage.getItem("hub.rail.expanded") === "1"; } catch {}
  apply(stored);
  toggle.addEventListener("click", () => {
    const expanded = !shell.classList.contains("rail-expanded");
    apply(expanded);
    try { localStorage.setItem("hub.rail.expanded", expanded ? "1" : "0"); } catch {}
    queueMicrotask(() => { try { applyColumnWidths(); } catch { /* 起動前の呼び出しは何もしない */ } });
  });
}
// 左の列の「コミュニティ」の下に並べる具体的な一覧（参加中が先・最大8件。1つも入っていなければ公開の人気）。5分は読み直さない。左の記号の帯には置かない。
const communitiesHost = document.createElement("div");
communitiesHost.className = "nav-communities";
communitiesHost.setAttribute("role", "group");
communitiesHost.setAttribute("aria-label", "コミュニティ");
communitiesHost.hidden = true;
const navCommunities = createNavCommunities({
  document, host: communitiesHost, asset: (img, url) => hubAsset(img, url),
  load: () => invoke("hub_resource", { resource: "communities", query: "" }),
  signedIn: () => desktopAccount.state === "registered",
  onOpen: (row) => { if (communitiesHost.closest(".sidebar-tree")) sidebarContextOwner = "feed"; void openDetail("community", [row.id], { title: row.name }); },
  onAll: () => void navigateFrom({ dataset: { view: "community" }, childNodes: [] }),
  onSub: (key, row) => {
    const open = detailTrail.at(-1);
    if (currentView === "detail" && open?.name === "community") selectCommunitySection(open, key);
    else if (row?.id) void openDetail("community", [row.id], { title: row.name, targetSelection: { section: key } });
  },
});

window.addEventListener("hub-account-changed", () => { navCommunities.clear(); if (currentView === "community" || sidebarParentView() === "community") renderSidebarContext(currentView); });
let nativeSidebar = null;
const messagesSide = document.querySelector(".messages-side");
const messagesLayout = document.querySelector(".messages-layout");
const mailListCol = document.querySelector(".mail-list-col");
const mailLayoutNode = document.querySelector(".mail-layout");

// 内側左列の下段「あなたのもの」（sidebar-mine.mjs、2026-10-29）。読み出しは既存の hub_client / hub_detail と端末の状態だけ。
// 先頭固定は端末の保存領域に、端末のアカウント（deviceId）ごとに覚える。
const mineGo = (view) => document.querySelector(`.icon-rail [data-view="${view}"], #primary-nav [data-view="${view}"]`)?.click();
const mineClick = (selector) => document.querySelector(selector)?.click();
const mineTitle = (item) => (typeof item?.title === "string" && item.title) || (typeof item?.name === "string" && item.name) || "";
const mineRows = (list, make) => ({ items: (Array.isArray(list) ? list : []).map(make).filter((row) => row.id && row.label) });
const mineRemote = async (kind, tags) => {
  await sidebarRemote.load(kind);
  const entry = sidebarRemote.state(kind);
  if (entry.failed) throw new Error("sidebar_failed");
  return tags ? mineRows(sidebarRemote.tags(), (tag) => ({ id: tag, label: tag })) : mineRows(entry.items, (item) => ({ id: item.id, label: item.name, raw: item }));
};
const mineClient = (name) => Promise.resolve(invoke("hub_client", { name }));
const sidebarMine = createSidebarMine({
  document,
  storage: { getItem: (key) => { try { return window.localStorage.getItem(key); } catch { return null; } }, setItem: (key, value) => { try { window.localStorage.setItem(key, value); } catch { /* 覚えられなくても操作は効く */ } } },
  profile: () => desktopAccount.deviceId ?? "local",
  epoch: () => homeAccountEpoch,
  registered: () => desktopAccount.state === "registered",
  changed: () => renderSidebarContext(currentView),
  sources: {
    "feed.tags": () => mineRemote("feed", true),
    "feed.lists": async () => mineRows((await mineClient("lists"))?.lists, (list) => ({ id: list?.id, label: list?.name || "リスト", meta: (list?.profileIds ?? []).length || "" })),
    "articles.writers": () => mineRemote("articles", false),
    "articles.tags": () => mineRemote("articles", true),
    "articles.drafts": async () => mineRows(parseDrafts(await mineClient("article_drafts")), (draft) => ({ id: draft.id, label: draft.title })),
    "articles.saved": async () => mineRows((await mineClient("saved_articles"))?.articles, (item) => ({ id: item?.id, label: mineTitle(item), raw: item })),
    "videos.tags": () => mineRemote("videos", true),
    "videos.channels": () => mineRemote("videos", false),
    "videos.later": async () => mineRows((await mineClient("video_library"))?.savedVideos, (item) => ({ id: item?.id, label: mineTitle(item), raw: item })),
    "music.tags": () => mineRemote("music", true),
    "music.playlists": async () => mineRows((await mineClient("music_playlists"))?.playlists, (item) => ({ id: item?.id, label: mineTitle(item) })),
    "music.favorites": async () => { const data = await mineClient("music_favorites"); return mineRows(data?.works ?? data?.favorites ?? data?.tracks, (item) => ({ id: item?.id, label: mineTitle(item) })); },
    "music.recent": () => mineRows(musicHistory.list().map((entry) => entry.track ?? entry.work), (item) => ({ id: item?.id, label: mineTitle(item) })),
    "market.cart": () => { const lines = cartLines(); return { ...mineRows(lines, ({ id, product, quantity }) => ({ id, label: product.title, meta: quantity > 1 ? `×${quantity}` : "" })), count: lines.reduce((n, line) => n + line.quantity, 0) }; },
    "research.projects": () => mineRows(researchWorkspace.projects(), (project) => ({ id: project?.id, label: project?.title })),
  },
  actions: {
    signIn: () => mineGo("settings"),
    open(key, item) {
      if (["feed.tags", "articles.tags", "videos.tags", "music.tags"].includes(key)) void openDetail("tag", [item.id], { title: `#${item.id}` });
      else if (key === "feed.lists") void openDetail("list", [item.id], { title: item.label });
      else if (key === "articles.writers" || key === "videos.channels") { if (item.raw?.type === "profile" && item.raw.handle) void openDetail("profile", [item.raw.handle], { title: item.label }); else this.seeAll(key); }
      else if (key === "articles.saved") void openDetail("article", [item.id], { title: item.label });
      else if (key === "videos.later") void openDetail("video", [item.id], { title: item.label, local: true, data: item.raw });
      else if (key === "research.projects") void openDetail("research_project", [item.id], { title: item.label }, );
      else this.seeAll(key);
    },
    seeAll(key) {
      const target = { "feed.lists": () => mineGo("lists"), "feed.tags": () => mineGo("search"), "articles.writers": () => mineGo("articles"), "articles.tags": () => mineGo("articles"), "videos.tags": () => mineGo("videos"), "music.tags": () => mineGo("music"),
        "articles.drafts": () => mineClick("#articles-drafts"), "articles.saved": () => mineClick("#articles-saved"), "videos.channels": () => setVideoMode("subscriptions"),
        "videos.later": () => mineClick("#video-saved"), "music.playlists": () => mineClick("#music-playlists"), "music.favorites": () => mineClick("#music-saved"),
        "music.recent": () => openMusicSideMode("history"), "market.cart": () => mineClick("#market-cart-open"), "research.projects": () => mineGo("research") }[key];
      target?.();
    },
    empty(key) {
      const target = { "feed.tags": () => mineGo("search"), "feed.lists": () => mineGo("lists"), "articles.drafts": () => mineClick("#articles-drafts"), "videos.channels": () => mineGo("videos"),
        "videos.later": () => mineGo("videos"), "music.playlists": () => mineGo("music"), "music.favorites": () => mineGo("music"), "music.recent": () => mineGo("music"),
        "market.cart": () => mineGo("market"), "research.projects": () => mineClick("#research-create-web") }[key];
      (target ?? (() => mineGo(key.split(".")[0])))();
    },
  },
});
function appendSidebarMine(view) {
  const shell = document.querySelector(".app-shell");
  // The feed column is a tree that already holds its tags and lists, so the lower "あなたのもの" block would repeat them.
  if (appsOpen || ["ai", "browser"].includes(shell.dataset.sidebarContext) || view === "messages" || view === "feed" || sidebarFeedTreeOwned) return;
  if (["market", "cart", "purchased", "order"].includes(view)) return; // マーケットの木が列の全部
  if (view === "music" || (view === "detail" && MUSIC_TREE_DETAILS.has(detailTrail.at(-1)?.name))) return; // 音楽の木が列の全部
  if (view === "articles" || (view === "detail" && ["saved_articles", "article_drafts"].includes(detailTrail.at(-1)?.name))) return; // 記事の木が列の全部
  if (view === "videos" || (view === "detail" && ["video_library", "video_playlists"].includes(detailTrail.at(-1)?.name))) return; // 動画の木が列の全部（フォロー中・あとで見る・再生リスト）
  if (view === "research" || (view === "detail" && DETAIL_SIDEBAR_FAMILY[detailTrail.at(-1)?.name] === "research")) return; // 研究の木が列の全部
  const name = view === "detail" ? detailTrail.at(-1)?.name : "";
  const key = view === "detail"
    ? ({ saved_articles: "articles", article_drafts: "articles", video_library: "videos", music_library: "music", video_playlists: "videos", music_playlists: "music" }[name] ?? (name.startsWith("research_") ? "research" : null))
    : (["cart", "market"].includes(view) ? "market" : view);
  const node = key ? sidebarMine.render(key) : null;
  if (node) sidebarContext.append(node);
}

// 内側左列は「今の画面の中の行き先と一覧」だけを持つ（2026-10-15 旦那様「内側左列の使い方が下手すぎる」）。
// アイコンの列にある行き先は繰り返さず、本文の見出しのタブと同じものも二重に出さない。
// 中身の無い画面では列ごと畳む（利用者が畳んだ状態とは別に覚え、中身のある画面に戻れば開き直す）。
let sidebarCollapsedForEmpty = false;
let sidebarEmptyView = false;
// 自分宛て = メンションと返信。ほかの種類は返ってくる通知の type / targetType だけで分ける（返らない欄は作らない）。
const matchesNotifTab = (item, tab) => {
  if (tab === "unread") return !item.isRead;
  if (tab === "mention") return item.context === "mention" || item.type === "social_reply" || item.type === "thread_reply";
  if (tab === "feed") return item.targetType === "social_post" || item.targetType === "profile" || item.type === "followed";
  if (tab === "community") return item.targetType === "community_message";
  if (tab === "system") return item.type === "system";
  return true;
};
const NOTIF_TREE_MAIN = [["all", "すべて", "bell"], ["mention", "自分宛て", "at"]];
const NOTIF_TREE_FILTERS = [["unread", "未読", "system"], ["feed", "フィード", "post"], ["community", "コミュニティ", "community"], ["system", "お知らせ", "bell"]];
const notifCounts = (items) => Object.fromEntries([...NOTIF_TREE_MAIN, ...NOTIF_TREE_FILTERS].map(([key]) => [key, key === "all" ? 0 : items.filter((item) => matchesNotifTab(item, key)).length]));
const sidebarLists = { epoch: null, items: [], loading: false };
// フィードの木の行（タグ・リスト・話題・スレッド・コミュニティ）から開いた画面では、列を入れ替えず木のまま本文だけを変える（2026-11-02）。
// アイコンの列を直接押したら外す。木の行が押す「アイコンの列」は feedTreeNav で見分ける。
let sidebarContextOwner = null;
let feedTreeNav = false;
let sidebarFeedTreeOwned = false;
const FEED_TREE_VIEWS = new Set(["search", "threads", "community", "lists"]);
const FEED_TREE_DETAILS = new Set(["tag", "list", "community"]);
for (const rail of document.querySelectorAll(".icon-rail, #primary-nav, .account-nav")) {
  rail.addEventListener("click", () => { if (!feedTreeNav) sidebarContextOwner = null; }, true);
}
// 木の枝の最初と最後の行に印を付ける。線の上端と、最後の行の曲がり角はこの印で決まる（非同期で入る行があるため構造では決めない）。
function markTreeEdges(kids) {
  const items = [...kids.querySelectorAll(".sidebar-context-item, .sidebar-tree-sub, .sidebar-tree-note")]
    .filter((node) => !node.classList.contains("nav-community-all") && !node.closest("[hidden]"));
  for (const node of kids.querySelectorAll(".is-tree-first, .is-tree-last")) node.classList.remove("is-tree-first", "is-tree-last");
  items[0]?.classList.add("is-tree-first");
  items.at(-1)?.classList.add("is-tree-last");
}
// 音楽の木（music-tree.mjs）の持ち主：この名前の詳細でも、内側左列は音楽の木のまま（押しても列は変わらない）。
const MUSIC_TREE_DETAILS = new Set(["music_library", "music_playlists", "music_playlist", "music_artists", "music_artist", "music_album"]);
// 木の「プレイリスト」の子。ログイン中だけ。プレイリストの頁を開き直したときだけ読み直す。
const musicPlaylistList = { items: [], loaded: false, loading: false, epoch: null, entry: null };
function loadMusicPlaylistList(entry) {
  if (desktopAccount.state !== "registered") { if (musicPlaylistList.items.length) musicPlaylistList.items = []; return; }
  const stale = entry && musicPlaylistList.entry !== entry;
  if (musicPlaylistList.loading || (musicPlaylistList.loaded && musicPlaylistList.epoch === homeAccountEpoch && !stale)) return;
  const epoch = homeAccountEpoch;
  musicPlaylistList.loading = true; musicPlaylistList.entry = entry ?? musicPlaylistList.entry;
  void Promise.resolve(invoke("hub_client", { name: "music_playlists" })).then((data) => {
    if (epoch !== homeAccountEpoch) return;
    musicPlaylistList.items = (Array.isArray(data?.playlists) ? data.playlists : []).filter((item) => item && typeof item.id === "string").map((item) => ({ id: item.id, title: String(item.title ?? "") })).slice(0, 100);
  }).catch(() => { if (epoch === homeAccountEpoch) musicPlaylistList.items = []; }).finally(() => {
    musicPlaylistList.loading = false; musicPlaylistList.loaded = true; musicPlaylistList.epoch = epoch;
    if (epoch === homeAccountEpoch && (currentView === "music" || (currentView === "detail" && MUSIC_TREE_DETAILS.has(detailTrail.at(-1)?.name)))) renderSidebarContext(currentView);
  });
}
function renderSidebarContext(view) {
  fillSidebarContext(view);
  appendSidebarMine(view);
  finishSidebarContext(view);
}
// 一覧と詳細を並べる画面（メッセージとメール）。一覧は内側の列に置き、列を畳むか窓が狭いと本文の左へ戻る。
// 1100 以上は 一覧 380 + 詳細 600、未満は選ぶまで一覧だけ（desktop-layouts.css）。
function placeMessagesSide() {
  const shell = document.querySelector(".app-shell");
  const open = !appsOpen && !shell.classList.contains("sidebar-collapsed") && matchMedia("(min-width: 861px)").matches;
  const inColumn = currentView === "messages" && open;
  // 列は木（メール／連絡先）を持つ。会話の一覧（#messages-list）は木の枝の元データとして本文側に残し、CSS で隠す。メールの一覧は本文側。
  if (messagesSide.parentElement !== messagesLayout) messagesLayout.prepend(messagesSide);
  if (mailListCol.parentElement !== mailLayoutNode) mailLayoutNode.prepend(mailListCol);
  shell.classList.toggle("sidebar-holds-messages", inColumn);
  // remove() は無い class でも属性を書き直し、この関数を呼ぶ MutationObserver が無限に回る。あるときだけ外す。
  if (shell.classList.contains("sidebar-holds-mail")) shell.classList.remove("sidebar-holds-mail");
}
// 狭い窓で会話を開いているか。状態はシェルの class だけが持つ（初期化の順に左右されない）。
function setDmThreadShown(open) {
  document.querySelector(".app-shell")?.classList.toggle("dm-thread-open", open);
}
function finishSidebarContext(view) {
  const shell = document.querySelector(".app-shell");
  const family = shell.dataset.sidebarContext;
  const empty = !appsOpen && !["ai", "browser"].includes(family) && view !== "messages" && !sidebarContext.querySelector(".sidebar-context-item, .messages-side, .sidebar-mine");
  sidebarEmptyView = empty;
  shell.classList.toggle("sidebar-empty-view", empty);
  if (empty && !shell.classList.contains("sidebar-collapsed")) {
    shell.classList.add("sidebar-collapsed");
    sidebarCollapsedForEmpty = true;
  } else if (!empty && sidebarCollapsedForEmpty) {
    sidebarCollapsedForEmpty = false;
    if (!sidebarCollapsedForRail && matchMedia("(min-width: 861px)").matches) shell.classList.remove("sidebar-collapsed");
  }
  placeMessagesSide();
  refreshViewChips();
}
function loadSidebarLists() {
  if (desktopAccount.state !== "registered" || sidebarLists.loading || sidebarLists.epoch === homeAccountEpoch) return;
  const epoch = homeAccountEpoch;
  sidebarLists.loading = true;
  void Promise.resolve(invoke("hub_client", { name: "lists" })).then((data) => {
    if (epoch !== homeAccountEpoch) return;
    sidebarLists.items = Array.isArray(data?.lists) ? data.lists.filter((list) => list?.id && typeof list.name === "string").slice(0, 12) : [];
  }).catch(() => { sidebarLists.items = []; }).finally(() => {
    sidebarLists.loading = false;
    if (epoch !== homeAccountEpoch) return;
    sidebarLists.epoch = epoch;
    if (["feed", "lists", "bookmarks"].includes(currentView) || sidebarFeedTreeOwned) renderSidebarContext(currentView);
  });
}
// フォロー中（画面ごとの人・チャンネル）とフォロー中のタグ。Hub の /api/client/sidebar を hub_detail で読む。
const SIDEBAR_REMOTE_KIND = { feed: "feed", videos: "videos", music: "music", articles: "articles" };
const sidebarRemote = createSidebarRemote({
  invoke, epoch: () => homeAccountEpoch, registered: () => desktopAccount.state === "registered",
  changed: (kind) => {
    if (SIDEBAR_REMOTE_KIND[sidebarParentView()] === kind || (kind === "feed" && sidebarFeedTreeOwned)) renderSidebarContext(currentView);
    refreshViewChips();
  },
});
// 列の続きは、最後の行が見えたら読む（列全体が1本で流れる。入れ子の流れは作らない）。
let sidebarMoreObserver = null;
function sidebarParentView() {
  return currentView === "detail" ? (DETAIL_PARENT_VIEW[detailTrail.at(-1)?.name] || "detail") : currentView;
}
// 自作動画の投稿と管理は、デスクトップ内のスタジオ（video-studio.mjs）で行う。通信は hub_client の固定 verb だけを通る。
let videoStudio = null;
function hideVideoStudio() {
  videoStudio?.destroy();
  videoStudio = null;
  const section = document.querySelector("#video-studio");
  if (!section) return;
  section.hidden = true;
  document.querySelector("#video-studio-body")?.replaceChildren();
}
function openVideoStudio() {
  const section = document.querySelector("#video-studio"), body = document.querySelector("#video-studio-body");
  if (!section || !body) return;
  if (currentView !== "videos") document.querySelector('.icon-rail [data-view="videos"]')?.click();
  hideVideoChannel();
  hideVideoStudio();
  document.querySelector("#video-watch").hidden = true;
  document.querySelector("#video-discover").hidden = true;
  section.hidden = false;
  videoStudio = renderVideoStudio(body, { document, api: createNativeVideoApi(invoke), confirmDelete: (video) => window.confirm(`「${video.title || "無題"}」を削除します。元に戻せません。`) });
  if (viewScroller()) viewScroller().scrollTop = 0;
  document.querySelector("#video-studio-back").focus();
}
function openOwnProfile() {
  document.querySelector('.icon-rail [data-view="profile"]')?.click();
}
// 本文の上のチップ（すべて・カテゴリ・フォロー中のタグ）を置く場所。見出しのすぐ下に作る。
function viewChipHost(view) {
  const panel = document.querySelector(`#view-${view}`);
  if (!panel) return null;
  let host = panel.querySelector(":scope > .sidebar-chip-strip, :scope .view-chip-host");
  if (!host) {
    host = document.createElement("div");
    host.className = "view-chip-host";
    host.id = `${view}-chips`;
    // 検索欄があればそのすぐ下、無ければ見出しの下（参考画面と同じ、本文の一番上）。
    const search = { videos: "#video-search", articles: "#articles-search" }[view];
    // タイムラインは自前のタブ（#feed-tabs）を見出しに持つので、チップは見出しの下に置く。
    const header = panel.id === "view-feed" ? null : panel.querySelector(":scope > .view-head.page-header, :scope > div > .view-head.page-header");
    const anchor = (search && panel.querySelector(search)) || panel.querySelector(":scope > .view-head, :scope > .page-header, :scope > div > .view-head");
    // 共通の見出しを使う画面では、絞り込みのチップを page-tabs として見出しの中に置く。
    const ownHead = view === "threads" || view === "community" ? panel.querySelector(":scope > .view-head") : null;
    if (ownHead) {
      // スレッドとコミュニティ：チップは「＋」のある頭の帯の中、操作の左に置く（帯を2段にしない）。
      host.classList.add("view-head-chips");
      ownHead.insertBefore(host, ownHead.querySelector(":scope > .view-head-actions"));
    } else if (header) {
      host.classList.add("page-tabs");
      header.append(host);
    } else if (anchor) anchor.after(host);
    else panel.prepend(host);
  }
  return host;
}
function refreshViewChips() {
  const view = currentView;
  if (view === "videos" && videoSearchState) renderVideoChips();
  else if (view === "music") renderMusicChips();
  else if (view === "feed") renderFeedChips();
  else if (readingDirectory.has(view)) renderReadingChips(view);
}
function fillSidebarContext(view) {
  const owner=homeAccountEpoch;
  nativeSidebar?.sync();
  if (messagesSide.parentElement !== messagesLayout) messagesLayout.prepend(messagesSide);
  document.querySelector(".app-shell").classList.toggle("apps-active", appsOpen);
  for (const button of document.querySelectorAll("#desktop-apps, #toolbar-apps")) button.setAttribute("aria-expanded", String(appsOpen));
  const previous = document.querySelector(".app-shell").dataset.sidebarContext;
  const detailName = view === "detail" ? detailTrail.at(-1)?.name : null;
  const contextView = detailName ? (DETAIL_PARENT_VIEW[detailName] || view) : view;
  const isLibrary = ["saved_articles","article_drafts","video_library","music_library","video_playlists","music_playlists"].includes(detailName) || MUSIC_TREE_DETAILS.has(detailName);
  // スレッドとコミュニティの一覧は、どこから開いても木の列（フィードと同じ3本の根）にする。
  const feedTreeOwned = !appsOpen && view !== "feed"
    && (view === "threads" || view === "community"
      || (view === "detail" && (detailName === "thread" || detailName === "community"))
      || (sidebarContextOwner === "feed" && (FEED_TREE_VIEWS.has(view) || (view === "detail" && FEED_TREE_DETAILS.has(detailName))))
      // コミュニティの流れから開いた投稿：列は木のまま、そのコミュニティの行が現在の印を持つ。
      || (detailName === "post" && Boolean(detailTrail.at(-1)?.communityId)));
  sidebarFeedTreeOwned = feedTreeOwned;
  const family = feedTreeOwned ? "feed" : view === "detail"
    ? (DETAIL_SIDEBAR_FAMILY[detailName] || previous || "feed")
    : (SIDEBAR_FAMILY[view] || view);
  document.querySelector(".app-shell").dataset.sidebarContext = family;
  // 題は列の中身の名前にする（本文の見出しと同じ語を並べない）。
  // 受信トレイの列は題を持たない木（メール／連絡先）。題の段ごと畳む。
  const inboxTree = !appsOpen && (view === "messages" || view === "mail");
  document.querySelector(".app-shell").classList.toggle("sidebar-inbox-tree", inboxTree);
  const sidebarTitle = appsOpen ? "すべての機能" : inboxTree ? "" : feedTreeOwned ? "フィード" : isLibrary ? ({ videos: "動画を見る", music: "音楽を聴く", articles: "記事を読む" }[contextView] || "ライブラリ") : ({ ai: "作業", browser: "タブ", feed: "フィード", search: "結果の種類", videos: "動画を見る", music: "音楽を聴く", research: "プロジェクト", settings: "Hub Desktop", messages: "会話", mail: "メールのフォルダ", market: "買い物", purchased: "買い物", cart: "買い物", order: "買い物", lists: "ブックマークとリスト", bookmarks: "ブックマークとリスト" }[view] || (readingDirectory.has(contextView) ? (view === "detail" ? (detailName === "hubpedia_article" ? "Hubpedia" : detailName === "community" ? "コミュニティ" : "目次") : { articles: "記事を読む", hubpedia: "分野", community: "コミュニティの分類", threads: "話題の種別" }[contextView]) : null) || (family === "research" ? "プロジェクト" : SIDEBAR_TITLES[family]) || "この画面");
  document.querySelector(".sidebar .brand h1").textContent = sidebarTitle;
  // 画面ごとのタブはすべて左の列に縦に並べる（ユーザー指定 2026-10-11）。
  if (sidebarContext.parentElement !== document.querySelector(".sidebar")) document.querySelector("#primary-nav").before(sidebarContext);
  sidebarMoreObserver?.disconnect();
  sidebarMoreObserver = null;
  sidebarContext.replaceChildren();
  if (!appsOpen && (family === "ai" || family === "browser")) return;
  let host = sidebarContext; // 木の枝の中では、行はその枝の入れ物へ入る
  const section = (label) => {
    const title = document.createElement("p");
    title.className = "nav-group";
    title.textContent = label;
    host.append(title);
    return title;
  };
  const action = (label, click, selected = false) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `sidebar-context-item${selected ? " on" : ""}`;
    button.textContent = label;
    button.onclick = event => { if(owner===homeAccountEpoch&&button.isConnected)return click(event); };
    host.append(button);
    return button;
  };
  // 一覧の行：左に名前、右に件数や状態（薄い字）。
  const row = (label, meta, click, selected = false) => {
    const button = action("", click, selected);
    const name = document.createElement("span"), note = document.createElement("span");
    name.className = "sidebar-item-label";
    name.textContent = label;
    button.title = label;
    button.append(name);
    if (meta !== "" && meta != null) {
      note.className = "sidebar-item-meta";
      note.textContent = String(meta);
      button.append(note);
    }
    if (selected) button.setAttribute("aria-current", "true");
    return button;
  };
  // 左の列は行き先だけ（2026-11-11 所有者）。並び替え（おすすめ・人気・参加中）と分類は、本文の一覧の上のチップ（renderReadingChips）。
  // 同じ受信トレイの中の切り替え（DM・メール・連絡先）。項目の一覧とは別の段にする。
  const switchRow = (label, entries) => {
    const group = document.createElement("div");
    group.className = "sidebar-switch";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", label);
    for (const [text, target] of entries) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = text;
      button.setAttribute("aria-pressed", String(target === view));
      button.onclick = () => { if (owner === homeAccountEpoch && button.isConnected && target !== view) document.querySelector(`#primary-nav [data-view="${target}"]`)?.click(); };
      group.append(button);
    }
    sidebarContext.append(group);
  };
  const mirror = (selector, label) => {
    const source = document.querySelector(selector);
    if (source) {
      const button = action(label, () => { source.click(); renderSidebarContext(view); }, source.classList.contains("on")&&(view!=="feed"||socialMode==="legacy"));
      const id = nativeSidebarId(view, selector);
      if (id) button.dataset.nativeSidebarId = String(id);
    }
  };
  const destination = (label, target) => {
    // 詳細の画面に「戻る」の行は置かない（戻るのは上の戻るボタン）。
    const selected = !isLibrary && target === contextView;
    const button = action(label, () => {
      document.querySelector(`.icon-rail [data-view="${target}"], #primary-nav [data-view="${target}"], .account-nav [data-view="${target}"]`)?.click();
    }, selected);
    if (selected) button.setAttribute("aria-current", "page");
    // 行の頭にアイコン列と同じ記号（#primary-nav にある同じ行き先の線画をそのまま写す）。
    const glyph = document.querySelector(`#primary-nav [data-view="${target}"] svg, .icon-rail [data-view="${target}"] svg`)?.cloneNode(true);
    if (glyph) { glyph.setAttribute("aria-hidden", "true"); glyph.classList.add("sidebar-icon"); button.prepend(glyph); }
    return button;
  };
  if (appsOpen) {
    const search = document.createElement("input");
    search.type = "search";
    search.className = "sidebar-app-search";
    search.placeholder = "機能を探す";
    search.setAttribute("aria-label", "機能を探す");
    sidebarContext.append(search);
    const groups = [];
    for (const [group, links] of APP_GROUPS) {
      const heading = section(group);
      const buttons = links.map(([label, target]) => destination(label, target));
      groups.push({ group, heading, buttons });
    }
    const empty = document.createElement("p");
    empty.className = "meta sidebar-app-empty";
    empty.textContent = "該当する機能はありません";
    empty.hidden = true;
    sidebarContext.append(empty);
    search.oninput = () => {
      const query = search.value.trim().toLocaleLowerCase();
      let visible = 0;
      for (const { group, heading, buttons } of groups) {
        const groupMatch = group.toLocaleLowerCase().includes(query);
        for (const button of buttons) {
          button.hidden = !groupMatch && !button.textContent.toLocaleLowerCase().includes(query);
          if (!button.hidden) visible++;
        }
        heading.hidden = buttons.every((button) => button.hidden);
      }
      empty.hidden = visible > 0;
    };
    sidebarContext.scrollTop = 0;
    return;
  }
  // ===== 参考画面（2026-10-15）の骨組み =====
  // 上の段（記号つきの行）→ 区切り → 「フォロー中 ›」と顔つきの行（全員・列ごと流れる）。マイページの節は無い（2026-10-18）。
  // カテゴリとタグは本文の上のチップに置く（列には並べない）。
  const navRow = (label, icon, click, selected = false) => {
    const button = action("", click, selected);
    button.classList.add("sidebar-nav-row");
    const name = document.createElement("span");
    name.className = "sidebar-item-label";
    name.textContent = label;
    button.append(sidebarIcon(document, icon), name);
    if (selected) button.setAttribute("aria-current", "true");
    return button;
  };
  const divider = () => {
    const line = document.createElement("hr");
    line.className = "sidebar-divider";
    sidebarContext.append(line);
  };
  // 節の見出し。押せるときは「›」つきで、その節の一覧を本文に開く。
  const headingLink = (label, click, selected = false) => {
    const node = document.createElement(click ? "button" : "p");
    node.className = "sidebar-heading";
    if (click) {
      node.type = "button";
      node.classList.add("is-link");
      node.onclick = () => { if (owner === homeAccountEpoch && node.isConnected) click(); };
      if (selected) node.setAttribute("aria-current", "true");
    }
    const text = document.createElement("span");
    text.textContent = label;
    node.append(text);
    if (click) {
      const chevron = document.createElement("span");
      chevron.className = "sidebar-heading-chevron";
      chevron.setAttribute("aria-hidden", "true");
      chevron.textContent = "›";
      node.append(chevron);
    }
    sidebarContext.append(node);
    return node;
  };
  // フォロー中（動画だけ）：全員を並べ、最後の行が見えたら次の頁を読む。未接続なら節ごと出さない。
  const channelBlock = (kind, onHeading, headingSelected, open, isSelected = () => false) => {
    if (desktopAccount.state !== "registered") return;
    divider();
    headingLink("フォロー中", onHeading, headingSelected);
    void sidebarRemote.load(kind);
    const entry = sidebarRemote.state(kind);
    for (const channel of entry.items) {
      const selected = isSelected(channel);
      const button = action("", () => open(channel), selected);
      button.classList.add("sidebar-channel-row");
      button.title = channel.name;
      const name = document.createElement("span");
      name.className = "sidebar-item-label";
      name.textContent = channel.name;
      button.append(channelAvatar(document, channel, hubAsset), name);
      if (selected) button.setAttribute("aria-current", "true");
    }
    if (!entry.loaded || entry.loading || entry.failed || !entry.items.length) {
      const note = document.createElement("p");
      note.className = "sidebar-note";
      note.textContent = entry.failed ? "読み込めませんでした" : !entry.loaded || entry.loading ? "読み込み中…" : "まだ登録していません";
      sidebarContext.append(note);
    }
    if (entry.next) {
      const sentinel = document.createElement("div");
      sentinel.className = "sidebar-more-sentinel";
      sentinel.setAttribute("aria-hidden", "true");
      sidebarContext.append(sentinel);
      if (typeof IntersectionObserver === "function") {
        sidebarMoreObserver = new IntersectionObserver((entries) => {
          if (entries.some((item) => item.isIntersecting)) void sidebarRemote.more(kind);
        }, { root: sidebarContext, rootMargin: "0px 0px 240px 0px" });
        sidebarMoreObserver.observe(sentinel);
      }
    }
  };
  const openChannelProfile = (channel) => {
    if (channel.type === "profile" && channel.handle) void openDetail("profile", [channel.handle], { title: channel.name });
  };
  // 音楽の列は木（music-tree.mjs）：ホーム / ライブラリ（お気に入り・プレイリスト（各プレイリスト）・アーティスト）。
  // 音楽のどの頁にいても同じ木で、押した行が現在になるだけ。アップロードは、デスクトップに音楽の投稿口が無いので出さない。
  // マーケットの列は木（market-tree.mjs）：マーケット（種別）/ 自分（カート・ライブラリ・注文・出品中/売上）。押しても列は変わらず、本文だけが替わる。
  const marketColumn = () => {
    const route = view === "cart" ? { page: "cart" } : view === "purchased" ? { page: "purchased" } : view === "order" ? { page: "orders" }
      : !document.querySelector("#market-api")?.hidden ? { page: "api" } : { page: "browse", category: marketBrowse?.state().category ?? "all" };
    const cartCount = Object.values(shop.cart).reduce((n, q) => n + q, 0);
    marketView.tree = renderMarketTree({
      document, host: sidebarContext, model: marketTreeModel({ sells: marketView.sells === true, canList: desktopAccount.state === "registered", cartCount, apiMarket: true }), route,
      onGo: (target) => {
        if (target.page === "api") { if (currentView !== "market") document.querySelector('.nav-item[data-view="market"]')?.click(); showApiMarket(); marketView.tree?.select?.(target); }
        else if (target.page === "browse") { if (currentView !== "market") document.querySelector('.nav-item[data-view="market"]')?.click(); document.querySelector('[data-shop-tab="products"]')?.click(); marketBrowse?.setCategory(target.category); }
        else if (target.page === "cart") document.querySelector("#market-cart-open")?.click();
        else if (target.page === "purchased" || target.page === "orders") { document.querySelector('.nav-item[data-view="purchased"]')?.click(); if (target.page === "orders") document.querySelector("#orders-list")?.scrollIntoView?.({ block: "start" }); }
        else if (target.page === "sell") { if (currentView !== "market") document.querySelector('.nav-item[data-view="market"]')?.click(); document.querySelector('[data-shop-tab="seller"]')?.click(); const details = document.querySelector("#seller-product-details"); if (details && !document.querySelector("#seller-console")?.hidden) { details.open = true; details.scrollIntoView?.({ block: "start" }); } }
        else if (target.page === "listings") { if (currentView !== "market") document.querySelector('.nav-item[data-view="market"]')?.click(); document.querySelector('[data-shop-tab="listings"]')?.click(); }
        else if (target.page === "selling") { if (currentView !== "market") document.querySelector('.nav-item[data-view="market"]')?.click(); document.querySelector('[data-shop-tab="seller"]')?.click(); }
      },
    });
    // 出品者かどうかは既存の読み（commerce_seller_state）を一度だけ使う。変わったときだけ列を描き直す。
    if (marketView.sells === undefined) {
      marketView.sells = false;
      void invoke("commerce_seller_state").then((session) => { if (session?.loggedIn) { marketView.sells = true; renderSidebarContext(currentView); } }).catch(() => undefined);
    }
  };
  const musicColumn = () => {
    const onMusic = view === "music";
    const current = detailTrail.at(-1);
    const route = onMusic ? { page: "home" }
      : detailName === "music_library" ? { page: "favorites" }
      : detailName === "music_playlists" ? { page: "playlists" }
      : detailName === "music_playlist" ? { page: "playlist", id: current?.ids?.[0] }
      : detailName === "music_artists" || detailName === "music_artist" ? { page: "artists" } : null;
    loadMusicPlaylistList(detailName === "music_playlists" ? current : null);
    const go = (target) => {
      if (target.page === "home") {
        if (currentView !== "music") document.querySelector('.icon-rail [data-view="music"]')?.click();
        musicSideMode = null;
        document.querySelector("#music-tab-home")?.click();
        syncMusicSidePanel();
      } else if (target.page === "favorites") document.querySelector("#music-saved").click();
      else if (target.page === "playlists") document.querySelector("#music-playlists").click();
      else if (target.page === "playlist") void openDetail("music_playlist", [target.id], { title: musicPlaylistList.items.find((item) => item.id === target.id)?.title || "プレイリスト", local: true, data: {} });
      else if (target.page === "artists") void openDetail("music_artists", [], { title: "アーティスト", local: true, data: {} });
    };
    renderMusicTree({ document, host: sidebarContext, model: musicTreeModel({ playlists: musicPlaylistList.items, canUpload: false }), route, onGo: go });
  };
  // 動画の列は木（video-tree.mjs）：ホーム / ショート / フォロー中（フォローしている人）/ ライブラリ（あとで見る・再生リスト・履歴・自分の動画）。押しても列は変わらない。
  const videoColumn = () => {
    const listing = view === "videos" && videoWatchIndex < 0;
    const signedIn = desktopAccount.state === "registered";
    if (signedIn) void sidebarRemote.load("videos");
    const entry = sidebarRemote.state("videos");
    const channelQuery = document.querySelector("#video-query")?.value ?? "";
    const modeRoute = { home: { page: "home" }, shorts: { page: "shorts" }, history: { page: "history" }, subscriptions: { page: "subscriptions" } };
    const route = detailName === "video_library" ? { page: "later" }
      : detailName === "video_playlists" ? { page: "playlists" }
      : listing && videoMode === "home" && channelQuery && entry.items.some((channel) => channel.name === channelQuery) ? { page: "channel", id: entry.items.find((channel) => channel.name === channelQuery).handle ?? channelQuery }
      : listing ? (modeRoute[videoMode] ?? { page: "home" }) : null;
    const go = (target) => {
      if (target.page === "home") setVideoMode("home");
      else if (target.page === "shorts") setVideoMode("shorts");
      else if (target.page === "history") setVideoMode("history");
      else if (target.page === "subscriptions") setVideoMode("subscriptions");
      else if (target.page === "later") document.querySelector("#video-saved").click();
      else if (target.page === "playlists") document.querySelector("#video-playlists").click();
      else if (target.page === "studio") void openVideoStudio();
      else if (target.page === "channel") {
        // フォロー中の人 = 動画のチャンネル。押すと、その人のチャンネルページ（読み取りのみ・フォローは人のフォローと同じ動詞）を開く。
        const channel = entry.items.find((item) => (item.handle ?? item.name) === target.id);
        if (channel?.handle) openVideoChannel(channel.handle);
      }
    };
    renderVideoTree({
      document, host: sidebarContext, route, onGo: go,
      model: videoTreeModel({ channels: entry.items, signedIn, channelsStatus: entry.failed ? "failed" : !entry.loaded || entry.loading ? "loading" : "done", canUpload: true }),
      avatar: (doc, channel) => channelAvatar(doc, channel, hubAsset),
    });
    // フォロー中の続き（今の channelBlock と同じ：最後の行が見えたら次の頁を読む）。
    if (signedIn && entry.next) {
      const sentinel = document.createElement("div");
      sentinel.className = "sidebar-more-sentinel";
      sentinel.setAttribute("aria-hidden", "true");
      sidebarContext.append(sentinel);
      if (typeof IntersectionObserver === "function") {
        sidebarMoreObserver = new IntersectionObserver((entries) => {
          if (entries.some((item) => item.isIntersecting)) void sidebarRemote.more("videos");
        }, { root: sidebarContext, rootMargin: "0px 0px 240px 0px" });
        sidebarMoreObserver.observe(sentinel);
      }
    }
  };
  // 記事：木（ホーム〔フォロー中のタグ・下書き・シリーズ〕/ マガジン〔保存した記事〕）。押しても列は変わらない。
  const articleColumn = () => {
    const directory = readingDirectory.get("articles");
    const onArticles = view === "articles";
    const route = detailName === "saved_articles" ? { page: "saved" }
      : detailName === "article_drafts" ? { page: "drafts" }
      : onArticles && directory.filter ? { page: "tag", id: directory.filter }
      : onArticles ? { page: "home" } : null;
    void sidebarRemote.load("articles"); // フォロー中のタグ（changed -> renderSidebarContext で木の枝が埋まる）
    const go = (target) => {
      const toArticles = () => { if (currentView !== "articles") document.querySelector('.icon-rail [data-view="articles"]')?.click(); };
      if (target.page === "home" || target.page === "tags" || target.page === "tag") {
        toArticles();
        directory.filter = target.page === "tag" ? target.id : "";
        const input = document.querySelector("#articles-query");
        if (input?.value) { input.value = ""; void loadCatalog("articles"); }
        renderReadingCatalog("articles");        // 絞り込みと一覧だけ描き直す。列は触らない
        tree.select(target.page === "tags" ? { page: "home" } : target);
      } else if (target.page === "drafts") document.querySelector("#articles-drafts").click();
      else if (target.page === "saved") document.querySelector("#articles-saved").click();
      else if (target.page === "series") document.querySelector("#articles-series").click(); // Web版を既定のブラウザで開く（従来どおり）
    };
    const tree = renderArticleTree({ document, host: sidebarContext, model: articleTreeModel({ tags: sidebarRemote.tags() }), route, onGo: go });
  };
  if (isLibrary) {
    // ライブラリの画面も親の画面と同じ列を出す（今いる項目を選択中にする）。
    if (contextView === "music") musicColumn();
    else if (contextView === "videos") videoColumn();
    else if (contextView === "articles") articleColumn();
    return;
  }
  if (family === "research") {
    // 研究の列は木（research-tree.mjs）：プロジェクト（各プロジェクト）/ 探す。押した行が現在になるだけで、列は変わらない。
    const current = detailTrail.at(-1);
    const route = view === "research" ? { page: "projects" }
      : detailName === "research_network_fork" ? null
      : current?.ids?.[0] ? { page: "project", id: current.ids[0] } : null;
    const go = (target) => {
      if (owner !== homeAccountEpoch) return;
      if (target.page === "project") {
        void openDetail("research_project", [target.id], { title: researchWorkspace.projects().find((item) => item.id === target.id)?.title || "プロジェクト" });
        return;
      }
      if (currentView !== "research") document.querySelector('.icon-rail [data-view="research"], #primary-nav [data-view="research"]')?.click();
      if (target.page === "discover") document.querySelector("#research-query")?.focus();
      else document.querySelector("#research-results")?.scrollIntoView({ block: "start" });
    };
    renderResearchTree({ document, host: sidebarContext, model: researchTreeModel({ projects: researchWorkspace.projects() }), route, onGo: go });
    return;
  }
  // 木の列（2026-11-02）：根は線を持たず、枝は曲がり線でぶら下がる。フィード・ブックマーク／リストが同じ作り。
  // 根が null のときは枝を持たない（ブックマーク）。枝の中の行は build が置く。
  // tools：根の行の右端に置く記号だけのボタン（探す・一覧など）。字の行を増やさない（2026-11-04 所有者「字で説明しない」）。
  const tree = (label, icon, click, selected, build, tools = []) => {
    const group = document.createElement("div");
    group.className = "sidebar-tree";
    sidebarContext.append(group);
    host = group;
    const root = navRow(label, icon, click, selected);
    root.classList.add("sidebar-tree-root");
    if (tools.length) {
      const head = document.createElement("div");
      head.className = "sidebar-tree-head";
      group.insertBefore(head, root);
      head.append(root);
      for (const tool of tools) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "sidebar-tree-tool";
        button.setAttribute("aria-label", tool.label);
        button.title = tool.label;
        if (tool.selected) button.setAttribute("aria-current", "page");
        button.append(sidebarIcon(document, tool.icon));
        button.onclick = tool.click;
        head.append(button);
      }
    }
    if (build) {
      const kids = document.createElement("div");
      kids.className = "sidebar-tree-children";
      kids.setAttribute("role", "group");
      kids.setAttribute("aria-label", label);
      group.append(kids);
      host = kids;
      build(kids);
      markTreeEdges(kids);
    }
    host = sidebarContext;
  };
  const sub = (label) => {
    const heading = document.createElement("p");
    heading.className = "sidebar-tree-sub";
    heading.textContent = label;
    host.append(heading);
  };
  // アイコンの列の行き先を押す。フィードの木から押したときだけ、列は木のまま本文だけが変わる（sidebarContextOwner）。
  const railGo = (target, fromFeedTree = false) => {
    if (fromFeedTree) { sidebarContextOwner = "feed"; feedTreeNav = true; }
    try { document.querySelector(`.icon-rail [data-view="${target}"], #primary-nav [data-view="${target}"], .account-nav [data-view="${target}"]`)?.click(); }
    finally { feedTreeNav = false; }
  };
  const treeLink = (label, target, selected) => {
    const button = action(label, () => railGo(target, true), selected);
    if (selected) button.setAttribute("aria-current", "page");
    return button;
  };
  const openFromTree = (name, ids, title) => { sidebarContextOwner = "feed"; void openDetail(name, ids, { title }); };
  const detailId = detailName ? detailTrail.at(-1)?.ids?.[0] : null;
  if (view === "feed" || feedTreeOwned) {
    // フィードの列は3本の根の木：フィード（フォロー中のタグ・リスト）／スレッド／コミュニティ。
    // 枝は常に出す。根を押すとこれまでどおり投稿のタブか selectSocial に移る。枝を押しても列は変わらず、押した行が現在になる。
    // 並び（おすすめ・人気）は本文の上のチップ。「新着」は置かない（2026-10-12）。
    if (view === "feed") sidebarContextOwner = null;
    const atFeed = view === "feed";
    const kind = socialMode === "legacy" ? "post" : socialFilter;
    const following = socialMode === "mixed" && socialScope === "following";
    const rootClick = (filter) => () => {
      if (!atFeed && filter === "post") { railGo("feed"); return; }
      sidebarContextOwner = null;
      if (filter === "post") selectFeedTab(feedTabKey()); else void selectSocial("mixed", filter, "latest");
    };
    // 2026-11-04 所有者「左ごちゃごちゃすぎ」：小見出し・空の案内・「話題を探す」（検索は上の欄と右の列にある）を外し、
    // フォロー中のタグとリストは、あるときだけ行を出す。リストの一覧・スレッドとコミュニティを探す入口は、根の行の右の記号にした。
    const tool = (label, icon, target) => ({ label, icon, click: () => railGo(target, true), selected: view === target });
    // 種類の行（おすすめ・フォロー中・人気・自分のリスト）は、ここの最初の枝（2026-11-06 所有者「おすすめとか左列に入れたほうが美しい」）。
    // 選んだ行が現在の印を持つので、根の印は種類が選ばれていないときだけ。矢印キーで行を移ると、その種類に切り替わる。
    let tabEntries = [];
    try { tabEntries = feedTabEntries(); } catch { /* 宣言前 */ }
    const tabSelected = atFeed && kind === "post" && tabEntries.some((entry) => entry.selected);
    const pickTab = (key) => { sidebarContextOwner = null; selectFeedTab(key); if (!atFeed) railGo("feed"); };
    tree("フィード", "home", rootClick("post"), atFeed && kind === "post" && !following && !tabSelected, () => {
      tabEntries.forEach((entry, at) => {
        const button = row(entry.label, "", () => pickTab(entry.key), atFeed && entry.selected);
        button.dataset.feedTab = entry.key;
        button.onkeydown = (event) => {
          const n = tabEntries.length;
          const to = { ArrowDown: (at + 1) % n, ArrowUp: (at - 1 + n) % n, Home: 0, End: n - 1 }[event.key];
          if (to === undefined) return;
          event.preventDefault();
          pickTab(tabEntries[to].key);
        };
      });
      for (const tag of sidebarRemote.tags().slice(0, 8)) row(`#${tag}`, "", () => openFromTree("tag", [tag], `#${tag}`), detailName === "tag" && detailId === tag);
    }, [tool("ブックマーク", "bookmark", "bookmarks"), tool("リスト", "list", "lists"), { label: "表示元と接続先", icon: "more", click: () => toggleFeedSources(), selected: document.querySelector("#view-feed")?.classList.contains("show-sources") }]);
    // 検索は1番上の欄だけ（2026-11-04 所有者）。スレッドとコミュニティは、根の行がそれぞれの一覧（探す・作る）を開く。
    // スレッド：参加中・フォロー中を返す既存の読み取りは許可リストに無い（sidebar は feed/videos/music/articles だけ）ので、枝は無い。
    // スレッドの詳細でも同じ木のまま。開いているスレッドは「スレッド」の枝の現在の1行になる（戻る行は足さない：戻るのは上の戻るボタン）。
    const openThread = detailName === "thread" ? detailTrail.at(-1) : null;
    // 根はフィードと同じく、並びの行が選ばれていないときだけ現在（現在の行は1つだけ）。
    tree("スレッド", "thread", () => railGo("threads", true), view === "threads", openThread ? () => {
      const title = String(openThread.title || document.querySelector("#detail-content h1, #detail-content h2")?.textContent || "スレッド").trim();
      const current = row(title, "", () => viewScroller()?.scrollTo?.({ top: 0, behavior: "smooth" }), true);
      current.setAttribute("aria-current", "page");
      current.classList.add("sidebar-detail-current");
    } : null);
    tree("コミュニティ", "community", () => railGo("community", true), view === "community", (kids) => {
      // 具体的なコミュニティの一覧は根の直下（見出しは足さない）。
      const placeJoined = () => { kids.append(communitiesHost); };
      const postCommunity = detailName === "post" ? detailTrail.at(-1)?.communityId ?? "" : "";
      const inCommunity = view === "community" || detailName === "community" || Boolean(postCommunity);
      if (inCommunity || view === "detail") placeJoined();
      const openId = detailName === "community" ? detailId ?? "" : postCommunity;
      navCommunities.setCurrent(openId, openId ? communitySectionItems(detailTrail.findLast((item) => item.name === "community" && item.ids?.[0] === openId)).map((item) => (postCommunity ? { ...item, selected: false } : item)) : []);
      void navCommunities.refresh().then(() => markTreeEdges(kids));
    });
    try { loadFeedTabLists(); } catch { /* 宣言前 */ }
    void sidebarRemote.load("feed"); // フォロー中のタグ
    return;
  }
  if (family === "feed" && !readingDirectory.has(contextView)) {
    // タイムラインはアイコンの列にあるので、詳細から戻るときだけ出す。
    loadSidebarLists();
    // ブックマークとリストの画面（2026-11-02）：フィードと同じ木。根は「ブックマーク」「リスト」、
    // 自分のリストは「リスト」の枝に並べ、最後に「すべて見る」。「リスト」の根が一覧を開く。
    tree("ブックマーク", "bookmark", () => railGo("bookmarks"), view === "bookmarks", null);
    tree("リスト", "list", () => railGo("lists"), view === "lists", () => {
      for (const list of sidebarLists.items) {
        row(list.name || "リスト", (list.profileIds ?? []).length || "", () => void openDetail("list", [list.id], { title: list.name }),
          detailName === "list" && detailId === list.id);
      }
      action("すべて見る", () => railGo("lists"), false);
    });
  } else if (view === "notifications") {
    // 通知の列は木（2026-11-03）：根「通知」の下に すべて・自分宛て、「絞り込み」の下に 未読・フィード・コミュニティ・お知らせ。
    // 押すと本文の一覧だけが替わり（setNotifTab）、列は同じ木のまま、押した行が現在になる。件数は読み込んだ通知から数える。
    let items = [], current = "all";
    try { items = notificationsData?.notifications ?? []; current = notifTab; } catch { /* 宣言前 */ }
    const counts = notifCounts(items);
    const leaf = ([key, label, glyph]) => {
      const meta = counts[key] ? String(counts[key]) : "";
      const button = row(label, meta, () => setNotifTab(key), current === key);
      button.prepend(sidebarIcon(document, glyph));
      button.dataset.notifTree = key;
    };
    tree("通知", "bell", () => setNotifTab("all"), false, () => {
      for (const entry of NOTIF_TREE_MAIN) leaf(entry);
      sub("絞り込み");
      for (const entry of NOTIF_TREE_FILTERS) leaf(entry);
    });
  } else if (inboxTree) {
    // 受信トレイの列は切り替え無しの木（2026-11-02）：根「メール」と根「連絡先」。連絡先の枝は DM の相手（既存の会話一覧）。
    // 列はメッセージとメールのどちらを開いても同じ木のまま、本文だけが変わり、押した行が現在になる。
    // メールの一覧と本文はこれまでどおり本文側の列（loadMail）。メールのアドレスは Hub のプロフィールに結び付けない。
    tree("メール", "mail", () => { if (view !== "mail") document.querySelector('#primary-nav [data-view="mail"]')?.click(); }, view === "mail", null);
    // messagesData と activeConversationId は後ろで宣言される let。最初の描画は宣言より前に走るので、読めるまでは空として扱う。
    let dm = null, activeId = null;
    try { dm = messagesData; activeId = activeConversationId; } catch { /* 宣言前 */ }
    const peers = dm ? dm.conversations.map((conversation) => {
      const profiles = new Map(dm.profiles.map((profile) => [profile.id, profile]));
      return { conversation, peer: conversationPeer(conversation, profiles, dm.currentProfileId) };
    }) : [];
    tree("連絡先", "contacts", () => { if (view !== "messages") document.querySelector('#primary-nav [data-view="messages"]')?.click(); }, false, () => {
      for (const { conversation, peer } of peers) {
        const name = peer.displayName || peer.handle || "（名無し）";
        const button = action("", () => {
          for (const other of sidebarContext.querySelectorAll(".sidebar-contact-row")) { other.classList.toggle("on", other === button); if (other === button) other.setAttribute("aria-current", "true"); else other.removeAttribute("aria-current"); }
          if (currentView === "messages") void openConversation(conversation.id);
          else void navigateFrom({ dataset: { view: "messages" }, childNodes: [] }).then(() => openConversation(conversation.id));
        }, view === "messages" && activeId === conversation.id);
        button.classList.add("sidebar-channel-row", "sidebar-contact-row");
        button.title = name;
        const label = document.createElement("span");
        label.className = "sidebar-item-label";
        label.textContent = name;
        const when = document.createElement("span");
        when.className = "sidebar-item-meta";
        when.textContent = conversation.lastMessageAt ? relTime(conversation.lastMessageAt) : "";
        button.append(channelAvatar(document, { type: "profile", name, avatarUrl: peer.avatarUrl }, hubAsset), label, when);
        if (view === "messages" && activeId === conversation.id) button.setAttribute("aria-current", "true");
      }
      if (!peers.length && dm) {
        const note = document.createElement("p");
        note.className = "sidebar-tree-note";
        note.textContent = "まだやり取りはありません";
        host.append(note);
        treeLink("相手を探す", "search", false);
      }
    });
  } else if (family === "market") {
    marketColumn();
  } else if (view === "search") {
    // 結果の種類だけを持つ。結果が無いあいだは列を畳む（行き先の一覧はアイコンの列と「すべての機能」にある）。
    const tabs = document.querySelector("#search-tabs");
    if (!tabs.hidden) {
      for (const [index, tab] of [...tabs.children].entries()) mirror(`#search-tabs .chip:nth-child(${index + 1})`, tab.textContent);
    }
  } else if (view === "videos") {
    videoColumn();
  } else if (view === "music") {
    musicColumn();
  } else if (readingDirectory.has(contextView)) {
    if (contextView === "community") {
      // コミュニティの一覧（hub_resource communities。参加中が先、無ければ公開の人気）。見出しは一覧が描かれたときだけ出す。
      const heading = section("コミュニティ");
      heading.hidden = true;
      sidebarContext.append(communitiesHost);
      const current = view === "detail" && detailName === "community" ? detailTrail.at(-1)?.ids?.[0] : "";
      const sync = () => { heading.hidden = communitiesHost.hidden; };
      navCommunities.setCurrent(current, current ? communitySectionItems(detailTrail.at(-1)) : []);
      sync();
      void navCommunities.refresh().then(sync);
    }
    if (view === "detail") {
      // グループの画面の列は1本の一覧（参加中 → チャンネル・共有・メンバー）だけ。目次も戻る行も足さない。
      const groupPage = contextView === "community" && detailName === "community";
      // 戻る行・題・目次の行は、一覧画面の枝の行（.sidebar-tree-children）と同じ入れ物に置く。左端・行の高さ・間隔を一覧と揃える。
      const detailRows = !groupPage && detailName !== "hubpedia_article";
      if (detailRows) {
        const group = document.createElement("div");
        group.className = "sidebar-tree";
        const kids = document.createElement("div");
        kids.className = "sidebar-tree-children";
        kids.setAttribute("role", "group");
        group.append(kids);
        sidebarContext.append(group);
        host = kids;
      }
      if (detailName === "hubpedia_article") {
        // 記事の目次の木（2026-11-03）：根「記事の目次」の下に本文の見出しを段つきで並べ、最後に出典。押すと本文のその節へ寄る。
        const body = document.querySelector("#detail-content .hubpedia-reading");
        const entries = body ? hubpediaHeadings(body) : [];
        const sources = document.querySelector("#detail-content .hubpedia-sources")?.parentElement?.querySelector(".result-heading");
        const numbers = hubpediaNumbers(entries);
        const top = () => viewScroller()?.scrollTo?.({ top: 0, behavior: "smooth" });
        tree("記事の目次", "article", top, false, () => {
          entries.forEach((entry, index) => {
            const button = row(entry.text, numbers[index], () => entry.node.scrollIntoView?.({ behavior: "smooth", block: "start" }));
            button.dataset.tocLevel = String(Math.min(entry.level, 3));
          });
          if (sources) row("出典", "", () => sources.scrollIntoView?.({ behavior: "smooth", block: "start" })).dataset.tocLevel = "1";
        });
      } else if (!groupPage) {
      const headings = [...document.querySelectorAll("#detail-content .detail-h, #detail-content h2, #detail-content h3")];
      for (const heading of headings) {
        action(heading.textContent, () => heading.scrollIntoView({ behavior: "smooth", block: "start" }));
      }
      }
      if (detailRows) { markTreeEdges(host); host = sidebarContext; }
    } else if (contextView === "articles") {
      articleColumn();
    }
    // コミュニティ・資料の分類は本文の上のチップにある（列には並べない）。スレッドは並びと分類を列の行にする。
  } else if (view === "profile") {
    // プロフィールの列は木（2026-11-03）：根「プロフィール」の下に 投稿・返信・メディア（返った種類だけ。記事・動画・コード・スレッド・コミュニティも同じ）、
    // 「つながり」の下に フォロー中・フォロワー。押すのは本文の札と同じもの。「いいね」はこの端末が読める応答に無いので置かない。
    const tabs = [...document.querySelectorAll("#view-profile .profile-tab")];
    const active = document.querySelector("#view-profile .profile-panel")?.dataset.tab ?? "";
    const glyphs = { posts: "post", replies: "reply", media: "image", threads: "thread", communities: "community", articles: "article", videos: "video", music: "tracks", research: "research", market: "market", code: "code" };
    tree("プロフィール", "contacts", () => { tabs.find((tab) => tab.dataset.tab === "posts")?.click(); renderSidebarContext("profile"); }, false, () => {
      for (const tab of tabs) {
        const label = tab.firstChild?.textContent?.trim() || tab.textContent.trim();
        const count = tab.querySelector(".profile-tab-count")?.textContent?.trim() ?? "";
        row(label, count, () => { tab.click(); renderSidebarContext("profile"); }, tab.dataset.tab === active).prepend(sidebarIcon(document, glyphs[tab.dataset.tab] ?? "list"));
      }
      const links = [["following", "フォロー中", "contacts"], ["followers", "フォロワー", "community"]]
        .map(([kind, label, glyph]) => ({ kind, label, glyph, stat: document.querySelector(`#profile-stats button[data-connections="${kind}"]`) }))
        .filter((entry) => entry.stat);
      if (links.length) sub("つながり");
      for (const { kind, label, glyph, stat } of links) {
        row(label, "", () => { stat.click(); renderSidebarContext("profile"); }, active === kind).prepend(sidebarIcon(document, glyph));
      }
    });
  } else if (view === "settings") {
    // 設定の列は木（2026-11-03）：根「設定」の下に、節を3つの見出しで分けて並べる。
    // 押すのは本文の節の切り替えと同じもの（.inner-nav-item）。節は減らさず並べ替えだけ。検索は列の頭に置く（本文の検索欄と同じ入力を使う）。
    const sections = new Map([...document.querySelectorAll("#view-settings .inner-nav-item")].map((tab) => [tab.dataset.settingsSec, tab]));
    const groups = [
      ["よく使う", [["notifications", "bell"], ["appearance", "display"], ["privacy", "lock"], ["account", "contacts"]]],
      ["Hubの機能", [["ai", "sparkle"], ["wallet", "wallet"], ["browser", "external"]]],
      ["この端末とアプリ", [["device", "device"], ["advanced", "code"]]],
    ];
    const searchSource = document.querySelector("#settings-search");
    if (searchSource) {
      const field = document.createElement("input");
      field.type = "search";
      field.className = "sidebar-app-search settings-column-search";
      field.placeholder = "設定を検索";
      field.setAttribute("aria-label", "設定を検索");
      field.autocomplete = "off";
      field.spellcheck = false;
      field.maxLength = 100;
      field.value = searchSource.value;
      field.addEventListener("input", () => { searchSource.value = field.value; searchSource.dispatchEvent(new Event("input", { bubbles: true })); });
      field.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === "ArrowDown") searchSource.dispatchEvent(new KeyboardEvent("keydown", { key: event.key, bubbles: true, cancelable: true })); });
      sidebarContext.append(field);
    }
    // 強調は本文に見えている節から引く。クリック・検索・リンク・初期表示のどれで開いても一致させる。
    const shown = visibleSection(document);
    const current = (sections.has(shown) ? shown : null) ?? [...sections.values()].find((tab) => tab.classList.contains("on"))?.dataset.settingsSec ?? "account";
    tree("設定", "system", () => sections.get("account")?.click(), false, () => {
      for (const [label, entries] of groups) {
        sub(label);
        for (const [key, glyph] of entries) {
          const tab = sections.get(key);
          if (!tab) continue;
          const button = row({ privacy: "プライバシー", advanced: "詳細" }[key] ?? tab.textContent.trim(), "", () => { tab.click(); renderSidebarContext("settings"); }, current === key && !searchSource?.value);
          button.prepend(sidebarIcon(document, glyph));
          button.dataset.settingsTree = key;
        }
      }
    });
  }
  if (view === "wallet") {
    // ウォレットの列は木（2026-11-03）：根「ウォレット」の下に、本文の区画（この端末のウォレット・プロフィール連携・連携中のアドレス・履歴・チップ設定）を並べる。
    // 押すと本文のその区画へ寄せるだけ。署名・送金・確認の手順には触れない。区画はウォレットを読み込んだあとの本文から数える。
    const blocks = [...document.querySelectorAll("#wallet-results > *")].map((node) => {
      const label = node.classList.contains("wallet-device") ? "この端末のウォレット" : (node.querySelector("h2, h3, summary")?.textContent ?? "").trim();
      return label ? { node, label } : null;
    }).filter(Boolean);
    const glyphOf = (label) => /履歴|アクティビティ/.test(label) ? "history" : /チップ|受取/.test(label) ? "heart" : /連携/.test(label) ? "contacts" : "wallet";
    tree("ウォレット", "wallet", () => document.querySelector("#view-wallet")?.scrollIntoView?.({ block: "start" }), false, () => {
      const short = { "この端末のウォレット": "この端末", "プロフィール連携": "連携", "連携中のアドレス": "アドレス", "最近の履歴": "履歴", "チップの受取設定": "チップ" };
      for (const { node, label } of blocks) row(short[label] ?? label, "", () => node.scrollIntoView?.({ block: "start", behavior: "smooth" })).prepend(sidebarIcon(document, glyphOf(label)));
    });
  }
  // 見つける系（概要・世界・ランキング・サービス・本・この端末）とアカウント（プロフィール・ウォレット）は、
  // 列に置けるのが他の画面への行き先だけなので、何も出さずに畳む。行き先は「すべての機能」にある。
}

function showView(view, title, history = {}) {
  if(view!=="feed")contentSharePreview?.invalidate();
  if(currentView==="feed"&&view!=="feed"){captureSocialScene();socialStreamController?.invalidate();}
  if(currentView==='videos'&&view!=='videos'){captureVideoScene();videoSearch.invalidate();}
  if(view!=='videos')videoSceneRevision++;
  const previousView = currentView;
  if(previousView==='messages'&&view!=='messages')closeDmView();
  if (previousView === "notifications" && view !== "notifications") notificationsController.invalidate("view");
  if (previousView === "wallet" && view !== "wallet") releaseWalletTipSettings();
  if (previousView === "market" && view !== "market") releaseOwnedEventListings();
  if (previousView === "node" && view !== "node") hubPeers.closeTransfer();
  if(view!=="detail" && typeof releaseResearchDetail==='function'){releaseResearchDetail();releaseCommunityDetail();}
  const viewChanged = currentView !== view;
  if(viewChanged)disposeExternalMediaRegistration();
  if(viewChanged&&previousView==='videos')stopVideoPlayer();
  // 小窓の位置をブラウザのページへ伝え直す（ブラウザの枠は表示のあとで決まるので、少し遅れてもう一度）。
  if(viewChanged&&typeof ytDock!=='undefined'){requestAnimationFrame(()=>ytDock.layout());setTimeout(()=>ytDock.layout(),400);}
  const scroller = viewChanged ? viewScroller() : null;
  if (scroller && previousView !== "detail") viewScroll.set(previousView, scroller.scrollTop);
  if (previousView === "threads" && toolbarTrail[toolbarTrailIndex]?.view === "threads" && !history.replay && !history.detailReplay) Object.assign(toolbarTrail[toolbarTrailIndex], {
    boardKey: threadBoardKey, boardTitle: threadBoardTitle, query: document.querySelector("#threads-query").value,
  });
  currentView = view;
  if (typeof feedLive !== "undefined") feedLive?.sync();
  // 音楽の画面（一覧と作品の詳細）を離れたら YouTube の埋め込みを外す。音も止まる。
  if (typeof musicYoutube !== "undefined") musicYoutube.sync(view === "music" || railMusic?.hostsYoutube() === true);
  syncSavedSearchView(previousView, view);
  if(typeof feedComposer!=='undefined'){
    if(viewChanged&&(previousView==='feed'||view==='feed'))feedComposerViewEpoch={};
    if(view==='feed')feedComposer?.refresh();
  }
  if (view === "feed" && typeof syncFeedInlineComposer === "function") syncFeedInlineComposer();
  if (view === "market") queueMicrotask(syncOwnedEventListings);
  if (view === "articles") void articleEditor?.refreshScope().catch(() => {});
  if (viewChanged && (previousView === "ai" || view === "ai")) syncPiChangesView?.(view);
  syncCommunityInvite();
  if (viewChanged && view !== "detail" && !history.replay && !history.detailReplay) detailForwardTrail = [];
  if (view === "search" && viewChanged) {
    const toolbarInput = document.querySelector("#toolbar-search-input");
    if (document.activeElement !== toolbarInput) toolbarInput.value = document.querySelector("#search-query").value;
  }
  if (viewChanged && view !== "detail" && !history.replay && !history.detailReplay && toolbarTrail[toolbarTrailIndex]?.view !== view) {
    toolbarTrail.splice(toolbarTrailIndex + 1);
    toolbarTrail.push({ view, title });
    toolbarTrailIndex = toolbarTrail.length - 1;
  }
  if (view === "threads") Object.assign(toolbarTrail[toolbarTrailIndex], {
    boardKey: threadBoardKey, boardTitle: threadBoardTitle, query: document.querySelector("#threads-query").value,
  });
  const wasAppsOpen = appsOpen;
  appsOpen = false;
  const shell = document.querySelector(".app-shell");
  if ((viewChanged || wasAppsOpen) && matchMedia("(max-width: 860px)").matches) shell?.classList.add("sidebar-collapsed");
  // ウォレットとプロフィールも他の画面と同じく左の列を出す（2026-10-11 ユーザー指定）。自動で畳まない。
  const railOpen = (rightRailAvailable(view) && matchMedia("(min-width: 861px)").matches && railChoiceFor(view));
  syncSidebarForRail(railOpen);
  shell?.classList.toggle("ai-active", view === "ai");
  shell?.classList.toggle("browser-active", view === "browser");
  shell?.classList.toggle("messages-active", view === "messages");
  shell?.classList.toggle("mail-active", view === "mail");
  if (viewChanged && view === "messages") setDmThreadShown(false);
  if (shell) shell.dataset.template = templateFor(view, detailTrail.at(-1)?.name);
  // 既定の列幅は画面（メッセージ・ブラウザ）で変わるので、クラスを替えたあとに引き直す。
  queueMicrotask(() => { try { applyColumnWidths(); } catch { /* 起動前の呼び出しは何もしない */ } });
  renderSidebarContext(view);
  markRailCurrent(view);
  shell?.classList.toggle("rail-open", railOpen);
  document.querySelector("#rail-activity-toggle")?.setAttribute("aria-expanded", String(railOpen));
  document.querySelector("#rail-activity-toggle")?.classList.toggle("on", railOpen);
  const rail = document.querySelector(".rail");
  rail?.classList.toggle("view-notifications", view === "notifications");
  rail?.classList.toggle("view-messages", view === "messages" || view === "mail");
  rail?.classList.toggle("view-profile", view === "profile");
  for (const panel of document.querySelectorAll("[data-view-panel]")) {
    const selected = panel.dataset.viewPanel === view;
    panel.classList.toggle("on", selected);
    if (selected && title) panel.setAttribute("aria-label", title);
  }
  if (scroller) requestAnimationFrame(() => {
    if (currentView === view) scroller.scrollTop = view === "detail" ? detailTrail.at(-1)?.scrollTop ?? 0 : viewScroll.get(view) ?? 0;
  });
  const head = document.querySelector(`#view-${view} :is(.view-head, .page-header) h2`);
  if (head && view !== "feed") head.textContent = view === "ai" ? "AI" : title;
  document.querySelector("#toolbar-current").textContent = view === "feed" ? "タイムライン" : head?.textContent || title || "Hub";
  updateToolbarNavigation();
  const railBody = document.querySelector(".rail-body");
  if (railBody) railBody.hidden = !railOpen;
  if (railActivityReady) syncRailView();
  for (const button of document.querySelectorAll(".desktop-rail-toggle")) {
    button.setAttribute("aria-expanded", String(railOpen));
    button.setAttribute("aria-label", railOpen ? "情報パネルを閉じる" : "情報パネルを開く");
  }
}

// 左のアイコン列の「いま」の印は1か所だけ。「すべての機能」を開いている間は、その鍵だけが現在（開く前の画面は印を外す）。
function markRailCurrent(view) {
  const shell = document.querySelector(".app-shell");
  const contextView = view === "detail" ? (DETAIL_PARENT_VIEW[detailTrail.at(-1)?.name] || view) : view;
  const main = contextView === "hubpedia" ? "research" : contextView === "threads" || contextView === "community" ? "feed" : document.querySelector(`.icon-rail .icon-nav-item[data-view="${contextView}"]`) ? contextView : ({ discovery: "home", account: view === "wallet" ? "wallet" : "profile", market: "market", messages: "messages", feed: "feed" }[shell?.dataset.sidebarContext] || contextView);
  let selectedVisible = false;
  for (const item of document.querySelectorAll(".icon-rail .icon-nav-item")) {
    const selected = !appsOpen && item.dataset.view === main;
    item.classList.toggle("on", selected);
    if (selected) {
      item.setAttribute("aria-current", "page");
      item.scrollIntoView({ block: "nearest" });
    }
    else item.removeAttribute("aria-current");
    selectedVisible ||= selected && item.getClientRects().length > 0;
  }
  const appsButton = document.querySelector("#desktop-apps");
  const inMore = !selectedVisible && contextView !== "search";
  appsButton?.classList.toggle("current", inMore);
  if (inMore) appsButton?.setAttribute("aria-current", "page");
  else appsButton?.removeAttribute("aria-current");
}

function textValue(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

const GROUP_LABELS = {
  boards: "掲示板", profiles: "人物", threads: "スレッド", posts: "投稿", images: "画像",
  hubpedia: "Hubpedia", communities: "コミュニティ", videos: "動画",
  lists: "リスト", tokens: "トークン", work: "仕事", realEstate: "不動産", vehicles: "車",
  listings: "出品", coreEntities: "その他", results: "検索結果", works: "楽曲", games: "ゲーム",
  rankings: "ランキング", articles: "記事", projects: "プロジェクト", tracks: "公開曲", books: "本"
};

function publicGroups(data) {
  if (Array.isArray(data)) return [["results", data]];
  if (!data || typeof data !== "object") return [];
  const groups = Object.entries(data).filter(([, value]) => Array.isArray(value) && value.length);
  if (groups.length) {
    const typed = groups.filter(([key]) => key !== "coreEntities");
    const ids = new Map(typed.map(([key, records]) => [key, new Set(records.flatMap((record) =>
      [record?.id, record?.slug].filter((id) => typeof id === "string" && id)))]));
    const core = groups.find(([key]) => key === "coreEntities");
    const unique = core?.[1].filter((item) => !ids.get(item?.sourceGroup)?.has(item?.ref?.id)) ?? [];
    return unique.length ? [...typed, ["coreEntities", unique]] : typed;
  }
  const nested = Object.entries(data).find(([, value]) => value && typeof value === "object" && !Array.isArray(value));
  return nested ? publicGroups(nested[1]) : [];
}

// 空・未接続・読込の見せ方は全画面で同じ部品にする。
// 画面ごとの即興表示が「製品になっていない」印象を作る。
function emptyState(iconName, title, body) {
  const box = document.createElement("div");
  box.className = "empty-state";
  const iconNode = document.createElement("span");
  iconNode.className = "empty-icon";
  iconNode.innerHTML = icon(iconName);
  const strong = document.createElement("strong");
  strong.textContent = title;
  box.append(iconNode, strong);
  // 説明は字で見せない（2026-11-04）。短い一言だけ残し、長い文・生のエラーはtitle属性に回す。
  if (body && String(body).length <= 12) {
    const text = document.createElement("p");
    text.textContent = body;
    box.append(text);
  } else if (body) box.title = String(body);
  return box;
}

// 共通の空・エラー表示（components.css の .state-panel）。retry を渡すと「再試行」の二番手ボタンを添える。
function statePanel(iconName, title, body, retry) {
  const box = document.createElement("div");
  box.className = "state-panel";
  box.setAttribute("role", "status");
  const iconNode = document.createElement("span");
  iconNode.className = "state-icon";
  iconNode.innerHTML = icon(iconName);
  const heading = document.createElement("p");
  heading.className = "state-title";
  heading.textContent = title;
  box.append(iconNode, heading);
  if (body && String(body).length <= 12) {
    const text = document.createElement("p");
    text.className = "state-body";
    text.textContent = body;
    box.append(text);
  } else if (body) box.title = String(body);
  if (retry) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-secondary state-action";
    button.textContent = "再試行";
    button.onclick = () => { button.disabled = true; void retry(); };
    box.append(button);
  }
  return box;
}

// ページ共通の空・エラー表示。既存の .empty-state を保ったまま、
// components.css の .state-panel を重ねて三画面の見た目を揃える。
function pageState(iconName, title, body, run) {
  const box = emptyState(iconName, title, body);
  box.setAttribute("role", "status");
  box.classList.add("state-panel");
  box.querySelector(".empty-icon")?.classList.add("state-icon");
  box.querySelector("strong")?.classList.add("state-title");
  box.querySelector("p")?.classList.add("state-body");
  if (run) box.append(stateRetryButton(run));
  return box;
}

function pageErrorState(title, detail, run) {
  const box = pageState("alert", title, detail);
  box.classList.add("load-error");
  box.setAttribute("role", "alert");
  if (run) box.append(stateRetryButton(run));
  return box;
}

function webDiscoveryAction(label, query) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "approve";
  button.textContent = label;
  button.onclick = () => void openWebSearch(query);
  return button;
}

function connectState(detail) {
  // 未ログイン表示は Web の V2State(signedOut) と同じ部品。主ボタンは 1 つだけ。
  return createState(document, {
    kind: "signedOut",
    icon: "lock",
    title: "Desktop接続が必要です",
    note: detail,
    action: { label: "Desktopを接続", onClick: () => void connectDesktopAccount() },
    iconSvg: icon,
  });
}

function skeletonResult() {
  const card = document.createElement("div");
  card.className = "card skeleton-post";
  for (const w of ["skeleton-line w40", "skeleton-line", "skeleton-line w60"]) {
    const line = document.createElement("div");
    line.className = `skeleton-block ${w}`;
    card.append(line);
  }
  return card;
}

function resultCard(record, fallback = "詳細はWeb版と同じHubデータから取得しています。") {
  const card = document.createElement("article");
  card.className = "card result-card";
  const title = document.createElement("strong");
  title.textContent = textValue(record, ["title", "name", "displayName", "display_name", "artist", "handle", "slug", "id"]) || "Hubの項目";
  const summary = document.createElement("p");
  summary.textContent = textValue(record, ["summary", "description", "body", "bio", "artistName", "artist_name", "category", "kind"]) || fallback;
  const meta = document.createElement("p");
  meta.className = "meta";
  const handle = textValue(record, ["handle"]);
  const reference = handle ? (handle.startsWith("@") ? handle : `@${handle}`) : textValue(record, ["slug", "genre", "category"]);
  const date = relTime(textValue(record, ["createdAt", "created_at", "updatedAt", "updated_at"]));
  const bits = [reference, date].filter(Boolean);
  meta.textContent = bits.join(" · ");
  card.append(title, summary);
  if (meta.textContent) card.append(meta);
  return card;
}

// 検索の投稿は汎用カードではなく投稿カードで出す——いいねも返信も
// できる実物の方が、見るだけの要約より「同じ内容」になる。
function searchPost(record) {
  if (typeof record?.id !== "string" || !record.id) return null;
  if (!(typeof record.body === "string" && record.body.trim()) &&
      !record.referenced && !(Array.isArray(record.images) && record.images.length) &&
      !(Array.isArray(record.tags) && record.tags.length)) {
    const author = textValue(record, ["authorName", "displayName", "handle"]) || "投稿";
    const card = resultCard({ ...record, title: `${author}の投稿` }, "投稿を開いて内容を確認");
    card.classList.add("is-link");
    card.tabIndex = 0;
    card.title = "投稿を開く";
    card.onclick = () => void openDetail("post", [record.id], { title: "投稿" });
    card.onkeydown = (event) => { if (event.key === "Enter") card.click(); };
    return card;
  }
  return postCard({
    ...record,
    authorName: record.authorName ?? record.displayName ?? "",
    authorHandle: record.authorHandle ?? record.handle ?? null,
    likeCount: record.likeCount ?? 0,
    replyCount: record.replyCount ?? 0,
    repostCount: record.repostCount ?? 0,
  });
}

// 検索結果1件を開く関数（無ければ null）。検索カードと上の検索欄の候補が同じ道を使う。
function searchResultOpener(key, record, title) {
  if (key === "posts") return record?.id ? () => openDetail("post", [record.id], { title: "投稿" }) : null;
  return key === "coreEntities"
    ? (typeof record?.href === "string" && record.href.startsWith("/") ? () => openHubPath(record.href, title) : null)
    : ({
    threads: () => record.id && openDetail("thread", [record.id], { title: title || "スレッド" }),
    communities: () => record.id && openDetail("community", [record.id], { title: title || "コミュニティ" }),
    hubpedia: () => record.slug && openDetail("hubpedia_article", [record.slug], { title: title || "記事" }),
    articles: () => record.id && openDetail("article", [record.id], { title: title || "記事" }),
    listings: () => record.id && openDetail("listing", [record.id], { title: title || "出品" }),
    videos: () => openDetail("video", [record.id ?? ""], { local: true, data: record, title: title || "動画" }),
    projects: () => record.id && openDetail("research_project", [record.id], {title}),
    books: () => record.id && openDetail("book", [record.id], {title}),
    games: () => record.slug && openStoreGame(record),
    tracks: () => playMusicTrack(record, [record]),
    works: () => playMusicWork(record),
    profiles: () => record.handle && openDetail("profile", [record.handle], { title: title || "プロフィール" }),
  }[key] ?? null);
}

// 検索結果のグループからネイティブ詳細への写し方。対応する面が無い
// グループ（人物・リスト等）はクリックなしのカードのままにする。
function searchResultCard(key, record) {
  if (key === "posts") return searchPost(record) ?? resultCard(record);
  const card = resultCard(record, key === "coreEntities" ? GROUP_LABELS[record?.sourceGroup] ?? "Hubの項目" : undefined);
  const title = textValue(record, ["title", "name", "displayName", "display_name", "slug", "id"]);
  const open = searchResultOpener(key, record, title);
  if (!open) return card;
  card.classList.add("is-link");
  card.tabIndex = 0;
  card.title = "開く";
  card.onclick = () => void open();
  card.onkeydown = (event) => { if (event.key === "Enter") void open(); };
  return card;
}

function renderPublicResults(target, data, query, conditions = false) {
  const groups = publicGroups(data);
  const nodes = [];
  for (const [key, records] of groups) {
    const heading = document.createElement("h3");
    heading.className = "result-heading";
    heading.textContent = GROUP_LABELS[key] ?? key;
    nodes.push(heading);
    for (const record of records) {
      nodes.push(searchResultCard(key, record));
    }
  }
  if (!nodes.length) nodes.push(conditions && !query
    ? emptyState("search", "条件に一致する項目はありません", "条件を変更して再検索してください。")
    : query ? emptyState("search", "該当する項目はありません", `「${query}」に合うものは見つかりませんでした`)
    : emptyState("search", "検索", "上の欄から検索できます。"));
  target.replaceChildren(...nodes);
}

async function loadPublic(resource, query, target, state, cursor) {
  state.textContent = "";
  state.classList.remove("warning");
  target.replaceChildren(skeletonResult(), skeletonResult(), skeletonResult());
  try {
    const data = await invoke("hub_resource", { resource, query, cursor: cursor ?? null });
    renderPublicResults(target, data, query);
    return data;
  } catch (error) {
    target.replaceChildren();
    state.textContent = friendlyError(error);
    state.classList.add("warning");
    return null;
  }
}

// --- カタログ・個人面 ---
// Hub内パスの行き先。ネイティブ詳細があるものはそちらへ——残りは
// アプリ版に無い画面として正直に告げる。Web版へは逃がさない。
async function openSharedContentReference(href, isCurrent, event) {
  const reference=contentShareReference(href);if(!reference||!isCurrent())return;
  try {
    const origin=homeCanonicalOrigin(await invoke('hub_origin'));
    if(!isCurrent())return;
    const target=new URL(reference.href,origin);
    if(event?.ctrlKey||event?.metaKey||event?.shiftKey||event?.button===1) return await invoke('open_external',{url:target.href});
    if(reference.kind==='github') return await enterBrowser(target.href);
    if(target.origin!==origin) return await invoke('open_external',{url:target.href});
    return await openHubPath(target.pathname+target.search+target.hash,undefined,isCurrent);
  }catch(error){if(isCurrent())showNotice(friendlyError(error));}
}
async function openHubPath(path, title, isCurrent = () => true) {
  if (typeof path !== "string" || typeof isCurrent !== 'function' || !isCurrent()) return;
  const researchId = path.match(/^\/(?:v2\/)?research\/([A-Za-z0-9_-]{1,128})\/?$/)?.[1];
  if (researchId) return openDetail("research_project", [researchId], { title: title || "プロジェクト", isCurrent });
  if (/^\/(?:v2\/)?research\/?$/.test(path)) return navigateFrom({ dataset: { view: "research", title: "プロジェクトと研究" }, childNodes: [] });
  const detail = detailForHubPath(path);
  if (detail) {
    return openDetail(detail.name, detail.ids, { title: detail.title, isCurrent });
  }
  const board = path.match(/^\/bbs\/([A-Za-z0-9_-]{1,128})(?:[/?#]|$)/);
  if (board) {
    await navigateFrom({ dataset: { view: "threads", title: "スレッド", boardKey: board[1], boardTitle: title || "掲示板" }, childNodes: [] });
    return;
  }
  const catalog = path.match(/^\/(?:v2\/)?(token|services)(?:[/?#]|$)/)?.[1];
  if (catalog) {
    const destinations = { token: ["ranking", "ランキング"], services: ["services", "サービス"] };
    const [view, label] = destinations[catalog];
    await navigateFrom({ dataset: { view, title: label }, childNodes: [] });
    return;
  }
  // 詳細ではなくビューに行く行き先。channel=email はネイティブメール、
  // 裸の /messages はDM一覧。
  const messagesPath = path.match(/^\/(?:v2\/)?messages\/?(?:\?(.*))?$/);
  if (messagesPath) {
    const channel = new URLSearchParams(messagesPath[1] ?? "").get("channel");
    void navigateFrom({ dataset: { view: channel === "email" ? "mail" : "messages" }, childNodes: [] });
    return;
  }
  const videoId=path.match(/^\/(?:v2\/)?videos\/([A-Za-z0-9_-]{1,128})\/?$/)?.[1];
  if(videoId){try{const data=await invoke('hub_detail',{name:'video',ids:[videoId]});if(!isCurrent())return;await navigateFrom({dataset:{view:'videos',title:'動画'},childNodes:[]});if(isCurrent())openVideoWatch(data.video);}catch(error){if(isCurrent())showNotice(friendlyError(error));}return;}
  if(/^\/(?:v2\/)?music\?/u.test(path)){
    const query=hubMusicQuery(path);
    if(query===null){showNotice('音楽の検索語は100文字・8語以内で指定してください。');return;}
    musicSearch.invalidate();catalogSearches.get('music')?.invalidate();
    for(const id of ['music-query','music-catalog-query']){
      const input=document.getElementById(id);if(input){input.value=query;input.dispatchEvent(new Event('input',{bubbles:true}));}
    }
    musicCatalogLoaded=true;document.querySelector('#music-tab-catalog').click();
    await navigateFrom({dataset:{view:'music',title:'音楽'},childNodes:[]});
    return;
  }
  showNotice("この画面はアプリ版ではまだ開けません。");
}

function showNotice(text) {
  const dialog = document.querySelector("#notice-dialog");
  if (!dialog) return;
  document.querySelector("#notice-text").textContent = text;
  dialog.showModal();
}

function articleCoverLabel(article) {
  const tag = (Array.isArray(article?.tags) ? article.tags : []).find((value) => typeof value === "string" && value.trim());
  if (tag) return tag.trim();
  const title = String(article?.title ?? "").trim();
  return title ? Array.from(title)[0] : "記事";
}

function catalogCard({ title, body, meta = [], imageUrl, href, onOpen, cover = false, coverLabel, badge = "", menuWork = null }) {
  const card = document.createElement("article");
  card.className = "card result-card";
  if (cover) {
    card.classList.add("has-cover");
    card.append(createCoverMedia(document, { url: imageUrl, title: title || "Hubの項目", fallbackLabel: coverLabel, hubAsset, hubOrigin: hubOrigin ?? "", ratio: "16 / 9" }));
  } else if (imageUrl) {
    const media = document.createElement("div");
    media.className = "result-media";
    const img = document.createElement("img");
    hubAsset(img, imageUrl);
    img.alt = "";
    img.loading = "lazy";
    media.append(img);
    card.append(media);
  }
  const strong = document.createElement("strong");
  strong.textContent = title || "Hubの項目";
  card.append(strong);
  if (badge) {
    const chip = document.createElement("span");
    chip.className = "card-badge";
    chip.textContent = badge;
    strong.after(chip);
  }
  if (body) {
    const text = document.createElement("p");
    text.textContent = body;
    card.append(text);
  }
  const bits = meta.filter(Boolean);
  if (bits.length) {
    const metaLine = document.createElement("p");
    metaLine.className = "meta";
    metaLine.textContent = bits.join(" · ");
    card.append(metaLine);
  }
  const open = onOpen ?? (href ? () => void openHubPath(href) : null);
  if (open) {
    card.classList.add("is-link");
    card.tabIndex = 0;
    card.title = "開く";
    card.onclick = open;
    card.onkeydown = (event) => { if (event.key === "Enter" && event.target === card) open(); };
  }
  if (menuWork) { card.classList.add("has-music-menu"); card.append(musicMenuButton(document, menuWork)); }
  return card;
}

// 連絡先はプロフィールなのでアバター付き。押すとWeb版のプロフィールへ。
function contactCard(profile) {
  const card = document.createElement("article");
  card.className = "card result-card contact-card is-link";
  card.tabIndex = 0;
  const avatar = document.createElement("span");
  avatar.className = "post-avatar";
  if (profile.avatarUrl) {
    const img = document.createElement("img");
    hubAsset(img, profile.avatarUrl);
    img.alt = "";
    avatar.classList.add("has-image");
    avatar.append(img);
  } else {
    avatar.textContent = (profile.displayName || profile.handle || "?").trim().slice(0, 1).toUpperCase();
    paintAvatar(avatar, profile.displayName || profile.handle);
  }
  const body = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = profile.displayName || profile.handle;
  const handle = document.createElement("p");
  handle.className = "meta";
  handle.textContent = `@${profile.handle}`;
  body.append(strong, handle);
  if (profile.bio) {
    const bio = document.createElement("p");
    bio.textContent = profile.bio;
    body.append(bio);
    addBaitRow(document, bio, profile.bio);
  }
  card.append(avatar, body);
  const open = () => void openHubPath(`/v2/profile/${encodeURIComponent(profile.handle)}`);
  card.onclick = open;
  card.onkeydown = (event) => { if (event.key === "Enter") open(); };
  return card;
}

// ブックマークは対象の種類が混ざる。投稿は実物カード、スレッドと返信は
// 行き先つきの要約で出す。
function bookmarkCard(item) {
  if (item.kind === "social" && item.post) return searchPost(item.post) ?? resultCard(item.post);
  const detail = detailForHubPath(item.href);
  const onOpen = detail ? () => void openDetail(detail.name, detail.ids, { title: item.threadTitle ?? item.title ?? "詳細" }) : null;
  if (item.kind === "reply") {
    return catalogCard({
      title: item.threadTitle,
      body: `${item.displayName}: ${item.body}`,
      meta: item.note ? [item.note] : [],
      onOpen,
    });
  }
  return catalogCard({ title: item.title, body: item.note, onOpen });
}

function walletText(tag, className, value) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = value;
  return node;
}

// 数量の入力をweiへ。小数18桁まで。BigIntで組むので精度は落ちない。
function tokenToWei(text) {
  const match = /^(\d+)(?:\.(\d{1,18}))?$/.exec((text ?? "").trim());
  if (!match) return null;
  return BigInt(match[1]) * 10n ** 18n + BigInt((match[2] ?? "").padEnd(18, "0"));
}

// この端末のウォレットをプロフィールへ連携する。
// challenge取得 → 端末で署名（確認モーダル） → verify、の3段。
async function linkDeviceWallet(status, note) {
  const challenge = await invoke("hub_client_action", {
    action: "wallet_link_challenge",
    options: { address: status.address, chainId: status.chainId },
  });
  note.textContent = "署名を確認してください…";
  const signature = await invoke("wallet_sign_typed_data", { typedData: challenge.typedData });
  note.textContent = "連携を確定しています…";
  await invoke("hub_client_action", {
    action: "wallet_link_verify",
    options: {
      challengeId: challenge.challengeId,
      address: status.address,
      typedData: challenge.typedData,
      signature,
    },
  });
  note.textContent = "連携しました。";
}

// チップ送金。受取設定（公開API）→ 数量入力 → 端末ウォレットで送金
// （確認モーダル）→ ハブへ確定通知。受け付けていない相手にはその旨を出す。
async function openTipDialog(profile) {
  const dialog = document.querySelector("#tip-dialog");
  const note = document.querySelector("#tip-note");
  const select = document.querySelector("#tip-option");
  const send = document.querySelector("#tip-send");
  const amount = document.querySelector("#tip-amount");
  if (!dialog || !note || !select || !send || !amount) return;
  document.querySelector("#tip-to").textContent = `${profile.displayName ?? ""} @${profile.handle} へ`;
  note.textContent = "受取設定を確認しています…";
  select.replaceChildren();
  select.disabled = true;
  send.disabled = true;
  amount.value = "";
  dialog.showModal();
  try {
    const info = await invoke("hub_detail", { name: "tip_recipient", ids: [profile.handle] });
    const options = info?.options ?? [];
    if (!info?.enabled || !options.length) {
      note.textContent = "このユーザーはチップを受け付けていません。";
      return;
    }
    for (const option of options) {
      const el = document.createElement("option");
      el.value = JSON.stringify(option);
      el.textContent = `${option.network}（${option.symbol}）→ ${option.address.slice(0, 12)}…`;
      select.append(el);
    }
    select.disabled = false;
    send.disabled = false;
    const showMinimum = () => {
      const option = JSON.parse(select.value);
      note.textContent = `最低 ${option.minimumAmount} ${option.symbol} から送れます。`;
    };
    select.onchange = showMinimum;
    showMinimum();
    send.onclick = async () => {
      const option = JSON.parse(select.value);
      const wei = tokenToWei(amount.value);
      if (!wei || wei <= 0n) {
        note.textContent = "数量が正しくありません。";
        return;
      }
      send.disabled = true;
      note.textContent = "ウォレットで承認してください…";
      try {
        const txHash = await invoke("wallet_send_native", {
          chainId: option.chainId,
          to: option.address,
          amountWei: wei.toString(),
        });
        note.textContent = "送金をネットワークへ届けました。ハブで確認しています…";
        const result = await invoke("hub_client_action", {
          action: "tip_confirm",
          options: { handle: profile.handle, txHash, chainId: option.chainId },
        });
        note.textContent = result?.confirmed
          ? "チップを送りました。"
          : "送金を記録しました。確定まで時間がかかることがあります。";
      } catch (error) {
        note.textContent = friendlyError(error);
        send.disabled = false;
      }
    };
  } catch (error) {
    note.textContent = friendlyError(error);
  }
}

let walletHistoryController=null, walletTipSettingsController=null, ownedEventListingsController=null;
function releaseWalletTipSettings() { walletTipSettingsController?.destroy(); walletTipSettingsController=null; }
function releaseOwnedEventListings() { ownedEventListingsController?.destroy(); ownedEventListingsController=null; }
function syncOwnedEventListings() {
  const host=document.querySelector('#market-listings');
  if (currentView!=='market' || !host || host.hidden) { releaseOwnedEventListings(); return; }
  if (ownedEventListingsController) return;
  const generation=researchAccountGeneration;
  ownedEventListingsController=createOwnedEventListings({document,invoke,getScope:()=>articleEditorScope(),
    isCurrent:()=>currentView==='market'&&!host.hidden&&generation===researchAccountGeneration,
    onOpen:url=>enterBrowser(url)});
  host.prepend(ownedEventListingsController.element);
}
window.addEventListener('hub-account-changed',()=>{releaseWalletTipSettings();releaseOwnedEventListings();queueMicrotask(syncOwnedEventListings);});
window.addEventListener('hub-account-changed',()=>{
  walletHistoryController?.destroy();walletHistoryController=null;
  const target=document.querySelector('#wallet-results');target.catalogRequest=Symbol('account_changed');target.replaceChildren();
  if(currentView==='wallet')void loadCatalog('wallet');
});
function walletBalanceSummary(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new RangeError("invalid wallet balance");
  const wei = BigInt(value);
  if (wei > (1n << 128n) - 1n) throw new RangeError("invalid wallet balance");
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
  return { label: wei > 0n && whole === 0n && !frac ? "0.000001未満" : `${whole}${frac ? `.${frac}` : ""}`, canSend: wei > 0n };
}

async function renderWallet(target, data, isCurrent = () => true) {
  releaseWalletTipSettings();
  walletHistoryController?.destroy();walletHistoryController=null;
  const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
  const links = Array.isArray(data?.links) ? data.links : [];
  const activity = Array.isArray(data?.activity) ? data.activity : [];
  const device = document.createElement("section");
  device.className = "wallet-device";
  const note = walletText("p", "wallet-note", "");
  let status;
  try {
    status = await settleWithin(invoke("wallet_status"));
  } catch (error) {
    if (!isCurrent()) return;
    device.append(walletText("h3", "", "この端末のウォレットを開けません"), walletText("p", "wallet-note", friendlyError(error)));
  }
  if (!isCurrent()) return;

  if (status?.address) {
    const linked = links.some((link) => validLink(link) && link.chainId === status.chainId && link.address.toLowerCase() === status.address.toLowerCase());
    const top = document.createElement("div");
    top.className = "wallet-device-top";
    const networkName = status.chainName || `chain ${status.chainId}`;
    const symbol = typeof status.symbol === "string" && status.symbol ? status.symbol : "ネイティブトークン";
    top.append(walletText("span", "wallet-eyebrow", "この端末のウォレット"), walletText("span", "wallet-network", `${networkName} · chain ${status.chainId}${status.mainnet === false ? " · テスト用" : ""}`));
    const walletNetwork = createWalletNetwork({ document, invoke, status, isCurrent, describeError: friendlyError, onChanged: () => void loadCatalog("wallet") });
    const balance = walletText("strong", "wallet-balance", "—");
    const balanceState = walletText("p", "wallet-balance-state", "残高を確認中…");
    balanceState.setAttribute("role", "status");
    const unit = walletText("span", "wallet-unit", `${symbol}（${networkName}）`);
    const tokens = createWalletTokens({ document, invoke, status, isCurrent });
    const address = walletText("p", "wallet-address mono", status.address);
    const actions = document.createElement("div");
    actions.className = "wallet-actions";
    const receive = walletText("button", "approve", "受け取る");
    const send = walletText("button", "deny", "送金する");
    receive.type = send.type = "button";
    send.disabled = true;
    const receivePanel = document.createElement("div");
    receivePanel.className = "wallet-action-panel";
    receivePanel.hidden = true;
    receivePanel.append(walletText("strong", "", "受取アドレス"), walletText("p", "wallet-address mono", status.address));
    const copy = walletText("button", "head-action", "アドレスをコピー");
    copy.type = "button";
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(status.address);
        copy.textContent = "コピーしました";
        setTimeout(() => { copy.textContent = "アドレスをコピー"; }, 1600);
      } catch { note.textContent = "コピーできませんでした。"; }
    };
    receivePanel.append(copy, walletText("p", "wallet-note", `受取ネットワークは ${networkName}（chain ID ${status.chainId}）です。別のネットワークで送ると受け取れないことがあります。送る側でも確認してください。`));
    const sendPanel = document.createElement("div");
    sendPanel.className = "wallet-action-panel wallet-send-panel";
    sendPanel.hidden = true;
    sendPanel.append(walletText("strong", "", "送金内容"), walletText("p", "wallet-note wallet-send-network", `${networkName}（chain ID ${status.chainId}）の ${symbol} を送ります。確認画面で宛先と数量を再確認してください。`), networkNotice(document, status.mainnet === true));
    const fields = document.createElement("div");
    fields.className = "wallet-send-fields";
    const toLabel = walletText("label", "", "送り先アドレス");
    const toInput = document.createElement("input");
    toInput.type = "text";
    toInput.placeholder = "0x…";
    toInput.maxLength = 42;
    toInput.spellcheck = false;
    toLabel.append(toInput);
    const amountLabel = walletText("label", "", `数量（${symbol}）`);
    const amountInput = document.createElement("input");
    amountInput.type = "text";
    amountInput.inputMode = "decimal";
    amountInput.maxLength = 30;
    amountLabel.append(amountInput);
    fields.append(toLabel, amountLabel);
    const sendButton = walletText("button", "approve", "内容を確認して送金");
    sendButton.type = "button";
    sendButton.onclick = async () => {
      const to = toInput.value.trim();
      const wei = tokenToWei(amountInput.value);
      if (!/^0x[0-9a-fA-F]{40}$/.test(to)) { note.textContent = "送り先のアドレスが正しくありません。"; return; }
      if (!wei || wei <= 0n) { note.textContent = "数量が正しくありません。"; return; }
      sendButton.disabled = true;
      note.textContent = "確認画面で内容を確かめてください。";
      try {
        const hash = await invoke("wallet_send_native", { chainId: status.chainId, to, amountWei: wei.toString() });
        note.textContent = `送金をネットワークへ届けました。${hash}`;
      } catch (error) {
        note.textContent = friendlyError(error);
      } finally {
        sendButton.disabled = false;
      }
    };
    sendPanel.append(fields, sendButton);
    const toggle = (panel, button) => {
      const opening = panel.hidden;
      receivePanel.hidden = sendPanel.hidden = true;
      receive.setAttribute("aria-expanded", "false");
      send.setAttribute("aria-expanded", "false");
      panel.hidden = !opening;
      button.setAttribute("aria-expanded", String(opening));
      if (opening) panel.querySelector("input")?.focus();
    };
    receive.onclick = () => toggle(receivePanel, receive);
    send.onclick = () => toggle(sendPanel, send);
    receive.setAttribute("aria-expanded", "false");
    send.setAttribute("aria-expanded", "false");
    actions.append(receive, send);
    device.append(top, walletNetwork.element, balance, unit, balanceState, tokens.element, address, actions, receivePanel, sendPanel, note);
    settleWithin(invoke("wallet_balance")).then((result) => {
      if (!isCurrent()) return;
      // 別のネットワークの残高を、表示中のネットワークのものとして見せない。
      if (result?.chainId !== status.chainId) throw new RangeError("wallet balance is for another network");
      const summary = walletBalanceSummary(result?.balanceWei);
      balance.textContent = summary.label;
      balanceState.hidden = summary.canSend;
      if (summary.canSend) send.disabled = false;
      else balanceState.textContent = "送金できる残高がありません。";
    }).catch(() => {
      if (!isCurrent()) return;
      balanceState.classList.add("is-error");
      balance.textContent = "残高を確認できません";
      balance.classList.add("is-unavailable");
      balanceState.textContent = "送金は使えません。ネットワーク接続を確認してください。";
    });

    const profile = document.createElement("section");
    profile.className = "wallet-section";
    profile.append(walletText("h3", "", "プロフィール連携"), walletText("p", "wallet-note", data?.hubUnavailable ? (data.accountUnavailable ? ACCOUNT_UNAVAILABLE_TEXT : "連携状態を確認できません。Hubへの接続を確認してください。") : linked ? "この端末のウォレットは連携済みです。" : "この端末のウォレットはまだ連携していません。"));
    const linkAction = walletText("button", linked ? "deny" : "head-action", linked ? "連携を解除する" : "このウォレットを連携する");
    linkAction.type = "button";
    if (linked) linkAction.textContent = "連携一覧で解除を確認";
    linkAction.onclick = async () => {
      if (!isCurrent()) return;
      if (linked) {
        const button = target.querySelector(`button[data-wallet-address="${status.address.toLowerCase()}"][data-wallet-chain-id="${status.chainId}"]`);
        if (button) { button.click(); button.scrollIntoView({block:"nearest"}); }
        else note.textContent = "連携状態を再確認してから、一覧で解除してください。";
        return;
      }
      linkAction.disabled = true;
      note.textContent = linked ? "解除しています…" : "連携を開始しています…";
      try {
        await linkDeviceWallet(status, note);
        void loadCatalog("wallet");
      } catch (error) {
        linkAction.disabled = false;
        note.textContent = friendlyError(error);
      }
    };
    if (data?.hubUnavailable) {
      const retry = walletText("button", "head-action", "連携状態を再確認");
      retry.type = "button";
      retry.onclick = () => void loadCatalog("wallet");
      profile.append(retry);
    } else profile.append(linkAction);
    target.replaceChildren(device, profile);
  } else {
    if (status) device.append(walletText("h3", "", "この端末のウォレットを開けません"), walletText("p", "wallet-note", "アドレスを取得できませんでした。更新して再試行してください。"));
    target.replaceChildren(device);
  }

  // Hub連携はアドレスとチェーンの組で扱い、端末のリンクも残す。
  function validLink(link) { return link && typeof link.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(link.address)
    && Number.isSafeInteger(link.chainId) && link.chainId > 0
    && typeof link.network === "string" && link.network.trim() && link.network.length <= 80
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(link.network); }
  const linkKey = link => `${link.address.toLowerCase()}:${link.chainId}`;
  const accountMap = new Map(accounts.filter(account => typeof account?.address === "string" && account.address).map(account => [account.address.toLowerCase(), account]));
  const linkedRows = new Map(links.filter(validLink).map(link => [linkKey(link), {address: link.address, account: accountMap.get(link.address.toLowerCase()), link: {...link}}]));
  for (const [key, account] of accountMap) {
    if (![...linkedRows.values()].some(item => item.address.toLowerCase() === key)) linkedRows.set(`account:${key}`, {address: account.address, account});
  }
  if (linkedRows.size || links.some(link => !validLink(link))) {
    const list = document.createElement("section");
    list.className = "wallet-section";
    list.append(walletText("h3", "", "連携中のアドレス"));
    const generation = researchAccountGeneration, account = desktopAccount;
    const current = () => isCurrent() && currentView === "wallet" && generation === researchAccountGeneration && account === desktopAccount && list.isConnected;
    let selected = null, busy = false, recheckRequired = false;
    const message = walletText("p", "wallet-note", links.some(link => !validLink(link)) ? "一部の連携情報を確認できないため、その項目は操作できません。更新して確認してください。" : "");
    message.setAttribute("role", "status");
    const preview = document.createElement("div");
    preview.className = "wallet-action-panel";
    preview.hidden = true;
    const summary = walletText("p", "wallet-note", "");
    const confirm = walletText("button", "deny", "確認して連携を解除");
    const cancel = walletText("button", "head-action", "取消");
    const recheck = walletText("button", "head-action", "連携状態を再確認");
    confirm.type = cancel.type = recheck.type = "button";
    recheck.hidden = true;
    const sync = () => {
      for (const button of list.querySelectorAll("button[data-wallet-unlink]")) button.disabled = busy || recheckRequired;
      confirm.disabled = busy || recheckRequired;
      cancel.disabled = recheck.disabled = busy;
      recheck.hidden = !recheckRequired;
    };
    const verifyAbsent = async link => {
      if (!current()) return null;
      const fresh = await invoke("hub_client", {name: "wallet"});
      if (!current()) return null;
      if (!Array.isArray(fresh?.links) || !fresh.links.every(validLink)) throw new Error("ウォレットの連携状態を確認できませんでした。");
      return !fresh.links.some(item => linkKey(item) === linkKey(link));
    };
    const finish = () => {
      if (!current()) return;
      showNotice("対象のHub連携が解除されていることを確認しました。");
      void loadCatalog("wallet");
    };
    confirm.onclick = async () => {
      if (!current() || busy || recheckRequired || !selected) return;
      const link = selected;
      busy = true; sync(); message.textContent = "Hubとの連携を解除しています…";
      try {
        const result = await invoke("hub_client_action", {action: "wallet_unlink", options: {address: link.address, chainId: link.chainId}});
        if (!current()) return;
        if (typeof result?.unlinked !== "boolean") throw new Error("解除の応答を確認できませんでした。");
        if (await verifyAbsent(link) === true) finish();
        else if (current()) throw new Error("対象の連携が残っています。状態を再確認してください。");
      } catch (error) {
        if (current()) { recheckRequired = true; message.textContent = `${friendlyError(error)} 連携状態を再確認してください。`; }
      } finally { if (current()) { busy = false; sync(); } }
    };
    recheck.onclick = async () => {
      if (!current() || busy || !selected) return;
      busy = true; sync(); message.textContent = "連携状態を確認しています…";
      try {
        if (await verifyAbsent(selected) === true) finish();
        else if (current()) { recheckRequired = false; message.textContent = "対象の連携は残っています。確認後に解除できます。"; }
      } catch (error) { if (current()) message.textContent = friendlyError(error); }
      finally { if (current()) { busy = false; sync(); } }
    };
    cancel.onclick = () => {
      if (!current() || busy) return;
      if (recheckRequired) { message.textContent = "結果を確認するため、先に連携状態を再確認してください。"; return; }
      selected = null; preview.hidden = true; message.textContent = "";
    };
    preview.append(summary, walletText("p", "wallet-note", "Hubプロフィールとの連携だけを解除します。この端末のウォレットや資産は削除しません。"), confirm, cancel, recheck);
    for (const item of linkedRows.values()) {
      const detail = [item.account?.namespace, ...(item.account?.networks ?? []), item.link ? `${item.link.network} · Chain ID ${item.link.chainId}` : "", item.account?.verificationStatus === "watch_only" ? "閲覧のみ" : "", (item.link?.visibility ?? item.account?.visibility) === "public" ? "公開" : ""].filter(Boolean);
      const row = document.createElement("div");
      row.className = "wallet-list-row";
      row.append(walletText("strong", "mono", item.address), walletText("span", "wallet-note", [...new Set(detail)].join(" · ")));
      if (item.link && !data?.hubUnavailable) {
        const unlink = walletText("button", "head-action", "この連携を解除");
        unlink.type = "button";
        unlink.dataset.walletUnlink = linkKey(item.link);
        unlink.dataset.walletAddress = item.link.address.toLowerCase();
        unlink.dataset.walletChainId = String(item.link.chainId);
        unlink.onclick = () => {
          if (!current() || busy || recheckRequired) return;
          selected = item.link; preview.hidden = false;
          summary.textContent = `${item.link.address}（${item.link.network} · Chain ID ${item.link.chainId}）のHub連携を解除します。`;
          message.textContent = "内容を確認してください。"; sync(); confirm.focus();
        };
        row.append(unlink);
      }
      list.append(row);
    }
    list.append(preview, message);
    target.append(list);
  }
  walletHistoryController=createWalletHistory(document,{activity,activityUnavailable:Boolean(data?.hubUnavailable),invoke,
    isCurrent:()=>isCurrent()&&currentView==='wallet',copy:value=>navigator.clipboard.writeText(value),open:url=>enterBrowser(url)});
  target.append(walletHistoryController.element);
  const tipGeneration=researchAccountGeneration;
  walletTipSettingsController=createWalletTipSettings({document,invoke,getScope:()=>articleEditorScope(),
    isCurrent:()=>isCurrent()&&currentView==="wallet"&&tipGeneration===researchAccountGeneration});
  target.append(walletTipSettingsController.element);
  if (currentView === "wallet" && typeof renderSidebarContext === "function") renderSidebarContext("wallet"); // 区画の一覧（列の木）
}

let videoCollection = [];
let videoWatchHistory = [];
let videoWatchIndex = -1;
let videoWatchComments=null,videoWatchRevision=0;
const videoCommentDrafts=new Map();
for(const event of ['hub-account-changed','hub-origin-changed'])window.addEventListener(event,()=>{resetVideoScene();if(currentView==='videos')void searchVideos(true);});
let videoOrder = "recent";
// 内側左列の「ホーム・ショート・フォロー中・履歴」（2026-10-15）。
let videoMode = "home";
let videoSubscriptions = { items: [], loading: false, failed: false };
let videoCategory = "";
let videoFacets = [];
let videoSearchState = null;


let videoSceneScope = null, videoListScroll = 0, videoWatchScrolls = [], videoSceneRevision = 0;
const sameVideoScope = (a,b) => a && b && ['origin','deviceId','viewerId','generation'].every(key => a[key] === b[key]);
const videoMemoryId = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[^A-Za-z0-9_-]/u.test(value);
const videoMemoryPosition = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2147483647;
function videoSnapshotItem(item) {
  const required=['id','title','channel','category','purpose','topic','provider','sourceUrl','publishedAt','createdAt','viewCount'];
  const optional=['relatedHubpediaSlug','thumbnailUrl','duration','submittedByDisplayName','safetyLevel','safetyNotice','availabilityStatus','broadcastStatus','metadataCheckedAt'];
  if(!item || typeof item!=='object' || Array.isArray(item) || ![Object.prototype,null].includes(Object.getPrototypeOf(item)) || Reflect.ownKeys(item).some(key=>typeof key!=='string'||!required.includes(key)&&!optional.includes(key)) || required.some(key=>!Object.hasOwn(Object.getOwnPropertyDescriptor(item,key)??{},'value')) || Object.values(Object.getOwnPropertyDescriptors(item)).some(descriptor=>!Object.hasOwn(descriptor,'value')) || !videoMemoryId(item.id))return false;
  if(!Number.isSafeInteger(item.viewCount)||item.viewCount<0 || Object.entries(item).some(([key,value])=>key!=='viewCount'&&(typeof value!=='string'||value.length>100000||/\p{Surrogate}/u.test(value))))return false;
  if(!['youtube','vimeo','twitch','niconico','tiktok','dailymotion','peertube','hub'].includes(item.provider) || ['publishedAt','createdAt'].some(key=>item[key].length>64||!Number.isFinite(Date.parse(item[key]))))return false;
  if(item.availabilityStatus!==undefined&&!['unknown','available','unavailable'].includes(item.availabilityStatus)||item.broadcastStatus!==undefined&&!['video','live','upcoming','archive'].includes(item.broadcastStatus)||item.safetyLevel!==undefined&&!['standard','sensitive','adult','medical','political'].includes(item.safetyLevel))return false;
  for(const key of ['sourceUrl','thumbnailUrl'])if(item[key]){try{const url=new URL(item[key],'https://hub.invalid');if(!['https:','http:'].includes(url.protocol)||url.username||url.password)return false;}catch{return false;}}
  return true;
}
async function videoStateScope() {
  const generation=researchAccountGeneration, captured=await captureHomeScope(homeAccountSnapshot());
  if(!captured || generation!==researchAccountGeneration)return null;
  let viewerId=null;
  if(captured.state==='registered') {
    const me=await invoke('hub_client',{name:'me'});
    if(!videoMemoryId(me?.profile?.id))return null;
    viewerId=me.profile.id;
  }
  if(generation!==researchAccountGeneration || !await confirmHomeScope(captured) || generation!==researchAccountGeneration)return null;
  return {origin:captured.origin,deviceId:captured.state==='registered'?captured.deviceId:null,viewerId,generation};
}
function rememberVideoScroll() {
  const position=viewScroller()?.scrollTop??0;
  if(!videoMemoryPosition(position))return;
  if(videoWatchIndex>=0)videoWatchScrolls[videoWatchIndex]=position;else videoListScroll=position;
}
function captureVideoScene(entry=toolbarTrail[toolbarTrailIndex]) {
  if(currentView!=='videos'||entry?.view!=='videos'||!videoSceneScope||videoSceneScope.generation!==researchAccountGeneration)return null;
  delete entry.videoScene;
  rememberVideoScroll();
  try {
    const query=document.querySelector('#video-query').value, snapshot=videoSearch.capture(videoSceneScope);
    if(query.length>100||!['recent','popular','live'].includes(videoOrder)||videoCategory.length>100||videoWatchHistory.some(item=>!videoSnapshotItem(item)))return null;
    const value={version:1,scope:{...videoSceneScope},query,category:videoCategory,order:videoOrder,snapshot:query.trim()===snapshot?.snapshot.query?snapshot:null,
      history:videoWatchHistory,index:videoWatchIndex,listScroll:videoListScroll,watchScrolls:videoWatchHistory.map((_,index)=>videoWatchScrolls[index]??0)};
    if(new TextEncoder().encode(JSON.stringify(value)).length>2*1024*1024)return null;
    return entry.videoScene=structuredClone(value);
  } catch { return null; }
}
function resetVideoScene() {
  videoSceneRevision++;videoSceneScope=null;videoSearch.invalidate();videoWatchComments?.destroy();videoWatchComments=null;videoWatchRevision++;videoCommentDrafts.clear();
  videoWatchHistory=[];videoWatchIndex=-1;videoWatchScrolls=[];videoListScroll=0;videoCollection=[];videoFacets=[];videoSearchState=null;videoCategory='';videoOrder='recent';videoMode='home';videoSubscriptions={items:[],loading:false,failed:false};
  resetVideoHome();stopVideoPlayer();destroyShortsFeed();hideVideoChannel();document.querySelector('#video-home')?.replaceChildren();
  document.querySelector('#video-query').value='';document.querySelector('#videos-results').replaceChildren();document.querySelector('#video-watch-main').replaceChildren();document.querySelector('#video-watch-related').replaceChildren();
  document.querySelector('#video-watch').hidden=true;document.querySelector('#video-discover').hidden=false;
  for(const entry of toolbarTrail)delete entry.videoScene;
}
async function restoreVideoScene(entry) {
  const request=++videoSceneRevision, generation=researchAccountGeneration;
  let value;try{value=structuredClone(entry?.videoScene);}catch{return false;}
  if(!value||value.version!==1||Object.keys(value).sort().join(',')!==['version','scope','query','category','order','snapshot','history','index','listScroll','watchScrolls'].sort().join(',')||typeof value.query!=='string'||value.query.length>100||typeof value.category!=='string'||value.category.length>100||!['recent','popular','live'].includes(value.order)||!Array.isArray(value.history)||value.history.some(item=>!videoSnapshotItem(item))||!Number.isSafeInteger(value.index)||value.index< -1||value.index>=value.history.length||!videoMemoryPosition(value.listScroll)||!Array.isArray(value.watchScrolls)||value.watchScrolls.length!==value.history.length||value.watchScrolls.some(position=>!videoMemoryPosition(position))||new TextEncoder().encode(JSON.stringify(value)).length>2*1024*1024)return false;
  let fresh;try{fresh=await videoStateScope();}catch{fresh=null;}
  if(request!==videoSceneRevision||generation!==researchAccountGeneration||toolbarTrail[toolbarTrailIndex]!==entry)return null;
  if(!fresh)return false;
  if(!sameVideoScope(value.scope,fresh)){resetVideoScene();return false;}
  if(!value.snapshot){document.querySelector('#video-query').value=value.query;videoCategory=value.category;videoOrder=value.order;return false;}
  if(value.snapshot.snapshot?.query!==value.query.trim()||value.snapshot.snapshot?.filters.category!==value.category||value.snapshot.snapshot?.filters.order!==value.order)return false;
  // Validate the complete search packet before restoring any visible field.
  if(!videoSearch.restore(value.snapshot,fresh))return false;
  videoSceneScope=fresh;videoCategory=value.category;videoOrder=value.order;videoWatchHistory=value.history;videoWatchIndex=value.index;videoListScroll=value.listScroll;videoWatchScrolls=value.watchScrolls;
  document.querySelector('#video-query').value=value.query;
  renderVideoCatalog(document.querySelector('#videos-results'),videoSearch.snapshot());
  return true;
}
function paintRestoredVideoScene() {
  if(videoWatchIndex>=0)openVideoWatch(videoWatchHistory[videoWatchIndex],true);else showVideoList();
}

function videoCategoryName(video) {
  return typeof video.category === "string" && video.category.trim() ? video.category.trim() : "未分類";
}

function videoCategoryCounts() {
  const counts = videoFacets.map(({ name, count }) => [name, count]);
  if (videoCategory && !counts.some(([name]) => name === videoCategory)) counts.push([videoCategory, 0]);
  return counts;
}
function videoCategoryTotal() { return videoFacets.reduce((total, facet) => total + facet.count, 0); }
function selectVideoCategory(category) {
  videoCategory = category;
  void searchVideos(true);
}


function videoThumbnail(video) {
  return createVideoThumbnail(document, video, { hubAsset });
}

function videoCard(video, compact = false) {
  return createVideoCard(document, video, { hubAsset, relTime, onOpen: openVideoWatch, compact });
}

// 動画ホーム（ヒーロー＋行）。検索語・カテゴリ・表示順の指定が無いときだけ出す。
// 接続した他Hubの動画（YouTube参照）。60秒以内は再取得しない。失敗しても自分のHubの行は出す。
let peerVideos = [], peerVideoAt = 0;
function refreshPeerVideos() {
  if (Date.now() - peerVideoAt < 60_000) return;
  peerVideoAt = Date.now();
  void (async () => {
    try { await hubNetwork.ready; peerVideos = peerVideoEntries(await hubNetwork.load("video"), { ownOrigin: hubOrigin ?? "" }); }
    catch { peerVideos = []; }
    if (currentView === "videos" && videoSearchState) renderVideoHomeRows(videoSearchState, false);
  })();
}
function renderVideoHomeRows(state, refresh = true) {
  const host = document.querySelector("#video-home");
  if (!host) return;
  if (videoMode !== "home" || state.query || videoCategory || videoOrder !== "recent" || state.error) { host.replaceChildren(); host.hidden = true; return; }
  const onOpen = video => openVideoWatch(video);
  if (refresh) refreshPeerVideos();
  renderVideoHome(host, { items: state.items, peerVideos, taken: state.items.filter(isShortVideo).slice(0, 12), deps: { document, hubAsset, relTime, onOpen },
    onOpenSaved: async item => {
      const known = videoCollection.find(video => video.id === item.id);
      if (known) { openVideoWatch(known); return; }
      try { const data = await invoke("hub_detail", { name: "video", ids: [item.id] }); if (data?.video) openVideoWatch(data.video); }
      catch (error) { showNotice(friendlyError(error)); }
    } });
  appendVideoShortsShelf(host, state.items);
  if (desktopAccount.state === "registered") void loadSavedVideos(invoke, { isCurrent: () => currentView === "videos", changed: () => renderVideoHomeRows(videoSearchState ?? state) });
}

// ホームの「ショート」の棚：60秒以下の動画を縦長（9:16）の札で並べる。無ければ出さない。
function appendVideoShortsShelf(host, items) {
  const shorts = ownFirst(items.filter(isShortVideo)).slice(0, 12);
  if (!shorts.length) return;
  const shelf = document.createElement("section");
  shelf.className = "video-shorts-shelf";
  const title = document.createElement("h3");
  title.className = "video-shorts-title";
  title.append(sidebarIcon(document, "shorts"), document.createTextNode("ショート"));
  const more = document.createElement("button");
  more.type = "button";
  more.className = "video-shorts-more";
  more.textContent = "すべて見る";
  more.onclick = () => setVideoMode("shorts");
  const head = document.createElement("div");
  head.className = "video-shorts-head";
  head.append(title, more);
  const row = document.createElement("div");
  row.className = "video-shorts-row";
  for (const video of shorts) row.append(videoShortCard(video));
  shelf.append(head, row);
  host.hidden = false;
  host.prepend(shelf);
}
function videoShortCard(video) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "video-short-card";
  const frame = document.createElement("span");
  frame.className = "video-short-frame";
  const thumb = videoThumbnail(video);
  thumb.style.setProperty("--ratio", "9 / 16");
  frame.append(thumb);
  const name = document.createElement("span");
  name.className = "video-short-name";
  name.textContent = video.title || "動画";
  card.title = video.title || "動画";
  card.append(frame, name);
  card.onclick = () => openVideoWatch(video);
  return card;
}

// 動画の見せ方：ホーム（一覧）・ショート（60秒以下）・フォロー中（追っているチャンネルの新着）・履歴（この起動中に見たもの）。
function setVideoMode(mode, render = true) {
  if (currentView !== "videos") document.querySelector('.icon-rail [data-view="videos"]')?.click();
  videoMode = mode;
  if (videoWatchIndex >= 0) showVideoList();
  if (mode === "subscriptions") loadVideoSubscriptions();
  if (!render) return;
  if (videoSearchState) renderVideoCatalog(document.querySelector("#videos-results"), videoSearchState);
  else if (currentView === "videos") renderSidebarContext("videos");
}
function loadVideoSubscriptions() {
  if (desktopAccount.state !== "registered" || videoSubscriptions.loading) return;
  const epoch = homeAccountEpoch;
  videoSubscriptions.loading = true;
  void Promise.resolve(invoke("hub_detail", { name: "subscriptions", ids: ["videos"] })).then((data) => {
    if (epoch !== homeAccountEpoch) return;
    videoSubscriptions.items = Array.isArray(data?.videos) ? data.videos.filter((video) => video && typeof video.id === "string") : [];
    videoSubscriptions.failed = false;
  }).catch(() => { if (epoch === homeAccountEpoch) { videoSubscriptions.items = []; videoSubscriptions.failed = true; } }).finally(() => {
    if (epoch !== homeAccountEpoch) return;
    videoSubscriptions.loading = false;
    if (currentView === "videos" && videoMode === "subscriptions" && videoSearchState) renderVideoCatalog(document.querySelector("#videos-results"), videoSearchState);
  });
}
// ショートの縦フィード。同じ並びで描き直されたときは作り直さない（再生を途切れさせない）。
let shortsFeed = null;
function destroyShortsFeed() { shortsFeed?.controller.destroy(); shortsFeed = null; }
function renderShortsFeed(target, items) {
  const ids = items.map(video => video.id).join("\n");
  if (shortsFeed && shortsFeed.ids === ids && shortsFeed.controller.element.parentNode === target) return;
  destroyShortsFeed();
  if (!items.length) { target.replaceChildren(); return; }
  const controller = createShortsFeed({ document, items, dock: ytDock, owner: playbackOwner, hubAsset, signedIn: desktopAccount.state === "registered", invoke,
    onOpenChannel: openVideoChannel, onOpenVideo: openVideoWatch });
  shortsFeed = { ids, controller };
  target.replaceChildren(controller.element);
}
function videoModeItems() {
  if (videoMode === "shorts") return ownFirst(videoCollection.filter(isShortVideo));
  if (videoMode === "subscriptions") return videoSubscriptions.items;
  if (videoMode === "history") {
    const seen = new Set();
    return [...videoWatchHistory].reverse().filter((video) => video?.id && !seen.has(video.id) && seen.add(video.id));
  }
  return ownFirst(videoCollection);
}

// 本文の上のチップ：すべて・カテゴリ（件数）・フォロー中のタグ。選ぶとこの画面を絞り込む。
function renderVideoChips() {
  const bar = viewChipHost("videos");
  if (!bar) return;
  const query = document.querySelector("#video-query")?.value.trim() ?? "";
  const tags = sidebarRemote.tags();
  if (desktopAccount.state === "registered") void sidebarRemote.load("videos");
  const chips = [
    { key: "", label: "すべて", kind: "all", selected: !videoCategory && !tags.includes(query) },
    ...videoCategoryCounts().map(([name]) => ({ key: name, label: name, kind: "category", selected: videoCategory === name })),
    ...tags.map((tag) => ({ key: tag, label: tag, kind: "tag", selected: query === tag && !videoCategory })),
  ];
  renderChipRow(document, bar, { label: "動画のカテゴリとタグ", chips, onSelect: (chip) => {
    if (videoMode === "subscriptions" || videoMode === "history") videoMode = "home";
    const input = document.querySelector("#video-query");
    if (chip.kind === "tag") { videoCategory = ""; input.value = chip.key; void searchVideos(true); return; }
    if (chip.kind === "all" && tags.includes(input.value.trim())) input.value = "";
    selectVideoCategory(chip.key);
  } });
}

function renderVideoCatalog(target, state) {
  videoSearchState = state;
  videoCollection = state.items;
  if (!state.loading && !state.error) videoFacets = state.categories;
  renderVideoChips();
  const titles = { shorts: "ショート", subscriptions: "フォロー中", history: "履歴（この起動中に見た動画）" };
  document.querySelector("#video-catalog-title").textContent = titles[videoMode] || videoCategory || (state.query ? "検索結果" : "すべての動画");
  const filters = document.querySelector("#video-filters");
  filters.hidden = videoMode === "subscriptions" || videoMode === "history";
  filters.replaceChildren(...[["recent", "新着"], ["popular", "視聴数順"], ["live", "ライブ"]].map(([key, label]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `video-filter${videoOrder === key ? " on" : ""}`;
    button.textContent = label;
    button.setAttribute("aria-pressed", String(videoOrder === key));
    button.onclick = () => { videoOrder = key; void searchVideos(true); };
    return button;
  }));
  const items = videoModeItems();
  const waiting = videoMode === "subscriptions" ? videoSubscriptions.loading : state.loading;
  target.classList.toggle("vid-shorts-mode", videoMode === "shorts");
  if (videoMode !== "shorts") destroyShortsFeed();
  if (!items.length && waiting) { destroyShortsFeed(); target.replaceChildren(...createVideoSkeletons(document, 6)); }
  else if (videoMode === "shorts") renderShortsFeed(target, items);
  else target.replaceChildren(...items.map(video => videoCard(video)));
  renderVideoHomeRows(state);
  if (!items.length && !waiting && state.error) {
    target.replaceChildren(pageErrorState("読み込めませんでした", friendlyError(state.error), () => void videoSearch.retry()));
  } else if (!items.length && !waiting) {
    const failed = videoMode === "subscriptions" && videoSubscriptions.failed;
    target.append(createVideoEmpty(document, emptyFor({ mode: videoMode, failed, filtered: Boolean(state.query || videoCategory || videoOrder === "live") })));
  }
  renderMediaSearchState("video", state, target, document.querySelector("#videos-state"));
  if (currentView === "videos") renderSidebarContext("videos");
}

function renderMediaSearchState(kind, state, target, status) {
  target.setAttribute("aria-busy", String(state.loading));
  status.classList.toggle("warning", Boolean(state.error));
  status.title = state.error ? friendlyError(state.error) : "";
  status.textContent = state.error ? (target.querySelector(":scope > .state-panel") ? "" : "読み込めませんでした") : state.loading ? "検索しています…" : `${state.total} 件中 ${state.items.length} 件を表示`;
  if (state.error && !target.querySelector(":scope > :is(.state-panel, .vt-empty)")) {
    target.append(stateRetryButton(() => void (kind === "video" ? videoSearch : musicSearch).retry()));
  }
  const more = document.querySelector(`#${kind}-more`);
  more.hidden = !state.hasMore || Boolean(state.error);
  more.disabled = state.loading;
  more.textContent = state.loading ? "読み込み中…" : "続きを表示";
}

const videoSearch = createMediaSearch({
  validateItem: videoSnapshotItem,
  fetchPage: async ({ query, offset, category, order }) => {
    const data = await invoke("hub_resource", { resource: "videos", query, offset, category, order });
    return { ...data, items: data.videos };
  },
  changed: state => renderVideoCatalog(document.querySelector("#videos-results"), state),
});
async function searchVideos(immediate = false) {
  const request=++videoSceneRevision,generation=researchAccountGeneration;
  const query=document.querySelector('#video-query').value,category=videoCategory,order=videoOrder;
  videoSceneScope=null;videoSearch.invalidate();showVideoList();videoWatchHistory=[];videoWatchScrolls=[];videoWatchIndex=-1;videoListScroll=0;if(viewScroller())viewScroller().scrollTop=0;
  let scope;try{scope=await videoStateScope();}catch{scope=null;}
  if(request!==videoSceneRevision||generation!==researchAccountGeneration||currentView!=='videos')return;
  videoSceneScope=scope;
  return videoSearch.search(query,{category,order},immediate,scope);
}
function bindMediaSearch(kind, search, controller) {
  const input = document.querySelector(`#${kind}-query`);
  bindSearchInput(input, {form: document.querySelector(`#${kind}-search`), search: () => {
    // 検索語を入れたら、フォロー中・履歴の表示から一覧へ戻す。
    if (kind === "video" && (videoMode === "subscriptions" || videoMode === "history")) videoMode = "home";
    return search(true);
  }, invalidate: () => {
    controller.invalidate();
    const target = document.querySelector(kind === "video" ? "#videos-results" : "#music-tracks");
    target.replaceChildren();
    document.querySelector(kind === "video" ? "#videos-state" : "#music-tracks-state").textContent = "検索語を入力中…";
    document.querySelector(`#${kind}-more`).hidden = true;
  }});
  document.querySelector(`#${kind}-more`).onclick = () => void controller.more();
}

bindMediaSearch("video", searchVideos, videoSearch);

function showVideoList() {
  hideVideoChannel();
  hideVideoStudio();
  rememberVideoScroll();
  videoWatchComments?.destroy();videoWatchComments=null;videoWatchRevision++;
  videoWatchIndex = -1;
  stopVideoPlayer();
  document.querySelector("#video-watch").hidden = true;
  document.querySelector("#video-discover").hidden = false;
  if (videoSearchState) renderVideoHomeRows(videoSearchState);
  if(viewScroller())viewScroller().scrollTop=videoListScroll;
  if (currentView === "videos") renderSidebarContext("videos");
  updateToolbarNavigation();
}

function openVideoWatch(video, replay = false) {
  hideVideoChannel();
  disposeExternalMediaRegistration();
  videoWatchComments?.destroy();videoWatchComments=null;const revision=++videoWatchRevision;
  if (!replay) {
    rememberVideoScroll();
    videoWatchScrolls=videoWatchScrolls.slice(0,videoWatchIndex+1);
    videoWatchHistory = videoWatchHistory.slice(0, videoWatchIndex + 1);
    videoWatchHistory.push(video);
    videoWatchIndex++;
  }
  const main = document.querySelector("#video-watch-main");
  const related = document.querySelector("#video-watch-related");
  // YouTube はアプリ内で再生する。他の提供元はサムネイルと「提供元で開く」。
  const stage = createWatchStage(document, video, { hubAsset, onOpenExternal: url => void enterBrowser(url), dock: ytDock, nativePlay: (id) => invoke('native_video_play', { id }),
    onReopen: () => { void navigateFrom({ dataset: { view: "videos", title: "動画" }, childNodes: [] }).then(() => openVideoWatch(video)); } });
  const head = createWatchHeader(document, video, { relTime });
  const note = document.createElement("p");
  note.className = "meta";
  note.textContent = video.availabilityStatus === "unavailable" ? "この動画は提供元で視聴できません。" : "再生すると提供元のページをHubブラウザで開きます。";
  note.hidden = Boolean(stage.element.querySelector(".yt-player, .vh-native-player"));
  if (!replay) rememberWatched(video);
  main.replaceChildren(stage.element, head.title, head.bar, head.desc, note);
  document.querySelector("#video-discover").hidden = true;
  document.querySelector("#video-watch").hidden = false;
  // 他Hubの動画は元のHubのもの。保存・共有・コメント等は付けず、再生だけを共有の dock で行う。
  if (typeof video.peerHost === "string" && String(video.id).startsWith("peer:")) {
    const origin = document.createElement("p");
    origin.className = "meta";
    origin.textContent = `${video.peerHost} が公開している動画（YouTube）`;
    note.hidden = true;
    main.append(origin);
    related.replaceChildren(...createRelatedList(document, video, videoCollection, { hubAsset, relTime, onOpen: item => openVideoWatch(item) }));
    if(viewScroller())viewScroller().scrollTop=videoWatchScrolls[videoWatchIndex]??0;
    document.querySelector("#video-watch-back").focus();
    if (currentView === "videos") renderSidebarContext("videos");
    updateToolbarNavigation();
    return;
  }
  const generation=researchAccountGeneration,selectedId=video.id;
  appendPlaylistEntry(head.actions,'video',{id:selectedId,title:video.title??'動画'});
  attachVideoEngagement(head,video,()=>revision===videoWatchRevision&&generation===researchAccountGeneration&&currentView==='videos'&&videoWatchHistory[videoWatchIndex]?.id===selectedId&&!document.querySelector('#video-watch').hidden);
  attachContentSave({document,host:head.actions,kind:'video',id:selectedId,invoke,isCurrent:()=>generation===researchAccountGeneration&&currentView==='videos'&&videoWatchHistory[videoWatchIndex]?.id===selectedId});
  attachContentShare({document,host:head.actions,kind:'video',id:selectedId,title:video.title??'動画',
    isCurrent:()=>revision===videoWatchRevision&&generation===researchAccountGeneration&&currentView==='videos'&&videoWatchHistory[videoWatchIndex]?.id===selectedId&&!document.querySelector('#video-watch').hidden,
    onShare:offerPublicContentShare});
  if(typeof selectedId==='string'&&/^[A-Za-z0-9_-]{1,128}$/u.test(selectedId)){
    const epoch=homeAccountEpoch;
    attachAiHandoff({document,host:head.actions,kind:'video',href:`/v2/videos/${selectedId}`,title:String(video.title??'動画').slice(0,200),
      getText:()=>[video.channel,video.description].filter(value=>typeof value==='string'&&value).join('\n\n'),getContext:aiHandoffContext,
      isCurrent:()=>epoch===homeAccountEpoch&&revision===videoWatchRevision&&generation===researchAccountGeneration&&currentView==='videos'&&videoWatchHistory[videoWatchIndex]?.id===selectedId&&!document.querySelector('#video-watch').hidden,
      onAsk:askAiAboutPublicContent});
  }
  if(typeof selectedId==='string'&&selectedId.length<=128&&selectedId.length>0&&!/[^A-Za-z0-9_-]/u.test(selectedId)){
    if(!videoCommentDrafts.has(selectedId))videoCommentDrafts.set(selectedId,{});
    videoWatchComments=mountVideoPosts({videoId:selectedId,invoke,renderPost:post=>postCard(post),state:videoCommentDrafts.get(selectedId),
      isCurrent:()=>revision===videoWatchRevision&&generation===researchAccountGeneration&&currentView==='videos'&&videoWatchHistory[videoWatchIndex]?.id===selectedId&&!document.querySelector('#video-watch').hidden,
    });
    main.append(videoWatchComments.element);
  }
  const selectedVideo=video.id;void appendResearchBacklinks(main,'video',video.id,()=>currentView==='videos'&&videoWatchHistory[videoWatchIndex]?.id===selectedVideo);
  if (video.safetyNotice) {
    const warning = document.createElement("p");
    warning.className = "warning";
    warning.textContent = video.safetyNotice;
    main.append(warning);
  }
  related.replaceChildren(...createRelatedList(document, video, videoCollection, { hubAsset, relTime, onOpen: item => openVideoWatch(item) }));
  if(viewScroller())viewScroller().scrollTop=videoWatchScrolls[videoWatchIndex]??0;
  document.querySelector("#video-watch-back").focus();
  if (currentView === "videos") renderSidebarContext("videos");
  updateToolbarNavigation();
}

// 視聴画面のいいね・チャンネル。いいねは Hub が持つ。チャンネルとフォローは Hub の動画だけ。
function attachVideoEngagement(head, video, isCurrent) {
  const id = video.id, signedIn = desktopAccount.state === "registered";
  void loadEngagement(invoke, id).then((state) => {
    if (!state || !isCurrent()) return;
    head.actions.prepend(createLikeButton(document, { state, signedIn, onSet: (liked) => setVideoLike(invoke, id, liked) }));
  });
  if (video.provider !== "hub" || !isChannelHandle(video.channelHandle)) return;
  const handle = video.channelHandle;
  const name = head.bar.querySelector(".vh-watch-channel strong");
  if (name) {
    const link = document.createElement("button");
    link.type = "button";
    link.className = "vid-watch-channel-link link";
    link.textContent = name.textContent;
    link.title = "チャンネルを開く";
    link.onclick = () => openVideoChannel(handle);
    name.replaceWith(link);
  }
  void Promise.resolve(invoke("hub_detail", { name: "video_channel", ids: [handle] })).then((data) => {
    const channel = parseChannelPage(data).channel;
    if (!channel || !isCurrent()) return;
    const follow = createFollowButton(document, { following: channel.viewerFollows, signedIn, isViewer: channel.isViewer, onSet: (next) => setChannelFollow(channel.profileId, next) });
    if (follow) head.bar.querySelector(".vh-watch-channel")?.append(follow);
  }).catch(() => {});
}
async function setChannelFollow(profileId, next) {
  try { await invoke("hub_client_action", { action: next ? "follow" : "unfollow", target: profileId }); }
  catch (error) { throw new Error(friendlyError(error)); }
  return next;
}

// チャンネルページ。視聴画面・一覧とは別の面で、戻ると元の面へ帰る。
let videoChannel = null;
function hideVideoChannel() {
  videoChannel?.state.dispose();
  videoChannel = null;
  const section = document.querySelector("#video-channel");
  if (!section) return;
  section.hidden = true;
  document.querySelector("#video-channel-body")?.replaceChildren();
}
function openVideoChannel(handle) {
  if (!isChannelHandle(handle)) return;
  const section = document.querySelector("#video-channel"), body = document.querySelector("#video-channel-body");
  if (!section || !body) return;
  const from = !document.querySelector("#video-watch").hidden ? "watch" : "list";
  videoChannel?.state.dispose();
  const signedIn = desktopAccount.state === "registered";
  const paint = (snapshot) => body.replaceChildren(renderChannelPage(document, snapshot, { hubAsset, relTime, signedIn,
    onOpenVideo: (item) => void Promise.resolve(invoke("hub_detail", { name: "video", ids: [item.id] })).then((data) => { if (data?.video) openVideoWatch(data.video); else showNotice("動画を開けませんでした。"); }).catch((error) => showNotice(friendlyError(error))),
    onLocked: () => showNotice("この動画はゲート付きです。条件を満たすとWebで視聴できます。"),
    onFollow: async (next) => { const done = await setChannelFollow(snapshot.channel.profileId, next); state.setFollowing(done); return done; },
    onMore: () => void state.more(), onRetry: () => void state.load() }));
  const state = createChannelState({ invoke, handle, changed: (snapshot) => { if (videoChannel?.state === state) paint(snapshot); } });
  videoChannel = { state, from };
  document.querySelector("#video-watch").hidden = true;
  document.querySelector("#video-discover").hidden = true;
  section.hidden = false;
  if (viewScroller()) viewScroller().scrollTop = 0;
  void state.load();
  document.querySelector("#video-channel-back").focus();
}
function closeVideoChannel() {
  const from = videoChannel?.from ?? "list";
  hideVideoChannel();
  if (from === "watch" && videoWatchIndex >= 0) { document.querySelector("#video-watch").hidden = false; ytDock.layout(); }
  else document.querySelector("#video-discover").hidden = false;
  updateToolbarNavigation();
}
document.querySelector("#video-channel-back").onclick = closeVideoChannel;
document.querySelector("#video-studio-back").onclick = () => showVideoList();

document.querySelector("#video-watch-back").onclick = showVideoList;
// どの経路で視聴画面を閉じても（戻る・履歴移動・検索のやり直し）、再生を止めて一覧の「続きを見る」を更新する。
new MutationObserver(() => {
  if (!document.querySelector("#video-watch").hidden) return;
  stopVideoPlayer();
  if (videoSearchState) renderVideoHomeRows(videoSearchState);
}).observe(document.querySelector("#video-watch"), { attributes: true, attributeFilter: ["hidden"] });

const externalMediaDrafts={video:{},music:{}};
let externalMediaRegistrationController=null;
function disposeExternalMediaRegistration(){
  externalMediaRegistrationController?.destroy();externalMediaRegistrationController=null;
  for(const id of ['video-add-external','music-add-external'])document.getElementById(id)?.setAttribute('aria-expanded','false');
}
function mountExternalMediaRegistration(kind){
  const view=kind==='video'?'videos':'music',generation=researchAccountGeneration;
  if(currentView!==view)return;
  const already=externalMediaRegistrationController?.kind===kind;
  disposeExternalMediaRegistration();if(already)return;
  let controller;
  const current=()=>generation===researchAccountGeneration&&currentView===view&&externalMediaRegistrationController===controller&&
    (kind!=='video'||!document.querySelector('#video-discover').hidden);
  const communityPicker=createCommunityPicker({document,invoke,isCurrent:()=>current()});
  communityPicker.root.addEventListener('change',event=>event.stopPropagation());
  controller=createExternalMediaRegistration({document,kind,invoke,
    getAccount:()=>desktopAccount.state==='registered'?String(researchAccountGeneration):null,isCurrent:current,state:externalMediaDrafts[kind],
    onRegistered:async record=>{
      const community=communityPicker.value();
      if(community&&typeof record?.id==='string'){const linked=await linkToCommunity(invoke,community,kind,record.id);communityPicker.reset();if(!linked.ok)showNotice('登録しました。コミュニティには載せられませんでした。');}
      if(current())void loadCatalog(view);
    },
    onCheck:async()=>{
      const data=await invoke('hub_resource',{resource:view,query:'',boardKey:null});
      if(!current()||!validateExternalMediaCatalog(kind,data))return false;
      controller.element.querySelector('[data-media-catalog-snapshot]')?.remove();
      const snapshot=document.createElement('details');snapshot.className='detail-form';snapshot.dataset.mediaCatalogSnapshot='';
      const summary=document.createElement('summary');summary.textContent='再取得した公開一覧（この取得範囲のみ）';snapshot.append(summary);
      for(const item of data[kind==='video'?'videos':'works']){const line=document.createElement('p');line.className='meta';line.style.overflowWrap='anywhere';line.textContent=item.title+' · '+(kind==='video'?item.channel:item.artist);snapshot.append(line);}
      controller.element.append(snapshot);return true;
    }});
  controller.kind=kind;externalMediaRegistrationController=controller;controller.element.append(communityPicker.root);
  const head=document.querySelector(kind==='video'?'#video-discover .view-head':'#view-music .view-head');head.after(controller.element);
  document.getElementById(kind==='video'?'video-add-external':'music-add-external').setAttribute('aria-expanded','true');
}
function initExternalMediaRegistrationEntries(){
  for(const[kind,selector,id]of [['video','#video-discover .view-head-actions','video-add-external'],['music','#view-music .view-head-actions','music-add-external']]){
    const host=document.querySelector(selector);if(!host||document.getElementById(id))continue;
    const button=document.createElement('button');button.id=id;button.type='button';button.className='btn btn-primary';button.textContent='追加';
    button.setAttribute('aria-label',kind==='video'?'外部動画を追加':'外部音楽作品を追加');button.setAttribute('aria-expanded','false');
    button.onclick=()=>mountExternalMediaRegistration(kind);host.append(button);
  }
}
initExternalMediaRegistrationEntries();
window.addEventListener('hub-account-changed',()=>{disposeExternalMediaRegistration();for(const draft of Object.values(externalMediaDrafts))for(const key of Object.keys(draft))delete draft[key];});

let threadBoardKey = "";
let threadBoardTitle = "";

let networkViewsReady=false;
const hubNetwork = createHubNetwork({document, invoke, storage:localStorage,
  getAccount:()=>desktopAccountLoaded ? desktopAccount : null,
  changed:kind=>{if(!networkViewsReady||startupTool)return;if(kind==='post')void loadFeed();if(kind==='research')void researchWorkspace.load();if(kind==='music')void musicHome?.refresh();if(kind==='video'){peerVideoAt=0;if(videoSearchState)renderVideoHomeRows(videoSearchState);}},
  manage:()=>{showView('node');void loadNode();},
  onShare:offerPublicContentShare,
  isCurrent:kind=>currentView===({post:'feed',research:'research'})[kind],
  openResearchFork:item=>void openDetail('research_network_fork',[item.origin,item.id],{title:`${item.title}をfork`,local:true}),
  openWeb:url=>void invoke('open_external',{url}).catch(error=>showNotice(friendlyError(error))),
});
const hubPeers = initHubPeers({document,invoke,getScope:()=>articleEditorScope(),isCurrent:()=>currentView==='node'});
const nativeGitHub = initNativeGitHub({
  document, host:document.querySelector('#research-github-panel'),
  readRepository:query=>invoke('hub_resource',{resource:'github_repository',query}),
  getContext:async()=>{
    const epoch=homeAccountEpoch,account=desktopAccount,key=JSON.stringify([desktopAccount.state,desktopAccount.deviceId??null,desktopAccount.keyThumbprint??null]);
    const origin=homeCanonicalOrigin(await invoke('hub_origin'));
    if(epoch!==homeAccountEpoch||account!==desktopAccount||key!==JSON.stringify([desktopAccount.state,desktopAccount.deviceId??null,desktopAccount.keyThumbprint??null]))return null;
    return {origin,key,epoch};
  },
  isCurrent:scope=>currentView==='research'&&(!scope||scope.epoch===homeAccountEpoch&&scope.key===JSON.stringify([desktopAccount.state,desktopAccount.deviceId??null,desktopAccount.keyThumbprint??null])),onShare:offerPublicContentShare,
  openReference:(url,event,isCurrent)=>openSharedContentReference(url,isCurrent,event),copyReference:href=>navigator.clipboard.writeText(href),
});
const researchWorkspace = initResearch({
  network:hubNetwork,
  openGitHub:()=>nativeGitHub.open(),
  document, invoke, friendlyError: (error) => friendlyError(error),
  openProject: (project) => void openDetail("research_project", [project.id], { title: project.title }),
  changed: () => { if (currentView === "research" || (currentView === "detail" && DETAIL_SIDEBAR_FAMILY[detailTrail.at(-1)?.name] === "research")) renderSidebarContext(currentView); },
  openWeb: async (path) => {
    try { await invoke("open_external", { url: `${await invoke("hub_origin")}${path}` }); }
    catch (error) { showNotice(friendlyError(error)); }
  },
});
const SERVICE_STATUS = { approved: "承認済み", pending: "審査中", submitted: "審査中", draft: "下書き", rejected: "却下", suspended: "停止中" };
const RANKING_VERIFY = { verified: "確認済み", failed: "確認に失敗", pending: "確認待ち", unverified: "未確認" };
// スレッド一覧の札：フィードの投稿と同じ札（頭字の顔・題・板・返信数・最終の動き）。
// 2026-11-06 所有者「読みにくい」：丸い頭字・「板 cat03-board02」・件数の行をやめ、題を1行目、板の名前・返信数・時刻を2行目に置く（区切り線の行）。
let threadBoardNames = null;
async function ensureThreadBoardNames() {
  if (threadBoardNames) return;
  const names = new Map();
  try {
    const data = await invoke("hub_client", { name: "boards" });
    const groups = data?.groups?.length ? data.groups : [{ boards: data?.boards ?? [] }];
    for (const group of groups) for (const board of group.boards ?? []) if (board?.key && board.title) names.set(board.key, board.title);
  } catch { /* 板の名前が取れなければ短い言葉で代える */ }
  if (names.size) threadBoardNames = names; // 取れなかったときは次の読み込みでやり直す
  else threadBoardNames = new Map();
  if (!names.size) setTimeout(() => { threadBoardNames = null; }, 30000);
}
function threadBoardLabel(key) {
  if (!key) return "";
  return threadBoardNames?.get(key) || (key === threadBoardKey && threadBoardTitle) || "掲示板";
}
function threadListCard(t) {
  const row = document.createElement("article");
  row.className = "thread-row";
  row.tabIndex = 0;
  row.setAttribute("role", "link");
  const title = document.createElement("div");
  title.className = "thread-row-title";
  title.textContent = t.title || "スレッド";
  const meta = threadRowMeta(document, t, { relTime, icon });
  row.append(title, meta);
  const open = () => void openDetail("thread", [t.id], { title: t.title });
  row.addEventListener("click", open);
  row.addEventListener("keydown", (event) => { if (event.target === row && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); open(); } });
  return row;
}
// 左の列の並び（サーバーの順位。未接続のときは端末で並べ替え）。空は並べ替えなし。
const THREAD_SORTS = [["recommended", "おすすめ"], ["mine", "参加中・追跡中"], ["popular", "人気"]];
let threadSort = "";
async function fetchThreadRanking(sort) {
  if (desktopAccount.state === "registered") {
    const data = await invoke("hub_client", { name: `thread_rankings_${sort}` });
    return Array.isArray(data?.threads) ? data.threads.filter((item) => item?.id) : [];
  }
  const data = await invoke("hub_resource", { resource: "threads", query: "", offset: 0, boardKey: threadBoardKey || null });
  return rankThreads(data?.threads, sort, {});
}
// 2026-11-07 所有者「コミュニティも同じに」：区切り線の行。左に集まりの顔（画像、無ければその集まりの頭字）、1行目に名前、2行目に分類・人数・最後の動き。非公開には鍵。
const COMMUNITY_SORTS = [["recommended", "おすすめ"], ["popular", "人気"], ["joined", "参加中"]];
let communitySort = "";
let communitySortChosen = false;
async function fetchCommunityRanking(sort) {
  if (desktopAccount.state === "registered") {
    const data = await invoke("hub_client", { name: `community_rankings_${sort}` });
    return (Array.isArray(data?.groups) ? data.groups : []).filter((item) => item?.id)
      .map((item) => ({ ...item, viewerJoined: item.joined === true, lastMessageAt: item.lastMessageAt ?? item.updatedAt }));
  }
  const data = await invoke("hub_resource", { resource: "communities", query: "" });
  const models = groupModels({ communities: data?.communities, memberships: data?.memberships });
  return rankGroups(models, sort, {}).map((item) => ({ ...item.raw, viewerJoined: item.joined }));
}
function communityListCard(c) {
  // 2026-11-09 帯をやめた：左に顔、右に名前1行・説明1行・人数と最後の動き。カード全体が押せる。
  const card = document.createElement("article");
  card.className = "community-card";
  card.tabIndex = 0;
  card.setAttribute("role", "link");
  const name = c.name || "コミュニティ";
  const iconBox = document.createElement("span");
  iconBox.className = "community-card-icon";
  iconBox.setAttribute("aria-hidden", "true");
  if (c.imageUrl) {
    const img = document.createElement("img");
    hubAsset(img, c.imageUrl);
    img.alt = "";
    img.loading = "lazy";
    iconBox.classList.add("has-image");
    iconBox.append(img);
  } else {
    iconBox.textContent = (name.match(/[\p{L}\p{N}]/u)?.[0] ?? name.trim().slice(0, 1)).toUpperCase();
    iconBox.dataset.tint = String(avatarTint(name));
  }
  const body = document.createElement("div");
  body.className = "community-card-body";
  const title = document.createElement("div");
  title.className = "community-card-title";
  const titleText = document.createElement("span");
  titleText.className = "community-card-name";
  titleText.textContent = name;
  title.append(titleText);
  if (c.visibility === "private") {
    const lock = document.createElement("span");
    lock.className = "community-card-lock";
    lock.setAttribute("role", "img");
    lock.setAttribute("aria-label", "非公開");
    lock.title = "非公開";
    lock.innerHTML = icon("lock");
    title.append(lock);
  }
  const desc = document.createElement("p");
  desc.className = "community-card-desc";
  desc.textContent = typeof c.description === "string" ? c.description.trim() : "";
  const foot = document.createElement("div");
  foot.className = "community-card-foot";
  const when = relTime(c.lastMessageAt ?? c.lastActivityAt ?? c.updatedAt);
  const stats = document.createElement("span");
  stats.className = "community-card-meta";
  if (Number.isSafeInteger(c.memberCount)) stats.innerHTML = `${icon("user")}<span>${c.memberCount.toLocaleString("ja-JP")}</span>`;
  if (when) { const t = document.createElement("span"); t.textContent = when; stats.append(t); }
  { const at = c.lastMessageAt ?? c.lastActivityAt ?? c.updatedAt; if (when && at) stats.title = new Date(at).toLocaleString("ja-JP"); }
  foot.append(stats);
  if (c.viewerJoined) {
    const joined = document.createElement("span");
    joined.className = "community-card-badge";
    joined.textContent = "参加中";
    foot.append(joined);
  }
  body.append(title, desc, foot);
  card.append(iconBox, body);
  if (!c.viewerJoined && c.id) {
    // 開いてから「参加する」を探さなくてよいように、カードから参加の欄まで1手で行く（2026-11-11）。
    const join = document.createElement("button");
    join.type = "button";
    join.className = "community-card-join";
    join.textContent = c.visibility === "public" ? "参加する" : "参加を申請";
    join.setAttribute("data-keep-text", "");
    join.addEventListener("click", (event) => { event.stopPropagation(); void openDetail("community", [c.id], { title: c.name, headPanels: { join: true } }); });
    card.append(join);
  }
  const open = () => void openDetail("community", [c.id], { title: c.name });
  card.addEventListener("click", open);
  card.addEventListener("keydown", (event) => { if (event.target === card && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); open(); } });
  return card;
}
const CATALOGS = {
  // 参加中かどうかは右列と同じ memberships（active / muted）で決める。人数は返るときだけ出す。
  community: { resource: "communities", items: (d) => {
      const joined = new Set((Array.isArray(d?.memberships) ? d.memberships : [])
        .filter((item) => item && ["active", "muted"].includes(item.status)).map((item) => item.communityId));
      return Array.isArray(d?.communities) ? d.communities.map((c) => joined.has(c?.id) ? { ...c, viewerJoined: true } : c) : d?.communities;
    }, empty: "コミュニティはまだありません",
    card: communityListCard },
  threads: { resource: "threads", items: (d) => d?.threads, empty: "スレッドはまだありません",
    card: threadListCard },
  hubpedia: { resource: "hubpedia_catalog", items: (d) => d?.articles ?? d?.results, empty: "公開記事はまだありません",
    card: (a) => catalogCard({ title: a.title, body: a.summary, meta: ["百科項目", a.category], onOpen: a.slug ? () => void openDetail("hubpedia_article", [a.slug], { title: a.title }) : null }) },
  articles: { resource: "articles", items: (d) => d?.articles, empty: "記事はまだありません",
    card: (a) => catalogCard({ cover: true, coverLabel: articleCoverLabel(a), title: a.title, body: a.summary, imageUrl: a.thumbnailUrl, meta: ["作者の記事", a.authorName ?? a.author, relTime(a.createdAt ?? a.publishedAt)], onOpen: a.id ? () => void openDetail("article", [a.id], { title: a.title }) : null }) },
  videos: { resource: "videos", render: renderVideoCatalog },
  music: { resource: "music", items: (d) => d?.works, empty: "外部作品はまだありません",
    card: (w) => catalogCard({ title: w.title, body: w.artist, imageUrl: w.artworkUrl, meta: [w.genre, w.year], menuWork: w, onOpen: () => void playMusicWork(w) }) },
  market: { resource: "market", items: (d) => d?.listings, empty: "出品はまだありません",
    card: (l) => catalogCard({ title: l.title, body: l.summary, meta: [l.category, l.priceLabel, l.providerLabel], onOpen: l.id ? () => void openDetail("listing", [l.id], { title: l.title }) : null }) },
  books: { resource: "books", items: (d) => d?.books, empty: "本はまだありません",
    card: (b) => catalogCard({ title: b.title, body: b.description, imageUrl: b.coverImageUrl, meta: [b.author, b.licenseName, b.sourceSiteName], onOpen: () => void openDetail("book", [b.id], { title: b.title }) }) },
  ranking: { resource: "rankings", items: (d) => d?.rankings, empty: "ランキングはまだありません",
    card: (r) => catalogCard({ title: r.title, body: r.description, meta: [r.symbol, r.network, `${r.holderCount ?? 0} 保有者`],
      onOpen: r.id ? () => void openDetail("ranking_item", [r.id], { local: true, data: r, title: r.title }) : null }) },
  contacts: { client: "contacts", items: (d) => d?.contacts, empty: "連絡先はまだありません", card: contactCard },
  bookmarks: { client: "bookmarks", items: (d) => d?.items, empty: "ブックマークはまだありません", card: bookmarkCard },
  lists: { client: "lists", render: renderListsView },
  services: { client: "services", items: (d) => d?.services, empty: "サービスはまだありません",
    card: (s) => catalogCard({ title: s.displayName || s.serviceName, body: s.description, meta: [s.serviceName, SERVICE_STATUS[s.status]],
      onOpen: s.id ? () => void openDetail("service_item", [s.id], { local: true, data: s, title: s.displayName || s.serviceName }) : null }) },
  wallet: { client: "wallet", render: renderWallet },
};

// リストの画面（2026-11-02）：区切り線の行。名前・人数（薄い字）・あれば1行の説明。押すとそのリストを開く。
// 0件は「リストを作る」つきの空の状態、読めなかったときは静かな1行と再試行。枠つきのカードは使わない。
const LIST_ROWS_DEADLINE_MS = 12_000;
const listRowsSkeleton = () => createListRowsSkeleton(document);
const listRowsError = (retry, message) => createListRowsError(document, retry, message);
async function renderListsView(target, data) {
  renderListsRows(document, target, data, {
    emptyState: (title) => emptyState("doc", title, ""),
    onCreate: () => { const form = document.querySelector("#lists-create"); if (form?.hidden) document.querySelector("#lists-create-toggle")?.click(); form?.querySelector("input, textarea")?.focus(); },
    onOpen: (list) => void openDetail("list", [list.id], { title: list.name }),
  });
}

// A UI deadline: callers explicitly show partial data or a retry state.
// It does not cancel the underlying native request.
function settleWithin(promise, ms = 15_000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject("request_timeout"), ms);
  })]).finally(() => clearTimeout(timer));
}

const catalogSearches = new Map();
const pagedCatalogs = new Set(["threads", "hubpedia", "articles", "market", "music"]);
function catalogSearch(view) {
  if (catalogSearches.has(view)) return catalogSearches.get(view);
  const def = CATALOGS[view], target = document.querySelector(`#${view}-results`), status = document.querySelector(`#${view}-state`);
  const more = document.createElement("button");
  more.type = "button"; more.className = "deny"; more.hidden = true; more.textContent = "続きを表示";
  target.after(more);
  const controller = createMediaSearch({
    allowUnknownTotal: true, key: item => item.id ?? item.slug,
    fetchPage: async ({query, offset, boardKey}) => {
      if (view === "threads") {
        await ensureThreadBoardNames();
        if (threadSort && !query) {
          const items = (await fetchThreadRanking(threadSort)).filter((item) => !boardKey || item.boardKey === boardKey);
          return {items, total: null, hasMore: false};
        }
      }
      const data =await invoke("hub_resource", {resource: def.resource, query, offset, boardKey});
      const items = def.items(data);
      return {items, total: data.total ?? null, hasMore: data.hasMore ?? (Number.isSafeInteger(data.total) ? offset + items.length < data.total : false)};
    },
    changed: page => {
      const pageLevel = view === "articles" || view === "music";
      const emptyError = Boolean(page.error) && !page.items.length && !page.loading;
      if (readingDirectory.has(view)) {
        Object.assign(readingDirectory.get(view), {items: page.items, query: page.query});
        if (emptyError) target.replaceChildren(pageErrorState("読み込めませんでした", friendlyError(page.error), () => controller.retry()));
        else renderReadingCatalog(view);
      } else if (emptyError) {
        target.replaceChildren(pageErrorState("読み込めませんでした", friendlyError(page.error), () => controller.retry()));
      } else target.replaceChildren(...page.items.map(def.card));
      if (!page.items.length && page.loading) target.replaceChildren(skeletonResult(), skeletonResult());
      target.setAttribute("aria-busy", String(page.loading));
      status.classList.toggle("warning", Boolean(page.error));
      status.textContent = page.error ? (emptyError ? "" : friendlyError(page.error)) : view === "threads" ? "" : page.loading ? "検索しています…" : page.total === null ? `${page.items.length}件を表示` : `${page.total}件中 ${page.items.length}件を表示`;
      if (page.error && !emptyError) status.append(pageLevel ? stateRetryButton(() => controller.retry()) : retryButton(() => controller.retry()));
      if (!page.items.length && !page.loading && !page.error && !readingDirectory.has(view)) target.append((pageLevel ? pageState : emptyState)("search", page.query ? "一致する項目がありません" : def.empty, "検索語を変更してください。"));
      more.hidden = !page.hasMore || Boolean(page.error); more.disabled = page.loading;
      if (currentView === view) renderSidebarContext(view);
    },
  });
  more.onclick = () => controller.more(); catalogSearches.set(view, controller); return controller;
}

async function loadCatalog(view, query = document.querySelector(view === "music" ? "#music-catalog-query" : `#${view}-query`)?.value ?? "") {
  if (view === "videos") return searchVideos(true);
  if (pagedCatalogs.has(view)) return catalogSearch(view).search(query, {boardKey: view === "threads" ? threadBoardKey || null : null}, true);
  const def = CATALOGS[view];
  const state = document.querySelector(`#${view}-state`);
  const target = document.querySelector(`#${view}-results`);
  if (!def || !state || !target) return;
  const request = Symbol(view);
  target.catalogRequest = request;
  state.textContent = view === "wallet" ? "ウォレットを読み込んでいます…" : "";
  state.classList.remove("warning");
  if (view === "lists") target.replaceChildren(listRowsSkeleton());
  else target.replaceChildren(skeletonResult(), skeletonResult(), skeletonResult());
  if (view === "community" && !communitySortChosen && !query.trim() && desktopAccount.state === "registered") {
    // 参加しているコミュニティがあるなら、最初から「参加中」で開く（一度きり。選び直せば従う）。
    communitySortChosen = true;
    try {
      const mine = await fetchCommunityRanking("joined");
      if (target.catalogRequest !== request) return;
      if (mine.some((item) => item.viewerJoined)) { communitySort = "joined"; if (currentView === view) renderSidebarContext(view); }
    } catch { /* 取れなければ従来どおり */ }
  }
  try {
    const source = def.client
      ? invoke("hub_client", { name: def.client })
      : view === "community" && communitySort && !query.trim() ? fetchCommunityRanking(communitySort).then((communities) => ({ communities }))
      : invoke("hub_resource", { resource: query.trim() && def.queryResource ? def.queryResource : def.resource, query, boardKey: view === "threads" ? threadBoardKey || null : null });
    const data = await settleWithin(source, view === "wallet" ? 15_000 : view === "lists" ? LIST_ROWS_DEADLINE_MS : 30_000);
    if (target.catalogRequest !== request) return;
    if (view !== "wallet") state.textContent = "";
    if (def.render) {
      target.replaceChildren();
      await def.render(target, data, () => target.catalogRequest === request);
      if (view === "wallet" && target.catalogRequest === request) state.textContent = "";
      return;
    }
    const items = def.items(data) ?? [];
    if (readingDirectory.has(view)) {
      const directory = readingDirectory.get(view);
      directory.items = items;
      directory.query = query;
      renderReadingCatalog(view);
      if (currentView === view) renderSidebarContext(view);
      return;
    }
    if (!items.length) {
      const emptyBoard = view === "threads" && threadBoardKey && !query;
      const empty = emptyState("search",
        query ? `「${query}」は見つかりません` : emptyBoard ? "スレッドはありません" : (def.empty ?? "まだありません"),
        query ? "別のキーワードを試してください。" : emptyBoard ? "右上の「＋作成」から立てられます。" : view === "music" ? "Webの音楽はHubブラウザで探せます。" : "Web版から追加できます。");
      if (view === "music" && !query) empty.append(webDiscoveryAction("Webで音楽を探す", "音楽"));
      target.replaceChildren(empty);
      return;
    }
    target.replaceChildren(...items.map((item) => def.card(item)));
  } catch (error) {
    if (target.catalogRequest !== request) return;
    if (view === "wallet") {
      state.textContent = "";
      await renderWallet(target, { hubUnavailable: true, accountUnavailable: isAccountUnavailable(error) }, () => target.catalogRequest === request);
      return;
    }
    if (view === "lists" && !accountNeeded(error)) {
      state.textContent = "";
      state.classList.remove("warning");
      target.replaceChildren(listRowsError(() => loadCatalog(view, query), error === "request_timeout" ? "時間内に読み込めませんでした" : "読み込めませんでした"));
      return;
    }
    showClientError(state, target, error, () => loadCatalog(view, query));
  }
}

function readingLabels(view, item) {
  if (view === "threads") return [{ chat: "雑談", question: "質問", recruitment: "募集", knowledge: "知識" }[item.threadType]].filter(Boolean);
  return view === "hubpedia" || view === "community" ? [item.category].filter(value => typeof value === "string" && value)
    : (Array.isArray(item.tags) ? item.tags : []).filter(value => typeof value === "string" && value);
}

function renderReadingCatalog(view) {
  const { items, query, filter } = readingDirectory.get(view);
  const shown = items.filter(item => (!filter || readingLabels(view, item).includes(filter)) &&
    (pagedCatalogs.has(view) || matchesSearch(query, item.title ?? item.name, item.summary ?? item.description, item.authorName ?? item.author, readingLabels(view, item).join(" "))));
  const target = document.querySelector(`#${view}-results`);
  if (view === "articles" && shown.length) {
    target.replaceChildren(renderArticleHome(document, shown, {
      hubAsset, hubOrigin: hubOrigin ?? "", relTime,
      onOpen: (a) => { if (a.id) void openDetail("article", [a.id], { title: a.title }); },
    }));
  } else if (view === "articles") {
    const filtered = Boolean(query || filter);
    target.replaceChildren(renderArticleEmpty(document, filtered ? "filtered" : "none", { actions: {
      clear: () => { readingDirectory.get(view).filter = ""; const input = document.querySelector("#articles-query"); if (input) input.value = ""; void loadCatalog(view); },
      write: () => openPostComposer(),
    } }));
  } else if (shown.length) target.replaceChildren(...shown.map(item => CATALOGS[view].card(item)));
  else {
    const empty = (view === "articles" ? pageState : emptyState)("search", query || filter ? "条件に一致する項目がありません" : CATALOGS[view].empty,
      query || filter ? "検索語や左列の絞り込みを変更してください。" : view === "articles" ? "「＋書く」から最初の記事を書けます。" : view === "hubpedia" ? "公開された百科項目がここに並びます。" : "「＋作成」から始められます。");
    if (query || filter) {
      const clear = (view === "articles" ? stateRetryButton : retryButton)(() => {
        readingDirectory.get(view).filter = "";
        const input = document.querySelector(`#${view}-query`);
        if (input) input.value = "";
        void loadCatalog(view);
      });
      clear.textContent = "絞り込みを解除";
      empty.append(clear);
    }
    target.replaceChildren(empty);
  }
  renderReadingChips(view);
}

// --- Hub公開曲 ---
// 一覧はRust経由。音声だけはMusic Workerの公開・検査済みRange配信を
// HTML audioへ直接載せ、シーク時に必要な範囲だけ受け取る。
let musicQueueView = null;
const musicPlayer = { tracks: [], queue: [], currentId: null, currentTrack: null, currentIndex: -1, artUrl: null, request: 0, sourceRequest: 0, directUrl: null };
const hubTrackAudio = createHubTrackAudio({ invoke });
const musicAudio = document.querySelector("#music-player-audio");
let musicTab = "home";
// 内側左列の「フォロー中の新着」「履歴」を音楽の本文に出す（2026-10-15）。ホーム・公開曲・外部作品のタブを押すと戻る。
let musicSideMode = null;
const musicSubscriptions = { items: [], loading: false, failed: false, epoch: null };
function musicSidePanel() {
  let panel = document.querySelector("#music-side-panel");
  if (!panel) {
    panel = document.createElement("section");
    panel.id = "music-side-panel";
    panel.className = "music-side-panel";
    panel.hidden = true;
    document.querySelector("#music-home")?.before(panel);
  }
  return panel;
}
function openMusicSideMode(mode) {
  if (currentView !== "music") document.querySelector('.icon-rail [data-view="music"]')?.click();
  musicSideMode = mode;
  if (mode === "subscriptions") loadMusicSubscriptions();
  syncMusicSidePanel();
  if (currentView === "music") renderSidebarContext("music");
}
function loadMusicSubscriptions() {
  if (desktopAccount.state !== "registered" || musicSubscriptions.loading) return;
  const epoch = homeAccountEpoch;
  musicSubscriptions.loading = true;
  void Promise.resolve(invoke("hub_detail", { name: "subscriptions", ids: ["music"] })).then((data) => {
    if (epoch !== homeAccountEpoch) return;
    musicSubscriptions.items = Array.isArray(data?.works) ? data.works.filter((work) => work && typeof work.id === "string") : [];
    musicSubscriptions.failed = false;
  }).catch(() => { if (epoch === homeAccountEpoch) { musicSubscriptions.items = []; musicSubscriptions.failed = true; } }).finally(() => {
    if (epoch !== homeAccountEpoch) return;
    musicSubscriptions.loading = false;
    syncMusicSidePanel();
  });
}
function syncMusicSidePanel() {
  const panel = musicSidePanel();
  const showing = Boolean(musicSideMode);
  panel.hidden = !showing;
  document.querySelector("#music-home").hidden = showing || musicTab !== "home";
  document.querySelector("#music-stream").hidden = showing || musicTab !== "tracks";
  document.querySelector("#music-catalog").hidden = showing || musicTab !== "catalog";
  if (!showing) { panel.replaceChildren(); return; }
  const title = document.createElement("h3");
  title.className = "music-side-title";
  title.textContent = musicSideMode === "subscriptions" ? "フォロー中の新着" : "履歴（この起動中に再生した曲）";
  const list = document.createElement("div");
  list.className = "result-grid";
  let cards = [];
  if (musicSideMode === "subscriptions") {
    cards = musicSubscriptions.items.map((work) => catalogCard({ title: work.title || "楽曲", body: work.artist || "", meta: [work.genre, work.submittedByDisplayName].filter(Boolean),
      menuWork: work, onOpen: () => void playMusicWork(work) }));
  } else {
    cards = musicHistory.list().map((entry) => {
      const item = entry.kind === "track" ? entry.track : entry.work;
      return catalogCard({ title: item.title || "楽曲", body: item.artist || "", meta: [entry.kind === "track" ? "Hubの公開曲" : "外部作品"],
        menuWork: entry.kind === "track" ? { ...item, id: "music:" + item.id } : item, onOpen: () => entry.kind === "track" ? void playMusicTrack(item, musicPlayer.tracks) : void playMusicWork(item) });
    });
  }
  const note = document.createElement("p");
  note.className = "meta";
  note.textContent = musicSideMode === "subscriptions"
    ? (musicSubscriptions.loading ? "読み込み中…" : musicSubscriptions.failed ? "読み込めませんでした" : cards.length ? "" : "フォロー中の新着はありません")
    : (cards.length ? "端末には残しません。" : "再生した曲はありません");
  list.replaceChildren(...cards);
  panel.replaceChildren(title, note, list);
}
// 本文の上のチップ：すべて・アーティスト・フォロー中のタグ。選ぶと公開曲をその語で探す。
function renderMusicChips() {
  const host = viewChipHost("music");
  if (!host) return;
  const query = document.querySelector("#music-query")?.value.trim() ?? "";
  const artists = [...new Set(musicPlayer.tracks.map((track) => typeof track.artist === "string" ? track.artist.trim() : "").filter(Boolean))].slice(0, 20);
  const tags = sidebarRemote.tags();
  const chips = [
    { key: "", label: "すべて", kind: "all", selected: !query || musicTab === "home" },
    ...artists.map((artist) => ({ key: artist, label: artist, kind: "category", selected: musicTab === "tracks" && query === artist })),
    ...tags.map((tag) => ({ key: tag, label: tag, kind: "tag", selected: musicTab === "tracks" && query === tag })),
  ];
  renderChipRow(document, host, { label: "音楽のアーティストとタグ", chips: chips.length > 1 ? chips : [], onSelect: (chip) => {
    musicSideMode = null;
    document.querySelector("#music-query").value = chip.key;
    if (chip.kind === "all") { document.querySelector("#music-tab-home").click(); void searchMusic(true); return; }
    document.querySelector("#music-tab-tracks").click();
    void searchMusic(true);
  } });
}
// フィードの上のチップ：並び（おすすめ・人気。投稿のときだけ）とフォロー中のタグ（タグの画面を開く）。
function renderFeedChips() {
  const host = viewChipHost("feed");
  if (!host) return;
  const kind = socialMode === "legacy" ? "post" : socialFilter;
  const following = socialMode === "mixed" && socialScope === "following";
  const chips = sidebarRemote.tags().map((tag) => ({ key: tag, label: tag, kind: "tag", selected: false }));
  renderChipRow(document, host, { label: "フォロー中のタグ", chips, onSelect: (chip) => {
    void openDetail("tag", [chip.key], { title: `#${chip.key}` });
  } });
}
// 記事・コミュニティ・スレッド・資料の上のチップ：すべて・分類（件数つき）、記事はフォロー中のタグも。
function renderReadingChips(view) {
  const host = viewChipHost(view);
  const directory = readingDirectory.get(view);
  if (!host || !directory) return;
  if (view === "threads" || view === "community") {
    // スレッドとコミュニティ：並び替え（おすすめ・人気…）と分類を、一覧の上の1行に置く（2026-11-11 所有者：左の列は行き先だけ）。もう一度押すと解除。
    const isThread = view === "threads";
    const sort = isThread ? threadSort : communitySort;
    const counts = new Map();
    for (const item of directory.items) for (const label of new Set(readingLabels(view, item))) counts.set(label, (counts.get(label) ?? 0) + 1);
    const labels = counts.size >= 2 ? [...counts.keys()].sort((a, b) => a.localeCompare(b, "ja")) : [];
    const chips = [
      ...(isThread ? THREAD_SORTS : COMMUNITY_SORTS).map(([key, label]) => ({ key, label, kind: "sort", selected: sort === key })),
      ...labels.map((label) => ({ key: label, label: `${label} ${counts.get(label)}`, kind: "category", selected: directory.filter === label })),
    ];
    renderChipRow(document, host, { label: "並び替えと分類", chips, onSelect: (chip) => {
      if (chip.kind === "sort") {
        const next = sort === chip.key ? "" : chip.key;
        if (isThread) threadSort = next; else { communitySort = next; communitySortChosen = true; }
        void loadCatalog(view);
      } else {
        directory.filter = directory.filter === chip.key ? "" : chip.key;
        renderReadingCatalog(view);
      }
      renderReadingChips(view);
    } });
    return;
  }
  const counts = new Map();
  for (const item of directory.items) for (const label of new Set(readingLabels(view, item))) counts.set(label, (counts.get(label) ?? 0) + 1);
  const labels = [...counts.keys()].sort((a, b) => a.localeCompare(b, "ja"));
  const tags = view === "articles" ? sidebarRemote.tags().filter((tag) => !counts.has(tag)) : [];
  const chips = labels.length || tags.length || directory.filter ? [
    { key: "", label: "すべて", kind: "all", selected: !directory.filter },
    ...labels.map((label) => ({ key: label, label: `${label} ${counts.get(label)}`, kind: "category", selected: directory.filter === label })),
    ...tags.map((tag) => ({ key: tag, label: tag, kind: "tag", selected: false })),
  ] : [];
  renderChipRow(document, host, { label: "分類とタグ", chips, onSelect: (chip) => {
    if (chip.kind === "tag") { void openDetail("tag", [chip.key], { title: `#${chip.key}` }); return; }
    directory.filter = chip.key;
    renderReadingCatalog(view);
    renderSidebarContext(view);
  } });
}
// Hubの中で再生できるのは YouTube の埋め込みだけ。履歴はこのセッション中のみ。
const musicHistory = createMusicHistory();
let musicHome = null;
// 動画と音楽で共有する再生枠。画面を離れると右下の動かせる小窓になる。
// 同時に鳴らすのは1つだけ。始めた側が claim し、Hub の曲・YouTube 枠・右列ブラウザのほかが止まる。
const playbackOwner = createPlaybackOwner();
playbackOwner.register("music-audio", () => { if (!musicAudio.paused) musicAudio.pause(); });
musicAudio.addEventListener("play", () => playbackOwner.claim("music-audio"));
const ytDock = createYouTubeDock({ document, owner: playbackOwner, invoke, stage: () => document.querySelector("#browser-stage"), storage: (() => { try { return window.localStorage; } catch { return null; } })() });
// 埋め込みで再生できないと分かった YouTube の項目は一覧から外す（絞り込みは yt-unplayable.mjs の1か所）。表示中の一覧は描き直す。
ytUnplayable().subscribe(() => { try { if (currentView === "videos" && videoSearchState) renderVideoHomeRows(videoSearchState, false); if (currentView === "music") musicHome?.repaint(); } catch { /* 描き直せなくても再生は止まっている */ } });
// P2P の手元キャッシュの手入れ（再検証・取消された曲の削除・古い断片の掃除）。起動の少し後と60分ごと（DESIGN.md §6.4）。
const maintainMediaCache = () => void Promise.resolve(invoke("media_cache_maintain")).catch(() => {});
setTimeout(maintainMediaCache, 20000); setInterval(maintainMediaCache, 60 * 60 * 1000);
const musicYoutube = createMusicYoutubeSession({ document, bar: document.querySelector("#music-yt-bar"), hubAsset: (img, url) => hubAsset(img, url), dock: ytDock,
  onOpenWork: work => openMusicWorkInRail(work, { autoplay: false }),
  onPlayed: (work) => { musicHistory.add({ kind: "work", work }); musicHome?.repaint(); if (currentView === "music") renderSidebarContext("music"); } });
let musicCatalogLoaded = false;

function musicDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "";
  const total = Math.round(value);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

const musicSearch = createMediaSearch({
  fetchPage: async ({ query, offset }) => {
    const data = await invoke("music_tracks", { query, offset });
    return { ...data, items: data.tracks };
  },
  changed: state => {
    musicPlayer.tracks = state.items;
    renderMusicTracks();
    renderMediaSearchState("music", state, document.querySelector("#music-tracks"), document.querySelector("#music-tracks-state"));
    // 右列の一覧は右列が自分で持つ（中央の検索結果には連動しない）。
    musicHome?.repaint();
    if (currentView === "music") renderSidebarContext("music");
  },
});
function searchMusic(immediate = false) { return musicSearch.search(document.querySelector("#music-query").value, {}, immediate); }
function loadMusicTracks() { void musicHome?.refresh(); return searchMusic(true); }
bindMediaSearch("music", searchMusic, musicSearch);
// Hub公開曲の再生を始めたら、このセッションの履歴に積む。
musicAudio.addEventListener("play", () => { if (musicPlayer.currentTrack && !musicPlayer.currentTrack.peer) { musicHistory.add({ kind: "track", track: { ...musicPlayer.currentTrack } }); if (currentView === "music") renderSidebarContext("music"); } });
musicHome = createMusicHome({
  document, host: document.querySelector("#music-home"), hubAsset: (img, url) => hubAsset(img, url), history: musicHistory,
  loaders: {
    recommended: async () => (await settleWithin(invoke("hub_resource", { resource: "music", query: "" }), 30_000))?.works ?? [],
    favorites: async () => desktopAccount.state === "registered" ? ((await invoke("hub_client", { name: "music_library" }))?.works ?? []) : [],
    tracks: () => musicPlayer.tracks,
    // 接続した他のHubの公開曲。自分のHubの曲は除く。
    peers: async () => { await hubNetwork.ready; return peerMusicEntries(await hubNetwork.load("music"), { ownOrigin: hubOrigin ?? "" }); },
  },
  actions: {
    playPeer: (entry) => playPeerMusic(entry),
    canPlayWork: (work) => youtubeSource(work) !== null,
    // 棚を順に再生：公開曲は共有の待ち行列、先頭が外部の曲・他Hubの曲ならその1曲（飛ばすのは再生できないものだけ）。
    playQueue: (entries) => {
      const plan = planShelfPlayback(entries, { canPlayWork: (work) => youtubeSource(work) !== null });
      const start = plan.start;
      if (!start) return false;
      if (start.kind === "track") {
        const from = Math.max(0, plan.tracks.findIndex((item) => item.id === start.track.id));
        musicHistory.add({ kind: "track", track: { ...start.track } }); musicHome?.repaint();
        void playMusicTrack(start.track, plan.tracks.slice(from));
      } else if (start.kind === "peer") playPeerMusic(start.peer);
      else void playMusicWork(start.work);
      return true;
    },
    openWork: (work) => void playMusicWork(work),
    playWork: (work) => void playMusicWork(work),
    playTrack: (track) => { musicHistory.add({ kind: "track", track: { ...track } }); musicHome?.repaint(); void playMusicTrack(track, musicPlayer.tracks); },
    search: (query) => {
      const wasLoaded = musicCatalogLoaded;
      document.querySelector("#music-catalog-query").value = query;
      document.querySelector("#music-tab-catalog").click();
      if (wasLoaded) document.querySelector("#music-catalog-search").requestSubmit();
    },
  },
});

// 他Hubの曲：YouTube は共有の再生枠、Worker の公開曲は Rust が取った音声を blob: で既存の <audio> に載せる。
const peerAudio = createPeerAudio({ invoke, audio: musicAudio,
  onTrack: (entry) => {
    const track = { id: `peer:${entry.key}`, title: entry.title, artist: entry.artist, peer: true };
    ++musicPlayer.request; ++musicPlayer.sourceRequest;
    hubTrackAudio.release(); musicPlayer.directUrl = null;
    musicYoutube.stop();
    musicPlayer.queue = []; musicPlayer.currentTrack = track; musicPlayer.currentId = track.id; musicPlayer.currentIndex = -1;
    document.querySelector("#music-player-title").textContent = track.title;
    document.querySelector("#music-player-artist").textContent = [track.artist, entry.host].filter(Boolean).join(" · ");
    const art = document.querySelector("#music-player-art"); art.hidden = true; art.removeAttribute("src");
    document.querySelector("#music-player").hidden = false;
    syncMusicPlayerBounds(); updateMusicControls();
  },
  onError: (error) => { document.querySelector("#music-playback-state").textContent = friendlyError(error); } });
function playPeerMusic(entry) {
  if (entry?.youtubeId) {
    const work = peerYoutubeWork(entry);
    musicAudio.pause();
    void playMusicWork(work);
    return true;
  }
  if (!entry?.audioPath) return false;
  document.querySelector("#music-playback-state").textContent = "読み込み中…";
  void peerAudio.play(entry).then((ok) => { if (ok) document.querySelector("#music-playback-state").textContent = ""; });
  return true;
}

function musicTrackArt(track) {
  const art = document.createElement("span");
  art.className = "music-track-art";
  art.textContent = "♪";
  if (track.artworkUrl === `/music/api/tracks/${track.id}/artwork`) {
    const img = document.createElement("img");
    hubAsset(img, track.artworkUrl);
    img.alt = "";
    img.loading = "lazy";
    img.onerror = () => img.remove();
    art.append(img);
  }
  return art;
}

// 行の中の名前。行全体が再生ボタンなので、入れ子のボタンにせず、押したら行の再生を止めて頁を開く。
function musicNameLink(node, open, label) {
  node.classList.add('music-name-link'); node.setAttribute('role', 'link'); node.tabIndex = 0; node.setAttribute('aria-label', label);
  node.addEventListener('click', event => { event.stopPropagation(); event.preventDefault(); open(); });
  node.addEventListener('keydown', event => { if (event.key === 'Enter') { event.stopPropagation(); event.preventDefault(); open(); } else if (event.key === ' ') event.stopPropagation(); });
}
{ const playerArtist = document.querySelector('#music-player-artist'); if (playerArtist) { playerArtist.classList.add('music-name-link'); playerArtist.setAttribute('role', 'link'); playerArtist.tabIndex = 0; const open = () => { const track = musicPlayer.currentTrack; if (track && !track.peer && track.artist) openMusicArtist(track.artist); }; playerArtist.addEventListener('click', open); playerArtist.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); open(); } }); } }
let musicFavoriteRead=null;
const musicFavoriteControls=new Set();
function musicFavoriteInvoke(name,args){
  if(name==='hub_client'&&args?.name==='music_favorites')return musicFavoriteRead??=invoke(name,args).catch(error=>{musicFavoriteRead=null;throw error;});
  return invoke(name,args);
}
function renderMusicTracks() {
  for(const control of musicFavoriteControls)control.destroy();musicFavoriteControls.clear();
  const target = document.querySelector("#music-tracks");
  const state = document.querySelector("#music-tracks-state");
  const query = document.querySelector("#music-query").value.trim();
  const tracks = musicPlayer.tracks;
  const searchState = musicSearch.snapshot();
  state.textContent = `${searchState.total} 件中 ${tracks.length} 件を表示`;
  if (!tracks.length && searchState.loading) { target.replaceChildren(); return; }
  if (!tracks.length && searchState.error) {
    target.replaceChildren(pageErrorState("読み込めませんでした", friendlyError(searchState.error), () => void musicSearch.retry()));
    return;
  }
  if (!tracks.length) {
    const empty = pageState("music", query ? "曲が見つかりません" : "公開曲はまだありません", query ? "検索語を変えてください。" : "公開曲が追加されるとHub内で再生できます。上のWeb検索からHubブラウザで探せます。");
    target.replaceChildren(empty);
    return;
  }
  target.replaceChildren(...tracks.map((track, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `music-track${musicPlayer.currentId === track.id ? " on" : ""}`;
    row.setAttribute("aria-label", `${track.title || "楽曲"}、${track.artist || "アーティスト不明"}を再生`);
    const number = document.createElement("span");
    number.className = "music-track-number";
    number.textContent = String(index + 1);
    const copy = document.createElement("span");
    copy.className = "music-track-text";
    const title = document.createElement("strong");
    title.textContent = track.title || "楽曲";
    const artist = document.createElement("span");
    artist.textContent = track.artist || "アーティスト不明";
    if (track.artist) musicNameLink(artist, () => openMusicArtist(track.artist), track.artist + "のアーティストページを開く");
    copy.append(title, artist);
    const album = document.createElement("span");
    album.className = "music-track-album";
    album.textContent = track.album || "シングル";
    if (track.album) musicNameLink(album, () => openMusicAlbum(track.album, track.artist), "アルバム " + track.album + "を開く");
    const duration = document.createElement("span");
    duration.className = "music-track-duration";
    duration.textContent = musicDuration(track.durationSeconds);
    row.append(number, musicTrackArt(track), copy, album, duration);
    row.onclick = () => void playMusicTrack(track, tracks);
    const group=document.createElement('div');group.className='music-track-group';group.append(row);
    const next=actionButton('次に再生','head-action',()=>{if(currentView==='music'&&target.contains(group))enqueueMusicTrack(track,'next');});next.className='head-action music-queue-add';next.setAttribute('aria-label',(track.title||'楽曲')+'を次に再生');group.append(next,musicMenuButton(document,{...track,id:'music:'+track.id}));
    if(desktopAccount.state!=='registered'||currentView!=='music')return group;
    const generation=researchAccountGeneration;
    musicFavoriteControls.add(attachMusicFavorite({document,host:group,workId:'music:'+track.id,invoke:musicFavoriteInvoke,
      isCurrent:()=>generation===researchAccountGeneration&&currentView==='music'&&target.contains(group),
      onChanged:()=>{musicFavoriteRead=null;renderMusicTracks();}}));
    return group;
  }));
}

function musicAudioUrl(origin, trackId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trackId)) return null;
  try {
    const url = new URL(origin);
    if (url.username || url.password || !["https://hub.jkamma.com", "http://localhost:3020", "http://127.0.0.1:3020"].includes(url.origin)) return null;
    return `${url.origin}/music/api/tracks/${trackId}/audio`;
  } catch { return null; }
}


function syncMusicPlayerBounds() {
  const player = document.querySelector("#music-player");
  const rect = document.querySelector(".workspace-main").getBoundingClientRect();
  player.style.left = `${rect.left}px`;
  player.style.width = `${rect.width}px`;
  const ytBar = document.querySelector("#music-yt-bar");
  ytBar.style.left = `${rect.left}px`;
  ytBar.style.width = `${rect.width}px`;
  musicQueueView?.render();
}
new ResizeObserver(syncMusicPlayerBounds).observe(document.querySelector(".workspace-main"));
window.addEventListener("resize", syncMusicPlayerBounds);

function updateMusicControls() {
  const playing = !musicAudio.paused && !musicAudio.ended;
  const toggle = document.querySelector("#music-toggle");
  toggle.textContent = playing ? "Ⅱ" : "▶";
  toggle.setAttribute("aria-label", playing ? "一時停止" : "再生");
  document.querySelector("#music-prev").disabled = !musicQueue.adjacentMusicQueueTrack(musicPlayer.queue, musicPlayer.currentId, -1);
  document.querySelector("#music-next").disabled = !musicQueue.adjacentMusicQueueTrack(musicPlayer.queue, musicPlayer.currentId, 1);
  toggle.disabled = !musicPlayer.currentId && musicPlayer.queue.length === 0;
  renderRailNowPlaying();
  try { miniPlayer.refresh(); } catch { /* 小窓は初期化の前なら後で描く */ }
  musicQueueView?.render();
}

function getMusicQueueState() {
  return {queue: musicPlayer.queue.map(track => ({...track})), currentId: musicPlayer.currentId, currentIndex: musicPlayer.currentIndex};
}
function applyMusicQueue(update) {
  ++musicPlayer.request;
  try {
    musicPlayer.queue = update();
    musicPlayer.currentIndex = musicPlayer.queue.findIndex(track => track.id === musicPlayer.currentId);
    document.querySelector("#music-playback-state").textContent = "";
    if (!musicPlayer.currentId && musicPlayer.queue.length) {
      document.querySelector("#music-player").hidden = false;
      document.querySelector("#music-player-title").textContent = "再生待ち";
      document.querySelector("#music-player-artist").textContent = "";
      syncMusicPlayerBounds();
    }
    updateMusicControls();
    return true;
  } catch {
    document.querySelector("#music-playback-state").textContent = "再生待ち一覧は200件までの公開曲にしてください。";
    return false;
  }
}
function enqueueMusicTrack(track, placement = "last") {
  return applyMusicQueue(() => musicQueue.enqueueMusicQueue(musicPlayer.queue, track, musicPlayer.currentId, placement));
}
function removeMusicQueueTrack(id) { return applyMusicQueue(() => musicQueue.removeMusicQueue(musicPlayer.queue, id)); }
function replaceMusicQueue(tracks) { return applyMusicQueue(() => musicQueue.normalizeMusicQueue(tracks)); }

// --- 曲の再生と操作（作品の頁は無い。2026-11-02 所有者承認） ---
// 曲を押すとその場で再生する。Hub の公開曲は音声を鳴らし、YouTube の曲は右列の「再生中」に16:9の枠を出す。画面は切り替えない。
// 曲の操作は「⋯」メニュー（music-track-menu.mjs）に集める。
const HUB_MUSIC_WORK_ID = /^music:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MUSIC_WORK_ID = /^(?:[A-Za-z0-9_-]{1,128}|music:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu;
const musicWorkOf = (input) => { const work = input?.work ?? input; return work && typeof work === "object" ? work : null; };
/** 右列を「音楽」の再生中に切り替えて開き、その作品を右列の中で出す。 */
function openMusicWorkInRail(input, { autoplay = true, report = false } = {}) {
  const work = musicWorkOf(input);
  if (!work || !railMusic) return false;
  selectRailView("music");
  const route = { type: "work", work, autoplay, report };
  railNav.visit("music", "m" + (++railNavSeq), { route });
  railMusic.show(route);
  return true;
}
/** 曲を押したとき。公開曲は音声、YouTube は右列の枠。再生できない作品も右列に出し、⋯ から提供元を開ける。 */
function playMusicWork(input, queue = null, { openRail = false } = {}) {
  const work = musicWorkOf(input);
  if (!work) return false;
  if (HUB_MUSIC_WORK_ID.test(String(work.id ?? ""))) {
    const track = { ...work, id: work.id.slice(6) };
    void playMusicTrack(track, queue?.length ? queue : [track]);
    if (openRail) openMusicWorkInRail(work, { autoplay: false });
    return true;
  }
  return openMusicWorkInRail(work, { autoplay: youtubeSource(work) !== null });
}
/** 曲のID（深いリンク・プレイリスト）から曲を再生する。作品が手元に無ければ読んでから。 */
async function openMusicWorkById(id, known = null) {
  const generation = researchAccountGeneration;
  try {
    let work = musicWorkOf(known);
    if (!work || work.id !== id) {
      if (typeof id !== "string" || !MUSIC_WORK_ID.test(id)) return false;
      work = (await invoke("hub_detail", { name: "music_work", ids: [id] }))?.work;
    }
    if (generation !== researchAccountGeneration || !work || typeof work.id !== "string") return false;
    return playMusicWork(work, null, { openRail: true });
  } catch (error) { showNotice(friendlyError(error)); return false; }
}
function currentMusicBarWork() {
  const track = musicPlayer.currentTrack;
  return track && !track.peer && musicQueue.isPublicMusicTrackId(track.id) ? { ...track, id: "music:" + track.id } : null;
}
function openMusicDownload(work) { const url = musicDownloadPageUrl(hubOrigin ?? "", work.id.slice(6)); if (url) void enterBrowser(url); }
const reportableMusicWork = (work) => work?.source === "community" && typeof work.id === "string" && !work.id.startsWith("music:") && !work.id.startsWith("sample");
async function toggleMusicFavorite(work) {
  if (desktopAccount.state !== "registered") { showNotice("お気に入りにはHubへの接続が必要です。"); return; }
  const generation = researchAccountGeneration;
  try {
    const saved = await invoke("hub_client", { name: "music_favorites" });
    if (generation !== researchAccountGeneration) return;
    const ids = Array.isArray(saved?.favoriteIds) ? saved.favoriteIds : [];
    const add = !ids.includes(work.id);
    if (add && ids.length >= 200) { showNotice("お気に入りの追加は200件までです。保存済みの作品を解除してから追加してください。"); return; }
    const next = await invoke("hub_client_action", { action: add ? "favorite_music" : "unfavorite_music", target: work.id });
    if (generation !== researchAccountGeneration) return;
    if (!Array.isArray(next?.favoriteIds) || next.favoriteIds.includes(work.id) !== add) throw Error("invalid_music_favorite_state");
    musicFavoriteRead = null;
    showNotice(add ? "お気に入りに保存しました。" : "お気に入りを解除しました。");
  } catch { showNotice("お気に入りを更新できませんでした。もう一度操作してください。"); }
}
// 「プロフィールに表示」。Commerce は出品者セッション、Music は管理用アサーション（どちらも Rust が持ち、窓には渡らない）で証明を取る。
const profileAttribution = createProfileAttribution({ invoke, fetchProof: {
  market: commerceProofFetcher(invoke),
  music: musicProofFetcher(invoke),
} });
// 自分の曲（公開中・スキャン済み）と、すでに表示している曲。メニューは同期で組まれるので、先に読んでおく（⋯に触れた時に読み、60秒は再利用）。
const musicAttributionState = { eligible: new Set(), attributed: new Set(), loadedAt: 0, loading: null };
function primeMusicAttribution() {
  if (musicAttributionState.loading) return musicAttributionState.loading;
  if (Date.now() - musicAttributionState.loadedAt < 60_000) return Promise.resolve();
  musicAttributionState.loadedAt = Date.now();
  musicAttributionState.loading = (async () => {
    try {
      const own = await invoke("music_own_attribution_candidates");
      const eligible = new Set(Array.isArray(own?.ids) ? own.ids.filter((id) => typeof id === "string") : []);
      const attributed = new Set(await profileAttribution.ids("music").catch(() => []));
      musicAttributionState.eligible = eligible;
      musicAttributionState.attributed = attributed;
    } catch { musicAttributionState.eligible = new Set(); musicAttributionState.attributed = new Set(); }
    finally { musicAttributionState.loading = null; }
  })();
  return musicAttributionState.loading;
}
document.addEventListener("pointerover", (event) => { if (event.target?.closest?.("[data-music-menu]")) void primeMusicAttribution(); }, { passive: true });
const musicP2p = createMusicP2pDeclaration({ invoke, confirm: (text) => window.confirm(text), notice: (text) => showNotice(text), autoSync: true });
const musicMenuDeps = {
  p2p: {
    label: (work) => { const id = String(work?.id ?? "").slice(6); return musicP2p.label(id, musicAttributionState.eligible.has(id)); },
    run: (work) => musicP2p.run(String(work?.id ?? "").slice(6)),
  },
  profileAttribution: {
    // メニューを開く前に待つ（読み込み中か60秒を過ぎた時だけ Promise。新しければ null で即開く）。
    ready: () => {
      const own = musicAttributionState.loading ?? (Date.now() - musicAttributionState.loadedAt < 60_000 ? null : primeMusicAttribution());
      const p2p = musicP2p.ready();
      return own && p2p ? Promise.all([own, p2p]) : (own ?? p2p);
    },
    label: (work) => {
      void primeMusicAttribution();
      const id = String(work?.id ?? "").slice(6);
      if (musicAttributionState.attributed.has(id)) return "プロフィールから外す";
      return musicAttributionState.eligible.has(id) ? "プロフィールに表示" : null;
    },
    run: async (work) => {
      const id = String(work?.id ?? "").slice(6);
      const shown = musicAttributionState.attributed.has(id);
      try {
        if (shown) await profileAttribution.remove("music", id); else await profileAttribution.show("music", id);
        musicAttributionState.loadedAt = 0;
        await primeMusicAttribution();
        showNotice(shown ? "プロフィールから外しました。" : "プロフィールに表示しました。");
      } catch (error) { showNotice(attributionMessage(error)); }
    },
  },
  enqueue: (work) => enqueueMusicTrack({ ...work, id: work.id.slice(6) }, "next"),
  favorite: (work) => void toggleMusicFavorite(work),
  addToPlaylist: (work) => void openDetail("music_playlists", [work.id], { title: "プレイリストに追加", local: true, data: { selectedItem: { id: work.id, title: work.title || "楽曲" } } }),
  share: (work) => void shareMusicWork({ workId: work.id, title: work.title || "楽曲" }, {
    invoke, isCurrent: () => true, onShare: offerPublicContentShare, onStatus: (text) => { if (text) showNotice(text); },
    getViewer: async () => (await invoke("hub_client", { name: "me" }))?.profile?.id }),
  canReport: reportableMusicWork,
  report: (work) => { if (!openMusicWorkInRail(work, { autoplay: false, report: true })) showNotice("報告を開けませんでした。"); },
  openExternal: (url) => void invoke("open_external", { url }).catch((error) => showNotice(friendlyError(error))),
};
async function playMusicTrack(input, queue = musicPlayer.queue, options = {}) {
  const request = ++musicPlayer.request, generation = researchAccountGeneration;
  const state = document.querySelector("#music-playback-state");
  const current = () => {
    try { return request === musicPlayer.request && generation === researchAccountGeneration
      && (options.isCurrent === undefined || typeof options.isCurrent === "function" && options.isCurrent() === true); }
    catch { return false; }
  };
  if (!options || typeof options !== "object" || Reflect.ownKeys(options).some(key => key !== "isCurrent") || !current()) return false;
  try {
    let track = musicQueue.normalizeMusicQueue([input])[0];
    let planned = musicQueue.normalizeMusicQueue(queue);
    if (!planned.some(item => item.id === track.id)) planned = musicQueue.enqueueMusicQueue(planned, track, null, "next");
    state.textContent = "読み込み中…";
    if (track.id === musicPlayer.currentId && musicAudio.src) {
      musicPlayer.queue = planned.map(item => item.id === track.id && musicPlayer.currentTrack ? {...musicPlayer.currentTrack} : item);
      musicPlayer.currentIndex = musicPlayer.queue.findIndex(item => item.id === track.id);
      updateMusicControls();
      if (musicAudio.paused || musicAudio.ended) {
        if (!current()) return false;
        await musicAudio.play();
      }
      if (!current()) return false;
      state.textContent = "";
      return true;
    }
    if (track.playlistStub === true) {
      const id = "music:" + track.id;
      const data = await invoke("hub_detail", {name: "music_work", ids: [id]});
      if (!current()) return false;
      if (data?.work?.id !== id) throw Error("楽曲情報を確認できませんでした。");
      track = musicQueue.normalizeMusicQueue([{...data.work, id: track.id}])[0];
    }
    if (!current()) return false;
    const origin = hubOrigin ?? await invoke("hub_origin");
    if (!current()) return false;
    const url = musicAudioUrl(origin, track.id);
    if (!url) throw Error("音楽の配信先を確認できません。");
    // 検証済みの音声(media_audio)をblob:で鳴らす。使えない時は直接URLへ退く。
    const source = await hubTrackAudio.resolve({ origin, trackId: track.id, directUrl: url, isCurrent: current });
    if (source === null || !current()) return false;
    musicAudio.pause();
    musicAudio.src = source;
    musicAudio.load();
    musicPlayer.directUrl = url;
    const sourceRequest = ++musicPlayer.sourceRequest;
    musicPlayer.queue = planned.map(item => item.id === track.id ? {...track} : item);
    musicPlayer.currentTrack = {...track};
    musicPlayer.currentId = track.id;
    musicPlayer.currentIndex = musicPlayer.queue.findIndex(item => item.id === track.id);
    document.querySelector("#music-player-title").textContent = track.title || "楽曲";
    document.querySelector("#music-player-artist").textContent = [track.artist, track.album].filter(Boolean).join(" · ");
    const art = document.querySelector("#music-player-art");
    art.hidden = true;
    art.removeAttribute("src");
    if (musicPlayer.artUrl) { URL.revokeObjectURL(musicPlayer.artUrl); musicPlayer.artUrl = null; }
    if (track.artworkUrl) {
      void invoke("music_artwork", {trackId: track.id}).then(image => {
        if (musicPlayer.sourceRequest !== sourceRequest || musicPlayer.currentId !== track.id) return;
        musicPlayer.artUrl = URL.createObjectURL(new Blob([image]));
        art.src = musicPlayer.artUrl;
        art.hidden = false; try { miniPlayer.refresh(); } catch { /* 小窓は後で描く */ }
      }).catch(() => {});
    }
    document.querySelector("#music-player").hidden = false;
    syncMusicPlayerBounds();
    renderMusicTracks();
    updateMusicControls();
    if (!current()) return false;
    await musicAudio.play();
    if (!current()) return false;
    state.textContent = "";
    return true;
  } catch (error) {
    if (current()) state.textContent = error?.message?.startsWith("music_queue_") ? "再生待ち一覧は200件までの公開曲にしてください。" : friendlyError(error);
    return false;
  }
}

async function toggleMusicPlayback() {
  if (!musicPlayer.currentId || !musicAudio.src) {
    const first = musicPlayer.queue[0];
    return first ? playMusicTrack(first) : false;
  }
  const request = ++musicPlayer.request, generation = researchAccountGeneration;
  const state = document.querySelector("#music-playback-state");
  if (!musicAudio.paused && !musicAudio.ended) { musicAudio.pause(); state.textContent = ""; return true; }
  state.textContent = "読み込み中…";
  try {
    await musicAudio.play();
    if (request !== musicPlayer.request || generation !== researchAccountGeneration) return false;
    state.textContent = ""; return true;
  } catch {
    if (request === musicPlayer.request && generation === researchAccountGeneration) state.textContent = "再生できませんでした。";
    return false;
  }
}



for (const tab of ["home", "tracks", "catalog"]) {
  document.querySelector(`#music-tab-${tab}`).onclick = () => {
    musicTab = tab;
    musicSideMode = null;
    musicSidePanel().hidden = true;
    for (const key of ["home", "tracks", "catalog"]) {
      const active = key === tab;
      const button = document.querySelector(`#music-tab-${key}`);
      button.classList.toggle("on", active);
      button.setAttribute("aria-selected", String(active));
    }
    document.querySelector("#music-home").hidden = tab !== "home";
    document.querySelector("#music-stream").hidden = tab !== "tracks";
    document.querySelector("#music-catalog").hidden = tab !== "catalog";
    if (currentView === "music") renderSidebarContext("music");
    if (tab === "catalog" && !musicCatalogLoaded) {
      musicCatalogLoaded = true;
      void loadCatalog("music");
    }
  };
}
document.querySelector("#music-prev").onclick = () => {
  const track = musicQueue.adjacentMusicQueueTrack(musicPlayer.queue, musicPlayer.currentId, -1);
  if (track) void playMusicTrack(track);
};
document.querySelector("#music-next").onclick = () => {
  const track = musicQueue.adjacentMusicQueueTrack(musicPlayer.queue, musicPlayer.currentId, 1);
  if (track) void playMusicTrack(track);
};
document.querySelector("#music-toggle").onclick = () => { void toggleMusicPlayback(); };
document.querySelector("#music-more-slot").replaceWith(musicMenuButton(document, () => currentMusicBarWork(), { label: "再生中の曲のその他の操作", className: "music-player-more" }));
document.querySelector("#music-volume").oninput = (event) => { musicAudio.volume = Number(event.target.value) / 100; };
musicAudio.volume = 0.8;
document.querySelector("#music-seek").oninput = (event) => {
  if (Number.isFinite(musicAudio.duration)) musicAudio.currentTime = Number(event.target.value);
};
const updateMusicProgress = () => {
  const duration = Number.isFinite(musicAudio.duration) ? musicAudio.duration : 0;
  const seek = document.querySelector("#music-seek");
  seek.max = String(duration || 100);
  seek.value = String(Math.min(musicAudio.currentTime || 0, duration || 100));
  document.querySelector("#music-current-time").textContent = musicDuration(musicAudio.currentTime) || "0:00";
  document.querySelector("#music-total-time").textContent = musicDuration(duration) || "0:00";
};
musicAudio.addEventListener("timeupdate", updateMusicProgress);
musicAudio.addEventListener("loadedmetadata", updateMusicProgress);
musicAudio.addEventListener("play", updateMusicControls);
musicAudio.addEventListener("pause", updateMusicControls);
musicAudio.addEventListener("ended", () => {
  updateMusicControls();
  const next = musicQueue.adjacentMusicQueueTrack(musicPlayer.queue, musicPlayer.currentId, 1);
  if (next) void playMusicTrack(next);
});
musicAudio.addEventListener("error", () => { if (musicAudio.error) document.querySelector("#music-playback-state").textContent = "音声を読み込めませんでした。"; });

// 小窓の再生（画面の中に浮く）。Hub の曲の操作盤で、右列が閉じていても出る。操作は下の再生バーと同じ関数を呼ぶ。
const miniPlayer = createMiniPlayer({ document, dock: ytDock, storage: (() => { try { return window.localStorage; } catch { return null; } })(),
  engine: {
    state: () => ({ track: musicPlayer.queue.find(item => item.id === musicPlayer.currentId) ?? null, artwork: musicPlayer.artUrl, paused: musicAudio.paused || musicAudio.ended, currentTime: musicAudio.currentTime || 0,
      duration: Number.isFinite(musicAudio.duration) ? musicAudio.duration : 0,
      hasPrev: Boolean(musicQueue.adjacentMusicQueueTrack(musicPlayer.queue, musicPlayer.currentId, -1)), hasNext: Boolean(musicQueue.adjacentMusicQueueTrack(musicPlayer.queue, musicPlayer.currentId, 1)) }),
    subscribe: (fn) => {
      const events = ["timeupdate", "loadedmetadata", "play", "pause", "ended", "emptied"];
      for (const name of events) musicAudio.addEventListener(name, fn);
      return () => { for (const name of events) musicAudio.removeEventListener(name, fn); };
    },
    toggle: () => { void toggleMusicPlayback(); },
    prev: () => { const track = musicQueue.adjacentMusicQueueTrack(musicPlayer.queue, musicPlayer.currentId, -1); if (track) void playMusicTrack(track); },
    next: () => { const track = musicQueue.adjacentMusicQueueTrack(musicPlayer.queue, musicPlayer.currentId, 1); if (track) void playMusicTrack(track); },
    seek: (seconds) => { if (Number.isFinite(musicAudio.duration) && Number.isFinite(seconds)) musicAudio.currentTime = seconds; },
    queue: () => document.querySelector("#music-queue-toggle")?.click(),
    expand: () => showView("music", "音楽"),
    close: () => {
      ++musicPlayer.request; musicAudio.pause(); musicAudio.removeAttribute("src"); musicAudio.load();
      musicPlayer.currentId = null; musicPlayer.currentIndex = -1;
      document.querySelector("#music-player").hidden = true;
      musicAudio.dispatchEvent(new Event("emptied"));
    },
  } });

musicQueueView=initMusicQueueView({document,host:document.querySelector('#music-queue-panel'),toggle:document.querySelector('#music-queue-toggle'),
  getState:getMusicQueueState,onPlay:track=>playMusicTrack(track),onRemove:removeMusicQueueTrack,art:musicTrackArt,
  onLayout:()=>{const panel=document.querySelector('#music-queue-panel');document.querySelector('.workspace-main').style.setProperty('--music-queue-height',(panel.hidden?0:panel.getBoundingClientRect().height)+'px');}});

for (const view of ["threads", "hubpedia", "articles", "market"]) {
  const form = document.querySelector(`#${view}-search`);
  const input = document.querySelector(`#${view}-query`);
  if (form && input) {
    bindSearchInput(input, { form, search: query => loadCatalog(view, query), invalidate: () => {
      catalogSearches.get(view)?.invalidate();
      document.querySelector(`#${view}-results`).replaceChildren();
      document.querySelector(`#${view}-state`).textContent = "検索語を入力中…";
    }});
  }
}

bindSearchInput(document.querySelector("#music-catalog-query"), {form: document.querySelector("#music-catalog-search"), search: query => loadCatalog("music", query), invalidate: () => catalogSearches.get("music")?.invalidate()});

// --- EC（Commerce） ---
// 商品・注文作成・入金照合はCommerceが持つ。配送先の確認だけIdentityへ行き、
// 署名済みの確認情報（assertion）だけが戻る。宛先・鍵はこの窓にも来ない。
let marketBrowse = null; // createMarketBrowse（後ろで作る）。作る前に呼ばれても何もしない。
const marketView = { tree: null };
const SHOP_CART_KEY = "hub.desktop.shop-cart.v1";
const SHOP_CART_PRODUCTS_KEY = "hub.desktop.shop-cart-products.v1";
const SHOP_ORDERS_KEY = "hub.desktop.shop-orders.v1";
const shop = {
  products: [], // 読み込み済み全件（カート解決用）。visibleが表示対象。
  visible: [], // 現在の検索・絞り込み結果（サーバー側で算出）
  otherProducts: [], // Commerceのデジタル・店頭受取。この画面のカートには入れず、Webで購入する。
  query: "",
  sort: "new", // new | price_asc | price_desc。並べ替え・絞り込みはサーバー側。
  inStock: false,
  freeShipping: false,
  nextCursor: null,
  assets: [],
  paymentsEnabled: false,
  cart: {}, // productId -> quantity
  cartProducts: {}, // カート表示用の公開商品情報。価格は確定額ではない。
  assertions: {}, // productId -> fulfillment assertion（5分で切れる）
  zones: {}, // productId -> destinationZone
  orders: [], // 端末ローカルの注文レシート
  prepared: null, // { lines: [{product, quantity, order}], asset }
  sellerFilter: null, // { id, name } — 店舗名を押すとその店の商品だけに絞る
  busy: false,
  localFailed: false,
  loadError: "",
};

function shopLoad() {
  try {
    shop.cart = JSON.parse(localStorage.getItem(SHOP_CART_KEY) ?? "{}");
    shop.cartProducts = JSON.parse(localStorage.getItem(SHOP_CART_PRODUCTS_KEY) ?? "{}");
    if (!shop.cartProducts || typeof shop.cartProducts !== "object" || Array.isArray(shop.cartProducts)) shop.cartProducts = {};
    shop.orders = JSON.parse(localStorage.getItem(SHOP_ORDERS_KEY) ?? "[]");
  } catch { /* 壊れていたら空から始める */ }
}
function shopSave() {
  localStorage.setItem(SHOP_CART_KEY, JSON.stringify(shop.cart));
  localStorage.setItem(SHOP_CART_PRODUCTS_KEY, JSON.stringify(shop.cartProducts));
  let resolved = 0;
  localStorage.setItem(SHOP_ORDERS_KEY, JSON.stringify(shop.orders.filter((receipt) => ["status_pending", "wallet_unknown"].includes(receipt.status) || resolved++ < 50)));
}
function shopTokenKey(orderId) { return `hub.desktop.shop-order-token.${orderId}`; }
function shopToken(orderId) { return sessionStorage.getItem(shopTokenKey(orderId)); }

function mergeShopProducts(products) {
  const known = new Set(shop.products.map((p) => p.id));
  shop.products.push(...products.filter((p) => !known.has(p.id)));
}

async function fetchShopCatalog(before) {
  const data = await invoke("commerce_catalog", {
    query: shop.query,
    sellerId: shop.sellerFilter?.id ?? null,
    before: before ?? null,
    sort: shop.sort,
    inStock: shop.inStock ? true : null,
    freeShipping: shop.freeShipping ? true : null,
  });
  const listed = (data?.products ?? []).filter(
    (p) => ["seller_shipping", "platform_3pl"].includes(p.fulfillmentType) && (p.stockQuantity ?? 0) > 0,
  );
  const others = (data?.products ?? []).filter((p) => ["digital", "pickup"].includes(p.fulfillmentType));
  return { data, listed, others, nextCursor: data?.nextCursor ?? null };
}

let shopLoadVersion = 0,shopVisibleKey='',shopRecoveryKey='',shopLoadFailed=false;
const shopViewKey=()=>JSON.stringify([desktopAccount.state,desktopAccount.deviceId,shop.query,shop.sellerFilter?.id,shop.sort,shop.inStock,shop.freeShipping]);
const shopRecovery=createReadRecovery({retry:()=>loadShop({automatic:true}),active:()=>document.querySelector('#view-market')?.classList.contains('on')&&shopLoadFailed&&shopRecoveryKey===shopViewKey()});
window.addEventListener('pagehide',()=>{shopLoadVersion++;shopRecovery.reset();},{once:true});
window.addEventListener('hub-account-changed',()=>{shopVisibleKey='';shopLoadVersion++;shopRecovery.reset();shop.visible=[];shop.otherProducts=[];shop.catalogStale=true;shop.paymentsEnabled=false;document.querySelector('#shop-results')?.replaceChildren();if(document.querySelector('#view-market')?.classList.contains('on'))marketBrowse?.reload();});
function showShopPartialFailure(state) {
  const message = document.createElement("span");
  message.textContent = `${shop.loadError}${shop.visible.length || shop.otherProducts.length ? "取得できた商品だけを表示しています。" : "再試行して一覧を確認してください。"}`;
  state.classList.add("is-partial");
  state.replaceChildren(message, retryButton(() => loadShop()));
}

async function loadShop({automatic=false}={}) {
  if(!automatic)shopRecovery.reset();
  const key=shopViewKey(),retained=shopVisibleKey===key;shopRecoveryKey=key;shopLoadFailed=false;
  const state = document.querySelector("#shop-state");
  const target = document.querySelector("#shop-results");
  if (!state || !target) return;
  const version = ++shopLoadVersion;
  const current=()=>version===shopLoadVersion&&key===shopViewKey();
  shop.busy=true;shop.catalogStale=true;shop.paymentsEnabled=false;
  if(!retained){shopVisibleKey='';
  shop.visible = [];
  shop.otherProducts = [];
  shop.nextCursor = null;
  shop.localFailed = false;
  }
  state.classList.remove("is-partial");
  state.textContent = "商品を読み込んでいます…";
  if(retained){state.textContent='商品を更新しています。前回の表示を残しています。';renderShopResults();}
  else target.replaceChildren(skeletonResult(), skeletonResult());
  try {
    // 商品はCommerceだけ（Hubのウェブのマーケットと同じ。外部ショップの商品は扱わない）。
    const [local] = await Promise.allSettled([settleWithin(fetchShopCatalog(null))]);
    if (!current()) return;
    const failures=local.status==='rejected'?[local.reason]:[];
    if(local.status==='rejected'&&isReadAccessDenied(local.reason))throw local.reason;
    const transient=failures.find(isTransientReadError);shopLoadFailed=!!transient;
    const waiting=transient&&shopRecovery.schedule(transient);
    if(!failures.length){shopRecovery.reset();shopVisibleKey=key;}
    const { data, listed, others, nextCursor } = local.status === "fulfilled" ? local.value : { data: null, listed: retained?shop.visible:[], others: retained?shop.otherProducts:[], nextCursor: null };
    shop.products = listed;
    shop.visible = listed;
    shop.otherProducts = others;
    shop.nextCursor = nextCursor;
    if(!failures.length||shop.visible.length||shop.otherProducts.length)shopVisibleKey=key;
    shop.localFailed = local.status === "rejected";
    shop.loadError = shop.localFailed ? "商品を読み込めませんでした。" : "";
    shop.assets = data?.paymentAssets ?? [];
    shop.catalogStale=local.status!=="fulfilled";
    shop.paymentsEnabled = !shop.catalogStale&&data?.paymentsEnabled === true;
    shop.busy = false;
    state.textContent = shop.loadError || (shop.localFailed || shop.paymentsEnabled ? "" : "現在は決済メンテナンス中です。商品は確認できます。");
    renderShopResults();
    if (shop.loadError && !target.querySelector(".shop-error-panel")) showShopPartialFailure(state);
    if(waiting){state.textContent=readWaitText(transient);if(!shop.visible.length&&!shop.otherProducts.length)target.replaceChildren(statePanel('clock','Hubへの接続を待っています',readWaitText(transient)));}
    if(retained&&failures.length){const message=document.createElement('span');message.textContent=(waiting?readWaitText(transient):'商品を更新できませんでした。')+' 前回の表示を含んでいます。価格・在庫は再確認が必要です。';state.replaceChildren(message,retryButton(()=>loadShop()));}
    updateCartBadge();
  } catch (error) {
    if (!current()) return;
    shopLoadFailed=isTransientReadError(error);const waiting=shopRecovery.schedule(error);
    if(retained&&!isReadAccessDenied(error)){shop.busy=false;renderShopResults();state.textContent=(waiting?readWaitText(error):friendlyError(error))+' 前回の表示を残しています。';return;}
    shopVisibleKey='';
    shop.visible = [];
    shop.otherProducts = [];
    shop.localFailed = true;
    shop.busy = false;
    shop.loadError = friendlyError(error);
    state.classList.remove("is-partial");
    state.textContent = shop.loadError;
    renderShopResults();
  }
}

// 検索・絞り込みはサーバー側。ローカルフィルターでは未読込の頁が対象外になる。
let shopSearchTimer = null;
function searchShop(query) {
  shop.query = query.trim();
  shopLoadVersion++;
  shop.busy = true;
  shop.nextCursor = null;
  document.querySelector("#shop-results").replaceChildren();
  document.querySelector("#shop-state").textContent = "検索しています…";
  if (shopSearchTimer) window.clearTimeout(shopSearchTimer);
  shopSearchTimer = window.setTimeout(() => {
    void loadShop();
  }, 250);
}

function loadMoreShop() {
  if (shop.busy||shop.catalogStale||!shop.nextCursor) return;
  const cursor = shop.nextCursor;
  const version = shopLoadVersion;
  shop.nextCursor = null;
  void fetchShopCatalog(cursor)
    .then(({ listed, others, nextCursor }) => {
      if (version !== shopLoadVersion) return;
      mergeShopProducts(listed);
      const knownOthers = new Set(shop.otherProducts.map((p) => p.id));
      shop.otherProducts.push(...others.filter((p) => !knownOthers.has(p.id)));
      const known = new Set(shop.visible.map((p) => p.id));
      shop.visible.push(...listed.filter((p) => !known.has(p.id)));
      shop.nextCursor = nextCursor;
      renderShopResults();
    })
    .catch(() => {
      if (version !== shopLoadVersion) return;
      shop.nextCursor = cursor;
      const state = document.querySelector("#shop-state");
      if (state) { state.classList.remove("is-partial"); state.textContent = "商品の続きを読み込めませんでした。"; }
      renderShopResults();
    });
}

async function addShopProduct(product, verifiedScope) {
  const current=()=>verifiedScope?.()===true || !verifiedScope&&!shop.catalogStale;
  if (!current() || shopCartLocked() || shop.cart[product.id] || !(await discardPrepared())) return false;
  if (!current() || shopCartLocked()) return false;
  shop.cart[product.id] = 1;
  shop.cartProducts[product.id] = cartProductSnapshot(product);
  shopSave();
  updateCartBadge();
  renderShopResults();
  return true;
}

function shopAddButton(product) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "approve";
  button.textContent = shop.cart[product.id] ? "カートに追加済み" : "カートに追加";
  button.disabled = shop.catalogStale || shopCartLocked() || Boolean(shop.cart[product.id]);
  button.onclick = async (event) => {
    event.stopPropagation();
    if (!(await addShopProduct(product))) return;
    button.textContent = "カートに追加済み";
    button.disabled = true;
  };
  return button;
}

// 総額表示。Commerceが税率を確定できた商品は税込を大きく、本体価格を小さく出す。確定できない商品は本体価格と「税は注文時に確定」。
function shopTax(product) {
  const t = product?.taxIncluded;
  return t && t.status === "determined" && Number.isFinite(t.priceJpyc) ? t : null;
}
function shopPriceLine(product) {
  const line = document.createElement("p");
  line.className = "shop-product-meta";
  const amount = document.createElement("strong");
  const tax = document.createElement("span");
  tax.className = "shop-tax";
  const t = shopTax(product);
  if (t) {
    amount.textContent = `${t.priceJpyc.toLocaleString()} JPYC（税込）`;
    tax.textContent = Number.isFinite(product.priceJpyc) ? `本体 ${product.priceJpyc.toLocaleString()} JPYC` : "";
  } else {
    amount.textContent = Number.isFinite(product.priceJpyc) ? `${product.priceJpyc.toLocaleString()} JPYC` : "価格は詳細で確認";
    tax.textContent = Number.isFinite(product.priceJpyc) ? "税は注文時に確定" : "";
  }
  line.append(amount);
  if (tax.textContent) line.append(tax);
  return line;
}
function shopShippingText(product) {
  if (product.shippingJpyc == null) return "送料は注文時に確認";
  if (product.shippingJpyc === 0) return "送料無料";
  const t = shopTax(product);
  return t && Number.isFinite(t.shippingJpyc) ? `送料 ${t.shippingJpyc.toLocaleString()} JPYC（税込）` : `送料 ${product.shippingJpyc.toLocaleString()} JPYC`;
}
function shopStockText(product) {
  const stock = product.stockQuantity;
  if (stock == null) return "";
  if (stock <= 0) return "在庫なし";
  return stock <= 3 ? `残り${stock}点` : "在庫あり";
}
function shopSubLine(product) {
  const line = document.createElement("p");
  line.className = "shop-product-sub";
  const shipping = document.createElement("span");
  shipping.textContent = shopShippingText(product);
  line.append(shipping);
  const stockText = shopStockText(product);
  if (stockText) {
    const stock = document.createElement("span");
    stock.textContent = stockText;
    if (product.stockQuantity <= 3) stock.className = "is-low";
    line.append(stock);
  }
  return line;
}
function renderShopCount() {
  const count = document.querySelector("#shop-count");
  if (!count) return;
  const n = shop.visible.length + (shop.sellerFilter ? 0 : shop.otherProducts.length);
  count.textContent = n ? `${n.toLocaleString()}件${shop.nextCursor ? "以上" : ""}` : "";
}

function renderShopResults() {
  const target = document.querySelector("#shop-results");
  if (!target) return;
  renderShopCount();
  const items = shop.visible;
  const others = shop.otherProducts;
  const filterNote = document.querySelector("#shop-filter");
  if (filterNote) {
    filterNote.hidden = !shop.sellerFilter;
    filterNote.replaceChildren();
    if (shop.sellerFilter) {
      const label = document.createElement("span");
      label.textContent = `${shop.sellerFilter.name}の商品 `;
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "head-action";
      clear.textContent = "フィルターを解除";
      clear.onclick = () => { shop.sellerFilter = null; searchShop(shop.query); };
      filterNote.append(label, clear);
    }
  }
  if (!items.length && !others.length) {
    if (shop.busy) return;
    if (shop.localFailed) {
      const error = statePanel("search", shop.loadError || "商品を読み込めませんでした",
        "接続を確認", () => loadShop());
      error.classList.add("shop-error-panel");
      target.replaceChildren(error);
      const state = document.querySelector("#shop-state");
      state.classList.remove("is-partial");
      state.textContent = "";
      return;
    }
    target.replaceChildren(statePanel("search",
      shop.query ? `「${shop.query}」は見つかりません` : shop.sellerFilter ? "この店舗の商品はありません" : "商品はまだありません",
      shop.query ? "別のキーワードを試してください。" : shop.sellerFilter ? "フィルターを解除すると全商品に戻ります。" : "販売者が商品を登録すると、ここに表示されます。"));
    return;
  }
  // 札は絵・名前・店・価格・送料と在庫だけ。説明は詳細で読む（一覧で3行ずつ並べると比べにくい）。
  const localCards = items.map((p) => {
    const card = catalogCard({
      title: p.title,
      imageUrl: p.imageUrl,
      onOpen: () => void openDetail("commerce_product", [p.id], { local: true, data: p, title: "商品詳細" }),
    });
    card.classList.add("shop-product-card");
    if (!p.imageUrl) card.prepend(shopPlaceholderMedia(p.seller?.publicName ?? p.title));
    card.setAttribute("aria-label", `${p.title}の詳細を見る`);
    const sellerLink = shopSellerLink(p);
    if (sellerLink) card.append(sellerLink);
    card.append(shopPriceLine(p), shopSubLine(p));
    const actions = document.createElement("div");
    actions.className = "shop-card-actions";
    actions.append(shopAddButton(p));
    card.append(actions);
    return card;
  });
  // デジタル・店頭受取はこの画面のカートでは買えない。Hubのウェブのマーケットで購入する。
  const otherCards = shop.sellerFilter ? [] : others.map((p) => {
    const kind = p.fulfillmentType === "digital" ? "デジタル" : "店頭受取";
    const card = catalogCard({
      title: p.title,
      imageUrl: p.imageUrl,
      meta: [kind, p.seller?.publicName],
      onOpen: () => void openHubWebPath(p.fulfillmentType === "digital" ? "/v2/market/digital" : "/v2/market/products"),
    });
    card.classList.add("shop-product-card");
    if (!p.imageUrl) card.prepend(shopPlaceholderMedia(p.seller?.publicName ?? p.title));
    card.setAttribute("aria-label", `${p.title}をWebのマーケットで見る`);
    card.append(shopPriceLine(p));
    const actions = document.createElement("div");
    actions.className = "shop-card-actions";
    const hint = document.createElement("span");
    hint.className = "shop-web-hint";
    hint.textContent = "Webで買う ↗";
    actions.append(hint);
    card.append(actions);
    return card;
  });
  target.replaceChildren(...localCards, ...otherCards);
  if (shop.nextCursor) {
    const more = document.createElement("div");
    more.className = "actions";
    more.append(actionButton("さらに表示", "ghost", loadMoreShop));
    target.append(more);
  }
}

// ランキングとサービスの詳細。一覧（hub_resource rankings / hub_client services）で読んだ項目をそのまま見せる。
// 順位・参加者・ウォレット確認・サービスの登録は Hub のウェブにしか無いので、「ウェブで開く」は既定のブラウザへ（open_external）。
function factRows(rows) {
  const list = document.createElement("dl");
  list.className = "fact-rows";
  for (const [label, value] of rows) {
    if (value === undefined || value === null || value === "") continue;
    const row = document.createElement("div");
    row.className = "fact-row";
    const term = document.createElement("dt");
    term.textContent = label;
    const desc = document.createElement("dd");
    if (value instanceof Node) desc.append(value); else desc.textContent = String(value);
    row.append(term, desc);
    list.append(row);
  }
  return list;
}
function detailLede(text) {
  const node = document.createElement("p");
  node.className = "detail-lede";
  node.textContent = text;
  return node;
}
function webOpenRow(label, path, note) {
  const row = document.createElement("div");
  row.className = "detail-web-open";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "head-action";
  button.textContent = label;
  button.onclick = () => void openHubWebPath(path);
  const hint = document.createElement("p");
  hint.className = "meta";
  hint.textContent = note;
  row.append(button, hint);
  return row;
}
function renderRankingDetail(target, data, entry) {
  const ranking = data ?? {};
  const address = document.createElement("code");
  address.textContent = typeof ranking.contractAddress === "string" ? ranking.contractAddress : "";
  address.title = address.textContent;
  const holders = Number.isSafeInteger(ranking.holderCount) ? `${ranking.holderCount.toLocaleString("ja-JP")}人` : "";
  const synced = ranking.lastSyncedAt ? relTime(ranking.lastSyncedAt) : "";
  target.replaceChildren(
    detailLede(ranking.description || `${ranking.symbol || "トークン"} の公開残高ランキングです。`),
    factRows([["シンボル", ranking.symbol], ["ネットワーク", ranking.network], ["保有者", holders],
      ["確認", RANKING_VERIFY[ranking.verificationStatus]], ["コントラクト", address.textContent ? address : ""], ["最終更新", synced]]),
    webOpenRow("ウェブで順位と参加者を見る", `/v2/token?ranking=${encodeURIComponent(ranking.id ?? entry.ids[0])}`,
      "順位、参加者、ウォレットの確認と貢献は Hub のウェブで行います。ここには概要だけを表示します。"));
}
function renderServiceDetail(target, data, entry) {
  const service = data ?? {};
  const capability = [service.capabilityName, service.capabilityDescription].filter(Boolean).join(" — ");
  const cost = { free: "無料", paid: "有料", mixed: "一部有料" }[service.costMode] ?? service.costMode;
  const updated = service.updatedAt ? relTime(service.updatedAt) : "";
  target.replaceChildren(
    detailLede(service.description || "説明はまだありません。"),
    factRows([["サービス名", service.serviceName], ["状態", SERVICE_STATUS[service.status] ?? service.status], ["機能", capability],
      ["呼び出し", service.httpMethod], ["費用", cost], ["実行前の確認", service.humanApproval === true ? "あなたの承認が必要" : service.humanApproval === false ? "不要" : ""],
      ["ホームページ", service.homepageUrl], ["プライバシー", service.privacyUrl], ["利用規約", service.termsUrl], ["更新", updated]]),
    webOpenRow("ウェブでサービスを管理", "/v2/services", "サービスの登録・審査の依頼・取り下げは Hub のウェブで行います。"));
}

// Hubのウェブのマーケットだけにある面（デジタル・予約とチケット・仕事）は既定のブラウザで開く。
async function openHubWebPath(path) {
  try { await invoke("open_external", { url: new URL(path, await invoke("hub_origin")).href }); }
  catch (error) { showNotice(friendlyError(error)); }
}

// 予約・チケット。Hubのウェブのマーケットと同じ /api/market/tickets を読む。購入はウェブで行う。
let marketTicketsBusy = false;
function marketTicketCard(event) {
  const prices = (Array.isArray(event.ticketTypes) ? event.ticketTypes : [])
    .filter((type) => type?.currency === "JPY" && Number.isFinite(type.priceMinor)).map((type) => type.priceMinor);
  const starts = Date.parse(event.startsAt);
  return catalogCard({
    title: event.title,
    body: event.summary,
    meta: [event.venueName, Number.isFinite(starts) ? new Date(starts).toLocaleDateString("ja-JP") : "", prices.length ? `¥${Math.min(...prices).toLocaleString()}〜` : ""],
    onOpen: () => void openHubWebPath("/v2/market/tickets"),
  });
}
async function loadMarketTickets() {
  const host = document.querySelector("#market-tickets"), state = document.querySelector("#market-tickets-state");
  if (!host || !state || marketTicketsBusy) return;
  marketTicketsBusy = true;
  state.textContent = "予約・チケットを読み込んでいます…";
  try {
    const data = await settleWithin(invoke("hub_resource", { resource: "market_tickets", query: "" }));
    const events = (Array.isArray(data?.events) ? data.events : []).filter((event) => event && typeof event.title === "string");
    host.replaceChildren(...events.map(marketTicketCard));
    state.textContent = events.length ? "" : "販売中の予約・チケットはまだありません";
  } catch (error) {
    state.textContent = friendlyError(error);
  } finally {
    marketTicketsBusy = false;
  }
}
for (const button of document.querySelectorAll("[data-market-web]")) button.onclick = () => void openHubWebPath(button.dataset.marketWeb);

// 絵の無い商品は、店（無ければ商品名）の頭字と、買い物袋の記号で出す。
function shopPlaceholderMedia(label) {
  const media = document.createElement("div");
  media.className = "result-media is-placeholder";
  media.setAttribute("aria-hidden", "true");
  const initial = document.createElement("span");
  initial.className = "shop-initial";
  initial.textContent = [...String(label ?? "").trim()][0]?.toUpperCase() ?? "";
  media.append(initial);
  const glyph = document.createElement("span");
  glyph.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8h12l-1 12H7L6 8Z"/><path d="M9 8V7a3 3 0 0 1 6 0v1"/></svg>';
  media.append(glyph.firstElementChild);
  return media;
}

function renderCommerceProductDetail(target, product, entry) {
  // 見せ方は market-product.mjs。購入は既存のカート→カート画面の既存の道だけ（新しい購入の道は作らない）。
  const item = normalizeProduct(product);
  if (!item) { target.replaceChildren(); return; }
  const page = createMarketProductPage({
    document, host: target,
    deps: {
      asset: hubAsset,
      addToCart: async (picked, quantity) => {
        const ok = await addShopProduct(picked.raw);
        if (ok && quantity > 1) { shop.cart[picked.id] = Math.min(20, quantity); shopSave(); updateCartBadge(); }
        page.refresh({ inCart: Boolean(shop.cart[picked.id]) });
        return ok;
      },
      goCheckout: () => { detailTrail = []; document.querySelector("#market-cart-open")?.click(); },
      openWeb: (path) => void openHubWebPath(path),
      openSeller: (seller) => { detailTrail = []; filterMarketSeller(seller); },
      openProfile: (handle) => void openDetail("profile", [handle], { title: handle }),
      openLegal: (url) => enterBrowser(url),
      openItem: (picked) => void openDetail("commerce_product", [picked.id], { local: true, data: picked.raw, title: "商品詳細" }),
    },
  });
  page.show(item, {
    inCart: Boolean(shop.cart[item.id]),
    paymentsEnabled: shop.paymentsEnabled,
    related: (marketBrowse?.loadedProducts() ?? []).filter((other) => other.id !== item.id && other.seller?.id && other.seller.id === item.seller?.id),
  });
}

// 店舗を選ぶと、その店の商品だけの一覧に切り替える（解除は一覧の上の行から）。
function filterMarketSeller(seller) {
  shop.sellerFilter = { id: seller.id, name: seller.publicName ?? "店舗" };
  document.querySelector('.nav-item[data-view="market"]')?.click();
  marketBrowse?.setCategory("all");
  marketBrowse?.reload();
}

// 店舗名を押すとその店の商品だけに絞る。
function shopSellerLink(product) {
  if (!product.seller?.id) return null;
  const link = document.createElement("button");
  link.type = "button";
  link.className = "seller-link";
  link.textContent = product.seller.publicName ?? "店舗";
  link.title = "この店舗の商品だけ見る";
  link.onclick = (event) => {
    event.stopPropagation();
    shop.sellerFilter = { id: product.seller.id, name: product.seller.publicName ?? "店舗" };
    searchShop(shop.query);
  };
  return link;
}

function updateCartBadge() {
  const count = Object.values(shop.cart).reduce((n, q) => n + q, 0);
  const button = document.querySelector("#market-cart-open");
  if (button) button.textContent = count ? `カート（${count}）` : "カート";
  for (const item of document.querySelectorAll("#sidebar-context .sidebar-cart")) item.textContent = button?.textContent || "カート";
  marketView.tree?.setCount(count);
}

function cartProductSnapshot(product) {
  return {
    id: product.id,
    title: product.title,
    imageUrl: product.imageUrl ?? null,
    priceJpyc: product.priceJpyc,
    shippingJpyc: product.shippingJpyc,
    taxIncluded: product.taxIncluded ?? null,
    stockQuantity: product.stockQuantity,
    fulfillmentType: product.fulfillmentType,
    checkoutRecovered: product.checkoutRecovered === true,
    seller: product.seller && {
      publicName: product.seller.publicName,
      legalDisplayUrl: product.seller.legalDisplayUrl,
    },
  };
}

function cartLines() {
  return Object.entries(shop.cart)
    .map(([id, quantity]) => {
      const current = shop.products.find((p) => p.id === id);
      const product = current ?? shop.cartProducts[id];
      return { id, product, quantity, saved: !current };
    })
    .filter(({ id, product }) => product?.id === id && typeof product.title === "string" && Number.isFinite(product.priceJpyc));
}

async function renderCart() {
  if (!checkoutBusy) await refreshCheckoutPending();
  const state = document.querySelector("#cart-state");
  const lines = document.querySelector("#cart-lines");
  const summary = document.querySelector("#cart-summary");
  const review = document.querySelector("#cart-review");
  if (!state || !lines || !summary) return;
  lines.replaceChildren();
  renderCartReview();
  const entries = cartLines();
  const missingIds = Object.keys(shop.cart).filter((id) => !entries.some(({ product }) => product.id === id));
  summary.hidden = (!entries.length || missingIds.length > 0) && !checkoutRequests.length && !checkoutAttempt && !shop.prepared && !checkoutPendingError && !checkoutFinishError;
  if (shop.prepared) state.textContent = shop.prepared.message;
  if (missingIds.length) {
    state.textContent = `${missingIds.length}件の商品情報を表示できません。削除して商品一覧から追加し直してください。`;
    const removeMissing = document.createElement("button");
    removeMissing.type = "button";
    removeMissing.className = "head-action";
    removeMissing.textContent = "表示できない商品を削除";
    removeMissing.onclick = async () => {
      if (shopCartLocked() || !(await discardPrepared())) return;
      if (shopCartLocked()) return;
      for (const id of missingIds) { delete shop.cart[id]; delete shop.cartProducts[id]; }
      shopSave();
      updateCartBadge();
      void renderCart();
    };
    state.append(" ", removeMissing);
  }
  if (!entries.length) {
    if (!missingIds.length) lines.replaceChildren(emptyState("cart", "カートは空です", "マーケットで商品を追加するとここに出ます。"));
    document.querySelector("#cart-totals").replaceChildren();
    syncCartControls();
    return;
  }
  // 行の見せ方は market-me.mjs。数量・削除・配送先の確認は既存の道（この関数の外のハンドラ）のまま。
  const cartLineExtra = ({ product }) => {
    const wrap = document.createElement("div");
      const fulfill = document.createElement("div");
      fulfill.className = "actions";
      const zone = shop.zones[product.id];
      if (shop.assertions[product.id]) {
        const ok = document.createElement("p");
        ok.className = "meta";
        ok.textContent = `配送先を確認済み${zone ? `（${zone}宛）` : ""}・確認情報は5分間有効です`;
        const again = document.createElement("button");
        again.type = "button";
        again.className = "head-action";
        again.textContent = "再確認";
        again.onclick = () => void confirmFulfillment(product);
        fulfill.append(ok, again);
      } else {
        const note = document.createElement("p");
        note.className = "meta";
        note.textContent = "配送先はIdentityで安全に確認します。氏名・住所はこの端末にもHubにも保存されません。";
        const confirm = document.createElement("button");
        confirm.type = "button";
        confirm.className = "approve";
        confirm.textContent = "配送先を確認";
        confirm.onclick = () => void confirmFulfillment(product);
        fulfill.append(note, confirm);
      }

    if (product.seller?.legalDisplayUrl) {
      const legal = document.createElement("button");
      legal.type = "button";
      legal.className = "seller-link";
      legal.textContent = "販売条件・返品";
      legal.onclick = () => void invoke("open_external", { url: product.seller.legalDisplayUrl }).catch(() => undefined);
      wrap.append(legal);
    }
    wrap.append(fulfill);
    return wrap;
  };
  const removeCartLine = async (id) => {
    if (shopCartLocked() || !(await discardPrepared())) return;
    if (shopCartLocked()) return;
    delete shop.cart[id];
    delete shop.cartProducts[id];
    delete shop.assertions[id];
    delete shop.zones[id];
    shopSave();
    updateCartBadge();
    void renderCart();
  };
  renderCartRows({
    document, host: lines, lines: entries, showTotals: false,
    deps: {
      asset: hubAsset, locked: shopCartLocked,
      openItem: (id) => { const found = entries.find((entry) => entry.id === id); if (found) void openDetail("commerce_product", [id], { local: true, data: { ...found.product, id }, title: "商品詳細" }); },
      setQuantity: async (id, next) => {
        if (shopCartLocked() || !(await discardPrepared())) return;
        if (shopCartLocked()) return;
        shop.cart[id] = Math.max(1, Math.min(20, next));
        shopSave();
        updateCartBadge();
        void renderCart();
      },
      remove: removeCartLine,
      checkout: () => document.querySelector("#cart-checkout")?.click(),
      browse: () => document.querySelector('.nav-item[data-view="market"]')?.click(),
      lineExtra: cartLineExtra,
    },
  });
  renderCartSummary(entries);
  syncCartControls();
}

// カートの目安。税込の単価が分かる行は税込、分からない行は本体価格で足す。
function shopCartUnit(product) {
  const t = product?.taxIncluded?.status === "determined" && Number.isFinite(product.taxIncluded.priceJpyc) ? product.taxIncluded : null;
  return {
    unit: t ? t.priceJpyc : product.priceJpyc,
    ship: product.shippingJpyc == null ? null : (t && Number.isFinite(t.shippingJpyc) ? t.shippingJpyc : product.shippingJpyc),
    taxed: Boolean(t),
  };
}
function renderCartSummary(entries) {
  const totals = document.querySelector("#cart-totals");
  const asset = document.querySelector("#cart-asset");
  if (!totals || !asset) return;
  const subtotal = entries.reduce((sum, { product, quantity }) => {
    const u = shopCartUnit(product);
    return sum + u.unit * quantity + (u.ship ?? 0);
  }, 0);
  totals.innerHTML = "";
  const list = document.createElement("dl");
  const row = (dt, dd) => {
    const a = document.createElement("dt");
    const b = document.createElement("dd");
    a.textContent = dt;
    b.textContent = dd;
    const div = document.createElement("div");
    div.append(a, b);
    list.append(div);
  };
  const shippingPending = entries.some(({ product }) => product.shippingJpyc === null);
  row(shippingPending ? "商品・確認済み送料（税込・目安）" : "商品・送料（税込・目安）",
    `${subtotal.toLocaleString()} JPYC${shippingPending ? " ＋ 未確定送料（注文時に確認）" : ""}`);
  row("税", "確定額は注文時にCommerceが表示");
  row("Hub手数料", "販売者負担・本体価格の1%（消費税込み）");
  totals.append(list);
  const selection = shop.prepared ?? checkoutSelection;
  const previous = selection ? `${selection.asset.chainId}:${selection.asset.currency}` : asset.value;
  const assets = selection ? [selection.asset, ...shop.assets.filter((item) => `${item.chainId}:${item.currency}` !== previous)] : shop.assets;
  asset.replaceChildren(...assets.map((a) => {
    const option = document.createElement("option");
    option.value = `${a.chainId}:${a.currency}`;
    option.textContent = `${a.currency}（${a.chainName}）`;
    return option;
  }));
  if (assets.some((a) => `${a.chainId}:${a.currency}` === previous)) asset.value = previous;
  else if (shop.assets.length === 1) asset.value = `${shop.assets[0].chainId}:${shop.assets[0].currency}`;
}

let checkoutBusy = false;
let checkoutSelection = null;
let checkoutRequests = [], checkoutPendingReady = false, checkoutPendingError = "", checkoutPendingGeneration = 0;
let checkoutAttempt = null;
let checkoutFinishError = "";
const checkoutId = (id) => typeof id === "string" && /^[^\s\u0000-\u001f\u007f-\u009f]{1,200}$/u.test(id);
const checkoutUuid = (id) => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
const checkoutTerminal = new Set(["submitted", "paid", "partially_refunded", "refunded", "payment_failed", "expired", "cancelled"]);
function checkoutError(error) {
  const code = String(error?.message ?? error);
  if (code === "checkout_binding_mismatch") return "保存した注文のウォレットまたは接続先が現在の設定と一致しません。元の設定で確認してください。";
  if (code === "checkout_store_limit") return "未確認の注文が保存上限に達しました。保存した注文の状態を先に確認してください。";
  if (code === "checkout_pending_exists") return "この商品の保存済み注文が見つかりました。元の保存済み注文を選んで確認してください。";
  if (["checkout_store_unavailable", "checkout_store_invalid"].includes(code)) return "保存した注文を読み書きできません。新しい注文を作らず、状態の取得をやり直してください。";
  if (["checkout_response_invalid", "checkout_request_conflict"].includes(code)) return "保存した注文と応答が一致しません。新しい注文や支払いを行わず、注文の状態を確認してください。";
  return "注文作成の結果を確認できません。保存した注文を明示的に確認してください。新しい注文や支払いは行っていません。";
}
async function refreshCheckoutPending() {
  const generation = ++checkoutPendingGeneration;
  checkoutPendingReady = false;
  try {
    const body = await invoke("commerce_checkout_pending", {});
    const requests = body?.requests;
    if (!Array.isArray(requests) || requests.length > 20 || new Set(requests.map((item) => item?.operationId)).size !== requests.length
        || requests.some((item) => !item || Object.keys(item).length !== 7 || Object.keys(item).some((key) => !["operationId", "productId", "quantity", "billingCountry", "paymentCurrency", "paymentChainId", "orderId"].includes(key))
          || !checkoutUuid(item.operationId) || !checkoutId(item.productId) || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 20
          || !/^[A-Z]{2}$/.test(item.billingCountry) || typeof item.paymentCurrency !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(item.paymentCurrency)
          || !Number.isSafeInteger(item.paymentChainId) || item.paymentChainId < 1 || item.orderId !== null && !checkoutId(item.orderId))) throw new Error("checkout_store_invalid");
    if (generation !== checkoutPendingGeneration) return false;
    checkoutRequests = requests.map((item) => ({ ...item }));
    checkoutPendingReady = true; checkoutPendingError = "";
    return true;
  } catch (error) {
    if (generation === checkoutPendingGeneration) checkoutPendingError = checkoutError(error);
    return false;
  }
}
function renderCheckoutPending(review) {
  const requests = checkoutRequests.filter((item) => !shop.prepared?.lines.some((line) => line.operationId === item.operationId));
  if (!checkoutPendingError && !checkoutFinishError && !requests.length && !checkoutAttempt) return;
  review.hidden = false;
  const note = document.createElement("p"); note.className = "meta"; note.setAttribute("role", "status");
  note.textContent = checkoutPendingError || checkoutFinishError || "保存した注文があります。確認操作は元の注文作成結果を復旧します。数量・配送先・資産を変更せず、まだ支払いは行いません。";
  review.append(note);
  if (checkoutPendingError) {
    const retry = document.createElement("button"); retry.type = "button"; retry.className = "head-action"; retry.textContent = "保存した注文を再取得";
    retry.disabled = checkoutBusy;
    retry.onclick = async () => { if (checkoutBusy) return; await refreshCheckoutPending(); syncCartControls(); };
    review.append(retry);
  }
  if (checkoutAttempt) {
    const retry = document.createElement("button"); retry.type = "button"; retry.className = "head-action"; retry.textContent = "保存した注文作成を確認";
    retry.disabled = checkoutBusy || !checkoutPendingReady;
    retry.onclick = () => { if (!checkoutBusy && checkoutPendingReady) void continueCheckoutAttempt(); };
    review.append(retry);
  } else for (const request of requests) {
    const row = document.createElement("p"); row.className = "meta";
    row.textContent = `${shop.cartProducts[request.productId]?.title ?? `商品 ${request.productId}`} × ${request.quantity}（保存した元の数量）`;
    const recover = document.createElement("button"); recover.type = "button"; recover.className = "head-action"; recover.textContent = "注文作成の結果を確認";
    recover.disabled = checkoutBusy || !checkoutPendingReady;
    recover.onclick = () => { if (!checkoutBusy && checkoutPendingReady) void recoverCheckout(request.operationId); };
    row.append(" ", recover); review.append(row);
  }
}
function checkoutOrder(body, entry) {
  const order = body?.order, metadata = entry.metadata;
  if (!order || !checkoutId(order.id) || order.productId !== metadata.productId || order.quantity !== metadata.quantity
      || order.chainId !== metadata.paymentChainId || order.currency !== metadata.paymentCurrency
      || metadata.orderId && order.id !== metadata.orderId) throw new Error("checkout_response_invalid");
  if (body.paymentActionAvailable === false) {
    if (!checkoutTerminal.has(order.status) && order.status !== "confirming") throw new Error("checkout_response_invalid");
    return { order: shopReviewSnapshot(order), statusOnly: true };
  }
  if (order.status !== "awaiting_payment" || !order.escrow || typeof order.accessToken !== "string" || !order.accessToken
      || !Number.isFinite(order.amountJpyc) || order.amountJpyc < 0 || !Number.isFinite(order.taxJpyc) || order.taxJpyc < 0
      || typeof order.paymentAmount !== "string" || order.paymentAmount.length > 128 || !/^(0|[1-9]\d*)(\.\d+)?$/.test(order.paymentAmount)
      || !Number.isFinite(Number(order.paymentAmount)) || typeof order.chainName !== "string" || !order.chainName || order.chainName.length > 100) throw new Error("checkout_response_invalid");
  return { order: shopReviewSnapshot(order), statusOnly: false };
}
async function finishCheckout(operationId) {
  if (!operationId) return;
  try {
    const result = await invoke("commerce_checkout_finish", { operationId });
    if (result?.finished !== true) throw new Error("checkout_not_finished");
    checkoutFinishError = "";
  } catch {
    checkoutFinishError = "注文の状態は確認済みです。保存した作成情報の整理は未完了です。再送金せず、保存した注文の状態を確認してください。";
  }
  await refreshCheckoutPending();
  if (checkoutPendingReady && !checkoutRequests.length) checkoutFinishError = "";
}
async function finishCheckoutForOrder(orderId, operationId) {
  if (!operationId) { await refreshCheckoutPending(); operationId = checkoutRequests.find((request) => request.orderId === orderId)?.operationId; }
  if (operationId) await finishCheckout(operationId);
}
function shopLinePayment(line) {
  const payment = shopPayment.status(line), receipt = shop.orders.find((item) => item.id === line.order.id);
  if (receipt?.status === "wallet_unknown") return { ...payment, attempted: true, unknown: true };
  if (receipt?.transactionHash) return { ...payment, attempted: true, transactionHash: receipt.transactionHash };
  return payment;
}
async function continueCheckoutAttempt() {
  if (checkoutBusy || !checkoutAttempt || !checkoutPendingReady) return;
  const attempt = checkoutAttempt, state = document.querySelector("#cart-state");
  checkoutBusy = true; checkoutSelection = attempt; syncCartControls();
  try {
    for (const entry of attempt.entries.filter((item) => !item.resolved)) {
      state.textContent = `${entry.product.title}の保存した注文作成を確認しています…`;
      const result = checkoutOrder(await invoke("commerce_order_create", { params: entry.params }), entry);
      entry.metadata.orderId ??= result.order.id;
      entry.order = result.order;
      if (typeof result.order.accessToken === "string" && result.order.accessToken) sessionStorage.setItem(shopTokenKey(result.order.id), result.order.accessToken);
      if (result.statusOnly) {
        if (!Number.isFinite(result.order.amountJpyc) || result.order.amountJpyc < 0) throw new Error("checkout_response_invalid");
        const receipt = shop.orders.find((item) => item.id === result.order.id && (item.status === "wallet_unknown" || item.transactionHash));
        if (receipt) { receipt.operationId = entry.operationId; shopSave(); }
        else saveShopReceipt({ product: entry.product, quantity: entry.metadata.quantity, order: result.order, operationId: entry.operationId }, result.order.transactionHash ?? null, result.order.status);
        entry.statusOnly = true;
        if (shop.cart[entry.product.id] === entry.metadata.quantity) {
          delete shop.cart[entry.product.id]; delete shop.cartProducts[entry.product.id]; delete shop.assertions[entry.product.id]; delete shop.zones[entry.product.id];
        }
        shopSave();
        await finishCheckout(entry.operationId);
      }
      entry.resolved = true;
    }
    const lines = attempt.entries.filter((entry) => !entry.statusOnly).map((entry) => ({ product: entry.product, quantity: entry.metadata.quantity, order: entry.order, operationId: entry.operationId }));
    checkoutAttempt = null;
    if (lines.length) {
      for (const line of lines) { shop.cart[line.product.id] = line.quantity; shop.cartProducts[line.product.id] = cartProductSnapshot(line.product); }
      document.querySelector("#cart-country").value = attempt.country;
      shop.prepared = { lines, asset: attempt.asset, country: attempt.country, assetKey: attempt.assetKey, key: "", recovered: attempt.recovered === true,
        message: attempt.recovered ? "選択した保存済み注文の元の数量と支払内容を復旧しました。この注文の内容を確認してから、別の操作で支払いへ進んでください。"
          : "Commerceの確定金額を確認してください。まだ署名・送金は行っていません。" };
      renderCartSummary(cartLines()); shop.prepared.key = shopReviewKey();
      state.textContent = shop.prepared.message;
    } else state.textContent = "保存した注文の状態を確認しました。支払い操作は行っていません。注文詳細を確認してください。";
    shopSave(); updateCartBadge();
    await refreshCheckoutPending();
    await renderCart();
  } catch (error) {
    state.textContent = checkoutError(error);
    const pendingCurrent = await refreshCheckoutPending();
    if (String(error?.message ?? error) === "checkout_pending_exists" && pendingCurrent) checkoutAttempt = null;
    await renderCart();
  } finally { checkoutBusy = false; checkoutSelection = null; syncCartControls(); }
}
async function recoverCheckout(operationId) {
  if (checkoutBusy || !checkoutPendingReady || shop.prepared || checkoutAttempt) return;
  if (!checkoutRequests.some((item) => item.operationId === operationId)) return;
  const entries = checkoutRequests.filter((metadata) => metadata.operationId === operationId).map((metadata) => {
    const publicProduct = shop.products.find((product) => product.id === metadata.productId) ?? shop.cartProducts[metadata.productId];
    const product = shopReviewSnapshot(publicProduct ?? { id: metadata.productId, title: `商品 ${metadata.productId}`, priceJpyc: 0, fulfillmentType: "seller_shipping", checkoutRecovered: true });
    return { product, metadata: { ...metadata }, params: { operationId: metadata.operationId }, operationId: metadata.operationId, resolved: false };
  });
  const first = entries[0].metadata, asset = shop.assets.find((item) => item.chainId === first.paymentChainId && item.currency === first.paymentCurrency)
    ?? { chainId: first.paymentChainId, currency: first.paymentCurrency, chainName: String(first.paymentChainId) };
  checkoutAttempt = { entries, asset: shopReviewSnapshot(asset), country: first.billingCountry, assetKey: `${asset.chainId}:${asset.currency}`, recovered: true };
  await continueCheckoutAttempt();
}

const shopPayment = createShopPayment({ invoke, onSent: (line, transactionHash) => {
  saveShopReceipt(line, transactionHash, "status_pending");
} });
function saveShopReceipt({ product, quantity, order, operationId }, transactionHash, status) {
  shop.orders = [{ id: order.id, productId: product.id, quantity, title: product.title, amountJpyc: order.amountJpyc,
    transactionHash, status, operationId: operationId ?? shop.orders.find((receipt) => receipt.id === order.id)?.operationId ?? null, expiresAt: order.expiresAt ?? null,
    createdAt: shop.orders.find((receipt) => receipt.id === order.id)?.createdAt ?? new Date().toISOString(),
  }, ...shop.orders.filter((receipt) => receipt.id !== order.id)];
  try { shopSave(); } catch { throw new Error("shop_payment_record_failed"); }
}
const shopCartLocked = () => checkoutBusy || shop.busy || Boolean(checkoutAttempt) || Boolean(shop.prepared?.lines.some((line) => !shopPayment.discardable(line) || shopPendingOrder(line.order.id)));
const shopPendingOrder = (orderId) => shop.orders.some((receipt) => receipt.id === orderId && (receipt.status === "wallet_unknown" || receipt.transactionHash))
  || Boolean(shop.prepared?.lines.some((line) => line.order.id === orderId && !shopPayment.discardable(line)));
const shopReviewKey = () => JSON.stringify([cartLines().map(({ product, quantity }) => [cartProductSnapshot(product), quantity, shop.assertions[product.id] ?? null]),
  document.querySelector("#cart-country")?.value.trim().toUpperCase(), document.querySelector("#cart-asset")?.value]);
function shopReviewSnapshot(value) {
  const freeze = (item) => { if (item && typeof item === "object") { Object.values(item).forEach(freeze); Object.freeze(item); } return item; };
  return freeze(JSON.parse(JSON.stringify(value)));
}
function shopPaymentError(error) {
  const text = String(error?.message ?? error);
  const feeCode = typeof error === "string" ? error : error instanceof Error && typeof error.message === "string" ? error.message : "";
  return ({ shop_payment_busy: "支払いの確認中です。完了するまでお待ちください。",
    shop_payment_invalid: "支払内容を確認できません。署名せず、注文の内容を確認してください。",
    shop_payment_expired: "支払い期限が過ぎました。注文の状態を確認してください。",
    shop_payment_unsupported: "この支払い方法はこの端末で利用できません。Webで対応状況を確認してください。",
    shop_payment_unknown: "ウォレット操作の結果を確認できません。再送せず、注文の状態とウォレットの履歴を確認してください。",
    shop_payment_status_mismatch: "注文番号または保存した取引と応答が一致しません。再送せず、注文の状態を確認してください。",
    shop_payment_recovery_unavailable: "保存した取引を照合できません。再送せず、状態の確認をやり直してください。",
    shop_payment_record_failed: "取引IDを端末へ記録できませんでした。この画面を閉じずに注文の状態を確認してください。再送金は行いません。",
    wallet_user_rejected: "ウォレットで操作を取り消しました。支払内容を確認してから再度操作できます。",
    wallet_confirm_busy: "別のウォレット操作を確認中です。完了してから、支払内容を確認して再度操作してください。",
    wallet_confirm_unavailable: "ウォレットの確認画面を開けませんでした。画面の状態を確認してから再度操作してください。送金は行われていません。",
    wallet_fee_unavailable: "安全な手数料の見積もりを確認できませんでした。署名・送金は行われていません。接続状態を確認し、再度操作して新しい見積もりを確認してください。",
    wallet_fee_expired: "手数料の見積もりの期限が過ぎました。署名・送金は行われていません。再度操作して新しい見積もりを確認してください。",
    wallet_fee_stale: "送信元または取引の順序が変わりました。署名・送金は行われていません。ウォレットの状態を確認し、再度操作して新しい見積もりを確認してください。",
  })[text.startsWith("wallet_fee_") ? feeCode : text] ?? "支払いの結果を確認できません。再送せず、注文の状態を確認してください。";
}
function renderCartReview() {
  const review = document.querySelector("#cart-review"), button = document.querySelector("#cart-checkout");
  const prepared = shop.prepared;
  review.hidden = !prepared?.lines.length;
  review.replaceChildren();
  renderCheckoutPending(review);
  button.disabled = checkoutBusy || shop.busy || !checkoutPendingReady || Boolean(checkoutAttempt) || !cartLines().length;
  button.textContent = "確定金額を確認";
  if (!prepared?.lines.length) return;
  const head = document.createElement("p"); head.className = "meta";
  head.textContent = "以下はCommerceが確定した支払内容です。ウォレット操作は確認ボタンを押したときだけ行います。";
  const list = document.createElement("dl");
  for (const line of prepared.lines) {
    const { product, quantity, order } = line, payment = shopLinePayment(line);
    const row = document.createElement("div"), dt = document.createElement("dt"), dd = document.createElement("dd");
    dt.textContent = `${product.title} × ${quantity}`;
    dd.textContent = `${order.amountJpyc.toLocaleString()} JPYC → ${order.paymentAmount} ${order.currency}（${order.chainName}）・税${order.taxJpyc.toLocaleString()} JPYC`;
    row.append(dt, dd);
    if (payment.attempted) {
      const status = document.createElement("p"); status.className = "meta"; status.setAttribute("role", "status");
      status.textContent = payment.transactionHash ? "取引IDを保存しています。同じ取引の状態を確認します。新たな送金は行いません。"
        : payment.unknown ? "ウォレットの結果が未確認です。再送金はできません。" : "ウォレット操作を確認してください。成功した承認は繰り返しません。";
      const detail = document.createElement("button"); detail.type = "button"; detail.className = "head-action"; detail.textContent = "注文の状態を確認";
      detail.disabled = checkoutBusy;
      detail.onclick = () => { if (!checkoutBusy) void openOrderDetail(order.id); };
      row.append(status, detail);
    }
    list.append(row);
  }
  review.append(head, list);
  const payment = shopLinePayment(prepared.lines[0]);
  button.textContent = payment.transactionHash ? "保存した取引の状態を確認" : payment.unknown ? "ウォレットの結果を確認してください" : "ウォレットで確認して支払う";
  button.disabled ||= Boolean(payment.unknown && !payment.transactionHash);
  if (prepared.unsupported) {
    button.disabled = true;
    const web = document.createElement("button"); web.type = "button"; web.className = "head-action"; web.textContent = "Webで対応状況を確認";
    web.disabled = checkoutBusy;
    web.onclick = () => { if (!checkoutBusy) void openHubWebPath("/v2/market/products"); };
    review.append(web);
  }
}
function syncCartControls() {
  const locked = shopCartLocked();
  for (const input of document.querySelectorAll("#cart-lines input,#cart-lines button,#cart-country,#cart-asset")) input.disabled = locked;
  renderCartReview();
}

// 未操作の注文だけを破棄する。送信済み・結果未確認の注文は保持する。
async function discardPrepared() {
  if (checkoutBusy || shop.busy) return false;
  if (checkoutAttempt) { document.querySelector("#cart-state").textContent = "保存した注文作成の結果を先に確認してください。"; return false; }
  if (!shop.prepared) return true;
  if (shop.prepared.lines.some((line) => !shopPayment.discardable(line) || shopPendingOrder(line.order.id))) {
    document.querySelector("#cart-state").textContent = "ウォレット操作を行った注文を保持しています。先に注文の状態を確認してください。";
    return false;
  }
  const lines = shop.prepared.lines;
  shop.prepared = null;
  checkoutBusy = true;
  syncCartControls();
  try {
    for (const { order } of lines) {
      try { await invoke("commerce_order_cancel", { orderId: order.id, accessToken: order.accessToken }); await finishCheckoutForOrder(order.id, lines.find((line) => line.order.id === order.id)?.operationId); }
      catch { /* 未操作の注文は期限切れでも解放される */ }
    }
    return true;
  } finally { checkoutBusy = false; syncCartControls(); }
}

async function confirmFulfillment(product) {
  if (shopCartLocked() || !(await discardPrepared())) return;
  if (shopCartLocked()) return;
  const state = document.querySelector("#cart-state");
  checkoutBusy = true; syncCartControls();
  state.textContent = `${product.title}の配送先をIdentityで確認しています…`;
  try {
    const result = await invoke("commerce_fulfillment_quote", { productId: product.id, fulfillmentMode: product.fulfillmentType });
    shop.assertions[product.id] = result.assertion;
    shop.zones[product.id] = result.destinationZone ?? "";
    state.textContent = `${product.title}の配送先を確認しました。確認情報は5分間有効です。`;
  } catch { state.textContent = "配送先を確認できませんでした。状態を確認してからやり直してください。"; }
  finally { checkoutBusy = false; await renderCart(); }
}

// 確定額の確認と支払いを別のクリックに保ち、既知の取引は再署名しない。
async function cartCheckout() {
  if (checkoutBusy || shop.busy) return;
  const state = document.querySelector("#cart-state");
  if (!checkoutPendingReady) { state.textContent = checkoutPendingError || "保存した注文を確認してから新しい注文を作成してください。"; return; }
  if (checkoutAttempt) { await continueCheckoutAttempt(); return; }
  let prepared = shop.prepared;
  if (prepared && !prepared.lines.length) { shop.prepared = prepared = null; syncCartControls(); }
  const entries = cartLines();
  if (!entries.length || !prepared && entries.length !== Object.keys(shop.cart).length) return;
  if (prepared && !shopPayment.status(prepared.lines[0]).transactionHash && prepared.key !== shopReviewKey()) {
    if (!(await discardPrepared())) return;
    state.textContent = "選択内容が変わりました。確定金額をもう一度確認してください。";
    await renderCart(); return;
  }
  if (!prepared) {
    if (entries.length + checkoutRequests.length > 20) { state.textContent = "保存できる注文は20件までです。保存した注文を先に確認し、商品を分けて購入してください。"; return; }
    if (entries.some(({ quantity }) => !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 20)) {
      state.textContent = "商品の数量を確認してください。"; return;
    }
    if (shop.orders.some((receipt) => (receipt.status === "wallet_unknown" || receipt.status === "status_pending" && receipt.transactionHash) && entries.some(({ product }) => product.id === receipt.productId))) {
      state.textContent = "この商品のウォレット操作が未確認です。「注文」の注文詳細とウォレットの履歴を先に確認してください。";
      return;
    }
    if (checkoutRequests.some((request) => entries.some(({ product }) => product.id === request.productId))) { state.textContent = "この商品の保存した注文があります。注文作成の結果を先に確認してください。"; syncCartControls(); return; }
    if (!shop.paymentsEnabled) { state.textContent = "現在は決済メンテナンス中です。"; return; }
    const country = document.querySelector("#cart-country")?.value.trim().toUpperCase() ?? "";
    if (!/^[A-Z]{2}$/.test(country)) { state.textContent = "請求先国を2文字の国コードで入力してください。"; return; }
    const assetKey = document.querySelector("#cart-asset")?.value ?? "";
    const asset = shop.assets.find((item) => `${item.chainId}:${item.currency}` === assetKey);
    if (!asset) { state.textContent = "支払いに使う資産を選択してください。"; return; }
    const missing = entries.find(({ product }) => !shop.assertions[product.id]);
    if (missing) { state.textContent = `${missing.product.title}の配送先確認が必要です。「配送先を確認」を押してください。`; return; }
    const snapshot = shopReviewSnapshot({ entries: entries.map(({ product, quantity }) => ({ product, quantity, assertion: shop.assertions[product.id] })), asset, country });
    checkoutAttempt = { asset: snapshot.asset, country, assetKey, entries: snapshot.entries.map(({ product, quantity, assertion }) => {
      const operationId = crypto.randomUUID();
      return { product, quantity, operationId, resolved: false, metadata: { productId: product.id, quantity, billingCountry: country, paymentCurrency: asset.currency, paymentChainId: asset.chainId, orderId: null },
        params: shopReviewSnapshot({ operationId, productId: product.id, quantity, billingCountry: country, paymentCurrency: asset.currency, paymentChainId: asset.chainId, fulfillmentAssertion: assertion }) };
    }) };
    await continueCheckoutAttempt();
    return;
  }
  checkoutBusy = true; syncCartControls();
  try {
    while (prepared.lines.length) {
      const line = prepared.lines[0];
      const reviewMatches = prepared.key === shopReviewKey();
      if (!shopPayment.status(line).transactionHash && !reviewMatches) throw new Error("shop_payment_invalid");
      state.textContent = shopPayment.status(line).transactionHash ? `${line.product.title}の保存した取引を照合しています…` : `${line.product.title}: ウォレットで確認してください…`;
      const pendingReceipt = shop.orders.find((receipt) => receipt.id === line.order.id && (receipt.status === "wallet_unknown" || receipt.transactionHash));
      if (pendingReceipt?.status === "wallet_unknown") throw new Error("shop_payment_unknown");
      const { transactionHash, order } = pendingReceipt?.transactionHash
        ? await shopPayment.recover({ orderId: pendingReceipt.id, transactionHash: pendingReceipt.transactionHash }) : await shopPayment.pay(line);
      saveShopReceipt(line, transactionHash, order.status);
      delete shop.cart[line.product.id]; delete shop.cartProducts[line.product.id]; delete shop.assertions[line.product.id]; delete shop.zones[line.product.id];
      prepared.lines.shift(); if (reviewMatches) prepared.key = shopReviewKey();
      shopSave();
      await finishCheckoutForOrder(order.id, line.operationId);
    }
    shop.prepared = null;
    updateCartBadge();
    state.textContent = prepared.recovered ? "復旧した注文の支払いを送信しました。ほかのカートや保存した注文の支払いは行っていません。"
      : "確認した注文の支払いを送信しました。注文履歴は「注文」で確認できます。";
    await renderCart(); renderOrders();
  } catch (error) {
    if (!prepared.lines.length) {
      shop.prepared = null;
      state.textContent = "注文情報を端末に保存できませんでした。保存した取引は注文詳細で確認してください。";
    } else {
      prepared.message = shopPaymentError(error);
      prepared.unsupported = String(error?.message ?? error) === "shop_payment_unsupported";
      if (String(error?.message ?? error) === "shop_payment_unknown") {
        try { saveShopReceipt(prepared.lines[0], null, "wallet_unknown"); }
        catch { prepared.message += "端末への記録にも失敗しました。この画面を閉じずに状態を確認してください。"; }
      }
      state.textContent = prepared.message;
    }
  } finally { checkoutBusy = false; syncCartControls(); }
}


// 送金確認中の注文は描画時に一度だけ自動再照合する。不足・超過入金の
// 例外はこの状態中に検出されるため、詳細を開かなくても気付けるようにする。
const orderAutoRefreshed = new Set();
let orderFilter = "all";
let orderVisibleCount = 20;

// 購入者側の「動ける注文」。Webの注文履歴フィルターと同じ分類。
function orderBuyerAttention(receipt) {
  return receipt.status === "awaiting_payment" ||
    Boolean(receipt.paymentException) ||
    receipt.returnStatus === "requested" ||
    receipt.returnStatus === "approved" ||
    receipt.returnStatus === "in_transit" ||
    receipt.escrow?.state === "disputed" ||
    receipt.escrow?.state === "shipped";
}
function orderBuyerDone(receipt) {
  return ["refunded", "expired", "cancelled"].includes(receipt.status) ||
    receipt.fulfillmentStatus === "delivered" ||
    receipt.escrow?.state === "released";
}

document.querySelectorAll("#orders-filter button").forEach((button) => {
  button.addEventListener("click", () => {
    orderFilter = button.dataset.filter ?? "all";
    orderVisibleCount = 20;
    document.querySelectorAll("#orders-filter button").forEach((b) => b.classList.toggle("on", b === button));
    renderOrders();
  });
});

// 注文の状態を取り直す（一覧の自動更新と「状態を更新」で同じ項目を写す）。
async function refreshOrderReceipt(receipt, { automatic = false } = {}) {
  if (!automatic && (receipt.status === "wallet_unknown" || receipt.status === "status_pending" && receipt.transactionHash)) { await openOrderDetail(receipt.id); return; }
  try {
    // トークンは空でもよい——端末の資格情報保管庫から引かれる。
    const body = await invoke("commerce_order_status", { orderId: receipt.id, accessToken: shopToken(receipt.id) ?? "" });
    const order = body?.order;
    receipt.status = order?.status ?? receipt.status;
    if (automatic) receipt.fulfillmentType = order?.fulfillmentType ?? receipt.fulfillmentType;
    receipt.fulfillmentStatus = order?.fulfillmentStatus;
    receipt.trackingNumber = order?.trackingNumber;
    receipt.returnStatus = order?.returnStatus ?? receipt.returnStatus;
    receipt.paymentException = body?.paymentException ?? null;
    if (body?.physicalEscrow) receipt.escrow = body.physicalEscrow;
    shopSave();
    renderOrders();
  } catch (error) {
    if (!automatic) showNotice(`更新できませんでした: ${friendlyError(error)}`);
  }
}
let ordersList = null;
function renderOrders() {
  const host = document.querySelector("#orders-list");
  if (!host) return;
  const deps = {
    asset: hubAsset,
    statusText: orderStatusText,
    fulfillmentText,
    bucketOf: (receipt) => (orderBuyerAttention(receipt) ? "attention" : orderBuyerDone(receipt) ? "done" : "open"),
    openOrder: (id) => void openOrderDetail(id),
    openWeb: (path) => void openHubWebPath(path),
    refresh: (receipt) => void refreshOrderReceipt(receipt),
    browse: () => document.querySelector('.nav-item[data-view="market"]')?.click(),
  };
  ordersList ??= createOrdersList({ document, host, deps });
  // 支払い待ちも取り直す——期限切れの反映と在庫解放の確認が一覧で見える。
  for (const receipt of shop.orders.slice(0, 20)) {
    const needsEscrow = ["paid", "partially_refunded", "refunded"].includes(receipt.status) && !receipt.escrow;
    if ((["awaiting_payment", "submitted"].includes(receipt.status) || needsEscrow) && !orderAutoRefreshed.has(receipt.id)) {
      orderAutoRefreshed.add(receipt.id);
      void refreshOrderReceipt(receipt, { automatic: true });
    }
  }
  ordersList.set(shop.orders);
  const purchased = document.querySelector("#purchased-items");
  if (purchased) renderMarketLibrary(purchased, deps);
}
// ライブラリ（2026-11-04）：デジタルは上の shop.orders。ゲーム・チケット・限定の中身は Web のライブラリの行（market-me.mjs）。
let marketLibrary = null;
function renderMarketLibrary(host, orderDeps) {
  const deps = {
    ...orderDeps,
    openOrders: () => document.querySelector("#orders-list")?.scrollIntoView?.({ block: "start" }),
  };
  if (!marketLibrary || !host.contains(marketLibrary.root)) marketLibrary = createLibrary({ document, host, deps });
  marketLibrary.set({ receipts: shop.orders });
}

// ---- 注文詳細（支払い・発送・受取・返品の操作面） ----
// 状態取得はCommerceの注文API一本。操作は（エスクローcalldata準備 →
// ウォレット確認 → 提出照合）の3段。トークンは資格情報保管庫が持つ。

let detailOrderId = null;
let detailOrder = null;
let latestDetailRecoveryControls = () => {};

const ESCROW_LABELS = {
  funded: "代金を安全に保管中",
  shipped: "発送済み・受取確認待ち",
  released: "販売者への支払い完了",
  refunded: "購入者へ返金済み",
  disputed: "問題の確認中・支払い停止",
};
const ORDER_STATUS_LABELS = {
  awaiting_payment: "支払い待ち", submitted: "送金を確認中", confirming: "送金を照合中", status_pending: "取引ID保存済み・注文の照合待ち", wallet_unknown: "ウォレット操作の結果未確認", paid: "支払い済み",
  partially_refunded: "一部返金済み", refunded: "返金済み",
  cancelled: "キャンセル済み", expired: "支払い期限切れ", payment_failed: "支払いに失敗",
};
const FULFILL_LABELS = {
  processing: "発送準備中", shipped: "発送済み", delivered: "配達完了",
};
const RETURN_STATUS_LABELS = {
  requested: "申請中", approved: "承認済み・返送可", rejected: "受付不可",
  in_transit: "返送中", received: "販売者が受領", refunded: "返金済み",
};
const orderStatusText = (s) => ORDER_STATUS_LABELS[s] ?? s ?? "確認中";
const fulfillmentText = (s) => FULFILL_LABELS[s] ?? s ?? "";
const escrowText = (s) => ESCROW_LABELS[s] ?? s ?? "確認中";
const returnText = (s) => RETURN_STATUS_LABELS[s] ?? s ?? "申請中";

async function openOrderDetail(orderId) {
  detailOrderId = orderId;
  showView("order", "注文詳細");
  await loadOrderDetail();
}

async function loadOrderDetail() {
  const state = document.querySelector("#order-state");
  const target = document.querySelector("#order-detail");
  if (!state || !target || !detailOrderId) return;
  const orderId = detailOrderId;
  state.textContent = "注文情報を読み込んでいます…";
  target.replaceChildren();
  try {
    const body = await invoke("commerce_order_status", {
      orderId,
      accessToken: shopToken(orderId) ?? "",
    });
    if (detailOrderId !== orderId) return;
    detailOrder = body?.order ?? null;
    renderOrderDetail(body);
    state.textContent = "";
  } catch (error) {
    if (detailOrderId !== orderId) return;
    state.textContent = String(error) === "order_token_unavailable"
      ? "この注文の確認権限がこの端末にありません。購入時に使った端末で開いてください。"
      : `注文情報を読み込めませんでした: ${friendlyError(error)}`;
  }
}

function detailCard(title) {
  const card = document.createElement("div");
  card.className = "card";
  const h = document.createElement("h3");
  h.textContent = title;
  card.append(h);
  return card;
}
function detailRow(list, dt, dd) {
  const div = document.createElement("div");
  const a = document.createElement("dt");
  const b = document.createElement("dd");
  a.textContent = dt;
  b.textContent = dd;
  div.append(a, b);
  list.append(div);
}
/* 配送業者は自由記入。分かる業者のときだけ追跡URLを組み立てる。 */
function trackingUrl(carrier, trackingNumber) {
  if (!carrier || !/^[A-Za-z0-9-]{6,32}$/.test(trackingNumber)) return null;
  const name = carrier.toLowerCase();
  const number = encodeURIComponent(trackingNumber);
  if (name.includes("ヤマト") || name.includes("yamato") || name.includes("kuroneko"))
    return `https://jizen.kuronekoyamato.co.jp/jizen/servlet/crjz.b.NQ0010?id=${number}`;
  if (name.includes("佐川") || name.includes("sagawa"))
    return `https://k2k.sagawa-exp.co.jp/p/web/okurihosearch.do?okurihoNo=${number}`;
  if (name.includes("郵便") || name.includes("ゆうパック") || name.includes("japan post") || name.includes("japanpost"))
    return `https://trackings.post.japanpost.jp/services/srv/search/direct?searchKind=S002&locale=ja&reqCodeNo1=${number}`;
  return null;
}
function actionButton(label, kind, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = kind === "danger" ? "head-action" : "approve";
  button.textContent = label;
  button.onclick = onClick;
  return button;
}

function formatAtomicAmount(atomic, decimals, currency) {
  if (atomic === undefined || atomic === null || atomic === "") return "?";
  try {
    const value = BigInt(atomic);
    const d = Number(decimals ?? 0);
    const unit = 10n ** BigInt(d);
    const whole = value / unit;
    const frac = d ? (value % unit).toString().padStart(d, "0").replace(/0+$/, "") : "";
    return `${whole.toLocaleString()}${frac ? `.${frac}` : ""} ${currency ?? ""}`.trim();
  } catch {
    return String(atomic);
  }
}

async function completeShopRecovery(result, receipt) {
  const reviewMatches = shop.prepared?.key === shopReviewKey();
  if (shop.cart[receipt.productId] === receipt.quantity) {
    delete shop.cart[receipt.productId]; delete shop.cartProducts[receipt.productId];
    delete shop.assertions[receipt.productId]; delete shop.zones[receipt.productId];
  }
  if (shop.prepared) {
    shop.prepared.lines = shop.prepared.lines.filter((line) => line.order.id !== receipt.id);
    if (!shop.prepared.lines.length) shop.prepared = null;
    else if (reviewMatches) shop.prepared.key = shopReviewKey();
  }
  receipt.status = result.order.status;
  try { shopSave(); } catch { receipt.status = "status_pending"; throw new Error("shop_payment_record_failed"); }
  updateCartBadge();
  await finishCheckoutForOrder(result.order.id, receipt.operationId);
}

function renderOrderDetail(body) {
  const target = document.querySelector("#order-detail");
  const order = body?.order;
  if (!target || !order) return;
  const recoveryControls = [];
  const escrow = body.physicalEscrow ?? null;
  const proposal = body.escrowProposal ?? null;
  const returnRequest = body.returnRequest ?? null;
  const events = body.events ?? [];
  const refunds = body.refunds ?? (body.refund ? [body.refund] : []);

  const overview = detailCard("概要");
  const dl = document.createElement("dl");
  detailRow(dl, "注文", order.id);
  detailRow(dl, "支払い", escrow ? escrowText(escrow.state) : orderStatusText(order.status));
  detailRow(dl, "配送", order.fulfillmentStatus ? fulfillmentText(order.fulfillmentStatus) : "発送準備前");
  detailRow(dl, "合計", `${order.amountJpyc.toLocaleString()} JPYC`);
  if (escrow) {
    detailRow(dl, "発送期限", new Date(escrow.shipBy).toLocaleString("ja-JP"));
    detailRow(dl, "自動解除予定", new Date(escrow.releaseAt).toLocaleString("ja-JP"));
    if (escrow.state === "disputed" && escrow.disputeResolutionDeadline)
      detailRow(dl, "仲裁の解決期限", new Date(escrow.disputeResolutionDeadline).toLocaleString("ja-JP"));
  }
  if (order.trackingNumber) {
    const url = trackingUrl(order.shippingCarrier, order.trackingNumber);
    if (url) {
      const div = document.createElement("div");
      const a = document.createElement("dt");
      const b = document.createElement("dd");
      a.textContent = "追跡";
      const link = document.createElement("button");
      link.type = "button";
      link.className = "seller-link";
      link.textContent = `${order.shippingCarrier ?? ""} ${order.trackingNumber}`;
      link.onclick = () => void invoke("open_external", { url }).catch(() => undefined);
      b.append(link);
      div.append(a, b);
      dl.append(div);
    } else {
      detailRow(dl, "追跡", `${order.shippingCarrier ?? ""} ${order.trackingNumber}`);
    }
  }
  overview.append(dl);
  const overviewActions = document.createElement("div");
  overviewActions.className = "actions";
  const unknownReceipt = shop.orders.find((receipt) => receipt.id === order.id && receipt.status === "wallet_unknown");
  if (unknownReceipt) {
    const unknown = document.createElement("p"); unknown.className = "meta"; unknown.setAttribute("role", "status");
    unknown.textContent = "ウォレット操作の結果が未確認です。保存した支払取引を照合できます。記録が見つからなくても未送信とは判断できません。再送金や注文の取り消しをせず、ウォレットの履歴と注文の状態を確認してください。";
    overview.append(unknown);
  }
  const pendingReceipt = shop.orders.find((receipt) => receipt.id === order.id && receipt.status === "status_pending" && receipt.transactionHash);
  const recoveryReceipt = unknownReceipt ?? pendingReceipt;
  if (recoveryReceipt) {
    const recoveryOrderId = order.id, recoveryChainId = order.chainId;
    const recover = actionButton("保存した取引を照合", "primary", async () => {
      if (checkoutBusy || detailOrderId !== recoveryOrderId || unknownReceipt && (!Number.isSafeInteger(recoveryChainId) || recoveryChainId <= 0)) return;
      checkoutBusy = true; recover.disabled = true; syncCartControls();
      const state = document.querySelector("#order-state");
      try {
        const result = unknownReceipt
          ? await shopPayment.recoverUnknown({ orderId: recoveryOrderId, chainId: recoveryChainId, onRecovered: (transactionHash) => {
            const receipt = shop.orders.find((item) => item.id === recoveryOrderId);
            if (!receipt) throw new Error("shop_payment_recovery_unavailable");
            receipt.transactionHash = transactionHash; receipt.status = "status_pending";
            try { shopSave(); } catch { throw new Error("shop_payment_record_failed"); }
          } })
          : await shopPayment.recover({ orderId: recoveryOrderId, transactionHash: pendingReceipt.transactionHash });
        const receipt = shop.orders.find((item) => item.id === recoveryOrderId);
        if (!receipt) throw new Error("shop_payment_recovery_unavailable");
        await completeShopRecovery(result, receipt);
        if (detailOrderId !== recoveryOrderId) return;
        state.textContent = "保存した取引を注文と照合しました。新たな送金は行っていません。";
        await loadOrderDetail();
      } catch (error) { if (detailOrderId === recoveryOrderId) state.textContent = shopPaymentError(error); }
      finally { checkoutBusy = false; recover.disabled = false; syncCartControls(); latestDetailRecoveryControls(); }
    });
    recover.disabled = checkoutBusy || Boolean(unknownReceipt && (!Number.isSafeInteger(recoveryChainId) || recoveryChainId <= 0));
    recoveryControls.push(() => { recover.disabled = checkoutBusy || Boolean(unknownReceipt && (!Number.isSafeInteger(recoveryChainId) || recoveryChainId <= 0)); });
    overviewActions.append(recover);
  }
  if (overviewActions.childElementCount) overview.append(overviewActions);
  if (unknownReceipt) {
    const prepared = shop.prepared;
    const line = prepared?.lines.find((item) => item.order?.id === order.id && item.order.chainId === order.chainId &&
      item.order.assetKind === "erc20" && item.product?.id === unknownReceipt.productId && item.quantity === unknownReceipt.quantity &&
      item.order.productId === item.product.id && item.order.quantity === item.quantity && Object.isFrozen(item.order) && Object.isFrozen(item.product));
    const guidance = document.createElement("p"); guidance.className = "meta"; guidance.setAttribute("role", "status");
    overview.append(guidance);
    if (!line || order.status !== "awaiting_payment" || order.transactionHash != null) {
      guidance.textContent = "承認だけが完了した場合の支払い続行には、元の確定したERC20支払内容が必要です。カートの保存した注文を復旧して元の支払内容を確認してください。この画面では再構成しません。";
    } else {
      const orderId = order.id, originalKey = prepared.key, originalOrder = line.order, originalProduct = line.product, quantity = line.quantity;
      let approvalReady = false;
      const matches = () => overview.isConnected && detailOrderId === orderId && shop.prepared === prepared && prepared.lines.includes(line) &&
        line.order === originalOrder && line.product === originalProduct && line.quantity === quantity &&
        prepared.key === originalKey && shopReviewKey() === originalKey && shop.cart[line.product.id] === quantity &&
        shop.orders.some((receipt) => receipt.id === orderId && receipt.status === "wallet_unknown" && !receipt.transactionHash);
      const inspect = actionButton("承認取引を照合", "danger", async () => {
        if (checkoutBusy || !matches()) return;
        approvalReady = false; continuation.hidden = true;
        checkoutBusy = true; inspect.disabled = true; syncCartControls();
        try {
          await shopPayment.recoverApproval(line);
          if (!matches()) return;
          approvalReady = true; continuation.hidden = false;
          guidance.textContent = "承認取引の取り込みと現在の利用枠を確認しました。支払い完了や最終確定を示すものではありません。元の支払内容を確認してから、別の操作で支払いへ進んでください。";
        } catch (error) { if (matches()) guidance.textContent = shopPaymentError(error); }
        finally { checkoutBusy = false; inspect.disabled = false; syncCartControls(); latestDetailRecoveryControls(); }
      });
      const continuation = actionButton("承認を再送せず支払いを確認", "danger", async () => {
        if (checkoutBusy || !approvalReady || !matches()) return;
        approvalReady = false; continuation.hidden = true;
        checkoutBusy = true; inspect.disabled = true; continuation.disabled = true; syncCartControls();
        try {
          const result = await shopPayment.pay(line);
          saveShopReceipt(line, result.transactionHash, "status_pending");
          const receipt = shop.orders.find((item) => item.id === orderId);
          await completeShopRecovery(result, receipt);
          if (detailOrderId !== orderId || !overview.isConnected) return;
          document.querySelector("#order-state").textContent = "この注文の支払いを確認しました。ほかの注文の支払いは行っていません。";
          await loadOrderDetail();
        } catch (error) { if (detailOrderId === orderId && overview.isConnected) guidance.textContent = shopPaymentError(error); }
        finally { checkoutBusy = false; inspect.disabled = continuation.disabled = false; syncCartControls(); latestDetailRecoveryControls(); }
      });
      continuation.hidden = true; inspect.disabled = checkoutBusy;
      recoveryControls.push(() => { inspect.disabled = continuation.disabled = checkoutBusy; });
      guidance.textContent = "承認取引の照合は支払いを行いません。確認後の支払いは、この注文の元の確定内容だけを別の操作で確認します。";
      const approvalActions = document.createElement("div"); approvalActions.className = "actions"; approvalActions.style.flexWrap = "wrap";
      for (const button of [inspect, continuation]) { button.style.flex = "0 0 auto"; button.style.whiteSpace = "nowrap"; }
      approvalActions.append(inspect, continuation);
      overview.append(approvalActions);
    }
  }
  if (["paid", "partially_refunded", "refunded"].includes(order.status)) {
    const receipt = actionButton("領収書をコピー", "danger", async () => {
      try {
        const body = await invoke("commerce_order_receipt", {
          orderId: order.id, accessToken: shopToken(order.id) ?? "",
        });
        await navigator.clipboard.writeText(JSON.stringify(body?.receipt ?? body, null, 2));
        receipt.textContent = "領収書をコピーしました";
      } catch (error) {
        receipt.textContent = `領収書を取得できませんでした: ${friendlyError(error)}`;
      }
    });
    overviewActions.append(receipt);
  }
  if (order.status === "awaiting_payment" && !order.transactionHash && !shopPendingOrder(order.id)) {
    overviewActions.append(actionButton("この注文を取り消す", "danger", async () => {
      const state = document.querySelector("#order-state");
      try {
        if (checkoutBusy || shopPendingOrder(order.id)) return;
        await invoke("commerce_order_cancel", {
          orderId: order.id, accessToken: shopToken(order.id) ?? "",
        });
        if (shop.prepared) { shop.prepared.lines = shop.prepared.lines.filter((line) => line.order.id !== order.id); if (!shop.prepared.lines.length) shop.prepared = null; }
        await finishCheckoutForOrder(order.id);
        if (state) state.textContent = "注文を取り消しました。";
        await loadOrderDetail();
      } catch (error) {
        if (state) state.textContent = `注文を取り消せませんでした: ${friendlyError(error)}`;
      }
    }));
  }
  if (overviewActions.childElementCount && overviewActions.parentNode !== overview) overview.append(overviewActions);

  // 支払い例外（不足・超過）。不足は購入者ウォレットからの追加入金で解消、
  // 超過は店舗側の返送処理待ち。送金specはサーバーが組み立てたものを使う。
  const exception = body.paymentException ?? null;
  let exceptionCard = null;
  if (exception) {
    exceptionCard = detailCard("支払いの確認が必要です");
    const p = document.createElement("p");
    p.className = "meta";
    const expected = formatAtomicAmount(exception.expectedAtomic, order.paymentTokenDecimals, order.paymentCurrency);
    const observed = formatAtomicAmount(exception.observedAtomic, order.paymentTokenDecimals, order.paymentCurrency);
    if (exception.exceptionType === "underpaid") {
      const short = formatAtomicAmount(String(BigInt(exception.expectedAtomic) - BigInt(exception.observedAtomic)), order.paymentTokenDecimals, order.paymentCurrency);
      p.textContent = `請求額 ${expected} に対し ${observed} が入金済みです。不足分 ${short} を追加で送金してください。`;
      exceptionCard.append(p);
      if (exception.resolutionTransfer) {
        const exActions = document.createElement("div");
        exActions.className = "actions";
        exActions.append(actionButton("不足分を送金する", "primary", () => void supplementPayment(exception)));
        exceptionCard.append(exActions);
      }
    } else {
      p.textContent = `請求額 ${expected} に対し ${observed} が入金されました。店舗が差額の返送処理を行います。`;
      exceptionCard.append(p);
    }
  }

  const actions = detailCard("代金ロックの操作");
  const note = document.createElement("p");
  note.className = "meta";
  note.textContent = "実行前に内容を確認してください。送信はウォレットの確認モーダルで承認してから行われます。";
  if (Array.isArray(body.escrowSubmissions) && body.escrowSubmissions.some((s) => s?.status === "failed")) {
    note.textContent = "以前の操作を確認できません。未送信や再実行可能とは判断せず、保存した操作を照合してください。";
  }
  const row = document.createElement("div");
  row.className = "actions";
  const escrowUncertain = () => Boolean(escrow && escrowHistoryUncertain({ orderId: order.id, role: "buyer", chainId: order.chainId, submissions: body.escrowSubmissions }));
  const escrowOrderId = order.id;
  const escrowCurrent = () => overview.isConnected && detailOrderId === escrowOrderId && currentView === "order";
  const runEscrow = (action, extra = {}) => escrowAction(action, extra, { orderId: escrowOrderId, canConfirm: escrowCurrent, blocked: escrowUncertain });
  let hasAction = false;
  if (escrow?.state === "shipped") {
    row.append(actionButton("受取を確認して店舗へ支払う", "primary", () => void runEscrow("confirm")));
    if (Date.now() >= Date.parse(escrow.releaseAt)) {
      row.append(actionButton("期限到来の自動解除を実行", "primary", () => void runEscrow("release")));
    }
    hasAction = true;
  }
  if (escrow?.state === "funded" && Date.now() > Date.parse(escrow.shipBy)) {
    row.append(actionButton("未発送のため返金する", "danger", () => void runEscrow("refund_unshipped")));
    hasAction = true;
  }
  if (["funded", "shipped"].includes(escrow?.state) && Date.now() < Date.parse(escrow.releaseAt)) {
    row.append(actionButton("問題を報告して支払いを停止", "danger", () => void runEscrow("dispute")));
    hasAction = true;
  }
  if (escrow?.state === "disputed") {
    if (proposal?.status === "open") {
      const openProposal = document.createElement("p");
      openProposal.className = "meta";
      const buyerShare = formatAtomicAmount(proposal.buyerAmountAtomic, order.paymentTokenDecimals, order.paymentCurrency);
      const sellerShare = formatAtomicAmount(proposal.sellerAmountAtomic, order.paymentTokenDecimals, order.paymentCurrency);
      if (proposal.proposedBy === "buyer") {
        openProposal.textContent = `自分の配分案（購入者へ ${buyerShare}・店舗へ ${sellerShare}）は店舗の承認待ちです。`;
        actions.append(openProposal);
      } else {
        openProposal.textContent = `店舗の配分案：購入者へ ${buyerShare}・店舗へ ${sellerShare}`;
        row.append(actionButton("この配分案を承認して解決", "primary", () => void runEscrow("accept_resolution")));
        actions.append(openProposal);
      }
    }
    actions.append(escrowSplitForm(escrow, runEscrow));
    // 期限が読めない（RPC不調）だけで確定操作を隠すと期限経過後に詰まる。
    // 期限不明ならサーバー側のprepare判定に任せてボタンは出す。
    if (!escrow.disputeResolutionDeadline || Date.now() >= Date.parse(escrow.disputeResolutionDeadline))
      row.append(actionButton("異議の解決期限が過ぎた場合、異議前の状態へ戻す", "ghost", () => void runEscrow("finalize_expired_dispute")));
    hasAction = true;
  }
  if (!hasAction) {
    const quiet = document.createElement("p");
    quiet.className = "meta";
    quiet.textContent = escrow ? "現在実行できる操作はありません。" : "この注文には代金ロックがありません。";
    actions.append(quiet);
  }
  actions.insertBefore(note, actions.firstChild?.nextSibling ?? null);
  actions.append(row);
  if (escrow) {
    const recovery = document.createElement("div"); recovery.className = "actions";
    const recover = actionButton("保存した操作を照合", "danger", () => void recoverEscrowOperation({ orderId: escrowOrderId, role: "buyer", canConfirm: escrowCurrent }));
    const inspect = actionButton("失敗した取引を確認", "danger", () => void recoverEscrowOperation({ orderId: escrowOrderId, role: "buyer", canConfirm: escrowCurrent }, "failure"));
    recovery.style.flexWrap = "wrap";
    recovery.style.justifyContent = "flex-start";
    recover.style.flex = inspect.style.flex = "0 0 auto";
    recovery.append(recover, inspect); actions.append(recovery);
    recoveryControls.push(() => {
      const pending = escrowActions.status({ orderId: escrowOrderId, role: "buyer" });
      const uncertain = escrowUncertain();
      for (const input of actions.querySelectorAll("button,input")) input.disabled = checkoutBusy || pending.busy || pending.pending || pending.unknown || uncertain;
      recover.disabled = inspect.disabled = checkoutBusy || pending.busy;
      note.textContent = pending.pending || pending.unknown || uncertain
        ? "以前の操作の結果を確認できません。未送信とは判断せず、新しい操作を止めています。保存した操作の照合や失敗した取引の確認を行ってください。"
        : "次の操作は別に選び、新しいウォレット確認で承認してください。保存した操作の照合や失敗した取引の確認では署名・送金を行いません。";
    });
  }

  const returns = detailCard("返品");
  if (returnRequest) {
    const p = document.createElement("p");
    p.className = "meta";
    p.textContent = `状態: ${returnText(returnRequest.status)}`;
    returns.append(p);
    if (returnRequest.status === "requested" && escrow && ["funded", "shipped"].includes(escrow.state)) {
      const hint = document.createElement("p");
      hint.className = "meta";
      hint.textContent = "店舗が応答しない場合は、上の「問題を報告して支払いを停止」から異議を開くことができます。";
      returns.append(hint);
    }
    if (returnRequest.status === "approved") returns.append(returnShipmentForm());
  } else if (order.status === "paid") {
    const deadline = order.paidAt ? new Date(Date.parse(order.paidAt) + 30 * 86_400_000) : null;
    if (deadline && deadline.getTime() < Date.now()) {
      const p = document.createElement("p");
      p.className = "meta";
      p.textContent = "返品申請期間（支払い確定から30日）を過ぎています。";
      returns.append(p);
    } else {
      if (deadline) {
        const p = document.createElement("p");
        p.className = "meta";
        p.textContent = `返品申請は${deadline.toLocaleDateString("ja-JP")}まで受け付けています。`;
        returns.append(p);
      }
      returns.append(returnForm());
    }
  } else {
    const p = document.createElement("p");
    p.className = "meta";
    p.textContent = "支払い確定後に返品を申請できます。";
    returns.append(p);
  }

  const history = detailCard("更新履歴");
  if (refunds.length) {
    const refundList = document.createElement("ul");
    for (const refund of refunds) {
      const li = document.createElement("li");
      li.className = "meta";
      li.textContent = `返金 ${refund.status === "confirmed" ? "完了" : refund.status === "rejected" ? "確認不成立" : "照合待ち"}${refund.sellerRefundTransactionHash ? "" : "（未送信）"}`;
      refundList.append(li);
    }
    history.append(refundList);
  }
  if (events.length) {
    const ol = document.createElement("ol");
    for (const item of events) {
      const li = document.createElement("li");
      li.className = "meta";
      li.textContent = `${new Date(item.createdAt).toLocaleString("ja-JP")} — ${item.publicMessage}`;
      ol.append(li);
    }
    history.append(ol);
  } else if (!refunds.length) {
    const p = document.createElement("p");
    p.className = "meta";
    p.textContent = "更新はまだありません。";
    history.append(p);
  }

  target.replaceChildren(...[overview, exceptionCard, actions, returns, history].filter(Boolean));
  latestDetailRecoveryControls = () => { if (target.contains(overview)) recoveryControls.forEach((update) => update()); };
  latestDetailRecoveryControls();
}

// 不足分の追加入金: specはサーバー生成（宛先=店舗受取先、額=差額）。
// 送信後はCommerceがon-chainで from/額/宛先を照合して注文を確定する。
async function supplementPayment(exception) {
  const state = document.querySelector("#order-state");
  const id = detailOrderId;
  const spec = exception?.resolutionTransfer;
  if (!state || !id || !spec) return;
  try {
    // 追加入金は購入時のウォレットからでないと照合が通らない。
    const status = await invoke("wallet_status");
    if (spec.from && status?.address
        && status.address.toLowerCase() !== String(spec.from).toLowerCase()) {
      state.textContent = "この端末のウォレットは購入時のウォレットと違います。購入に使った端末で操作してください。";
      return;
    }
    state.textContent = "ウォレットで追加入金を確認してください…";
    const transactionHash = await invoke("wallet_send_contract", {
      chainId: spec.chainId, to: spec.to,
      valueWei: shopAtomicHex(spec.value), data: spec.data,
      summary: `注文 ${id} の不足分入金: ${formatAtomicAmount(spec.amountAtomic, detailOrder?.paymentTokenDecimals, detailOrder?.paymentCurrency)} を店舗へ送金`,
    });
    let lastError = "";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 2000));
      state.textContent = "送信した取引を照合しています…";
      try {
        await invoke("commerce_order_payment_exception_resolve", {
          orderId: id, accessToken: shopToken(id) ?? "", transactionHash,
        });
        lastError = "";
        break;
      } catch (error) {
        lastError = String(error);
        if (lastError !== "transaction_not_confirmed") break;
      }
    }
    if (lastError) throw new Error(lastError === "transaction_not_confirmed" ? "送信済みですが、確定監視が時間内に完了しませんでした。" : friendlyError(lastError));
    state.textContent = "不足分の入金を確認し、注文を確定しました。";
    await loadOrderDetail();
  } catch (error) {
    state.textContent = `追加入金を完了できませんでした: ${friendlyError(error)}`;
  }
}

const escrowActions = createEscrowActions({ invoke });
const refundActions = createRefundActions({ invoke });
let latestSellerEscrowControls = () => {};
function escrowHistoryUncertain({ orderId, role, chainId, submissions, unavailable = false, aggregateFailed = false }) {
  if (unavailable || !Array.isArray(submissions) || submissions.length > 20) return true;
  const verified = escrowActions.status({ orderId, role }).verifiedReverted ?? [];
  const hashes = new Set();
  const actions = {
    buyer: ["confirm", "release", "refund_unshipped", "dispute", "propose_resolution", "accept_resolution", "finalize_expired_dispute"],
    seller: ["ship", "release", "refund_by_seller", "dispute", "propose_resolution", "accept_resolution", "finalize_expired_dispute"],
    automation: ["resolve"],
  };
  let failed = false;
  for (const item of submissions) {
    if (!item || !["submitted", "failed", "confirmed"].includes(item.status)
      || !["buyer", "seller", "automation"].includes(item.actorRole) || !actions[item.actorRole].includes(item.action)
      || typeof item.transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(item.transactionHash)
      || hashes.has(item.transactionHash.toLowerCase())) return true;
    hashes.add(item.transactionHash.toLowerCase());
    if (item.status === "confirmed") continue;
    if (item.status === "failed") failed = true;
    if (!Number.isSafeInteger(chainId) || chainId <= 0 || !["buyer", "seller"].includes(item.actorRole)
      || !verified.some((proof) => proof.chainId === chainId && proof.role === item.actorRole
        && proof.action === item.action && proof.transactionHash === item.transactionHash)) return true;
  }
  return Boolean(aggregateFailed && (!failed || submissions.length === 20));
}
function escrowOperationError(error) {
  const code = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const messages = {
    escrow_action_invalid: "操作の内容を確認できません。新しい操作を送らず、注文の状態を確認してください。",
    escrow_action_busy: "別の操作を確認中です。完了するまでお待ちください。",
    escrow_action_pending: "保存した操作が未確認です。新しい操作を送らず、保存した操作を照合してください。",
    escrow_action_unknown: "操作の結果を確認できません。再送せず、保存した操作と注文の状態を確認してください。",
    escrow_action_status_mismatch: "保存した操作と注文の応答が一致しません。再送せず、注文の状態を確認してください。",
    escrow_action_recovery_unavailable: "保存した操作を照合できません。未送信とは判断せず、再送を止めたまま状態を確認してください。",
  };
  if (messages[code]) return messages[code];
  if (["wallet_user_rejected", "wallet_confirm_busy", "wallet_confirm_unavailable", "wallet_fee_unavailable", "wallet_fee_expired", "wallet_fee_stale"].includes(code)) return shopPaymentError(error);
  return "操作の結果を確認できません。再送せず、保存した操作と注文の状態を確認してください。";
}
async function performEscrowOperation({ orderId, role, action, extra = {}, summary, canConfirm, blocked = false }, recovering = false) {
  if (checkoutBusy || !canConfirm()) return;
  const state = document.querySelector(role === "buyer" ? "#order-state" : "#seller-orders-state");
  const pending = escrowActions.status({ orderId, role });
  const isBlocked = () => typeof blocked === "function" ? blocked() : blocked;
  if (!recovering && (isBlocked() || pending.pending || pending.unknown || pending.busy)) {
    if (state) state.textContent = escrowOperationError("escrow_action_pending");
    return;
  }
  checkoutBusy = true; syncCartControls(); latestDetailRecoveryControls(); latestSellerEscrowControls();
  if (state) state.textContent = recovering === "failure" ? "失敗した取引の確定情報を確認しています…" : recovering ? "保存した操作を照合しています…" : "操作を準備しています。ウォレットの確認前に注文の状態を確かめます…";
  try {
    let failureHistory;
    if (recovering === "failure") failureHistory = await escrowActions.recoverFailure({ orderId, role });
    else if (recovering) await escrowActions.recover({ orderId, role });
    else await escrowActions.execute({ orderId, role, action, extra: Object.freeze({ ...extra }), summary, canConfirm: () => canConfirm() && !isBlocked() });
    if (!canConfirm()) return;
    if (recovering === "failure") {
      if (state) state.textContent = failureHistory.verifiedReverted.length
        ? "端末に保存された失敗の確定情報を確認しました。履歴と一致する場合だけ次の操作を選べます。次の操作は別に選び、新しいウォレット確認で承認してください。"
        : "確定した失敗の記録がありません。未送信とは判断せず、未確認の操作の再送を止めたまま状態を確認してください。";
    } else {
      if (state) state.textContent = "保存した操作をCommerceの確定情報と照合しました。";
      if (role === "buyer") await loadOrderDetail(); else await loadSellerOrders();
    }
  } catch (error) { if (canConfirm() && state) state.textContent = escrowOperationError(error); }
  finally { checkoutBusy = false; syncCartControls(); latestDetailRecoveryControls(); latestSellerEscrowControls(); }
}
async function escrowAction(action, extra = {}, context = {}) {
  const orderId = context.orderId ?? detailOrderId;
  if (!orderId) return;
  const canConfirm = context.canConfirm ?? (() => detailOrderId === orderId && currentView === "order");
  const summary = action === "propose_resolution"
    ? `購入者の配分案：購入者へ ${extra.buyerAmountAtomic}・店舗へ ${extra.sellerAmountAtomic}（最小単位）`
    : `購入者エスクロー操作：${action}`;
  await performEscrowOperation({ orderId, role: "buyer", action, extra, summary, canConfirm, blocked: context.blocked });
}
async function recoverEscrowOperation({ orderId, role, canConfirm }, mode = true) {
  await performEscrowOperation({ orderId, role, canConfirm }, mode);
}

// 配分案は専用フォームで——WebView2には window.prompt が無い。
function escrowSplitForm(escrow, execute = escrowAction) {
  const form = document.createElement("form");
  form.className = "detail-form";
  const title = document.createElement("p");
  title.className = "meta";
  title.textContent = `ロック中の ${escrow?.amountAtomic ?? "?"}（最小単位）を分ける案を作ります。`;
  const buyer = document.createElement("input");
  buyer.type = "number";
  buyer.min = "0";
  buyer.required = true;
  buyer.placeholder = "購入者へ返す額（最小単位）";
  const seller = document.createElement("input");
  seller.type = "number";
  seller.min = "0";
  seller.required = true;
  seller.placeholder = "店舗へ支払う額（最小単位）";
  const submit = document.createElement("button");
  submit.className = "approve";
  submit.type = "submit";
  submit.textContent = "この配分を提案";
  form.append(title, buyer, seller, submit);
  form.onsubmit = (event) => {
    event.preventDefault();
    const state = document.querySelector("#order-state");
    if (!/^\d+$/.test(buyer.value) || !/^\d+$/.test(seller.value)) {
      if (state) state.textContent = "配分は0以上の整数で入力してください。";
      return;
    }
    if (escrow?.amountAtomic && BigInt(buyer.value) + BigInt(seller.value) !== BigInt(escrow.amountAtomic)) {
      if (state) state.textContent = "合計がロック中の額と一致しません。";
      return;
    }
    void execute("propose_resolution", {
      buyerAmountAtomic: buyer.value, sellerAmountAtomic: seller.value,
    });
  };
  return form;
}

function returnForm() {
  const form = document.createElement("form");
  form.className = "detail-form";
  const reason = document.createElement("select");
  reason.name = "reasonCode";
  reason.required = true;
  for (const [value, label] of [["damaged", "破損"], ["wrong_item", "商品違い"], ["not_as_described", "説明との相違"], ["other", "その他"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    reason.append(option);
  }
  const detail = document.createElement("textarea");
  detail.name = "detail";
  detail.maxLength = 1000;
  detail.rows = 3;
  detail.placeholder = "詳細（任意）";
  const submit = document.createElement("button");
  submit.className = "approve";
  submit.type = "submit";
  submit.textContent = "返品を申請";
  form.append(reason, detail, submit);
  form.onsubmit = async (event) => {
    event.preventDefault();
    const state = document.querySelector("#order-state");
    try {
      await invoke("commerce_return_request", {
        orderId: detailOrderId, accessToken: shopToken(detailOrderId) ?? "",
        reasonCode: reason.value, detail: detail.value,
      });
      if (state) state.textContent = "返品申請を受け付けました。";
      await loadOrderDetail();
    } catch (error) {
      if (state) state.textContent = `返品申請を完了できませんでした: ${friendlyError(error)}`;
    }
  };
  return form;
}

function returnShipmentForm() {
  const form = document.createElement("form");
  form.className = "detail-form";
  const carrier = document.createElement("input");
  carrier.placeholder = "配送業者";
  carrier.maxLength = 80;
  carrier.required = true;
  const tracking = document.createElement("input");
  tracking.placeholder = "追跡番号";
  tracking.maxLength = 100;
  tracking.required = true;
  const submit = document.createElement("button");
  submit.className = "approve";
  submit.type = "submit";
  submit.textContent = "返送を登録";
  form.append(carrier, tracking, submit);
  form.onsubmit = async (event) => {
    event.preventDefault();
    const state = document.querySelector("#order-state");
    try {
      await invoke("commerce_return_shipment", {
        orderId: detailOrderId, accessToken: shopToken(detailOrderId) ?? "",
        carrier: carrier.value, trackingNumber: tracking.value,
      });
      if (state) state.textContent = "返送を登録しました。";
      await loadOrderDetail();
    } catch (error) {
      if (state) state.textContent = `返送を登録できませんでした: ${friendlyError(error)}`;
    }
  };
  return form;
}

// ---- 販売者面 ----
// セッションはCommerceのCookieトークンで、資格情報保管庫に留まる——窓には
// 出ない。本人確認アサーションは開発環境ではIdentityのデモ経路（ループ
// バック限定）から引く。本番の本人確認はWeb版で行う導線をここに残す。

let sellerBusy = false;
let editingProductId = null;
let sellerOrdersFilter = "attention";

async function loadSeller() {
  const state = document.querySelector("#seller-state");
  const gate = document.querySelector("#seller-gate");
  const console_ = document.querySelector("#seller-console");
  if (!state || !gate || !console_) return;
  state.textContent = "販売者の状態を確認しています…";
  try {
    const session = await invoke("commerce_seller_state");
    if (session?.loggedIn) {
      state.textContent = "";
      gate.replaceChildren();
      gate.hidden = true;
      console_.hidden = false;
      document.querySelector("#seller-shop-name").textContent = session.seller?.publicName ?? "店舗";
      await Promise.all([loadSellerProducts(), loadSellerOrders(), loadSellerAnalytics(), loadSellerMedia(), loadSellerExceptions(), loadSellerWallet(), loadSellerDestinations()]);
      return;
    }
  } catch { /* 未ログインとして入口を出す */ }
  state.textContent = "";
  console_.hidden = true;
  gate.hidden = false;
  renderSellerGate(gate);
}

function renderSellerGate(gate) {
  const card = document.createElement("div");
  card.className = "card";
  const title = document.createElement("h3");
  title.textContent = "販売者として始める";
  const note = document.createElement("p");
  note.className = "meta";
  note.textContent = "登録済みの出品者は「販売者として入る」でこの端末のセッションを開始します。本人確認（KYC/KYB）はWeb版Hubで行います。";
  const login = document.createElement("button");
  login.type = "button";
  login.className = "approve";
  login.textContent = "販売者として入る";
  login.onclick = () => void sellerLogin();
  const openWeb = document.createElement("button");
  openWeb.type = "button";
  openWeb.className = "head-action";
  openWeb.textContent = "Webで販売者確認を開く";
  openWeb.onclick = async () => {
    try {
      const origin = await invoke("hub_origin");
      await invoke("open_external", { url: `${origin}/v2/market/products/sell` });
    } catch { /* 既定ブラウザが開けなくても致命傷ではない */ }
  };
  const row = document.createElement("div");
  row.className = "actions";
  row.append(login, openWeb);
  card.append(title, note, row, sellerOnboardingForm());
  const webRows = document.createElement("div");
  renderWebRows({ document, host: webRows, rows: WEB_ROWS.filter((entry) => entry.path !== "/v2/market/digital"), openWeb: (path) => void openHubWebPath(path) });
  gate.replaceChildren(card, webRows);
}

// 登録は challenge → 内容確認 → ウォレット署名（所有確認のみ）→ session。
function sellerOnboardingForm() {
  const wrap = document.createElement("form");
  wrap.className = "detail-form";
  const head = document.createElement("h3");
  head.textContent = "販売者登録";
  const publicName = document.createElement("input");
  publicName.placeholder = "公開名（店舗名）";
  publicName.maxLength = 100;
  publicName.required = true;
  const legalUrl = document.createElement("input");
  legalUrl.type = "url";
  legalUrl.placeholder = "販売条件・返品表示のURL（https://…）";
  legalUrl.required = true;
  const submit = document.createElement("button");
  submit.className = "approve";
  submit.type = "submit";
  submit.textContent = "登録内容を確認";
  wrap.append(head, publicName, legalUrl, submit);
  wrap.onsubmit = async (event) => {
    event.preventDefault();
    await sellerChallenge(publicName.value, legalUrl.value);
  };
  return wrap;
}

async function sellerLogin() {
  const state = document.querySelector("#seller-state");
  if (!state || sellerBusy) return;
  sellerBusy = true;
  try {
    state.textContent = "販売者として入っています…";
    await invoke("commerce_seller_login");
    await loadSeller();
  } catch (error) {
    const code = String(error);
    if (code === "seller_unavailable") {
      state.textContent = "このアサーションの販売者登録がまだありません。下のフォームで登録できます。";
    } else if (code === "seller_assertion_unavailable") {
      state.textContent = "この端末では販売者確認を発行できません。本番環境ではWeb版で販売者確認を完了してください。";
    } else {
      state.textContent = `販売者として入れませんでした: ${code}`;
    }
  } finally {
    sellerBusy = false;
  }
}

async function sellerChallenge(publicName, legalDisplayUrl) {
  const state = document.querySelector("#seller-state");
  if (!state || sellerBusy) return;
  sellerBusy = true;
  try {
    state.textContent = "登録内容を確認しています…";
    const challenge = await invoke("commerce_seller_challenge", {
      params: { publicName, legalDisplayUrl },
    });
    const summary = challenge?.summary;
    if (!challenge?.challengeId || !challenge.message || !summary) {
      throw new Error("seller_challenge_unavailable");
    }
    const ok = window.confirm(
      `以下の内容で販売者登録を行います。\n\n公開名: ${summary.publicName}\n受取ウォレット: ${summary.payoutWallet}\n販売条件: ${summary.legalDisplayUrl}\n\n続けるとウォレットの所有確認署名へ進みます。`
    );
    if (!ok) {
      state.textContent = "登録をやめました。";
      return;
    }
    state.textContent = "ウォレットで所有確認に署名してください…";
    await invoke("commerce_seller_complete", {
      challengeId: challenge.challengeId,
      message: challenge.message,
    });
    state.textContent = "販売者登録が完了しました。";
    await loadSeller();
  } catch (error) {
    const code = String(error);
    state.textContent = code === "seller_already_registered"
      ? "この確認または受取ウォレットはすでに登録済みです。「販売者として入る」を試してください。"
      : `販売者登録を完了できませんでした: ${code}`;
  } finally {
    sellerBusy = false;
  }
}

let sellerProductsAll = [];
let sellerAttributedIds = new Set();
let sellerProductsCursor = null;

async function loadSellerProducts(before) {
  const state = document.querySelector("#seller-products-state");
  const list = document.querySelector("#seller-products");
  if (!state || !list) return;
  if (!before) {
    state.textContent = "商品を読み込んでいます…";
    sellerProductsAll = [];
    sellerProductsCursor = null;
  }
  try {
    const body = await invoke("commerce_seller_products", before ? { before } : {});
    if (!before) sellerAttributedIds = new Set(await profileAttribution.ids("market").catch(() => []));
    const fresh = body?.products ?? [];
    sellerProductsCursor = body?.nextCursor ?? null;
    const known = new Set(sellerProductsAll.map((p) => p.id));
    sellerProductsAll.push(...fresh.filter((p) => !known.has(p.id)));
    if (!sellerProductsAll.length) {
      state.textContent = "出品した商品はまだありません。";
      list.replaceChildren();
      return;
    }
    state.textContent = "";
    list.replaceChildren();
    for (const product of sellerProductsAll) {
      const card = document.createElement("div");
      card.className = "card";
      const title = document.createElement("strong");
      title.textContent = `${product.title}（${product.priceJpyc.toLocaleString()} JPYC）`;
      const meta = document.createElement("p");
      meta.className = "meta";
      meta.textContent = `状態: ${product.status} ・ 在庫: ${product.stockQuantity ?? "—"} ・ ${product.fulfillmentType}`;
      const actions = document.createElement("div");
      actions.className = "actions";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "head-action";
      toggle.textContent = product.status === "active" ? "公開を止める" : "公開する";
      toggle.onclick = async () => {
        try {
          await invoke("commerce_seller_product_save", {
            params: { id: product.id, status: product.status === "active" ? "archived" : "active" },
          });
          await loadSellerProducts();
        } catch (error) {
          meta.textContent = `更新できませんでした: ${friendlyError(error)}`;
        }
      };
      const restock = document.createElement("button");
      restock.type = "button";
      restock.className = "head-action";
      restock.textContent = "在庫を更新";
      const stockForm = document.createElement("form");
      stockForm.className = "detail-form-row";
      stockForm.hidden = true;
      const stockInput = document.createElement("input");
      stockInput.type = "number";
      stockInput.min = "0";
      stockInput.max = "1000000";
      stockInput.required = true;
      stockInput.value = String(product.stockQuantity ?? 0);
      const stockSubmit = document.createElement("button");
      stockSubmit.className = "approve";
      stockSubmit.type = "submit";
      stockSubmit.textContent = "更新";
      stockForm.append(stockInput, stockSubmit);
      restock.onclick = () => { stockForm.hidden = !stockForm.hidden; };
      stockForm.onsubmit = (event) => {
        event.preventDefault();
        const next = stockInput.value;
        if (!/^\d+$/.test(next)) return;
        void (async () => {
          try {
            await invoke("commerce_seller_product_save", {
              params: {
                id: product.id,
                title: product.title, description: product.description,
                imageUrl: product.imageUrl, hubProductId: product.hubProductId,
                priceJpyc: product.priceJpyc, fulfillmentType: product.fulfillmentType,
                stockQuantity: Number(next), shippingJpyc: product.shippingJpyc,
                gasPayerPolicy: product.gasPayerPolicy,
                gasSponsorThresholdJpy: product.gasSponsorThresholdJpy,
                status: product.status,
              },
            });
            await loadSellerProducts();
          } catch (error) {
            meta.textContent = `在庫を更新できませんでした: ${friendlyError(error)}`;
          }
        })();
      };
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "head-action";
      edit.textContent = "編集";
      edit.onclick = () => {
        const form = document.querySelector("#seller-product-form");
        if (!form) return;
        editingProductId = product.id;
        form.elements["title"].value = product.title ?? "";
        form.elements["description"].value = product.description ?? "";
        form.elements["priceJpyc"].value = String(product.priceJpyc ?? 0);
        form.elements["shippingJpyc"].value = String(product.shippingJpyc ?? 0);
        form.elements["stockQuantity"].value = String(product.stockQuantity ?? 0);
        form.elements["fulfillmentType"].value = product.fulfillmentType ?? "seller_shipping";
        form.elements["status"].value = product.status ?? "active";
        form.elements["hubProductId"].value = product.hubProductId ?? "";
        form.elements["imageUrl"].value = product.imageUrl ?? "";
        form.elements["gasPayerPolicy"].value = product.gasPayerPolicy ?? "buyer";
        form.elements["gasSponsorThresholdJpy"].value = product.gasSponsorThresholdJpy != null ? String(product.gasSponsorThresholdJpy) : "";
        form.querySelector('button[type="submit"]').textContent = "商品を更新";
        form.querySelector("#seller-product-cancel").hidden = false;
        const detailsBox = document.querySelector("#seller-product-details"); if (detailsBox) detailsBox.open = true;
        form.scrollIntoView({ behavior: "smooth", block: "start" });
      };
      const profileToggle = document.createElement("button");
      profileToggle.type = "button";
      profileToggle.className = "head-action";
      const shown = sellerAttributedIds.has(product.id);
      profileToggle.textContent = shown ? "プロフィールから外す" : "プロフィールに表示";
      profileToggle.hidden = product.status !== "active" && !shown;
      profileToggle.onclick = async () => {
        profileToggle.disabled = true;
        try {
          if (shown) await profileAttribution.remove("market", product.id); else await profileAttribution.show("market", product.id);
          await loadSellerProducts();
        } catch (error) {
          meta.textContent = attributionMessage(error);
          profileToggle.disabled = false;
        }
      };
      actions.append(toggle, restock, edit, profileToggle);
      card.append(title, meta, actions, stockForm);
      list.append(card);
    }
    if (sellerProductsCursor) {
      const more = document.createElement("div");
      more.className = "actions";
      more.append(actionButton("さらに古い商品を表示", "ghost", () => void loadSellerProducts(sellerProductsCursor)));
      list.append(more);
    }
  } catch (error) {
    state.textContent = `商品を読み込めませんでした: ${friendlyError(error)}`;
  }
}

function orderNeedsAttention(order) {
  return order.escrowState === "disputed" ||
    order.returnStatus === "requested" ||
    order.hasOpenPaymentException ||
    order.escrowSubmissionFailed ||
    (order.escrowState === "funded" && order.escrowShipBy && new Date(order.escrowShipBy) <= new Date());
}

document.querySelectorAll("#seller-orders-filter button").forEach((button) => {
  button.addEventListener("click", () => {
    sellerOrdersFilter = button.dataset.filter ?? "attention";
    document.querySelectorAll("#seller-orders-filter button").forEach((b) => b.classList.toggle("on", b === button));
    void loadSellerOrders();
  });
});

// 注文一覧と返金履歴はCommerce側で別の範囲。切替ごとに読み直す。
document.querySelectorAll("#seller-orders-purpose button").forEach((button) => {
  button.addEventListener("click", () => {
    sellerOrdersPurpose = button.dataset.purpose === "refunds" ? "refunds" : "orders";
    document.querySelectorAll("#seller-orders-purpose button").forEach((b) => b.classList.toggle("on", b === button));
    const title = document.querySelector("#seller-orders-title");
    if (title) title.textContent = sellerOrdersPurpose === "refunds" ? "返金履歴" : "注文（販売分）";
    void loadSellerOrders();
  });
});

document.querySelector("#seller-orders-csv")?.addEventListener("click", async () => {
  const state = document.querySelector("#seller-orders-state");
  if (!state) return;
  try {
    const csv = await invoke("commerce_seller_orders_csv");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `orders-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    state.textContent = "CSVをダウンロードしました";
  } catch {
    state.textContent = "CSVの取得に失敗しました";
  }
});

let sellerOrdersPurpose = "orders";
let sellerOrdersGeneration = 0;
// 一覧の蓄積とカーソルは目的別に持つ——片方の「さらに表示」が
// もう片方の続きを汚さない。
const sellerOrdersData = {
  orders: { all: [], cursor: null },
  refunds: { all: [], cursor: null },
};

async function loadSellerOrders(before) {
  const state = document.querySelector("#seller-orders-state");
  const list = document.querySelector("#seller-orders");
  if (!state || !list) return;
  const generation = ++sellerOrdersGeneration, purpose = sellerOrdersPurpose, filter = sellerOrdersFilter;
  const isCurrent = () => generation === sellerOrdersGeneration && purpose === sellerOrdersPurpose && filter === sellerOrdersFilter;
  const escrowControlUpdates = [];
  const bucket = sellerOrdersData[sellerOrdersPurpose];
  if (!before) {
    state.textContent = sellerOrdersPurpose === "refunds" ? "返金履歴を読み込んでいます…" : "注文を読み込んでいます…";
    bucket.all = [];
    bucket.cursor = null;
  }
  try {
    const body = await invoke("commerce_seller_orders", {
      before: before ?? null,
      purpose: sellerOrdersPurpose === "refunds" ? "refunds" : null,
    });
    if (!isCurrent()) return;
    const fresh = body?.orders ?? [];
    bucket.cursor = body?.nextCursor ?? null;
    const known = new Set(bucket.all.map((order) => order.id));
    bucket.all.push(...fresh.filter((order) => !known.has(order.id)));
    if (!bucket.all.length) {
      state.textContent = sellerOrdersPurpose === "refunds" ? "返金履歴はまだありません。" : "販売分の注文はまだありません。";
      list.replaceChildren();
      return;
    }
    // 異議中と返品申請中の注文は詳細から解決期限・返品理由を取り込む。
    await Promise.all(fresh.map(async (order) => {
      if (!order.escrowState && order.returnStatus !== "requested") return;
      try {
        const detail = await invoke("commerce_seller_order_detail", { orderId: order.id });
        order.escrowRecoveryUnavailable = detail?.order?.id !== order.id || !Array.isArray(detail?.escrowSubmissions);
        order.escrowSubmissions = order.escrowRecoveryUnavailable ? [] : detail.escrowSubmissions;
        order.disputeResolutionDeadline = detail?.physicalEscrow?.disputeResolutionDeadline ?? null;
        order.returnReason = detail?.returnRequest?.detail
          ? `${detail.returnRequest.reasonCode ?? ""}：${detail.returnRequest.detail}`
          : (detail?.returnRequest?.reasonCode ?? null);
        order.recentEvents = (detail?.events ?? []).slice(-3).map((e) => e.publicMessage ?? e.eventType);
      } catch {
        order.escrowRecoveryUnavailable = true;
        order.disputeResolutionDeadline = null;
      }
    }));
    if (!isCurrent()) return;
    state.textContent = "";
    list.replaceChildren();
    const visible = sellerOrdersFilter === "attention" ? bucket.all.filter(orderNeedsAttention) : bucket.all;
    if (!visible.length) state.textContent = "要対応の注文はありません。";
    for (const order of visible) {
      const card = document.createElement("div");
      card.className = "card";
      const orderId = order.id;
      const sellerCurrent = () => card.isConnected && isCurrent() && currentView === "market" && !document.querySelector("#market-seller").hidden;
      const uncertain = () => escrowHistoryUncertain({ orderId, role: "seller", chainId: order.chainId, submissions: order.escrowSubmissions, unavailable: order.escrowRecoveryUnavailable, aggregateFailed: order.escrowSubmissionFailed });
      const escrowButtons = [];
      const runSeller = (action, extra = {}) => sellerEscrow(orderId, action, extra, order, { canConfirm: sellerCurrent, blocked: uncertain });
      const sellerAction = (label, kind, action) => { const button = actionButton(label, kind, () => void runSeller(action)); escrowButtons.push(button); return button; };
      const title = document.createElement("strong");
      title.textContent = `${order.productTitle ?? "商品"} × ${order.quantity}`;
      const meta = document.createElement("p");
      meta.className = "meta";
      meta.textContent = [
        `${(order.amountJpyc ?? 0).toLocaleString()} JPYC`,
        `支払い: ${orderStatusText(order.status)}`,
        `配送: ${order.fulfillmentStatus ? fulfillmentText(order.fulfillmentStatus) : "発送準備前"}`,
        order.escrowState ? `ロック: ${escrowText(order.escrowState)}` : "",
        order.escrowShipBy ? `発送期限: ${new Date(order.escrowShipBy).toLocaleString("ja-JP")}` : "",
        order.returnStatus ? `返品: ${returnText(order.returnStatus)}` : "",
        order.refundStatus ? `返金: ${order.refundStatus}` : "",
        order.trackingNumber ? `追跡: ${order.shippingCarrier ?? ""} ${order.trackingNumber}` : "",
      ].filter(Boolean).join(" ・ ");
      card.append(title, meta);
      if (order.paidAt && Date.now() - Date.parse(order.paidAt) < 86_400_000 && order.fulfillmentStatus !== "shipped") {
        const badge = document.createElement("p");
        badge.className = "meta";
        badge.style.cssText = "color:var(--emphasis);font-weight:700";
        badge.textContent = "新規注文";
        card.append(badge);
      }
      if (order.escrowState === "funded" && order.escrowShipBy && new Date(order.escrowShipBy) <= new Date()) {
        const overdue = document.createElement("p");
        overdue.className = "meta";
        overdue.textContent = "発送期限を過ぎています。購入者が未発送返金を請求できる状態です。";
        card.append(overdue);
      }
      if (order.hasOpenPaymentException) {
        const exception = document.createElement("p");
        exception.className = "meta";
        exception.textContent = "支払いの整合が取れていません。支払い例外の一覧で内容を確認してください。";
        card.append(exception);
      }
      if (order.escrowSubmissionFailed && !order.escrowState) {
        const failed = document.createElement("p");
        failed.className = "meta";
        failed.textContent = "以前の操作を確認できません。未送信や再実行可能とは判断せず、保存した操作を照合してください。";
        card.append(failed);
      }
      if (order.returnStatus === "received" && order.status === "paid") {
        const refundHint = document.createElement("p");
        refundHint.className = "meta";
        refundHint.textContent = ["funded", "shipped"].includes(order.escrowState)
          ? "返品商品を受領済みです。「購入者へ返金」でエスクロー内の資金を返してください。"
          : "返品商品を受領済みです。返金メニューから購入者への送金を実行してください。";
        card.append(refundHint);
      }
      const ops = document.createElement("div");
      ops.className = "actions";
      // 返品の裁定：申請中→承認/却下、承認・返送中→受領。
      if (order.returnStatus === "requested") {
        if (order.returnReason) {
          const reason = document.createElement("p");
          reason.className = "meta";
          reason.textContent = `返品の申し出：${order.returnReason}`;
          card.append(reason);
        }
        ops.append(
          actionButton("返品を承認", "primary", () => void sellerReturnReview(order.id, "approved")),
          actionButton("返品を却下", "danger", () => void sellerReturnReview(order.id, "rejected")),
        );
      }
      if (["approved", "in_transit"].includes(order.returnStatus)) {
        ops.append(actionButton("返品を受領した", "primary", () => void sellerReturnReview(order.id, "received")));
      }
      // エスクローが乗る注文のオンチェーン操作。発送確定はDBの追跡登録とは別に要る。
      if (order.escrowState === "funded") {
        ops.append(sellerAction("発送をオンチェーン確定", "primary", "ship"));
      }
      if (["funded", "shipped"].includes(order.escrowState)) {
        if (order.escrowState === "shipped" && order.escrowReleaseAt && new Date(order.escrowReleaseAt) <= new Date()) {
          ops.append(sellerAction("受取期限が過ぎたため代金を回収", "primary", "release"));
        }
        ops.append(
          sellerAction("エスクローから返金", "danger", "refund_by_seller"),
          sellerAction("問題を報告して支払い停止", "danger", "dispute"),
        );
      }
      if (order.escrowState === "disputed") {
        if (order.disputeResolutionDeadline) {
          const deadline = document.createElement("p");
          deadline.className = "meta";
          deadline.textContent = `仲裁の解決期限：${new Date(order.disputeResolutionDeadline).toLocaleString("ja-JP")}`;
          card.append(deadline);
        }
        if (order.recentEvents?.length) {
          const log = document.createElement("details");
          log.className = "meta";
          const summary = document.createElement("summary");
          summary.textContent = "経緯を見る";
          const items = document.createElement("ul");
          for (const event of order.recentEvents) {
            const li = document.createElement("li");
            li.textContent = event;
            items.append(li);
          }
          log.append(summary, items);
          card.append(log);
        }
        if (order.proposalProposedBy === "buyer") {
          const proposal = document.createElement("p");
          proposal.className = "meta";
          proposal.textContent = `購入者の配分案：購入者へ ${formatAtomicAmount(order.proposalBuyerAmountAtomic, order.paymentTokenDecimals, order.paymentCurrency)}・店舗へ ${formatAtomicAmount(order.proposalSellerAmountAtomic, order.paymentTokenDecimals, order.paymentCurrency)}`;
          card.append(proposal);
          ops.append(sellerAction("この配分案を承認して解決", "primary", "accept_resolution"));
        } else if (order.proposalProposedBy === "seller") {
          const waiting = document.createElement("p");
          waiting.className = "meta";
          waiting.textContent = "自分の配分案は購入者の承認待ちです。";
          card.append(waiting);
        }
        if (!order.disputeResolutionDeadline || Date.now() >= Date.parse(order.disputeResolutionDeadline))
          ops.append(sellerAction("異議の解決期限が過ぎた場合、異議前の状態へ戻す", "ghost", "finalize_expired_dispute"));
      }
      // エスクローに乗らない直払い分の返金。
      if (!order.escrowState) {
        const refundRow = document.createElement("div"); refundRow.className = "actions";
        refundRow.style.flexWrap = "wrap"; refundRow.style.justifyContent = "flex-start";
        const hint = document.createElement("p"); hint.className = "meta"; hint.setAttribute("role", "status");
        let confirmed = false;
        const blocked = () => confirmed || order.refundStatus === "submitted";
        const context = { canConfirm: sellerCurrent, blocked, onConfirmed: () => { confirmed = true; } };
        const refund = ["paid", "partially_refunded"].includes(order.status)
          ? actionButton("購入者へ返金", "primary", () => void sellerRefund(orderId, context)) : null;
        const recover = actionButton("保存した返金を照合", "danger", () => void sellerRefund(orderId, context, true));
        for (const button of [refund, recover].filter(Boolean)) { button.style.flex = "0 0 auto"; refundRow.append(button); }
        card.append(hint, refundRow);
        escrowControlUpdates.push(() => {
          if (!list.contains(card)) return;
          const pending = refundActions.status({ orderId });
          if (refund) refund.disabled = checkoutBusy || pending.busy || pending.pending || pending.unknown || blocked();
          recover.disabled = checkoutBusy || pending.busy;
          hint.textContent = confirmed ? "店舗から購入者への返金送金を確認済みです。Hub手数料分を含む返金全体の完了は、返金履歴の状態を確認してください。"
            : pending.pending || pending.unknown || order.refundStatus === "submitted"
              ? "返金の結果が未確認です。未送信とは判断せず、新しい返金を止めています。保存した返金を照合してください。"
              : "店舗から購入者への送金確認と、Hub手数料分を含む返金全体の完了は別です。保存した返金の照合では新しい署名・送金を行いません。";
        });
      }
      if (ops.childElementCount) card.append(ops);
      if (order.escrowState === "disputed") {
        const split = sellerSplitForm(orderId, runSeller); card.append(split); escrowButtons.push(...split.querySelectorAll("button,input"));
      }
      if (order.escrowState) {
        const recovery = document.createElement("div"); recovery.className = "actions";
        const recover = actionButton("保存した操作を照合", "danger", () => void recoverEscrowOperation({ orderId, role: "seller", canConfirm: sellerCurrent }));
        const hint = document.createElement("p"); hint.className = "meta"; hint.setAttribute("role", "status");
        const inspect = actionButton("失敗した取引を確認", "danger", () => void recoverEscrowOperation({ orderId, role: "seller", canConfirm: sellerCurrent }, "failure"));
        recovery.style.flexWrap = "wrap";
        recovery.style.justifyContent = "flex-start";
        recover.style.flex = inspect.style.flex = "0 0 auto";
        recovery.append(recover, inspect); card.append(hint, recovery);
        escrowControlUpdates.push(() => {
          if (!list.contains(card)) return;
          const pending = escrowActions.status({ orderId, role: "seller" });
          const blocked = uncertain();
          for (const button of escrowButtons) button.disabled = checkoutBusy || pending.busy || pending.pending || pending.unknown || blocked;
          recover.disabled = inspect.disabled = checkoutBusy || pending.busy;
          hint.textContent = pending.pending || pending.unknown || blocked ? "以前の操作の結果が未確認です。未送信とは判断せず、新しい操作を止めています。保存した操作の照合や失敗した取引の確認を行ってください。" : "次の操作は別に選び、新しいウォレット確認で承認してください。保存した操作の照合や失敗した取引の確認では署名・送金を行いません。";
        });
      }
      // 受け取り販売には配送が無い——発送ではなく引き渡しを記録する。
      if (order.status === "paid" && order.fulfillmentType === "pickup" && order.fulfillmentStatus !== "delivered") {
        const pickup = document.createElement("div");
        pickup.className = "actions";
        pickup.append(actionButton("商品を渡したので引き渡し済みにする", "primary", async () => {
          try {
            await invoke("commerce_seller_mark_delivered", { orderId: order.id });
            if (state) state.textContent = "引き渡し済みにしました。";
            await loadSellerOrders();
          } catch (error) {
            if (state) state.textContent = `引き渡しを記録できませんでした: ${friendlyError(error)}`;
          }
        }));
        card.append(pickup);
      }
      if (order.status === "paid" && !["shipped", "delivered"].includes(order.fulfillmentStatus) && !["digital", "pickup"].includes(order.fulfillmentType)) {
        card.append(shipForm(order.id, state));
      }
      if (order.status === "paid" && order.fulfillmentStatus === "shipped") {
        const edit = shipForm(order.id, state);
        edit.querySelector("input").value = order.shippingCarrier ?? "";
        edit.querySelectorAll("input")[1].value = order.trackingNumber ?? "";
        edit.querySelector("button").textContent = "追跡情報を修正";
        card.append(edit);
      }
      list.append(card);
    }
    latestSellerEscrowControls = () => escrowControlUpdates.forEach((update) => update());
    latestSellerEscrowControls();
    if (bucket.cursor) {
      const more = document.createElement("div");
      more.className = "actions";
      more.append(actionButton(sellerOrdersPurpose === "refunds" ? "さらに古い履歴を表示" : "さらに古い注文を表示", "ghost", () => void loadSellerOrders(bucket.cursor)));
      list.append(more);
    }
  } catch (error) {
    if (!isCurrent()) return;
    state.textContent = `注文を読み込めませんでした: ${friendlyError(error)}`;
  }
}

function shipForm(orderId) {
  const form = document.createElement("form");
  form.className = "detail-form";
  const row = document.createElement("div");
  row.className = "detail-form-row";
  const carrier = document.createElement("input");
  carrier.placeholder = "配送業者（例: ヤマト運輸）";
  carrier.maxLength = 80;
  carrier.required = true;
  const tracking = document.createElement("input");
  tracking.placeholder = "追跡番号";
  tracking.maxLength = 100;
  tracking.required = true;
  const submit = document.createElement("button");
  submit.className = "approve";
  submit.type = "submit";
  submit.textContent = "発送を登録";
  row.append(carrier, tracking, submit);
  form.append(row);
  form.onsubmit = async (event) => {
    event.preventDefault();
    const state = document.querySelector("#seller-orders-state");
    try {
      await invoke("commerce_seller_ship", {
        orderId, carrier: carrier.value, trackingNumber: tracking.value,
      });
      if (state) state.textContent = "発送を登録しました。";
      await loadSellerOrders();
    } catch (error) {
      if (state) state.textContent = `発送を登録できませんでした: ${friendlyError(error)}`;
    }
  };
  return form;
}

async function sellerReturnReview(orderId, decision) {
  const state = document.querySelector("#seller-orders-state");
  try {
    await invoke("commerce_seller_return_review", { orderId, decision });
    if (state) state.textContent = "返品の裁定を登録しました。";
    await loadSellerOrders();
  } catch (error) {
    if (state) state.textContent = `返品の裁定を登録できませんでした: ${friendlyError(error)}`;
  }
}

// 出品者側のエスクロー操作。calldataはCommerceが組み立て、送信はウォレットの
// 確認モーダル、確定はCommerceがtxを読んで照合する——購入者側と同じ3段。
async function sellerEscrow(orderId, action, extra = {}, order = null, context = {}) {
  const purpose = sellerOrdersPurpose, filter = sellerOrdersFilter;
  const canConfirm = context.canConfirm ?? (() => currentView === "market" && !document.querySelector("#market-seller").hidden && sellerOrdersPurpose === purpose && sellerOrdersFilter === filter);
  const summary = action === "propose_resolution"
    ? `店舗の配分案：購入者へ ${extra.buyerAmountAtomic}・店舗へ ${extra.sellerAmountAtomic}（最小単位）`
    : `店舗エスクロー操作：${action}`;
  await performEscrowOperation({ orderId, role: "seller", action, extra, summary, canConfirm, blocked: context.blocked });
}

function sellerSplitForm(orderId, execute = (action, extra) => sellerEscrow(orderId, action, extra)) {
  const form = document.createElement("form");
  form.className = "detail-form";
  const title = document.createElement("p");
  title.className = "meta";
  title.textContent = "ロック中の額を購入者と分ける案を作ります（最小単位・合計はロック額と一致させてください）。";
  const buyer = document.createElement("input");
  buyer.type = "number";
  buyer.min = "0";
  buyer.required = true;
  buyer.placeholder = "購入者へ返す額";
  const seller = document.createElement("input");
  seller.type = "number";
  seller.min = "0";
  seller.required = true;
  seller.placeholder = "店舗へ支払う額";
  const submit = document.createElement("button");
  submit.className = "approve";
  submit.type = "submit";
  submit.textContent = "この配分を提案";
  form.append(title, buyer, seller, submit);
  form.onsubmit = (event) => {
    event.preventDefault();
    if (!/^\d+$/.test(buyer.value) || !/^\d+$/.test(seller.value)) return;
    void execute("propose_resolution", {
      buyerAmountAtomic: buyer.value, sellerAmountAtomic: seller.value,
    });
  };
  return form;
}

// 直払い分の返金: 見積(quote) → sellerTransferをウォレット送信 → tx照合。
function refundOperationError(error) {
  const code = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const messages = {
    refund_action_invalid: "返金の内容を確認できません。新しい返金を送らず、注文の状態を確認してください。",
    refund_action_busy: "別の返金を確認中です。完了するまでお待ちください。",
    refund_action_pending: "保存した返金が未確認です。新しい返金を送らず、保存した返金を照合してください。",
    refund_action_unknown: "返金の結果を確認できません。未送信とは判断せず、再送を止めたまま保存した返金を照合してください。",
    refund_action_status_mismatch: "保存した返金と注文の応答が一致しません。再送せず、注文の状態を確認してください。",
    refund_action_preparation_unavailable: "返金の見積や支払先を確認できません。ウォレット確認を始めず、注文の状態を確認してください。",
    refund_action_recovery_unavailable: "保存した返金を照合できません。未送信とは判断せず、再送を止めたまま状態を確認してください。",
  };
  if (messages[code]) return messages[code];
  if (["wallet_user_rejected", "wallet_confirm_busy", "wallet_confirm_unavailable", "wallet_fee_unavailable", "wallet_fee_expired", "wallet_fee_stale"].includes(code)) return shopPaymentError(error);
  return "返金の結果を確認できません。未送信とは判断せず、再送を止めたまま保存した返金と注文の状態を確認してください。";
}
async function sellerRefund(orderId, context = {}, recovering = false) {
  const { canConfirm, blocked = () => false, onConfirmed } = context;
  if (checkoutBusy || typeof canConfirm !== "function" || !canConfirm()) return;
  const state = document.querySelector("#seller-orders-state");
  const pending = refundActions.status({ orderId });
  if (pending.busy || (!recovering && (blocked() || pending.pending || pending.unknown))) return;
  checkoutBusy = true; syncCartControls(); latestDetailRecoveryControls(); latestSellerEscrowControls();
  if (state) state.textContent = recovering ? "保存した返金を照合しています…" : "返金の内容を確認しています。店舗から購入者への送金はウォレットで確認してから行います…";
  try {
    const result = recovering ? await refundActions.recover({ orderId })
      : await refundActions.execute({ orderId, canConfirm: () => canConfirm() && !blocked() });
    if (!canConfirm()) return;
    if (result.noPending) {
      if (state) state.textContent = "保存した未確認の返金は見つかりませんでした。過去の返金が未送信とは判断しません。返金履歴の状態を確認してください。";
    } else {
      onConfirmed?.();
      if (state) state.textContent = "店舗から購入者への返金送金を確認しました。Hub手数料分を含む返金全体の完了は、返金履歴の状態を確認してください。";
    }
  } catch (error) {
    if (canConfirm() && state) state.textContent = refundOperationError(error);
  }
  finally { checkoutBusy = false; syncCartControls(); latestDetailRecoveryControls(); latestSellerEscrowControls(); }
}

async function loadSellerAnalytics() {
  const state = document.querySelector("#seller-analytics-state");
  const target = document.querySelector("#seller-analytics");
  if (!state || !target) return;
  try {
    const body = await invoke("commerce_seller_analytics");
    const s = body?.summary ?? {};
    const net = (s.grossJpyc ?? 0) - (s.refundedJpyc ?? 0);
    const dl = document.createElement("dl");
    detailRow(dl, "確定済み注文", `${s.orders ?? 0} 件`);
    detailRow(dl, "売上総額", `${(s.grossJpyc ?? 0).toLocaleString()} JPYC`);
    detailRow(dl, "返金額", `${(s.refundedJpyc ?? 0).toLocaleString()} JPYC`);
    detailRow(dl, "手取り（返金控除後）", `${net.toLocaleString()} JPYC`);
    target.replaceChildren(dl);
    const top = (body?.products ?? []).slice(0, 5);
    if (top.length) {
      const ul = document.createElement("ul");
      for (const row of top) {
        const li = document.createElement("li");
        li.className = "meta";
        li.textContent = `${row.title} — ${row.quantity}点・${(row.grossJpyc ?? 0).toLocaleString()} JPYC`;
        ul.append(li);
      }
      target.append(ul);
    }
    state.textContent = "";
  } catch (error) {
    state.textContent = `売上を読み込めませんでした: ${friendlyError(error)}`;
  }
}

let sellerMediaAll = [];
let sellerMediaCursor = null;

async function loadSellerMedia(before) {
  const state = document.querySelector("#seller-media-state");
  const target = document.querySelector("#seller-media");
  if (!state || !target) return;
  if (!before) {
    sellerMediaAll = [];
    sellerMediaCursor = null;
  }
  try {
    const body = await invoke("commerce_seller_media", before ? { before } : {});
    const fresh = body?.media ?? [];
    sellerMediaCursor = body?.nextCursor ?? null;
    const known = new Set(sellerMediaAll.map((i) => i.id));
    sellerMediaAll.push(...fresh.filter((i) => !known.has(i.id)));
    target.replaceChildren();
    for (const item of sellerMediaAll) {
      const row = document.createElement("p");
      row.className = "meta";
      const statusText = item.status === "clean" ? "利用可" : item.status === "rejected" ? "却下" : "審査中";
      row.textContent = `${item.id} — ${statusText}${item.byteLength ? `（${Math.round(item.byteLength / 1024)}KB）` : ""}`;
      if (item.status === "clean" && item.url) {
        const use = document.createElement("button");
        use.type = "button";
        use.className = "head-action";
        use.textContent = "商品フォームに入れる";
        use.onclick = () => {
          const field = document.querySelector('#seller-product-form input[name="imageUrl"]');
          if (field) field.value = item.url;
        };
        row.append(" ", use);
      }
      const del = document.createElement("button");
      del.type = "button";
      del.className = "head-action";
      del.textContent = "削除";
      del.onclick = async () => {
        try {
          await invoke("commerce_seller_media_delete", { mediaId: item.id });
          await loadSellerMedia();
        } catch {
          if (state) state.textContent = "画像を削除できませんでした。";
        }
      };
      row.append(" ", del);
      target.append(row);
    }
    if (sellerMediaCursor) {
      const more = document.createElement("div");
      more.className = "actions";
      more.append(actionButton("さらに古い画像を表示", "ghost", () => void loadSellerMedia(sellerMediaCursor)));
      target.append(more);
    }
    state.textContent = sellerMediaAll.length ? "アップロード済みの画像：" : "アップロードした画像は検疫と審査を通った後に配信URLが有効になります。";
  } catch (error) {
    state.textContent = `画像一覧を読み込めませんでした: ${friendlyError(error)}`;
  }
}

// 支払い例外: 過少は購入者の追加入金待ち（こちらからは動かせない）、
// 過払いは差額を購入者へ返すtxを送って照合する。tx specはサーバー生成。
async function loadSellerExceptions() {
  const state = document.querySelector("#seller-exceptions-state");
  const target = document.querySelector("#seller-exceptions");
  if (!state || !target) return;
  try {
    const body = await invoke("commerce_seller_payment_exceptions");
    const list = (body?.exceptions ?? []).filter((e) => e.status === "open");
    target.replaceChildren();
    if (!list.length) {
      state.textContent = "確認が必要な支払いはありません。";
      return;
    }
    state.textContent = "";
    for (const item of list) {
      const row = document.createElement("p");
      row.className = "meta";
      const expected = formatAtomicAmount(item.expectedAtomic, item.paymentTokenDecimals, item.paymentCurrency);
      const observed = formatAtomicAmount(item.observedAtomic, item.paymentTokenDecimals, item.paymentCurrency);
      row.textContent = item.exceptionType === "overpaid"
        ? `注文 ${item.orderId}：請求 ${expected} に対し ${observed} が入金（多すぎ）`
        : `注文 ${item.orderId}：請求 ${expected} に対し ${observed} しか入金されていません（購入者の追加入金待ち）`;
      if (item.resolutionTransfer) {
        const resolve = document.createElement("button");
        resolve.type = "button";
        resolve.className = "head-action";
        resolve.textContent = "差額を返送して解決";
        resolve.onclick = async () => {
          // 返送はpayoutWalletからでないと照合が通らない——先に端末鍵と照らす。
          try {
            const status = await invoke("wallet_status");
            if (item.payoutWallet && status?.address
                && status.address.toLowerCase() !== String(item.payoutWallet).toLowerCase()) {
              if (state) state.textContent = `この端末のウォレット（${status.address}）は店舗の受取ウォレットと違います。登録した端末で操作してください。`;
              return;
            }
          } catch { /* ウォレット未作成なら送信段階で弾かれる */ }
          void sellerResolveException(item);
        };
        row.append(" ", resolve);
      } else if (item.exceptionType === "underpaid") {
        // 購入者が窓外で送金した場合、取引IDを登録すればCommerceが照合する。
        const form = document.createElement("form");
        form.className = "detail-form";
        const input = document.createElement("input");
        input.type = "text";
        input.placeholder = "0x…（購入者の送金取引ID）";
        input.required = true;
        input.pattern = "0x[0-9a-fA-F]{64}";
        const submit = document.createElement("button");
        submit.type = "submit";
        submit.className = "head-action";
        submit.textContent = "取引IDを登録して照合";
        form.append(input, submit);
        form.onsubmit = async (event) => {
          event.preventDefault();
          try {
            state.textContent = "取引を照合しています…";
            await invoke("commerce_seller_payment_exception_resolve", {
              exceptionId: item.id, transactionHash: input.value.trim(),
            });
            state.textContent = "支払い例外を解決しました。";
            await loadSellerExceptions();
          } catch (error) {
            state.textContent = `解決できませんでした: ${friendlyError(error)}`;
          }
        };
        target.append(form);
      }
      target.append(row);
    }
  } catch (error) {
    state.textContent = `支払い例外を読み込めませんでした: ${friendlyError(error)}`;
  }
}

async function sellerResolveException(item) {
  const state = document.querySelector("#seller-exceptions-state");
  const spec = item.resolutionTransfer;
  if (!spec) return;
  try {
    const diff = formatAtomicAmount(String(BigInt(item.observedAtomic) - BigInt(item.expectedAtomic)), item.paymentTokenDecimals, item.paymentCurrency);
    if (state) state.textContent = "ウォレットで返送を確認してください…";
    const transactionHash = await invoke("wallet_send_contract", {
      chainId: spec.chainId, to: spec.to,
      valueWei: shopAtomicHex(spec.value), data: spec.data,
      summary: `支払い例外の解決: 注文 ${item.orderId} の超過分 ${diff} を購入者へ返送`,
    });
    let lastError = "";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 2000));
      if (state) state.textContent = "返送した取引を照合しています…";
      try {
        await invoke("commerce_seller_payment_exception_resolve", {
          exceptionId: item.id, transactionHash,
        });
        lastError = "";
        break;
      } catch (error) {
        lastError = String(error);
        if (lastError !== "transaction_not_confirmed") break;
      }
    }
    if (lastError) throw new Error(lastError === "transaction_not_confirmed" ? "送信済みですが、確定監視が時間内に完了しませんでした。" : friendlyError(lastError));
    if (state) state.textContent = "支払い例外を解決しました。";
    await loadSellerExceptions();
  } catch (error) {
    if (state) state.textContent = `解決できませんでした: ${friendlyError(error)}`;
  }
}

async function loadSellerWallet() {
  const state = document.querySelector("#seller-wallet-state");
  const target = document.querySelector("#seller-wallet");
  if (!state || !target) return;
  try {
    const body = await invoke("commerce_seller_wallet");
    target.replaceChildren();
    if (!body?.wallet) {
      state.textContent = "加盟店ウォレットはまだ設定されていません。";
      const account=desktopAccount, generation=researchAccountGeneration;
      const setup=actionButton('Webで登録内容を確認','head-action',async()=>{
        if(account!==desktopAccount||generation!==researchAccountGeneration||currentView!=='market')return;
        setup.disabled=true;
        try {
          const origin=new URL(await invoke('hub_origin'));
          if(origin.username||origin.password||!['http:','https:'].includes(origin.protocol)||account!==desktopAccount||generation!==researchAccountGeneration||currentView!=='market')return;
          await invoke('open_external',{url:new URL('/v2/market/products/sell',origin.origin).href});
        }catch(error){if(account===desktopAccount&&generation===researchAccountGeneration)state.textContent=friendlyError(error);}
        finally{if(setup.isConnected)setup.disabled=false;}
      });
      target.append(setup);
      return;
    }
    const w = body.wallet;
    const dl = document.createElement("dl");
    detailRow(dl, "アドレス", w.walletAddress ?? "—");
    detailRow(dl, "チェーン", w.chainId ? `eip155:${w.chainId}` : "—");
    detailRow(dl, "状態", w.status ?? "—");
    if (w.dailyLimitJpy) detailRow(dl, "1日の上限", `${Number(w.dailyLimitJpy).toLocaleString()} 円`);
    const members = body?.members ?? [];
    if (members.length) {
      const ul = document.createElement("ul");
      for (const m of members) {
        const li = document.createElement("li");
        li.className = "meta";
        li.textContent = `${m.role}（${m.status}・passkey ${m.passkeyCount ?? 0}）`;
        ul.append(li);
      }
      const dt = document.createElement("dt");
      dt.textContent = "メンバー";
      const dd = document.createElement("dd");
      dd.append(ul);
      dl.append(dt, dd);
    }
    const withdrawals = body?.withdrawals ?? [];
    if (withdrawals.length) {
      const ul = document.createElement("ul");
      for (const wd of withdrawals.slice(0, 10)) {
        const li = document.createElement("li");
        li.className = "meta";
        li.textContent = `${Number(wd.amountJpy ?? 0).toLocaleString()} 円 → ${wd.destinationAddress}（${wd.status}${wd.requiredApprovals > 1 ? `・承認 ${wd.requiredApprovals} 必要` : ""}）`;
        ul.append(li);
      }
      const dt = document.createElement("dt");
      dt.textContent = "出金リクエスト";
      const dd = document.createElement("dd");
      dd.append(ul);
      dl.append(dt, dd);
    }
    target.append(dl);
    state.textContent = "";
  } catch (error) {
    state.textContent = `ウォレット情報を読み込めませんでした: ${friendlyError(error)}`;
  }
}

let sellerChainCatalog = [];

async function loadSellerDestinations() {
  const state = document.querySelector("#seller-destinations-state");
  const target = document.querySelector("#seller-destinations");
  const form = document.querySelector("#seller-destination-form");
  if (!state || !target || !form) return;
  try {
    const [body, catalog] = await Promise.all([
      invoke("commerce_seller_chain_destinations"),
      sellerChainCatalog.length
        ? Promise.resolve({ chains: sellerChainCatalog })
        : invoke("commerce_payment_chain_catalog"),
    ]);
    sellerChainCatalog = catalog?.chains ?? [];
    const select = form.elements.networkKey;
    if (select && !select.options.length) {
      for (const chain of sellerChainCatalog) {
        const option = document.createElement("option");
        option.value = chain.key;
        option.textContent = `${chain.label}（${chain.nativeSymbol}）`;
        select.append(option);
      }
    }
    const list = body?.destinations ?? [];
    target.replaceChildren();
    if (!list.length) {
      state.textContent = "受取先は未設定です。チェーンを選んで登録してください。";
      return;
    }
    state.textContent = "";
    for (const d of list) {
      const row = document.createElement("p");
      row.className = "meta";
      const label = sellerChainCatalog.find((c) => c.key === d.networkKey)?.label ?? d.networkKey;
      row.textContent = `${label}: ${d.address}${d.addressTag ? `（タグ ${d.addressTag}）` : ""} — ${d.status === "active" ? "有効" : "無効"}`;
      if (d.status === "active") {
        const disable = document.createElement("button");
        disable.type = "button";
        disable.className = "head-action";
        disable.textContent = "無効化";
        disable.onclick = async () => {
          try {
            await invoke("commerce_seller_chain_destination_disable", { networkKey: d.networkKey });
            await loadSellerDestinations();
          } catch (error) {
            state.textContent = `無効化できませんでした: ${friendlyError(error)}`;
          }
        };
        row.append(" ", disable);
      }
      target.append(row);
    }
  } catch (error) {
    state.textContent = `受取先を読み込めませんでした: ${friendlyError(error)}`;
  }
}

shopLoad();
for (const tab of document.querySelectorAll("[data-shop-tab]")) {
  tab.onclick = () => {
    for (const other of document.querySelectorAll("[data-shop-tab]")) other.classList.toggle("on", other === tab);
    const current = tab.dataset.shopTab === "games" ? "products" : tab.dataset.shopTab;
    if (tab.dataset.shopTab === "games") marketBrowse?.setCategory("game");
    document.querySelector("#market-shop").hidden = current !== "products";
    document.querySelector("#market-games").hidden = true;
    document.querySelector("#market-api").hidden = true;
    document.querySelector("#market-listings").hidden = current !== "listings";
    document.querySelector("#market-seller").hidden = current !== "seller";
    syncOwnedEventListings();
    if (current === "listings") { void loadMarketTickets(); if (!document.querySelector("#market-results")?.childElementCount) void loadCatalog("market"); }
    if (current === "products") marketBrowse?.show();
    if (current === "seller") void loadSeller();
  };
}
bindSearchInput(document.querySelector("#shop-query"), {delay: 0, search: searchShop, invalidate: () => { clearTimeout(shopSearchTimer); shopLoadVersion++; shop.busy = true; shop.nextCursor = null; }});
// 並べ替え・在庫あり・送料無料はサーバーに渡して1頁目から読み直す（読込済みの頁だけを並べ替えると未読の頁が漏れる）。
function applyShopControls() {
  const sort = document.querySelector("#shop-sort")?.value;
  shop.sort = ["new", "price_asc", "price_desc"].includes(sort) ? sort : "new";
  shop.inStock = document.querySelector("#shop-in-stock")?.checked === true;
  shop.freeShipping = document.querySelector("#shop-free-shipping")?.checked === true;
  clearTimeout(shopSearchTimer);
  shopLoadVersion++;
  shop.nextCursor = null;
  void loadShop();
}
for (const id of ["#shop-sort", "#shop-in-stock", "#shop-free-shipping"]) document.querySelector(id)?.addEventListener("change", applyShopControls);
document.querySelector("#market-cart-open")?.addEventListener("click", () => {
  showView("cart", "カート");
  void renderCart();
});
document.querySelector("#cart-back")?.addEventListener("click", () => {
  document.querySelector('.nav-item[data-view="market"]')?.click();
});
document.querySelector("#cart-checkout")?.addEventListener("click", () => void cartCheckout());
document.querySelector("#cart-country")?.addEventListener("change", async () => {
  if (shopCartLocked()) { const selection = shop.prepared ?? checkoutSelection; if (selection) document.querySelector("#cart-country").value = selection.country; return; }
  await discardPrepared();
});
document.querySelector("#cart-asset")?.addEventListener("change", async () => {
  if (shopCartLocked()) { const selection = shop.prepared ?? checkoutSelection; if (selection) document.querySelector("#cart-asset").value = selection.assetKey; return; }
  await discardPrepared();
});
document.querySelector("#order-back")?.addEventListener("click", () => {
  document.querySelector('.nav-item[data-view="purchased"]')?.click();
});
document.querySelector("#seller-product-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const state = document.querySelector("#seller-product-state");
  const data = new FormData(form);
  if (String(data.get("gasPayerPolicy")) === "merchant_above_threshold"
      && !(Number(data.get("gasSponsorThresholdJpy")) > 0)) {
    if (state) state.textContent = "「一定額以上で店舗が負担」には1円以上の閾値が必要です。";
    return;
  }
  try {
    if (state) state.textContent = editingProductId ? "商品を更新しています…" : "商品を登録しています…";
    await invoke("commerce_seller_product_save", {
      params: {
        ...(editingProductId ? { id: editingProductId } : {}),
        title: String(data.get("title") ?? "").trim(),
        description: String(data.get("description") ?? "").trim(),
        priceJpyc: Number(data.get("priceJpyc")),
        shippingJpyc: Number(data.get("shippingJpyc") ?? 0),
        stockQuantity: Number(data.get("stockQuantity")),
        fulfillmentType: String(data.get("fulfillmentType") ?? "seller_shipping"),
        status: String(data.get("status") ?? "active"),
        gasPayerPolicy: String(data.get("gasPayerPolicy") ?? "buyer"),
        gasSponsorThresholdJpy: String(data.get("gasPayerPolicy")) === "merchant_above_threshold"
          ? Number(data.get("gasSponsorThresholdJpy"))
          : null,
        imageUrl: String(data.get("imageUrl") ?? "").trim() || null,
        hubProductId: String(data.get("hubProductId") ?? "").trim() || null,
      },
    });
    if (state) state.textContent = editingProductId ? "商品を更新しました。" : "商品を登録しました。";
    editingProductId = null;
    form.reset();
    form.querySelector('button[type="submit"]').textContent = "商品を登録";
    form.querySelector("#seller-product-cancel").hidden = true;
    await loadSellerProducts();
  } catch (error) {
    if (state) state.textContent = `商品を${editingProductId ? "更新" : "登録"}できませんでした: ${friendlyError(error)}`;
  }
});
document.querySelector("#seller-product-cancel")?.addEventListener("click", () => {
  const form = document.querySelector("#seller-product-form");
  if (!form) return;
  editingProductId = null;
  form.reset();
  form.querySelector('button[type="submit"]').textContent = "商品を登録";
  document.querySelector("#seller-product-cancel").hidden = true;
});
document.querySelector("#seller-logout")?.addEventListener("click", async () => {
  try {
    await invoke("commerce_seller_logout");
  } finally {
    await loadSeller();
  }
});
document.querySelector("#seller-destination-wallet")?.addEventListener("click", async () => {
  const form = document.querySelector("#seller-destination-form");
  const select = form?.elements.networkKey;
  const chain = sellerChainCatalog.find((c) => c.key === select?.value);
  if (chain?.family !== "evm") return;
  try {
    const status = await invoke("wallet_status");
    if (status?.address && form) form.elements.address.value = status.address;
  } catch { /* ウォレット未作成なら手入力のまま */ }
});
document.querySelector("#seller-destination-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const state = document.querySelector("#seller-destinations-state");
  const data = new FormData(form);
  const address = String(data.get("address") ?? "").trim();
  const chain = sellerChainCatalog.find((c) => c.key === String(data.get("networkKey")));
  if (chain?.family === "evm" && !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    if (state) state.textContent = "EVMチェーンの受取先は 0x… 形式のアドレスが必要です。";
    return;
  }
  try {
    if (state) state.textContent = "受取先を登録しています…";
    await invoke("commerce_seller_chain_destination_put", {
      networkKey: String(data.get("networkKey")),
      address,
      addressTag: String(data.get("addressTag") ?? "").trim() || null,
    });
    if (state) state.textContent = "受取先を登録しました。";
    form.elements.address.value = "";
    form.elements.addressTag.value = "";
    await loadSellerDestinations();
  } catch (error) {
    if (state) state.textContent = `受取先を登録できませんでした: ${friendlyError(error)}`;
  }
});
document.querySelector("#seller-media-upload")?.addEventListener("click", async () => {
  const state = document.querySelector("#seller-media-state");
  try {
    if (state) state.textContent = "画像をアップロードしています…";
    await invoke("commerce_seller_media_upload");
    await loadSellerMedia();
  } catch (error) {
    if (String(error) === "cancelled") {
      await loadSellerMedia();
      return;
    }
    if (state) state.textContent = `画像をアップロードできませんでした: ${friendlyError(error)}`;
  }
});
updateCartBadge();
renderOrders();

// --- Compute ---
// 公開のhealth/offersと本人の予約を出す。認証はRust側でcompute audienceの
// assertionを都度発行する。予約作成は資金枠の確保（payment assertion →
// commerce grant）までRust側で畳む——窓はオファーと時間数しか渡さない。
let computeOffers = [];

async function loadCompute() {
  const state = document.querySelector("#compute-state");
  if (!state) return;
  state.textContent = "読み込み中…";
  try {
    const data = await invoke("compute_status");
    computeOffers = data.offers ?? [];
    state.textContent = data.connected
      ? (data.health?.demoAvailable ? "接続済み · デモ利用可能" : "接続済み")
      : "公開情報のみ — デモと予約にはアカウント接続が要ります";
    renderComputeReservations(data.reservations ?? []);
    renderComputeOffers();
  } catch (error) {
    state.textContent = friendlyError(error);
  }
}

function computeOfferLabel(offer) {
  const rate = offer.minimum_rate_atomic ?? "?";
  const resv = offer.minimum_reservation_rate_atomic ?? "?";
  return `${offer.template_id ?? "template"} · ${offer.region ?? ""} · ${offer.trust_tier ?? ""} · 実行${rate}+予約${resv} ${offer.settlement_asset ?? ""}/h`;
}

function renderComputeOffers() {
  const box = document.querySelector("#compute-offers");
  const select = document.querySelector("#compute-offer-select");
  const button = document.querySelector("#compute-reserve-button");
  if (!box || !select) return;
  select.replaceChildren(...computeOffers.map((offer) => {
    const option = document.createElement("option");
    option.value = offer.id;
    option.textContent = computeOfferLabel(offer);
    return option;
  }));
  if (button) button.disabled = !computeOffers.length;
  box.replaceChildren(...(computeOffers.length
    ? computeOffers.map((offer) => catalogCard({
      title: computeOfferLabel(offer),
      meta: [`offer ${offer.id}`, `起動 ${offer.startup_seconds ?? "?"}秒`, `最長 ${Math.floor((offer.maximum_duration_seconds ?? 0) / 3600)}時間`],
    }))
    : [emptyState("search", "オファーなし", "提供側が現れればここに出ます。")]));
}

function renderComputeReservations(reservations) {
  const box = document.querySelector("#compute-reservations");
  if (!box) return;
  if (!reservations.length) {
    box.replaceChildren(emptyState("search", "予約はありません", "オファーを選んで下のフォームから予約できます。"));
    return;
  }
  box.replaceChildren(...reservations.map((reservation) => {
    const card = document.createElement("div");
    card.className = "card";
    const title = document.createElement("strong");
    title.textContent = `${reservation.id}`;
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = [
      reservation.status,
      `${reservation.starts_at ?? "?"} 〜 ${reservation.ends_at ?? "?"}`,
      `課金 ${reservation.charged_atomic ?? "0"} ${reservation.settlement_asset ?? ""}`,
    ].join(" · ");
    const job = document.createElement("p");
    job.className = "meta mono";
    const actions = document.createElement("div");
    actions.className = "actions";
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "head-action";
    refresh.textContent = "ジョブを確認";
    refresh.onclick = async () => {
      job.textContent = "確認中…";
      try {
        const info = await invoke("compute_reservation_job", { reservationId: reservation.id });
        job.textContent = `job ${info.jobId} — ${info.state}${info.output != null ? `\n結果: ${info.output}` : ""}`;
      } catch (error) {
        job.textContent = friendlyError(error);
      }
    };
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "deny";
    cancel.textContent = "取消";
    cancel.onclick = async () => {
      cancel.disabled = true;
      try {
        await invoke("compute_cancel_reservation", { reservationId: reservation.id });
        void loadCompute();
      } catch (error) {
        cancel.disabled = false;
        job.textContent = friendlyError(error);
      }
    };
    const run = document.createElement("button");
    run.type = "button";
    run.className = "approve";
    run.textContent = "テキスト実行";
    run.onclick = async () => {
      const text = window.prompt("変換するテキスト（大文字化）");
      if (!text?.trim()) return;
      run.disabled = true;
      job.textContent = "投入中…";
      try {
        const info = await invoke("compute_submit_text", {
          reservationId: reservation.id,
          text,
          operation: "uppercase",
        });
        job.textContent = `job ${info.jobId} — ${info.state}。しばらくして「ジョブを確認」を押してください。`;
      } catch (error) {
        job.textContent = friendlyError(error);
      } finally {
        run.disabled = false;
      }
    };
    actions.append(refresh, run, cancel);
    card.append(title, meta, job, actions);
    return card;
  }));
}

{
  const demoForm = document.querySelector("#compute-demo-form");
  const demoState = document.querySelector("#compute-demo-state");
  const demoOutput = document.querySelector("#compute-demo-output");
  demoForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(demoForm);
    const submit = demoForm.querySelector("button[type=submit]");
    submit.disabled = true;
    demoState.textContent = "実行しています…";
    demoOutput.hidden = true;
    try {
      const result = await invoke("compute_demo", {
        text: String(data.get("text") ?? ""),
        operation: String(data.get("operation") ?? "uppercase"),
      });
      demoOutput.hidden = false;
      demoOutput.textContent = String(result.output ?? "");
      demoState.textContent = `${result.state} · job ${result.jobId} · 課金なし`;
    } catch (error) {
      demoState.textContent = friendlyError(error);
    } finally {
      submit.disabled = false;
    }
  });
  const reserveForm = document.querySelector("#compute-reserve-form");
  const reserveState = document.querySelector("#compute-reserve-state");
  reserveForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(reserveForm);
    const startsAt = Date.parse(String(data.get("startsAt") ?? ""));
    const hours = Number(data.get("durationHours"));
    const offer = computeOffers.find((o) => o.id === data.get("offerId"));
    if (!offer || !Number.isFinite(startsAt) || startsAt <= Date.now() || !(hours >= 1 && hours <= 24)) {
      reserveState.textContent = "オファーと未来の開始時刻、1〜24時間を指定してください。";
      return;
    }
    const maximum = (BigInt(offer.minimum_reservation_rate_atomic ?? 0) + BigInt(offer.minimum_rate_atomic ?? 0)) * BigInt(hours);
    if (!window.confirm(`最大 ${maximum} ${offer.settlement_asset} の資金枠を確保して予約します。よろしいですか？`)) return;
    const submit = document.querySelector("#compute-reserve-button");
    submit.disabled = true;
    reserveState.textContent = "資金枠を確保して予約しています…";
    try {
      const result = await invoke("compute_reserve", {
        offerId: offer.id,
        startsAtMs: startsAt,
        durationHours: hours,
      });
      reserveState.textContent = `予約を受け付けました（${result.reservationId ?? "—"}）。割り当て確定まで少し待ちます。`;
      reserveForm.reset();
      void loadCompute();
    } catch (error) {
      reserveState.textContent = friendlyError(error);
    } finally {
      submit.disabled = false;
    }
  });
}

// --- 作成フォーム（コミュニティ・スレッド・記事） ---
// 成功したら一覧を読み直してできたものを詳細で開く。失敗はその場の
// state 行に出す。二重送信はハブ側の requestId とボタン無効で防ぐ。
function wireCreateForm(view, action, readFields, onCreated) {
  const toggle = document.querySelector(`#${view}-create-toggle`);
  const form = document.querySelector(`#${view}-create`);
  const state = document.querySelector(`#${view}-create-state`);
  if (!toggle || !form || !state) return;
  toggle.onclick = () => { form.hidden = !form.hidden; };
  form.onsubmit = async (event) => {
    event.preventDefault();
    const fields = readFields(form);
    if (!fields) return;
    const submit = form.querySelector("button[type=submit]");
    submit.disabled = true;
    state.textContent = "送信中…";
    state.classList.remove("warning");
    try {
      const result = await invoke("hub_client_action", {
        action,
        text: fields.text,
        requestId: crypto.randomUUID(),
        options: fields.options,
      });
      form.reset();
      form.hidden = true;
      state.textContent = "";
      await loadCatalog(view);
      onCreated(result);
    } catch (error) {
      state.textContent = friendlyError(error);
      state.classList.add("warning");
      submit.disabled = false;
    }
  };
}

wireCreateForm("community", "create_community", (form) => ({
  text: form.elements.description.value.trim(),
  options: {
    name: form.elements.name.value.trim(),
    category: form.elements.category.value.trim(),
    visibility: form.elements.visibility.value,
  },
}), (result) => {
  const id = result?.community?.id;
  if (id) void openDetail("community", [id], { title: result.community.name ?? "コミュニティ" });
});

wireCreateForm("threads", "create_thread", (form) => ({
  text: form.elements.body.value.trim(),
  options: {
    boardKey: form.elements.boardKey.value,
    title: form.elements.title.value.trim(),
    language: form.elements.language.value,
    region: form.elements.region.value,
    threadType: form.elements.threadType.value,
    identityMode: form.elements.anonymous.checked ? "anonymous" : "account",
    tags: form.elements.tags.value,
  },
}), (result) => {
  const id = result?.thread?.id ?? result?.id;
  if (id) void openDetail("thread", [id], { title: result?.thread?.title ?? "スレッド" });
});

// 板の選択肢はフォームを開いたときに一度だけ取る。グループ付きなら
// optgroup に分けて、Web版の板カタログと同じ見え方にする。
document.querySelector("#threads-create-toggle")?.addEventListener("click", async () => {
  const select = document.querySelector("#threads-create select[name=boardKey]");
  if (!select) return;
  if (select.options.length) {
    if (threadBoardKey && [...select.options].some((option) => option.value === threadBoardKey)) select.value = threadBoardKey;
    return;
  }
  try {
    const data = await invoke("hub_client", { name: "boards" });
    const groups = data?.groups?.length ? data.groups : [{ name: "", boards: data?.boards ?? [] }];
    for (const group of groups) {
      const parent = group.name ? Object.assign(document.createElement("optgroup"), { label: group.name }) : select;
      for (const board of group.boards ?? []) {
        const option = document.createElement("option");
        option.value = board.key;
        option.textContent = board.title ?? board.key;
        parent.append(option);
      }
      if (parent !== select) select.append(parent);
    }
    if (threadBoardKey && [...select.options].some((option) => option.value === threadBoardKey)) select.value = threadBoardKey;
  } catch { /* 板が取れなければ送信時にハブが弾く */ }
});

wireCreateForm("lists", "create_list", (form) => ({
  text: null,
  options: {
    name: form.elements.name.value.trim(),
    description: form.elements.description.value.trim(),
    visibility: form.elements.visibility.value,
  },
}), (result) => {
  const id = result?.list?.id;
  if (id) void openDetail("list", [id], { title: result.list.name ?? "リスト" });
});

// 記事は専用editorでプレビューと同じ要求IDの結果確認を行う。

// --- 詳細面 ---
// 一覧からの行き先はブラウザではなくこの画面で読む・書く。戻るは直前の
// 詳細、最初の詳細なら開く前にいた面へ帰る。全部Rustの固定パス経由。
let currentView = "feed";
const toolbarTrail = [{ view: "feed", title: "フィード" }];
let toolbarTrailIndex = 0;
let detailTrail = [];
let detailForwardTrail = [];
let detailReturn = { view: "feed", title: "フィード" };
const viewScroll = new Map();
const viewScroller = () => matchMedia("(max-width: 860px)").matches ? document.scrollingElement : document.querySelector(".workspace-main");

function saveDetailTrail() {
  const entry = toolbarTrail[toolbarTrailIndex];
  if (entry?.view !== "detail") return;
  entry.title = detailTrail.at(-1)?.title || entry.title;
  entry.detailTrail = detailTrail.slice();
  entry.detailForwardTrail = detailForwardTrail.slice();
  entry.detailReturn = { ...detailReturn };
}

function updateToolbarNavigation() {
  const canRedoDetail = detailForwardTrail.length && (currentView === "detail" || currentView === detailReturn.view);
  const canBackVideo = currentView === "videos" && videoWatchIndex >= 0;
  const canRedoVideo = currentView === "videos" && videoWatchIndex + 1 < videoWatchHistory.length;
  const back = document.querySelector("#toolbar-back");
  back.disabled = currentView === "detail" ? !detailTrail.length : !canBackVideo && toolbarTrailIndex === 0;
  const backLabel = currentView === "detail"
    ? detailTrail.length > 1 ? "前の詳細に戻る" : `${detailReturn.title || "前の画面"}に戻る`
    : canBackVideo ? videoWatchIndex > 0 ? "前の動画に戻る" : "動画一覧に戻る"
    : toolbarTrail[toolbarTrailIndex - 1]?.title ? `${toolbarTrail[toolbarTrailIndex - 1].title}に戻る` : "戻る";
  back.setAttribute("aria-label", backLabel);
  back.title = backLabel;
  const forward = document.querySelector("#toolbar-forward");
  forward.disabled = !canRedoDetail && !canRedoVideo && toolbarTrailIndex >= toolbarTrail.length - 1;
  const forwardLabel = canRedoDetail ? "次の詳細に進む"
    : canRedoVideo ? "次の動画に進む"
    : toolbarTrail[toolbarTrailIndex + 1]?.title ? `${toolbarTrail[toolbarTrailIndex + 1].title}に進む` : "進む";
  forward.setAttribute("aria-label", forwardLabel);
  forward.title = forwardLabel;
  const comparisonButton = document.querySelector("#toolbar-ai-compare");
  if (comparisonButton) {
    comparisonButton.hidden = startupTool || currentView !== "ai";
    comparisonButton.disabled = !legacyPiWorkController || desktopShell.classList.contains("browser-active");
  }
  if (currentView === "browser") browserControls?.syncNavigation?.();
}

// Hubが検証して公開した外部リソースだけを表示する。外部の決済や反応を
// HubのローカルID・カート・投稿操作へ渡さない。
function distributedResourceUrl(resource) {
  try {
    const origin = new URL(resource.origin);
    const page = new URL(resource.canonicalUrl);
    return origin.protocol === "https:" && page.protocol === "https:"
      && !origin.username && !origin.password && !page.username && !page.password
      && !origin.port && !page.port && page.origin === origin.origin ? page.href : null;
  } catch { return null; }
}

function distributedResourceCard(resource) {
  const url = distributedResourceUrl(resource);
  if (!url) return null;
  const host = new URL(url).hostname;
  const card = catalogCard({
    title: resource.title,
    body: resource.summary,
    meta: [`${host} から`, "外部投稿"],
    onOpen: () => void invoke("open_external", { url }).catch(() => undefined),
  });
  card.classList.add("distributed-resource");
  return card;
}

function activityPubUrl(item) {
  try {
    const url = new URL(item.url);
    return url.protocol === "https:" && !url.username && !url.password && !url.port ? url.href : null;
  } catch { return null; }
}

function activityPubCard(item) {
  const url = activityPubUrl(item);
  if (!url) return null;
  const card = catalogCard({
    title: item.actor?.name || item.actor?.handle || new URL(url).hostname,
    body: item.content,
    meta: [item.actor?.handle, `${new URL(url).hostname} から`, relTime(item.published)],
    onOpen: () => void invoke("open_external", { url }).catch(() => undefined),
  });
  card.classList.add("distributed-resource");
  return card;
}

function updateSourceSummary(id, resources, hubAvailable = true, otherHosts = []) {
  const target = document.querySelector(id);
  if (!target) return;
  const origins = new Set([...resources.filter((item) => distributedResourceUrl(item)).map((item) => new URL(item.origin).hostname), ...otherHosts]);
  target.textContent = origins.size ? `${hubAvailable ? "Hubと" : ""}外部${origins.size}サーバーを表示` : "";
}

const detailTitle = () => document.querySelector("#detail-title");
const detailState = () => document.querySelector("#detail-state");
const detailContent = () => document.querySelector("#detail-content");
let detailRenderRevision = 0;
document.querySelector('#music-saved').onclick=()=>void openDetail('music_library',[],{title:'お気に入りの音楽',local:true,data:{}});
document.querySelector('#articles-saved').onclick=()=>void openDetail('saved_articles',[],{title:'保存した記事',local:true,data:{}});
document.querySelector('#articles-drafts').onclick=()=>void openDetail('article_drafts',[],{title:'下書き',local:true,data:{}});
// シリーズと統計はWeb版のHubの画面（Desktopに専用の画面は無い）。下書きの編集と同じく既定のブラウザで開く。
for (const [id, path] of [['#articles-series','/v2/articles/series'], ['#articles-stats','/v2/articles/stats']]) {
  document.querySelector(id).onclick = async () => {
    try { await invoke('open_external', { url: new URL(path, await invoke('hub_origin')).href }); }
    catch (error) { showNotice(friendlyError(error)); }
  };
}
document.querySelector('#video-playlists').onclick=()=>void openDetail('video_playlists',[],{title:'動画のプレイリスト',local:true,data:{}});
document.querySelector('#music-playlists').onclick=()=>void openDetail('music_playlists',[],{title:'音楽のプレイリスト',local:true,data:{}});
document.querySelector('#video-saved').onclick=()=>void openDetail('video_library',[],{title:'あとで見る',local:true,data:{}});


function paintDetailHead(entry) {
  const generation=researchAccountGeneration,current=()=>generation===researchAccountGeneration&&currentView==='detail'&&detailTrail.at(-1)===entry;
  detailTitle().textContent = entry.title;
  // グループの画面は細い帯が頭（チャンネル名と ⋯）なので、ページの見出しの行は出さない。「右で読む」は見出しのボタン。
  const headRow=detailTitle().closest('.view-head');if(headRow)headRow.hidden=entry.name==='community';
  // 「右で読む」は出さない（2026-11-07 所有者）。押せる道は右の列から開く。
  const parallel=document.querySelector('#detail-open-right');parallel.hidden=true;
  parallel.onclick=()=>{if(!current())return;railPreferredView='search';setDesktopRailOpen(true);const host=document.querySelector('#rail-detail-preview-host');const row=railRow(entry.title,'右列で読む',null,()=>void railReader.show('detail',row,{title:entry.title,detail:{name:entry.name,ids:entry.ids}}));host.replaceChildren(row);void railReader.show('detail',row,{title:entry.title,detail:{name:entry.name,ids:entry.ids}});};
}

function releaseResearchDetail(invalidate=false) {
  if(invalidate)researchDetailController?.invalidate?.();
  else researchDetailController?.dispose?.();
  researchDetailController=null;
}

function syncCommunityInvite(reset=false){
  if(currentView!=='community'||reset){communityInviteController?.dispose();communityInviteController?.root.remove();communityInviteController=null;}
  if(currentView!=='community'||communityInviteController)return;
  const generation=researchAccountGeneration;
  communityInviteController=communityInvite(document,{invoke,friendlyError,connectAccount:()=>connectDesktopAccount(),isCurrent:()=>currentView==='community'&&generation===researchAccountGeneration,onJoined:id=>void openDetail('community',[id],{title:'コミュニティ'})});
  (document.querySelector('#view-community .view-head-actions')??document.querySelector('#view-community .view-head'))?.prepend(communityInviteController.root);
}
function releaseCommunityDetail(invalidate=false){
  if(invalidate)communityDetailController?.invalidate?.();else communityDetailController?.dispose?.();
  communityDetailController=null;
}

let videoCommentsController=null;
async function renderDetailEntry(entry) {
  videoCommentsController?.destroy();videoCommentsController=null;
  releaseResearchDetail();releaseCommunityDetail();
  const revision = ++detailRenderRevision, generation=researchAccountGeneration;
  const current=()=>revision===detailRenderRevision&&generation===researchAccountGeneration&&currentView==="detail"&&detailTrail.at(-1)===entry;
  paintDetailHead(entry);
  const state = detailState();
  const target = detailContent();
  state.textContent = "";
  state.classList.remove("warning");
  // 本人のライブラリは未接続だと必ず拒否される。読みに行って「再試行」だけを出さず、接続の入口を出す。
  if (["saved_articles", "article_drafts", "video_library", "music_library", "video_playlists", "music_playlists", "music_playlist"].includes(entry.name) && desktopAccount.state !== "registered") { target.replaceChildren(connectState()); return; }
  target.replaceChildren(skeletonResult(), skeletonResult(), skeletonResult());
  try {
    const data = entry.local
      ? entry.data
      : await invoke("hub_detail", (entry.name.startsWith('community_governance')?communityGovernanceRequest(entry):null)??communityAppealReviewRequest(entry)??communityReportReviewRequest(entry)??communityMembershipReviewRequest(entry)??communityGuideRequest(entry));
    if (!current()) return;
    state.textContent = "";
    entry.data = data;
    const controller=DETAIL_RENDERERS[entry.name](target, data, entry);
    if(entry.name==="community")communityDetailController=controller;
    if(['thread','research_project','research_network_fork','research_git_management','research_git_history','research_git_commit','research_git_compare','research_git_proposals','research_git_proposal','research_git_discussion','research_proposal','research_document','research_revision','community_governance','community_governance_proposal','community_governance_settings','community_governance_create_context','community_governance_mutation_context','video_playlists','music_playlists'].includes(entry.name))researchDetailController=controller;
    if (['article','video'].includes(entry.name)) {
      const generation=researchAccountGeneration;
      const actionHost=entry.name==='article'?target.querySelector('.article-actions')??target:target;
      attachContentSave({document,host:actionHost,kind:entry.name,id:entry.ids[0],invoke:researchEditorOptions(entry).invoke,
        isCurrent:()=>revision===detailRenderRevision&&generation===researchAccountGeneration&&currentView==='detail'&&detailTrail.at(-1)===entry});
      attachContentShare({document,host:actionHost,kind:entry.name,id:entry.ids[0],title:data.article?.title??data.video?.title??entry.title,
        isCurrent:current,onShare:offerPublicContentShare});
    }
    if(entry.name==='video')appendPlaylistEntry(target,'video',{id:entry.ids[0],title:data?.title??data?.work?.title??entry.title});
    attachDetailAiHandoff(entry,data,target,current);
    const referenceKind={article:'article',video:'video',hubpedia_article:'hubpedia',thread:'thread'}[entry.name];
    if(referenceKind)void appendResearchBacklinks(target,referenceKind,entry.ids[0],()=>revision===detailRenderRevision&&currentView==='detail');
    if (readingDirectory.has(DETAIL_PARENT_VIEW[entry.name]) || DETAIL_PARENT_VIEW[entry.name] === "research") renderSidebarContext("detail");
  } catch (error) {
    if (!current()) return;
    target.replaceChildren();
    if(['research_git_history','research_git_commit','research_git_compare'].includes(entry.name)){
      if(isReadAccessDenied(error)||String(error)==='見つかりませんでした'||/^ハブが (401|403|404) を返しています$/.test(String(error))){
        const cache=entry.editorState?.gitBrowser;if(cache)for(const key of Object.keys(cache))delete cache[key];
      }
      target.append(retryButton(()=>void renderDetailEntry(entry)));
    }
    if (String(error).includes("desktop_not_connected")) {
      target.append(connectState());
    } else {
      state.textContent = friendlyError(error);
      state.classList.add("warning");
    }
  }
}

async function appendResearchBacklinks(target,kind,id,current=()=>true) {
  const account=desktopAccount,epoch=homeAccountEpoch;
  return renderResearchBacklinks(target,{kind,id,invoke,isCurrent:()=>current()&&account===desktopAccount&&epoch===homeAccountEpoch,
    openProject:(project,isCurrent)=>openDetail('research_project',[project.id],{title:project.title,isCurrent})});
}
function renderFeedResearchUpdates(target,items,current=()=>true) {
  if(items===undefined)return null;
  const account=desktopAccount,epoch=homeAccountEpoch;
  return appendResearchUpdates(target,items,{isCurrent:()=>current()&&account===desktopAccount&&epoch===homeAccountEpoch,
    openLink:(href,title,isCurrent)=>openHubPath(href,title,isCurrent)});
}
async function openDetail(name, ids, opts = {}) {
  // 作品の頁は無い（2026-11-02）。曲への深いリンクは、その曲を再生して右列の「再生中」を開く。
  if (name === "music_work") { if (!opts.isCurrent || opts.isCurrent()) await openMusicWorkById(ids?.[0], opts.data); return; }
  await exitBrowser();
  if(opts.isCurrent&&!opts.isCurrent())return;
  if(currentView==='videos')captureVideoScene();
  if(currentView==="feed")captureSocialScene();
  const enteringDetail = currentView !== "detail";
  if (enteringDetail) {
    detailReturn = { view: currentView, title: document.querySelector(`#view-${currentView} :is(.view-head, .page-header) h2`)?.textContent ?? "Hub", boardKey: currentView === "threads" ? threadBoardKey : "", boardTitle: currentView === "threads" ? threadBoardTitle : "", query: currentView === "threads" ? document.querySelector("#threads-query").value : undefined };
    if(currentView==="feed")detailReturn.socialScene=toolbarTrail[toolbarTrailIndex]?.socialScene;
    if (currentView === "threads") Object.assign(toolbarTrail[toolbarTrailIndex], {
      boardKey: detailReturn.boardKey, boardTitle: detailReturn.boardTitle, query: detailReturn.query,
    });
    toolbarTrail.splice(toolbarTrailIndex + 1);
  } else if (detailTrail.at(-1)) detailTrail.at(-1).scrollTop = viewScroller()?.scrollTop ?? 0;
  detailForwardTrail = [];
  const entry = { name, ids, title: opts.title ?? "詳細", local: opts.local ?? false, data: opts.data, targetSelection:opts.targetSelection, scrollTop: 0, editorState:opts.editorState,governanceState:opts.governanceState, ...(typeof opts.communityId === "string" && opts.communityId ? { communityId: opts.communityId } : {}) };
  if (opts.headPanels && typeof opts.headPanels === "object") entry.headPanels = { join: opts.headPanels.join === true, about: opts.headPanels.about === true };
  detailTrail.push(entry);
  if (enteringDetail) {
    toolbarTrail.push({ view: "detail", title: entry.title });
    toolbarTrailIndex = toolbarTrail.length - 1;
  }
  saveDetailTrail();
  showView("detail", entry.title);
  if (viewScroller()) viewScroller().scrollTop = 0;
  await renderDetailEntry(entry);
}

async function detailBack() {
  const leaving = detailTrail.pop();
  if (!leaving) return;
  leaving.scrollTop = viewScroller()?.scrollTop ?? 0;
  detailForwardTrail.push(leaving);
  const previous = detailTrail[detailTrail.length - 1];
  if (previous) {
    saveDetailTrail();
    showView("detail", previous.title);
    await renderDetailEntry(previous);
    if (currentView === "detail" && detailTrail.at(-1) === previous && viewScroller()) viewScroller().scrollTop = previous.scrollTop ?? 0;
    updateToolbarNavigation();
    return;
  }
  const back = detailReturn;
  if (toolbarTrail[toolbarTrailIndex]?.view === "detail") toolbarTrailIndex--;
  try { await navigateFrom({ dataset: { view: back.view, title: back.title, boardKey: back.boardKey, boardTitle: back.boardTitle, query: back.query }, childNodes: [] }, { detailReplay: true }); }
  finally { updateToolbarNavigation(); }
}

async function detailForward() {
  const entry = detailForwardTrail.pop();
  if (!entry) return;
  if (currentView === "detail" && detailTrail.at(-1)) detailTrail.at(-1).scrollTop = viewScroller()?.scrollTop ?? 0;
  if (currentView === detailReturn.view && toolbarTrail[toolbarTrailIndex + 1]?.view === "detail") toolbarTrailIndex++;
  detailTrail.push(entry);
  saveDetailTrail();
  showView("detail", entry.title);
  await renderDetailEntry(entry);
  if (currentView === "detail" && detailTrail.at(-1) === entry && viewScroller()) viewScroller().scrollTop = entry.scrollTop ?? 0;
  updateToolbarNavigation();
}

// Hub内パスのうちネイティブ詳細があるものを写す。アプリに面が無い
// 行き先（外部サービス・Commerce購入等）は null でブラウザへ。
function detailForHubPath(path) {
  if (typeof path !== "string") return null;
  const music=path.match(/^\/v2\/music\/works\/([^/?#]+)$/);
  if(music) {
    try {const id=decodeURIComponent(music[1]);if(!/[\p{Cc}\p{Surrogate}]/u.test(path)&&encodeURIComponent(id)===music[1]&&(/^[A-Za-z0-9_-]{1,128}$/.test(id)||/^music:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)))return{name:'music_work',ids:[id],title:'音楽作品'};}catch{}
    return null;
  }
  const profile = path.match(/^\/(?:v2\/)?profile\/([A-Za-z0-9_.-]{1,64})/);
  if (profile) return { name: "profile", ids: [profile[1]], title: `@${profile[1]}` };
  const tag = path.match(/^\/(?:v2\/)?tag\/([^/?#]{1,128})/);
  if (tag) return { name: "tag", ids: [decodeURIComponent(tag[1])], title: `#${decodeURIComponent(tag[1])}` };
  // コミュニティ通知は /v2/community?community=<id>&post=<id> の
  // クエリ形で来る。コミュニティの投稿ストリームを開く。
  const communityQuery = path.match(/^\/(?:v2\/)?community\?(.{1,500})/);
  if (communityQuery) {
    const params = new URLSearchParams(communityQuery[1]);
    const communityId = params.get("community") ?? "";
    const idOk = (id) => /^[A-Za-z0-9_-]{1,80}$/.test(id);
    if (idOk(communityId)) {
      return { name: "community", ids: [communityId], title: "コミュニティ" };
    }
  }
  const gitProposal=path.match(/^\/v2\/research\/(rp_[a-f0-9]{32})\?gitProposal=([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})#git$/);
  if(gitProposal&&!/[\r\n]/.test(path))return {name:'research_git_proposal',ids:[gitProposal[1],gitProposal[2]],title:'Git提案のレビュー'};
  const gitCompare=path.match(/^\/v2\/research\/(rp_[a-f0-9]{32})\?commit=([a-f0-9]{40}|[a-f0-9]{64})&base=([a-f0-9]{40}|[a-f0-9]{64})#git$/);
  if(gitCompare&&!/[\r\n]/.test(path)&&gitCompare[2].length===gitCompare[3].length)return {name:'research_git_compare',ids:[gitCompare[1],gitCompare[2],gitCompare[3]],title:'Gitの二版比較'};
  const git=path.match(/^\/v2\/research\/(rp_[a-f0-9]{32})(?:\?commit=([a-f0-9]{40}|[a-f0-9]{64}))?#git$/);
  if(git && !/[\r\n]/.test(path))return {name:git[2]?'research_git_commit':'research_git_history',ids:git[2]?[git[1],git[2]]:[git[1]],title:git[2]?'コードの変更':'Gitの変更履歴'};
  const research=path.match(/^\/(?:v2\/)?research\/([A-Za-z0-9_-]{1,128})(?:[/?#]|$)/);
  if(research){
    const url=new URL(path,'https://hub.local'),query=url.searchParams,id=query.get('document');
    if(query.has('commit')||url.hash==='#git')return null;
    if(query.getAll('document').length>1||query.getAll('version').length>1)return null;
    if(query.has('version')){
      const version=query.get('version');
      return id&&/^[A-Za-z0-9_.-]{1,100}$/.test(id)&&/^[1-9][0-9]*$/.test(version)&&Number.isSafeInteger(Number(version))?{name:'research_revision',ids:[research[1],id,version],title:`文書 · v${version}`} : null;
    }
    return id&&/^[A-Za-z0-9_.-]{1,100}$/.test(id)?{name:'research_document',ids:[research[1],id],title:'文書'}:{name:'research_project',ids:[research[1]],title:'プロジェクト'};
  }
  const video=path.match(/^\/(?:v2\/)?videos\/([A-Za-z0-9_-]{1,128})(?:[?#]|$)/);
  if(video&&!/[\r\n]/.test(path))return {name:'video',ids:[video[1]],title:'動画'};
  // マーケットの一覧・購入面（商品、デジタル、チケット、注文など）は出品の詳細ではない。ウェブで開く。
  if (/^\/(?:v2\/)?market\/(?:products|digital|tickets|orders|cart|purchased|sell|federated|wallet)(?:[/?#]|$)/.test(path)) return null;
  const match = path.match(/^\/(?:v2\/)?(posts|threads|articles|hubpedia|books|community|market)\/([A-Za-z0-9_-]{1,128})/);
  if (!match) return null;
  const names = { posts: "post", threads: "thread", articles: "article", hubpedia: "hubpedia_article", books: "book", community: "community", market: "listing" };
  const titles = { posts: "投稿", threads: "スレッド", articles: "記事", hubpedia: "Hubpedia", books: "本", community: "コミュニティ", market: "出品" };
  return { name: names[match[1]], ids: [match[2]], title: titles[match[1]] };
}

// Hubpedia・記事の本文はMarkdownで来る。全部は要らないので、見出し・
// 段落・箇条書き・引用・Hub内リンクだけを組み立てる。生HTMLは流さない。
function markdownBlocks(markdown) {
  const nodes = [];
  const flushParagraph = (lines) => {
    if (!lines.length) return;
    const p = document.createElement("p");
    p.className = "detail-p";
    appendInline(p, lines.join(" "));
    nodes.push(p);
    lines.length = 0;
  };
  let paragraph = [];
  let list = null;
  for (const raw of (markdown ?? "").split("\n")) {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,4})\s+(.*)/);
    const item = line.match(/^[-*]\s+(.*)/);
    const quote = line.match(/^>\s?(.*)/);
    if (heading) {
      flushParagraph(paragraph); list = null;
      const h = document.createElement(`h${Math.min(heading[1].length + 2, 6)}`);
      h.className = "detail-h";
      appendInline(h, heading[2]);
      nodes.push(h);
    } else if (item) {
      flushParagraph(paragraph);
      if (!list) { list = document.createElement("ul"); list.className = "detail-list"; nodes.push(list); }
      const li = document.createElement("li");
      appendInline(li, item[1]);
      list.append(li);
    } else if (quote) {
      flushParagraph(paragraph); list = null;
      const q = document.createElement("blockquote");
      q.className = "detail-quote";
      appendInline(q, quote[1]);
      nodes.push(q);
    } else if (!line.trim()) {
      flushParagraph(paragraph); list = null;
    } else {
      paragraph.push(line.trim());
    }
  }
  flushParagraph(paragraph);
  return nodes;
}

// 利用者記事の本文（詳細と執筆プレビュー）。文法は article-body.mjs（webの
// lib/article-body.ts と同じ）。Hubpedia は上の markdownBlocks のまま。
function articleBodyNodes(body) {
  return renderArticleBodyNodes(document, body ?? "", {
    openLink: (href, external) => { if (external) void enterBrowser(href); else void openHubPath(href); },
    hubAsset,
    createYouTubePlayer: createArticleYouTubePlayer,
  });
}

// [text](url) と **強調** だけを解釈する。Hub内リンクはネイティブ詳細へ、
// 外部リンクはブラウザ面へ。URL文字列は要素の属性ではなくクリック動作に
// 閉じ込める。
function appendInline(node, text) {
  const pattern = /\[([^\]]{1,200})\]\(([^)\s]{1,500})\)|\*\*([^*]{1,200})\*\*/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) node.append(document.createTextNode(text.slice(last, match.index)));
    if (match[3] !== undefined) {
      const strong = document.createElement("strong");
      strong.textContent = match[3];
      node.append(strong);
    } else {
      const [, label, url] = match;
      const link = document.createElement("button");
      link.type = "button";
      link.className = "detail-link";
      link.textContent = label;
      link.onclick = () => {
        const hubpedia = url.match(/^\/hubpedia\/([A-Za-z0-9_-]+)/);
        if (hubpedia) void openDetail("hubpedia_article", [hubpedia[1]], { title: label });
        else void openHubPath(url);
      };
      node.append(link);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) node.append(document.createTextNode(text.slice(last)));
}

function detailSection(title, nodes) {
  const section = document.createElement("section");
  section.className = "detail-section";
  const heading = document.createElement("h3");
  heading.className = "result-heading";
  heading.textContent = title;
  section.append(heading, ...nodes);
  return section;
}

// --- 投稿詳細：祖先・本体・返信を実物カードのまま積む ---
function renderPostDetail(target, data, entry) {
  const nodes = [];
  if (!data?.post) { target.replaceChildren(pageErrorState("投稿を開けませんでした", "", entry ? () => void renderDetailEntry(entry) : null)); return; }
  const chain = (data.ancestors ?? []).map((post) => ({ post, node: postCard(post) }));
  chain.push({ post: data.post, node: postCard(data.post, {
    primaryDetail: true,
    replyProfile: data.authenticated ? (data.currentProfileDisplayName || "自分") : null,
  }) });
  applyThreadLinks(chain);
  nodes.push(...chain.map((entry) => entry.node));
  if (!data.authenticated) {
    nodes.push(connectState("返信・いいね・ブックマークには接続が必要です。"));
  }
  const replies = [...(data.replies ?? [])];
  if(entry?.targetSelection?.replyOrder==='latest'||entry?.targetSelection?.replyOrder==='oldest'){
    const direction=entry.targetSelection.replyOrder==='latest'?-1:1;
    replies.sort((a,b)=>direction*(Date.parse(a.createdAt)-Date.parse(b.createdAt)));
  }
  const replySection=detailSection(
    replies.length ? `返信 ${replies.length}件` : "返信",
    replies.length ? (() => { const rows = replies.map((post) => ({ post, node: postCard(post) })); applyThreadLinks(rows); return rows.map((row) => row.node); })() : [emptyState("reply", "まだ返信はありません")],
  );
  nodes.push(replySection);target.replaceChildren(...nodes);
  if(entry?.targetSelection?.showReplies&&!entry.targetSelection.applied){
    entry.targetSelection.applied=true;replySection.tabIndex=-1;
    const generation=researchAccountGeneration,revision=detailRenderRevision;
    queueMicrotask(()=>{if(generation===researchAccountGeneration&&revision===detailRenderRevision&&currentView==='detail'&&detailTrail.at(-1)===entry&&replySection.isConnected){replySection.focus({preventScroll:true});replySection.scrollIntoView({block:'start'});}});
  }
}

// --- スレッド詳細：見出し＋投稿一覧＋スコープ付き返信フォーム ---
const LANGUAGE_LABELS = { ja: "日本語", en: "English", ko: "한국어", "zh-CN": "简体中文", es: "Español", fr: "Français", de: "Deutsch", pt: "Português", ar: "العربية", hi: "हिन्दी", other: "その他" };
const REGION_LABELS = { global: "グローバル", africa: "アフリカ", "asia-pacific": "アジア太平洋", europe: "ヨーロッパ", "latin-america-caribbean": "中南米・カリブ", "middle-east-north-africa": "中東・北アフリカ", "north-america": "北米", local: "地域限定" };

// 2026-11-06 所有者「スレッドの中こそポストと同じUIにするべき」：スレッドの投稿も投稿詳細の行と同じ作り（post-row.mjs）。
// 操作はスレッドの既存の道だけ：いいね＝thread_post_vote(up)、返信＝引用して返信、編集・削除・通報・低評価は従来の道。
function threadPostCard(post, context, rerender, jumpTo = () => {}) {
  const deleted = Boolean(post.deletedAt || post.moderatedAt || post.viewerMuted || post.viewerBlocked);
  const viewer = context?.viewer;
  const own = Boolean(viewer && (post.viewerIsAuthor || post.authorProfileId && post.authorProfileId === viewer.id));
  const isBest = context?.thread?.bestAnswerPostId === post.id;
  const fail = (error) => window.alert(friendlyError(error));
  let row = null;
  const body = document.createElement("div");
  body.className = "post-body";
  const text = document.createElement("p");
  text.className = "detail-p post-body-text";
  text.textContent = deleted ? "（この投稿は表示できません）" : post.body;
  body.append(text);
  if (!deleted) addBaitRow(document, text, post.body);
  const extra = [];
  const reference = !deleted ? researchDiscussionReference(post.body) : null;
  const gitReference = !deleted ? researchGitDiscussionReference(post.body) : null;
  for (const [ref, label] of [[reference, reference && `参照した文書の版（v${reference.version}）`], [gitReference, gitReference && `参照したコードの変更（${gitReference.oid?.slice(0, 12)}）`]]) {
    if (!ref) continue;
    const link = document.createElement("button");
    link.type = "button"; link.className = "detail-link"; link.textContent = label;
    link.onclick = (event) => { event.stopPropagation(); void openHubPath(ref.href); };
    extra.push(link);
  }
  if (isBest && !deleted) {
    const badge = document.createElement("span");
    badge.className = "thread-best-badge";
    badge.setAttribute("role", "img");
    badge.setAttribute("aria-label", "ベストアンサー");
    badge.innerHTML = icon("check");
    badge.append(Object.assign(document.createElement("span"), { textContent: "ベストアンサー" }));
    extra.push(badge);
  }
  const vote = async (kind, button) => {
    button.disabled = true;
    try {
      let reason = null;
      if (kind === "down") {
        const pick = window.prompt("低評価の理由（空欄可）\nincorrect=不正確 / unsupported=根拠不明 / off_topic=話題ずれ / unclear=不明瞭", "");
        if (pick === null) { button.disabled = false; return; }
        const key = pick.trim();
        if (key && !["incorrect", "unsupported", "off_topic", "unclear"].includes(key)) { window.alert("理由は incorrect / unsupported / off_topic / unclear から選んでください。"); button.disabled = false; return; }
        reason = key || null;
      }
      await invoke("hub_client_action", { action: "thread_post_vote", target: post.id, options: { kind, reason } });
      await rerender();
    } catch (error) { button.disabled = false; fail(error); }
  };
  const actions = [];
  if (viewer && !deleted) {
    const summary = post.voteSummary;
    if (!own) actions.push({ icon: "heart", label: "いいね", count: summary?.up ?? 0, active: summary?.viewerVote === "up", pressed: summary?.viewerVote === "up", onClick: (_e, button) => void vote("up", button) });
    if (context?.quote) actions.push({ icon: "reply", label: "返信", onClick: () => context.quote(post) });
    actions.push({ icon: "share", label: "共有", onClick: async (_e, button) => {
      const origin = hubOrigin ?? (await invoke("hub_origin").catch(() => null));
      const url = origin && context?.thread?.id ? `${origin}/threads/${encodeURIComponent(context.thread.id)}` : "";
      if (!url) return;
      try { await navigator.clipboard.writeText(url); button.classList.add("is-done"); setTimeout(() => button.classList.remove("is-done"), 1600); }
      catch { await invoke("open_external", { url }).catch(() => undefined); }
    } });
  }
  const menu = [];
  if (!deleted && viewer && context?.canPickBest && !isBest) {
    menu.push(["ベストアンサーにする", async () => {
      try { await invoke("hub_client_action", { action: "thread_best_answer", target: context.thread.id, options: { postId: post.id } }); await rerender(); }
      catch (error) { fail(error); }
    }]);
  }
  if (!deleted && own) {
    menu.push(["編集", async () => {
      const next = window.prompt("投稿内容を編集", post.body ?? "");
      if (next === null) return;
      const value = next.trim();
      if (!value) { window.alert("本文を入力してください。"); return; }
      try {
        await invoke("hub_client_action", { action: "thread_post_edit", target: post.id, text: value, options: { editReason: window.prompt("編集理由（空欄可）", "") ?? "" } });
        await rerender();
      } catch (error) { fail(error); }
    }], ["削除", async () => {
      if (!window.confirm("この投稿を削除しますか？")) return;
      try { await invoke("hub_client_action", { action: "thread_post_delete", target: post.id }); await rerender(); } catch (error) { fail(error); }
    }]);
  } else if (viewer && !deleted) {
    const controlThrough = (action) => async () => {
      if (!post.authorProfileId) { const panel = row?.querySelector(".thread-post-controls"); if (panel) { panel.hidden = false; panel.open = true; panel.scrollIntoView?.({ block: "nearest" }); } return; }
      if (action === "block" && !window.confirm("ブロックするとお互いのフォローが外れます。ブロックしますか？")) return;
      try { await invoke("hub_client_action", { action, target: post.authorProfileId }); (await loadSafetyControls()).set(post.authorProfileId, { muted: action === "mute", blocked: action === "block" }); await rerender(); } catch (error) { fail(error); }
    };
    if (post.authorProfileId) menu.push(["リストに追加", () => void openListPicker("profile", post.authorProfileId, row)]);
    if (post.authorProfileId || post.canControlAuthor) menu.push(["ミュート", controlThrough("mute")], ["ブロック", controlThrough("block")]);
    menu.push(["低評価", () => { void vote("down", document.createElement("button")); }],
      ["報告", () => { row.querySelector(".report-form")?.remove(); row.querySelector(".post-content").append(reportForm("thread_post", post.id)); }]);
  }
  const target = Number.isSafeInteger(post.replyTargetNo) && post.replyTargetNo > 0 ? post.replyTargetNo : null;
  row = createPostRow(document, {
    authorName: post.displayName ?? "名無しさん", authorHandle: post.authorHandle, avatarUrl: post.avatarUrl,
    time: relTime(post.createdAt), timeTitle: post.createdAt ? new Date(post.createdAt).toLocaleString("ja-JP") : "",
    meta: [`#${post.no}`, post.editedAt ? "編集済み" : ""],
    replyTo: target ? { label: `#${target}${post.replyTargetDisplayName ? `（${post.replyTargetDisplayName}）` : ""}`, onClick: () => jumpTo(target) } : null,
    body, images: !deleted ? (post.images ?? []) : [], extra, actions, menu, hubAsset, icon, paintAvatar,
    classes: isBest && !deleted ? ["thread-post", "is-best"] : ["thread-post"],
  });
  row.dataset.postId = post.id; row.dataset.postNo = String(post.no);
  if (!deleted && typeof attachTranslateAction === "function" && typeof localTranslator !== "undefined") {
    const bar = row.querySelector(".post-actions");
    if (bar) {
      const host = document.createElement("span");
      host.className = "local-translate-host";
      host.onclick = (event) => event.stopPropagation();
      bar.insertBefore(host, [...bar.querySelectorAll("[aria-label]")].find((node) => (globalThis.__hubI18n?.sourceAttr(node, "aria-label") ?? node.getAttribute("aria-label")) === "共有") ?? null);
      attachTranslateAction({ doc: document, host, body: text, translator: localTranslator,
        item: { id: post.id, revision: post.editedAt ?? "", type: "thread_post", isPublic: true, sourceLang: post.language || null },
        getText: () => post.body, restore: () => { text.textContent = post.body; } });
    }
  }
  return row;
}

function renderThreadDetail(target, data, entry) {
  const thread = data.thread ?? {};
  const posts = data.posts ?? [];
  const nodes = [];
  // 1枚の小さな見出し：題名と主な操作（追跡・⋯）が1行、続けて短い情報・タグ・検索の1行。
  // 少ない操作（リストに追加・既読・受付の変更）は ⋯ に畳む。
  const threadRevision=detailRenderRevision, threadGeneration=researchAccountGeneration;
  const threadCurrent=()=>threadRevision===detailRenderRevision&&threadGeneration===researchAccountGeneration&&currentView==='detail'&&detailTrail.at(-1)===entry;
  const head = document.createElement("div");
  head.className = "card thread-head";
  const top = document.createElement("div");
  top.className = "thread-head-row";
  const title = document.createElement("h3");
  title.textContent = thread.title ?? "スレッド";
  top.append(title);
  { const band = document.querySelector("#detail-title"); if (band) band.textContent = "スレッド"; }
  const metaThread = { ...thread, postCount: Math.max(posts.length, Number(thread.postCount) || 0) };
  const meta = typeof threadRowMeta === "function" ? threadRowMeta(document, metaThread, { relTime, icon, className: "thread-row-meta thread-head-meta" })
    : Object.assign(document.createElement("p"), { className: "meta", textContent: `${posts.length || thread.postCount || 0} 投稿 · ${relTime(thread.updatedAt)}` });
  if (data.currentProfile?.id || thread.id) {
    const tools = document.createElement("div");
    tools.className = "thread-head-tools";
    if (data.viewer) {
      const follow = document.createElement("button");
      follow.type = "button";
      follow.className = "head-action thread-follow";
      follow.textContent = data.viewer.following ? "追跡中" : "追跡する";
      follow.onclick = async () => {
        follow.disabled = true;
        try {
          await invoke("hub_client_action", { action: "thread_follow", target: thread.id });
          await renderDetailEntry(entry);
        } catch (error) {
          follow.disabled = false;
          window.alert(friendlyError(error));
        }
      };
      tools.append(follow);
    }
    const more = document.createElement("details");
    more.className = "thread-more";
    const toggle = document.createElement("summary");
    toggle.className = "head-action community-more-toggle";
    toggle.textContent = "⋯";
    toggle.setAttribute("aria-label", "その他の操作");
    const list = document.createElement("div");
    list.className = "community-more-list thread-more-list";
    list.setAttribute("role", "group");
    const addList = document.createElement("button");
    addList.type = "button";
    addList.className = "community-more-item";
    addList.textContent = "リストに追加";
    addList.onclick = () => { more.open = false; void openListPicker("thread", thread.id, head); };
    list.append(addList);
    // 既読にする・受付の終了と再開（モジュールの部品をそのまま ⋯ の中へ）。
    const stateControls = createThreadStateControls(document,{thread,viewer:data.viewer,invoke:researchEditorOptions(entry).invoke,isCurrent:threadCurrent,
      readThrough:Math.min(thread.postCount,Math.max(0,...posts.map(p=>Number.isSafeInteger(p.no)?p.no:0))),onRefresh:()=>threadCurrent()?renderDetailEntry(entry):undefined});
    stateControls.classList.remove("card");
    stateControls.classList.add("thread-more-state");
    list.append(stateControls);
    more.append(toggle, list);
    tools.append(more);
    top.append(tools);
  }
  head.append(top, meta);
  if (thread.id) {
    const contentCard = createThreadContentCard({ document, threadId: thread.id, invoke,
      isCurrent: () => threadRevision === detailRenderRevision && currentView === "detail", openContent: openCommunityContent });
    head.append(contentCard.root);
  }
  if (thread.tags?.length) {
    const tags = document.createElement("p");
    tags.className = "meta";
    for (const tag of thread.tags) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "post-tag";
      chip.textContent = `#${tag}`;
      chip.onclick = () => void openDetail("tag", [tag], { title: `#${tag}` });
      tags.append(chip);
    }
    head.append(tags);
  }
  nodes.push(head);
  let replyTarget = null;
  let sending = false, refreshControlsPending = false, disposed = false;
  const postControls = new Set();
  const clearPostControls = () => { for (const control of postControls) control.destroy(); postControls.clear(); };
  let threadReader=null;
  const releasePostControls = () => { disposed = true;threadReader?.dispose();clearPostControls(); };
  const lifecycle = { dispose: releasePostControls, invalidate: releasePostControls };
  const postContext = {
    thread,
    viewer: data.viewer ?? null,
    canPickBest: Boolean(data.viewer?.canPickBestAnswer && thread.status !== "closed"),
    quote: (post) => {
      if (!replyTarget || sending || !threadCurrent()) return;
      replyTarget?.quote(post);
    },
  };
  const jumpToThreadPost = (no) => {
    const row = threadReader?.querySelector(`.thread-post[data-post-no="${no}"]`);
    if (!row) { showNotice(`#${no} は今の表示に出ていません。`); return; }
    row.tabIndex = -1; row.scrollIntoView?.({ block: "center" }); row.focus({ preventScroll: true });
  };
  const byNo = new Map(posts.map((p) => [p.no, p]));
  const relinkThread = (list) => {
    const rows = [...list.children].map((node) => {
      const post = byNo.get(Number(node.dataset?.postNo));
      return post && node.classList.contains("thread-post") ? { post: { id: post.id, replyToPostId: post.replyToPostId ?? byNo.get(post.replyTargetNo)?.id ?? null }, node } : null;
    });
    applyThreadLinks(rows);
  };
  threadReader=createThreadReader(document, { thread, posts, viewer: data.viewer, state: entry.reading ??= {}, selection:entry.targetSelection,isCurrent:threadCurrent,
    onRendered: relinkThread,
    onBeforeRender: clearPostControls,
    renderPost: post => {
      const card = threadPostCard(post, postContext, () => renderDetailEntry(entry), jumpToThreadPost);
      const current = () => !disposed && threadCurrent() && card.isConnected;
      const control = createThreadPostControls({ document, post, viewerId: data.viewer?.id ?? null,
        invoke: researchEditorOptions(entry).invoke, getScope: articleEditorScope, isCurrent: current,
        onChanged: async () => {
          if (!current()) return;
          if (sending) { refreshControlsPending = true; return; }
          await renderDetailEntry(entry);
        },
      });
      postControls.add(control); (card.querySelector(".post-content") ?? card).append(control.element); return card;
    },
  });
  // 検索と絞り込みは見出しの中へ（本文の前に別の枠を積まない）。
  const readerControls = threadReader.querySelector(":scope > form");
  if (readerControls) {
    readerControls.classList.add("thread-head-search");
    // 普段は畳む（2026-11-11）。頭の検索の印で開く。検索語が入っている間は開いたまま。
    const searchInput = readerControls.querySelector('input[type="search"]');
    const searchToggle = document.createElement("button");
    searchToggle.type = "button";
    searchToggle.className = "head-action thread-search-toggle";
    searchToggle.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13Zm9.5 16-4.5-4.5"/></svg>';
    searchToggle.title = "スレッド内を検索・並び順";
    searchToggle.setAttribute("aria-label", "スレッド内を検索・並び順");
    const showSearch = (open) => { readerControls.hidden = !open; searchToggle.setAttribute("aria-expanded", String(open)); };
    showSearch(entry.threadSearchOpen === true || Boolean(searchInput?.value));
    searchToggle.onclick = () => { entry.threadSearchOpen = readerControls.hidden; showSearch(entry.threadSearchOpen); if (entry.threadSearchOpen) searchInput?.focus(); };
    head.querySelector(".thread-head-tools")?.prepend(searchToggle);
    head.append(readerControls);
  }
  nodes.push(threadReader);
  // 統一した投稿の読み出し（place = thread:{id}）。旧表の投稿は上の道のまま、新しい形の投稿だけを続けて並べる。
  const placeList = document.createElement("div");
  placeList.className = "thread-place-posts";
  nodes.push(placeList);
  if (/^[A-Za-z0-9_-]{1,128}$/.test(thread.id ?? "") && typeof isUnifiedPost === "function") {
    void Promise.resolve(invoke("hub_detail", { name: "posts_place", ids: [`thread:${thread.id}`] })).then((result) => {
      if (disposed || !threadCurrent() || !Array.isArray(result?.items)) return;
      const known = new Set(posts.map((p) => p.id));
      const fresh = result.items.filter((item) => isUnifiedPost(item) && !known.has(item.id)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      if (fresh.length) placeList.replaceChildren(...fresh.map((item) => postCard(item)));
    }).catch(() => undefined);
  }
  nodes.push(threadKnowledgeControls(document, { thread, invoke: researchEditorOptions(entry).invoke, state: entry.knowledge ??= {}, onOpen: (id, title) => void openDetail("thread", [id], { title }) }));
  if (data.relatedThreads?.length) nodes.push(detailSection("関連スレッド", data.relatedThreads.map(item => catalogCard({ title: item.title,
    onOpen: () => void openDetail("thread", [item.id], { title: item.title }),
  }))));

  if ((thread.status ?? "open") !== "open" || thread.moderationStatus === "frozen" || thread.mergedIntoThreadId) {
    const note = document.createElement("p"); note.className = "meta"; note.textContent = "このスレッドは返信の受付を終了しています。";
    target.replaceChildren(...nodes, note); return lifecycle;
  }

  // 返信フォーム——スレッドが許す言語・タグ・地域だけを選ばせる。
  // 選べない値を送ってもハブが弾くので、選択肢はスレッドの宣言から組み立てる。
  const form = document.createElement("form");
  form.className = "thread-composer";
  const textarea = document.createElement("textarea");
  textarea.maxLength = 2000;
  textarea.dataset.threadReply = "";
  textarea.rows = 1;
  textarea.setAttribute("aria-label", "返信");
  const draft=entry.replyDraft??(entry.replyDraft={});textarea.value=draft.body??'';
  replyTarget = createThreadReplyTarget(document, { draft, textarea });
  textarea.placeholder = "返信を入力";
  const selects = document.createElement("div");
  selects.className = "thread-composer-options-body";
  const makeSelect = (labelText, options, current) => {
    const label = document.createElement("label");
    label.className = "field";
    const span = document.createElement("span");
    span.className = "meta";
    span.textContent = labelText;
    const select = document.createElement("select");
    for (const value of options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = LANGUAGE_LABELS[value] ?? REGION_LABELS[value] ?? value;
      select.append(option);
    }
    select.value = current;
    label.append(span, select);
    selects.append(label);
    return select;
  };
  const languages = thread.allowedLanguages?.length ? thread.allowedLanguages : [thread.language ?? "ja"];
  const tags = thread.allowedLanguageTags?.length ? thread.allowedLanguageTags : ["ja-JP"];
  const langSelect = makeSelect("言語", languages, thread.language ?? languages[0]);
  const tagSelect = makeSelect("言語・方言", tags, tags[0]);
  let countrySelect = null;
  if (thread.allowedCountryCodes?.length) {
    countrySelect = makeSelect("国・地域", thread.allowedCountryCodes, thread.allowedCountryCodes[0]);
  }
  for(const [key,control] of [['language',langSelect],['languageTag',tagSelect],['countryCode',countrySelect]])if(control){if([...control.options].some(o=>o.value===draft[key]))control.value=draft[key];control.onchange=()=>{draft[key]=control.value;};}
  const optionsBox = document.createElement("details");
  optionsBox.className = "thread-composer-options";
  const optionsToggle = document.createElement("summary");
  optionsToggle.textContent = "言語";
  optionsToggle.setAttribute("aria-label", "言語と地域");
  optionsBox.append(optionsToggle, selects);
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "approve";
  submit.disabled = !textarea.value.trim();
  submit.textContent = "返信";
  submit.title = "Ctrl+Enter";
  const formState = document.createElement("p");
  formState.className = "meta";

  textarea.oninput = () => {draft.body=textarea.value;submit.disabled=sending||!textarea.value.trim();textarea.style.height="auto";textarea.style.height=`${Math.min(textarea.scrollHeight,160)}px`;};
  textarea.onkeydown = (event) => {
    if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || event.isComposing) return;
    event.preventDefault();
    if (typeof form.requestSubmit === "function") form.requestSubmit(); else form.dispatchEvent(new (document.defaultView?.Event ?? Event)("submit", { cancelable: true, bubbles: true }));
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    const text = textarea.value.trim();
    if (!text||sending||!threadCurrent()) return;
    sending=true;submit.disabled=true;
    textarea.disabled=true;selects.querySelectorAll("select").forEach(control=>{control.disabled=true;});replyTarget.root.querySelector("button").disabled=true;
    formState.textContent = "送信中…";
    try {
      await researchEditorOptions(entry).invoke("hub_client_action", {
        action: "thread_reply",
        target: entry.ids[0],
        text,
        options: {
          language: langSelect.value,
          region: thread.region ?? "global",
          languageTag: tagSelect.value,
          countryCode: countrySelect?.value ?? null,
          replyToPostId: draft.replyToPostId ?? null,
        },
      });
      if (entry.replyDraft === draft) entry.replyDraft={};
      entry.replyFocused = false;
      if (!threadCurrent()) return;
      textarea.value = "";
      formState.textContent = "";
      await renderDetailEntry(entry);
    } catch (error) {
      formState.textContent = friendlyError(error);
      formState.classList.add("warning");
      submit.disabled = false;
    } finally {sending=false;textarea.disabled=false;selects.querySelectorAll("select").forEach(control=>{control.disabled=false;});replyTarget.root.querySelector("button").disabled=false;
      if (refreshControlsPending && threadCurrent()) { refreshControlsPending = false; void renderDetailEntry(entry); }
    }
  };
  const composerRow = document.createElement("div");
  composerRow.className = "thread-composer-row";
  composerRow.append(textarea, optionsBox, submit);
  form.append(replyTarget.root, composerRow, formState);
  nodes.push(form);
  target.replaceChildren(...nodes);
  // 開いたときは返信欄にカーソル（最初の1回だけ。描き直しのたびに奪わない）。
  if (!entry.replyFocused) {
    entry.replyFocused = true;
    void Promise.resolve().then(() => { if (!disposed && textarea.isConnected && !textarea.disabled) textarea.focus({ preventScroll: true }); });
  }
  return lifecycle;
}

// --- 記事・Hubpedia・本 ---
function renderArticleDetail(target, data) {
  const article = data.article ?? {};
  const reader = document.createElement("article");
  reader.className = "article-reader";
  { const band = document.querySelector("#detail-title"); if (band) band.textContent = "記事"; }
  // 表紙は Hub の画像と YouTube のサムネイルだけ。許可されない出どころは出さない（題が本文に1度ある）。
  if (article.thumbnailUrl && isAllowedImageUrl(article.thumbnailUrl, { hubOrigin: hubOrigin ?? "" })) {
    const media = document.createElement("div");
    media.className = "article-cover";
    const img = document.createElement("img");
    hubAsset(img, article.thumbnailUrl);
    img.alt = "";
    img.onerror = () => media.remove();
    media.append(img);
    reader.append(media);
  }
  const title = document.createElement("h1");
  title.className = "article-title";
  title.textContent = article.title ?? "記事";
  reader.append(title);
  if (article.summary) {
    const lead = document.createElement("p");
    lead.className = "article-lead";
    lead.textContent = article.summary;
    reader.append(lead);
  }
  // 著者カード：名前・ハンドル・日付・読了時間。ハンドルがあればプロフィールへ。
  const byline = document.createElement("div");
  byline.className = "article-byline";
  const authorName = article.authorName || "Hubの書き手";
  const avatar = document.createElement("span");
  avatar.className = "article-author-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = [...authorName][0] ?? "";
  const who = document.createElement(article.authorHandle ? "button" : "span");
  who.className = "article-author-name";
  if (article.authorHandle) {
    who.type = "button";
    who.onclick = () => void openHubPath(`/v2/profile/${encodeURIComponent(article.authorHandle)}`);
  }
  who.textContent = authorName;
  const facts = document.createElement("span");
  facts.className = "meta";
  facts.textContent = [article.authorHandle ? `@${article.authorHandle}` : "", relTime(article.createdAt, { absolute: true }), articleReadingLabel(articleReadingMinutes(article.body)), openLicenseLabel(article.license)].filter(Boolean).join(" · ");
  const text = document.createElement("div");
  text.className = "article-byline-text";
  const factsLine = document.createElement("div");
  factsLine.className = "article-byline-facts";
  factsLine.append(facts);
  text.append(who, factsLine);
  byline.append(avatar, text);
  reader.append(byline);
  if (article.tags?.length) {
    // タグは日時・読む時間の横（2026-11-05 所有者「ポスト以外もこの形式」）。
    const tags = document.createElement("span");
    tags.className = "meta article-tags";
    // 2026-11-05 所有者「タグもカード感を出して特別に」：字の列ではなく1つずつの札。押すとタグの頁。
    for (const tag of article.tags) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "post-tag";
      chip.textContent = `#${tag}`;
      chip.onclick = () => void openHubPath(`/v2/tag/${encodeURIComponent(tag)}`);
      tags.append(chip);
    }
    factsLine.append(tags);
  }
  const body = document.createElement("div");
  body.className = "article-reader-body detail-body";
  body.append(...articleBodyNodes(article.body ?? ""));
  reader.append(body);
  {
    // 記事は Hub の翻訳キャッシュの対象外（isPublic false）。端末の中だけで訳す。
    const translateRow = document.createElement("div");
    translateRow.className = "local-translate-row";
    body.before(translateRow);
    attachTranslateAction({ doc: document, host: translateRow, body, translator: localTranslator,
      item: { id: String(article.id ?? ""), revision: String(article.updatedAt ?? ""), type: "article", isPublic: false, sourceLang: article.language || null },
      getText: () => article.body ?? "",
      show: (text) => { const paragraphs = text.split(/\n{2,}/).map((part) => { const p = document.createElement("p"); p.textContent = part; return p; }); body.replaceChildren(...paragraphs); },
      restore: () => body.replaceChildren(...articleBodyNodes(article.body ?? "")) });
  }
  // 保存・紹介・AIに聞くの置き場。読む幅の中に一列で並べる（呼び出し側が各ボタンを足す）。
  const actions = document.createElement("div");
  actions.className = "article-actions";
  actions.setAttribute("role", "group");
  actions.setAttribute("aria-label", "記事の操作");
  reader.append(actions);
  const engagement = document.createElement("div");
  engagement.className = "article-engagement";
  reader.append(engagement);
  if (article.id) {
    const articleRevision = detailRenderRevision;
    reader.append(createCommunityTalk({ document, contentType: "article", contentId: article.id, invoke,
      isCurrent: () => articleRevision === detailRenderRevision && currentView === "detail", openThread: openCommunityThread, describeError: friendlyError }).root);
  }
  target.replaceChildren(reader);
  if (article.id) void loadArticleEngagement(engagement, article.id, article.authorHandle);
}

// コメント行（投稿と同じ行）の「…」。コメントに書き手のプロフィールIDが付くときだけ、人への既存の操作（リスト・ミュート・ブロック）を出す。
function commentRowOptions(connected) {
  return { icon, paintAvatar, hubAsset, decorate: (row, comment) => {
    const body = row.querySelector(".article-comment-body");
    if (!body) return;
    const host = document.createElement("div");
    host.className = "local-translate-row";
    body.after(host);
    attachTranslateAction({ doc: document, host, body, translator: localTranslator, item: { id: String(comment.id ?? ""), revision: "", type: "article_comment", isPublic: false, sourceLang: null }, getText: () => comment.body ?? "" });
  }, menuFor: (comment) => connected && comment.profileId ? [
    ["リストに追加", (row) => void openListPicker("profile", comment.profileId, row)],
    ["ミュート", () => void muteOrBlockProfile("mute", comment.profileId).catch((error) => showNotice(friendlyError(error)))],
    ["ブロック", () => void muteOrBlockProfile("block", comment.profileId).catch((error) => showNotice(friendlyError(error)))],
  ] : [] };
}

// いいね・コメント欄。接続済みなら端末の資格で自分のいいね状態を読み、付け外しとコメント投稿もできる。
// 未接続・失敗のときは公開面の読み取りだけにする。失敗しても本文は読めるので黙って畳む。
async function loadArticleEngagement(container, articleId, authorHandle) {
  const connected = desktopAccount.state === "registered";
  // 自分の記事にはHubがいいねを受け付けない。接続中のプロフィールのハンドルが著者と同じなら数の表示だけにする。
  // ハンドルを確かめられないときはボタンを残し、Hubの拒否メッセージをそのまま出す。
  const own = connected && authorHandle
    ? invoke("hub_client", { name: "me" }).then((me) => isOwnArticle(me?.profile, authorHandle)).catch(() => false)
    : Promise.resolve(false);
  const [like, comments, ownArticle] = await Promise.all([
    (connected ? invoke("hub_detail", { name: "article_like_me", ids: [articleId] }).catch(() => null) : Promise.resolve(null))
      .then((own) => own ?? invoke("hub_detail", { name: "article_like", ids: [articleId] }).catch(() => null)),
    invoke("hub_detail", { name: "article_comments", ids: [articleId] }).catch(() => null),
    own,
  ]);
  if (!container.isConnected) return;
  const nodes = [];
  const likeState = like ? parseLikeState(like) : null;
  const act = (action, options) => invoke("hub_client_action", { action, target: articleId, options }).catch((error) => { throw new Error(friendlyError(error)); });
  if (likeState) {
    nodes.push(connected && !ownArticle
      ? renderLikeButton(document, likeState, { onSet: (liked) => act(liked ? "article_like_set" : "article_like_clear") })
      : renderLikeSummary(document, likeState));
  }
  if (comments) {
    const page = parseCommentPage(comments);
    let list = null;
    const form = connected && page.commentsEnabled ? renderCommentForm(document, {
      onSubmit: async (body) => (await act("article_comment_create", { body }))?.comment ?? null,
      onPosted: () => {
        // 投稿後は一覧を読み直して自分のコメントを出す。失敗しても投稿は済んでいる。
        void invoke("hub_detail", { name: "article_comments", ids: [articleId] }).then((fresh) => {
          if (!container.isConnected || !list?.isConnected) return;
          const next = renderCommentList(document, parseCommentPage(fresh), { relTime, form, rowOptions: commentRowOptions(connected) });
          list.replaceWith(next);
          list = next;
        }).catch(() => {});
      },
    }) : null;
    list = renderCommentList(document, page, { relTime, form, rowOptions: commentRowOptions(connected), signedOutNote: connected ? "" : "コメントするにはDesktopを接続してください。" });
    nodes.push(list);
  }
  container.replaceChildren(...nodes);
}

// 自分の下書き一覧。編集はWeb版のHubの記事エディタ（?draft=ID）を既定のブラウザで開く。
async function renderArticleDrafts(target, _data, entry) {
  target.replaceChildren();
  const revision = detailRenderRevision, generation = researchAccountGeneration;
  const current = () => revision === detailRenderRevision && generation === researchAccountGeneration && currentView === "detail" && detailTrail.at(-1) === entry;
  const note = document.createElement("p");
  note.className = "meta";
  target.append(note);
  if (desktopAccount.state !== "registered") { note.textContent = "下書きを見るにはDesktopを接続してください。"; return; }
  note.textContent = "読み込んでいます…";
  try {
    const drafts = parseDrafts(await invoke("hub_client", { name: "article_drafts" }));
    if (!current()) return;
    target.replaceChildren(renderDraftList(document, drafts, {
      relTime,
      onOpen: async (draft) => {
        try {
          const origin = await invoke("hub_origin");
          await invoke("open_external", { url: new URL(draftEditorPath(draft.id), origin).href });
        } catch (error) { if (current()) showNotice(friendlyError(error)); }
      },
    }));
  } catch (error) {
    if (current()) note.textContent = friendlyError(error);
  }
}

// 本文の見出し（h3=大、h4=中、h5=小）から目次の箱を作る。番号は 1 / 1.1 / 1.1.1。
function hubpediaHeadings(root) {
  const base = Math.min(...[...root.querySelectorAll("h3.detail-h, h4.detail-h, h5.detail-h, h6.detail-h")].map((h) => Number(h.tagName[1])), 6);
  return [...root.querySelectorAll("h3.detail-h, h4.detail-h, h5.detail-h, h6.detail-h")].map((node) => ({ node, level: Number(node.tagName[1]) - base + 1, text: node.textContent.trim() })).filter((entry) => entry.text);
}
function hubpediaNumbers(entries) {
  const counters = [];
  return entries.map(({ level }) => {
    counters.length = level;
    for (let i = 0; i < level; i += 1) counters[i] = counters[i] ?? 0;
    counters[level - 1] += 1;
    return counters.slice(0, level).join(".");
  });
}
function hubpediaContents(body) {
  const entries = hubpediaHeadings(body);
  if (entries.length < 2) return null;
  const numbers = hubpediaNumbers(entries);
  const nav = document.createElement("nav");
  nav.className = "hubpedia-toc";
  nav.setAttribute("aria-label", "目次");
  const title = document.createElement("p");
  title.className = "hubpedia-toc-title";
  title.textContent = "目次";
  const list = document.createElement("ol");
  entries.forEach((entry, index) => {
    const item = document.createElement("li");
    item.dataset.level = String(Math.min(entry.level, 3));
    const link = document.createElement("button");
    link.type = "button";
    link.className = "hubpedia-toc-link";
    const number = document.createElement("span");
    number.className = "hubpedia-toc-number";
    number.textContent = numbers[index];
    link.append(number, entry.text);
    link.onclick = () => entry.node.scrollIntoView?.({ behavior: "smooth", block: "start" });
    item.append(link);
    list.append(item);
  });
  nav.append(title, list);
  return nav;
}
function renderHubpediaDetail(target, data) {
  const nodes = [];
  const head = document.createElement("div");
  head.className = "hubpedia-intro";
  const meta = document.createElement("p");
  meta.className = "meta";
  const checkedAt = data.freshness?.lastVerifiedAt;
  const checkedDate = checkedAt && !Number.isNaN(Date.parse(checkedAt))
    ? new Date(checkedAt).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" }) : "";
  meta.textContent = [data.category, data.freshness?.overdue ? "再確認が必要" : checkedDate ? `最終確認 ${checkedDate}` : ""].filter(Boolean).join(" · ");
  if (meta.textContent) head.append(meta);
  if (data.summary) {
    const summary = document.createElement("p");
    summary.className = "detail-p";
    summary.textContent = data.summary;
    head.append(summary);
  }
  let body = null;
  if (data.bodyMarkdown) {
    body = document.createElement("div");
    body.className = "hubpedia-reading detail-body";
    body.append(...markdownBlocks(data.bodyMarkdown));
  }
  // 目次の箱（Wikipedia の型）：細い線の枠に番号つきの見出し。節が2つ以上あるときだけ。押すとその節へ寄る。
  const toc = body ? hubpediaContents(body) : null;
  if (toc) head.append(toc);
  nodes.push(head);
  if (body) nodes.push(body);
  if (data.sources?.length) {
    // 出典は番号つきの行（枠なし）。URL があるものだけ押せる。
    const list = document.createElement("ol");
    list.className = "hubpedia-sources";
    for (const source of data.sources.slice(0, 20)) {
      const item = document.createElement("li");
      const link = source.url && /^https?:\/\//.test(source.url);
      const title = document.createElement(link ? "button" : "span");
      title.className = "hubpedia-source-title";
      title.textContent = source.title ?? source.url ?? "";
      if (link) { title.type = "button"; title.onclick = () => void enterBrowser(source.url); }
      item.append(title);
      const note = [source.publisher, source.license].filter(Boolean).join(" · ");
      if (note) { const meta = document.createElement("span"); meta.className = "meta"; meta.textContent = note; item.append(meta); }
      list.append(item);
    }
    nodes.push(detailSection("出典", [list]));
  }
  target.replaceChildren(...nodes);
}

function renderBookDetail(target, data, entry) {
  const book = data.book ?? {};
  const nodes = [];
  const head = document.createElement("div");
  head.className = "card book-head";
  if (book.coverImageUrl) {
    const media = document.createElement("div");
    media.className = "result-media";
    const img = document.createElement("img");
    hubAsset(img, book.coverImageUrl);
    img.alt = "";
    media.append(img);
    head.append(media);
  }
  const info = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = book.title ?? "本";
  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = [book.author, book.licenseName, book.sourceSiteName].filter(Boolean).join(" · ");
  info.append(title, meta);
  if (book.description) {
    const description = document.createElement("p");
    description.className = "detail-p";
    description.textContent = book.description;
    info.append(description);
  }
  head.append(info);
  nodes.push(head);
  if (book.readingMode === "article") {
    const chapters = book.chapters ?? [];
    nodes.push(detailSection(
      "目次",
      chapters.length
        ? chapters.map((chapter) => catalogCard({
          title: chapter.title,
          body: chapter.lead,
          onOpen: () => void openDetail("book_chapter", [book.id, chapter.slug], { title: chapter.title }),
        }))
        : [emptyState("books", "章がありません")],
    ));
  } else {
    const volumes = book.volumes ?? [];
    nodes.push(detailSection(
      "巻",
      volumes.length
        ? volumes.map((volume) => {
          const card = catalogCard({ title: volume.title ?? `第${volume.number}巻` });
          card.classList.add("is-link");
          card.title = "PDFをブラウザで開く";
          card.onclick = () => void openHubPath(volume.fileUrl);
          return card;
        })
        : [emptyState("books", "巻がありません")],
    ));
  }
  target.replaceChildren(...nodes);
}

function renderBookChapter(target, data, entry) {
  const chapter = data.chapter ?? {};
  const nodes = [];
  const head = document.createElement("div");
  head.className = "card";
  const eyebrow = document.createElement("p");
  eyebrow.className = "meta";
  eyebrow.textContent = `${data.book?.title ?? ""} · ${data.book?.author ?? ""}`;
  const title = document.createElement("h3");
  title.textContent = chapter.title ?? "章";
  head.append(eyebrow, title);
  if (chapter.lead) {
    const lead = document.createElement("p");
    lead.className = "detail-p";
    lead.textContent = chapter.lead;
    head.append(lead);
  }
  nodes.push(head);
  for (const section of chapter.sections ?? []) {
    const card = document.createElement("div");
    card.className = "card detail-body";
    if (section.heading) {
      const heading = document.createElement("h4");
      heading.className = "detail-h";
      heading.textContent = section.heading;
      card.append(heading);
    }
    for (const paragraph of section.paragraphs ?? []) {
      const p = document.createElement("p");
      p.className = "detail-p";
      p.textContent = paragraph;
      card.append(p);
    }
    if (section.quote) {
      const quote = document.createElement("blockquote");
      quote.className = "detail-quote";
      quote.textContent = section.quote;
      card.append(quote);
    }
    nodes.push(card);
  }
  if (data.prev || data.next) {
    const nav = document.createElement("div");
    nav.className = "detail-form-row";
    if (data.prev) {
      const prev = document.createElement("button");
      prev.type = "button";
      prev.className = "head-action";
      prev.textContent = `‹ ${data.prev.title}`;
      prev.onclick = () => void openDetail("book_chapter", [entry.ids[0], data.prev.slug], { title: data.prev.title });
      nav.append(prev);
    }
    if (data.next) {
      const next = document.createElement("button");
      next.type = "button";
      next.className = "head-action";
      next.textContent = `${data.next.title} ›`;
      next.onclick = () => void openDetail("book_chapter", [entry.ids[0], data.next.slug], { title: data.next.title });
      nav.append(next);
    }
    nodes.push(nav);
  }
  target.replaceChildren(...nodes);
}

// --- コミュニティ詳細：本体・参加状態・チャンネル ---
function renderCommunityAppeal(target,data,entry) {
  const options=researchEditorOptions(entry),own=entry.name==="community_appeal_history",stateKey=own?"appealSubmitDraft":"appealReviewDraft";
  const reload=async()=>{
    const next=await options.invoke("hub_detail",{name:entry.name,ids:entry.ids});
    if(next.communityId!==entry.ids[0] || (own?!Array.isArray(next.appeals):next.appeal?.id!==entry.ids[1]))throw new Error("異議申立てを確認できませんでした。");
    if(currentView!=="detail" || detailTrail.at(-1)!==entry)return;
    entry.data=next;renderCommunityAppeal(target,next,entry);
  };
  target.replaceChildren((own?communityAppealForm:communityAppealReview)(document,{communityId:entry.ids[0],appealId:entry.ids[1],data,state:entry[stateKey]??={},invoke:options.invoke,onReload:reload}));
}

function renderCommunityReport(target,data,entry) {
  const options=researchEditorOptions(entry);
  const reload=async()=>{
    const next=await options.invoke("hub_detail",{name:"community_report",ids:entry.ids});
    if(next.communityId!==entry.ids[0] || next.report?.id!==entry.ids[1])throw new Error("通報を確認できませんでした。");
    if(currentView!=="detail" || detailTrail.at(-1)!==entry)return;
    entry.data=next;renderCommunityReport(target,next,entry);
  };
  target.replaceChildren(communityReportReview(document,{communityId:entry.ids[0],reportId:entry.ids[1],data,state:entry.reportDraft??={},invoke:options.invoke,onReload:reload}));
}

function renderCommunityMembers(target, data, entry) {
  const options=researchEditorOptions(entry),state=entry.memberState??={};
  const refresh=async()=>{
    const next=await options.invoke("hub_detail",{name:"community_members",ids:entry.ids});
    if(next.communityId!==entry.ids[0] || !Array.isArray(next.members))throw new Error("メンバー一覧を確認できませんでした。");
    if(currentView!=="detail" || detailTrail.at(-1)!==entry)return;
    for(const [id,item] of state.targets??[])if(item.saved)state.targets.delete(id);
    entry.data=next;renderCommunityMembers(target,next,entry);
  };
  target.replaceChildren(communityMemberControls(document, { ...data, state, invoke:options.invoke, refresh, holdingAsset:data.holdingAsset??null }));
}

function renderCommunityGuides(target, data, entry) {
  const history = entry.name === "community_guide_revisions";
  target.replaceChildren(communityGuideCatalog(document,{communityId:entry.ids[0],pageId:entry.ids[1],data,invoke:researchEditorOptions(entry).invoke,history,proposals:entry.name==="community_guide_proposals",state:entry.guidePage??={},draft:entry.guideDraft??={},onOpen:(name,ids,title)=>void openDetail(name,ids,{title})}));
}
function renderCommunityGuide(target, data, entry) {
  target.replaceChildren(communityGuidePage(document,{communityId:entry.ids[0],pageId:entry.ids[1],data,revision:entry.name === "community_guide_revision",draft:entry.guideDraft??={},invoke:researchEditorOptions(entry).invoke,onOpen:(name,ids,title)=>void openDetail(name,ids,{title})}));
}
function communityPreferenceControls(data,entry) {
  if(!data.viewerId || !['active','muted'].includes(data.viewerStatus))return null;
  const options=researchEditorOptions(entry),revision=detailRenderRevision,generation=researchAccountGeneration;
  const current=()=>revision===detailRenderRevision&&generation===researchAccountGeneration&&options.isCurrent();
  const controller=createCommunityNotifications({document,communityId:entry.ids[0],invoke:options.invoke,isCurrent:current,
    getAccount:()=>desktopAccount.state==='registered'?String(researchAccountGeneration):null,canReadAll:true,
    onReadAll:async()=>{
      const next=await options.invoke('hub_detail',{name:'community',ids:[entry.ids[0]]});
      if(!current())return;
      if(next?.viewerId!==data.viewerId || next?.community?.id!==entry.ids[0] || !['active','muted'].includes(next.viewerStatus))throw Error('既読操作は受け付けましたが、現在の状態を確認できませんでした。画面を更新してください。');
      entry.data=next;
    }});
  return{root:controller.element,ready:controller.ready,dispose:controller.destroy,invalidate:controller.destroy};
}

// コミュニティ内の見出し（投稿 / メンバー / 設定）。左の列の木と同じ行き先。
// 行は 投稿 / 記事 / 動画 / 音楽 / メンバー（旧「掲載」は種類ごとの行に統合）。設定は ⋯ メニューから開く。
const COMMUNITY_SECTIONS = [["chat", "チャット"], ["shared", "共有"], ["members", "メンバー"], ["settings", "設定"]];
function communitySection(entry) {
  const asked = entry.section ?? entry.targetSelection?.section;
  // 旧い呼び名：posts＝チャット、記事・動画・音楽・掲載＝共有（種類を覚えておく）。
  if (["article", "video", "music", "content"].includes(asked)) { entry.sharedKind = asked === "content" ? "article" : asked; return "shared"; }
  return ["shared", "members", "settings"].includes(asked) ? asked : "chat";
}
function communitySectionItems(entry) {
  if (!entry || entry.name !== "community") return [];
  const data = entry.data ?? {};
  const section = communitySection(entry);
  // 外側の左の列：開いているコミュニティの下に 共有 → メンバー だけ（チャンネルは無い）。
  // 流れそのものはコミュニティの行が表す。並び（新着・人気）は流れの上に1か所だけ置き、ここには置かない（2026-11-10：同じ切り替えを2か所に出さない）。
  return [
    { key: "shared", label: "共有", selected: section === "shared" },
    ...(data.viewerId ? [{ key: "members", label: "メンバー", selected: section === "members" }] : []),
  ];
}
// コミュニティに載ったコンテンツ・つながったスレッドを開く。音楽は右の枠で開く。
function openCommunityContent(type, item) {
  const id = item?.contentId;
  if (typeof id !== "string" || !id) return;
  if (type === "music") {
    if (!openMusicWorkInRail({ id, title: item.title, artist: item.summary ?? "", source: "community" }, { autoplay: false })) showNotice("作品を開けませんでした。");
    return;
  }
  void openDetail(type, [id], { title: item.title || ({ post: "投稿", article: "記事", video: "動画" }[type] ?? "") });
}
function openCommunityThread(threadId) { if (typeof threadId === "string" && threadId) void openDetail("thread", [threadId], { title: "スレッド" }); }
function selectCommunitySection(entry, key) {
  if (!entry || entry.name !== "community" || !COMMUNITY_SECTIONS.some(([value]) => value === key)) return;
  if (communitySection(entry) === key) return;
  entry.section = key;
  if (entry.targetSelection) entry.targetSelection.section = undefined;
  viewScroller()?.scrollTo?.({ top: 0 });
  void renderDetailEntry(entry);
}

// 投稿ストリームの読み込み。続きはカーソルで足す。
// mode.kind：チャンネル（投稿の種類）を固定する。mode.chat：チャットの並び（古い順・下に新着）で、新着は静かに取り直す。
// mode.key：entry に覚えておく場所（チャットと共同ページで別）。
function mountCommunityStream(host, entry, holder, ownerCurrent, mode = {}) {
  const stream = entry[mode.key ?? "stream"] ??= { kind: mode.kind ?? null };
  if (mode.kind) stream.kind = mode.kind;
  const [communityId] = entry.ids;
  const request = (cursor) => {
    const kind = stream.kind ?? null;
    if (cursor) return kind ? ["community_posts_kind_page", [communityId, kind, cursor]] : ["community_posts_page", [communityId, cursor]];
    return kind ? ["community_posts_kind", [communityId, kind]] : ["community_posts", [communityId]];
  };
  let epoch = 0, shown = "", stuck = true, settled = false;
  const scroller = () => host.querySelector(".community-chat-scroll");
  // 統一した読み出し（place = channel:{コミュニティ}:{チャンネル}）。旧表のメッセージは上の道のまま、新しい形の投稿だけを続けて並べる。
  // 1本の流れの場所は既定のチャンネル（サーバーの形は変えない）。種類は投稿の kind に載る。
  // 種類のチップ（雑談・質問・募集）は置き場 channel:{コミュニティ}:{chat|question|party} になる。3つを読んで1本に並べる。
  const placeFor = () => (mode.chat && /^[A-Za-z0-9_-]{1,128}$/.test(communityId) ? `channel:${communityId}:chat` : "");
  const loadPlace = () => {
    const place = placeFor();
    if (!place) return Promise.resolve();
    return Promise.all(["chat", "question", "party"].map((kind) => Promise.resolve(invoke("hub_detail", { name: "posts_place", ids: [`channel:${communityId}:${kind}`] }))
      .then((result) => (Array.isArray(result?.items) ? result.items.filter((item) => isUnifiedPost(item)).map((item) => ({ ...item, communityKind: kind })) : null), () => null)))
      .then((lists) => {
        if (!ownerCurrent() || place !== placeFor() || lists.every((list) => list === null)) return;
        stream.placeKey = place;
        stream.placeItems = lists.flatMap((list) => list ?? []);
        if (stream.data) paint();
      }).catch(() => undefined);
  };
  const reloadAll = () => { void loadPlace(); return load(null, true); };
  const paint = (toEnd = false) => {
    const had = host.contains(document.activeElement) && document.activeElement?.tagName === "TEXTAREA";
    const old = scroller();
    const oldTop = old?.scrollTop ?? 0;
    holder.ctrl?.dispose?.();
    holder.ctrl = renderCommunityStream(host, stream.data, entry, {
      kind: mode.kind, chat: mode.chat === true, order: stream.order, period: stream.period,
      placeItems: stream.placeKey === placeFor() ? stream.placeItems ?? [] : [],
      openPost: (item) => void openDetail("post", [item.id], { title: item.title || "投稿", communityId }),
      likePost: (item, on) => invoke("hub_client_action", { action: "react_post", target: item.id, options: { action: "like", on } }).then((result) => ({ likes: result?.counts?.likes, liked: result?.viewer?.liked })),
      postMenu: (item) => unifiedRowDeps().menu(item), openAuthor: (handle) => unifiedAuthorOpen(handle),
      // 並びは手元で掛ける（読み直さない）。種類は読み直す。
      onOrder: (order) => { stream.order = normalizeCommunityOrder(order); paint(); },
      onPeriod: (period) => { stream.period = normalizeTopPeriod(period); paint(); },
      onThread: (id) => { stream.thread = id ?? null; paint(); viewScroller()?.scrollTo?.({ top: 0 }); },
      onKind: (kind) => { stream.kind = kind; stream.data = null; void load(); },
      onMore: () => void load(stream.data?.nextCursor ?? null),
      reload: reloadAll,
    });
    const box = scroller();
    if (box) box.scrollTop = toEnd ? 0 : oldTop;
    if (had) host.querySelector("form textarea")?.focus({ preventScroll: true });
    shown = JSON.stringify(stream.data?.messages ?? []);
  };
  async function load(cursor = null, quiet = false) {
    // 最初の読み込みが決着する（描くか、失敗を出す）まで、静かな読み直しは始めない。追い越すと最初の結果が捨てられ、骨組みのまま止まる。
    if (quiet && !settled) return;
    const mine = ++epoch;
    if (!cursor && !quiet) host.replaceChildren(skeletonResult(), skeletonResult());
    const [name, ids] = request(cursor);
    try {
      const next = await invoke("hub_detail", { name, ids });
      if (mine !== epoch || !ownerCurrent()) return;
      if (!Array.isArray(next?.messages)) throw new Error("投稿を確認できませんでした。");
      const before = cursor || quiet ? stream.data : null;
      const seen = new Set((before?.messages ?? []).map((message) => message.id));
      if (quiet && before) {
        // 新着を静かに足す：先頭の頁で置き換え、もっと古い頁（読み込み済み）はそのまま残す。
        const fresh = new Set(next.messages.map((message) => message.id));
        const older = before.messages.filter((message) => !fresh.has(message.id));
        stream.data = { ...next, messages: [...next.messages, ...older], nextCursor: before.nextCursor ?? next.nextCursor, profiles: { ...before.profiles, ...next.profiles } };
        if (JSON.stringify(stream.data.messages) === shown && host.childElementCount) return;
        paint();
        return;
      }
      stream.data = before
        ? { ...next, messages: [...before.messages, ...next.messages.filter((message) => !seen.has(message.id))], profiles: { ...before.profiles, ...next.profiles }, pollOptions: [...(before.pollOptions ?? []), ...(next.pollOptions ?? [])] }
        : next;
      settled = true;
      paint(!cursor);
    } catch (error) {
      if (mine !== epoch || !ownerCurrent()) return;
      if (quiet) return;
      settled = true;
      host.replaceChildren(accountNeeded(error) ? connectState() : pageErrorState("読み込めませんでした", friendlyError(error), () => void load(cursor)));
    }
  }
  const first = load();
  loadPlace();
  if (mode.chat) {
    // 新着：繋がっていればリアルタイム（group-message）、でなければ定期取得。右列が同じ接続を使っている間は定期取得だけ。
    const live = subscribeGroup({
      win: window, group: { kind: "public", id: communityId }, refresh: reloadAll,
      realtime: !(typeof railChat !== "undefined" && railChat.isOpen) && window.__TAURI__?.event?.listen ? { invoke: (name, args) => invoke(name, args), listen: (name, handler) => window.__TAURI__.event.listen(name, (event) => handler(event.payload)) } : null,
      isActive: () => ownerCurrent() && document.visibilityState !== "hidden",
      isFocused: () => document.hasFocus?.() !== false,
    });
    const dispose = holder.liveStop;
    holder.liveStop = () => { dispose?.(); live.stop(); };
  }
  return first;
}

function renderCommunityDetail(target, data, entry) {
  const community = data.community ?? {};
  const membership = data.membership;
  const section = communitySection(entry);
  entry.section = section;
  const nodes = [];
  const isMember = Boolean(data.viewerId) && ["active", "muted"].includes(data.viewerStatus);
  const revision=detailRenderRevision,generation=researchAccountGeneration;
  const sectionCurrent=()=>revision===detailRenderRevision&&generation===researchAccountGeneration&&currentView==="detail"&&detailTrail.at(-1)===entry;
  // 自分のポイント（ポイントを使わないコミュニティや未参加なら何も出ない）
  const points = isMember ? createCommunityPoints({ document, communityId: community.id, invoke: researchEditorOptions(entry).invoke, isCurrent: sectionCurrent }) : null;
  // 参加・退出。未接続なら接続を促すだけ——ボタンを出しても通らない。
  const joinRevision=detailRenderRevision,joinGeneration=researchAccountGeneration;
  const joinCurrent=()=>joinRevision===detailRenderRevision&&joinGeneration===researchAccountGeneration&&currentView==='detail'&&detailTrail.at(-1)===entry;
  const join=communityMembershipControls(document,{...data,state:entry.joinState??={},invoke:researchEditorOptions(entry).invoke,isCurrent:joinCurrent,connectAccount:()=>connectDesktopAccount(),refresh:()=>joinCurrent()?renderDetailEntry(entry):Promise.resolve()});
  const buttonAction = (label, action) => { const button = document.createElement("button"); button.type = "button"; button.className = "head-action"; button.textContent = label; button.onclick = action; return button; };
  // 見出し（2026-11-10）：顔・名前・条件の錠前・人数・説明、右端に 参加 → 概要 → ⋯。
  // 参加の手続きと概要（ルール・運営・作成日）は見出しのすぐ下に開く。⋯ は管理とガイドと設定だけ。
  const moreMenu = document.createElement("details");
  moreMenu.className = "community-more";
  const moreSummary = document.createElement("summary");
  moreSummary.className = "head-action community-more-toggle";
  moreSummary.textContent = "⋯";
  moreSummary.setAttribute("aria-label", "その他の操作");
  moreSummary.setAttribute("data-keep-text", "");
  const moreList = document.createElement("div");
  moreList.className = "community-more-list";
  moreList.setAttribute("role", "group");
  moreMenu.append(moreSummary, moreList);
  // 外を押す・Escで閉じる（開いている間だけ聞く）。
  const closeAway = (event) => { if (!moreMenu.isConnected || !moreMenu.open) { document.removeEventListener("click", closeAway); return; } if (!moreMenu.contains(event.target)) moreMenu.open = false; };
  moreMenu.addEventListener("toggle", () => { if (moreMenu.open) document.addEventListener("click", closeAway); else document.removeEventListener("click", closeAway); });
  moreMenu.addEventListener("keydown", (event) => { if (event.key === "Escape" && moreMenu.open) { event.stopPropagation(); moreMenu.open = false; moreSummary.focus(); } });
  const menuAction = (label, action) => { const button = buttonAction(label, () => { moreMenu.open = false; action(); }); button.className = "community-more-item"; moreList.append(button); return button; };
  if(data.canManage)menuAction("参加申請",()=>void openDetail("community_membership_requests",[community.id],{title:"参加申請"}));
  if(data.canManage)menuAction("通報",()=>void openDetail("community_reports",[community.id],{title:"通報"}));
  if(data.canManage)menuAction("異議申立ての審査",()=>void openDetail("community_appeals",[community.id],{title:"異議申立て"}));
  if(data.viewerId && membership)menuAction("自分の異議申立て",()=>void openDetail("community_appeal_history",[community.id],{title:"自分の異議申立て"}));
  if(community.governanceMode==='dao')menuAction('ガバナンス',()=>{if(joinCurrent())void openDetail('community_governance',[community.id],{title:'ガバナンス',governanceState:entry.governanceState??={}});});
  if (community.visibility !== "private" || ["active", "muted"].includes(data.viewerStatus))
    menuAction("ガイド", () => void openDetail("community_guides", [community.id], { title: "ガイド" }));
  if (["active", "muted"].includes(data.viewerStatus)) menuAction("設定", () => { if (sectionCurrent()) selectCommunitySection(entry, "settings"); });
  const panels = entry.headPanels ??= { join: false, about: false };
  const joinHost = document.createElement("div");
  joinHost.className = "community-head-panel community-head-join-panel";
  joinHost.append(join.root);
  const aboutHost = document.createElement("div");
  aboutHost.className = "community-head-panel community-head-about-panel";
  let aboutMounted = false;
  const mountAbout = () => {
    if (aboutMounted) return;
    aboutMounted = true;
    const read = researchEditorOptions(entry).invoke;
    const about = createCommunityAbout(document, {
      community, icon, isCurrent: sectionCurrent,
      formatDate: (value) => new Date(value).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" }),
      loadRules: () => read("hub_detail", { name: "community_onboarding", ids: [community.id] }).then((value) => value?.rules ?? []),
      loadModerators: data.viewerId ? () => read("hub_detail", { name: "community_members", ids: [community.id] }).then((value) => value?.members ?? []) : null,
      onProfile: (handle) => unifiedAuthorOpen(handle),
    });
    aboutHost.append(about.root);
  };
  const syncPanels = () => {
    joinHost.hidden = !panels.join; aboutHost.hidden = !panels.about;
    head.setJoinOpen(panels.join); head.setAboutOpen(panels.about);
    if (panels.about) mountAbout();
  };
  const head = createCommunityHead(document, {
    community, icon, asset: (img, url) => hubAsset(img, url), more: moreList.childElementCount ? moreMenu : null,
    join: communityJoinView({ membership, viewerStatus: data.viewerStatus, visibility: community.visibility }),
    section: section === "chat" ? "" : ({ shared: "共有", members: "メンバー", settings: "設定" }[section] ?? ""),
    aboutOpen: panels.about, joinOpen: panels.join,
    onAbout: () => { if (!sectionCurrent()) return; panels.about = !panels.about; syncPanels(); },
    onJoin: () => {
      if (!sectionCurrent()) return;
      panels.join = !panels.join; syncPanels();
      // まだ入っていないなら、開いたその手で参加の案内（ルールと質問）まで進める。
      if (panels.join && !joinHost.querySelector("form, .card")) [...joinHost.querySelectorAll("button")].find((button) => !button.disabled && /^(参加する|参加を申請する)$/.test(globalThis.__hubI18n?.source(button) ?? button.textContent))?.click();
    },
  });
  syncPanels();
  nodes.push(head.root, joinHost, aboutHost);
  const controllers=[join], holder={ctrl:null}, pending=[];
  if (points) pending.push(points.ready);
  // 2026-11-08 所有者決定：チャンネルは持たない。コミュニティの投稿は1本の流れ。雑談・質問・募集は投稿の種類で、流れの上のチップで絞るだけ。
  navCommunities.setCurrent(community.id, communitySectionItems(entry), { name: community.name, imageUrl: community.imageUrl });
  if (section === "chat") {
    const host = document.createElement("div");
    host.className = "community-stream community-chat-main";
    nodes.push(host);
    holder.liveStop?.(); holder.liveStop = null;
    pending.push(Promise.resolve().then(() => (sectionCurrent() ? mountCommunityStream(host, entry, holder, sectionCurrent, { chat: true, key: "stream" }) : undefined)).catch(() => {}));
  } else if (section === "shared") {
    const shared = createSharedTab({
      document, initial: entry.sharedKind ?? "article", isCurrent: sectionCurrent, onKind: (kind) => { entry.sharedKind = kind; },
      createContentTabs: (type) => createCommunityContentTabs({ document, communityId: community.id, invoke, isCurrent: sectionCurrent, type, open: openCommunityContent, describeError: friendlyError }),
      mountGuides: (host) => {
        const guideHolder = { ctrl: null };
        entry.guideStream = { kind: "guide" };
        const ready = mountCommunityStream(host, entry, guideHolder, sectionCurrent, { kind: "guide", key: "guideStream" });
        return { ready, dispose() { guideHolder.ctrl?.dispose?.(); }, invalidate() { guideHolder.ctrl?.invalidate?.(); } };
      },
    });
    nodes.push(shared.root);
    controllers.push(shared);
  } else if (section === "members") {
    if (points) nodes.push(points.own, points.ranking);
    if (data.viewerId) {
      const host = document.createElement("div");
      host.className = "community-members";
      nodes.push(host);
      const options = researchEditorOptions(entry), state = entry.memberState ??= {};
      const showMembers = async () => {
        const next = await options.invoke("hub_detail", { name: "community_members", ids: [community.id] });
        if (!sectionCurrent()) return;
        if (next.communityId !== community.id || !Array.isArray(next.members)) throw new Error("メンバー一覧を確認できませんでした。");
        host.replaceChildren(communityMemberControls(document, { ...next, state, invoke: options.invoke, refresh: showMembers, holdingAsset: next.holdingAsset ?? null }));
      };
      pending.push(showMembers().catch((error) => {
        if (!sectionCurrent()) return;
        const note = document.createElement("p");
        note.className = "meta warning"; note.textContent = friendlyError(error);
        host.replaceChildren(note, retryButton(() => void showMembers().catch(() => {})));
      }));
    }
  } else {
    if (points) nodes.push(...points.toggle);
    const preferences=communityPreferenceControls(data,entry);
    if(preferences){nodes.push(preferences.root);controllers.push(preferences);}
    if(data.viewerId){
      const holdingOptions=researchEditorOptions(entry);
      const holding=communityHoldingSettings(document,{communityId:community.id,canManage:Boolean(data.canManage),joined:['active','muted'].includes(data.viewerStatus),invoke:holdingOptions.invoke,icon,isCurrent:()=>revision===detailRenderRevision&&generation===researchAccountGeneration&&currentView==="detail"});
      nodes.push(holding.root);controllers.push(holding);
    }
    if (data.canManage) {
      const access=communityAccessManagement(document,{communityId:community.id,invoke,storage:entry.accessManagementState??={},isCurrent:()=>revision===detailRenderRevision&&generation===researchAccountGeneration&&currentView==="detail",onChanged:()=>void renderDetailEntry(entry)});
      nodes.push(access.root);controllers.push(access);
    } else entry.accessManagementState=undefined;
    if (!nodes.length || nodes.length === 1) nodes.push(emptyState("community", "設定できる項目はありません"));
  }
  target.replaceChildren(...nodes);
  return{get ready(){return Promise.all([...controllers.map(c=>c.ready),...pending]);},dispose(){controllers.forEach(c=>c.dispose());holder.liveStop?.();holder.ctrl?.dispose?.();},invalidate(){controllers.forEach(c=>c.invalidate());holder.liveStop?.();holder.ctrl?.invalidate?.();}};
}

// --- コミュニティの投稿ストリーム（チャンネルは無い。タグのチップで絞る） ---
const MESSAGE_KIND_LABELS = { chat: "雑談", guide: "共同ページ", question: "質問", party: "募集" };

// 人（プロフィール）へのミュート・ブロック。投稿の「…」と同じ道（hub_client_action mute/block）。外すのはプロフィールの画面で。
async function muteOrBlockProfile(action, profileId) {
  const map = await loadSafetyControls();
  const prev = map.get(profileId) ?? { muted: false, blocked: false };
  const key = action === "mute" ? "muted" : "blocked";
  if (prev[key]) return;
  if (action === "block" && !confirm("ブロックするとお互いのフォローが外れます。ブロックしますか？")) return;
  await invoke("hub_client_action", { action, target: profileId });
  map.set(profileId, { ...prev, [key]: true });
}

// 2026-11-06 所有者「コミュニティとかレビューとかコメントもそう」：コミュニティの発言も投稿と同じ行（post-row.mjs）。
// 操作は既存の道だけ：いいね＝❤️の反応、返信、編集・削除・固定・通報。
function communityPostCard(message, profiles, handlers) {
  const profile = profiles?.[message.authorProfileId];
  let row = null;
  const flags = [message.kind && message.kind !== "chat" ? MESSAGE_KIND_LABELS[message.kind] : "", message.editedAt ? "編集済み" : ""];
  const common = {
    authorName: profile?.displayName ?? message.botName ?? "メンバー", authorHandle: profile?.handle, avatarUrl: profile?.avatarUrl,
    time: relTime(message.createdAt), timeTitle: message.createdAt ? new Date(message.createdAt).toLocaleString("ja-JP") : "",
    authorHolding: profile?.holding ?? null, authorRole: profile?.communityRole ?? null,
    meta: flags, hubAsset, icon, paintAvatar, classes: ["community-post"],
  };
  const pin = () => {
    if (!message.pinnedAt) return;
    const mark = document.createElement("span");
    mark.className = "pin-marker"; mark.textContent = "固定";
    row.querySelector(".post-head").append(mark);
  };
  if (message.locked) {
    const note = document.createElement("p");
    note.className = "post-body meta"; note.textContent = "鍵付きの投稿です。条件を満たすと読めます。";
    row = createPostRow(document, { ...common, body: note });
    pin();
    return row;
  }
  const ownerId = handlers.viewerId;
  const menu = [];
  if (ownerId && message.authorProfileId === ownerId) {
    menu.push(["編集", () => handlers.edit(message, row)], ["削除", () => void handlers.remove(message)]);
  }
  if (handlers.canModerate) menu.push([message.pinnedAt ? "固定を解除" : "固定する", () => void handlers.pin(message)]);
  if (ownerId && message.authorProfileId && message.authorProfileId !== ownerId) {
    const fail = (error) => { row.dataset.actionError = friendlyError(error); row.classList.add("action-error"); };
    menu.push(["リストに追加", () => void openListPicker("profile", message.authorProfileId, row)],
      ["ミュート", () => void muteOrBlockProfile("mute", message.authorProfileId).catch(fail)],
      ["ブロック", () => void muteOrBlockProfile("block", message.authorProfileId).catch(fail)],
      ["報告", () => {
        const existing = row.querySelector(".report-form");
        if (existing) { existing.remove(); return; }
        row.querySelector(".post-content").append(reportForm("community_message", message.id, { communityId: handlers.communityId }));
      }]);
  }
  const actions = [];
  if (handlers.canPost) {
    actions.push({ icon: "heart", label: "いいね", onClick: () => void handlers.react(message, "❤️") },
      { icon: "reply", label: "返信", onClick: () => handlers.reply(message) });
    menu.push(["👍で反応", () => void handlers.react(message, "👍")], ["🎉で反応", () => void handlers.react(message, "🎉")]);
  }
  // 投稿の操作行と同じ並び：いいね・返信・共有（リンクをコピー）。共有は読むだけの人にも出す。
  actions.push({ icon: "share", label: "共有（リンクをコピー）", onClick: async (_e, button) => {
    const origin = hubOrigin ?? (await invoke("hub_origin").catch(() => null));
    const url = origin ? `${origin}/v2/community?community=${encodeURIComponent(handlers.communityId)}&post=${encodeURIComponent(message.id)}` : "";
    if (!url) return;
    try { await navigator.clipboard.writeText(url); button.classList.add("is-done"); setTimeout(() => button.classList.remove("is-done"), 1600); }
    catch { await invoke("open_external", { url }).catch(() => undefined); }
  } });
  const replyTo = message.replyToMessageId ? { label: handlers.parentName?.(message.replyToMessageId) ?? "メッセージ", onClick: () => {
    const target = [...(row.closest("section")?.querySelectorAll("[data-message-id]") ?? [])].find((node) => node.dataset.messageId === message.replyToMessageId);
    if (target) { target.tabIndex = -1; target.scrollIntoView?.({ block: "center" }); target.focus({ preventScroll: true }); }
  } } : null;
  row = createPostRow(document, { ...common, replyTo, body: message.body, images: message.images ?? [], actions, menu });
  pin();
  const poll = handlers.pollOptions?.filter(option => option.messageId === message.id) ?? [];
  if (poll.length) row.querySelector(".post-content").append(communityPollCard(document, { options: poll, canVote: handlers.canPost, invoke: handlers.invoke, communityId: handlers.communityId, refresh: handlers.refresh }));
  return row;
}

// コミュニティの流れの書き込み欄：タイムラインと同じ統一した欄を1つ作って entry に持たせる。再描画しても打ちかけの文は残る。
// 種類（雑談・質問・募集）は置き場 channel:{コミュニティ}:{種類} になる。既定は雑談。
const COMMUNITY_CHANNEL_KINDS = ["chat", "question", "party"];
const COMMUNITY_CHANNEL_ICONS = { chat: "bubble", question: "search", party: "people" };
function communityUnifiedComposer(entry, communityId, viewerId, reload) {
  const held = entry.communityUnified;
  if (held && held.communityId === communityId && held.viewerId === viewerId) { held.reload = reload; return held; }
  const next = { communityId, viewerId, reload, composer: null };
  next.composer = unifiedComposerFor({
    place: `channel:${communityId}:chat`, label: "コミュニティ", icon: "bubble", variant: "inline", placeholder: "書き込む",
    placeChoices: COMMUNITY_CHANNEL_KINDS.map((kind) => ({ value: `channel:${communityId}:${kind}`, label: MESSAGE_KIND_LABELS[kind], icon: COMMUNITY_CHANNEL_ICONS[kind] })),
    onPosted: (post) => { if (post) next.reload?.(); },
  });
  entry.communityUnified = next;
  return next;
}
// data は GET communities/{id}/posts の応答（キーは messages のまま）。ctx.onKind / ctx.onMore は読み込む側が渡す。
function renderCommunityStream(target, data, entry, ctx = {}) {
  const messages = data.messages ?? [];
  const profiles = data.profiles ?? {};
  const [communityId] = entry.ids;
  const nodes = [];
  const generation=researchAccountGeneration,revision=detailRenderRevision;
  let disposed=false;
  const current=()=>!disposed&&generation===researchAccountGeneration&&revision===detailRenderRevision&&currentView==='detail'&&detailTrail.at(-1)===entry;
  const options=researchEditorOptions(entry);
  const postInvoke=async(name,args)=>{
    if(!current())throw Error('account_changed');
    const managed=name==='hub_client_action'&&['community_poll_create','community_poll_vote','community_message_schedule'].includes(args?.action);
    let scope;
    if(managed){
      scope=await articleEditorScope();
      if(!current()||!scope||scope.generation!==generation||typeof data.viewerProfileId!=='string'||!data.viewerProfileId)throw Error('account_changed');
      const [origin,deviceId]=JSON.parse(scope.key);
      args={...args,options:{...args.options,expectedOrigin:origin,expectedDeviceId:deviceId,expectedViewerId:data.viewerProfileId}};
    }
    const result=await options.invoke(name,args);
    if(!current())throw Error('account_changed');
    if(managed){
      const after=await articleEditorScope();
      if(!current()||!after||after.key!==scope.key||after.generation!==scope.generation)throw Error('account_changed');
      if(result?.viewerId!==data.viewerProfileId)throw Error('community_operation_unknown');
    }
    return result;
  };
  const refresh=()=>current()?(ctx.reload?ctx.reload():renderDetailEntry(entry)):Promise.resolve();
  const formState=document.createElement('p');formState.className='meta';
  // 流れ（chat）の書き込み欄はタイムラインと同じ統一した欄。共同ページ（ctx.kind）だけ従来の欄のまま。
  const streamState=entry.stream??={kind:null};
  if(ctx.chat===true&&!ctx.kind&&entry.targetSelection?.messageId&&!entry.targetSelection.applied){
    const hit=messages.find(item=>item.id===entry.targetSelection.messageId);
    if(hit?.replyToMessageId)streamState.thread=messageThreads(messages).rootOf(hit.id);
  }
  // 旧い形の発言を開いている間（threadId）は、その発言と返信の木だけを出す。返信先を持てる従来の欄を使う。
  const threadId=ctx.chat===true&&!ctx.kind&&typeof streamState.thread==='string'&&messages.some(item=>item.id===streamState.thread)?streamState.thread:null;
  const unified=ctx.chat===true&&!ctx.kind&&!threadId&&data.canPost===true&&Boolean(data.viewerProfileId)&&/^[A-Za-z0-9_-]{1,128}$/.test(communityId);
  const unifiedHolder=unified?communityUnifiedComposer(entry,communityId,data.viewerProfileId,refresh):null;
  const composer=unifiedHolder?.composer??null;
  const controller=!unified&&data.canPost===true&&data.viewerProfileId?createChannelComposer({
    document,communityId,viewerId:data.viewerProfileId,state:entry.postDraft??={},
    invoke:postInvoke,getScope:()=>articleEditorScope(),isCurrent:current,
    uploadFiles:uploadChannelImages,onSent:refresh,formatError:friendlyError,
    onError:()=>{if(current())formState.textContent='操作結果を確認してください。';}
  }):null;
  const textarea=controller?.textarea,kind=controller?.kind;
  // チャンネル（または共同ページ）の中では、投稿の種類はそのチャンネルに固定する（選ぶ欄は隠す）。
  if(kind&&!ctx.kind)kind.querySelector('option[value="guide"]')?.remove();
  if(kind&&ctx.kind){kind.hidden=true;if(kind.value!==ctx.kind){kind.value=ctx.kind;kind.onchange?.();}}
  const act=async(action,message,extra={})=>{
    if(!current())return;
    try{
      await postInvoke("hub_client_action",{action,target:communityId,...extra,options:{messageId:message.id,...(extra.options??{})}});
      await refresh();
    }catch(error){
      if(!current())return;
      formState.textContent=friendlyError(error);
      formState.classList.add("warning");
    }
  };
  const handlers = {
    communityId,
    parentName: (id) => { const parent = messages.find((item) => item.id === id); const who = parent && profiles[parent.authorProfileId]; return who ? (who.handle ? `@${who.handle}` : who.displayName) : undefined; },
    invoke:postInvoke,
    viewerId: data.viewerProfileId ?? null,
    canPost: data.canPost === true, pollOptions: data.pollOptions ?? [], refresh,
    canModerate: data.canModerate === true,
    replyTarget: (message) => { if(controller&&message)controller.setReply({id:message.id,communityId,label:[...(profiles[message.authorProfileId]?.displayName??'メンバー'),...('「'+message.body.slice(0,40)+'」')].slice(0,120).join('')}); },
    reply: (message) => {
      if(!current())return;
      if(composer){composer.focus();return;}
      if(!controller)return;
      if(controller.setReply({id:message.id,communityId,label:[...(profiles[message.authorProfileId]?.displayName??'メンバー'),...('「'+message.body.slice(0,40)+'」')].slice(0,120).join('')}))textarea.focus();
    },
    edit: (message, card) => {
      if(!current())return;
      const existing = card.querySelector(".message-edit");
      if (existing) { existing.remove(); return; }
      const form = document.createElement("div");
      form.className = "detail-form message-edit";
      const box = document.createElement("textarea");
      box.value = message.body;
      box.maxLength = 2000;
      box.rows = 3;
      const save = document.createElement("button");
      save.type = "button";
      save.className = "approve";
      save.textContent = "保存";
      const note = document.createElement("span");
      note.className = "meta";
      save.onclick = async () => {
        if(!current()||!card.isConnected)return;
        const next = box.value.trim();
        if (!next) { note.textContent = "本文が必要です"; return; }
        save.disabled = true;
        note.textContent = "保存しています…";
        try {
          await postInvoke("hub_client_action", {
            action: "community_post_edit",
            target: communityId,
            text: next,
            options: { messageId: message.id },
          });
          await refresh();
        } catch (error) {
          if(!current()||!card.isConnected)return;
          save.disabled = false;
          note.textContent = friendlyError(error);
        }
      };
      form.append(box, save, note);
      (card.querySelector(".post-content") ?? card).append(form);
      box.focus();
    },
    remove: async (message) => {
      if (!current()||!confirm("この投稿を削除しますか？")) return;
      await act("community_post_delete", message);
    },
    pin: (message) => act(message.pinnedAt ? "community_post_unpin" : "community_post_pin", message),
    react: (message, emoji) => act("community_post_reaction", message, { options: { emoji } }),
  };
  // 流れの上の1行：左に種類のチップ（雑談・質問・募集）、右端に並び（新着・人気）。並びはここだけ（左の列には置かない）。
  const stream = streamState;
  if (!ctx.kind && !threadId) {
    const chips = document.createElement("div");
    chips.className = "chip-row community-kind-chips";
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", "投稿の種類");
    for (const [value, label] of [[null, "すべて"], ...Object.entries(MESSAGE_KIND_LABELS).filter(([key]) => key !== "guide")]) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.textContent = label;
      chip.dataset.kind = value ?? "";
      chip.setAttribute("aria-pressed", String((stream.kind ?? null) === value));
      chip.onclick = () => { if (current() && (stream.kind ?? null) !== value) ctx.onKind?.(value); };
      chips.append(chip);
    }
    if (ctx.chat) {
      const bar = document.createElement("div");
      bar.className = "community-toolbar";
      const orders = document.createElement("div");
      orders.className = "community-order";
      orders.setAttribute("role", "group");
      orders.setAttribute("aria-label", "並び");
      const now = normalizeCommunityOrder(ctx.order);
      for (const [value, label] of COMMUNITY_ORDERS) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "community-order-item";
        button.textContent = label;
        button.dataset.order = value;
        button.setAttribute("data-keep-text", "");
        button.setAttribute("aria-pressed", String(now === value));
        button.onclick = () => { if (current() && now !== value) ctx.onOrder?.(value); };
        orders.append(button);
      }
      // トップのときだけ、並びの右に期間を選ぶ欄（今日・今週・今月・すべて）。
      const sorts = document.createElement("div");
      sorts.className = "community-sorts";
      sorts.append(orders);
      if (now === "top") {
        const period = document.createElement("select");
        period.className = "community-period";
        period.setAttribute("aria-label", "期間");
        const chosen = normalizeTopPeriod(ctx.period);
        for (const [value, label] of TOP_PERIODS) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = label;
          option.selected = value === chosen;
          period.append(option);
        }
        period.onchange = () => { if (current()) ctx.onPeriod?.(period.value); };
        // 開く欄であることは字でなく下向きの印で示す。
        const wrap = document.createElement("span");
        wrap.className = "community-period-wrap";
        wrap.innerHTML = '<svg class="ic community-period-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>';
        wrap.prepend(period);
        sorts.append(wrap);
      }
      bar.append(chips, sorts);
      nodes.push(bar);
    } else nodes.push(chips);
  }
  const fullCard = (message) => { const card = communityPostCard(message, profiles, handlers); card.dataset.messageId = message.id; return card; };
  const toRows = (list) => { const rows = list.map((message) => ({ post: { id: message.id, replyToPostId: message.replyToMessageId }, node: fullCard(message) })); applyThreadLinks(rows); return rows.map((row) => row.node); };
  const more = data.nextCursor && ctx.onMore ? document.createElement("button") : null;
  if (more) {
    more.type = "button";
    more.className = "head-action community-more";
    more.textContent = ctx.chat ? "古い投稿を読み込む" : "さらに読み込む";
    more.onclick = () => { if (current()) { more.disabled = true; ctx.onMore(); } };
  }
  if (ctx.chat && threadId) {
    // 旧い形の発言の詳細：元の発言、その下に返信の木（左の線で畳む）。戻るのは上の1行。
    const parentOf = (message) => message.replyToMessageId;
    const byId = new Map(messages.map((message) => [message.id, message]));
    const under = (message) => { const seen = new Set(); let at = message; while (at && at.replyToMessageId && !seen.has(at.id)) { if (at.replyToMessageId === threadId) return true; seen.add(at.id); at = byId.get(at.replyToMessageId); } return false; };
    const back = document.createElement("button");
    back.type = "button";
    back.className = "community-thread-back";
    back.innerHTML = icon("back");
    back.title = "流れに戻る"; back.setAttribute("aria-label", "流れに戻る");
    back.onclick = () => { if (current()) ctx.onThread?.(null); };
    const root = fullCard(byId.get(threadId));
    root.classList.add("community-thread-root");
    const tree = buildReplyTree(messages.filter(under).sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt)), threadId, { parentOf });
    const scroll = document.createElement("div");
    scroll.className = "community-chat-scroll community-thread";
    scroll.append(back, root, ...(tree.length ? [renderReplyTree(document, tree, { renderItem: fullCard, parentOf, collapsed: stream.collapsed ??= new Set(), onContinue: (message) => ctx.onThread?.(message.id) })] : []));
    nodes.push(scroll);
    // 返信の欄は、開いた発言を返信先にして待つ（欄の準備が済んでから。打ちかけの返信先があれば変えない）。
    if (controller) Promise.resolve(controller.ready).then(() => { if (current() && !disposed && !entry.postDraft?.reply) handlers.replyTarget(byId.get(threadId)); }, () => {});
  } else if (ctx.chat) {
    // 並び（新着・人気）：固定した投稿が先頭、あとは選んだ並び。1件は詰めた2行（題・種類・書いた人・時刻、右に 絵・返信の数・いいね）。
    // 返信は流れに並べない：元の投稿の返信の数に入り、開いた先で木になる。
    const known = new Set(messages.map((message) => message.id));
    const placed = (ctx.placeItems ?? []).filter((item) => item?.id && !known.has(item.id) && !item.replyToPostId);
    const placedIds = new Set(placed.map((item) => item.id));
    const threads = messageThreads(messages);
    const ordered = orderCommunityMessages([...threads.roots, ...placed], { order: ctx.order, period: ctx.period, kind: stream.kind ?? null });
    const dense = { icon, hubAsset, relTime, onAuthor: ctx.openAuthor };
    const rows = ordered.map((item) => {
      const row = placedIds.has(item.id)
        ? createCommunityRow(document, rowFromPost(item), { ...dense, onOpen: () => ctx.openPost?.(item), onLike: ctx.likePost ? (_view, on) => ctx.likePost(item, on) : null, menu: ctx.postMenu?.(item) ?? [] })
        : createCommunityRow(document, rowFromMessage(item, profiles, { replies: threads.replies.get(item.id) ?? 0 }), { ...dense,
          onOpen: () => { if (current()) ctx.onThread?.(item.id); },
          onLike: handlers.canPost && !item.locked ? () => handlers.react(item, "❤️") : null,
          menu: [...(handlers.canModerate ? [[item.pinnedAt ? "固定を解除" : "固定する", () => void handlers.pin(item)]] : []), ...(handlers.viewerId && item.authorProfileId === handlers.viewerId ? [["削除", () => void handlers.remove(item)]] : [])] });
      row.dataset.messageId = item.id;
      return row;
    });
    const scroll = document.createElement("div");
    scroll.className = "community-chat-scroll community-rows";
    scroll.setAttribute("role", "feed");
    scroll.setAttribute("aria-label", "コミュニティの投稿");
    scroll.append(...(rows.length ? rows : [emptyState("community", "まだ書き込みはありません")]), ...(more ? [more] : []));
    // 書き込み欄はタイムラインと同じく流れの先頭。
    if (composer) nodes.unshift(composer.root);
    nodes.push(scroll);
  } else {
    nodes.push(detailSection(
      `投稿 ${messages.length || ""}`.trim(),
      messages.length ? toRows(messages) : [emptyState("community", "まだ投稿はありません")],
    ));
    if (more) nodes.push(more);
  }
  if (composer) {
    // 上で置いた。
  } else if (controller) {
    // 共同ページと、旧い形の発言への返信の欄。画像・アンケート・予約投稿は入力欄の ＋ メニューから。
    const tools=communityComposerTools(document,{communityId,invoke:postInvoke,refresh,textarea,kind,hasImages:controller.hasImages});
    controller.addAction?.('アンケートを作成',()=>tools.openPanel?.('poll'));
    controller.addAction?.('予約投稿',()=>tools.openPanel?.('schedule'));
    nodes.push(tools,controller.element);
  } else if (!ctx.chat || data.canPost !== true) { const note = document.createElement("p"); note.className = "meta community-post-note"; note.textContent = "投稿するには、Desktop接続とこのコミュニティへの投稿権限が必要です。"; nodes.push(note); }
  nodes.push(formState);
  const messageId=entry.targetSelection?.messageId;
  if(messageId&&!entry.targetSelection.applied){
    const message=messages.find(item=>item.id===messageId);
    const card=nodes.flatMap(node=>[...node.querySelectorAll('[data-message-id]')]).find(node=>node.dataset.messageId===messageId);
    if(message&&card&&!message.deletedAt&&!message.moderatedAt){
      entry.targetSelection.applied=true;card.tabIndex=-1;card.dataset.notificationTarget='true';
      queueMicrotask(()=>{if(current()&&card.isConnected){card.focus({preventScroll:true});card.scrollIntoView({block:'center'});}});
    }else if(!ctx.onMore||!data.nextCursor){
      const note=document.createElement('p');note.className='meta';note.textContent='通知の投稿は表示できません。削除されたか、現在の表示範囲にありません。';note.setAttribute('role','status');nodes.unshift(note);
    }
  }
  target.replaceChildren(...nodes);
  if(controller&&!entry.targetSelection&&!ctx.chat){
    const typing=()=>document.activeElement?.matches?.('input, textarea, select, [contenteditable]');
    Promise.resolve(controller.ready).then(()=>{if(current()&&!disposed&&textarea.isConnected&&!textarea.disabled&&!typing())textarea.focus({preventScroll:true});},()=>{});
  }
  return {dispose:()=>{disposed=true;controller?.destroy();},invalidate:()=>{disposed=true;controller?.invalidate();controller?.destroy();}};
}

// --- 出品詳細：商品の中身は読める。注文・支払いはCommerce側の仕事なので
// Webの専用面へ逃がす。 ---
function renderListingDetail(target, data) {
  const listing = data.listing ?? {};
  const nodes = [];
  const head = document.createElement("div");
  head.className = "card";
  const title = document.createElement("h3");
  title.textContent = listing.title ?? "出品";
  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = [listing.category, listing.priceLabel, listing.providerLabel, listing.status].filter(Boolean).join(" · ");
  head.append(title, meta);
  for (const [label, value] of [
    ["概要", listing.summary ?? listing.description],
    ["場所", listing.location],
    ["期間", listing.eventAt ? relTime(listing.eventAt, { absolute: true }) : ""],
  ]) {
    if (!value) continue;
    const p = document.createElement("p");
    p.className = "detail-p";
    p.textContent = `${label}: ${value}`;
    head.append(p);
  }
  const note = document.createElement("p");
  note.className = "meta";
  note.textContent = "注文・支払いはCommerce側の画面で行います。";
  head.append(note);
  nodes.push(head);
  target.replaceChildren(...nodes);
}

// --- 動画・楽曲：詳細の中身は一覧の項目が持っている。再生は提供元へ ---
function renderVideoDetail(target, data, entry) {
  const item=data.video??data;
  const nodes = [];
  const head = document.createElement("div");
  head.className = "card";
  if (item.thumbnailUrl) {
    const media = document.createElement("div");
    media.className = "result-media";
    const img = document.createElement("img");
    hubAsset(img, item.thumbnailUrl);
    img.alt = "";
    media.append(img);
    head.append(media);
  }
  const title = document.createElement("h3");
  title.textContent = item.title ?? "動画";
  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = [item.channel, item.category, item.duration, item.publishedAt ? relTime(item.publishedAt) : "", item.viewCount != null ? `${item.viewCount} 回視聴` : ""].filter(Boolean).join(" · ");
  head.append(title, meta);
  if (item.safetyNotice) {
    const notice = document.createElement("p");
    notice.className = "warning";
    notice.textContent = item.safetyNotice;
    head.append(notice);
  }
  const note = document.createElement("p");
  note.className = "meta";
  note.textContent = "再生は提供元のページで行います。";
  head.append(note);
  const row = document.createElement("div");
  row.className = "actions";
  if (item.sourceUrl) {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "approve";
    open.textContent = "提供元で再生";
    open.onclick = () => void enterBrowser(item.sourceUrl);
    row.append(open);
  }
  head.append(row);
  nodes.push(head);
  target.replaceChildren(...nodes);
  const options=researchEditorOptions(entry),revision=detailRenderRevision;
  if(typeof entry.ids[0]==='string'&&entry.ids[0].length>0&&entry.ids[0].length<=128&&!/[^A-Za-z0-9_-]/u.test(entry.ids[0])) {
    target.append(createCommunityTalk({document,contentType:'video',contentId:entry.ids[0],invoke:options.invoke,
      isCurrent:()=>options.isCurrent()&&revision===detailRenderRevision,openThread:openCommunityThread,describeError:friendlyError}).root);
    videoCommentsController=mountVideoPosts({videoId:entry.ids[0],invoke:options.invoke,renderPost:post=>postCard(post),
      state:entry.videoCommentDraft??={},isCurrent:()=>options.isCurrent()&&revision===detailRenderRevision,
    });
    target.append(videoCommentsController.element);
  }
}

// アーティスト・アルバムの頁。目録は手元の曲（検索結果・再生待ち・作品）と、名前で引いた music_tracks / hub_resource から組む。
function openMusicArtist(name) { const value = String(name ?? '').trim(); if (value) void openDetail('music_artist', [value.slice(0, 128)], { local: true, data: { kind: 'artist', name: value }, title: value }); }
function openMusicAlbum(name, artist = '') { const value = String(name ?? '').trim(); if (value) void openDetail('music_album', [value.slice(0, 128)], { local: true, data: { kind: 'album', name: value, artist: String(artist ?? '').trim() }, title: value }); }
function musicCollectionSeed() {
  const known = [...musicPlayer.tracks, ...musicPlayer.queue];
  if (musicPlayer.currentTrack && !musicPlayer.currentTrack.peer) known.push(musicPlayer.currentTrack);
  return known;
}
async function loadMusicCollectionSources(query) {
  const [tracks, works] = await Promise.allSettled([invoke('music_tracks', { query, offset: 0 }), invoke('hub_resource', { resource: 'music', query })]);
  if (tracks.status === 'rejected' && works.status === 'rejected') throw tracks.reason;
  return [...(tracks.status === 'fulfilled' && Array.isArray(tracks.value?.tracks) ? tracks.value.tracks : []), ...(works.status === 'fulfilled' && Array.isArray(works.value?.works) ? works.value.works : [])];
}
function renderMusicCollectionDetail(target, data, entry) {
  musicYoutube.stop();
  { const band = document.querySelector('#detail-title'); if (band) band.textContent = '音楽'; }
  target.replaceChildren();
  const revision = detailRenderRevision, generation = researchAccountGeneration;
  const kind = entry.name === 'music_album' ? 'album' : 'artist';
  const name = data?.name ?? entry.ids[0], artist = data?.artist ?? '';
  return renderMusicCollection({ document, host: target, kind, name, artist, seed: musicCollectionSeed(), hubAsset: (img, url) => hubAsset(img, url),
    load: () => loadMusicCollectionSources(kind === 'album' && artist ? artist : name),
    isCurrent: () => revision === detailRenderRevision && generation === researchAccountGeneration && currentView === 'detail' && detailTrail.at(-1) === entry,
    actions: {
      playTracks: (tracks, start) => { const index = tracks.findIndex(track => track.id === start.id); const from = index >= 200 ? index : 0; void playMusicTrack(start, tracks.slice(from, from + 200)); },
      playWork: work => void playMusicWork(work),
      openWork: work => void playMusicWork(work),
      enqueue: track => enqueueMusicTrack(track, 'next'),
      openArtist: openMusicArtist, openAlbum: openMusicAlbum } });
}
function musicPageCurrent(entry) {
  const revision = detailRenderRevision, generation = researchAccountGeneration;
  return () => revision === detailRenderRevision && generation === researchAccountGeneration && currentView === "detail" && detailTrail.at(-1) === entry;
}
function musicPageActions() {
  return {
    playTracks: (tracks, start) => { const index = tracks.findIndex((track) => track.id === start.id); const from = index >= 200 ? index : 0; void playMusicTrack(start, tracks.slice(from, from + 200)); },
    playWork: (work) => void playMusicWork(work),
    openWork: (work) => void playMusicWork(work),
    enqueue: (track) => enqueueMusicTrack(track, "next"),
    openArtist: openMusicArtist,
  };
}
function renderMusicPlaylistDetail(target, data, entry) {
  musicYoutube.stop();
  { const band = document.querySelector("#detail-title"); if (band) band.textContent = "音楽"; }
  target.replaceChildren();
  const current = musicPageCurrent(entry);
  const note = document.createElement("p");
  note.className = "meta"; note.setAttribute("role", "status"); note.textContent = "読み込んでいます…";
  target.append(note);
  const resolver = createItemResolver({ invoke, kind: "music" });
  let page = null, gone = false;
  void (async () => {
    try {
      const raw = await invoke("hub_client", { name: "music_playlists" });
      if (gone || !current()) return;
      const found = (Array.isArray(raw?.playlists) ? raw.playlists : []).find((item) => item?.id === entry.ids[0]);
      if (!found) { note.textContent = "このプレイリストは見つかりませんでした。"; return; }
      note.remove();
      page = renderMusicPlaylist({ document, host: target, playlist: { id: found.id, title: String(found.title ?? ""), description: String(found.description ?? ""), items: Array.isArray(found.workIds) ? found.workIds : [] },
        resolve: (id) => resolver.resolve(id), hubAsset: (img, url) => hubAsset(img, url), isCurrent: current,
        actions: { ...musicPageActions(), edit: () => document.querySelector("#music-playlists").click() } });
    } catch { if (!gone) note.textContent = "プレイリストを読み込めませんでした。"; }
  })();
  const stop = () => { gone = true; page?.destroy(); };
  return { dispose: stop, destroy: stop, invalidate: stop };
}
function renderMusicArtistsDetail(target, data, entry) {
  musicYoutube.stop();
  { const band = document.querySelector("#detail-title"); if (band) band.textContent = "音楽"; }
  target.replaceChildren();
  const page = renderMusicArtists({ document, host: target, load: () => loadMusicCollectionSources(""), hubAsset: (img, url) => hubAsset(img, url), isCurrent: musicPageCurrent(entry), actions: { openArtist: openMusicArtist } });
  const stop = () => page.destroy();
  return { dispose: stop, destroy: stop, invalidate: stop };
}
// --- プロフィール詳細：本人か他人かで操作が変わる ---
function renderProfileDetail(target, data, entry) {
  const profile = data.profile;
  if (!profile) {
    target.replaceChildren(emptyState("profile", "プロフィールが見つかりません", "削除されたか、表示できないアカウントです。"));
    return;
  }
  const nodes = [];
  const head = document.createElement("div");
  head.className = "card";
  const row = document.createElement("div");
  row.className = "contact-card";
  const avatar = document.createElement("span");
  avatar.className = "post-avatar";
  if (profile.avatarUrl) {
    const img = document.createElement("img");
    hubAsset(img, profile.avatarUrl);
    img.alt = "";
    avatar.classList.add("has-image");
    avatar.append(img);
  } else {
    avatar.textContent = (profile.displayName || profile.handle || "?").trim().slice(0, 1).toUpperCase();
    paintAvatar(avatar, profile.displayName || profile.handle);
  }
  const who = document.createElement("div");
  const name = document.createElement("h3");
  name.textContent = profile.displayName ?? profile.handle;
  const handle = document.createElement("p");
  handle.className = "meta";
  handle.textContent = `@${profile.handle}`;
  who.append(name, handle);
  row.append(avatar, who);
  head.append(row);
  if (profile.bio) {
    const bio = document.createElement("p");
    bio.className = "detail-p";
    bio.textContent = profile.bio;
    head.append(bio);
    addBaitRow(document, bio, profile.bio);
  }
  // リンク・登録時期・件数（押すとフォロワー/フォロー中の一覧）とタブは profile-view.mjs。
  const profileDeps = { ...profileViewDeps(), onEdit: null, origin: hubOrigin };
  const profileBody = createProfileBody(document, data, profileDeps);
  head.append(renderProfileFacts(document, data, profileDeps),
    renderProfileStats(document, { ...data, postCount: data.posts?.length ?? 0 }, { onConnections: profileBody.showConnections }),
    renderProfileActions(document, data, profileDeps));
  // フォロー。自分自身と未接続には出さない——通らないボタンは飾り。
  const isSelf = data.isCurrentUser === true;
  const connected = Boolean(data.currentProfile?.id);
  if (connected) {
    const actions = document.createElement("div");
    actions.className = "actions";
    if (!isSelf) {
      const follow = document.createElement("button");
      follow.type = "button";
      follow.className = data.following ? "deny" : "approve";
      follow.textContent = data.following ? "フォロー中" : "フォローする";
      follow.onclick = async () => {
        follow.disabled = true;
        try {
          await invoke("hub_client_action", {
            action: data.following ? "unfollow" : "follow",
            target: profile.id,
          });
          await renderDetailEntry(entry);
        } catch (error) {
          follow.disabled = false;
          follow.textContent = friendlyError(error);
        }
      };
      const dm = document.createElement("button");
      dm.type = "button";
      dm.className = "head-action";
      dm.textContent = "メッセージ";
      dm.onclick = async () => {
        dm.disabled = true;
        try {
          const result = await invoke("hub_client_action", { action: "start_dm", target: profile.id });
          await navigateFrom({ dataset: { view: "messages" }, childNodes: [] });
          if (result?.conversation_id) await openConversation(result.conversation_id);
        } catch (error) {
          dm.disabled = false;
          dm.textContent = friendlyError(error);
        }
      };
      // 他のハブの人にはDMを送れない（ハブ間DMは当面しない）。ボタンを出さず、返信で話しかけてもらう。
      if (isRemoteProfile(data)) {
        const note = document.createElement("p");
        note.className = "meta";
        note.textContent = "別のハブの人です。返信やメンションで話しかけられます。ダイレクトメッセージは送れません。";
        actions.append(follow, note);
      } else {
        actions.append(follow, dm);
      }
    } else {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "head-action";
      edit.textContent = "プロフィールを編集";
      edit.onclick = () => {
        const existing = head.querySelector(".detail-form");
        if (existing) { existing.remove(); return; }
        head.append(profileEditForm(entry, profile));
      };
      actions.append(edit);
      // 他のハブの人をフォローする欄。送ったフォローの状態（承認待ち・フォロー中）もここに並ぶ。
      const remote = remoteFollowForm({ document, invoke, friendlyError });
      head.append(remote.root);
      void remote.refresh();
    }
    if (!isSelf) {
      const addList = document.createElement("button");
      addList.type = "button";
      addList.className = "head-action";
      addList.textContent = "リストに追加";
      addList.onclick = () => void openListPicker("profile", profile.id, head);
      actions.append(addList);
      const tip = document.createElement("button");
      tip.type = "button";
      tip.className = "head-action";
      tip.textContent = "チップ";
      tip.onclick = () => void openTipDialog(profile);
      actions.append(tip);

      // ミュート・ブロック・通報。状態は一覧を読んでから確定する。
      const safety = document.createElement("div");
      safety.className = "detail-form-row";
      const muteBtn = document.createElement("button");
      muteBtn.type = "button";
      muteBtn.className = "head-action";
      const blockBtn = document.createElement("button");
      blockBtn.type = "button";
      blockBtn.className = "head-action";
      const reportBtn = document.createElement("button");
      reportBtn.type = "button";
      reportBtn.className = "head-action";
      reportBtn.textContent = "通報";
      const safetyNote = document.createElement("span");
      safetyNote.className = "meta";
      safety.append(muteBtn, blockBtn, reportBtn, safetyNote);
      head.append(safety);
      const paintSafety = (ctrl) => {
        muteBtn.textContent = ctrl?.muted ? "ミュート中" : "ミュート";
        blockBtn.textContent = ctrl?.blocked ? "ブロック中" : "ブロック";
      };
      let currentControl = null;
      paintSafety(null);
      muteBtn.disabled = blockBtn.disabled = true;
      void loadSafetyControls().then((map) => {
        currentControl = map.get(profile.id) ?? null;
        paintSafety(currentControl);
        muteBtn.disabled = blockBtn.disabled = false;
      });
      const setControl = async (action, enabled) => {
        const button = action === "mute" ? muteBtn : blockBtn;
        button.disabled = true;
        try {
          await invoke("hub_client_action", {
            action: (enabled ? "" : "un") + action,
            target: profile.id,
          });
          const map = await loadSafetyControls();
          const prev = map.get(profile.id) ?? { muted: false, blocked: false };
          const next = { ...prev, [action === "mute" ? "muted" : "blocked"]: enabled };
          map.set(profile.id, next);
          currentControl = next;
          paintSafety(next);
        } catch (error) {
          safetyNote.textContent = friendlyError(error);
        } finally {
          button.disabled = false;
        }
      };
      muteBtn.onclick = () => void setControl("mute", !currentControl?.muted);
      blockBtn.onclick = () => {
        if (!currentControl?.blocked && !confirm("ブロックするとお互いのフォローが外れます。ブロックしますか？")) return;
        void setControl("block", !currentControl?.blocked);
      };
      reportBtn.onclick = () => {
        const existing = head.querySelector(".report-form");
        if (existing) { existing.remove(); return; }
        head.append(reportForm("profile", profile.id));
      };
    }
    if (actions.children.length) head.append(actions);
  }
  nodes.push(head, profileBody.root);
  target.replaceChildren(...nodes);
}

// --- 安全（ミュート・ブロック・通報） ---
// 操作は /api/client/safety と /api/client/reports へ。理由の選択肢は
// ハブ側の集合と同じにしておき、判断自体はハブに任せる。
const REPORT_REASONS = {
  social_post: [["image_safety", "画像の安全性"], ["sexual", "性的な内容"], ["violence", "暴力的な内容"], ["copyright", "著作権の侵害"], ["privacy", "プライバシー"], ["harassment", "嫌がらせ"], ["spam", "スパム"], ["other", "その他"]],
  profile: [["harassment", "嫌がらせ"], ["spam", "スパム"], ["impersonation", "なりすまし"], ["privacy", "プライバシー"], ["other", "その他"]],
  community_message: [["spam", "スパム"], ["harassment", "嫌がらせ"], ["other", "その他"]],
  thread_post: [["harassment", "嫌がらせ"], ["spam", "スパム"], ["privacy", "プライバシー"], ["misinformation", "誤った情報"], ["other", "その他"]],
};

// targetType=community_message のとき targetId はメッセージID、
// extra に {communityId} を渡す（宛先の組み立てのため）。
function reportForm(targetType, targetId, extra = {}) {
  const form = document.createElement("div");
  form.className = "detail-form report-form";
  const label = document.createElement("strong");
  label.textContent = "この" + (targetType === "community_message" ? "メッセージ" : targetType === "profile" ? "プロフィール" : "投稿") + "を通報する";
  const select = document.createElement("select");
  for (const [value, text] of REPORT_REASONS[targetType === "unified_post" ? "social_post" : targetType] ?? []) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  const details = document.createElement("textarea");
  details.placeholder = "詳細（任意・500字まで）";
  details.maxLength = 500;
  details.rows = 3;
  const send = document.createElement("button");
  send.type = "button";
  send.className = "approve";
  send.textContent = "送信";
  const note = document.createElement("span");
  note.className = "meta";
  send.onclick = async () => {
    send.disabled = true;
    note.textContent = "送っています…";
    try {
      await invoke("hub_client_action", {
        action: targetType === "unified_post" ? "report_post_v2" : targetType === "social_post" ? "report_post" : targetType === "community_message" ? "community_post_report" : targetType === "thread_post" ? "thread_post_report" : "report_profile",
        target: targetType === "community_message" ? extra.communityId : targetId,
        ...(targetType === "unified_post" ? { requestId: crypto.randomUUID() } : {}),
        options: targetType === "unified_post" ? { reason: select.value, ...(details.value.trim() ? { detail: details.value.trim() } : {}) }
          : { reason: select.value, details: details.value.trim(), ...(targetType === "community_message" ? { messageId: targetId } : {}) },
      });
      form.replaceChildren();
      const done = document.createElement("p");
      done.className = "meta";
      done.textContent = "通報を受け付けました。運営が内容を確認します。";
      form.append(done);
    } catch (error) {
      send.disabled = false;
      note.textContent = friendlyError(error);
    }
  };
  form.append(label, select, details, send, note);
  return form;
}

// ミュート/ブロックの状態。最初の表示で読み、操作のたびに張り替える。
let safetyControls = null;
async function loadSafetyControls() {
  if (!safetyControls) {
    try {
      const data = await invoke("hub_client", { name: "safety" });
      safetyControls = new Map((data.controls ?? []).map((c) => [c.profileId, c]));
    } catch {
      safetyControls = new Map();
    }
  }
  return safetyControls;
}

// --- タグ詳細：1つのタグで8種類が並ぶ（Web版 /v2/tag と同じ断面） ---
function renderTagDetail(target, data) {
  const nodes = [];
  const head = document.createElement("div");
  head.className = "card";
  const title = document.createElement("h3");
  title.textContent = `#${data.tag}`;
  const meta = document.createElement("p");
  meta.className = "meta";
  // 件数はサーバーの正確な数（counts）を優先。無い古い応答は読み込んだ数で補う。
  const counts = [
    ["posts", "投稿"], ["threads", "スレッド"], ["articles", "記事"],
    ["videos", "動画"], ["music", "音楽"], ["communities", "コミュニティ"], ["market", "マーケット"], ["games", "ゲーム"],
  ].map(([key, label]) => { const n = Number(data.counts?.[key] ?? data[key]?.length ?? 0); return n > 0 ? `${label} ${n}` : ""; }).filter(Boolean);
  meta.textContent = counts.join(" · ") || "項目はありません";
  // フォローは全種類で1つ（UNIFY.md）。窓は動詞だけ送る。
  const follow = document.createElement("button");
  follow.type = "button";
  follow.className = "head-action";
  let followed = data.following === true;
  const paintFollow = () => { follow.textContent = followed ? "フォロー中" : "タグをフォロー"; follow.setAttribute("aria-pressed", String(followed)); };
  paintFollow();
  follow.onclick = async () => {
    follow.disabled = true;
    try {
      await invoke("hub_client_action", { action: followed ? "unfollow_tag" : "follow_tag", target: data.tag });
      followed = !followed;
    } catch (error) { showNotice(friendlyError(error)); }
    follow.disabled = false;
    paintFollow();
  };
  head.append(title, meta, follow);
  nodes.push(head);
  // 種類ごとの描き方。続きの行も同じ関数で作る。
  const yen = (p) => (p.currency === "JPY" && Number.isFinite(p.priceMinor) ? `¥${Number(p.priceMinor).toLocaleString("ja-JP")}` : "");
  const KIND_VIEWS = [
    ["posts", "投稿", (post) => postCard(post)],
    ["threads", "スレッド", (t) => catalogCard({
      title: t.title,
      meta: [`${t.postCount ?? 0} 投稿`, relTime(t.updatedAt)],
      onOpen: () => void openDetail("thread", [t.id], { title: t.title }),
    })],
    ["articles", "記事", (a) => catalogCard({
      title: a.title,
      body: a.summary,
      imageUrl: a.thumbnailUrl,
      onOpen: a.id ? () => void openDetail("article", [a.id], { title: a.title }) : null,
    })],
    ["videos", "動画", (v) => catalogCard({
      title: v.title,
      body: v.channel,
      imageUrl: v.thumbnailUrl,
      onOpen: () => void openDetail("video", [v.id ?? ""], { local: true, data: v, title: v.title }),
    })],
    ["music", "音楽", (w) => catalogCard({
      title: w.title,
      imageUrl: w.artworkUrl,
      menuWork: w,
      onOpen: () => void playMusicWork(w),
    })],
    ["communities", "コミュニティ", (c) => catalogCard({
      title: c.communityName || c.communitySlug || "コミュニティ",
      body: c.excerpt,
      meta: [c.postKind, c.author, relTime(c.createdAt)].filter(Boolean),
      onOpen: c.communityId ? () => void openDetail("community", [c.communityId], { title: c.communityName || "コミュニティ" }) : null,
    })],
    ["games", "ゲーム", (g) => catalogCard({
      title: g.title,
      body: g.summary,
      onOpen: g.slug ? () => void openStoreGame(g) : null,
    })],
    // サーバーの種類名は market（応答の配列も market）。古い products も読む。
    ["market", "商品", (p) => catalogCard({
      title: p.title,
      body: p.summary,
      imageUrl: p.imageUrl,
      meta: [p.priceLabel || yen(p), p.providerLabel || p.seller].filter(Boolean),
      onOpen: p.id ? () => void openDetail("listing", [p.id], { title: p.title }) : null,
    })],
  ];
  for (const [kind, label, build] of KIND_VIEWS) {
    const items = data[kind] ?? (kind === "market" ? data.products : null);
    if (!items?.length) continue;
    const section = detailSection(label, items.map(build));
    // 続き：サーバーの kind+cursor（keyset）。押したときだけ読み、cursor が尽きたら外す。
    let cursor = data.nextCursors?.[kind] ?? null;
    if (cursor) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "head-action";
      more.textContent = "さらに表示";
      more.onclick = async () => {
        more.disabled = true;
        try {
          const next = await invoke("hub_detail", { name: "tag_page", ids: [data.key || data.tag, kind, cursor] });
          const rows = next?.[kind] ?? (kind === "market" ? next?.products : null) ?? [];
          more.before(...rows.map(build));
          cursor = next?.nextCursors?.[kind] ?? null;
          if (!cursor || !rows.length) more.remove();
        } catch (error) { showNotice(friendlyError(error)); }
        more.disabled = false;
      };
      section.append(more);
    }
    nodes.push(section);
  }
  if (nodes.length === 1) {
    nodes.push(emptyState("search", "項目はありません", "別のタグを試してください。"));
  }
  target.replaceChildren(...nodes);
}

// --- リスト詳細：自分のリストのメンバーとスレッド。編集・削除・
// メンバー出入りはここで完結させる（/api/client/lists/[id]経由） ---
function renderListDetail(target, data, entry) {
  const list = data.list ?? {};
  const nodes = [];
  const head = document.createElement("div");
  head.className = "card";
  const title = document.createElement("h3");
  title.textContent = list.name ?? "リスト";
  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = [
    `${(data.profiles ?? []).length} 人`,
    `${(data.threads ?? []).length} スレッド`,
    list.visibility === "public" ? "公開" : "非公開",
  ].join(" · ");
  head.append(title, meta);
  if (list.description) {
    const description = document.createElement("p");
    description.className = "detail-p";
    description.textContent = list.description;
    head.append(description);
  }
  const actions = document.createElement("div");
  actions.className = "actions";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "head-action";
  edit.textContent = "編集";
  edit.onclick = () => {
    const existing = head.querySelector(".detail-form");
    if (existing) { existing.remove(); return; }
    head.append(listEditForm(entry, list));
  };
  const del = document.createElement("button");
  del.type = "button";
  del.className = "deny";
  del.textContent = "削除";
  del.onclick = async () => {
    if (!del.dataset.armed) {
      del.dataset.armed = "1";
      del.textContent = "もう一度押すと削除";
      return;
    }
    del.disabled = true;
    try {
      await invoke("hub_client_action", { action: "delete_list", target: list.id });
      await detailBack();
    } catch (error) {
      del.disabled = false;
      del.textContent = friendlyError(error);
    }
  };
  actions.append(edit, del);
  head.append(actions);
  nodes.push(head);
  // メンバー/スレッド行に外すボタンを添える。
  const removable = (kind, id, card) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "head-action";
    btn.textContent = "外す";
    btn.onclick = async (event) => {
      event.stopPropagation();
      btn.disabled = true;
      try {
        await invoke("hub_client_action", {
          action: "list_member",
          target: list.id,
          options: { memberKind: kind, memberId: id, memberActive: false },
        });
        await renderDetailEntry(entry);
      } catch (error) {
        btn.disabled = false;
        btn.textContent = friendlyError(error);
      }
    };
    card.append(btn);
    return card;
  };
  nodes.push(detailSection(
    "メンバー",
    (data.profiles ?? []).length
      ? data.profiles.map((p) => removable("profile", p.id, contactCard(p)))
      : [emptyState("contacts", "メンバーはいません")],
  ));
  nodes.push(detailSection(
    "スレッド",
    (data.threads ?? []).length ? data.threads.map((t) => removable("thread", t.id, catalogCard({
      title: t.title,
      meta: [`${t.postCount ?? 0} 投稿`, relTime(t.updatedAt)],
      onOpen: () => void openDetail("thread", [t.id], { title: t.title }),
    }))) : [emptyState("threads", "スレッドはありません")],
  ));
  target.replaceChildren(...nodes);
}

function listEditForm(entry, list) {
  const form = document.createElement("form");
  form.className = "detail-form";
  const name = document.createElement("input");
  name.type = "text";
  name.maxLength = 100;
  name.placeholder = "リスト名";
  name.value = list.name ?? "";
  name.required = true;
  const description = document.createElement("textarea");
  description.rows = 2;
  description.maxLength = 1000;
  description.placeholder = "説明（任意）";
  description.value = list.description ?? "";
  const row = document.createElement("div");
  row.className = "detail-form-row";
  const visibility = document.createElement("select");
  for (const [value, label] of [["private", "非公開"], ["public", "公開"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    visibility.append(option);
  }
  visibility.value = list.visibility === "public" ? "public" : "private";
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "approve";
  submit.textContent = "保存";
  const state = document.createElement("p");
  state.className = "meta";
  row.append(visibility, submit, state);
  form.append(name, description, row);
  form.onsubmit = async (event) => {
    event.preventDefault();
    submit.disabled = true;
    state.textContent = "保存中…";
    try {
      await invoke("hub_client_action", {
        action: "update_list",
        target: list.id,
        options: {
          name: name.value.trim(),
          description: description.value,
          visibility: visibility.value,
        },
      });
      await renderDetailEntry(entry);
      submit.disabled = false;
    } catch (error) {
      state.textContent = friendlyError(error);
      state.classList.add("warning");
      submit.disabled = false;
    }
  };
  return form;
}

// --- プロフィール編集（表示名・bio。handleや外部リンクはWebの設定面） ---
function profileEditForm(entry, profile) {
  const form = document.createElement("form");
  form.className = "detail-form";
  const name = document.createElement("input");
  name.type = "text";
  name.maxLength = 40;
  name.placeholder = "表示名";
  name.value = profile.displayName ?? "";
  name.required = true;
  const bio = document.createElement("textarea");
  bio.rows = 3;
  bio.maxLength = 180;
  bio.placeholder = "自己紹介";
  bio.value = profile.bio ?? "";
  const row = document.createElement("div");
  row.className = "detail-form-row";
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "approve";
  submit.textContent = "保存";
  const state = document.createElement("p");
  state.className = "meta";
  row.append(submit, state);
  form.append(name, bio, row);
  form.onsubmit = async (event) => {
    event.preventDefault();
    submit.disabled = true;
    state.textContent = "保存中…";
    try {
      await invoke("hub_client_action", {
        action: "update_profile",
        text: bio.value,
        options: { displayName: name.value.trim() },
      });
      await renderDetailEntry(entry);
      state.textContent = "保存しました。";
      submit.disabled = false;
    } catch (error) {
      state.textContent = friendlyError(error);
      state.classList.add("warning");
      submit.disabled = false;
    }
  };
  return form;
}

// --- リスト選択。プロフィールやスレッドを自分のリストへ加える ---
async function openListPicker(kind, targetId, host) {
  const existing = host.querySelector(".list-picker");
  if (existing) { existing.remove(); return; }
  const box = document.createElement("div");
  box.className = "card list-picker";
  const title = document.createElement("p");
  title.className = "meta";
  title.textContent = "追加先のリスト";
  box.append(title);
  host.append(box);
  try {
    const data = await invoke("hub_client", { name: "lists" });
    const lists = data?.lists ?? [];
    if (!lists.length) {
      title.textContent = "リストがありません。リスト面で作成できます。";
      return;
    }
    for (const list of lists) {
      const already = (kind === "profile" ? list.profileIds : list.threadIds)?.includes(targetId);
      const item = document.createElement("button");
      item.type = "button";
      item.className = already ? "deny" : "head-action";
      item.textContent = `${already ? "✓ " : ""}${list.name}`;
      item.onclick = async () => {
        item.disabled = true;
        try {
          await invoke("hub_client_action", {
            action: "list_member",
            target: list.id,
            options: { memberKind: kind, memberId: targetId, memberActive: !already },
          });
          item.remove();
          title.textContent = already ? `${list.name} から外しました。` : `${list.name} に追加しました。`;
        } catch (error) {
          item.disabled = false;
          title.textContent = friendlyError(error);
          title.classList.add("warning");
        }
      };
      box.append(item);
    }
  } catch (error) {
    title.textContent = friendlyError(error);
    title.classList.add("warning");
  }
}

let researchAccountGeneration=0;
function researchEditorOptions(entry) {
  const generation=researchAccountGeneration;
  return {
    state:entry.editorState??(entry.editorState={}),friendlyError,confirm:text=>window.confirm(text),getScope:()=>articleEditorScope(),
    isCurrent:()=>generation===researchAccountGeneration&&currentView==='detail'&&detailTrail.at(-1)===entry,
    invoke:async(name,args,invokeOptions)=>{if(generation!==researchAccountGeneration)throw new Error('接続が変わりました。画面を読み直してください。');const result=await invoke(name,args,invokeOptions);if(generation!==researchAccountGeneration)throw new Error('接続が変わりました。画面を読み直してください。');return result;},
    reload:()=>currentView==='detail'&&detailTrail.at(-1)===entry?renderDetailEntry(entry):Promise.resolve(),
    openProject:project=>openDetail('research_project',[project.id],{title:project.title}),
    openSource:url=>invoke('open_external',{url}),
    connectAccount:()=>connectDesktopAccount(),
    openProposal:(projectId,id)=>openDetail('research_proposal',[projectId,id],{title:'変更提案の比較',local:true,editorState:entry.editorState}),
    openThread:thread=>openDetail('thread',[thread.id],{title:thread.title,editorState:entry.editorState}),
    openGitManagement:projectId=>openDetail('research_git_management',[projectId],{title:'Gitリポジトリの設定',local:true,editorState:entry.editorState}),
    openGit:projectId=>{
      const source=detailContent().firstElementChild,revision=detailRenderRevision;
      const current=()=>generation===researchAccountGeneration&&revision===detailRenderRevision&&currentView==='detail'&&detailTrail.at(-1)===entry&&source?.isConnected&&detailContent().firstElementChild===source;
      if(current())return openDetail('research_git_history',[projectId],{title:'Gitの変更履歴',editorState:entry.editorState,isCurrent:current});
    },
    openComparison:(projectId,oid,base)=>openDetail('research_git_compare',[projectId,oid,base],{title:'Gitの二版比較',editorState:entry.editorState}),
    openGitProposals:(projectId,comparison)=>openDetail('research_git_proposals',[projectId],{title:'Gitの変更提案',editorState:{...entry.editorState,gitComparison:comparison??entry.editorState?.gitComparison}}),
    openGitProposal:(projectId,id)=>openDetail('research_git_proposal',[projectId,id],{title:'Git提案のレビュー',editorState:entry.editorState}),
    openCommit:(projectId,oid)=>openDetail('research_git_commit',[projectId,oid],{title:`コードの変更 · ${oid.slice(0,12)}`,editorState:entry.editorState}),
    openGitDiscussion:(projectId,oid)=>openDetail('research_git_discussion',[projectId,oid],{title:'コードの変更について議論する',local:true,editorState:entry.editorState}),
    openRevision:(projectId,id,version,title)=>openDetail('research_revision',[projectId,id,String(version)],{title,editorState:entry.editorState}),
    openDiscussion:(projectId,id,version,title)=>openDetail('research_discussion',[projectId,id,String(version)],{title,editorState:entry.editorState}),
    shareContent:offerPublicContentShare,
  };
}
function invalidateDetailContext(reload=true) {sidebarContext.replaceChildren();releaseResearchDetail(true);releaseCommunityDetail(true);researchAccountGeneration++;syncCommunityInvite(true);detailRenderRevision++;for(const entry of new Set([...detailTrail,...detailForwardTrail,...toolbarTrail.flatMap(t=>[...(t.detailTrail??[]),...(t.detailForwardTrail??[])])])){entry.editorState=undefined;entry.replyDraft=undefined;entry.postDraft=undefined;entry.videoCommentDraft=undefined;entry.knowledge=undefined;entry.guideDraft=undefined;entry.membershipReviewDraft=undefined;entry.memberState=undefined;entry.channelPolicyState=undefined;entry.accessManagementState=undefined;entry.joinState=undefined;entry.governanceState=undefined;entry.reportDraft=undefined;entry.channelColumn=undefined;entry.chooseChannel=undefined;entry.reportPage=undefined;entry.appealReviewDraft=undefined;entry.appealSubmitDraft=undefined;entry.appealPage=undefined;entry.data=undefined;}if(reload&&currentView==='detail'&&(['thread','community'].includes(detailTrail.at(-1)?.name)||['research_','community_governance','community_guide','community_member','community_report','community_appeal'].some(prefix=>detailTrail.at(-1)?.name.startsWith(prefix))||['article','video','saved_articles','video_library','music_library','video_playlists','music_playlists'].includes(detailTrail.at(-1)?.name)))void renderDetailEntry(detailTrail.at(-1));}
window.addEventListener('hub-account-changed',()=>invalidateDetailContext());
window.addEventListener('hub-origin-changed',()=>{
  const previous=detailTrail.at(-1);
  invalidateDetailContext(false);
  detailTrail=[];detailForwardTrail=[];
  detailReturn={view:'feed',title:'タイムライン'};
  toolbarTrail.splice(0,toolbarTrail.length,{...detailReturn});toolbarTrailIndex=0;
  if(currentView==='detail'){
    detailState().textContent='接続するHubが変わりました。';
    detailTitle().textContent='一覧から選び直す';
    const preview=document.querySelector('#detail-open-right');preview.hidden=true;preview.onclick=null;
    const message=document.createElement('p');message.textContent='一覧から対象を選び直してください。';
    const destination=DETAIL_PARENT_VIEW[previous?.name]??'feed';
    detailContent().replaceChildren(message,actionButton('一覧を開く','ghost',()=>{
      const item=document.querySelector(`.icon-nav-item[data-view="${destination}"], #primary-nav [data-view="${destination}"]`)??document.querySelector('.icon-nav-item[data-view="feed"]');
      if(item)return navigateFrom(item);
    }));
  }
  updateToolbarNavigation();
});
function communityGovernanceOptions(entry){
  const base=researchEditorOptions(entry),revision=detailRenderRevision,generation=researchAccountGeneration;
  const isCurrent=()=>revision===detailRenderRevision&&generation===researchAccountGeneration&&currentView==='detail'&&detailTrail.at(-1)===entry;
  return{...base,state:entry.governanceState??={},isCurrent,prepared:entry.data,
    onChanged:()=>isCurrent()?renderDetailEntry(entry):Promise.resolve(),
    onOpen:(name,ids,title)=>isCurrent()?openDetail(name,ids,{title,governanceState:entry.governanceState}):Promise.resolve(),
    openWeb:async path=>{if(!isCurrent())return;try{const origin=new URL(await base.invoke('hub_origin')),url=new URL(path,origin);if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||url.origin!==origin.origin||url.pathname!=='/v2/community'||!isCurrent())return;await base.invoke('open_external',{url:url.href});}catch(error){if(isCurrent())showNotice(friendlyError(error));}},
  };
}
const gitReader=(target,data,entry)=>{target.replaceChildren();const options=researchEditorOptions(entry),controller=researchGitBrowser(target,{projectId:entry.ids[0],oid:entry.ids[1],base:entry.name==='research_git_compare'?entry.ids[2]:undefined},{...options,prepared:data,signedIn:desktopAccount.state==='registered',onComparison:comparison=>{options.state.gitComparison=comparison;},openDiscussion:options.openGitDiscussion,openWeb:path=>void invoke('hub_origin').then(origin=>invoke('open_external',{url:origin+path})).catch(error=>showNotice(friendlyError(error)))});controller.root.dataset.researchSection='コードの変更';if(desktopAccount.state==='registered')controller.root.append(actionButton('Gitの変更提案を見る','ghost',()=>options.openGitProposals(entry.ids[0])));if(desktopAccount.state!=='registered')controller.root.append(actionButton('議論するためDesktopを接続','ghost',options.connectAccount));return controller;};
function contentLibraryDetail(target,data,entry) {
  target.replaceChildren();const revision=detailRenderRevision,generation=researchAccountGeneration;
  return renderContentLibrary({document,host:target,embedded:true,kind:entry.name==='saved_articles'?'article':'video',invoke:researchEditorOptions(entry).invoke,renderCover:entry.name==='saved_articles'?undefined:mediaItemCover('video'),
    isCurrent:()=>revision===detailRenderRevision&&generation===researchAccountGeneration&&currentView==='detail'&&detailTrail.at(-1)===entry,
    onOpen:item=>entry.name==='saved_articles'?openDetail('article',[item.id],{title:item.title}):openDetail('video',[item.id],{title:item.title,local:true,data:item})});
}
function appendPlaylistEntry(host,kind,item) {
  const button=document.createElement('button');button.type='button';button.className='head-action';button.textContent='プレイリストに追加';
  button.onclick=()=>void openDetail(`${kind}_playlists`,[item.id],{title:'プレイリストに追加',local:true,data:{selectedItem:item}});
  host.append(button);
}
const mediaItemCover=kind=>entry=>kind==='video'?createVideoThumbnail(document,entry,{hubAsset}):createMusicArtwork(document,entry,{hubAsset,className:'mw-art mw-art-row'});
function mediaPlaylistDetail(target,data,entry) {
  const options=researchEditorOptions(entry),revision=detailRenderRevision,generation=researchAccountGeneration;
  const current=()=>revision===detailRenderRevision&&generation===researchAccountGeneration&&options.isCurrent();
  const kind=entry.name==='video_playlists'?'video':'music';
  target.replaceChildren();
  const resolver=(entry.editorState.itemResolvers??={})[kind]??=createItemResolver({invoke:options.invoke,kind});
  const controller=createMediaPlaylists({document,kind,invoke:options.invoke,isCurrent:current,resolveItem:id=>resolver.resolve(id),renderCover:mediaItemCover(kind),
    getScope:options.getScope,state:(entry.editorState??={}).mediaPlaylists??={},
    getAccount:()=>desktopAccount.state==='registered'?String(researchAccountGeneration):null,
    selectedItem:entry.ids.length?{id:entry.ids[0],title:data?.selectedItem?.title??(kind==='video'?'選択中の動画':'選択中の作品')}:undefined,
    onPlay:kind==='music'?(selection,scope)=>{
      if(!current()||!scope.isCurrent())return false;
      const queue=selection.workIds.map((workId,index)=>{const known=resolver.peek(workId);return {...(known?{artist:known.artist,album:known.album,artworkUrl:known.artworkUrl}:{}),id:workId.slice(6),title:known?.title??('楽曲 '+(index+1)),playlistStub:true};});
      const track=queue.find(track=>track.id===selection.startId.slice(6));
      return playMusicTrack(track,queue,{isCurrent:()=>current()&&scope.isCurrent()});
    }:undefined,
    onOpen:item=>{if(!current())return;if(kind==='video')void openDetail('video',[item.id],{title:item.title??'動画'});else void openMusicWorkById(item.id,item);}});
  target.append(controller.element);
  return {dispose:controller.destroy,invalidate:()=>{controller.invalidate();controller.destroy();}};
}
const DETAIL_RENDERERS = {
  video_playlists:mediaPlaylistDetail,music_playlists:mediaPlaylistDetail,music_playlist:renderMusicPlaylistDetail,music_artists:renderMusicArtistsDetail,
  music_library:(target,data,entry)=>{
    const options=researchEditorOptions(entry);target.replaceChildren();
    return renderMusicLibrary({document,host:target,embedded:true,invoke:options.invoke,isCurrent:options.isCurrent,renderCover:mediaItemCover('music'),
      onOpen:work=>playMusicWork(work),
      onPlay:(work,queue)=>{
        const start=queue.findIndex(item=>item.id===work.id);
        return playMusicTrack({...work,id:work.id.slice(6)},queue.slice(start>=200?start:0,(start>=200?start:0)+200).map(item=>({...item,id:item.id.slice(6)})));
      },
      onQueue:work=>enqueueMusicTrack({...work,id:work.id.slice(6)},'next')});
  },
  saved_articles:contentLibraryDetail,article_drafts:renderArticleDrafts,video_library:contentLibraryDetail,
  research_git_management:(target,data,entry)=>{target.replaceChildren();const revision=detailRenderRevision,generation=researchAccountGeneration;return researchGitManagement(target,{projectId:entry.ids[0]},{...researchEditorOptions(entry),isCurrent:()=>revision===detailRenderRevision&&generation===researchAccountGeneration&&currentView==='detail'&&detailTrail.at(-1)===entry});},
  community_governance_mutation_context:(target,data,entry)=>{target.replaceChildren();const c=communityGovernanceMutations(target,{communityId:entry.ids[0],proposalId:entry.ids[1]},communityGovernanceOptions(entry));target.append(c.root);return c;},
  community_governance_create_context:(target,data,entry)=>{target.replaceChildren();const c=communityGovernanceCreate(target,{communityId:entry.ids[0]},communityGovernanceOptions(entry));target.append(c.root);return c;},
  community_governance:(target,data,entry)=>{target.replaceChildren();const c=communityGovernanceCatalog(target,{communityId:entry.ids[0]},communityGovernanceOptions(entry));target.append(c.root);return c;},
  community_governance_proposal:(target,data,entry)=>{target.replaceChildren();const c=communityGovernanceProposal(target,{communityId:entry.ids[0],proposalId:entry.ids[1]},communityGovernanceOptions(entry));target.append(c.root);return c;},
  community_governance_settings:(target,data,entry)=>{target.replaceChildren();const c=communityGovernanceSettings(target,{communityId:entry.ids[0]},communityGovernanceOptions(entry));target.append(c.root);return c;},
  research_proposal:(target,data,entry)=>{target.replaceChildren();const controller=researchProposalReview(target,{projectId:entry.ids[0],proposalId:entry.ids[1]},{...researchEditorOptions(entry),prepared:data});controller.root.dataset.researchSection='変更提案の比較';return controller;},
  research_git_history:gitReader, research_git_commit:gitReader, research_git_compare:gitReader,
  research_git_proposals:(target,data,entry)=>{target.replaceChildren();const options=researchEditorOptions(entry);return researchGitProposals(target,{projectId:entry.ids[0]},{...options,prepared:data,openWeb:path=>options.invoke('hub_origin').then(origin=>options.invoke('open_external',{url:origin+path})).catch(error=>showNotice(friendlyError(error)))});},
  research_git_proposal:(target,data,entry)=>{target.replaceChildren();const options=researchEditorOptions(entry);return researchGitProposals(target,{projectId:entry.ids[0],proposalId:entry.ids[1]},{...options,prepared:data,openWeb:path=>options.invoke('hub_origin').then(origin=>options.invoke('open_external',{url:origin+path})).catch(error=>showNotice(friendlyError(error)))});},
  research_git_discussion:(target,data,entry)=>{target.replaceChildren();const controller=researchGitDiscussion(target,{projectId:entry.ids[0],oid:entry.ids[1]},{...researchEditorOptions(entry),prepared:data,openThread:thread=>openDetail('thread',[thread.id],{title:thread.title})});controller.root.dataset.researchSection='変更の検証';return controller;},
  research_network_fork:(target,data,entry)=>{target.replaceChildren();return researchFork(target,{project:{id:entry.ids[1]},signedIn:desktopAccount.state==='registered'},{...researchEditorOptions(entry),sourceOrigin:entry.ids[0]});},
  research_project: (target, data, entry) => renderResearchProject(target, data, (projectId, item) => openDetail('research_document', [projectId, item.id], {title:item.title}), (path) => void openHubPath(path), async (path) => {
    try { await invoke('open_external', {url:`${await invoke('hub_origin')}${path}`}); }
    catch(error) { showNotice(friendlyError(error)); }
  }, {...researchEditorOptions(entry),
    uploadPdf:({projectId,title,seriesId})=>researchEditorOptions(entry).invoke('research_pdf_upload',{projectId,titleText:title,seriesId}),
    downloadPdf:({projectId,pdfId})=>researchEditorOptions(entry).invoke('research_pdf_download',{projectId,pdfId})}),
  research_discussion: (target,data,entry) => researchDiscussion(target,{projectId:entry.ids[0],documentId:entry.ids[1],version:Number(entry.ids[2])},{...researchEditorOptions(entry),prepared:data,openThread:thread=>openDetail('thread',[thread.id],{title:thread.title})}),
  research_revision: (target,data,entry) => renderResearchDocument(target,data,null,researchEditorOptions(entry)),
  research_document: (target, data, entry) => renderResearchDocument(target, data, async (path) => {
    try { await invoke('open_external', {url:`${await invoke('hub_origin')}${path}`}); }
    catch (error) {showNotice(friendlyError(error));}
  }, researchEditorOptions(entry)),
  post: renderPostDetailAny,
  thread: renderThreadDetail,
  article: renderArticleDetail,
  hubpedia_article: renderHubpediaDetail,
  book: renderBookDetail,
  book_chapter: renderBookChapter,
  community: renderCommunityDetail,
  community_membership_requests:(target,data,entry)=>target.replaceChildren(communityMembershipRequests(document,{communityId:entry.ids[0],data,state:entry.membershipReviewPage??={},invoke:researchEditorOptions(entry).invoke,onOpen:(name,ids,title)=>void openDetail(name,ids,{title})})),
  community_membership_request:(target,data,entry)=>target.replaceChildren(communityMembershipReview(document,{communityId:entry.ids[0],profileId:entry.ids[1],data,state:entry.membershipReviewDraft??={},invoke:researchEditorOptions(entry).invoke,onReload:()=>renderDetailEntry(entry)})),
  community_reports:(target,data,entry)=>target.replaceChildren(communityReports(document,{communityId:entry.ids[0],data,state:entry.reportPage??={},invoke:researchEditorOptions(entry).invoke,onOpen:(name,ids,title)=>void openDetail(name,ids,{title})})),
  community_report:renderCommunityReport,
  community_appeals:(target,data,entry)=>target.replaceChildren(communityAppeals(document,{communityId:entry.ids[0],data,state:entry.appealPage??={},invoke:researchEditorOptions(entry).invoke,onOpen:(name,ids,title)=>void openDetail(name,ids,{title})})),
  community_appeal:renderCommunityAppeal,
  community_appeal_history:renderCommunityAppeal,
  community_members: renderCommunityMembers,
  community_guides: renderCommunityGuides, community_guide: renderCommunityGuide,
  community_guide_revisions: renderCommunityGuides, community_guide_revision: renderCommunityGuide,
  community_guide_proposals:renderCommunityGuides, community_guide_proposal:(target,data,entry)=>target.replaceChildren(communityGuideProposal(document,{data,communityId:entry.ids[0],proposalId:entry.ids[1],invoke:researchEditorOptions(entry).invoke,state:entry.guideDraft??={},onOpen:(name,ids,title)=>void openDetail(name,ids,{title})})),
  ranking_item: renderRankingDetail,
  service_item: renderServiceDetail,
  listing: renderListingDetail,
  commerce_product: renderCommerceProductDetail,
  video: renderVideoDetail,
  music_artist: renderMusicCollectionDetail, music_album: renderMusicCollectionDetail,
  profile: renderProfileDetail,
  tag: renderTagDetail,
  list: renderListDetail,
};

function focusSearchInput() {
  const toolbarInput = document.querySelector("#toolbar-search-input");
  const input = toolbarInput.getClientRects().length ? toolbarInput : document.querySelector("#search-query");
  input.focus();
  input.select();
}

async function navigateFrom(item, history = {}, progress = {}) {
    const alive = () => progress.alive?.() !== false;
    const shown = () => progress.onShown?.();
    if (!alive()) return;
    const view = item.dataset.view;
    if (view === "games") { openMarketGames(); return; }
    if(view==="feed"&&(history.replay||history.detailReplay)){const scene=history.detailReplay?detailReturn.socialScene:toolbarTrail[toolbarTrailIndex]?.socialScene;if(scene){socialMode=scene.mode;socialFilter=scene.filter;socialScope=scene.scope;feedScope=scene.feedScope;feedListId=scene.feedListId??null;socialWantedScene=scene;}}
    if (view === currentView && view !== "browser" && !history.replay && !history.detailReplay
        && (view !== "threads" || (item.dataset.boardKey || "") === threadBoardKey)) {
      if (appsOpen) showView(view, document.querySelector("#toolbar-current").textContent);
      const scroller = viewScroller();
      if (scroller) scroller.scrollTop = 0;
      if (view === "search") focusSearchInput();
      shown();
      return;
    }
    if (!history.replay && !history.detailReplay) detailForwardTrail = [];
    if (currentView === "detail" && !history.detailReplay) saveDetailTrail();
    if (view === "browser") { await enterBrowser(undefined, history); return; }
    // コードはゲームと同じく、Hub のコード一覧（/v2/code）をアプリのブラウザ面で開く。Hub の場所が分からないときだけ説明の画面へ。
    if (view === "code" && !history.replay && !history.detailReplay) {
      const origin = hubOrigin ?? await invoke("hub_origin").catch(() => null);
      if (!alive()) return;
      if (origin) { await enterBrowser(new URL("/v2/code", origin).href); shown(); return; }
    }
    await exitBrowser();
    if (!alive()) return;
    if (view === "threads") {
      const previousBoard = threadBoardKey;
      threadBoardKey = item.dataset.boardKey || "";
      threadBoardTitle = threadBoardKey ? item.dataset.boardTitle || "掲示板" : "";
      document.querySelector("#threads-board-clear").hidden = !threadBoardKey;
      document.querySelector("#threads-query").placeholder = threadBoardKey ? "この板のスレッドを検索" : "スレッドを検索";
      const query = document.querySelector("#threads-query");
      if (item.dataset.query !== undefined) query.value = item.dataset.query;
      else if (threadBoardKey !== previousBoard) query.value = "";
    }
    // 通常面へ出るときは詳細の履歴を捨てる——一覧に帰ってから
    // 「戻る」で古い詳細が出ると迷子になる。
    detailTrail = [];
    const labelText = [...item.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join("").trim();
    const title = view === "threads" && threadBoardKey
      ? `${threadBoardTitle}のスレッド`
      : item.dataset.title ?? item.getAttribute?.("aria-label") ?? (labelText || "Hub");
    for (const control of document.querySelectorAll(".nav-item.on, .mobile-nav-item.on")) control.classList.remove("on");
    for (const control of document.querySelectorAll(`.nav-item[data-view="${view}"], .mobile-nav-item[data-view="${view}"]`)) control.classList.add("on");
    if (view === "notifications") {
      showView(view, title, history);
      shown();
      await loadNotifications();
    } else if (view === "messages") {
      showView(view, title, history);
      shown();
      await loadMessages();
    } else if (view === "mail") {
      showView(view, title, history);
      shown();
      await loadMail();
    } else if (view === "profile") {
      showView(view, title, history);
      shown();
      await loadProfile();
    } else {
      const restoredVideo=view==='videos'&&(history.replay||history.detailReplay)?await restoreVideoScene(toolbarTrail[toolbarTrailIndex]):false;
      if(restoredVideo===null||!alive())return;
      showView(view, title, history);
      shown();
      if(restoredVideo)paintRestoredVideoScene();
      if (view === "feed") await loadFeed();
      if (view === "home") await loadHomeSummary();
      if (view === "ai") { void loadAiStatus(); void subscriptionUsageController?.refresh(); }
      if (view === "node") await loadNode();
      if (view === "compute") await loadCompute();
      if (view === "research") await researchWorkspace.load();
      if (view === "market" && !history.detailReplay) marketBrowse?.show();
      if (view === "purchased") renderOrders();
      if (view === "music") {
        void loadMusicTracks();
        if (musicTab === "catalog") { await loadCatalog(view); musicCatalogLoaded = true; }
      }
      if (CATALOGS[view] && view !== "music" && !restoredVideo) await loadCatalog(view);
    }
    if (!alive()) return;
    if (view === "search") {
      focusSearchInput();
    }
}

for (const item of document.querySelectorAll(".nav-item, .mobile-nav-item")) {
  item.onclick = () => navigateFrom(item);
}
document.querySelector("#code-open-web").onclick = () => void invoke("hub_origin").then((origin) => enterBrowser(new URL("/v2/code", origin).href)).catch((error) => showNotice(friendlyError(error)));
document.querySelector("#threads-board-clear").onclick = () => void navigateFrom({ dataset: { view: "threads", title: "スレッド" }, childNodes: [] });
const desktopShell = document.querySelector(".app-shell");
/*
 * ブラウザのアドレス欄は一番上の行に置く（帯を1段減らす。2026-10-11 ユーザー指定）。
 * 要素は #view-browser の中のまま（見た目の規則がそこに付いている）で、位置だけを
 * 上の行の空き（戻る・進む・再読込の右から、右端のボタンの左まで）へ合わせる。
 */
function placeBrowserStrip() {
  const strip = document.querySelector("#view-browser .browser-strip");
  const header = document.querySelector(".app-toolbar");
  if (!strip || !header) return;
  /*
   * 一番上の欄（Hubの検索とブラウザのアドレス欄）は中央の列の真上、最大980px（2026-10-18 所有者:
   * 「検索バーを左に寄せて、右側の戻るとかが一番上に来る方がいい」）。
   * 右列がブラウザを出しているときは、右列の操作列（戻る・進む・再読込・ホーム・アドレス・中央で開く）を
   * 上の行の右列の真上へ上げる。右列のページはそのぶん上から始まる（#rail-browser-stage の実測が Rust へ渡る）。
   */
  {
    const root = document.documentElement;
    const bar = header.getBoundingClientRect(), nav = header.querySelector(".toolbar-navigation")?.getBoundingClientRect();
    const ends = [...header.querySelectorAll("#toolbar-rail")].map((node) => node.getBoundingClientRect()).filter((rect) => rect.width > 0);
    const endLeft = ends.length ? Math.min(...ends.map((rect) => rect.left)) : bar.right - 150;
    const shell = document.querySelector(".app-shell");
    // 中央がブラウザのときは、上の行の左側を中央のブラウザの操作が使い、右列の操作列は右列の真上の自分の区画へ上げる
    // （どちらの状態でも右列の戻る・進む・歯車・中身が同じ位置になる。中央の操作は下の strip で右列の手前までに収める）。
    const centreBrowser = Boolean(shell?.classList.contains("browser-active"));
    // 右列の戻る・進む・更新などは右列自身の見出し行に置く（2026-11-02 所有者）。上の行へは上げない。
    const railOpen = Boolean(shell?.classList.contains("rail-open"));
    const railNode = !railOpen ? null : shell.classList.contains("rail-browser-view") ? document.querySelector(".rail-view--browser:not([hidden])") : document.querySelector(".rail .rail-body:not([hidden])");
    const railBox = railNode?.getBoundingClientRect();
    for (const name of ["railBar", "railBarFit"]) if (root.dataset[name]) delete root.dataset[name];
    for (const name of ["--rail-bar-left", "--rail-bar-width", "--rail-bar-top", "--rail-bar-height"]) root.style.removeProperty(name);
    const minLeft = Math.round((nav?.right ?? bar.left + 150) + 48);
    let width, left;
    if (centreBrowser) {
      width = Math.max(280, Math.min(980, window.innerWidth - 2 * 340));
      left = Math.max(minLeft, Math.round((window.innerWidth - width) / 2));
    } else {
      // 検索欄は左に寄せ、サイドバーの切替ボタンの直後から右列の操作の手前（16px あけて）まで伸ばす（2026-10-18 所有者）。
      // 右列を閉じているときは窓ボタンの手前までだが、広い画面で長くなりすぎないよう 900px で止める。
      const railLeft = railBox && railBox.width > 0 ? railBox.left : null;
      const maxRight = Math.round((railLeft ?? endLeft) - 16);
      left = Math.round((nav?.right ?? bar.left + 150) + 12);
      width = Math.max(200, railLeft === null ? Math.min(900, maxRight - left) : maxRight - left);
    }
    root.style.setProperty("--omni-left", left + "px"); root.style.setProperty("--omni-width", width + "px"); root.style.setProperty("--omni-top", Math.round(bar.top + (bar.height - 34) / 2) + "px");
  }
  if (!document.querySelector(".app-shell")?.classList.contains("browser-active")) {
    for (const name of ["--browser-strip-top", "--browser-strip-height", "--browser-strip-left", "--browser-strip-right"]) strip.style.removeProperty(name);
    return;
  }
  const bar = header.getBoundingClientRect();
  const start = header.querySelector(".toolbar-navigation")?.getBoundingClientRect();
  const ends = [...header.querySelectorAll("#toolbar-rail")].map((node) => node.getBoundingClientRect()).filter((rect) => rect.width > 0);
  let right = ends.length ? Math.min(...ends.map((rect) => rect.left)) : bar.right - 150;
  strip.style.setProperty("--browser-strip-top", `${Math.round(bar.top)}px`);
  strip.style.setProperty("--browser-strip-height", `${Math.round(bar.height)}px`);
  strip.style.setProperty("--browser-strip-left", `${Math.round((start?.right ?? bar.left + 160) + 8)}px`);
  // 右端の手前に約120pxの空きを残す（窓をつかんで動かす場所）。
  strip.style.setProperty("--browser-strip-right", `${Math.round(window.innerWidth - right + 120)}px`);
}
window.addEventListener("resize", placeBrowserStrip);
// 画面の切り替え（.app-shell の class）でも置き直す。
if (desktopShell && typeof MutationObserver === "function") new MutationObserver(placeBrowserStrip).observe(desktopShell, { attributes: true, attributeFilter: ["class"] });
placeBrowserStrip();
const columnKeys = { sidebar: "hub.desktop.sidebarWidth.compact", rail: "hub.desktop.railWidth" };
const columnLimits = { sidebar: [190, 260], rail: [240, 480] };
const columnCollapseDistance = 40;
const nativeColumnBridge = !startupTool && typeof window.__TAURI__?.core?.invoke === "function" && typeof window.__TAURI__?.event?.listen === "function";
const nativeColumnReady = { sidebar: false, rail: false }, columnPointerStyle = {}, columnDomDrag = {};
let nativeColumnDrag = null, nativeColumnSession = 0, nativeColumnFrame = null, nativeColumnSyncBusy = false, nativeColumnDirty = false, nativeColumnLastColors = null, nativeColumnCanSync = false;
const savedColumnWidth = (key) => {
  try {
    const value = Number(localStorage.getItem(columnKeys[key]));
    return Number.isFinite(value) && value >= columnLimits[key][0] && value <= columnLimits[key][1] ? value : null;
  } catch { return null; }
};
const preferredColumnWidth = { sidebar: savedColumnWidth("sidebar"), rail: savedColumnWidth("rail") };
const clampColumn = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

function applyColumnWidths() {
  if (startupTool) return;
  const viewport = window.innerWidth;
  const wide = viewport >= 1180;
  const sidebarVisible = viewport >= 861 && !desktopShell.classList.contains("sidebar-collapsed");
  const browser = desktopShell.classList.contains("browser-active");
  const railOpen = desktopShell.classList.contains("rail-open");
  const splitList = desktopShell.classList.contains("messages-active") || desktopShell.classList.contains("mail-active");
  const mainMin = splitList ? 480 : wide ? 600 : 480;
  // 左の記号の帯は 56、メニューで広げると 208（desktop-shell.css の --rail-w）。
  const navWidth = desktopShell.classList.contains("rail-expanded") ? 208 : 56;
  // 内側の列の既定幅：メッセージとメールは 380（一覧 380 + 詳細 600）、そのほかは従来どおり。
  const sidebarDefault = splitList ? 380 : wide ? clampColumn(viewport * .135, 210, 250) : clampColumn(viewport * .22, 200, 235);
  const sidebarDesired = preferredColumnWidth.sidebar ?? sidebarDefault;
  // 右列ブラウザはスマホ幅（帯の48pxを足して420。中身は約360px）から始める。保存した幅があればそれを使う。
  // 2026-10-18 所有者「あと右側」：1600px 以上の窓では右列を 380 に広げ、通知・会話の行を 1 行で読めるようにする（Web の右列 372 に近づける）。
  const railDesired = preferredColumnWidth.rail ?? (desktopShell.classList.contains("rail-browser-view") ? 420 : viewport >= 1600 ? 380 : wide ? 300 : 360);
  const railInGrid = viewport >= 861 && railOpen;
  const railMax = Math.max(240, Math.min(480,
    railInGrid ? viewport - navWidth - mainMin - (sidebarVisible ? sidebarDesired : 0) : viewport - 80));
  const railWidth = clampColumn(railDesired, 240, railMax);
  const sidebarMax = Math.max(columnLimits.sidebar[0], Math.min(splitList ? 420 : columnLimits.sidebar[1],
    viewport - navWidth - mainMin - (railInGrid ? railWidth : browser || railOpen ? 0 : 48)));
  const sidebarWidth = clampColumn(sidebarDesired, columnLimits.sidebar[0], sidebarMax);
  desktopShell.style.setProperty("--desktop-sidebar-width", `${sidebarWidth}px`);
  desktopShell.style.setProperty("--desktop-rail-width", `${railWidth}px`);
  for (const [name, width] of [["sidebar", sidebarWidth], ["rail", railWidth]]) {
    const handle = document.querySelector(name === "sidebar" ? "#sidebar-resizer" : "#rail-resizer");
    handle.setAttribute("aria-valuemin", String(columnLimits[name][0]));
    handle.setAttribute("aria-valuemax", String(name === "sidebar" ? sidebarMax : railMax));
    handle.setAttribute("aria-valuenow", String(Math.round(width)));
    handle.setAttribute("aria-valuetext", `${Math.round(width)}ピクセル`);
  }
  scheduleNativeColumnSync();
}

function closeResizedColumn(name) {
  if (name === "sidebar") {
    sidebarCollapsedForRail = false;
    appsOpen = false;
    desktopShell.classList.add("sidebar-collapsed");
    renderSidebarContext(currentView);
    syncToolbarSidebar();
    document.querySelector("#toolbar-sidebar").focus();
  } else {
    saveRailChoice(false);
    setDesktopRailOpen(false);
    document.querySelector(window.innerWidth >= 861 ? "#rail-activity-toggle" : "#toolbar-rail").focus();
  }
}

function beginColumnResize(name, startX) {
  const handle = document.querySelector(name === "sidebar" ? "#sidebar-resizer" : "#rail-resizer");
  const initial = preferredColumnWidth[name], startWidth = Number(handle.getAttribute("aria-valuenow"));
  let done = false;
  handle.classList.add("dragging"); document.body.classList.add("column-resizing");
  const finish = (cancelled = false, collapse = false) => {
    if (done) return; done = true;
    handle.classList.remove("dragging"); document.body.classList.remove("column-resizing");
    preferredColumnWidth[name] = cancelled || collapse ? initial : Number(handle.getAttribute("aria-valuenow"));
    applyColumnWidths();
    try {
      if (preferredColumnWidth[name] === null) localStorage.removeItem(columnKeys[name]);
      else localStorage.setItem(columnKeys[name], String(preferredColumnWidth[name]));
    } catch { /* Storage may be unavailable in a tool window. */ }
    if (collapse) closeResizedColumn(name);
  };
  return { finish, move(x) {
    if (done) return false;
    const width = startWidth + (x - startX) * (name === "sidebar" ? 1 : -1);
    if (!Number.isFinite(width)) return true;
    if (width < columnLimits[name][0] - columnCollapseDistance) { finish(false, true); return false; }
    preferredColumnWidth[name] = Math.max(columnLimits[name][0], width); applyColumnWidths(); return true;
  } };
}
function resetColumnWidth(name) {
  if (nativeColumnDrag?.side === name) cancelNativeColumnDrag();
  preferredColumnWidth[name] = null;
  try { localStorage.removeItem(columnKeys[name]); } catch {}
  applyColumnWidths();
}
for (const [name, id] of [["sidebar", "#sidebar-resizer"], ["rail", "#rail-resizer"]]) {
  const handle = document.querySelector(id); columnPointerStyle[name] = handle.style.pointerEvents;
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || nativeColumnReady[name]) return;
    event.preventDefault(); columnDomDrag[name]?.(); handle.setPointerCapture(event.pointerId);
    const drag = beginColumnResize(name, event.clientX);
    const release = () => {
      columnDomDrag[name] = null;
      handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish); handle.removeEventListener("lostpointercapture", finish);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    };
    columnDomDrag[name] = () => { release(); drag.finish(true); };
    const move = (next) => { if (next.pointerId === event.pointerId && !drag.move(next.clientX)) release(); };
    const finish = (next) => {
      if (next.pointerId !== event.pointerId) return;
      release(); drag.finish(next.type === "pointercancel" || next.type === "lostpointercapture");
    };
    handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish); handle.addEventListener("lostpointercapture", finish);
  });
  handle.addEventListener("dblclick", () => {
    resetColumnWidth(name);
  });
  handle.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 40 : 16;
    const direction = name === "sidebar" ? 1 : -1;
    const delta = event.key === "ArrowRight" ? step * direction : event.key === "ArrowLeft" ? -step * direction : null;
    if (delta === null && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    if (nativeColumnDrag?.side === name) cancelNativeColumnDrag();
    const width = event.key === "Home" ? columnLimits[name][0] : event.key === "End" ? columnLimits[name][1] : Number(handle.getAttribute("aria-valuenow")) + delta;
    if (width < columnLimits[name][0]) { closeResizedColumn(name); return; }
    preferredColumnWidth[name] = width;
    applyColumnWidths();
    try { localStorage.setItem(columnKeys[name], handle.getAttribute("aria-valuenow")); } catch {}
  });
}
function nativeColumnRect(name) {
  if (startupTool || desktopShell.classList.contains("browser-active") || document.visibilityState !== "visible" || document.querySelector("dialog[open]")) return null;
  const handle = document.querySelector(name === "sidebar" ? "#sidebar-resizer" : "#rail-resizer"), style = window.getComputedStyle(handle);
  if (document.activeElement === handle || !handle.isConnected || handle.closest("[hidden]") || style.display === "none" || style.visibility === "hidden") return null;
  const rect = handle.getBoundingClientRect();
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.x < 0 || rect.y < 0 || rect.x > 32767 || rect.y > 32767 || rect.width < 1 || rect.height < 1 || rect.width > 24 || rect.height > 32767) return null;
  return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
}
function nativeColumnColors() {
  const style = window.getComputedStyle(desktopShell);
  const rgba = (token) => {
    const value = style.getPropertyValue(token).trim();
    if (/^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(value)) { const hex = value.length === 4 ? [...value.slice(1)].map(x => x + x).join("") : value.slice(1); return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)).concat(1); }
    const match = value.match(/^rgba?\(([^)]+)\)$/i); if (!match) return null;
    const channels = match[1].trim().split(/[\s,\/]+/).map(Number); if (channels.length === 3) channels.push(1);
    return channels.length === 4 && channels.every(Number.isFinite) && channels.slice(0, 3).every(x => x >= 0 && x <= 255) && channels[3] >= 0 && channels[3] <= 1 ? channels : null;
  };
  const background = rgba("--panel"), divider = rgba("--line-strong"), active = rgba("--action");
  if (!background || background[3] !== 1 || !divider || !active) return null;
  const blend = color => color.slice(0, 3).map((x, i) => Math.round(x * color[3] + background[i] * (1 - color[3])));
  return { background: background.slice(0, 3).map(Math.round), divider: blend(divider), active: blend(active) };
}
function cancelNativeColumnDrag() {
  const request = nativeColumnDrag; nativeColumnDrag = null; request?.drag.finish(true);
}
function setNativeColumnReady(payload) {
  if (!nativeColumnBridge || !nativeColumnCanSync || !payload || typeof payload !== "object" || Array.isArray(payload) || Reflect.ownKeys(payload).length !== 2 || !["sidebar", "rail"].every(name => Object.hasOwn(payload, name) && typeof payload[name] === "boolean")) return;
  for (const name of ["sidebar", "rail"]) {
    if (payload[name]) columnDomDrag[name]?.();
    nativeColumnReady[name] = payload[name];
    document.querySelector(name === "sidebar" ? "#sidebar-resizer" : "#rail-resizer").style.pointerEvents = payload[name] ? "none" : columnPointerStyle[name];
  }
  if (nativeColumnDrag && !nativeColumnReady[nativeColumnDrag.side]) cancelNativeColumnDrag();
}
function nativeColumnResize(payload) {
  if (!nativeColumnBridge || !nativeColumnCanSync || !payload || typeof payload !== "object" || Array.isArray(payload) || Reflect.ownKeys(payload).length !== 4 || !["side", "phase", "session", "x"].every(key => Object.hasOwn(payload, key)) || !["sidebar", "rail"].includes(payload.side) || !["start", "move", "end", "cancel", "reset"].includes(payload.phase) || !Number.isSafeInteger(payload.session) || payload.session <= 0 || !Number.isFinite(payload.x) || Math.abs(payload.x) > 32767) return;
  if (!nativeColumnReady[payload.side] || !nativeColumnRect(payload.side)) { if (nativeColumnDrag?.side === payload.side) cancelNativeColumnDrag(); return; }
  if (payload.phase === "start" || payload.phase === "reset") {
    if (payload.session <= nativeColumnSession) return;
    nativeColumnSession = payload.session; cancelNativeColumnDrag();
    if (payload.phase === "reset") { resetColumnWidth(payload.side); return; }
    if (document.body.classList.contains("column-resizing")) return;
    nativeColumnDrag = { side: payload.side, session: payload.session, drag: beginColumnResize(payload.side, payload.x) }; return;
  }
  const request = nativeColumnDrag;
  if (!request || request.side !== payload.side || request.session !== payload.session) return;
  if (payload.phase === "move") { if (!request.drag.move(payload.x)) nativeColumnDrag = null; }
  else { nativeColumnDrag = null; request.drag.finish(payload.phase === "cancel"); }
}
let nativeColumnLastSent = null;
// The native side may have lost its copy (window shown again, DPI or size change): send the next sync even if unchanged.
function resendNativeColumns() { nativeColumnLastSent = null; scheduleNativeColumnSync(); }
function scheduleNativeColumnSync() {
  if (!nativeColumnBridge) return;
  nativeColumnDirty = true;
  if (!nativeColumnCanSync || nativeColumnSyncBusy || nativeColumnFrame !== null) return;
  nativeColumnFrame = window.requestAnimationFrame(() => { nativeColumnFrame = null; void syncNativeColumns(); });
}
async function syncNativeColumns() {
  if (nativeColumnSyncBusy || !nativeColumnDirty) return;
  nativeColumnDirty = false; nativeColumnSyncBusy = true;
  try {
    let sidebar = nativeColumnRect("sidebar"), rail = nativeColumnRect("rail"), colors = nativeColumnColors();
    if (nativeColumnDrag && !(nativeColumnDrag.side === "sidebar" ? sidebar : rail)) cancelNativeColumnDrag();
    if (colors) nativeColumnLastColors = colors;
    else { setNativeColumnReady({ sidebar: false, rail: false }); sidebar = rail = null; colors = nativeColumnLastColors; }
    // Any class change on the page schedules a sync; send only when the geometry or colors changed.
    const sent = colors ? JSON.stringify([sidebar, rail, colors]) : null;
    if (colors && sent !== nativeColumnLastSent) { await invoke("native_shell_resize_sync", { sidebar, rail, colors }); nativeColumnLastSent = sent; }
  } catch { nativeColumnLastSent = null; setNativeColumnReady({ sidebar: false, rail: false }); }
  finally { nativeColumnSyncBusy = false; if (nativeColumnDirty) scheduleNativeColumnSync(); }
}
if (nativeColumnBridge) {
  try {
    Promise.all([
      window.__TAURI__.event.listen("native-shell-resize-ready", event => { setNativeColumnReady(event.payload); nativeColumnLastSent = null; }),
      window.__TAURI__.event.listen("native-shell-resize", event => nativeColumnResize(event.payload)),
    ]).then(() => { nativeColumnCanSync = true; scheduleNativeColumnSync(); }).catch(() => {});
  } catch { /* DOM resizing remains available if Native listeners cannot register. */ }
  const observer = new ResizeObserver(scheduleNativeColumnSync);
  for (const selector of ["#sidebar-resizer", "#rail-resizer", ".sidebar", ".rail"]) { const node = document.querySelector(selector); if (node) observer.observe(node); }
  new MutationObserver(scheduleNativeColumnSync).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class", "open", "hidden"] });
  document.addEventListener("visibilitychange", resendNativeColumns);
  window.addEventListener("resize", resendNativeColumns);
  const syncColumnFocus = event => { if (event.target === document.querySelector("#sidebar-resizer") || event.target === document.querySelector("#rail-resizer")) scheduleNativeColumnSync(); };
  document.addEventListener("focusin", syncColumnFocus); document.addEventListener("focusout", syncColumnFocus);
}
applyColumnWidths();
window.addEventListener("resize", applyColumnWidths);
new MutationObserver(applyColumnWidths).observe(desktopShell, { attributes: true, attributeFilter: ["class"] });
async function travelToolbar(direction) {
  if (currentView === "detail") {
    if (direction < 0) { await detailBack(); return; }
    if (detailForwardTrail.length) { await detailForward(); return; }
  }
  if (currentView === "videos" && (direction < 0 && videoWatchIndex >= 0 || direction > 0 && videoWatchIndex + 1 < videoWatchHistory.length)) {
    rememberVideoScroll();
    videoWatchIndex += direction;
    if (videoWatchIndex < 0) {
      document.querySelector("#video-watch").hidden = true;
      document.querySelector("#video-discover").hidden = false;
      if(viewScroller())viewScroller().scrollTop=videoListScroll;
      renderSidebarContext("videos");
      updateToolbarNavigation();
    } else openVideoWatch(videoWatchHistory[videoWatchIndex], true);
    return;
  }
  if (direction > 0 && detailForwardTrail.length && currentView === detailReturn.view) {
    await detailForward();
    return;
  }
  const next = toolbarTrailIndex + direction;
  if (next < 0 || next >= toolbarTrail.length) return;
  const entry = toolbarTrail[next];
  if (entry.view === "detail" && !entry.detailTrail?.length) return;
  const source = entry.view === "threads" ? { dataset: entry, childNodes: [] }
    : document.querySelector(`.icon-rail [data-view="${entry.view}"], #primary-nav [data-view="${entry.view}"], .account-nav [data-view="${entry.view}"]`)
    || { dataset: entry, childNodes: [], getAttribute: () => null };
  if(currentView==="feed")captureSocialScene();
  toolbarTrailIndex = next;
  try {
    if (entry.view === "detail") {
      detailTrail = entry.detailTrail.slice();
      detailForwardTrail = entry.detailForwardTrail.slice();
      detailReturn = { ...entry.detailReturn };
      const selected = detailTrail.at(-1);
      showView("detail", selected.title, { replay: true });
      await renderDetailEntry(selected);
      if (currentView === "detail" && viewScroller()) viewScroller().scrollTop = selected.scrollTop ?? 0;
    } else await navigateFrom(source, { replay: true });
  }
  finally { updateToolbarNavigation(); }
}
// 列の幅を変えたとき（右列・左列のつまみ）も、検索欄と右列の操作列を置き直す。
if (typeof ResizeObserver === "function") { const columnsObserver = new ResizeObserver(() => placeBrowserStrip()); for (const node of document.querySelectorAll(".app-shell .rail, .app-shell .workspace-main")) columnsObserver.observe(node); }
document.querySelector("#toolbar-back").onclick = () => void travelToolbar(-1);
document.querySelector("#toolbar-forward").onclick = () => void travelToolbar(1);
const quickSwitcher = document.querySelector("#quick-switcher");
const quickQuery = document.querySelector("#quick-switcher-query");
const quickResults = document.querySelector("#quick-switcher-results");
const quickDestinations = [
  ["タイムライン", "feed"], ["通知", "notifications"], ["メッセージ", "messages"], ["AI", "ai"],
  ["マーケット", "market"], ["ブラウザ", "browser"], ["ウォレット", "wallet"], ["プロフィール", "profile"],
  // 「すべて」から外した行き先も、クイック切替えからは今までどおり開ける。
  ["コミュニティ", "community"], ["スレッド", "threads"], ["メール", "mail"], ["連絡先", "contacts"], ["動画", "videos"], ["音楽", "music"], ["記事", "articles"],
  ["ライブラリ", "purchased"], ["検索", "search"], ["ブックマーク", "bookmarks"], ["リスト", "lists"], ["設定", "settings"],
  ...APP_GROUPS.flatMap(([, links]) => links),
].filter((item, index, items) => items.findIndex(([, view]) => view === item[1]) === index);
let quickItems = [];
let quickActive = 0;

function selectQuickItem(index) {
  quickActive = (index + quickItems.length) % quickItems.length;
  for (const [position, option] of [...quickResults.children].entries()) {
    const selected = position === quickActive;
    option.classList.toggle("on", selected);
    option.setAttribute("aria-selected", String(selected));
    if (selected) option.scrollIntoView({ block: "nearest" });
  }
  quickQuery.setAttribute("aria-activedescendant", `quick-switcher-option-${quickActive}`);
}

async function openQuickItem(index) {
  const item = quickItems[index];
  if (!item) return;
  const term = quickQuery.value.trim();
  quickSwitcher.close();
  if (item.view === "apps") {
    appsOpen = true;
    desktopShell.classList.remove("sidebar-collapsed");
    renderSidebarContext(currentView);
    markRailCurrent(currentView);
    sidebarContext.querySelector(".sidebar-app-search")?.focus();
    return;
  }
  const source = document.querySelector(`.icon-rail [data-view="${item.view}"], #primary-nav [data-view="${item.view}"], .account-nav [data-view="${item.view}"]`);
  if (!source) return;
  await navigateFrom(source);
  if (item.view === "search") {
    const input = document.querySelector("#search-query");
    input.value = term;
    const toolbarInput = document.querySelector("#toolbar-search-input");
    toolbarInput.value = term;
    (toolbarInput.getClientRects().length ? toolbarInput : input).focus();
    if (term) document.querySelector("#hub-search").requestSubmit();
  }
}

function quickItemsFor(term) {
  const matches = quickDestinations.filter(([label]) => matchesSearch(term, label));
  const destinations = term ? matches : matches.filter(([, view]) => ["feed", "ai", "market", "browser", "wallet"].includes(view));
  const items = destinations.map(([label, view]) => ({ label, view }));
  const search = { label: term ? `「${term}」をHubで検索` : "Hub内を検索", view: "search" };
  if (term && items.length) items.push(search);
  else items.unshift(search);
  if (!term) items.push({ label: "すべての機能", view: "apps" });
  return items;
}

function renderQuickSwitcher() {
  quickItems = quickItemsFor(quickQuery.value.trim());
  quickResults.replaceChildren(...quickItems.map((item, index) => {
    const option = document.createElement("button");
    option.type = "button";
    option.id = `quick-switcher-option-${index}`;
    option.className = "quick-switcher-option";
    option.setAttribute("role", "option");
    option.tabIndex = -1;
    option.textContent = item.label;
    option.onclick = () => void openQuickItem(index);
    return option;
  }));
  selectQuickItem(0);
}

function openQuickSwitcher() {
  if (startupTool || document.querySelector("dialog[open]")) return;
  quickQuery.value = "";
  renderQuickSwitcher();
  quickSwitcher.showModal();
  quickQuery.focus();
}

document.querySelector("#toolbar-search").onclick = () => void navigateFrom(document.querySelector('#primary-nav [data-view="search"]'));
document.querySelector("#toolbar-search-input").oninput = (event) => {
  if (currentView === "search") {
    document.querySelector("#search-query").value = event.currentTarget.value;
    document.querySelector("#search-web-state").textContent = "";
  }
};
document.querySelector("#search-query").oninput = (event) => {
  document.querySelector("#toolbar-search-input").value = event.currentTarget.value;
  document.querySelector("#search-web-state").textContent = "";
};
// 一番上の検索はHubの検索とWebのアドレス欄を兼ねる（2026-10-12）。アドレスならブラウザで開き、言葉ならHub内を探す。
// Web検索の送信先は設定の「Web検索」（hub.desktop.webSearchEngine、既定 DuckDuckGo）。web-search.mjs が正本。
const browserSearchEngine = () => { try { return getWebSearchEngine(window.localStorage); } catch { return getWebSearchEngine(null); } };
const openWebSearch = (query) => { const url = webSearchUrl(browserSearchEngine(), query); if (url) void enterBrowser(url); return Boolean(url); };
// 入力中の候補用のHub検索。確定と同じ読み取り（hub_resource search）を1回だけ、語数と長さを検索と同じ上限で。
const omniboxHubSearch = async (typed) => {
  const query = String(typed ?? "").normalize("NFKC").trim().toLocaleLowerCase("ja");
  if (!query || query.length > 100 || query.split(/\s+/u).length > 8 || /[\u0000-\u001f\u007f-\u009f]/u.test(query.replace(/\s/gu, ""))) return null;
  return invoke("hub_resource", { resource: "search", query, cursor: null, offset: 0, searchFilters: { ...normalizeHubSearchFilters() }, order: "recommended" });
};
// 1番上の欄は今いる項目を覚えて、その種類の結果から見せる（2026-11-04 所有者）。種類の札「すべて」で Hub 全体に戻る。
const SEARCH_SCOPE_BY_VIEW = { feed: "posts", articles: "articles", videos: "videos", music: "tracks", market: "listings", community: "communities",
  threads: "threads", hubpedia: "hubpedia", games: "games", books: "books", research: "projects", lists: "lists" };
async function runHubSearch(term) {
  const value = String(term ?? "").trim();
  if (!value) return;
  // 全体検索へ回せない画面内の絞り込みは、上の欄の語をそのまま渡す（外部作品の検索、板の中のスレッド検索）。
  const local = currentView === "music" && !document.querySelector("#music-catalog").hidden ? ["#music-catalog-query", "#music-catalog-search"]
    : currentView === "music" && !document.querySelector("#music-home").hidden && document.querySelector(".mh-search") ? [".mh-search input", ".mh-search"]
    : currentView === "threads" && threadBoardKey ? ["#threads-query", "#threads-search"] : null;
  if (local) { document.querySelector(local[0]).value = value; document.querySelector(local[1]).requestSubmit(); return; }
  if (currentView !== "search") searchGroupFilter = SEARCH_SCOPE_BY_VIEW[currentView] ?? "all";
  await navigateFrom(document.querySelector('#primary-nav [data-view="search"]'));
  document.querySelector("#search-query").value = value;
  document.querySelector("#toolbar-search-input").value = value;
  document.querySelector("#hub-search").requestSubmit();
}
document.querySelector("#toolbar-search-form").onsubmit = async (event) => {
  event.preventDefault();
  if (toolbarSearchBinding.composing()) return;
  toolbarSearchBinding.cancel();
  const term = document.querySelector("#toolbar-search-input").value.trim();
  if (!term) return;
  const address = omniboxAddress(term, browserSearchEngine());
  if (address) { toolbarOmnibox?.hide(); await enterBrowser(address); return; }
  await runHubSearch(term);
  document.querySelector("#toolbar-search-input").focus();
};
const toolbarOmnibox = !startupTool && window.__TAURI__?.core?.invoke ? createOmnibox({
  document, window,
  form: document.querySelector("#toolbar-search-form"), input: document.querySelector("#toolbar-search-input"),
  getEngine: browserSearchEngine,
  searchHub: omniboxHubSearch,
  loadPages: async () => { const [saved, visited] = await Promise.all([invoke("browser_favorites").catch(() => []), invoke("browser_history").catch(() => [])]); return [...(Array.isArray(saved) ? saved : []), ...(Array.isArray(visited) ? visited : [])]; },
  onHubSearch: (term) => runHubSearch(term),
  onOpen: (url) => enterBrowser(url),
  onOpenResult: (group, record) => {
    const title = textValue(record, ["title", "name", "displayName", "display_name", "slug", "id"]);
    const open = record && typeof record === "object" ? (searchResultOpener(group, record, title) ?? searchResultOpener("coreEntities", record, title)) : null;
    if (!open) return false;
    void Promise.resolve(open()).catch(() => {});
    return true;
  },
}) : null;
const mainWindow = !startupTool ? window.__TAURI__?.window?.getCurrentWindow?.() : null;
if (mainWindow) {
  void mainWindow.isDecorated().then((decorated) => {
    if (decorated) return;
    document.querySelector(".window-strip").hidden = false;
    document.querySelector("#window-minimize").onclick = () => void mainWindow.minimize();
    const maximize = document.querySelector("#window-maximize");
    const updateMaximize = async () => {
      const label = await mainWindow.isMaximized() ? "元に戻す" : "最大化";
      maximize.setAttribute("aria-label", label);
      maximize.title = label;
    };
    maximize.onclick = async () => { await mainWindow.toggleMaximize(); await updateMaximize(); };
    document.querySelector("#window-close").onclick = () => void mainWindow.close();
    // 窓の移動: 題名の場所に加えて、上の行とブラウザのアドレス行の何も無い所からもつかめる。
    const dragWindow = (event) => {
      if (event.button === 0) void (event.detail === 2 ? mainWindow.toggleMaximize() : mainWindow.startDragging());
    };
    document.querySelector(".toolbar-location").onpointerdown = dragWindow;
    const emptyArea = (event) => event.target === event.currentTarget || event.target.matches?.(".toolbar-navigation, #browser-navigation, .browser-strip");
    document.querySelector(".app-toolbar")?.addEventListener("pointerdown", (event) => { if (emptyArea(event)) dragWindow(event); });
    document.querySelector(".window-strip")?.addEventListener("pointerdown", (event) => { if (event.target === event.currentTarget) dragWindow(event); });
    window.requestAnimationFrame?.(() => placeBrowserStrip());
    document.querySelector("#view-browser .browser-strip")?.addEventListener("pointerdown", (event) => { if (emptyArea(event)) dragWindow(event); });
    // 上の行へ上げた右列の操作列も、ボタンとアドレス欄の外はつかめる（上げていないときは右列の中なので動かさない）。
    document.querySelector(".rail-activity-head")?.addEventListener("pointerdown", (event) => { if (document.documentElement.dataset.railBar === "top" && (event.target === event.currentTarget || event.target.matches?.(".rail-history-nav, .rail-activity-heading, .rail-view-name, .rail-activity-actions"))) dragWindow(event); });
    document.querySelector(".rail-view--browser .rb-bar")?.addEventListener("pointerdown", (event) => { if (document.documentElement.dataset.railBar === "top" && (event.target === event.currentTarget || event.target.matches?.(".rb-row"))) dragWindow(event); });
    void updateMaximize();
    void mainWindow.onResized(updateMaximize);
  });
}
quickQuery.addEventListener("input", renderQuickSwitcher);
quickQuery.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    selectQuickItem(quickActive + (event.key === "ArrowDown" ? 1 : -1));
  } else if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    void openQuickItem(quickActive);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() !== "k" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey ||
      (event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable]") && event.target.id !== "toolbar-search-input")) return;
  event.preventDefault();
  openQuickSwitcher();
});
// キーボードの近道（shortcuts.mjs）と右クリックのメニュー（context-menu.mjs）。Hub の画面だけが対象。
if (!startupTool) {
  installShortcuts({ document, getView: () => currentView });
  let hubHosts = new Set(["localhost:3020", "127.0.0.1:3020", "hub.jkamma.com"]);
  void invoke("hub_origin").then((origin) => { hubHosts = new Set([...hubHosts, new URL(origin).host]); }).catch(() => {});
  window.hubContextMenu = installContextMenu({
    document,
    isHubUrl: (url) => hubHosts.has(url.host),
    openTab: (url) => void enterBrowser(url),
    openExternal: (url) => void invoke("open_external", { url }).catch(() => {}),
  });
}
// Windows 11 の Mica（Rust 側が対応と「透明効果」の設定を確かめる）。成功したときだけ data-material を付ける。
if (!startupTool) createMaterialSync({ root: document.documentElement, invoke });
const comparisonDialog = document.querySelector("#ai-comparison");
let comparisonPanel = null;
document.querySelector("#ai-comparison-close").onclick = () => comparisonDialog.close();
comparisonDialog.addEventListener("close", () => {
  comparisonPanel?.destroy(); comparisonPanel = null;
  document.querySelector("#ai-comparison-body").replaceChildren();
});
document.querySelector("#toolbar-ai-compare").onclick = () => {
  const controller = legacyPiWorkController;
  if (startupTool || currentView !== "ai" || !controller
      || desktopShell.classList.contains("browser-active") || comparisonDialog.open) return;
  document.querySelector("#ai-more")?.close?.();
  const current = () => comparisonDialog.open && controller === legacyPiWorkController && currentView === "ai"
    && !desktopShell.classList.contains("browser-active");
  comparisonPanel = createHarnessComparison({document, invoke, isMain: () => !startupTool, isCurrent: current,
    onStarted: async run => {
      if (!current()) return;
      await controller.load();
      if (!current()) return;
      if (!controller.state.runs.some(item => item.id === run.id)) throw Error("comparison_history_unavailable");
      controller.select(run.id);
      comparisonDialog.close();
    }});
  document.querySelector("#ai-comparison-body").replaceChildren(comparisonPanel.element);
  comparisonDialog.showModal();
};
const toolbarSidebar = document.querySelector("#toolbar-sidebar");
const syncToolbarSidebar = () => {
  // 中身の無い画面では開けない（空の列を出さない）。
  toolbarSidebar.disabled = sidebarEmptyView && !appsOpen;
  toolbarSidebar.title = toolbarSidebar.disabled ? "この画面には左の列がありません" : "サイドバーを切り替える";
  const expanded = !desktopShell.classList.contains("sidebar-collapsed");
  toolbarSidebar.setAttribute("aria-expanded", String(expanded));
  toolbarSidebar.setAttribute("aria-label", expanded ? "サイドバーを閉じる" : "サイドバーを開く");
};
toolbarSidebar.onclick = () => {
  // ブラウザでは、左上のこのボタンがタブの列を細く・広くする（Braveと同じ）。列の中のピンは出さない。
  const tabsPin = document.querySelector("#browser-tabs-pin");
  if (currentView === "browser" && tabsPin && !tabsPin.hidden && !desktopShell.classList.contains("sidebar-collapsed")) { tabsPin.click(); return; }
  const wasExpanded = !desktopShell.classList.contains("sidebar-collapsed");
  if (matchMedia("(max-width: 1179px)").matches) {
    saveRailChoice(false);
    setDesktopRailOpen(false);
  }
  if (appsOpen) appsOpen = false;
  desktopShell.classList.toggle("sidebar-collapsed", wasExpanded);
  sidebarCollapsedForRail = false;
  sidebarCollapsedForEmpty = false;
  renderSidebarContext(currentView);
};
new MutationObserver(syncToolbarSidebar).observe(desktopShell, { attributes: true, attributeFilter: ["class"] });
// 列を畳む・開く操作は描き直しを通らないことがあるので、会話の一覧の置き場所は class の変化でも合わせる。
new MutationObserver(placeMessagesSide).observe(desktopShell, { attributes: true, attributeFilter: ["class"] });
syncToolbarSidebar();
updateToolbarNavigation();
function setDesktopRailOpen(open) {
  if (open && !rightRailAvailable(currentView)) return;
  syncSidebarForRail(open);
  if (open && matchMedia("(max-width: 1179px)").matches) desktopShell?.classList.add("sidebar-collapsed");
  desktopShell?.classList.toggle("rail-open", open);
  const railBody = document.querySelector(".rail-body");
  if (railBody) railBody.hidden = !open;
  const activityToggle = document.querySelector("#rail-activity-toggle");
  activityToggle?.setAttribute("aria-expanded", String(open));
  activityToggle?.setAttribute("aria-label", open ? "右列を閉じる" : "右列を開く");
  if (activityToggle) activityToggle.title = open ? "右列を閉じる" : "右列を開く";
  activityToggle?.classList.toggle("on", open);
  for (const button of document.querySelectorAll(".desktop-rail-toggle")) {
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", open ? "情報パネルを閉じる" : "情報パネルを開く");
  }
  if (railActivityReady) syncRailView();
}
for (const button of document.querySelectorAll(".desktop-rail-toggle")) {
  button.addEventListener("click", () => {
    const open = !desktopShell?.classList.contains("rail-open");
    saveRailChoice(open);
    setDesktopRailOpen(open);
  });
}
const wideRail = matchMedia("(min-width: 721px)");
const compactLayout = matchMedia("(max-width: 860px)");
let sidebarBeforeCompact = compactLayout.matches ? true : null;
setDesktopRailOpen(rightRailAvailable(currentView) && !compactLayout.matches && railChoiceFor(currentView));
window.addEventListener("resize", () => syncSidebarForRail(desktopShell.classList.contains("rail-open")));
wideRail.addEventListener("change", () => {
  if (!wideRail.matches) setDesktopRailOpen(false);
});
compactLayout.addEventListener("change", () => {
  if (compactLayout.matches) {
    sidebarBeforeCompact = !desktopShell.classList.contains("sidebar-collapsed");
    desktopShell.classList.add("sidebar-collapsed");
    setDesktopRailOpen(false);
  } else {
    if (sidebarBeforeCompact) desktopShell.classList.remove("sidebar-collapsed");
    sidebarBeforeCompact = null;
    setDesktopRailOpen(rightRailAvailable(currentView) && railChoiceFor(currentView));
  }
  renderSidebarContext(currentView);
});
renderSidebarContext(currentView);
if (compactLayout.matches) desktopShell?.classList.add("sidebar-collapsed");
function toggleAppDirectory() {
  appsOpen = !appsOpen;
  if (appsOpen && matchMedia("(max-width: 1179px)").matches) {
    saveRailChoice(false);
    setDesktopRailOpen(false);
  }
  desktopShell?.classList.toggle("sidebar-collapsed", !appsOpen && matchMedia("(max-width: 860px)").matches);
  renderSidebarContext(currentView);
  markRailCurrent(currentView);
  if (appsOpen) sidebarContext.querySelector(".sidebar-app-search")?.focus();
}
for (const button of document.querySelectorAll("#desktop-apps, #toolbar-apps")) button.addEventListener("click", toggleAppDirectory);
// --- 統一した投稿（docs/hub-unified-post/DESIGN.md 5・6）：作成画面・一覧の行・詳細面 ---
const unifiedAuthorOpen = (handle) => {
  const detail = detailForHubPath(`/v2/profile/${encodeURIComponent(handle)}`);
  if (detail) void openDetail(detail.name, detail.ids, { title: detail.title });
};
const unifiedReplyPlace = (post) => (post.places ?? []).find((place) => place !== "timeline") ?? "timeline";
function unifiedRowDeps() {
  return {
    icon, hubAsset, relTime, paintAvatar, licenceLabel: (id) => LICENCE_LABELS[id] ?? id,
    onOpen: (post) => void openDetail("post", [post.id], { title: post.title || "投稿" }),
    onAuthor: unifiedAuthorOpen,
    onReply: (post) => openPostComposer({ place: unifiedReplyPlace(post), label: "返信", icon: "reply" }, { replyToPostId: post.id }),
    onRepost: (post) => {
      invoke("hub_client_action", { action: "create_post_v2", requestId: crypto.randomUUID(), options: { place: "timeline", body: "", repostOfPostId: post.id } })
        .then(() => showNotice("リポストしました"), (error) => showNotice(friendlyError(error)));
    },
    onShare: async (post) => {
      try { const origin = hubOrigin ?? await invoke("hub_origin"); await navigator.clipboard.writeText(`${origin}/v2/post/${post.id}`); showNotice("リンクをコピーしました"); }
      catch (error) { showNotice(friendlyError(error)); }
    },
    onReact: (post, { action, on }) => invoke("hub_client_action", { action: "react_post", target: post.id, options: { action, on } }),
    onReport: (post) => { const host = document.querySelector(`[data-post-id="${CSS.escape(post.id)}"] .post-content`) ?? document.querySelector(".ud"); host?.append(reportForm("unified_post", post.id)); },
    attachTranslate: (host, body, post) => attachTranslateAction({ doc: document, host, body, translator: localTranslator,
      item: { id: post.id, revision: post.editedAt ?? "", type: "social_post", isPublic: false, sourceLang: post.language || null },
      getText: () => post.body ?? "", restore: () => { body.textContent = firstLines(post.body); } }),
    menu: (post) => {
      const own = Boolean(selfProfileHandle && post.author?.handle === selfProfileHandle);
      if (own) return [["削除", (row) => {
        if (!confirm("この投稿を削除しますか？")) return;
        invoke("hub_client_action", { action: "delete_post_v2", target: post.id }).then(() => row.remove(), (error) => showNotice(friendlyError(error)));
      }]];
      return [["報告", (row) => { const host = row.querySelector(".post-content"); if (host && !host.querySelector(".report-form")) host.append(reportForm("unified_post", post.id)); }]];
    },
  };
}
function unifiedPostRow(post) { return createUnifiedRow(document, post, unifiedRowDeps()); }

function currentComposePlace() {
  if (currentView === "detail") {
    const entry = detailTrail.at(-1);
    if (entry?.name === "thread" && /^[A-Za-z0-9_-]{1,128}$/.test(entry.ids?.[0] ?? "")) return { place: `thread:${entry.ids[0]}`, label: entry.title || "スレッド", icon: "bubble" };
  }
  return { place: "timeline", label: "タイムライン", icon: "bubble" };
}
function unifiedAvatar() {
  const node = document.createElement("span");
  node.className = "post-avatar";
  if (composerProfile) paintComposerAvatarNode(node, composerProfile); else node.innerHTML = PERSON_AVATAR_SVG;
  return node;
}
// タイムラインの先頭には投稿欄を置かない（2026-11-11 所有者：左の「投稿する」と重なる）。書くのは左のボタンから開く面。
function syncFeedInlineComposer() {
  feedInlineComposer?.root.remove();
  feedInlineComposer = null;
}
function unifiedComposerFor(spec) {
  return createUnifiedComposer(document, {
    icon, invoke, place: spec.place, placeLabel: spec.label, placeIcon: spec.icon,
    replyToPostId: spec.replyToPostId, quoteOfPostId: spec.quoteOfPostId, placeholder: spec.replyToPostId ? "返信" : spec.placeholder, placeChoices: spec.placeChoices,
    variant: spec.variant, avatar: unifiedAvatar,
    prepareImage: processComposerImage,
    uploadImage: async (item) => {
      const [image, thumbnail] = await Promise.all([item.blob.arrayBuffer(), item.thumbnailBlob.arrayBuffer()]);
      const result = await invoke("hub_upload_image", { image: Array.from(new Uint8Array(image)), thumbnail: Array.from(new Uint8Array(thumbnail)), width: item.width,
        height: item.height, thumbnailWidth: item.thumbnailWidth, thumbnailHeight: item.thumbnailHeight, altText: "" });
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      if (!result?.image?.id) throw new Error("画像を登録できませんでした");
      return result.image.id;
    },
    describeError: friendlyError, onPosted: spec.onPosted,
  });
}
let postComposeDialog = null, postComposeKey = "", postComposeInstance = null;
function afterUnifiedPost(post, target) {
  if (!post) return;
  if (post.status === "held") showNotice("審査中");
  if (currentView === "feed" && target.place === "timeline" && post.status === "published") feed.list.prepend(postCard(post));
  else if (currentView === "detail" && detailTrail.at(-1)) void renderDetailEntry(detailTrail.at(-1));
}
// 作成画面は1つ。置き場は開いた場所で決まり、選ばせない。未接続のときだけ従来の入口（接続の案内つき）を開く。
function openPostComposer(target = currentComposePlace(), extra = {}) {
  if (desktopAccount.state !== "registered") { openComposeDialog(); return; }
  // 開いているコミュニティには流れの下に書き込み欄がある。そこへ寄せて焦点を当てる。
  if (currentView === "detail" && !extra.replyToPostId && !extra.quoteOfPostId && target.place === "timeline") {
    const held = detailTrail.at(-1)?.name === "community" ? detailTrail.at(-1).communityUnified : null;
    if (held?.composer.root.isConnected) {
      held.composer.root.scrollIntoView?.({ block: "nearest" });
      held.composer.focus();
      return;
    }
  }
  let dialog = postComposeDialog;
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "post-compose-dialog";
    dialog.setAttribute("aria-label", "投稿する");
    const head = document.createElement("div");
    head.className = "uc-dialog-head";
    const close = document.createElement("button");
    close.type = "button"; close.className = "uc-tool"; close.innerHTML = icon("x"); close.title = "閉じる"; close.setAttribute("aria-label", "閉じる");
    close.onclick = () => dialog.close();
    head.append(close);
    dialog.append(head);
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
    document.body.append(dialog);
    postComposeDialog = dialog;
  }
  const key = JSON.stringify([target.place, extra.replyToPostId ?? "", extra.quoteOfPostId ?? ""]);
  if (key !== postComposeKey || !postComposeInstance) {
    postComposeInstance?.root.remove();
    postComposeInstance = unifiedComposerFor({ ...target, ...extra, onPosted: (post) => { dialog.close(); afterUnifiedPost(post, target); } });
    postComposeKey = key;
    dialog.append(postComposeInstance.root);
  }
  if (!dialog.open) dialog.showModal();
  postComposeInstance.focus();
}
window.addEventListener("hub-account-changed", () => { postComposeInstance?.root.remove(); postComposeInstance = null; postComposeKey = ""; feedInlineComposer?.root.remove(); feedInlineComposer = null; syncFeedInlineComposer(); });

// 統一した投稿の詳細面。旧表の投稿は従来の詳細のまま。
function renderPostDetailAny(target, data, entry) {
  if (!unwrapUnifiedPost(data)) return renderPostDetail(target, data, entry);
  const revision = detailRenderRevision;
  const connected = desktopAccount.state === "registered";
  const current = () => revision === detailRenderRevision && currentView === "detail";
  const refresh = () => { if (current() && detailTrail.at(-1)) void renderDetailEntry(detailTrail.at(-1)); };
  renderUnifiedPostDetail(document, target, data, {
    ...unifiedRowDeps(), isCurrent: current,
    // 畳んだ枝は描き直しても残す。コミュニティから開いた投稿は、返信を開いても同じコミュニティの中にいる。
    collapsedReplies: entry.collapsedReplies ??= new Set(),
    onOpen: (post) => void openDetail("post", [post.id], { title: post.title || "投稿", communityId: entry.communityId }),
    loadReplies: (post) => invoke("hub_detail", { name: "post_replies", ids: [post.id] }),
    loadRevisions: (post) => invoke("hub_detail", { name: "post_revisions", ids: [post.id] }),
    composer: connected ? (post) => unifiedComposerFor({ place: unifiedReplyPlace(post), label: "返信", icon: "reply", replyToPostId: post.id, placeholder: "返信", variant: "inline", onPosted: refresh }).root : null,
    postUrl: (post) => (hubOrigin ? `${hubOrigin}/v2/post/${post.id}` : ""),
    copyText: (text) => navigator.clipboard.writeText(text),
    openExternal: (url) => invoke("open_external", { url }).catch((error) => showNotice(friendlyError(error))),
    renderBody: (body) => articleBodyNodes(body),
    readingLabel: (body) => articleReadingLabel(articleReadingMinutes(body)),
    onPlayAudio: (id) => { void Promise.resolve(playMusicTrack({ id, title: "", artist: "" }, [])).catch((error) => showNotice(friendlyError(error))); },
    onAdsAllowed: (allowed) => { document.body.dataset.adsAllowed = String(allowed); },
  });
}

// 投稿の入口はここだけ。フィードには入力欄を置かず、既存の投稿欄（#composer）を
// このダイアログの中で開く（Hub投稿／自分のノードの切替・公開内容の確認・画像・予約を含む）。
function openComposeDialog() {
  const dialog = document.querySelector("#compose-dialog");
  if (!dialog) return;
  if (!dialog.open) dialog.showModal();
  document.querySelector("#composer")?.classList.add("open");
  const text = document.querySelector("#composer-text");
  if (text && !text.disabled) text.focus();
  else document.querySelector('#desktop-account-callout [data-account="login"]')?.focus();
}
// 接続済みなら統一した作成画面。従来の入口（下）は未接続の案内と AI からの下書きの受け皿として残す。
document.querySelector("#desktop-compose")?.addEventListener("click", (event) => { if (desktopAccount.state !== "registered") return; event.stopImmediatePropagation(); openPostComposer(); }, true);
document.querySelector("#desktop-compose")?.addEventListener("click", openComposeDialog);
function closeLayoutOverlays() {
  saveRailChoice(false);
  setDesktopRailOpen(false);
  if (matchMedia("(max-width: 1040px)").matches) desktopShell?.classList.add("sidebar-collapsed");
  if (appsOpen) { appsOpen = false; renderSidebarContext(currentView); markRailCurrent(currentView); }
}
document.querySelector("#layout-backdrop")?.addEventListener("click", closeLayoutOverlays);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !event.defaultPrevented && !document.querySelector("dialog[open]") &&
      !(event.target instanceof Element && event.target.closest("dialog")) &&
      (desktopShell?.classList.contains("rail-open") ||
      (matchMedia("(min-width: 721px) and (max-width: 1040px)").matches && !desktopShell?.classList.contains("sidebar-collapsed")))) closeLayoutOverlays();
});

// 旧ナビは画面遷移の入口として残し、見える内側左列は画面別の内容にする。
for (const item of document.querySelectorAll(".open-view")) {
  item.onclick = () => {
    const label = item.querySelector("strong")?.textContent ?? item.textContent.trim();
    navigateFrom({ dataset: { view: item.dataset.openView, resource: item.dataset.resource, title: item.dataset.title ?? label }, childNodes: [] });
  };
}

// 検索は結果をカテゴリのタブで絞れるようにする。Web版のカテゴリ分けと同じ
// 見え方にするため、グループが2つ以上あるときだけタブを出す。
let searchOriginLabel='接続中のHub';
void invoke('hub_origin').then(origin=>{searchOriginLabel=new URL(origin).host;}).catch(()=>{});
const searchScopeText=state=>`対象: ${searchOriginLabel}の閲覧できるコンテンツ${state.filtered?' · 絞り込み中（他サービスは対象外）':'・接続中の公開曲サービス'}${Object.keys(state.errors).length?' · 一部を取得できません':''}`;
let searchGroups = [];
let searchGroupFilter = "all";
let searchLastQuery = "";
let mainSearchState = null;
const mainSearchBindings=[];
function appendSearchControls(target, state, controller) {
  for (const source of state.more) {
    const button = actionButton(`${searchSources[source]}の続きを表示`, "ghost", () => controller.more(source));
    button.disabled = state.pending.includes(source); target.append(button);
  }
  for (const [source, error] of Object.entries(state.errors)) {
    const row = document.createElement("p"); row.className = "meta warning";
    row.append(`${searchSources[source]}: ${friendlyError(error)} `, retryButton(() => controller.retry(source))); target.append(row);
  }
}
function renderSearchResults() {
  const target = document.querySelector("#search-results");
  const data = Object.fromEntries(searchGroups);
  // 項目から来た絞り込みでも、その種類が1件も無ければ全体を見せる（空の画面で止めない）。
  if (searchGroupFilter !== "all" && searchGroups.length && !data[searchGroupFilter]?.length && !mainSearchState?.pending?.length) searchGroupFilter = "all";
  renderPublicResults(target, searchGroupFilter === "all" ? data : {[searchGroupFilter]: data[searchGroupFilter]}, searchLastQuery, mainSearchState?.filtered);
  if (mainSearchState) {
    if (!searchGroups.length && mainSearchState.pending.length) target.replaceChildren(skeletonResult());
    else if (!searchGroups.length && Object.keys(mainSearchState.errors).length) target.replaceChildren();
    appendSearchControls(target, mainSearchState, mainSearch);
  }
}
const mainSearch = createHubSearch({invoke, changed: state => {
  mainSearchState = state; searchLastQuery = state.query; searchGroups = publicGroups(state.data);
  document.querySelector("#search-state").textContent = state.pending.length ? "検索しています…" : state.query || state.filtered ? searchScopeText(state) : "";
  renderSearchTabs(); renderSearchResults();
}});

function renderSearchTabs() {
  const bar = document.querySelector("#search-tabs");
  if (!bar) return;
  if (searchGroups.length < 2) {
    bar.hidden = true;
    bar.replaceChildren();
    if (currentView === "search") renderSidebarContext("search");
    return;
  }
  const make = (key, label) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `chip${searchGroupFilter === key ? " on" : ""}`;
    button.textContent = label;
    button.onclick = () => {
      searchGroupFilter = key;
      for (const other of bar.children) other.classList.toggle("on", other === button);
      renderSearchResults();
    };
    return button;
  };
  bar.hidden = false;
  bar.replaceChildren(
    make("all", "すべて"),
    ...searchGroups.map(([key, records]) => make(key, `${GROUP_LABELS[key] ?? key} ${records.length}`)),
  );
  if (currentView === "search") renderSidebarContext("search");
}

const mainSearchFilters=createHubSearchFilters(document,{
  onChange:()=>{for(const binding of mainSearchBindings)binding.cancel();if(!mainSearchBindings.length)mainSearch.invalidate();document.querySelector('#search-state').textContent='条件を変更しました。適用してください。';},
  onApply:options=>submitMainSearch(document.querySelector('#search-query').value,options)});
document.querySelector('#search-filter-host').append(mainSearchFilters.element);
const submitMainSearch = (query, options) => {
  searchGroupFilter = "all";
  document.querySelector("#toolbar-search-input").value = query;
  try{return mainSearch.search(query,options??mainSearchFilters.value());}
  catch {mainSearch.invalidate();document.querySelector('#search-state').textContent='検索条件を確認してください。';return Promise.resolve();}
};
mainSearchBindings.push(bindSearchInput(document.querySelector("#search-query"), {form: document.querySelector("#hub-search"), search: submitMainSearch, invalidate: () => mainSearch.invalidate()}));
window.addEventListener("hub-account-changed", () => mainSearch.invalidate());
const toolbarSearchInput = document.querySelector("#toolbar-search-input");
const toolbarSearchBinding = bindSearchInput(toolbarSearchInput, {
  search: query => currentView === "search" ? submitMainSearch(query) : undefined,
  invalidate: () => { if (currentView === "search") mainSearch.invalidate(); },
});

mainSearchBindings.push(toolbarSearchBinding);
let savedSearchStorage = null;
try { savedSearchStorage = window.localStorage; } catch {}
if (!startupTool) {
  savedSearchPanel = createSavedSearches({
    document, storage: savedSearchStorage, getScope: savedSearchScopeSnapshot,
    getValue: () => ({ query: document.querySelector('#search-query').value, group: searchGroupFilter, ...mainSearchFilters.value() }),
    isCurrent: () => currentView === 'search',
    apply: async (value, stillCurrent) => {
      if (!stillCurrent()) return false;
      for (const binding of mainSearchBindings) { if (!stillCurrent()) return false; binding.cancel(); }
      if (!stillCurrent()) return false; mainSearchFilters.setValue({ filters: value.filters, order: value.order });
      if (!stillCurrent()) return false; document.querySelector('#search-query').value = value.query;
      if (!stillCurrent()) return false; document.querySelector('#toolbar-search-input').value = value.query;
      if (!stillCurrent()) return false;
      const searching = submitMainSearch(value.query, { filters: value.filters, order: value.order });
      if (!stillCurrent()) return false; searchGroupFilter = value.group; renderSearchTabs(); renderSearchResults();
      await searching;
      if (!stillCurrent()) return false;
      return !Object.keys(mainSearch.snapshot().errors ?? {}).length;
    },
  });
  document.querySelector('#search-filter-host').append(savedSearchPanel.element);
  if (currentView === 'search') void refreshSavedSearchScope();
}


document.querySelector("#search-web").onclick = () => {
  const query = document.querySelector("#search-query").value.trim();
  const state = document.querySelector("#search-web-state");
  if (!query) { state.textContent = "検索語を入力してください。"; return; }
  state.textContent = "";
  void openWebSearch(query);
};
const syncSearchWebLabel = () => { const label = `Webでも探す（${webSearchLabel(browserSearchEngine())}）`; const button = document.querySelector("#search-web"); if (button) button.textContent = label; };
syncSearchWebLabel();
window.addEventListener("hub-web-search-changed", syncSearchWebLabel);
for (const tab of document.querySelectorAll("[data-market-tab]")) {
  tab.onclick = () => document.querySelector(
    `.nav-item[data-view="${tab.dataset.marketTab}"]`
  )?.click();
}
// 設定はWeb版と同じ内側左列。節を選ぶと本文だけが入れ替わる。各節は settings-view.mjs。
// 音楽のP2P配布（任意参加・既定オフ）。「この端末」の節に置く。
const mediaP2pHost = document.querySelector("#settings-media-p2p");
const mediaP2pSettings = mediaP2pHost
  ? createMediaP2pSettings({ document, invoke, isCurrent: () => !mediaP2pHost.closest("[hidden]") })
  : null;
if (mediaP2pSettings) mediaP2pHost.append(mediaP2pSettings.element);
// 端末内翻訳（モデルの取得・自前の GGUF・規約への同意）。「この端末」の節に置く。
const localTranslateHost = document.querySelector("#settings-local-translate");
const localTranslateSettings = localTranslateHost ? renderTranslateSettings({ doc: document, root: localTranslateHost, invoke }) : null;
void localTranslateSettings?.ready?.catch?.(() => undefined);
const safeStorage = (() => { try { return window.localStorage; } catch { return null; } })();
// APIの窓口（api-market-view.mjs、patch-notes-api-market.md）。公開の一覧は自分の写しを持ち、開示の同意は AI の選び手と同じ鍵。
let apiMarketListings = [];
const apiMarketController = createMarketController({ storage: safeStorage, getListings: () => apiMarketListings, ask: (info) => showDisclosure(document, info) });
const apiMarketView = createApiMarketView({
  document, host: document.querySelector("#market-api"), getListings: () => apiMarketListings, market: apiMarketController,
  openExternal: (url) => void invoke("open_external", { url }).catch(() => undefined),
  // 種別 ai だけ、開示に同意した後に、この窓口を選んだ状態で AI 画面を開く。
  onUse: (listing, model) => {
    document.querySelector('.nav-item[data-view="ai"]')?.click();
    const input = document.querySelector("#pi-work-model");
    if (!input) return;
    input.value = marketRef(listing, model);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  },
});
const showApiMarket = () => {
  for (const id of ["#market-shop", "#market-games", "#market-listings", "#market-seller"]) { const node = document.querySelector(id); if (node) node.hidden = true; }
  document.querySelector("#market-api").hidden = false;
  apiMarketView.render();
  void Promise.resolve(invoke("hub_resource", { resource: "ai_market", query: "", cursor: null }))
    .then((body) => { apiMarketListings = normalizeListings(body); apiMarketView.render(); })
    .catch(() => { apiMarketListings = []; apiMarketView.render(); });
};
const settingsPanels = {
  appearance: createAppearanceSettings({ document, storage: safeStorage }),
  identity: createIdentityPanel({ document, invoke }),
  cache: createCachePanel({ document, invoke }),
  storage: createStoragePanel({ document, invoke, openExternal: (url) => invoke("open_external", { url }) }),
  browser: createBrowserPanel({ document, invoke, storage: safeStorage, onWebSearchChange: () => window.dispatchEvent(new Event("hub-web-search-changed")) }),
  ai: createAiConnectionsPanel({ document, invoke, storage: safeStorage, listen: window.__TAURI__?.event?.listen ? (name, callback) => window.__TAURI__.event.listen(name, callback) : null }),
  about: createAboutPanel({ document, invoke, getVersion: () => window.__TAURI__.app.getVersion() }),
};
// 言語は「表示」の先頭の行（i18n.mjs）。
settingsPanels.appearance.element.prepend(createLanguageSetting({ document, i18n: hubI18n }));
for (const [id, panel] of [["appearance", settingsPanels.appearance], ["identity", settingsPanels.identity], ["cache", settingsPanels.cache], ["browser", settingsPanels.browser], ["ai", settingsPanels.ai], ["about", settingsPanels.about]]) {
  document.querySelector(`#settings-${id}`)?.append(panel.element);
}
document.querySelector("#settings-storage")?.append(settingsPanels.storage.element);
// 手元のデータを消す（ウォレットの鍵は別の確認を経る）と、AIの作業記録の一括削除。
document.querySelector("#settings-local-data")?.append(createLocalDataPanel({
  document, invoke,
  openWallet: () => document.querySelector('[data-settings-panel="wallet"] .open-view[data-open-view="wallet"]')?.click(),
}).element);
document.querySelector("#settings-ai")?.append(createAiRecordsPanel({
  document, invoke, onDeleted: () => document.dispatchEvent(new CustomEvent("hub-ai-records-deleted")),
}).element);
const settingsNav = createSettingsNav({
  document,
  onSelect: (section) => {
    if (section === "notifications" || section === "privacy") void loadSettingsPanel();
    if (section === "device") { void localTranslateSettings?.redraw?.().catch(() => undefined); void mediaP2pSettings?.refresh(); void settingsPanels.cache.refresh(); void settingsPanels.storage.refresh(); }
    if (section === "advanced") { void settingsPanels.identity.refresh(); void settingsPanels.about.refresh(); }
    if (section === "browser") void settingsPanels.browser.refresh();
    if (section === "ai") void settingsPanels.ai.refresh();
  },
});
document.addEventListener("hub-settings-section", () => { if (currentView === "settings") renderSidebarContext("settings"); });
// 設定の検索（ラベルと説明の部分一致）。結果を押すとその節へ移り、その行を示す。
const settingsSearchInput = document.querySelector("#settings-search");
const settingsSearchPanel = document.querySelector('#view-settings [data-settings-panel="search"]');
if (settingsSearchInput && settingsSearchPanel) createSettingsSearch({ document, input: settingsSearchInput, panel: settingsSearchPanel, nav: settingsNav });

// --- 通知と受信（/api/client/settings 経由・デスクトップのassertion必須） ---
const NOTIFICATION_PREF_LABELS = [
  ["replies", "返信"], ["reactions", "リアクション"], ["follows", "フォロー"],
  ["messages", "メッセージ"], ["commercePayments", "購入・支払い"],
  ["commerceDelivery", "配送・受け取り"], ["commerceReturns", "返品・返金"],
];
const NOTIFICATION_PREF_HINTS = {
  replies: "投稿に返信が付いたとき",
  reactions: "投稿にリアクションが付いたとき",
  follows: "フォローされたとき",
  messages: "メッセージが届いたとき",
  commercePayments: "購入や支払いに動きがあったとき",
  commerceDelivery: "配送や受け取りに動きがあったとき",
  commerceReturns: "返品や返金に動きがあったとき",
};
// 項目は起動時に並べる（検索で見つかるように）。値は読み込み後に入り、それまでは触れない。
(() => {
  const box = document.querySelector("#settings-notifications");
  if (!box) return;
  box.replaceChildren(...NOTIFICATION_PREF_LABELS.map(([key, label]) => {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.prefKey = key;
    input.disabled = true;
    input.setAttribute("role", "switch");
    return settingRow(document, { label: `${label}の通知`, desc: NOTIFICATION_PREF_HINTS[key], control: input, keywords: "通知 お知らせ", key: `notify-${key}` });
  }));
})();
const settingsStates = () => [document.querySelector("#settings-state"), document.querySelector("#settings-state-safety")].filter(Boolean);
const settingsSaves = () => [document.querySelector("#settings-save"), document.querySelector("#settings-save-safety")].filter(Boolean);
function setSettingsState(text, warning = false) {
  for (const node of settingsStates()) { node.textContent = text; node.classList.toggle("warning", warning); }
}
let settingsLoaded = false;
async function loadSettingsPanel() {
  if (settingsLoaded) return;
  for (const save of settingsSaves()) save.disabled = true;
  try {
    const data = await invoke("hub_client", { name: "settings" });
    for (const input of document.querySelectorAll("#settings-notifications input[data-pref-key]")) {
      input.checked = Boolean(data?.notifications?.[input.dataset.prefKey]);
      input.disabled = false;
    }
    document.querySelector("#settings-dm").value = data?.directMessages ?? "mutuals";
    document.querySelector("#settings-muted").value = (data?.contentSafety?.terms ?? []).join("\n");
    document.querySelector("#settings-sensitive").checked = Boolean(data?.contentSafety?.showSensitive);
    setSettingsState("");
    settingsLoaded = true;
    for (const save of settingsSaves()) save.disabled = false;
  } catch (error) {
    setSettingsState(accountNeeded(error) ? "Desktopを接続すると設定できます。" : friendlyError(error), !accountNeeded(error));
  }
}

// 通知とプライバシーは同じ設定を一度に保存する。どちらの保存ボタンからでも、全部を送る。
const saveSettings = async () => {
  for (const save of settingsSaves()) save.disabled = true;
  setSettingsState("保存中…");
  const notifications = {};
  for (const input of document.querySelectorAll("#settings-notifications input[data-pref-key]")) {
    notifications[input.dataset.prefKey] = input.checked;
  }
  try {
    await invoke("hub_client_action", {
      action: "update_settings",
      options: {
        notifications,
        directMessages: document.querySelector("#settings-dm").value,
        mutedTerms: document.querySelector("#settings-muted").value.split("\n").map((s) => s.trim()).filter(Boolean),
        showSensitive: document.querySelector("#settings-sensitive").checked,
      },
    });
    setSettingsState("保存しました。");
  } catch (error) {
    setSettingsState(friendlyError(error), true);
  }
  for (const save of settingsSaves()) save.disabled = false;
};
for (const save of settingsSaves()) save.onclick = saveSettings;

// 左のレールのゲームはマーケットのゲームの種別を開く（openMarketGames、loadMarketGames）。購入はWebの商品頁をシステムのブラウザで開く。

// --- AI ツール（x402 従量課金）---
// 実行系は支払いゲート: 初回呼出しで 402 と支払い要件が返り、窓は要件の
// 各オプション（資産・金額・ネットワーク）を提示する。本人が選ぶと Rust 側が
// EIP-3009 の typedData を組んで確認モーダルを出し、署名済み payload で再送する。
const aiTools = {
  catalog: null,
  pending: null, // {params, required} — 支払い待ちの呼出し
  videoObjectUrl: null,
  imageObjectUrl: null,
};
const aiCatalogState = document.querySelector("#ai-catalog-state");
const aiToolForm = document.querySelector("#ai-tool-form");
const aiToolSelect = document.querySelector("#ai-tool-select");
const aiProviderField = document.querySelector("#ai-provider-field");
const aiProviderSelect = document.querySelector("#ai-provider-select");
const aiAspectField = document.querySelector("#ai-aspect-field");
const aiAspectSelect = document.querySelector("#ai-aspect-select");
const aiPrompt = document.querySelector("#ai-prompt");
const aiRunButton = document.querySelector("#ai-run");
const aiRunState = document.querySelector("#ai-run-state");
const aiPayPanel = document.querySelector("#ai-pay-panel");
const aiPayOptions = document.querySelector("#ai-pay-options");
const aiResult = document.querySelector("#ai-result");
// 有料実行は既定で無効（所有者決定 2026-10-15）。カードは index.html で hidden。
if (AI_PAID_EXECUTION) document.querySelector("#ai-tools").hidden = false;

function aiToolKind() {
  const tool = aiTools.catalog?.tools?.find((item) => item.id === aiToolSelect.value);
  if (!tool) return null;
  if (tool.output === "image") return "image";
  if (tool.output === "video") return "video";
  return "tool";
}

function aiCallParams() {
  const kind = aiToolKind();
  if (!kind) return null;
  return {
    kind,
    providerId: kind === "tool" ? aiProviderSelect.value : null,
    toolId: kind === "tool" ? aiToolSelect.value : null,
    prompt: aiPrompt.value,
    aspectRatio: kind === "tool" ? null : aiAspectSelect.value,
  };
}

function aiSetState(node, text) {
  node.hidden = !text;
  node.textContent = text || "";
}

// 原子単位の金額を decimals と通貨名で人間向けにする。
function aiFormatAmount(atomic, decimals, currency) {
  const digits = String(atomic);
  const point = digits.length - decimals;
  const text = point > 0 ? `${digits.slice(0, point)}.${digits.slice(point).replace(/0+$/, "") || "0"}` : `0.${"0".repeat(-point)}${digits}`;
  return `${text} ${currency}`;
}

function aiOptionFor(accepted) {
  return aiTools.catalog?.payment?.options?.find(
    (option) => option.network === accepted.network && option.asset.toLowerCase() === String(accepted.asset).toLowerCase(),
  );
}

function aiRenderResult(result) {
  aiResult.hidden = false;
  aiResult.replaceChildren();
  const kind = aiToolKind();
  if (kind === "image" && typeof result?.imageBase64 === "string") {
    const bytes = Uint8Array.from(atob(result.imageBase64), (c) => c.charCodeAt(0));
    if (aiTools.imageObjectUrl) URL.revokeObjectURL(aiTools.imageObjectUrl);
    aiTools.imageObjectUrl = URL.createObjectURL(new Blob([bytes], { type: result.mimeType || "image/png" }));
    const image = document.createElement("img");
    image.src = aiTools.imageObjectUrl;
    image.className = "ai-result-image";
    aiResult.append(image);
    return;
  }
  if (kind === "video" && typeof result?.token === "string") {
    aiPollVideo(result.token);
    return;
  }
  const pre = document.createElement("pre");
  pre.className = "ai-result-text";
  pre.textContent = typeof result?.output === "string" ? result.output : JSON.stringify(result, null, 2);
  aiResult.append(pre);
}

async function aiPollVideo(token) {
  const note = document.createElement("p");
  note.className = "meta";
  note.textContent = "動画を生成しています…";
  aiResult.append(note);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const status = await invoke("ai_video_status", { token }).catch((error) => ({ status: "failed", error: String(error) }));
    if (status.status === "completed") {
      const bytes = await invoke("ai_video_content", { token }).catch(() => null);
      if (!bytes) { note.textContent = "動画の取得に失敗しました"; return; }
      if (aiTools.videoObjectUrl) URL.revokeObjectURL(aiTools.videoObjectUrl);
      aiTools.videoObjectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "video/mp4" }));
      const video = document.createElement("video");
      video.src = aiTools.videoObjectUrl;
      video.controls = true;
      video.className = "ai-result-video";
      note.remove();
      aiResult.append(video);
      return;
    }
    if (status.status !== "queued") { note.textContent = "動画の生成に失敗しました"; return; }
    note.textContent = `動画を生成しています…（${status.progress ?? 0}%）`;
  }
  note.textContent = "動画の生成がまだ終わっていません";
}

function aiRenderPay(required, params) {
  aiPayPanel.hidden = false;
  aiPayOptions.replaceChildren();
  const accepts = Array.isArray(required?.accepts) ? required.accepts : [];
  const exact = accepts.filter((entry) => entry?.scheme === "exact");
  if (!exact.length) {
    aiSetState(aiRunState, "この端末が扱える支払い方式がありません");
    return;
  }
  for (const entry of exact) {
    const option = aiOptionFor(entry);
    const label = option
      ? `${aiFormatAmount(entry.amount, option.decimals, option.currency)} · ${option.chainName}`
      : `${entry.amount}（原子単位） · ${entry.network}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "approve";
    button.textContent = `${label} で支払う`;
    button.onclick = () => void aiPay(entry, label, params, required?.resource?.description);
    aiPayOptions.append(button);
  }
}

async function aiPay(entry, display, params, description) {
  if (!AI_PAID_EXECUTION) return;
  aiSetState(aiRunState, "署名の確認を待っています…");
  const outcome = await invoke("ai_pay_and_call", {
    ...params,
    accepted: entry,
    display,
    description: typeof description === "string" ? description : "AI ツールの実行",
  }).catch((error) => ({ status: "error", error: friendlyError(error) }));
  aiPayPanel.hidden = true;
  aiHandleOutcome(outcome, params);
}

function aiHandleOutcome(outcome, params) {
  if (outcome?.status === "ok") {
    aiSetState(aiRunState, "");
    aiRenderResult(outcome.result);
    return;
  }
  if (outcome?.status === "payment_required" && outcome.required) {
    aiTools.pending = { params, required: outcome.required };
    aiSetState(aiRunState, "");
    aiRenderPay(outcome.required, params);
    return;
  }
  aiSetState(aiRunState, outcome?.error ? friendlyError(outcome.error) : "実行できませんでした");
}

document.querySelector("#ai-catalog-load").onclick = async () => {
  if (!AI_PAID_EXECUTION) return;
  aiSetState(aiCatalogState, "読み込み中…");
  const catalog = await invoke("ai_catalog").catch((error) => ({ error: friendlyError(error) }));
  if (!catalog || catalog.error || !Array.isArray(catalog.tools)) {
    aiSetState(aiCatalogState, catalog?.error || "一覧を読めませんでした");
    return;
  }
  aiTools.catalog = catalog;
  aiSetState(aiCatalogState, catalog.payment?.enabled ? "" : "現在は支払いを受け付けていません");
  aiToolForm.hidden = false;
  aiToolSelect.replaceChildren();
  for (const tool of catalog.tools) {
    const option = document.createElement("option");
    option.value = tool.id;
    option.textContent = `${tool.name}${tool.available === false ? "（休止中）" : ""}`;
    option.disabled = tool.available === false;
    aiToolSelect.append(option);
  }
  aiProviderSelect.replaceChildren();
  for (const provider of catalog.providers ?? []) {
    const option = document.createElement("option");
    option.value = provider.id;
    option.textContent = `${provider.name}${provider.available ? ` · $${provider.priceUsd}` : "（使えません）"}`;
    option.disabled = !provider.available;
    aiProviderSelect.append(option);
  }
  aiToolSelect.onchange();
};

aiToolSelect.onchange = () => {
  const kind = aiToolKind();
  aiProviderField.hidden = kind !== "tool";
  aiAspectField.hidden = kind === "tool";
  aiPayPanel.hidden = true;
  aiResult.hidden = true;
};

aiPrompt.oninput = () => { aiRunButton.disabled = !aiPrompt.value.trim() || !aiToolKind(); };
aiProviderSelect.onchange = () => { aiRunButton.disabled = !aiPrompt.value.trim() || !aiToolKind(); };

aiRunButton.onclick = async () => {
  if (!AI_PAID_EXECUTION) return;
  const params = aiCallParams();
  if (!params) return;
  aiRunButton.disabled = true;
  aiPayPanel.hidden = true;
  aiResult.hidden = true;
  aiSetState(aiRunState, "実行しています…");
  const outcome = await invoke("ai_call", params).catch((error) => ({ status: "error", error: friendlyError(error) }));
  aiRunButton.disabled = false;
  aiHandleOutcome(outcome, params);
};

// --- ブラウザ ---
// ブラウザはアプリの中の行き先のひとつ。操作面（ストリップ・タブ欄）は
// このDOMが持ち、ページ本体は子webviewがステージ領域へ描く。メニューを
// 縦タブは固定したステージの上へ広げ、Nativeのchild hostだけをclipする。
// 行き先を離れると隠すだけで、タブは残って続きから再開する。
const browserStage = document.querySelector("#browser-stage");
const browserHint = document.querySelector("#browser-empty");
let browserActive = false;
let browserTransition = 0;
let browserControls = null;
let hubOrigin = null;

function browserRect() {
  const rect = browserStage.getBoundingClientRect();
  return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
}
// Root imports createBrowserExternalOpen from './browser-external-open.mjs'.
// One unresolved external open is kept in memory; no target-navigation retry is offered.
let browserExternalOperation = null;
function renderBrowserExternalOutcome(operation, transition) {
  const current=()=>transition===browserTransition&&currentView==='browser'&&browserExternalOperation===operation;
  if(!current())return;
  const unknown=operation.status().state==='unknown',message=document.createElement('p');
  message.textContent=unknown?'外部リンクを開けたか確認できません。再送せず、タブの状態を確認してください。':'ページを開く準備を確認できませんでした。新しいページは開いていません。';
  const check=document.createElement('button');check.type='button';check.className='approve';check.textContent=unknown?'開いたタブを確認':'ブラウザの状態を確認';
  check.onclick=async()=>{
    if(!current()||check.disabled)return;check.disabled=true;
    try{
      if(unknown){const opened=await operation.recheck();if(!current())return;if(opened){browserExternalOperation=null;browserHint.hidden=true;}else renderBrowserExternalOutcome(operation,transition);}
      else await browserControls?.refresh();
    }finally{if(current())check.disabled=false;}
  };
  browserHint.replaceChildren(message,check);browserHint.hidden=false;
}
async function enterBrowser(url, history = {}) {
  const external=url!==undefined&&url!==null&&currentView!=='browser';
  const transition = ++browserTransition;
  for (const control of document.querySelectorAll(".nav-item.on, .mobile-nav-item.on")) control.classList.remove("on");
  document.querySelector('.nav-item[data-view="browser"]')?.classList.add("on");
  showView("browser", "ブラウザ", history);
  browserActive = true;
  const current=()=>transition===browserTransition&&currentView==='browser';
  const loading = document.createElement("p");loading.textContent = "ブラウザを開いています…";
  browserHint.replaceChildren(loading);browserHint.hidden = false;
  try {
    if(browserExternalOperation?.status().state==='unknown'){
      await invoke('browser_enter',{rect:browserRect(),url:null});
      if(current())renderBrowserExternalOutcome(browserExternalOperation,transition);
      return;
    }
    if(external){
      const intent=browserControls?.captureNavigationIntent?.()??(()=>true);
      const operation=createBrowserExternalOpen({url,invoke,
        enter:()=>invoke('browser_enter',{rect:browserRect(),url:null}),
        isCurrent:()=>current()&&intent(),canInspect:()=>browserActive&&currentView==='browser'});
      browserExternalOperation=operation;
      const opened=await operation.open();if(!current())return;
      if(operation.status().state==='superseded'){browserHint.hidden=true;return;}
      if(!opened){renderBrowserExternalOutcome(operation,transition);return;}
      browserExternalOperation=null;
    }else await invoke("browser_enter", { rect: browserRect(), url: url ?? null });
    if (!current()) return;
    browserHint.hidden = true;
  } catch {
    if (!current()) return;
    browserActive = false;
    const message = document.createElement("p");message.textContent = "ブラウザを開けませんでした。接続を確認して再試行してください。";
    const retry = document.createElement("button");retry.type = "button";retry.className = "approve";retry.textContent = "再試行";
    retry.onclick = () => { if (current()) void enterBrowser(url); };
    browserHint.replaceChildren(message, retry);
  }
}
async function exitBrowser() {
  ++browserTransition;
  browserControls?.cancelPendingFocus();
  browserControls?.closeAuxiliary?.();
  if (!browserActive) return;
  browserActive = false;
  await invoke("browser_exit").catch(() => {});
}
if (!startupTool) {
  initBrowserControls();
  void invoke("hub_origin").then((origin) => { hubOrigin = origin; }).catch(() => {});
  new ResizeObserver(() => {
    if (browserActive) invoke("browser_layout", { rect: browserRect() }).catch(() => {});
  }).observe(browserStage);
  // HTML over the page stage (menu, tooltips, suggestion lists) stays visible: Native cuts the page out under it.
  createBrowserPageHoles({ window, document, stage: browserStage, invoke, isActive: () => browserActive && currentView === "browser" });
  let overlayFrame = null, overlayBusy = false, overlayLast = null;
  function overlayUnavailable() {
    if (desktopShell.classList.contains("browser-tabs-overlay-unavailable")) return;
    desktopShell.classList.add("browser-tabs-overlay-unavailable");
    showNotice("タブの重ね表示を利用できません。通常のサイドバー表示に戻しました。");
  }
  function syncTabOverlay() {
    if (overlayFrame !== null) return;
    overlayFrame = requestAnimationFrame(async () => {
      overlayFrame = null; if (overlayBusy) return;
      const sidebar = desktopShell.querySelector(".sidebar");
      const enabled = browserActive && currentView === "browser" && desktopShell.classList.contains("browser-tabs-peek-open") && !desktopShell.classList.contains("browser-tabs-overlay-unavailable");
      const left = enabled ? Math.min(480, Math.max(0, sidebar.getBoundingClientRect().right - browserStage.getBoundingClientRect().left)) : 0;
      if (left === overlayLast) return;
      overlayBusy = true;
      try { await invoke("browser_tab_overlay", {left}); overlayLast = left; }
      catch { overlayLast = left; overlayUnavailable(); }
      finally { overlayBusy = false; syncTabOverlay(); }
    });
  }
  new ResizeObserver(syncTabOverlay).observe(desktopShell.querySelector(".sidebar"));
  new MutationObserver(syncTabOverlay).observe(desktopShell, {attributes:true,attributeFilter:["class"]});
  await window.__TAURI__.event.listen("browser-tab-overlay-unavailable", overlayUnavailable);
  syncTabOverlay();
  await window.__TAURI__.event.listen("desktop-control-metrics", (event) => {
    const requestId = event.payload?.requestId;
    if (Number.isSafeInteger(requestId) && requestId > 0) void invoke("desktop_control_metrics_report", { requestId, snapshot: controlMetrics.snapshot() }).catch(() => {});
  });
  // emit_to(MAIN_LABEL) はバーwebviewにも届くので、アプリ本体側だけが応答する。
  await window.__TAURI__.event.listen("browser-open-request", (event) => void enterBrowser(event.payload?.url));
  await window.__TAURI__.event.listen("browser-closed", () => {
    if (browserActive) navigateFrom({ dataset: { view: "home" }, childNodes: [] });
  });
  // Web版Hub宛の遷移はRust側で止まる。開けなかったURLだけ覚えておき、
  // 「既定のブラウザで開く」へ渡す。
  const blocked = document.querySelector("#browser-blocked");
  const blockedOpen = document.querySelector("#browser-blocked-open");
  let blockedUrl = null;
  await window.__TAURI__.event.listen("browser-hub-blocked", (event) => {
    blockedUrl = event.payload?.url ?? null;
    if (blocked) blocked.hidden = !blockedUrl;
  });
  if (blockedOpen) {
    blockedOpen.onclick = () => {
      if (blockedUrl) void invoke("open_external", { url: blockedUrl }).catch(() => undefined);
    };
  }
}

async function decide(command, id, button) {
  button.disabled = true;
  try { await invoke(command, { id }); await refresh(); }
  catch { button.disabled = false; }
}

function controls(denyCommand, approveCommand, id, approveLabel, enabled = true) {
  const node = document.createElement("div"); node.className = "actions";
  const deny = document.createElement("button"); deny.className = "deny"; deny.textContent = "拒否";
  deny.onclick = () => decide(denyCommand, id, deny);
  const approve = document.createElement("button"); approve.className = "approve"; approve.textContent = approveLabel;
  approve.disabled = !enabled; approve.onclick = () => decide(approveCommand, id, approve);
  node.append(deny, approve); return node;
}

function runCard(run, isolationReady) {
  const card = document.createElement("article"); card.className = "card";
  const title = document.createElement("strong"); title.textContent = run.language === "python" ? "Python" : "JavaScript";
  const meta = document.createElement("p"); meta.className = "meta"; meta.textContent = `${run.workspace_root} · 最大 ${Math.ceil(run.timeout_ms / 1000)}秒 · ネットワークなし`;
  const source = document.createElement("pre"); source.textContent = run.code;
  card.append(title, meta, source, controls("deny_run", "approve_run", run.id, "承認して実行", isolationReady)); return card;
}

function writeCard(write) {
  const card = document.createElement("article"); card.className = "card";
  const title = document.createElement("strong"); title.textContent = write.relative_path;
  const meta = document.createElement("p"); meta.className = "meta"; meta.textContent = `${write.workspace_root} · 残り ${write.expires_in_seconds}秒`;
  const hashes = document.createElement("pre"); hashes.textContent = `現在: ${write.expected_previous_sha256 || "新規ファイル"}\n保存後: ${write.expected_next_sha256}`;
  card.append(title, meta, hashes, controls("deny_file_write", "approve_file_write", write.id, "承認して保存")); return card;
}

function devApprovalCard(run) {
  const card = document.createElement("article"); card.className = "card";
  const title = document.createElement("strong"); title.textContent = `${run.agent} ${run.model}`;
  const meta = document.createElement("p"); meta.className = "meta";
  meta.textContent = `${run.workspace} · 残り ${run.expiresInSeconds}秒`;
  const adapter = document.createElement("p"); adapter.className = "meta";
  adapter.textContent = run.adapter
    ? `接続 ${run.adapter.label} · ${run.adapter.connectionState} · 実行主体 ${run.adapter.executionAuthority}`
    : "旧形式の接続記録";
  const warning = document.createElement("p"); warning.className = "warning";
  warning.textContent = run.requestedCapabilities?.includes("prompt_only_proposal")
    ? "Claudeへ依頼と圧縮した文脈を送り、提案だけを受け取ります。ファイル・シェル操作はできません。"
    : "選択フォルダ内でコマンドを実行し、依頼と必要なソースをクラウドAIへ送ります。";
  const risk = document.createElement("p"); risk.className = "meta";
  risk.textContent = `リスク ${run.riskLevel || "R1"} · 要求 ${run.requestedCapabilities?.join(" / ") || "workspace"}`;
  const blocked = document.createElement("p"); blocked.className = "warning";
  blocked.textContent = run.blockedCapabilities?.length
    ? `この実行では禁止: ${run.blockedCapabilities.join(" / ")}`
    : "外部公開・配備・購入・送信・Git pushは許可されません。";
  const policy = document.createElement("p"); policy.className = "meta";
  policy.textContent = "固定方針: 先に調査と計画を行い、公開・配備・購入・送信はせず、関連する検査結果と未解決点を報告します。";
  const prompt = document.createElement("pre"); prompt.textContent = run.prompt;
  card.append(title, meta, adapter, risk, warning, blocked, policy, prompt, controls("deny_dev_run", "approve_dev_run", run.id, "接続先で実行を開始"));
  return card;
}

// --- フィード ---
// このアプリは開発の道具箱ではなく、SNSのクライアントでもある。ハブを包んだ
// webview ではなく、APIを読んで自分で描く。包みはブラウザより不便になるだけで、
// 足せるものが何も無い。
const feed = {
  state: document.querySelector("#feed-state"),
  list: document.querySelector("#feed-list")
};
let feedLoadFailed = false;
// Web /v2 のフィードと同じ並びを既定にする——違う既定だと、
// 同じハブを開いても違う投稿が並ぶ。
let feedScope = "recommended";

// アバターや投稿画像の src を Hub 起点へ揃える。hubOrigin は非同期で
// 届くので、相対URLは届いてから確定する。
function hubAsset(img, url) {
  // CSP の img-src に data: は無い。形を確かめて blob: にし、通らなければ onerror（画像なし）の道へ。
  if (typeof url === "string" && /^data:/i.test(url)) {
    const blobUrl = dataImageToBlobUrl(url);
    if (blobUrl) img.src = blobUrl; else queueMicrotask(() => img.dispatchEvent(new Event("error")));
    return;
  }
  if (!url?.startsWith("/")) { img.src = url; return; }
  void Promise.resolve(hubOrigin ?? invoke("hub_origin").then((origin) => { hubOrigin = origin; return origin; }).catch(() => null))
    .then((origin) => { if (origin) img.src = origin + url; });
}

// 投稿の画像の拡大表示。1 枚ずつ縦横比を保って窓に収め、←→ で送り、Esc・背景・× で閉じて元の画像へ焦点を戻す。
// 画像は投稿に載っている URL だけを使う（別の大きさを取りに行かない）。
function openMediaLightbox(images, start, opener) {
  if (!images?.length) return;
  document.querySelector("dialog.media-lightbox")?.remove();
  const dialog = document.createElement("dialog");
  dialog.className = "media-lightbox";
  dialog.setAttribute("aria-label", "画像");
  const figure = document.createElement("figure");
  const img = document.createElement("img");
  const caption = document.createElement("figcaption");
  figure.append(img, caption);
  const button = (cls, label, glyph) => { const b = document.createElement("button"); b.type = "button"; b.className = cls; b.setAttribute("aria-label", label); b.title = label; b.textContent = glyph; return b; };
  const close = button("media-lightbox-close", "閉じる", "×");
  const prev = button("media-lightbox-prev", "前の画像", "‹");
  const next = button("media-lightbox-next", "次の画像", "›");
  const count = document.createElement("p");
  count.className = "media-lightbox-count";
  let index = start;
  const show = () => {
    const image = images[index];
    hubAsset(img, image.url);
    img.alt = image.altText || "";
    caption.textContent = image.altText || "";
    caption.hidden = !image.altText;
    prev.hidden = next.hidden = count.hidden = images.length < 2;
    prev.disabled = index === 0;
    next.disabled = index === images.length - 1;
    count.textContent = `${index + 1} / ${images.length}`;
  };
  const step = (delta) => { const target = index + delta; if (target < 0 || target >= images.length) return; index = target; show(); };
  prev.onclick = (event) => { event.stopPropagation(); step(-1); };
  next.onclick = (event) => { event.stopPropagation(); step(1); };
  close.onclick = () => dialog.close();
  dialog.onclick = (event) => { if (event.target === dialog || event.target === figure) dialog.close(); };
  dialog.onkeydown = (event) => {
    if (event.key === "ArrowLeft") { event.preventDefault(); step(-1); }
    else if (event.key === "ArrowRight") { event.preventDefault(); step(1); }
  };
  dialog.onclose = () => { dialog.remove(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  dialog.append(figure, prev, next, count, close);
  document.body.append(dialog);
  show();
  dialog.showModal();
  close.focus();
}

// Web の ClientFeedPost（client-feed-shape.ts）と同じフィールドをそのまま描く。
// avatarUrl が無い投稿だけ名前由来の丸アイコンに落とす。
document.addEventListener("pointerdown", (event) => {
  for (const menu of document.querySelectorAll(".post-repost-menu:not([hidden])")) {
    if (menu.parentElement.contains(event.target)) continue;
    menu.hidden = true;
    menu.previousElementSibling.setAttribute("aria-expanded", "false");
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const menu of document.querySelectorAll(".post-repost-menu:not([hidden])")) {
    const focused = menu.contains(document.activeElement);
    menu.hidden = true;
    menu.previousElementSibling.setAttribute("aria-expanded", "false");
    if (focused) menu.previousElementSibling.focus();
  }
});
function postCard(post, { primaryDetail = false, replyProfile = null, onOpen = null } = {}) {
  // 新しい投稿の形（統一した投稿）は同じ行の部品で描く。旧表の投稿は下の旧い道のまま（L5 まで）。
  if (post?.kind && post.counts && isUnifiedPost(post)) return unifiedPostRow(post);
  const authorName = post.authorName || post.displayName;
  const authorHandle = post.authorHandle || post.handle;
  const linkScope=homeAccountSnapshot();
  const linksCurrent=()=>homeAccountCurrent(linkScope);
  const card = document.createElement("article");
  card.className = "post";
  card.dataset.postId = post.id;
  if (primaryDetail) card.classList.add("detail-primary-post");
  else { card.tabIndex = 0; card.title = "投稿を開く"; }
  const avatar = document.createElement("span");
  avatar.className = "post-avatar";
  if (post.avatarUrl) {
    const img = document.createElement("img");
    hubAsset(img, post.avatarUrl);
    img.alt = "";
    avatar.classList.add("has-image");
    avatar.append(img);
  } else {
    avatar.textContent = (authorName || authorHandle || "?").trim().slice(0, 1).toUpperCase();
    paintAvatar(avatar, authorName || authorHandle);
  }
  const content = document.createElement("div");
  content.className = "post-content";
  const head = document.createElement("div");
  head.className = "post-head";
  const authorLink = document.createElement(authorHandle ? "button" : "span");
  authorLink.className = "post-author-link";
  if (authorHandle) {
    authorLink.type = "button";
    authorLink.setAttribute("aria-label", `${authorName || authorHandle}のプロフィールを開く`);
  }
  const who = document.createElement("strong");
  who.textContent = authorName || "（名無し）";
  if (authorHandle) who.className = "post-author";
  const handle = document.createElement("span");
  handle.className = "meta";
  handle.textContent = authorHandle ? "@" + authorHandle : "";
  authorLink.append(who, handle);
  const when = document.createElement("span");
  when.className = "meta when";
  when.textContent = relTime(post.createdAt);
  if (post.createdAt) when.title = new Date(post.createdAt).toLocaleString("ja-JP");
  head.append(authorLink, when);

  // 編集・削除・通報は「…」の中へ（DESKTOP_SPEC §3.10）。常に見える押し手は 28px 未満にしない。
  // 自分の投稿だけに編集・削除を出す。他人の投稿には出さない——権限はハブ側でも自分の投稿に限られる。
  const isOwnPost = Boolean(selfProfileId && post.authorProfileId === selfProfileId);
  const doDelete = () => {
    if (!confirm("この投稿を削除しますか？")) return;
    invoke("hub_client_action", { action: "delete_post", target: post.id })
      .then(() => card.remove())
      .catch((error) => { card.dataset.actionError = friendlyError(error); card.classList.add("action-error"); });
  };
  const startEdit = () => {
    if (body.dataset.editing) return;
    body.dataset.editing = "1";
    const editor = document.createElement("textarea");
    editor.className = "post-edit-box";
    editor.value = post.body;
    editor.maxLength = 500;
    const row = document.createElement("div");
    row.className = "post-edit-actions";
    row.onclick = event => event.stopPropagation();
    const save = document.createElement("button");
    save.type = "button";
    save.className = "approve";
    save.textContent = "保存";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ghost";
    cancel.textContent = "取消";
    const note = document.createElement("span");
    note.className = "meta";
    row.append(save, cancel, note);
    body.replaceChildren(editor, row);
    cancel.onclick = () => {
      delete body.dataset.editing;
      paintBody();
    };
    save.onclick = () => {
      const next = editor.value.trim();
      if (!next) { note.textContent = "本文が必要です"; return; }
      save.disabled = true;
      note.textContent = "保存しています…";
      invoke("hub_client_action", { action: "edit_post", target: post.id, text: next })
        .then((result) => {
          delete body.dataset.editing;
          post.body = result?.post?.body ?? next;
          paintBody();
        })
        .catch((error) => {
          save.disabled = false;
          note.textContent = friendlyError(error);
        });
    };
    editor.focus();
  };
  // 他人の投稿——通報口。フォームはカード内に開く。
  const openReport = () => {
    const existing = content.querySelector(".report-form");
    if (existing) { existing.remove(); return; }
    content.append(reportForm("social_post", post.id));
  };
  // 2026-11-06 所有者「人をリストに追加とか通報とかをまとめたボタン」：他人の投稿の「…」に、人への操作をまとめる。
  const setAuthorControl = async (action) => {
    const map = await loadSafetyControls();
    const prev = map.get(post.authorProfileId) ?? { muted: false, blocked: false };
    const key = action === "mute" ? "muted" : "blocked";
    // ここからは掛けるだけ。外すのはプロフィールの画面で（押し間違いで黙って外れないように）。
    if (prev[key]) return;
    if (action === "block" && !confirm("ブロックするとお互いのフォローが外れます。ブロックしますか？")) return;
    try {
      await invoke("hub_client_action", { action, target: post.authorProfileId });
      map.set(post.authorProfileId, { ...prev, [key]: true });
    } catch (error) { card.dataset.actionError = friendlyError(error); card.classList.add("action-error"); }
  };
  const moreEntries = isOwnPost ? [["編集", startEdit], ["削除", doDelete]]
    : post.authorProfileId ? [
      ["リストに追加", () => void openListPicker("profile", post.authorProfileId, content)],
      ["ミュート", () => void setAuthorControl("mute")],
      ["ブロック", () => void setAuthorControl("block")],
      ["報告", openReport],
    ] : [];
  if (moreEntries.length) {
    const wrap = document.createElement("div");
    wrap.className = "post-more-wrap";
    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "post-more";
    moreBtn.innerHTML = icon("more");
    moreBtn.setAttribute("aria-label", "投稿のその他の操作");
    moreBtn.setAttribute("aria-haspopup", "menu");
    moreBtn.setAttribute("aria-expanded", "false");
    moreBtn.title = "その他";
    // 既存の外押し・Esc の処理は .post-repost-menu と直前の兄弟の押し手を見る。同じ形にそろえる。
    const moreMenu = document.createElement("div");
    moreMenu.className = "post-repost-menu post-more-menu";
    moreMenu.setAttribute("role", "menu");
    moreMenu.hidden = true;
    for (const [label, run] of moreEntries) {
      const item = document.createElement("button");
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.textContent = label;
      item.onclick = (event) => {
        event.stopPropagation();
        moreMenu.hidden = true;
        moreBtn.setAttribute("aria-expanded", "false");
        run();
      };
      moreMenu.append(item);
    }
    moreBtn.onclick = (event) => {
      event.stopPropagation();
      moreMenu.hidden = !moreMenu.hidden;
      moreBtn.setAttribute("aria-expanded", String(!moreMenu.hidden));
      if (!moreMenu.hidden) moreMenu.querySelector("button")?.focus();
    };
    wrap.onclick = (event) => event.stopPropagation();
    wrap.append(moreBtn, moreMenu);
    head.append(wrap);
  }
  // 右クリック／キーボード用の入口。context-menu.mjs の提供者が読む。
  card.hubPostEntries = moreEntries;

  // Hub内の既知のパスはネイティブ詳細へ写す。知らないパスは
  // アプリ版に無い画面として正直に告げる（Web版へは逃がさない）。
  const openHubPath = (path) => {
    const detail = detailForHubPath(path);
    if (detail) {
      void openDetail(detail.name, detail.ids, { title: detail.title });
      return;
    }
    showNotice("この画面はアプリ版ではまだ開けません。");
  };
  if (authorHandle) {
    authorLink.onclick = (event) => { event.stopPropagation(); void openHubPath(`/v2/profile/${encodeURIComponent(authorHandle)}`); };
  }

  // 引用・リポスト・返信元の札。Webの投稿カードと同じものを出す——
  // これが無いと、引用投稿が「自分の言葉」に見えてしまう。
  let referenced = null;
  if (post.referenced?.href) {
    referenced = document.createElement("button");
    referenced.type = "button";
    referenced.className = "post-referenced";
    const label = document.createElement("span");
    label.className = "post-referenced-label";
    const kind = String(post.referenced.label || "").toLowerCase();
    const kindLabel = kind === "repost" ? "リポスト元" : kind === "reply" ? "返信先" : kind === "quote" ? "引用元" : post.referenced.label || "元の投稿";
    referenced.dataset.kind = ["repost", "reply", "quote"].includes(kind) ? kind : "other";
    label.textContent = post.referenced.contextLabel
      ? `${kindLabel} · ${post.referenced.contextLabel}`
      : kindLabel;
    const author = document.createElement("span");
    author.className = "post-referenced-author";
    const referenceAvatar = document.createElement("span");
    referenceAvatar.className = "post-referenced-avatar";
    referenceAvatar.textContent = (post.referenced.title || "?").trim().slice(0, 1).toUpperCase();
    paintAvatar(referenceAvatar, post.referenced.title);
    const title = document.createElement("strong");
    title.className = "post-referenced-title";
    title.textContent = post.referenced.title || "元の投稿";
    author.append(referenceAvatar, title);
    referenced.append(label, author);
    if (post.referenced.body) {
      const excerpt = document.createElement("span");
      excerpt.className = "post-referenced-body";
      excerpt.textContent = post.referenced.body;
      referenced.append(excerpt);
    }
    referenced.onclick = (event) => { event.stopPropagation(); void openHubPath(post.referenced.href); };
  }

  const body = document.createElement("p");
  body.className = "post-body";
  const paintBody = () => {
    body.textContent = post.body;
    renderContentReferenceLinks(body,post.body,{isCurrent:linksCurrent,open:(reference,event)=>{const anchor=event.currentTarget;return openSharedContentReference(reference.href,()=>linksCurrent()&&body.isConnected&&body.contains(anchor),event);},compact:true,openUrl:(href,event)=>{const hubHost=/^(hub\.jkamma\.com|localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(href).hostname);const outside=event?.ctrlKey||event?.metaKey||event?.shiftKey||event?.button===1;const go=()=>outside?void invoke("open_external",{url:href}).catch(()=>undefined):void enterBrowser(href);if(hubHost)return void invoke("open_external",{url:href}).catch(()=>undefined);confirmLeave(document,event?.currentTarget,href,{open:go,hubHosts:["hub.jkamma.com"]});}});
    decoratePostLinks(body);
  };
  paintBody();

  // 画像とタグも投稿の中身。落とすとWebと違う投稿が見える。
  let images = null;
  if (post.images?.length) {
    // 1〜4 枚の格子（3 枚は左の 1 枚を縦に通す）。押すと拡大表示（Esc で閉じる、←→ で送る）。
    const shown = post.images.slice(0, 4);
    images = document.createElement("div");
    images.className = `post-images post-images--${shown.length}`;
    shown.forEach((image, index) => {
      const img = document.createElement("img");
      hubAsset(img, image.url);
      img.alt = image.altText || "";
      img.loading = "lazy";
      img.decoding = "async";
      if (image.width > 0 && image.height > 0) { img.width = image.width; img.height = image.height; }
      img.tabIndex = 0;
      img.setAttribute("role", "button");
      img.setAttribute("aria-label", image.altText ? `画像を拡大：${image.altText}` : `画像を拡大（${index + 1}/${shown.length}）`);
      const open = (event) => { event.stopPropagation(); openMediaLightbox(shown, index, img); };
      img.onclick = open;
      img.onkeydown = (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(event); } };
      images.append(img);
    });
  }
  let tags = null;
  const visibleTags = (post.tags ?? []).filter((tag) => !["public", "followers"].includes(tag.toLowerCase()));
  if (visibleTags.length) {
    tags = document.createElement("p");
    tags.className = "post-tags";
    for (const tag of visibleTags) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "post-tag";
      chip.textContent = `#${tag}`;
      chip.onclick = (event) => { event.stopPropagation(); void openHubPath(`/v2/tag/${encodeURIComponent(tag)}`); };
      tags.append(chip);
    }
  }

  // 投稿カードの5つの操作。反応は /api/client/* 経由で本人の
  // 状態を実際に書き換える——飾りの数字だけ並べた偽物にはしない。
  const state = {
    liked: post.likedByViewer === true,
    likeCount: post.likeCount ?? 0,
    bookmarked: post.bookmarkedByViewer === true,
    repostId: post.viewerRepostId ?? null,
    repostCount: post.repostCount ?? 0,
    replyCount: post.replyCount ?? 0,
    pending: false,
  };
  const actions = document.createElement("div");
  actions.className = "post-actions";
  const actionButton = (iconName, label, filled = false) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "post-action";
    button.innerHTML = `${icon(iconName, filled)}<b class="post-action-count"></b>`;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.onclick = (event) => event.stopPropagation();
    return button;
  };
  const replyBtn = actionButton("reply", "返信");
  const repostBtn = actionButton("repost", "リポスト");
  const repostWrap = document.createElement("div");
  repostWrap.className = "post-repost-wrap";
  const repostMenu = document.createElement("div");
  repostMenu.className = "post-repost-menu";
  repostMenu.setAttribute("role", "menu");
  repostMenu.hidden = true;
  const repostOption = document.createElement("button");
  repostOption.type = "button";
  repostOption.setAttribute("role", "menuitem");
  const quoteOption = document.createElement("button");
  quoteOption.type = "button";
  quoteOption.setAttribute("role", "menuitem");
  quoteOption.textContent = "引用";
  repostMenu.append(repostOption, quoteOption);
  repostWrap.append(repostBtn, repostMenu);
  const likeBtn = actionButton("heart", "いいね", state.liked);
  const bookmarkBtn = actionButton("bookmark", "ブックマーク", state.bookmarked);
  const shareBtn = actionButton("share", "共有");
  // 2026-11-05 所有者「インスタグラムの並びの方がいいかも」：左に いいね・返信・リポスト・共有、右端に保存。
  actions.append(likeBtn, replyBtn, repostWrap, shareBtn, bookmarkBtn);
  // 並びは 本文 → 画像 → 引用・リポスト元の札（札は本文の後ろ）。
  content.append(head);
  // 返信の行の「返信先 @handle」。ハブが親のハンドルを付けたときだけ（親が非表示・匿名なら付かない）。
  const replyToHandle = post.replyToPostId && typeof post.replyToHandle === "string" ? post.replyToHandle : "";
  if (replyToHandle) {
    const replyTo = document.createElement("p");
    replyTo.className = "post-reply-to";
    replyTo.append("返信先 ");
    const target = document.createElement("a");
    target.href = "#";
    target.textContent = `@${replyToHandle}`;
    target.onclick = (event) => { event.preventDefault(); event.stopPropagation(); void openHubPath(`/v2/profile/${encodeURIComponent(replyToHandle)}`); };
    replyTo.append(target);
    content.append(replyTo);
  }
  content.append(body);
  addBaitRow(document, body, post.body);
  if (images) content.append(images);
  if (referenced) content.append(referenced);
  // 2026-11-05 所有者「普通のポストにタグが出るのって邪魔じゃね、三日前とかの横に」：タグは本文の下ではなく頭の行の時刻の横。
  if (tags) head.append(tags);
  // 投稿詳細の主役だけ、日時の全体と反応の数を本文の下に出す（Web の投稿詳細と同じ）。
  let detailCounts = null;
  if (primaryDetail) {
    const at = new Date(post.createdAt);
    if (Number.isFinite(at.getTime())) {
      const stamp = document.createElement("p");
      stamp.className = "post-stamp";
      const time = document.createElement("time");
      time.dateTime = at.toISOString();
      time.textContent = `${new Intl.DateTimeFormat("ja-JP", { hour: "numeric", minute: "2-digit" }).format(at)} · ${new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long", day: "numeric" }).format(at)}`;
      stamp.append(time);
      content.append(stamp);
    }
    detailCounts = document.createElement("p");
    detailCounts.className = "post-counts";
    content.append(detailCounts);
  }
  content.append(actions);
  {
    const translateHost = document.createElement("span");
    translateHost.className = "local-translate-host";
    translateHost.onclick = (event) => event.stopPropagation();
    actions.insertBefore(translateHost, bookmarkBtn);
    attachTranslateAction({ doc: document, host: translateHost, body, translator: localTranslator,
      item: { id: post.id, revision: post.updatedAt ?? post.editedAt ?? "", type: "social_post", isPublic: post.audience === "public", sourceLang: post.language || null },
      getText: () => post.body, restore: () => paintBody() });
  }

  const paintActions = () => {
    if (detailCounts) {
      const parts = [[state.repostCount, "リポスト"], [state.likeCount, "いいね"], [state.bookmarked ? 1 : 0, ""]].filter(([n, label]) => n > 0 && label);
      detailCounts.replaceChildren(...parts.map(([n, label]) => { const span = document.createElement("span"); const b = document.createElement("b"); b.textContent = Number(n).toLocaleString("ja-JP"); span.append(b, ` ${label}`); return span; }));
      detailCounts.hidden = !parts.length;
    }
    replyBtn.querySelector(".post-action-count").textContent = state.replyCount || "";
    repostBtn.querySelector(".post-action-count").textContent = state.repostCount || "";
    repostBtn.classList.toggle("is-reposted", Boolean(state.repostId));
    repostBtn.querySelector("svg").outerHTML = icon("repost");
    const repostLabel = state.repostId ? "リポストを取り消す" : "リポスト";
    repostBtn.title = repostLabel;
    repostBtn.setAttribute("aria-label", "リポストの操作");
    repostOption.textContent = repostLabel;
    likeBtn.querySelector(".post-action-count").textContent = state.likeCount || "";
    likeBtn.classList.toggle("is-liked", state.liked);
    likeBtn.querySelector("svg").outerHTML = icon("heart", state.liked);
    bookmarkBtn.classList.toggle("is-saved", state.bookmarked);
    bookmarkBtn.querySelector("svg").outerHTML = icon("bookmark", state.bookmarked);
    // いいね・リポスト・保存は送信中も押せる（Web §4.2）。連打は最後の状態だけを送る。
  };
  const failAction = (error) => {
    card.dataset.actionError = friendlyError(error);
    card.classList.add("action-error");
    setTimeout(() => card.classList.remove("action-error"), 4000);
    state.pending = false;
    paintActions();
  };
  // 先に画面を反転させて、失敗したら直前の状態へ戻す（楽観更新）。
  // run は invoke の失敗を受けて pending を下ろす。戻り値で成否を返すので、
  // 呼び側は失敗時にスナップショットへ戻すだけでよい。
  const run = async (fn) => {
    state.pending = true;
    paintActions();
    try {
      await fn();
      state.pending = false;
      paintActions();
      return true;
    } catch (error) {
      failAction(error);
      return false;
    }
  };
  // カード本体を押すとアプリ内の投稿詳細へ。祖先・返信・操作は
  // ネイティブの詳細画面が本実装。
  const openPost = onOpen ? () => void onOpen() : () => void openDetail("post", [post.id], { title: "投稿" });

  // 画面は先に反転し、送信は1本ずつ。送信中に押されたら最後の状態だけを送る（Web §4.2）。
  const likeSync = { sent: state.liked, busy: false };
  const saveSync = { sent: state.bookmarked, busy: false };
  const flushLike = async () => {
    if (likeSync.busy) return;
    likeSync.busy = true;
    try {
      while (state.liked !== likeSync.sent) {
        const want = state.liked;
        try {
          const result = await invoke("hub_client_action", { action: want ? "like" : "unlike", target: post.id });
          likeSync.sent = want;
          const summary = result?.summary;
          // サーバの summary が着たら確定する。ただし送信中にもう一度押されていたら、その押下を優先する。
          if (summary && state.liked === want) {
            state.liked = summary.viewerReaction === "like";
            likeSync.sent = state.liked;
            if (typeof summary.likeCount === "number") state.likeCount = summary.likeCount;
            if (typeof summary.bookmarked === "boolean" && !saveSync.busy) { state.bookmarked = summary.bookmarked; saveSync.sent = summary.bookmarked; }
          }
          paintActions();
        } catch (error) {
          state.likeCount = Math.max(0, state.likeCount - (state.liked ? 1 : 0) + (likeSync.sent ? 1 : 0));
          state.liked = likeSync.sent;
          paintActions();
          failAction(error);
          return;
        }
      }
    } finally { likeSync.busy = false; }
  };
  const flushSave = async () => {
    if (saveSync.busy) return;
    saveSync.busy = true;
    try {
      while (state.bookmarked !== saveSync.sent) {
        const want = state.bookmarked;
        try {
          await invoke("hub_client_action", { action: want ? "bookmark" : "unbookmark", target: post.id });
          saveSync.sent = want;
        } catch (error) {
          state.bookmarked = saveSync.sent;
          paintActions();
          failAction(error);
          return;
        }
      }
    } finally { saveSync.busy = false; }
  };
  likeBtn.onclick = (event) => {
    event.stopPropagation();
    state.liked = !state.liked;
    state.likeCount = Math.max(0, state.likeCount + (state.liked ? 1 : -1));
    paintActions();
    void flushLike();
  };
  const closeRepostMenu = () => {
    repostMenu.hidden = true;
    repostBtn.setAttribute("aria-expanded", "false");
  };
  repostBtn.setAttribute("aria-haspopup", "menu");
  repostBtn.setAttribute("aria-expanded", "false");
  repostBtn.onclick = (event) => {
    event.stopPropagation();
    repostMenu.hidden = !repostMenu.hidden;
    repostBtn.setAttribute("aria-expanded", String(!repostMenu.hidden));
    if (!repostMenu.hidden) repostOption.focus();
  };
  repostMenu.onclick = (event) => event.stopPropagation();
  repostOption.onclick = (event) => {
    event.stopPropagation();
    closeRepostMenu();
    if (state.pending) return;
    const before = { repostId: state.repostId, repostCount: state.repostCount };
    if (state.repostId) {
      state.repostId = null;
      state.repostCount = Math.max(0, before.repostCount - 1);
      void run(() => invoke("hub_client_action", { action: "delete_post", target: before.repostId }))
        .then((ok) => { if (!ok) { Object.assign(state, before); paintActions(); } });
    } else {
      state.repostCount = before.repostCount + 1;
      void run(async () => {
        const result = await invoke("hub_client_action", { action: "repost", target: post.id });
        if (result?.post?.id) state.repostId = result.post.id;
      }).then((ok) => { if (!ok) { Object.assign(state, before); paintActions(); } });
    }
  };
  bookmarkBtn.onclick = (event) => {
    event.stopPropagation();
    state.bookmarked = !state.bookmarked;
    paintActions();
    void flushSave();
  };
  shareBtn.onclick = async (event) => {
    event.stopPropagation();
    const origin = hubOrigin ?? (await invoke("hub_origin").catch(() => null));
    const url = origin ? `${origin}/v2/posts/${encodeURIComponent(post.id)}` : "";
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      shareBtn.classList.add("is-done");
      setTimeout(() => shareBtn.classList.remove("is-done"), 1600);
    } catch {
      // コピーが通らない環境では既定ブラウザで投稿ページを開く——行き先は同じ。
      await invoke("open_external", { url }).catch(() => undefined);
    }
  };

  const quoteBox = document.createElement("form");
  quoteBox.className = "post-quote-compose";
  quoteBox.hidden = true;
  quoteBox.innerHTML = `<label class="post-quote-prompt">コメントを付けて引用<textarea maxlength="500" rows="3" placeholder="コメントを書く"></textarea></label><div class="post-quote-target"><strong></strong><p></p></div><div class="post-quote-bar"><span class="post-quote-note" aria-live="polite"></span><button class="ghost post-quote-cancel" type="button">キャンセル</button><button class="approve post-quote-submit" type="submit" disabled>引用して投稿</button></div>`;
  quoteBox.querySelector(".post-quote-target strong").textContent = `${post.authorName || "（名無し）"}${post.authorHandle ? ` @${post.authorHandle}` : ""}`;
  quoteBox.querySelector(".post-quote-target p").textContent = post.body || (post.referenced ? `${post.referenced.title || "元の投稿"}: ${post.referenced.body || "本文なし"}` : post.images?.length ? "画像を含む投稿" : "本文のない投稿");
  const quoteText = quoteBox.querySelector("textarea");
  const quoteSubmit = quoteBox.querySelector(".post-quote-submit");
  const quoteNote = quoteBox.querySelector(".post-quote-note");
  const quoteStatus = document.createElement("p");
  quoteStatus.className = "post-quote-status";
  quoteStatus.setAttribute("role", "status");
  quoteText.oninput = () => { quoteSubmit.disabled = !quoteText.value.trim() || state.pending; quoteNote.textContent = ""; };
  quoteBox.onclick = (event) => event.stopPropagation();
  quoteBox.querySelector(".post-quote-cancel").onclick = () => {
    quoteBox.hidden = true;
    quoteText.value = "";
    quoteNote.textContent = "";
    quoteSubmit.disabled = true;
    repostBtn.focus();
  };
  quoteBox.onsubmit = async (event) => {
    event.preventDefault();
    const comment = quoteText.value.trim();
    if (!comment || state.pending) return;
    state.pending = true;
    quoteSubmit.disabled = true;
    paintActions();
    try {
      await invoke("hub_client_action", { action: "quote_post", target: post.id, text: comment });
      state.repostCount += 1;
      quoteBox.hidden = true;
      quoteText.value = "";
      quoteStatus.textContent = "引用を投稿しました。";
      setTimeout(() => { quoteStatus.textContent = ""; }, 4000);
    } catch (error) {
      quoteNote.textContent = friendlyError(error);
    } finally {
      state.pending = false;
      quoteSubmit.disabled = !quoteText.value.trim();
      paintActions();
    }
  };
  quoteOption.onclick = (event) => {
    event.stopPropagation();
    closeRepostMenu();
    quoteBox.hidden = false;
    replyBox.hidden = true;
    replyBtn.setAttribute("aria-expanded", "false");
    quoteText.focus();
    quoteBox.scrollIntoView({ block: "center" });
  };

  // 返信はこの場で書ける。送信すると投稿として立ち、返信数に足す。
  const replyBox = document.createElement("form");
  replyBox.className = "post-reply";
  replyBox.hidden = replyProfile === null;
  replyBox.innerHTML = `<textarea maxlength="500" rows="2" placeholder="返信を入力"></textarea><div class="post-reply-bar"><button type="submit" class="approve" disabled>返信</button></div>`;
  const replyText = replyBox.querySelector("textarea");
  if (replyProfile !== null) {
    replyText.placeholder = `${replyProfile}として返信`;
    replyText.setAttribute("aria-label", replyText.placeholder);
  }
  replyBtn.setAttribute("aria-expanded", String(!replyBox.hidden));
  const replySubmit = replyBox.querySelector("button");
  replyText.oninput = () => { replySubmit.disabled = !replyText.value.trim(); };
  replyBox.onclick = (event) => event.stopPropagation();
  replyBox.onsubmit = async (event) => {
    event.preventDefault();
    const text = replyText.value.trim();
    if (!text) return;
    replySubmit.disabled = true;
    try {
      await invoke("hub_client_action", { action: "reply", target: post.id, text });
      replyText.value = "";
      replyBox.hidden = true;
      replyBtn.setAttribute("aria-expanded", "false");
      state.replyCount += 1;
      paintActions();
    } catch (error) {
      failAction(error);
      replySubmit.disabled = false;
    }
  };
  replyBtn.onclick = (event) => {
    event.stopPropagation();
    replyBox.hidden = !replyBox.hidden;
    replyBtn.setAttribute("aria-expanded", String(!replyBox.hidden));
    if (!replyBox.hidden) { quoteBox.hidden = true; closeRepostMenu(); replyText.focus(); }
  };
  content.append(quoteStatus, quoteBox, replyBox);
  card.append(avatar, content);
  paintActions();
  if (!primaryDetail) {
    card.onclick = openPost;
    card.onkeydown = (event) => { if (event.key === "Enter" && event.target === card) openPost(); };
  }
  card.hubPostActions = {
    open: openPost,
    reply: () => replyBtn.click(),
    repost: () => repostBtn.click(),
    bookmark: () => bookmarkBtn.click(),
    copyLink: () => shareBtn.click(),
    openWeb: async () => {
      const origin = hubOrigin ?? (await invoke("hub_origin").catch(() => null));
      if (origin) await invoke("open_external", { url: `${origin}/v2/posts/${encodeURIComponent(post.id)}` }).catch(() => undefined);
    },
  };
  return card;
}

// 投稿の右クリック（DESKTOP_SPEC §2.8）。リンク・画像・入力欄の上は共通の項目に任せる。
window.hubContextMenu?.register?.((target) => {
  const row = target?.closest?.(".post[data-post-id]");
  const actions = row?.hubPostActions;
  if (!actions || target.closest("a[href], img, input, textarea, select")) return null;
  const items = [
    { label: "開く", run: actions.open },
    { label: "返信", keys: "R", run: actions.reply },
    { label: "リポスト", run: actions.repost },
    { label: "保存", keys: "B", run: actions.bookmark },
    "-",
    { label: "リンクをコピー", run: actions.copyLink },
    { label: "Webで開く", run: actions.openWeb },
  ];
  const own = row.hubPostEntries ?? [];
  if (own.length) { items.push("-"); for (const [label, run] of own) items.push({ label, run }); }
  return items;
});

// 曲の「⋯」メニュー（右クリックでも同じ項目）。
if (window.hubContextMenu) registerMusicMenu(window.hubContextMenu, musicMenuDeps, { document });

// 投稿本文の中のリンクは、題だけの札に整える。Hub 内の作品は「記号＋種別＋題」、外部は域名＋道筋。
// 題そのものは本文に無い（IDだけ）ので、IDの読みやすい形を出す。絵は取らない（外部の画像は読まない）。
function decoratePostLinks(body) {
  const kindIcon = { 音楽: "music", 動画: "video", 記事: "doc", 投稿: "bubble", 研究: "doc", 商品: "wallet" };
  for (const link of body.querySelectorAll("a.content-reference-link")) {
    if (link.dataset.decorated) continue;
    link.dataset.decorated = "1";
    const text = link.textContent || "";
    const external = link.classList.contains("external");
    const split = text.indexOf(": ");
    const kind = !external && split > 0 ? text.slice(0, split) : "";
    const rest = !external && split > 0 ? text.slice(split + 2) : text;
    const tile = document.createElement("span");
    tile.className = "ref-tile";
    tile.innerHTML = icon(external ? "share" : (kindIcon[kind] ?? "share"));
    const copy = document.createElement("span");
    copy.className = "ref-copy";
    const title = document.createElement("span");
    title.className = "ref-title";
    title.textContent = external ? rest : rest.replace(/[-_]+/g, " ");
    const meta = document.createElement("span");
    meta.className = "ref-meta";
    meta.textContent = external ? "外部サイト" : (kind || "Hub");
    copy.append(title, meta);
    link.replaceChildren(tile, copy);
    link.classList.add("ref-card");
    // 札の前後の改行は余白で足りる。空行を残すと札の上に 1 行ぶん空く。
    // 本文の文字は変えない（textContent は元のまま）。空白だけの文字ノードを、隠す枠で包む。
    for (const direction of ["previousSibling", "nextSibling"]) {
      let node = link[direction];
      while (node?.nodeType === 3 && !node.textContent.trim()) {
        const next = node[direction];
        const gap = document.createElement("span");
        gap.className = "ref-gap";
        node.replaceWith(gap);
        gap.append(node);
        node = next;
      }
    }
  }
}

// 検索結果・ブックマーク等で来たHub内リンクをネイティブ詳細へ写す。
// 対応する面があるものだけ——無いものは呼び側がブラウザへ逃がす。

// 読み込み中は文ではなく投稿型の骨を置く——件数表示は出さない
// （何件あるかではなく流れを見る場なので、数字は視線を逸らすだけ）。
function skeletonPost() {
  const card = document.createElement("div");
  card.className = "post skeleton-post";
  const avatar = document.createElement("span");
  avatar.className = "post-avatar skeleton-block";
  const content = document.createElement("div");
  content.className = "post-content";
  for (const w of ["skeleton-line w30", "skeleton-line", "skeleton-line w70"]) {
    const line = document.createElement("div");
    line.className = `skeleton-block ${w}`;
    content.append(line);
  }
  card.append(avatar, content);
  return card;
}

// 続きの取り方・新着の知らせ方・未読の区切りは、全部Web版と同じ考え方。
const feedPage = { offset: 0, cursor: null, hasMore: false, loading: false };
let feedLoadRevision = 0;
const feedMore = document.querySelector("#feed-more");
const feedFresh = document.querySelector("#feed-fresh");
const feedFreshShow = document.querySelector("#feed-fresh-show");
let feedFreshItems = [];

function captureSocialScene(){
 const entry=toolbarTrail[toolbarTrailIndex];if(currentView!=="feed"||entry?.view!=="feed")return;
 entry.socialScene={mode:socialMode,filter:socialFilter,scope:socialScope,feedScope,feedListId,scroll:viewScroller()?.scrollTop??0,account:homeAccountEpoch,snapshot:socialMode==="mixed"?socialStreamController?.navigation():null};
}
async function selectSocial(mode,filter,scope){
 captureSocialScene();socialMode=mode;socialFilter=filter;socialScope=scope;socialWantedScene=null;feedLoadRevision++;socialStreamController?.invalidate();feedRecovery.reset();
 if(currentView!=="feed")await navigateFrom({dataset:{view:"feed",title:"タイムライン"},childNodes:[]});else{renderSidebarContext("feed");await loadFeed();}
}
const socialBar=document.createElement("nav");socialBar.className="social-main-controls";socialBar.setAttribute("aria-label","タイムラインの分類");socialBar.hidden=true;
for(const [filter,label]of [["all","すべて"],["post","投稿"],["thread","スレッド"],["community","コミュニティ"]]){const button=document.createElement("button");button.type="button";button.textContent=label;button.dataset.socialFilter=filter;button.onclick=()=>selectSocial("mixed",filter,socialScope);socialBar.append(button);}
for(const [scope,label]of [["latest","新着"],["following","フォロー中"]]){const button=document.createElement("button");button.type="button";button.textContent=label;button.dataset.socialScope=scope;button.onclick=()=>selectSocial("mixed",socialFilter,scope);socialBar.append(button);}
document.querySelector("#view-feed .page-header").after(socialBar);
function fuseSocialSources(status){
 if(socialMode!=="mixed"||currentView!=="feed")return;const list=socialStreamController?.element.querySelector(".social-stream-list");if(!list)return;
 for(const node of list.querySelectorAll("[data-social-external]"))node.remove();
 const rows=[...list.children].map((node,index)=>({node,date:Date.parse(status.items[index]?.createdAt)||0}));
 for(const item of socialExternal){const card=item.card();if(card){card.dataset.socialExternal="true";rows.push({node:card,date:item.date});}}
 rows.sort((a,b)=>b.date-a.date);list.append(...rows.map(row=>row.node));
 for(const button of socialBar.children)button.setAttribute("aria-current",button.dataset.socialFilter?button.dataset.socialFilter===socialFilter?"page":"false":button.dataset.socialScope===socialScope?"page":"false");
}
socialStreamController=createSocialStream({document,invoke,getContext:()=>socialVerifiedContext?{...socialVerifiedContext,filter:socialFilter,scope:socialScope}:null,isCurrent:()=>currentView==="feed"&&socialMode==="mixed",renderPost:postCard,formatTime:relTime,onOpenThread:item=>openDetail("thread",[item.id],{title:item.title}),onOpenCommunityPost:item=>openDetail("community",[item.communityId],{title:item.communityName,targetSelection:{messageId:item.id}}),onStatus:fuseSocialSources});
async function loadMixedSocialFeed(){
 mixedPublicationUpdates?.dispose();mixedPublicationUpdates=null;
 if(socialWantedScene){socialExternal=[];socialStreamController.invalidate();}
 const revision=++feedLoadRevision,snapshot=homeAccountSnapshot(),filter=socialFilter,scope=socialScope;
 const current=()=>revision===feedLoadRevision&&homeAccountCurrent(snapshot)&&currentView==="feed"&&socialMode==="mixed"&&filter===socialFilter&&scope===socialScope;
 feedMore.hidden=feedFresh.hidden=true;feed.state.textContent="タイムラインを読み込んでいます…";
 try{
  await hubNetwork.ready;if(!current())return;const captured=await captureHomeScope(snapshot);if(!captured||!current())throw Error("social_stream_auth_unavailable");
  let viewer=null;if(snapshot.state==="registered"){const me=await invoke("hub_client",{name:"me_summary"});if(!current()||!validHomeProfileId(me?.profile?.id)||!await confirmHomeScope(captured))throw Error("social_stream_scope_changed");viewer=me.profile.id;paintComposerAvatar(me.profile);}
  if(!current())return;socialVerifiedContext={origin:captured.origin,viewerId:viewer,generation:snapshot.epoch};socialExternal=[];
  if(!feed.list.contains(socialStreamController.element))feed.list.replaceChildren(socialStreamController.element);
  if(scope==='latest'&&['all','post'].includes(filter)&&hubNetwork.includePrimary('post'))mixedPublicationUpdates=createPublicationUpdates(feed.list,{invoke,isCurrent:current,origin:captured.origin,openLink:(href,title)=>openHubPath(href,title,current)});
  const scene=socialWantedScene;socialWantedScene=null;
  const matching=scene?.account===homeAccountEpoch&&scene.mode==="mixed"&&scene.filter===filter&&scene.scope===scope;
  const restorePosition=()=>{if(current()&&matching&&viewScroller())viewScroller().scrollTop=Number.isFinite(scene.scroll)&&scene.scroll>=0?scene.scroll:0;};
  if(hubNetwork.includePrimary("post")){const restored=matching?await socialStreamController.restore(scene.snapshot,restorePosition):null;if(restored===null)await socialStreamController.load();}else socialStreamController.invalidate();
  if(!current())return;feed.state.textContent="";
  const connected=scope==="following"||filter!=="all"&&filter!=="post"?[]:await hubNetwork.load("post");if(!current())return;
  socialExternal=connected.map(item=>({date:Date.parse(item.updatedAt)||0,card:()=>hubNetwork.card(item)}));
  if(scope!=="following"&&(filter==="all"||filter==="post")&&hubNetwork.includePrimary("post")){
   const distributed=await invoke("hub_resource",{resource:"distributed_posts",query:""}).catch(()=>null);if(!current())return;
   socialExternal.push(...(distributed?.resources??[]).map(item=>({date:Date.parse(item.publishedAt)||0,card:()=>distributedResourceCard(item)})));
   const federated=await invoke("hub_client",{name:"federated_feed"}).catch(()=>null);if(!current())return;
   socialExternal.push(...(federated?.items??[]).map(item=>({date:Date.parse(item.published)||0,card:()=>activityPubCard(item)})));
  }
  fuseSocialSources(socialStreamController.status());
 }catch(error){if(!current())return;socialVerifiedContext=null;socialStreamController.invalidate();feed.state.textContent=friendlyError(error);}
}
for(const name of ["hub-account-changed","hub-origin-changed"])window.addEventListener(name,()=>{socialVerifiedContext=null;socialStreamController.invalidate();socialExternal=[];socialWantedScene=null;for(const entry of toolbarTrail)delete entry.socialScene;delete detailReturn.socialScene;if(name==="hub-origin-changed"&&currentView==="feed")void loadFeed();});

// 前回この並びで見た先頭を覚え、今回の一覧でその直前に線を引く（Web版と同じ）。
const feedSeenKey = () => `hub.desktop.feed-seen.${feedScope}`;
let feedSeenId = null;

function unreadLine() {
  const line = document.createElement("p");
  line.className = "feed-unread-line";
  const text = document.createElement("span");
  text.textContent = "ここまで未読";
  line.append(text);
  return line;
}

function renderFeedPosts(posts, { append = false, distributed = [], activityPub = [], network = [] } = {}) {
  const nodes = [];
  const remote = [
    ...network.map(item=>({date:Date.parse(item.updatedAt)||0,card:hubNetwork.card(item)})),
    ...distributed.map((item) => ({ date: Date.parse(item.publishedAt) || 0, card: distributedResourceCard(item) })),
    ...activityPub.map((item) => ({ date: Date.parse(item.published) || 0, card: activityPubCard(item) })),
  ].filter((item) => item.card).sort((a, b) => b.date - a.date).map((item) => item.card);
  const boundary = feedSeenId ? posts.findIndex((item) => item.id === feedSeenId) : -1;
  const threadRows = [];
  const flushThreadRows = () => { applyThreadLinks(threadRows.splice(0), { selfOnly: true }); };
  posts.forEach((post, index) => {
    if (!append && feedScope !== "recommended" && boundary > 0 && index === boundary) { flushThreadRows(); nodes.push(unreadLine()); }
    const node = postCard(post);
    nodes.push(node);
    threadRows.push({ post, node });
    if (index % 3 === 2 && remote.length) { flushThreadRows(); nodes.push(remote.shift()); }
  });
  flushThreadRows();
  nodes.push(...remote);
  if (append) feed.list.append(...nodes);
  else feed.list.replaceChildren(...nodes);
}

const feedAccountKey=()=>JSON.stringify([desktopAccount.state,desktopAccount.deviceId]);
let feedRecoveryAccount='',feedVisibleKey='',feedRecoveryView='',feedSnapshot=null;
const feedViewKey=()=>JSON.stringify([feedAccountKey(),feedScope,feedListId,hubNetwork.context('post')]);
const feedRecovery=createReadRecovery({retry:()=>loadFeed({automatic:true}),active:()=>currentView==='feed'&&feedLoadFailed&&feedRecoveryAccount===feedAccountKey()&&feedRecoveryView===feedViewKey()});
window.addEventListener('pagehide',()=>{feedLoadRevision++;feedRecovery.reset();},{once:true});
window.addEventListener('hub-account-changed',()=>{feedTabLists.epoch=null;feedTabLists.items=[];feedVisibleKey='';feedSnapshot=null;feedLoadRevision++;feedRecovery.reset();feed.list.replaceChildren();if(currentView==='feed')void loadFeed();});
async function loadFeed({automatic=false,observeStartup=false}={}) {
  socialBar.hidden=true;renderFeedTabs();
  mixedPublicationUpdates?.dispose();mixedPublicationUpdates=null;
 if(socialMode==="mixed")return loadMixedSocialFeed();
  if(feedScope==="list")return loadListFeed();
  const observeRead=(name,action)=>observeStartup?controlMetrics.measure(name,action):action();
  let classified=false;
  const markOutcome=name=>{if(observeStartup&&!classified){classified=true;controlMetrics.mark(name);}};
  feedRecoveryAccount=feedAccountKey();
  if(!automatic)feedRecovery.reset();
  const revision = ++feedLoadRevision;
  feedLoadFailed = false;
  const scope = feedScope,key=feedViewKey(),retained=feedVisibleKey===key;
  feedRecoveryView=key;
  const current=()=>revision===feedLoadRevision&&key===feedViewKey();
  feedMore.hidden = true;
  feedFresh.hidden = true;
  feedFreshItems = [];
  feed.state.textContent = retained ? "" : "投稿を読み込んでいます…";
  feed.state.classList.remove("warning");
  if(!retained){feedVisibleKey='';feedSnapshot=null;feed.list.replaceChildren(skeletonPost(), skeletonPost(), skeletonPost());}
  try { feedSeenId = localStorage.getItem(feedSeenKey()); } catch { feedSeenId = null; }
  try {
    await observeRead("feedReadyWait",()=>hubNetwork.ready);
    if(!current()){markOutcome("feedSuperseded");return;}
    const primary=hubNetwork.includePrimary('post');
    const localFeed = primary ? observeRead("feedLocal",()=>settleWithin(invoke("hub_feed", { scope, limit: 20 }))) : Promise.resolve({posts:[],signedIn:false,hasMore:false});
    let initialPosts=[],initialNetwork=[];
    const connectedFeed = scope === "following" ? Promise.resolve([]) : observeRead("feedConnected",()=>hubNetwork.load("post"));
    void connectedFeed.then(items=>{
      if(!current())return;
      initialNetwork=items;
      if(items.length&&!retained)renderFeedPosts(initialPosts,{network:initialNetwork});
    }).catch(()=>undefined);
    void localFeed.then((result) => {
      if (!current() || retained || !result?.posts?.length) return;
      initialPosts=result.posts;
      renderFeedPosts(initialPosts,{network:initialNetwork});
      feed.state.textContent = "ほかのサーバーの投稿を確認しています…";
    }).catch(() => undefined);
    // Account の署名発行を同時に重ねない。公開フィードの結果を待ってから連携投稿を読む。
    const federatedFeed = !primary || scope === "following" ? Promise.resolve({ items: [] })
      : settleWithin(localFeed.catch((error) => {
        if (error === "request_timeout") throw error;
        return null;
      }).then(() => observeRead("feedFederated",()=>invoke("hub_client", { name: "federated_feed" }))), 30_000);
    const [local, external, activityPub, connected, unifiedTimeline] = await Promise.allSettled([
      localFeed,
      !primary || scope === "following" ? Promise.resolve({ resources: [] })
        : observeRead("feedDistributed",()=>settleWithin(invoke("hub_resource", { resource: "distributed_posts", query: "" }))),
      federatedFeed,
      connectedFeed,
      primary ? settleWithin(invoke("hub_detail", { name: "posts_place", ids: ["timeline"] })) : Promise.resolve(null),
    ]);
    const unifiedPosts = unifiedTimeline.status === "fulfilled" && Array.isArray(unifiedTimeline.value?.items) ? unifiedTimeline.value.items.filter(isUnifiedPost) : [];
    if (unifiedTimeline.status === "fulfilled" && unifiedTimeline.value) document.body.dataset.adsAllowed = String(unifiedTimeline.value.adsAllowed !== false);
    if (!current()) {markOutcome("feedSuperseded");return;}
    // 連携投稿（本人のActivityPub）は未接続だと必ず拒否される。公開フィードが読めたなら、それで画面を潰さない。
    const personalDenied = activityPub.status === "rejected" && isReadAccessDenied(activityPub.reason) && (local.status === "fulfilled" || external.status === "fulfilled");
    const failures=[local,external,personalDenied?null:activityPub,connected].flatMap(r=>r?.status==='rejected'?[r.reason]:[]).concat(scope==='following'?[]:hubNetwork.errors('post'));
    const denied=failures.find(isReadAccessDenied);if(denied)throw denied;
    const transient=failures.find(isTransientReadError);
    if(!primary&&failures.length&&!retained)throw failures[0];
    const result = local.status === "fulfilled" ? local.value : retained ? feedSnapshot.result : { posts: [], signedIn: false, hasMore: false };
    const remote = external.status === "fulfilled" && Array.isArray(external.value?.resources)
      ? external.value.resources : retained ? feedSnapshot.remote : [];
    const federated = activityPub.status === "fulfilled" && Array.isArray(activityPub.value?.items)
      ? activityPub.value.items : retained ? feedSnapshot.federated : [];
    const network=connected.status==='fulfilled'?[...connected.value,...(retained?feedSnapshot.network.filter(item=>hubNetwork.failedOrigins('post',true).includes(item.origin)):[])]:retained?feedSnapshot.network:[];
    if (!retained && local.status === "rejected" && !remote.length && !federated.length && !network.length && !unifiedPosts.length) throw local.reason;
    updateSourceSummary("#feed-sources", remote, local.status === "fulfilled",
      federated.filter((item) => activityPubUrl(item)).map((item) => new URL(item.url).hostname));
    renderFeedPosts([...unifiedPosts, ...result.posts], { distributed: remote, activityPub: federated, network });
    if(!failures.length||result.posts.length||remote.length||federated.length||network.length){feedVisibleKey=key;feedSnapshot={result,remote,federated,network};}
    let waiting=false;
    if(!failures.length){feedRecovery.reset();feedVisibleKey=key;}
    else {feedLoadFailed=!!transient;waiting=transient&&feedRecovery.schedule(transient);}
    feed.state.textContent = local.status === "rejected" ? "Hubの投稿を読み込めませんでした。外部投稿を表示しています。"
      : external.status === "rejected" ? "外部投稿の一部を読み込めませんでした。Hubの投稿を表示しています。" : "";
    if(waiting)feed.state.textContent=readWaitText(transient);
    if(retained&&failures.length)feed.state.textContent+=(feed.state.textContent?' ':'一部を更新できませんでした。')+'前回の表示を含んでいます。';
    feedPage.offset = result.nextOffset ?? result.posts.length;
    feedPage.cursor = result.nextCursor ?? null;
    feedPage.hasMore = local.status==="fulfilled"&&result.hasMore === true;
    feedMore.hidden = !feedPage.hasMore;
    if (result.posts.length === 0 && remote.length === 0 && federated.length === 0 && network.length === 0 && unifiedPosts.length === 0) {
      // Web版と同じ文言。フォロー中が空なのは繋がっていないのとは違うので、
      // 未接続のときだけその旨を添える。
      feed.list.replaceChildren(statePanel("bubble",
        feedScope === "following"
          ? (result.signedIn ? "まだフォローしていません" : "サインインが必要です")
          : "まだ投稿がありません",
        // 説明の2文目は置かない（2026-11-04 所有者「字で説明しない」）。未接続だけは次の行動が要るので残す。
        feedScope === "following" && !result.signedIn ? "Desktopを接続すると、フォローした人の投稿がここに並びます。" : ""));
    }
    renderFeedResearchUpdates(feed.list,result.researchUpdates,current);
    if (local.status==="fulfilled"&&result.posts[0]) {
      try { localStorage.setItem(feedSeenKey(), result.posts[0].id); } catch { /* 覚えられなくても線は引ける */ }
    }
    markOutcome("feedApplied");
  } catch (error) {
    if(!current()){markOutcome("feedSuperseded");return;}
    markOutcome("feedFailed");
    feedLoadFailed = !isReadAccessDenied(error);
    feed.state.textContent = "";
    if (isReadAccessDenied(error)) {
      feedVisibleKey='';feedSnapshot=null;feed.list.replaceChildren(connectState());
    } else {
      const waiting=feedRecovery.schedule(error);
      if(retained){feed.state.textContent=(waiting?readWaitText(error):friendlyError(error))+' 前回の表示を残しています。';return;}
      const notice = statePanel(waiting ? "clock" : "alert", waiting?"接続待ち":"読み込めませんでした", waiting?readWaitText(error):friendlyError(error), () => loadFeed());
      notice.classList.add("feed-error");
      feed.list.replaceChildren(notice);
    }
    updateSourceSummary("#feed-sources", [], false);
  }
}
// リストのタブ：Hub の /api/lists/{id}/feed（hub_detail "list_feed"）を読み、投稿は他の並びと同じ投稿カードで描く。
// スレッドの返信は、スレッド名を添えた同じ形のカードにする。
function listFeedItemCards(items) {
  const cards = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.kind === "social" && item.post?.id) {
      const post = item.post;
      cards.push(postCard({ ...post, authorName: post.authorName || post.displayName, authorHandle: post.authorHandle ?? post.handle ?? null, likedByViewer: post.likedByViewer ?? post.viewerReaction === "like", bookmarkedByViewer: post.bookmarkedByViewer ?? post.bookmarked === true, images: post.images ?? [], tags: post.tags ?? [] }));
    } else if (item?.kind === "thread-response" && item.response?.id) {
      const response = item.response;
      cards.push(postCard({
        id: response.id, body: response.body, createdAt: response.createdAt, authorName: response.displayName, authorHandle: response.authorHandle ?? null,
        authorProfileId: response.authorProfileId, avatarUrl: response.authorAvatarUrl ?? null, replyCount: 0, repostCount: 0, likeCount: 0, images: [], tags: [],
        referenced: { label: "スレッド", title: response.threadTitle, body: "", href: `/threads/${encodeURIComponent(response.threadId)}` },
      }));
    }
  }
  return cards;
}
async function loadListFeed() {
  const revision = ++feedLoadRevision, listId = feedListId, key = feedViewKey();
  const current = () => revision === feedLoadRevision && feedScope === "list" && feedListId === listId && key === feedViewKey() && currentView === "feed";
  feedLoadFailed = false;
  feedMore.hidden = feedFresh.hidden = true;
  feed.state.textContent = "";
  feed.list.replaceChildren(skeletonPost(), skeletonPost(), skeletonPost());
  try {
    if (desktopAccount.state !== "registered") { feed.list.replaceChildren(connectState("自分のリストを表示するには、この端末をHubアカウントへ接続してください。")); return; }
    const data = await invoke("hub_detail", { name: "list_feed", ids: [listId] });
    if (!current()) return;
    const cards = listFeedItemCards(data?.items);
    feed.list.replaceChildren(...(cards.length ? cards : [statePanel("bubble", "投稿はありません", "リストに入れた人が投稿すると、ここに並びます。")]));
  } catch (error) {
    if (!current()) return;
    feedLoadFailed = !isReadAccessDenied(error);
    feed.list.replaceChildren(isReadAccessDenied(error) ? connectState() : statePanel("alert", "読み込めませんでした", friendlyError(error), () => loadFeed()));
  }
}
window.addEventListener("focus", () => {
  if (feedLoadFailed && currentView === "feed") void loadFeed();
});
window.addEventListener("online", () => {
  if (feedLoadFailed && currentView === "feed") void loadFeed();
});

async function loadMoreFeed() {
  if (feedScope === "list" || feedPage.loading || !feedPage.hasMore) return;
  feedPage.loading = true;
  feedMore.disabled = true;
  try {
    const result = await invoke("hub_feed", {
      scope: feedScope, limit: 20, offset: feedPage.offset, cursor: feedPage.cursor,
    });
    const known = new Set([...feed.list.querySelectorAll(".post")].map((node) => node.dataset.postId));
    const fresh = result.posts.filter((post) => !known.has(post.id));
    renderFeedPosts(fresh, { append: true });
    feedPage.offset = result.nextOffset ?? feedPage.offset + result.posts.length;
    feedPage.cursor = result.nextCursor ?? null;
    feedPage.hasMore = result.hasMore === true && fresh.length > 0;
    feedMore.hidden = !feedPage.hasMore;
  } catch (error) {
    feed.state.textContent = friendlyError(error);
    feed.state.classList.add("warning");
  }
  feedPage.loading = false;
  feedMore.disabled = false;
}
feedMore.onclick = () => void loadMoreFeed();

// 新着の知らせ（Xと同じ作法）。見えている間だけ60秒ごとに先頭を確かめ、表示中の最新より新しい投稿があれば
// 「新しいポスト（N）」のピルで数だけ告げる。勝手に差し込まず、スクロールも動かさない。押したら先頭へ足して先頭へ戻る。
// 窓や画面が見えない間は止める。タイマーは1本だけ（feed-live.mjs）。
feedLive = createFeedLive({
  document, invoke,
  active: () => currentView === "feed" && socialMode === "legacy" && document.querySelector("#view-feed")?.classList.contains("on") === true,
  scope: () => feedScope,
  token: () => feedLoadRevision + "|" + feedViewKey(),
  shown: () => {
    const ids = new Set([...feed.list.querySelectorAll(".post")].map((node) => node.dataset.postId));
    const newest = Math.max(0, ...(feedSnapshot?.result?.posts ?? []).map((post) => Date.parse(post.createdAt) || 0));
    return { ids, newest };
  },
  getItems: () => feedFreshItems, setItems: (items) => { feedFreshItems = items; },
  pill: feedFresh, pillButton: feedFreshShow,
  render: (posts) => {
    const cards = posts.map(postCard);
    feed.list.prepend(...cards);
    if (feedSnapshot?.result?.posts) feedSnapshot.result.posts = [...posts, ...feedSnapshot.result.posts];
  },
  scrollTop: () => viewScroller()?.scrollTo({ top: 0, behavior: "auto" }),
  reload: () => loadFeed(),
});
feedLive.sync();

// 続きは下端の手前 600px で自動で読む（Web §4.2）。「もっと見る」は押せるまま残すが、探さなくてよい。
{
  const watched = new WeakSet();
  const near = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const button = entry.target;
      if (!entry.isIntersecting || button.hidden || button.disabled || !document.querySelector("#view-feed")?.classList.contains("on")) continue;
      button.click();
      // 追加分が短くて、まだ手前にあるときも次を読めるよう、少し置いて見張り直す。
      setTimeout(() => { near.unobserve(button); near.observe(button); }, 1000);
    }
  }, { rootMargin: "0px 0px 600px 0px" });
  const watch = () => {
    for (const button of [feedMore, ...feed.list.querySelectorAll(".social-stream .actions button:last-child")]) {
      if (!watched.has(button)) { watched.add(button); near.observe(button); }
    }
  };
  let queued = false;
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; watch(); syncUpdates(); }); } };
  // 「作品・研究の更新」は 1 行の帯に畳み、押すと開く（DESKTOP_SPEC §3.1）。
  const syncUpdates = () => {
    for (const section of feed.list.querySelectorAll(".research-feed-updates")) {
      section.dataset.count = String(section.querySelectorAll(".feed-update-row").length);
      section.hidden = section.dataset.count === "0";
      const head = section.querySelector("h3");
      if (head) head.dataset.countText = section.dataset.count + "件";
      if (!head || head.dataset.bound) continue;
      head.dataset.bound = "1";
      head.tabIndex = 0;
      head.setAttribute("role", "button");
      head.setAttribute("aria-expanded", "false");
      const toggle = () => { const open = section.classList.toggle("is-open"); head.setAttribute("aria-expanded", String(open)); };
      head.addEventListener("click", toggle);
      head.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(); } });
    }
  };
  new MutationObserver(queue).observe(feed.list, { childList: true, subtree: true });
  queue();
}

document.querySelector("#video-refresh").onclick = () => loadCatalog("videos");
document.querySelector("#music-refresh").onclick = () => { if (musicTab === "catalog") return loadCatalog("music"); void musicHome?.reload(); return searchMusic(true); };
document.querySelector("#notifications-refresh").onclick = () => loadNotifications();
document.querySelector("#messages-refresh").onclick = () => loadMessages();
document.querySelector("#wallet-refresh").onclick = () => loadCatalog("wallet");
document.querySelector("#compute-refresh").onclick = () => loadCompute();

// どの画面でも同じキーが効くように。
document.addEventListener("keydown", (event) => {
  // Ctrl/Cmd+Enter でフォームを送る——長文のtextareaだけ。
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && event.target instanceof HTMLTextAreaElement) {
    const form = event.target.closest("form");
    if (form) { event.preventDefault(); form.requestSubmit(); }
    return;
  }
  // Esc で詳細から一覧へ戻る。開いているダイアログがあるときは
  // ブラウザ標準の「ダイアログを閉じる」に任せる（ここでは動かない）。
  if (event.key === "Escape" && !document.querySelector("dialog[open]") && currentView === "detail") {
    void detailBack();
  }
});

// ダイアログの外側（背景）クリックで閉じる。ウォレット確認だけは
// 「閉じる＝拒否」でフェイルクローズ。
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    if (dialog.id === "wallet-confirm-dialog") {
      document.querySelector("#wallet-confirm-deny")?.click();
    } else {
      dialog.close();
    }
  });
}

// タイムラインのタブ：おすすめ・フォロー中・人気、続けて自分で作ったリスト（1つにつき1タブ）。
// 選んだタブは端末に覚える。リストは Hub の /api/lists を hub_client("lists") で読む。
const FEED_TAB_KEY = "hub.desktop.feedTab.v1";
const FEED_BASE_TABS = [["recommended", "おすすめ"], ["following", "フォロー中"], ["popular", "人気"]];
const FEED_LIST_ID = /^[A-Za-z0-9_-]{1,80}$/;
const feedTabLists = { epoch: null, items: [], loading: false };
let feedListId = null;
const feedTabKey = () => feedScope === "list" && feedListId ? `list:${feedListId}` : feedScope;
try {
  const saved = localStorage.getItem(FEED_TAB_KEY) ?? "";
  if (FEED_BASE_TABS.some(([key]) => key === saved)) feedScope = saved;
  else if (saved.startsWith("list:") && FEED_LIST_ID.test(saved.slice(5))) { feedScope = "list"; feedListId = saved.slice(5); }
} catch { /* 覚えていなければ既定のまま */ }
function loadFeedTabLists() {
  if (desktopAccount.state !== "registered" || feedTabLists.loading || feedTabLists.epoch === homeAccountEpoch) return;
  const epoch = homeAccountEpoch;
  feedTabLists.loading = true;
  void Promise.resolve(invoke("hub_client", { name: "lists" })).then((data) => {
    if (epoch !== homeAccountEpoch) return;
    feedTabLists.items = Array.isArray(data?.lists) ? data.lists.filter((list) => FEED_LIST_ID.test(String(list?.id ?? "")) && typeof list.name === "string" && list.name.trim()) : [];
  }).catch(() => { feedTabLists.items = []; }).finally(() => {
    feedTabLists.loading = false;
    if (epoch !== homeAccountEpoch) return;
    feedTabLists.epoch = epoch;
    // 覚えていたリストが無くなっていたら、おすすめへ戻す。
    if (feedScope === "list" && !feedTabLists.items.some((list) => list.id === feedListId)) {
      feedScope = "recommended"; feedListId = null;
      try { localStorage.setItem(FEED_TAB_KEY, "recommended"); } catch {}
      if (currentView === "feed" && socialMode === "legacy") void loadFeed();
    }
    renderFeedTabs();
    // 種類の行は左の列（フィードの木）にあるので、リストが読めたら列も描き直す。
    if (currentView === "feed" || sidebarFeedTreeOwned) renderSidebarContext(currentView);
  });
}
// 種類の行（おすすめ・フォロー中・人気・自分のリスト）。左の列のフィードの木が描く（2026-11-06 所有者）。
function feedTabEntries() {
  const active = socialMode === "legacy" ? feedTabKey() : "";
  return [...FEED_BASE_TABS.map(([key, label]) => ({ key, label })), ...feedTabLists.items.map((list) => ({ key: `list:${list.id}`, label: list.name.trim() }))]
    .map((entry) => ({ ...entry, selected: entry.key === active }));
}
// 見出しの文字を替え、リストを読む。種類の行そのものは renderSidebarContext が描く。
function renderFeedTabs() {
  const kind = socialMode === "legacy" ? "post" : socialFilter;
  const title = document.querySelector("#view-feed .page-title");
  if (title) title.textContent = { thread: "スレッド", community: "コミュニティ" }[kind] ?? "タイムライン";
  if (["post", "all"].includes(kind)) loadFeedTabLists();
}
function selectFeedTab(key) {
  if (currentView === "feed" && socialMode === "legacy" && key === feedTabKey() && typeof feedLive !== "undefined" && feedLive) { void feedLive?.refreshNow(); return; }
  if (key.startsWith("list:")) { feedScope = "list"; feedListId = key.slice(5); }
  else { feedScope = key; feedListId = null; }
  try { localStorage.setItem(FEED_TAB_KEY, key); } catch { /* 覚えられなくても切り替えは効く */ }
  socialMode = "legacy"; socialFilter = "post"; socialWantedScene = null; socialStreamController?.invalidate();
  socialBar.hidden = true;
  renderFeedTabs();
  const hadFocus = sidebarContext.contains(document.activeElement) && document.activeElement?.dataset?.feedTab !== undefined;
  renderSidebarContext("feed");
  if (hadFocus) [...sidebarContext.querySelectorAll("[data-feed-tab]")].find((node) => node.dataset.feedTab === key)?.focus({ preventScroll: true });
  void loadFeed();
}

// フィードのコンポーザー。Desktop接続があればこの場で投稿できる——
// 画像・予約投稿など載せていない行いは、注記の通りWeb版の画面が受け持つ。
const composer = {
  form: document.querySelector("#composer"),
  text: document.querySelector("#composer-text"),
  post: document.querySelector("#composer-post"),
  note: document.querySelector("#composer-note"),
  count: document.querySelector("#composer-count"),
};
composer.text.onfocus = () => composer.form.classList.add("open");
composer.text.onblur = () => {
  if (!composer.text.value.trim() && !document.querySelector("#compose-dialog")?.open) composer.form.classList.remove("open");
};
// 残り文字数。ハブは前後の空白を落とした長さを500字で切る（HUB_SOCIAL_POST_MAX_CHARACTERS）ので、同じ数え方をする。
const COMPOSER_MAX_CHARACTERS = 500;
composer.text.oninput = () => {
  const length = composer.text.value.trim().length;
  const remaining = COMPOSER_MAX_CHARACTERS - length;
  composer.post.disabled = (!composer.text.value.trim() && composerImages.length === 0) || remaining < 0;
  composer.count.hidden = length === 0;
  composer.count.textContent = String(remaining);
  composer.count.setAttribute("aria-label", `残り${remaining}文字`);
  composer.count.classList.toggle("composer-count--low", remaining <= 20);
  composer.count.classList.toggle("warning", remaining < 0);
};

// --- 投稿画像 ---
// 位置情報を含まないWebPへ必ず作り直す（ハブ側でも同じ検査を通る）。
// canvasで元ファイルを再描画するので、EXIFや埋め込みメタデータは落ちる。
const composerImages = [];
const composerImageAdd = document.querySelector("#composer-image-add");
const composerImageInput = document.querySelector("#composer-image-input");
const composerImageStrip = document.querySelector("#composer-images");
const composerAudience = document.querySelector("#composer-audience");
// 投稿と同時に載せるコミュニティ（空なら載せない）。投稿が確認できたあとに載せる。
const postCommunityPicker = createCommunityPicker({ document, invoke, isCurrent: () => true });
postCommunityPicker.root.addEventListener("change", (event) => event.stopPropagation());
window.addEventListener("hub-account-changed", () => { void postCommunityPicker.refresh(); });
composerAudience?.after(postCommunityPicker.root);
const composerScheduleBtn = document.querySelector("#composer-schedule");
const composerScheduleAt = document.querySelector("#composer-schedule-at");
const composerScheduledList = document.querySelector("#composer-scheduled-list");
const nodePostComposer = createNodePostComposer({document,invoke,form:composer.form,textarea:composer.text,post:composer.post,note:composer.note,getAccount:()=>desktopAccount,hasImages:()=>composerImages.length>0,audience:composerAudience,scheduledAt:composerScheduleAt,manage:()=>showView('node')});

// 予約投稿の一覧。予約中の編集・取消はここから行う。
async function renderScheduledList() {
  if (composerScheduledList.hidden) return;
  try {
    const data = await invoke("hub_client", { name: "scheduled_posts" });
    const posts = (data?.posts ?? []).filter((post) => post.status === "scheduled" || post.status === "failed");
    if (!posts.length) {
      composerScheduledList.replaceChildren();
      const empty = document.createElement("p");
      empty.className = "meta";
      empty.textContent = "予約中の投稿はありません。";
      composerScheduledList.append(empty);
      return;
    }
    composerScheduledList.replaceChildren(...posts.map((post) => {
      const row = document.createElement("div");
      row.className = "scheduled-row";
      const text = document.createElement("span");
      text.className = "meta";
      text.textContent = `${new Date(post.scheduledAt).toLocaleString("ja-JP")}${post.status === "failed" ? "（失敗）" : ""} — ${(post.body ?? "").slice(0, 40)}`;
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "head-action";
      edit.textContent = "変更";
      edit.onclick = async () => {
        const body = window.prompt("本文", post.body ?? "");
        if (body === null || !body.trim()) return;
        const at = window.prompt("投稿時刻（例: 2026-01-01 12:00）", new Date(post.scheduledAt).toLocaleString("sv-SE").slice(0, 16));
        if (at === null) return;
        const when = new Date(at.replace(" ", "T"));
        if (!Number.isFinite(when.getTime())) { window.alert("時刻の形が正しくありません。"); return; }
        edit.disabled = true;
        try {
          await invoke("hub_client_action", {
            action: "schedule_edit", target: post.id, text: body.trim(),
            options: { scheduledAt: when.toISOString(), audience: post.audience === "followers" ? "followers" : "public" },
          });
          await renderScheduledList();
        } catch (error) { edit.disabled = false; window.alert(friendlyError(error)); }
      };
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "head-action";
      cancel.textContent = "取り消す";
      cancel.onclick = async () => {
        cancel.disabled = true;
        try {
          await invoke("hub_client_action", { action: "schedule_cancel", target: post.id });
          await renderScheduledList();
        } catch (error) { cancel.disabled = false; window.alert(friendlyError(error)); }
      };
      row.append(text, edit, cancel);
      return row;
    }));
  } catch {
    composerScheduledList.replaceChildren();
  }
}

composerScheduleBtn.onclick = () => {
  const open = composerScheduleAt.hidden;
  composerScheduleAt.hidden = !open;
  composerScheduledList.hidden = !open;
  if (open) void renderScheduledList();
};
composerScheduleAt.onchange = () => {
  // 予約投稿はテキストのみ——画像ボタンを止めて条件を揃える。
  const scheduling = Boolean(composerScheduleAt.value);
  composerImageAdd.disabled = scheduling || composerImages.length >= 4;
  composer.note.textContent = scheduling ? `${new Date(composerScheduleAt.value).toLocaleString("ja-JP")}に予約` : "";
};

async function processComposerImage(file) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("JPEG、PNG、WebP画像だけ選択できます");
  if (file.size > 5 * 1024 * 1024) throw new Error("画像は1枚5MB以下にしてください");
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) { bitmap.close(); throw new Error("画像を処理できませんでした"); }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
  if (!blob) throw new Error("画像を処理できませんでした");
  const thumbScale = Math.min(1, 480 / Math.max(width, height));
  const thumbnailWidth = Math.max(1, Math.round(width * thumbScale));
  const thumbnailHeight = Math.max(1, Math.round(height * thumbScale));
  canvas.width = thumbnailWidth;
  canvas.height = thumbnailHeight;
  const thumbContext = canvas.getContext("2d");
  if (!thumbContext) throw new Error("画像を処理できませんでした");
  const processedBitmap = await createImageBitmap(blob);
  thumbContext.drawImage(processedBitmap, 0, 0, thumbnailWidth, thumbnailHeight);
  processedBitmap.close();
  const thumbnailBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.72));
  if (!thumbnailBlob) throw new Error("画像を処理できませんでした");
  return { blob, thumbnailBlob, width, height, thumbnailWidth, thumbnailHeight, previewUrl: URL.createObjectURL(blob) };
}

function renderComposerImages() {
  composerImageStrip.replaceChildren(...composerImages.map((item, index) => {
    const frame = document.createElement("span");
    frame.className = "composer-image-frame";
    const preview = document.createElement("img");
    preview.src = item.previewUrl;
    preview.alt = "添付画像";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "composer-image-remove";
    remove.textContent = "×";
    remove.title = "この画像を外す";
    remove.onclick = () => {
      URL.revokeObjectURL(item.previewUrl);
      composerImages.splice(index, 1);
      renderComposerImages();
    };
    frame.append(preview, remove);
    return frame;
  }));
  composerImageStrip.hidden = composerImages.length === 0;
  composerImageAdd.disabled = composerImages.length >= 4;
  composer.post.disabled = !composer.text.value.trim() && composerImages.length === 0;
  feedComposerDraftChanged();
}

// 処理済み画像群を hub_upload_image で pending 登録し、imageIds を返す。
// チャンネルメッセージ等、他のコンポーザーでも同じ手順を使う。
// DM は pending の表が別なので hub_upload_dm_image を使う。
async function uploadChannelImages(files,ctx){
  const imageIds=[];
  for(const [index,file] of files.entries()){
    ctx.assertCurrent();ctx.onProgress(`画像を準備しています… ${index+1}/${files.length}`);
    const item=await processComposerImage(file);
    try{
      ctx.assertCurrent();const image=await item.blob.arrayBuffer();ctx.assertCurrent();
      const thumbnail=await item.thumbnailBlob.arrayBuffer();ctx.assertCurrent();
      const uploaded=await ctx.invoke('hub_upload_image',{image:Array.from(new Uint8Array(image)),thumbnail:Array.from(new Uint8Array(thumbnail)),
        width:item.width,height:item.height,thumbnailWidth:item.thumbnailWidth,thumbnailHeight:item.thumbnailHeight,altText:''});
      ctx.assertCurrent();if(!uploaded?.image?.id)throw Error('画像のアップロードを確認できませんでした。');imageIds.push(uploaded.image.id);
    }finally{URL.revokeObjectURL(item.previewUrl);}
  }
  return imageIds;
}

async function uploadComposerImages(items, noteEl, command = "hub_upload_image") {
  const imageIds = [];
  for (const [index, item] of items.entries()) {
    if (noteEl) noteEl.textContent = `画像をアップロードしています… ${index + 1}/${items.length}`;
    const uploaded = await invoke(command, {
      image: Array.from(new Uint8Array(await item.blob.arrayBuffer())),
      thumbnail: Array.from(new Uint8Array(await item.thumbnailBlob.arrayBuffer())),
      width: item.width,
      height: item.height,
      thumbnailWidth: item.thumbnailWidth,
      thumbnailHeight: item.thumbnailHeight,
      altText: "",
    });
    if (!uploaded?.image?.id) throw new Error("画像のアップロードに失敗しました");
    imageIds.push(uploaded.image.id);
  }
  return imageIds;
}

// 任意のフォームに画像添付を足す小さな制御。{images, element} を返し、
// images は送信時に uploadComposerImages へ渡す。
function imageAttachmentControl(noteEl, onChange, context) {
  const images = [];
  const wrap = document.createElement("div");
  wrap.className = "composer-images-wrap";
  const add = document.createElement("button");
  add.type = "button";
  add.className = "head-action icon-only";
  add.setAttribute("aria-label", "画像を追加");
  add.title = "画像を追加";
  add.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 5.5h15v13h-15zM8.5 10.2a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM4.5 16l4.5-4.5 3.5 3.5 2.5-2.5 4.5 4.5"/></svg>';
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/jpeg,image/png,image/webp";
  input.multiple = true;
  input.hidden = true;
  const strip = document.createElement("div");
  strip.className = "composer-images";
  strip.hidden = true;
  const render = () => {
    strip.replaceChildren(...images.map((item, index) => {
      const frame = document.createElement("span");
      frame.className = "composer-image-frame";
      const preview = document.createElement("img");
      preview.src = item.previewUrl;
      preview.alt = "添付画像";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "composer-image-remove";
      remove.textContent = "×";
      remove.title = "この画像を外す";
      remove.onclick = () => {
        URL.revokeObjectURL(item.previewUrl);
        images.splice(index, 1);
        render();
        onChange?.();
      };
      frame.append(preview, remove);
      return frame;
    }));
    strip.hidden = images.length === 0;
    add.disabled = images.length >= 4;
    onChange?.();
  };
  add.onclick = () => input.click();
  input.onchange = async () => {
    const captured=context?.capture();
    const current=()=>!context||context.current(captured);
    const files = [...input.files];
    input.value = "";
    for (const file of files) {
      if(!current())return;
      if (images.length >= 4) { if (noteEl) noteEl.textContent = "画像は1投稿4枚までです"; break; }
      if (noteEl) noteEl.textContent = "画像を処理しています…";
      try {
        const item=await processComposerImage(file);
        if(!current()){URL.revokeObjectURL(item.previewUrl);return;}
        images.push(item);
        if (noteEl) noteEl.textContent = "";
      } catch (error) {
        if(!current())return;
        if (noteEl) noteEl.textContent = String(error instanceof Error ? error.message : error);
      }
    }
    render();
  };
  wrap.append(add, input, strip);
  return { images, element: wrap, replaceImages:items=>{images.splice(0,images.length,...items);render();}, clear: () => { images.splice(0).forEach((item) => URL.revokeObjectURL(item.previewUrl)); render(); } };
}

let feedImageEpoch=homeAccountEpoch;
let feedDraftRevision={},feedVerifiedScope=null,feedImageProcessing=0;
const feedComposerActions=document.createElement('div');feedComposerActions.className='composer-actions';
const feedComposerCheck=document.createElement('button'),feedComposerRetry=document.createElement('button'),feedComposerAbandon=document.createElement('button');
for(const button of [feedComposerCheck,feedComposerRetry,feedComposerAbandon]){button.type='button';button.className='head-action';button.hidden=true;}
feedComposerCheck.textContent='投稿結果を確認';feedComposerRetry.textContent='前の投稿を再送';feedComposerAbandon.textContent='画像を外して編集に戻る';feedComposerActions.append(feedComposerCheck,feedComposerRetry,feedComposerAbandon);composer.note.after(feedComposerActions);
function feedComposerScopeCurrent(source){
  return source&&feedVerifiedScope&&source.generation===homeAccountEpoch&&desktopAccountLoaded&&desktopAccount.state==='registered'
    &&source.device===desktopAccount.deviceId&&feedVerifiedScope.keyThumbprint===(desktopAccount.keyThumbprint??null)
    &&source.origin===feedVerifiedScope.source.origin&&source.viewer===feedVerifiedScope.source.viewer
    &&(!selfProfileId||source.viewer===selfProfileId);
}
const feedComposerCurrent=source=>feedComposerScopeCurrent(source)&&currentView==='feed'&&nodePostComposer.mode.value==='hub';
async function captureFeedComposerScope(){
  const snapshot=homeAccountSnapshot(),viewer=selfProfileId;
  if(snapshot.state!=='registered'||currentView!=='feed'||nodePostComposer.mode.value!=='hub')throw Error('feed_operation_scope_conflict');
  const same=()=>homeAccountCurrent(snapshot)&&(!viewer||selfProfileId===viewer);
  const captured=await captureHomeScope(snapshot);if(!captured||!same())throw Error('feed_operation_scope_conflict');
  const me=await invoke('hub_client',{name:'me'});if(!same()||!/^[A-Za-z0-9_-]{1,128}$/.test(me?.profile?.id??'')||viewer&&me.profile.id!==viewer)throw Error('feed_operation_scope_conflict');
  if(!await confirmHomeScope(captured)||!same())throw Error('feed_operation_scope_conflict');
  const source=Object.freeze({origin:captured.origin,device:captured.deviceId,viewer:me.profile.id,generation:snapshot.epoch});
  feedVerifiedScope={source,keyThumbprint:snapshot.keyThumbprint};return source;
}
async function confirmFeedComposerScope(source){
  if(!feedComposerScopeCurrent(source))throw Error('feed_operation_scope_conflict');
  if(!feedComposerCurrent(source))throw Error('feed_operation_paused');
  const snapshot=homeAccountSnapshot();
  if(!await confirmHomeScope({...snapshot,origin:source.origin}))throw Error('feed_operation_preparation_failed');
  if(!feedComposerScopeCurrent(source))throw Error('feed_operation_scope_conflict');
  if(!feedComposerCurrent(source))throw Error('feed_operation_paused');
}
function clearHubFeedDraft(){
  if(nodePostComposer.mode.value!=='hub')return;
  composer.text.value='';composerScheduleAt.value='';composerScheduleAt.hidden=true;composerScheduledList.hidden=true;
  composerImages.splice(0).forEach(item=>URL.revokeObjectURL(item.previewUrl));composer.count.hidden=true;composer.form.classList.remove('open');feedDraftRevision={};renderComposerImages();
}
function repaintFeedComposer(){
  if(!feedComposer)return;const status=feedComposer.status();nodePostComposer.mode.disabled=status.busy;
  const hub=nodePostComposer.mode.value==='hub';feedComposerActions.hidden=!hub;
  if(!hub)return;
  composer.post.disabled=feedImageProcessing>0||status.busy||['unknown','checking','upload_unknown','not_found','request_conflict','preparation_failed','paused'].includes(status.state)||!composer.text.value.trim()&&!composerImages.length;
  feedComposerCheck.hidden=!status.canRecheck;feedComposerRetry.hidden=!status.canRetry;feedComposerAbandon.hidden=status.state!=='upload_unknown';feedComposerCheck.disabled=feedComposerRetry.disabled=feedComposerAbandon.disabled=status.busy;
}
function feedComposerDraftChanged(){feedDraftRevision={};repaintFeedComposer();}
feedComposer=createFeedComposer({captureScope:captureFeedComposerScope,scopeCurrent:feedComposerScopeCurrent,current:feedComposerCurrent,
  getDraft:()=>({body:composer.text.value,images:composerImages,audience:composerAudience.value,scheduledAt:composerScheduleAt.value}),getDraftRevision:()=>feedDraftRevision,getViewRevision:()=>feedComposerViewEpoch,
  upload:async(payload,source)=>{await confirmFeedComposerScope(source);try{return await invoke('hub_upload_image',payload);}catch(error){if(String(error).includes('image_scope_conflict'))throw Error('feed_operation_scope_conflict');throw error;}},
  submit:async(input,source)=>{await confirmFeedComposerScope(source);try{return await invoke('hub_client_action',{action:'create_post',text:input.body,requestId:input.clientRequestId,
    options:{audience:input.audience,...(input.imageIds.length?{imageIds:input.imageIds}:{}),...(input.scheduledAt?{scheduledAt:input.scheduledAt}:{}),expectedDeviceId:source.device,expectedOrigin:source.origin,expectedViewerId:source.viewer}});}catch(error){if(String(error).includes('feed_operation_rejected:409'))throw Error('feed_operation_request_conflict');throw error;}},
  lookup:async(input,source)=>{await confirmFeedComposerScope(source);return invoke('hub_detail',{name:'feed_post_request',ids:[source.device,source.origin,source.viewer,input.clientRequestId,input.kind]});},
  onStatus:status=>{
    if(status.state==='scope_changed')clearHubFeedDraft();
    const notes={preparing:'画像と接続先を確認しています…',uploading:'画像をアップロードしています…',publishing:'投稿を送っています…',checking:'投稿結果を確認しています…',
      unknown:'投稿結果を確認できません。再送せず、結果を確認してください。',upload_unknown:'画像の登録結果を確認できません。自動で再アップロードや投稿はしていません。',not_found:'保存は見つかりませんでした。最初に送った内容を再送できます。編集中の草稿は保持します。',request_conflict:'この投稿IDの内容が一致しません。新しいIDで送らず、結果を確認してください。',
      preparation_failed:'投稿を準備できませんでした。草稿は保持しています。',invalid_draft:'本文・画像・予約時刻を確認してください。',scope_unavailable:'Desktopの接続先と本人を確認できません。草稿は保持しています。',paused:'投稿の処理を中断しています。結果を確認してから再開してください。',scope_changed:'接続先または本人が変わったため、前の投稿操作を解除しました。'};
    if(currentView==='feed'&&nodePostComposer.mode.value==='hub'&&Object.hasOwn(notes,status.state))composer.note.textContent=notes[status.state];repaintFeedComposer();
  },
  onAck:(receipt,info)=>{
    if(!feedComposerCurrent(info.source))return;
    if(info.clearDraft)clearHubFeedDraft();
    if(!feedComposerCurrent(info.source))return;
    const message=info.kind==='post'?'投稿しました':{scheduled:'予約しました',published:'予約した投稿は公開済みです。',cancelled:'この予約は取り消されています。草稿は保持しています。',failed:'この予約は失敗しています。草稿は保持しています。'}[info.outcome];
    if(info.kind==='post'){const community=postCommunityPicker.value();if(community&&receipt?.post?.id){postCommunityPicker.reset();void linkToCommunity(invoke,community,'post',receipt.post.id).then(linked=>{if(!linked.ok)showNotice('投稿しました。コミュニティには載せられませんでした。');});}document.querySelector('#compose-dialog')?.close();feed.list.prepend(postCard(receipt.post));feed.state.classList.remove('warning');feed.state.textContent=message;}else composer.note.textContent=message;
    const revision=feedDraftRevision;setTimeout(()=>{if(!feedComposerCurrent(info.source)||revision!==feedDraftRevision)return;const target=info.kind==='post'?feed.state:composer.note;if(target.textContent===message)target.textContent='';},4000);repaintFeedComposer();
  }});
const refreshFeedComposerAfterAction=()=>{if(currentView==='feed'&&nodePostComposer.mode.value==='hub')feedComposer.refresh();};
feedComposerCheck.onclick=()=>void feedComposer.recheck().finally(refreshFeedComposerAfterAction);feedComposerRetry.onclick=()=>void feedComposer.retry().finally(refreshFeedComposerAfterAction);
feedComposerAbandon.onclick=()=>{if(!feedComposer.abandonUpload())return;composerImages.splice(0).forEach(item=>URL.revokeObjectURL(item.previewUrl));renderComposerImages();composer.note.textContent='画像を外しました。本文は保持しています。';};
composer.form.addEventListener('input',feedComposerDraftChanged);composer.form.addEventListener('change',()=>{feedComposerDraftChanged();feedComposer.refresh();});
for(const name of ['hub-account-changed','hub-origin-changed'])window.addEventListener(name,()=>{feedVerifiedScope=null;feedImageProcessing=0;feedImageEpoch=homeAccountEpoch;feedComposer.invalidate();clearHubFeedDraft();});
repaintFeedComposer();

composerImageAdd.onclick = () => composerImageInput.click();
composerImageInput.onchange = async () => {
  const files=[...composerImageInput.files],epoch=homeAccountEpoch,viewEpoch=feedComposerViewEpoch,snapshot=homeAccountSnapshot(),viewer=selfProfileId;
  composerImageInput.value='';
  const current=()=>epoch===homeAccountEpoch&&viewEpoch===feedComposerViewEpoch&&homeAccountCurrent(snapshot)&&(!viewer||selfProfileId===viewer)&&currentView==='feed'&&nodePostComposer.mode.value==='hub';
  if(!current())return;feedImageProcessing++;repaintFeedComposer();
  try{for(const file of files){
    if(!current())return;if(composerImages.length>=4){composer.note.textContent='画像は1投稿4枚までです';break;}
    composer.note.textContent='画像を処理しています…';
    try{const item=await processComposerImage(file);if(!current()){URL.revokeObjectURL(item.previewUrl);return;}composerImages.push(item);composer.note.textContent='';renderComposerImages();}
    catch(error){if(current())composer.note.textContent=friendlyError(error);}
  }}finally{if(feedImageEpoch===epoch){feedImageProcessing--;if(currentView==='feed'&&nodePostComposer.mode.value==='hub')repaintFeedComposer();}}
};
composer.form.onsubmit = event => {
  event.preventDefault();
  if(nodePostComposer.mode.value==='node'){void nodePostComposer.submit();return;}
  if(feedImageProcessing)return;
  void feedComposer.send().finally(refreshFeedComposerAfterAction);
};

// --- 本人の画面（通知・メッセージ・プロフィール・ホームの未読） ---
// ここは公開面と違って本人のデータを扱う。Desktop接続が無いとき hub_client は
// "desktop_not_connected" で失敗する——それは壊れではなく「接続してください」の
// 合図なので、接続ボタン付きの案内に変える。
const accountNeeded = (error) => String(error).includes("desktop_not_connected");

// 内部コードをそのまま出すと判読できないので、知っているコードだけ
// 人向けの文言へ写す。知らないものは原文のまま——隠さない。
const ERROR_TEXT = {
  request_timeout: "接続先から応答がありません。再試行してください。",
  network_timeout: "Hubの応答に時間がかかっています。",
  network_unavailable: "Hubに接続できません。通信状態を確認してください。",
  service_unavailable: "Hubが一時的に応答できません。",
  account_service_unavailable: "アカウントサービスに接続できません。時間をおいて再試行してください。",
  desktop_account_network_unavailable: ACCOUNT_UNAVAILABLE_TEXT,
  desktop_account_unavailable: ACCOUNT_UNAVAILABLE_TEXT,
  desktop_account_request_failed: "アカウント認証を完了できませんでした。時間をおいて再試行してください。",
  desktop_account_request_expired: "端末の認証が期限切れです。接続状態を確認してください。",
  desktop_account_unauthorized: "端末の認証を確認できません。接続状態を確認してください。",
  desktop_account_response_invalid: "アカウントの認証サービスから正しい応答を受け取れませんでした。",
  desktop_account_response_too_large: "アカウントの認証サービスからの応答を読み込めませんでした。",
  desktop_not_connected: "Desktopを接続してください",
  rpc_unreachable: "チェーンへ接続できませんでした",
  rpc_unavailable: "チェーンへの接続が切れています",
  wallet_user_rejected: "操作をキャンセルしました",
  wallet_chain_unsupported: "このネットワークには対応していません",
  wallet_chain_mismatch: "接続先のネットワークが選択中のネットワークと一致しません。署名・送金は行われていません。",
  wallet_settings_unavailable: "ネットワークの設定を保存できませんでした。もう一度お試しください。",
  wallet_confirm_unavailable: "ウォレットの確認画面を開けませんでした。画面の状態を確認してから再度操作してください。署名・送金は行われていません。",
  wallet_confirm_busy: "別のウォレット操作を確認中です。完了してから再度操作してください。",
  wallet_fee_unavailable: "安全な手数料の見積もりを確認できませんでした。署名・送金は行われていません。接続状態を確認し、再度操作して新しい見積もりを確認してください。",
  wallet_fee_expired: "手数料の見積もりの期限が過ぎました。署名・送金は行われていません。再度操作して新しい見積もりを確認してください。",
  wallet_fee_stale: "送信元または取引の順序が変わりました。署名・送金は行われていません。ウォレットの状態を確認し、再度操作して新しい見積もりを確認してください。",
  wallet_method_unsupported: "この操作には対応していません",
  wallet_params_invalid: "指定が正しくありません",
  gas_estimate_failed: "手数料を見積もれませんでした。残高を確認してください",
  mail_link_required: "メールはWeb版で有効化してから使えます",
  desktop_account_signed_out: "Desktopを接続してください",
  desktop_account_not_registered: "Desktopを接続してください",
  mailbox_required: "先にメールアドレスを作成してください",
  address_unavailable: "このアドレスは使用されています",
  invalid_local_part: "アドレスの形が正しくありません",
  invalid_action: "その操作には対応していません",
  invalid_message: "宛先・件名・本文を確認してください",
  confirmation_required: "送信前の確認が必要です",
  preview_not_found: "送信前の確認内容が見つかりません。内容を確認し直してください",
  preview_mismatch: "送信前の確認内容が現在の返信先と一致しません",
  preview_expired: "送信前の確認が期限切れです。内容を確認し直してください",
  preview_already_used: "この確認内容はすでに処理されています",
  preview_invalid: "送信前の確認を組み立てられませんでした",
  delivery_status_unknown: "送信済みの可能性があります。送信状況を確認してから再試行してください",
  delivery_failed: "メールを送信できませんでした。時間をおいて再試行してください",
  outbound_disabled: "メール送信は現在利用できません",
  send_rate_limited: "送信回数が上限に達しました。時間をおいて再試行してください",
  idempotency_conflict: "送信状態を確認できませんでした",
  request_too_large: "内容が大きすぎます",
  invalid_json: "送信内容の形式が正しくありません",
  assertion_replayed: "認証票を取り直します。もう一度試してください",
  mail_request_failed: "メールを読み込めませんでした",
  internal_error: "内部エラーが起きました",
  not_found: "見つかりませんでした",
  credential_store_unavailable: "この端末の保管庫を使えません",
  wallet_unavailable: "この端末のウォレットを使えません",
  token_required: "このコンテンツへのアクセス権がありません",
  cancelled: "キャンセルしました",
};
const friendlyError = (error) => {
  const startupCode=typeof error==='string'?error:error instanceof Error?error.message:'';
  const startupText={startup_unavailable:"Windowsの起動設定を変更できませんでした。状態を再確認してください。",
    startup_ownership_conflict:"別のHub版の起動設定が登録されています。この画面では上書きしません。",
    startup_result_unknown:"起動設定の反映を確認できません。状態を再確認してください。",
    startup_unsupported:"このOSではログイン時の起動設定に対応していません。",
    node_startup_native_required:"起動設定はこのHubの画面で変更してください。"};
  if(Object.hasOwn(startupText,startupCode))return startupText[startupCode];
  if (isAccountUnavailable(error)) { markAccountFault(true); return ACCOUNT_UNAVAILABLE_TEXT; }
  const text = String(error);
  const feeCode = typeof error === "string" ? error : error instanceof Error && typeof error.message === "string" ? error.message : "";
  if (["wallet_fee_unavailable", "wallet_fee_expired", "wallet_fee_stale"].includes(feeCode)) return ERROR_TEXT[feeCode];
  if (ERROR_TEXT[text] && !text.startsWith("wallet_fee_")) return ERROR_TEXT[text];
  // チェーンRPCの応答は "rpc:理由" の形——理由を残して頭だけ訳す。
  if (text.startsWith("rpc:")) return `チェーン側が受け付けませんでした（${text.slice(4)}）`;
  // 状態番号だけの失敗（"ハブが 500 を返しています"）は番号を見せず、次の手を伝える。
  const status = /^(ハブ|AI)が (\d{3}) を返しています$/.exec(text);
  if (status) return status[2].startsWith("4") ? `${status[1]}がこの操作を受け付けませんでした。` : `${status[1]}から応答を得られませんでした。時間をおいて再試行してください。`;
  // 画面に出る最後の形：内部の JS 例外（TypeError など）は文面を見せず、Error の頭の「Error: 」も付けない。
  if (error instanceof Error) return /^(Type|Reference|Range|Syntax)Error$/.test(error.name) || typeof error.message !== "string" || !error.message ? "読み込めませんでした。時間をおいて再試行してください。" : error.message;
  return text;
};

function setBadge(id, count) {
  const badge = document.querySelector(`#${id}`);
  badge.hidden = !count;
  badge.textContent = count > 99 ? "99+" : String(count);
  // 左ナビの件数の札（同じ名前の data-badge）も同じ値にする。
  for (const mark of document.querySelectorAll(`.rail-badge[data-badge="${id.replace("nav-badge-", "")}"]`)) {
    mark.hidden = !count;
    mark.textContent = badge.textContent;
  }
}

function noticeCard(iconName, title, detail) {
  const card = document.createElement("div");
  card.className = "notice-card";
  const iconNode = document.createElement("span");
  iconNode.className = `notice-icon is-${iconName}`;
  iconNode.innerHTML = icon(iconName);
  const body = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = title;
  const text = document.createElement("p");
  text.textContent = detail;
  body.append(strong, text);
  card.append(iconNode, body);
  return card;
}

function connectCard(detail) {
  const card = noticeCard("lock", "Desktop接続が必要です", detail ?? "本人のデータを表示するには、この端末をHubアカウントへ接続してください。");
  const button = document.createElement("button");
  button.className = "approve";
  button.type = "button";
  button.textContent = "Desktopを接続";
  button.onclick = () => void connectDesktopAccount();
  card.querySelector("div").append(button);
  return card;
}

// 失敗した読み込みをその場でやり直すボタン。文言だけで終わると
// 回復手段がリロードしかないので、エラーの横に必ず置く。
function retryButton(run) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "head-action";
  button.textContent = "再試行";
  button.onclick = () => { button.disabled = true; void run(); };
  return button;
}

// 空・エラー表示の中の再試行は、その表示の唯一の主ボタン（Web の V2State と同じ。2026-10-29）。
function stateRetryButton(run) {
  const button = retryButton(run);
  button.className = "btn btn-primary state-action";
  return button;
}

function showClientError(state, list, error, retry) {
  state.textContent = "";
  state.classList.remove("warning");
  if (accountNeeded(error)) {
    list.replaceChildren(connectState());
    return;
  }
  const box = emptyState("alert", "読み込めませんでした", friendlyError(error));
  box.classList.add("load-error");
  box.setAttribute("role", "alert");
  if (retry) {
    const button = retryButton(retry);
    button.className = "approve";
    box.append(button);
  }
  list.replaceChildren(box);
}

function paintComposerAvatar(profile) {
  if (!profile) return;
  composerProfile = profile;
  for (const node of document.querySelectorAll(".uc-avatar")) paintComposerAvatarNode(node, profile);
  const composerAvatar = document.querySelector("#composer-avatar");
  if (composerAvatar) paintComposerAvatarNode(composerAvatar, profile);
}
function paintComposerAvatarNode(composerAvatar, profile) {
  composerAvatar.replaceChildren();
  if (profile.avatarUrl) {
    const img = document.createElement("img");
    hubAsset(img, profile.avatarUrl);
    img.alt = "";
    composerAvatar.classList.add("has-image");
    composerAvatar.append(img);
  } else {
    composerAvatar.classList.remove("has-image");
    const seed = profile.displayName || profile.handle || "?";
    composerAvatar.textContent = seed.trim().slice(0, 1).toUpperCase();
    paintAvatar(composerAvatar, seed);
  }
}
async function loadHomeSummary() {
  const request = homeSummaryRequest = {}, snapshot = homeAccountSnapshot();
  const current = () => request === homeSummaryRequest && homeAccountCurrent(snapshot);
  let captured = null;
  const box = document.querySelector("#home-attention");
  if (!box) return;
  try {
    captured = await captureHomeScope(snapshot);
    if (!captured || !current()) return;
    if (captured.state === 'signed_out') {
      if (!await confirmHomeScope(captured) || !current()) return;
      setBadge('nav-badge-notifications', 0); setBadge('nav-badge-messages', 0);
      box.replaceChildren(connectCard('接続すると未読の通知やメッセージをここで確認できます。'));
      return;
    }
    const me = await invoke("hub_client", { name: "me_summary" });
    if (!current() || !await confirmHomeScope(captured) || !current()) return;
    if (!validHomeProfileId(me?.profile?.id)) throw Error('home_profile_unavailable');
    selfProfileId = me.profile?.id ?? null;selfProfileHandle = me.profile?.handle ?? null;
    setBadge("nav-badge-notifications", me.unreadNotifications ?? 0);
    setBadge("nav-badge-messages", me.unreadMessages ?? 0);
    paintComposerAvatar(me.profile);
    paintRailAvatar(document.querySelector("#rail-profile-avatar"), me.profile, hubAsset);
    // アカウント行は接続中の本人を映す——「プロフィール」という
    // 宛先名のままだと誰で入っているか見えない。
    const accountName = document.querySelector("#account-name");
    const accountAvatar = document.querySelector("#account-avatar");
    if (accountName && accountAvatar) {
      if (me.profile) {
        accountName.textContent = me.profile.displayName || me.profile.handle || "プロフィール";
        accountAvatar.replaceChildren();
        if (me.profile.avatarUrl) {
          const img = document.createElement("img");
          hubAsset(img, me.profile.avatarUrl);
          img.alt = "";
          accountAvatar.classList.add("has-image");
          accountAvatar.append(img);
        } else {
          accountAvatar.classList.remove("has-image");
          const seed = me.profile.displayName || me.profile.handle || "?";
          accountAvatar.textContent = seed.trim().slice(0, 1).toUpperCase();
          paintAvatar(accountAvatar, seed);
        }
      } else {
        accountName.textContent = "プロフィール";
        accountAvatar.classList.remove("has-image");
        accountAvatar.replaceChildren();
        accountAvatar.innerHTML = icon("user");
        accountAvatar.removeAttribute("style");
      }
    }
    if (!me.unreadNotifications && !me.unreadMessages) {
      box.replaceChildren(noticeCard("check", "確認する項目はありません", "新しい通知が届くとここに表示されます。"));
      return;
    }
    const cards = [];
    if (me.unreadNotifications) {
      const card = noticeCard("bell", `未読の通知が${me.unreadNotifications}件あります`, "通知で内容を確認できます。");
      card.classList.add("clickable");
      card.onclick = async () => {
        if (currentView !== 'home' || !current() || !await confirmHomeScope(captured) || !current() || currentView !== 'home') return;
        return navigateFrom({ dataset: { view: "notifications" }, childNodes: [] });
      };
      cards.push(card);
    }
    if (me.unreadMessages) {
      const card = noticeCard("message", `未読のメッセージが${me.unreadMessages}件あります`, "メッセージで会話を開けます。");
      card.classList.add("clickable");
      card.onclick = async () => {
        if (currentView !== 'home' || !current() || !await confirmHomeScope(captured) || !current() || currentView !== 'home') return;
        return navigateFrom({ dataset: { view: "messages" }, childNodes: [] });
      };
      cards.push(card);
    }
    box.replaceChildren(...cards);
  } catch (error) {
    if (!current() || captured && !await confirmHomeScope(captured) || !current()) return;
    selfProfileId = null; selfProfileHandle = null;
    setBadge("nav-badge-notifications", 0);
    setBadge("nav-badge-messages", 0);
    box.replaceChildren(accountNeeded(error)
      ? connectCard("接続すると未読の通知やメッセージをここで確認できます。")
      : noticeCard("alert", "ハブへ届きません", friendlyError(error)));
  } finally {
    if (current() && captured) void loadHomeExtras(captured);
  }
}

// ホームは「確認すること」だけだと空の日に何もない画面になる。
// 通知・会話・端末の近況を各カードで出す——どれかが失敗しても他は届く。
async function loadHomeExtras(parentScope = null) {
  const request = homeExtrasRequest = {}, snapshot = homeAccountSnapshot();
  const current = () => request === homeExtrasRequest && homeAccountCurrent(snapshot);
  const captured = parentScope && homeAccountCurrent(parentScope) ? parentScope : await captureHomeScope(snapshot);
  if (!captured || !current() || !await confirmHomeScope(captured) || !current()) return;
  const notifBox = document.querySelector("#home-notifications");
  const msgBox = document.querySelector("#home-messages");
  const devBox = document.querySelector("#home-device");
  if (!notifBox || !msgBox || !devBox) return;
  const homeOpen = view => async () => {
    if (currentView !== 'home' || !current() || !await confirmHomeScope(captured) || !current() || currentView !== 'home') return;
    return navigateFrom({ dataset: { view }, childNodes: [] });
  };

  if (captured.state === 'registered') void invoke("hub_client", { name: "notifications" }).then(async data => {
    if (!current() || !await confirmHomeScope(captured) || !current()) return;
    const actors = new Map((data.actors ?? []).map((p) => [p.id, p]));
    const items = (data.notifications ?? []).slice(0, 4);
    notifBox.replaceChildren(...(items.length
      ? items.map((item) => railRow(
          actors.get(item.actorProfileId)?.displayName || "Hub",
          item.text || "新しい通知があります",
          item.createdAt,
          homeOpen("notifications")))
      : [railEmpty("通知はありません")]));
  }).catch(async error => {
    if (current() && await confirmHomeScope(captured) && current()) notifBox.replaceChildren(
      railEmpty(accountNeeded(error) ? "Desktopを接続すると表示されます" : friendlyError(error)));
  });
  else notifBox.replaceChildren(railEmpty('Desktopを接続すると表示されます'));

  if (captured.state === 'registered') void invoke("hub_client", { name: "conversations" }).then(async data => {
    if (!current() || !await confirmHomeScope(captured) || !current()) return;
    const profiles = new Map((data.profiles ?? []).map((p) => [p.id, p]));
    const latest = new Map();
    for (const message of data.messages ?? []) {
      const current = latest.get(message.conversationId);
      if (!current || message.createdAt > current.createdAt) latest.set(message.conversationId, message);
    }
    const items = (data.conversations ?? []).slice(0, 4);
    msgBox.replaceChildren(...(items.length
      ? items.map((conversation) => {
          const peer = conversationPeer(conversation, profiles, data.currentProfileId);
          const message = latest.get(conversation.id);
          return railRow(
            peer.displayName || "（名無し）",
            message?.previewText || (message ? "（暗号化されたメッセージ）" : ""),
            message?.createdAt,
            homeOpen("messages"));
        })
      : [railEmpty("会話はまだありません")]));
  }).catch(async error => {
    if (current() && await confirmHomeScope(captured) && current()) msgBox.replaceChildren(
      railEmpty(accountNeeded(error) ? "Desktopを接続すると表示されます" : friendlyError(error)));
  });
  else msgBox.replaceChildren(railEmpty('Desktopを接続すると表示されます'));

  const card = document.createElement("div");
  card.className = "card device-card";
  const name = document.createElement("strong");
  const stateLine = document.createElement("p");
  stateLine.className = "meta";
  const accountLine = document.createElement("p");
  accountLine.className = "meta";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "head-action";
  open.textContent = "Personal Nodeを開く";
  open.onclick = homeOpen("node");
  card.append(name, stateLine, accountLine, open);
  devBox.replaceChildren(card);
  try {
    const state = await invoke("node_state");
    if (!current() || !await confirmHomeScope(captured) || !current()) return;
    name.textContent = state?.deviceName || "この端末";
    if (state) {
      const when = state.lastSyncConfirmed === true && state.lastSyncAt && Number.isFinite(new Date(state.lastSyncAt * 1000).getTime()) ? WHEN.format(new Date(state.lastSyncAt * 1000)) : "未確認";
      stateLine.textContent = `${SYNC_STATE[state.syncState] ?? state.syncState} · 確認した配送 ${when} · 配信待ち ${state.queuedItems}件`;
      stateLine.classList.toggle("warning", state.syncState === "error");
    } else {
      stateLine.textContent = "ノードの状態を確認できません";
    }
  } catch {
    if (!current() || !await confirmHomeScope(captured) || !current()) return;
    name.textContent = "この端末";
    stateLine.textContent = "ノードの状態を確認できません";
  }
  if (!current()) return;
  accountLine.textContent = captured.state === "registered"
    ? "Desktop接続済み · 端末鍵で本人確認しています"
    : "Desktop未接続 · 接続すると本人の機能が使えます";
}

// --- 通知 ---
// 画面側（lib/v2-notifications.ts）と同じまとめ方・同じ行き先。独自の並べ方を
// すると、Webとアプリで届いたものの見え方が違ってしまう。
const NOTIF_LABELS = {
  social_reply: "返信", social_repost: "リポスト", social_reaction: "リアクション",
  social_bookmark: "保存", thread_reply: "スレッドへの返信", message_received: "メッセージ",
  followed: "新しいフォロワー", system: "Hubからのお知らせ",
};
const NOTIF_ICONS = { social_reply: "reply", social_repost: "repost", social_reaction: "heart", social_bookmark: "bookmark", thread_reply: "reply", message_received: "message", followed: "userplus", system: "bell" };
const notifLabel = (item) => item.context === "mention" ? "メンション" : (NOTIF_LABELS[item.type] ?? item.type);

const NOTIF_GROUPED = new Set(["social_reaction", "social_repost", "social_bookmark", "followed"]);
function groupNotifications(items) {
  const groups = new Map();
  const order = [];
  for (const item of items) {
    const key = NOTIF_GROUPED.has(item.type) && !item.context
      ? `${item.type}:${item.targetType}:${item.targetId}`
      : `one:${item.id}`;
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
      if (item.actorProfileId && !existing.actorIds.includes(item.actorProfileId)) existing.actorIds.push(item.actorProfileId);
      if (!item.isRead) existing.isRead = false;
      if (Date.parse(item.createdAt) > Date.parse(existing.latest.createdAt)) existing.latest = item;
      continue;
    }
    const group = { key, latest: item, items: [item], actorIds: item.actorProfileId ? [item.actorProfileId] : [], isRead: item.isRead };
    groups.set(key, group);
    order.push(group);
  }
  return order.sort((a, b) => Date.parse(b.latest.createdAt) - Date.parse(a.latest.createdAt));
}

// まとめた行の文を「名前（太字）」と「続き」に分ける。まとめない行は続きだけ。
function groupedNotificationParts(group, names) {
  if (group.items.length === 1 || !names.length) return { who: "", rest: group.latest.text || "新しい通知があります" };
  const shown = names.slice(0, 2);
  const others = group.actorIds.length - shown.length;
  const who = `${shown.map((name) => `${name}さん`).join("と")}${others > 0 ? `、ほか${others}人` : ""}`;
  const verb = {
    social_reaction: "があなたの投稿にいいねしました",
    social_repost: "があなたの投稿をリポストしました",
    social_bookmark: "があなたの投稿を保存しました",
    followed: "があなたをフォローしました",
  }[group.latest.type] ?? "";
  return { who, rest: verb };
}
function groupedNotificationText(group, names) {
  const parts = groupedNotificationParts(group, names);
  return parts.who + parts.rest;
}

// 行き先は Web 版の画面。メッセージだけはアプリに画面があるので
// ネイティブの会話を開く。

let notificationsData = null;
let notifTab = "all";
let notificationTicket = null;
let notificationsPending = false;
const notificationsController = createNotificationsController({
  invoke, getScope: articleEditorScope, isCurrent: () => currentView === "notifications",
  onData: (data, ticket) => {
    notificationsData = data; notificationTicket = ticket;
    if (data) { markAccountFault(false); renderNotifications(); }
    else { document.querySelector("#notifications-list").replaceChildren(); document.querySelector("#notifications-unread").textContent = ""; }
  },
  onBadge: (count, ticket) => {
    if (count === null) { const badge = document.querySelector("#nav-badge-notifications"); badge.hidden = true; badge.textContent = ""; }
    else if (notificationsController.isTicketCurrent(ticket)) setBadge("nav-badge-notifications", count);
  },
  onState: value => {
    notificationsPending = value.pending;
    const state = document.querySelector("#notifications-state"), list = document.querySelector("#notifications-list");
    state.classList.toggle("warning", value.phase === "error" || value.phase === "uncertain");
    if (value.phase === "loading") {
      state.textContent = "通知を確認しています…";
      if (!notificationsData) list.replaceChildren(skeletonPost(), skeletonPost(), skeletonPost());
    } else if (value.phase === "error") {
      state.textContent = "";
      state.classList.remove("warning");
      list.replaceChildren(pageErrorState("読み込めませんでした", friendlyError(value.error), () => loadNotifications()));
    } else if (value.phase === "uncertain") {
      state.textContent = value.error ? friendlyError(value.error) : "既読結果を確認できません。通知を更新して確認してください。";
    } else if (value.phase === "unconnected") {
      state.textContent = "";
      if (!notificationsData) list.replaceChildren(connectState());
    } else state.textContent = "";
    const blocked = value.pending || !notificationTicket || !notificationsController.isTicketCurrent(notificationTicket);
    document.querySelector("#notifications-read-all").disabled = blocked;
    for (const button of list.querySelectorAll(".notification-read")) button.disabled = blocked;
  },
  onChanged: ticket => { if (notificationsController.isTicketCurrent(ticket)) void loadHomeSummary(); },
});
window.addEventListener("hub-account-changed", () => {
  notificationsController.invalidate("account");
  if (currentView === "notifications") void loadNotifications();
});

async function markNotificationRead(item, ticket) {
  if (!notificationsController.isTicketCurrent(ticket)) return false;
  return notificationsController.markOne(item.id, ticket);
}

async function openNotificationTarget(group,ticket){
  if(!notificationsController.isTicketCurrent(ticket))return;
  const generation=researchAccountGeneration,account=desktopAccount;
  const current=()=>generation===researchAccountGeneration&&account===desktopAccount;
  const data=notificationsData;
  const profiles=new Map((data?.actors??[]).map(profile=>[profile.id,profile]));
  const target=notificationTarget(group.latest,profiles,data?.threadPostDestinations??{},data?.communityMessageDestinations??{});
  if(!target){showNotice('この通知の行き先は表示できません。');return;}
  for(const item of group.items){
    if(!current()||!notificationsController.isTicketCurrent(ticket))return;
    if(!item.isRead)await markNotificationRead(item,ticket);
  }
  if(!current()||!notificationsController.isTicketCurrent(ticket))return;
  if(target.kind==='detail')await openDetail(target.name,target.ids,{title:target.title,targetSelection:target.state,isCurrent:current});
  else if(target.kind==='view')await navigateFrom({dataset:{view:target.view},childNodes:[]});
  else if(target.kind==='conversation'){
    const view='messages';
    await navigateFrom({dataset:{view},childNodes:[]});
    if(current()&&currentView===view)await openConversation(target.id);
  }
}

function notificationCard(group) {
  const ticket = notificationsController.capture(group.items.map(item => item.id));
  const data = notificationsData;
  const item = group.latest;
  const profiles = new Map((data?.actors ?? []).map((p) => [p.id, p]));
  const actors = group.actorIds.map((id) => profiles.get(id)).filter(Boolean);
  const card = document.createElement("article");
  card.className = "post notif notif-x" + (group.isRead ? "" : " unread");
  card.tabIndex = 0;
  card.dataset.listRow = "";
  // 左の 40 の列に種類の記号（いいねだけ --reaction-like）。未読は左端の点（CSS）。
  const kind = document.createElement("span");
  kind.className = "notif-kind notif-kind-" + (item.context === "mention" ? "mention" : item.type);
  kind.innerHTML = icon(item.context === "mention" ? "at" : (NOTIF_ICONS[item.type] ?? "bell"), item.type === "social_reaction");
  kind.title = notifLabel(item);

  // まとめた行は顔を重ねる（3人まで）。1件なら顔1つ。
  const avatars = document.createElement("span");
  avatars.className = "notif-avatars";
  for (const actor of (actors.length ? actors.slice(0, 6) : [])) {
    const avatar = document.createElement("span");
    avatar.className = "post-avatar";
    if (actor?.avatarUrl) {
      const img = document.createElement("img");
      hubAsset(img, actor.avatarUrl);
      img.alt = "";
      avatar.classList.add("has-image");
      avatar.append(img);
    } else {
      avatar.textContent = (actor?.displayName || actor?.handle || "?").trim().slice(0, 1).toUpperCase();
      paintAvatar(avatar, actor?.displayName || actor?.handle);
    }
    avatars.append(avatar);
  }

  const content = document.createElement("div");
  content.className = "post-content";
  const body = document.createElement("p");
  body.className = "post-body";
  const soleName = actors.length === 1 && group.items.length === 1 ? (actors[0].displayName || "Hub") : "";
  const parts = groupedNotificationParts(group, actors.map((p) => p.displayName));
  // 名前は太字。文の頭が名前ならそのまま、入っていないときだけ先頭に足す。
  if (parts.who) {
    const strong = document.createElement("strong");
    strong.textContent = parts.who;
    body.append(strong, parts.rest);
  } else if (soleName && parts.rest.startsWith(soleName)) {
    const strong = document.createElement("strong");
    strong.textContent = soleName;
    body.append(strong, parts.rest.slice(soleName.length));
  } else if (soleName && !parts.rest.includes(soleName)) {
    const strong = document.createElement("strong");
    strong.textContent = soleName;
    body.append(strong, `　${parts.rest}`);
  } else body.append(parts.rest);
  const when = document.createElement("span");
  when.className = "meta when";
  when.textContent = ` · ${relTime(item.createdAt)}`;
  body.append(when);
  if (actors.length) content.append(avatars);
  content.append(body);
  // 元の投稿の本文の頭（ハブが付けたときだけ。閲覧条件つきの投稿には付かない）。
  const excerpt = group.items.find((entry) => typeof entry.excerpt === "string" && entry.excerpt)?.excerpt;
  if (excerpt) {
    const quote = document.createElement("p");
    quote.className = "notif-excerpt";
    quote.textContent = excerpt;
    content.append(quote);
  }
  if (!group.isRead) {
    const mark = document.createElement("button");
    mark.className = "deny notification-read";
    mark.type = "button";
    mark.textContent = "既読";
    mark.disabled = notificationsPending || !ticket;
    mark.onclick = async (event) => {
      event.stopPropagation();
      if (!card.isConnected || mark.disabled || !notificationsController.isTicketCurrent(ticket)) return;
      const selected = group.items.filter(item => !item.isRead).map(item => Object.freeze({ id: item.id }));
      mark.disabled = true;
      try {
        for (const item of selected) {
          if (!notificationsController.isTicketCurrent(ticket)) return;
          await markNotificationRead(item, ticket);
          if (!notificationsController.isTicketCurrent(ticket)) return;
        }
        if (notificationsController.isTicketCurrent(ticket)) renderNotifications();
      } finally {
        if (mark.isConnected && notificationsController.isTicketCurrent(ticket)) mark.disabled = notificationsPending;
      }
    };
    content.append(mark);
  }
  card.append(kind, content);
  const open = () => { if (card.isConnected && notificationsController.isTicketCurrent(ticket)) void openNotificationTarget(group, ticket); };
  card.onclick = open;
  card.onkeydown = (event) => { if (event.key === "Enter" && event.target === card) open(); };
  return card;
}

function renderNotifications() {
  const list = document.querySelector("#notifications-list");
  const unreadEl = document.querySelector("#notifications-unread");
  const moreWrap = document.querySelector("#notifications-more-wrap");
  if (!notificationsData) { list.replaceChildren(); unreadEl.textContent = ""; moreWrap.hidden = true; return; }
  if (currentView !== "notifications" || !notificationTicket || !notificationsController.isTicketCurrent(notificationTicket)) return;
  const items = notificationsData.notifications ?? [];
  unreadEl.textContent = notificationsData.unreadCount ? `未読 ${notificationsData.unreadCount}` : "";
  // 既読化は「…」の中、未読があるときだけ（Web §4.10）。
  moreWrap.hidden = !notificationsData.unreadCount;
  const visible = items.filter((item) => matchesNotifTab(item, notifTab));
  const groups = groupNotifications(visible);
  list.replaceChildren(...(groups.length
    ? groups.map(notificationCard)
    : [pageState("bell",
        notifTab === "unread" ? "未読の通知はありません" : notifTab === "mention" ? "自分宛ての通知はありません" : "通知はありません",
        notifTab === "all" ? "返信・いいね・フォローがあるとここに来ます。" : undefined,
        () => loadNotifications())]));
  renderSidebarContext("notifications"); // 件数と選択中の行（列は同じ木のまま作り直す）
}

async function loadNotifications() {
  if (currentView !== "notifications") return false;
  return notificationsController.load();
}

// 本文の札は すべて / 自分宛て の2つ。列の木はほかの絞り込みも持つ（札は 自分宛て 以外では「すべて」が選ばれる）。
function setNotifTab(key) {
  notifTab = key;
  for (const tab of document.querySelectorAll("#view-notifications [data-notif-tab]")) {
    const selected = tab.dataset.notifTab === (key === "mention" ? "mention" : "all");
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  renderNotifications();
}
for (const button of document.querySelectorAll("#view-notifications [data-notif-tab]")) button.onclick = () => setNotifTab(button.dataset.notifTab);

{
  const more = document.querySelector("#notifications-more"), menu = more.nextElementSibling;
  more.onclick = (event) => {
    event.stopPropagation();
    menu.hidden = !menu.hidden;
    more.setAttribute("aria-expanded", String(!menu.hidden));
    if (!menu.hidden) menu.querySelector("button")?.focus();
  };
  menu.addEventListener("click", () => { menu.hidden = true; more.setAttribute("aria-expanded", "false"); });
}
document.querySelector("#notifications-read-all").onclick = async (event) => {
  const button = event.currentTarget, ticket = notificationsController.capture();
  if (!button.isConnected || button.disabled || !ticket || !notificationsController.isTicketCurrent(ticket)) return;
  button.disabled = true;
  await notificationsController.markAll(ticket);
  // The controller's state callback enables the current row after its scoped reload.
};

// 表示元と接続先は「…」の先に畳む（DESKTOP_SPEC §3.1）。
// 切り替えの入口は左の列のフィードの行の「…」ひとつ（本文の上に孤立したボタンの帯は置かない）。
function toggleFeedSources() {
  const view = document.querySelector("#view-feed");
  view.classList.toggle("show-sources", !view.classList.contains("show-sources"));
  renderSidebarContext(currentView);
}

// --- メッセージ ---
// 会話一覧＋選んだ会話のスレッド。開いた会話は既読にしてから本文を引き直す。
let messagesData=null,dmController=null,dmDraftRevision=0,dmScopeKey=null,dmDraftOwner=null,dmReturnConversationId=null,dmPreserveDrafts=false,dmLoadPending=false;
const dmDrafts=new Map();
function saveDmDraft(){
  if(!activeConversationId||!dmDraftOwner)return;
  const value={text:document.querySelector('#thread-input').value,images:[...dmAttachment.images],revision:dmDraftRevision};
  if(value.text||value.images.length)dmDrafts.set(activeConversationId,value);else dmDrafts.delete(activeConversationId);
}
function switchDmDraft(id){
  if(id===activeConversationId)return;
  saveDmDraft();activeConversationId=id;dmReturnConversationId=id;
  const draft=dmDrafts.get(id);document.querySelector('#thread-input').value=draft?.text??'';
  dmAttachment.replaceImages(draft?.images??[]);dmDraftRevision++;
}
function clearDmPrivate(){
  const images=new Set([...dmDrafts.values()].flatMap(draft=>draft.images));for(const image of dmAttachment?.images??[])images.add(image);
  for(const image of images)URL.revokeObjectURL(image.previewUrl);dmDrafts.clear();dmDraftOwner=null;dmReturnConversationId=null;
  dmAttachment?.replaceImages([]);document.querySelector('#thread-input').value='';dmDraftRevision++;clearDmImageCache();
}
async function getDmScope(){
  const scope=await articleEditorScope();
  if(scope?.key!==dmScopeKey){clearDmPrivate();dmScopeKey=scope?.key??null;}
  return scope;
}
function closeDmView(){dmFocusedConversationId=null;saveDmDraft();dmPreserveDrafts=true;try{dmController?.invalidate('view');}finally{dmPreserveDrafts=false;}}


function profileOf(profiles, id) {
  return profiles.get(id) ?? { displayName: "（不明）", handle: "" };
}

function conversationPeer(conversation, profiles, selfId) {
  const peerId = conversation.participantIds.find((id) => id !== selfId) ?? conversation.participantIds[0];
  return profileOf(profiles, peerId);
}

function conversationCard(conversation, profiles, selfId, latestByConversation) {
  const peer = conversationPeer(conversation, profiles, selfId);
  const unread = conversation.unreadCountByProfileId?.[selfId] ?? 0;
  const card = document.createElement("button");
  card.className = "conversation" + (unread ? " unread" : "");
  card.type = "button";
  const avatar = document.createElement("span");
  avatar.className = "post-avatar";
  avatar.textContent = (peer.displayName || peer.handle || "?").trim().slice(0, 1).toUpperCase();
  paintAvatar(avatar, peer.displayName || peer.handle);
  const content = document.createElement("span");
  content.className = "conversation-content";
  const head = document.createElement("span");
  head.className = "conversation-head";
  const name = document.createElement("strong");
  name.textContent = peer.displayName || "（名無し）";
  name.title = name.textContent;
  const when = document.createElement("span");
  when.className = "meta when";
  when.textContent = relTime(conversation.lastMessageAt);
  head.append(name, when);
  const preview = document.createElement("span");
  preview.className = "meta conversation-preview";
  const latest = latestByConversation.get(conversation.id);
  const line = latest?.previewText || (latest?.images?.length ? "（画像）" : latest ? "（暗号化されたメッセージ）" : "");
  // 自分が最後に送った会話は X と同じく「あなた: 」を前に付ける。
  preview.textContent = line && latest?.senderProfileId === selfId ? `あなた: ${line}` : line;
  content.append(head, preview);
  card.append(avatar, content);
  if (unread) {
    const badge = document.createElement("b");
    badge.className = "nav-badge";
    badge.textContent = unread > 99 ? "99+" : String(unread);
    card.append(badge);
  }
  card.dataset.conversationId = conversation.id;
  const ticket=dmController?.capture();
  card.onclick=()=>{if(card.isConnected&&dmController?.isTicketCurrent(ticket))void openConversation(conversation.id,ticket);};
  return card;
}

// DM の画像は <img> に Bearer を付けられないので、Rust 側が取った
// バイト列から blob を作る。同じ画像を取り直さないよう id で覚える。
const dmImageUrls=new Map();let dmImageEpoch=0;
function clearDmImageCache(){dmImageEpoch++;for(const item of dmImageUrls.values())if(item.url)URL.revokeObjectURL(item.url);dmImageUrls.clear();}
function dmImageUrl(imageId,ticket){
  if(!dmController?.isTicketCurrent(ticket))return Promise.reject(Error('dm_scope_changed'));
  const epoch=dmImageEpoch,key=JSON.stringify([dmDraftOwner,imageId]);let cached=dmImageUrls.get(key);
  if(!cached){
    cached={url:null,promise:null};const item=cached;
    item.promise=invoke('hub_dm_image',{imageId,variant:'thumbnail'}).then(result=>{
      if(epoch!==dmImageEpoch||!dmController?.isTicketCurrent(ticket))throw Error('dm_scope_changed');
      item.url=URL.createObjectURL(new Blob([new Uint8Array(result.bytes)],{type:result.mimeType||'image/webp'}));return item.url;
    }).catch(error=>{if(dmImageUrls.get(key)===item)dmImageUrls.delete(key);throw error;});dmImageUrls.set(key,item);
  }
  return cached.promise;
}

function messageBubble(message, profiles, selfId) {
  const ticket=dmController?.capture();
  const own = message.senderProfileId === selfId;
  const row = document.createElement("div");
  row.className = "bubble-row" + (own ? " own" : "");
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const bubbleText = message.previewText || (message.images?.length ? "" : "（暗号化されたメッセージ）");
  if (detectBait(bubbleText).flagged) { const inner = document.createElement("span"); inner.textContent = bubbleText; bubble.append(inner); addBaitRow(document, inner, bubbleText); } else bubble.textContent = bubbleText;
  if (message.images?.length) {
    const images = document.createElement("div");
    images.className = "post-images";
    for (const image of message.images) {
      const img = document.createElement("img");
      img.alt = image.altText || "";
      img.loading = "lazy";
      if (image.width > 0 && image.height > 0) { img.width = image.width; img.height = image.height; }
      void dmImageUrl(image.id,ticket).then((url) => { if(img.isConnected&&dmController?.isTicketCurrent(ticket))img.src=url; }).catch(() => { img.remove(); });
      images.append(img);
    }
    bubble.append(images);
  }
  const when = document.createElement("span");
  when.className = "meta when";
  when.textContent = relTime(message.createdAt);
  if (message.createdAt) bubble.title = new Date(message.createdAt).toLocaleString("ja-JP");
  bubble.append(when);
  // 相手の吹き出しには顔を添える（連なりの最後の 1 つだけ見せ、ほかは場所だけ取る）。
  if (!own) {
    const sender = profiles.get(message.senderProfileId);
    const face = document.createElement("span");
    face.className = "post-avatar bubble-avatar";
    face.setAttribute("aria-hidden", "true");
    if (sender?.avatarUrl) {
      const img = document.createElement("img");
      hubAsset(img, sender.avatarUrl);
      img.alt = "";
      face.classList.add("has-image");
      face.append(img);
    } else {
      face.textContent = (sender?.displayName || sender?.handle || "?").trim().slice(0, 1).toUpperCase();
      paintAvatar(face, sender?.displayName || sender?.handle);
    }
    row.append(face);
  }
  row.append(bubble);
  return row;
}

// 同じ人の連なりは角を詰め、日が替わるところに日付の区切りを入れる（Web §4.11）。
// readByPeer: 相手の未読が 0（相手がこの会話を読み終えている）。最後の吹き出しが自分のものなら、その下に「既読」を出す。
function threadNodes(messages, profiles, selfId, readByPeer = false) {
  const dayOf = (message) => { const at = new Date(message.createdAt); return Number.isNaN(at.getTime()) ? "" : at.toDateString(); };
  const nodes = [];
  messages.forEach((message, index) => {
    const day = dayOf(message), prev = messages[index - 1], next = messages[index + 1];
    if (!prev || dayOf(prev) !== day) {
      const divider = document.createElement("p");
      divider.className = "msg-date";
      const at = new Date(message.createdAt);
      divider.textContent = Number.isNaN(at.getTime()) ? "" : at.toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
      if (divider.textContent) nodes.push(divider);
    }
    const row = messageBubble(message, profiles, selfId);
    const joinsPrev = prev && prev.senderProfileId === message.senderProfileId && dayOf(prev) === day;
    const joinsNext = next && next.senderProfileId === message.senderProfileId && dayOf(next) === day;
    row.classList.add(joinsPrev ? "grp-mid" : "grp-first");
    if (!joinsNext) row.classList.add("grp-last");
    nodes.push(row);
  });
  const last = messages.at(-1);
  if (readByPeer && last && last.senderProfileId === selfId) {
    const seen = document.createElement("p");
    seen.className = "msg-read";
    seen.textContent = "既読";
    nodes.push(seen);
  }
  return nodes;
}

// 会話が未選択のときの右の面。共通の空の状態（createState）を出す。
function threadIdleState() {
  return createState(document, {
    kind: "empty",
    icon: "mail",
    title: "会話を選択",
    action: { label: "新しいメッセージ", onClick: () => void navigateFrom({ dataset: { view: "search", title: "検索" }, childNodes: [] }) },
    iconSvg: icon,
  });
}

function renderThread() {
  const state = document.querySelector("#thread-state");
  const list = document.querySelector("#thread-list");
  const form = document.querySelector("#thread-form");
  if (!messagesData?.conversations?.length) {
    state.textContent = "";
    const empty = emptyState("bubble", "会話はまだありません", "相手のプロフィールからメッセージを始められます。");
    const find = document.createElement("button");
    find.type = "button";
    find.className = "btn-primary";
    find.textContent = "相手を探す";
    find.onclick = () => void navigateFrom({ dataset: { view: "search", title: "検索" }, childNodes: [] });
    empty.append(find);
    list.replaceChildren(empty);
    form.hidden = true;
    return;
  }
  if (!activeConversationId) {
    state.textContent = "";
    list.replaceChildren(threadIdleState());
    form.hidden = true;
    return;
  }
  const profiles = new Map(messagesData.profiles.map((profile) => [profile.id, profile]));
  const conversation = messagesData.conversations.find((item) => item.id === activeConversationId);
  const peer = conversation ? conversationPeer(conversation, profiles, messagesData.currentProfileId) : null;
  state.textContent = peer ? `${peer.displayName} との会話${conversation.isE2ee ? "（E2E）" : ""}` : "";
  const messages = messagesData.messages.filter((item) => item.conversationId === activeConversationId);
  const readByPeer = Boolean(peer?.id) && conversation?.unreadCountByProfileId?.[peer.id] === 0;
  list.replaceChildren(...threadNodes(messages, profiles, messagesData.currentProfileId, readByPeer));
  list.scrollTop = list.scrollHeight;
  form.hidden = conversation?.isE2ee!==false;
  if(conversation?.isE2ee)state.textContent+=' · この暗号化会話では送信できません';
  // 会話を開いたら入力欄に合わせる（同じ会話の描き直しでは奪わない）。
  if(!form.hidden&&dmFocusedConversationId!==activeConversationId&&currentView==='messages'){dmFocusedConversationId=activeConversationId;dmInput.focus({preventScroll:true});}
  // E2EE の会話には画像を付けられない（暗号化できない画像を平文で置くことになる）。
  if (dmAttachment) {
    dmAttachment.element.hidden = Boolean(conversation?.isE2ee);
    if (conversation?.isE2ee) dmAttachment.clear();
  }
  for (const card of document.querySelectorAll("#messages-list .conversation")) {
    card.classList.toggle("active", card.dataset.conversationId === activeConversationId);
  }
}

let activeConversationId = null;
let dmFocusedConversationId = null;

async function openConversation(id,ticket){
  if(currentView!=='messages'||!dmController)return false;
  if(ticket&&!dmController.isTicketCurrent(ticket))return false;
  document.querySelector(".app-shell")?.classList.add("dm-thread-open");
  if(!messagesData?.conversations?.some(item=>item.id===id)){
    if(!await dmController.load(id)||currentView!=='messages'){document.querySelector(".app-shell")?.classList.remove("dm-thread-open");return false;}ticket=dmController.capture();
  }
  const opened=await dmController.select(id,ticket);
  if(!opened)document.querySelector(".app-shell")?.classList.remove("dm-thread-open");
  return opened;
}
async function loadMessages(conversation){
  if(currentView!=='messages'||!dmController)return false;
  return dmController.load(conversation??activeConversationId??dmReturnConversationId);
}

// --- メール（独立した Mail サービス） ---
// DM とは別系統。読み書きはすべて mail_* コマンド経由で、認証は
// jkamma-mail assertion をRust側が要求ごとに発行する（ワーカーが
// jti の使い回しを禁じているため）。送信は必ず preview → 本人確認 →
// send の2段。届いたか不明な送信は「送信状況を確認」で再確認してから
// にしか再送しない——Web版 email-workspace と同じ手順。
const mailState = {
  mailbox: undefined,   // undefined=未読込、null=無し
  folder: "inbox",
  messages: [],
  drafts: [],
  draftId: null,
  nextCursor: null,
  selected: null,
  attachments: [],
  composing: false,
  replyTo: null,
  sendAttempt: null,
  previewing: false,
  busy: false,
};
const MAIL_UNRESOLVED = "送信済みの可能性があります。送信状況を確認してから再試行してください。";
const mailEl = (id) => document.querySelector(id);
const mailNeedsAccount = (error) => /desktop_account_signed_out|desktop_account_not_registered|desktop_not_connected|desktop_account_unauthorized|desktop_account_state_invalid|desktop_account_key_invalid/.test(String(error));
const mailNeedsLink = (error) => String(error).includes("mail_link_required");

function mailNotice(text) {
  const node = mailEl("#mail-notice");
  node.textContent = text || "";
}

function mailPreviewState(text) {
  mailEl("#mail-preview-state").textContent = text || "";
}

// 現在の下書きの指紋。preview はこの指紋に縛る——内容が変わったら
// 確認済みの preview は破棄して取り直す（内容ずれの送信を防ぐ）。
function mailDraftKey() {
  return JSON.stringify({
    replyTo: mailState.replyTo,
    to: mailEl("#mail-to").value,
    subject: mailEl("#mail-subject").value,
    text: mailEl("#mail-text").value,
  });
}

function mailInvalidatePreview() {
  mailState.previewing = false;
  mailState.sendAttempt = null;
  mailPreviewState("");
  renderMailPane();
}

// 「届いたか不明」な送信がある間は、一覧移動も新規作成も止める。
// 開き直して送信状況の確認へ誘導する（二重送信防止）。
function mailUnresolvedAttempt() {
  if (mailState.sendAttempt?.status !== "unknown") return false;
  mailState.previewing = true;
  mailPreviewState(MAIL_UNRESOLVED);
  mailNotice(MAIL_UNRESOLVED);
  renderMailPane();
  return true;
}

async function loadMail() {
  const state = mailEl("#mail-state");
  const gate = mailEl("#mail-gate");
  const setup = mailEl("#mail-setup");
  const main = mailEl("#mail-main");
  state.classList.remove("warning");
  state.textContent = "読み込み中…";
  gate.replaceChildren();
  setup.hidden = true;
  main.hidden = true;
  mailEl("#mail-compose").hidden = true;
  mailState.busy = true;
  try {
    const data = await invoke("mail_mailbox");
    mailState.mailbox = data?.mailbox ?? null;
    state.textContent = "";
    if (!mailState.mailbox) {
      setup.hidden = false;
      mailEl("#mail-setup-state").textContent = "";
      renderMailPane();
      return;
    }
    mailEl("#mail-address").textContent = mailState.mailbox.address ?? "";
    mailEl("#mail-compose").hidden = false;
    main.hidden = false;
    await loadMailFolder(true);
    renderMailPane();
  } catch (error) {
    state.textContent = "";
    if (mailNeedsAccount(error)) {
      gate.append(connectCard("メールを使うには、この端末をHubアカウントへ接続してください。"));
    } else if (mailNeedsLink(error)) {
      gate.append(noticeCard("message", "メールはWeb版で有効化してから使えます", "Web版のメール画面でAccountにメールを接続すると、この画面でも送受信できます。"));
    } else {
      state.textContent = friendlyError(error);
      state.classList.add("warning");
      state.append(" ", retryButton(loadMail));
    }
  } finally {
    mailState.busy = false;
    if (currentView === "mail") renderSidebarContext("mail");
  }
}

// 一覧。ワーカーのページングキーは before（createdAt の境界値）で、
// nextCursor が返るのは末尾まで読み切っていないときだけ——
// 50件ちょうどのときだけ「もっと見る」を出す。
async function loadMailFolder(reset) {
  const list = mailEl("#mail-list");
  const moreWrap = mailEl("#mail-more-wrap");
  if (reset) {
    mailState.messages = [];
    mailState.drafts = [];
    mailState.nextCursor = null;
    list.replaceChildren(skeletonPost(), skeletonPost());
  }
  try {
    // 下書きは MailDraft 表の別エンドポイント——ページングはない（ワーカー側100件上限）。
    if (mailState.folder === "drafts") {
      const data = await invoke("mail_drafts");
      mailState.drafts = Array.isArray(data?.drafts) ? data.drafts : [];
      moreWrap.hidden = true;
      renderMailList();
      return;
    }
    const data = await invoke("mail_messages", { folder: mailState.folder, cursor: reset ? null : mailState.nextCursor });
    const fresh = Array.isArray(data?.messages) ? data.messages : [];
    mailState.messages = reset ? fresh : [...mailState.messages, ...fresh];
    mailState.nextCursor = data?.nextCursor ?? null;
    moreWrap.hidden = !(fresh.length >= 50 && mailState.nextCursor);
    renderMailList();
  } catch (error) {
    list.replaceChildren();
    if (mailNeedsAccount(error)) {
      list.append(connectCard());
    } else if (mailNeedsLink(error)) {
      list.append(noticeCard("message", "メールはWeb版で有効化してから使えます", "Web版のメール画面でAccountにメールを接続すると、この画面でも送受信できます。"));
    } else {
      const state = document.createElement("p");
      state.className = "meta warning";
      state.textContent = friendlyError(error);
      state.append(" ", retryButton(() => loadMailFolder(reset)));
      list.append(state);
    }
  }
}

function renderMailList() {
  const list = mailEl("#mail-list");
  if (mailState.folder === "drafts") {
    if (!mailState.drafts.length) {
      list.replaceChildren(emptyState("message", "下書きはありません"));
      return;
    }
    list.replaceChildren(...mailState.drafts.map((item) => {
      const wrap = document.createElement("div");
      wrap.className = "mail-draft-row";
      const row = document.createElement("button");
      row.type = "button";
      row.className = `mail-item${mailState.draftId === item.id ? " active" : ""}`;
      const head = document.createElement("span");
      head.className = "mail-item-head";
      const who = document.createElement("strong");
      who.textContent = item.to ? `宛先: ${item.to}` : "宛先なし";
      const when = document.createElement("span");
      when.className = "when";
      when.textContent = relTime(item.updatedAt);
      head.append(who, when);
      const subject = document.createElement("span");
      subject.className = "mail-item-subject";
      subject.textContent = item.subject || "（件名なし）";
      const preview = document.createElement("span");
      preview.className = "mail-item-preview";
      preview.textContent = item.text ?? "";
      row.append(head, subject, preview);
      row.onclick = () => mailOpenDraft(item);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "mail-item-delete";
      remove.textContent = "削除";
      remove.onclick = (event) => { event.stopPropagation(); void mailDeleteDraft(item.id); };
      wrap.append(row, remove);
      return wrap;
    }));
    return;
  }
  if (!mailState.messages.length) {
    list.replaceChildren(emptyState("message", "メールはありません"));
    return;
  }
  list.replaceChildren(...mailState.messages.map((item) => {
    const row = document.createElement("button");
    row.type = "button";
    const unread = !item.readAt && item.direction === "inbound";
    row.className = `mail-item${unread ? " unread" : ""}${mailState.selected?.id === item.id ? " active" : ""}`;
    const head = document.createElement("span");
    head.className = "mail-item-head";
    const who = document.createElement("strong");
    who.textContent = item.direction === "inbound" ? item.sender : `宛先: ${item.recipient}`;
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = relTime(item.createdAt);
    head.append(who, when);
    const subject = document.createElement("span");
    subject.className = "mail-item-subject";
    subject.textContent = item.subject || "（件名なし）";
    const preview = document.createElement("span");
    preview.className = "mail-item-preview";
    preview.textContent = item.textBody ?? "";
    row.append(head, subject, preview);
    row.onclick = () => void openMail(item.id);
    return row;
  }));
}

// 一覧・本文・作成・確認の4面を排他で出す。Web版の3ペイン+モーダルと
// 同じ情報量を、この画面幅に合わせて右ペイン内で切り替える。
function renderMailPane() {
  const reading = !!mailState.selected && !mailState.previewing;
  const composing = mailState.composing && !mailState.previewing;
  mailEl("#mail-message").hidden = !reading;
  mailEl("#mail-form").hidden = !composing;
  mailEl("#mail-preview").hidden = !mailState.previewing;
  const state = mailEl("#mail-reader-state");
  state.hidden = reading || composing || mailState.previewing;
  // 狭い窓では詳細を開いている間だけ一覧を隠す（desktop-layouts.css）。戻る操作は読んでいるときだけ。
  document.querySelector(".app-shell")?.classList.toggle("mail-reader-open", reading || composing || mailState.previewing);
  mailEl("#mail-main").classList.toggle("is-reading", reading);
}
mailEl("#mail-reader-back").onclick = () => {
  if (mailUnresolvedAttempt()) return;
  mailState.selected = null;
  mailState.composing = false;
  mailInvalidatePreview();
  renderMailList();
  renderMailPane();
};

async function openMail(id) {
  if (mailState.busy || mailUnresolvedAttempt()) return;
  mailState.composing = false;
  mailInvalidatePreview();
  mailState.busy = true;
  mailNotice("");
  try {
    const result = await invoke("mail_message", { messageId: id });
    mailState.selected = result?.message ?? null;
    mailState.attachments = result?.attachments ?? [];
    if (mailState.selected && !mailState.selected.readAt) {
      await invoke("mail_message_action", { messageId: id, action: "read" }).catch(() => undefined);
      const item = mailState.messages.find((m) => m.id === id);
      if (item) item.readAt = new Date().toISOString();
    }
    renderMailList();
    renderMailReader();
  } catch (error) {
    mailNotice(friendlyError(error));
  } finally {
    mailState.busy = false;
    renderMailPane();
  }
}

function renderMailReader() {
  const box = mailEl("#mail-message");
  box.replaceChildren();
  const selected = mailState.selected;
  if (!selected) return;
  const head = document.createElement("div");
  head.className = "mail-head";
  const who = document.createElement("strong");
  who.textContent = selected.direction === "inbound" ? selected.sender : `宛先: ${selected.recipient}`;
  const when = document.createElement("span");
  when.className = "meta";
  when.textContent = new Date(selected.createdAt).toLocaleString("ja-JP");
  head.append(who, when);
  const subject = document.createElement("h3");
  subject.className = "mail-subject";
  subject.textContent = selected.subject || "（件名なし）";
  const actions = document.createElement("div");
  actions.className = "mail-actions";
  const mk = (label, run, cls = "head-action") => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = cls;
    button.textContent = label;
    button.disabled = mailState.busy;
    button.onclick = run;
    return button;
  };
  actions.append(
    mk("一覧に戻る", () => { mailState.selected = null; renderMailList(); renderMailPane(); }),
    mk("返信", mailBeginReply),
    mk("保管", () => void mailMove("archive")),
  );
  if (selected.direction === "inbound" && selected.folder !== "spam") {
    actions.append(mk("迷惑メール", () => void mailMove("spam")));
  }
  if (selected.folder === "spam" || selected.folder === "trash") {
    actions.append(mk("受信に戻す", () => void mailMove("inbox")));
  }
  actions.append(mk("削除", () => void mailMove("trash")));
  const body = document.createElement("p");
  body.className = "mail-body";
  body.textContent = selected.textBody ?? "";
  box.append(head, subject, actions, body);
  if (mailState.attachments.length) {
    const list = document.createElement("ul");
    list.className = "mail-attachments";
    for (const item of mailState.attachments) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "mail-attachment-name";
      name.textContent = item.filename || "添付ファイル";
      const size = document.createElement("small");
      size.className = "meta";
      size.textContent = `${item.mediaType} · ${Math.max(1, Math.round((item.byteSize ?? 0) / 1024)).toLocaleString("ja-JP")} KB`;
      li.append(name, size);
      // clean のものだけ保存口を出す。検査中・不通過は受け取れない。
      if (item.scanStatus === "clean") {
        li.append(mk("保存", () => void mailSaveAttachment(item), "approve"));
      } else {
        const note = document.createElement("em");
        note.className = "meta";
        note.textContent = item.scanStatus === "pending" ? "安全検査中のためまだ受け取れません" : "検査を通らなかったため受け取れません";
        li.append(note);
      }
      list.append(li);
    }
    box.append(list);
  }
}

async function mailMove(action) {
  if (mailState.busy || mailState.sendAttempt?.status === "unknown" || !mailState.selected) return;
  mailState.busy = true;
  mailNotice("");
  try {
    await invoke("mail_message_action", { messageId: mailState.selected.id, action });
    mailState.selected = null;
    mailState.attachments = [];
    await loadMailFolder(true);
  } catch (error) {
    mailNotice(friendlyError(error));
  } finally {
    mailState.busy = false;
    renderMailPane();
    renderMailList();
  }
}

async function mailSaveAttachment(item) {
  if (!mailState.selected || item.scanStatus !== "clean" || mailState.busy) return;
  mailState.busy = true;
  mailNotice("");
  try {
    const result = await invoke("mail_attachment_download", { messageId: mailState.selected.id, attachmentId: item.id });
    if (result?.saved) mailNotice(`添付ファイル「${result.filename}」を保存しました。`);
  } catch (error) {
    mailNotice(friendlyError(error));
  } finally {
    mailState.busy = false;
  }
}

function mailBeginCompose() {
  if (mailState.busy || mailUnresolvedAttempt()) return;
  mailInvalidatePreview();
  mailState.selected = null;
  mailState.replyTo = null;
  mailState.draftId = null;
  mailEl("#mail-form-title").textContent = "新しいメール";
  mailEl("#mail-to").value = "";
  mailEl("#mail-to").readOnly = false;
  mailEl("#mail-subject").value = "";
  mailEl("#mail-subject").readOnly = false;
  mailEl("#mail-text").value = "";
  mailState.composing = true;
  renderMailList();
  renderMailPane();
}

function mailBeginReply() {
  if (!mailState.selected || mailState.busy || mailUnresolvedAttempt()) return;
  mailInvalidatePreview();
  const original = mailState.selected;
  mailState.replyTo = original.id;
  mailState.draftId = null;
  mailEl("#mail-form-title").textContent = "返信";
  mailEl("#mail-to").value = original.direction === "inbound" ? original.sender : original.recipient;
  mailEl("#mail-to").readOnly = true;
  mailEl("#mail-subject").value = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
  mailEl("#mail-subject").readOnly = true;
  mailEl("#mail-text").value = "";
  mailState.selected = null;
  mailState.composing = true;
  renderMailList();
  renderMailPane();
}

function mailDiscardCompose() {
  if (mailUnresolvedAttempt()) return;
  mailInvalidatePreview();
  mailState.composing = false;
  mailState.replyTo = null;
  mailState.draftId = null;
  renderMailPane();
}

// 下書きは宛先・件名・本文が未確定のまま保存できる。返信の下書きは
// inReplyTo を付けてサーバ側へ保存するので、開き直しても返信の文脈が残る。
async function mailSaveDraft() {
  if (mailState.busy || mailUnresolvedAttempt()) return;
  const id = mailState.draftId ?? crypto.randomUUID();
  mailState.busy = true;
  mailNotice("");
  try {
    const result = await invoke("mail_draft_save", {
      draftId: id,
      to: mailEl("#mail-to").value,
      subject: mailEl("#mail-subject").value,
      text: mailEl("#mail-text").value,
      inReplyTo: mailState.replyTo,
    });
    if (result?.draft?.id !== id) throw new Error("draft_invalid");
    mailState.draftId = id;
    mailNotice("下書きを保存しました。");
    if (mailState.folder === "drafts") await loadMailFolder(true).catch(() => undefined);
  } catch (error) {
    mailNotice(friendlyError(error));
  } finally {
    mailState.busy = false;
  }
}

async function mailDeleteDraft(id) {
  if (mailState.busy || mailUnresolvedAttempt()) return;
  mailState.busy = true;
  mailNotice("");
  try {
    await invoke("mail_draft_delete", { draftId: id });
    if (mailState.draftId === id) mailState.draftId = null;
    await loadMailFolder(true);
  } catch (error) {
    mailNotice(friendlyError(error));
  } finally {
    mailState.busy = false;
  }
}

// 下書きを開くと、サーバ側のドラフトidを保持してコンポーザーに載せる。
// 宛先・件名は通常の作成と同じ編集系に戻す（返信下書きは宛先固定のまま）。
function mailOpenDraft(item) {
  if (mailState.busy || mailUnresolvedAttempt()) return;
  mailInvalidatePreview();
  mailNotice("");
  mailState.selected = null;
  mailState.attachments = [];
  mailState.draftId = item.id;
  mailState.replyTo = item.inReplyTo ?? null;
  mailEl("#mail-form-title").textContent = item.inReplyTo ? "返信" : "新しいメール";
  mailEl("#mail-to").value = item.to ?? "";
  mailEl("#mail-to").readOnly = Boolean(item.inReplyTo);
  mailEl("#mail-subject").value = item.subject ?? "";
  mailEl("#mail-subject").readOnly = false;
  mailEl("#mail-text").value = item.text ?? "";
  mailState.composing = true;
  renderMailList();
  renderMailPane();
}

// 送信前の確認。preview は送る内容の写し——この段階ではまだ送らない。
async function mailPreviewSend() {
  if (mailState.busy) return;
  const draftKey = mailDraftKey();
  if (mailState.sendAttempt?.status === "unknown" && mailState.sendAttempt.draftKey === draftKey) {
    mailState.previewing = true;
    mailPreviewState(MAIL_UNRESOLVED);
    renderMailPane();
    return;
  }
  mailState.busy = true;
  mailState.sendAttempt = null;
  mailState.previewing = true;
  mailPreviewState("");
  mailEl("#mail-preview-to").textContent = "";
  mailEl("#mail-preview-subject").textContent = "";
  mailEl("#mail-preview-text").textContent = "";
  mailEl("#mail-preview-expiry").textContent = "";
  renderMailPane();
  try {
    const result = mailState.replyTo
      ? await invoke("mail_reply_preview", { messageId: mailState.replyTo, text: mailEl("#mail-text").value })
      : await invoke("mail_compose_preview", { to: mailEl("#mail-to").value, subject: mailEl("#mail-subject").value, text: mailEl("#mail-text").value });
    const preview = result?.preview;
    if (!preview || typeof preview.id !== "string" || typeof preview.expiresAt !== "string" || Date.parse(preview.expiresAt) <= Date.now()) {
      throw new Error("preview_invalid");
    }
    mailState.sendAttempt = { preview, idempotencyKey: crypto.randomUUID(), draftKey, status: "ready" };
    mailEl("#mail-preview-to").textContent = preview.to ?? "";
    mailEl("#mail-preview-subject").textContent = preview.subject ?? "";
    mailEl("#mail-preview-text").textContent = preview.text ?? "";
    mailEl("#mail-preview-expiry").textContent = `有効期限: ${new Date(preview.expiresAt).toLocaleString("ja-JP")}。送信すると相手へ送信され、取り消せません。`;
    mailEl("#mail-preview-send").textContent = "この内容で送信";
  } catch (error) {
    mailPreviewState(friendlyError(error));
  } finally {
    mailState.busy = false;
    renderMailPane();
  }
}

function mailClosePreview() {
  if (mailState.busy) return;
  const keepUnknown = mailState.sendAttempt?.status === "unknown";
  mailState.previewing = false;
  mailPreviewState("");
  if (!keepUnknown) mailState.sendAttempt = null;
  if (keepUnknown) mailNotice(MAIL_UNRESOLVED);
  renderMailPane();
}

// 「届いたか不明」のまま終わった送信の確かめ直し。
async function mailCheckSendStatus() {
  if (mailState.busy) return;
  const attempt = mailState.sendAttempt;
  if (attempt?.status !== "unknown") return;
  mailState.busy = true;
  mailNotice("");
  try {
    const result = await invoke("mail_send_status", { intentId: attempt.preview.id });
    const delivery = result?.delivery;
    if (!delivery || delivery.previewId !== attempt.preview.id) throw new Error("status_invalid");
    if (delivery.state === "confirmed") { await mailFinishAccepted("メールは送信済みです。"); return; }
    if (delivery.state === "awaiting_confirmation") {
      mailState.sendAttempt = { ...attempt, status: "ready" };
      mailPreviewState("送信前の確認が残っています。内容を確認して送信してください。");
      mailEl("#mail-preview-send").textContent = "この内容で送信";
      return;
    }
    if (delivery.state === "failed") {
      mailState.sendAttempt = null;
      mailPreviewState("メールを送信できませんでした。内容を確認して再試行してください。");
      return;
    }
    if (delivery.state === "expired") {
      mailState.sendAttempt = null;
      mailPreviewState("送信前の確認が期限切れです。内容を確認して再試行してください。");
      return;
    }
    mailPreviewState(MAIL_UNRESOLVED);
    mailNotice(MAIL_UNRESOLVED);
  } catch {
    mailPreviewState(MAIL_UNRESOLVED);
    mailNotice(MAIL_UNRESOLVED);
  } finally {
    mailState.busy = false;
    renderMailPane();
  }
}

async function mailConfirmSend() {
  if (mailState.busy) return;
  const attempt = mailState.sendAttempt;
  if (attempt?.status === "unknown") {
    mailState.previewing = true;
    mailPreviewState(MAIL_UNRESOLVED);
    mailEl("#mail-preview-send").textContent = "送信状況を確認";
    renderMailPane();
    return;
  }
  if (!attempt || mailDraftKey() !== attempt.draftKey) {
    mailInvalidatePreview();
    mailNotice("内容が変更されたため、送信前の確認をやり直してください。");
    return;
  }
  if (Date.parse(attempt.preview.expiresAt) <= Date.now()) {
    mailState.sendAttempt = null;
    mailPreviewState("送信前の確認が期限切れです。内容を確認し直してください。");
    renderMailPane();
    return;
  }
  mailState.busy = true;
  mailNotice("");
  try {
    const result = mailState.replyTo
      ? await invoke("mail_reply_send", { messageId: mailState.replyTo, previewId: attempt.preview.id, idempotencyKey: attempt.idempotencyKey })
      : await invoke("mail_compose_send", { previewId: attempt.preview.id, idempotencyKey: attempt.idempotencyKey });
    if (result?.receipt?.status !== "accepted") {
      // 送信したか不明——受領済みの可能性があるので同じ内容を再送せず、
      // 状況確認へ切り替える（Web版と同じ判断）。
      mailState.sendAttempt = { ...attempt, status: "unknown" };
      mailPreviewState(MAIL_UNRESOLVED);
      mailNotice(MAIL_UNRESOLVED);
      mailEl("#mail-preview-send").textContent = "送信状況を確認";
      return;
    }
    await mailFinishAccepted("送信を受け付けました。");
  } catch (error) {
    const code = String(error);
    if (["confirmation_required", "preview_already_used", "preview_expired", "preview_mismatch", "preview_not_found"].some((k) => code.includes(k))) {
      mailState.sendAttempt = null;
      mailPreviewState(friendlyError(error));
    } else {
      mailState.sendAttempt = { ...attempt, status: "unknown" };
      mailPreviewState(MAIL_UNRESOLVED);
      mailNotice(MAIL_UNRESOLVED);
      mailEl("#mail-preview-send").textContent = "送信状況を確認";
    }
  } finally {
    mailState.busy = false;
    renderMailPane();
  }
}

// 送信が確定したら作成を畳んで送信済みフォルダへ——Web版と同じ流れ。
// 対応する下書きがあれば消す。消せなくても送信自体は成立しているので無視する。
async function mailFinishAccepted(message) {
  const sentDraftId = mailState.draftId;
  mailState.sendAttempt = null;
  mailState.previewing = false;
  mailState.composing = false;
  mailState.replyTo = null;
  mailState.draftId = null;
  mailState.selected = null;
  mailState.attachments = [];
  mailEl("#mail-to").value = "";
  mailEl("#mail-subject").value = "";
  mailEl("#mail-text").value = "";
  mailState.folder = "sent";
  for (const tab of document.querySelectorAll("[data-mail-folder]")) {
    const on = tab.dataset.mailFolder === "sent";
    tab.classList.toggle("on", on);
    tab.setAttribute("aria-pressed", String(on));
  }
  if (sentDraftId) await invoke("mail_draft_delete", { draftId: sentDraftId }).catch(() => undefined);
  try {
    await loadMailFolder(true);
    mailNotice(message);
  } catch {
    mailNotice(`${message} 送信済み一覧を更新できませんでした。`);
  }
  renderMailPane();
}

async function mailCreateMailbox() {
  const input = mailEl("#mail-local-part");
  const state = mailEl("#mail-setup-state");
  const localPart = input.value.trim().toLowerCase();
  if (localPart.length < 3) {
    state.textContent = "3文字以上で入れてください";
    return;
  }
  mailState.busy = true;
  state.classList.remove("warning");
  state.textContent = "";
  try {
    const result = await invoke("mail_mailbox_create", { localPart });
    mailState.mailbox = result?.mailbox ?? null;
    input.value = "";
    await loadMail();
  } catch (error) {
    state.textContent = friendlyError(error);
    state.classList.add("warning");
  } finally {
    mailState.busy = false;
  }
}

mailEl("#mail-refresh").onclick = () => void loadMail();
mailEl("#mail-compose").onclick = () => mailBeginCompose();
mailEl("#mail-create").onclick = () => void mailCreateMailbox();
mailEl("#mail-more").onclick = () => void loadMailFolder(false);
mailEl("#mail-form").onsubmit = (event) => { event.preventDefault(); void mailPreviewSend(); };
mailEl("#mail-discard").onclick = () => mailDiscardCompose();
mailEl("#mail-draft-save").onclick = () => void mailSaveDraft();
mailEl("#mail-preview-back").onclick = () => mailClosePreview();
mailEl("#mail-preview-send").onclick = () => void (mailState.sendAttempt?.status === "unknown" ? mailCheckSendStatus() : mailConfirmSend());
for (const tab of document.querySelectorAll("[data-mail-folder]")) {
  tab.onclick = () => {
    if (mailState.busy || mailUnresolvedAttempt()) return;
    mailState.selected = null;
    mailState.attachments = [];
    mailState.composing = false;
    mailInvalidatePreview();
    mailState.folder = tab.dataset.mailFolder;
    for (const other of document.querySelectorAll("[data-mail-folder]")) {
      const on = other === tab;
      other.classList.toggle("on", on);
      other.setAttribute("aria-pressed", String(on));
    }
    void loadMailFolder(true);
    renderMailPane();
  };
}
// 本文・宛先・件名を触ったら確認済み preview は破棄——内容ずれの
// 送信を防ぐため、確認は常に今の内容に対して取り直す。
for (const id of ["#mail-to", "#mail-subject", "#mail-text"]) {
  mailEl(id).oninput = () => { if (mailState.sendAttempt) mailInvalidatePreview(); };
}

// --- 右列 ---
// Web版と同じく、本文と並べて別の情報を選んで見る。
const railLoaded = new Set();
const railLoadRevision = new Map();
let railMusicWorks = [];

function renderRailNowPlaying() {
  const box = document.querySelector("#rail-playing");
  // 右列の音楽パネルが自分の再生カードを持つなら、旧い再生札は出さずカードだけ更新する。
  if (railMusic?.hasPlayer()) { box?.replaceChildren(); railMusic.syncPlayer(); return; }
  if (!box) return;
  const track = musicPlayer.queue.find(item => item.id === musicPlayer.currentId);
  box.replaceChildren();
  if (!track) return;
  // 操作は右列の中で完結させる。共有の再生エンジン（再生待ち・音声）を直接呼び、中央の再生欄や画面には触れない。
  const adjacent = (step) => musicQueue.adjacentMusicQueueTrack(musicPlayer.queue, musicPlayer.currentId, step);
  const controls = [
    { glyph: "⏮", disabled: !adjacent(-1), label: "前の曲", onClick: () => { const prev = adjacent(-1); if (prev) void playMusicTrack(prev); } },
    { glyph: musicAudio.paused ? "▶" : "Ⅱ", primary: true, disabled: !musicPlayer.currentId && musicPlayer.queue.length === 0, label: musicAudio.paused ? "再生" : "一時停止", onClick: () => { void toggleMusicPlayback(); } },
    { glyph: "⏭", disabled: !adjacent(1), label: "次の曲", onClick: () => { const next = adjacent(1); if (next) void playMusicTrack(next); } },
  ];
  box.append(railPanels.railNowPlaying(document, { track, paused: musicAudio.paused, controls }));
  // 再生待ち：いま流れている曲より後ろを数件。押すとその曲から再生する。
  const index = musicPlayer.queue.indexOf(track);
  const upcoming = musicPlayer.queue.slice(index + 1, index + 6);
  if (upcoming.length) {
    const heading = document.createElement("h3"); heading.textContent = `再生待ち · ${musicPlayer.queue.length - index - 1}曲`;
    box.append(heading, ...upcoming.map((item) => railMusicRow(item, () => void playMusicTrack(item, musicPlayer.queue))));
  }
}

function railEmpty(text) {
  const p = document.createElement("p");
  p.className = "meta";
  p.textContent = text;
  return p;
}

function railLoadError(text, retry, showPublicPosts = false) {
  const box = document.createElement("div");
  box.className = "rail-empty";
  const message = document.createElement("p");
  message.textContent = text;
  const actions = document.createElement("div");
  actions.className = "rail-empty-actions";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "再試行";
  button.onclick = retry;
  actions.append(button);
  if (showPublicPosts) {
    const alternateView = MAIN_RAIL_VIEWS[currentView] === "posts" ? "search" : "posts";
    const publicPosts = document.createElement("button");
    publicPosts.type = "button";
    publicPosts.textContent = alternateView === "search" ? "右で検索" : "右で投稿を見る";
    publicPosts.onclick = () => selectRailView(alternateView);
    actions.append(publicPosts);
  }
  box.append(message, actions);
  return box;
}

const railMusicPostDrafts = new Map(), railMusicReportDrafts = new Map();
function initRailMusic() {
  const accountOptions = () => {
    const generation = researchAccountGeneration;
    return { generation, invoke: async (name, args, options) => {
      if (generation !== researchAccountGeneration) throw new Error("接続が変わりました。画面を読み直してください。");
      const result = await invoke(name, args, options);
      if (generation !== researchAccountGeneration) throw new Error("接続が変わりました。画面を読み直してください。");
      return result;
    } };
  };
  const mediaCover = (work) => createMusicArtwork(document, work, { hubAsset, className: "mw-art mw-art-row" });
  let resolver = null;
  return createRailMusic({
    document, host: document.querySelector("#rail-music"), ytHost: document.querySelector("#rail-music-yt"), hubAsset: (img, url) => hubAsset(img, url),
    deps: {
      getTracks: () => railMusicTracks, getWorks: () => railMusicWorks, isHubOriginalWork, empty: () => railMusicEmpty(),
      loadCatalog: async (query) => {
        const [stream, catalog] = await Promise.allSettled([invoke("music_tracks", { query, offset: 0 }), invoke("hub_resource", { resource: "music", query })]);
        if (stream.status === "rejected" && catalog.status === "rejected") throw stream.reason;
        return { tracks: stream.status === "fulfilled" && Array.isArray(stream.value?.tracks) ? stream.value.tracks : [], works: catalog.status === "fulfilled" && Array.isArray(catalog.value?.works) ? catalog.value.works : [] };
      },
      playTrack: (track, queue) => playMusicTrack(track, queue),
      enqueue: (track) => enqueueMusicTrack(track, "next"),
      // 共有の音声エンジンの状態（右列の再生カード用）。操作は下の再生バーと同じ関数を呼ぶ。
      player: {
        state: () => {
          const track = musicPlayer.queue.find(item => item.id === musicPlayer.currentId) ?? null;
          return { track, queue: musicPlayer.queue, paused: musicAudio.paused || musicAudio.ended, currentTime: musicAudio.currentTime || 0,
            duration: Number.isFinite(musicAudio.duration) ? musicAudio.duration : 0,
            hasPrev: Boolean(musicQueue.adjacentMusicQueueTrack(musicPlayer.queue, musicPlayer.currentId, -1)), hasNext: Boolean(musicQueue.adjacentMusicQueueTrack(musicPlayer.queue, musicPlayer.currentId, 1)) };
        },
        subscribe: (fn) => {
          const events = ["timeupdate", "loadedmetadata", "play", "pause", "ended", "emptied"];
          for (const name of events) musicAudio.addEventListener(name, fn);
          return () => { for (const name of events) musicAudio.removeEventListener(name, fn); };
        },
        toggle: () => { void toggleMusicPlayback(); },
        prev: () => { const track = musicQueue.adjacentMusicQueueTrack(musicPlayer.queue, musicPlayer.currentId, -1); if (track) void playMusicTrack(track); },
        next: () => { const track = musicQueue.adjacentMusicQueueTrack(musicPlayer.queue, musicPlayer.currentId, 1); if (track) void playMusicTrack(track); },
        seek: (seconds) => { if (Number.isFinite(musicAudio.duration) && Number.isFinite(seconds)) musicAudio.currentTime = seconds; },
      },
      posts: ({ host, work, isCurrent }) => {
        if (typeof work?.id !== "string" || !MUSIC_WORK_ID.test(work.id)) return null;
        const options = accountOptions();
        const controller = createContentPosts(document, { kind: "music", id: work.id, invoke: options.invoke, renderPost: (post) => postCard(post),
          state: (railMusicPostDrafts.get(work.id) ?? railMusicPostDrafts.set(work.id, {}).get(work.id)),
          isCurrent: () => isCurrent() && options.generation === researchAccountGeneration });
        host.append(controller.element);
        return controller;
      },
      talk: ({ host, work, isCurrent }) => {
        if (!reportableMusicWork(work) || !/^[A-Za-z0-9_-]{1,128}$/u.test(work.id)) return null;
        const options = accountOptions();
        const controller = createCommunityTalk({ document, contentType: "music", contentId: work.id, invoke: options.invoke,
          isCurrent: () => isCurrent() && options.generation === researchAccountGeneration, openThread: openCommunityThread, describeError: friendlyError });
        host.append(controller.root);
        return controller;
      },
      report: ({ host, work, isCurrent, open }) => {
        if (!reportableMusicWork(work)) return null;
        const options = accountOptions();
        const controller = createExternalMusicReport({ document, workId: work.id, invoke: options.invoke,
          getAccount: () => desktopAccount.state === "registered" ? String(researchAccountGeneration) : null,
          isCurrent: () => isCurrent() && options.generation === researchAccountGeneration, state: (railMusicReportDrafts.get(work.id) ?? railMusicReportDrafts.set(work.id, {}).get(work.id)) });
        const box = document.createElement("details");
        box.className = "detail-form";
        box.open = open === true;
        const summary = document.createElement("summary");
        summary.textContent = "作品を報告";
        box.append(summary, controller.element);
        host.append(box);
        return controller;
      },
      download: (work) => HUB_MUSIC_WORK_ID.test(String(work?.id ?? "")) ? { allowed: musicDownloadAllowed(work), open: () => openMusicDownload(work) } : null,
      openExternal: (url) => musicMenuDeps.openExternal(url),
      youtube: { play: (work, panel) => musicYoutube.play({ work, panel }), stop: () => musicYoutube.stop(), isPlaying: (id) => musicYoutube.isPlaying(id), active: () => musicYoutube.active(), subscribe: (fn) => musicYoutube.subscribe(fn) },
      nav: { visit: (route) => railNav.visit("music", "m" + (++railNavSeq), { route }) },
      collection: ({ host, kind, name, artist, actions, isCurrent }) => {
        const seed = [...railMusicTracks, ...railMusicWorks, ...musicPlayer.queue];
        const generation = researchAccountGeneration;
        return renderMusicCollection({ document, host, kind, name, artist, seed, hubAsset: (img, url) => hubAsset(img, url),
          load: () => loadMusicCollectionSources(kind === "album" && artist ? artist : name),
          isCurrent: () => generation === researchAccountGeneration && isCurrent(), actions });
      },
      library: ({ host, actions, isCurrent }) => {
        const options = accountOptions();
        return renderMusicLibrary({ document, host, embedded: true, invoke: options.invoke, renderCover: mediaCover,
          isCurrent: () => options.generation === researchAccountGeneration && isCurrent(),
          onOpen: (work) => actions.open(work), onPlay: (work, queue) => actions.play(work, queue), onQueue: (work) => actions.enqueue(work) });
      },
      playlists: ({ host, actions, isCurrent }) => {
        const options = accountOptions();
        const current = () => options.generation === researchAccountGeneration && isCurrent();
        resolver ??= createItemResolver({ invoke: options.invoke, kind: "music" });
        const controller = createMediaPlaylists({ document, kind: "music", invoke: options.invoke, isCurrent: current, resolveItem: (id) => resolver.resolve(id), renderCover: mediaCover,
          getScope: () => articleEditorScope(), state: {}, getAccount: () => desktopAccount.state === "registered" ? String(researchAccountGeneration) : null,
          onPlay: (selection, scope) => {
            if (!current() || !scope.isCurrent()) return false;
            const queue = selection.workIds.map((workId, index) => { const known = resolver.peek(workId); return { ...(known ? { artist: known.artist, album: known.album, artworkUrl: known.artworkUrl } : {}), id: workId.slice(6), title: known?.title ?? ("楽曲 " + (index + 1)), playlistStub: true }; });
            const track = queue.find((item) => item.id === selection.startId.slice(6));
            return playMusicTrack(track, queue, { isCurrent: () => current() && scope.isCurrent() });
          },
          onOpen: (item) => { if (current()) actions.open(item); } });
        host.append(controller.element);
        return { dispose: () => controller.destroy(), invalidate: () => { controller.invalidate(); controller.destroy(); } };
      },
    },
  });
}

function railMusicEmpty() {
  const box = document.createElement("div");
  box.className = "rail-empty";
  const title = document.createElement("strong");
  title.textContent = "再生できる曲はまだありません";
  const detail = document.createElement("p");
  detail.textContent = "中央の画面を保ったまま、右列を別の作業に使えます。";
  const nextView = currentView === "ai" ? "search" : "ai";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = nextView === "ai" ? "右でAIを開く" : "資料を探す";
  button.onclick = () => document.querySelector(`.rail-view-button[data-rail-view="${nextView}"]`)?.click();
  box.append(title, detail, button);
  return box;
}
function railRow(title, text, at, onOpen) {
  const row = document.createElement("button");
  row.className = "rail-item";
  row.type = "button";
  const head = document.createElement("span");
  head.className = "rail-item-head";
  const who = document.createElement("strong");
  who.textContent = title;
  const when = document.createElement("span");
  when.className = "meta";
  when.textContent = relTime(at);
  head.append(who, when);
  const body = document.createElement("span");
  body.className = "rail-item-text";
  body.textContent = text;
  row.append(head, body);
  row.onclick = onOpen;
  return row;
}

const railReader=createRailReader({document,read:detail=>invoke('hub_detail',detail),friendlyError,
  // 右列のスレッド下の返信欄。中央のスレッド返信と同じ thread_reply（言語・地域もスレッドの宣言の先頭を使う）。
  replyThread:({threadId,text,thread})=>{
    const languages=thread.allowedLanguages?.length?thread.allowedLanguages:[thread.language??'ja'];
    const tags=thread.allowedLanguageTags?.length?thread.allowedLanguageTags:['ja-JP'];
    return invoke('hub_client_action',{action:'thread_reply',target:threadId,text,options:{language:languages.includes(thread.language)?thread.language:languages[0],region:thread.region??'global',languageTag:tags[0],countryCode:thread.allowedCountryCodes?.[0]??null,replyToPostId:null}});
  },
  onState:(key,open,row,item)=>open?railNav.visit(key,'d'+(++railNavSeq),{row,item}):railNav.closed(key),
  open:item=>{if(item.open)return item.open();if(item.detail)return openDetail(item.detail.name,item.detail.ids,{title:item.title});}
});
window.addEventListener('hub-account-changed',()=>{railReader.clear();document.querySelector('#rail-detail-preview-host')?.replaceChildren();});
// 右列の戻る・進む：一覧 ⇄ 詳細。行が作り直されて開けない詳細は捨てる（false）。
// 音楽は右列の中の掘り下げ（rail-music.mjs）。履歴の各項目が描く内容そのものを持つ。
railNav.handle("music", (entry) => { railMusic?.show(entry.key === "list" ? { type: "list" } : entry.data?.route); return true; });
for (const view of ["messages", "mail", "search"]) railNav.handle(view, (entry) => {
  if (entry.key === "list") { railReader.close(view); return true; }
  const { row, item } = entry.data ?? {};
  if (!row?.isConnected) return false;
  if (!railReader.isOpen(view, row)) void railReader.show(view, row, item);
  row.scrollIntoView?.({ block: "nearest" });
  return true;
});
// タイムライン："list" は一覧（開いているチャットも詳細も閉じる）。"g…" はグループのチャット、"d…" は右列の詳細。
railNav.handle("posts", (entry) => {
  if (entry.key === "list") { hideRailChat(); railReader.close("posts"); return true; }
  if (entry.data?.group) { railReader.close("posts"); showRailChat(entry.data.group); return true; }
  const { row, item } = entry.data ?? {};
  if (!row?.isConnected) return false;
  hideRailChat();
  if (!railReader.isOpen("posts", row)) void railReader.show("posts", row, item);
  row.scrollIntoView?.({ block: "nearest" });
  return true;
});
function paintRailNav() {
  const back = document.querySelector("#rail-back"), forward = document.querySelector("#rail-forward");
  if (!back || !forward) return;
  back.disabled = !railNav.can(railNavKey(), -1);
  forward.disabled = !railNav.can(railNavKey(), 1);
}
document.querySelector("#rail-back").onclick = () => void railNav.back(railNavKey());
document.querySelector("#rail-forward").onclick = () => void railNav.forward(railNavKey());
// 通知の「すべて既読」は上の行の右列の操作へ上げる（一覧の中のボタンは隠し、押すと同じ処理を呼ぶ）。
function syncRailMarkAll() {
  const header = document.querySelector("#rail-mark-all");
  if (!header) return;
  const inList = document.querySelector("#rail-notifications .rail-summary .rail-head-action");
  header.hidden = railView !== "notifications" || !inList;
  if (!inList) return;
  inList.hidden = true;
  header.disabled = inList.disabled;
  header.onclick = () => inList.click();
}

let railWalletController = null;
// 右列のウォレット：要約だけを出し、送金・全画面は中央のウォレット画面（確認画面つき）へ渡す。残高は毎回読み直す。
function loadRailWallet() {
  const box = document.querySelector("#rail-wallet");
  if (!box) return;
  railWalletController?.destroy();
  const revision = (railLoadRevision.get("wallet") ?? 0) + 1;
  railLoadRevision.set("wallet", revision);
  const controller = createRailWallet({
    document, invoke, settle: settleWithin, describeError: friendlyError,
    isCurrent: () => railLoadRevision.get("wallet") === revision && railView === "wallet",
    openWallet: openWalletInCenter, onChanged: () => { void loadRailWallet(); if (currentView === "wallet") void loadCatalog("wallet"); }, open: (url) => enterBrowser(url),
  });
  railWalletController = controller;
  box.replaceChildren(controller.element);
}
// 中央のウォレット画面を開く。send:true なら、同じ画面の送金欄を開く（送金できる残高があるときだけ押せる）。
async function openWalletInCenter({ send = false } = {}) {
  await navigateFrom({ dataset: { view: "wallet", title: "ウォレット" }, childNodes: [] });
  if (!send) return;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const button = document.querySelector("#wallet-results .wallet-actions .deny");
    if (button && !button.disabled) { button.click(); return; }
    if (button && attempt > 30) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

window.addEventListener("hub-account-changed", () => { if (railView === "wallet" && desktopShell.classList.contains("rail-open")) void loadRailWallet(); });
// 右列の通知：中央の通知と同じ口（notification_snapshot と既読の書き込み）を、右列専用の制御で使う。
// 既読は中央と同じく、端末・接続先・閲覧者を確かめてから書く。
let railNotificationsData = null, railNotificationsTicket = null, railNotificationsPhase = "idle", railNotificationsError = null;
let notifPopover = null;
const railNotificationsOpen = () => (railView === "notifications" && desktopShell.classList.contains("rail-open")) || Boolean(notifPopover?.isOpen());
const railNotifications = createNotificationsController({
  invoke, getScope: articleEditorScope, isCurrent: railNotificationsOpen,
  onData: (data, ticket) => { railNotificationsData = data; railNotificationsTicket = ticket; paintRailNotifications(); },
  onState: (value) => { railNotificationsPhase = value.phase; railNotificationsError = value.error ?? null; paintRailNotifications(value.pending); },
  onBadge: (count, ticket) => { if (count !== null && railNotifications.isTicketCurrent(ticket)) setBadge("nav-badge-notifications", count); },
  onChanged: () => { if (currentView === "notifications") void loadNotifications(); },
});
function paintRailNotifications(pending = false) {
  queueMicrotask(syncRailMarkAll);
  paintNotifPopover();
  const box = document.querySelector("#rail-notifications");
  if (!box || !railNotificationsOpen()) return;
  if (railNotificationsPhase === "unconnected" || desktopAccount.state !== "registered") {
    box.replaceChildren(railPanels.railSignedOut(document, "notifications", () => void connectDesktopAccount()));
    return;
  }
  if (!railNotificationsData) {
    box.replaceChildren(railNotificationsPhase === "error"
      ? railLoadError(railNotificationsError ? friendlyError(railNotificationsError) : "通知を読み込めませんでした", () => void loadRailNotifications(), true)
      : railPanels.railState(document, "loading"));
    return;
  }
  const ticket = railNotificationsTicket;
  box.replaceChildren(...railPanels.railNotificationNodes(document, railNotificationsData, {
    groups: groupNotifications, textOf: groupedNotificationText, relTime, asset: hubAsset, pending,
    canMark: railNotifications.isTicketCurrent(ticket),
    onMarkAll: () => { const current = railNotifications.capture(); if (current) void railNotifications.markAll(current); },
    onOpen: (group) => void openRailNotification(group),
  }));
  if (railNotificationsPhase === "uncertain") box.prepend(railPanels.railState(document, "error", { detail: "既読にできたか確かめられません。更新して確認してください。" }));
}
// 左の列の「通知」を押すと、横に最新の数件を出す（notification-popover.mjs）。読み出しと開き方は右列の通知と同じ口。
// プログラムからの click()（キー操作や他の画面からの移動）は今までどおり通知の画面へ行く。人が押したときだけ小さな一覧。
const notifRailButton = document.querySelector('.icon-rail [data-view="notifications"]');
if (notifRailButton) {
  notifPopover = createNotificationPopover({
    document, anchor: notifRailButton,
    onOpenItem: (group) => void openRailNotification(group),
    onAll: () => void navigateFrom(notifRailButton),
    onToggle: (open) => { if (open) { paintNotifPopover(); void loadRailNotifications(); } },
  });
  notifRailButton.setAttribute("aria-haspopup", "dialog");
  notifRailButton.setAttribute("aria-expanded", "false");
  notifRailButton.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    notifPopover.toggle();
  }, true);
}
function paintNotifPopover() {
  if (!notifPopover?.isOpen()) return;
  if (desktopAccount.state !== "registered" || railNotificationsPhase === "unconnected") { notifPopover.render({ state: "signedout", message: "Desktopを接続すると通知が見られます" }); return; }
  if (!railNotificationsData) { notifPopover.render(railNotificationsPhase === "error" ? { state: "error", message: "通知を読み込めませんでした" } : { state: "loading" }); return; }
  const data = railNotificationsData;
  const actors = new Map((data.actors ?? []).map((actor) => [actor.id, actor]));
  const items = groupNotifications(Array.isArray(data.notifications) ? data.notifications : []).slice(0, 5).map((group) => {
    const names = group.actorIds.map((id) => actors.get(id)?.displayName).filter(Boolean);
    const first = actors.get(group.actorIds[0]);
    const others = Math.max(0, group.actorIds.length - 1);
    return { ref: group, unread: !group.isRead, time: relTime(group.latest.createdAt),
      title: first ? `${first.displayName || first.handle || "Hub"}${others ? ` ほか${others}人` : ""}` : "Hub",
      text: group.latest.text || groupedNotificationText(group, names) };
  });
  notifPopover.render({ state: "ready", items });
}
async function openRailNotification(group) {
  const data = railNotificationsData, ticket = railNotifications.capture(group.items.map((item) => item.id));
  if (!data || !ticket) return;
  const profiles = new Map((data.actors ?? []).map((profile) => [profile.id, profile]));
  const target = notificationTarget(group.latest, profiles, data.threadPostDestinations ?? {}, data.communityMessageDestinations ?? {});
  for (const item of group.items) {
    if (!railNotifications.isTicketCurrent(ticket)) break;
    if (!item.isRead) await railNotifications.markOne(item.id, ticket);
  }
  if (!target) { showNotice("この通知の行き先は表示できません。"); return; }
  if (target.kind === "detail") await openDetail(target.name, target.ids, { title: target.title, targetSelection: target.state });
  else if (target.kind === "view") await navigateFrom({ dataset: { view: target.view }, childNodes: [] });
  else if (target.kind === "conversation") {
    await navigateFrom({ dataset: { view: "messages" }, childNodes: [] });
    if (currentView === "messages") await openConversation(target.id);
  }
}
function loadRailNotifications() {
  if (desktopAccount.state !== "registered") { railNotifications.invalidate("unconnected"); paintRailNotifications(); return; }
  if (!railNotificationsData) paintRailNotifications();
  return railNotifications.load();
}
window.addEventListener("hub-account-changed", () => { railNotifications.invalidate("account"); railNotificationsData = null; });
// 右列の「メッセージ」は DM とメールを1枚にまとめる。読み書きの経路は別（hub_client / mail_*）のまま、切り替えだけを内側に置く。
const RAIL_MESSAGES_TAB_KEY = "hub.desktop.railMessagesTab.v1";
let railMessagesTab = "dm";
try { if (localStorage.getItem(RAIL_MESSAGES_TAB_KEY) === "mail") railMessagesTab = "mail"; } catch {}
const railMessagesTabs = createRailSubTabs(document, {
  label: "メッセージの種類", selected: railMessagesTab, tabs: [["dm", "DM"], ["mail", "メール"]],
  onSelect(name) {
    railMessagesTab = name;
    try { localStorage.setItem(RAIL_MESSAGES_TAB_KEY, name); } catch {}
    paintRailMessagesTabs();
    paintRailNav();
    if (railView === "messages") void loadRail("messages");
  },
});
document.querySelector("#rail-messages-tabs")?.replaceChildren(railMessagesTabs.element);
function paintRailMessagesTabs() {
  document.querySelector("#rail-messages").hidden = railMessagesTab !== "dm";
  document.querySelector("#rail-mail").hidden = railMessagesTab !== "mail";
}
paintRailMessagesTabs();
// 右列の「タイムライン」：投稿・スレッド・グループの3つを切り替える（rail-timeline.mjs）。戻る・進む・読み込みの記録は "posts" の1本。
const railNavKey = () => railView === "messages" && railMessagesTab === "mail" ? "mail" : railView;
const railTimeline = createRailTimeline({
  document, invoke,
  deps: {
    relTime, hubAsset, icon, paintAvatar, friendlyError,
    storage: (() => { try { return localStorage; } catch { return null; } })(),
    renderPost: (post, options) => postCard(post, options),
    signedIn: () => desktopAccount.state === "registered",
    connect: () => void connectDesktopAccount(),
    viewerId: () => selfProfileId ?? null,
    openPost: (post, row) => void railReader.show("posts", row, { title: "投稿", body: post.body, detail: { name: "post", ids: [post.id] }, open: () => openDetail("post", [post.id], { title: "投稿" }) }),
    openThread: (thread, row) => void railReader.show("posts", row, { title: thread.title || "スレッド", body: "", detail: { name: "thread", ids: [thread.id] }, open: () => openDetail("thread", [thread.id], { title: thread.title }) }),
    openGroup: (group, row) => void openRailGroup(group, row),
    compose: () => document.querySelector("#desktop-compose")?.click(),
    observe: (callback) => typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) callback(); }, { rootMargin: "240px" }) : null,
  },
});
document.querySelector("#rail-timeline")?.replaceChildren(railTimeline.element);
window.addEventListener("hub-account-changed", () => { railTimeline.reset(); if (railView === "posts" && desktopShell.classList.contains("rail-open")) void railTimeline.load(); });
// グループは右列の中でチャットの見せ方（rail-chat.mjs）で開く。公開＝コミュニティ、非公開＝グループDM。書き込みは中央の画面へ渡す。
const railChat = createRailChat({
  document, invoke,
  deps: {
    relTime, hubAsset, icon, paintAvatar, friendlyError,
    getScope: () => articleEditorScope(), getDmScope: () => getDmScope(),
    uploadImages: (files, ctx) => uploadChannelImages(files, ctx),
    uploadDmImages: (items, ctx) => uploadDmImages(items, ctx),
    processImage: (file) => processComposerImage(file),
    openContent: (type, item) => openCommunityContent(type, item),
    isActive: () => desktopShell.classList.contains("rail-open") && railView === "posts",
    // 新着のリアルタイム（Rust が WebSocket を持ち、窓へは id だけの `hub-realtime` を渡す）。無ければ定期取得。
    realtime: window.__TAURI__?.event?.listen ? { invoke: (name, args) => invoke(name, args), listen: (name, handler) => window.__TAURI__.event.listen(name, (event) => handler(event.payload)) } : null,
    openCentral: (group) => group.kind === "private"
      ? navigateFrom({ dataset: { view: "messages" }, childNodes: [] }).then(() => openConversation(group.id))
      : openDetail("community", [group.id], { title: group.title }),
  },
});
document.querySelector("#rail-chat")?.replaceChildren(railChat.element);
function showRailChat(group) { railTimeline.element.hidden = true; void railChat.open(group); paintRailNav(); }
function hideRailChat() { if (!railChat.isOpen) return; railChat.close(); railTimeline.element.hidden = false; }
// 右列の表示・切り替え、窓の焦点で、グループの定期取得を止める・戻す。
window.addEventListener("focus", () => railChat.sync());
window.addEventListener("blur", () => railChat.sync());
railChat.onBack(() => { hideRailChat(); railNav.closed("posts"); paintRailNav(); });
window.addEventListener("hub-account-changed", () => hideRailChat());
function openRailGroup(group) {
  railReader.close("posts");
  railNav.visit("posts", "g" + (++railNavSeq), { group });
  showRailChat(group);
}
// 右列の動画：一覧から選ぶと右列の中で再生する。右列を閉じる・別の表示へ切り替えると、同じ再生枠（ytDock）が小窓を引き継ぐ。
const railVideo = createRailVideo({
  document, invoke,
  deps: {
    hubAsset, relTime, icon, friendlyError, dock: ytDock,
    storage: (() => { try { return localStorage; } catch { return null; } })(),
    openExternal: (url) => void enterBrowser(url),
    nativePlay: (id) => invoke("native_video_play", { id }),
    openCentral: (video) => navigateFrom({ dataset: { view: "videos", title: "動画" }, childNodes: [] }).then(() => openVideoWatch(video)),
    signedIn: () => desktopAccount.state === "registered",
    connect: () => void connectDesktopAccount(),
    onReopen: () => selectRailView("video"),
    observe: (callback) => typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) callback(); }, { rootMargin: "240px" }) : null,
  },
});
document.querySelector("#rail-video")?.replaceChildren(railVideo.element);
railVideo.onChange((change) => {
  if (change.type === "watch") railNav.visit("video", "v" + (++railNavSeq), { video: change.video });
  else railNav.closed("video");
  paintRailNav();
});
railNav.handle("video", (entry) => {
  if (entry.key === "list") { railVideo.closeWatch({ silent: true }); return true; }
  if (entry.data?.video) { railVideo.openWatch(entry.data.video, { silent: true }); return true; }
  return false;
});
window.addEventListener("hub-account-changed", () => railVideo.reset());
async function loadRail(name) {
  if (name === "video") return railVideo.load();
  if (name === "posts") return railTimeline.load();
  if (name === "messages" && railMessagesTab === "mail") name = "mail";
  if (name === "wallet") return loadRailWallet();
  if (name === "notifications") return loadRailNotifications();
  if (name === "messages" && desktopAccount.state !== "registered") {
    railLoaded.delete(name);
    document.querySelector("#rail-messages")?.replaceChildren(railPanels.railSignedOut(document, name, () => void connectDesktopAccount()));
    return;
  }
  if (railLoaded.has(name)) return;
  const box = document.querySelector({ notifications: "#rail-notifications", messages: "#rail-messages", mail: "#rail-mail", music: "#rail-music" }[name]);
  if (!box) return;
  const revision = (railLoadRevision.get(name) ?? 0) + 1;
  railLoadRevision.set(name, revision);
  const current = () => railLoadRevision.get(name) === revision &&
    (!["notifications", "messages", "mail"].includes(name) || desktopAccount.state === "registered");
  railLoaded.add(name);
  railNav.reset(name);
  box.replaceChildren(railPanels.railState(document, "loading"));
  const rowOptions = { relTime, asset: hubAsset };
  try {
    if (name === "music") {
      const [stream, catalog] = await Promise.allSettled([
        invoke("music_tracks"), invoke("hub_resource", { resource: "music", query: "" }),
      ]);
      if (!current()) return;
      if (stream.status === "rejected" && catalog.status === "rejected") throw stream.reason;
      // 右列は自分の一覧を持つ。中央の音楽の検索結果（musicPlayer.tracks）は書き換えない。
      if (stream.status === "fulfilled") railMusicTracks = Array.isArray(stream.value?.tracks) ? stream.value.tracks : [];
      if (catalog.status === "fulfilled") railMusicWorks = Array.isArray(catalog.value?.works) ? catalog.value.works : [];
      railMusic?.showList();
      renderRailNowPlaying();
    }
    if (name === "mail") {
      const data = await invoke("mail_messages", { folder: "inbox", cursor: null });
      if (!current()) return;
      box.replaceChildren(...railPanels.railMailRows(document, data, {
        relTime,
        onOpen: (item, row) => void railReader.show("mail", row, {
          title: item.subject || "（件名なし）", body: item.textBody ?? "",
          open: () => navigateFrom({ dataset: { view: "mail" }, childNodes: [] }).then(() => openMail(item.id)),
        }),
      }));
    }
    if (name === "messages") {
      const data = await invoke("hub_client", { name: "conversations" });
      if (!current()) return;
      box.replaceChildren(...railPanels.railConversationRows(document, data, {
        ...rowOptions, peerOf: conversationPeer,
        onOpen: (conversation, peer, message, row) => void railReader.show("messages", row, {
          title: peer.displayName || "メッセージ",
          body: message?.previewText || (message?.images?.length ? "画像が添付されています。" : "暗号化されたメッセージは中央の会話で確認できます。"),
          open: () => navigateFrom({ dataset: { view: "messages" }, childNodes: [] }).then(() => openConversation(conversation.id)),
        }),
      }));
    }
  } catch (error) {
    if (!current()) return;
    railLoaded.delete(name);
    box.replaceChildren((name === "mail" ? mailNeedsAccount(error) : accountNeeded(error))
      ? railPanels.railSignedOut(document, name === "mail" ? "messages" : name, () => void connectDesktopAccount())
      : name === "mail" && mailNeedsLink(error)
        ? railPanels.railState(document, "empty", { title: "メールはWeb版で有効化してから使えます", detail: "Web版のメール画面でAccountにメールを接続すると、ここにも並びます。" })
        : railLoadError(friendlyError(error), () => void loadRail(name), name === "messages" || name === "mail"));
  }
}

function railMusicRow(item, onOpen) {
  return railPanels.railRow(document, { title: item.title || "楽曲", text: item.artist || "", avatar: railPanels.railAvatar(document, { icon: "music" }), onOpen });
}
function renderRailMusic() {
  renderRailNowPlaying();
  railMusic?.refresh();
}

function refreshRailActivity(force = false) {
  if (force && railView === "video") { void railVideo.refresh(); return; }
  if (force && railView === "posts") { void (railChat.isOpen ? railChat.refresh() : railTimeline.refresh()); return; }
  if (force) { railLoaded.delete(railView); if (railView === "messages") railLoaded.delete("mail"); }
  if (!["search", "ai"].includes(railView)) void loadRail(railView);
}

function placeRailAiWorkspace() {
  if (startupTool) return;
  const workspace = document.querySelector("#ai-workspace");
  const host = document.querySelector("#rail-ai-workspace-host");
  const useRail = railView === "ai" && desktopShell.classList.contains("rail-open") && currentView !== "ai";
  const target = useRail ? host : document.querySelector("#view-ai");
  if (workspace.parentElement !== target) target.prepend(workspace);
  const layout = workspace.querySelector(".harness-layout");
  const history = document.querySelector(".harness-history");
  if (history && layout) {
    const historyTarget = useRail || matchMedia("(max-width: 860px)").matches ? layout : document.querySelector("#sidebar-ai-history");
    if (history.parentElement !== historyTarget) {
      if (historyTarget === layout) layout.prepend(history);
      else historyTarget.append(history);
    }
  }
  updatePiWorkEmptyState();
}

function syncRailView() {
  if (startupTool) return;
  railView = railPreferredView === "ai" && currentView === "ai" ? "search" : railPreferredView;
  const open = desktopShell.classList.contains("rail-open");
  document.querySelector("#rail-view-title").textContent = RAIL_VIEW_NAMES[railView] ?? "";
  document.querySelector("#rail-refresh").hidden = ["browser", "search", "ai"].includes(railView);
  desktopShell.classList.toggle("rail-browser-view", railView === "browser");
  document.querySelector("#rail-ai-new").hidden = railView !== "ai";
  document.querySelector("#rail-ai-history").hidden = railView !== "ai";
  document.querySelector("#rail-ai-conv").hidden = railView !== "ai";
  if (railView !== "ai") {
    document.querySelector("#rail-ai-workspace-host")?.classList.remove("history-open");
    document.querySelector("#rail-ai-history")?.setAttribute("aria-expanded", "false");
  }
  document.querySelector("#rail-open-ai-full").hidden = railView !== "ai";
  for (const pane of document.querySelectorAll(".rail-view")) pane.hidden = pane.dataset.railView !== railView;
  paintRailMessagesTabs();
  if (open && railView === "video") railVideo.show(); else railVideo.release();
  paintRailNav();
  syncRailMarkAll();
  for (const button of document.querySelectorAll(".rail-view-button")) {
    const inMain = button.dataset.railView === "ai" && currentView === "ai";
    button.disabled = inMain;
    button.title = inMain ? `${button.getAttribute("aria-label")}（中央に表示中）` : button.getAttribute("aria-label");
    const selected = open && button.dataset.railView === railView;
    button.classList.toggle("on", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
  placeRailAiWorkspace();
  railChat.sync();
  if (open) refreshRailActivity();
}

document.querySelector("#rail-open-ai-full").onclick = () => navigateFrom({ dataset: { view: "ai", title: "AI" }, childNodes: [] });

function selectRailView(name) {
  if (!RAIL_VIEWS.includes(name) || name === "ai" && currentView === "ai") return;
  railPreferredView = name;
  try { localStorage.setItem(RAIL_VIEW_KEY, railPreferredView); } catch {}
  saveRailChoice(true);
  setDesktopRailOpen(true);
  if (name === "search") requestAnimationFrame(() => railSearchQuery.focus());
}
// 空の「資料・検索」から、右列のほかの使い方へ切り替えられるようにする。
for (const button of document.querySelectorAll("[data-rail-switch]")) button.onclick = () => selectRailView(button.dataset.railSwitch);
// 右端の帯が右列の切り替え役（2026-10-15 所有者指定）。どのボタンも、押せばその表示に切り替えて右列を開く。
// 開いている表示をもう一度押しても閉じない（既定の「音楽」が開いているときに押すと消えて、切り替わらないように見えた）。
// 閉じるのは帯の先頭の開閉ボタンだけ。
function onRailViewButton(name) {
  selectRailView(name);
}
for (const button of document.querySelectorAll(".rail-view-button")) {
  button.onclick = () => onRailViewButton(button.dataset.railView);
}

const railSearchQuery = document.querySelector("#rail-search-query");
const railSearchIntro = document.querySelector("#rail-search-intro");
const railSearchResults = document.querySelector("#rail-search-results");
const sideSearch = createHubSearch({invoke, changed: state => {
  railSearchIntro.hidden = Boolean(state.query || state.filtered);
  railNav.reset("search");
  const groups = publicGroups(state.data), box = railSearchResults;
  box.replaceChildren();
  for (const [key, items] of groups) {
    const heading = document.createElement("h3"); heading.className = "meta"; heading.textContent = GROUP_LABELS[key] ?? key; box.append(heading);
    box.append(...items.map(item => {
      const card = searchResultCard(key, item);
      const title = textValue(item, ["title", "name", "displayName", "authorName", "handle", "slug"]) || GROUP_LABELS[key] || "Hubの項目";
      const body = textValue(item, ["summary", "description", "body", "bio", "artist", "channel"]);
      const open = key === "posts" ? () => openDetail("post", [item.id], {title}) : card.onclick;
      const row = railRow(title, body, item.createdAt, ()=>void railReader.show('search',row,{title,body,open,detail:({articles:'article',threads:'thread',communities:'community',hubpedia:'hubpedia_article',posts:'post'})[key]&&item.id?{name:({articles:'article',threads:'thread',communities:'community',hubpedia:'hubpedia_article',posts:'post'})[key],ids:[item.id]}:undefined}));row.setAttribute('aria-expanded','false');row.disabled=!open;return row;
    }));
  }
  appendSearchControls(box, state, sideSearch);
  document.querySelector("#rail-search-state").textContent = state.pending.length ? "検索しています…" : !state.query && !state.filtered ? "" : groups.length ? `${groups.reduce((sum, [,items]) => sum + items.length, 0)}件 · ${searchScopeText(state)}` : Object.keys(state.errors).length ? "一部の検索を取得できませんでした" : "一致するものがありません";
}});
window.addEventListener("hub-account-changed", () => sideSearch.invalidate());
let sideSearchBinding=null;
const sideSearchFilters=createHubSearchFilters(document,{
  onChange:()=>{if(sideSearchBinding)sideSearchBinding.cancel();else sideSearch.invalidate();document.querySelector('#rail-search-state').textContent='条件を変更しました。適用してください。';},
  onApply:options=>submitSideSearch(railSearchQuery.value,options)});
document.querySelector('#rail-search-filter-host').append(sideSearchFilters.element);
const submitSideSearch=(query,options)=>{
  try{return sideSearch.search(query,options??sideSearchFilters.value());}
  catch {sideSearch.invalidate();document.querySelector('#rail-search-state').textContent='検索条件を確認してください。';return Promise.resolve();}
};
sideSearchBinding=bindSearchInput(railSearchQuery, {form: document.querySelector("#rail-search-form"), search: submitSideSearch, invalidate: () => sideSearch.invalidate()});

const railActivityToggle = document.querySelector("#rail-activity-toggle");
railActivityToggle.onclick = () => {
  const open = !desktopShell?.classList.contains("rail-open");
  saveRailChoice(open);
  setDesktopRailOpen(open);
};
document.querySelector("#rail-refresh").onclick = () => refreshRailActivity(true);
/* D5 rail browser */
// 右列ブラウザ：スマホ幅の専用webview。中央の画面とは独立して動き、畳んでも隠すだけで再生は続く。
if (!startupTool) {
  railBrowser = createRailBrowser({
    document, window, invoke,
    listen: (name, handler) => window.__TAURI__.event.listen(name, handler),
    storage: (() => { try { return window.localStorage; } catch { return null; } })(),
    getHubOrigin: () => invoke("hub_origin"),
    getEngine: () => browserSearchEngine(),
    isShown: () => desktopShell.classList.contains("rail-open") && railView === "browser" && document.querySelector(".rail-body")?.hidden === false,
    reveal: () => selectRailView("browser"),
    openCenterView: (view, title) => void navigateFrom({ dataset: { view, title }, childNodes: [] }),
    openCenterTab: (url) => void enterBrowser(url),
    openExternal: (url) => void invoke("open_external", { url }).catch(() => {}),
    // 同時に2つ鳴らさない：右列が鳴り始めたら中央の再生を止め、中央が鳴り始めたら右列のページを止める。
    pauseCentre: () => playbackOwner.claim("rail-browser"),
    notice: showNotice,
  });
  playbackOwner.register("rail-browser", () => railBrowser?.pauseRail());
  // YouTube 枠が鳴り始めたときの右列の停止は、枠の再生通知（claim）が行う。
  // 中央のリンクの右クリックに「右列で開く」を足す（既定の項目はそのまま）。
  window.hubContextMenu?.register?.((target) => {
    const anchor = target?.closest?.("a[href]");
    let link = null;
    try { const url = anchor ? new URL(anchor.getAttribute("href"), anchor.baseURI) : null; link = url && ["http:", "https:"].includes(url.protocol) ? url.href : null; } catch { link = null; }
    if (!link || !railBrowser) return null;
    const items = [{ label: "右列で開く", run: () => void railBrowser.openInRail(link) }];
    const hub = (() => { try { const url = new URL(link); return url.host === "hub.jkamma.com" || url.origin === hubOrigin; } catch { return false; } })();
    if (!hub) items.push({ label: "新しいタブで開く", run: () => void enterBrowser(link) });
    items.push({ label: "既定のブラウザで開く", run: () => void invoke("open_external", { url: link }).catch(() => {}) }, "-",
      { label: "リンクのアドレスをコピー", run: () => void navigator.clipboard?.writeText(link).catch(() => {}) });
    return items;
  });
}
railActivityReady = true;
railMusic = initRailMusic();
renderRailNowPlaying();
syncRailView();

// 作業フォルダとモデルの状態は、この窓のAI画面に表示する。
async function loadAiStatus() {
  const box = document.querySelector("#ai-status");
  if (!box) return;
  try {
    const [workspace, body] = await Promise.all([
      invoke("dev_workspace").catch(() => null),
      invoke("pi_work_models", {}).catch(() => null),
    ]);
    const models = Array.isArray(body?.models) ? body.models : [];
    const modelLine = models.length
      ? `${body.ready ? `${body.ready.length}件がすぐ使えます` : `${models.length}件を検出`} · 既定 ${body.default || models[0]}`
      : "見つかりません — 下の接続設定を確認してください";
    const facts = document.createElement("div");
    facts.className = "ai-facts";
    for (const [label, value] of [
      ["作業フォルダ", workspace || "未設定 — 下の作業フォルダ設定から選んでください"],
      ["モデル", modelLine],
      ["作業の進め方", "開始・承認・確認はこのHubハーネス画面で行います"],
    ]) {
      const row = document.createElement("p");
      row.className = "ai-fact";
      const key = document.createElement("span");
      key.className = "ai-fact-key";
      key.textContent = label;
      const val = document.createElement("span");
      val.textContent = value;
      row.append(key, val);
      facts.append(row);
    }
    box.replaceChildren(facts);
  } catch {
    box.hidden = true;
  }
}

// DM コンポーザーの添付UI。E2EE 会話では renderThread で隠す。
const dmAttachment=imageAttachmentControl(document.querySelector('#thread-state'),()=>{dmDraftRevision++;saveDmDraft();},{
  capture:()=>dmController?.capture(),current:ticket=>Boolean(dmController?.isTicketCurrent(ticket))});
document.querySelector('#thread-attach').append(dmAttachment.element);
const dmInput=document.querySelector('#thread-input'),dmForm=document.querySelector('#thread-form');dmInput.maxLength=280;
dmInput.addEventListener('input',()=>{dmDraftRevision++;saveDmDraft();});
// Enter で送る・Shift+Enter で改行。変換中の Enter（確定）では送らない（IME）。
dmInput.addEventListener('keydown',event=>{
  if(event.key!=='Enter'||event.shiftKey||event.isComposing||event.keyCode===229)return;
  event.preventDefault();
  if(dmForm.querySelector('button[type=submit]').disabled)return;
  dmForm.requestSubmit();
});
const dmResult=document.createElement('p');dmResult.className='meta';dmResult.setAttribute('role','status');dmForm.after(dmResult);
const dmRecovery=document.createElement('div');dmRecovery.className='detail-form-row';
const dmCheck=actionButton('送信結果を確認','head-action',()=>dmController.recheck());
const dmRetry=actionButton('同じ送信を再試行','head-action',()=>dmController.retrySame());dmRecovery.append(dmCheck,dmRetry);dmResult.after(dmRecovery);
dmController=createDmController({invoke,getScope:getDmScope,isCurrent:()=>currentView==='messages',
  getDraft:()=>({text:dmInput.value,images:[...dmAttachment.images],revision:dmDraftRevision}),
  onSelection:switchDmDraft,
  onData:(data,meta)=>{
    if(!data){
      if(!dmPreserveDrafts)clearDmPrivate();messagesData=null;activeConversationId=null;dmAttachment.replaceImages([]);dmInput.value='';
      for(const id of ['messages-list','thread-list','thread-state'])document.getElementById(id).replaceChildren();
      if(currentView==='messages'&&!dmPreserveDrafts)document.querySelector('#thread-list').append(connectState('会話を開くには、Hubへの接続と閲覧権限を確認してください。'));
      dmForm.hidden=true;setBadge('nav-badge-messages',0);return;
    }
    const owner=JSON.stringify([dmScopeKey,data.currentProfileId]);if(dmDraftOwner&&dmDraftOwner!==owner)clearDmPrivate();dmDraftOwner=owner;
    switchDmDraft(meta.conversationId);messagesData=data;
    const profiles=new Map(data.profiles.map(profile=>[profile.id,profile])),latest=new Map();
    for(const message of data.messages){const prior=latest.get(message.conversationId);if(!prior||message.createdAt>prior.createdAt)latest.set(message.conversationId,message);}
    document.querySelector('#messages-list').replaceChildren(...(data.conversations.length?data.conversations.map(conversation=>conversationCard(conversation,profiles,data.currentProfileId,latest)):[emptyState('bubble','会話はまだありません')]));
    setBadge('nav-badge-messages',data.messageCount);renderThread();
    if(currentView==='messages'||currentView==='mail')renderSidebarContext(currentView);
  },
  onState:value=>{
    dmForm.querySelector('button[type=submit]').disabled=value.pending||!activeConversationId||Boolean(value.attemptState);
    dmCheck.hidden=dmRetry.hidden=!value.uncertain;dmCheck.disabled=value.pending;dmRetry.disabled=value.pending||!value.retryAvailable;
    const detail={loading:'会話を読み込んでいます…',preparing:'送信を準備しています…',sending:'送信中…',reading:'既読を確認しています…',sent:'送信を確認しました。',unknown:'送信結果が不明です。再送せず、結果を確認してください。',read_error:'既読を確認できませんでした。最新の未読状態を表示しています。',rejected:'送信は確認できませんでした。内容と接続を確認してください。',conflict:'送信済みメッセージと内容が一致しません。再送せず、会話を確認してください。',error:'会話を読み込めませんでした。接続と投稿権限を確認してください。',idle:''};
    if(value.phase==='loading')dmLoadPending=true;else if(value.phase!=='error')dmLoadPending=false;
    const loadError=value.phase==='error'&&dmLoadPending;
    // 読み込み中の知らせは会話一覧の側（#messages-state）だけに出す。送信欄の下には送信の状態だけを出す。
    // 読み込みの失敗は、会話一覧の側に共通の .state-panel と二番手の再試行で置く。
    dmResult.textContent=value.phase==='loading'||loadError?'':detail[value.phase]??'';document.querySelector('#messages-state').textContent=value.phase==='loading'?detail.loading:'';
    document.querySelector('#thread-state').hidden=value.phase==='loading'&&!activeConversationId;
    if(loadError){document.querySelector('#messages-list').replaceChildren(statePanel('alert','会話を読み込めませんでした','接続と投稿権限を確認してください。',()=>loadMessages()));
      const threadList=document.querySelector('#thread-list');if(!activeConversationId&&!threadList.childElementCount)threadList.append(threadIdleState());}
  },
  onSent:()=>{void loadHomeSummary();},
  onClearDraft:captured=>{
    if(dmInput.value!==captured.text||dmDraftRevision!==captured.revision||dmAttachment.images.length!==captured.images.length||dmAttachment.images.some((item,i)=>item!==captured.images[i]))return;
    dmDrafts.delete(activeConversationId);dmInput.value='';dmAttachment.clear();dmDraftRevision++;
  },
  uploadFiles:(items,ctx)=>uploadDmImages(items,ctx)
});
// 中央のDM欄と右列のグループ欄で共有する、DM画像のアップロード。
async function uploadDmImages(items,ctx){
  const imageIds=[];
  for(const item of items){
    ctx.assertCurrent();const image=await item.blob.arrayBuffer();ctx.assertCurrent();
    const thumbnail=await item.thumbnailBlob.arrayBuffer();ctx.assertCurrent();
    const result=await ctx.invoke('hub_upload_dm_image',{image:Array.from(new Uint8Array(image)),thumbnail:Array.from(new Uint8Array(thumbnail)),width:item.width,height:item.height,thumbnailWidth:item.thumbnailWidth,thumbnailHeight:item.thumbnailHeight,altText:''});
    ctx.assertCurrent();if(!result?.image?.id)throw Error('dm_unknown');imageIds.push(result.image.id);
  }
  return imageIds;
}
dmForm.onsubmit=event=>{event.preventDefault();void dmController.send();};
document.querySelector("#thread-back").onclick=()=>setDmThreadShown(false);
window.addEventListener('hub-account-changed',()=>{dmController.invalidate('account');dmScopeKey=null;if(currentView==='messages')void loadMessages();});
window.addEventListener('hub-origin-changed',()=>{dmController.invalidate('scope');dmScopeKey=null;if(currentView==='messages')void loadMessages();});

// Public page links are previews; the existing composer remains the only submit path.
async function contentShareContext(){
  const captured=await captureHomeScope(homeAccountSnapshot());
  if(!captured||captured.state!=='registered'||!homeAccountCurrent(captured))return null;
  return {origin:captured.origin,key:JSON.stringify([captured.origin,captured.deviceId,captured.keyThumbprint??null]),epoch:captured.epoch};
}
async function offerPublicContentShare(input){
  const offered=await contentSharePreview?.offer(input);
  if(!offered&&(input.isCurrent()||currentView==='feed'))showNotice('紹介するにはDesktopの接続を確認し、投稿先をHubにしてください。草稿は保持しています。');
  return offered;
}
contentSharePreview=createContentShare({document,host:composer.form.querySelector(".composer-body"),textarea:composer.text,getContext:contentShareContext,
  isCurrent:()=>currentView==='feed'&&socialMode==='mixed'&&socialFilter==='post'&&socialScope==='latest'&&nodePostComposer.mode.value==='hub',
  onNavigate:()=>selectSocial('mixed','post','latest'),
  onOpenReference:(href,isCurrent,event)=>{const account=homeAccountSnapshot();return openSharedContentReference(href,()=>isCurrent()&&homeAccountCurrent(account),event);}});
for(const name of ['hub-account-changed','hub-origin-changed'])window.addEventListener(name,()=>contentSharePreview.invalidate());

// 公開コンテンツ→AI、AIの最終回答→投稿欄。どちらも下書きを置くだけで、実行も投稿もしない。
async function aiHandoffContext(){
  const epoch=homeAccountEpoch,account=desktopAccount,keyOf=()=>JSON.stringify([desktopAccount.state,desktopAccount.deviceId??null,desktopAccount.keyThumbprint??null]),key=keyOf();
  const origin=homeCanonicalOrigin(await invoke('hub_origin'));
  return epoch===homeAccountEpoch&&account===desktopAccount&&key===keyOf()?{origin,key,epoch}:null;
}
async function askAiAboutPublicContent(draft,source){
  const generation=researchAccountGeneration,account=desktopAccount,epoch=homeAccountEpoch;
  const current=()=>generation===researchAccountGeneration&&account===desktopAccount&&epoch===homeAccountEpoch&&source?.isCurrent?.()!==false;
  if(!current())return false;
  if(!piWorkDraftHandler)throw new Error('ai_work_unavailable');
  return await piWorkDraftHandler(draft,{isCurrent:current})===true;
}
// 詳細画面の「AIに聞く」。すでに描画した公開データだけを材料にし、投稿の公開範囲が public でなければ出さない。
function attachDetailAiHandoff(entry,data,target,current){
  const kind={post:'post',article:'article',video:'video'}[entry.name],id=entry.ids?.[0];
  if(!kind||typeof id!=='string'||!id)return;
  const item={post:data?.post,article:data?.article,video:data?.video??data,music:data?.work??data}[kind];
  if(!item||typeof item!=='object'||kind==='post'&&item.audience!=='public')return;
  const href={post:`/v2/posts/${id}`,article:`/v2/articles/${id}`,video:`/v2/videos/${id}`,music:`/v2/music/works/${encodeURIComponent(id)}`}[kind];
  const text=()=>{
    const facts=[item.channel,item.category,item.artist,item.album,item.genre,item.seller].filter(value=>typeof value==='string'&&value).join(' / ');
    return [facts,kind==='post'||kind==='article'?item.body:item.description].filter(value=>typeof value==='string'&&value).join('\n\n');
  };
  const options=researchEditorOptions(entry),epoch=homeAccountEpoch;
  const verify=kind==='music'?async()=>{
    const me=await options.invoke('hub_client',{name:'me'}),shared=await options.invoke('hub_detail',{name:'music_share_context',ids:[id]});
    return typeof me?.profile?.id==='string'&&Boolean(shared)&&Reflect.ownKeys(shared).length===3&&shared.viewerId===me.profile.id&&shared.publicAvailable===true&&shared.reference?.kind==='music'&&shared.reference.href===href;
  }:undefined;
  const row=document.createElement('div');row.className='ai-handoff-row';
  const anchor=kind==='post'?target.children[data.ancestors?.length??0]:null;
  const articleActions=kind==='article'?target.querySelector('.article-actions'):null;
  if(articleActions)articleActions.append(row);else if(anchor)anchor.after(row);else target.append(row);
  const title=String(kind==='post'?(item.authorName?`${item.authorName}の投稿`:'投稿'):(item.title??entry.title??'')).slice(0,200);
  const ai=attachAiHandoff({document,host:row,kind,href,title,getText:text,getContext:aiHandoffContext,isCurrent:()=>epoch===homeAccountEpoch&&current(),verify,onAsk:askAiAboutPublicContent});
  if(!ai){row.remove();return;}
  if(kind==='music'){const prior=researchDetailController;researchDetailController={dispose(){prior?.dispose?.();ai.dispose();},invalidate(){prior?.invalidate?.();ai.invalidate();}};}
}
async function draftPostFromAiAnswer(answer){
  const draft=buildPostDraftFromAnswer(answer);
  if(!draft)return false;
  const generation=researchAccountGeneration,account=desktopAccount,epoch=homeAccountEpoch;
  await selectSocial('mixed','post','latest');
  if(generation!==researchAccountGeneration||account!==desktopAccount||epoch!==homeAccountEpoch||currentView!=='feed')return false;
  if(composer.text.disabled){showNotice('投稿の下書きにするにはDesktopの接続が必要です。');return false;}
  if(composer.text.value.trim()){showNotice('投稿欄に書きかけの内容があるため、上書きしませんでした。');composer.text.focus();return false;}
  composer.text.value=draft.text;
  composer.text.dispatchEvent(new Event('input',{bubbles:true}));
  openComposeDialog();
  composer.note.textContent=draft.truncated?'AIの最終回答が500文字を超えたため、先頭500文字までに切り詰めました。内容を確認して「ポスト」で投稿できます。':'AIの最終回答を下書きにしました。内容を確認して「ポスト」で投稿できます。';
  if(draft.truncated)showNotice(composer.note.textContent);
  return true;
}

// --- プロフィール ---
let profileRequest=0;
window.addEventListener('hub-account-changed',()=>{
  profileRequest++;selfProfileId=null;selfProfileHandle=null;
  document.querySelector('.profile-card').hidden=true;
  for(const id of ['profile-avatar','profile-name','profile-handle','profile-stats','profile-bio','profile-facts','profile-actions','profile-posts'])document.getElementById(id)?.replaceChildren();
  if(currentView==='profile')void loadProfile();
});
// 表紙は 3:1。画像が無いときは --content-nested の無地（外部の画像は読まない）。
function paintProfileCover(node, profile) {
  node.replaceChildren();
  const url = profile.coverUrl || profile.headerUrl || profile.bannerUrl;
  if (typeof url === "string" && url) {
    const img = document.createElement("img");
    hubAsset(img, url);
    img.alt = "";
    img.decoding = "async";
    node.append(img);
  }
}
function profileViewDeps() {
  return {
    postCard, emptyState,
    personCard: (person) => contactCard(person),
    openProfile: (handle) => void openDetail("profile", [handle], { title: `@${handle}` }),
    openThread: (thread) => void openDetail("thread", [thread.id], { title: thread.title }),
    openCommunity: (community) => void openDetail("community", [community.id], { title: community.name }),
    openUrl: (url) => void enterBrowser(url),
    copyText: (text) => navigator.clipboard.writeText(text),
    onEdit: (handle) => void openHubPath(`/v2/profile/${encodeURIComponent(handle)}`),
    onBookmarks: () => document.querySelector('#primary-nav [data-view="bookmarks"]')?.click(),
    onLists: () => document.querySelector('#primary-nav [data-view="lists"]')?.click(),
    onManageChannel: () => void openVideoStudio(),
    // 記事・動画・音楽・研究・マーケット・コードのタブ。名前は hub_client.rs の許可表の profile_* だけ。
    loadWorks: (name, ids) => invoke("hub_detail", { name, ids }),
    openWork: openProfileWork,
    workRow: profileWorkRow,
    createWork: createProfileWork,
  };
}
// プロフィールのタブの行を開く。各画面と同じ開き口（記事・動画・研究・出品）を使い、音楽はその場で再生する。
function openProfileWork(item) {
  const raw = item.raw ?? {};
  if (item.kind === "articles") return void openDetail("article", [item.id], { title: item.title });
  if (item.kind === "videos") return void invoke("hub_detail", { name: "video", ids: [item.id] }).then((data) => { if (data?.video) openVideoWatch(data.video); }).catch((error) => showNotice(friendlyError(error)));
  if (item.kind === "music") return void playMusicWork(raw);
  if (item.kind === "research") return void openDetail("research_project", [item.id], { title: item.title });
  if (item.kind === "market") {
    if (raw.source === "game") return void openStoreGame({ ...raw, slug: raw.slug });
    // Commerce の公開商品。買う画面は既存の商品詳細（決済は Commerce の道）。
    if (raw.source === "product") return void invoke("commerce_public_product", { productId: item.id }).then((data) => {
      if (data?.product?.id !== item.id) throw new Error("commerce_product_unavailable");
      return openDetail("commerce_product", [item.id], { local: true, data: data.product, title: item.title });
    }).catch((error) => showNotice(friendlyError(error)));
    // 売ります・買います／仕事は個別の頁が無い。アプリ内にはこの画面が無いので、Webの一覧を既定のブラウザで開く。
    if (raw.source === "classified") return void openHubWebPath("/v2/market");
    if (raw.source === "work") return void openHubWebPath("/v2/work");
    return void openDetail("listing", [item.id], { title: item.title });
  }
  if (item.kind === "code") return void openHubPath(`/v2/code/${encodeURIComponent(item.owner)}/${encodeURIComponent(item.name)}`, item.name);
}
// 行の中身は、その種類の各画面（タグ詳細の種類別・検索結果）と同じ catalogCard。
function profileWorkRow(item) {
  const raw = item.raw;
  if (!raw) return null;
  const open = () => openProfileWork(item);
  const when = relTime(raw.publishedAt ?? raw.updatedAt);
  if (item.kind === "articles") return catalogCard({ title: item.title, body: raw.locked ? "" : raw.summary, meta: [raw.locked ? "閲覧条件つき" : "", when], onOpen: open });
  if (item.kind === "videos") return catalogCard({ title: item.title, imageUrl: raw.thumbnailUrl, meta: [raw.locked ? "閲覧条件つき" : raw.duration, when], onOpen: open });
  if (item.kind === "music") return catalogCard({ title: item.title, body: raw.artist, menuWork: raw, onOpen: open });
  if (item.kind === "research") return catalogCard({ title: item.title, meta: [item.meta, when], onOpen: open });
  if (item.kind === "market") return catalogCard({ title: item.title, body: raw.summary, meta: [item.meta, { game: "ゲーム", product: "商品", classified: "売ります・買います", work: "仕事" }[raw.source] ?? "", when], onOpen: open });
  return null;
}
// 本人の空のタブから、その種類を作る画面へ。既存の入口のボタンを押すだけ（新しい作成画面は作らない）。
function createProfileWork(kind) {
  if (kind === "videos") return void openVideoStudio();
  if (kind === "articles") return void openPostComposer();
  const [view, button] = { articles: ["articles", "#articles-create-toggle"], music: ["music", "#music-add-external"], research: ["research", "#research-create-web"], market: ["market", '[data-shop-tab="listings"]'] }[kind] ?? [];
  if (!view) return;
  mineGo(view);
  setTimeout(() => mineClick(button), 0);
}
async function renderOwnProfileSections(me, full, posts) {
  const stats = me.stats ?? {};
  const data = { ...(full ?? {}), profile: me.profile, isCurrentUser: true,
    posts: full?.posts ?? me.posts ?? [],
    postCount: stats.postCount ?? me.posts?.length ?? 0,
    followerCount: full?.followerCount ?? stats.followerCount, followingCount: full?.followingCount ?? stats.followingCount };
  const deps = { ...profileViewDeps(), origin: hubOrigin ?? await invoke("hub_origin").catch(() => null) };
  const body = createProfileBody(document, data, deps);
  document.querySelector("#profile-actions").replaceChildren(renderProfileActions(document, data, { ...deps, shortcutsSeparate: true }));
  document.querySelector("#profile-facts").replaceChildren(renderProfileFacts(document, data, deps));
  document.querySelector("#profile-shortcuts").replaceChildren(renderProfileShortcuts(document, data, deps));
  document.querySelector("#profile-stats").replaceChildren(renderProfileStats(document, data, { omitPosts: true, onConnections: (kind) => { body.showConnections(kind); if (currentView === "profile") renderSidebarContext("profile"); } }));
  posts.replaceChildren(body.root);
  // 本文の札を押したとき、左の木の「いま開いている行」も追従させる（木の行を押したときは自分で描き直す）。
  body.root.addEventListener("click", (event) => { if (event.target.closest?.(".profile-tab") && currentView === "profile") renderSidebarContext("profile"); });
  if (currentView === "profile") renderSidebarContext("profile");
  void body.ready.then(() => { if (currentView === "profile") renderSidebarContext("profile"); });
}
async function loadProfile() {
  const request=++profileRequest,generation=researchAccountGeneration,account=desktopAccount;
  const current=()=>request===profileRequest&&generation===researchAccountGeneration&&account===desktopAccount&&currentView==='profile';
  const state = document.querySelector("#profile-state");
  const posts = document.querySelector("#profile-posts");
  state.textContent = "";
  state.classList.remove("warning");
  posts.replaceChildren(skeletonPost(), skeletonPost());
  try {
    const me = await invoke("hub_client", { name: "me" });
    if(!current())return;
    const profile = me.profile;
    selfProfileId = profile?.id ?? null;selfProfileHandle = profile?.handle ?? null;
    paintRailAvatar(document.querySelector("#rail-profile-avatar"), profile, hubAsset);
    document.querySelector(".profile-card").hidden = false;
    const profileAvatar = document.querySelector("#profile-avatar");
    profileAvatar.replaceChildren();
    if (profile.avatarUrl) {
      const img = document.createElement("img");
      hubAsset(img, profile.avatarUrl);
      img.alt = "";
      profileAvatar.classList.add("has-image");
      profileAvatar.append(img);
    } else {
      profileAvatar.classList.remove("has-image");
      profileAvatar.textContent = (profile.displayName || profile.handle || "?").trim().slice(0, 1).toUpperCase();
      paintAvatar(profileAvatar, profile.displayName || profile.handle);
    }
    document.querySelector("#profile-name").textContent = profile.displayName || "（名無し）";
    document.querySelector("#profile-handle").textContent = profile.handle ? `@${profile.handle}` : "";
    const paintProfilePoints = (value) => { document.querySelector("#profile-handle .post-points")?.remove(); const node = pointsBadge(document, value ?? null, icon); if (node) document.querySelector("#profile-handle").append(node); };
    paintProfilePoints(profile.badgePoints);
    paintProfileCover(document.querySelector("#profile-cover"), profile);
    { const bioNode = document.querySelector("#profile-bio"); bioNode.textContent = profile.bio || ""; bioNode.previousElementSibling?.classList?.contains("bait-warning") && bioNode.previousElementSibling.remove(); addBaitRow(document, bioNode, profile.bio || ""); }
    // 種類別のタブ・フォロー一覧・リンク・固定の投稿は公開プロフィールの応答から（profile-view.mjs）。読めなければ me の投稿だけで描く。
    const full = profile.handle ? await invoke("hub_detail", { name: "profile", ids: [profile.handle] }).catch(() => null) : null;
    if (current() && full?.profile?.badgePoints !== undefined) paintProfilePoints(full.profile.badgePoints);
    if(!current())return;
    await renderOwnProfileSections(me, full?.profile?.id === profile.id ? full : null, posts);
  } catch (error) {
    if(!current())return;
    // 空のプロフィール枠が残ると壊れた画面に見える——中身が無いなら枠も出さない。
    document.querySelector(".profile-card").hidden = true;
    state.textContent = "";
    state.classList.remove("warning");
    if (accountNeeded(error)) {
      posts.replaceChildren(connectState());
    } else {
      posts.replaceChildren(statePanel("alert", "読み込めませんでした", friendlyError(error), loadProfile));
    }
  }
}

// --- この端末 ---
// Rust側には身元・保管先・同期があるのに、窓には開発と承認しか無かった。
// 中身にあるものが画面に無いと、無いのと同じになる。
const node = {
  name: document.querySelector("#node-name"),
  url: document.querySelector("#node-url"),
  storage: document.querySelector("#node-storage"),
  enabled: document.querySelector("#node-enabled"),
  login: document.querySelector("#node-login"),
  state: document.querySelector("#node-state"),
  save: document.querySelector("#node-save"),
  sync: document.querySelector("#node-sync")
};

const nodeStartup = createNodeStartup({document,invoke,checkbox:node.login,
  status:document.querySelector("#node-startup-state"),isMain:()=>!startupTool,isCurrent:()=>currentView==='node'});
const SYNC_STATE = { ready: "待機中", pending: "配信待ち", syncing: "配送中", error: "受領を確認できていません" };

function showNode(state) {
  if (!state) {
    node.state.textContent = "この端末の保管先が使えません";
    node.state.classList.add("warning");
    for (const field of [node.name, node.url, node.storage, node.enabled, node.login, node.save, node.sync]) field.disabled = true;
    return;
  }
  // 鍵の指紋。どの身元で名乗っているかを見せる。**公開鍵からしか作っていない。**
  const key = document.querySelector("#node-key");
  key.textContent = state.keyThumbprint
    ? "身元鍵 " + state.keyThumbprint.slice(0, 16) + "…（EC P-256）"
    : "身元鍵がありません。この端末はノードとして名乗れません";
  key.classList.toggle("warning", !state.keyThumbprint);
  node.name.value = state.deviceName;
  node.url.value = state.hubUrl ?? "";
  node.storage.value = state.storagePath;
  node.enabled.checked = state.enabled;
  nodeStartup.setSavedPreference(state.launchAtLogin);
  // 一度も同期していないなら、そう言う。空欄より分かる。
  const when = state.lastSyncConfirmed === true && state.lastSyncAt && Number.isFinite(new Date(state.lastSyncAt * 1000).getTime()) ? WHEN.format(new Date(state.lastSyncAt * 1000)) : "未確認";
  node.state.textContent = `${SYNC_STATE[state.syncState] ?? state.syncState} · 確認した配送 ${when} · 配信待ち ${state.queuedItems}件`;
  node.state.classList.toggle("warning", state.syncState === "error");
  node.sync.disabled = !state.enabled;
}

let personalNodeDashboard=null;
function nodeDashboard(){
  const host=document.querySelector("#personal-node-dashboard");document.querySelector("#view-node .view-head").after(host);
  if(!personalNodeDashboard){personalNodeDashboard=createPersonalNodeDashboard(document,{invoke,
    isCurrent:()=>currentView==='node',getAccount:()=>desktopAccount.state==='registered'?String(researchAccountGeneration):null});
    document.querySelector('#personal-node-dashboard').append(personalNodeDashboard.element);return personalNodeDashboard.ready;}
  return personalNodeDashboard.reload();
}
window.addEventListener('hub-account-changed',()=>{musicPlayer.request++;const current=musicPlayer.currentTrack;replaceMusicQueue(current?[current]:[]);musicFavoriteRead=null;for(const control of musicFavoriteControls)control.destroy();musicFavoriteControls.clear();personalNodeDashboard?.dispose();personalNodeDashboard=null;document.querySelector('#personal-node-dashboard').replaceChildren();if(currentView==='node')void nodeDashboard();});
async function loadNode({keepDraft=false}={}) {
  if(currentView==='node')void nodeDashboard();
  try {
    const state=await invoke("node_state");
    const draft=keepDraft?{name:node.name.value,url:node.url.value,storage:node.storage.value,enabled:node.enabled.checked}:null;
    showNode(state);
    if(draft){node.name.value=draft.name;node.url.value=draft.url;node.storage.value=draft.storage;node.enabled.checked=draft.enabled;}
    if(currentView==='node')await nodeStartup.refresh();
  } catch (error) { node.state.textContent = friendlyError(error); node.state.classList.add("warning"); }
}
document.querySelector("#node-refresh").onclick=async()=>{
  const button=document.querySelector("#node-refresh");if(button.disabled)return;button.disabled=true;
  try{await loadNode({keepDraft:true});}finally{button.disabled=false;}
};

node.save.onclick = async () => {
  if(node.save.disabled)return;
  hubPeers.invalidate();
  node.save.disabled = true;
  const startup=nodeStartup.saveInput();
  try {
    showNode(await invoke("save_node_settings", { startup:startup.applyStartup, settings: {
      deviceName: node.name.value,
      enabled: node.enabled.checked,
      launchAtLogin: startup.launchAtLogin,
      storagePath: node.storage.value,
      hubUrl: node.url.value
    } }));
    await nodeStartup.refresh();
    node.state.textContent = "保存しました";
    node.state.classList.remove("warning");
  } catch (error) {
    node.state.textContent = friendlyError(error);
    node.state.classList.add("warning");
    await nodeStartup.refresh();
  }
  node.save.disabled = false;
};

const nodeSyncDialog = document.querySelector("#node-sync-dialog");
let nodeSyncPanel = null;
document.querySelector("#node-sync-close").onclick = () => nodeSyncDialog.close();
nodeSyncDialog.addEventListener("close", () => {
  nodeSyncPanel?.destroy(); nodeSyncPanel = null;
  document.querySelector("#node-sync-body").replaceChildren();
});
node.sync.onclick = () => {
  if (startupTool || currentView !== "node" || nodeSyncDialog.open || node.sync.disabled) return;
  const generation = researchAccountGeneration;
  const current = () => nodeSyncDialog.open && currentView === "node" && generation === researchAccountGeneration;
  nodeSyncPanel = createNodeSync({document, invoke, isMain: () => !startupTool, isCurrent: current,
    onState: state => { if (current()) showNode(state); },
    onInspectOriginal: sequence => { if (current()) return nodePostComposer.openOriginal(sequence); }});
  document.querySelector("#node-sync-body").replaceChildren(nodeSyncPanel.element);
  nodeSyncDialog.showModal();
};
window.addEventListener("hub-account-changed", () => { if (nodeSyncDialog.open) nodeSyncDialog.close(); });

// 公開は preview と commit を分ける。入力が1文字でも変われば、前の確認は無効。
const content = {
  kind: document.querySelector("#content-kind"),
  title: document.querySelector("#content-title"),
  language: document.querySelector("#content-language"),
  body: document.querySelector("#content-body"),
  preview: document.querySelector("#content-preview"),
  clear: document.querySelector("#content-clear"),
  panel: document.querySelector("#content-preview-panel"),
  summary: document.querySelector("#content-preview-summary"),
  previewBody: document.querySelector("#content-preview-body"),
  confirm: document.querySelector("#content-confirm-public"),
  publish: document.querySelector("#content-publish"),
  state: document.querySelector("#content-state"),
  current: null
};

function invalidateContentPreview() {
  content.current = null;
  content.panel.hidden = true;
  content.confirm.checked = false;
  content.publish.disabled = true;
}

for (const field of [content.kind, content.title, content.language, content.body]) {
  field.addEventListener("input", invalidateContentPreview);
  field.addEventListener("change", invalidateContentPreview);
}

content.preview.onclick = async () => {
  content.preview.disabled = true;
  content.state.textContent = "公開条件を確認中…";
  content.state.classList.remove("warning");
  try {
    const preview = await invoke("preview_public_content", { input: {
      kind: content.kind.value,
      title: content.title.value,
      body: content.body.value,
      language: content.language.value
    } });
    content.current = preview;
    content.summary.textContent = `${preview.kind} · ${preview.characterCount}文字 / ${preview.byteLength}バイト · 公開 · ミラー許可 · AI学習は同意必須 · ${preview.nodeUrl}`;
    content.previewBody.textContent = `${preview.title ? preview.title + "\n\n" : ""}${preview.body}`;
    content.panel.hidden = false;
    content.confirm.checked = false;
    content.publish.disabled = true;
    content.state.textContent = `プレビュー期限 ${WHEN.format(new Date(preview.expiresAt))}`;
  } catch (error) {
    invalidateContentPreview();
    content.state.textContent = friendlyError(error);
    content.state.classList.add("warning");
  }
  content.preview.disabled = false;
};

content.confirm.onchange = () => {
  content.publish.disabled = !content.current || !content.confirm.checked;
};

content.publish.onclick = async () => {
  if (!content.current || !content.confirm.checked) return;
  content.publish.disabled = true;
  try {
    const receipt = await invoke("publish_public_content", { input: {
      previewId: content.current.previewId,
      confirmedPublic: true
    } });
    content.state.textContent = `配信待ちへ追加しました · #${receipt.sequence} · ${receipt.contentId}`;
    content.state.classList.remove("warning");
    content.current = null;
    content.panel.hidden = true;
    await loadNode();
  } catch (error) {
    content.state.textContent = friendlyError(error);
    content.state.classList.add("warning");
    content.publish.disabled = false;
  }
};

content.clear.onclick = () => {
  content.title.value = "";
  content.body.value = "";
  invalidateContentPreview();
  content.state.textContent = "";
};

// --- ゲーム（ストアはマーケットのゲームの種別） ---
const marketGamesView = { main: document.querySelector("#market-games-main"), query: document.querySelector("#market-games-query"), request: 0 };

// 購入・入手はWebのマーケットの商品頁（Commerce の道）。アプリ内に別の決済は作らない。
async function openStoreGame(entry) {
  try { await invoke("open_external", { url: new URL(`/v2/market/games/${encodeURIComponent(entry.slug)}`, await invoke("hub_origin")).href }); }
  catch (error) { showNotice(friendlyError(error)); }
}

// ゲーム画面の「ストア」は、マーケットを開いてゲームの種別へ移る入口。
function openMarketGames() {
  document.querySelector('.nav-item[data-view="market"]')?.click();
  document.querySelector('[data-shop-tab="games"]')?.click();
}

const marketGames = createMarketGames({
  document, host: marketGamesView.main,
  deps: { asset: hubAsset, openWeb: (entry) => void openStoreGame(entry), reloadStore: () => void loadMarketGames() },
});
marketGamesView.query.oninput = () => marketGames.setQuery(marketGamesView.query.value);

// この PC のゲーム（2026-11-06）。Steam・Epic の導入記録を端末内で読むだけ。一覧は Hub へ送らない。ゲーム種別の本文の上に置く。
const pcGamesHost = document.createElement("section");
pcGamesHost.id = "pc-games";
pcGamesHost.setAttribute("aria-label", "この PC のゲーム");
const gamesBody = document.createElement("div");
gamesBody.className = "games-body-wrap";
gamesBody.append(pcGamesHost, marketGamesView.main);
const dockMainRect = () => {
  const box = document.querySelector(".workspace-main")?.getBoundingClientRect();
  if (!box || box.width < 1 || box.height < 1) throw new Error("no_content_rect");
  return { rect: { x: box.left, y: box.top, w: box.width, h: box.height }, dpr: window.devicePixelRatio || 1 };
};
const pcGames = createPcGames({
  document, host: pcGamesHost, bar: document.querySelector("#pc-dock-bar"),
  deps: {
    list: () => invoke("pc_games_list"),
    art: (id) => invoke("pc_game_art", { id }),
    launch: (id) => invoke("pc_game_launch", { id }),
    dockStart: (id, rect, dpr) => invoke("game_dock_start", { id, rect, dpr, launch: true }),
    dockRect: (rect, dpr) => invoke("game_dock_rect", { rect, dpr }),
    dockStop: () => invoke("game_dock_stop"),
    measure: dockMainRect,
    ensureRail: () => setDesktopRailOpen(true),
    nextFrame: () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    friendlyError, notify: showNotice,
  },
});
await window.__TAURI__?.event?.listen?.("pc-game-dock", (event) => pcGames.setDock(event.payload));
const dockRectObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => pcGames.syncRect()) : null;
{ const main = document.querySelector(".workspace-main"); if (main) dockRectObserver?.observe(main); }
window.addEventListener("resize", () => pcGames.syncRect());

// マーケットの一覧（market-browse.mjs）。読みは既存の commerce_catalog と market_tickets だけ。ゲームの種別は上の marketGames がそのまま本文になる。
marketBrowse = createMarketBrowse({
  document, host: document.querySelector("#market-browse"),
  deps: {
    gamesHost: gamesBody,
    openGames: () => { marketGames.showList(); void loadMarketGames(); void pcGames.load(); },
    setGamesQuery: (query) => marketGames.setQuery(query),
    asset: hubAsset,
    friendlyError,
    onCategory: (category) => marketView.tree?.select({ page: "browse", category }),
    filter: () => (shop.sellerFilter ? { key: shop.sellerFilter.id, label: `${shop.sellerFilter.name}の商品`, clear: () => { shop.sellerFilter = null; } } : null),
    openItem: (item) => (item.kind === "ticket" ? void openHubWebPath("/v2/market/tickets") : void openDetail("commerce_product", [item.id], { local: true, data: item.raw, title: "商品詳細" })),
    loadProducts: async ({ query, sort, before, inStock, freeShipping }) => {
      shop.query = query; shop.sort = sort; shop.inStock = inStock === true; shop.freeShipping = freeShipping === true;
      const { data, listed, others, nextCursor } = await settleWithin(fetchShopCatalog(before));
      if (before) mergeShopProducts(listed); else shop.products = listed; // カートの解決用（既存）
      shop.assets = data?.paymentAssets ?? shop.assets;
      shop.catalogStale = false;
      shop.paymentsEnabled = data?.paymentsEnabled === true;
      updateCartBadge();
      return { items: [...listed, ...(shop.sellerFilter ? [] : others)], nextCursor };
    },
    loadTickets: async () => (await settleWithin(invoke("hub_resource", { resource: "market_tickets", query: "" })))?.events ?? [],
  },
});

// マーケットのゲームの種別の一覧。ストアと同じ読み（hub_resource games_store）。
async function loadMarketGames() {
  const request = ++marketGamesView.request;
  marketGames.setStore({ status: "loading" });
  try {
    const data = await settleWithin(invoke("hub_resource", { resource: "games_store", query: "" }), 30_000);
    if (request !== marketGamesView.request) return;
    marketGames.setStore({ status: "ready", games: normalizeStoreGames(data) });
  } catch (error) {
    if (request !== marketGamesView.request) return;
    marketGames.setStore({ status: "error", message: friendlyError(error) });
  }
}

// --- 開発 ---
// The agent's stream is JSONL and mostly bookkeeping. Showing it raw would bury
// the two things worth watching: what it decided to do, and what it said.
const dev = {
  path: document.querySelector("#workspace-path"),
  state: document.querySelector("#workspace-state"),
  agent: document.querySelector("#dev-agent"),
  model: document.querySelector("#dev-model"),
  resume: document.querySelector("#dev-resume"),
  prompt: document.querySelector("#dev-prompt"),
  start: document.querySelector("#dev-start"),
  cancel: document.querySelector("#dev-cancel"),
  status: document.querySelector("#dev-status"),
  output: document.querySelector("#dev-output")
};
// Suggestions, not a whitelist. The runner takes any name shaped like a model
// identifier, so a release that appears tomorrow needs no change here. An
// agent not listed here (e.g. one added via the config file) simply gets no
// suggestions — its defaultModel still fills the field.
const SUGGESTED = { claude: ["sonnet", "opus", "haiku"], codex: ["gpt-5.6-luna", "gpt-5.6-sol"] };
let activeRun = null;
let lastRun = null;
let lastSession = null;
let lastPrompt = "";
let poller = null;
let devAgents = [];
let refreshPiWorkComposer = () => {};

function currentAgent() {
  return devAgents.find((item) => item.id === dev.agent.value);
}

function fillModels() {
  const names = SUGGESTED[dev.agent.value] ?? [];
  document.querySelector("#dev-model-list").replaceChildren(
    ...names.map((name) => { const option = document.createElement("option"); option.value = name; return option; })
  );
  dev.model.value = currentAgent()?.defaultModel ?? "";
}

// The picker only offers what dev_agents reports available, so a CLI added to
// the config file shows up here without a code change. If the list cannot be
// fetched at all (e.g. right after launch), fail into an empty picker with an
// explanation rather than a dropdown that looks fine but does nothing.
async function loadAgents() {
  try {
    devAgents = (await invoke("dev_agents")).filter((item) => item.available);
  } catch {
    devAgents = [];
  }
  dev.agent.replaceChildren(
    ...devAgents.map((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = `${item.label} · ${item.adapter?.connectionState === "connected" ? "接続済み" : "接続不可"}`;
      return option;
    })
  );
  if (devAgents.length === 0) {
    dev.status.textContent = "接続可能なCLIが見つかりません";
    dev.status.classList.add("warning");
  }
  fillModels();
}

function readable(line) {
  let event;
  try { event = JSON.parse(line); } catch { return line; }
  if (event.type === "assistant") {
    return (event.message?.content ?? [])
      .map((part) => (part.type === "text" ? part.text : part.type === "tool_use" ? `→ ${part.name}` : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (event.type === "result") return event.result ?? "";
  if (event.type === "item.completed" && event.item?.type === "agent_message") return event.item.text ?? "";
  if (event.type === "item.started" && event.item?.type === "command_execution") return "→ Command";
  if (event.type === "item.started" && event.item?.type === "file_change") return "→ File change";
  return "";
}

let history = [];
let refreshHubWorkHistory = null;

async function loadLastSession({observeStartup=false}={}) {
  const observe = (name, action) => {
    if (!observeStartup) return action();
    const finish = controlMetrics.begin(name);
    try { return action(); } finally { finish(); }
  };
  const finishRead = observeStartup ? controlMetrics.begin("lastSessionRead") : null;
  try { history = await invoke("dev_history"); } finally { finishRead?.(); }
  const latest = history.find((run) => run.agent === dev.agent.value && run.sessionId);
  chooseSession(latest ? latest.sessionId : null, latest ? latest.prompt : "");
  observe("historyRender", renderHistory);
  observe("workHistory", ()=>refreshHubWorkHistory?.());
}

// Which earlier conversation "続きから" would continue. The newest run of the
// selected agent by default; a row in the history can name a different one.
function chooseSession(id, prompt) {
  lastSession = id;
  lastPrompt = prompt ?? "";
  document.querySelector("#dev-resume-hint").textContent = lastSession ? lastPrompt.split("\n")[0].slice(0, 24) : "";
  dev.resume.closest("label").hidden = !lastSession || !currentAgent()?.canResume;
}

const WHEN = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

// 投稿・通知の時刻は Web 版と同じ相対表示（「3分前」）。lib/v2-time.ts と
// 同じ段階の区切りにする——絶対時刻だと同じ投稿が違う顔で見える。
function relTime(value, options = {}) {
  const then = Date.parse(value);
  if (!Number.isFinite(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}日前`;
  // 一覧は相対表示のまま（絶対の日付は title に）。詳細だけ { absolute: true } で日付にする。
  if (options.absolute) return new Date(then).toLocaleDateString("ja-JP", { year: "numeric", month: "short", day: "numeric" });
  if (days < 30) return `${Math.floor(days / 7)}週間前`;
  if (days < 365) return `${Math.floor(days / 30)}か月前`;
  return `${Math.floor(days / 365)}年前`;
}
const STATUS_LABEL = { running: "実行中", done: "返答終了", failed: "失敗", cancelled: "中断" };

// The tail is cut by bytes, so its first line is usually half an event. Showing
// the fragment would look like corruption; dropping it loses nothing.
function tailText(tail) {
  const lines = tail.split("\n");
  if (lines.length > 1) lines.shift();
  return lines.map(readable).filter(Boolean).filter((line, index, all) => line !== all[index - 1]).join("\n");
}

// Runs are kept and shown because "what was asked, what changed, did it work"
// is the question asked a week later, when the terminal output is long gone.
function renderHistory() {
  const node = document.querySelector("#dev-history");
  if (history.length === 0) {
    node.className = "empty";
    node.replaceChildren(document.createTextNode("まだありません"));
    return;
  }
  node.className = "";
  node.replaceChildren(...history.map(historyCard));
}

function historyCard(run) {
  const card = document.createElement("article");
  card.className = "card history";
  const head = document.createElement("div");
  head.className = "run-head";
  const title = document.createElement("strong");
  title.textContent = (STATUS_LABEL[run.status] ?? run.status) + " · " + run.agent + " " + run.model;
  if (run.status !== "done") title.className = "warning";
  const when = document.createElement("span");
  when.className = "meta";
  // One record written by an older version must not stop the window starting.
  when.textContent = Number.isFinite(run.startedAtMs) ? WHEN.format(new Date(run.startedAtMs)) : "";
  head.append(title, when);

  const asked = document.createElement("p");
  asked.className = "asked";
  asked.textContent = run.prompt.split("\n")[0];

  const mine = (run.changed ?? []).filter((item) => !item.alreadyDirty);
  const summary = document.createElement("p");
  summary.className = "meta";
  summary.textContent = mine.length > 0 ? mine.length + "件のファイルを変更" : "変更なし";

  const details = document.createElement("div");
  details.className = "history-details";
  details.hidden = true;
  const open = document.createElement("button");
  open.type = "button";
  open.className = "deny";
  open.textContent = "中身を見る";
  open.onclick = () => {
    details.hidden = !details.hidden;
    open.textContent = details.hidden ? "中身を見る" : "たたむ";
    if (details.childElementCount === 0) details.append(...historyDetails(run, mine));
  };

  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(open, historyActions(run, mine));
  card.append(head, asked, summary, actions, details);
  return card;
}

function historyDetails(run, mine) {
  const parts = [];
  const text = tailText(run.tail);
  if (text) {
    const output = document.createElement("pre");
    output.textContent = text;
    parts.push(output);
  }
  if (mine.length > 0) {
    const list = document.createElement("ul");
    list.className = "paths";
    for (const item of mine) {
      const row = document.createElement("li");
      const state = document.createElement("code");
      state.textContent = item.state.trim() || "??";
      row.append(state, document.createTextNode(" " + item.path));
      list.append(row);
    }
    parts.push(list);
  }
  if ((run.checks ?? []).length > 0) {
    const checks = document.createElement("ul");
    checks.className = "paths";
    for (const check of run.checks) {
      const row = document.createElement("li");
      row.textContent = `${check.status} · ${check.name} · ${check.detail}`;
      checks.append(row);
    }
    parts.push(checks);
  }
  return parts;
}

function historyActions(run, mine) {
  const group = document.createElement("div");
  group.className = "history-actions";
  if (run.sessionId) {
    const again = document.createElement("button");
    again.type = "button";
    again.className = "deny";
    again.textContent = "この続きから";
    again.onclick = () => {
      dev.agent.value = run.agent;
      fillModels();
      chooseSession(run.sessionId, run.prompt);
      dev.resume.checked = true;
      dev.prompt.focus();
    };
    group.append(again);
  }
  // Undo restores the paths this run changed, which is only safe while nothing
  // newer has touched them. After a restart the run is not held any more, so
  // the offer is withdrawn rather than made and then refused.
  const reversible = mine.filter((item) => item.revertSupported !== false);
  if (mine.length > 0) {
    const undo = document.createElement("button");
    undo.type = "button";
    undo.className = "deny";
    undo.textContent = "取り消す";
    undo.disabled = !run.revertable || reversible.length === 0;
    if (reversible.length === 0) undo.title = "この変更は安全な自動取り消しに対応していません";
    else if (!run.revertable) undo.title = "実行後にファイルが変わったか、アプリを起動し直したため取り消せません";
    undo.onclick = async () => {
      undo.disabled = true;
      try {
        const restored = await invoke("revert_dev_run", { id: run.id });
        dev.status.textContent = restored.length ? restored.length + "件を元に戻しました" : "戻すものはありませんでした";
        dev.status.classList.remove("warning");
      } catch (error) {
        dev.status.textContent = friendlyError(error);
        dev.status.classList.add("warning");
      }
      await loadLastSession();
    };
    group.append(undo);
  }
  return group;
}

async function refreshWorkspace() {
  const workspace = await invoke("dev_workspace");
  savedWorkspace = typeof workspace === "string" ? workspace.trim() : "";
  const ready = Boolean(savedWorkspace);
  dev.state.textContent = ready
    ? `この中だけで動きます: ${savedWorkspace}`
    : "未設定のため開発は使えません。フォルダを指定してください。";
  dev.state.classList.toggle("warning", !ready);
  dev.start.disabled = !ready || activeRun !== null || devAgents.length === 0;
  if (ready && !dev.path.value) dev.path.value = savedWorkspace;
  const label = document.querySelector("#pi-work-workspace-label");
  const button = document.querySelector("#pi-work-workspace");
  if (label && button) {
    label.textContent = ready ? savedWorkspace.split(/[\\/]/).filter(Boolean).at(-1) : "作業フォルダを設定";
    button.title = ready ? savedWorkspace : "作業フォルダを設定";
  }
  updatePiWorkEmptyState();
  refreshPiWorkComposer();
}

// 右列のAIは見出しを1行にする。会話名と状態点だけを右列の見出しへ写し、履歴は見出しの履歴ボタンから開く。
function setRailAiHistoryOpen(open) {
  const host = document.querySelector("#rail-ai-workspace-host");
  const button = document.querySelector("#rail-ai-history");
  if (!host || !button) return;
  host.classList.toggle("history-open", open);
  button.setAttribute("aria-expanded", String(open));
  if (open) document.querySelector("#pi-work-history-search")?.focus({ preventScroll: true });
}

document.querySelector("#rail-ai-history")?.addEventListener("click", () => setRailAiHistoryOpen(!document.querySelector("#rail-ai-workspace-host").classList.contains("history-open")));
document.addEventListener("pointerdown", (event) => {
  const host = document.querySelector("#rail-ai-workspace-host");
  if (!host?.classList.contains("history-open")) return;
  if (event.target.closest?.("#rail-ai-history, .harness-history")) return;
  setRailAiHistoryOpen(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.querySelector("#rail-ai-workspace-host")?.classList.contains("history-open")) setRailAiHistoryOpen(false);
});
document.querySelector("#rail-ai-workspace-host")?.addEventListener("click", (event) => {
  if (event.target.closest?.(".piw-history-item")) setTimeout(() => setRailAiHistoryOpen(false), 0);
});

function updatePiWorkEmptyState() {
  const empty = document.querySelector("#pi-work-timeline .piw-empty");
  if (!empty) return;
  const inRail = document.querySelector("#rail-ai-workspace-host")?.contains(empty);
  const detail = empty.querySelector("span");
  if (detail) detail.textContent = inRail
    ? savedWorkspace ? "中央の画面を開いたまま、下の入力欄から別の作業を始められます。" : "作業フォルダを選ぶと、下の入力欄から始められます。"
    : savedWorkspace ? `${savedWorkspace.split(/[\\/]/).filter(Boolean).at(-1) ?? savedWorkspace} で作業します` : "作業フォルダを選んでください";
  const picker = empty.querySelector(".piw-empty-workspace");
  if (picker) picker.hidden = Boolean(savedWorkspace);
}

let missedPolls = 0;

async function poll() {
  if (!activeRun) return;
  // A failed poll says nothing about the agent, which is still editing. Ending
  // the watch here would report a failure that has not happened.
  let run;
  try { run = await invoke("dev_run", { id: activeRun }); }
  catch {
    if ((missedPolls += 1) <= 5) return;
    clearInterval(poller); poller = null; activeRun = null;
    dev.status.textContent = "アプリに問い合わせられません。実行は続いている可能性があります";
    dev.status.classList.add("warning");
    dev.cancel.disabled = true;
    await refreshWorkspace();
    return;
  }
  missedPolls = 0;
  if (!run) return;
  // The closing result event repeats the last thing the agent said.
  const text = run.output.split("\n").map(readable).filter(Boolean)
    .filter((line, index, lines) => line !== lines[index - 1]).join("\n");
  dev.output.textContent = text;
  dev.output.scrollTop = dev.output.scrollHeight;
  const label = { running: "実行中", done: "返答終了", failed: "失敗", cancelled: "中断しました" }[run.status];
  dev.status.textContent = `${label}${run.exitCode === null || run.exitCode === undefined ? "" : ` · exit ${run.exitCode}`}`;
  showChanges(run.changed);
  if (run.status !== "running") {
    clearInterval(poller);
    poller = null;
    activeRun = null;
    dev.cancel.disabled = true;
    await refreshWorkspace();
    await loadLastSession();
    // The finished run is now the top of the history, with the same file list
    // and the same undo. Leaving it here as well would put two buttons for one
    // run on the screen.
    document.querySelector("#dev-changes").replaceChildren();
  }
}

// Skipping per-edit approval is only defensible if the operator can see
// afterwards what changed and put it back.
function showChanges(changed) {
  const node = document.querySelector("#dev-changes");
  if (!changed || changed.length === 0) { node.replaceChildren(); return; }
  const mine = changed.filter((item) => !item.alreadyDirty);
  const head = document.createElement("div"); head.className = "changes-head";
  const title = document.createElement("strong"); title.textContent = `変更したファイル ${mine.length}件`;
  const undo = document.createElement("button"); undo.type = "button"; undo.className = "deny"; undo.textContent = "この実行を取り消す";
  undo.onclick = async () => {
    undo.disabled = true;
    const restored = await invoke("revert_dev_run", { id: lastRun });
    dev.status.textContent = restored.length ? `${restored.length}件を元に戻しました` : "戻すものはありませんでした";
    node.replaceChildren();
  };
  head.append(title, undo);
  const list = document.createElement("ul");
  for (const item of changed) {
    const row = document.createElement("li");
    if (item.alreadyDirty) row.className = "untouched";
    const state = document.createElement("code"); state.textContent = item.state.trim() || "??";
    row.append(state, document.createTextNode(" " + item.path));
    if (item.alreadyDirty) { const note = document.createElement("small"); note.textContent = "実行前から変更あり · 取り消さない"; row.append(note); }
    list.append(row);
  }
  node.replaceChildren(head, list);
}

dev.agent.onchange = () => { fillModels(); void loadLastSession(); };

dev.start.onclick = async () => {
  const prompt = dev.prompt.value.trim();
  if (!prompt) return;
  dev.start.disabled = true;
  dev.output.textContent = "";
  document.querySelector("#dev-changes").replaceChildren();
  dev.status.textContent = "開始しています…";
  try {
    activeRun = lastRun = await invoke("start_dev_run", {
      request: {
        agent: dev.agent.value,
        prompt,
        model: dev.model.value,
        resume: dev.resume.checked ? lastSession : null
      }
    });
    dev.cancel.disabled = false;
    poller = setInterval(poll, 1000);
    await poll();
  } catch (error) {
    dev.status.textContent = friendlyError(error);
    dev.status.classList.add("warning");
    activeRun = null;
    await refreshWorkspace();
  }
};

dev.cancel.onclick = async () => {
  if (!activeRun) return;
  dev.cancel.disabled = true;
  await invoke("cancel_dev_run", { id: activeRun });
  await poll();
};

dev.path.onkeydown = (event) => { if (event.key === "Enter") document.querySelector("#workspace-save").click(); };

document.querySelector("#workspace-save").onclick = async () => {
  try {
    await invoke("set_dev_workspace", { path: dev.path.value });
    dev.status.textContent = "";
  } catch (error) {
    dev.state.textContent = `設定できません: ${error}`;
    dev.state.classList.add("warning");
    return;
  }
  await refreshWorkspace();
};

// Typing an absolute path correctly is the first thing that goes wrong, and
// getting it wrong turns the whole feature off with no explanation.
document.querySelector("#workspace-pick").onclick = async () => {
  const chosen = await invoke("pick_dev_workspace");
  if (!chosen) return;
  dev.path.value = chosen;
  dev.status.textContent = "";
  await refreshWorkspace();
};

document.querySelector("#workspace-clear").onclick = async () => {
  await invoke("clear_dev_workspace");
  dev.path.value = "";
  await refreshWorkspace();
};

// A run started before this window was reloaded is still editing the workspace.
// Picking it back up is what stops the same work being asked for twice. The
// prompt is not restored: the runner does not carry it on a live run, and the
// output already shows what the agent is doing.
async function attachToRunInProgress() {
  const run = await invoke("dev_active_run");
  // Anything that is not a run leaves the screen as it was. Half-attaching to a
  // shape we did not expect turns the whole panel off with no explanation.
  if (!run || typeof run.id !== "string") return;
  activeRun = lastRun = run.id;
  dev.agent.value = run.agent;
  fillModels();
  dev.model.value = run.model;
  dev.cancel.disabled = false;
  poller = setInterval(poll, 1000);
  await poll();
}

// --- Hub AI (Pi Work) ---
// The sidecar owns the agent loop, so the window only watches: a run list on
// one side, the selected run's tools and output on the other, and approvals
// when the backend offers them. The workspace is never duplicated here — the
// shared input above is the single source.
function initPiWork({ timers = globalThis, invokeWork = invoke, isActive = () => true } = {}) {
  const els = {
    status: document.querySelector("#pi-work-status"),
    model: document.querySelector("#pi-work-model"),
    modelList: document.querySelector("#pi-work-model-list"),
    prompt: document.querySelector("#pi-work-prompt"),
    draftLimit: document.querySelector("#pi-work-draft-limit"),
    allowWrite: document.querySelector("#pi-work-allow-write"),
    allowExec: document.querySelector("#pi-work-allow-exec"),
    allowHttp: document.querySelector("#pi-work-allow-http"),
    verifyProgram: document.querySelector("#pi-work-verify-program"),
    verifyArgs: document.querySelector("#pi-work-verify-args"),
    bestOf: document.querySelector("#pi-work-best-of"),
    bestOfEstimate: document.querySelector("#pi-work-best-of-estimate"),
    bestOfConfirm: document.querySelector("#pi-work-best-of-confirm"),
    fastCheck: document.querySelector("#pi-work-fast-check"),
    fastCheckNote: document.querySelector("#pi-work-fast-check-note"),
    connection: document.querySelector("#pi-work-connection"),
    connectionModel: document.querySelector("#pi-work-connection-model"),
    connectionNote: document.querySelector("#pi-work-connection-note"),
    hubpediaAsk: document.querySelector("#pi-work-hubpedia-ask"),
    hubpediaAskNote: document.querySelector("#pi-work-hubpedia-ask-note"),
    writeNote: document.querySelector("#pi-work-write-note"),
    start: document.querySelector("#pi-work-start"),
    cancel: document.querySelector("#pi-work-cancel"),
    error: document.querySelector("#pi-work-error"),
    composer: document.querySelector("#pi-work .piw-composer"),
    finished: document.querySelector("#pi-work-finished"),
    finishedText: document.querySelector("#pi-work-finished-text"),
    finishedAction: document.querySelector("#pi-work-finished-action"),
    finishedPost: document.querySelector("#pi-work-finished-post"),
    resume: document.querySelector("#pi-work-resume"),
    resumeText: document.querySelector("#pi-work-resume-text"),
    resumeSource: document.querySelector("#pi-work-resume-source"),
    resumePath: document.querySelector("#pi-work-resume-path"),
    resumeWorkspace: document.querySelector("#pi-work-resume-workspace"),
    resumeClear: document.querySelector("#pi-work-resume-clear"),
    history: document.querySelector("#pi-work-history"),
    historySearch: document.querySelector("#pi-work-history-search"),
    timeline: document.querySelector("#pi-work-timeline"),
    latest: document.querySelector("#pi-work-latest"),
    shortcut: document.querySelector("#pi-work-shortcut"),
    workspace: document.querySelector("#pi-work-workspace")
  };
  if (!els.start || !els.timeline) return null;
  const last = { timeline: "", history: "" };
  let changesPanel = null, changesPanelKey = "";
  const clearChangesPanel = () => { changesPanel?.destroy(); changesPanel=null; changesPanelKey=""; };
  const historyWorkspaceOpen = new Map();
  // 前回の終了で途中だった作業（runId → 中断の内訳）。開くたびに読み直す。
  let interrupted = new Map();
  let resumeFrom = null;
  let modelPicker=null, presets=null;
  // 自分のAPIキー / インストール済みCLIの接続。モデル一覧に載せ、選ばれたときだけこちらで会話する。
  const connectionModels = createConnectionModels({ invoke: invokeWork, storage: safeStorage });
  // "AIの接続" for AI work: names and default models only; a failed list leaves just "使わない".
  if (els.connection && els.connectionModel) {
    const picker = { select: els.connection, modelInput: els.connectionModel, note: els.connectionNote };
    if (els.connectionNote) els.connectionNote.textContent = CONNECTION_NOTE;
    els.connection.addEventListener("change", () => syncConnectionModel(picker));
    void Promise.resolve(invokeWork("pi_work_connections")).then((list) => renderConnectionPicker(picker, connectionChoices(list)))
      .catch(() => renderConnectionPicker(picker, []));
  }
  const connectionChat = createConnectionChat({ document, invoke: invokeWork, listen: (name, callback) => window.__TAURI__.event.listen(name, callback),
    host: els.timeline.parentElement, timeline: els.timeline, onChange: () => syncSendState(),
    routing: { storage: safeStorage, available: () => new Set(connectionModels.refs()), nameOf: (ref) => { const m = parseRef(ref); return `${connectionModels.groupOf(ref) ?? ref}${m?.model ? ` / ${m.model}` : ""}`; } },
    market: { listing: (id) => marketListings.find((l) => l.id === id) ?? null } });
  let modelBeforeResume = null;
  let newWork = true;
  let initialWorkSelection = true;
  const drafts = createPiWorkDrafts();
  let draftContext = null;
  let stickToBottom = true;
  const updateLatest = () => {
    els.latest.hidden = els.timeline.scrollHeight - els.timeline.scrollTop - els.timeline.clientHeight <= 64;
  };
  els.timeline.addEventListener("scroll", () => {
    stickToBottom = els.timeline.scrollHeight - els.timeline.scrollTop - els.timeline.clientHeight < 64;
    updateLatest();
  });
  els.latest.onclick = () => {
    stickToBottom = true;
    els.timeline.scrollTo({ top: els.timeline.scrollHeight, behavior: "smooth" });
    updateLatest();
  };
  new ResizeObserver(() => {
    if (stickToBottom && els.timeline.clientHeight) els.timeline.scrollTop = els.timeline.scrollHeight;
    updateLatest();
  }).observe(els.timeline);
  let choosingWorkspace = false;
  const pickWorkspace = async () => {
    if (controller.state.busy || choosingWorkspace) return false;
    choosingWorkspace = true;
    let selectionError = "";
    controller.refresh();
    try {
      const chosen = await invokeWork("pick_dev_workspace");
      if (!chosen) return false;
      dev.path.value = chosen;
      await refreshWorkspace();
      els.prompt.focus();
      return Boolean(savedWorkspace);
    } catch (error) {
      selectionError = piWorkErrorText(error);
      return false;
    } finally {
      choosingWorkspace = false;
      controller.refresh();
      if (selectionError) els.error.textContent = selectionError;
    }
  };
  const composerWorkspace = document.querySelector("#pi-work-composer-workspace");
  els.workspace.onclick = () => void pickWorkspace();
  if (composerWorkspace) composerWorkspace.onclick = els.workspace.onclick;

  // Pending approvals take the composer's seat, one at a time (never bulk). The
  // composer is only hidden by class, so its draft text is left untouched.
  let approvalIndex = 0, approvalRunId = null, approvalSeatKey = "", approvalView = null;
  const renderApprovalSeat = (run, busy, decideSupported) => {
    const seat = document.querySelector("#pi-work-approval-seat");
    const actions = run && decideSupported ? pendingActionsOf(run) : [];
    if ((run?.id ?? null) !== approvalRunId) { approvalRunId = run?.id ?? null; approvalIndex = 0; }
    approvalIndex = Math.min(approvalIndex, Math.max(0, actions.length - 1));
    approvalView = { run, busy, decideSupported };
    document.querySelector("#pi-work .piw-composer")?.classList.toggle("is-approval-pending", actions.length > 0);
    if (!seat) return;
    const key = JSON.stringify([run?.id, busy, approvalIndex, actions]);
    if (key === approvalSeatKey) return;
    approvalSeatKey = key;
    seat.hidden = actions.length === 0;
    if (!actions.length) { seat.replaceChildren(); return; }
    seat.replaceChildren(renderPiApproval({
      document, run, action: actions[approvalIndex], busy,
      onDecide: (runId, actionId, approve) => controller.decide(runId, actionId, approve),
      position: { index: approvalIndex, total: actions.length, onNav: (step) => { approvalIndex += step; renderApprovalSeat(approvalView.run, approvalView.busy, approvalView.decideSupported); } }
    }));
  };

  // Model output is text, never HTML. Keep formatting useful for code review
  // without letting generated markup or links execute in the app window.
  const appendInline = (el, text) => {
    for (const part of text.split(/(\*\*[^*]+\*\*|`[^`\n]+`|\[[^\]]+\]\([^\s)]+\))/)) {
      if (part.startsWith("**") && part.endsWith("**")) {
        const strong = document.createElement("strong");
        strong.textContent = part.slice(2, -2);
        el.append(strong);
      } else if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
        const code = document.createElement("code");
        code.textContent = part.slice(1, -1);
        el.append(code);
      } else if (/^\[[^\]]+\]\([^\s)]+\)$/.test(part)) {
        const [, label, url] = part.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/);
        const local = url.startsWith("/") && !url.startsWith("//");
        let external = false;
        try {
          const parsed = new URL(url);
          external = ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
        } catch {}
        if (local || external) {
          const link = document.createElement("button");
          link.type = "button";
          link.className = "piw-answer-link";
          link.textContent = label;
          link.title = url;
          link.onclick = () => void (url.startsWith("/") ? openHubPath(url) : enterBrowser(url));
          el.append(link);
        } else el.append(part);
      } else {
        el.append(part);
      }
    }
  };
  const answerEl = (text) => {
    const box = document.createElement("div");
    box.className = "piw-answer";
    const lines = String(text).split(/\r?\n/);
    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      const fence = line.match(/^\s*```([\w+#.-]{0,30})\s*$/);
      if (fence) {
        const codeLines = [];
        for (i += 1; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i += 1) codeLines.push(lines[i]);
        if (i < lines.length) i += 1;
        const block = document.createElement("div");
        block.className = "piw-code-block";
        const head = document.createElement("div");
        head.className = "piw-code-head";
        const label = document.createElement("span");
        label.textContent = fence[1] || "コード";
        const copy = document.createElement("button");
        copy.type = "button";
        copy.textContent = "コピー";
        const content = codeLines.join("\n");
        copy.onclick = async () => {
          try { await navigator.clipboard.writeText(content); copy.textContent = "コピーしました"; }
          catch { copy.textContent = "コピーできませんでした"; }
        };
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = content;
        pre.append(code);
        head.append(label, copy);
        block.append(head, pre);
        box.append(block);
        continue;
      }
      if (!line.trim()) { i += 1; continue; }
      const heading = line.match(/^(#{1,4})\s+(.+)$/);
      if (heading) {
        const title = document.createElement("h3");
        title.className = "piw-answer-heading";
        appendInline(title, heading[2]);
        box.append(title);
        i += 1;
        continue;
      }
      const listMatch = line.match(/^\s*(?:([-*•])|(\d+)\.)\s+(.+)$/);
      if (listMatch) {
        const ordered = Boolean(listMatch[2]);
        const list = document.createElement(ordered ? "ol" : "ul");
        while (i < lines.length) {
          const item = lines[i].match(/^\s*(?:([-*•])|(\d+)\.)\s+(.+)$/);
          if (!item || Boolean(item[2]) !== ordered) break;
          const li = document.createElement("li");
          appendInline(li, item[3]);
          list.append(li);
          i += 1;
        }
        box.append(list);
        continue;
      }
      const paragraph = document.createElement("p");
      const parts = [];
      while (i < lines.length && lines[i].trim() && !/^\s*```|^#{1,4}\s+|^\s*(?:[-*•]|\d+\.)\s+/.test(lines[i])) parts.push(lines[i++].trim());
      if (!parts.length) parts.push(lines[i++].trim());
      appendInline(paragraph, parts.join(" "));
      box.append(paragraph);
    }
    return box;
  };

  const traceEl = (run) => {
    const calls = toolCallsOf(run);
    if (!calls.length) return null;
    const details = document.createElement("details");
    details.className = "piw-trace";
    details.dataset.detailKey = "tools";
    details.open = true;
    const summary = document.createElement("summary");
    summary.textContent = `ツール ${calls.length}件`;
    const list = document.createElement("ul");
    const finished = piWorkIsTerminal(run.status);
    calls.forEach((call, index) => {
      const row = document.createElement("li");
      const state = call.ok === true ? "ok" : call.ok === false ? "fail" : finished ? "stopped" : "running";
      const glyph = document.createElement("span");
      glyph.className = "piw-trace-glyph " + state;
      glyph.textContent = { ok: "✓", fail: "✗", stopped: "■", running: "…" }[state];
      const name = document.createElement("code");
      name.textContent = call.name ?? "tool";
      const detail = document.createElement("span");
      detail.className = "piw-trace-detail";
      detail.textContent = call.detail ?? "";
      if (call.preview) {
        // Click expands to the full recorded preview (hub_exec argv/output, hub_http request, read lines).
        const item = document.createElement("details");
        item.className = "piw-tool";
        item.dataset.detailKey = `tool:${index}`;
        const head = document.createElement("summary");
        head.append(glyph, name, detail);
        const body = document.createElement("pre");
        body.className = "piw-trace-preview";
        body.textContent = call.preview;
        item.append(head, body);
        row.append(item);
      } else {
        const line = document.createElement("div");
        line.className = "piw-tool-line";
        line.append(glyph, name, detail);
        row.append(line);
      }
      list.append(row);
    });
    details.append(summary, list);
    return details;
  };

  const liveMetaText = (run) => {
    const now = Date.now();
    const started = Number.isFinite(run.startedAtMs) && !Number.isNaN(new Date(run.startedAtMs).getTime()) ? run.startedAtMs : now;
    const elapsed = Math.max(0, Math.floor((now - started) / 1000));
    return `${elapsed}秒`;
  };
  const updateElapsed = (run) => {
    if (!run || piWorkIsTerminal(run.status)) return;
    const meta = els.timeline.querySelector(".piw-turn.is-live > .piw-meta");
    if (meta?.lastChild?.nodeType === Node.TEXT_NODE) meta.lastChild.textContent = liveMetaText(run);
  };

  const turnEl = (run, busy, decideSupported) => {
    const turn = document.createElement("section");
    turn.className = "piw-turn" + (piWorkIsTerminal(run.status) ? "" : " is-live");
    turn.dataset.runId = run.id;
    const pending = pendingActionsOf(run).length;
    const verification = run.verification?.status;
    const bubble = document.createElement("div");
    bubble.className = "piw-bubble";
    bubble.textContent = run.prompt ?? "";
    turn.append(bubble);

    const meta = document.createElement("p");
    meta.className = "piw-meta" + (run.status === "failed" ? " is-failed" : "");
    const calls = toolCallsOf(run);
    if (!piWorkIsTerminal(run.status)) {
      const dot = document.createElement("span");
      dot.className = "piw-dot";
      meta.append(dot, liveMetaText(run));
    } else {
      const started = new Date(run.startedAtMs);
      meta.textContent = Number.isFinite(run.startedAtMs) && !Number.isNaN(started.getTime()) ? WHEN.format(started) : "日時不明";
    }
    turn.append(meta);
    const compaction = piInterrupted.compactionNote(document, run.compaction);
    if (compaction) turn.append(compaction);
    const pausedItem = piWorkIsTerminal(run.status) ? interrupted.get(run.id) : null;
    if (pausedItem) turn.append(piInterrupted.interruptedPanel({ document, item: pausedItem, busy, onRerun: rerunInterrupted, onDismiss: dismissInterrupted }));

    const changeKey = JSON.stringify([run.id, run.changes]);
    if (changeKey !== changesPanelKey) {
      clearChangesPanel(); changesPanelKey=changeKey;
      changesPanel=createPiChanges({document,run,invoke,isCurrent:()=>currentView === "ai" && !newWork && controller.state.selectedId === run.id});
    }

    // One collapsible process block: tools, plan, changes, pending note, diagnostics.
    const live = !piWorkIsTerminal(run.status);
    const process = document.createElement("details");
    process.className = "piw-process";
    process.dataset.detailKey = "process";
    process.dataset.autoOpen = live ? "1" : "0";
    process.open = live;
    const processHead = document.createElement("summary");
    const processMark = document.createElement("span");
    const failedRun = run.status === "failed" || run.status === "cancelled" || run.outcome?.ok === false;
    processMark.className = "piw-process-mark" + (live ? " is-running" : failedRun ? " is-failed" : " is-ok");
    processMark.textContent = live ? "" : failedRun ? "✗" : "✓";
    const lastTool = calls.length ? calls[calls.length - 1].name ?? "tool" : "";
    processHead.append(processMark, `作業の経過 · ツール ${calls.length}件${lastTool ? ` · ${lastTool}` : ""}`);
    const processBody = document.createElement("div");
    processBody.className = "piw-process-body";
    const trace = traceEl(run);
    if (trace) processBody.append(trace);
    processBody.append(changesPanel.element);
    if (pending) {
      const waiting = document.createElement("p");
      waiting.className = "piw-pending-row";
      waiting.textContent = `承認待ち ${pending}件`;
      processBody.append(waiting);
    }
    if (run.stderrTail) {
      const stderr = document.createElement("details");
      stderr.className = "piw-stderr";
      stderr.dataset.detailKey = "diagnostics";
      const stderrHead = document.createElement("summary");
      stderrHead.textContent = "診断ログ";
      const stderrBody = document.createElement("pre");
      stderrBody.className = "dev-output";
      stderrBody.textContent = run.stderrTail;
      stderr.append(stderrHead, stderrBody);
      processBody.append(stderr);
    }
    process.append(processHead, processBody);
    turn.append(process);

    const answer = run.finalOutput || (!piWorkIsTerminal(run.status) ? run.partialOutput : "");
    if (answer) turn.append(answerEl(answer));

    const facts = [];
    if (run.usage?.inputTokens || run.usage?.outputTokens) {
      facts.push(`トークン ${run.usage.inputTokens ?? 0}/${run.usage.outputTokens ?? 0}`);
    }
    const caps = [run.allowExec ? "コマンド" : null, run.allowHttp ? "HTTP" : null, run.allowTest ? "テスト" : null].filter(Boolean).join("/") || "ファイルのみ";
    if (run.allowWrite || run.allowExec || run.allowHttp) facts.push(`書き込み${run.allowWrite ? "事前許可" : "都度承認"} · ${caps}`);
    if (run.outcome) facts.push(`実行${run.outcome.ok ? "正常終了" : "失敗"}${run.outcome.exitCode == null ? "" : ` · exit ${run.outcome.exitCode}`}`);
    const verificationLabels = { pending: ["未実行", ""], running: ["実行中", ""], passed: ["合格", "is-ok"], failed: ["不合格", "is-failed"], incomplete: ["未完了", ""] };
    if (facts.length || run.verification) {
      const usage = document.createElement("p");
      usage.className = "piw-meta piw-footer";
      usage.textContent = facts.join(" · ");
      if (run.verification) {
        const [label, tone] = Object.hasOwn(verificationLabels, verification) ? verificationLabels[verification] : ["状態不明", ""];
        const check = document.createElement("span");
        check.className = "piw-verify " + tone;
        const { attempts, limit } = run.verification;
        const rounds = Number.isInteger(attempts) && Number.isInteger(limit) && limit > 0 ? `（${Math.min(attempts, limit)}/${limit}回）` : "";
        check.textContent = `指定検証: ${label}${rounds}`;
        if (facts.length) usage.append(" · ");
        usage.append(check);
      }
      turn.append(usage);
    }
    if (run.outcome?.error) {
      const warning = document.createElement("p");
      warning.className = "warning";
      warning.textContent = piWorkErrorText(run.outcome.error);
      turn.append(warning);
    }
    return turn;
  };

  const selectHubWork = (run) => {
    if (controller.state.busy || choosingWorkspace || connectionChat.isBusy()) return;
    railNav.visit("ai", run.id, null, { key: newWork ? "new" : (controller.state.selectedId ?? "new") });
    connectionChat.hide();
    const text = drafts.switchTo(draftContext, run.id, els.prompt.value);
    draftContext = run.id;
    initialWorkSelection = false;
    newWork = false;
    clearResume();
    els.prompt.value = text;
    autogrow();
    stickToBottom = false;
    els.timeline.scrollTop = 0;
    if (controller.state.selectedId === run.id) controller.refresh();
    else controller.select(run.id);
    els.timeline.scrollTop = 0;
    updateLatest();
  };

  const renderWorkHistory = (runs, selected, busy = controller.state.busy || choosingWorkspace) => {
    if (!els.history) return;
    const all = hubWorkHistoryEntries(runs, history);
    els.history.closest(".harness-history")?.classList.toggle("is-empty", all.length === 0);
    const query = els.historySearch.value.trim().toLocaleLowerCase();
    const key = JSON.stringify([busy, query, selected?.id, [...interrupted.keys()], all.map(({ kind, run }) => [kind, run.id, run.prompt, run.workspace, run.model, run.status, run.verification?.status, pendingActionsOf(run).length, run.agent, run.startedAtMs])]);
    if (key === last.history) return;
    last.history = key;
    const entries = renderPiWorkHistory({
      document, entries: all, query, selectedId: selected?.id ?? null, busy, openGroups: historyWorkspaceOpen, groupBy: "date", interruptedIds: new Set(interrupted.keys()),
      onDelete: ({ run }) => void deleteHubWork(run),
      onSelect: ({ kind, run }) => {
        if (controller.state.busy || choosingWorkspace) return;
        if (kind === "hub") {
          selectHubWork(run);
        } else {
          if (!startupTool && currentView === "ai") {
            const moreDialog = document.querySelector("#ai-more");
            if (!moreDialog.open) moreDialog.showModal();
          }
          const card = [...document.querySelector("#dev-history").children][history.indexOf(run)];
          card?.scrollIntoView({ behavior: "smooth", block: "center" });
          if (card?.querySelector(".history-details")?.hidden) card.querySelector("button")?.click();
        }
      }
    });
    els.history.replaceChildren(...entries);
  };

  // 中断した作業：開くたびに読み直す。読めなければ何も出さない。
  const loadInterrupted = async () => {
    const before = JSON.stringify([...interrupted.values()]);
    try { interrupted = piInterrupted.normalizeInterrupted(await invokeWork("pi_work_interrupted")); }
    catch { interrupted = new Map(); }
    if (!isActive() || JSON.stringify([...interrupted.values()]) === before) return;
    last.history = ""; last.timeline = "";
    controller.refresh();
  };
  // 再実行は利用者が押したときだけ。既存の再開経路（resumeRunId）で始め、権限は付けない。承認待ちは通常の承認画面として戻る。
  const rerunInterrupted = async (item) => {
    const run = controller.state.runs.find((candidate) => candidate.id === item.runId);
    if (!run || controller.state.busy || choosingWorkspace) return;
    const norm = (value) => String(value ?? "").replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase();
    if (!run.workspace || norm(run.workspace) !== norm(savedWorkspace)) { activateContinuation(run, true); return; }
    activateContinuation(run, false);
    stickToBottom = true;
    if (await controller.start({ prompt: "中断した作業を続けてください。", model: run.model, connection: "", connectionModel: "", allowWrite: false, allowExec: false, allowHttp: false, verifyProgram: "", verifyArgs: "", bestOf: "", bestOfConfirmed: false, checkers: [], resumeRunId: run.id, engine: run.engine ?? "thin" })) {
      interrupted.delete(item.runId); clearResume(); newWork = false;
    }
  };
  const dismissInterrupted = async (item) => {
    try { await invokeWork("pi_work_interrupted_dismiss", { runId: item.runId }); } catch { return; }
    interrupted.delete(item.runId);
    last.history = ""; last.timeline = "";
    controller.refresh();
  };

  // 「この作業記録を削除」: 会話・添付画像・一覧の行を消し、新しい作業の画面へ戻る。
  const deleteHubWork = async (run) => {
    if (controller.state.busy || choosingWorkspace) return;
    try { await invokeWork("pi_work_delete", { id: run.id }); }
    catch { last.history = ""; renderWorkHistory(controller.state.runs, controller.state.runs.find((item) => item.id === controller.state.selectedId)); return; }
    if (controller.state.selectedId === run.id) newWorkAction();
    await controller.load();
  };
  document.addEventListener("hub-ai-records-deleted", () => { newWorkAction(); void controller.load(); });
  const workStateOf = (run) => !run ? "idle" : pendingActionsOf(run).length ? "waiting" : !piWorkIsTerminal(run.status) ? "running"
    : run.status === "failed" || run.verification?.status === "failed" ? "failed" : run.status === "done" ? "ok" : "cancelled";
  const relativeTime = (ms) => {
    if (!Number.isFinite(ms) || ms <= 0) return "";
    const at = new Date(ms), now = new Date(), day = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
    const days = Math.round((day(now) - day(at)) / 86400000);
    return now - at < 60000 ? "今" : days <= 0 ? `${at.getHours()}:${String(at.getMinutes()).padStart(2, "0")}` : days === 1 ? "昨日" : `${at.getMonth() + 1}/${at.getDate()}`;
  };
  // While a run is working and nothing is typed, the stop button takes the send button's place.
  const syncPrimary = () => { els.start.hidden = !els.cancel.hidden && !els.prompt.value.trim(); };
  const modelChip = document.querySelector("#pi-work-model-chip");
  const syncSendState = () => {
    const busy = controller.state.busy || choosingWorkspace;
    const liveRun = controller.state.runs.find((run) => !piWorkIsTerminal(run.status));
    const empty = !els.prompt.value.trim();
    const draftLength = piWorkDraftLength(els.prompt.value), tooLong = draftLength > 8000;
    els.draftLimit.hidden = !tooLong;
    els.draftLimit.textContent = tooLong ? `依頼内容は8000文字以内で指定してください（現在${draftLength}文字）。下書きは保持しています。` : "";

    const missingWorkspace = !savedWorkspace;
    const differentWorkspace = Boolean(resumeFrom?.workspace && resumeFrom.workspace.replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase() !== savedWorkspace.replace(/[\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase());
    const displayed = newWork ? null : controller.state.runs.find((run) => run.id === controller.state.selectedId);
    const finished = Boolean(displayed && piWorkIsTerminal(displayed.status) && !resumeFrom);
    els.finished.hidden = !finished;
    els.composer.hidden = finished;
    const retired = Boolean(displayed && (displayed.engine === "pi" || displayed.continuation?.error === "standard_engine_retired"));
    els.finishedText.textContent = retired ? "この作業は旧方式のため再開できません" : displayed?.continuation?.available ? "この会話を続けられます。権限は引き継ぎません。" : "この実行は終了しました。新しい作業を始められます。";
    els.finishedAction.textContent = retired ? "この依頼で新しく始める" : displayed?.continuation?.available ? "この会話を続ける" : "新しい作業を始める";
    els.finishedAction.disabled = busy;
    els.finishedPost.hidden = !(finished && displayed.status === "done" && typeof displayed.finalOutput === "string" && displayed.finalOutput.trim());
    els.finishedPost.disabled = busy;
    els.status.textContent = displayed ? piWorkStatusLabel(displayed.status, displayed.verification)
      : liveRun ? "別の作業を実行中" : missingWorkspace ? "作業フォルダ未設定" : "待機中";
    els.status.hidden = !displayed && !liveRun && missingWorkspace;
    els.status.classList.toggle("is-live", Boolean(displayed && !piWorkIsTerminal(displayed.status)));
    els.status.dataset.state = workStateOf(displayed);
    const railDot = document.querySelector("#rail-ai-dot");
    if (railDot) { railDot.dataset.state = els.status.dataset.state ?? ""; railDot.hidden = els.status.hidden; railDot.title = els.status.textContent; }
    const mode = resumeFrom ? "この実行の続きを入力" : "新しい作業を入力";
    els.prompt.placeholder = mode;
    els.prompt.setAttribute("aria-label", mode);
    els.workspace.hidden = false;
    els.resumeWorkspace.hidden = !differentWorkspace;
    els.resumeWorkspace.disabled = busy || Boolean(liveRun);
    els.resumeWorkspace.title = resumeFrom?.workspace ?? "";
    els.resumeText.textContent = differentWorkspace ? "続きを送るには、履歴の作業フォルダへ切り替えてください。権限は引き継ぎません。" : "この実行の会話から続けます。権限と検証コマンドは新しく指定してください。";
    els.resumeSource.hidden = !differentWorkspace;
    els.resumePath.textContent = differentWorkspace ? resumeFrom.workspace : "";
    els.start.disabled = finished || busy || Boolean(liveRun) || connectionChat.isBusy() || empty || differentWorkspace || tooLong;
    els.start.title = tooLong ? "依頼内容は8000文字以内で指定してください" : differentWorkspace ? "元の作業フォルダを選んでください" : liveRun ? "実行中の作業が終わると送信できます" : empty ? "依頼内容を入力してください" : missingWorkspace ? "フォルダを選んで送信" : resumeFrom ? "続きを送信" : "新しい作業を送信";
    els.start.setAttribute("aria-label", els.start.title);
    els.shortcut.textContent = tooLong ? "8000文字以内にすると送信できます" : differentWorkspace ? "元のフォルダに戻すと送信できます" : missingWorkspace ? "送信時にフォルダを選んで開始" : liveRun ? "実行中 · 次の依頼は終了後に送信" : "Enterで送信 · Shift+Enterで改行";
    if (composerWorkspace) {
      const name = savedWorkspace.split(/[\\/]/).filter(Boolean).at(-1);
      composerWorkspace.querySelector("span").textContent = name ?? "作業フォルダを選ぶ";
      composerWorkspace.title = savedWorkspace || "作業フォルダを設定";
      composerWorkspace.disabled = busy;
      composerWorkspace.classList.toggle("is-attention", missingWorkspace);
    }
    if (modelChip) modelChip.disabled = busy;
    modelPicker?.sync();
    presets?.sync();
    syncPrimary();
  };
  refreshPiWorkComposer = syncSendState;

  const clearResume = () => {
    const previousDsh=resumeFrom?.engine==="dsh";
    resumeFrom = null;
    if(previousDsh)void modelPicker?.refresh();
    els.resume.hidden = true;
    if (modelBeforeResume !== null) {
      els.model.value = modelBeforeResume;
      modelBeforeResume = null;
    }
    syncSendState();
  };
  const activateContinuation = (run, focus) => {
    if (resumeFrom?.id === run.id) { if (focus) els.prompt.focus(); return; }
    if (modelBeforeResume === null) modelBeforeResume = els.model.value;
    const previousDsh=resumeFrom?.engine==="dsh";
    resumeFrom = { id: run.id, engine: run.engine, workspace: run.workspace };
    if(previousDsh!==(run.engine==="dsh"))void modelPicker?.refresh();
    els.model.value = run.model;
    els.allowWrite.checked = els.allowExec.checked = els.allowHttp.checked = false;
    els.allowWrite.onchange();
    els.verifyProgram.value = els.verifyArgs.value = "";
    els.resume.hidden = false;
    syncSendState();
    if (focus) { controller.refresh(); els.prompt.focus(); }
  };

  // hub_pay approval = open this product's buyer screen. Checkout, wallet
  // confirmation and signing stay in the existing market flow.
  const openPurchaseProduct = async ({ productId, quantity }) => {
    const data = await invokeWork("commerce_public_product", { productId });
    if (!isActive() || data?.product?.id !== productId) return false;
    await openDetail("commerce_product", [productId], { local: true, data: data.product, title: typeof data.product.title === "string" ? data.product.title : "商品" });
    showNotice(`AIの提案: 数量 ${quantity}。購入前に商品・価格・数量をご自身で確認してください。支払いは行われていません。`);
    return true;
  };
  const controller = createPiWorkController({
    invoke: invokeWork, timers, purchaseHandoff: openPurchaseProduct,
    getWorkspace: () => savedWorkspace,
    // Idle polling only while someone can see the AI view (or a run is live); entering the view polls once.
    shouldPoll: () => document.visibilityState !== "hidden" && (currentView === "ai" || controller.state.runs.some((run) => !piWorkIsTerminal(run.status))),
    render: ({ runs, selected, busy, error, decideSupported }) => {
      if (!isActive()) return;
      busy ||= choosingWorkspace;
      const liveRun = runs.find((run) => !piWorkIsTerminal(run.status));
      if (initialWorkSelection && !error) {
        newWork = !liveRun || draftContext !== null || els.prompt.value.length > 0;
        if (!newWork && selected) {
          els.prompt.value = drafts.switchTo(draftContext, selected.id, els.prompt.value);
          draftContext = selected.id;
        }
        initialWorkSelection = false;
      }
      const title = newWork || !selected ? "新しい作業" : selected.prompt?.trim().split("\n")[0] || "無題の実行";
      const titleElement = document.querySelector("#pi-work-title");
      titleElement.textContent = title;
      titleElement.title = title;
      const railTitle = document.querySelector("#rail-ai-conv-title");
      if (railTitle) { railTitle.textContent = title; railTitle.title = title; }
      document.querySelector("#pi-work .piw-shell").classList.toggle("is-new", newWork || !selected);
      document.querySelector("#sidebar-ai-new").setAttribute("aria-current", String(newWork || !selected));
      const displayed = newWork ? null : selected;
      renderApprovalSeat(displayed, busy, decideSupported);
      els.error.textContent = error ? piWorkErrorText(error) : "";
      syncSendState();
      document.querySelector("#sidebar-ai-new").disabled = busy;
      document.querySelector("#pi-work-new").disabled = busy;
      document.querySelector("#rail-ai-new").disabled = busy;
      els.cancel.hidden = !liveRun || newWork || selected?.id !== liveRun.id;
      els.cancel.disabled = busy || !liveRun;
      syncPrimary();
      for (const input of [els.model, els.allowWrite, els.allowExec, els.allowHttp, els.verifyProgram, els.verifyArgs, els.bestOf, els.fastCheck]) if (input) input.disabled = busy;
      els.prompt.readOnly = busy;
      els.workspace.disabled = busy;
      els.resumeClear.disabled = busy;

      renderWorkHistory(runs, newWork ? null : selected, busy);
      const recentRuns = [...runs].sort((a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0)).slice(0, 3);
      const key = JSON.stringify([busy, decideSupported, newWork, selected, resumeFrom?.id, [...interrupted.values()],
        newWork || !selected ? recentRuns.map((run) => [run.id, run.prompt, run.status, run.startedAtMs]) : null]);
      if (key === last.timeline) { updateElapsed(displayed); updateLatest(); return; }
      last.timeline = key;
      if (newWork || !selected) {
        clearChangesPanel();
        const empty = document.createElement("div");
        empty.className = "piw-empty";
        empty.insertAdjacentHTML("afterbegin", '<svg class="piw-empty-icon ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v10H10l-5 4Z"/></svg>');
        const heading = document.createElement("strong");
        heading.textContent = "AIに何を依頼しますか？";
        const detail = document.createElement("span");
        detail.textContent = savedWorkspace ? `${savedWorkspace.split(/[\\/]/).filter(Boolean).at(-1) ?? savedWorkspace} で作業します` : "作業フォルダを選んでください";
        empty.append(heading, detail);
        if (recentRuns.length) {
          const recent = document.createElement("div");
          recent.className = "piw-empty-recent layout-reading";
          for (const run of recentRuns) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "piw-empty-recent-item";
            button.disabled = busy;
            const dot = document.createElement("i");
            dot.className = "piw-dot";
            dot.dataset.state = workStateOf(run);
            dot.setAttribute("aria-hidden", "true");
            const name = document.createElement("span");
            name.textContent = run.prompt?.trim().replace(/\s+/g, " ") || "無題の実行";
            const state = document.createElement("small");
            state.textContent = relativeTime(run.startedAtMs);
            button.title = piWorkStatusLabel(run.status, run.verification);
            button.append(dot, name, state);
            button.onclick = () => selectHubWork(run);
            recent.append(button);
          }
          empty.append(recent);
        }
        els.timeline.replaceChildren(empty);
        updatePiWorkEmptyState();
        updateLatest();
        return;
      }
      const scrollTop = els.timeline.scrollTop;
      const sameRun = els.timeline.querySelector(".piw-turn")?.dataset.runId === selected.id;
      // A block that still shows its automatic state follows the new default (live open, finished collapsed); a manual toggle wins.
      const detailStates = new Map(sameRun ? [...els.timeline.querySelectorAll("details[data-detail-key]")].filter((detail) => detail.dataset.autoOpen === undefined || detail.open !== (detail.dataset.autoOpen === "1")).map((detail) => [detail.dataset.detailKey, detail.open]) : []);
      const nextTurn = turnEl(selected, busy, decideSupported);
      for (const detail of nextTurn.querySelectorAll("details[data-detail-key]")) {
        if (detailStates.has(detail.dataset.detailKey)) detail.open = detailStates.get(detail.dataset.detailKey);
      }
      els.timeline.replaceChildren(nextTurn);
      els.timeline.scrollTop = stickToBottom ? els.timeline.scrollHeight : scrollTop;
      updateLatest();
    }
  });
  syncPiChangesView = view => { clearChangesPanel(); last.timeline=""; if(view === "ai") { void controller.refresh(); void controller.poll(); void loadInterrupted(); } };
  void loadInterrupted();
  refreshHubWorkHistory = () => renderWorkHistory(controller.state.runs, newWork ? null : controller.state.runs.find((run) => run.id === controller.state.selectedId));
  els.historySearch.addEventListener("input", refreshHubWorkHistory);

  const send = async () => {
    const inspectingFinished = () => !newWork && !resumeFrom && piWorkIsTerminal(controller.state.runs?.find((run) => run.id === controller.state.selectedId)?.status);
    if (els.start.disabled || inspectingFinished()) return;
    // A connection chosen for AI work starts a Pi run; the model field's own BYOK refs stay chat.
    const askNote = els.hubpediaAskNote;
    if (els.hubpediaAsk?.checked) {
      // ハブペディアに聞く: Hubへ出るのは検索語だけ。回答は選んだ接続（自分のAI）が作り、資料に基づく文だけを残す。
      if (askNote) askNote.hidden = connectionChat.handles(els.model.value);
      if (!connectionChat.handles(els.model.value)) { if (askNote) askNote.textContent = "ハブペディアに聞くには、モデル欄で自分のAPIキーの接続かインストール済みCLIを選んでください。"; return; }
      const text = els.prompt.value;
      const openLink = (url) => { try { const u = new URL(url); if (/^(hub\.jkamma\.com|localhost|127\.0\.0\.1)$/.test(u.hostname)) void openHubPath(u.pathname + u.search); else void enterBrowser(url); } catch { /* ignore */ } };
      if (await connectionChat.askHubpedia(text, els.model.value, els.model.value.slice(els.model.value.indexOf("/") + 1), { retrieve: (q) => invokeWork("hub_resource", { resource: "hubpedia_retrieve", query: q }), openLink })) {
        connectionModels.remember(els.model.value);
        drafts.forget(draftContext);
        els.prompt.value = "";
        autogrow();
        els.prompt.focus();
      }
      return;
    }
    if (!els.connection?.value && connectionChat.handles(els.model.value)) {
      const text = els.prompt.value;
      if (await connectionChat.send(text, els.model.value, els.model.value.slice(els.model.value.indexOf("/") + 1))) {
        connectionModels.remember(els.model.value);
        drafts.forget(draftContext);
        els.prompt.value = "";
        autogrow();
        els.prompt.focus();
      }
      return;
    }
    connectionChat.reset();
    if (!savedWorkspace && !(await pickWorkspace())) return;
    if (els.start.disabled || inspectingFinished()) return;
    stickToBottom = true;
    const submittedContext = draftContext, submittedText = els.prompt.value;
    if (await controller.start({ prompt: submittedText, model: els.model.value, connection: els.connection?.value ?? "", connectionModel: els.connectionModel?.value ?? "", allowWrite: els.allowWrite.checked, allowExec: els.allowExec.checked, allowHttp: els.allowHttp.checked, verifyProgram: els.verifyProgram.value, verifyArgs: els.verifyArgs.value, bestOf: els.bestOf?.value ?? "", bestOfConfirmed: Boolean(els.bestOfConfirm?.checked), checkers: els.fastCheck?.checked ? fastCheckers : [], resumeRunId: resumeFrom?.id, engine: resumeFrom ? (resumeFrom.engine ?? "thin") : "thin" })) {
      drafts.forget(submittedContext);
      if (draftContext === submittedContext && els.prompt.value === submittedText) {
        els.prompt.value = "";
        draftContext = controller.state.selectedId;
        newWork = false;
        clearResume();
        controller.refresh();
        autogrow();
        els.prompt.focus();
      }
    }
  };
  els.start.onclick = () => void send();
  const newWorkAction = () => {
    if (controller.state.busy || choosingWorkspace || connectionChat.isBusy()) return;
    connectionChat.reset();
    if (newWork) { els.prompt.focus(); return; }
    railNav.visit("ai", "new", null, { key: controller.state.selectedId ?? "new" });
    const text = drafts.switchTo(draftContext, null, els.prompt.value);
    draftContext = null;
    initialWorkSelection = false;
    newWork = true;
    stickToBottom = true;
    els.historySearch.value = "";
    clearResume();
    controller.refresh();
    els.prompt.value = text;
    autogrow();
    els.prompt.focus();
  };
  els.finishedPost.onclick = () => {
    if (controller.state.busy || choosingWorkspace) return;
    const selected = controller.state.runs.find((run) => run.id === controller.state.selectedId);
    if (!selected || selected.status !== "done" || typeof selected.finalOutput !== "string") return;
    els.finishedPost.disabled = true;
    void draftPostFromAiAnswer(selected.finalOutput).catch(() => showNotice("投稿の下書きを開けませんでした。")).finally(() => { els.finishedPost.disabled = false; });
  };
  els.finishedAction.onclick = () => {
    if (controller.state.busy || choosingWorkspace) return;
    const selected = controller.state.runs.find((run) => run.id === controller.state.selectedId);
    if (!selected || !piWorkIsTerminal(selected.status)) return;
    if (selected.engine === "pi" || selected.continuation?.error === "standard_engine_retired") {
      // Saved standard run: view-only. Start a fresh thin run with the same request; never resume.
      newWorkAction();
      els.prompt.value = String(selected.prompt ?? "");
      els.prompt.dispatchEvent(new Event("input", { bubbles: true }));
      els.prompt.focus();
    } else if (selected.continuation?.available) activateContinuation(selected, true);
    else newWorkAction();
  };
  document.querySelector("#sidebar-ai-new").onclick = newWorkAction;
  document.querySelector("#pi-work-new").onclick = newWorkAction;
  document.querySelector("#rail-ai-new").onclick = newWorkAction;
  // 右列のAIの戻る・進む：作業の切り替え（新しい作業 ⇄ 過去の作業）を戻る。動作中は動かさない。
  railNav.handle("ai", (entry) => {
    if (controller.state.busy || choosingWorkspace || connectionChat.isBusy()) return null;
    if (entry.key === "new") { newWorkAction(); return true; }
    const run = controller.state.runs.find((item) => item.id === entry.key);
    if (!run) return false;
    selectHubWork(run);
    return true;
  });
  els.resumeClear.onclick = newWorkAction;
  els.resumeWorkspace.onclick = async () => {
    if (!resumeFrom?.workspace || controller.state.busy || choosingWorkspace || controller.state.runs.some((run) => !piWorkIsTerminal(run.status))) return;
    els.resumeWorkspace.disabled = true;
    try {
      await invokeWork("set_dev_workspace", { path: resumeFrom.workspace });
      await refreshWorkspace();
      dev.path.value = savedWorkspace;
      els.error.textContent = "";
      els.prompt.focus();
    } catch (error) {
      const reason = { "not a directory": "元のフォルダが見つかりません", "git workspace required": "元のフォルダは現在の作業フォルダとして使えません" }[String(error)] ?? piWorkErrorText(error);
      els.error.textContent = `元の作業フォルダを設定できません: ${reason}`;
    } finally {
      syncSendState();
    }
  };
  els.prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); send(); }
  });
  const autogrow = () => {
    els.prompt.style.height = "auto";
    els.prompt.style.height = `${Math.min(els.prompt.scrollHeight, 132)}px`;
    syncSendState();
  };
  els.prompt.addEventListener("input", autogrow);
  syncSendState();
  els.cancel.onclick = () => {
    const current = controller.state.runs.find((run) => !piWorkIsTerminal(run.status));
    if (current) void controller.cancel(current.id);
  };
  // The preset popover only sets these checkboxes; they stay the source of truth for pi_work_start.
  els.allowWrite.onchange = () => presets?.sync();
  // Best-of-N: the N-attempt estimate is shown and confirmed before a start;
  // Rust refuses a start whose echoed estimate differs from its own.
  if (els.bestOf) els.bestOf.onchange = () => {
    const estimate = bestOfEstimate(els.bestOf.value);
    els.bestOfEstimate.hidden = !estimate;
    els.bestOfEstimate.textContent = estimate?.text ?? "";
    els.bestOfConfirm.checked = false;
    els.bestOfConfirm.disabled = !estimate;
  };
  // Fast check: the detected commands are shown; ticking the box allows exactly them for the run.
  let fastCheckers = [];
  if (els.fastCheck) els.fastCheck.onchange = async () => {
    fastCheckers = [];
    els.fastCheckNote.hidden = !els.fastCheck.checked;
    els.fastCheckNote.textContent = "";
    if (!els.fastCheck.checked) return;
    try {
      const found = await invokeWork("pi_work_detect_checkers", { workspace: savedWorkspace });
      fastCheckers = Array.isArray(found) ? found.map(checker => checker.command) : [];
      els.fastCheckNote.textContent = fastCheckers.length
        ? `使う検査: ${found.map(checker => `${checker.id}（${[checker.command.program, ...checker.command.args].join(" ")}）`).join("、")}。コマンド実行の有効化が必要です。`
        : "この作業フォルダでは対応する検査（tsc・cargo check・pyright・mypy・eslint）が見つかりません。";
    } catch (error) { els.fastCheck.checked = false; els.fastCheckNote.textContent = piWorkErrorText(error); }
  };

  piWorkDraftHandler = (draft, source) => {
    if(source?.isCurrent?.()===false)return false;
    if (controller.state.busy || choosingWorkspace || els.prompt.readOnly) throw new Error("ai_work_busy");
    const selected = newWork ? null : controller.state.runs.find((run) => run.id === controller.state.selectedId);
    const useNew = Boolean(selected && piWorkIsTerminal(selected.status) && !resumeFrom);
    let combined;
    try { combined = drafts.append(useNew ? drafts.get(null) : els.prompt.value, draft); }
    catch (error) { throw new Error(String(error?.message ?? error) === "ai_draft_too_long" ? "ai_draft_too_long" : "ai_draft_invalid"); }
    if (useNew) newWorkAction();
    initialWorkSelection = false;
    els.prompt.value = combined;
    els.prompt.dispatchEvent(new Event("input", { bubbles: true }));
    source?.onAccepted?.();
    if (rightRailAvailable("browser")) {
      railPreferredView = "ai"; saveRailChoice(true); setDesktopRailOpen(true); syncRailView();
    } else {
      navigateFrom({ dataset: { view: "ai", title: "AI" }, childNodes: [] });
    }
    els.prompt.focus();
    return true;
  };

  const pick = (id) => document.querySelector(`#pi-work-${id}`);
  // AI market (slice 1): listed endpoints join the picker. Listings are public data read through the Hub resource list; no key is involved.
  let marketListings = [];
  const loadMarketListings = () => Promise.resolve(invoke("hub_resource", { resource: "ai_market", query: "", cursor: null })).then((body) => { marketListings = normalizeListings(body); modelPicker?.sync?.(); }).catch(() => { marketListings = []; });
  void loadMarketListings();
  const marketController = createMarketController({ storage: safeStorage, getListings: () => marketListings, ask: (info) => showDisclosure(document, info) });
  modelPicker=createPiModelPicker(document,{input:els.model,list:els.modelList,market:marketController,
    refreshButton:document.querySelector('#pi-work-model-refresh'),status:document.querySelector('#pi-work-model-status'),invoke:connectionModels.invoke,groupOf:connectionModels.groupOf,privacyOf:connectionModels.privacyOf,
    ui:pick("model-chip")&&{chip:pick("model-chip"),chipLabel:pick("model-chip-label"),popover:pick("model-popover"),search:pick("model-search"),options:pick("model-options")},
    getContext:()=>{const engine=resumeFrom?.engine==='dsh'?'dsh':'pi';return{engine,key:engine};}});
  // 最後に選んだモデルを覚える。接続（キー・CLI）のモデルは、一覧に現れてから戻す。
  els.model.addEventListener("input", () => connectionModels.remember(els.model.value.trim()));
  void modelPicker.ready?.then(() => {
    const saved = connectionModels.remembered();
    if (saved && parseRef(saved) && connectionModels.known(saved) && !els.model.value.trim()) {
      els.model.value = saved;
      els.model.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  if (pick("perm-chip")) presets = createPiPermissionPresets(document, {
    chip: pick("perm-chip"), chipLabel: pick("perm-chip-label"), popover: pick("perm-popover"),
    checkboxes: { write: els.allowWrite, exec: els.allowExec, http: els.allowHttp },
    presetButtons: [...pick("perm-popover").querySelectorAll("button[data-preset]")], customRow: pick("perm-custom"),
    confirmBox: pick("write-confirm"), confirmOk: pick("write-confirm-ok"), confirmCancel: pick("write-confirm-cancel"), lockNote: pick("perm-lock"),
    verifyProgram: els.verifyProgram, verifyWarning: pick("verify-warning"), verifyEnable: pick("verify-enable"),
    // Permissions are fixed once a run starts; a request in flight or a live run both lock them.
    isLocked: () => controller.state.busy || choosingWorkspace || controller.state.runs.some((run) => !piWorkIsTerminal(run.status))
  });
  syncSendState();
  controller.ready = controller.load();
  return controller;
}

if (!startupTool) window.addEventListener("beforeunload", () => {
  legacyPiWorkController?.dispose();
}, { once: true });

if (!startupTool && window.__TAURI__?.event?.listen) {
  const listen = (name, callback) => window.__TAURI__.event.listen(name, callback);
  nativeSidebar = initNativeSidebar({ document, window, invoke, listen, getView: () => currentView,
    // Off: with every screen using the left column (2026-10-11) the native rows did not appear and hid the DOM rows.
    eligible: () => false });
  initBrowserAiControl({listen,invoke,
    isReady:()=>!startupTool&&!appsOpen&&browserActive&&currentView==='browser'&&!document.querySelector('dialog[open]'),
    sendToAi:(context,markPhase)=>browserControls?.sendToAi(context,markPhase),
    readResult:(_tabId,url)=>{
      const host=document.querySelector('#rail-browser-reference');
      return browserAiReference?.matches(url)===true&&host&&!host.hidden&&host.getClientRects().length
        ?{accepted:true,reference:true,surface:'pi'}:null;
    },
  });
  initShellControl({
    listen, invoke,
    canInspect: () => !startupTool,
    canLayout: () => !appsOpen && window.innerWidth >= 1180 && !desktopShell.classList.contains("browser-active") && !document.body.classList.contains("column-resizing") && !document.querySelector("dialog[open]"),
    applyLayout: async (layout, alive, remaining = () => 5000) => {
      if (!alive()) return;
      const libraries={saved_articles:'保存した記事',article_drafts:'下書き',video_library:'あとで見る',music_library:'お気に入りの音楽',video_playlists:'動画のプレイリスト',music_playlists:'音楽のプレイリスト'};
      if(Object.hasOwn(libraries,layout.view))await openDetail(layout.view,[],{title:libraries[layout.view],local:true,data:{}});
      else {
        const source = document.querySelector(`.nav-item[data-view="${layout.view}"]`);
        if (!source) throw new Error("shell_view_unavailable");
        // Layout readiness is the shown surface; ordinary navigation still awaits its reads.
        await new Promise((resolve, reject) => {
          navigateFrom(source, {}, { alive, onShown: resolve }).then(resolve, reject);
        });
      }
      if (!alive()) return;
      setDesktopRailOpen(layout.railOpen);
      desktopShell.classList.toggle("sidebar-collapsed", !layout.sidebarOpen);
      sidebarCollapsedForRail = false;
      renderSidebarContext(currentView);
      syncToolbarSidebar();
      applyColumnWidths();
    },
    readState: () => {
      const detail=currentView==='detail'?detailTrail.at(-1)?.name:null;
      const view = ['saved_articles','article_drafts','video_library','music_library','video_playlists','music_playlists'].includes(detail)?detail:
        ["feed", "notifications", "market", "settings","music","node","search","videos","wallet","ai","articles","threads","research","messages"].includes(currentView)?currentView:null;
      const usesNative=['feed','notifications','market','settings'].includes(view);
      const native = nativeSidebar.status();
      const aiSurface = view === "ai" ? "legacy" : null;
      return { view, aiSurface, sidebarOpen: !desktopShell.classList.contains("sidebar-collapsed"), railOpen: desktopShell.classList.contains("rail-open"),
        sidebarWidth: Number(document.querySelector("#sidebar-resizer").getAttribute("aria-valuenow")),
        railWidth: Number(document.querySelector("#rail-resizer").getAttribute("aria-valuenow")),
        sidebarSelected: usesNative ? native.selected : 0, nativeRevision: view === "ai" ? 0 : native.revision, nativeIds: usesNative ? native.ids : [] };
    }
  });
}
networkViewsReady=true;
controlMetrics.mark("uiWired");
// 同梱メイン窓のAI画面と旧専用窓だけが作業面を初期化する。
if (!startupTool || startupTool === "harness") {
  legacyPiWorkController = initPiWork();
  await controlMetrics.measure("workspace", refreshWorkspace);
  await controlMetrics.measure("agents", loadAgents);
  await controlMetrics.measure("attach", attachToRunInProgress);
  await controlMetrics.measure("lastSession", ()=>loadLastSession({observeStartup:true}));
}
if (!startupTool) {
  document.querySelector("#search-results").replaceChildren(
    emptyState("search", "検索", "上の検索欄に入力してEnterを押してください。"));
  await controlMetrics.measure("feed", ()=>loadFeed({observeStartup:true}));
  controlMetrics.mark("feedReady");
  await controlMetrics.measure("node", loadNode);
  void loadHomeSummary();
}

controlMetrics.mark("startupComplete");

// Asking about isolation runs `docker version`, a whole process. The approval
// lists have to be current to the second; whether Docker is installed does not
// change that fast, so it is asked far less often.
async function refreshIsolation() {
  if (Date.now() - isolationCheckedAt < ISOLATION_EVERY_MS) return;
  isolationCheckedAt = Date.now();
  isolationReady = (await invoke("isolation_status")) === "docker";
  isolationNode.textContent = isolationReady ? "隔離テスト: 利用可能" : "隔離テスト: この端末では利用できません";
}

async function refresh() {
  await refreshIsolation();
  const ready = isolationReady;
  const [runs, writes, development] = await Promise.all([invoke("pending_runs"), invoke("pending_file_writes"), invoke("pending_dev_runs")]);
  runsNode.className = runs.length ? "" : "empty";
  runsNode.replaceChildren(...(runs.length ? runs.map((run) => runCard(run, ready)) : [document.createTextNode("実行リクエストはありません")]));
  writesNode.className = writes.length ? "" : "empty";
  writesNode.replaceChildren(...(writes.length ? writes.map(writeCard) : [document.createTextNode("保存リクエストはありません")]));
  devApprovalsNode.className = development.length ? "" : "empty";
  devApprovalsNode.replaceChildren(...(development.length ? development.map(devApprovalCard) : [document.createTextNode("開発リクエストはありません")]));
}

if (!startupTool || startupTool === "harness") {
  if (startupTool === "harness") await refresh();
  // Every second while someone can see it; a hidden or minimized window has no one to answer an approval.
  setInterval(() => { if (document.visibilityState !== "hidden" && (startupTool === "harness" || currentView === "ai")) void refresh(); }, 1000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState !== "hidden" && (startupTool === "harness" || currentView === "ai")) void refresh(); });
}


// 接続先と現在の端末を毎回読み直し、別の本人の公開へ引き継がない。
async function articleEditorScope() {
  const generation = researchAccountGeneration, account = desktopAccount;
  if (!desktopAccountLoaded || account.state !== "registered" || !account.deviceId) return null;
  const [origin, status] = await Promise.all([invoke("hub_origin"), invoke("desktop_account_status")]);
  if (generation !== researchAccountGeneration || account !== desktopAccount
    || status?.state !== "registered" || status.deviceId !== account.deviceId) return null;
  const url = new URL(origin);
  return { key: JSON.stringify([url.origin, status.deviceId]), generation };
}
let articleDraftStorage = null;
try { articleDraftStorage = window.localStorage; } catch {}
// 記事を書く画面の「コミュニティに載せる」選択。公開が確認できたあとに載せる。
const articleCommunityPicker = createCommunityPicker({ document, invoke, isCurrent: () => currentView === "articles" });
articleCommunityPicker.root.addEventListener("change", (event) => event.stopPropagation());
window.addEventListener("hub-account-changed", () => { void articleCommunityPicker.refresh(); });
document.querySelector("#articles-create .detail-form-row:last-of-type")?.before(articleCommunityPicker.root);
if (!startupTool) articleEditor = createArticleComposer({
  document, form: document.querySelector("#articles-create"),
  toggle: document.querySelector("#articles-create-toggle"), state: document.querySelector("#articles-create-state"),
  invoke, getScope: articleEditorScope, isCurrent: () => currentView === "articles",
  renderMarkdown: articleBodyNodes, storage: articleDraftStorage,
  onPublished: async result => {
    const generation = researchAccountGeneration;
    const articleCommunity = articleCommunityPicker.value();
    if (articleCommunity) {
      const linked = await linkToCommunity(invoke, articleCommunity, "article", result.id);
      articleCommunityPicker.reset();
      if (!linked.ok) showNotice("記事は公開しました。コミュニティには載せられませんでした。");
    }
    await loadCatalog("articles");
    if (generation === researchAccountGeneration && currentView === "articles")
      await openDetail("article", [result.id], { title: "記事" });
  },
});
window.addEventListener("hub-account-changed", () => { void articleEditor?.refreshScope().catch(() => {}); });
// 記事の作成口もこの1つの作成画面へ（旧モジュールは L5 まで残す）。
document.querySelector("#articles-create-toggle")?.addEventListener("click", (event) => { event.preventDefault(); event.stopImmediatePropagation(); openPostComposer(); }, true);

// 端のぼかし（タブ列）。
bindEdgeFade(document);

// 字のボタンを記号へ（text-button-icons.mjs）。
installTextButtonIcons(document);

// モジュールの初期化が終わったあとで、接続済みならタイムライン先頭の投稿欄を置く（接続の通知がこれより先に来ていた場合）。
syncFeedInlineComposer();
