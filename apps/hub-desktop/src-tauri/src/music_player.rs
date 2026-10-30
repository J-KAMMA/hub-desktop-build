/// ハブの音楽を鳴らす側。
///
/// 取りに行くのは Rust。公開トラック一覧と音声は `GET /music/api/...` に公開
/// されており（公開・クリーン・再生可能なものだけをワーカーが出す）、assertion は
/// 要らない。窓の JS は外へ出られないので、音声もここで取って IPC の生バイトで
/// 渡し、窓では blob: の <audio> にだけ載る。宛先を1つに絞ったまま、楽曲IDは
/// UUID の形だけを受けてパスに載せる。

/// 音声の上限。公開トラックは数十MBまであり得るが、それを超える応答は切る。
const MAX_AUDIO_BYTES: u64 = 64 * 1024 * 1024;
/// 一覧・画像の上限。
const MAX_BYTES: usize = 4 * 1024 * 1024;

/// パスに載せてよいトラックIDの形。これ以外は呼び出しの時点で捨てる。
fn track_id(value: &str) -> Option<&str> {
    let ok = value.len() == 36
        && value
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c == '-');
    ok.then_some(value)
}

fn client(seconds: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(seconds))
        .build()
        .map_err(|_| "取りに行けません".to_owned())
}

fn map_send(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "ハブが応答しません".to_owned()
    } else if error.is_connect() {
        "ハブへ接続できません".to_owned()
    } else {
        "ハブへ届きません".to_owned()
    }
}

async fn check_ok(response: reqwest::Response) -> Result<reqwest::Response, String> {
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("見つかりませんでした".to_owned());
    }
    if !response.status().is_success() {
        return Err(format!(
            "ハブが {} を返しています",
            response.status().as_u16()
        ));
    }
    Ok(response)
}

/// 公開トラック一覧。公開・クリーン・再生可能なものだけがワーカーから来る。
pub async fn tracks(base: &str, query: &str, offset: u32) -> Result<serde_json::Value, String> {
    let query = query.trim();
    if query.encode_utf16().count() > 100 || query.split_whitespace().count() > 8 {
        return Err("検索語は100文字・8語以内で指定してください".to_owned());
    }
    let mut url = reqwest::Url::parse(&format!("{}/music/api/tracks", base.trim_end_matches('/')))
        .map_err(|_| "接続先が正しくありません".to_owned())?;
    url.query_pairs_mut().append_pair("q", query).append_pair("limit", "50").append_pair("offset", &offset.to_string());
    let response = check_ok(client(12)?.get(url).send().await.map_err(map_send)?).await?;
    let bytes = response.bytes().await.map_err(|_| "読み取れませんでした".to_owned())?;
    if bytes.len() > MAX_BYTES {
        return Err("応答が大きすぎます".to_owned());
    }
    serde_json::from_slice::<serde_json::Value>(&bytes).map_err(|_| "読み取れませんでした".to_owned())
}

/// トラックの音声。バイト列をそのまま IPC で返し、窓は blob: の <audio> に乗せる。
/// Content-Length が上限超えなら読まずに捨てる。
pub async fn audio(base: &str, id: &str) -> Result<Vec<u8>, String> {
    let id = track_id(id).ok_or_else(|| "トラックIDが不正です".to_owned())?;
    let url = format!("{}/music/api/tracks/{}/audio", base.trim_end_matches('/'), id);
    let response = check_ok(client(60)?.get(&url).send().await.map_err(map_send)?).await?;
    if response.content_length().unwrap_or(0) > MAX_AUDIO_BYTES {
        return Err("音声が大きすぎます".to_owned());
    }
    let bytes = response.bytes().await.map_err(|_| "読み取れませんでした".to_owned())?;
    if bytes.len() as u64 > MAX_AUDIO_BYTES {
        return Err("音声が大きすぎます".to_owned());
    }
    Ok(bytes.to_vec())
}

/// トラックのアートワーク。クリーンなものだけワーカーが返す。
pub async fn artwork(base: &str, id: &str) -> Result<Vec<u8>, String> {
    let id = track_id(id).ok_or_else(|| "トラックIDが不正です".to_owned())?;
    let url = format!("{}/music/api/tracks/{}/artwork", base.trim_end_matches('/'), id);
    let response = check_ok(client(12)?.get(&url).send().await.map_err(map_send)?).await?;
    let bytes = response.bytes().await.map_err(|_| "読み取れませんでした".to_owned())?;
    if bytes.len() > MAX_BYTES {
        return Err("画像が大きすぎます".to_owned());
    }
    Ok(bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use super::track_id;

    #[test]
    fn track_id_accepts_uuid_shape() {
        assert!(track_id("0f8fad5b-d9cb-469f-a165-70867728950c").is_some());
        assert!(track_id("").is_none());
        assert!(track_id("../etc").is_none());
        assert!(track_id("0f8fad5bd9cb469fa16570867728950c/extra").is_none());
        assert!(track_id(&"a".repeat(37)).is_none());
    }
}
