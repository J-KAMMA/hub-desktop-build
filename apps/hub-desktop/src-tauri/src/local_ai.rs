use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

const OLLAMA: &str = "http://127.0.0.1:11434";
// Common defaults: LM Studio, Jan, GPT4All, KoboldCpp, vLLM/ChatGLM.cpp,
// llama.cpp/LocalAI/ModelScope SWIFT, and Xinference.
const OPENAI_COMPATIBLE_PORTS: &[u16] = &[1234, 1337, 4891, 5001, 8000, 8080, 9997];

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModel {
    pub id: String,
    pub name: String,
    pub runtime: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalChatRequest {
    pub runtime: String,
    pub model: String,
    pub prompt: String,
    #[serde(default)]
    pub policy: LocalExecutionPolicy,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalExecutionPolicy {
    pub mode: String,
    pub allow_web: bool,
    pub allow_hub_read: bool,
    pub allow_hub_write: bool,
    pub allow_file_read: bool,
    pub allow_file_write: bool,
    pub allow_code_execution: bool,
    pub allow_purchase: bool,
    pub maximum_cost_usd: f64,
}
impl Default for LocalExecutionPolicy {
    fn default() -> Self {
        Self {
            mode: "local_only".into(),
            allow_web: false,
            allow_hub_read: false,
            allow_hub_write: false,
            allow_file_read: false,
            allow_file_write: false,
            allow_code_execution: false,
            allow_purchase: false,
            maximum_cost_usd: 0.0,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalChatResponse {
    pub output: String,
    pub model: String,
    pub runtime: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalOrchestrationRequest {
    pub models: Vec<LocalModel>,
    pub prompt: String,
    pub organization: Option<LocalOrganization>,
    #[serde(default)]
    pub policy: LocalExecutionPolicy,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalOrganization {
    pub name: String,
    pub objective: String,
    pub mode: String,
    pub roles: Vec<LocalOrganizationRole>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalOrganizationRole {
    pub id: String,
    pub name: String,
    pub responsibility: String,
    pub provider_id: String,
    pub reports_to_id: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalOrchestrationResponse {
    pub output: String,
    pub stages: Vec<LocalOrchestrationStage>,
    pub artifacts: Vec<LocalRoleArtifact>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalOrchestrationStage {
    pub id: String,
    pub label: String,
    pub model: String,
    pub runtime: String,
    pub duration_ms: u128,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRoleArtifact {
    pub id: String,
    pub role_id: String,
    pub role_name: String,
    pub summary: String,
}

pub async fn models() -> Vec<LocalModel> {
    let client = client();
    let mut models = Vec::new();
    if let Ok(response) = client.get(format!("{OLLAMA}/api/tags")).send().await {
        if let Ok(body) = response.json::<Value>().await {
            if let Some(items) = body.get("models").and_then(Value::as_array) {
                for item in items {
                    if let Some(name) = item
                        .get("name")
                        .and_then(Value::as_str)
                        .filter(|name| valid_model(name))
                    {
                        models.push(LocalModel {
                            id: name.into(),
                            name: name.into(),
                            runtime: "ollama".into(),
                        });
                    }
                }
            }
        }
    }
    for port in configured_openai_ports() {
        let base = format!("http://127.0.0.1:{port}");
        if let Ok(response) = client.get(format!("{base}/v1/models")).send().await {
            if let Ok(body) = response.json::<Value>().await {
                if let Some(items) = body.get("data").and_then(Value::as_array) {
                    for item in items {
                        if let Some(id) = item
                            .get("id")
                            .and_then(Value::as_str)
                            .filter(|id| valid_model(id))
                        {
                            models.push(LocalModel {
                                id: id.into(),
                                name: id.into(),
                                runtime: format!("openai:{port}"),
                            });
                        }
                    }
                }
            }
        }
    }
    models.sort_by(|left, right| {
        left.runtime
            .cmp(&right.runtime)
            .then(left.name.cmp(&right.name))
    });
    models.dedup_by(|left, right| left.runtime == right.runtime && left.id == right.id);
    models.truncate(200);
    models
}

pub async fn chat(input: LocalChatRequest) -> Result<LocalChatResponse, &'static str> {
    if input.prompt.is_empty()
        || input.prompt.chars().count() > 8_000
        || !valid_model(&input.model)
        || !valid_policy(&input.policy)
    {
        return Err("invalid_request");
    }
    let (endpoint, payload, ollama) = if input.runtime == "ollama" {
        (
            format!("{OLLAMA}/api/chat"),
            json!({"model": input.model, "stream": false, "messages": [{"role":"user","content":input.prompt}]}),
            true,
        )
    } else {
        let port = openai_port(&input.runtime).ok_or("invalid_request")?;
        (
            format!("http://127.0.0.1:{port}/v1/chat/completions"),
            json!({"model": input.model, "stream": false, "messages": [{"role":"user","content":input.prompt}]}),
            false,
        )
    };
    let response = client()
        .post(endpoint)
        .json(&payload)
        .send()
        .await
        .map_err(|_| "runtime_unavailable")?;
    if !response.status().is_success() {
        return Err("runtime_failed");
    }
    let body = response
        .json::<Value>()
        .await
        .map_err(|_| "invalid_response")?;
    let output = if ollama {
        body.pointer("/message/content")
    } else {
        body.pointer("/choices/0/message/content")
    }
    .and_then(Value::as_str)
    .filter(|value| value.len() <= 2_000_000)
    .ok_or("invalid_response")?;
    Ok(LocalChatResponse {
        output: output.into(),
        model: input.model,
        runtime: input.runtime,
    })
}

pub async fn orchestrate(
    input: LocalOrchestrationRequest,
) -> Result<LocalOrchestrationResponse, &'static str> {
    if input.models.is_empty()
        || input.models.len() > 3
        || input.prompt.is_empty()
        || input.prompt.chars().count() > 8_000
        || !valid_policy(&input.policy)
    {
        return Err("invalid_request");
    }
    if input.models.iter().any(|model| {
        !valid_model(&model.id)
            || (model.runtime != "ollama" && openai_port(&model.runtime).is_none())
    }) {
        return Err("invalid_request");
    }
    let definitions: Vec<(String, String, String)> = if let Some(organization) = input.organization
    {
        if organization.roles.is_empty()
            || organization.roles.len() > 12
            || !matches!(organization.mode.as_str(), "sequential" | "parallel")
            || !valid_text(&organization.name, 80)
            || !valid_text(&organization.objective, 2000)
        {
            return Err("invalid_request");
        }
        if organization.roles.iter().any(|role| {
            !valid_text(&role.id, 80)
                || !valid_text(&role.name, 60)
                || !valid_text(&role.responsibility, 500)
                || !valid_text(&role.provider_id, 200)
                || !role.provider_id.starts_with("local:")
                || role
                    .reports_to_id
                    .as_ref()
                    .is_some_and(|value| !valid_text(value, 80))
        }) {
            return Err("invalid_request");
        }
        organization
            .roles
            .into_iter()
            .map(|role| {
                (
                    role.id,
                    format!(
                        "役職: {}\n責任範囲: {}\n組織の目的に対する担当成果を作成してください。",
                        role.name, role.responsibility
                    ),
                    role.provider_id,
                )
            })
            .collect()
    } else {
        vec![
            (
                "plan".into(),
                "依頼を完了条件、制約、実行手順に分解してください。".into(),
                "local:auto".into(),
            ),
            (
                "solve".into(),
                "計画に従い、具体的な回答案または成果物を作ってください。".into(),
                "local:auto".into(),
            ),
            (
                "challenge".into(),
                "回答案の誤り、抜け、危険な仮定を指摘し、修正案を示してください。".into(),
                "local:auto".into(),
            ),
            (
                "verify".into(),
                "依頼と各工程を照合し、完了条件ごとに合否を判定してください。".into(),
                "local:auto".into(),
            ),
        ]
    };
    let mut context = String::new();
    let mut stages = Vec::new();
    let mut artifacts = Vec::new();
    for (index, (id, instruction, provider_id)) in definitions.iter().enumerate() {
        let model = provider_id
            .strip_prefix("local:")
            .and_then(|key| {
                input
                    .models
                    .iter()
                    .find(|candidate| format!("{}:{}", candidate.runtime, candidate.id) == key)
            })
            .cloned()
            .unwrap_or_else(|| input.models[index % input.models.len()].clone());
        let prompt = trim_chars(&format!("あなたはPC内だけで動くAIチームです。外部サービスを利用しないでください。\n\n担当: {id}\n{instruction}\n\n依頼:\n{}\n\n前工程:\n{}", input.prompt, context), 8_000);
        let started = std::time::Instant::now();
        let response = chat(LocalChatRequest {
            runtime: model.runtime.clone(),
            model: model.id.clone(),
            prompt,
            policy: input.policy.clone(),
        })
        .await?;
        let summary = trim_chars(&response.output, 1_200);
        context = trim_chars(&format!("{}\n\n[{}]\n{}", context, id, summary), 6_000);
        artifacts.push(LocalRoleArtifact {
            id: uuid::Uuid::new_v4().to_string(),
            role_id: id.clone(),
            role_name: instruction
                .lines()
                .next()
                .unwrap_or(id)
                .replace("役職: ", ""),
            summary,
        });
        stages.push(LocalOrchestrationStage {
            id: id.clone(),
            label: instruction
                .lines()
                .next()
                .unwrap_or(id)
                .replace("役職: ", ""),
            model: model.name,
            runtime: model.runtime,
            duration_ms: started.elapsed().as_millis(),
        });
    }
    let final_model = input.models[0].clone();
    let started = std::time::Instant::now();
    let final_prompt=trim_chars(&format!("PC内AI組織の統括として、以下の役職別成果を検証し、依頼への最終回答だけを作ってください。\n\n依頼:\n{}\n\n成果物:\n{}",input.prompt,context),8_000);
    let final_response = chat(LocalChatRequest {
        runtime: final_model.runtime.clone(),
        model: final_model.id.clone(),
        prompt: final_prompt,
        policy: input.policy.clone(),
    })
    .await?;
    stages.push(LocalOrchestrationStage {
        id: "finalize".into(),
        label: "最終統合".into(),
        model: final_model.name,
        runtime: final_model.runtime,
        duration_ms: started.elapsed().as_millis(),
    });
    Ok(LocalOrchestrationResponse {
        output: final_response.output,
        stages,
        artifacts,
    })
}

fn trim_chars(value: &str, maximum: usize) -> String {
    let count = value.chars().count();
    if count <= maximum {
        return value.to_owned();
    }
    value.chars().skip(count - maximum).collect()
}

fn valid_text(value: &str, maximum: usize) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= maximum
        && !value.chars().any(char::is_control)
}

fn configured_openai_ports() -> Vec<u16> {
    let mut ports = OPENAI_COMPATIBLE_PORTS.to_vec();
    if let Ok(extra) = std::env::var("HUB_LOCAL_AI_OPENAI_PORTS") {
        ports.extend(
            extra
                .split(',')
                .filter_map(|value| value.trim().parse::<u16>().ok())
                .filter(|port| *port > 0),
        );
    }
    ports.sort_unstable();
    ports.dedup();
    ports
}

fn openai_port(runtime: &str) -> Option<u16> {
    let port = runtime.strip_prefix("openai:")?.parse::<u16>().ok()?;
    configured_openai_ports().contains(&port).then_some(port)
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(350))
        .timeout(Duration::from_secs(120))
        .no_proxy()
        .build()
        .expect("fixed local client")
}

fn valid_model(value: &str) -> bool {
    !value.is_empty() && value.len() <= 200 && !value.chars().any(char::is_control)
}

fn valid_policy(policy: &LocalExecutionPolicy) -> bool {
    matches!(policy.mode.as_str(), "local_only" | "local_preferred")
        && policy.maximum_cost_usd.is_finite()
        && (0.0..=1000.0).contains(&policy.maximum_cost_usd)
        && !(policy.mode == "local_only"
            && (policy.allow_web
                || policy.allow_hub_write
                || policy.allow_purchase
                || policy.maximum_cost_usd > 0.0))
        && !(policy.allow_purchase && (!policy.allow_hub_write || policy.maximum_cost_usd <= 0.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_configured_loopback_ports_become_runtimes() {
        assert_eq!(openai_port("openai:1234"), Some(1234));
        assert_eq!(openai_port("openai:9997"), Some(9997));
        assert_eq!(openai_port("openai:443"), None);
        assert_eq!(openai_port("https://example.com"), None);
    }

    #[test]
    fn model_ids_reject_control_characters() {
        assert!(valid_model("model/company-name"));
        assert!(!valid_model("bad\nmodel"));
    }

    #[test]
    fn orchestration_context_is_unicode_safely_bounded() {
        let value = "あ".repeat(9_000);
        assert_eq!(trim_chars(&value, 8_000).chars().count(), 8_000);
    }
    #[test]
    fn local_only_policy_cannot_enable_external_side_effects() {
        assert!(valid_policy(&LocalExecutionPolicy::default()));
        let mut policy = LocalExecutionPolicy::default();
        policy.allow_web = true;
        assert!(!valid_policy(&policy));
        let purchase = LocalExecutionPolicy {
            mode: "local_preferred".into(),
            allow_hub_write: true,
            allow_purchase: true,
            maximum_cost_usd: 1.0,
            ..Default::default()
        };
        assert!(valid_policy(&purchase));
    }
}
