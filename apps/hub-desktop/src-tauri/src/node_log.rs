use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// このノードが出した出来事の連なり。
///
/// Personal Node は公開原本を持つ側で、出したものを**追記だけの連鎖**として
/// 積む。ゲートウェイは `sequence` が前+1、`previousHash` が前の hash と
/// 一致することを確かめる（`apps/federation/src/personal-node.ts`）。
/// 途中を差し替えると連鎖が切れるので、後から静かに書き換えられない。
///
/// **正規化は相手と1バイトも違えられない。** 署名は `canonicalJson(event)` の
/// 上に載る。並び順や空白が違えば、同じ中身でも別の文字列になり、署名は
/// 通らない。相手の実装はこう:
///
/// ```js
/// if (value === null || typeof value !== "object") return JSON.stringify(value);
/// if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
/// return `{${Object.keys(object).sort().map((key) =>
///   `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
/// ```

/// 相手の `canonicalJson` と同じ文字列を作る。
///
/// キーは名前で昇順、区切りに空白を入れない。`serde_json` の既定は挿入順
/// なので、そのままでは合わない。
pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let body = keys
                .iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        Value::String((*key).clone()),
                        canonical_json(&map[*key])
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{body}}}")
        }
        Value::Array(items) => {
            format!(
                "[{}]",
                items
                    .iter()
                    .map(canonical_json)
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        other => other.to_string(),
    }
}

/// 出来事の hash。相手は16進の小文字で持つ。
pub fn event_hash(event: &Value) -> String {
    Sha256::digest(canonical_json(event).as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// 次の出来事を組む。
///
/// 連鎖の位置は呼び出し側が持つ。**ここで勝手に採番しない**——同じ番号を
/// 二度出すと、ゲートウェイはどちらか一方しか受け取らず、落ちたほうは
/// 黙って消える。
pub fn build_event(
    id: &str,
    kind: &str,
    sequence: u64,
    previous_hash: Option<&str>,
    payload: Value,
    created_at: &str,
) -> Value {
    let mut event = Map::new();
    event.insert("id".into(), Value::String(id.to_owned()));
    event.insert("type".into(), Value::String(kind.to_owned()));
    event.insert("sequence".into(), Value::Number(sequence.into()));
    // 先頭には previousHash を入れない。受信側の portableEvent() は null を
    // 正規化時に省くため、こちらだけ null を署名対象へ入れると検証に失敗する。
    if let Some(hash) = previous_hash {
        event.insert("previousHash".into(), Value::String(hash.to_owned()));
    }
    event.insert("payload".into(), payload);
    event.insert("createdAt".into(), Value::String(created_at.to_owned()));
    Value::Object(event)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keys_are_sorted_and_nothing_is_padded() {
        // 相手の canonicalJson と同じ文字列でなければ署名は通らない。
        let value = json!({ "b": 1, "a": 2, "c": { "z": 1, "y": [3, 2, 1] } });
        assert_eq!(
            canonical_json(&value),
            r#"{"a":2,"b":1,"c":{"y":[3,2,1],"z":1}}"#
        );
    }

    #[test]
    fn the_shape_does_not_change_with_insertion_order() {
        // serde_json の既定は挿入順。そのままでは、同じ中身が別の文字列になる。
        let one: Value = serde_json::from_str(r#"{"a":1,"b":2}"#).unwrap();
        let other: Value = serde_json::from_str(r#"{"b":2,"a":1}"#).unwrap();
        assert_eq!(canonical_json(&one), canonical_json(&other));
        assert_eq!(event_hash(&one), event_hash(&other));
    }

    #[test]
    fn strings_are_escaped_the_same_way() {
        // 日本語も記号も、相手の JSON.stringify と同じでなければならない。
        let value = json!({ "本文": "改行\nと\"引用\"とバックスラッシュ\\" });
        assert_eq!(
            canonical_json(&value),
            r#"{"本文":"改行\nと\"引用\"とバックスラッシュ\\"}"#
        );
    }

    #[test]
    fn the_first_event_omits_the_absent_previous_hash_like_the_gateway() {
        let first = build_event(
            "event-1",
            "post.created",
            1,
            None,
            json!({ "id": "p1" }),
            "2026-08-28T00:00:00.000Z",
        );
        assert!(first.get("previousHash").is_none());
        assert!(!canonical_json(&first).contains("previousHash"));
    }

    #[test]
    fn the_chain_moves_forward_one_at_a_time() {
        let first = build_event(
            "event-1",
            "post.created",
            1,
            None,
            json!({ "id": "p1" }),
            "2026-08-28T00:00:00.000Z",
        );
        let second = build_event(
            "event-2",
            "post.created",
            2,
            Some(&event_hash(&first)),
            json!({ "id": "p2" }),
            "2026-08-28T00:00:01.000Z",
        );
        assert_eq!(second["sequence"], 2);
        assert_eq!(second["previousHash"], Value::String(event_hash(&first)));
        // 中身を1文字変えれば hash は変わる。後から静かに差し替えられない。
        let tampered = build_event(
            "event-1",
            "post.created",
            1,
            None,
            json!({ "id": "p1!" }),
            "2026-08-28T00:00:00.000Z",
        );
        assert_ne!(event_hash(&tampered), event_hash(&first));
    }

    /// 相手の実装と突き合わせるための材料を出す。
    ///   cargo test emit_canonical_material -- --ignored --nocapture
    #[test]
    #[ignore]
    fn emit_canonical_material() {
        let cases = json!([
            { "b": 1, "a": 2, "c": { "z": 1, "y": [3, 2, 1] } },
            { "本文": "改行\nと\"引用\"とバックスラッシュ\\", "数": 0 },
            build_event("event-1", "post.created", 1, None, json!({ "id": "p1", "body": "はじめまして" }), "2026-08-28T00:00:00.000Z"),
            build_event("event-2", "post.created", 2, Some("abc123"), json!({ "id": "p2", "tags": [] }), "2026-08-28T00:00:01.000Z")
        ]);
        let rendered: Vec<Value> = cases
            .as_array()
            .unwrap()
            .iter()
            .map(|case| json!({ "value": case, "canonical": canonical_json(case), "hash": event_hash(case) }))
            .collect();
        println!("{}", Value::Array(rendered));
    }
}
