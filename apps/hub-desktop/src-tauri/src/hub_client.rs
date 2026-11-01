use serde::{Deserialize, Serialize};
// Add next to the existing private scoped-client modules. No legacy feed edits.
#[path = "social_stream_client.rs"]
mod social_stream_client;
pub async fn fetch_social_stream(base: &str, filter: &str, scope: &str, limit: u32, cursor: Option<&str>) -> Result<serde_json::Value, String> {
    social_stream_client::read(base, filter, scope, limit, cursor).await
}

#[path="owned_settings.rs"] mod owned_settings;
#[path="scoped_social_client.rs"] mod scoped_social_client;
#[path="scoped_dm_client.rs"] mod scoped_dm_client;
#[path="scoped_feed_client.rs"] mod scoped_feed_client;

/// ハブをSNSとして読む側。
///
/// 取りに行くのは Rust。窓の CSP は `connect-src ipc:` だけで、窓のJSからは
/// 外へ出られない。**そこを緩めない。** 緩めると、この窓で動くものが任意の
/// 宛先へ出られるようになる。宛先を1つに絞ったまま、必要なものだけを渡す。
///
/// 宛先は `hub_window::hub_url` と同じ絞り込みを通る（https かこの端末の
/// ループバックのみ）。

/// 一度に運ぶ上限。ハブ側も50で切っている。
const MAX_LIMIT: u32 = 50;
/// 応答の上限。ハブが壊れて巨大な本文を返しても、端末が固まらないように。
const MAX_BYTES: usize = 2 * 1024 * 1024;

/// Desktop から読める Hub の公開面。窓から URL を渡させず、名前から固定の
/// パスへ変換することで `/api/admin` などへ曲げられないようにする。
pub fn resource_path(resource: &str) -> Option<&'static str> {
    match resource {
        "search" => Some("/api/search"),
        "web_search" => Some("/api/search/web"),
        "communities" => Some("/api/communities"),
        "threads" => Some("/api/bbs/threads"),
        "articles" => Some("/api/articles"),
        "videos" => Some("/api/videos"),
        "hubpedia" => Some("/api/hubpedia/v1/search"),
        "hubpedia_catalog" => Some("/api/hubpedia/v1/articles"),
        // 「ハブペディアに聞く」の資料取得（2026-10-30）。送るのは検索語だけで、回答は端末側のAIが作る。
        "hubpedia_retrieve" => Some("/api/hubpedia/retrieve"),
        "research" => Some("/api/client/research"),
        "github_repository" => Some("/api/client/github/repository"),
        "music" => Some("/api/music"),
        "games" => Some("/api/games"),
        "games_store" => Some("/api/games/store"),
        "books" => Some("/api/books"),
        "market" => Some("/api/listings"),
        "market_tickets" => Some("/api/market/tickets"),
        "distributed_posts" => Some("/api/distributed/resources?kind=post&limit=30"),
        "rankings" => Some("/api/token-rankings"),
        "world" => Some("/api/world/servers"),
        _ => None,
    }
}

/// 本人にしか返せないクライアント向けパス。公開面（resource_path）とは別の表に
/// する。ここは必ず desktop assertion を持って行くので、未接続のときは窓側へ
/// 「接続が要る」ことを分けて返せるように失敗語を固定する。
/// `/api/lists` と `/api/platform/developer/services` はHub側でviewer解決
/// （Bearerがあればassertion、無ければCookieセッション）を受け付ける。
pub fn client_path(name: &str) -> Option<&'static str> {
    match name {
        "me" => Some("/api/client/me"),
        // 自分が誰かと未読数だけ。自分の投稿50件を読まない（タイムラインと未読バッジ用）。
        "me_summary" => Some("/api/client/me?posts=0"),
        "saved_articles" => Some("/api/client/articles/saved"),
        // 自分の下書き一覧（本文なし）。本人だけ。
        "article_drafts" => Some("/api/client/articles/drafts"),
        "video_library" => Some("/api/client/videos/library"),
        "video_playlists" => Some("/api/client/videos/playlists"),
        "music_playlists" => Some("/api/client/music/playlists"),
        "music_favorites" => Some("/api/client/music/favorites"),
        "music_library" => Some("/api/client/music/library"),
        "personal_node" => Some("/api/client/personal-node"),
        "notifications" => Some("/api/client/notifications"),
        "conversations" => Some("/api/client/conversations"),
        "bookmarks" => Some("/api/client/bookmarks"),
        "contacts" => Some("/api/client/contacts"),
        "wallet" => Some("/api/client/wallet"),
        "lists" => Some("/api/lists"),
        "services" => Some("/api/platform/developer/services"),
        "boards" => Some("/api/client/boards"),
        "settings" => Some("/api/client/settings"),
        // 保存容量の合計・上限・プラン（Accountが正本。読めないときは503で、0を作らない）。
        "storage" => Some("/api/client/storage"),
        "safety" => Some("/api/client/safety"),
        "tips" => Some("/api/client/tips"),
        "scheduled_posts" => Some("/api/client/scheduled-posts"),
        "federated_feed" => Some("/api/federation/recommendations"),
        // 自分が送った他のハブの人へのフォローと、その状態（pending / accepted / rejected）。
        "remote_follows" => Some("/api/client/federation/follows"),
        _ => None,
    }
}

/// 詳細面の固定パステンプレート。`{a}`・`{b}` には窓から来た識別子が
/// 入るが、識別子の形しか通さない（下の path_segment）。名前→テンプレートの
/// 表は閉じているので、窓が任意のURLを組み立てることはできない。
/// bool は「viewerで返り値が変わる面」= assertionを添えて個人化する印。
/// 公開面でも添えて良い面だけに絞り、発行の往復を増やさない。
fn detail_path(name: &str) -> Option<(&'static str, bool)> {
    match name {
        "thread_post_relationship" => Some(("/api/client/thread-posts/{a}/relationship", true)),
        "thread_post_history" => Some(("/api/client/thread-posts/{a}/history", true)),
        "article_publication" => Some(("/api/client/articles/publication/{a}", true)),
        "community_notifications" => Some(("/api/client/communities/{a}/notifications", true)),
        "community_invite" => Some(("/api/client/community-invites/{a}", true)),
        "music_library_page" => Some(("/api/client/music/library?offset={a}", true)),
        "research_pdfs" => Some(("/api/client/research/{a}/pdfs", true)),
        // viewerが効く面（接続済みなら個人化・未接続でも公開分は読める）
        "post" => Some(("/api/client/posts/{a}", true)),
        "community" => Some(("/api/client/communities/{a}", true)),
        "community_channel_policy" => Some(("/api/client/communities/{a}/channels/policy", true)),
        "community_access_management_page" => Some(("/api/client/communities/{a}/access-management?kind={b}&offset={c}", true)),
        "community_channel_policy_page" => Some(("/api/client/communities/{a}/channels/policy?offset={b}", true)),
        "community_membership_requests" => Some(("/api/client/communities/{a}/membership-requests", true)),
        "community_membership_requests_page" => Some(("/api/client/communities/{a}/membership-requests?offset={b}", true)),
        "community_membership_request" => Some(("/api/client/communities/{a}/membership-requests/{b}", true)),
        "community_reports" => Some(("/api/client/communities/{a}/reports", true)),
        "community_reports_page" => Some(("/api/client/communities/{a}/reports?offset={b}", true)),
        "community_report" => Some(("/api/client/communities/{a}/reports/{b}", true)),
        "community_appeals" => Some(("/api/client/communities/{a}/appeals", true)),
        "community_appeals_page" => Some(("/api/client/communities/{a}/appeals?offset={b}", true)),
        "community_appeal" => Some(("/api/client/communities/{a}/appeals/{b}", true)),
        "community_appeal_history" => Some(("/api/client/communities/{a}/my-appeals", true)),
        "community_members" => Some(("/api/client/communities/{a}/members", true)),
        "community_guide_reviews_page" => Some(("/api/client/communities/{a}/guides/proposals/{b}/reviews?offset={c}", true)),
        "community_guide_proposals" => Some(("/api/client/communities/{a}/guides/proposals", true)),
        "community_guide_proposals_page" => Some(("/api/client/communities/{a}/guides/proposals?offset={b}", true)),
        "community_guide_proposal" => Some(("/api/client/communities/{a}/guides/proposals/{b}", true)),
        "community_guides" => Some(("/api/client/communities/{a}/guides", true)),
        "community_guides_directory_page" => Some(("/api/client/communities/{a}/guides?offset={b}&directory={c}", true)),
        "community_guides_page" => Some(("/api/client/communities/{a}/guides?offset={b}", true)),
        "community_guide" => Some(("/api/client/communities/{a}/guides/{b}", true)),
        "community_guide_revisions" => Some(("/api/client/communities/{a}/guides/{b}/revisions", true)),
        "community_guide_revisions_page" => Some(("/api/client/communities/{a}/guides/{b}/revisions?offset={c}", true)),
        "community_guide_revision" => Some(("/api/client/communities/{a}/guides/{b}/revisions/{c}", true)),
        "community_governance" => Some(("/api/client/communities/{a}/governance/proposals", true)),
        "community_governance_page" => Some(("/api/client/communities/{a}/governance/proposals?offset={b}", true)),
        "community_governance_proposal" => Some(("/api/client/communities/{a}/governance/proposals/{b}", true)),
        "community_governance_settings" => Some(("/api/client/communities/{a}/governance/settings", true)),
        "community_governance_create_context" => Some(("/api/client/communities/{a}/governance/proposals/context", true)),
        "community_governance_mutation_context" => Some(("/api/client/communities/{a}/governance/proposals/{b}/context", true)),
        "community_onboarding" => Some(("/api/client/communities/{a}/onboarding", true)),
        "channel_messages" => Some(("/api/client/communities/{a}/channels/{b}/messages", true)),
        "profile" => Some(("/api/client/profiles/{a}", true)),
        // プロフィールの記事・動画・コードのタブ（公開の一覧だけ。端末の資格は送らない）。続きは base64url のカーソル。
        "profile_articles" => Some(("/api/articles?author={a}", false)),
        "profile_articles_page" => Some(("/api/articles?author={a}&cursor={b}", false)),
        "profile_videos" => Some(("/api/videos?author={a}", false)),
        "profile_videos_page" => Some(("/api/videos?author={a}&cursor={b}", false)),
        "profile_code" => Some(("/api/code/repos?owner={a}", false)),
        "profile_code_page" => Some(("/api/code/repos?owner={a}&cursor={b}", false)),
        "tag" => Some(("/api/client/tags/{a}", true)),
        // 内側左列（2026-10-15）。kind は feed・videos・music・articles、続きは base64url のキー。
        "sidebar" => Some(("/api/client/sidebar/{a}", true)),
        "sidebar_page" => Some(("/api/client/sidebar/{a}/{b}", true)),
        "subscriptions" => Some(("/api/client/subscriptions/{a}", true)),
        "research_git_management" => Some(("/api/client/research/{a}/git", true)),
        "research_git_history" => Some(("/api/client/research/{a}/git/browse", true)),
        "research_git_commit" => Some(("/api/client/research/{a}/git/browse?commit={b}", true)),
        "research_git_compare" => Some(("/api/client/research/{a}/git/browse?commit={b}&base={c}", true)),
        "research_git_proposals" => Some(("/api/client/research/{a}/git/proposals", true)),
        "research_git_proposals_page" => Some(("/api/client/research/{a}/git/proposals?cursor={b}", true)),
        "research_git_proposal" => Some(("/api/client/research/{a}/git/proposals?proposal={b}", true)),
        "research_git_discussion" => Some(("/api/client/research/{a}/git/discussion?commit={b}", true)),
        "research_proposal_discussions" => Some(("/api/client/research/{a}/proposals/{b}/discussions", true)),
        "research_proposal" => Some(("/api/client/research/{a}/proposals/{b}", true)),
        "research_project" => Some(("/api/client/research/{a}", true)),
        "research_fork" => Some(("/api/client/research/{a}/fork", true)),
        "research_network_fork" => Some(("/api/client/research/network-fork",true)),
        "research_document" => Some(("/api/client/research/{a}/documents/{b}", true)),
        "research_revision" => Some(("/api/client/research/{a}/documents/{b}?version={c}", true)),
        "research_discussion" => Some(("/api/client/research/{a}/workspace?discussion={b}&version={c}", true)),
        "research_publication_updates" => Some(("/api/research/discovery", false)),
        "research_backlinks_article" => Some(("/api/research/discovery?kind=article&id={a}", false)),
        "research_backlinks_music" => Some(("/api/research/discovery?kind=music&id={a}", false)),
        "research_backlinks_video" => Some(("/api/research/discovery?kind=video&id={a}", false)),
        "research_backlinks_hubpedia" => Some(("/api/research/discovery?kind=hubpedia&id={a}", false)),
        "research_backlinks_thread" => Some(("/api/research/discovery?kind=thread&id={a}", false)),
        "research_backlinks_community" => Some(("/api/research/discovery?kind=community&id={a}", false)),
        "research_links_article" => Some(("/api/client/research/{a}/links?kind=article&q={b}", true)),
        "research_links_music" => Some(("/api/client/research/{a}/links?kind=music&q={b}", true)),
        "research_links_video" => Some(("/api/client/research/{a}/links?kind=video&q={b}", true)),
        "research_links_hubpedia" => Some(("/api/client/research/{a}/links?kind=hubpedia&q={b}", true)),
        "research_links_thread" => Some(("/api/client/research/{a}/links?kind=thread&q={b}", true)),
        "research_links_community" => Some(("/api/client/research/{a}/links?kind=community&q={b}", true)),
        "article_save" => Some(("/api/client/articles/{a}/save", true)),
        "video_save" => Some(("/api/client/videos/{a}/save", true)),
        "video_engagement" => Some(("/api/client/videos/{a}/engagement", true)),
        "video_channel" => Some(("/api/client/videos/channels/{a}", true)),
        "video_channel_page" => Some(("/api/client/videos/channels/{a}?cursor={b}", true)),
        "video_posts" => Some(("/api/client/videos/{a}/posts", true)),
        "video_posts_page" => Some(("/api/client/videos/{a}/posts?cursor={b}", true)),
        "music_posts" => Some(("/api/client/music/works/{a}/posts", true)),
        "music_posts_page" => Some(("/api/client/music/works/{a}/posts?cursor={b}", true)),
        "saved_articles_page" => Some(("/api/client/articles/saved?after={a}", true)),
        "video_library_page" => Some(("/api/client/videos/library?cursor={a}", true)),
        "thread" => Some(("/api/client/threads/{a}", true)),
        "thread_knowledge" => Some(("/api/client/threads/{a}/knowledge-platform", true)),
        "thread_knowledge_before" => Some(("/api/client/threads/{a}/knowledge-platform?before={b}", true)),
        // 純粋な公開面
        "article" => Some(("/api/articles/{a}", false)),
        // 記事のいいね数・コメントの公開読み取り。自分が付けているかは端末の資格で読む article_like_me。
        "article_like" => Some(("/api/articles/{a}/like", false)),
        "article_like_me" => Some(("/api/client/articles/{a}/like", true)),
        "article_comments" => Some(("/api/articles/{a}/comments", false)),
        "video" => Some(("/api/client/videos/{a}", false)),
        "music_work" => Some(("/api/client/music/works/{a}", true)),
        "music_share_context" => Some(("/api/client/music/works/{a}/share", true)),
        "hubpedia_article" => Some(("/api/hubpedia/v1/articles/{a}", false)),
        "book" => Some(("/api/books/{a}", false)),
        "book_chapter" => Some(("/api/books/{a}/chapters/{b}", false)),
        "listing" => Some(("/api/listings/{a}", false)),
        // 本人のものだけが返る面——未接続なら窓が「接続が要る」と分かれる。
        "list" => Some(("/api/client/lists/{a}", true)),
        // リストの投稿の流れ（タイムラインのリストのタブ）。本人のリストだけが返る。
        "list_feed" => Some(("/api/lists/{a}/feed", true)),
        // チップの受取先（公開面。ハンドルは英数_のみなので通常区切りで足りる）。
        "tip_recipient" => Some(("/api/tips/recipient?handle={a}", false)),
        _ => None,
    }
}

/// パスの1区切りとして安全な識別子だけを通す。`/`・`?`・`#`・空白・
/// パーセントを含まないので、これを通った値はテンプレートを曲げられない。
fn path_segment(raw: Option<&str>) -> Result<String, String> {
    let id = raw.unwrap_or("").trim();
    if let Some(suffix) = id.strip_prefix("scheduled:") {
        if suffix.len() == 36 && uuid::Uuid::parse_str(suffix).is_ok() { return Ok(id.to_owned()); }
    }
    if !id.is_empty()
        && id.len() <= 128
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        Ok(id.to_owned())
    } else {
        Err("対象の指定が正しくありません".to_owned())
    }
}

// 楽曲の識別子。公開曲は music:<uuid>、それ以外は英数字・_・- の128字まで（Hubの validMusicKey と同じ）。
fn music_work_key(value: &str) -> Result<String,String> {
    let lower=value.to_ascii_lowercase();
    let public=lower.strip_prefix("music:").filter(|v|v.len()==36).and_then(|v|uuid::Uuid::parse_str(v).ok()).is_some_and(|u|(1..=5).contains(&u.get_version_num())&&u.get_variant()==uuid::Variant::RFC4122);
    if !public {discussion_id(Some(value)).map_err(|_|"作品の指定が不正です".to_owned())?;}
    Ok(value.replace(':',"%3A"))
}

fn discussion_id(raw: Option<&str>) -> Result<String,String> {
    raw.filter(|id| !id.is_empty() && id.len()<=128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b,b'-'|b'_'))).map(str::to_owned).ok_or("参照の識別子が不正です".to_owned())
}

fn research_network_origin(raw: &str)->Result<String,String>{
    let url=reqwest::Url::parse(raw).map_err(|_|"接続先HubのURLが不正です")?;
    if raw.len()>512||url.scheme()!="https"||url.host_str().is_none()||!url.username().is_empty()||url.password().is_some()||url.query().is_some()||url.fragment().is_some()||url.origin().ascii_serialization()!=raw{return Err("接続先HubのURLが不正です".to_owned());}Ok(raw.to_owned())
}
pub(crate) fn catalog_product_id(id:&str)->bool {
    !id.is_empty()&&id.encode_utf16().count()<=180&&id!="."&&id!=".."
      &&!id.chars().any(|c|c.is_whitespace()||c.is_control()||matches!(c,'\u{feff}'|'\u{fffd}'|'/'|'\\'|'?'|'#'|'%'|'<'|'>'|'"'|'\''|'`'))
}
/// プロフィールのタブの一覧。テンプレートから (パス, ハンドルを載せるクエリ名) を返す。
fn profile_works_path(template: &str) -> Option<(&'static str, &'static str)> {
    match template {
        "/api/articles?author={a}"|"/api/articles?author={a}&cursor={b}" => Some(("/api/articles","author")),
        "/api/videos?author={a}"|"/api/videos?author={a}&cursor={b}" => Some(("/api/videos","author")),
        "/api/code/repos?owner={a}"|"/api/code/repos?owner={a}&cursor={b}" => Some(("/api/code/repos","owner")),
        _ => None,
    }
}

fn fill_path(template: &'static str, ids: &[String]) -> Result<String, String> {
    if template == "/api/research/discovery" && !ids.is_empty() {
        return Err("識別子の個数が不正です".to_owned());
    }
    if matches!(template,"/api/client/research/{a}/documents/{b}"|"/api/client/research/{a}/documents/{b}/revisions/{c}"|"/api/client/research/{a}/documents/{b}?version={c}")
        && ids.get(1).is_some_and(|id|id.contains('.')) {
        let revision=template.ends_with("/revisions/{c}")||template.contains("?version=");
        if ids.len()!=if revision{3}else{2} { return Err("対象の指定が正しくありません".into()); }
        let project=research_git_project(Some(&ids[0]))?;
        let document=&ids[1];
        if document.is_empty()||document.len()>100||!document.bytes().all(|b|b.is_ascii_alphanumeric()||b"_.-".contains(&b)) { return Err("文書IDが不正です".into()); }
        let mut url=reqwest::Url::parse(&format!("https://hub.invalid/api/client/research/{project}/workspace")).map_err(|_|"対象の指定が正しくありません")?;
        url.query_pairs_mut().append_pair("document",document);
        if revision {
            let version=ids[2].parse::<u64>().ok().filter(|v|*v>0&&*v<=9_007_199_254_740_991&&v.to_string()==ids[2]).ok_or("版が不正です")?;
            url.query_pairs_mut().append_pair("version",&version.to_string());
        }
        return Ok(format!("{}?{}",url.path(),url.query().ok_or("文書IDが不正です")?));
    }

    if matches!(template, "/api/client/thread-posts/{a}/relationship" | "/api/client/thread-posts/{a}/history") {
        return thread_post_control_path(template, ids);
    }
    if template=="/api/research/discovery?kind=music&id={a}" {
        let value=ids.first().filter(|_|ids.len()==1).ok_or("作品の指定が不正です")?;
        fill_path("/api/client/music/works/{a}",ids)?;
        let mut url=reqwest::Url::parse("https://hub.invalid/api/research/discovery?kind=music").map_err(|_|"作品の指定が不正です")?;
        url.query_pairs_mut().append_pair("id",value);
        return Ok(format!("{}?{}",url.path(),url.query().ok_or("作品の指定が不正です")?));
    }
    if template == "/api/client/articles/publication/{a}" {
        let id = ids.first().filter(|_| ids.len() == 3).ok_or("article_publication_invalid_request")?;
        article_publication_scope(&ids[1], &ids[2])?;
        return Ok(format!("/api/client/articles/publication/{}", article_publication_id(Some(id))?));
    }
    if template=="/api/client/communities/{a}/notifications" {
        if ids.len()!=1 {return Err("コミュニティの指定が不正です".into());}
        return Ok(format!("/api/client/communities/{}/notifications",discussion_id(Some(&ids[0]))?));
    }
    if matches!(template,"/api/client/music/works/{a}"|"/api/client/music/works/{a}/share") {
        let value=ids.first().filter(|_|ids.len()==1).ok_or("作品の指定が不正です")?;
        let lower=value.to_ascii_lowercase();
        let public=lower.strip_prefix("music:").filter(|v|v.len()==36).and_then(|v|uuid::Uuid::parse_str(v).ok()).is_some_and(|u|(1..=5).contains(&u.get_version_num())&&u.get_variant()==uuid::Variant::RFC4122);
        if !public {discussion_id(Some(value))?;}
        return Ok(format!("/api/client/music/works/{}{}",value.replace(':',"%3A"),if template.ends_with("/share"){"/share"}else{""}));
    }
    if template=="/api/client/videos/{a}/engagement" {
        if ids.len()!=1 {return Err("動画の指定が不正です".into());}
        return Ok(format!("/api/client/videos/{}/engagement",discussion_id(Some(&ids[0]))?));
    }
    if matches!(template,"/api/client/videos/channels/{a}"|"/api/client/videos/channels/{a}?cursor={b}") {
        let paged=template.contains("{b}");
        if ids.len()!=if paged{2}else{1} {return Err("チャンネルの指定が不正です".into());}
        let handle=&ids[0];
        if handle.is_empty()||handle.len()>64||!handle.bytes().all(|c|c.is_ascii_alphanumeric()||matches!(c,b'_'|b'.'|b'-')){return Err("チャンネルの指定が不正です".into());}
        let path=format!("/api/client/videos/channels/{handle}");
        if !paged {return Ok(path);}
        let cursor=&ids[1];
        if cursor.is_empty()||cursor.len()>256||!cursor.bytes().all(|c|c.is_ascii_alphanumeric()||matches!(c,b'-'|b'_'|b'=')){return Err("ページ指定が不正です".into());}
        return Ok(format!("{path}?cursor={cursor}"));
    }
    if matches!(template,"/api/client/videos/{a}/posts"|"/api/client/videos/{a}/posts?cursor={b}") {
        let paged=template.contains("{b}");
        if ids.len()!=if paged{2}else{1} {return Err("動画の指定が不正です".into());}
        let path=format!("/api/client/videos/{}/posts",discussion_id(Some(&ids[0]))?);
        if !paged {return Ok(path);}
        let cursor=&ids[1];
        if cursor.is_empty()||cursor.len()>256||!cursor.bytes().all(|c|c.is_ascii_alphanumeric()||matches!(c,b'-'|b'_'|b'.'|b'~'|b':'|b'|'|b'=')){return Err("ページ指定が不正です".into());}
        let mut url=reqwest::Url::parse(&format!("https://hub.invalid{path}")).unwrap();
        url.query_pairs_mut().append_pair("cursor",cursor);
        return Ok(format!("{}?{}",url.path(),url.query().unwrap_or("")));
    }
    if matches!(template,"/api/client/music/works/{a}/posts"|"/api/client/music/works/{a}/posts?cursor={b}") {
        let paged=template.contains("{b}");
        if ids.len()!=if paged{2}else{1} {return Err("作品の指定が不正です".into());}
        let path=format!("/api/client/music/works/{}/posts",music_work_key(&ids[0])?);
        if !paged {return Ok(path);}
        let cursor=&ids[1];
        if cursor.is_empty()||cursor.len()>256||!cursor.bytes().all(|c|c.is_ascii_alphanumeric()||matches!(c,b'-'|b'_'|b'.'|b'~'|b':'|b'|'|b'=')){return Err("ページ指定が不正です".into());}
        let mut url=reqwest::Url::parse(&format!("https://hub.invalid{path}")).unwrap();
        url.query_pairs_mut().append_pair("cursor",cursor);
        return Ok(format!("{}?{}",url.path(),url.query().unwrap_or("")));
    }
    if let Some((path,key))=profile_works_path(template) {
        let paged=template.contains("{b}");
        if ids.len()!=if paged{2}else{1} {return Err("プロフィールの指定が正しくありません".into());}
        let handle=&ids[0];
        if handle.is_empty()||handle.len()>64||handle=="."||handle==".."||!handle.bytes().all(|b|b.is_ascii_alphanumeric()||matches!(b,b'_'|b'.'|b'-')) {return Err("プロフィールの指定が正しくありません".into());}
        let mut url=reqwest::Url::parse(&format!("https://hub.invalid{path}")).unwrap();
        url.query_pairs_mut().append_pair(key,handle);
        if paged {
            let cursor=&ids[1];
            if cursor.is_empty()||cursor.len()>400||!cursor.bytes().all(|b|b.is_ascii_alphanumeric()||matches!(b,b'-'|b'_')) {return Err("ページ指定が不正です".into());}
            url.query_pairs_mut().append_pair("cursor",cursor);
        }
        return Ok(format!("{}?{}",url.path(),url.query().unwrap_or("")));
    }
    if template=="/api/client/research/{a}/pdfs" {
        let project=ids.first().filter(|_|ids.len()==1).ok_or("識別子の個数が不正です")?;
        if project.len()<3||project.len()>128||(!project.as_bytes()[0].is_ascii_lowercase()&&!project.as_bytes()[0].is_ascii_digit())||!project.bytes().all(|c|c.is_ascii_lowercase()||c.is_ascii_digit()||c==b'_'||c==b'-'){return Err("プロジェクトの指定が不正です".into());}
        return Ok(format!("/api/client/research/{project}/pdfs"));
    }
    if template=="/api/client/music/library?offset={a}" {
        let raw=ids.first().ok_or("ページ指定が不正です")?;
        let number=raw.parse::<u64>().map_err(|_|"ページ指定が不正です")?;
        if ids.len()!=1||number>9_007_199_254_740_991||raw!=&number.to_string(){return Err("ページ指定が不正です".into());}
        return Ok(format!("/api/client/music/library?offset={number}"));
    }
    if template.contains("/git/proposals") {
        if ids.len()!=if template.contains("{b}"){2}else{1}{return Err("識別子の個数が不正です".to_owned());}
        let project=research_git_project(ids.first().map(String::as_str))?;
        let path=format!("/api/client/research/{project}/git/proposals");
        if !template.contains("{b}"){return Ok(path);}
        let mut url=reqwest::Url::parse(&format!("https://hub.invalid{path}")).unwrap();
        if template.contains("?proposal="){url.query_pairs_mut().append_pair("proposal",&research_git_proposal_id(Some(&ids[1]))?);}
        else {
            if ids[1].len()>256{return Err("ページ指定が不正です".to_owned());}
            let cursor:serde_json::Value=serde_json::from_str(&ids[1]).map_err(|_|"ページ指定が不正です")?;
            let cursor=cursor.as_object().filter(|o|o.len()==2&&o.contains_key("createdAt")&&o.contains_key("id")).ok_or("ページ指定が不正です")?;
            research_git_proposal_id(cursor.get("id").and_then(serde_json::Value::as_str))?;
            let time=cursor.get("createdAt").and_then(serde_json::Value::as_str).ok_or("日時が不正です")?;
            if time.len()!=24||!time.bytes().enumerate().all(|(i,b)|match i {4|7=>b==b'-',10=>b==b'T',13|16=>b==b':',19=>b==b'.',23=>b==b'Z',_=>b.is_ascii_digit()})||chrono::DateTime::parse_from_rfc3339(time).is_err(){return Err("日時が不正です".to_owned());}
            url.query_pairs_mut().append_pair("cursor",&ids[1]);
        }
        return Ok(format!("{}?{}",url.path(),url.query().unwrap_or("")));
    }
    if template=="/api/client/research/{a}/git/browse?commit={b}&base={c}" {
        if ids.len()!=3{return Err("識別子の個数が不正です".to_owned());}
        let p=research_git_project(ids.first().map(String::as_str))?;let head=research_git_oid(Some(&ids[1]))?;let base=research_git_oid(Some(&ids[2]))?;
        if head.len()!=base.len(){return Err("コミット形式が一致しません".to_owned());}return Ok(format!("/api/client/research/{p}/git/browse?commit={head}&base={base}"));
    }
    if template=="/api/client/research/network-fork" {
        if ids.len()!=2{return Err("識別子の個数が不正です".to_owned());}
        let origin=research_network_origin(&ids[0])?;let project=research_git_project(Some(&ids[1]))?;
        let mut url=reqwest::Url::parse("https://hub.invalid/api/client/research/network-fork").unwrap();url.query_pairs_mut().append_pair("origin",&origin).append_pair("projectId",&project);
        return Ok(format!("{}?{}",url.path(),url.query().unwrap_or("")));
    }
    if template.starts_with("/api/client/communities/") && template.contains("/governance/") && ids.len() != if template.contains("{b}") { 2 } else { 1 } {
        return Err("識別子の個数が不正です".to_owned());
    }
    let mut path = template.to_owned();
    for (index, key) in ["{a}", "{b}", "{c}"].iter().enumerate() {
        if path.contains(key) {
            // タグだけは日本語などの自由文字が来る。構造を曲げる記号
            // （/ ? # % \ と空白・制御）は通さず、残りはUTF-8で
            // パーセントエンコードしてからテンプレートへ入れる。
            let id = if template=="/api/client/videos/library?cursor={a}" {
                let cursor=ids.get(index).ok_or("ページ指定がありません")?;
                let (stamp,id)=cursor.split_once('|').ok_or("ページ指定が不正です")?;
                if cursor.len()>153||stamp.len()!=24||!stamp.bytes().all(|c|c.is_ascii_digit()||matches!(c,b'-'|b'T'|b':'|b'.'|b'Z'))||id.trim()!=id||id.is_empty(){return Err("ページ指定が不正です".to_owned());}
                path_segment(Some(id))?;
                reqwest::Url::parse("https://hub.invalid/").unwrap().query_pairs_mut().append_pair("cursor",cursor).finish().query().unwrap().strip_prefix("cursor=").unwrap().to_owned()
            } else if template.starts_with("/api/client/communities/") && template.contains("/governance/") {
                let value=ids.get(index).ok_or("識別子がありません")?;
                if template.contains("?offset=") && index==1 {
                    let n=value.parse::<u64>().ok().filter(|n|*n<=9_007_199_254_740_971&&n.to_string()==*value).ok_or("ページ指定が不正です")?;
                    n.to_string()
                } else {
                    if value.is_empty()||value.len()>100||!value.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-'){return Err("識別子が不正です".to_owned());}
                    value.clone()
                }
            } else if matches!(template,"/api/client/research/{a}/proposals/{b}"|"/api/client/research/{a}/proposals/{b}/discussions") {
                let value=ids.get(index).ok_or("識別子がありません")?;
                if index==0 { research_git_project(Some(value))? } else { research_proposal_uuid(Some(value))? }
            } else if template == "/api/client/research/{a}/fork" {
                research_git_project(ids.get(index).map(String::as_str))?
            } else if template.starts_with("/api/client/research/") && (template.ends_with("/git") || template.ends_with("/git/browse") || template.contains("/git/browse?commit=") || template.contains("/git/discussion?commit=")) {
                let value=ids.get(index).ok_or("識別子がありません")?;
                if index==0 { research_git_project(Some(value))? } else { research_git_oid(Some(value))? }
            } else if template == "/api/client/research/{a}/workspace?discussion={b}&version={c}" && index == 2 {
                let value=ids.get(index).ok_or("版の指定がありません")?;
                let number=value.parse::<u64>().ok().filter(|number| *number>0 && *number<=9_007_199_254_740_991).ok_or("版の指定が正しくありません")?;
                if number.to_string()!=*value{return Err("版の指定が正しくありません".to_owned());}number.to_string()
            } else if template == "/api/client/research/{a}/workspace?discussion={b}&version={c}" {
                discussion_id(ids.get(index).map(String::as_str))?
            } else if template=="/api/client/communities/{a}/access-management?kind={b}&offset={c}" {
                let value=ids.get(index).ok_or("指定がありません")?;
                if index==0 {if value.len()>100||value.is_empty()||!value.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-'){return Err("識別子が不正です".to_owned());}value.clone()}
                else if index==1 {if !["invites","rules","questions"].contains(&value.as_str()){return Err("種類が不正です".to_owned());}value.clone()}
                else {let n=value.parse::<u64>().ok().filter(|n|*n<=9_007_199_254_740_971&&n.to_string()==*value).ok_or("ページ指定が不正です")?;n.to_string()}
            } else if template.starts_with("/api/client/research/") && template.contains("/links?kind=") && index == 1 {
                let value = ids.get(index).ok_or("検索語がありません")?;
                if value.encode_utf16().count() > 100 || value.chars().any(char::is_control) { return Err("検索語が不正です".to_owned()); }
                reqwest::Url::parse("https://hub.invalid/").unwrap().query_pairs_mut().append_pair("q",value).finish().query().unwrap().strip_prefix("q=").unwrap().to_owned()
            } else if ((template == "/api/client/communities/{a}/channels/policy?offset={b}" || template == "/api/client/communities/{a}/membership-requests?offset={b}" || template == "/api/client/communities/{a}/reports?offset={b}" || template == "/api/client/communities/{a}/appeals?offset={b}" || template == "/api/client/communities/{a}/guides?offset={b}&directory={c}" || template == "/api/client/communities/{a}/guides?offset={b}" || template == "/api/client/communities/{a}/guides/proposals?offset={b}") && index == 1)
                || ((template == "/api/client/communities/{a}/guides/{b}/revisions?offset={c}" || template == "/api/client/communities/{a}/guides/proposals/{b}/reviews?offset={c}") && index == 2) {
                let value = ids.get(index).ok_or("ページ指定がありません")?;
                let number = value.parse::<u64>().ok().filter(|number| *number <= 9_007_199_254_740_991).ok_or("ページ指定が正しくありません")?;
                if template=="/api/client/communities/{a}/channels/policy?offset={b}" && number>9_007_199_254_740_971 {return Err("ページ指定が正しくありません".to_owned());}
                if number.to_string() != *value { return Err("ページ指定が正しくありません".to_owned()); }
                number.to_string()
            } else if template == "/api/client/communities/{a}/guides?offset={b}&directory={c}" && index == 2 {
                let value=ids.get(index).ok_or("分類指定がありません")?;
                if value.len()>80 || value.trim()!=value {return Err("分類指定が不正です".to_owned());}
                path_segment(Some(value))?
            } else if template == "/api/client/threads/{a}/knowledge-platform?before={b}" && index == 1 {
                let value = ids.get(index).ok_or("提案のページ指定がありません")?;
                let number = value.parse::<u64>().ok().filter(|number| *number > 0 && *number <= 9_007_199_254_740_991).ok_or("提案のページ指定が正しくありません")?;
                if number.to_string() != *value { return Err("提案のページ指定が正しくありません".to_owned()); }
                number.to_string()
            } else if template.starts_with("/api/client/sidebar/") || template == "/api/client/subscriptions/{a}" {
                let value = ids.get(index).ok_or("指定がありません")?;
                let kinds: &[&str] = if template.starts_with("/api/client/subscriptions/") { &["videos", "music"] } else { &["feed", "videos", "music", "articles"] };
                if ids.len() != if template.contains("{b}") { 2 } else { 1 } { return Err("識別子の個数が不正です".to_owned()); }
                if index == 0 {
                    if !kinds.contains(&value.as_str()) { return Err("種類が不正です".to_owned()); }
                    value.clone()
                } else {
                    if value.is_empty() || value.len() > 200 || !value.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') { return Err("ページ指定が不正です".to_owned()); }
                    value.clone()
                }
            } else if template.starts_with("/api/client/tags/") {
                path_segment_text(ids.get(index).map(String::as_str))?
            } else {
                path_segment(ids.get(index).map(String::as_str))?
            };
            if matches!(template, "/api/client/communities/{a}/reports" | "/api/client/communities/{a}/reports?offset={b}" | "/api/client/communities/{a}/reports/{b}" | "/api/client/communities/{a}/appeals" | "/api/client/communities/{a}/appeals?offset={b}" | "/api/client/communities/{a}/appeals/{b}" | "/api/client/communities/{a}/my-appeals") && id.len() > 80 {
                return Err("識別子が長すぎます".to_owned());
            }
            if template.contains("/channels/policy") && index==0 && id.len()>100{return Err("識別子が長すぎます".to_owned());}
            path = path.replace(key, &id);
        }
    }
    Ok(path)
}

/// 自由文の区切り（タグ名）。識別子より緩いが、URL構造を変える
/// 文字は受けない。通った値はUTF-8のpercent-encodingへ。
fn path_segment_text(raw: Option<&str>) -> Result<String, String> {
    let value = raw.unwrap_or("").trim();
    if value.is_empty()
        || value.chars().count() > 128
        || value.chars().any(|c| {
            matches!(c, '/' | '?' | '#' | '%' | '\\' | '&' | '=') || c.is_control() || c.is_whitespace()
        })
    {
        return Err("対象の指定が正しくありません".to_owned());
    }
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.' | b'~') {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    Ok(out)
}

/// GETしてJSONで受け取る共通部。assertionは添えるだけで必須ではない
/// （個人化が効く面は呼び出し側が添える）。失敗語は窓が状態を分けられる
/// ように固定する。
async fn get_json(url: reqwest::Url, assertion: Option<String>) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|_| "取りに行けません".to_owned())?;
    let mut request = client.get(url);
    if let Some(assertion) = assertion {
        request = request.bearer_auth(assertion);
    }
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            "ハブが応答しません".to_owned()
        } else if error.is_connect() {
            "ハブへ接続できません".to_owned()
        } else {
            "ハブへ届きません".to_owned()
        }
    })?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("見つかりませんでした".to_owned());
    }
    if response.status() == reqwest::StatusCode::FORBIDDEN {
        return Err("このアカウントは停止されているか、権限がありません".to_owned());
    }
    if !response.status().is_success() {
        return Err(format!(
            "ハブが {} を返しています",
            response.status().as_u16()
        ));
    }
    let body = response
        .bytes()
        .await
        .map_err(|_| "受け取れませんでした".to_owned())?;
    if body.len() > MAX_BYTES {
        return Err("応答が大きすぎます".to_owned());
    }
    serde_json::from_slice(&body).map_err(|_| "読めない形で返ってきました".to_owned())
}

/// 詳細面を1件読む。識別子は区切りごとに検証してから固定テンプレートへ
/// 入れる。viewerで変わる面には接続済みならassertionを添える——未接続でも
/// 公開分は読めるので、発行失敗で読めなくはしない。
pub async fn fetch_detail(
    base: &str,
    name: &str,
    ids: &[String],
) -> Result<serde_json::Value, String> {
    if name=="feed_post_request" { return scoped_feed_client::read(base,ids).await; }
    if name=="dm_snapshot" { return scoped_dm_client::read(base,ids).await; }
    if name=="notification_snapshot" { return scoped_social_client::read_notifications(base,ids).await; }
    if name=="research_change_context" { return crate::research_change_file::read(base,ids).await.and_then(|value|serde_json::to_value(value).map_err(|_|"research_change_unknown".into())); }
    if matches!(name,"wallet_tip_settings"|"owned_event_listings"|"owned_event_listing") { return owned_settings::read(base,name,ids).await; }
    let (template, viewer_aware) =
        detail_path(name).ok_or_else(|| "この機能は許可されていません".to_owned())?;
    let path = fill_path(template, ids)?;
    if matches!(name, "thread_post_relationship" | "thread_post_history") {
        return thread_post_control_request(base, &path, reqwest::Method::GET, None, &ids[0], &ids[1], &ids[2], &ids[3],
            name == "thread_post_history", ids.get(4).map(String::as_str), None).await;
    }
    if name == "article_publication" {
        return article_publication_request(base, &path, reqwest::Method::GET, None, &ids[0], &ids[1], &ids[2]).await;
    }
    let url = reqwest::Url::parse(&format!("{}{}", base.trim_end_matches('/'), path))
        .map_err(|_| "ハブの接続先が正しくありません".to_owned())?;
    let assertion = if viewer_aware {
        crate::desktop_account::assertion_if_registered(base)
            .await
            .ok()
            .flatten()
    } else {
        None
    };
    get_json(url, assertion).await
}

/// 端末の窓から来た会話指定をクエリに載せる。識別子の形しか通さない。
fn conversation_query(raw: Option<&str>) -> Option<String> {
    let id = raw?.trim();
    if !id.is_empty()
        && id.len() <= 128
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        Some(id.to_owned())
    } else {
        None
    }
}

pub async fn fetch_client(
    base: &str,
    name: &str,
    conversation: Option<&str>,
) -> Result<serde_json::Value, String> {
    let path = client_path(name).ok_or_else(|| "この機能は許可されていません".to_owned())?;
    let mut url = reqwest::Url::parse(&format!("{}{}", base.trim_end_matches('/'), path))
        .map_err(|_| "ハブの接続先が正しくありません".to_owned())?;
    if let Some(id) = conversation_query(conversation) {
        url.query_pairs_mut().append_pair("conversation", &id);
    }
    let assertion = crate::desktop_account::assertion_if_registered(base)
        .await?
        .ok_or_else(|| "desktop_not_connected".to_owned())?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|_| "取りに行けません".to_owned())?;
    let response = client
        .get(url)
        .bearer_auth(assertion)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "ハブが応答しません".to_owned()
            } else if error.is_connect() {
                "ハブへ接続できません".to_owned()
            } else {
                "ハブへ届きません".to_owned()
            }
        })?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("desktop_not_connected".to_owned());
    }
    if response.status() == reqwest::StatusCode::FORBIDDEN {
        return Err("このアカウントは停止されています".to_owned());
    }
    if !response.status().is_success() {
        return Err(format!(
            "ハブが {} を返しています",
            response.status().as_u16()
        ));
    }
    let body = response
        .bytes()
        .await
        .map_err(|_| "受け取れませんでした".to_owned())?;
    if body.len() > MAX_BYTES {
        return Err("応答が大きすぎます".to_owned());
    }
    serde_json::from_slice(&body).map_err(|_| "読めない形で返ってきました".to_owned())
}

/// 本人のデータへの書き込み（既読化・DM送信・投稿への反応）。読み取りと同じく
/// 宛先は固定表、本文はここで組み立てる——窓から来たJSONをそのまま流すと、
/// 許可した形以外の要求がそのままハブへ届く。
///   action            target        使うもの
///   read_all_notifications  —       POST notifications {readAll:true}
///   read_notification   通知ID      POST notifications {id}
///   read_conversation   会話ID      POST conversations {conversation,markRead}
///   send_message        会話ID      POST conversations {conversation,text,requestId,imageIds?}
///   like / unlike       投稿ID      POST engagements {kind:"like",targetId,active?}
///   bookmark/unbookmark 投稿ID      POST engagements {kind:"bookmark",targetId,active?}
///   repost              投稿ID      POST posts {repostOfTarget*}
///   quote_post          投稿ID      POST posts {body:text,quoteOfTarget*}
///   reply               投稿ID      POST posts {body:text,replyToPostId}
///   create_post         —           POST posts {body:text,clientRequestId,imageIds?,audience?}
///   edit_post           投稿ID      PATCH posts {id,body:text}（自分の投稿のみ）
///   delete_post         投稿ID      DELETE posts {id}（リポスト取消も同じ）
///   thread_reply        スレッドID  POST threads/{id}/posts {body,language,region,languageTag}
///   community_join/leave コミュニティID POST communities/{id}/membership {joined}
///   channel_message     コミュニティID POST communities/{id}/channels/{cid}/messages
///   channel_message_edit/delete/pin/unpin/report 同上 messages/{mid} PATCH/DELETE/POST
///   message_reaction    コミュニティID POST communities/{id}/channels/{cid}/messages/{mid}/reactions
///   follow / unfollow   プロフィールID POST follows {target_profile_id,active}
///   mute/unmute/block/unblock プロフィールID PATCH safety {targetProfileId,action,enabled}
///   report_post/report_profile 対象ID POST reports {targetType,targetId,reason,details}
///   thread_post_edit/delete 投稿ID PATCH/DELETE thread-posts/{id}
///   thread_post_vote/report 投稿ID POST thread-posts/{id}/vote | /report
///   thread_best_answer/follow スレッドID POST threads/{id}/best-answer | /follow
///   create_thread       —           POST threads {board_key,title,body:text,scope…}
///   create_community    —           POST communities {name,description:text,category,visibility}
///   create_article      —           POST articles {title,body:text,summary?,tags}
/// action から宛先と本文を決める。窓の言葉をそのままパスや本文に繋げない。
/// options は各操作が必要とする決まったキーだけをここで取り出す——
/// 窓から来たJSONをそのまま本文に流すことはしない。
///
/// 画像添付（投稿・DM共通）は pending 画像の id だけを通す。
/// 窓からの任意文字列は通さず UUID 形だけ通し、4枚まで。
fn image_id_list(options: Option<&serde_json::Value>) -> Result<Vec<String>, String> {
    let image_ids: Vec<String> = options
        .and_then(|value| value.get("imageIds"))
        .and_then(|value| value.as_array())
        .map(|ids| {
            ids.iter()
                .filter_map(|id| id.as_str())
                .filter(|id| {
                    id.len() == 36
                        && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
                })
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    if image_ids.len() > 4 {
        return Err("画像は4枚までです".to_owned());
    }
    Ok(image_ids)
}

fn research_git_project(raw: Option<&str>) -> Result<String,String> {
    let v=raw.unwrap_or("");
    if v.len()!=35 || !v.starts_with("rp_") || !v[3..].bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return Err("プロジェクトの指定が不正です".to_owned());} Ok(v.to_owned())
}
fn research_git_oid(raw: Option<&str>) -> Result<String,String> {
    let v=raw.unwrap_or("");
    if !matches!(v.len(),40|64) || !v.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return Err("コミットの指定が不正です".to_owned());} Ok(v.to_owned())
}
fn research_proposal_uuid(raw: Option<&str>) -> Result<String,String> {
    let value=raw.unwrap_or("");
    if value.len()!=36 || uuid::Uuid::parse_str(value).is_err(){return Err("変更提案の指定が不正です".to_owned());} Ok(value.to_owned())
}
fn research_git_proposal_id(raw:Option<&str>)->Result<String,String>{let id=research_proposal_uuid(raw)?;if uuid::Uuid::parse_str(&id).map_err(|_|"提案IDが不正です")?.to_string()!=id{return Err("提案IDが不正です".to_owned());}Ok(id)}
fn research_git_proposal_action(action:&str,target:Option<&str>,request_id:Option<&str>,options:Option<&serde_json::Value>)->Result<(reqwest::Method,String,serde_json::Value),String>{
 let p=research_git_project(target)?;let v=options.and_then(serde_json::Value::as_object).ok_or("入力が不正です")?;
 let hash=|key:&str|->Result<String,String>{v.get(key).and_then(serde_json::Value::as_str).filter(|s|s.len()==64&&s.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))).map(str::to_owned).ok_or("確認用ハッシュが不正です".to_owned())};
 let mut body=serde_json::json!({});
 let fields=match action{"research_git_propose"=>vec!["baseOid","headOid","title","summary","comparisonHash"],"research_git_approve"=>vec!["proposalId","snapshot","comparisonHash","fullReviewConfirmed"],"research_git_reject"=>vec!["proposalId","snapshot"],_=>return Err("操作が不正です".to_owned())};
 if v.keys().any(|k|!fields.contains(&k.as_str())){return Err("入力の項目が不正です".to_owned());}
 if action=="research_git_propose" {
  let base=research_git_oid(v.get("baseOid").and_then(serde_json::Value::as_str))?;let head=research_git_oid(v.get("headOid").and_then(serde_json::Value::as_str))?;
  if base==head||base.len()!=head.len(){return Err("異なる二版を指定してください".to_owned());}
  body["action"]="create".into();body["requestId"]=research_git_proposal_id(request_id)?.into();body["baseOid"]=base.into();body["headOid"]=head.into();body["comparisonHash"]=hash("comparisonHash")?.into();
  for(key,max)in[("title",240),("summary",500)]{let text=v.get(key).and_then(serde_json::Value::as_str).filter(|s|!s.trim().is_empty()&&s.encode_utf16().count()<=max&&!s.contains('\0')).ok_or("提案の文字数を確認してください")?;body[key]=text.into();}
 } else {
  if request_id.is_some(){return Err("レビューに作成IDは使えません".to_owned());}
  body["action"]=if action=="research_git_approve"{"approve"}else{"reject"}.into();body["proposalId"]=research_git_proposal_id(v.get("proposalId").and_then(serde_json::Value::as_str))?.into();body["snapshot"]=hash("snapshot")?.into();
  if action=="research_git_approve"{body["comparisonHash"]=hash("comparisonHash")?.into();if let Some(value)=v.get("fullReviewConfirmed"){body["fullReviewConfirmed"]=value.as_bool().ok_or("全体確認の指定が不正です")?.into();}}
 }
 if serde_json::to_vec(&body).map_err(|_|"入力が不正です")?.len()>8192{return Err("入力が大きすぎます".to_owned());}
 Ok((reqwest::Method::POST,format!("/api/client/research/{p}/git/proposals"),body))
}
fn research_git_application_action(
    action: &str,
    target: Option<&str>,
    options: Option<&serde_json::Value>,
) -> Result<(reqwest::Method, String, serde_json::Value), String> {
    let project = research_git_project(target)?;
    let value = options.and_then(serde_json::Value::as_object).ok_or("入力が不正です")?;
    let (kind, fields): (&str, &[&str]) = match action {
        "research_git_application_preview" => ("preview", &["proposalId", "snapshot"]),
        "research_git_application_check" => ("check", &["proposalId", "snapshot", "comparisonHash", "branch"]),
        "research_git_application_apply" => ("apply", &["proposalId", "snapshot", "comparisonHash", "branch", "confirmed"]),
        _ => return Err("操作が不正です".to_owned()),
    };
    if value.len() != fields.len() || value.keys().any(|key| !fields.contains(&key.as_str())) {
        return Err("入力の項目が不正です".to_owned());
    }
    let hash = |key: &str| -> Result<&str, String> {
        value.get(key).and_then(serde_json::Value::as_str)
            .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
            .ok_or("確認用ハッシュが不正です".to_owned())
    };
    let mut body = serde_json::json!({
        "action": kind,
        "proposalId": research_git_proposal_id(value.get("proposalId").and_then(serde_json::Value::as_str))?,
        "snapshot": hash("snapshot")?,
    });
    if kind != "preview" {
        let branch = value.get("branch").and_then(serde_json::Value::as_str)
            .filter(|s| !s.trim().is_empty() && s.len() <= 200 && !s.bytes().any(|b| b <= b' ' || b == 127 || b == b'\\'))
            .ok_or("ブランチの指定が不正です")?;
        body["comparisonHash"] = hash("comparisonHash")?.into();
        body["branch"] = branch.into();
    }
    if kind == "apply" {
        if value.get("confirmed").and_then(serde_json::Value::as_bool) != Some(true) {
            return Err("反映の確認が必要です".to_owned());
        }
        body["confirmed"] = true.into();
    }
    if serde_json::to_vec(&body).map_err(|_| "入力が不正です")?.len() > 2048 {
        return Err("入力が大きすぎます".to_owned());
    }
    Ok((reqwest::Method::POST, format!("/api/client/research/{project}/git/application"), body))
}

fn research_action(action: &str, target: Option<&str>, options: Option<&serde_json::Value>) -> Result<(reqwest::Method, String, serde_json::Value), String> {
    let value = options.ok_or("入力がありません")?;
    let text = |key: &str, max: usize, required: bool| -> Result<String,String> {
        let text = value.get(key).and_then(serde_json::Value::as_str).ok_or("入力が不正です")?;
        if text.encode_utf16().count() > max || (required && text.trim().is_empty()) { return Err("入力の文字数を確認してください".to_owned()); }
        Ok(text.to_owned())
    };
    let id = |key: &str| path_segment(value.get(key).and_then(serde_json::Value::as_str));
    let choice = |key: &str, allowed: &[&str]| -> Result<String,String> { let v=text(key,32,true)?; if allowed.contains(&v.as_str()) {Ok(v)} else {Err("種類が不正です".to_owned())} };
    if matches!(action,"research_proposal_link"|"research_proposal_unlink") {
        let project=research_git_project(target)?;
        let canonical_uuid=|key:&str|->Result<String,String>{let id=research_proposal_uuid(value.get(key).and_then(serde_json::Value::as_str))?;if id!=id.to_ascii_lowercase(){return Err("関連IDが不正です".to_owned());}Ok(id)};
        let proposal=canonical_uuid("proposalId")?;
        let thread=discussion_id(value.get("threadId").and_then(serde_json::Value::as_str))?;
        let body=if action=="research_proposal_link" {
            let expected=if value.get("expectedLinkId")==Some(&serde_json::Value::Null){None}else{Some(canonical_uuid("expectedLinkId")?)};
            serde_json::json!({"action":"link","requestId":canonical_uuid("requestId")?,"threadId":thread,"expectedLinkId":expected})
        }else{serde_json::json!({"action":"unlink","linkId":canonical_uuid("linkId")?,"threadId":thread})};
        return Ok((reqwest::Method::POST,format!("/api/client/research/{project}/proposals/{proposal}/discussions"),body));
    }
    if matches!(action,"research_fork"|"research_network_fork") {
        let project=research_git_project(target)?;
        let request=text("requestId",36,true)?;
        if request.len()!=36 || request!=request.to_ascii_lowercase() || uuid::Uuid::parse_str(&request).is_err(){return Err("操作IDが不正です".to_owned());}
        let hash=text("snapshotHash",71,true)?;
        if hash.len()!=71 || !hash.starts_with("sha256:") || !hash[7..].bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)) || value.get("rightsConfirmed")!=Some(&serde_json::Value::Bool(true)){return Err("内容と利用条件を確認してください".to_owned());}
        if action=="research_network_fork" {let origin=research_network_origin(&text("origin",512,true)?)?;return Ok((reqwest::Method::POST,"/api/client/research/network-fork".to_owned(),serde_json::json!({"origin":origin,"projectId":project,"requestId":request,"snapshotHash":hash,"rightsConfirmed":true})));}
        return Ok((reqwest::Method::POST,format!("/api/client/research/{project}/fork"),serde_json::json!({"requestId":request,"snapshotHash":hash,"rightsConfirmed":true})));
    }
    if action == "research_create_project" {
        let title=text("title",240,true)?;
        if title.trim().encode_utf16().count()<3 {return Err("タイトルは3文字以上です".to_owned());}
        return Ok((reqwest::Method::POST,"/api/client/research".to_owned(),serde_json::json!({"title":title,"description":text("description",5000,false)?,"defaultLicense":text("defaultLicense",200,false)?,"visibility":choice("visibility",&["public","confidential"])?})));
    }
    if action == "research_update_project" {
        let title=text("title",240,true)?;if title.trim().encode_utf16().count()<3{return Err("タイトルは3文字以上です".to_owned());}
        return Ok((reqwest::Method::POST,format!("/api/client/research/{}",path_segment(target)?),serde_json::json!({"title":title,"description":text("description",5000,false)?,"defaultLicense":text("defaultLicense",200,false)?,"status":choice("status",&["draft","active","paused","completed","withdrawn"])?})));
    }
    if action == "research_git_discuss" {
        let project=research_git_project(target)?;
        let oid=research_git_oid(value.get("oid").and_then(serde_json::Value::as_str))?;
        let request=text("requestId",36,true)?;
        if request.len()!=36 || uuid::Uuid::parse_str(&request).is_err(){return Err("操作IDが不正です".to_owned());}
        let (title,body)=(text("title",100,true)?,text("body",4000,true)?);
        if title.trim().encode_utf16().count()<8 || body.trim().encode_utf16().count()<30{return Err("タイトル・本文の文字数を確認してください".to_owned());}
        let source=value.get("source").and_then(serde_json::Value::as_object).ok_or("参照が不正です")?;
        let source_text=|key:&str,max:usize|->Result<String,String>{source.get(key).and_then(serde_json::Value::as_str).filter(|s|!s.is_empty()&&s.encode_utf16().count()<=max&&!s.chars().any(|c|(c as u32)<=31||(c as u32)==127)).map(str::to_owned).ok_or("参照が不正です".to_owned())};
        let (project_title,subject,href)=(source_text("projectTitle",240)?,source_text("subject",240)?,source_text("href",256)?);
        if source.get("projectId").and_then(serde_json::Value::as_str)!=Some(project.as_str()) || source.get("oid").and_then(serde_json::Value::as_str)!=Some(oid.as_str()) || href!=format!("/v2/research/{project}?commit={oid}#git"){return Err("参照が不正です".to_owned());}
        if format!("{}\n\n参照Git: {project_title} / {subject}\n{oid}\n{href}",body.trim()).encode_utf16().count()>4000{return Err("参照を含む本文が長すぎます".to_owned());}
        let output=serde_json::json!({"action":"discuss_git","oid":oid,"requestId":request,"source":{"projectId":project,"projectTitle":project_title,"oid":oid,"subject":subject,"href":href},"title":title,"body":body,"boardKey":discussion_id(value.get("boardKey").and_then(serde_json::Value::as_str))?,"threadType":choice("threadType",&["question","issue","discussion"])?});
        return Ok((reqwest::Method::POST,format!("/api/client/research/{project}/git/discussion"),output));
    }
    let path=format!("/api/client/research/{}/workspace",path_segment(target)?);
    let body=match action {
        "research_discuss" => {
            let (document,project)=(discussion_id(value.get("documentId").and_then(serde_json::Value::as_str))?,discussion_id(target)?);
            let version=value.get("version").and_then(serde_json::Value::as_u64).filter(|n|*n>0&&*n<=9_007_199_254_740_991).ok_or("版が不正です")?;
            let request=text("requestId",36,true)?;
            if request.len()!=36||uuid::Uuid::parse_str(&request).is_err(){return Err("操作IDが不正です".to_owned());}
            let (title,body)=(text("title",100,true)?,text("body",4000,true)?);
            if title.trim().encode_utf16().count()<8||body.trim().encode_utf16().count()<30{return Err("タイトル・本文の文字数を確認してください".to_owned());}
            let source=value.get("source").and_then(serde_json::Value::as_object).ok_or("参照が不正です")?;
            let source_text=|key:&str,max:usize|->Result<String,String>{source.get(key).and_then(serde_json::Value::as_str).filter(|s|!s.is_empty()&&s.encode_utf16().count()<=max).map(str::to_owned).ok_or("参照が不正です".to_owned())};
            let (project_title,document_title,hash,href)=(source_text("projectTitle",240)?,source_text("title",240)?,source_text("contentHash",71)?,source_text("href",1000)?);
            if source.get("projectId").and_then(serde_json::Value::as_str)!=Some(project.as_str())||source.get("documentId").and_then(serde_json::Value::as_str)!=Some(document.as_str())||source.get("version").and_then(serde_json::Value::as_u64)!=Some(version)
                ||hash.len()!=71||!hash.starts_with("sha256:")||!hash[7..].bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))
                ||href!=format!("/v2/research/{project}?document={document}&version={version}"){return Err("参照が不正です".to_owned());}
            let final_body=format!("{}\n\n参照: {project_title} / {document_title} · v{version}\n{hash}\n{href}",body.trim());
            if final_body.encode_utf16().count()>4000{return Err("参照を含む本文が長すぎます".to_owned());}
            serde_json::json!({"action":"discuss","documentId":document,"version":version,"requestId":request,"source":{"projectId":project,"projectTitle":project_title,"documentId":document,"title":document_title,"version":version,"contentHash":hash,"href":href},"title":title,"body":body,"boardKey":discussion_id(value.get("boardKey").and_then(serde_json::Value::as_str))?,"threadType":choice("threadType",&["question","issue","discussion"])?})
        },
        "research_create" => serde_json::json!({"action":"create","title":text("title",240,true)?,"body":text("body",100000,true)?,"kind":choice("kind",&["paper","software","dataset","notebook"])? ,"visibility":choice("visibility",&["public","confidential"])?}),
        "research_propose" => {
            research_git_project(target)?;
            let request=research_proposal_uuid(value.get("requestId").and_then(serde_json::Value::as_str))?;
            if request!=request.to_ascii_lowercase(){return Err("再試行IDが不正です".to_owned());}
            let base=value.get("baseVersion").and_then(serde_json::Value::as_u64).filter(|n|*n>0&&*n<=9007199254740991).ok_or("版が不正です")?;
            let document=value.get("documentId").and_then(serde_json::Value::as_str).filter(|v|!v.is_empty()&&v.len()<=100&&v.bytes().all(|b|b.is_ascii_alphanumeric()||b"_.-".contains(&b))).ok_or("文書IDが不正です")?;
            let mut proposal=serde_json::json!({"action":"propose","requestId":request,"documentId":document,"baseVersion":base,"body":text("body",100000,true)?,"summary":text("summary",500,true)?});
            if let Some(hash)=value.get("expectedBaseHash") {
                let digest=hash.as_str().filter(|v|v.len()==71&&v.starts_with("sha256:")&&v[7..].bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))).ok_or("基準本文のハッシュが不正です")?;
                proposal["expectedBaseHash"]=serde_json::json!(digest);
            }
            proposal
        },
        "research_accept" | "research_reject" => {
            research_git_project(target)?;
            let proposal=research_proposal_uuid(value.get("proposalId").and_then(serde_json::Value::as_str))?;
            let snapshot=value.get("snapshot").and_then(serde_json::Value::as_object).ok_or("比較済みの提案を確認してください")?;
            if snapshot.get("proposalId").and_then(serde_json::Value::as_str)!=Some(proposal.as_str()){return Err("比較済みの提案を確認してください".to_owned());}
            let number=|key:&str|->Result<u64,String>{snapshot.get(key).and_then(serde_json::Value::as_u64).filter(|v|*v>0&&*v<=9_007_199_254_740_991).ok_or("版の指定が不正です".to_owned())};
            let digest=|key:&str|->Result<String,String>{snapshot.get(key).and_then(serde_json::Value::as_str).filter(|v|v.len()==71&&v.starts_with("sha256:")&&v[7..].bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))).map(str::to_owned).ok_or("比較済みの提案を確認してください".to_owned())};
            serde_json::json!({"action":action.strip_prefix("research_").unwrap(),"proposalId":proposal,"snapshot":{"proposalId":proposal,"baseVersion":number("baseVersion")?,"currentHead":number("currentHead")?,"proposalHash":digest("proposalHash")?,"baseHash":digest("baseHash")?}})
        },
        "research_visibility" => serde_json::json!({"action":"visibility","documentId":id("documentId")?,"visibility":choice("visibility",&["public","confidential"])?}),
        "research_link" | "research_unlink" => serde_json::json!({"action":action.strip_prefix("research_").unwrap(),"kind":choice("kind",&["article","video","music","hubpedia","thread","community"])? ,"targetId":text("targetId",1000,true)?}),
        _ => return Err("操作が不正です".to_owned()),
    };
    Ok((reqwest::Method::POST,path,body))
}

fn community_access_action(action:&str,target:Option<&str>,request_id:Option<&str>,options:Option<&serde_json::Value>)->Result<(reqwest::Method,String,serde_json::Value),String>{
    use unicode_normalization::UnicodeNormalization;
    let identifier=|value:Option<&str>|->Result<String,String>{value.filter(|v|!v.is_empty()&&v.len()<=100&&v.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-')).map(str::to_owned).ok_or("識別子が不正です".to_owned())};
    let community=identifier(target)?;
    let operation=request_id.filter(|v|v.len()==36&&v.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)||b==b'-')&&uuid::Uuid::parse_str(v).is_ok()).ok_or("操作IDが不正です")?;
    let values=options.and_then(serde_json::Value::as_object).ok_or("設定内容がありません")?;
    let normalized=|key:&str,max:usize,min:usize|->Result<String,String>{let raw=values.get(key).and_then(serde_json::Value::as_str).filter(|v|v.encode_utf16().count()<=max).ok_or("文字数が不正です")?;let v=raw.nfkc().collect::<String>().trim_matches(|c:char|matches!(c as u32,0x9..=0xd|0x20|0xa0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff)).to_owned();if !(min..=max).contains(&v.encode_utf16().count()){return Err("文字数が不正です".to_owned());}Ok(v)};
    let kind=action.strip_prefix("community_access_").ok_or("操作が不正です")?;
    let mut body=serde_json::json!({"action":kind,"operationId":operation,"note":normalized("note",1000,5)?});
    match kind {
        "create_invite"=>{body["label"]=serde_json::json!(normalized("label",80,0)?);let uses=values.get("maxUses").ok_or("使用上限がありません")?;if !uses.is_null()&&!uses.as_u64().is_some_and(|n|(1..=9_007_199_254_740_991).contains(&n)){return Err("使用上限が不正です".to_owned());}body["maxUses"]=uses.clone();body["expiresInDays"]=serde_json::json!(values.get("expiresInDays").and_then(serde_json::Value::as_u64).filter(|n|(1..=365).contains(n)).ok_or("期限が不正です")?);},
        "create_rule"=>{body["title"]=serde_json::json!(normalized("title",80,1)?);body["body"]=serde_json::json!(normalized("body",1000,1)?);},
        "create_onboarding_question"=>{body["prompt"]=serde_json::json!(normalized("prompt",200,1)?);body["required"]=serde_json::json!(values.get("required").and_then(serde_json::Value::as_bool).ok_or("必須設定が不正です")?);},
        "revoke_invite"|"delete_rule"|"delete_onboarding_question"=>{
            let key=if kind=="revoke_invite"{"inviteId"}else if kind=="delete_rule"{"ruleId"}else{"questionId"};let target_id=identifier(values.get(key).and_then(serde_json::Value::as_str))?;
            let source=values.get("expected").and_then(serde_json::Value::as_object).ok_or("確認済み設定がありません")?;let fields: &[&str]=if kind=="revoke_invite"{&["id","label","maxUses","useCount","expiresAt","revokedAt","createdAt"]}else if kind=="delete_rule"{&["id","title","body","required","position","createdAt","updatedAt"]}else{&["id","prompt","required","position","createdAt"]};
            let mut expected=serde_json::Map::new();for field in fields {let value=source.get(*field).ok_or("確認済み設定が不正です")?;let valid=match *field {
                "id"=>identifier(value.as_str()).is_ok()&&value.as_str()==Some(target_id.as_str()),
                "label"|"title"|"body"|"prompt"=>value.as_str().is_some_and(|s|s.encode_utf16().count()<=if *field=="body"{1000}else if *field=="prompt"{200}else{80}&&(*field=="label"||!s.is_empty())),
                "required"=>value.is_boolean(),"position"|"useCount"=>value.as_u64().is_some_and(|n|n<=9_007_199_254_740_991),"maxUses"=>value.is_null()||value.as_u64().is_some_and(|n|(1..=9_007_199_254_740_991).contains(&n)),
                _=>(matches!(*field,"expiresAt"|"revokedAt")&&value.is_null())||value.as_str().is_some_and(|s|s.encode_utf16().count()<=64&&!s.chars().any(char::is_control)&&chrono::DateTime::parse_from_rfc3339(s).is_ok())
            };if !valid{return Err("確認済み設定が不正です".to_owned());}expected.insert((*field).to_owned(),value.clone());}
            body[key]=serde_json::json!(target_id);body["expected"]=serde_json::Value::Object(expected);
        },_=>return Err("操作が不正です".to_owned())
    }
    if body.to_string().len()>32768{return Err("入力が大きすぎます".to_owned());}
    Ok((reqwest::Method::POST,format!("/api/client/communities/{community}/access-management"),body))
}

fn community_join_action(target: Option<&str>, options: Option<&serde_json::Value>) -> Result<(reqwest::Method, String, serde_json::Value), String> {
    use unicode_normalization::UnicodeNormalization;
    let hex = |value: &str, length: usize| value.len() == length && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    let community = target.filter(|v| !v.is_empty() && v.len() <= 100 && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')).ok_or("コミュニティの指定が不正です")?;
    let input = options.and_then(serde_json::Value::as_object).ok_or("参加内容が不正です")?;
    let modern = input.contains_key("operationId") || input.contains_key("snapshot");
    let keys: &[&str] = if modern { &["operationId", "snapshot", "acceptedRules", "answers"] } else { &["acceptedRules", "answers"] };
    if input.len() != keys.len() || !keys.iter().all(|k| input.contains_key(*k)) { return Err("参加内容が不正です".to_owned()); }
    let accepted = input.get("acceptedRules").and_then(serde_json::Value::as_bool).ok_or("同意の指定が不正です")?;
    if !modern && !accepted { return Err("ルールへの同意が必要です".to_owned()); }
    let items = input.get("answers").and_then(serde_json::Value::as_array).filter(|v| v.len() <= 20).ok_or("回答は20件以内です")?;
    let mut seen = std::collections::HashSet::new();
    let answers = items.iter().map(|item| {
        let fields = item.as_object().filter(|v| v.len() == 2 && v.contains_key("questionId") && v.contains_key("answer")).ok_or("回答の指定が不正です")?;
        let id = fields.get("questionId").and_then(serde_json::Value::as_str).filter(|v| !v.is_empty() && v.len() <= 100 && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')).ok_or("質問の指定が不正です")?;
        if !seen.insert(id) { return Err("質問の指定が重複しています".to_owned()); }
        let raw = fields.get("answer").and_then(serde_json::Value::as_str).filter(|v| v.encode_utf16().count() <= 1000).ok_or("回答は1000文字以内です")?;
        let normalized = raw.nfkc().collect::<String>();
        let answer = normalized.trim_matches(|c: char| matches!(c as u32, 0x9..=0xd | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff));
        if answer.encode_utf16().count() > 1000 { return Err("回答は1000文字以内です".to_owned()); }
        Ok(serde_json::json!({"questionId":id,"answer":answer}))
    }).collect::<Result<Vec<_>,String>>()?;
    let mut body = serde_json::json!({"acceptedRules":accepted,"answers":answers});
    if modern {
        let operation = input.get("operationId").and_then(serde_json::Value::as_str).filter(|v| v.len() == 36 && v.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-') && uuid::Uuid::parse_str(v).is_ok()).ok_or("操作IDが不正です")?;
        let snapshot = input.get("snapshot").and_then(serde_json::Value::as_str).filter(|v| hex(v,64)).ok_or("参加案内を確認してください")?;
        body["operationId"] = serde_json::json!(operation);
        body["snapshot"] = serde_json::json!(snapshot);
    }
    if body.to_string().len() > 98304 { return Err("入力が大きすぎます".to_owned()); }
    Ok((reqwest::Method::POST,format!("/api/client/communities/{community}/onboarding"),body))
}

fn community_invite_action(target: Option<&str>, request_id: Option<&str>, options: Option<&serde_json::Value>) -> Result<(reqwest::Method, String, serde_json::Value), String> {
    use unicode_normalization::UnicodeNormalization;
    let hex = |value: &str, length: usize| value.len() == length && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    let code = target.filter(|v| hex(v, 32)).ok_or("招待コードが不正です")?;
    let operation = request_id.filter(|v| v.len() == 36 && v.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-') && uuid::Uuid::parse_str(v).is_ok()).ok_or("操作IDが不正です")?;
    let input = options.and_then(serde_json::Value::as_object).filter(|v| v.len() == 3 && ["snapshot", "acceptedRules", "answers"].iter().all(|k| v.contains_key(*k))).ok_or("参加内容が不正です")?;
    let snapshot = input.get("snapshot").and_then(serde_json::Value::as_str).filter(|v| hex(v, 64)).ok_or("参加案内を確認してください")?;
    let accepted = input.get("acceptedRules").and_then(serde_json::Value::as_bool).ok_or("同意の指定が不正です")?;
    let items = input.get("answers").and_then(serde_json::Value::as_array).filter(|v| v.len() <= 20).ok_or("回答は20件以内です")?;
    let mut seen = std::collections::HashSet::new();
    let answers = items.iter().map(|item| {
        let fields = item.as_object().filter(|v| v.len() == 2 && v.contains_key("questionId") && v.contains_key("answer")).ok_or("回答の指定が不正です")?;
        let id = fields.get("questionId").and_then(serde_json::Value::as_str).filter(|v| !v.is_empty() && v.len() <= 100 && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')).ok_or("質問の指定が不正です")?;
        if !seen.insert(id) { return Err("質問の指定が重複しています".to_owned()); }
        let raw = fields.get("answer").and_then(serde_json::Value::as_str).filter(|v| v.encode_utf16().count() <= 1000).ok_or("回答は1000文字以内です")?;
        let normalized = raw.nfkc().collect::<String>();
        let answer = normalized.trim_matches(|c: char| matches!(c as u32, 0x9..=0xd | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff));
        if answer.encode_utf16().count() > 1000 { return Err("回答は1000文字以内です".to_owned()); }
        Ok(serde_json::json!({"questionId": id, "answer": answer}))
    }).collect::<Result<Vec<_>, String>>()?;
    let body = serde_json::json!({"operationId": operation, "snapshot": snapshot, "acceptedRules": accepted, "answers": answers});
    if body.to_string().len() > 98304 { return Err("入力が大きすぎます".to_owned()); }
    Ok((reqwest::Method::POST, format!("/api/client/community-invites/{code}"), body))
}

fn community_governance_mutation_action(action: &str, target: Option<&str>, proposal: Option<&str>, options: Option<&serde_json::Value>) -> Result<(reqwest::Method, String, serde_json::Value), String> {
    let id=|s:&str|!s.is_empty()&&s.len()<=100&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-');
    let cid=target.filter(|s|id(s)).ok_or("コミュニティの指定が不正です")?;
    let pid=proposal.filter(|s|id(s)).ok_or("DAO提案の指定が不正です")?;
    let input=options.and_then(serde_json::Value::as_object).ok_or("操作内容がありません")?;
    let vote=action=="community_governance_vote";
    if !vote&&action!="community_governance_lifecycle" {return Err("DAO提案の操作が不正です".to_owned());}
    let field=if vote{"choice"}else{"action"};
    if input.len()!=3||input.keys().any(|k|!["operationId","snapshot",field].contains(&k.as_str())) {return Err("操作の項目が不正です".to_owned());}
    let operation=input.get("operationId").and_then(serde_json::Value::as_str).ok_or("操作IDがありません")?;
    if operation.len()!=36||uuid::Uuid::parse_str(operation).is_err()||!operation.bytes().all(|b|b==b'-'||b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return Err("操作IDが不正です".to_owned());}
    let snapshot=input.get("snapshot").and_then(serde_json::Value::as_str).ok_or("提案の状態を確認してください")?;
    if snapshot.len()!=64||!snapshot.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return Err("確認した提案の状態が不正です".to_owned());}
    let allowed=if vote{&["for","against","abstain"][..]}else{&["start_voting","close_voting","execute","cancel"][..]};
    if input.get(field).and_then(serde_json::Value::as_str).filter(|s|allowed.contains(s)).is_none(){return Err("投票・提案の操作が不正です".to_owned());}
    let body=serde_json::Value::Object(input.clone());
    Ok((if vote{reqwest::Method::POST}else{reqwest::Method::PATCH},format!("/api/client/communities/{cid}/governance/proposals/{pid}{}",if vote{"/votes"}else{""}),body))
}

fn community_governance_create_action(target: Option<&str>, options: Option<&serde_json::Value>) -> Result<(reqwest::Method, String, serde_json::Value), String> {
    let id=|s:&str|!s.is_empty()&&s.len()<=100&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-');
    let cid=target.filter(|s|id(s)).ok_or("コミュニティの指定が不正です")?;
    let input=options.and_then(serde_json::Value::as_object).ok_or("提案内容がありません")?;
    let keys=["operationId","snapshot","kind","title","body","linkedGuideProposalId","votingMethod","decisionScope","executionMode","snapshotPolicy","quorumMemberBps","quorumTokenBps","approvalBps"];
    if input.len()!=keys.len()||input.keys().any(|k|!keys.contains(&k.as_str())){return Err("提案の項目が不正です".to_owned());}
    let operation=input.get("operationId").and_then(serde_json::Value::as_str).ok_or("操作IDがありません")?;
    if operation.len()!=36||uuid::Uuid::parse_str(operation).is_err()||!operation.bytes().all(|b|b==b'-'||b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return Err("操作IDが不正です".to_owned());}
    let snapshot=input.get("snapshot").and_then(serde_json::Value::as_str).ok_or("提案条件を確認してください")?;
    if snapshot.len()!=64||!snapshot.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return Err("提案条件が不正です".to_owned());}
    for (key,min,max) in [("title",5,120),("body",20,4000)] {
        let raw=input.get(key).and_then(serde_json::Value::as_str).ok_or("提案の文章が不正です")?;
        let normalized=raw.trim_matches(|c: char|matches!(c as u32,0x9..=0xd|0x20|0xa0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff));
        if !(min..=max).contains(&normalized.encode_utf16().count()){return Err("タイトル・本文の長さを確認してください".to_owned());}
    }
    let guide=input.get("linkedGuideProposalId").ok_or("編集提案の指定がありません")?;
    if !guide.is_null()&&guide.as_str().filter(|s|id(s)).is_none(){return Err("編集提案の指定が不正です".to_owned());}
    for (key,allowed) in [
        ("kind",&["guide","channel","rule","moderator"][..]),
        ("votingMethod",&["one_member_one_vote","one_holder_one_vote","token_linear","token_sqrt","token_log","dual_chamber"][..]),
        ("decisionScope",&["community","budget","token","project","rules","moderation","hub_policy","security"][..]),
        ("executionMode",&["advisory","operator","timelock","veto"][..]),
        ("snapshotPolicy",&["proposal_start","seven_day_prior","time_weighted"][..]),
    ] {if input.get(key).and_then(serde_json::Value::as_str).filter(|s|allowed.contains(s)).is_none(){return Err("提案の方針が不正です".to_owned());}}
    if matches!(input["decisionScope"].as_str(),Some("hub_policy"|"security"))||(input["kind"]=="moderator"||input["decisionScope"]=="moderation")&&(input["votingMethod"]!="one_member_one_vote"||input["executionMode"]!="advisory"){return Err("この範囲で選択できない投票・実行方式です".to_owned());}
    for key in ["quorumMemberBps","quorumTokenBps","approvalBps"] {
        let min=if key=="approvalBps"{1.0}else{0.0};
        if input.get(key).and_then(serde_json::Value::as_f64).filter(|v|v.is_finite()&&v.fract()==0.0&&*v>=min&&*v<=10000.0).is_none(){return Err("定足数・承認割合が不正です".to_owned());}
    }
    let body=serde_json::Value::Object(input.clone());
    if serde_json::to_vec(&body).map_err(|_|"入力が不正です")?.len()>32768{return Err("入力が大きすぎます".to_owned());}
    Ok((reqwest::Method::POST,format!("/api/client/communities/{cid}/governance/proposals"),body))
}

fn community_governance_settings_action(target: Option<&str>, options: Option<&serde_json::Value>) -> Result<(reqwest::Method, String, serde_json::Value), String> {
    let id=|s:&str|!s.is_empty()&&s.len()<=100&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'_'||b==b'-');
    let cid=target.filter(|s|id(s)).ok_or("コミュニティの指定が不正です")?;
    let input=options.and_then(serde_json::Value::as_object).ok_or("投票設定がありません")?;
    let keys=["operationId","snapshot","votingStrategy","tokenRules","voteWeightCap"];
    if input.len()!=keys.len()||input.keys().any(|k|!keys.contains(&k.as_str())){return Err("投票設定の項目が不正です".to_owned());}
    let operation=input.get("operationId").and_then(serde_json::Value::as_str).ok_or("操作IDがありません")?;
    if operation.len()!=36||uuid::Uuid::parse_str(operation).is_err()||!operation.bytes().all(|b|b==b'-'||b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return Err("操作IDが不正です".to_owned());}
    let snapshot=input.get("snapshot").and_then(serde_json::Value::as_str).ok_or("確認した設定がありません")?;
    if snapshot.len()!=64||!snapshot.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){return Err("確認した設定が不正です".to_owned());}
    let strategy=input.get("votingStrategy").and_then(serde_json::Value::as_str).filter(|s|["one_member_one_vote","token_weighted","token_capped"].contains(s)).ok_or("投票方式が不正です")?;
    let rules=input.get("tokenRules").and_then(serde_json::Value::as_array).filter(|r|r.len()<=100).ok_or("投票トークンは100件以内です")?;
    let mut seen=std::collections::HashSet::new();
    let positive=|v:Option<&serde_json::Value>|v.and_then(serde_json::Value::as_f64).filter(|n|n.is_finite()&&*n>0.0&&*n<=9_007_199_254_740_991.0);
    for rule in rules {
        let r=rule.as_object().filter(|r|r.len()==3&&r.keys().all(|k|["tokenId","tokensPerVote","weight"].contains(&k.as_str()))).ok_or("投票トークンの項目が不正です")?;
        let token=r.get("tokenId").and_then(serde_json::Value::as_str).filter(|s|id(s)).ok_or("トークンの指定が不正です")?;
        if !seen.insert(token)||positive(r.get("tokensPerVote")).is_none()||positive(r.get("weight")).filter(|n|*n<=1000.0).is_none(){return Err("換算量・重み・重複を確認してください".to_owned());}
    }
    let cap=input.get("voteWeightCap").ok_or("票数上限がありません")?;
    let capped=cap.as_f64().filter(|n|n.is_finite()&&*n>=1.0&&*n<=9_007_199_254_740_991.0&&n.fract()==0.0);
    if (strategy=="one_member_one_vote"&&(!rules.is_empty()||!cap.is_null()))||(strategy=="token_weighted"&&(rules.is_empty()||!cap.is_null()))||(strategy=="token_capped"&&(rules.is_empty()||capped.is_none())){return Err("方式に対応するトークンと上限を確認してください".to_owned());}
    let body=serde_json::Value::Object(input.clone());
    if serde_json::to_vec(&body).map_err(|_|"入力が不正です")?.len()>65_536{return Err("入力が大きすぎます".to_owned());}
    Ok((reqwest::Method::PATCH,format!("/api/client/communities/{cid}/governance/settings"),body))
}

fn research_git_management_action(action:&str,target:Option<&str>,request_id:Option<&str>,options:Option<&serde_json::Value>)->Result<(reqwest::Method,String,serde_json::Value),String>{
 let project=research_git_project(target)?;let value=options.and_then(serde_json::Value::as_object).ok_or("入力が不正です")?;
 let snapshot=value.get("snapshot").and_then(serde_json::Value::as_str).filter(|v|v.len()==64&&v.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))).ok_or("確認した設定が不正です")?;
 let mut body=serde_json::json!({"snapshot":snapshot});
 let kind=match action{"research_git_create"=>"create","research_git_visibility"=>"visibility","research_git_revoke"=>"revoke","research_git_token"=>"token",_=>return Err("操作が不正です".to_owned())};body["action"]=kind.into();
 match kind{
 "visibility"=>{let v=value.get("visibility").and_then(serde_json::Value::as_str).filter(|v|matches!(*v,"public"|"confidential")).ok_or("公開範囲が不正です")?;body["visibility"]=v.into();},
 "revoke"=>{let v=research_proposal_uuid(value.get("id").and_then(serde_json::Value::as_str))?;if v!=v.to_ascii_lowercase()||v.as_bytes()[14]!=b'4'||!b"89ab".contains(&v.as_bytes()[19]){return Err("認証情報の指定が不正です".to_owned());}body["id"]=v.into();},
 "token"=>{let v=value.get("scope").and_then(serde_json::Value::as_str).filter(|v|matches!(*v,"read"|"write")).ok_or("権限が不正です")?;let id=research_proposal_uuid(request_id)?;if id!=id.to_ascii_lowercase()||id.as_bytes()[14]!=b'4'||!b"89ab".contains(&id.as_bytes()[19]){return Err("操作IDが不正です".to_owned());}body["scope"]=v.into();body["requestId"]=id.into();},_=>{}
 }Ok((reqwest::Method::POST,format!("/api/client/research/{project}/git"),body))
}

fn video_post_action(target: Option<&str>, options: Option<&serde_json::Value>) -> Result<(reqwest::Method, String, serde_json::Value), String> {
    let raw=target.ok_or("動画の指定がありません")?;
    if raw.trim()!=raw { return Err("動画の指定が不正です".into()); }
    let video=discussion_id(Some(raw))?;
    let values=options.and_then(serde_json::Value::as_object).ok_or("入力が不正です")?;
    if values.keys().any(|key|!matches!(key.as_str(),"body"|"audience"|"inFeed"|"parentPostId"|"playbackSeconds")){return Err("入力項目が不正です".into());}
    // 動画のコメントには本文が要る。上限は通常のポストと同じ500字。
    let text=values.get("body").and_then(serde_json::Value::as_str).ok_or("本文が不正です")?.trim();
    if text.is_empty()||text.chars().count()>500 {return Err("文字数を確認してください".into());}
    let mut body=serde_json::json!({"body":text});
    // フォロワーのフィードにも出すか。省略は「出さない」。
    if let Some(in_feed)=values.get("inFeed").filter(|value|!value.is_null()) {
        body["inFeed"]=in_feed.as_bool().ok_or("フィードへの掲載の指定が不正です")?.into();
    }
    if let Some(parent)=values.get("parentPostId").filter(|value|!value.is_null()) {
        body["parentPostId"]=discussion_id(Some(parent.as_str().ok_or("返信先が不正です")?))?.into();
    }
    if let Some(seconds)=values.get("playbackSeconds").filter(|value|!value.is_null()) {
        let seconds=seconds.as_u64().filter(|value|*value<=604_800).ok_or("再生位置が不正です")?;
        body["playbackSeconds"]=seconds.into();
    }
    if let Some(audience)=values.get("audience").filter(|value|!value.is_null()) {
        let audience=audience.as_str().filter(|value|matches!(*value,"public"|"followers")).ok_or("公開範囲が不正です")?;
        body["audience"]=audience.into();
    }
    Ok((reqwest::Method::POST,format!("/api/client/videos/{video}/posts"),body))
}

fn music_post_action(target: Option<&str>, options: Option<&serde_json::Value>) -> Result<(reqwest::Method, String, serde_json::Value), String> {
    let raw=target.ok_or("作品の指定がありません")?;
    if raw.trim()!=raw { return Err("作品の指定が不正です".into()); }
    let work=music_work_key(raw)?;
    let values=options.and_then(serde_json::Value::as_object).ok_or("入力が不正です")?;
    if values.keys().any(|key|!matches!(key.as_str(),"body"|"audience")){return Err("入力項目が不正です".into());}
    // 本文が空ならリポスト（ハブが曲へのリンクを補う）。上限は通常のポストと同じ500字。
    let text=values.get("body").and_then(serde_json::Value::as_str).ok_or("本文が不正です")?.trim();
    if text.chars().count()>500 {return Err("文字数を確認してください".into());}
    let mut body=serde_json::json!({"body":text});
    if let Some(audience)=values.get("audience").filter(|value|!value.is_null()) {
        let audience=audience.as_str().filter(|value|matches!(*value,"public"|"followers")).ok_or("公開範囲が不正です")?;
        body["audience"]=audience.into();
    }
    Ok((reqwest::Method::POST,format!("/api/client/music/works/{work}/posts"),body))
}

fn parity_action(action: &str, target: Option<&str>, options: Option<&serde_json::Value>) -> Result<(reqwest::Method,String,serde_json::Value),String> {
    let target=target.ok_or("対象がありません")?;
    if target.trim()!=target {return Err("対象が不正です".to_owned());}
    let target=path_segment(Some(target))?;
    if matches!(action,"save_article"|"unsave_article"|"save_video"|"unsave_video") {
        let kind=if action.ends_with("article"){"articles"}else{"videos"};
        return Ok((if action.starts_with("unsave_"){reqwest::Method::DELETE}else{reqwest::Method::POST},format!("/api/client/{kind}/{target}/save"),serde_json::json!({})));
    }
    if matches!(action,"article_like_set"|"article_like_clear") {
        return Ok((if action=="article_like_set"{reqwest::Method::PUT}else{reqwest::Method::DELETE},format!("/api/client/articles/{target}/like"),serde_json::json!({})));
    }
    let v=options.and_then(serde_json::Value::as_object).ok_or("入力が不正です")?;
    let keys=|allowed:&[&str]|->Result<(),String>{if v.len()!=allowed.len()||v.keys().any(|key|!allowed.contains(&key.as_str())){Err("入力項目が不正です".to_owned())}else{Ok(())}};
    let text=|key:&str,max:usize,required:bool|->Result<String,String>{let t=v.get(key).and_then(serde_json::Value::as_str).ok_or("入力が不正です")?;if t.encode_utf16().count()>max||t.chars().any(char::is_control)||(required&&t.trim().is_empty()){return Err("文字数を確認してください".to_owned());}Ok(t.to_owned())};
    if action=="article_comment_create" {keys(&["body"])?;let body=v.get("body").and_then(serde_json::Value::as_str).ok_or("本文が不正です")?.trim();if body.is_empty()||body.encode_utf16().count()>2000||body.chars().any(|c|c.is_control()&&!matches!(c,'\n'|'\t')){return Err("文字数を確認してください".to_owned());}return Ok((reqwest::Method::POST,format!("/api/client/articles/{target}/comments"),serde_json::json!({"body":body})));}
    if action=="thread_read" {keys(&["lastReadPostNo"])?;let n=v.get("lastReadPostNo").and_then(serde_json::Value::as_u64).filter(|n|*n<=9_007_199_254_740_991).ok_or("既読位置が不正です")?;return Ok((reqwest::Method::POST,format!("/api/client/threads/{target}/read"),serde_json::json!({"last_read_post_no":n})));}
    if action=="thread_status" {keys(&["status"])?;let status=text("status",6,true)?;if !["open","closed"].contains(&status.as_str()){return Err("状態が不正です".to_owned());}return Ok((reqwest::Method::POST,format!("/api/client/threads/{target}/status"),serde_json::json!({"status":status})));}
    let id=|key:&str|->Result<String,String>{let id=text(key,128,true)?;if id.len()<3||!id.as_bytes()[0].is_ascii_lowercase()&&!id.as_bytes()[0].is_ascii_digit()||!id.bytes().all(|c|c.is_ascii_lowercase()||c.is_ascii_digit()||matches!(c,b'_'|b'-')){return Err("識別子が不正です".to_owned());}Ok(id)};
    if target.len()<3||!target.as_bytes()[0].is_ascii_lowercase()&&!target.as_bytes()[0].is_ascii_digit()||!target.bytes().all(|c|c.is_ascii_lowercase()||c.is_ascii_digit()||matches!(c,b'_'|b'-')){return Err("プロジェクトIDが不正です".to_owned());}
    if action=="research_register_object" {
        keys(&["objectType","title","version","contentHash","license","visibility"])?;
        let kind=text("objectType",32,true)?;if !["question","hypothesis","claim","evidence","paper","review","software","model","notebook","dataset","experiment_run","protocol","preregistration","replication","license"].contains(&kind.as_str()){return Err("成果の種類が不正です".to_owned());}
        let visibility=text("visibility",16,true)?;if !["public","embargoed","controlled","confidential","restricted"].contains(&visibility.as_str()){return Err("公開範囲が不正です".to_owned());}
        let version=v.get("version").and_then(serde_json::Value::as_u64).filter(|n|*n>0&&*n<=9_007_199_254_740_991).ok_or("版が不正です")?;
        let hash=text("contentHash",71,true)?;if hash.len()!=71||!hash.starts_with("sha256:")||!hash[7..].bytes().all(|c|c.is_ascii_digit()||(b'a'..=b'f').contains(&c)){return Err("ハッシュが不正です".to_owned());}
        return Ok((reqwest::Method::POST,format!("/api/client/research/{target}/objects"),serde_json::json!({"objectType":kind,"title":text("title",240,true)?,"version":version,"contentHash":hash,"license":text("license",200,false)?,"visibility":visibility})));
    }
    if action=="research_register_relation" {keys(&["fromObjectId","toObjectId","relationType"])?;let from=id("fromObjectId")?;let to=id("toObjectId")?;let kind=text("relationType",32,true)?;if from==to||!["supported_by","contradicted_by","replicated_by","supersedes","derived_from","uses_protocol","included_in","reviewed_by"].contains(&kind.as_str()){return Err("成果の関係が不正です".to_owned());}return Ok((reqwest::Method::POST,format!("/api/client/research/{target}/relations"),serde_json::json!({"fromObjectId":from,"toObjectId":to,"relationType":kind})));}
    Err("この機能は許可されていません".to_owned())
}


fn library_action(action:&str,target:Option<&str>,options:Option<&serde_json::Value>)->Result<(reqwest::Method,String,serde_json::Value),String>{
    let invalid=||"入力内容が正しくありません".to_owned();
    if matches!(action,"favorite_music"|"unfavorite_music") {
        if options.is_some(){return Err(invalid());}
        let id=target.ok_or_else(invalid)?;
        let lower=id.to_ascii_lowercase();
        let public=lower.strip_prefix("music:").is_some_and(|v| v.len()==36 && uuid::Uuid::parse_str(v).is_ok() && matches!(v.as_bytes()[14],b'1'..=b'5') && matches!(v.as_bytes()[19],b'8'|b'9'|b'a'|b'b'));
        if public&&action=="favorite_music"&&id!=lower{return Err(invalid());}
        if !public && (id.is_empty()||id.len()>128||!id.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'_'||c==b'-')){return Err(invalid());}
        return Ok((if action=="favorite_music"{reqwest::Method::POST}else{reqwest::Method::DELETE},"/api/client/music/favorites".into(),serde_json::json!({"id":id})));
    }
    if action=="personal_node_device_revoke" {
        if options.is_some(){return Err(invalid());}let id=target.ok_or_else(invalid)?;
        if id.is_empty()||id.len()>160||!id.as_bytes()[0].is_ascii_alphanumeric()||!id.bytes().all(|c|c.is_ascii_alphanumeric()||matches!(c,b'_'|b'-'|b'.'|b':' )){return Err(invalid());}
        let mut url=reqwest::Url::parse("https://placeholder.invalid/api/client/personal-node").unwrap();url.query_pairs_mut().append_pair("deviceId",id);
        return Ok((reqwest::Method::DELETE,format!("{}?{}",url.path(),url.query().unwrap()),serde_json::json!({})));
    }
    let values=options.and_then(serde_json::Value::as_object).ok_or_else(invalid)?;
    if action=="personal_node_relays" {
        if target.is_some()||values.len()!=1{return Err(invalid());}let relays=values.get("relays").and_then(serde_json::Value::as_array).filter(|v|v.len()<=3).ok_or_else(invalid)?;
        let mut normalized=Vec::new();
        for value in relays {let raw=value.as_str().filter(|v|v.len()<=2048).ok_or_else(invalid)?;let url=reqwest::Url::parse(raw).map_err(|_|invalid())?;
            if url.scheme()!="https"||!url.username().is_empty()||url.password().is_some()||url.path()!="/"||url.query().is_some()||url.fragment().is_some()||url.host_str().is_none(){return Err(invalid());}
            let value=url.origin().ascii_serialization();if normalized.contains(&value){return Err(invalid());}normalized.push(value);
        }
        return Ok((reqwest::Method::PUT,"/api/client/personal-node".into(),serde_json::json!({"relays":normalized})));
    }
    let project=target.filter(|id|id.len()>=3&&id.len()<=128&&(id.as_bytes()[0].is_ascii_lowercase()||id.as_bytes()[0].is_ascii_digit())&&id.bytes().all(|c|c.is_ascii_lowercase()||c.is_ascii_digit()||c==b'_'||c==b'-')).ok_or_else(invalid)?;
    let id=values.get("id").and_then(serde_json::Value::as_str).filter(|id|id.len()==36&&uuid::Uuid::parse_str(id).is_ok()&&id.bytes().all(|c|c==b'-'||c.is_ascii_digit()||(b'a'..=b'f').contains(&c))).ok_or_else(invalid)?;
    let body=match action {
        "research_pdf_scan" if values.len()==1=>serde_json::json!({"id":id,"action":"scan"}),
        "research_pdf_visibility" if values.len()==2=>{let visibility=values.get("visibility").and_then(serde_json::Value::as_str).filter(|v|matches!(*v,"public"|"confidential")).ok_or_else(invalid)?;serde_json::json!({"id":id,"action":"visibility","visibility":visibility})},
        _=>return Err(invalid()),
    };
    Ok((reqwest::Method::POST,format!("/api/client/research/{project}/pdfs"),body))
}


fn is_playlist_action(action: &str) -> bool {
    matches!(action,"create_video_playlist"|"update_video_playlist"|"delete_video_playlist"|"add_video_playlist_item"|"remove_video_playlist_item"|"create_music_playlist"|"update_music_playlist"|"delete_music_playlist"|"set_music_playlist_items")
}
fn playlist_action(action: &str, target: Option<&str>, options: Option<&serde_json::Value>) -> Result<(reqwest::Method, String, serde_json::Value), String> {
    use unicode_normalization::UnicodeNormalization;
    let invalid = || "プレイリストの入力を確認してください".to_owned();
    let id = |v: &str| !v.is_empty() && v.len() <= 128 && v.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'));
    let music = action.contains("music_playlist");
    let base = if music { "/api/client/music/playlists" } else { "/api/client/videos/playlists" };
    let create = matches!(action, "create_video_playlist" | "create_music_playlist");
    let path = if create {
        if target.is_some() { return Err(invalid()); } base.to_owned()
    } else { format!("{base}/{}", target.filter(|v| id(v)).ok_or_else(invalid)?) };
    let values = options.and_then(serde_json::Value::as_object).ok_or_else(invalid)?;
    match action {
        "create_video_playlist" | "create_music_playlist" | "update_video_playlist" | "update_music_playlist" => {
            if !values.contains_key("title") || values.keys().any(|key| key != "title" && key != "description") { return Err(invalid()); }
            let text = |key: &str, max: usize, required: bool| -> Result<String, String> {
                let raw = match values.get(key) { None if !required => "", Some(v) => v.as_str().ok_or_else(invalid)?, _ => return Err(invalid()) };
                if raw.len() > 128 * 1024 { return Err(invalid()); }
                let normalized = raw.nfkc().collect::<String>();
                let value = normalized.split(search_space).filter(|s|!s.is_empty()).collect::<Vec<_>>().join(" ");
                if (required && value.is_empty()) || value.encode_utf16().count() > max || value.chars().any(char::is_control) { return Err(invalid()); }
                Ok(value.to_owned())
            };
            Ok((if create { reqwest::Method::POST } else { reqwest::Method::PATCH }, path, serde_json::json!({"title":text("title",80,true)?,"description":text("description",500,false)?})))
        }
        "delete_video_playlist" | "delete_music_playlist" if values.is_empty() => Ok((reqwest::Method::DELETE, path, serde_json::json!({}))),
        "add_video_playlist_item" | "remove_video_playlist_item" if values.len() == 1 => {
            let video = values.get("videoId").and_then(serde_json::Value::as_str).filter(|v| id(v)).ok_or_else(invalid)?;
            Ok((if action == "add_video_playlist_item" { reqwest::Method::POST } else { reqwest::Method::DELETE }, format!("{path}/items/{video}"), serde_json::json!({})))
        }
        "set_music_playlist_items" if values.len() == 1 => {
            let items = values.get("workIds").and_then(serde_json::Value::as_array).filter(|v| v.len() <= 200).ok_or_else(invalid)?;
            let mut unique = std::collections::HashSet::new();
            for item in items {
                let value = item.as_str().ok_or_else(invalid)?;
                let lower=value.to_ascii_lowercase();
                let public = lower.strip_prefix("music:").and_then(|v| uuid::Uuid::parse_str(v).ok()).is_some_and(|u| {
                    value.len() == 42 && (1..=5).contains(&u.get_version_num()) && u.get_variant() == uuid::Variant::RFC4122
                });
                if !(id(value) || public) || !unique.insert(value) { return Err(invalid()); }
            }
            Ok((reqwest::Method::PUT, format!("{path}/items"), serde_json::json!({"workIds":items})))
        }
        _ => Err(invalid()),
    }
}

fn community_preferences_action(action: &str, target: Option<&str>, options: Option<&serde_json::Value>) -> Result<(reqwest::Method, String, serde_json::Value), String> {
    let invalid=|| "コミュニティ設定の入力を確認してください".to_owned();
    let community=discussion_id(target)?;
    let values=options.and_then(serde_json::Value::as_object).ok_or_else(invalid)?;
    if action=="read_all_community_channels" {
        if !values.is_empty() {return Err(invalid());}
        return Ok((reqwest::Method::POST,format!("/api/client/communities/{community}/read-all"),serde_json::json!({})));
    }
    let keys=["mentions","replies","guideUpdates","governance","membership"];
    if action!="update_community_notifications" || values.len()!=6 || !values.contains_key("channels") || keys.iter().any(|key|!values.contains_key(*key)) {return Err(invalid());}
    let mut body=serde_json::Map::new();
    for key in keys {body.insert(key.into(),serde_json::json!(values[key].as_bool().ok_or_else(invalid)?));}
    let channels=values["channels"].as_array().filter(|v|v.len()<=100).ok_or_else(invalid)?;
    let mut unique=std::collections::HashSet::new();
    let channels=channels.iter().map(|value| {
        let value=value.as_object().filter(|v|v.len()==2&&v.contains_key("channelId")&&v.contains_key("mode")).ok_or_else(invalid)?;
        let id=discussion_id(value["channelId"].as_str())?;
        if !unique.insert(id.clone()) {return Err(invalid());}
        let mode=value["mode"].as_str().filter(|v|matches!(*v,"all"|"mentions"|"none")).ok_or_else(invalid)?;
        Ok(serde_json::json!({"channelId":id,"mode":mode}))
    }).collect::<Result<Vec<_>,String>>()?;
    body.insert("channels".into(),serde_json::json!(channels));
    Ok((reqwest::Method::PATCH,format!("/api/client/communities/{community}/notifications"),serde_json::Value::Object(body)))
}

const ARTICLE_PUBLICATION_MAX_REQUEST_BYTES: usize = 768 * 1024;
const ARTICLE_PUBLICATION_MAX_RECEIPT_BYTES: usize = 64 * 1024;
const ARTICLE_PUBLICATION_UNKNOWN: &str = "article_publication_unknown";

fn article_publication_id(raw: Option<&str>) -> Result<String, String> {
    let raw = raw.ok_or("article_publication_invalid_request")?;
    uuid::Uuid::parse_str(raw).ok().filter(|id| id.get_version_num() == 4
        && id.get_variant() == uuid::Variant::RFC4122 && id.to_string() == raw)
        .map(|_| raw.to_owned()).ok_or("article_publication_invalid_request".into())
}

// ECMAScript trim: Rust White_Space differs for NEL and BOM.
fn article_publication_trim(value: &str) -> &str {
    value.trim_matches(|c: char| (c.is_whitespace() && c != '\u{0085}') || c == '\u{feff}')
}

fn article_publication_scope(device: &str, origin: &str) -> Result<(), String> {
    if device.is_empty() || device.len() > 128 || !device.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')) {
        return Err("article_publication_invalid_request".into());
    }
    let url = reqwest::Url::parse(origin).map_err(|_| "article_publication_invalid_request")?;
    if origin.len() > 512 || url.origin().ascii_serialization() != origin || !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err("article_publication_invalid_request".into());
    }
    Ok(())
}

fn require_article_publication_owner(base: &str, device: &str, expected_origin: &str) -> Result<(), String> {
    article_publication_scope(device, expected_origin)?;
    if reqwest::Url::parse(base).map_err(|_| "account_changed")?.origin().ascii_serialization() != expected_origin {
        return Err("account_changed".into());
    }
    crate::hub_network::require_source_owner(base, device).map_err(|error|
        if error == "account_required" { "desktop_not_connected".into() } else { "account_changed".into() })
}

fn article_publication_bytes(value: &serde_json::Value) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec(value).map_err(|_| "article_publication_invalid_request")?;
    if bytes.len() > ARTICLE_PUBLICATION_MAX_REQUEST_BYTES { return Err("article_publication_request_too_large".into()); }
    Ok(bytes)
}

fn article_publication_action(target: Option<&str>, text: Option<&str>, request_id: Option<&str>,
    options: Option<&serde_json::Value>) -> Result<(reqwest::Method, String, serde_json::Value), String> {
    if target.is_some() { return Err("article_publication_invalid_request".into()); }
    let request_id = article_publication_id(request_id)?;
    let options = options.and_then(serde_json::Value::as_object).ok_or("article_publication_invalid_request")?;
    if options.keys().any(|key| !matches!(key.as_str(), "title" | "summary" | "tags" | "expectedDeviceId" | "expectedOrigin")) {
        return Err("article_publication_invalid_request".into());
    }
    article_publication_scope(options.get("expectedDeviceId").and_then(serde_json::Value::as_str).ok_or("article_publication_invalid_request")?,
        options.get("expectedOrigin").and_then(serde_json::Value::as_str).ok_or("article_publication_invalid_request")?)?;
    let text = text.ok_or("article_publication_invalid_request")?;
    article_publication_bytes(&serde_json::json!({"text":text,"options":options,"requestId":request_id}))?;
    let field = |key: &str, max: usize, required: bool| -> Result<String, String> {
        let raw = match options.get(key) {
            Some(value) => value.as_str().ok_or("article_publication_invalid_request")?,
            None if !required => "",
            None => return Err("article_publication_invalid_request".into()),
        };
        let normalized = article_publication_trim(raw);
        if raw.contains('\0') || normalized.chars().count() > max || (required && normalized.is_empty()) {
            return Err("article_publication_invalid_request".into());
        }
        Ok(normalized.into())
    };
    let title = field("title", 120, true)?;
    let summary = field("summary", 400, false)?;
    let body = text.replace("\r\n", "\n");
    let body = article_publication_trim(&body);
    if text.contains('\0') || body.is_empty() || body.chars().count() > 100_000 {
        return Err("article_publication_invalid_request".into());
    }
    let tags = match options.get("tags") {
        None => Vec::new(),
        Some(value) => {
            let raw = value.as_str().filter(|raw| !raw.contains('\0')).ok_or("article_publication_invalid_request")?;
            raw.split(',').map(article_publication_trim).filter(|tag| !tag.is_empty())
                .try_fold(Vec::<&str>::new(), |mut tags, tag| {
                    if tag.encode_utf16().count() > 24 { return Err("article_publication_invalid_request"); }
                    if !tags.contains(&tag) {
                        if tags.len() == 8 { return Err("article_publication_invalid_request"); }
                        tags.push(tag);
                    }
                    Ok(tags)
                })?
        }
    };
    let body = serde_json::json!({"title":title,"body":body,"summary":summary,"tags":tags,
        "audience":"general","access":"public","clientRequestId":request_id});
    article_publication_bytes(&body)?;
    Ok((reqwest::Method::POST, "/api/client/articles".into(), body))
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArticlePublicationReceipt { id: String, href: String, duplicate: bool, client_request_id: String }
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArticlePublicationLookup { found: bool, client_request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")] id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] href: Option<String> }

fn article_publication_receipt(bytes: &[u8], request_id: &str, lookup: bool, status: u16) -> Result<serde_json::Value, String> {
    let unknown = || ARTICLE_PUBLICATION_UNKNOWN.to_owned();
    if bytes.len() > ARTICLE_PUBLICATION_MAX_RECEIPT_BYTES { return Err(unknown()); }
    let valid_article = |id: &str, href: &str| article_publication_id(Some(id)).is_ok() && href == format!("/articles/{id}");
    if lookup {
        let receipt: ArticlePublicationLookup = serde_json::from_slice(bytes).map_err(|_| unknown())?;
        let fields = serde_json::from_slice::<serde_json::Value>(bytes).map_err(|_| unknown())?;
        if status != 200 || receipt.client_request_id != request_id
            || fields.as_object().is_none_or(|fields| fields.len() != if receipt.found { 4 } else { 2 })
            || (receipt.found && !receipt.id.as_deref().zip(receipt.href.as_deref()).is_some_and(|(id, href)| valid_article(id, href)))
            || (!receipt.found && (receipt.id.is_some() || receipt.href.is_some())) { return Err(unknown()); }
        serde_json::to_value(receipt).map_err(|_| unknown())
    } else {
        let receipt: ArticlePublicationReceipt = serde_json::from_slice(bytes).map_err(|_| unknown())?;
        if receipt.client_request_id != request_id || !valid_article(&receipt.id, &receipt.href)
            || status != if receipt.duplicate { 200 } else { 201 } { return Err(unknown()); }
        serde_json::to_value(receipt).map_err(|_| unknown())
    }
}

fn article_publication_status(status: u16) -> Result<(), String> {
    match status {
        200 | 201 => Ok(()),
        401 => Err("desktop_not_connected".into()),
        409 => Err("article_publication_conflict".into()),
        400 | 403 | 413 | 429 => Err(format!("article_publication_rejected:{status}")),
        _ => Err(ARTICLE_PUBLICATION_UNKNOWN.into()),
    }
}

async fn article_publication_request(base: &str, path: &str, method: reqwest::Method,
    body: Option<&serde_json::Value>, request_id: &str, device: &str, expected_origin: &str) -> Result<serde_json::Value, String> {
    let lookup = method == reqwest::Method::GET;
    require_article_publication_owner(base, device, expected_origin)?;
    let origin = reqwest::Url::parse(base).map_err(|_| ARTICLE_PUBLICATION_UNKNOWN)?.origin().ascii_serialization();
    let url = reqwest::Url::parse(&format!("{}{}", base.trim_end_matches('/'), path)).map_err(|_| ARTICLE_PUBLICATION_UNKNOWN)?;
    let assertion = crate::desktop_account::assertion_if_registered(base).await;
    require_article_publication_owner(base, device, expected_origin)?;
    let assertion = assertion.map_err(|error| if matches!(error.as_str(), "desktop_account_signed_out"
        | "desktop_account_not_registered" | "desktop_account_unauthorized" | "desktop_account_key_invalid") {
        "desktop_not_connected"
    } else { ARTICLE_PUBLICATION_UNKNOWN })?.ok_or("desktop_not_connected")?;
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|_| ARTICLE_PUBLICATION_UNKNOWN)?;
    let mut request = client.request(method, url).bearer_auth(assertion).header(reqwest::header::ORIGIN, origin);
    if let Some(body) = body { request = request.header(reqwest::header::CONTENT_TYPE, "application/json").body(article_publication_bytes(body)?); }
    let mut response = request.send().await.map_err(|_| ARTICLE_PUBLICATION_UNKNOWN)?;
    require_article_publication_owner(base, device, expected_origin)?;
    let status = response.status().as_u16();
    article_publication_status(status)?;
    if !git_application_json_mime(response.headers()) { return Err(ARTICLE_PUBLICATION_UNKNOWN.into()); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ARTICLE_PUBLICATION_UNKNOWN)? {
        if chunk.len() > ARTICLE_PUBLICATION_MAX_RECEIPT_BYTES.saturating_sub(bytes.len()) { return Err(ARTICLE_PUBLICATION_UNKNOWN.into()); }
        bytes.extend_from_slice(&chunk);
    }
    require_article_publication_owner(base, device, expected_origin)?;
    article_publication_receipt(&bytes, request_id, lookup, status)
}

const THREAD_POST_CONTROL_INVALID: &str = "thread_post_action_invalid_request";
const THREAD_POST_CONTROL_UNKNOWN: &str = "thread_post_action_unknown";
const THREAD_POST_CONTROL_MAX_BYTES: usize = 1024 * 1024;

fn thread_post_control_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn thread_post_control_scope(device: &str, origin: &str, viewer: &str) -> Result<(), String> {
    if !thread_post_control_id(viewer) { return Err(THREAD_POST_CONTROL_INVALID.into()); }
    article_publication_scope(device, origin).map_err(|_| THREAD_POST_CONTROL_INVALID.into())
}

fn thread_post_history_date(value: &str) -> bool {
    !value.is_empty() && value.encode_utf16().count() <= 64 && !value.chars().any(char::is_control)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThreadPostHistoryCursor { post_id: String, created_at: String, id: String }

fn thread_post_history_cursor(raw: &str, post_id: &str) -> Result<ThreadPostHistoryCursor, String> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    if raw.is_empty() || raw.len() > 512 { return Err(THREAD_POST_CONTROL_INVALID.into()); }
    let bytes = URL_SAFE_NO_PAD.decode(raw).map_err(|_| THREAD_POST_CONTROL_INVALID)?;
    if URL_SAFE_NO_PAD.encode(&bytes) != raw { return Err(THREAD_POST_CONTROL_INVALID.into()); }
    let cursor: ThreadPostHistoryCursor = serde_json::from_slice(&bytes).map_err(|_| THREAD_POST_CONTROL_INVALID)?;
    if cursor.post_id != post_id || !thread_post_control_id(&cursor.id) || !thread_post_history_date(&cursor.created_at) {
        return Err(THREAD_POST_CONTROL_INVALID.into());
    }
    Ok(cursor)
}

fn thread_post_control_path(template: &str, ids: &[String]) -> Result<String, String> {
    let history = template == "/api/client/thread-posts/{a}/history";
    if ids.len() != 4 && !(history && ids.len() == 5) { return Err(THREAD_POST_CONTROL_INVALID.into()); }
    if !thread_post_control_id(&ids[0]) { return Err(THREAD_POST_CONTROL_INVALID.into()); }
    thread_post_control_scope(&ids[1], &ids[2], &ids[3])?;
    let path = format!("/api/client/thread-posts/{}/{}", ids[0], if history { "history" } else { "relationship" });
    if let Some(cursor) = ids.get(4) {
        thread_post_history_cursor(cursor, &ids[0])?;
        let mut url = reqwest::Url::parse(&format!("https://hub.invalid{path}")).map_err(|_| THREAD_POST_CONTROL_INVALID)?;
        url.query_pairs_mut().append_pair("after", cursor);
        return Ok(format!("{}?{}", url.path(), url.query().ok_or(THREAD_POST_CONTROL_INVALID)?));
    }
    Ok(path)
}

fn thread_post_control_action(target: Option<&str>, text: Option<&str>, request_id: Option<&str>,
    options: Option<&serde_json::Value>) -> Result<(reqwest::Method, String, serde_json::Value), String> {
    let post = target.filter(|post| thread_post_control_id(post)).ok_or(THREAD_POST_CONTROL_INVALID)?;
    if text.is_some() || request_id.is_some() { return Err(THREAD_POST_CONTROL_INVALID.into()); }
    let options = options.and_then(serde_json::Value::as_object).ok_or(THREAD_POST_CONTROL_INVALID)?;
    let keys = ["kind", "enabled", "expectedDeviceId", "expectedOrigin", "expectedViewerId"];
    if options.len() != keys.len() || options.keys().any(|key| !keys.contains(&key.as_str())) { return Err(THREAD_POST_CONTROL_INVALID.into()); }
    let string = |key: &str| options.get(key).and_then(serde_json::Value::as_str).ok_or(THREAD_POST_CONTROL_INVALID);
    let kind = string("kind")?;
    if !matches!(kind, "mute" | "block") { return Err(THREAD_POST_CONTROL_INVALID.into()); }
    let enabled = options.get("enabled").and_then(serde_json::Value::as_bool).ok_or(THREAD_POST_CONTROL_INVALID)?;
    thread_post_control_scope(string("expectedDeviceId")?, string("expectedOrigin")?, string("expectedViewerId")?)?;
    Ok((reqwest::Method::PUT, format!("/api/client/thread-posts/{post}/relationship"), serde_json::json!({"kind":kind,"enabled":enabled})))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ThreadPostControl { muted: bool, blocked: bool }
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThreadPostControlReceipt { viewer_id: String, post_id: String, control: ThreadPostControl }
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThreadPostHistoryRevision { id: String, post_id: String, body: String, created_at: String, edit_reason: String }
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThreadPostHistoryReceipt { viewer_id: String, post_id: String, revisions: Vec<ThreadPostHistoryRevision>, next_cursor: serde_json::Value }

fn thread_post_control_receipt(bytes: &[u8], post: &str, viewer: &str, history: bool,
    cursor: Option<&str>, desired: Option<(&str, bool)>) -> Result<serde_json::Value, String> {
    let unknown = || THREAD_POST_CONTROL_UNKNOWN.to_owned();
    if bytes.len() > THREAD_POST_CONTROL_MAX_BYTES { return Err(unknown()); }
    if !history {
        let receipt: ThreadPostControlReceipt = serde_json::from_slice(bytes).map_err(|_| unknown())?;
        if receipt.post_id != post || receipt.viewer_id != viewer || desired.is_some_and(|(kind, enabled)|
            match kind { "mute" => receipt.control.muted != enabled, "block" => receipt.control.blocked != enabled, _ => true }) { return Err(unknown()); }
        return serde_json::to_value(receipt).map_err(|_| unknown());
    }
    let receipt: ThreadPostHistoryReceipt = serde_json::from_slice(bytes).map_err(|_| unknown())?;
    let before = cursor.map(|raw| thread_post_history_cursor(raw, post)).transpose().map_err(|_| unknown())?;
    let mut ids = std::collections::HashSet::new();
    if receipt.post_id != post || receipt.viewer_id != viewer || receipt.revisions.len() > 5
        || receipt.revisions.iter().any(|revision| !thread_post_control_id(&revision.id) || !ids.insert(&revision.id)
            || revision.post_id != post || !thread_post_history_date(&revision.created_at)
            || revision.body.chars().count() > 20_000 || revision.body.encode_utf16().count() > 40_000 || revision.body.contains('\0')
            || revision.edit_reason.chars().count() > 300 || revision.edit_reason.encode_utf16().count() > 600 || revision.edit_reason.contains('\0')
            || before.as_ref().is_some_and(|before| (revision.created_at.as_str(), revision.id.as_str()) >= (before.created_at.as_str(), before.id.as_str())))
        || receipt.revisions.windows(2).any(|rows| (rows[0].created_at.as_str(), rows[0].id.as_str()) <= (rows[1].created_at.as_str(), rows[1].id.as_str())) {
        return Err(unknown());
    }
    if !receipt.next_cursor.is_null() {
        let raw = receipt.next_cursor.as_str().ok_or_else(unknown)?;
        let next = thread_post_history_cursor(raw, post).map_err(|_| unknown())?;
        if !receipt.revisions.last().is_some_and(|last| next.created_at == last.created_at && next.id == last.id)
            || cursor == Some(raw) { return Err(unknown()); }
    }
    serde_json::to_value(receipt).map_err(|_| unknown())
}

fn thread_post_control_status(status: u16) -> Result<(), String> {
    match status {
        200 => Ok(()), 401 => Err("desktop_not_connected".into()),
        400 | 403 | 404 | 409 | 413 | 429 => Err(format!("thread_post_action_rejected:{status}")),
        _ => Err(THREAD_POST_CONTROL_UNKNOWN.into()),
    }
}

#[allow(clippy::too_many_arguments)]
async fn thread_post_control_request(base: &str, path: &str, method: reqwest::Method, body: Option<&serde_json::Value>,
    post: &str, device: &str, expected_origin: &str, viewer: &str, history: bool, cursor: Option<&str>,
    desired: Option<(&str, bool)>) -> Result<serde_json::Value, String> {
    thread_post_control_scope(device, expected_origin, viewer)?;
    require_article_publication_owner(base, device, expected_origin)?;
    let assertion = crate::desktop_account::assertion_if_registered(base).await;
    require_article_publication_owner(base, device, expected_origin)?;
    let assertion = assertion.map_err(|_| THREAD_POST_CONTROL_UNKNOWN)?.ok_or("desktop_not_connected")?;
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|_| THREAD_POST_CONTROL_UNKNOWN)?;
    let url = reqwest::Url::parse(&format!("{}{}", base.trim_end_matches('/'), path)).map_err(|_| THREAD_POST_CONTROL_UNKNOWN)?;
    let mut request = client.request(method, url).bearer_auth(assertion).header(reqwest::header::ORIGIN, expected_origin);
    if let Some(body) = body { request = request.json(body); }
    let mut response = request.send().await.map_err(|_| THREAD_POST_CONTROL_UNKNOWN)?;
    require_article_publication_owner(base, device, expected_origin)?;
    thread_post_control_status(response.status().as_u16())?;
    if !git_application_json_mime(response.headers()) { return Err(THREAD_POST_CONTROL_UNKNOWN.into()); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| THREAD_POST_CONTROL_UNKNOWN)? {
        if chunk.len() > THREAD_POST_CONTROL_MAX_BYTES.saturating_sub(bytes.len()) { return Err(THREAD_POST_CONTROL_UNKNOWN.into()); }
        bytes.extend_from_slice(&chunk);
    }
    require_article_publication_owner(base, device, expected_origin)?;
    thread_post_control_receipt(&bytes, post, viewer, history, cursor, desired)
}

/// 他のハブの人を @名前@ハブ でフォローする。窓から来る文字列は handle だけで、
/// ここで形を絞る（`@` で始まってよい・`名前@ホスト`・パスやクエリの文字は通さない）。
/// 宛先は固定、相手の解決（WebFinger）と Follow の送信はハブと連合サービスが行う。
fn remote_follow_action(options: Option<&serde_json::Value>) -> Result<(reqwest::Method, String, serde_json::Value), String> {
    let handle = options
        .and_then(|value| value.get("handle"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .map(|value| value.strip_prefix('@').unwrap_or(value))
        .ok_or("ユーザー名は @名前@ホスト の形で入力してください")?;
    let valid = handle.len() <= 320
        && handle.split_once('@').is_some_and(|(name, host)| {
            !host.contains('@')
                && (1..=64).contains(&name.len())
                && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
                && (3..=255).contains(&host.len())
                && host.contains('.')
                && host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
                && !host.starts_with(['.', '-', ':'])
        });
    if !valid {
        return Err("ユーザー名は @名前@ホスト の形で入力してください".to_owned());
    }
    Ok((
        reqwest::Method::POST,
        "/api/client/federation/follows".to_owned(),
        serde_json::json!({ "handle": format!("@{handle}") }),
    ))
}

fn action_request(
    action: &str,
    target: Option<&str>,
    text: Option<&str>,
    request_id: Option<&str>,
    options: Option<&serde_json::Value>,
) -> Result<(reqwest::Method, String, serde_json::Value), String> {
    if matches!(action,"tip_settings"|"cancel_event_listing") { return owned_settings::action(action,target,text,request_id,options); }
    if action == "thread_post_relationship" { return thread_post_control_action(target, text, request_id, options); }
    if action == "create_article" { return article_publication_action(target, text, request_id, options); }
    if matches!(action,"update_community_notifications"|"read_all_community_channels") {
        if text.is_some()||request_id.is_some() {return Err("固定の入力項目を使ってください".into());}
        return community_preferences_action(action,target,options);
    }
    if is_playlist_action(action) {
        if text.is_some() || request_id.is_some() { return Err("固定の入力項目を使ってください".into()); }
        return playlist_action(action,target,options);
    }
    if action=="music_post_create" {
        if text.is_some()||request_id.is_some(){return Err("固定の入力項目を使ってください".into());}
        return music_post_action(target,options);
    }
    if action=="video_post_create" {
        if text.is_some()||request_id.is_some(){return Err("固定の入力項目を使ってください".into());}
        return video_post_action(target,options);
    }
    if matches!(action,"like_video"|"unlike_video") {
        if text.is_some()||request_id.is_some()||options.is_some(){return Err("固定の入力項目を使ってください".into());}
        let video=discussion_id(target)?;
        return Ok((if action=="like_video"{reqwest::Method::POST}else{reqwest::Method::DELETE},format!("/api/client/videos/{video}/engagement"),serde_json::json!({})));
    }
    if matches!(action,"favorite_music"|"unfavorite_music"|"personal_node_relays"|"personal_node_device_revoke"|"research_pdf_scan"|"research_pdf_visibility") {
        if text.is_some()||request_id.is_some(){return Err("固定の入力項目を使ってください".into());}
        return library_action(action,target,options);
    }
    if matches!(action,"save_article"|"unsave_article"|"article_like_set"|"article_like_clear"|"article_comment_create"|"save_video"|"unsave_video"|"thread_read"|"thread_status"|"research_register_object"|"research_register_relation") {
        if text.is_some()||request_id.is_some(){return Err("固定の入力項目を使ってください".to_owned());}
        return parity_action(action,target,options);
    }
    if matches!(action, "research_git_application_preview" | "research_git_application_check" | "research_git_application_apply") {
        if text.is_some() || request_id.is_some() {
            return Err("反映には固定の入力項目を使ってください".to_owned());
        }
        return research_git_application_action(action, target, options);
    }
    if matches!(action,"research_git_propose"|"research_git_approve"|"research_git_reject"){if text.is_some(){return Err("提案には固定の入力項目を使ってください".to_owned());}return research_git_proposal_action(action,target,request_id,options);}
    if matches!(action,"community_governance_vote"|"community_governance_lifecycle") {return community_governance_mutation_action(action,target,text,options);}
    if action == "community_governance_create_proposal" { return community_governance_create_action(target, options); }
    if action == "community_governance_settings" { return community_governance_settings_action(target, options); }
    if action == "follow_remote" {
        if target.is_some() || text.is_some() || request_id.is_some() { return Err("固定の入力項目を使ってください".to_owned()); }
        return remote_follow_action(options);
    }
    if action == "community_invite_accept" { return community_invite_action(target, request_id, options); }
    if action == "community_join_complete" { return community_join_action(target, options); }
    if action.starts_with("community_access_") {return community_access_action(action,target,request_id,options);}
    if matches!(action,"research_git_create"|"research_git_visibility"|"research_git_revoke"|"research_git_token"){return research_git_management_action(action,target,request_id,options);}
    if action.starts_with("research_") { return research_action(action, target, options); }
    let target = conversation_query(target);
    let post_body = |text: Option<&str>| -> Result<String, String> {
        // ハブ側の上限は500字。超えた分はここで切る——送ってから弾かれると
        // 何が保存されたか窓から分からなくなる。
        Ok(text.ok_or("本文が正しくありません")?.chars().take(500).collect::<String>())
    };
    // options から決まったキーの文字列を取る。識別子・区分値だけなので
    // 形をここで絞る。長い自由文は text 側（post_body）を通す。
    let option_string = |key: &str| -> Result<String, String> {
        options
            .and_then(|value| value.get(key))
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty() && value.len() <= 128)
            .map(str::to_owned)
            .ok_or_else(|| "指定が正しくありません".to_owned())
    };
    let option_id = |key: &str| -> Result<String, String> {
        path_segment(options.and_then(|value| value.get(key)).and_then(|value| value.as_str()))
    };
    let optional_id = |key: &str| -> Option<String> {
        options
            .and_then(|value| value.get(key))
            .and_then(|value| value.as_str())
            .and_then(|value| path_segment(Some(value)).ok())
    };
    // サーバー発行の構造体をそのまま送り返すための口（typedData）。
    // オブジェクト形でサイズ上限だけ——中身の正当性はハブが再構築して照合する。
    let option_json = |key: &str| -> Result<serde_json::Value, String> {
        let value = options
            .and_then(|value| value.get(key))
            .cloned()
            .ok_or_else(|| "指定が正しくありません".to_owned())?;
        if !value.is_object() || value.to_string().len() > 16 * 1024 {
            return Err("指定が正しくありません".to_owned());
        }
        Ok(value)
    };
    // ウォレットアドレス（0x+40hex）専用。
    let option_address = |key: &str| -> Result<String, String> {
        let value = option_string(key)?;
        if value.len() == 42
            && value.starts_with("0x")
            && value[2..].bytes().all(|b| b.is_ascii_hexdigit())
        {
            Ok(value)
        } else {
            Err("アドレスの指定が正しくありません".to_owned())
        }
    };
    let option_u64 = |key: &str| -> Result<u64, String> {
        options
            .and_then(|value| value.get(key))
            .and_then(|value| value.as_u64())
            .ok_or_else(|| "指定が正しくありません".to_owned())
    };
    // txHash / challengeId 等の0xhexまたはuuid文字列。
    let option_loose = |key: &str, max: usize| -> Result<String, String> {
        let value = option_string(key)?;
        if value.len() <= max
            && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, 'x' | '-'))
        {
            Ok(value)
        } else {
            Err("指定が正しくありません".to_owned())
        }
    };
    match action {
        "community_guide_review" | "community_guide_update" => {
            let community=path_segment(target.as_deref())?;let proposal=path_segment(Some(&option_string("proposalId")?))?;
            if community.len()>80 || proposal.len()>80 {return Err("編集案の指定が正しくありません".to_owned());}
            let id=request_id.filter(|id|id.len()==36&&uuid::Uuid::parse_str(id).is_ok()).ok_or("操作IDが正しくありません")?;
            let expected=option_string("expectedUpdatedAt")?;
            if expected.is_empty()||expected.encode_utf16().count()>80{return Err("確認した版の指定が正しくありません".to_owned());}
            if action=="community_guide_review" {
                let decision=option_string("decision")?;
                if !["comment","approve","request_changes"].contains(&decision.as_str()){return Err("レビューの指定が正しくありません".to_owned());}
                let body=text.map(str::trim).filter(|body|!body.is_empty()&&body.encode_utf16().count()<=2000).ok_or("レビューの文字数が正しくありません")?;
                Ok((reqwest::Method::POST,format!("/api/client/communities/{community}/guides/proposals/{proposal}/reviews"),serde_json::json!({"requestId":id,"body":body,"decision":decision,"expectedUpdatedAt":expected})))
            } else {
                let kind=option_string("action")?;
                if !["merge","close","reopen"].contains(&kind.as_str()){return Err("編集案の操作が正しくありません".to_owned());}
                Ok((reqwest::Method::PATCH,format!("/api/client/communities/{community}/guides/proposals/{proposal}"),serde_json::json!({"requestId":id,"action":kind,"expectedUpdatedAt":expected})))
            }
        }
        "community_channel_slowmode" | "community_channel_archive" => {
            use unicode_normalization::UnicodeNormalization;
            let community=path_segment(target.as_deref())?;if community.len()>100{return Err("識別子が長すぎます".to_owned());}
            let values=options.and_then(serde_json::Value::as_object).ok_or("設定内容がありません")?;
            let channel=path_segment(values.get("channelId").and_then(serde_json::Value::as_str))?;if channel.len()>100{return Err("識別子が長すぎます".to_owned());}
            let operation=research_proposal_uuid(request_id)?;if operation!=operation.to_ascii_lowercase(){return Err("操作IDが不正です".to_owned());}
            let raw_note=values.get("note").and_then(serde_json::Value::as_str).filter(|value|value.encode_utf16().count()<=1000).ok_or("変更理由が不正です")?;
            let note=raw_note.nfkc().collect::<String>().trim_matches(|c:char|matches!(c as u32,0x9..=0xd|0x20|0xa0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff)).to_owned();
            if !(5..=1000).contains(&note.encode_utf16().count()){return Err("変更理由が不正です".to_owned());}
            let mode=|key:&str|->Result<u64,String>{values.get(key).and_then(serde_json::Value::as_u64).filter(|n|[0,5,10,30,60,300,600,3600].contains(n)).ok_or("低速モードが不正です".to_owned())};
            let archived=values.get("expectedArchivedAt").ok_or("現在の状態がありません")?;
            if !archived.is_null() && !archived.as_str().is_some_and(|v|!v.is_empty()&&v.encode_utf16().count()<=64&&!v.chars().any(char::is_control)&&chrono::DateTime::parse_from_rfc3339(v).is_ok()){return Err("現在の状態が不正です".to_owned());}
            let mut body=serde_json::json!({"action":if action=="community_channel_slowmode"{"channel_controls"}else{"set_channel_archived"},"channelId":channel,"operationId":operation,"note":note,"expectedSlowmodeSeconds":mode("expectedSlowmodeSeconds")?,"expectedArchivedAt":archived});
            if action=="community_channel_slowmode" {body["slowmodeSeconds"]=serde_json::json!(mode("slowmodeSeconds")?);}else{body["archived"]=serde_json::json!(values.get("archived").and_then(serde_json::Value::as_bool).ok_or("アーカイブの指定が不正です")?);}
            Ok((reqwest::Method::POST,format!("/api/client/communities/{community}/channels/policy"),body))
        }
        "community_appeal_submit" => {
            let community=path_segment(target.as_deref())?;
            if community.len()>80 {return Err("識別子が長すぎます".to_owned());}
            let values=options.and_then(serde_json::Value::as_object).ok_or("申立て内容がありません")?;
            let reason=values.get("reason").and_then(serde_json::Value::as_str).map(str::trim).filter(|value| value.chars().count()>=20 && value.encode_utf16().count()<=1000).ok_or("申立て理由が不正です")?;
            let sanction=values.get("expectedSanctionKey").and_then(serde_json::Value::as_str).filter(|value| value.len()==64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))).ok_or("確認した処分の指定が不正です")?;
            let id=request_id.filter(|value| uuid::Uuid::parse_str(value).is_ok()).ok_or("操作IDが不正です")?;
            Ok((reqwest::Method::POST,fill_path("/api/client/communities/{a}/my-appeals",&[community])?,serde_json::json!({"operationId":id,"reason":reason,"expectedSanctionKey":sanction})))
        }
        "community_appeal_review" => {
            let community=path_segment(target.as_deref())?;
            let values=options.and_then(serde_json::Value::as_object).ok_or("審査内容がありません")?;
            let appeal=values.get("appealId").and_then(serde_json::Value::as_str).ok_or("異議申立てがありません")?;
            if community.len()>80 || appeal.len()>80 {return Err("識別子が長すぎます".to_owned());}
            let appeal=path_segment(Some(appeal))?;
            let decision=values.get("decision").and_then(serde_json::Value::as_str).filter(|value| ["accepted","rejected"].contains(value)).ok_or("判定が不正です")?;
            let note=values.get("note").and_then(serde_json::Value::as_str).map(str::trim).filter(|value| (5..=1000).contains(&value.encode_utf16().count())).ok_or("判断理由が不正です")?;
            let expected=values.get("expectedCreatedAt").and_then(serde_json::Value::as_str).filter(|value| !value.is_empty() && value.encode_utf16().count()<=80).ok_or("申立日時が不正です")?;
            let sanction=values.get("expectedSanctionKey").and_then(serde_json::Value::as_str).filter(|value| value.len()==64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))).ok_or("確認した処分の指定が不正です")?;
            let id=request_id.filter(|value| uuid::Uuid::parse_str(value).is_ok()).ok_or("操作IDが不正です")?;
            Ok((reqwest::Method::POST,fill_path("/api/client/communities/{a}/appeals/{b}",&[community,appeal])?,serde_json::json!({"operationId":id,"decision":decision,"note":note,"expectedCreatedAt":expected,"expectedSanctionKey":sanction})))
        }
        "community_report_review" => {
            let community=path_segment(target.as_deref())?;
            let values=options.and_then(serde_json::Value::as_object).ok_or("審査内容がありません")?;
            let report=values.get("reportId").and_then(serde_json::Value::as_str).ok_or("通報がありません")?;
            if community.len()>80 || report.len()>80 {return Err("識別子が長すぎます".to_owned());}
            let report=path_segment(Some(report))?;
            let decision=values.get("decision").and_then(serde_json::Value::as_str).filter(|value| ["actioned","dismissed"].contains(value)).ok_or("判定が不正です")?;
            let note=values.get("note").and_then(serde_json::Value::as_str).map(str::trim).filter(|value| (5..=1000).contains(&value.encode_utf16().count())).ok_or("判断理由が不正です")?;
            let expected=values.get("expectedCreatedAt").and_then(serde_json::Value::as_str).filter(|value| !value.is_empty() && value.encode_utf16().count()<=80).ok_or("通報日時が不正です")?;
            let edited=values.get("expectedMessageEditedAt").ok_or("確認した本文の編集日時がありません")?;
            if !edited.is_null() && !edited.as_str().is_some_and(|value| !value.is_empty() && value.encode_utf16().count()<=80) {return Err("確認した本文の編集日時が不正です".to_owned());}
            let id=request_id.filter(|value| uuid::Uuid::parse_str(value).is_ok()).ok_or("操作IDが不正です")?;
            Ok((reqwest::Method::POST,fill_path("/api/client/communities/{a}/reports/{b}",&[community,report])?,serde_json::json!({"operationId":id,"decision":decision,"note":note,"expectedCreatedAt":expected,"expectedMessageEditedAt":edited})))
        }
        "community_membership_review" => {
            let community=path_segment(target.as_deref())?;
            let values=options.and_then(serde_json::Value::as_object).ok_or("審査内容がありません")?;
            let profile=values.get("profileId").and_then(serde_json::Value::as_str).ok_or("申請者がありません")?;
            if community.len()>80 || profile.len()>80 {return Err("識別子が長すぎます".to_owned());}
            let profile=path_segment(Some(profile))?;
            let decision=values.get("decision").and_then(serde_json::Value::as_str).filter(|value| ["approve","reject"].contains(value)).ok_or("判定が不正です")?;
            let note=values.get("note").and_then(serde_json::Value::as_str).map(str::trim).filter(|value| (5..=1000).contains(&value.encode_utf16().count())).ok_or("判断理由が不正です")?;
            let expected=values.get("expectedCreatedAt").and_then(serde_json::Value::as_str).filter(|value| !value.is_empty() && value.encode_utf16().count()<=80).ok_or("申請日時が不正です")?;
            let id=request_id.filter(|value| uuid::Uuid::parse_str(value).is_ok()).ok_or("操作IDが不正です")?;
            Ok((reqwest::Method::POST,fill_path("/api/client/communities/{a}/membership-requests/{b}",&[community,profile])?,serde_json::json!({"operationId":id,"decision":decision,"note":note,"expectedCreatedAt":expected})))
        }
        "community_guide_propose" => {
            let community = path_segment(target.as_deref())?;
            let bounded = |raw: Option<&str>, max: usize| -> Result<String,String> {
                raw.map(str::trim).filter(|s| !s.is_empty() && s.encode_utf16().count() <= max).map(str::to_owned).ok_or("編集案の文字数が正しくありません".to_owned())
            };
            let field = |key,max| bounded(options.and_then(|o|o.get(key)).and_then(|v|v.as_str()),max);
            let optional = |key| -> Result<Option<String>,String> {
                match options.and_then(|o|o.get(key)) {
                    None | Some(serde_json::Value::Null) => Ok(None),
                    Some(value) => {let id=path_segment(value.as_str())?;if id.len()>80{return Err("ガイドの指定が正しくありません".to_owned());}Ok(Some(id))}
                }
            };
            let id=request_id.filter(|id| id.len()==36 && uuid::Uuid::parse_str(id).is_ok()).ok_or("操作IDが正しくありません")?;
            let version=option_u64("baseVersion")?;
            if community.len()>80 || version>9_007_199_254_740_991 {return Err("ガイドの指定が正しくありません".to_owned());}
            Ok((reqwest::Method::POST,format!("/api/client/communities/{community}/guides"),serde_json::json!({
                "requestId":id,"pageId":optional("pageId")?,"proposedDirectoryId":optional("proposedDirectoryId")?,
                "title":field("title",120)?,"proposedTitle":field("proposedTitle",120)?,"proposedBody":bounded(text,30000)?,
                "summary":field("summary",500)?,"baseVersion":version
            })))
        }
        "read_all_notifications" => Ok((
            reqwest::Method::POST,
            "/api/client/notifications".to_owned(),
            serde_json::json!({ "readAll": true }),
        )),
        "read_notification" => Ok((
            reqwest::Method::POST,
            "/api/client/notifications".to_owned(),
            serde_json::json!({ "id": target.ok_or("通知の指定が正しくありません")? }),
        )),
        "read_conversation" => Ok((
            reqwest::Method::POST,
            "/api/client/conversations".to_owned(),
            serde_json::json!({ "conversation": target.ok_or("会話の指定が正しくありません")?, "markRead": true }),
        )),
        "send_message" => {
            let mut body = serde_json::json!({
                "conversation": target.ok_or("会話の指定が正しくありません")?,
                "text": ({let text=text.ok_or("dm_rejected:400")?;if text.encode_utf16().count()>280||text.contains('\0'){return Err("dm_rejected:400".into());}text}),
            });
            if let Some(id) = conversation_query(request_id) {
                body["requestId"] = serde_json::Value::String(id);
            }
            let image_ids = image_id_list(options)?;
            if !image_ids.is_empty() {
                body["imageIds"] = serde_json::json!(image_ids);
            }
            Ok((reqwest::Method::POST, "/api/client/conversations".to_owned(), body))
        }
        "like" | "unlike" | "bookmark" | "unbookmark" => Ok((
            reqwest::Method::POST,
            "/api/client/engagements".to_owned(),
            serde_json::json!({
                "kind": if action.contains("like") { "like" } else { "bookmark" },
                "targetId": target.ok_or("投稿の指定が正しくありません")?,
                "active": !action.starts_with("un"),
            }),
        )),
        "repost" => Ok((
            reqwest::Method::POST,
            "/api/client/posts".to_owned(),
            serde_json::json!({
                "repostOfTargetType": "social_post",
                "repostOfTargetId": target.ok_or("投稿の指定が正しくありません")?,
            }),
        )),
        // 引用はコメント本文が要る——空引用はハブ側も受けない。
        "quote_post" => Ok((
            reqwest::Method::POST,
            "/api/client/posts".to_owned(),
            serde_json::json!({
                "body": post_body(text)?,
                "quoteOfTargetType": "social_post",
                "quoteOfTargetId": target.ok_or("投稿の指定が正しくありません")?,
            }),
        )),
        "reply" => Ok((
            reqwest::Method::POST,
            "/api/client/posts".to_owned(),
            serde_json::json!({
                "body": post_body(text)?,
                "replyToPostId": target.ok_or("投稿の指定が正しくありません")?,
            }),
        )),
        "create_post" => {
            // 画像は /api/client/images で上げた pending 画像の id だけが来る。
            // 窓からの任意文字列は通さず UUID 形だけ通す。
            let image_ids = image_id_list(options)?;
            let mut body = serde_json::json!({ "body": post_body(text)? });
            if let Some(id) = conversation_query(request_id) {
                body["clientRequestId"] = serde_json::Value::String(id);
            }
            if !image_ids.is_empty() {
                body["imageIds"] = serde_json::json!(image_ids);
            }
            // 公開範囲は followers だけが来る——それ以外の値はpublicのまま。
            if let Ok(audience) = option_string("audience") {
                if audience == "followers" {
                    body["audience"] = serde_json::Value::String(audience);
                }
            }
            // 予約時刻は ISO 文字列。形だけここで見て、実際の可否はハブが決める。
            if let Ok(scheduled) = option_string("scheduledAt") {
                let looks_iso = scheduled.len() <= 40
                    && scheduled.chars().all(|c| {
                        c.is_ascii_alphanumeric() || matches!(c, '-' | ':' | 'T' | 'Z' | '.' | '+')
                    });
                if !looks_iso {
                    return Err("予約時刻が正しくありません".to_owned());
                }
                body["scheduledAt"] = serde_json::Value::String(scheduled);
            }
            Ok((reqwest::Method::POST, "/api/client/posts".to_owned(), body))
        }
        // 予約投稿の編集・取り消し。id は target、新しい本文は text。
        "schedule_edit" => Ok((
            reqwest::Method::PATCH,
            "/api/client/scheduled-posts".to_owned(),
            serde_json::json!({
                "id": target.ok_or("予約の指定が正しくありません")?,
                "body": post_body(text)?,
                "scheduledAt": option_string("scheduledAt")?,
                "audience": optional_id("audience").filter(|a| a == "followers").unwrap_or_else(|| "public".to_owned()),
            }),
        )),
        "schedule_cancel" => Ok((
            reqwest::Method::DELETE,
            format!(
                "/api/client/scheduled-posts?id={}",
                target.ok_or("予約の指定が正しくありません")?
            ),
            serde_json::json!({}),
        )),
        // 自分の投稿の編集。id は target、新しい本文は text。
        "edit_post" => Ok((
            reqwest::Method::PATCH,
            "/api/client/posts".to_owned(),
            serde_json::json!({
                "id": target.ok_or("投稿の指定が正しくありません")?,
                "body": post_body(text)?,
            }),
        )),
        "delete_post" => Ok((
            reqwest::Method::DELETE,
            "/api/client/posts".to_owned(),
            serde_json::json!({ "id": target.ok_or("投稿の指定が正しくありません")? }),
        )),
        // スレッドへの返信。言語・地域・言語タグはスレッドのスコープ宣言に
        // 必要なので options から取る——本文の text と混ぜない。
        "thread_reply" => Ok((
            reqwest::Method::POST,
            fill_path(
                "/api/client/threads/{a}/posts",
                &[target.clone().ok_or("スレッドの指定が正しくありません")?],
            )?,
            serde_json::json!({
                "body": text.ok_or("本文が正しくありません")?.chars().take(2000).collect::<String>(),
                "replyToPostId": optional_id("replyToPostId"),
                "language": option_string("language")?,
                "region": option_string("region")?,
                "languageTag": option_string("languageTag")?,
                "countryCode": optional_id("countryCode"),
            }),
        )),
        // スレッド投稿の編集・削除・評価・通報。postId は target。
        // 編集の本文は text、評価の種類と通報理由は options の決まったキー。
        "thread_post_edit" => Ok((
            reqwest::Method::PATCH,
            fill_path(
                "/api/client/thread-posts/{a}",
                &[target.clone().ok_or("投稿の指定が正しくありません")?],
            )?,
            serde_json::json!({
                "body": text.ok_or("本文が正しくありません")?.chars().take(4000).collect::<String>(),
                "edit_reason": options
                    .and_then(|v| v.get("editReason")).and_then(|v| v.as_str())
                    .unwrap_or("").chars().take(300).collect::<String>(),
            }),
        )),
        "thread_post_delete" => Ok((
            reqwest::Method::DELETE,
            fill_path(
                "/api/client/thread-posts/{a}",
                &[target.clone().ok_or("投稿の指定が正しくありません")?],
            )?,
            serde_json::json!({}),
        )),
        "thread_post_vote" => {
            let kind = option_string("kind")?;
            if !matches!(kind.as_str(), "up" | "down") {
                return Err("評価の種類が正しくありません".to_owned());
            }
            Ok((
                reqwest::Method::POST,
                fill_path(
                    "/api/client/thread-posts/{a}/vote",
                    &[target.clone().ok_or("投稿の指定が正しくありません")?],
                )?,
                serde_json::json!({
                    "kind": kind,
                    "reason": optional_id("reason")
                        .filter(|r| matches!(r.as_str(), "incorrect" | "unsupported" | "off_topic" | "unclear")),
                }),
            ))
        }
        "thread_post_report" => {
            let reason = option_string("reason")?;
            if !matches!(reason.as_str(), "harassment" | "spam" | "privacy" | "misinformation" | "other") {
                return Err("通報理由が正しくありません".to_owned());
            }
            Ok((
                reqwest::Method::POST,
                fill_path(
                    "/api/client/thread-posts/{a}/report",
                    &[target.clone().ok_or("投稿の指定が正しくありません")?],
                )?,
                serde_json::json!({
                    "reason": reason,
                    "details": options
                        .and_then(|v| v.get("details")).and_then(|v| v.as_str())
                        .unwrap_or("").chars().take(500).collect::<String>(),
                }),
            ))
        }
        // ベストアンサーと追跡はスレッドID宛て。postIdは options。
        "thread_best_answer" => Ok((
            reqwest::Method::POST,
            fill_path(
                "/api/client/threads/{a}/best-answer",
                &[target.clone().ok_or("スレッドの指定が正しくありません")?],
            )?,
            serde_json::json!({ "post_id": option_id("postId")? }),
        )),
        "thread_summary_propose" | "thread_summary_publish" | "thread_topic_subscribe" | "thread_topic_unsubscribe" | "thread_archive" | "thread_unarchive" | "thread_continue" => {
            let id = target.as_deref().filter(|id| id.len()<=64).ok_or("スレッドの指定が正しくありません")?;
            let path = fill_path("/api/client/threads/{a}/knowledge-platform", &[id.to_owned()])?;
            let operation_id = || request_id.filter(|id| id.len()==36 && uuid::Uuid::parse_str(id).is_ok()).ok_or("操作IDが正しくありません");
            let body = match action {
                "thread_summary_propose" => {
                    let value = text.ok_or("まとめが必要です")?.trim();
                    if value.chars().count()<20 || value.encode_utf16().count()>12000 { return Err("まとめは20〜12000文字です".to_owned()); }
                    serde_json::json!({"action":"propose_summary","text":value,"requestId":operation_id()?})
                }
                "thread_summary_publish" => {
                    let summary = option_id("summaryId")?; if summary.len()>64 { return Err("提案IDが長すぎます".to_owned()); }
                    serde_json::json!({"action":"publish_summary","summaryId":summary})
                }
                "thread_topic_subscribe" | "thread_topic_unsubscribe" => {
                    let kind = option_string("kind")?;
                    let value = options.and_then(|v|v.get("value")).and_then(|v|v.as_str()).filter(|value| !value.is_empty() && value.encode_utf16().count()<=100 && !value.chars().any(char::is_control)).ok_or("話題の指定が正しくありません")?;
                    if !["board","tag","language","region"].contains(&kind.as_str()) { return Err("話題の種類が正しくありません".to_owned()); }
                    serde_json::json!({"action":if action=="thread_topic_subscribe" {"subscribe"} else {"unsubscribe"},"kind":kind,"value":value})
                }
                "thread_continue" => {
                    let title = options.and_then(|v|v.get("title")).and_then(|v|v.as_str()).ok_or("タイトルが必要です")?.trim(); let value = text.ok_or("本文が必要です")?.trim();
                    if !(8..=100).contains(&title.encode_utf16().count()) || !(30..=4000).contains(&value.encode_utf16().count()) { return Err("タイトルは8〜100文字、本文は30〜4000文字です".to_owned()); }
                    let mode = option_string("identityMode")?; if !["account","anonymous"].contains(&mode.as_str()) { return Err("投稿者の種類が正しくありません".to_owned()); }
                    serde_json::json!({"action":"continue_thread","title":title,"text":value,"identityMode":mode,"requestId":operation_id()?})
                }
                _ => serde_json::json!({"action":if action=="thread_archive" {"archive"} else {"unarchive"}}),
            };
            Ok((reqwest::Method::POST,path,body))
        }
        "thread_follow" => Ok((
            reqwest::Method::POST,
            fill_path(
                "/api/client/threads/{a}/follow",
                &[target.clone().ok_or("スレッドの指定が正しくありません")?],
            )?,
            serde_json::json!({}),
        )),
        // コミュニティの参加・退出。joined は action 名で固定するので
        // 窓が真偽を組み立てることはない。
        "community_join" | "community_leave" => Ok((
            reqwest::Method::POST,
            fill_path(
                "/api/client/communities/{a}/membership",
                &[target.clone().ok_or("コミュニティの指定が正しくありません")?],
            )?,
            serde_json::json!({ "joined": action == "community_join" }),
        )),
        "community_cancel_request" => {
            let id = request_id.filter(|id| id.len() == 36 && uuid::Uuid::parse_str(id).is_ok()).ok_or("操作IDが正しくありません")?;
            Ok((reqwest::Method::DELETE, fill_path("/api/client/communities/{a}/membership", &[target.clone().ok_or("コミュニティの指定が正しくありません")?])?, serde_json::json!({"operationId":id})))
        }
        "community_channel_create" | "community_channel_edit" | "community_channel_up" | "community_channel_down" | "community_channel_delete"
        | "community_member_promote" | "community_member_demote" | "community_member_mute" | "community_member_unmute" | "community_member_ban"
        | "community_poll_create" | "community_poll_vote" | "community_message_schedule" => {
            let community = target.clone().ok_or("コミュニティの指定が正しくありません")?;
            let bounded = |key: &str, max: usize| -> Result<String, String> {
                let value = options.and_then(|value| value.get(key)).and_then(|value| value.as_str()).ok_or("入力が正しくありません")?.trim();
                if value.chars().count() > max { return Err("入力が長すぎます".to_owned()); }
                Ok(value.to_owned())
            };
            let operation_id = || -> Result<String, String> {
                request_id.filter(|id| id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')).map(str::to_owned).ok_or("操作IDが正しくありません".to_owned())
            };
            let community_path = |template: &'static str| fill_path(template, std::slice::from_ref(&community));
            match action {
                "community_channel_create" | "community_channel_edit" => {
                    let name = bounded("name", 50)?;
                    if name.is_empty() { return Err("チャンネル名が必要です".to_owned()); }
                    let body = serde_json::json!({"name":name,"description":bounded("description",200)?});
                    if action == "community_channel_create" { Ok((reqwest::Method::POST,community_path("/api/client/communities/{a}/channels")?,body)) }
                    else { Ok((reqwest::Method::PATCH,fill_path("/api/client/communities/{a}/channels/{b}",&[community,option_id("channelId")?])?,body)) }
                }
                "community_channel_up" | "community_channel_down" | "community_channel_delete" => {
                    let path = fill_path("/api/client/communities/{a}/channels/{b}",&[community,option_id("channelId")?])?;
                    if action == "community_channel_delete" { Ok((reqwest::Method::DELETE,path,serde_json::json!({"operationId":operation_id()?,"note":""}))) }
                    else { Ok((reqwest::Method::PATCH,path,serde_json::json!({"direction":if action == "community_channel_up" {"up"} else {"down"}}))) }
                }
                "community_poll_create" => {
                    let question = bounded("question",200)?;
                    let labels = options.and_then(|value|value.get("choices")).and_then(|value|value.as_array()).filter(|items|(2..=10).contains(&items.len())).ok_or("選択肢は2〜10件です")?
                        .iter().map(|value|value.as_str().map(str::trim).filter(|value|!value.is_empty() && value.chars().count()<=100).map(str::to_owned).ok_or("選択肢が正しくありません")).collect::<Result<Vec<_>,_>>()?;
                    let hours = options.and_then(|value|value.get("closesInHours")).and_then(|value|value.as_u64()).filter(|value|(1..=720).contains(value)).ok_or("締切が正しくありません")?;
                    if question.is_empty() { return Err("質問が必要です".to_owned()); }
                    Ok((reqwest::Method::POST,community_path("/api/client/communities/{a}/polls")?,serde_json::json!({"channelId":option_id("channelId")?,"question":question,"options":labels,"closesInHours":hours,"clientRequestId":operation_id()?})))
                }
                "community_poll_vote" => Ok((reqwest::Method::PATCH,community_path("/api/client/communities/{a}/polls")?,serde_json::json!({"optionId":option_id("optionId")?}))),
                "community_message_schedule" => {
                    let content = text.map(str::trim).filter(|value|!value.is_empty() && value.chars().count()<=2000).ok_or("本文は1〜2000文字です")?;
                    let kind = option_string("kind")?;
                    if !matches!(kind.as_str(),"chat"|"guide"|"question"|"party") { return Err("投稿の種類が正しくありません".to_owned()); }
                    Ok((reqwest::Method::POST,community_path("/api/client/communities/{a}/scheduled")?,serde_json::json!({"channelId":option_id("channelId")?,"body":content,"kind":kind,"scheduledAt":bounded("scheduledAt",64)?,"clientRequestId":operation_id()?})))
                }
                _ => Ok((reqwest::Method::PATCH,fill_path("/api/client/communities/{a}/members/{b}",&[community,option_id("profileId")?])?,serde_json::json!({"action":action.strip_prefix("community_member_").ok_or("管理操作が正しくありません")?,"operationId":operation_id()?,"note":bounded("note",500)?}))),
            }
        }

        // チャンネルへの投稿。channelId は options 側の識別子。
        "channel_message" => {
            let mut body = serde_json::json!({
                "body": ({
                    let text=text.unwrap_or_default();
                    if text.encode_utf16().count()>2000 { return Err("channel_message_rejected:400".into()); }
                    text
                }),
                "replyToMessageId": optional_id("replyToMessageId"),
            });
            // 画像は pending 登録済みの ID だけを受け取る。形をここで絞る。
            if let Some(value) = options.and_then(|value| value.get("imageIds")) {
                let ids = value
                    .as_array()
                    .filter(|ids| !ids.is_empty() && ids.len() <= 4)
                    .ok_or("画像の指定が正しくありません")?
                    .iter()
                    .map(|id| path_segment(id.as_str()))
                    .collect::<Result<Vec<_>, _>>()?;
                body["imageIds"] = serde_json::json!(ids);
            }
            let no_text = body["body"].as_str().map(str::is_empty).unwrap_or(true);
            if no_text && body.get("imageIds").is_none() {
                return Err("本文が正しくありません".to_owned());
            }
            if let Ok(kind) = option_string("kind") {
                if matches!(kind.as_str(), "guide" | "question" | "party") {
                    body["kind"] = serde_json::Value::String(kind);
                }
            }
            if let Some(id) = request_id.and_then(|value| {
                let value = value.trim();
                (value.len() == 36 && value.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
                    .then(|| value.to_owned())
            }) {
                body["clientRequestId"] = serde_json::Value::String(id);
            }
            Ok((
                reqwest::Method::POST,
                fill_path(
                    "/api/client/communities/{a}/channels/{b}/messages",
                    &[
                        target.clone().ok_or("コミュニティの指定が正しくありません")?,
                        option_id("channelId")?,
                    ],
                )?,
                body,
            ))
        }
        // 自分のメッセージの編集・削除。権限の判定はハブ側——ここは
        // 宛先の組立てだけ。
        "channel_message_edit" => Ok((
            reqwest::Method::PATCH,
            fill_path(
                "/api/client/communities/{a}/channels/{b}/messages/{c}",
                &[
                    target.clone().ok_or("コミュニティの指定が正しくありません")?,
                    option_id("channelId")?,
                    option_id("messageId")?,
                ],
            )?,
            serde_json::json!({
                "body": text.ok_or("本文が正しくありません")?.chars().take(2000).collect::<String>(),
            }),
        )),
        "channel_message_delete" => Ok((
            reqwest::Method::DELETE,
            fill_path(
                "/api/client/communities/{a}/channels/{b}/messages/{c}",
                &[
                    target.clone().ok_or("コミュニティの指定が正しくありません")?,
                    option_id("channelId")?,
                    option_id("messageId")?,
                ],
            )?,
            serde_json::json!({}),
        )),
        // ピン留めはモデレーター操作。action 名で ON/OFF を固定する。
        "channel_message_pin" | "channel_message_unpin" => Ok((
            reqwest::Method::PATCH,
            fill_path(
                "/api/client/communities/{a}/channels/{b}/messages/{c}",
                &[
                    target.clone().ok_or("コミュニティの指定が正しくありません")?,
                    option_id("channelId")?,
                    option_id("messageId")?,
                ],
            )?,
            serde_json::json!({ "pinned": action == "channel_message_pin" }),
        )),
        // メッセージの通報。理由はハブ側の許可3種だけ通す。
        "channel_message_report" => {
            let reason = option_string("reason")?;
            if !matches!(reason.as_str(), "spam" | "harassment" | "other") {
                return Err("通報理由が正しくありません".to_owned());
            }
            Ok((
                reqwest::Method::POST,
                fill_path(
                    "/api/client/communities/{a}/channels/{b}/messages/{c}/reports",
                    &[
                        target.clone().ok_or("コミュニティの指定が正しくありません")?,
                        option_id("channelId")?,
                        option_id("messageId")?,
                    ],
                )?,
                serde_json::json!({ "reason": reason }),
            ))
        }
        // メッセージへのリアクション。絵文字はハブ側の許可3種だけ通す。
        "message_reaction" => Ok((
            reqwest::Method::POST,
            fill_path(
                "/api/client/communities/{a}/channels/{b}/messages/{c}/reactions",
                &[
                    target.clone().ok_or("コミュニティの指定が正しくありません")?,
                    option_id("channelId")?,
                    option_id("messageId")?,
                ],
            )?,
            serde_json::json!({
                "emoji": match option_string("emoji")?.as_str() {
                    "❤️" => "❤️",
                    "🎉" => "🎉",
                    _ => "👍",
                },
            }),
        )),
        // フォロー切替。active は action 名で固定——窓が真偽を組み立てない。
        "follow" | "unfollow" => Ok((
            reqwest::Method::POST,
            "/api/client/follows".to_owned(),
            serde_json::json!({
                "target_profile_id": target.ok_or("プロフィールの指定が正しくありません")?,
                "active": action == "follow",
            }),
        )),
        // ミュート・ブロック。action 名で ON/OFF が決まるので窓が真偽を組まない。
        "mute" | "unmute" | "block" | "unblock" => Ok((
            reqwest::Method::PATCH,
            "/api/client/safety".to_owned(),
            serde_json::json!({
                "targetProfileId": target.ok_or("プロフィールの指定が正しくありません")?,
                "action": if action.starts_with("un") { &action[2..] } else { action },
                "enabled": !action.starts_with("un"),
            }),
        )),
        // 投稿・プロフィールの通報。対象は target、理由は options の決まった
        // キーだけ。理由の選択肢はハブ側の集合と同じ——違う値はここで止める。
        "report_post" | "report_profile" => {
            let reason = option_string("reason")?;
            let allowed = if action == "report_post" {
                ["image_safety", "sexual", "violence", "copyright", "privacy", "harassment", "spam", "other"].as_slice()
            } else {
                ["harassment", "spam", "impersonation", "privacy", "other"].as_slice()
            };
            if !allowed.contains(&reason.as_str()) {
                return Err("通報理由が正しくありません".to_owned());
            }
            Ok((
                reqwest::Method::POST,
                "/api/client/reports".to_owned(),
                serde_json::json!({
                    "targetType": if action == "report_post" { "social_post" } else { "profile" },
                    "targetId": target.ok_or("対象の指定が正しくありません")?,
                    "reason": reason,
                    "details": options
                        .and_then(|value| value.get("details"))
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .chars()
                        .take(500)
                        .collect::<String>(),
                }),
            ))
        }
        // スレッド作成。本文は text、スコープ系は options の決まったキー。
        "create_thread" => Ok((
            reqwest::Method::POST,
            "/api/client/threads".to_owned(),
            serde_json::json!({
                "board_key": option_string("boardKey")?,
                "title": option_string("title")?,
                "body": text.ok_or("本文が正しくありません")?.chars().take(4000).collect::<String>(),
                "identity_mode": match option_string("identityMode").unwrap_or_else(|_| "account".into()).as_str() {
                    "anonymous" => "anonymous",
                    _ => "account",
                },
                "language": option_string("language").unwrap_or_else(|_| "ja".into()),
                "region": option_string("region").unwrap_or_else(|_| "global".into()),
                "thread_type": option_string("threadType").unwrap_or_else(|_| "chat".into()),
                "tags": options
                    .and_then(|v| v.get("tags")).and_then(|v| v.as_str())
                    .map(|raw| raw.split(',').map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>())
                    .unwrap_or_default(),
            }),
        )),
        // コミュニティ作成。説明は text（10〜2000字はハブが弾く）。
        "create_community" => Ok((
            reqwest::Method::POST,
            "/api/client/communities".to_owned(),
            serde_json::json!({
                "name": option_string("name")?,
                "description": text.ok_or("説明が正しくありません")?.chars().take(2000).collect::<String>(),
                "category": option_string("category")?,
                "visibility": match option_string("visibility").unwrap_or_else(|_| "public".into()).as_str() {
                    "approval" => "approval",
                    "private" => "private",
                    _ => "public",
                },
            }),
        )),
        // DMの新規開始。start は対象プロフィールのID。
        "start_dm" => Ok((
            reqwest::Method::POST,
            "/api/client/conversations".to_owned(),
            serde_json::json!({ "start": target.ok_or("相手の指定が正しくありません")? }),
        )),
        // プロフィール編集（表示名・bio）。
        "update_profile" => Ok((
            reqwest::Method::PATCH,
            "/api/client/profile".to_owned(),
            serde_json::json!({
                "displayName": option_string("displayName")?,
                "bio": text.ok_or("bioが正しくありません")?.chars().take(180).collect::<String>(),
            }),
        )),
        // リスト作成。target なし。
        "create_list" => Ok((
            reqwest::Method::POST,
            "/api/client/lists".to_owned(),
            serde_json::json!({
                "name": option_string("name")?,
                "description": options.and_then(|v| v.get("description")).and_then(|v| v.as_str()).map(|s| s.chars().take(1000).collect::<String>()).unwrap_or_default(),
                "visibility": match option_string("visibility").unwrap_or_else(|_| "private".into()).as_str() {
                    "public" => "public",
                    _ => "private",
                },
            }),
        )),
        // リスト更新（target=listId）。メンバー切替は別動詞。
        "update_list" => Ok((
            reqwest::Method::PATCH,
            format!("/api/client/lists/{}", path_segment(target.as_deref())?),
            serde_json::json!({
                "name": option_string("name")?,
                "description": options.and_then(|v| v.get("description")).and_then(|v| v.as_str()).map(|s| s.chars().take(1000).collect::<String>()).unwrap_or_default(),
                "visibility": match option_string("visibility").unwrap_or_else(|_| "private".into()).as_str() {
                    "public" => "public",
                    _ => "private",
                },
            }),
        )),
        "delete_list" => Ok((
            reqwest::Method::DELETE,
            format!("/api/client/lists/{}", path_segment(target.as_deref())?),
            serde_json::json!({}),
        )),
        // メンバー切替。target=listId、options.memberKind/memberId/memberActive。
        "list_member" => Ok((
            reqwest::Method::PATCH,
            format!("/api/client/lists/{}", path_segment(target.as_deref())?),
            serde_json::json!({
                "member": {
                    "kind": match option_string("memberKind")?.as_str() {
                        "thread" => "thread",
                        _ => "profile",
                    },
                    "id": option_id("memberId")?,
                    "active": options
                        .and_then(|v| v.get("memberActive"))
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                },
            }),
        )),
        // 設定。通知7種・DM受信範囲・ミュート語・センシティブ表示。
        // options から決まったキーだけ拾い、窓のJSONはそのまま流さない。
        "update_settings" => {
            let mut body = serde_json::Map::new();
            if let Some(n) = options.and_then(|v| v.get("notifications")).and_then(|v| v.as_object()) {
                let mut prefs = serde_json::Map::new();
                for key in ["replies", "reactions", "follows", "messages", "commercePayments", "commerceDelivery", "commerceReturns"] {
                    if let Some(value) = n.get(key).and_then(|v| v.as_bool()) {
                        prefs.insert(key.to_owned(), serde_json::Value::Bool(value));
                    }
                }
                if !prefs.is_empty() {
                    body.insert("notifications".to_owned(), serde_json::Value::Object(prefs));
                }
            }
            if let Some(policy) = options.and_then(|v| v.get("directMessages")).and_then(|v| v.as_str()) {
                if matches!(policy, "mutuals" | "following" | "nobody") {
                    body.insert("directMessages".to_owned(), serde_json::Value::String(policy.to_owned()));
                }
            }
            if let Some(terms) = options.and_then(|v| v.get("mutedTerms")).and_then(|v| v.as_array()) {
                body.insert(
                    "mutedTerms".to_owned(),
                    serde_json::Value::Array(
                        terms.iter().filter_map(|t| t.as_str())
                            .map(|s| s.chars().take(80).collect::<String>())
                            .take(50)
                            .map(serde_json::Value::String)
                            .collect(),
                    ),
                );
            }
            if let Some(show) = options.and_then(|v| v.get("showSensitive")).and_then(|v| v.as_bool()) {
                body.insert("showSensitive".to_owned(), serde_json::Value::Bool(show));
            }
            if body.is_empty() {
                return Err("変更する設定がありません".to_owned());
            }
            Ok((reqwest::Method::PATCH, "/api/client/settings".to_owned(), serde_json::Value::Object(body)))
        }
        // ウォレット連携。challenge →（端末で署名）→ verify → unlink。
        // typedData はハブ発行のものをそのまま送り返す（改変はverifyが弾く）。
        "wallet_link_challenge" => Ok((
            reqwest::Method::POST,
            "/api/client/wallet-link/challenge".to_owned(),
            serde_json::json!({
                "address": option_address("address")?,
                "chainId": option_u64("chainId")?,
            }),
        )),
        "wallet_link_verify" => Ok((
            reqwest::Method::POST,
            "/api/client/wallet-link/verify".to_owned(),
            serde_json::json!({
                "challengeId": option_loose("challengeId", 36)?,
                "address": option_address("address")?,
                "typedData": option_json("typedData")?,
                "signature": option_loose("signature", 512)?,
            }),
        )),
        "wallet_unlink" => Ok((
            reqwest::Method::POST,
            "/api/client/wallet-link/unlink".to_owned(),
            serde_json::json!({
                "address": option_address("address")?,
                "chainId": option_u64("chainId")?,
            }),
        )),
        // チップの送金確認（オンチェーン送金後にHubへ届ける）。
        "tip_confirm" => Ok((
            reqwest::Method::POST,
            "/api/client/tips/confirm".to_owned(),
            serde_json::json!({
                "recipientHandle": option_string("handle")?,
                "txHash": option_loose("txHash", 66)?,
                "chainId": option_u64("chainId")?,
            }),
        )),
        _ => Err("この操作は許可されていません".to_owned()),
    }
}

const GIT_APPLICATION_MAX_RESPONSE_BYTES: usize = 64 * 1024;
const GIT_APPLICATION_RESPONSE_ERROR: &str = "反映の応答を確認できませんでした";

fn is_git_application_action(action: &str) -> bool {
    matches!(action, "research_git_application_preview" | "research_git_application_check" | "research_git_application_apply")
}

fn git_application_json_mime(headers: &reqwest::header::HeaderMap) -> bool {
    headers.get(reqwest::header::CONTENT_TYPE).and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
}

fn append_git_application_chunk(body: &mut Vec<u8>, chunk: &[u8]) -> Result<(), String> {
    if body.len() > GIT_APPLICATION_MAX_RESPONSE_BYTES || chunk.len() > GIT_APPLICATION_MAX_RESPONSE_BYTES.saturating_sub(body.len()) {
        return Err(GIT_APPLICATION_RESPONSE_ERROR.to_owned());
    }
    body.extend_from_slice(chunk);
    Ok(())
}

async fn read_git_application_response(mut response: reqwest::Response) -> Result<serde_json::Value, String> {
    let status = response.status();
    if status.is_redirection() || !git_application_json_mime(response.headers()) {
        return Err(GIT_APPLICATION_RESPONSE_ERROR.to_owned());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| GIT_APPLICATION_RESPONSE_ERROR.to_owned())? {
        append_git_application_chunk(&mut body, &chunk)?;
    }
    let value = serde_json::from_slice(&body).map_err(|_| GIT_APPLICATION_RESPONSE_ERROR.to_owned())?;
    if !status.is_success() {
        return Err("操作を受け付けてもらえませんでした".to_owned());
    }
    Ok(value)
}

pub async fn post_client(
    base: &str,
    action: &str,
    target: Option<&str>,
    text: Option<&str>,
    request_id: Option<&str>,
    options: Option<&serde_json::Value>,
) -> Result<serde_json::Value, String> {
    if matches!(action,"tip_settings"|"cancel_event_listing") { return owned_settings::write(base,action,target,text,request_id,options).await; }
    if action=="create_post" && scoped_feed_client::managed(options)? {
        if target.is_some() { return Err("feed_operation_rejected:400".into()); }
        let options=options.ok_or("feed_operation_rejected:400")?;
        if options.as_object().is_none_or(|value|value.keys().any(|key|!matches!(key.as_str(),"expectedDeviceId"|"expectedOrigin"|"expectedViewerId"|"audience"|"imageIds"|"scheduledAt"))) { return Err("feed_operation_rejected:400".into()); }
        let mut body=serde_json::json!({"body":text.ok_or("feed_operation_rejected:400")?,"clientRequestId":request_id.ok_or("feed_operation_rejected:400")?});
        for key in ["audience","imageIds","scheduledAt"] { if let Some(value)=options.get(key) { body[key]=value.clone(); } }
        return scoped_feed_client::send(base,"/api/client/posts",&body,options).await;
    }
    let (method, path, body) = action_request(action, target, text, request_id, options)?;
    if matches!(action,"community_poll_create"|"community_poll_vote"|"community_message_schedule") {
        return community_ops_client::send(base, action, method, &path, &body,
            options.ok_or("community_operation_rejected:400")?).await;
    }
    if matches!(action,"read_conversation"|"send_message") {
        return scoped_dm_client::send(base,action,&path,&body,options.ok_or("dm_rejected:400")?).await;
    }
    if matches!(action,"read_notification"|"read_all_notifications"|"channel_message") {
        return scoped_social_client::send(base,action,&path,&body,options.ok_or("notification_unknown")?).await;
    }
    if action == "thread_post_relationship" {
        let options = options.ok_or(THREAD_POST_CONTROL_INVALID)?;
        return thread_post_control_request(base, &path, method, Some(&body), target.ok_or(THREAD_POST_CONTROL_INVALID)?,
            options["expectedDeviceId"].as_str().ok_or(THREAD_POST_CONTROL_INVALID)?,
            options["expectedOrigin"].as_str().ok_or(THREAD_POST_CONTROL_INVALID)?,
            options["expectedViewerId"].as_str().ok_or(THREAD_POST_CONTROL_INVALID)?, false, None,
            Some((body["kind"].as_str().ok_or(THREAD_POST_CONTROL_INVALID)?, body["enabled"].as_bool().ok_or(THREAD_POST_CONTROL_INVALID)?))).await;
    }
    if action == "create_article" {
        let options = options.ok_or("article_publication_invalid_request")?;
        return article_publication_request(base, &path, method, Some(&body),
            body["clientRequestId"].as_str().ok_or("article_publication_invalid_request")?,
            options["expectedDeviceId"].as_str().ok_or("article_publication_invalid_request")?,
            options["expectedOrigin"].as_str().ok_or("article_publication_invalid_request")?).await;
    }
    let url = reqwest::Url::parse(&format!("{}{}", base.trim_end_matches('/'), path))
        .map_err(|_| "ハブの接続先が正しくありません".to_owned())?;
    let assertion = crate::desktop_account::assertion_if_registered(base)
        .await?
        .ok_or_else(|| "desktop_not_connected".to_owned())?;
    let git_application = is_git_application_action(action);
    let builder = reqwest::Client::builder();
    let builder = if action=="research_pdf_scan" {
        builder.timeout(std::time::Duration::from_secs(70)).redirect(reqwest::redirect::Policy::none())
    } else if git_application {
        builder.timeout(std::time::Duration::from_secs(60)).redirect(reqwest::redirect::Policy::none())
    } else {
        builder.timeout(std::time::Duration::from_secs(12))
    };
    let client = builder
        .build()
        .map_err(|_| "届けられません".to_owned())?;
    let response = client
        .request(method, url)
        .bearer_auth(assertion)
        .json(&body)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "ハブが応答しません".to_owned()
            } else if error.is_connect() {
                "ハブへ接続できません".to_owned()
            } else {
                "ハブへ届きません".to_owned()
            }
        })?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("desktop_not_connected".to_owned());
    }
    if git_application {
        return read_git_application_response(response).await;
    }
    if !response.status().is_success() {
        // ハブが理由を {error, code} で返しているときはそれを見せる。
        let rejected_status=response.status().as_u16();
        if action=="update_community_notifications" && matches!(rejected_status,400|403|404|409|413|429) {return Err(format!("community_preferences_rejected:{rejected_status}:通知設定を保存できませんでした。"));}
        if action=="read_all_community_channels" && matches!(rejected_status,400|403|404|409|413|429) {return Err(format!("community_read_all_rejected:{rejected_status}:既読状態を更新できませんでした。"));}
        if is_playlist_action(action) && matches!(rejected_status,400|403|404|409|413|429) { return Err(format!("playlist_rejected:{rejected_status}:プレイリストを保存できませんでした。")); }
        if matches!(action,"research_pdf_scan"|"research_pdf_visibility")&&matches!(rejected_status,400|403|404|409|413|415|429){return Err(format!("{action}_rejected:{rejected_status}:PDF操作を完了できませんでした"));}
        if matches!(action,"research_git_create"|"research_git_visibility"|"research_git_revoke"|"research_git_token")&&matches!(rejected_status,400|403|404|409){return Err(format!("research_git_management_rejected:{rejected_status}:Git設定を保存できませんでした"));}
        if matches!(action,"research_register_object"|"research_register_relation")&&matches!(rejected_status,400|403|404|409|429){return Err(format!("{action}_rejected:{rejected_status}:保存できませんでした"));}
        if matches!(action,"research_fork"|"research_network_fork")&&matches!(rejected_status,400|403|404|409|429){return Err(format!("research_fork_rejected:{rejected_status}:forkを作成できませんでした"));}
        let body = response.bytes().await.unwrap_or_default();
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&body[..body.len().min(MAX_BYTES)]) {
            if let Some(message) = value.get("error").and_then(|e| e.as_str()) {
                if !message.is_empty() && message.chars().count() <= 200 {

                    if action.starts_with("community_access_") && matches!(rejected_status,400|403|404|409){return Err(format!("community_access_rejected:{rejected_status}:{message}"));}


        if action == "community_invite_accept" && matches!(rejected_status,400|403|404|409){return Err(format!("community_invite_rejected:{rejected_status}:{message}"));}
                    if matches!(action,"community_governance_vote"|"community_governance_lifecycle") && matches!(rejected_status,400|403|404|409|413){return Err(format!("community_governance_mutation_rejected:{rejected_status}:{message}"));}
                    if action == "community_governance_create_proposal" && matches!(rejected_status,400|403|404|409|413){return Err(format!("community_governance_create_rejected:{rejected_status}:{message}"));}
                    if action == "community_governance_settings" && matches!(rejected_status,400|403|404|409){return Err(format!("community_governance_settings_rejected:{rejected_status}:{message}"));}
                    if action == "community_join_complete" && matches!(rejected_status,400|403|404|409){return Err(format!("community_join_rejected:{rejected_status}:{message}"));}
                    if matches!(action,"community_channel_slowmode"|"community_channel_archive") && matches!(rejected_status,400|403|404|409){return Err(format!("community_channel_policy_rejected:{rejected_status}:{message}"));}
                    if action.starts_with("community_access_") && matches!(rejected_status,400|403|404|409){return Err(format!("community_access_rejected:{rejected_status}:参加設定を保存できませんでした"));}
                    if matches!(action,"community_channel_slowmode"|"community_channel_archive") && matches!(rejected_status,400|403|404|409){return Err(format!("community_channel_policy_rejected:{rejected_status}:設定を保存できませんでした"));}
        return Err(if matches!(action,"research_discuss"|"research_git_discuss"|"research_accept"|"research_reject"|"research_propose"|"research_proposal_link"|"research_proposal_unlink") && (matches!(rejected_status,400|403|404|409)||(action=="research_propose"&&rejected_status==429)) {format!("{action}_rejected:{rejected_status}:{message}")} else {message.to_owned()});
                }
            }
        }
        if action == "community_invite_accept" && matches!(rejected_status,400|403|404|409) { return Err(format!("community_invite_rejected:{rejected_status}:参加できませんでした")); }
        if matches!(action,"community_governance_vote"|"community_governance_lifecycle") && matches!(rejected_status,400|403|404|409|413){return Err(format!("community_governance_mutation_rejected:{rejected_status}:提案の操作を保存できませんでした"));}

        if action == "community_governance_create_proposal" && matches!(rejected_status,400|403|404|409|413) { return Err(format!("community_governance_create_rejected:{rejected_status}:提案を保存できませんでした")); }
        if action == "community_governance_settings" && matches!(rejected_status,400|403|404|409) { return Err(format!("community_governance_settings_rejected:{rejected_status}:投票設定を保存できませんでした")); }
        if action == "community_join_complete" && matches!(rejected_status,400|403|404|409) { return Err(format!("community_join_rejected:{rejected_status}:参加できませんでした")); }
        return Err(if matches!(action,"research_discuss"|"research_git_discuss"|"research_accept"|"research_reject"|"research_propose"|"research_proposal_link"|"research_proposal_unlink") && (matches!(rejected_status,400|403|404|409)||(action=="research_propose"&&rejected_status==429)) {format!("{action}_rejected:{rejected_status}:操作を受け付けてもらえませんでした")} else {"操作を受け付けてもらえませんでした".to_owned()});
    }
    let body = response
        .bytes()
        .await
        .map_err(|_| "受け取れませんでした".to_owned())?;
    if body.len() > MAX_BYTES {
        return Err("応答が大きすぎます".to_owned());
    }
    serde_json::from_slice(&body).map_err(|_| "読めない形で返ってきました".to_owned())
}

/// 投稿画像を pending 画像として上げる。窓から来たのは canvas で作り直した
/// WebP のバイト列だけ——ファイルパスや元のMIMEは渡さない。サイズと形の
/// 最終判定はハブ側の createPendingImage がやるので、ここでは上限だけ見る。
#[allow(clippy::too_many_arguments)]
pub async fn post_image(
    base: &str,
    image: Vec<u8>,
    thumbnail: Vec<u8>,
    width: u32,
    height: u32,
    thumbnail_width: u32,
    thumbnail_height: u32,
    alt_text: Option<String>,
    scope_options: Option<&serde_json::Value>,
) -> Result<serde_json::Value, String> {
    post_image_request(
        base,
        "/api/client/images",
        image,
        thumbnail,
        width,
        height,
        thumbnail_width,
        thumbnail_height,
        alt_text,
        scope_options,
    )
    .await
}

/// DM 添付画像を pending 画像として上げる。投稿画像と同じ手順だが、
/// ハブ側では DM 専用の表（createPendingDmImage → /api/client/dm-images）へ入る。
#[allow(clippy::too_many_arguments)]
pub async fn post_dm_image(
    base: &str,
    image: Vec<u8>,
    thumbnail: Vec<u8>,
    width: u32,
    height: u32,
    thumbnail_width: u32,
    thumbnail_height: u32,
    alt_text: Option<String>,
    scope_options: Option<&serde_json::Value>,
) -> Result<serde_json::Value, String> {
    post_image_request(
        base,
        "/api/client/dm-images",
        image,
        thumbnail,
        width,
        height,
        thumbnail_width,
        thumbnail_height,
        alt_text,
        scope_options,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn post_image_request(
    base: &str,
    path: &str,
    image: Vec<u8>,
    thumbnail: Vec<u8>,
    width: u32,
    height: u32,
    thumbnail_width: u32,
    thumbnail_height: u32,
    alt_text: Option<String>,
    scope_options: Option<&serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let scope=scope_options.map(scoped_social_client::Scope::from_options).transpose()?;
    if let Some(scope)=&scope { scope.check(base)?; }
    // ハブ側の上限は 2MB/512KB。越えたものは送らずここで止める。
    const MAX_IMAGE: usize = 2 * 1024 * 1024;
    const MAX_THUMBNAIL: usize = 512 * 1024;
    if image.is_empty() || image.len() > MAX_IMAGE {
        return Err("画像は2MB以下にしてください".to_owned());
    }
    if thumbnail.is_empty() || thumbnail.len() > MAX_THUMBNAIL {
        return Err("サムネイルを作れませんでした".to_owned());
    }
    if width == 0 || width > 1600 || height == 0 || height > 1600 {
        return Err("画像の縦横が正しくありません".to_owned());
    }
    if thumbnail_width == 0 || thumbnail_width > 480 || thumbnail_height == 0 || thumbnail_height > 480 {
        return Err("サムネイルの縦横が正しくありません".to_owned());
    }
    let alt_text = alt_text.unwrap_or_default().chars().take(300).collect::<String>();
    let assertion = crate::desktop_account::assertion_if_registered(base)
        .await?
        .ok_or_else(|| "desktop_not_connected".to_owned())?;
    if let Some(scope)=&scope { scope.check(base)?; }
    let url = reqwest::Url::parse(&format!("{}{}", base.trim_end_matches('/'), path))
        .map_err(|_| "ハブの接続先が正しくありません".to_owned())?;
    let part = |name: &str, bytes: Vec<u8>| {
        reqwest::multipart::Part::bytes(bytes)
            .file_name(name.to_owned())
            .mime_str("image/webp")
            .unwrap_or_else(|_| reqwest::multipart::Part::bytes(Vec::new()))
    };
    let form = reqwest::multipart::Form::new()
        .part("image", part("image.webp", image))
        .part("thumbnail", part("thumbnail.webp", thumbnail))
        .text("width", width.to_string())
        .text("height", height.to_string())
        .text("thumbnailWidth", thumbnail_width.to_string())
        .text("thumbnailHeight", thumbnail_height.to_string())
        .text("altText", alt_text);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "届けられません".to_owned())?;
    let mut request = client.post(url).bearer_auth(assertion);
    if let Some(scope)=&scope { request=request.header(reqwest::header::ORIGIN,&scope.origin).header("X-Hub-Expected-Viewer",&scope.viewer); }
    let response = request.multipart(form)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "ハブが応答しません".to_owned()
            } else if error.is_connect() {
                "ハブへ接続できません".to_owned()
            } else {
                "ハブへ届きません".to_owned()
            }
        })?;
    if let Some(scope)=&scope { scope.check(base)?; }
    if response.status() == reqwest::StatusCode::CONFLICT && scope.is_some() { return Err("image_scope_conflict".into()); }
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("desktop_not_connected".to_owned());
    }
    let success = response.status().is_success();
    let body = response
        .bytes()
        .await
        .map_err(|_| "受け取れませんでした".to_owned())?;
    if body.len() > MAX_BYTES {
        return Err("応答が大きすぎます".to_owned());
    }
    if let Some(scope)=&scope { scope.check(base)?; }
    if !success {
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&body) {
            if let Some(message) = value.get("error").and_then(|e| e.as_str()) {
                if !message.is_empty() && message.chars().count() <= 200 {
                    return Err(message.to_owned());
                }
            }
        }
        return Err("画像を受け付けてもらえませんでした".to_owned());
    }
    serde_json::from_slice(&body).map_err(|_| "読めない形で返ってきました".to_owned())
}

/// DM 添付画像のバイト列を取る。窓の <img> は Bearer を付けられないので
/// Rust が取りに行き、窓は受け取ったバイト列から blob を作る。
/// 会話の参加者かどうかはハブ側が判定し、参加者以外には 404 が返る。
/// 戻り値は（バイト列, MIME）。
pub async fn fetch_dm_image(
    base: &str,
    image_id: &str,
    variant: &str,
) -> Result<(Vec<u8>, String), String> {
    let id = path_segment(Some(image_id))?;
    let variant = if variant == "full" { "full" } else { "thumbnail" };
    let url = reqwest::Url::parse(&format!(
        "{}/api/media/dm-images/{}?variant={}",
        base.trim_end_matches('/'),
        id,
        variant
    ))
    .map_err(|_| "ハブの接続先が正しくありません".to_owned())?;
    let assertion = crate::desktop_account::assertion_if_registered(base)
        .await?
        .ok_or_else(|| "desktop_not_connected".to_owned())?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|_| "取りに行けません".to_owned())?;
    let response = client
        .get(url)
        .bearer_auth(assertion)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "ハブが応答しません".to_owned()
            } else if error.is_connect() {
                "ハブへ接続できません".to_owned()
            } else {
                "ハブへ届きません".to_owned()
            }
        })?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("desktop_not_connected".to_owned());
    }
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("画像が見つかりません".to_owned());
    }
    if !response.status().is_success() {
        return Err(format!(
            "ハブが {} を返しています",
            response.status().as_u16()
        ));
    }
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .unwrap_or_else(|| "image/webp".to_owned());
    let body = response
        .bytes()
        .await
        .map_err(|_| "受け取れませんでした".to_owned())?;
    if body.len() > MAX_BYTES {
        return Err("応答が大きすぎます".to_owned());
    }
    Ok((body.to_vec(), mime))
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopSearchFilters {
    pub from: Option<String>,
    pub to: Option<String>,
    pub max_price: Option<String>,
    pub currency: Option<String>,
    pub language: Option<String>,
    pub region: Option<String>,
    pub category: Option<String>,
    pub r#type: Option<String>,
}

// ECMAScript whitespace matches the Web filter/query contract, including BOM but not NEL.
fn search_space(c: char) -> bool {
    matches!(c as u32, 0x9..=0xd | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
fn search_control(c: char) -> bool {
    matches!(c as u32, 0..=0x1f | 0x7f..=0x9f)
}
fn search_trim(value: &str) -> &str {
    value.trim_matches(search_space)
}
fn search_date(value: &str) -> bool {
    value.is_empty()
        || value.len() == 10
            && value.as_bytes()[4] == b'-'
            && value.as_bytes()[7] == b'-'
            && value
                .bytes()
                .enumerate()
                .all(|(i, c)| matches!(i, 4 | 7) || c.is_ascii_digit())
            && !value.starts_with("0000")
            && chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .is_ok_and(|date| date.to_string() == value)
}
fn search_price(value: &str, currency: &str) -> Result<String, String> {
    if value.is_empty() {
        return Ok(String::new());
    }
    let digits = if currency == "JPY" { 0 } else { 2 };
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if value.len() > 32
        || whole.is_empty()
        || !whole.bytes().all(|c| c.is_ascii_digit())
        || value.contains('.') && fraction.is_empty()
        || fraction.len() > digits
        || !fraction.bytes().all(|c| c.is_ascii_digit())
    {
        return Err("上限価格が正しくありません".into());
    }
    let whole = whole
        .parse::<u128>()
        .map_err(|_| "上限価格が正しくありません")?;
    let minor = whole.checked_mul(10u128.pow(digits as u32)).and_then(|n| {
        fraction
            .parse::<u128>()
            .unwrap_or(0)
            .checked_mul(10u128.pow((digits - fraction.len()) as u32))
            .and_then(|f| n.checked_add(f))
    });
    if !minor.is_some_and(|n| n <= 9_007_199_254_740_991) {
        return Err("上限価格が正しくありません".into());
    }
    let fraction = fraction.trim_end_matches('0');
    Ok(format!(
        "{whole}{}",
        if fraction.is_empty() {
            String::new()
        } else {
            format!(".{fraction}")
        }
    ))
}
fn search_metadata(value: &str) -> Result<Option<String>, String> {
    use unicode_normalization::UnicodeNormalization;
    if value.chars().any(search_control) {
        return Err("検索条件が正しくありません".into());
    }
    let normalized = value
        .nfkc()
        .collect::<String>()
        .split(search_space)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if normalized.encode_utf16().count() > 80 {
        return Err("検索条件は80文字以内で指定してください".into());
    }
    Ok((!normalized.is_empty()).then_some(normalized))
}
impl DesktopSearchFilters {
    pub fn normalized(&self) -> Result<Self, String> {
        let (from, to) = (
            search_trim(self.from.as_deref().unwrap_or("")),
            search_trim(self.to.as_deref().unwrap_or("")),
        );
        if !search_date(from) || !search_date(to) || !from.is_empty() && !to.is_empty() && from > to
        {
            return Err("検索期間が正しくありません".into());
        }
        let currency = search_trim(self.currency.as_deref().unwrap_or("")).to_uppercase();
        let currency = if currency.is_empty() {
            "JPY"
        } else {
            currency.as_str()
        };
        if !["JPY", "USD", "EUR"].contains(&currency) {
            return Err("通貨が正しくありません".into());
        }
        let price = search_price(
            search_trim(self.max_price.as_deref().unwrap_or("")),
            currency,
        )?;
        let language = search_trim(self.language.as_deref().unwrap_or("")).to_lowercase();
        let language = match language.as_str() {
            "" | "any" | "all" => None,
            "zh" | "zh-cn" => Some("zh-CN".into()),
            "ja" | "en" | "ko" | "es" | "fr" | "de" | "pt" | "ar" | "hi" | "other" => {
                Some(language)
            }
            _ => return Err("言語が正しくありません".into()),
        };
        let kind = search_trim(self.r#type.as_deref().unwrap_or("")).to_lowercase();
        let kind = match kind.as_str() {
            "" | "any" | "all" => None,
            "boards" | "profiles" | "threads" | "posts" | "images" | "hubpedia" | "communities"
            | "videos" | "lists" | "tokens" | "work" | "listings" => Some(kind),
            _ => return Err("種類が正しくありません".into()),
        };
        Ok(Self {
            from: (!from.is_empty()).then(|| from.into()),
            to: (!to.is_empty()).then(|| to.into()),
            currency: Some(if price.is_empty() { "JPY" } else { currency }.into()),
            max_price: (!price.is_empty()).then_some(price),
            language,
            region: search_metadata(self.region.as_deref().unwrap_or(""))?,
            category: search_metadata(self.category.as_deref().unwrap_or(""))?,
            r#type: kind,
        })
    }
}
fn search_query(value: &str) -> Result<String, String> {
    use unicode_normalization::UnicodeNormalization;
    if value.chars().any(|c| search_control(c) && !search_space(c)) {
        return Err("検索語が正しくありません".into());
    }
    let normalized = value.nfkc().collect::<String>();
    let query = search_trim(&normalized).to_lowercase();
    if query.encode_utf16().count() > 100
        || query
            .split(search_space)
            .filter(|part| !part.is_empty())
            .count()
            > 8
    {
        return Err("検索語は100文字・8語以内で指定してください".into());
    }
    Ok(query)
}
fn search_cursor(value: &str) -> bool {
    use base64::Engine;
    if value.len() > 4096 {
        return false;
    }
    let Some((payload, signature)) = value.split_once('.') else {
        return false;
    };
    let token = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
    };
    token(payload)
        && signature.len() == 43
        && token(signature)
        && base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload)
            .is_ok()
        && base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(signature)
            .is_ok_and(|bytes| bytes.len() == 32)
}
/// The signed cursor remains opaque: the server verifies its signature, filters and query scope.
pub fn search_resource_url(
    base: &str,
    query: &str,
    cursor: Option<&str>,
    order: Option<&str>,
    filters: Option<&DesktopSearchFilters>,
) -> Result<reqwest::Url, String> {
    let query = search_query(query)?;
    let filters = filters.cloned().unwrap_or_default().normalized()?;
    let order = order.unwrap_or("recommended");
    if !["recommended", "kind"].contains(&order) {
        return Err("並び順が正しくありません".into());
    }
    let cursor = cursor.filter(|value| !value.is_empty());
    if cursor.is_some_and(|value| !search_cursor(value)) {
        return Err("検索の続きの指定が正しくありません".into());
    }
    let mut url = reqwest::Url::parse(base).map_err(|_| "ハブの接続先が正しくありません")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https"
            || url.scheme() == "http" && matches!(url.host_str(), Some("localhost" | "127.0.0.1")))
    {
        return Err("ハブの接続先が正しくありません".into());
    }
    url.set_path("/api/search");
    let mut pairs = url.query_pairs_mut();
    pairs
        .append_pair("cursorMode", "1")
        .append_pair("order", order);
    if !query.is_empty() {
        pairs.append_pair("q", &query);
    }
    if let Some(cursor) = cursor {
        pairs.append_pair("cursor", cursor);
    }
    for (key, value) in [
        ("from", &filters.from),
        ("to", &filters.to),
        ("maxPrice", &filters.max_price),
        ("language", &filters.language),
        ("region", &filters.region),
        ("category", &filters.category),
        ("type", &filters.r#type),
    ] {
        if let Some(value) = value {
            pairs.append_pair(key, value);
        }
    }
    if filters.max_price.is_some() {
        pairs.append_pair("currency", filters.currency.as_deref().unwrap_or("JPY"));
    }
    drop(pairs);
    Ok(url)
}

#[cfg(test)]
mod desktop_search_filter_tests {
    use super::*;
    #[test]
    fn list_feed_is_a_viewer_aware_fixed_path_for_one_list_id() {
        let (path, auth) = detail_path("list_feed").unwrap();
        assert!(auth);
        assert_eq!(fill_path(path, &["list-1".to_owned()]).unwrap(), "/api/lists/list-1/feed");
        assert!(fill_path(path, &["../x".to_owned()]).is_err());
    }
    #[test]
    fn sidebar_paths_take_only_known_kinds_and_url_safe_cursors() {
        let (sidebar, auth) = detail_path("sidebar").unwrap();
        assert!(auth);
        assert_eq!(fill_path(sidebar, &["videos".to_owned()]).unwrap(), "/api/client/sidebar/videos");
        let page = detail_path("sidebar_page").unwrap().0;
        assert_eq!(fill_path(page, &["feed".to_owned(), "YWJj-_9".to_owned()]).unwrap(), "/api/client/sidebar/feed/YWJj-_9");
        let feed = detail_path("subscriptions").unwrap().0;
        assert_eq!(fill_path(feed, &["music".to_owned()]).unwrap(), "/api/client/subscriptions/music");
        for bad in [vec!["admin".to_owned()], vec!["videos".to_owned(), "x".to_owned()], vec!["../me".to_owned()]] {
            assert!(fill_path(sidebar, &bad).is_err());
        }
        assert!(fill_path(feed, &["feed".to_owned()]).is_err());
        for bad in ["a/b", "a?b", "a%2F", "a=b", ""] {
            assert!(fill_path(page, &["feed".to_owned(), bad.to_owned()]).is_err(), "{bad}");
        }
        assert!(fill_path(page, &["feed".to_owned(), "a".repeat(201)]).is_err());
    }

    #[test]
    fn filters_are_search_only_and_existing_video_and_board_arguments_survive() {
        let filters = DesktopSearchFilters::default();
        for resource in [
            "music",
            "threads",
            "articles",
            "videos",
            "market",
            "research",
            "hubpedia_catalog",
        ] {
            assert!(resource_url(
                "https://hub.example",
                resource,
                "",
                None,
                None,
                None,
                None,
                None,
                Some(&filters)
            )
            .is_err());
        }
        let video = resource_url(
            "https://hub.example",
            "videos",
            "title",
            None,
            None,
            Some(50),
            Some("映画"),
            Some("popular"),
            None,
        )
        .unwrap();
        let values = video
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(video.path(), "/api/videos");
        assert_eq!(values["order"], "popular");
        assert_eq!(values["category"], "映画");
        assert_eq!(values["offset"], "50");
        assert!(resource_url(
            "https://hub.example",
            "videos",
            "",
            None,
            None,
            None,
            None,
            Some("recommended"),
            None
        )
        .is_err());
        let thread = resource_url(
            "https://hub.example",
            "threads",
            "",
            None,
            Some("board_1"),
            Some(3),
            None,
            None,
            None,
        )
        .unwrap();
        let values = thread
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(values["boardKey"], "board_1");
        assert_eq!(values["offset"], "3");
        assert_eq!(values["limit"], "50");
        assert!(resource_url(
            "https://hub.example",
            "/api/admin",
            "",
            None,
            None,
            None,
            None,
            None,
            None
        )
        .is_err());
    }
    fn filters(value: serde_json::Value) -> DesktopSearchFilters {
        serde_json::from_value(value).unwrap()
    }
    #[test]
    fn exact_typed_fields_and_aliases_match_web() {
        for value in [
            serde_json::json!({"unknown":"x"}),
            serde_json::json!({"maxPrice":0}),
            serde_json::json!({"language":[]}),
            serde_json::json!({"from":true}),
        ] {
            assert!(serde_json::from_value::<DesktopSearchFilters>(value).is_err());
        }
        let parsed=filters(serde_json::json!({"language":" ZH ","type":" VIDEOS ","currency":" usd ","maxPrice":"000.00"})).normalized().unwrap();
        assert_eq!(parsed.language.as_deref(), Some("zh-CN"));
        assert_eq!(parsed.r#type.as_deref(), Some("videos"));
        assert_eq!(parsed.currency.as_deref(), Some("USD"));
        assert_eq!(parsed.max_price.as_deref(), Some("0"));
        for value in ["any", "all", ""] {
            let parsed =
                filters(serde_json::json!({"language":value,"type":value,"currency":"USD"}))
                    .normalized()
                    .unwrap();
            assert!(parsed.language.is_none() && parsed.r#type.is_none());
            assert_eq!(parsed.currency.as_deref(), Some("JPY"));
        }
        for value in [
            serde_json::json!({"currency":"BTC"}),
            serde_json::json!({"language":"zz"}),
            serde_json::json!({"type":"admin"}),
        ] {
            assert!(filters(value).normalized().is_err());
        }
    }
    #[test]
    fn date_real_gregorian_and_order_boundaries() {
        for value in ["0001-01-01", "2000-02-29", "2024-02-29", "9999-12-31"] {
            assert!(filters(serde_json::json!({"from":value,"to":value}))
                .normalized()
                .is_ok());
        }
        for value in [
            "0000-01-01",
            "1900-02-29",
            "2023-02-29",
            "2024-04-31",
            "2024-13-01",
            "2024-1-01",
            "+2024-01-01",
            "2024-01-01x",
        ] {
            assert!(
                filters(serde_json::json!({"from":value}))
                    .normalized()
                    .is_err(),
                "{value}"
            );
        }
        assert!(
            filters(serde_json::json!({"from":"2024-02-02","to":"2024-02-01"}))
                .normalized()
                .is_err()
        );
    }
    #[test]
    fn prices_use_currency_minor_units_safe_integers_and_canonical_zero() {
        for (value, currency, expected) in [
            ("000", "JPY", "0"),
            ("0001.20", "USD", "1.2"),
            ("00.01", "EUR", "0.01"),
            ("9007199254740991", "JPY", "9007199254740991"),
            ("90071992547409.91", "USD", "90071992547409.91"),
            ("00000000000000000000000000000000", "JPY", "0"),
        ] {
            assert_eq!(search_price(value, currency).unwrap(), expected);
        }
        for (value, currency) in [
            ("1.0", "JPY"),
            ("1.001", "USD"),
            ("9007199254740992", "JPY"),
            ("90071992547409.92", "USD"),
            ("-1", "USD"),
            ("1e3", "JPY"),
            ("1.", "USD"),
            (".1", "USD"),
            ("1..0", "USD"),
            ("１２", "JPY"),
            ("1,000", "JPY"),
        ] {
            assert!(search_price(value, currency).is_err(), "{value}");
        }
        assert!(search_price(&"0".repeat(33), "JPY").is_err());
    }
    #[test]
    fn metadata_nfkc_whitespace_case_and_utf16_expansion_bounds() {
        assert_eq!(
            search_metadata("\u{feff} ＴＯＫＹＯ　  Book \u{feff}")
                .unwrap()
                .as_deref(),
            Some("tokyo book")
        );
        assert_eq!(search_metadata("ΟΣ").unwrap().as_deref(), Some("ος"));
        assert!(search_metadata(&"🧪".repeat(40)).is_ok());
        assert!(search_metadata(&format!("{}x", "🧪".repeat(40))).is_err());
        assert!(search_metadata(&"a".repeat(80)).is_ok());
        assert!(search_metadata(&"a".repeat(81)).is_err());
        assert!(search_metadata(&"㌖".repeat(20)).is_err());
        for value in ["a\n", "a\t", "a\0", "a\u{85}", "a\u{7f}"] {
            assert!(search_metadata(value).is_err());
        }
    }
    #[test]
    fn query_is_normalized_before_limits_and_never_truncated() {
        assert_eq!(
            search_query("\u{feff} ＨＵＢ　Search \u{feff}").unwrap(),
            "hub search"
        );
        assert_eq!(search_query("a\tb\nc").unwrap(), "a\tb\nc");
        assert!(search_query(&"🧪".repeat(50)).is_ok());
        assert!(search_query(&format!("{}x", "🧪".repeat(50))).is_err());
        assert!(search_query(&"㌖".repeat(20)).is_err());
        assert_eq!(search_query("ΟΣ").unwrap(), "ος");
        assert!(search_query("a b c d e f g h").is_ok());
        assert!(search_query("a b c d e f g h i").is_err());
        for value in ["a\0", "a\u{85}", "a\u{7f}"] {
            assert!(search_query(value).is_err());
        }
    }
    #[test]
    fn cursor_shape_ascii_and_whole_token_limit() {
        let signature = "A".repeat(43);
        assert!(search_cursor(&format!("e30.{signature}")));
        assert!(search_cursor(&format!("{}.{signature}", "A".repeat(4052))));
        assert!(!search_cursor(&format!("{}.{signature}", "A".repeat(4053))));
        for value in [
            "", "a", "a.b", ".abc", "abc.", "e30.A.A", "e30/AAA", "e30=", "e30.%2e", "e30.é",
        ] {
            assert!(!search_cursor(value));
        }
        assert!(!search_cursor(&format!("e30.{signature}\n")));
        assert!(!search_cursor(&format!("e30.{}B", "A".repeat(42))));
    }
    #[test]
    fn url_keeps_fixed_scope_filters_and_cursors_without_expanding_query_pairs() {
        let filter = filters(
            serde_json::json!({"from":"2024-01-01","to":"2024-01-31","maxPrice":"000.00","currency":"usd","language":"zh","region":"Ａ　B","category":"x&scope=admin","type":"listings"}),
        );
        let cursor = format!("e30.{}", "A".repeat(43));
        let url = search_resource_url(
            "http://localhost:3020/",
            " Ｘ&role=admin # / ",
            Some(&cursor),
            Some("kind"),
            Some(&filter),
        )
        .unwrap();
        assert_eq!(url.path(), "/api/search");
        assert_eq!(url.host_str(), Some("localhost"));
        assert!(url.fragment().is_none());
        let pairs = url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(pairs.len(), 12);
        assert_eq!(pairs["q"], "x&role=admin # /");
        assert_eq!(pairs["maxPrice"], "0");
        assert_eq!(pairs["currency"], "USD");
        assert_eq!(pairs["region"], "a b");
        assert_eq!(pairs["category"], "x&scope=admin");
        assert_eq!(pairs["cursor"], cursor);
        assert_eq!(pairs["language"], "zh-CN");
        assert_eq!(pairs["type"], "listings");
        assert_eq!(pairs["order"], "kind");
        let url = search_resource_url(
            "https://hub.example",
            "",
            None,
            None,
            Some(&filters(serde_json::json!({"region":"東京"}))),
        )
        .unwrap();
        assert_eq!(url.query_pairs().count(), 3);
        assert!(
            search_resource_url("https://hub.example", "", None, Some("recent"), None).is_err()
        );
        for base in [
            "https://hub.example/admin",
            "https://user@hub.example",
            "https://hub.example/?path=/api/admin",
            "https://hub.example/#x",
            "http://remote.example/",
        ] {
            assert!(search_resource_url(base, "", None, None, None).is_err());
        }
    }
}

const GITHUB_RESOURCE_MAX_BYTES: usize = 1024 * 1024;
const GITHUB_RESOURCE_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const GITHUB_RESOURCE_INVALID: &str = "github_repository_invalid";
const GITHUB_RESOURCE_UNAVAILABLE: &str = "github_repository_unavailable";

fn github_repository_name(raw: &str) -> Result<String, String> {
    let (owner, name) = raw.split_once('/').ok_or(GITHUB_RESOURCE_INVALID)?;
    if !(1..=39).contains(&owner.len()) || !(1..=100).contains(&name.len())
        || !owner.as_bytes()[0].is_ascii_alphanumeric() || !owner.as_bytes()[owner.len()-1].is_ascii_alphanumeric()
        || !owner.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b)) || matches!(name, "." | "..") {
        return Err(GITHUB_RESOURCE_INVALID.into());
    }
    Ok(raw.to_ascii_lowercase())
}

fn github_resource_url(base: &str, query: &str, cursor: Option<&str>, board: Option<&str>, offset: Option<u32>, category: Option<&str>, order: Option<&str>, filters: bool) -> Result<reqwest::Url, String> {
    if cursor.is_some() || board.is_some() || offset.is_some() || category.is_some() || order.is_some() || filters {
        return Err(GITHUB_RESOURCE_INVALID.into());
    }
    let repository = github_repository_name(query)?;
    let mut url = reqwest::Url::parse(base).map_err(|_| GITHUB_RESOURCE_INVALID)?;
    let loopback = url.host_str().is_some_and(|host| ["localhost", "127.0.0.1", "[::1]", "::1"].contains(&host));
    if base.len() > 512 || !(url.scheme() == "https" || url.scheme() == "http" && loopback)
        || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some()
        || url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err(GITHUB_RESOURCE_INVALID.into());
    }
    url.set_path("/api/client/github/repository");
    url.query_pairs_mut().append_pair("repo", &repository);
    Ok(url)
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all="snake_case")]
enum GithubReadStatus { Ok, Unavailable, RateLimited }
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all="snake_case")]
enum GithubOverviewStatus { Ok, Partial, Unavailable, RateLimited }
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct GithubRepository { name: String, href: String, description: String, default_branch: String, stars: u64 }
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct GithubIssue { number: u64, title: String, href: String }
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct GithubCommit { oid: String, title: String, href: String }
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct GithubCategories { issues: GithubReadStatus, pull_requests: GithubReadStatus, commits: GithubReadStatus }
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct GithubOverview {
    status: GithubOverviewStatus,
    #[serde(deserialize_with="github_required_option")] repository: Option<GithubRepository>,
    #[serde(deserialize_with="github_required_option")] issues: Option<Vec<GithubIssue>>,
    #[serde(deserialize_with="github_required_option")] pull_requests: Option<Vec<GithubIssue>>,
    #[serde(deserialize_with="github_required_option")] commits: Option<Vec<GithubCommit>>,
    category_statuses: GithubCategories,
}
fn github_required_option<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(deserializer: D) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(deserializer)
}
fn github_text(value: &str, limit: usize, empty: bool) -> bool {
    (empty || !value.trim().is_empty()) && value.encode_utf16().count() <= limit && !value.chars().any(char::is_control)
}
fn github_issues(items: &Option<Vec<GithubIssue>>, status: GithubReadStatus, repository: &str, kind: &str) -> bool {
    match (items, status) {
        (Some(items), GithubReadStatus::Ok) => items.len() <= 20 && items.iter().all(|item| item.number > 0
            && item.number <= GITHUB_RESOURCE_SAFE_INTEGER && github_text(&item.title, 300, false)
            && item.href == format!("https://github.com/{repository}/{kind}/{}", item.number)),
        (None, GithubReadStatus::Unavailable | GithubReadStatus::RateLimited) => true,
        _ => false,
    }
}
fn github_response(status: u16, repository: &str, body: &[u8]) -> Result<serde_json::Value, String> {
    if body.len() > GITHUB_RESOURCE_MAX_BYTES || ![200, 429, 503].contains(&status) { return Err(GITHUB_RESOURCE_UNAVAILABLE.into()); }
    let dto: GithubOverview = serde_json::from_slice(body).map_err(|_| GITHUB_RESOURCE_UNAVAILABLE)?;
    let categories = &dto.category_statuses;
    let all_ok = categories.issues == GithubReadStatus::Ok && categories.pull_requests == GithubReadStatus::Ok && categories.commits == GithubReadStatus::Ok;
    let valid = if status == 200 {
        matches!(dto.status, GithubOverviewStatus::Ok) && all_ok || matches!(dto.status, GithubOverviewStatus::Partial) && !all_ok
    } else {
        let (expected, category) = if status == 429 { (GithubOverviewStatus::RateLimited, GithubReadStatus::RateLimited) }
            else { (GithubOverviewStatus::Unavailable, GithubReadStatus::Unavailable) };
        dto.status == expected && dto.repository.is_none() && dto.issues.is_none() && dto.pull_requests.is_none() && dto.commits.is_none()
            && [categories.issues, categories.pull_requests, categories.commits].iter().all(|value| *value == category)
    };
    if !valid { return Err(GITHUB_RESOURCE_UNAVAILABLE.into()); }
    if status == 200 {
        let info = dto.repository.as_ref().ok_or(GITHUB_RESOURCE_UNAVAILABLE)?;
        if info.name != repository || info.href != format!("https://github.com/{repository}")
            || !github_text(&info.description, 1000, true) || !github_text(&info.default_branch, 128, false)
            || info.stars > GITHUB_RESOURCE_SAFE_INTEGER || categories.issues != categories.pull_requests
            || !github_issues(&dto.issues, categories.issues, repository, "issues")
            || !github_issues(&dto.pull_requests, categories.pull_requests, repository, "pull")
            || dto.issues.as_ref().map_or(0, Vec::len) + dto.pull_requests.as_ref().map_or(0, Vec::len) > 20 {
            return Err(GITHUB_RESOURCE_UNAVAILABLE.into());
        }
        let commits_valid = match (&dto.commits, categories.commits) {
            (Some(items), GithubReadStatus::Ok) => items.len() <= 5 && items.iter().all(|item|
                [40, 64].contains(&item.oid.len()) && item.oid.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                && github_text(&item.title, 300, false) && item.href == format!("https://github.com/{repository}/commit/{}", item.oid)),
            (None, GithubReadStatus::Unavailable | GithubReadStatus::RateLimited) => true,
            _ => false,
        };
        if !commits_valid { return Err(GITHUB_RESOURCE_UNAVAILABLE.into()); }
    }
    serde_json::to_value(dto).map_err(|_| GITHUB_RESOURCE_UNAVAILABLE.into())
}
async fn fetch_github_resource(url: reqwest::Url) -> Result<serde_json::Value, String> {
    let repository = url.query_pairs().find(|(key, _)| key == "repo").map(|(_, value)| value.into_owned()).ok_or(GITHUB_RESOURCE_INVALID)?;
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none()).no_proxy().build().map_err(|_| GITHUB_RESOURCE_UNAVAILABLE)?;
    // This public branch never obtains an Account assertion, cookie or provider credential.
    let mut response = client.get(url).header(reqwest::header::ACCEPT, "application/json").send().await.map_err(|_| GITHUB_RESOURCE_UNAVAILABLE)?;
    let status = response.status().as_u16();
    if ![200, 429, 503].contains(&status) || response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next()).is_none_or(|value| !value.trim().eq_ignore_ascii_case("application/json"))
        || response.content_length().is_some_and(|length| length > GITHUB_RESOURCE_MAX_BYTES as u64) {
        return Err(GITHUB_RESOURCE_UNAVAILABLE.into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| GITHUB_RESOURCE_UNAVAILABLE)? {
        if body.len().checked_add(chunk.len()).is_none_or(|size| size > GITHUB_RESOURCE_MAX_BYTES) { return Err(GITHUB_RESOURCE_UNAVAILABLE.into()); }
        body.extend_from_slice(&chunk);
    }
    github_response(status, &repository, &body)
}

fn resource_url(
    base: &str, resource: &str, query: &str, cursor: Option<&str>, board_key: Option<&str>, offset: Option<u32>, category: Option<&str>, order: Option<&str>, search_filters: Option<&DesktopSearchFilters>,
) -> Result<reqwest::Url, String> {
    if resource == "github_repository" { return github_resource_url(base,query,cursor,board_key,offset,category,order,search_filters.is_some()); }
    if resource == "search" {return search_resource_url(base,query,cursor,order,search_filters);}
    if search_filters.is_some() {return Err("検索条件はHub検索だけに指定できます".into());}
    let path = resource_path(resource).ok_or_else(|| "この機能は許可されていません".to_owned())?;
    let mut url = reqwest::Url::parse(&format!("{}{}", base.trim_end_matches('/'), path))
        .map_err(|_| "ハブの接続先が正しくありません".to_owned())?;
    let query = query.trim();
    if !query.is_empty() {
        url.query_pairs_mut()
            .append_pair("q", &query.chars().take(100).collect::<String>());
    }
    if resource == "threads" {
        if let Some(board_key) = board_key {
            url.query_pairs_mut().append_pair("boardKey", &path_segment(Some(board_key))?);
        }
    }
    if matches!(resource, "music" | "threads" | "articles" | "market" | "research" | "hubpedia_catalog") {
        if query.encode_utf16().count() > 100 || query.split_whitespace().count() > 8 {
            return Err("検索語は100文字・8語以内で指定してください".to_owned());
        }
        url.query_pairs_mut().append_pair("limit", "50").append_pair("offset", &offset.unwrap_or(0).to_string());
        if resource == "hubpedia_catalog" { url.query_pairs_mut().append_pair("pageMode", "1"); }
    } else if resource == "videos" {
        let category = category.unwrap_or("").trim();
        let order = order.unwrap_or("recent");
        if query.encode_utf16().count() > 100 || query.split_whitespace().count() > 8 || category.encode_utf16().count() > 100 || !["recent", "popular", "live"].contains(&order) {
            return Err("検索条件が正しくありません".to_owned());
        }
        url.query_pairs_mut().append_pair("limit", "50")
            .append_pair("offset", &offset.unwrap_or(0).to_string())
            .append_pair("category", category).append_pair("order", order);
    } else if resource == "hubpedia" {
        url.query_pairs_mut().append_pair("limit", "20");
    } else if resource == "hubpedia_retrieve" {
        url.query_pairs_mut().append_pair("limit", "8");

    }
    Ok(url)
}

pub async fn fetch_resource(
    base: &str,
    resource: &str,
    query: &str,
    cursor: Option<&str>,
    board_key: Option<&str>,
    offset: Option<u32>,
    category: Option<&str>,
    order: Option<&str>,
    search_filters: Option<&DesktopSearchFilters>,
) -> Result<serde_json::Value, String> {
    let url = resource_url(base,resource,query,cursor,board_key,offset,category,order,search_filters)?;
    if resource == "github_repository" { return fetch_github_resource(url).await; }

    // viewer対応の面（コミュニティの参加中・ワールドの自分のサーバ）だけ
    // assertionを添えて個人化を効かせる。純粋な公開カタログまで毎回発行
    // すると往復が増えるだけなので絞る。発行に失敗しても公開情報は取れる
    // ので、そのときは名無しのまま進める。
    let assertion = if matches!(resource, "communities" | "world" | "research") {
        crate::desktop_account::assertion_if_registered(base)
            .await
            .ok()
            .flatten()
    } else {
        None
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|_| "取りに行けません".to_owned())?;
    let mut request = client.get(url);
    if let Some(assertion) = assertion {
        request = request.bearer_auth(assertion);
    }
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            "ハブが応答しません".to_owned()
        } else if error.is_connect() {
            "ハブへ接続できません".to_owned()
        } else {
            "ハブへ届きません".to_owned()
        }
    })?;
    if !response.status().is_success() {
        return Err(format!(
            "ハブが {} を返しています",
            response.status().as_u16()
        ));
    }
    let body = response
        .bytes()
        .await
        .map_err(|_| "受け取れませんでした".to_owned())?;
    if body.len() > MAX_BYTES {
        return Err("応答が大きすぎます".to_owned());
    }
    serde_json::from_slice(&body).map_err(|_| "読めない形で返ってきました".to_owned())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedImage {
    pub id: String,
    pub url: String,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    #[serde(default)]
    pub alt_text: String,
}

/// 引用・リポスト・返信元の札。href は Hub 内のパスなので、
/// 開くときは hub_origin に繋いでブラウザ面へ送る。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedReference {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub href: String,
    #[serde(default)]
    pub context_label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedPost {
    pub id: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub author_name: String,
    #[serde(default)]
    pub author_handle: Option<String>,
    #[serde(default)]
    pub author_profile_id: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub reply_count: u32,
    #[serde(default)]
    pub repost_count: u32,
    #[serde(default)]
    pub like_count: u32,
    #[serde(default)]
    pub liked_by_viewer: bool,
    #[serde(default)]
    pub bookmarked_by_viewer: bool,
    #[serde(default)]
    pub viewer_repost_id: Option<String>,
    #[serde(default)]
    pub images: Vec<FeedImage>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub referenced: Option<FeedReference>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Feed {
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub signed_in: bool,
    #[serde(default)]
    pub posts: Vec<FeedPost>,
    #[serde(default)]
    pub research_updates: Vec<ResearchUpdate>,
    #[serde(default)]
    pub has_more: bool,
    #[serde(default)]
    pub next_cursor: Option<String>,
    #[serde(default)]
    pub next_offset: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchUpdate {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub href: String,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub project_title: String,
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub updated_at: String,
}

/// 読む範囲。知らない語はここで落とす。
///
/// 端末から来た文字列をそのまま問い合わせに繋げない。ハブ側でも見ているが、
/// 両側で見る。片方の絞り込みが緩んだときに、もう片方が残る。
pub fn safe_scope(raw: &str) -> &'static str {
    match raw {
        "latest" => "latest",
        "following" => "following",
        "popular" => "popular",
        "recommended" => "recommended",
        _ => "all",
    }
}

fn feed_auth(scope: &str, assertion: Result<Option<String>, String>) -> Result<Option<String>, String> {
    if safe_scope(scope) == "following" {
        assertion?.ok_or_else(|| "desktop_not_connected".to_owned()).map(Some)
    } else {
        // Public feeds remain readable when the optional account service is down.
        Ok(assertion.ok().flatten())
    }
}

pub fn feed_url(base: &str, scope: &str, limit: u32, offset: u32, cursor: Option<&str>) -> String {
    let mut url = match reqwest::Url::parse(&format!("{}/api/client/feed", base.trim_end_matches('/'))) {
        Ok(url) => url,
        // 基底URLは hub_window で検証済みのはず。万一おかしければ、
        // ページネーションを落とした素直な問い合わせに退く——panicはしない。
        Err(_) => {
            return format!(
                "{}/api/client/feed?scope={}&limit={}",
                base.trim_end_matches('/'),
                safe_scope(scope),
                limit.clamp(1, MAX_LIMIT)
            );
        }
    };
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("scope", safe_scope(scope));
        pairs.append_pair("limit", &limit.clamp(1, MAX_LIMIT).to_string());
        if offset > 0 {
            pairs.append_pair("offset", &offset.to_string());
        }
        // カーソルはハブが発行した opaque な値をそのまま返す。長いものは
        // ハブ側が512字で切るので、ここでも同じ長さで止める。
        if let Some(value) = cursor.map(str::trim).filter(|value| !value.is_empty() && value.len() <= 512) {
            pairs.append_pair("cursor", value);
        }
    }
    url.into()
}

/// 取りに行く。
///
/// 届かないことは普通に起きる（ハブが未公開、電波が無い、寝ている）。
/// 落ちるのではなく、理由を返して画面に出せるようにする。
pub async fn fetch_feed(
    base: &str,
    scope: &str,
    limit: u32,
    offset: u32,
    cursor: Option<&str>,
) -> Result<Feed, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|_| "取りに行けません".to_owned())?;
    let mut request = client.get(feed_url(base, scope, limit, offset, cursor));
    if let Some(assertion) = feed_auth(scope, crate::desktop_account::assertion_if_registered(base).await)? {
        request = request.bearer_auth(assertion);
    }
    let response = request.send().await.map_err(|error| {
        if error.is_timeout() {
            "ハブが応答しません".to_owned()
        } else if error.is_connect() {
            "ハブへ接続できません".to_owned()
        } else {
            "ハブへ届きません".to_owned()
        }
    })?;
    if !response.status().is_success() {
        return Err(format!(
            "ハブが {} を返しています",
            response.status().as_u16()
        ));
    }
    let body = response
        .bytes()
        .await
        .map_err(|_| "受け取れませんでした".to_owned())?;
    if body.len() > MAX_BYTES {
        return Err("応答が大きすぎます".to_owned());
    }
    serde_json::from_slice(&body).map_err(|_| "読めない形で返ってきました".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn community_access_paths_and_payload_bounds_are_fixed(){
        let op="00000000-0000-0000-0000-000000000000";
        let input=serde_json::json!({"note":"変更の理由です","label":"招待","maxUses":25,"expiresInDays":7,"ignored":"secret"});
        let (_,path,body)=action_request("community_access_create_invite",Some("community"),None,Some(op),Some(&input)).unwrap();assert_eq!(path,"/api/client/communities/community/access-management");assert_eq!(body["operationId"],op);assert!(body.get("ignored").is_none());
        let template=detail_path("community_access_management_page").unwrap().0;
        assert_eq!(fill_path(template,&["community".to_owned(),"invites".to_owned(),"20".to_owned()]).unwrap(),"/api/client/communities/community/access-management?kind=invites&offset=20");
        for values in [["community","unknown","0"],["community","rules","9007199254740972"],["community\n","rules","0"]]{assert!(fill_path(template,&values.map(str::to_owned)).is_err());}
        for key in ["maxUses","expiresInDays"]{let mut bad=input.clone();bad[key]=serde_json::json!("25");assert!(action_request("community_access_create_invite",Some("community"),None,Some(op),Some(&bad)).is_err());}
        let mut bad=input.clone();bad["note"]=serde_json::json!("😀".repeat(501));assert!(action_request("community_access_create_invite",Some("community"),None,Some(op),Some(&bad)).is_err());
        assert!(action_request("community_access_create_invite",Some("community"),None,None,Some(&input)).is_err());assert!(action_request("community_access_create_invite",Some("community\n"),None,Some(op),Some(&input)).is_err());
        let rule=serde_json::json!({"note":"変更の理由です","title":"題名","body":"本文"});assert!(action_request("community_access_create_rule",Some("community"),None,Some(op),Some(&rule)).is_ok());
        let question=serde_json::json!({"note":"変更の理由です","prompt":"質問","required":true});assert!(action_request("community_access_create_onboarding_question",Some("community"),None,Some(op),Some(&question)).is_ok());
    }
    #[test]
    fn channel_policy_paths_payloads_and_unicode_bounds_are_fixed() {
        let operation="12345678-1234-4234-8234-123456789abc";
        let options=serde_json::json!({"channelId":"channel_1","note":"  ＡＢＣＤＥ  ","expectedSlowmodeSeconds":0,"expectedArchivedAt":null,"slowmodeSeconds":30,"extra":"discard"});
        let (_,path,body)=action_request("community_channel_slowmode",Some("community"),None,Some(operation),Some(&options)).unwrap();
        assert_eq!(path,"/api/client/communities/community/channels/policy");assert_eq!(body["note"],"ABCDE");assert_eq!(body["operationId"],operation);assert!(body.get("extra").is_none());
        let template=detail_path("community_channel_policy_page").unwrap().0;
        assert_eq!(fill_path(template,&["community".into(),"20".into()]).unwrap(),format!("{path}?offset=20"));
        assert!(fill_path(template,&["community".into(),"01".into()]).is_err());
        assert!(fill_path(template,&["community".into(),"9007199254740972".into()]).is_err());
        assert!(fill_path(template,&["community".into(),"9007199254740971".into()]).is_ok());
        for key in ["slowmodeSeconds","expectedSlowmodeSeconds"]{let mut bad=options.clone();bad[key]=serde_json::json!("30");assert!(action_request("community_channel_slowmode",Some("community"),None,Some(operation),Some(&bad)).is_err());}
        let mut bad=options.clone();bad["note"]=serde_json::json!("😀".repeat(501));assert!(action_request("community_channel_slowmode",Some("community"),None,Some(operation),Some(&bad)).is_err());
        bad=options.clone();bad["expectedArchivedAt"]=serde_json::json!("not-a-date");assert!(action_request("community_channel_slowmode",Some("community"),None,Some(operation),Some(&bad)).is_err());
        assert!(action_request("community_channel_slowmode",Some("community"),None,None,Some(&options)).is_err());
        let archive=serde_json::json!({"channelId":"channel_1","note":"Archive reason","expectedSlowmodeSeconds":0,"expectedArchivedAt":null,"archived":true});
        assert_eq!(action_request("community_channel_archive",Some("community"),None,Some(operation),Some(&archive)).unwrap().2["action"],"set_channel_archived");
    }

    #[test]
    fn private_proposal_discussion_paths_and_actions_are_fixed() {
        let project=format!("rp_{}","a".repeat(32));
        let proposal="12345678-1234-4234-8234-123456789abc";
        let request="12345678-1234-4234-8234-123456789abd";
        let options=serde_json::json!({"proposalId":proposal,"threadId":"thread_1","requestId":request,"expectedLinkId":null,"extra":"discard"});
        let (_,path,body)=research_action("research_proposal_link",Some(&project),Some(&options)).unwrap();
        assert_eq!(path,format!("/api/client/research/{project}/proposals/{proposal}/discussions"));
        assert_eq!(body["requestId"],request);assert!(body.get("extra").is_none());assert!(body.get("proposalId").is_none());
        let template=detail_path("research_proposal_discussions").unwrap().0;
        assert_eq!(fill_path(template,&[project.clone(),proposal.into()]).unwrap(),path);
        for key in ["proposalId","requestId","threadId"] {
            let mut changed=options.clone();changed[key]=serde_json::json!("../elsewhere");assert!(research_action("research_proposal_link",Some(&project),Some(&changed)).is_err());
        }
        let mut absent=options.clone();absent.as_object_mut().unwrap().remove("expectedLinkId");assert!(research_action("research_proposal_link",Some(&project),Some(&absent)).is_err());
        let unlink=serde_json::json!({"proposalId":proposal,"threadId":"thread_1","linkId":request});
        assert_eq!(research_action("research_proposal_unlink",Some(&project),Some(&unlink)).unwrap().2,serde_json::json!({"action":"unlink","threadId":"thread_1","linkId":request}));
        let mut oversized=options.clone();oversized["threadId"]=serde_json::json!("a".repeat(129));assert!(research_action("research_proposal_link",Some(&project),Some(&oversized)).is_err());
    }

    #[test]
    fn proposal_creation_requires_a_fixed_uuid_and_whitelists_the_payload() {
        let project=format!("rp_{}","a".repeat(32));
        let options=serde_json::json!({"requestId":"12345678-1234-4234-8234-123456789abc","documentId":"document","baseVersion":1,"body":"body","summary":"reason","extra":"discard"});
        let (_,_,body)=research_action("research_propose",Some(&project),Some(&options)).unwrap();
        assert_eq!(body["requestId"],options["requestId"]);assert!(body.get("extra").is_none());
        for invalid in [serde_json::Value::Null,serde_json::json!("../id"),serde_json::json!("12345678-1234-4234-8234-123456789ABC")] {
            let mut changed=options.clone();changed["requestId"]=invalid;
            assert!(research_action("research_propose",Some(&project),Some(&changed)).is_err());
        }
        let mut changed=options.clone();changed["body"]=serde_json::json!("😀".repeat(50001));assert!(research_action("research_propose",Some(&project),Some(&changed)).is_err());
        changed=options.clone();changed["baseVersion"]=serde_json::json!(9007199254740992u64);assert!(research_action("research_propose",Some(&project),Some(&changed)).is_err());
    }

    #[test]
    fn proposal_decisions_require_the_reviewed_snapshot() {
        let project=format!("rp_{}","a".repeat(32));
        let proposal="12345678-1234-4234-8234-123456789abc";
        let hash=format!("sha256:{}","a".repeat(64));
        let options=serde_json::json!({"proposalId":proposal,"snapshot":{"proposalId":proposal,"baseVersion":1,"currentHead":1,"proposalHash":hash,"baseHash":hash,"extra":"discard"},"extra":"discard"});
        for action in ["research_accept","research_reject"] {
            let (_,path,body)=research_action(action,Some(&project),Some(&options)).unwrap();
            assert_eq!(path,format!("/api/client/research/{project}/workspace"));
            assert!(body.get("extra").is_none());
            assert!(body["snapshot"].get("extra").is_none());
            for field in ["baseVersion","currentHead"] {
                for invalid in [serde_json::json!(0),serde_json::json!(9007199254740992u64),serde_json::json!("1")] {
                    let mut changed=options.clone();changed["snapshot"][field]=invalid;
                    assert!(research_action(action,Some(&project),Some(&changed)).is_err());
                }
            }
            let mut missing=options.clone();missing["snapshot"]=serde_json::Value::Null;
            assert!(research_action(action,Some(&project),Some(&missing)).is_err());
            let mut wrong=options.clone();wrong["snapshot"]["proposalId"]=serde_json::json!("other");
            assert!(research_action(action,Some(&project),Some(&wrong)).is_err());
            let mut bad_hash=options.clone();bad_hash["snapshot"]["baseHash"]=serde_json::json!(format!("{hash}\n"));
            assert!(research_action(action,Some(&project),Some(&bad_hash)).is_err());
        }
        assert!(research_proposal_uuid(Some("../proposal")).is_err());
    }

    #[test]
    fn an_unknown_scope_becomes_all() {
        // 端末から来た文字列をそのまま問い合わせに繋げない。ハブ側でも
        // 見ているが、両側で見る。片方が緩んだときにもう片方が残る。
        assert_eq!(safe_scope("latest"), "latest");
        assert_eq!(safe_scope("following"), "following");
        assert_eq!(safe_scope(""), "all");
        assert_eq!(safe_scope("everything"), "all");
        assert_eq!(safe_scope("all&limit=99999"), "all");
        assert_eq!(safe_scope("../admin"), "all");
    }

    #[test]
    fn public_feed_degrades_to_anonymous_but_following_requires_authentication() {
        assert_eq!(feed_auth("recommended", Err("account_offline".into())).unwrap(), None);
        assert_eq!(feed_auth("popular", Ok(None)).unwrap(), None);
        assert_eq!(feed_auth("latest", Ok(Some("token".into()))).unwrap().as_deref(), Some("token"));
        assert_eq!(feed_auth("following", Ok(None)).unwrap_err(), "desktop_not_connected");
        assert_eq!(feed_auth("following", Err("account_offline".into())).unwrap_err(), "account_offline");
    }

    #[test]
    fn the_url_cannot_be_bent_by_what_the_window_asks_for() {
        assert_eq!(
            feed_url("https://hub.example", "latest", 3, 0, None),
            "https://hub.example/api/client/feed?scope=latest&limit=3"
        );
        // 末尾のスラッシュで二重にならない。
        assert_eq!(
            feed_url("https://hub.example/", "all", 20, 0, None),
            "https://hub.example/api/client/feed?scope=all&limit=20"
        );
        // 件数は必ず範囲に入る。
        assert!(feed_url("https://h", "all", 0, 0, None).ends_with("limit=1"));
        assert!(feed_url("https://h", "all", 100_000, 0, None).ends_with("limit=50"));
        // 変な範囲を渡されても、問い合わせは1つのままで壊れない。
        assert_eq!(
            feed_url("https://h", "x&scope=admin", 5, 0, None),
            "https://h/api/client/feed?scope=all&limit=5"
        );
        // 続きの指定。カーソルはクエリとしてエンコードされ、空や長すぎるものは落ちる。
        assert_eq!(
            feed_url("https://h", "latest", 20, 40, Some("a~b")),
            "https://h/api/client/feed?scope=latest&limit=20&offset=40&cursor=a%7Eb"
        );
        assert!(!feed_url("https://h", "all", 20, 0, Some("  ")).contains("cursor"));
        assert!(!feed_url("https://h", "all", 20, 0, Some(&"x".repeat(600))).contains("cursor"));
        assert!(feed_url("https://h", "all", 20, 0, Some("a b&c=d")).contains("cursor=a+b%26c%3Dd"));
    }

    #[test]
    fn research_boundaries_preserve_long_unicode_and_fixed_paths() {
        let options=serde_json::json!({"title":"研究","body":"文".repeat(100000),"kind":"paper","visibility":"confidential","url":"https://evil.invalid"});
        let (_,path,body)=research_action("research_create",Some("rp_1"),Some(&options)).unwrap();
        assert_eq!(path,"/api/client/research/rp_1/workspace");assert_eq!(body["body"].as_str().unwrap().chars().count(),100000);assert!(body.get("url").is_none());
        let mut oversized=options.clone();oversized["body"]=serde_json::json!("😀".repeat(50001));assert!(research_action("research_create",Some("rp_1"),Some(&oversized)).is_err());
        assert!(research_action("research_create",Some("../admin"),Some(&options)).is_err());assert!(research_action("research_delete_database",Some("rp_1"),Some(&options)).is_err());
        let template=detail_path("research_links_article").unwrap().0;
        let path=fill_path(template,&["rp_1".to_owned(),"研究 & kind=video".to_owned()]).unwrap();let url=reqwest::Url::parse(&format!("https://hub.invalid{path}")).unwrap();
        assert_eq!(url.query_pairs().collect::<Vec<_>>(),vec![("kind".into(),"article".into()),("q".into(),"研究 & kind=video".into())]);
        assert!(fill_path(template,&["rp_1".to_owned(),"😀".repeat(51)]).is_err());
        assert!(detail_path("research_links_admin").is_none());
    }

    #[test]
    fn desktop_resources_are_a_closed_allowlist() {
        let feed: Feed = serde_json::from_value(serde_json::json!({"researchUpdates":[{"id":"doc","title":"Paper","projectId":"project","projectTitle":"Research","version":2,"updatedAt":"2026-10-04T00:00:00Z"}]})).unwrap();
        assert_eq!(feed.research_updates.len(), 1);
        assert_eq!(serde_json::to_value(&feed).unwrap()["researchUpdates"][0]["updatedAt"], "2026-10-04T00:00:00Z");
        assert_eq!(serde_json::to_value(feed).unwrap()["researchUpdates"][0]["version"], 2);
        assert_eq!(resource_path("search"), Some("/api/search"));
        assert_eq!(resource_path("web_search"), Some("/api/search/web"));
        assert_eq!(resource_path("hubpedia"), Some("/api/hubpedia/v1/search"));
        assert_eq!(resource_path("hubpedia_catalog"), Some("/api/hubpedia/v1/articles"));
        assert_eq!(resource_path("hubpedia_retrieve"), Some("/api/hubpedia/retrieve"));
        assert_eq!(resource_path("research"), Some("/api/client/research"));
        assert_eq!(detail_path("article_like"), Some(("/api/articles/{a}/like", false)));
        assert_eq!(detail_path("article_comments"), Some(("/api/articles/{a}/comments", false)));
        assert_eq!(detail_path("article_like_me"), Some(("/api/client/articles/{a}/like", true)));
        assert_eq!(fill_path("/api/articles/{a}/like", &["art_1".to_owned()]).unwrap(), "/api/articles/art_1/like");
        assert!(fill_path("/api/articles/{a}/comments", &["../x".to_owned()]).is_err());
        assert_eq!(detail_path("research_project"), Some(("/api/client/research/{a}", true)));
        assert_eq!(detail_path("research_document"), Some(("/api/client/research/{a}/documents/{b}", true)));
        assert_eq!(fill_path("/api/client/research/{a}", &["rp_1".to_owned()]).unwrap(), "/api/client/research/rp_1");
        assert!(fill_path("/api/client/research/{a}", &["../private".to_owned()]).is_err());
        assert_eq!(resource_path("threads"), Some("/api/bbs/threads"));
        assert_eq!(resource_path("articles"), Some("/api/articles"));
        assert_eq!(resource_path("books"), Some("/api/books"));
        assert_eq!(resource_path("world"), Some("/api/world/servers"));
        assert_eq!(resource_path("distributed_posts"), Some("/api/distributed/resources?kind=post&limit=30"));
        assert_eq!(resource_path("market_tickets"), Some("/api/market/tickets"));
        assert_eq!(resource_path("shopping_products"), None);
        assert_eq!(resource_path("distributed_products"), None);
        assert_eq!(resource_path("../admin"), None);
        assert_eq!(resource_path("https://evil.example"), None);
    }

    #[test]
    fn client_paths_are_a_closed_allowlist_and_queries_are_shape_checked() {
        assert_eq!(client_path("me"), Some("/api/client/me"));
        assert_eq!(client_path("me_summary"), Some("/api/client/me?posts=0"));
        assert_eq!(client_path("notifications"), Some("/api/client/notifications"));
        assert_eq!(client_path("conversations"), Some("/api/client/conversations"));
        assert_eq!(client_path("bookmarks"), Some("/api/client/bookmarks"));
        assert_eq!(client_path("federated_feed"), Some("/api/federation/recommendations"));
        assert_eq!(client_path("contacts"), Some("/api/client/contacts"));
        assert_eq!(client_path("remote_follows"), Some("/api/client/federation/follows"));
        assert_eq!(client_path("wallet"), Some("/api/client/wallet"));
        assert_eq!(client_path("lists"), Some("/api/lists"));
        assert_eq!(client_path("services"), Some("/api/platform/developer/services"));
        assert_eq!(client_path("admin"), None);
        assert_eq!(client_path("../api/admin"), None);
        // 会話識別子は識別子の形だけ。クエリやパスの文字を混ぜられない。
        assert_eq!(conversation_query(Some("conv-1_abc")), Some("conv-1_abc".into()));
        assert_eq!(conversation_query(Some("a&b=admin")), None);
        assert_eq!(conversation_query(Some("../x")), None);
        assert_eq!(conversation_query(Some(" ")), None);
        assert_eq!(conversation_query(None), None);
    }

    #[test]
    fn client_actions_are_a_closed_set_with_checked_shapes() {
        // 許可した操作だけが、許可した形の本文になる。
        let (method, path, body) = action_request("read_all_notifications", None, None, None, None).unwrap();
        assert_eq!(method, reqwest::Method::POST);
        assert_eq!(path, "/api/client/notifications");
        assert_eq!(body, serde_json::json!({ "readAll": true }));

        let (_, _, body) = action_request("read_notification", Some("n-1"), None, None, None).unwrap();
        assert_eq!(body, serde_json::json!({ "id": "n-1" }));

        let (_, path, body) =
            action_request("read_conversation", Some("conv-1"), None, None, None).unwrap();
        assert_eq!(path, "/api/client/conversations");
        assert_eq!(body["markRead"], true);

        let (_, _, body) = action_request(
            "send_message",
            Some("conv-1"),
            Some("こんにちは"),
            Some("11111111-2222-3333-4444-555555555555"),
            None,
        )
        .unwrap();
        assert_eq!(body["text"], "こんにちは");
        assert_eq!(body["requestId"], "11111111-2222-3333-4444-555555555555");

        // DM の画像も投稿と同じくUUID形だけが通り、4枚まで。
        let (_, path, body) = action_request(
            "send_message",
            Some("conv-1"),
            Some("写真を見て"),
            None,
            Some(&serde_json::json!({
                "imageIds": ["11111111-2222-3333-4444-555555555555", "not-a-uuid", 42],
            })),
        )
        .unwrap();
        assert_eq!(path, "/api/client/conversations");
        assert_eq!(body["imageIds"], serde_json::json!(["11111111-2222-3333-4444-555555555555"]));
        assert!(action_request(
            "send_message",
            Some("conv-1"),
            Some("写真"),
            None,
            Some(&serde_json::json!({ "imageIds": [
                "11111111-1111-1111-1111-111111111111",
                "22222222-2222-2222-2222-222222222222",
                "33333333-3333-3333-3333-333333333333",
                "44444444-4444-4444-4444-444444444444",
                "55555555-5555-5555-5555-555555555555",
            ] })),
        )
        .is_err());

        // 投稿への反応——いいね・ブックマーク・リポスト・返信・削除。
        let (_, path, body) = action_request("like", Some("p-1"), None, None, None).unwrap();
        assert_eq!(path, "/api/client/engagements");
        assert_eq!(body, serde_json::json!({ "kind": "like", "targetId": "p-1", "active": true }));
        let (_, _, body) = action_request("unlike", Some("p-1"), None, None, None).unwrap();
        assert_eq!(body, serde_json::json!({ "kind": "like", "targetId": "p-1", "active": false }));
        let (_, _, body) = action_request("bookmark", Some("p-1"), None, None, None).unwrap();
        assert_eq!(body["kind"], "bookmark");
        assert_eq!(body["active"], true);
        let (_, _, body) = action_request("unbookmark", Some("p-1"), None, None, None).unwrap();
        assert_eq!(body["active"], false);

        let (_, path, body) = action_request("repost", Some("p-1"), None, None, None).unwrap();
        assert_eq!(path, "/api/client/posts");
        assert_eq!(body["repostOfTargetType"], "social_post");
        assert_eq!(body["repostOfTargetId"], "p-1");
        let (_, path, body) =
            action_request("quote_post", Some("p-1"), Some("いい視点"), None, None).unwrap();
        assert_eq!(path, "/api/client/posts");
        assert_eq!(body["quoteOfTargetId"], "p-1");
        assert_eq!(body["body"], "いい視点");
        // 引用に本文が無いものは拒否。
        assert!(action_request("quote_post", Some("p-1"), None, None, None).is_err());

        let (_, path, body) =
            action_request("reply", Some("p-1"), Some("たしかに"), None, None).unwrap();
        assert_eq!(path, "/api/client/posts");
        assert_eq!(body["body"], "たしかに");
        assert_eq!(body["replyToPostId"], "p-1");

        let (_, _, body) = action_request(
            "create_post",
            None,
            Some("本文"),
            Some("11111111-2222-3333-4444-555555555555"),
            None,
        )
        .unwrap();
        assert_eq!(body["body"], "本文");
        assert_eq!(body["clientRequestId"], "11111111-2222-3333-4444-555555555555");

        // 画像IDはUUID形だけが通り、4枚まで。違う形は落とす。
        let (_, _, body) = action_request(
            "create_post",
            None,
            Some("本文"),
            None,
            Some(&serde_json::json!({
                "imageIds": ["11111111-2222-3333-4444-555555555555", "not-a-uuid", 42],
            })),
        )
        .unwrap();
        assert_eq!(body["imageIds"], serde_json::json!(["11111111-2222-3333-4444-555555555555"]));
        assert!(action_request(
            "create_post",
            None,
            Some("本文"),
            None,
            Some(&serde_json::json!({ "imageIds": [
                "11111111-1111-1111-1111-111111111111",
                "22222222-2222-2222-2222-222222222222",
                "33333333-3333-3333-3333-333333333333",
                "44444444-4444-4444-4444-444444444444",
                "55555555-5555-5555-5555-555555555555",
            ] })),
        )
        .is_err());

        // 公開範囲は followers だけが通る——それ以外はpublicのまま。
        let (_, _, body) = action_request(
            "create_post",
            None,
            Some("本文"),
            None,
            Some(&serde_json::json!({ "audience": "followers" })),
        )
        .unwrap();
        assert_eq!(body["audience"], "followers");
        let (_, _, body) = action_request(
            "create_post",
            None,
            Some("本文"),
            None,
            Some(&serde_json::json!({ "audience": "admins" })),
        )
        .unwrap();
        assert!(body.get("audience").is_none());

        // 自分の投稿の編集。id と新しい本文だけを送る。
        let (method, path, body) =
            action_request("edit_post", Some("p-1"), Some("直した本文"), None, None).unwrap();
        assert_eq!(method, reqwest::Method::PATCH);
        assert_eq!(path, "/api/client/posts");
        assert_eq!(body, serde_json::json!({ "id": "p-1", "body": "直した本文" }));
        assert!(action_request("edit_post", None, Some("本文"), None, None).is_err());
        assert!(action_request("edit_post", Some("p-1"), None, None, None).is_err());

        // ミュート/ブロック——action名が enabled を決める。
        let (method, path, body) =
            action_request("mute", Some("pr-1"), None, None, None).unwrap();
        assert_eq!(method, reqwest::Method::PATCH);
        assert_eq!(path, "/api/client/safety");
        assert_eq!(body, serde_json::json!({ "targetProfileId": "pr-1", "action": "mute", "enabled": true }));
        let (_, _, body) = action_request("unblock", Some("pr-1"), None, None, None).unwrap();
        assert_eq!(body, serde_json::json!({ "targetProfileId": "pr-1", "action": "block", "enabled": false }));

        // 通報——理由は許可集合だけ。詳細は500字で切る。
        let (method, path, body) = action_request(
            "report_post",
            Some("p-1"),
            None,
            None,
            Some(&serde_json::json!({ "reason": "spam", "details": "宣伝ばかり" })),
        )
        .unwrap();
        assert_eq!(method, reqwest::Method::POST);
        assert_eq!(path, "/api/client/reports");
        assert_eq!(body["targetType"], "social_post");
        assert_eq!(body["reason"], "spam");
        assert!(action_request(
            "report_post",
            Some("p-1"),
            None,
            None,
            Some(&serde_json::json!({ "reason": "nonsense" })),
        )
        .is_err());
        let (_, _, body) = action_request(
            "report_profile",
            Some("pr-1"),
            None,
            None,
            Some(&serde_json::json!({ "reason": "impersonation" })),
        )
        .unwrap();
        assert_eq!(body["targetType"], "profile");
        assert!(action_request(
            "report_profile",
            Some("pr-1"),
            None,
            None,
            Some(&serde_json::json!({ "reason": "copyright" })),
        )
        .is_err());

        let (method, _, body) = action_request("delete_post", Some("p-1"), None, None, None).unwrap();
        assert_eq!(method, reqwest::Method::DELETE);
        assert_eq!(body, serde_json::json!({ "id": "p-1" }));

        // 投稿の本文はハブと同じ500字で切る。
        let (_, _, body) =
            action_request("create_post", None, Some(&"あ".repeat(600)), None, None).unwrap();
        assert_eq!(body["body"].as_str().unwrap().chars().count(), 500);

        // 対象なし・形の合わない識別子・知らない操作は全部ここで止まる。
        assert!(action_request("read_notification", None, None, None, None).is_err());
        assert!(action_request("like", None, None, None, None).is_err());
        assert!(action_request("like", Some("a&b=x"), None, None, None).is_err());
        assert!(action_request("reply", Some("p-1"), None, None, None).is_err());
        assert!(action_request("create_post", None, None, None, None).is_err());
        assert!(action_request("delete_post", None, None, None, None).is_err());
        assert!(action_request("send_message", Some("a&b=x"), Some("t"), None, None).is_err());
        assert!(action_request("delete_everything", None, None, None, None).is_err());
        // 280 UTF-16単位を超える本文は切らずに拒否する。requestId が形でなくても
        // 送信自体は止めない（冪等キーは任意）。
        let (_, _, body) =
            action_request("send_message", Some("c"), Some(&"あ".repeat(280)), Some("bad id"), None)
                .unwrap();
        assert_eq!(body["text"].as_str().unwrap(), "あ".repeat(280));
        assert!(body.get("requestId").is_none());
        for text in ["あ".repeat(281), "あ".repeat(300), "😀".repeat(141)] {
            assert!(action_request("send_message", Some("c"), Some(&text), None, None).is_err());
        }
        let (_, _, emoji) = action_request("send_message", Some("c"), Some(&"😀".repeat(140)), None, None).unwrap();
        assert_eq!(emoji["text"].as_str().unwrap(), "😀".repeat(140));
    }

    #[test]
    fn profile_works_paths_take_a_handle_and_a_cursor_only() {
        let fill=|name:&str,ids:&[&str]| fill_path(detail_path(name).unwrap().0,&ids.iter().map(|v|v.to_string()).collect::<Vec<_>>());
        assert_eq!(fill("profile_articles",&["kamma.dev"]).unwrap(),"/api/articles?author=kamma.dev");
        assert_eq!(fill("profile_videos_page",&["k_1","MjAyNi0xMC0xN1QwMDowMDowMC4wMDBafmFiYw"]).unwrap(),"/api/videos?author=k_1&cursor=MjAyNi0xMC0xN1QwMDowMDowMC4wMDBafmFiYw");
        assert_eq!(fill("profile_code",&["k"]).unwrap(),"/api/code/repos?owner=k");
        assert_eq!(detail_path("profile_code_page").map(|v|v.1),Some(false));
        for bad in ["", "..", "a/b", "a?b", "a&owner=x", "a%2F", "a b", &"x".repeat(65)] { assert!(fill("profile_articles",&[bad]).is_err(), "{bad}"); }
        for bad in ["", "a=b", "a+b", "a/b", "a%20", &"x".repeat(401)] { assert!(fill("profile_code_page",&["k",bad]).is_err(), "{bad}"); }
        assert!(fill("profile_articles",&["k","c"]).is_err());
        assert!(fill("profile_videos_page",&["k"]).is_err());
    }

    #[test]
    fn detail_paths_fill_only_checked_identifiers() {
        // 固定テンプレートに識別子が入る。区切り・クエリ・百分符号は入らない。
        assert_eq!(
            fill_path("/api/client/posts/{a}", &["p-1".to_owned()]).unwrap(),
            "/api/client/posts/p-1"
        );
        assert_eq!(
            fill_path(
                "/api/books/{a}/chapters/{b}",
                &["kokoro".to_owned(), "part-2".to_owned()]
            )
            .unwrap(),
            "/api/books/kokoro/chapters/part-2"
        );
        assert!(fill_path("/api/client/posts/{a}", &["../admin".to_owned()]).is_err());
        assert!(fill_path("/api/client/posts/{a}", &["a?b=1".to_owned()]).is_err());
        assert!(fill_path("/api/client/posts/{a}", &["a%20".to_owned()]).is_err());
        assert!(fill_path("/api/client/posts/{a}", &["a/b".to_owned()]).is_err());
        assert!(fill_path("/api/client/posts/{a}", &[" ".to_owned()]).is_err());
        // 必要な識別子が足りないときも止まる。
        assert!(fill_path("/api/books/{a}/chapters/{b}", &["kokoro".to_owned()]).is_err());
        // 名前の表も閉じている。
        assert!(detail_path("post").is_some());
        assert_eq!(detail_path("thread"), Some(("/api/client/threads/{a}", true)));
        assert!(detail_path("shopping_product").is_none());
        assert!(detail_path("admin").is_none());
        assert!(detail_path("../etc").is_none());
    }

    #[test]
    fn detail_and_write_actions_build_fixed_bodies() {
        let options = |pairs: &[(&str, &str)]| {
            serde_json::Value::Object(
                pairs
                    .iter()
                    .map(|(k, v)| ((*k).to_owned(), serde_json::Value::String((*v).to_owned())))
                    .collect(),
            )
        };

        // スレッド返信——スコープ宣言は options の決まったキーから。
        let (method, path, body) = action_request(
            "thread_reply",
            Some("t-1"),
            Some("返信本文"),
            None,
            Some(&options(&[
                ("language", "ja"),
                ("region", "global"),
                ("languageTag", "ja-JP"),
                ("replyToPostId", "tp-9"),
            ])),
        )
        .unwrap();
        assert_eq!(method, reqwest::Method::POST);
        assert_eq!(path, "/api/client/threads/t-1/posts");
        assert_eq!(body["body"], "返信本文");
        assert_eq!(body["language"], "ja");
        assert_eq!(body["languageTag"], "ja-JP");
        assert_eq!(body["replyToPostId"], "tp-9");
        // スコープ宣言が無い返信はここで止まる。
        assert!(action_request("thread_reply", Some("t-1"), Some("x"), None, None).is_err());

        // 参加・退出——joined は action 名で固定、窓は真偽を組み立てない。
        let (_, path, body) =
            action_request("community_join", Some("c-1"), None, None, None).unwrap();
        assert_eq!(path, "/api/client/communities/c-1/membership");
        assert_eq!(body, serde_json::json!({ "joined": true }));
        let (_, _, body) =
            action_request("community_leave", Some("c-1"), None, None, None).unwrap();
        assert_eq!(body, serde_json::json!({ "joined": false }));

        // チャンネル投稿——communityId は target、channelId は options。
        let (_, path, body) = action_request(
            "channel_message",
            Some("c-1"),
            Some("メッセージ"),
            Some("11111111-2222-3333-4444-555555555555"),
            Some(&options(&[("channelId", "ch-7"), ("kind", "question")])),
        )
        .unwrap();
        assert_eq!(path, "/api/client/communities/c-1/channels/ch-7/messages");
        assert_eq!(body["body"], "メッセージ");
        assert_eq!(body["kind"], "question");
        assert_eq!(body["clientRequestId"], "11111111-2222-3333-4444-555555555555");
        // channelId が無い・形が違うものは止まる。
        assert!(
            action_request("channel_message", Some("c-1"), Some("x"), None, None).is_err()
        );
        assert!(
            action_request(
                "channel_message",
                Some("c-1"),
                Some("x"),
                None,
                Some(&options(&[("channelId", "a/b")]))
            )
            .is_err()
        );

        // リアクション——絵文字は3種の外を通さない。
        let (_, path, body) = action_request(
            "message_reaction",
            Some("c-1"),
            None,
            None,
            Some(&options(&[
                ("channelId", "ch-7"),
                ("messageId", "m-3"),
                ("emoji", "❤️"),
            ])),
        )
        .unwrap();
        assert_eq!(
            path,
            "/api/client/communities/c-1/channels/ch-7/messages/m-3/reactions"
        );
        assert_eq!(body["emoji"], "❤️");
        let (_, _, body) = action_request(
            "message_reaction",
            Some("c-1"),
            None,
            None,
            Some(&options(&[
                ("channelId", "ch-7"),
                ("messageId", "m-3"),
                ("emoji", "🔥"),
            ])),
        )
        .unwrap();
        assert_eq!(body["emoji"], "👍");
    }

    /// 手元のハブが動いているときだけ走る。繋ぎ目は実物でしか確かめられない。
    ///   cargo test reads_from_a_live_hub -- --ignored --nocapture
    /// HUB_DESKTOP_LIVE_HUB_ORIGIN may point at another validated HTTPS or
    /// loopback Hub; the normal VPS tunnel at localhost:3020 is the default.
    #[tokio::test]
    #[ignore]
    async fn reads_from_a_live_hub() {
        let configured = std::env::var("HUB_DESKTOP_LIVE_HUB_ORIGIN").ok();
        let origin = crate::hub_window::hub_url(configured.as_deref());
        let feed = fetch_feed(&origin, "all", 5, 0, None).await.expect("読めること");
        println!(
            "scope={} signed_in={} posts={}",
            feed.scope,
            feed.signed_in,
            feed.posts.len()
        );
        assert!(!feed.posts.is_empty(), "投稿が返ること");
        assert!(!feed.posts[0].id.is_empty());
        println!(
            "先頭: {} / {}",
            feed.posts[0].author_name,
            feed.posts[0].body.chars().take(24).collect::<String>()
        );
    }

    #[test]
    fn thread_post_actions_build_fixed_requests() {
        let (method, path, body) = action_request(
            "thread_post_edit",
            Some("post-1"),
            Some("直し"),
            None,
            Some(&serde_json::json!({"editReason": "typo"})),
        )
        .unwrap();
        assert_eq!(method, reqwest::Method::PATCH);
        assert_eq!(path, "/api/client/thread-posts/post-1");
        assert_eq!(body["body"], "直し");
        assert_eq!(body["edit_reason"], "typo");

        let (method, path, _) =
            action_request("thread_post_delete", Some("post-1"), None, None, None).unwrap();
        assert_eq!(method, reqwest::Method::DELETE);
        assert_eq!(path, "/api/client/thread-posts/post-1");

        let (method, path, body) = action_request(
            "thread_post_vote",
            Some("post-1"),
            None,
            None,
            Some(&serde_json::json!({"kind": "down", "reason": "off_topic"})),
        )
        .unwrap();
        assert_eq!(method, reqwest::Method::POST);
        assert_eq!(path, "/api/client/thread-posts/post-1/vote");
        assert_eq!(body["kind"], "down");
        assert_eq!(body["reason"], "off_topic");

        // 定義外の評価種別・通報理由は拒否する。
        assert!(action_request(
            "thread_post_vote",
            Some("post-1"),
            None,
            None,
            Some(&serde_json::json!({"kind": "sideways"})),
        )
        .is_err());
        assert!(action_request(
            "thread_post_report",
            Some("post-1"),
            None,
            None,
            Some(&serde_json::json!({"reason": "bogus"})),
        )
        .is_err());
        let (method, path, body) = action_request(
            "thread_post_report",
            Some("post-1"),
            None,
            None,
            Some(&serde_json::json!({"reason": "misinformation", "details": "根拠なし"})),
        )
        .unwrap();
        assert_eq!(method, reqwest::Method::POST);
        assert_eq!(path, "/api/client/thread-posts/post-1/report");
        assert_eq!(body["reason"], "misinformation");

        let (method, path, body) = action_request(
            "thread_best_answer",
            Some("thread-9"),
            None,
            None,
            Some(&serde_json::json!({"postId": "post-7"})),
        )
        .unwrap();
        assert_eq!(method, reqwest::Method::POST);
        assert_eq!(path, "/api/client/threads/thread-9/best-answer");
        assert_eq!(body["post_id"], "post-7");

        let (method, path, _) =
            action_request("thread_follow", Some("thread-9"), None, None, None).unwrap();
        assert_eq!(method, reqwest::Method::POST);
        assert_eq!(path, "/api/client/threads/thread-9/follow");
    }

    #[test]
    fn follow_remote_sends_only_a_shape_checked_handle_to_a_fixed_path() {
        let options = serde_json::json!({ "handle": " @bob@hub.example " });
        let (method, path, body) = action_request("follow_remote", None, None, None, Some(&options)).unwrap();
        assert_eq!(method, reqwest::Method::POST);
        assert_eq!(path, "/api/client/federation/follows");
        assert_eq!(body, serde_json::json!({ "handle": "@bob@hub.example" }));
        let (_, _, without_at) = action_request("follow_remote", None, None, None, Some(&serde_json::json!({ "handle": "bob@127.0.0.1:3030" }))).unwrap();
        assert_eq!(without_at["handle"], "@bob@127.0.0.1:3030");
        // 形の外・余分な入力は止める。
        for bad in ["", "bob", "@bob@", "@@hub.example", "bob@hub", "bob@hub.example/x", "bob@hub.example?a=1", "b ob@hub.example", "bob@evil@hub.example", "../x@hub.example"] {
            assert!(action_request("follow_remote", None, None, None, Some(&serde_json::json!({ "handle": bad }))).is_err(), "{bad}");
        }
        assert!(action_request("follow_remote", None, None, None, None).is_err());
        assert!(action_request("follow_remote", Some("profile-1"), None, None, Some(&options)).is_err());
        assert!(action_request("follow_remote", None, Some("x"), None, Some(&options)).is_err());
    }

    #[test]
    fn a_feed_with_missing_fields_still_reads() {
        // ハブ側が値を落としても、端末で NaN や undefined が並ばないこと。
        let feed: Feed = serde_json::from_str(r#"{"scope":"all","posts":[{"id":"p1"}]}"#).unwrap();
        assert_eq!(feed.posts.len(), 1);
        assert_eq!(feed.posts[0].body, "");
        assert_eq!(feed.posts[0].like_count, 0);
        assert!(!feed.posts[0].liked_by_viewer);
        assert!(!feed.signed_in);
    }

}

#[cfg(test)]
mod community_native_tests {
    use super::*;
    const OP: &str = "00000000-0000-4000-8000-000000000001";
    #[test]
    fn research_git_management_paths_and_payload_are_closed(){
      let p=format!("rp_{}","a".repeat(32));let op="00000000-0000-4000-8000-000000000001";let input=serde_json::json!({"snapshot":"a".repeat(64),"scope":"write","id":op,"visibility":"public","token":"ignored","url":"https://evil.invalid"});
      let(template,auth)=detail_path("research_git_management").unwrap();assert!(auth);assert_eq!(fill_path(template,&[p.clone()]).unwrap(),format!("/api/client/research/{p}/git"));
      for action in ["research_git_create","research_git_visibility","research_git_revoke","research_git_token"]{let(_,path,body)=action_request(action,Some(&p),None,Some(op),Some(&input)).unwrap();assert_eq!(path,format!("/api/client/research/{p}/git"));assert!(body.get("token").is_none());assert!(body.get("url").is_none());}
      assert!(action_request("research_git_token",Some(&p),None,None,Some(&input)).is_err());
      for(key,v)in[("snapshot",serde_json::json!("a".repeat(64)+"\n")),("snapshot",serde_json::json!("A".repeat(64))),("scope",serde_json::json!("admin")),("id",serde_json::json!("bad")),("visibility",serde_json::json!(false))]{let mut bad=input.clone();bad[key]=v;let action=if key=="id"{"research_git_revoke"}else if key=="visibility"{"research_git_visibility"}else{"research_git_token"};assert!(action_request(action,Some(&p),None,Some(op),Some(&bad)).is_err());}
      assert!(fill_path(template,&[p.clone()+"\n"]).is_err());assert!(action_request("research_git_create",Some(&(p+"\n")),None,None,Some(&input)).is_err());
    }

    #[test]
    fn research_git_paths_and_payload_are_closed() {
        let project=format!("rp_{}","a".repeat(32)); let oid="b".repeat(40);
        for name in ["research_git_history","research_git_commit","research_git_discussion"] {
            let (template,auth)=detail_path(name).unwrap();assert!(auth);
            let ids=if name=="research_git_history"{vec![project.clone()]}else{vec![project.clone(),oid.clone()]};
            assert!(fill_path(template,&ids).is_ok());
            let mut invalid=ids.clone();invalid[0].push('\n');assert!(fill_path(template,&invalid).is_err());
        }
        let href=format!("/v2/research/{project}?commit={oid}#git");
        let options=serde_json::json!({"oid":oid,"source":{"projectId":project,"projectTitle":"Project","oid":oid,"subject":"Change","href":href,"ignored":"discard"},"title":"Verification title","body":"Please verify the implications of this code change.","boardKey":"general","threadType":"issue","requestId":"00000000-0000-4000-8000-000000000001","ignored":"discard"});
        let (_,path,body)=action_request("research_git_discuss",Some(&project),None,None,Some(&options)).unwrap();
        assert_eq!(path,format!("/api/client/research/{project}/git/discussion"));assert_eq!(body["action"],"discuss_git");assert!(body.get("ignored").is_none());assert!(body["source"].get("ignored").is_none());
        for (key,value) in [("oid",serde_json::json!("B".repeat(40))),("requestId",serde_json::json!("bad")),("title",serde_json::json!("short")),("body",serde_json::json!("x".repeat(4000))),("threadType",serde_json::json!("chat"))] {let mut changed=options.clone();changed[key]=value;assert!(action_request("research_git_discuss",Some(&project),None,None,Some(&changed)).is_err());}
        for (key,value) in [("href",serde_json::json!("https://evil.test")),("oid",serde_json::json!("c".repeat(40))),("subject",serde_json::json!("bad\nsubject")),("projectTitle",serde_json::json!("😀".repeat(121)))] {let mut changed=options.clone();changed["source"][key]=value;assert!(action_request("research_git_discuss",Some(&project),None,None,Some(&changed)).is_err());}
        assert!(research_git_oid(Some(&("a".repeat(40)+"\n"))).is_err());assert!(research_git_oid(Some(&"c".repeat(64))).is_ok());
    }

    #[test]
    fn research_fork_paths_and_payload_are_closed() {
        let p=format!("rp_{}","a".repeat(32));
        let template="/api/client/research/{a}/fork";
        assert_eq!(detail_path("research_fork"),Some((template,true)));
        assert_eq!(fill_path(template,&[p.clone()]).unwrap(),format!("/api/client/research/{p}/fork"));
        assert!(fill_path(template,&["../outside".to_owned()]).is_err());
        let input=serde_json::json!({"requestId":"00000000-0000-4000-8000-000000000001","snapshotHash":format!("sha256:{}","b".repeat(64)),"rightsConfirmed":true,"origin":"https://evil.invalid","visibility":"public"});
        let (method,path,body)=action_request("research_fork",Some(&p),None,None,Some(&input)).unwrap();
        assert_eq!(method,reqwest::Method::POST);assert_eq!(path,format!("/api/client/research/{p}/fork"));assert!(body.get("origin").is_none());assert!(body.get("visibility").is_none());
        for (key,value) in [("requestId",serde_json::json!("bad")),("snapshotHash",serde_json::json!(format!("sha256:{}\n","b".repeat(64)))),("rightsConfirmed",serde_json::json!(false))]{let mut changed=input.clone();changed[key]=value;assert!(action_request("research_fork",Some(&p),None,None,Some(&changed)).is_err());}
    }

    #[test]
    fn research_network_fork_paths_and_payload_are_closed() {
        let p=format!("rp_{}","a".repeat(32));
        let template="/api/client/research/network-fork";
        assert_eq!(detail_path("research_network_fork"),Some((template,true)));
        let path=fill_path(template,&["https://remote.example:8443".to_owned(),p.clone()]).unwrap();
        let url=reqwest::Url::parse(&format!("https://local.example{path}")).unwrap();
        assert_eq!(url.path(),template);
        assert_eq!(url.query_pairs().collect::<Vec<_>>(),vec![("origin".into(),"https://remote.example:8443".into()),("projectId".into(),p.as_str().into())]);
        for origin in ["http://127.0.0.1","https://user:pass@remote.example","https://remote.example/","https://remote.example/path","https://remote.example?x=1","https://remote.example#x","https://REMOTE.example","https://remote.example:443"] {
            assert!(fill_path(template,&[origin.to_owned(),p.clone()]).is_err());
        }
        for ids in [vec![],vec!["https://remote.example".to_owned()],vec!["https://remote.example".to_owned(),p.clone(),"extra".to_owned()],vec!["https://remote.example".to_owned(),"../project".to_owned()]] {assert!(fill_path(template,&ids).is_err());}
        let input=serde_json::json!({"origin":"https://remote.example","requestId":"00000000-0000-4000-8000-000000000001","snapshotHash":format!("sha256:{}","b".repeat(64)),"rightsConfirmed":true,"projectId":"spoof","ownerProfileId":"spoof","visibility":"public","url":"https://evil.invalid"});
        let (method,path,body)=action_request("research_network_fork",Some(&p),None,None,Some(&input)).unwrap();
        assert_eq!(method,reqwest::Method::POST);assert_eq!(path,template);
        assert_eq!(body,serde_json::json!({"origin":"https://remote.example","projectId":p,"requestId":input["requestId"],"snapshotHash":input["snapshotHash"],"rightsConfirmed":true}));
        for (key,value) in [("origin",serde_json::json!("https://remote.example/")),("requestId",serde_json::json!("bad")),("snapshotHash",serde_json::json!(format!("sha256:{}\n","b".repeat(64)))),("rightsConfirmed",serde_json::json!(false))] {let mut changed=input.clone();changed[key]=value;assert!(action_request("research_network_fork",Some(&p),None,None,Some(&changed)).is_err());}
        assert!(action_request("research_network_fork",Some("../project"),None,None,Some(&input)).is_err());
    }

    #[test]
    fn research_discussion_path_and_payload_are_closed() {
        let template="/api/client/research/{a}/workspace?discussion={b}&version={c}";
        assert_eq!(detail_path("research_discussion"),Some((template,true)));
        assert_eq!(fill_path(template,&["rp".to_owned(),"doc".to_owned(),"2".to_owned()]).unwrap(),"/api/client/research/rp/workspace?discussion=doc&version=2");
        for value in ["0","01","-1","1.5","1e2","2&private=true","9007199254740992"] {assert!(fill_path(template,&["rp".to_owned(),"doc".to_owned(),value.to_owned()]).is_err());}
        for value in ["".to_owned(),"../doc".to_owned(),"doc%26admin".to_owned(),"doc&version=1".to_owned()," doc".to_owned(),"x".repeat(129)] {
            assert!(fill_path(template,&["rp".to_owned(),value,"1".to_owned()]).is_err());
        }
        assert!(fill_path(template,&["x".repeat(128),"d".repeat(128),"9007199254740991".to_owned()]).is_ok());
        assert!(detail_path("research_discussion_admin").is_none());
        let source=serde_json::json!({"projectId":"rp","projectTitle":"Project","documentId":"doc","title":"Source","version":2,"contentHash":"sha256:".to_owned()+&"a".repeat(64),"href":"/v2/research/rp?document=doc&version=2","privateBody":"discard"});
        let options=serde_json::json!({"documentId":"doc","version":2,"requestId":OP,"source":source,"title":"題".repeat(100),"body":"本".repeat(30),"boardKey":"general","threadType":"question","url":"https://other.invalid"});
        let (method,path,body)=action_request("research_discuss",Some("rp"),Some("ignored"),None,Some(&options)).unwrap();
        assert_eq!(method,reqwest::Method::POST);assert_eq!(path,"/api/client/research/rp/workspace");assert_eq!(body["action"],"discuss");assert_eq!(body["body"],"本".repeat(30));assert_eq!(body["requestId"],OP);assert!(body.get("url").is_none());assert!(body["source"].get("privateBody").is_none());
        for (key,value) in [("version",serde_json::json!(0)),("version",serde_json::json!(9007199254740992u64)),("version",serde_json::json!("2")),("requestId",serde_json::json!("bad")),("title",serde_json::json!("😀".repeat(51))),("title",serde_json::json!("seven")),("body",serde_json::json!("😀".repeat(14))),("body",serde_json::json!("x".repeat(4000))),("boardKey",serde_json::json!("../general")),("threadType",serde_json::json!("chat")),("source",serde_json::Value::Null),("documentId",serde_json::json!("doc%26other"))] {
            let mut changed=options.clone();changed[key]=value;assert!(action_request("research_discuss",Some("rp"),None,None,Some(&changed)).is_err(),"{key}");
        }
        for key in ["documentId","version","requestId","source","title","body","boardKey","threadType"] {
            let mut changed=options.clone();changed.as_object_mut().unwrap().remove(key);assert!(action_request("research_discuss",Some("rp"),None,None,Some(&changed)).is_err());
        }
        for (key,value) in [("projectId",serde_json::json!("other")),("documentId",serde_json::json!("other")),("version",serde_json::json!(3)),("contentHash",serde_json::json!("sha256:short")),("href",serde_json::json!("https://other.invalid"))] {
            let mut changed=options.clone();changed["source"][key]=value;assert!(action_request("research_discuss",Some("rp"),None,None,Some(&changed)).is_err());
        }
    }
    #[test]
    fn guide_review_actions_and_pages_are_bounded_and_fixed() {
        let options=serde_json::json!({"proposalId":"p1","expectedUpdatedAt":"2026-10-02T00:00:00.000Z","decision":"approve","action":"merge","url":"https://other.invalid"});
        for action in ["community_guide_review","community_guide_update"] {
            let (method,path,body)=action_request(action,Some("c1"),Some(&"😀".repeat(1000)),Some(OP),Some(&options)).unwrap();
            assert_eq!(method,if action=="community_guide_review" {reqwest::Method::POST} else {reqwest::Method::PATCH});assert!(path.starts_with("/api/client/communities/c1/guides/proposals/p1"));assert!(body.get("url").is_none());
        }
        for (key,value) in [("proposalId",serde_json::json!("../other")),("expectedUpdatedAt",serde_json::json!("x".repeat(81))),("decision",serde_json::json!("merge"))] {
            let mut bad=options.clone();bad[key]=value;assert!(action_request("community_guide_review",Some("c1"),Some("Body"),Some(OP),Some(&bad)).is_err());
        }
        assert!(action_request("community_guide_review",Some("c1"),Some(&"😀".repeat(1001)),Some(OP),Some(&options)).is_err());
        let template=detail_path("community_guide_reviews_page").unwrap().0;
        assert_eq!(fill_path(template,&["c1".to_owned(),"p1".to_owned(),"20".to_owned()]).unwrap(),"/api/client/communities/c1/guides/proposals/p1/reviews?offset=20");
        for value in ["01","-1","20&bad=1","9007199254740992"] {assert!(fill_path(template,&["c1".to_owned(),"p1".to_owned(),value.to_owned()]).is_err());}
    }
    #[test]
    fn community_guide_proposals_are_fixed_and_validate_utf16_and_identifiers() {
        let options=serde_json::json!({"title":"題".repeat(120),"proposedTitle":"題".repeat(120),"summary":"😀".repeat(250),"pageId":"g1","baseVersion":1,"url":"https://untrusted.invalid"});
        let (method,path,body)=action_request("community_guide_propose",Some("c1"),Some(&"😀".repeat(15000)),Some(OP),Some(&options)).unwrap();
        assert_eq!(method,reqwest::Method::POST);assert_eq!(path,"/api/client/communities/c1/guides");assert!(body.get("url").is_none());assert_eq!(body["pageId"],"g1");assert_eq!(body["baseVersion"],1);
        for text in ["".to_owned()," ".to_owned(),"😀".repeat(15001)] {assert!(action_request("community_guide_propose",Some("c1"),Some(&text),Some(OP),Some(&options)).is_err());}
        for (key,bad) in [("title",serde_json::json!("😀".repeat(61))),("summary",serde_json::json!("😀".repeat(251))),("pageId",serde_json::json!("a/b")),("baseVersion",serde_json::json!(9007199254740992u64))] {
            let mut value=options.clone();value[key]=bad;assert!(action_request("community_guide_propose",Some("c1"),Some("Body"),Some(OP),Some(&value)).is_err());
        }
        assert!(action_request("community_guide_propose",Some("c1"),Some("Body"),Some("bad"),Some(&options)).is_err());
        let template=detail_path("community_guide_proposals_page").unwrap().0;
        assert_eq!(fill_path(template,&["c1".to_owned(),"20".to_owned()]).unwrap(),"/api/client/communities/c1/guides/proposals?offset=20");
        assert!(fill_path(template,&["c1".to_owned(),"20&other=1".to_owned()]).is_err());
    }

    #[test]
    fn community_appeal_paths_are_closed_and_bounded() {
        for (name,template,ids,expected) in [
            ("community_appeals","/api/client/communities/{a}/appeals",vec!["c1".to_owned()],"/api/client/communities/c1/appeals"),
            ("community_appeals_page","/api/client/communities/{a}/appeals?offset={b}",vec!["c1".to_owned(),"20".to_owned()],"/api/client/communities/c1/appeals?offset=20"),
            ("community_appeal","/api/client/communities/{a}/appeals/{b}",vec!["c1".to_owned(),"a1".to_owned()],"/api/client/communities/c1/appeals/a1"),
            ("community_appeal_history","/api/client/communities/{a}/my-appeals",vec!["c1".to_owned()],"/api/client/communities/c1/my-appeals")
        ] {
            assert_eq!(detail_path(name),Some((template,true)));assert_eq!(fill_path(template,&ids).unwrap(),expected);assert!(fill_path(template,&[]).is_err());
            for bad in ["".to_owned(),"../c1".to_owned(),"c1?other=1".to_owned(),"c1%2fadmin".to_owned(),"x".repeat(81)] {
                let mut changed=ids.clone();changed[0]=bad;assert!(fill_path(template,&changed).is_err());
            }
            let mut changed=ids;changed[0]="x".repeat(80);assert!(fill_path(template,&changed).is_ok());
        }
        for name in ["community_appeal_delete","community_appeals?url=/api/admin","/api/client/communities/c1/appeals"] {assert!(detail_path(name).is_none());}
        let template=detail_path("community_appeals_page").unwrap().0;
        for offset in ["0","9007199254740991"] {assert!(fill_path(template,&["c1".to_owned(),offset.to_owned()]).is_ok());}
        for offset in ["","01","-1","+1","1.5","1e2"," 1","1 ","20&other=1","9007199254740992","18446744073709551616"] {assert!(fill_path(template,&["c1".to_owned(),offset.to_owned()]).is_err());}
        let template=detail_path("community_appeal").unwrap().0;
        for appeal in ["".to_owned(),"../a1".to_owned(),"a1#admin".to_owned(),"x".repeat(81)] {assert!(fill_path(template,&["c1".to_owned(),appeal]).is_err());}
        assert!(fill_path(template,&["c1".to_owned(),"x".repeat(80)]).is_ok());assert!(fill_path(template,&["c1".to_owned()]).is_err());
    }

    #[test]
    fn community_appeal_submit_payload_is_closed_and_bounded() {
        let options=serde_json::json!({"reason":"  ".to_owned()+&"😀".repeat(20)+"  ","expectedSanctionKey":"0123456789abcdef".repeat(4),"memberActionId":"other","operationId":"other","url":"https://other.invalid/","path":"/api/admin","body":{"admin":true}});
        let (method,path,body)=action_request("community_appeal_submit",Some("c1"),Some("ignored"),Some(OP),Some(&options)).unwrap();
        assert_eq!(method,reqwest::Method::POST);assert_eq!(path,"/api/client/communities/c1/my-appeals");
        assert_eq!(body,serde_json::json!({"operationId":OP,"reason":"😀".repeat(20),"expectedSanctionKey":"0123456789abcdef".repeat(4)}));
        for key in ["reason","expectedSanctionKey"] {
            for value in [serde_json::Value::Null,serde_json::json!(1),serde_json::json!(true),serde_json::json!([]),serde_json::json!({})] {
                let mut bad=options.clone();bad[key]=value;assert!(action_request("community_appeal_submit",Some("c1"),None,Some(OP),Some(&bad)).is_err());
            }
            let mut bad=options.clone();bad.as_object_mut().unwrap().remove(key);assert!(action_request("community_appeal_submit",Some("c1"),None,Some(OP),Some(&bad)).is_err());
        }
        for sanction in ["".to_owned(),"a".repeat(63),"a".repeat(65),"A".repeat(64),"g".repeat(64),"ａ".repeat(64)," ".repeat(64)] {
            let mut bad=options.clone();bad["expectedSanctionKey"]=serde_json::json!(sanction);assert!(action_request("community_appeal_submit",Some("c1"),None,Some(OP),Some(&bad)).is_err());
        }
        for reason in ["".to_owned()," ".repeat(20),"  ".to_owned()+&"x".repeat(19)+"  ","😀".repeat(9)+"x","😀".repeat(10),"😀".repeat(19),"x".repeat(1001),"😀".repeat(500)+"x"] {
            let mut bad=options.clone();bad["reason"]=serde_json::json!(reason);assert!(action_request("community_appeal_submit",Some("c1"),None,Some(OP),Some(&bad)).is_err());
        }
        for reason in ["x".repeat(20),"😀".repeat(500)] {
            let mut value=options.clone();value["reason"]=serde_json::json!(reason);assert_eq!(action_request("community_appeal_submit",Some(&"c".repeat(80)),None,Some(OP),Some(&value)).unwrap().2["reason"],reason);
        }
        for target in [None,Some("../c1"),Some(""),Some(&"x".repeat(81))] {assert!(action_request("community_appeal_submit",target,None,Some(OP),Some(&options)).is_err());}
        for id in [None,Some(""),Some("not-a-uuid"),Some("00000000-0000-4000-8000-00000000000g")] {assert!(action_request("community_appeal_submit",Some("c1"),None,id,Some(&options)).is_err());}
        for values in [None,Some(serde_json::json!([])),Some(serde_json::json!("appeal")),Some(serde_json::json!(true))] {assert!(action_request("community_appeal_submit",Some("c1"),None,Some(OP),values.as_ref()).is_err());}
    }

    #[test]
    fn community_appeal_review_payload_is_closed_and_validates_types() {
        let options=serde_json::json!({"appealId":"a1","decision":"accepted","note":"  Checked appeal  ","expectedCreatedAt":"2026-10-02","expectedSanctionKey":"a".repeat(64),"url":"https://other.invalid/","path":"/api/admin","operationId":"other","role":"owner","body":{"admin":true}});
        for decision in ["accepted","rejected"] {
            let mut values=options.clone();values["decision"]=serde_json::json!(decision);
            let (method,path,body)=action_request("community_appeal_review",Some("c1"),Some("ignored"),Some(OP),Some(&values)).unwrap();
            assert_eq!(method,reqwest::Method::POST);assert_eq!(path,"/api/client/communities/c1/appeals/a1");
            assert_eq!(body,serde_json::json!({"operationId":OP,"decision":decision,"note":"Checked appeal","expectedCreatedAt":"2026-10-02","expectedSanctionKey":"a".repeat(64)}));
        }
        for key in ["appealId","decision","note","expectedCreatedAt","expectedSanctionKey"] {
            for value in [serde_json::Value::Null,serde_json::json!(1),serde_json::json!(true),serde_json::json!([]),serde_json::json!({})] {
                let mut bad=options.clone();bad[key]=value;assert!(action_request("community_appeal_review",Some("c1"),None,Some(OP),Some(&bad)).is_err());
            }
            let mut bad=options.clone();bad.as_object_mut().unwrap().remove(key);assert!(action_request("community_appeal_review",Some("c1"),None,Some(OP),Some(&bad)).is_err());
        }
        for (key,value) in [("appealId",serde_json::json!("a1?other=1")),("appealId",serde_json::json!("x".repeat(81))),("decision",serde_json::json!("approve")),("decision",serde_json::json!(" accepted"))] {
            let mut bad=options.clone();bad[key]=value;assert!(action_request("community_appeal_review",Some("c1"),None,Some(OP),Some(&bad)).is_err());
        }
        for sanction in ["".to_owned(),"a".repeat(63),"a".repeat(65),"A".repeat(64),"g".repeat(64),"ａ".repeat(64)," ".repeat(64)] {
            let mut bad=options.clone();bad["expectedSanctionKey"]=serde_json::json!(sanction);assert!(action_request("community_appeal_review",Some("c1"),None,Some(OP),Some(&bad)).is_err());
        }
        for target in [None,Some("../c1"),Some(""),Some(&"x".repeat(81))] {assert!(action_request("community_appeal_review",target,None,Some(OP),Some(&options)).is_err());}
        for id in [None,Some(""),Some("not-a-uuid"),Some("00000000-0000-4000-8000-00000000000g")] {assert!(action_request("community_appeal_review",Some("c1"),None,id,Some(&options)).is_err());}
        for values in [None,Some(serde_json::json!([])),Some(serde_json::json!("appeal")),Some(serde_json::json!(true))] {assert!(action_request("community_appeal_review",Some("c1"),None,Some(OP),values.as_ref()).is_err());}
        let mut boundary=options.clone();boundary["appealId"]=serde_json::json!("x".repeat(80));assert!(action_request("community_appeal_review",Some(&"x".repeat(80)),None,Some(OP),Some(&boundary)).is_ok());
        assert!(action_request("community_appeal_delete",Some("c1"),None,Some(OP),Some(&options)).is_err());
    }

    #[test]
    fn community_appeal_review_uses_trimmed_utf16_boundaries() {
        let options=serde_json::json!({"appealId":"a1","decision":"rejected","note":"Valid reason","expectedCreatedAt":"2026-10-02","expectedSanctionKey":"0123456789abcdef".repeat(4)});
        for note in ["  😀😀x  ".to_owned(),"😀".repeat(500)] {
            let mut value=options.clone();value["note"]=serde_json::json!(note);
            assert_eq!(action_request("community_appeal_review",Some("c1"),None,Some(OP),Some(&value)).unwrap().2["note"],note.trim());
        }
        for note in ["".to_owned(),"     ".to_owned(),"  four  ".to_owned(),"😀😀".to_owned(),"x".repeat(1001),"😀".repeat(500)+"x"] {
            let mut value=options.clone();value["note"]=serde_json::json!(note);assert!(action_request("community_appeal_review",Some("c1"),None,Some(OP),Some(&value)).is_err());
        }
        for expected in ["x".repeat(80),"😀".repeat(40)] {
            let mut value=options.clone();value["expectedCreatedAt"]=serde_json::json!(expected);assert!(action_request("community_appeal_review",Some("c1"),None,Some(OP),Some(&value)).is_ok());
        }
        for expected in ["".to_owned(),"x".repeat(81),"😀".repeat(40)+"x"] {
            let mut value=options.clone();value["expectedCreatedAt"]=serde_json::json!(expected);assert!(action_request("community_appeal_review",Some("c1"),None,Some(OP),Some(&value)).is_err());
        }
    }

    #[test]
    fn community_report_paths_are_closed_and_bounded() {
        for (name,template,ids,expected) in [
            ("community_reports","/api/client/communities/{a}/reports",vec!["c1".to_owned()],"/api/client/communities/c1/reports"),
            ("community_reports_page","/api/client/communities/{a}/reports?offset={b}",vec!["c1".to_owned(),"20".to_owned()],"/api/client/communities/c1/reports?offset=20"),
            ("community_report","/api/client/communities/{a}/reports/{b}",vec!["c1".to_owned(),"r1".to_owned()],"/api/client/communities/c1/reports/r1")
        ] {
            assert_eq!(detail_path(name),Some((template,true)));
            assert_eq!(fill_path(template,&ids).unwrap(),expected);
            assert!(fill_path(template,&[]).is_err());
            for bad in ["".to_owned(),"../c1".to_owned(),"c1?admin=1".to_owned(),"c1%2fadmin".to_owned(),"x".repeat(81)] {
                let mut changed=ids.clone();changed[0]=bad;assert!(fill_path(template,&changed).is_err());
            }
            let mut changed=ids;changed[0]="x".repeat(80);assert!(fill_path(template,&changed).is_ok());
        }
        for name in ["community_report_delete","community_reports?url=/api/admin","/api/client/communities/c1/reports"] {assert!(detail_path(name).is_none());}
        let template=detail_path("community_reports_page").unwrap().0;
        for offset in ["0","9007199254740991"] {assert!(fill_path(template,&["c1".to_owned(),offset.to_owned()]).is_ok());}
        for offset in ["","01","-1","+1","1.5","1e2"," 1","1 ","20&other=1","9007199254740992","18446744073709551616"] {assert!(fill_path(template,&["c1".to_owned(),offset.to_owned()]).is_err());}
        let template=detail_path("community_report").unwrap().0;
        for report in ["".to_owned(),"../r1".to_owned(),"r1#admin".to_owned(),"x".repeat(81)] {assert!(fill_path(template,&["c1".to_owned(),report]).is_err());}
        assert!(fill_path(template,&["c1".to_owned(),"x".repeat(80)]).is_ok());
        assert!(fill_path(template,&["c1".to_owned()]).is_err());
    }

    #[test]
    fn community_report_review_payload_is_closed_and_validates_types() {
        let options=serde_json::json!({"reportId":"r1","decision":"actioned","note":"  Checked report  ","expectedCreatedAt":"2026-10-02","expectedMessageEditedAt":null,"url":"https://other.invalid/","path":"/api/admin","operationId":"other","requestId":"other","role":"owner","body":{"admin":true}});
        for decision in ["actioned","dismissed"] {
            let mut values=options.clone();values["decision"]=serde_json::json!(decision);
            values["expectedMessageEditedAt"]=if decision=="actioned" {serde_json::Value::Null} else {serde_json::json!("2026-10-02T01:00:00.000Z")};
            let (method,path,body)=action_request("community_report_review",Some("c1"),Some("ignored"),Some(OP),Some(&values)).unwrap();
            assert_eq!(method,reqwest::Method::POST);assert_eq!(path,"/api/client/communities/c1/reports/r1");
            assert_eq!(body,serde_json::json!({"operationId":OP,"decision":decision,"note":"Checked report","expectedCreatedAt":"2026-10-02","expectedMessageEditedAt":values["expectedMessageEditedAt"]}));
        }
        for key in ["reportId","decision","note","expectedCreatedAt"] {
            for value in [serde_json::Value::Null,serde_json::json!(1),serde_json::json!(true),serde_json::json!([]),serde_json::json!({})] {
                let mut bad=options.clone();bad[key]=value;assert!(action_request("community_report_review",Some("c1"),None,Some(OP),Some(&bad)).is_err());
            }
            let mut bad=options.clone();bad.as_object_mut().unwrap().remove(key);assert!(action_request("community_report_review",Some("c1"),None,Some(OP),Some(&bad)).is_err());
        }
        for (key,value) in [("reportId",serde_json::json!("r1?other=1")),("reportId",serde_json::json!("x".repeat(81))),("decision",serde_json::json!("approve")),("decision",serde_json::json!(" actioned"))] {
            let mut bad=options.clone();bad[key]=value;assert!(action_request("community_report_review",Some("c1"),None,Some(OP),Some(&bad)).is_err());
        }
        for edited in [serde_json::json!(1),serde_json::json!(true),serde_json::json!([]),serde_json::json!({})] {
            let mut bad=options.clone();bad["expectedMessageEditedAt"]=edited;assert!(action_request("community_report_review",Some("c1"),None,Some(OP),Some(&bad)).is_err());
        }
        let mut missing=options.clone();missing.as_object_mut().unwrap().remove("expectedMessageEditedAt");assert!(action_request("community_report_review",Some("c1"),None,Some(OP),Some(&missing)).is_err());
        for target in [None,Some("../c1"),Some(""),Some(&"x".repeat(81))] {assert!(action_request("community_report_review",target,None,Some(OP),Some(&options)).is_err());}
        for id in [None,Some(""),Some("not-a-uuid"),Some("00000000-0000-4000-8000-00000000000g")] {assert!(action_request("community_report_review",Some("c1"),None,id,Some(&options)).is_err());}
        for values in [None,Some(serde_json::json!([])),Some(serde_json::json!("report")),Some(serde_json::json!(true))] {assert!(action_request("community_report_review",Some("c1"),None,Some(OP),values.as_ref()).is_err());}
        assert!(action_request("community_report_delete",Some("c1"),None,Some(OP),Some(&options)).is_err());
    }

    #[test]
    fn community_report_review_uses_trimmed_utf16_boundaries() {
        let options=serde_json::json!({"reportId":"r1","decision":"dismissed","note":"Valid reason","expectedCreatedAt":"2026-10-02","expectedMessageEditedAt":null});
        for note in ["  😀😀x  ".to_owned(),"😀".repeat(500)] {
            let mut value=options.clone();value["note"]=serde_json::json!(note);
            assert_eq!(action_request("community_report_review",Some("c1"),None,Some(OP),Some(&value)).unwrap().2["note"],note.trim());
        }
        for note in ["".to_owned(),"     ".to_owned(),"  four  ".to_owned(),"😀😀".to_owned(),"x".repeat(1001),"😀".repeat(500)+"x"] {
            let mut value=options.clone();value["note"]=serde_json::json!(note);assert!(action_request("community_report_review",Some("c1"),None,Some(OP),Some(&value)).is_err());
        }
        for key in ["expectedCreatedAt","expectedMessageEditedAt"] {
            for expected in ["x".repeat(80),"😀".repeat(40)] {
                let mut value=options.clone();value[key]=serde_json::json!(expected);assert!(action_request("community_report_review",Some("c1"),None,Some(OP),Some(&value)).is_ok());
            }
            for expected in ["".to_owned(),"x".repeat(81),"😀".repeat(40)+"x"] {
                let mut value=options.clone();value[key]=serde_json::json!(expected);assert!(action_request("community_report_review",Some("c1"),None,Some(OP),Some(&value)).is_err());
            }
        }
    }

    #[test]
    fn membership_review_paths_and_payload_are_closed() {
        let template=detail_path("community_membership_requests_page").unwrap().0;
        assert_eq!(fill_path(template,&["c1".to_owned(),"20".to_owned()]).unwrap(),"/api/client/communities/c1/membership-requests?offset=20");
        for value in ["01","-1","20&other=1","9007199254740992"] {assert!(fill_path(template,&["c1".to_owned(),value.to_owned()]).is_err());}
        let options=serde_json::json!({"profileId":"p1","decision":"approve","note":"Checked answers","expectedCreatedAt":"2026-10-02","url":"https://other.invalid/","role":"owner"});
        let (method,path,body)=action_request("community_membership_review",Some("c1"),Some("ignored"),Some(OP),Some(&options)).unwrap();
        assert_eq!(method,reqwest::Method::POST);assert_eq!(path,"/api/client/communities/c1/membership-requests/p1");
        assert_eq!(body,serde_json::json!({"operationId":OP,"decision":"approve","note":"Checked answers","expectedCreatedAt":"2026-10-02"}));
        for (key,value) in [("profileId",serde_json::json!("p1?other=1")),("profileId",serde_json::json!("x".repeat(81))),("decision",serde_json::json!("owner")),("note",serde_json::json!("four")),("note",serde_json::json!("😀".repeat(501))),("expectedCreatedAt",serde_json::json!("")),("expectedCreatedAt",serde_json::json!("x".repeat(81)))] {
            let mut changed=options.clone();changed[key]=value;assert!(action_request("community_membership_review",Some("c1"),None,Some(OP),Some(&changed)).is_err());
        }
        assert!(action_request("community_membership_review",Some("c1"),None,Some("bad"),Some(&options)).is_err());
    }

    #[test]
    fn community_guide_directory_paths_are_bounded_and_fixed() {
        let template=detail_path("community_guides_directory_page").unwrap().0;
        assert_eq!(fill_path(template,&["c1".to_owned(),"20".to_owned(),"d-1".to_owned()]).unwrap(),"/api/client/communities/c1/guides?offset=20&directory=d-1");
        for value in ["", "01", "-1", "20&directory=x", "9007199254740992"] {assert!(fill_path(template,&["c1".to_owned(),value.to_owned(),"d1".to_owned()]).is_err());}
        for value in ["".to_owned(),"../d1".to_owned(),"d1&other=x".to_owned()," d1".to_owned(),"x".repeat(81)] {assert!(fill_path(template,&["c1".to_owned(),"0".to_owned(),value]).is_err());}
        assert!(fill_path(template,&["c1".to_owned(),"0".to_owned()]).is_err());
    }

    #[test]
    fn community_guide_read_paths_are_bounded_and_fixed() {
        for (name,ids,expected) in [
            ("community_guides_page",vec!["c1".to_owned(),"20".to_owned()],"/api/client/communities/c1/guides?offset=20"),
            ("community_guide_revision",vec!["c1".to_owned(),"g1".to_owned(),"r1".to_owned()],"/api/client/communities/c1/guides/g1/revisions/r1"),
            ("community_guide_revisions_page",vec!["c1".to_owned(),"g1".to_owned(),"0".to_owned()],"/api/client/communities/c1/guides/g1/revisions?offset=0")
        ] { let (template,viewer)=detail_path(name).unwrap();assert!(viewer);assert_eq!(fill_path(template,&ids).unwrap(),expected); }
        let template=detail_path("community_guides_page").unwrap().0;
        for value in ["", "01", "-1", "1.5", "1e2", "20&other=1", "9007199254740992"] {assert!(fill_path(template,&["c1".to_owned(),value.to_owned()]).is_err());}
        assert!(fill_path(template,&["../c1".to_owned(),"0".to_owned()]).is_err());
    }

    #[test]
    fn thread_knowledge_pagination_is_bounded_and_fixed() {
        let template=detail_path("thread_knowledge_before").unwrap().0;
        assert_eq!(fill_path(template,&["t1".to_owned(),"40".to_owned()]).unwrap(),"/api/client/threads/t1/knowledge-platform?before=40");
        assert!(fill_path(template,&["t1".to_owned(),"9007199254740991".to_owned()]).is_ok());
        for value in ["", "0", "01", "-1", "1.5", "1e2", "40&other=1", "9007199254740992"] { assert!(fill_path(template,&["t1".to_owned(),value.to_owned()]).is_err()); }
        assert!(fill_path(template,&["../t1".to_owned(),"40".to_owned()]).is_err());
    }

    #[test]
    fn thread_knowledge_actions_are_bounded_and_fixed() {
        let id="f193db20-43e5-4a97-9ed4-2d54b542337b";
        assert_eq!(detail_path("thread_knowledge"),Some(("/api/client/threads/{a}/knowledge-platform",true)));
        let input=serde_json::json!({"summaryId":"s1","kind":"tag","value":"研究","title":"題".repeat(100),"identityMode":"anonymous","url":"https://untrusted.invalid"});
        let (_,path,body)=action_request("thread_summary_propose",Some("t1"),Some(&"😀".repeat(20)),Some(id),Some(&input)).unwrap();
        assert_eq!(path,"/api/client/threads/t1/knowledge-platform"); assert_eq!(body["action"],"propose_summary"); assert!(body.get("url").is_none());
        for value in ["x".repeat(19),"😀".repeat(19),"x".repeat(12001),"😀".repeat(6001)] { assert!(action_request("thread_summary_propose",Some("t1"),Some(&value),Some(id),None).is_err()); }
        assert!(action_request("thread_summary_propose",Some("t1"),Some(&"x".repeat(20)),Some("wrong"),None).is_err());
        assert!(action_request("thread_summary_publish",Some("../t1"),None,None,Some(&input)).is_err());
        assert!(action_request("thread_summary_publish",Some("t1"),None,None,Some(&serde_json::json!({"summaryId":"x".repeat(65)}))).is_err());
        assert!(action_request("thread_topic_subscribe",Some("t1"),None,None,Some(&input)).is_ok());
        for bad in [serde_json::json!({"kind":"other","value":"research"}),serde_json::json!({"kind":"tag","value":"😀".repeat(51)}),serde_json::json!({"kind":"tag","value":""})] { assert!(action_request("thread_topic_subscribe",Some("t1"),None,None,Some(&bad)).is_err()); }
        assert!(action_request("thread_continue",Some("t1"),Some(&"本".repeat(4000)),Some(id),Some(&input)).is_ok());
        for value in ["x".repeat(29),"😀".repeat(2001)] { assert!(action_request("thread_continue",Some("t1"),Some(&value),Some(id),Some(&input)).is_err()); }
        assert_eq!(action_request("thread_unarchive",Some("t1"),None,None,None).unwrap().2,serde_json::json!({"action":"unarchive"}));
    }

    #[test]
    fn community_onboarding_and_cancellation_are_bounded_and_fixed() {
        let input = serde_json::json!({"acceptedRules":true,"answers":[{"questionId":"q1","answer":"目的"}]});
        let (method,path,body) = action_request("community_join_complete",Some("c1"),None,None,Some(&input)).unwrap();
        assert_eq!(method,reqwest::Method::POST);
        assert_eq!(path,"/api/client/communities/c1/onboarding");
        assert_eq!(body,serde_json::json!({"acceptedRules":true,"answers":[{"questionId":"q1","answer":"目的"}]}));
        assert_eq!(detail_path("community_onboarding"),Some(("/api/client/communities/{a}/onboarding",true)));
        for bad in [serde_json::json!({"answers":[]}),serde_json::json!({"acceptedRules":false,"answers":[]}),serde_json::json!({"acceptedRules":true,"answers":null}),serde_json::json!({"acceptedRules":true,"answers":[null]}),serde_json::json!({"acceptedRules":true,"answers":[{"questionId":"../q1","answer":"x"}]}),serde_json::json!({"acceptedRules":true,"answers":[{"questionId":"q1","answer":"x"},{"questionId":"q1","answer":"y"}]}),serde_json::json!({"acceptedRules":true,"answers":[{"questionId":"q1","answer":"x".repeat(1001)}]}),serde_json::json!({"acceptedRules":true,"answers":vec![serde_json::json!({"questionId":"q1","answer":"x"});21]})] {
            assert!(action_request("community_join_complete",Some("c1"),None,None,Some(&bad)).is_err());
        }
        let edge = serde_json::json!({"acceptedRules":true,"answers":[{"questionId":"q1","answer":"😀".repeat(500)}]});
        assert!(action_request("community_join_complete",Some("c1"),None,None,Some(&edge)).is_ok());
        assert!(action_request("community_join_complete",Some("../c1"),None,None,Some(&input)).is_err());
        let id="11111111-2222-3333-4444-555555555555";
        let (method,path,body)=action_request("community_cancel_request",Some("c1"),None,Some(id),None).unwrap();
        assert_eq!(method,reqwest::Method::DELETE); assert_eq!(path,"/api/client/communities/c1/membership"); assert_eq!(body,serde_json::json!({"operationId":id}));
        for bad in [None,Some("------------------------------------"),Some("11111111222233334444555555555555")] { assert!(action_request("community_cancel_request",Some("c1"),None,bad,None).is_err()); }
    }

    #[test]
    fn community_governance_mutation_is_fixed_and_strict() {
        let input=serde_json::json!({"operationId":"11111111-2222-4333-8444-555555555555","snapshot":"a".repeat(64),"choice":"for"});
        for choice in ["for","against","abstain"] {let mut body=input.clone();body["choice"]=serde_json::json!(choice);let(method,path,out)=action_request("community_governance_vote",Some("c1"),Some("p1"),None,Some(&body)).unwrap();assert_eq!(method,reqwest::Method::POST);assert_eq!(path,"/api/client/communities/c1/governance/proposals/p1/votes");assert_eq!(out,body);}
        for action in ["start_voting","close_voting","execute","cancel"] {let body=serde_json::json!({"operationId":input["operationId"],"snapshot":input["snapshot"],"action":action});let(method,path,out)=action_request("community_governance_lifecycle",Some("c1"),Some("p1"),None,Some(&body)).unwrap();assert_eq!(method,reqwest::Method::PATCH);assert_eq!(path,"/api/client/communities/c1/governance/proposals/p1");assert_eq!(out,body);}
        for key in ["operationId","snapshot","choice"] {let mut body=input.clone();body.as_object_mut().unwrap().remove(key);assert!(community_governance_mutation_action("community_governance_vote",Some("c1"),Some("p1"),Some(&body)).is_err());}
        for(key,value)in [("operationId",serde_json::json!("11111111-2222-4333-8444-55555555555A")),("snapshot",serde_json::json!("A".repeat(64))),("snapshot",serde_json::json!("a".repeat(63))),("choice",serde_json::json!(true)),("choice",serde_json::json!("cancel")),("weight",serde_json::json!(100)),("proposalId",serde_json::json!("foreign"))] {let mut body=input.clone();body[key]=value;assert!(community_governance_mutation_action("community_governance_vote",Some("c1"),Some("p1"),Some(&body)).is_err());}
        for bad in ["".to_owned(),"p1\n".to_owned(),"../p1".to_owned(),"x".repeat(101)] {assert!(community_governance_mutation_action("community_governance_vote",Some("c1"),Some(&bad),Some(&input)).is_err());assert!(community_governance_mutation_action("community_governance_vote",Some(&bad),Some("p1"),Some(&input)).is_err());}
        assert!(community_governance_mutation_action("community_governance_vote",Some(&"c".repeat(100)),Some(&"p".repeat(100)),Some(&input)).is_ok());
        assert_eq!(detail_path("community_governance_mutation_context"),Some(("/api/client/communities/{a}/governance/proposals/{b}/context",true)));
    }

    #[test]
    fn community_governance_create_is_fixed_and_bounded() {
        let input=serde_json::json!({"operationId":"11111111-2222-4333-8444-555555555555","snapshot":"ab".repeat(32),"kind":"rule","title":"五文字の提案","body":"本体と投票条件を一括で保存するための提案です。","linkedGuideProposalId":null,"votingMethod":"one_member_one_vote","decisionScope":"community","executionMode":"operator","snapshotPolicy":"proposal_start","quorumMemberBps":2000,"quorumTokenBps":0,"approvalBps":5001});
        let (method,path,body)=action_request("community_governance_create_proposal",Some("c1"),None,None,Some(&input)).unwrap();
        assert_eq!(method,reqwest::Method::POST);assert_eq!(path,"/api/client/communities/c1/governance/proposals");assert_eq!(body,input);
        for key in input.as_object().unwrap().keys(){let mut bad=input.clone();bad.as_object_mut().unwrap().remove(key);assert!(community_governance_create_action(Some("c1"),Some(&bad)).is_err(),"missing {key}");}
        for (key,value) in [("operationId",serde_json::json!("11111111-2222-4333-8444-55555555555A")),("snapshot",serde_json::json!("A".repeat(64))),("kind",serde_json::json!("other")),("linkedGuideProposalId",serde_json::json!("p1\n")),("quorumMemberBps",serde_json::json!(1.5)),("quorumTokenBps",serde_json::json!("2000")),("approvalBps",serde_json::json!(0)),("approvalBps",serde_json::json!(10001)),("decisionScope",serde_json::json!("hub_policy")),("extra",serde_json::json!(true))]{let mut bad=input.clone();bad[key]=value;assert!(community_governance_create_action(Some("c1"),Some(&bad)).is_err(),"{key}");}
        for (key,min,max) in [("title",5,120),("body",20,4000)]{for (n,ok) in [(min-1,false),(min,true),(max,true),(max+1,false)]{let mut changed=input.clone();changed[key]=serde_json::json!("x".repeat(n));assert_eq!(community_governance_create_action(Some("c1"),Some(&changed)).is_ok(),ok,"{key} {n}");}let mut astral=input.clone();astral[key]=serde_json::json!("😀".repeat(max/2));assert!(community_governance_create_action(Some("c1"),Some(&astral)).is_ok());astral[key]=serde_json::json!("😀".repeat(max/2+1));assert!(community_governance_create_action(Some("c1"),Some(&astral)).is_err());}
        for bad in ["".to_owned()," c1".to_owned(),"c1\n".to_owned(),"x".repeat(101),"../c1".to_owned()]{assert!(community_governance_create_action(Some(&bad),Some(&input)).is_err());}
        let mut permitted=input.clone();permitted["kind"]=serde_json::json!("moderator");permitted["decisionScope"]=serde_json::json!("moderation");permitted["executionMode"]=serde_json::json!("advisory");assert!(community_governance_create_action(Some(&"c".repeat(100)),Some(&permitted)).is_ok());permitted["votingMethod"]=serde_json::json!("token_linear");assert!(community_governance_create_action(Some("c1"),Some(&permitted)).is_err());
        for method in ["one_member_one_vote","one_holder_one_vote","token_linear","token_sqrt","token_log","dual_chamber"]{let mut changed=input.clone();changed["votingMethod"]=serde_json::json!(method);assert!(community_governance_create_action(Some("c1"),Some(&changed)).is_ok());}
        let template=detail_path("community_governance_create_context").unwrap();assert!(template.1);assert_eq!(fill_path(template.0,&["c1".into()]).unwrap(),"/api/client/communities/c1/governance/proposals/context");assert!(fill_path(template.0,&["c1".into(),"extra".into()]).is_err());
    }

    #[test]
    fn community_governance_settings_are_fixed_and_bounded() {
        let options=serde_json::json!({"operationId":"00000000-0000-4000-8000-000000000001","snapshot":"a".repeat(64),"votingStrategy":"one_member_one_vote","tokenRules":[],"voteWeightCap":null});
        let (method,path,body)=action_request("community_governance_settings",Some("c1"),None,None,Some(&options)).unwrap();
        assert_eq!(method,reqwest::Method::PATCH);assert_eq!(path,"/api/client/communities/c1/governance/settings");assert_eq!(body,options);
        for key in ["operationId","snapshot","votingStrategy","tokenRules","voteWeightCap"] {let mut bad=options.clone();bad.as_object_mut().unwrap().remove(key);assert!(community_governance_settings_action(Some("c1"),Some(&bad)).is_err());}
        for (key,value) in [("operationId",serde_json::json!("00000000-0000-4000-8000-00000000000A")),("snapshot",serde_json::json!("A".repeat(64))),("votingStrategy",serde_json::json!("bad")),("voteWeightCap",serde_json::json!(1)),("extra",serde_json::json!(true))] {let mut bad=options.clone();bad[key]=value;assert!(community_governance_settings_action(Some("c1"),Some(&bad)).is_err(),"{key}");}
        let mut weighted=options.clone();weighted["votingStrategy"]=serde_json::json!("token_capped");weighted["tokenRules"]=serde_json::json!([{"tokenId":"t1","tokensPerVote":1.0,"weight":1000.0}]);weighted["voteWeightCap"]=serde_json::json!(9007199254740991u64);
        assert!(community_governance_settings_action(Some(&"c".repeat(100)),Some(&weighted)).is_ok());
        for value in [serde_json::json!(0),serde_json::json!(1.5),serde_json::json!(9007199254740992u64),serde_json::json!("2"),serde_json::Value::Null] {let mut bad=weighted.clone();bad["voteWeightCap"]=value;assert!(community_governance_settings_action(Some("c1"),Some(&bad)).is_err());}
        for (key,value) in [("tokenId",serde_json::json!("t1\n")),("tokensPerVote",serde_json::json!(0)),("tokensPerVote",serde_json::json!(9007199254740992u64)),("tokensPerVote",serde_json::json!("2")),("weight",serde_json::json!(1000.01)),("weight",serde_json::json!(true)),("extra",serde_json::json!(true))] {let mut bad=weighted.clone();bad["tokenRules"][0][key]=value;assert!(community_governance_settings_action(Some("c1"),Some(&bad)).is_err(),"{key}");}
        let mut duplicate=weighted.clone();duplicate["tokenRules"].as_array_mut().unwrap().push(weighted["tokenRules"][0].clone());assert!(community_governance_settings_action(Some("c1"),Some(&duplicate)).is_err());
        for count in [100usize,101] {let mut changed=weighted.clone();changed["tokenRules"]=serde_json::json!((0..count).map(|i|serde_json::json!({"tokenId":format!("t{i}"),"tokensPerVote":1,"weight":1})).collect::<Vec<_>>());assert_eq!(community_governance_settings_action(Some("c1"),Some(&changed)).is_ok(),count==100);}
        for bad in ["".to_owned()," c1".to_owned(),"c1\n".to_owned(),"x".repeat(101),"../c1".to_owned()] {assert!(community_governance_settings_action(Some(&bad),Some(&options)).is_err());}
        for (name,ids,expected) in [("community_governance",vec!["c1".to_owned()],"/api/client/communities/c1/governance/proposals"),("community_governance_page",vec!["c1".to_owned(),"20".to_owned()],"/api/client/communities/c1/governance/proposals?offset=20"),("community_governance_proposal",vec!["c1".to_owned(),"p1".to_owned()],"/api/client/communities/c1/governance/proposals/p1"),("community_governance_settings",vec!["c1".to_owned()],"/api/client/communities/c1/governance/settings")] {let (template,auth)=detail_path(name).unwrap();assert!(auth);assert_eq!(fill_path(template,&ids).unwrap(),expected);let mut extra=ids.clone();extra.push("ignored".into());assert!(fill_path(template,&extra).is_err());}
        let template=detail_path("community_governance_page").unwrap().0;
        for offset in ["-1","01","1e2","2.5","20&private=true","9007199254740972"] {assert!(fill_path(template,&["c1".into(),offset.into()]).is_err());}
        assert!(fill_path(template,&["c".repeat(100),"9007199254740971".into()]).is_ok());
        assert!(fill_path(detail_path("community_governance_proposal").unwrap().0,&["c1".into(),"p".repeat(100)]).is_ok());
        assert!(fill_path(template,&["c".repeat(101),"0".into()]).is_err());
    }

    #[test]
    fn community_join_operation_is_fixed_and_bounded() {
        let operation = "11111111-2222-3333-4444-555555555555";
        let snapshot = "ab".repeat(32);
        let input = serde_json::json!({"operationId":operation,"snapshot":snapshot,"acceptedRules":false,"answers":[{"questionId":"q1","answer":"\u{feff} Ｈｕｂ \u{feff}"}]});
        let (method,path,body) = action_request("community_join_complete",Some("c1"),None,None,Some(&input)).unwrap();
        assert_eq!(method,reqwest::Method::POST);
        assert_eq!(path,"/api/client/communities/c1/onboarding");
        assert_eq!(body,serde_json::json!({"operationId":operation,"snapshot":snapshot,"acceptedRules":false,"answers":[{"questionId":"q1","answer":"Hub"}]}));
        for target in ["", "../c1", "https://foreign.invalid", "c1\n", " c1", &"c".repeat(101)] {
            assert!(action_request("community_join_complete",Some(target),None,None,Some(&input)).is_err());
        }
        assert!(action_request("community_join_complete",Some(&"c".repeat(100)),None,None,Some(&input)).is_ok());
        for (key,value) in [
            ("operationId",serde_json::json!("------------------------------------")),
            ("operationId",serde_json::json!("ABCDEFAB-cdef-4abc-8def-abcdefabcdef")),
            ("operationId",serde_json::json!("11111111222233334444555555555555")),
            ("snapshot",serde_json::json!("AB".repeat(32))),
            ("snapshot",serde_json::json!(format!("{}\n",snapshot))),
            ("acceptedRules",serde_json::json!("false")),
            ("answers",serde_json::json!([{ "questionId":"q1\n","answer":"x" }])),
            ("answers",serde_json::json!([{ "questionId":"q1","answer":"x","extra":true }])),
            ("answers",serde_json::json!([{ "questionId":"q1","answer":"x" },{ "questionId":"q1","answer":"y" }])),
            ("answers",serde_json::json!([{ "questionId":"q1","answer":"😀".repeat(501) }])),
            ("answers",serde_json::json!([{ "questionId":"q1","answer":" ".repeat(1001) }])),
            ("answers",serde_json::json!([{ "questionId":"q1","answer":"ﷺ".repeat(60) }])),
            ("answers",serde_json::json!([{ "questionId":"q".repeat(101),"answer":"x" }])),
            ("answers",serde_json::json!((0..21).map(|i|serde_json::json!({"questionId":format!("q{i}"),"answer":"x"})).collect::<Vec<_>>())),
        ] {
            let mut bad=input.clone();bad[key]=value;
            assert!(action_request("community_join_complete",Some("c1"),None,None,Some(&bad)).is_err(),"{key}");
        }
        for missing in ["operationId","snapshot","acceptedRules","answers"] {
            let mut bad=input.clone();bad.as_object_mut().unwrap().remove(missing);
            assert!(action_request("community_join_complete",Some("c1"),None,None,Some(&bad)).is_err());
        }
        let mut extra=input.clone();extra["extra"]=serde_json::json!(true);
        assert!(action_request("community_join_complete",Some("c1"),None,None,Some(&extra)).is_err());
        let mut edge=input.clone();edge["answers"]=serde_json::json!((0..20).map(|i|serde_json::json!({"questionId":format!("q{i}"),"answer":"😀".repeat(500)})).collect::<Vec<_>>());
        assert!(action_request("community_join_complete",Some("c1"),None,None,Some(&edge)).is_ok());
        let legacy_extra=serde_json::json!({"acceptedRules":true,"answers":[],"extra":true});
        assert!(action_request("community_join_complete",Some("c1"),None,None,Some(&legacy_extra)).is_err());
    }

    #[test]
    fn community_invite_acceptance_is_fixed_and_bounded() {
        let code = "ab".repeat(16);
        let operation = "11111111-2222-3333-4444-555555555555";
        let input = serde_json::json!({"snapshot":"ab".repeat(32),"acceptedRules":true,"answers":[{"questionId":"q1","answer":"  Ｈｕｂ  "}]});
        let (method, path, body) = action_request("community_invite_accept", Some(&code), None, Some(operation), Some(&input)).unwrap();
        assert_eq!(method, reqwest::Method::POST);
        assert_eq!(path, format!("/api/client/community-invites/{code}"));
        assert_eq!(body, serde_json::json!({"operationId":operation,"snapshot":"ab".repeat(32),"acceptedRules":true,"answers":[{"questionId":"q1","answer":"Hub"}]}));
        assert_eq!(detail_path("community_invite"), Some(("/api/client/community-invites/{a}", true)));
        for target in ["", "https://foreign.invalid/invite", "../code", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"] {
            assert!(action_request("community_invite_accept", Some(target), None, Some(operation), Some(&input)).is_err());
        }
        for id in [None, Some("------------------------------------"), Some("11111111222233334444555555555555"), Some("abcdefAB-cdef-4abc-8def-abcdefabcdef")] {
            assert!(action_request("community_invite_accept", Some(&code), None, id, Some(&input)).is_err());
        }
        for invalid in [
            serde_json::json!({"snapshot":"ab".repeat(32),"acceptedRules":true}),
            serde_json::json!({"snapshot":"ab".repeat(32),"acceptedRules":true,"answers":[],"extra":1}),
            serde_json::json!({"snapshot":"AB".repeat(32),"acceptedRules":true,"answers":[]}),
            serde_json::json!({"snapshot":"ab".repeat(32),"acceptedRules":"true","answers":[]}),
            serde_json::json!({"snapshot":"ab".repeat(32),"acceptedRules":true,"answers":[null]}),
            serde_json::json!({"snapshot":"ab".repeat(32),"acceptedRules":true,"answers":[{"questionId":"q1\n","answer":"x"}]}),
            serde_json::json!({"snapshot":"ab".repeat(32),"acceptedRules":true,"answers":[{"questionId":"q1","answer":"x","extra":1}]}),
            serde_json::json!({"snapshot":"ab".repeat(32),"acceptedRules":true,"answers":[{"questionId":"q1","answer":"x"},{"questionId":"q1","answer":"y"}]}),
            serde_json::json!({"snapshot":"ab".repeat(32),"acceptedRules":true,"answers":[{"questionId":"q1","answer":"😀".repeat(501)}]}),
            serde_json::json!({"snapshot":"ab".repeat(32),"acceptedRules":true,"answers":[{"questionId":"q1","answer":"㍍".repeat(251)}]}),
            serde_json::json!({"snapshot":"ab".repeat(32),"acceptedRules":true,"answers":(0..21).map(|i|serde_json::json!({"questionId":format!("q{i}"),"answer":"x"})).collect::<Vec<_>>()})
        ] {
            assert!(action_request("community_invite_accept", Some(&code), None, Some(operation), Some(&invalid)).is_err());
        }
        let edge = serde_json::json!({"snapshot":"ab".repeat(32),"acceptedRules":false,"answers":(0..20).map(|i|serde_json::json!({"questionId":format!("q{i}"),"answer":"😀".repeat(500)})).collect::<Vec<_>>()});
        let (_, _, result) = action_request("community_invite_accept", Some(&code), None, Some(operation), Some(&edge)).unwrap();
        assert_eq!(result["answers"].as_array().unwrap().len(), 20);
        assert_eq!(result["acceptedRules"], false);
    }

    #[test]
    fn community_actions_are_closed_and_reconstruct_only_expected_fields() {
        let options=serde_json::json!({"channelId":"ch-1","name":"一般","description":"説明","url":"https://other.invalid/","profileId":"p-1","note":"理由"});
        let (method,path,body)=action_request("community_channel_create",Some("c-1"),None,None,Some(&options)).unwrap();
        assert_eq!(method,reqwest::Method::POST);assert_eq!(path,"/api/client/communities/c-1/channels");assert_eq!(body,serde_json::json!({"name":"一般","description":"説明"}));
        let (_,path,body)=action_request("community_member_ban",Some("c-1"),None,Some(OP),Some(&options)).unwrap();
        assert_eq!(path,"/api/client/communities/c-1/members/p-1");assert_eq!(body["action"],"ban");assert_eq!(body["operationId"],OP);assert!(body.get("url").is_none());
        assert!(action_request("community_member_owner",Some("c-1"),None,Some(OP),Some(&options)).is_err());
        assert!(action_request("community_channel_delete",Some("c-1"),None,None,Some(&options)).is_err());
        assert_eq!(detail_path("community_members"),Some(("/api/client/communities/{a}/members",true)));
        assert!(path_segment(Some("scheduled:00000000-0000-4000-8000-000000000001")).is_ok());
        assert!(path_segment(Some("scheduled:../../outside")).is_err());
    }
    #[test]
    fn poll_and_schedule_boundaries_reject_bad_ids_sizes_and_kinds() {
        let mut options=serde_json::json!({"channelId":"ch-1","question":"Q","choices":["A","B"],"closesInHours":72,"kind":"chat","scheduledAt":"2026-10-02T00:00:00Z"});
        let (_,_,body)=action_request("community_poll_create",Some("c-1"),None,Some(OP),Some(&options)).unwrap();assert_eq!(body["options"],serde_json::json!(["A","B"]));
        options["choices"]=serde_json::json!(["only"]);assert!(action_request("community_poll_create",Some("c-1"),None,Some(OP),Some(&options)).is_err());
        options["choices"]=serde_json::json!(["A",1]);assert!(action_request("community_poll_create",Some("c-1"),None,Some(OP),Some(&options)).is_err());
        options["channelId"]=serde_json::json!("../../outside");assert!(action_request("community_message_schedule",Some("c-1"),Some("Body"),Some(OP),Some(&options)).is_err());
        options["channelId"]=serde_json::json!("ch-1");options["kind"]=serde_json::json!("admin");assert!(action_request("community_message_schedule",Some("c-1"),Some("Body"),Some(OP),Some(&options)).is_err());
        options["kind"]=serde_json::json!("chat");assert!(action_request("community_message_schedule",Some("c-1"),Some(&"あ".repeat(2001)),Some(OP),Some(&options)).is_err());
        assert!(action_request("community_message_schedule",Some("c-1"),Some(&"あ".repeat(2000)),Some(OP),Some(&options)).is_ok());
    }
}

#[cfg(test)]
mod native_git_application_tests {
    use super::*;

    const PROJECT: &str = "rp_0123456789abcdef0123456789abcdef";
    const PROPOSAL: &str = "12345678-9abc-4def-8123-456789abcdef";
    const ACTIONS: [&str; 3] = ["research_git_application_preview", "research_git_application_check", "research_git_application_apply"];

    fn input(index: usize) -> serde_json::Value {
        let mut value = serde_json::json!({"proposalId": PROPOSAL, "snapshot": "a".repeat(64)});
        if index > 0 {
            value["comparisonHash"] = "b".repeat(64).into();
            value["branch"] = "main".into();
        }
        if index == 2 { value["confirmed"] = true.into(); }
        value
    }

    #[test]
    fn application_routes_and_payloads_are_fixed() {
        for (index, kind) in ["preview", "check", "apply"].iter().enumerate() {
            let options = input(index);
            let (method, path, body) = action_request(ACTIONS[index], Some(PROJECT), None, None, Some(&options)).unwrap();
            assert_eq!(method, reqwest::Method::POST);
            assert_eq!(path, "/api/client/research/rp_0123456789abcdef0123456789abcdef/git/application");
            let mut expected = options;
            expected["action"] = (*kind).into();
            assert_eq!(body, expected);
        }
        assert!(research_git_application_action("research_git_application_unknown", Some(PROJECT), Some(&input(0))).is_err());
    }

    #[test]
    fn application_options_require_exact_scalar_keys() {
        for (index, action) in ACTIONS.iter().enumerate() {
            let options = input(index);
            for key in options.as_object().unwrap().keys() {
                let mut missing = options.clone();
                missing.as_object_mut().unwrap().remove(key);
                assert!(action_request(action, Some(PROJECT), None, None, Some(&missing)).is_err(), "missing {key}");
                for bad in [serde_json::Value::Null, serde_json::json!({"value": options[key]}), serde_json::json!([options[key]]), serde_json::json!(42)] {
                    let mut changed = options.clone();
                    changed[key] = bad;
                    assert!(action_request(action, Some(PROJECT), None, None, Some(&changed)).is_err(), "type {key}");
                }
            }
            for key in ["action", "url", "credentials", "requestId", "text", "owner", "other"] {
                let mut extra = options.clone();
                extra[key] = "https://attacker.invalid".into();
                assert!(action_request(action, Some(PROJECT), None, None, Some(&extra)).is_err(), "extra {key}");
            }
            for bad in [serde_json::Value::Null, serde_json::json!([]), serde_json::json!("input"), serde_json::json!(true)] {
                assert!(action_request(action, Some(PROJECT), None, None, Some(&bad)).is_err());
            }
            assert!(action_request(action, Some(PROJECT), None, None, None).is_err());
        }
        assert!(action_request(ACTIONS[0], Some(PROJECT), None, None, Some(&input(1))).is_err());
        assert!(action_request(ACTIONS[1], Some(PROJECT), None, None, Some(&input(2))).is_err());
    }

    #[test]
    fn application_requires_explicit_confirmation_and_rejects_text_and_request_ids() {
        for (index, action) in ACTIONS.iter().enumerate() {
            let options = input(index);
            for text in ["", "body"] {
                assert!(action_request(action, Some(PROJECT), Some(text), None, Some(&options)).is_err());
            }
            for id in ["", PROPOSAL] {
                assert!(action_request(action, Some(PROJECT), None, Some(id), Some(&options)).is_err());
            }
        }
        for confirmed in [serde_json::json!(false), serde_json::json!("true"), serde_json::json!(1), serde_json::Value::Null] {
            let mut options = input(2);
            options["confirmed"] = confirmed;
            assert!(action_request(ACTIONS[2], Some(PROJECT), None, None, Some(&options)).is_err());
        }
    }

    #[test]
    fn application_rejects_malformed_project_proposal_and_hashes() {
        for (index, action) in ACTIONS.iter().enumerate() {
            let options = input(index);
            assert!(action_request(action, None, None, None, Some(&options)).is_err());
            for project in ["".to_owned(), PROJECT.to_uppercase(), format!("{PROJECT}/../../outside"), format!("{PROJECT}\n"), format!("{PROJECT}?url=https://attacker.invalid"), format!("rp_{}", "あ".repeat(11))] {
                assert!(action_request(action, Some(&project), None, None, Some(&options)).is_err());
            }
            for id in [PROPOSAL.to_uppercase(), format!("{PROPOSAL}\n"), "../outside".to_owned(), PROPOSAL.replace('-', ""), "00000000-0000-4000-8000-00000000000g".to_owned()] {
                let mut changed = options.clone();
                changed["proposalId"] = id.into();
                assert!(action_request(action, Some(PROJECT), None, None, Some(&changed)).is_err());
            }
            for key in if index == 0 { vec!["snapshot"] } else { vec!["snapshot", "comparisonHash"] } {
                for hash in ["a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), "a".repeat(64) + "\n", "あ".repeat(64)] {
                    let mut changed = options.clone();
                    changed[key] = hash.into();
                    assert!(action_request(action, Some(PROJECT), None, None, Some(&changed)).is_err(), "{key}");
                }
            }
        }
    }

    #[test]
    fn application_branch_bounds_use_utf8_bytes_and_reject_controls() {
        for (index, action) in ACTIONS.iter().enumerate().skip(1) {
            for branch in ["".to_owned(), " ".to_owned(), "\u{3000}".to_owned(), "main branch".to_owned(), "main\\branch".to_owned(), "main\nbranch".to_owned(), "main\tbranch".to_owned(), "main\0branch".to_owned(), "main\u{7f}branch".to_owned(), "a".repeat(201), "あ".repeat(67), "🧪".repeat(50) + "x"] {
                let mut options = input(index);
                options["branch"] = branch.into();
                assert!(action_request(action, Some(PROJECT), None, None, Some(&options)).is_err());
            }
            for branch in ["a".repeat(200), "あ".repeat(66) + "ab", "🧪".repeat(50)] {
                let mut options = input(index);
                options["branch"] = branch.clone().into();
                let body = action_request(action, Some(PROJECT), None, None, Some(&options)).unwrap().2;
                assert_eq!(body["branch"], branch);
            }
            for byte in (0..=32).chain(std::iter::once(127)) {
                let mut options = input(index);
                options["branch"] = format!("main{}branch", char::from(byte)).into();
                assert!(action_request(action, Some(PROJECT), None, None, Some(&options)).is_err());
            }
        }
    }

    #[test]
    fn application_serialized_request_size_accounts_for_json_escaping() {
        // The closed fields and 200-byte branch bound keep even the largest escaped body below 2048.
        let mut options = input(2);
        options["branch"] = "\"".repeat(200).into();
        let body = action_request(ACTIONS[2], Some(PROJECT), None, None, Some(&options)).unwrap().2;
        let encoded = serde_json::to_vec(&body).unwrap();
        assert_eq!(encoded.len(), 661);
        assert!(encoded.len() <= 2048);
        options["branch"] = "\"".repeat(2048).into();
        assert!(action_request(ACTIONS[2], Some(PROJECT), None, None, Some(&options)).is_err());
    }

    #[test]
    fn application_transport_policy_selects_only_the_three_fixed_actions() {
        for action in ACTIONS { assert!(is_git_application_action(action)); }
        for action in ["research_git_propose", "research_git_application", "research_git_application_unknown", "research_git_application_apply\n", "post"] {
            assert!(!is_git_application_action(action));
        }
    }

    #[test]
    fn application_response_mime_requires_json() {
        let mut headers = reqwest::header::HeaderMap::new();
        assert!(!git_application_json_mime(&headers));
        for mime in ["application/json", "application/json; charset=utf-8", "Application/JSON"] {
            headers.insert(reqwest::header::CONTENT_TYPE, reqwest::header::HeaderValue::from_str(mime).unwrap());
            assert!(git_application_json_mime(&headers));
        }
        for mime in ["", "text/html", "text/json", "application/jsonp", "application/octet-stream", "text/html; application/json", "application/problem+json"] {
            headers.insert(reqwest::header::CONTENT_TYPE, reqwest::header::HeaderValue::from_str(mime).unwrap());
            assert!(!git_application_json_mime(&headers));
        }
        headers.insert(reqwest::header::CONTENT_TYPE, reqwest::header::HeaderValue::from_bytes(&[255]).unwrap());
        assert!(!git_application_json_mime(&headers));
    }

    #[test]
    fn application_response_chunks_enforce_the_actual_64kib_limit() {
        let mut body = Vec::new();
        append_git_application_chunk(&mut body, &vec![b'a'; 65_535]).unwrap();
        append_git_application_chunk(&mut body, b"b").unwrap();
        assert_eq!(body.len(), 65_536);
        assert_eq!(body.last(), Some(&b'b'));
        append_git_application_chunk(&mut body, b"").unwrap();
        assert_eq!(append_git_application_chunk(&mut body, b"c").unwrap_err(), GIT_APPLICATION_RESPONSE_ERROR);
        assert_eq!(body.len(), 65_536);
        let mut single_chunk = Vec::new();
        assert!(append_git_application_chunk(&mut single_chunk, &vec![b'a'; 65_537]).is_err());
        assert!(single_chunk.is_empty());
        let mut invalid_initial_body = vec![b'a'; 65_537];
        assert!(append_git_application_chunk(&mut invalid_initial_body, b"").is_err());
    }
}

#[cfg(test)]
mod native_git_review_tests {
 use super::*;
 #[test]
 fn comparison_and_proposal_paths_are_closed() {
  let p=format!("rp_{}","a".repeat(32));let head="b".repeat(40);let base="a".repeat(40);let id="00000000-0000-4000-8000-000000000001".to_owned();
  let (template,auth)=detail_path("research_git_compare").unwrap();assert!(auth);assert_eq!(fill_path(template,&[p.clone(),head.clone(),base.clone()]).unwrap(),format!("/api/client/research/{p}/git/browse?commit={head}&base={base}"));
  for ids in [vec![p.clone(),head.clone()],vec![p.clone(),head.clone(),"a".repeat(64)],vec![p.clone(),head.clone(),base.clone(),id.clone()],vec![p.clone(),head.clone()+"\n",base.clone()]] {assert!(fill_path(template,&ids).is_err());}
  let(list,auth)=detail_path("research_git_proposals").unwrap();assert!(auth);assert!(fill_path(list,&[p.clone(),id.clone()]).is_err());
  let(detail,auth)=detail_path("research_git_proposal").unwrap();assert!(auth);assert_eq!(fill_path(detail,&[p.clone(),id.clone()]).unwrap(),format!("/api/client/research/{p}/git/proposals?proposal={id}"));assert!(fill_path(detail,&[p.clone(),id.clone()+"\n"]).is_err());
  let(page,_)=detail_path("research_git_proposals_page").unwrap();let cursor=serde_json::json!({"createdAt":"2026-01-01T00:00:00.000Z","id":id}).to_string();let path=fill_path(page,&[p.clone(),cursor.clone()]).unwrap();let url=reqwest::Url::parse(&format!("https://hub.invalid{path}")).unwrap();assert_eq!(url.query_pairs().collect::<Vec<_>>(),vec![("cursor".into(),cursor.into())]);
  for cursor in ["{}".to_owned(),"[]".to_owned(),"x".repeat(257),serde_json::json!({"createdAt":"2026-02-30T00:00:00.000Z","id":id}).to_string(),serde_json::json!({"createdAt":"2026-01-01T00:00:00.000Z","id":id,"other":true}).to_string()] {assert!(fill_path(page,&[p.clone(),cursor]).is_err());}
 }
 #[test]
 fn proposal_actions_build_only_fixed_payloads() {
  let p=format!("rp_{}","a".repeat(32));let id="00000000-0000-4000-8000-000000000001";let input=serde_json::json!({"baseOid":"a".repeat(40),"headOid":"b".repeat(40),"title":"🧪".repeat(120),"summary":"Reason","comparisonHash":"c".repeat(64)});
  let(method,path,body)=action_request("research_git_propose",Some(&p),None,Some(id),Some(&input)).unwrap();assert_eq!(method,reqwest::Method::POST);assert_eq!(path,format!("/api/client/research/{p}/git/proposals"));let mut expected=input.clone();expected["action"]="create".into();expected["requestId"]=id.into();assert_eq!(body,expected);
  for(key,value)in[("title",serde_json::json!("🧪".repeat(120)+"x")),("summary",serde_json::json!("\0")),("comparisonHash",serde_json::json!("c".repeat(64)+"\n")),("headOid",serde_json::json!("b".repeat(64))),("baseOid",serde_json::json!("b".repeat(40))),("owner",serde_json::json!("attacker"))]{let mut changed=input.clone();changed[key]=value;assert!(action_request("research_git_propose",Some(&p),None,Some(id),Some(&changed)).is_err());}
  assert!(action_request("research_git_propose",Some(&p),Some("body"),Some(id),Some(&input)).is_err());assert!(action_request("research_git_propose",Some(&p),None,Some(&(id.to_owned()+"\n")),Some(&input)).is_err());
  let review=serde_json::json!({"proposalId":id,"snapshot":"a".repeat(64),"comparisonHash":"c".repeat(64),"fullReviewConfirmed":true});let(_,_,body)=action_request("research_git_approve",Some(&p),None,None,Some(&review)).unwrap();assert_eq!(body["action"],"approve");assert!(body.get("requestId").is_none());assert!(action_request("research_git_approve",Some(&p),None,Some(id),Some(&review)).is_err());let mut wrong=review.clone();wrong["fullReviewConfirmed"]="true".into();assert!(action_request("research_git_approve",Some(&p),None,None,Some(&wrong)).is_err());assert!(action_request("research_git_reject",Some(&p),None,None,Some(&review)).is_err());
  let rejection=serde_json::json!({"proposalId":id,"snapshot":"a".repeat(64)});assert_eq!(action_request("research_git_reject",Some(&p),None,None,Some(&rejection)).unwrap().2["action"],"reject");
 }
}

#[cfg(test)]
mod feature_parity_tests {
    use super::*;
    #[test]
    fn parity_read_save_and_status_contracts_are_closed() {
        for (action,kind,method) in [("save_article","articles",reqwest::Method::POST),("unsave_article","articles",reqwest::Method::DELETE),("save_video","videos",reqwest::Method::POST),("unsave_video","videos",reqwest::Method::DELETE)] {
            let (got,path,body)=action_request(action,Some("item-1"),None,None,None).unwrap();assert_eq!(got,method);assert_eq!(path,format!("/api/client/{kind}/item-1/save"));assert_eq!(body,serde_json::json!({}));
            for id in ["../admin"," item-1","item-1\n",""]{assert!(action_request(action,Some(id),None,None,None).is_err());}
        }
        let (_,path,body)=action_request("thread_read",Some("t1"),None,None,Some(&serde_json::json!({"lastReadPostNo":9_007_199_254_740_991u64}))).unwrap();assert_eq!(path,"/api/client/threads/t1/read");assert_eq!(body["last_read_post_no"],9_007_199_254_740_991u64);
        for n in [serde_json::json!(-1),serde_json::json!(1.5),serde_json::json!(9_007_199_254_740_992u64),serde_json::json!("3")] {assert!(action_request("thread_read",Some("t1"),None,None,Some(&serde_json::json!({"lastReadPostNo":n}))).is_err());}
        assert!(action_request("thread_read",Some("t1"),None,None,Some(&serde_json::json!({"lastReadPostNo":3,"profileId":"other"}))).is_err());
        for status in ["open","closed"]{assert!(action_request("thread_status",Some("t1"),None,None,Some(&serde_json::json!({"status":status}))).is_ok());}
        assert!(action_request("thread_status",Some("t1"),None,None,Some(&serde_json::json!({"status":"archived"}))).is_err());
    }
    #[test]
    fn article_like_and_comment_wire_is_closed() {
        let (m,p,b)=action_request("article_like_set",Some("art-1"),None,None,None).unwrap();assert_eq!(m,reqwest::Method::PUT);assert_eq!(p,"/api/client/articles/art-1/like");assert_eq!(b,serde_json::json!({}));
        let (m,p,_)=action_request("article_like_clear",Some("art-1"),None,None,None).unwrap();assert_eq!(m,reqwest::Method::DELETE);assert_eq!(p,"/api/client/articles/art-1/like");
        for id in ["../admin"," art-1","art-1\n","","a/b","a?x=1"]{assert!(action_request("article_like_set",Some(id),None,None,None).is_err());assert!(action_request("article_comment_create",Some(id),None,None,Some(&serde_json::json!({"body":"x"}))).is_err());}
        let (m,p,b)=action_request("article_comment_create",Some("art-1"),None,None,Some(&serde_json::json!({"body":"行1\n行2"}))).unwrap();assert_eq!(m,reqwest::Method::POST);assert_eq!(p,"/api/client/articles/art-1/comments");assert_eq!(b,serde_json::json!({"body":"行1\n行2"}));
        assert!(action_request("article_comment_create",Some("art-1"),None,None,Some(&serde_json::json!({"body":"a".repeat(2000)}))).is_ok());
        for value in [serde_json::json!({"body":"a".repeat(2001)}),serde_json::json!({"body":"  "}),serde_json::json!({"body":null}),serde_json::json!({"body":"x","actor":"other"}),serde_json::json!({})]{assert!(action_request("article_comment_create",Some("art-1"),None,None,Some(&value)).is_err());}
        assert!(action_request("article_comment_create",Some("art-1"),Some("override"),None,Some(&serde_json::json!({"body":"x"}))).is_err());
        assert_eq!(client_path("article_drafts"),Some("/api/client/articles/drafts"));assert_eq!(detail_path("article_like_me"),Some(("/api/client/articles/{a}/like",true)));
    }
    #[test]
    fn parity_research_preserves_exact_bounds_and_refuses_extra_fields() {
        let v=serde_json::json!({"objectType":"paper","title":"🧪".repeat(120),"version":1,"contentHash":format!("sha256:{}","a".repeat(64)),"license":"","visibility":"confidential"});
        let (_,path,body)=action_request("research_register_object",Some("rp_1"),None,None,Some(&v)).unwrap();assert_eq!(path,"/api/client/research/rp_1/objects");assert_eq!(body,v);
        for (key,value) in [("title",serde_json::json!("🧪".repeat(121))),("version",serde_json::json!(0)),("version",serde_json::json!(9_007_199_254_740_992u64)),("contentHash",serde_json::json!(format!("sha256:{}","A".repeat(64)))),("visibility",serde_json::json!("other")),("actor",serde_json::json!("other"))]{let mut bad=v.clone();bad[key]=value;assert!(action_request("research_register_object",Some("rp_1"),None,None,Some(&bad)).is_err(),"{key}");}
        let relation=serde_json::json!({"fromObjectId":"obj_1","toObjectId":"obj_2","relationType":"supported_by"});assert!(action_request("research_register_relation",Some("rp_1"),None,None,Some(&relation)).is_ok());
        let mut bad=relation.clone();bad["toObjectId"]=serde_json::json!("obj_1");assert!(action_request("research_register_relation",Some("rp_1"),None,None,Some(&bad)).is_err());
        assert!(action_request("research_register_object",Some("rp_1"),Some("ignored"),None,Some(&v)).is_err());
    }
    #[test]
    fn parity_library_cursor_is_encoded_and_cannot_change_path() {
        let (template,auth)=detail_path("video_library_page").unwrap();assert!(auth);let cursor="2026-10-05T00:00:00.000Z|video1";
        let path=fill_path(template,&[cursor.to_owned()]).unwrap();let url=reqwest::Url::parse(&format!("https://hub.invalid{path}")).unwrap();assert_eq!(url.query_pairs().collect::<Vec<_>>(),vec![("cursor".into(),cursor.into())]);
        for bad in ["2026-10-05T00:00:00.000Z|../admin","2026-10-05T00:00:00.000Z|id&profile=other","2026-10-05T00:00:00.000Z| id","2026-10-05T00:00:00.000Z|id\n"]{assert!(fill_path(template,&[bad.to_owned()]).is_err());}
        assert_eq!(client_path("saved_articles"),Some("/api/client/articles/saved"));assert!(detail_path("video_library_admin").is_none());
    }
}

#[cfg(test)]
mod library_parity_tests {
 use super::*; use serde_json::json;
 #[test] fn music_ids_offsets_and_closed_commands(){
  let id="music:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert_eq!(library_action("favorite_music",Some(id),None).unwrap().2,json!({"id":id}));
  assert!(library_action("favorite_music",Some(&id.to_uppercase()),None).is_err());
  assert!(library_action("unfavorite_music",Some(&id.to_uppercase()),None).is_ok());
  for bad in ["music:bad","../music","a?x=1",&"a".repeat(129)]{assert!(library_action("favorite_music",Some(bad),None).is_err());}
  assert!(action_request("favorite_music",Some("id"),Some("text"),None,None).is_err());
  assert!(library_action("favorite_music",Some("id"),Some(&json!({"actor":"x"}))).is_err());
  for n in ["0","50","9007199254740991"]{assert!(fill_path("/api/client/music/library?offset={a}",&[n.into()]).is_ok());}
  for n in ["-1","+0","01","9007199254740992","a","0&actor=x"]{assert!(fill_path("/api/client/music/library?offset={a}",&[n.into()]).is_err());}
 }
 #[test] fn pdf_and_node_options_are_reconstructed(){
  let options=json!({"id":"00000000-0000-4000-8000-000000000000"});
  assert!(fill_path("/api/client/research/{a}/pdfs",&["p".repeat(128)]).is_ok());
  for ids in [vec![],vec!["ab".into()],vec!["p".repeat(129)],vec!["p01".into(),"extra".into()],vec!["p01?x".into()]]{assert!(fill_path("/api/client/research/{a}/pdfs",&ids).is_err());}
  assert!(library_action("research_pdf_scan",Some(&"p".repeat(128)),Some(&options)).is_ok());
  for project in ["ab","_project","PROJECT",&"p".repeat(129)] {assert!(library_action("research_pdf_scan",Some(project),Some(&options)).is_err());}
  for id in ["pdf","00000000-0000-4000-8000-00000000000A","00000000-0000-4000-8000-000000000000?x"]{assert!(library_action("research_pdf_scan",Some("p01"),Some(&json!({"id":id}))).is_err());}
  assert!(library_action("research_pdf_scan",Some("p01"),Some(&json!({"id":"00000000-0000-4000-8000-000000000000"}))).is_ok());
  assert!(library_action("research_pdf_visibility",Some("p01"),Some(&json!({"id":"00000000-0000-4000-8000-000000000000","visibility":"public"}))).is_ok());
  for o in [json!({"id":"00000000-0000-4000-8000-000000000000","visibility":"public","actor":"x"}),json!({"id":"00000000-0000-4000-8000-000000000000","visibility":"private"})]{assert!(library_action("research_pdf_visibility",Some("p01"),Some(&o)).is_err());}
  assert!(library_action("personal_node_relays",None,Some(&json!({"relays":["https://relay.example"]}))).is_ok());
  for relays in [json!(["https://relay.example","https://relay.example/"]),json!(["http://relay.example"]),json!(["https://user:pass@relay.example"]),json!(["https://relay.example/path"]),json!(["https://relay.example?a=1"])] {assert!(library_action("personal_node_relays",None,Some(&json!({"relays":relays}))).is_err());}
  assert_eq!(library_action("personal_node_device_revoke",Some("device:x.1"),None).unwrap().1,"/api/client/personal-node?deviceId=device%3Ax.1");
  assert!(library_action("personal_node_device_revoke",Some("../device"),None).is_err());
 }
}


#[cfg(test)]
mod playlist_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn playlist_fixed_paths_methods_and_bodies() {
        for kind in ["video","music"] {
            let base=if kind=="video"{"/api/client/videos/playlists"}else{"/api/client/music/playlists"};
            assert_eq!(client_path(&format!("{kind}_playlists")),Some(base));
            assert_eq!(resource_path(&format!("{kind}_playlists")),None);
            for (verb, method) in [("create",reqwest::Method::POST),("update",reqwest::Method::PATCH),("delete",reqwest::Method::DELETE)] {
                let create=verb=="create"; let options=if verb=="delete" {json!({})} else {json!({"title":"  Ａ作品  ","description":"説明"})};
                let result=action_request(&format!("{verb}_{kind}_playlist"),if create{None}else{Some("p_1")},None,None,Some(&options)).unwrap();
                assert_eq!(result.0,method);assert_eq!(result.1,if create{base.to_owned()}else{format!("{base}/p_1")});
                assert_eq!(result.2,if verb=="delete"{json!({})}else{json!({"title":"A作品","description":"説明"})});
            }
        }
        for (action,method) in [("add_video_playlist_item",reqwest::Method::POST),("remove_video_playlist_item",reqwest::Method::DELETE)] {
            let result=action_request(action,Some("p"),None,None,Some(&json!({"videoId":"v_1"}))).unwrap();
            assert_eq!(result,(method,"/api/client/videos/playlists/p/items/v_1".into(),json!({})));
        }
        let input=json!({"workIds":["a","music:00000000-0000-4000-8000-000000000000"]});
        assert_eq!(action_request("set_music_playlist_items",Some("p"),None,None,Some(&input)).unwrap(),(reqwest::Method::PUT,"/api/client/music/playlists/p/items".into(),input));
    }
    #[test]
    fn playlist_identifier_and_closed_input_boundaries() {
        for bad in ["","../p","p?x","p%2f","p/","日本",&"p".repeat(129)] {
            assert!(playlist_action("delete_video_playlist",Some(bad),Some(&json!({}))).is_err());
            assert!(playlist_action("add_video_playlist_item",Some("p"),Some(&json!({"videoId":bad}))).is_err());
        }
        assert!(playlist_action("delete_video_playlist",Some(&"p".repeat(128)),Some(&json!({}))).is_ok());
        for action in ["create_video_playlist","update_music_playlist","set_music_playlist_items"] {
            assert!(action_request(action,Some("p"),Some("text"),None,Some(&json!({}))).is_err());
            assert!(action_request(action,Some("p"),None,Some("id"),Some(&json!({}))).is_err());
        }
        for value in [json!(null),json!([]),json!({"title":"a","owner":"p"}),json!({"title":1}),json!({"title":"a","description":null})] {
            assert!(playlist_action("create_video_playlist",None,Some(&value)).is_err());
        }
        assert!(playlist_action("create_video_playlist",Some("p"),Some(&json!({"title":"a"}))).is_err());
        assert!(playlist_action("delete_music_playlist",Some("p"),Some(&json!({"title":"a"}))).is_err());
        assert!(playlist_action("add_video_playlist_item",Some("p"),Some(&json!({"videoId":"v","owner":"p"}))).is_err());
    }
    #[test]
    fn playlist_unicode_and_music_array_bounds() {
        assert!(playlist_action("create_music_playlist",None,Some(&json!({"title":"😀".repeat(40),"description":"a".repeat(500)}))).is_ok());
        for value in [json!({"title":"😀".repeat(41)}),json!({"title":"a","description":"a".repeat(501)}),json!({"title":"\u{0000}"}),json!({"title":"   "})] {
            assert!(playlist_action("create_video_playlist",None,Some(&value)).is_err());
        }
        for value in [json!({"workIds":["a","a"]}),json!({"workIds":[1]}),json!({"workIds":[["a"]]}),json!({"workIds":["music:00000000-0000-0000-8000-000000000000"]}),json!({"workIds":["music:00000000-0000-4000-0000-000000000000"]}),json!({"workIds":[],"owner":"p"})] {
            assert!(playlist_action("set_music_playlist_items",Some("p"),Some(&value)).is_err());
        }
        let normalized=playlist_action("create_music_playlist",None,Some(&json!({"title":" a\n b  ","description":"x\t y"}))).unwrap().2;
        assert_eq!(normalized,json!({"title":"a b","description":"x y"}));
        assert!(playlist_action("set_music_playlist_items",Some("p"),Some(&json!({"workIds":["MUSIC:AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"]}))).is_ok());
        for n in [0,200,201] {
            let value=json!({"workIds":(0..n).map(|i|format!("w{i}")).collect::<Vec<_>>()});
            assert_eq!(playlist_action("set_music_playlist_items",Some("p"),Some(&value)).is_ok(),n<=200);
        }
    }
}

#[cfg(test)]
mod playlist_item_detail_tests {
 use super::*;
 #[test]
 fn catalog_product_ids_preserve_utf16_width(){
  assert!(catalog_product_id(&"😀".repeat(90)));assert!(!catalog_product_id(&"😀".repeat(91)));
  for id in ["", ".", "..", "a/b", "a?b", "%2f", "x
", "x﻿", "x�", "x"]{assert!(!catalog_product_id(id));}
  assert!(detail_path("shopping_product").is_none());
 }
 #[test] fn metadata_path_is_closed_for_catalog_and_public_music() {
  let template=detail_path("music_work").unwrap();assert!(template.1);
  assert_eq!(fill_path(template.0,&["work_1".into()]).unwrap(),"/api/client/music/works/work_1");
  assert_eq!(fill_path(template.0,&["music:00000000-0000-4000-8000-000000000000".into()]).unwrap(),"/api/client/music/works/music%3A00000000-0000-4000-8000-000000000000");
  let sharing=detail_path("music_share_context").unwrap();assert!(sharing.1);
  assert_eq!(fill_path(sharing.0,&["music:00000000-0000-4000-8000-000000000000".into()]).unwrap(),"/api/client/music/works/music%3A00000000-0000-4000-8000-000000000000/share");
  for ids in [vec![],vec!["../w".into()],vec!["music:bad".into()],vec!["w?x".into()],vec!["w".into(),"x".into()]]{assert!(fill_path(sharing.0,&ids).is_err());}
  for ids in [vec![],vec!["../w".into()],vec!["music:bad".into()],vec!["w?x".into()],vec!["w".into(),"x".into()]] {assert!(fill_path(template.0,&ids).is_err());}
 }
    #[test]
    fn research_music_and_selected_dot_revision_paths_are_closed() {
        let (music,private)=detail_path("research_backlinks_music").unwrap();assert!(!private);
        assert_eq!(fill_path(music,&["music:00000000-0000-4000-8000-000000000000".into()]).unwrap(),"/api/research/discovery?kind=music&id=music%3A00000000-0000-4000-8000-000000000000");
        let (search,private)=detail_path("research_links_music").unwrap();assert!(private);
        assert_eq!(fill_path(search,&["rp_00000000000000000000000000000000".into(),"音楽 & next".into()]).unwrap(),"/api/client/research/rp_00000000000000000000000000000000/links?kind=music&q=%E9%9F%B3%E6%A5%BD+%26+next");
        let (revision,private)=detail_path("research_revision").unwrap();assert!(private);
        assert_eq!(fill_path(revision,&["rp_00000000000000000000000000000000".into(),"doc.with.dot".into(),"1".into()]).unwrap(),"/api/client/research/rp_00000000000000000000000000000000/workspace?document=doc.with.dot&version=1");
        for value in ["0","01","9007199254740992","1&version=2"] {assert!(fill_path(revision,&["rp_00000000000000000000000000000000".into(),"doc.with.dot".into(),value.into()]).is_err());}
        assert!(fill_path(music,&["../x".into()]).is_err());
        assert!(fill_path(search,&["rp_00000000000000000000000000000000".into(),"x\n".into()]).is_err());
    }
    #[test]
    fn community_preferences_fixed_native_paths_and_inputs() {
        let (template,private)=detail_path("community_notifications").unwrap();assert!(private);
        assert_eq!(fill_path(template,&["c".into()]).unwrap(),"/api/client/communities/c/notifications");
        assert!(fill_path(template,&[]).is_err());assert!(fill_path(template,&["c".into(),"d".into()]).is_err());
        for id in ["", "../x", "c\n", "c?x", "c%2F", "c\u{85}"] {assert!(fill_path(template,&[id.into()]).is_err());}
        let options=serde_json::json!({"mentions":true,"replies":false,"guideUpdates":true,"governance":false,"membership":true,"channels":[{"channelId":"a","mode":"none"}]});
        let (method,path,body)=action_request("update_community_notifications",Some("c"),None,None,Some(&options)).unwrap();
        assert_eq!(method,reqwest::Method::PATCH);assert_eq!(path,"/api/client/communities/c/notifications");assert_eq!(body,options);
        let empty=serde_json::json!({});
        let (method,path,body)=action_request("read_all_community_channels",Some("c"),None,None,Some(&empty)).unwrap();assert_eq!(method,reqwest::Method::POST);assert_eq!(path,"/api/client/communities/c/read-all");assert_eq!(body,empty);
        for action in ["update_community_notifications","read_all_community_channels"] {
            assert!(action_request(action,Some("c"),Some("x"),None,Some(&options)).is_err());
            assert!(action_request(action,Some("c"),None,Some("x"),Some(&options)).is_err());
            assert!(action_request(action,None,None,None,Some(&options)).is_err());
            assert!(action_request(action,Some("c"),None,None,None).is_err());
        }
        assert!(community_preferences_action("read_all_community_channels",Some("c"),Some(&options)).is_err());
        for bad in [serde_json::json!({"owner":"p"}),serde_json::json!(null),serde_json::json!([])] {assert!(community_preferences_action("read_all_community_channels",Some("c"),Some(&bad)).is_err());}
    }
    #[test]
    fn community_preferences_native_boolean_array_and_identifier_bounds() {
        let base=serde_json::json!({"mentions":true,"replies":true,"guideUpdates":true,"governance":true,"membership":true,"channels":[]});
        let action=|v:&serde_json::Value|community_preferences_action("update_community_notifications",Some("c"),Some(v));
        assert!(action(&base).is_ok());
        for key in ["mentions","replies","guideUpdates","governance","membership"] {
            for bad in [serde_json::json!(1),serde_json::json!("true"),serde_json::json!(null)] {let mut v=base.clone();v[key]=bad;assert!(action(&v).is_err());}
            let mut v=base.clone();v.as_object_mut().unwrap().remove(key);assert!(action(&v).is_err());
        }
        let mut v=base.clone();v["owner"]=serde_json::json!("p");assert!(action(&v).is_err());
        v=base.clone();v["channels"]=serde_json::json!((0..100).map(|i|serde_json::json!({"channelId":format!("channel-{i}"),"mode":"all"})).collect::<Vec<_>>());assert!(action(&v).is_ok());
        v["channels"].as_array_mut().unwrap().push(serde_json::json!({"channelId":"101","mode":"all"}));assert!(action(&v).is_err());
        for entry in [serde_json::json!({"channelId":"a","mode":"bogus"}),serde_json::json!({"channelId":"a","mode":null}),serde_json::json!({"channelId":"a","mode":"all","owner":"p"}),serde_json::json!({"channelId":"a\n","mode":"all"}),serde_json::json!({"channelId":"a".repeat(129),"mode":"all"})] {v=base.clone();v["channels"]=serde_json::json!([entry]);assert!(action(&v).is_err());}
        v=base.clone();v["channels"]=serde_json::json!([{"channelId":"a".repeat(128),"mode":"mentions"}]);assert!(action(&v).is_ok());
        v["channels"]=serde_json::json!([{"channelId":"a","mode":"all"},{"channelId":"a","mode":"none"}]);assert!(action(&v).is_err());
    }

}

fn hub_json_trim(value: &str) -> &str {
    value.trim_matches(|c| matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}

fn hub_json_object<'a>(
    value: &'a serde_json::Value,
    keys: &[&str],
) -> Option<&'a serde_json::Map<String, serde_json::Value>> {
    let object = value.as_object()?;
    object
        .keys()
        .all(|key| keys.contains(&key.as_str()))
        .then_some(object)
}

fn hub_json_integer(value: &serde_json::Value, maximum: u64) -> Option<u64> {
    let number = value.as_f64()?;
    (number.is_finite() && number >= 0.0 && number <= maximum as f64 && number.fract() == 0.0)
        .then_some(number as u64)
}

fn hub_json_strings(object: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> bool {
    keys.iter().all(|key| {
        object
            .get(*key)
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| !value.is_empty())
    })
}

fn hub_json_optional_strings(
    object: &serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> bool {
    keys.iter()
        .all(|key| object.get(*key).is_none_or(serde_json::Value::is_string))
}

fn hub_json_url(base: &str, path: &str) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(base).map_err(|_| "hub_response_unavailable".to_owned())?;
    if !((url.scheme() == "https" && url.host_str().is_some())
        || (url.scheme() == "http" && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("hub_response_unavailable".to_owned());
    }
    url.set_path(path);
    Ok(url)
}

fn hub_json_assertion(
    required: bool,
    assertion: Result<Option<String>, String>,
) -> Result<Option<String>, String> {
    let assertion = assertion.map_err(|_| "hub_response_unavailable".to_owned())?;
    if required && assertion.is_none() {
        return Err("desktop_not_connected".to_owned());
    }
    Ok(assertion)
}

fn hub_json_push_response(bytes: &mut Vec<u8>, chunk: &[u8]) -> Result<(), String> {
    if chunk.len() > MAX_BYTES.saturating_sub(bytes.len()) {
        return Err("hub_response_unavailable".to_owned());
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}

fn hub_json_clean_strings(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::String(text) => !text.contains('\0'),
        serde_json::Value::Array(values) => values.iter().all(hub_json_clean_strings),
        serde_json::Value::Object(values) => values
            .iter()
            .all(|(key, value)| !key.contains('\0') && hub_json_clean_strings(value)),
        _ => true,
    }
}

const EXTERNAL_MEDIA_BODY_BYTES: usize = 64 * 1024;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ExternalMediaOperation {
    VideoMetadata,
    VideoRegister,
    MusicMetadata,
    MusicRegister,
    MusicReport,
}
fn external_media_invalid() -> String {
    "external_media_rejected:400:invalid_request".to_owned()
}
fn external_media_unavailable() -> String {
    "external_media_unavailable".to_owned()
}
fn external_media_path(operation: ExternalMediaOperation) -> &'static str {
    match operation {
        ExternalMediaOperation::VideoMetadata => "/api/client/videos/metadata",
        ExternalMediaOperation::VideoRegister => "/api/client/videos",
        ExternalMediaOperation::MusicMetadata => "/api/client/music/metadata",
        ExternalMediaOperation::MusicRegister => "/api/client/music",
        ExternalMediaOperation::MusicReport => "/api/client/music/reports",
    }
}
struct ExternalMediaBodyBuffer(Vec<u8>);
impl std::io::Write for ExternalMediaBodyBuffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > EXTERNAL_MEDIA_BODY_BYTES.saturating_sub(self.0.len()) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "external_media_body_limit",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn external_media_body(value: &serde_json::Value) -> Result<Vec<u8>, String> {
    let mut buffer = ExternalMediaBodyBuffer(Vec::new());
    serde_json::to_writer(&mut buffer, value).map_err(|_| external_media_invalid())?;
    Ok(buffer.0)
}
fn external_media_text(
    value: &serde_json::Value,
    maximum: usize,
    required: bool,
) -> Result<String, String> {
    let raw = value.as_str().ok_or_else(external_media_invalid)?;
    if raw.contains('\0') || raw.encode_utf16().count() > maximum {
        return Err(external_media_invalid());
    }
    let trimmed = hub_json_trim(raw);
    if required && trimmed.is_empty() {
        return Err(external_media_invalid());
    }
    Ok(trimmed.to_owned())
}
fn external_media_secure_url(value: &str) -> bool {
    if value.is_empty()
        || value != hub_json_trim(value)
        || value.encode_utf16().count() > 2048
        || value.chars().any(char::is_control)
    {
        return false;
    }
    reqwest::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
    })
}
fn external_media_url_input(value: &serde_json::Value) -> Result<String, String> {
    let value = external_media_text(value, 2048, true)?;
    if !external_media_secure_url(&value) {
        return Err(external_media_invalid());
    }
    Ok(value)
}
fn external_media_purpose(value: &str) -> bool {
    matches!(
        value,
        "guide" | "explanation" | "live" | "review" | "creation" | "music" | "other"
    )
}
fn external_media_input(
    operation: ExternalMediaOperation,
    input: &serde_json::Value,
    current_year: u32,
) -> Result<serde_json::Value, String> {
    external_media_body(input)?;
    if !hub_json_clean_strings(input) {
        return Err(external_media_invalid());
    }
    let keys: &[&str] = match operation {
        ExternalMediaOperation::VideoMetadata | ExternalMediaOperation::MusicMetadata => {
            &["sourceUrl"]
        }
        ExternalMediaOperation::VideoRegister => &[
            "sourceUrl",
            "title",
            "channel",
            "category",
            "purpose",
            "topic",
            "relatedHubpediaSlug",
        ],
        ExternalMediaOperation::MusicRegister => &[
            "title",
            "artist",
            "description",
            "genre",
            "year",
            "tags",
            "serviceUrls",
        ],
        ExternalMediaOperation::MusicReport => &["workId", "reason", "details"],
    };
    let object = hub_json_object(input, keys).ok_or_else(external_media_invalid)?;
    let text = |key: &str, maximum, required| {
        external_media_text(
            object.get(key).ok_or_else(external_media_invalid)?,
            maximum,
            required,
        )
    };
    match operation {
        ExternalMediaOperation::VideoMetadata | ExternalMediaOperation::MusicMetadata => Ok(
            serde_json::json!({"sourceUrl":external_media_url_input(object.get("sourceUrl").ok_or_else(external_media_invalid)?)?}),
        ),
        ExternalMediaOperation::VideoRegister => {
            let purpose = object
                .get("purpose")
                .and_then(serde_json::Value::as_str)
                .filter(|value| external_media_purpose(value))
                .ok_or_else(external_media_invalid)?;
            let mut rebuilt = serde_json::json!({"sourceUrl":external_media_url_input(object.get("sourceUrl").ok_or_else(external_media_invalid)?)?,
                "title":text("title",240,true)?,"channel":text("channel",120,true)?,"category":text("category",80,true)?,"purpose":purpose,"topic":text("topic",80,true)?});
            if let Some(value) = object.get("relatedHubpediaSlug") {
                external_media_text(value, 160, false)?;
                rebuilt["relatedHubpediaSlug"] = value.clone();
            }
            Ok(rebuilt)
        }
        ExternalMediaOperation::MusicRegister => {
            let year = object
                .get("year")
                .and_then(|value| hub_json_integer(value, current_year.saturating_add(1) as u64))
                .filter(|year| *year >= 1000)
                .ok_or_else(external_media_invalid)?;
            let links = object
                .get("serviceUrls")
                .and_then(serde_json::Value::as_array)
                .filter(|values| (1..=6).contains(&values.len()))
                .ok_or_else(external_media_invalid)?;
            let links = links
                .iter()
                .map(external_media_url_input)
                .collect::<Result<Vec<_>, _>>()?;
            let tags = match object.get("tags") {
                None => Vec::new(),
                Some(value) => value
                    .as_array()
                    .filter(|values| values.len() <= 12)
                    .ok_or_else(external_media_invalid)?
                    .iter()
                    .map(|value| external_media_text(value, 40, true))
                    .collect::<Result<Vec<_>, _>>()?,
            };
            Ok(
                serde_json::json!({"title":text("title",180,true)?,"artist":text("artist",120,true)?,"description":text("description",500,true)?,"genre":text("genre",60,true)?,"year":year,"tags":tags,"serviceUrls":links}),
            )
        }
        ExternalMediaOperation::MusicReport => {
            let work = text("workId", 160, true)?;
            if work.to_ascii_lowercase().starts_with("music:") {
                return Err(external_media_invalid());
            }
            let reason = object
                .get("reason")
                .and_then(serde_json::Value::as_str)
                .filter(|reason| {
                    matches!(
                        *reason,
                        "not_music"
                            | "duplicate"
                            | "wrong_metadata"
                            | "unavailable"
                            | "rights"
                            | "other"
                    )
                })
                .ok_or_else(external_media_invalid)?;
            let details = object
                .get("details")
                .map(|value| external_media_text(value, 1000, false))
                .transpose()?
                .unwrap_or_default();
            Ok(serde_json::json!({"workId":work,"reason":reason,"details":details}))
        }
    }
}
fn external_media_optional_text(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    maximum: usize,
) -> bool {
    object
        .get(key)
        .is_none_or(|value| external_media_text(value, maximum, false).is_ok())
}
fn external_media_optional_url(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> bool {
    object
        .get(key)
        .is_none_or(|value| value.as_str().is_some_and(external_media_secure_url))
}
fn external_media_music_provider(value: &str) -> bool {
    matches!(
        value,
        "spotify" | "youtube" | "soundcloud" | "apple" | "amazon" | "bandcamp"
    )
}
fn external_media_video_provider(value: &str) -> bool {
    matches!(
        value,
        "youtube" | "vimeo" | "twitch" | "niconico" | "tiktok" | "dailymotion" | "peertube"
    )
}
fn external_media_metadata(value: &serde_json::Value, music: bool) -> bool {
    let keys: &[&str] = if music {
        &[
            "sourceUrl",
            "provider",
            "providerLabel",
            "title",
            "artist",
            "thumbnailUrl",
        ]
    } else {
        &[
            "sourceUrl",
            "provider",
            "title",
            "channel",
            "thumbnailUrl",
            "broadcastStatus",
        ]
    };
    hub_json_object(value, keys).is_some_and(|object| {
        object
            .get("sourceUrl")
            .and_then(serde_json::Value::as_str)
            .is_some_and(external_media_secure_url)
            && external_media_optional_url(object, "thumbnailUrl")
            && if music {
                object
                    .get("provider")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(external_media_music_provider)
                    && hub_json_strings(object, &["providerLabel"])
                    && external_media_optional_text(object, "title", 180)
                    && external_media_optional_text(object, "artist", 120)
            } else {
                matches!(
                    object.get("provider").and_then(serde_json::Value::as_str),
                    Some(
                        "YouTube"
                            | "Vimeo"
                            | "Twitch"
                            | "ニコニコ"
                            | "TikTok"
                            | "Dailymotion"
                            | "PeerTube"
                    )
                ) && external_media_optional_text(object, "title", 240)
                    && external_media_optional_text(object, "channel", 120)
                    && object.get("broadcastStatus").is_none_or(|value| {
                        matches!(
                            value.as_str(),
                            Some("video" | "live" | "upcoming" | "archive")
                        )
                    })
            }
    })
}
fn external_media_video(value: &serde_json::Value) -> bool {
    let Some(object) = hub_json_object(
        value,
        &[
            "id",
            "title",
            "channel",
            "category",
            "purpose",
            "topic",
            "relatedHubpediaSlug",
            "provider",
            "sourceUrl",
            "thumbnailUrl",
            "duration",
            "publishedAt",
            "submittedByDisplayName",
            "createdAt",
            "viewCount",
            "safetyLevel",
            "safetyNotice",
            "availabilityStatus",
            "broadcastStatus",
            "metadataCheckedAt",
        ],
    ) else {
        return false;
    };
    hub_json_strings(
        object,
        &[
            "id",
            "title",
            "channel",
            "category",
            "topic",
            "publishedAt",
            "createdAt",
        ],
    ) && object
        .get("provider")
        .and_then(serde_json::Value::as_str)
        .is_some_and(external_media_video_provider)
        && object
            .get("sourceUrl")
            .and_then(serde_json::Value::as_str)
            .is_some_and(external_media_secure_url)
        && object
            .get("purpose")
            .and_then(serde_json::Value::as_str)
            .is_some_and(external_media_purpose)
        && object
            .get("viewCount")
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|count| count <= 9_007_199_254_740_991)
        && [
            ("title", 240),
            ("channel", 120),
            ("category", 80),
            ("topic", 80),
        ]
        .iter()
        .all(|(key, max)| {
            object
                .get(*key)
                .is_some_and(|value| external_media_text(value, *max, true).is_ok())
        })
        && external_media_optional_text(object, "relatedHubpediaSlug", 160)
        && hub_json_optional_strings(
            object,
            &[
                "duration",
                "submittedByDisplayName",
                "safetyNotice",
                "metadataCheckedAt",
            ],
        )
        && external_media_optional_url(object, "thumbnailUrl")
        && object.get("safetyLevel").is_none_or(|value| {
            matches!(
                value.as_str(),
                Some("standard" | "sensitive" | "adult" | "medical" | "political")
            )
        })
        && object.get("availabilityStatus").is_none_or(|value| {
            matches!(
                value.as_str(),
                Some("unknown" | "available" | "unavailable")
            )
        })
        && object.get("broadcastStatus").is_none_or(|value| {
            matches!(
                value.as_str(),
                Some("video" | "live" | "upcoming" | "archive")
            )
        })
}
fn external_media_music(value: &serde_json::Value, current_year: u32) -> bool {
    let Some(object) = hub_json_object(
        value,
        &[
            "id",
            "title",
            "artist",
            "album",
            "description",
            "genre",
            "tags",
            "tagSignals",
            "year",
            "accent",
            "symbol",
            "artworkUrl",
            "featured",
            "source",
            "submittedBy",
            "createdAt",
            "services",
        ],
    ) else {
        return false;
    };
    if !hub_json_strings(
        object,
        &[
            "id",
            "title",
            "artist",
            "description",
            "genre",
            "accent",
            "symbol",
        ],
    ) || ![
        ("title", 180),
        ("artist", 120),
        ("description", 500),
        ("genre", 60),
    ]
    .iter()
    .all(|(key, max)| {
        object
            .get(*key)
            .is_some_and(|value| external_media_text(value, *max, true).is_ok())
    }) || !hub_json_optional_strings(object, &["album", "submittedBy", "createdAt"])
        || object.get("source").and_then(serde_json::Value::as_str) != Some("community")
        || !object
            .get("year")
            .and_then(|value| hub_json_integer(value, current_year.saturating_add(1) as u64))
            .is_some_and(|year| year >= 1000)
        || !object
            .get("featured")
            .is_none_or(serde_json::Value::is_boolean)
        || !external_media_optional_url(object, "artworkUrl")
    {
        return false;
    }
    if !object.get("tags").is_none_or(|value| {
        value.as_array().is_some_and(|values| {
            values
                .iter()
                .all(|value| value.as_str().is_some_and(|tag| !tag.is_empty()))
        })
    }) {
        return false;
    }
    if !object.get("tagSignals").is_none_or(|value| {
        value.as_array().is_some_and(|values| {
            values.iter().all(|value| {
                hub_json_object(value, &["tag", "kind", "confidence", "source"]).is_some_and(
                    |signal| {
                        hub_json_strings(signal, &["tag"])
                            && matches!(
                                signal.get("kind").and_then(serde_json::Value::as_str),
                                Some(
                                    "genre"
                                        | "era"
                                        | "language"
                                        | "region"
                                        | "mood"
                                        | "scene"
                                        | "tempo"
                                        | "feature"
                                        | "instrument"
                                        | "theme"
                                )
                            )
                            && matches!(
                                signal.get("source").and_then(serde_json::Value::as_str),
                                Some("metadata" | "rule" | "behavior")
                            )
                            && signal
                                .get("confidence")
                                .and_then(serde_json::Value::as_f64)
                                .is_some_and(|confidence| {
                                    confidence.is_finite() && (0.0..=1.0).contains(&confidence)
                                })
                    },
                )
            })
        })
    }) {
        return false;
    }
    let Some(services) = object.get("services").and_then(serde_json::Value::as_array) else {
        return false;
    };
    let mut providers = std::collections::HashSet::new();
    (1..=6).contains(&services.len())
        && services.iter().all(|value| {
            hub_json_object(value, &["provider", "label", "url", "embedUrl"]).is_some_and(
                |service| {
                    hub_json_strings(service, &["label"])
                        && service
                            .get("provider")
                            .and_then(serde_json::Value::as_str)
                            .is_some_and(|provider| {
                                external_media_music_provider(provider)
                                    && providers.insert(provider)
                            })
                        && service
                            .get("url")
                            .and_then(serde_json::Value::as_str)
                            .is_some_and(external_media_secure_url)
                        && external_media_optional_url(service, "embedUrl")
                },
            )
        })
        && services.iter().any(|value| {
            value["provider"] == "youtube"
                && value["embedUrl"]
                    .as_str()
                    .is_some_and(external_media_secure_url)
        })
}
fn external_media_receipt(
    value: &serde_json::Value,
    operation: ExternalMediaOperation,
    input: &serde_json::Value,
    current_year: u32,
) -> Result<(), String> {
    let keys: &[&str] = match operation {
        ExternalMediaOperation::VideoMetadata | ExternalMediaOperation::MusicMetadata => {
            &["viewerId", "requestedSourceUrl", "metadata"]
        }
        ExternalMediaOperation::VideoRegister => &["viewerId", "video"],
        ExternalMediaOperation::MusicRegister => &["viewerId", "work"],
        ExternalMediaOperation::MusicReport => &["viewerId", "workId", "reported"],
    };
    let object = hub_json_object(value, keys).ok_or_else(external_media_unavailable)?;
    if !hub_json_strings(object, &["viewerId"]) || !hub_json_clean_strings(value) {
        return Err(external_media_unavailable());
    }
    let valid = match operation {
        ExternalMediaOperation::VideoMetadata | ExternalMediaOperation::MusicMetadata => {
            object.get("requestedSourceUrl") == input.get("sourceUrl")
                && object.get("metadata").is_some_and(|metadata| {
                    external_media_metadata(
                        metadata,
                        operation == ExternalMediaOperation::MusicMetadata,
                    )
                })
        }
        ExternalMediaOperation::VideoRegister => {
            object.get("video").is_some_and(external_media_video)
        }
        ExternalMediaOperation::MusicRegister => object
            .get("work")
            .is_some_and(|work| external_media_music(work, current_year)),
        ExternalMediaOperation::MusicReport => {
            object.get("workId") == input.get("workId")
                && object.get("reported").and_then(serde_json::Value::as_bool) == Some(true)
        }
    };
    if !valid {
        return Err(external_media_unavailable());
    }
    Ok(())
}
fn external_media_error(status: u16, body: &[u8]) -> String {
    if status == 401 {
        return "desktop_not_connected".to_owned();
    }
    if !matches!(status, 400 | 403 | 404 | 409 | 410 | 422) {
        return external_media_unavailable();
    }
    let value = serde_json::from_slice::<serde_json::Value>(body).ok();
    let code = value
        .as_ref()
        .and_then(|value| value.get("error"))
        .and_then(serde_json::Value::as_str)
        .filter(|code| {
            matches!(
                (status, *code),
                (400, "invalid_request")
                    | (403, "invalid_request_origin" | "suspended")
                    | (404, "not_found")
                    | (409, "video_exists")
                    | (410, "youtube_video_registration_closed")
                    | (422, "youtube_music_rejected")
            )
        })
        .unwrap_or("rejected");
    format!("external_media_rejected:{status}:{code}")
}
// The API issues this one music-register error before createD1MusicWork is called.
// General 503/transport/receipt failures remain an unknown operation outcome.
fn external_media_operation_error(
    operation: ExternalMediaOperation,
    status: u16,
    body: &[u8],
) -> String {
    if operation == ExternalMediaOperation::MusicRegister && status == 503 {
        if serde_json::from_slice::<serde_json::Value>(body)
            .ok()
            .is_some_and(|value| {
                value.as_object().is_some_and(|value| {
                    value.len() == 1
                        && value.get("error").and_then(serde_json::Value::as_str)
                            == Some("youtube_music_validation_unavailable")
                })
            })
        {
            return "external_media_rejected:503:youtube_music_validation_unavailable".to_owned();
        }
    }
    external_media_error(status, body)
}

async fn external_media_request(
    base: &str,
    operation: ExternalMediaOperation,
    input: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let current_year = chrono::Datelike::year(&chrono::Utc::now()) as u32;
    let rebuilt = external_media_input(operation, input, current_year)?;
    let body = external_media_body(&rebuilt)?;
    let url = hub_json_url(base, external_media_path(operation))
        .map_err(|_| external_media_unavailable())?;
    let assertion = hub_json_assertion(
        true,
        crate::desktop_account::assertion_if_registered(base).await,
    )
    .map_err(|error| {
        if error == "desktop_not_connected" {
            error
        } else {
            external_media_unavailable()
        }
    })?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| external_media_unavailable())?;
    let mut request = client
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body);
    if let Some(assertion) = assertion {
        request = request.bearer_auth(assertion);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| external_media_unavailable())?;
    let status = response.status().as_u16();
    if status == 401
        || (!response.status().is_success() && !matches!(status, 400 | 403 | 404 | 409 | 410 | 422)
            && !(status == 503 && operation == ExternalMediaOperation::MusicRegister))
    {
        return Err(external_media_error(status, &[]));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_BYTES as u64)
    {
        return Err(external_media_unavailable());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| external_media_unavailable())?
    {
        hub_json_push_response(&mut bytes, &chunk).map_err(|_| external_media_unavailable())?;
    }
    let expected_status = if matches!(
        operation,
        ExternalMediaOperation::VideoRegister | ExternalMediaOperation::MusicRegister
    ) {
        201
    } else {
        200
    };
    if status != expected_status {
        return Err(external_media_operation_error(operation, status, &bytes));
    }
    let value = serde_json::from_slice(&bytes).map_err(|_| external_media_unavailable())?;
    external_media_receipt(&value, operation, &rebuilt, current_year)?;
    Ok(value)
}
pub async fn external_video_metadata(
    base: &str,
    input: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    external_media_request(base, ExternalMediaOperation::VideoMetadata, input).await
}
pub async fn external_video_register(
    base: &str,
    input: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    external_media_request(base, ExternalMediaOperation::VideoRegister, input).await
}
pub async fn external_music_metadata(
    base: &str,
    input: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    external_media_request(base, ExternalMediaOperation::MusicMetadata, input).await
}
pub async fn external_music_register(
    base: &str,
    input: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    external_media_request(base, ExternalMediaOperation::MusicRegister, input).await
}
pub async fn external_music_report(
    base: &str,
    input: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    external_media_request(base, ExternalMediaOperation::MusicReport, input).await
}

#[cfg(test)]
mod external_media_tests {
    use super::*;
    use serde_json::json;
    fn video_input() -> serde_json::Value {
        json!({"sourceUrl":"https://vimeo.com/123","title":"Title","channel":"Creator","category":"Art","purpose":"creation","topic":"Sketch"})
    }
    fn music_input() -> serde_json::Value {
        json!({"title":"Title","artist":"Artist","description":"Description","genre":"Pop","year":2026,"serviceUrls":["https://www.youtube.com/watch?v=dQw4w9WgXcQ"]})
    }
    fn music_work() -> serde_json::Value {
        json!({"id":"work1","title":"Title","artist":"Artist","description":"Description","genre":"Pop","year":2026,"accent":"accent","symbol":"AT","source":"community","services":[{"provider":"youtube","label":"YouTube","url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","embedUrl":"https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"}]})
    }
    #[test]
    fn only_five_paths_and_basic_secure_urls_are_admitted() {
        assert_eq!(
            [
                ExternalMediaOperation::VideoMetadata,
                ExternalMediaOperation::VideoRegister,
                ExternalMediaOperation::MusicMetadata,
                ExternalMediaOperation::MusicRegister,
                ExternalMediaOperation::MusicReport
            ]
            .map(external_media_path),
            [
                "/api/client/videos/metadata",
                "/api/client/videos",
                "/api/client/music/metadata",
                "/api/client/music",
                "/api/client/music/reports"
            ]
        );
        for url in [
            "http://vimeo.com/123",
            "https://user:pass@vimeo.com/123",
            "https://vimeo.com:8443/123",
            "file:///a",
            "javascript:alert(1)",
            "https://vimeo.com/\n123",
            "https://vimeo.com/\0",
        ] {
            assert!(!external_media_secure_url(url));
        }
        assert!(external_media_secure_url("https://vimeo.com/123"));
        let raw = json!({"sourceUrl":"\u{feff} https://youtu.be/dQw4w9WgXcQ?si=x \t"});
        assert_eq!(
            external_media_input(ExternalMediaOperation::VideoMetadata, &raw, 2026).unwrap()
                ["sourceUrl"],
            "https://youtu.be/dQw4w9WgXcQ?si=x"
        );
        let url =
            "https://example.test/".to_owned() + &"a".repeat(2048 - "https://example.test/".len());
        assert!(external_media_input(
            ExternalMediaOperation::VideoMetadata,
            &json!({"sourceUrl":url}),
            2026
        )
        .is_ok());
        assert!(external_media_input(
            ExternalMediaOperation::VideoMetadata,
            &json!({"sourceUrl":format!("{url}x")}),
            2026
        )
        .is_err());
        assert!(hub_json_url(
            "https://hub.example/?path=/other",
            external_media_path(ExternalMediaOperation::MusicRegister)
        )
        .is_err());
    }
    #[test]
    fn raw_video_types_widths_purpose_and_extra_keys_are_closed() {
        for (key, maximum) in [
            ("title", 240),
            ("channel", 120),
            ("category", 80),
            ("topic", 80),
            ("relatedHubpediaSlug", 160),
        ] {
            let mut input = video_input();
            input[key] = json!("a".repeat(maximum));
            assert!(
                external_media_input(ExternalMediaOperation::VideoRegister, &input, 2026).is_ok()
            );
            input[key] = json!("a".repeat(maximum + 1));
            assert!(
                external_media_input(ExternalMediaOperation::VideoRegister, &input, 2026).is_err()
            );
        }
        let mut input = video_input();
        input["title"] = json!("😀".repeat(120));
        assert!(external_media_input(ExternalMediaOperation::VideoRegister, &input, 2026).is_ok());
        input["title"] = json!("😀".repeat(121));
        assert!(external_media_input(ExternalMediaOperation::VideoRegister, &input, 2026).is_err());
        for (key, value) in [
            ("title", json!(false)),
            ("title", json!("a\0b")),
            ("purpose", json!(" creation ")),
            ("sourceUrl", json!(3)),
            ("submitter", json!("other")),
            ("createdAt", json!("forged")),
        ] {
            let mut input = video_input();
            input[key] = value;
            assert!(
                external_media_input(ExternalMediaOperation::VideoRegister, &input, 2026).is_err()
            );
        }
        assert!(serde_json::from_str::<serde_json::Value>(r#"{"title":"\uD800"}"#).is_err());
        assert!(external_media_input(
            ExternalMediaOperation::VideoMetadata,
            &json!({"sourceUrl":"https://vimeo.com/1","actor":"other"}),
            2026
        )
        .is_err());
    }
    #[test]
    fn music_year_string_fields_tag_and_link_array_limits_are_checked_before_server_parser() {
        for year in [1000, 2027] {
            let mut value = music_input();
            value["year"] = json!(year);
            assert!(
                external_media_input(ExternalMediaOperation::MusicRegister, &value, 2026).is_ok()
            );
        }
        for year in [
            json!("2026"),
            json!(999),
            json!(2028),
            json!(2026.5),
            json!(true),
        ] {
            let mut value = music_input();
            value["year"] = year;
            assert!(
                external_media_input(ExternalMediaOperation::MusicRegister, &value, 2026).is_err()
            );
        }
        for (key, max) in [
            ("title", 180),
            ("artist", 120),
            ("description", 500),
            ("genre", 60),
        ] {
            let mut value = music_input();
            value[key] = json!("x".repeat(max));
            assert!(
                external_media_input(ExternalMediaOperation::MusicRegister, &value, 2026).is_ok()
            );
            value[key] = json!("x".repeat(max + 1));
            assert!(
                external_media_input(ExternalMediaOperation::MusicRegister, &value, 2026).is_err()
            );
        }
        for count in [0, 12, 13] {
            let mut value = music_input();
            value["tags"] = json!((0..count).map(|i| format!("tag{i}")).collect::<Vec<_>>());
            assert_eq!(
                external_media_input(ExternalMediaOperation::MusicRegister, &value, 2026).is_ok(),
                count <= 12
            );
        }
        for count in [0, 1, 6, 7] {
            let mut value = music_input();
            value["serviceUrls"] =
                json!(vec!["https://www.youtube.com/watch?v=dQw4w9WgXcQ"; count]);
            assert_eq!(
                external_media_input(ExternalMediaOperation::MusicRegister, &value, 2026).is_ok(),
                (1..=6).contains(&count)
            );
        }
        for tags in [
            json!(null),
            json!("tag"),
            json!([1]),
            json!(["😀".repeat(21)]),
            json!(["a\0b"]),
        ] {
            let mut value = music_input();
            value["tags"] = tags;
            assert!(
                external_media_input(ExternalMediaOperation::MusicRegister, &value, 2026).is_err()
            );
        }
        for urls in [
            json!(null),
            json!([1]),
            json!(["https://user@youtube.com/watch?v=x"]),
        ] {
            let mut value = music_input();
            value["serviceUrls"] = urls;
            assert!(
                external_media_input(ExternalMediaOperation::MusicRegister, &value, 2026).is_err()
            );
        }
    }
    #[test]
    fn metadata_receipts_bind_rawtrim_request_viewer_public_provider_and_safe_urls() {
        let input = json!({"sourceUrl":"https://youtu.be/dQw4w9WgXcQ?si=x"});
        let original = json!({"viewerId":"viewer","requestedSourceUrl":input["sourceUrl"],"metadata":{"sourceUrl":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","provider":"YouTube","title":"Title"}});
        assert!(external_media_receipt(
            &original,
            ExternalMediaOperation::VideoMetadata,
            &input,
            2026
        )
        .is_ok());
        for (key, value) in [
            ("viewerId", json!(null)),
            ("requestedSourceUrl", json!("https://youtu.be/other")),
            ("rawProviderPayload", json!({})),
        ] {
            let mut receipt = original.clone();
            receipt[key] = value;
            assert!(external_media_receipt(
                &receipt,
                ExternalMediaOperation::VideoMetadata,
                &input,
                2026
            )
            .is_err());
        }
        for (key, value) in [
            ("provider", json!("unknown")),
            ("thumbnailUrl", json!("https://user@host.test/x")),
            ("sourceUrl", json!("http://host.test/x")),
            ("body", json!("private audio")),
        ] {
            let mut receipt = original.clone();
            receipt["metadata"][key] = value;
            assert!(external_media_receipt(
                &receipt,
                ExternalMediaOperation::VideoMetadata,
                &input,
                2026
            )
            .is_err());
        }
        let music = json!({"viewerId":"viewer","requestedSourceUrl":input["sourceUrl"],"metadata":{"sourceUrl":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","provider":"youtube","providerLabel":"YouTube"}});
        assert!(external_media_receipt(
            &music,
            ExternalMediaOperation::MusicMetadata,
            &input,
            2026
        )
        .is_ok());
    }
    #[test]
    fn registration_dtos_do_not_leak_internal_ids_or_accept_unknown_provider_shapes() {
        let input = music_input();
        let original = json!({"viewerId":"viewer","work":music_work()});
        assert!(external_media_receipt(
            &original,
            ExternalMediaOperation::MusicRegister,
            &input,
            2026
        )
        .is_ok());
        for (key, value) in [
            ("ownerId", json!("internal")),
            ("creatorId", json!("internal")),
            ("source", json!("sample")),
            ("title", json!(1)),
            ("year", json!("2026")),
        ] {
            let mut receipt = original.clone();
            receipt["work"][key] = value;
            assert!(external_media_receipt(
                &receipt,
                ExternalMediaOperation::MusicRegister,
                &input,
                2026
            )
            .is_err());
        }
        let mut receipt = original.clone();
        receipt["work"]["services"][0]["url"] = json!("javascript:alert(1)");
        assert!(external_media_receipt(
            &receipt,
            ExternalMediaOperation::MusicRegister,
            &input,
            2026
        )
        .is_err());
        receipt = original;
        receipt["work"]["services"][0]["provider"] = json!("unknown");
        assert!(external_media_receipt(
            &receipt,
            ExternalMediaOperation::MusicRegister,
            &input,
            2026
        )
        .is_err());
        let video = json!({"viewerId":"viewer","video":{"id":"v1","title":"Title","channel":"Creator","category":"Art","purpose":"creation","topic":"Sketch","provider":"vimeo","sourceUrl":"https://vimeo.com/123","publishedAt":"2026-10-06T00:00:00Z","createdAt":"2026-10-06T00:00:00Z","viewCount":0}});
        assert!(external_media_receipt(
            &video,
            ExternalMediaOperation::VideoRegister,
            &video_input(),
            2026
        )
        .is_ok());
    }
    #[test]
    fn reports_match_exact_external_work_and_reported_truth() {
        let input = json!({"workId":" work1 ","reason":"wrong_metadata","details":" observed "});
        let rebuilt =
            external_media_input(ExternalMediaOperation::MusicReport, &input, 2026).unwrap();
        assert_eq!(
            rebuilt,
            json!({"workId":"work1","reason":"wrong_metadata","details":"observed"})
        );
        let receipt = json!({"viewerId":"viewer","workId":"work1","reported":true});
        assert!(external_media_receipt(
            &receipt,
            ExternalMediaOperation::MusicReport,
            &rebuilt,
            2026
        )
        .is_ok());
        for (key, value) in [
            ("workId", json!("other")),
            ("reported", json!(false)),
            ("viewerId", json!(null)),
            ("reporterId", json!("internal")),
        ] {
            let mut receipt = receipt.clone();
            receipt[key] = value;
            assert!(external_media_receipt(
                &receipt,
                ExternalMediaOperation::MusicReport,
                &rebuilt,
                2026
            )
            .is_err());
        }
        for bad in [
            json!({"workId":"music:00000000-0000-4000-8000-000000000001","reason":"rights"}),
            json!({"workId":"work1","reason":"other","details":"a".repeat(1001)}),
            json!({"workId":"work1","reason":"bogus"}),
            json!({"workId":"work1","reason":"other","actor":"other"}),
        ] {
            assert!(external_media_input(ExternalMediaOperation::MusicReport, &bad, 2026).is_err());
        }
    }
    #[test]
    fn byte_limits_auth_and_fixed_errors_keep_raw_failures_private() {
        assert_eq!(
            external_media_body(&json!("a".repeat(EXTERNAL_MEDIA_BODY_BYTES - 2)))
                .unwrap()
                .len(),
            EXTERNAL_MEDIA_BODY_BYTES
        );
        assert!(external_media_body(&json!("a".repeat(EXTERNAL_MEDIA_BODY_BYTES - 1))).is_err());
        let mut bytes = vec![0; MAX_BYTES];
        assert!(hub_json_push_response(&mut bytes, b"x").is_err());
        assert_eq!(bytes.len(), MAX_BYTES);
        assert_eq!(
            hub_json_assertion(true, Ok(None)).unwrap_err(),
            "desktop_not_connected"
        );
        assert!(hub_json_assertion(true, Err("synthetic failure".into())).is_err());
        for (status, code) in [
            (400, "invalid_request"),
            (403, "suspended"),
            (404, "not_found"),
            (409, "video_exists"),
            (410, "youtube_video_registration_closed"),
            (422, "youtube_music_rejected"),
        ] {
            assert_eq!(
                external_media_error(status, &serde_json::to_vec(&json!({"error":code})).unwrap()),
                format!("external_media_rejected:{status}:{code}")
            );
        }
        assert_eq!(
            external_media_error(403, br#"{"error":"private body token /path"}"#),
            "external_media_rejected:403:rejected"
        );
        assert_eq!(
            external_media_error(401, b"private body"),
            "desktop_not_connected"
        );
        for status in [200, 201, 302, 503] {
            assert_eq!(
                external_media_error(status, b"private body"),
                external_media_unavailable()
            );
        }
    }
}

#[cfg(test)]
mod external_media_validation_unavailable_tests {
    use super::*;
    #[test]
    fn only_music_registration_keeps_the_exact_before_write_validation_failure() {
        let known = br#"{"error":"youtube_music_validation_unavailable"}"#;
        assert_eq!(
            external_media_operation_error(ExternalMediaOperation::MusicRegister, 503, known),
            "external_media_rejected:503:youtube_music_validation_unavailable"
        );
        for operation in [
            ExternalMediaOperation::VideoMetadata,
            ExternalMediaOperation::VideoRegister,
            ExternalMediaOperation::MusicMetadata,
            ExternalMediaOperation::MusicReport,
        ] {
            assert_eq!(
                external_media_operation_error(operation, 503, known),
                external_media_unavailable()
            );
        }
        for body in [
            b"".as_slice(),
            b"broken JSON".as_slice(),
            br#"{"error":"external_media_unavailable"}"#.as_slice(),
            br#"{"error":"youtube_music_validation_unavailable","private":"payload"}"#.as_slice(),
            br#"{"error":true}"#.as_slice(),
        ] {
            assert_eq!(
                external_media_operation_error(ExternalMediaOperation::MusicRegister, 503, body),
                external_media_unavailable()
            );
        }
        for status in [200, 201, 302, 500] {
            assert_eq!(
                external_media_operation_error(
                    ExternalMediaOperation::MusicRegister,
                    status,
                    known
                ),
                external_media_unavailable()
            );
        }
        assert_eq!(
            external_media_operation_error(ExternalMediaOperation::MusicRegister, 401, known),
            "desktop_not_connected"
        );
        assert_eq!(
            external_media_operation_error(
                ExternalMediaOperation::MusicRegister,
                409,
                br#"{"error":"video_exists"}"#
            ),
            "external_media_rejected:409:video_exists"
        );
        // The general classifier is unchanged; a code alone is not authority outside this operation.
        assert_eq!(
            external_media_error(503, known),
            external_media_unavailable()
        );
    }
}

#[cfg(test)]
mod stage25_article_publication_tests {
    use super::*;
    const REQUEST: &str = "12345678-1234-4234-8234-123456789abc";
    const ARTICLE: &str = "abcdef00-1234-4234-8234-123456789abc";
    const DEVICE: &str = "12345678-1234-4234-8234-123456789abd";
    fn options() -> serde_json::Value {
        serde_json::json!({"title":"Title", "expectedDeviceId":DEVICE,"expectedOrigin":"http://127.0.0.1:3020"})
    }
    fn create(text: &str, value: &serde_json::Value) -> Result<serde_json::Value, String> {
        action_request("create_article", None, Some(text), Some(REQUEST), Some(value)).map(|(_, _, body)| body)
    }
    #[test]
    fn article_publication_preserves_scalar_limits_and_web_normalization_without_truncation() {
        let mut value = options(); value["title"] = format!(" \u{feff}{}\u{feff} ","😀".repeat(120)).into();
        value["summary"] = "😀".repeat(400).into(); value["tags"] = " one, two , ,one ".into();
        let body = create(&format!(" \r\n{}\r\n ","😀".repeat(100_000)), &value).unwrap();
        assert_eq!(body["title"], "😀".repeat(120)); assert_eq!(body["body"], "😀".repeat(100_000));
        assert_eq!(body["summary"], "😀".repeat(400)); assert_eq!(body["tags"],serde_json::json!(["one","two"]));
        assert_eq!(body["clientRequestId"],REQUEST); assert_eq!(body["audience"],"general"); assert_eq!(body["access"],"public");
        assert!(body.get("expectedDeviceId").is_none()); assert!(body.get("expectedOrigin").is_none());
        assert_eq!(create("  first\r\nsecond  ",&options()).unwrap()["body"],"first\nsecond");
        assert!(create(&"😀".repeat(100_001),&options()).is_err());
        for (key, content) in [("title","😀".repeat(121)),("summary","😀".repeat(401))] {
            let mut value=options(); value[key]=content.into(); assert!(create("body",&value).is_err());
        }
    }
    #[test]
    fn article_publication_rejects_unclosed_wrong_types_raw_oversize_and_invalid_scope() {
        for (key, content) in [("title",serde_json::Value::Null),("summary",serde_json::json!(12)),
            ("tags",serde_json::json!(["tag"])),("audience",serde_json::json!("adult")),
            ("access",serde_json::json!("paid")),("expectedDeviceId",serde_json::json!("../device")),
            ("expectedOrigin",serde_json::json!("https://hub.example/path"))] {
            let mut value=options(); value[key]=content; assert!(create("body",&value).is_err());
        }
        for invalid in [None,Some("bad"),Some("12345678-1234-1234-8234-123456789abc"),Some("12345678-1234-4234-8234-123456789ABC")] {
            assert!(action_request("create_article",None,Some("body"),invalid,Some(&options())).is_err());
        }
        assert!(action_request("create_article",Some(""),Some("body"),Some(REQUEST),Some(&options())).is_err());
        for key in ["title","expectedDeviceId","expectedOrigin"] {let mut value=options();value.as_object_mut().unwrap().remove(key);assert!(create("body",&value).is_err());}
        assert!(create("body\0",&options()).is_err()); assert!(create(" \r\n ",&options()).is_err());
        let mut tagged=options();tagged["tags"]="😀".repeat(12).into();
        assert_eq!(create("body",&tagged).unwrap()["tags"],serde_json::json!(["😀".repeat(12)]));
        tagged["tags"]="😀".repeat(13).into();assert!(create("body",&tagged).is_err());
        let eight=(0..8).map(|id|format!("tag{id}")).collect::<Vec<_>>();
        tagged["tags"]=format!("{}, tag0, ,tag7",eight.join(",")).into();
        assert_eq!(create("body",&tagged).unwrap()["tags"],serde_json::json!(eight));
        tagged["tags"]=(0..9).map(|id|format!("tag{id}")).collect::<Vec<_>>().join(",").into();
        assert!(create("body",&tagged).is_err());
        assert_eq!(create(&format!("{}body"," ".repeat(ARTICLE_PUBLICATION_MAX_REQUEST_BYTES)),&options()).unwrap_err(),"article_publication_request_too_large");
        assert!(article_publication_bytes(&serde_json::json!("\u{0001}".repeat(ARTICLE_PUBLICATION_MAX_REQUEST_BYTES/6+1))).is_err());
    }
    #[test]
    fn article_publication_lookup_accepts_only_uuid_device_origin_and_receipts_bind_the_requested_operation() {
        let (template,auth)=detail_path("article_publication").unwrap();assert!(auth);
        let ids=vec![REQUEST.into(),DEVICE.into(),"http://127.0.0.1:3020".into()];
        assert_eq!(fill_path(template,&ids).unwrap(),format!("/api/client/articles/publication/{REQUEST}"));
        for ids in [Vec::new(),vec![REQUEST.into()],vec![REQUEST.into(),DEVICE.into()],
            vec![REQUEST.into(),DEVICE.into(),"http://127.0.0.1:3020".into(),"extra".into()]] {assert!(fill_path(template,&ids).is_err());}
        let bytes=|value:&serde_json::Value| serde_json::to_vec(value).unwrap();
        let receipt=serde_json::json!({"id":ARTICLE,"href":format!("/articles/{ARTICLE}"),"duplicate":false,"clientRequestId":REQUEST});
        assert_eq!(article_publication_receipt(&bytes(&receipt),REQUEST,false,201).unwrap(),receipt);
        assert!(article_publication_receipt(&bytes(&receipt),REQUEST,false,200).is_err());
        for (key,content) in [("clientRequestId",serde_json::json!(DEVICE)),("href",serde_json::json!("https://evil.invalid")),
            ("id",serde_json::json!("../article")),("duplicate",serde_json::json!("false")),("body",serde_json::json!("private"))] {
            let mut changed=receipt.clone();changed[key]=content;assert_eq!(article_publication_receipt(&bytes(&changed),REQUEST,false,201).unwrap_err(),ARTICLE_PUBLICATION_UNKNOWN);
        }
        for found in [false,true] {
            let mut receipt=serde_json::json!({"found":found,"clientRequestId":REQUEST});
            if found {receipt["id"]=ARTICLE.into();receipt["href"]=format!("/articles/{ARTICLE}").into();}
            assert_eq!(article_publication_receipt(&bytes(&receipt),REQUEST,true,200).unwrap(),receipt);
        }
        let invalid=serde_json::json!({"found":false,"clientRequestId":REQUEST,"id":null});
        assert!(article_publication_receipt(&bytes(&invalid),REQUEST,true,200).is_err());
        assert!(article_publication_receipt(&vec![b' ';ARTICLE_PUBLICATION_MAX_RECEIPT_BYTES+1],REQUEST,true,200).is_err());
        let duplicate=format!("{{\"found\":false,\"found\":true,\"clientRequestId\":\"{REQUEST}\"}}");
        assert!(article_publication_receipt(duplicate.as_bytes(),REQUEST,true,200).is_err());
    }
    #[test]
    fn article_publication_distinguishes_conflict_and_unknown_without_returning_raw_errors() {
        assert_eq!(article_publication_status(409).unwrap_err(),"article_publication_conflict");
        assert_eq!(article_publication_status(401).unwrap_err(),"desktop_not_connected");
        for status in [400,403,413,429] {assert_eq!(article_publication_status(status).unwrap_err(),format!("article_publication_rejected:{status}"));}
        for status in [204,302,404,500,503] {assert_eq!(article_publication_status(status).unwrap_err(),ARTICLE_PUBLICATION_UNKNOWN);}
    }
}

#[cfg(test)]
mod stage26_thread_post_control_tests {
    use super::*;
    const POST: &str = "post_1";
    const VIEWER: &str = "viewer_1";
    const DEVICE: &str = "12345678-1234-4234-8234-123456789abc";
    fn ids() -> Vec<String> { vec![POST.into(),DEVICE.into(),"http://127.0.0.1:3020".into(),VIEWER.into()] }
    fn options() -> serde_json::Value { serde_json::json!({"kind":"mute","enabled":true,"expectedDeviceId":DEVICE,
        "expectedOrigin":"http://127.0.0.1:3020","expectedViewerId":VIEWER}) }
    fn encoded(value: &serde_json::Value) -> String {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD,Engine};
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(value).unwrap())
    }
    fn cursor(id: &str, at: &str) -> String { encoded(&serde_json::json!({"postId":POST,"createdAt":at,"id":id})) }
    fn revision(id: &str, at: &str) -> serde_json::Value {
        serde_json::json!({"id":id,"postId":POST,"body":"old text","createdAt":at,"editReason":"reason"})
    }
    fn history(rows: Vec<serde_json::Value>, next: Option<String>) -> serde_json::Value {
        serde_json::json!({"viewerId":VIEWER,"postId":POST,"revisions":rows,"nextCursor":next})
    }
    fn decode(value: &serde_json::Value, history: bool, after: Option<&str>, desired: Option<(&str,bool)>) -> Result<serde_json::Value,String> {
        thread_post_control_receipt(&serde_json::to_vec(value).unwrap(),POST,VIEWER,history,after,desired)
    }
    #[test]
    fn thread_post_control_paths_and_cursor_are_closed_and_target_bound() {
        let (relation,auth)=detail_path("thread_post_relationship").unwrap();assert!(auth);
        let (history,auth)=detail_path("thread_post_history").unwrap();assert!(auth);
        assert_eq!(fill_path(relation,&ids()).unwrap(),"/api/client/thread-posts/post_1/relationship");
        assert_eq!(fill_path(history,&ids()).unwrap(),"/api/client/thread-posts/post_1/history");
        let after=cursor("revision-1","2026-10-07 09:00:00");let mut page=ids();page.push(after.clone());
        assert_eq!(fill_path(history,&page).unwrap(),format!("/api/client/thread-posts/{POST}/history?after={after}"));
        assert!(fill_path(relation,&page).is_err());
        for count in 0..4 {assert!(fill_path(history,&ids()[..count]).is_err());}
        let mut extra=page.clone();extra.push("extra".into());assert!(fill_path(history,&extra).is_err());
        for (index,value) in [(0,"../post"),(0," post_1"),(1,""),(2,"http://127.0.0.1:3020/path"),(3,"viewer/id")] {
            let mut changed=ids();changed[index]=value.into();assert!(fill_path(history,&changed).is_err());
        }
        for raw in [String::new(),after.clone()+"=","x".repeat(513),encoded(&serde_json::json!({"postId":"other","createdAt":"2026-10-07","id":"revision-1"})),
            encoded(&serde_json::json!({"postId":POST,"createdAt":"2026-10-07","id":"revision-1","body":"private"}))] {
            assert!(thread_post_history_cursor(&raw,POST).is_err());
        }
        let parsed=thread_post_history_cursor(&after,POST).unwrap();assert_eq!(parsed.created_at,"2026-10-07 09:00:00");
    }
    #[test]
    fn thread_post_relationship_is_an_idempotent_set_with_no_scope_fields_in_the_body() {
        let first=action_request("thread_post_relationship",Some(POST),None,None,Some(&options())).unwrap();
        let second=action_request("thread_post_relationship",Some(POST),None,None,Some(&options())).unwrap();
        assert_eq!(first,second);assert_eq!(first.0,reqwest::Method::PUT);
        assert_eq!(first.1,"/api/client/thread-posts/post_1/relationship");assert_eq!(first.2,serde_json::json!({"kind":"mute","enabled":true}));
        let mut disabled=options();disabled["kind"]="block".into();disabled["enabled"]=false.into();
        assert_eq!(thread_post_control_action(Some(POST),None,None,Some(&disabled)).unwrap().2,serde_json::json!({"kind":"block","enabled":false}));
        for (key,value) in [("kind",serde_json::json!("toggle")),("enabled",serde_json::json!(1)),("enabled",serde_json::Value::Null),
            ("expectedViewerId",serde_json::json!("../viewer")),("role",serde_json::json!("owner"))] {
            let mut changed=options();changed[key]=value;assert!(thread_post_control_action(Some(POST),None,None,Some(&changed)).is_err());
        }
        for key in ["kind","enabled","expectedDeviceId","expectedOrigin","expectedViewerId"] {
            let mut changed=options();changed.as_object_mut().unwrap().remove(key);assert!(thread_post_control_action(Some(POST),None,None,Some(&changed)).is_err());
        }
        assert!(thread_post_control_action(Some(POST),Some(""),None,Some(&options())).is_err());
        assert!(thread_post_control_action(Some(POST),None,Some(""),Some(&options())).is_err());
    }
    #[test]
    fn thread_post_relationship_receipt_requires_matching_post_viewer_shape_and_desired_value() {
        let original=serde_json::json!({"viewerId":VIEWER,"postId":POST,"control":{"muted":true,"blocked":false}});
        assert_eq!(decode(&original,false,None,Some(("mute",true))).unwrap(),original);
        assert!(decode(&original,false,None,Some(("mute",false))).is_err());
        for (key,value) in [("viewerId",serde_json::json!("other")),("postId",serde_json::json!("other")),
            ("control",serde_json::json!({"muted":1,"blocked":false})),("authorId",serde_json::json!("private"))] {
            let mut changed=original.clone();changed[key]=value;assert_eq!(decode(&changed,false,None,None).unwrap_err(),THREAD_POST_CONTROL_UNKNOWN);
        }
        let duplicate=format!("{{\"viewerId\":\"{VIEWER}\",\"postId\":\"{POST}\",\"control\":{{\"muted\":true,\"muted\":false,\"blocked\":false}}}}");
        assert!(thread_post_control_receipt(duplicate.as_bytes(),POST,VIEWER,false,None,None).is_err());
    }
    #[test]
    fn thread_post_history_preserves_legacy_widths_and_rejects_oversized_or_unbound_rows() {
        let mut row=revision("revision-1","2026-10-07 09:00:00");row["body"]="😀".repeat(20_000).into();row["editReason"]="😀".repeat(300).into();
        let original=history(vec![row.clone()],None);assert_eq!(decode(&original,true,None,None).unwrap(),original);
        for (key,value) in [("body",serde_json::json!("😀".repeat(20_001))),("editReason",serde_json::json!("😀".repeat(301))),
            ("postId",serde_json::json!("other")),("body",serde_json::json!("x\0")),("authorId",serde_json::json!("private"))] {
            let mut changed=row.clone();changed[key]=value;assert!(decode(&history(vec![changed],None),true,None,None).is_err());
        }
        let rows=(0..5).rev().map(|id|{let mut row=revision(&format!("revision-{id}"),"2026-10-07T09:00:00Z");row["body"]="\u{0001}".repeat(20_000).into();row}).collect::<Vec<_>>();
        let page=history(rows.clone(),None);assert!(serde_json::to_vec(&page).unwrap().len()<THREAD_POST_CONTROL_MAX_BYTES);assert!(decode(&page,true,None,None).is_ok());
        let mut too_many=rows;too_many.push(revision("older","2026-10-06T09:00:00Z"));assert!(decode(&history(too_many,None),true,None,None).is_err());
        let mut missing=original.clone();missing.as_object_mut().unwrap().remove("nextCursor");assert!(decode(&missing,true,None,None).is_err());
        assert!(thread_post_control_receipt(&vec![b' ';THREAD_POST_CONTROL_MAX_BYTES+1],POST,VIEWER,true,None,None).is_err());
    }
    #[test]
    fn thread_post_history_keysets_are_strictly_ordered_and_next_cursor_matches_last_returned_row() {
        let rows=vec![revision("r2","2026-10-07 09:00:00"),revision("r1","2026-10-07 09:00:00")];
        let after=cursor("r3","2026-10-07 09:00:00");let next=cursor("r1","2026-10-07 09:00:00");
        assert!(decode(&history(rows.clone(),Some(next.clone())),true,Some(&after),None).is_ok());
        assert!(decode(&history(rows.clone(),Some(after.clone())),true,Some(&after),None).is_err());
        assert!(decode(&history(Vec::new(),Some(next)),true,None,None).is_err());
        assert!(decode(&history(vec![rows[1].clone(),rows[0].clone()],None),true,None,None).is_err());
        assert!(decode(&history(vec![rows[0].clone(),rows[0].clone()],None),true,None,None).is_err());
        let mut foreign=history(rows,None);foreign["viewerId"]="other".into();assert!(decode(&foreign,true,None,None).is_err());
    }
    #[test]
    fn thread_post_action_errors_keep_unknown_separate_from_definite_rejection() {
        assert!(thread_post_control_status(200).is_ok());assert_eq!(thread_post_control_status(401).unwrap_err(),"desktop_not_connected");
        for status in [400,403,404,409,413,429] {assert_eq!(thread_post_control_status(status).unwrap_err(),format!("thread_post_action_rejected:{status}"));}
        for status in [201,204,302,500,503] {assert_eq!(thread_post_control_status(status).unwrap_err(),THREAD_POST_CONTROL_UNKNOWN);}
    }
}

#[cfg(test)]
mod stage28_change_wire_tests {
    use super::*;
    #[test]
    fn proposal_import_preserves_optional_hash_and_body_without_an_author_claim() {
        let project=format!("rp_{}","a".repeat(32));
        let mut options=serde_json::json!({"requestId":"11111111-1111-4111-8111-111111111111","documentId":"doc.version","baseVersion":2,"body":"  本文🧪\n","summary":"理由"});
        let (_,_,body)=research_action("research_propose",Some(&project),Some(&options)).unwrap();
        assert_eq!(body["body"],options["body"]);assert!(body.get("expectedBaseHash").is_none());
        let hash=format!("sha256:{}","b".repeat(64));options["expectedBaseHash"]=serde_json::json!(hash);
        let (_,_,body)=research_action("research_propose",Some(&project),Some(&options)).unwrap();
        assert_eq!(body["expectedBaseHash"],hash);assert!(body.get("author").is_none());
        for invalid in [serde_json::Value::Null,serde_json::json!("bad"),serde_json::json!(format!("{hash}\n"))] {
            options["expectedBaseHash"]=invalid;assert!(research_action("research_propose",Some(&project),Some(&options)).is_err());
        }
    }
    #[test]
    fn dot_document_routes_use_bounded_queries_without_traversing_the_project_path() {
        let project=format!("rp_{}","a".repeat(32));
        for doc in ["doc.version","..","."] {
            let path=fill_path("/api/client/research/{a}/documents/{b}/revisions/{c}",&[project.clone(),doc.into(),"2".into()]).unwrap();
            assert_eq!(path,format!("/api/client/research/{project}/workspace?document={doc}&version=2"));
        }
        for bad in ["a./../b","doc.\n","doc.?x=1"] {
            assert!(fill_path("/api/client/research/{a}/documents/{b}",&[project.clone(),bad.into()]).is_err());
        }
    }
}

#[cfg(test)]
mod stage29_channel_width_tests {
 use super::*;
 #[test] fn channel_body_rejects_overflow_without_slicing_the_input() {
  let options=serde_json::json!({"channelId":"ch","kind":"chat"});
  let p="00000000-0000-4000-8000-000000000000";
  let body="😀".repeat(1000);
  let (_,_,value)=action_request("channel_message",Some("c"),Some(&body),Some(p),Some(&options)).unwrap();
  assert_eq!(value["body"],body);
  assert!(action_request("channel_message",Some("c"),Some(&(body+"x")),Some(p),Some(&options)).is_err());
 }
}

#[cfg(test)] mod stage30_dm_width_tests { use super::*;#[test] fn dm_utf16_rejects_overflow_and_never_slices(){let body="😀".repeat(140);let (_,_,packet)=action_request("send_message",Some("c"),Some(&body),Some("00000000-0000-4000-8000-000000000000"),None).unwrap();assert_eq!(packet["text"],body);assert!(action_request("send_message",Some("c"),Some(&(body+"x")),None,None).is_err());assert!(action_request("send_message",Some("c"),Some("\0"),None,None).is_err());}}

#[path = "community_ops_client.rs"]
mod community_ops_client;

#[cfg(test)]
mod stage54_publication_update_tests {
    use super::*;

    #[test]
    fn publication_updates_have_one_fixed_public_read_name() {
        assert_eq!(detail_path("research_publication_updates"), Some(("/api/research/discovery", false)));
        for name in ["research_publication_updates\n", "research_publication_updates?kind=article", "research_publication_updates_admin", "/api/research/discovery"] {
            assert!(detail_path(name).is_none());
        }
        assert!(resource_path("research_publication_updates").is_none());
    }

    #[test]
    fn publication_updates_require_exactly_zero_ids() {
        let path = "/api/research/discovery";
        assert_eq!(fill_path(path, &[]).unwrap(), path);
        for ids in [vec!["article".into()], vec![String::new()], vec!["?kind=article".into()], vec!["../admin".into()], vec!["a".into(), "b".into()]] {
            assert!(fill_path(path, &ids).is_err());
        }
    }

    #[tokio::test]
    async fn publication_updates_use_get_without_an_account_assertion() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        detail_path("research_publication_updates").expect("Fixed read must exist before transport test");
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let expected = serde_json::json!({"updates":[{"id":"work","kind":"music","title":"Work","href":"/v2/music/works/work","updatedAt":"2026-10-08T00:00:00.000Z"}]});
        let body = expected.to_string();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 1024];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0 && request.len() + count <= 4096);
                request.extend_from_slice(&buffer[..count]);
            }
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
            socket.write_all(response.as_bytes()).await.unwrap();
            String::from_utf8(request).unwrap()
        });
        let result = fetch_detail(&base, "research_publication_updates", &[]).await;
        if result.is_err() { server.abort(); }
        assert_eq!(result.unwrap(), expected);
        let request = server.await.unwrap();
        assert_eq!(request.lines().next(), Some("GET /api/research/discovery HTTP/1.1"));
        assert!(!request.to_ascii_lowercase().contains("\r\nauthorization:"));
    }
}

#[cfg(test)]
mod github_resource_tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn url(base: &str, query: &str) -> reqwest::Url { github_resource_url(base, query, None, None, None, None, None, false).unwrap() }
    fn dto() -> serde_json::Value { json!({"status":"ok","repository":{"name":"o/r","href":"https://github.com/o/r","description":"Public","defaultBranch":"main","stars":0},
        "issues":[],"pullRequests":[],"commits":[],"categoryStatuses":{"issues":"ok","pullRequests":"ok","commits":"ok"}}) }
    fn failure(status: &str) -> serde_json::Value { json!({"status":status,"repository":null,"issues":null,"pullRequests":null,"commits":null,
        "categoryStatuses":{"issues":status,"pullRequests":status,"commits":status}}) }

    #[test]
    fn github_resource_names_and_urls_preserve_full_boundaries() {
        assert_eq!(resource_path("github_repository"), Some("/api/client/github/repository"));
        for name in ["a/z".to_owned(), format!("{}/{}", "a".repeat(39), "z".repeat(100)), "Owner/Thing.git".into()] {
            let result = url("https://hub.example", &name);
            assert_eq!(result.path(), "/api/client/github/repository");
            assert_eq!(result.query_pairs().collect::<Vec<_>>(), vec![("repo".into(), name.to_ascii_lowercase().into())]);
        }
        for name in ["", "owner", "/r", "a/", "a/.", "a/..", " a/r", "a/r ", "a/r\n", "a/r/x", "a/%72", "a/r?x=1", "a/r#x", "https://github.com/a/r", "-a/r", "a-/r", "a_/r", "é/r"] {
            assert!(github_repository_name(name).is_err(), "{name}");
        }
        assert!(github_repository_name(&format!("{}/r", "a".repeat(40))).is_err());
        assert!(github_repository_name(&format!("a/{}", "r".repeat(101))).is_err());
        for base in ["http://remote.example", "https://user:pass@hub.example", "https://hub.example/path", "https://hub.example?token=x", "https://hub.example#x", "file:///tmp"] {
            assert!(github_resource_url(base, "o/r", None, None, None, None, None, false).is_err());
        }
    }
    #[test]
    fn github_resource_rejects_all_extra_query_flags_including_empty_values() {
        for flags in [(Some(""),None,None,None,None,false),(None,Some(""),None,None,None,false),(None,None,Some(0),None,None,false),
            (None,None,None,Some(""),None,false),(None,None,None,None,Some(""),false),(None,None,None,None,None,true)] {
            assert!(github_resource_url("https://hub.example", "o/r", flags.0, flags.1, flags.2, flags.3, flags.4, flags.5).is_err());
        }
    }
    #[test]
    fn github_resource_dtos_preserve_full_oids_partial_and_typed_failures() {
        for width in [40,64] {
            let mut expected=dto();let oid="a".repeat(width);
            expected["issues"]=json!([{"number":GITHUB_RESOURCE_SAFE_INTEGER,"title":"Issue","href":format!("https://github.com/o/r/issues/{GITHUB_RESOURCE_SAFE_INTEGER}")}]);
            expected["pullRequests"]=json!([{"number":1,"title":"PR","href":"https://github.com/o/r/pull/1"}]);
            expected["commits"]=json!([{"oid":oid,"title":"Commit","href":format!("https://github.com/o/r/commit/{}","a".repeat(width))}]);
            assert_eq!(github_response(200,"o/r",expected.to_string().as_bytes()).unwrap(),expected);
        }
        let mut partial=dto();partial["status"]=json!("partial");partial["commits"]=json!(null);partial["categoryStatuses"]["commits"]=json!("rate_limited");
        assert_eq!(github_response(200,"o/r",partial.to_string().as_bytes()).unwrap(),partial);
        for (status,body) in [(429,failure("rate_limited")),(503,failure("unavailable"))] {
            assert_eq!(github_response(status,"o/r",body.to_string().as_bytes()).unwrap(),body);
        }
    }
    #[test]
    fn github_resource_rejects_malformed_provider_fields_and_size_or_numeric_edges() {
        let mut variants=Vec::new();
        let mut value=dto();value["repository"]["href"]=json!("https://evil.example");variants.push(value);
        let mut value=dto();value["repository"]["stars"]=json!(GITHUB_RESOURCE_SAFE_INTEGER+1);variants.push(value);
        let mut value=dto();value["repository"]["email"]=json!("must_not_escape@example.com");variants.push(value);
        let mut value=dto();value.as_object_mut().unwrap().remove("issues");variants.push(value);
        let mut value=dto();value["issues"]=json!([{"number":0,"title":"bad","href":"https://github.com/o/r/issues/0"}]);variants.push(value);
        let mut value=dto();value["repository"]["description"]=json!("😀".repeat(501));variants.push(value);
        let mut value=dto();value["commits"]=json!([{"oid":"A".repeat(40),"title":"bad","href":format!("https://github.com/o/r/commit/{}","A".repeat(40))}]);variants.push(value);
        let mut value=dto();value["status"]=json!("partial");variants.push(value);
        for body in variants { assert_eq!(github_response(200,"o/r",body.to_string().as_bytes()).unwrap_err(),GITHUB_RESOURCE_UNAVAILABLE); }
        assert!(github_response(429,"o/r",dto().to_string().as_bytes()).is_err());
        assert!(github_response(404,"o/r",failure("unavailable").to_string().as_bytes()).is_err());
        assert!(github_response(200,"o/r",b"not json must_not_escape").is_err());
    }
    async fn fixture(status: u16, body: Vec<u8>, extra: &str) -> (reqwest::Url, tokio::task::JoinHandle<String>) {
        let listener=tokio::net::TcpListener::bind(("127.0.0.1",0)).await.unwrap();
        let endpoint=url(&format!("http://{}",listener.local_addr().unwrap()),"o/r");
        let headers=format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\n{extra}Connection: close\r\n\r\n");
        let server=tokio::spawn(async move {
            let (mut socket,_)=listener.accept().await.unwrap();let mut request=Vec::new();let mut buffer=[0u8;1024];
            while !request.windows(4).any(|bytes|bytes==b"\r\n\r\n") {let count=socket.read(&mut buffer).await.unwrap();assert!(count>0&&request.len()+count<=4096);request.extend_from_slice(&buffer[..count]);}
            let _=socket.write_all(headers.as_bytes()).await;let _=socket.write_all(&body).await;
            String::from_utf8(request).unwrap()
        });(endpoint,server)
    }
    #[tokio::test]
    async fn github_resource_transport_gets_anonymous_canonical_statuses() {
        for (status,body) in [(200,dto()),(429,failure("rate_limited")),(503,failure("unavailable"))] {
            let bytes=body.to_string().into_bytes();let (endpoint,server)=fixture(status,bytes.clone(),&format!("Content-Length: {}\r\n",bytes.len())).await;
            assert_eq!(fetch_github_resource(endpoint).await.unwrap(),body);
            let request=server.await.unwrap();assert_eq!(request.lines().next(),Some("GET /api/client/github/repository?repo=o%2Fr HTTP/1.1"));
            let request=request.to_ascii_lowercase();assert!(!request.contains("\r\nauthorization:")&&!request.contains("\r\ncookie:")&&!request.contains("\r\nproxy-authorization:"));
        }
    }
    #[tokio::test]
    async fn github_resource_transport_rejects_redirect_and_unexpected_status() {
        let destination=tokio::net::TcpListener::bind(("127.0.0.1",0)).await.unwrap();
        let location=format!("Location: http://{}/forbidden\r\n",destination.local_addr().unwrap());
        let (endpoint,server)=fixture(302,Vec::new(),&location).await;
        assert_eq!(fetch_github_resource(endpoint).await.unwrap_err(),GITHUB_RESOURCE_UNAVAILABLE);server.await.unwrap();
        assert!(tokio::time::timeout(std::time::Duration::from_millis(100),destination.accept()).await.is_err());
        for status in [401,403,404,500] {let (endpoint,server)=fixture(status,b"must_not_escape".to_vec(),"").await;
            assert_eq!(fetch_github_resource(endpoint).await.unwrap_err(),GITHUB_RESOURCE_UNAVAILABLE);server.await.unwrap();}
    }
    #[tokio::test]
    async fn github_resource_transport_bounds_declared_and_streamed_bytes() {
        let mut at_limit=dto().to_string().into_bytes();at_limit.resize(GITHUB_RESOURCE_MAX_BYTES,b' ');
        let (endpoint,server)=fixture(200,at_limit.clone(),"").await;assert_eq!(fetch_github_resource(endpoint).await.unwrap(),dto());server.await.unwrap();
        at_limit.push(b' ');let (endpoint,server)=fixture(200,at_limit,"").await;
        assert_eq!(fetch_github_resource(endpoint).await.unwrap_err(),GITHUB_RESOURCE_UNAVAILABLE);server.await.unwrap();
        let (endpoint,server)=fixture(200,dto().to_string().into_bytes(),&format!("Content-Length: {}\r\n",GITHUB_RESOURCE_MAX_BYTES+1)).await;
        assert_eq!(fetch_github_resource(endpoint).await.unwrap_err(),GITHUB_RESOURCE_UNAVAILABLE);server.await.unwrap();
    }
}

#[cfg(test)]
mod video_post_wire_tests {
    use super::*;
    #[test]
    fn bounded_video_post_wire() {
        let (method,path,body)=action_request("video_post_create",Some("video-1"),None,None,Some(&serde_json::json!({"body":" 感想 ","audience":"followers"}))).unwrap();
        assert_eq!(method,reqwest::Method::POST);assert_eq!(path,"/api/client/videos/video-1/posts");assert_eq!(body,serde_json::json!({"body":"感想","audience":"followers"}));
        assert!(action_request("video_post_create",Some("video-1"),None,None,Some(&serde_json::json!({"body":""}))).is_err());
        let (_,_,comment)=action_request("video_post_create",Some("video-1"),None,None,Some(&serde_json::json!({"body":"x","inFeed":true,"parentPostId":"c-1","playbackSeconds":61}))).unwrap();assert_eq!(comment,serde_json::json!({"body":"x","inFeed":true,"parentPostId":"c-1","playbackSeconds":61}));
        for value in [serde_json::json!({"body":"x","inFeed":"yes"}),serde_json::json!({"body":"x","parentPostId":"../c"}),serde_json::json!({"body":"x","parentPostId":3}),serde_json::json!({"body":"x","playbackSeconds":-1}),serde_json::json!({"body":"x","playbackSeconds":604801})] {assert!(video_post_action(Some("video"),Some(&value)).is_err());}
        for body in ["😀".repeat(500),"a".repeat(500)] {assert!(video_post_action(Some("video"),Some(&serde_json::json!({"body":body}))).is_ok());}
        assert!(video_post_action(Some("video"),Some(&serde_json::json!({"body":"a".repeat(501)}))).is_err());
        for value in [serde_json::json!({"body":"x","actor":"o"}),serde_json::json!({"body":null}),serde_json::json!({}),serde_json::json!({"body":"x","audience":"secret"}),serde_json::json!({"body":"x","audience":3})] {assert!(video_post_action(Some("video"),Some(&value)).is_err());}
        for target in ["../video","video?x=1","video/other"," video ",""] {assert!(video_post_action(Some(target),Some(&serde_json::json!({"body":"x"}))).is_err());}
        assert!(action_request("video_post_create",Some("video"),Some("override"),None,Some(&serde_json::json!({"body":"x"}))).is_err());
        assert!(action_request("video_post_create",Some("video"),None,Some("req"),Some(&serde_json::json!({"body":"x"}))).is_err());
        let (template,viewer)=detail_path("video_posts").unwrap();assert!(viewer);assert_eq!(fill_path(template,&["video-1".into()]).unwrap(),"/api/client/videos/video-1/posts");
        assert!(fill_path(template,&["../video".into()]).is_err());assert!(fill_path(template,&["video".into(),"extra".into()]).is_err());
        let (page,viewer)=detail_path("video_posts_page").unwrap();assert!(viewer);
        assert_eq!(fill_path(page,&["video-1".into(),"abc.DEF_1-2~:|=".into()]).unwrap(),"/api/client/videos/video-1/posts?cursor=abc.DEF_1-2%7E%3A%7C%3D");
        for cursor in ["","a&b=1","a b","a/b","%41","x".repeat(257).as_str()] {assert!(fill_path(page,&["video-1".into(),cursor.into()]).is_err());}
        assert!(fill_path(page,&["video-1".into()]).is_err());
    }
}

#[cfg(test)]
mod music_post_wire_tests {
    use super::*;
    #[test]
    fn bounded_music_post_wire() {
        let id="music:00000000-0000-4000-8000-000000000000";
        let (method,path,body)=action_request("music_post_create",Some(id),None,None,Some(&serde_json::json!({"body":" 感想 ","audience":"followers"}))).unwrap();
        assert_eq!(method,reqwest::Method::POST);assert_eq!(path,"/api/client/music/works/music%3A00000000-0000-4000-8000-000000000000/posts");assert_eq!(body,serde_json::json!({"body":"感想","audience":"followers"}));
        let (_,path,repost)=action_request("music_post_create",Some("work-1"),None,None,Some(&serde_json::json!({"body":""}))).unwrap();assert_eq!(repost,serde_json::json!({"body":""}));assert_eq!(path,"/api/client/music/works/work-1/posts");
        for body in ["😀".repeat(500),"a".repeat(500)] {assert!(music_post_action(Some("w"),Some(&serde_json::json!({"body":body}))).is_ok());}
        assert!(music_post_action(Some("w"),Some(&serde_json::json!({"body":"a".repeat(501)}))).is_err());
        for value in [serde_json::json!({"body":"x","actor":"o"}),serde_json::json!({"body":null}),serde_json::json!({}),serde_json::json!({"body":"x","audience":"secret"}),serde_json::json!({"body":"x","audience":3})] {assert!(music_post_action(Some("w"),Some(&value)).is_err());}
        for target in ["../w","w?x=1","w/other"," w ","","music:bad"] {assert!(music_post_action(Some(target),Some(&serde_json::json!({"body":"x"}))).is_err());}
        assert!(action_request("music_post_create",Some("w"),Some("override"),None,Some(&serde_json::json!({"body":"x"}))).is_err());
        assert!(action_request("music_post_create",Some("w"),None,Some("req"),Some(&serde_json::json!({"body":"x"}))).is_err());
        let (template,viewer)=detail_path("music_posts").unwrap();assert!(viewer);assert_eq!(fill_path(template,&[id.into()]).unwrap(),"/api/client/music/works/music%3A00000000-0000-4000-8000-000000000000/posts");
        assert!(fill_path(template,&["../w".into()]).is_err());assert!(fill_path(template,&["w".into(),"extra".into()]).is_err());
        let (page,viewer)=detail_path("music_posts_page").unwrap();assert!(viewer);
        assert_eq!(fill_path(page,&["w1".into(),"abc.DEF_1-2~:|=".into()]).unwrap(),"/api/client/music/works/w1/posts?cursor=abc.DEF_1-2%7E%3A%7C%3D");
        for cursor in ["","a&b=1","a b","a/b","%41","x".repeat(257).as_str()] {assert!(fill_path(page,&["w1".into(),cursor.into()]).is_err());}
        assert!(fill_path(page,&["w1".into()]).is_err());
    }
}

#[cfg(test)]
mod video_engagement_wire_tests {
    use super::*;
    #[test]
    fn engagement_and_channel_paths_are_bounded() {
        let (t,viewer)=detail_path("video_engagement").unwrap();assert!(viewer);
        assert_eq!(fill_path(t,&["video-1".into()]).unwrap(),"/api/client/videos/video-1/engagement");
        for bad in ["../v","v/x","v?x","","a b"] {assert!(fill_path(t,&[bad.into()]).is_err(),"{bad}");}
        assert!(fill_path(t,&["v".into(),"x".into()]).is_err());
        let (c,viewer)=detail_path("video_channel").unwrap();assert!(viewer);
        assert_eq!(fill_path(c,&["ab_c.d-1".into()]).unwrap(),"/api/client/videos/channels/ab_c.d-1");
        let long="x".repeat(65);
        for bad in ["","a/b","a?b","a b","%41","日本",long.as_str()] {assert!(fill_path(c,&[bad.into()]).is_err(),"{bad}");}
        assert!(fill_path(c,&["a".into(),"b".into()]).is_err());
        let (p,viewer)=detail_path("video_channel_page").unwrap();assert!(viewer);
        assert_eq!(fill_path(p,&["h1".into(),"abc-DEF_12==".into()]).unwrap(),"/api/client/videos/channels/h1?cursor=abc-DEF_12==");
        let longc="x".repeat(257);
        for cursor in ["","a&b=1","a b","a/b","%41","a.b",longc.as_str()] {assert!(fill_path(p,&["h1".into(),cursor.into()]).is_err(),"{cursor}");}
        assert!(fill_path(p,&["h1".into()]).is_err());
    }
    #[test]
    fn like_verbs_map_to_engagement() {
        let (m,path,body)=action_request("like_video",Some("video-1"),None,None,None).unwrap();
        assert_eq!(m,reqwest::Method::POST);assert_eq!(path,"/api/client/videos/video-1/engagement");assert_eq!(body,serde_json::json!({}));
        let (m,_,_)=action_request("unlike_video",Some("video-1"),None,None,None).unwrap();assert_eq!(m,reqwest::Method::DELETE);
        assert!(action_request("like_video",Some("../v"),None,None,None).is_err());
        assert!(action_request("like_video",None,None,None,None).is_err());
        assert!(action_request("like_video",Some("v"),Some("t"),None,None).is_err());
        assert!(action_request("like_video",Some("v"),None,None,Some(&serde_json::json!({"x":1}))).is_err());
    }
}
