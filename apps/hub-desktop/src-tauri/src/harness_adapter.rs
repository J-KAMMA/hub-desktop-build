use serde::{Deserialize, Serialize};

pub const ADAPTER_PROTOCOL_VERSION: &str = "1.0";

/// What Hub knows about an existing harness connection.
///
/// Hub owns approval, observation and recovery. The connected provider keeps
/// ownership of its agent loop, tool selection and provider-specific context.
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessAdapterContract {
    pub id: String,
    pub label: String,
    pub protocol_version: String,
    pub transport: String,
    pub execution_authority: String,
    pub approval_mode: String,
    pub connection_state: String,
    pub capabilities: Vec<String>,
    pub provider_owns: Vec<String>,
}

impl HarnessAdapterContract {
    pub fn process(
        id: &str,
        label: &str,
        proposal_only: bool,
        can_resume: bool,
        available: bool,
    ) -> Self {
        let mut capabilities = if proposal_only {
            vec!["proposal".into(), "streaming".into(), "cancel".into()]
        } else {
            vec![
                "workspace_read".into(),
                "workspace_write".into(),
                "shell".into(),
                "streaming".into(),
                "cancel".into(),
                "verification".into(),
                "artifacts".into(),
            ]
        };
        if can_resume {
            capabilities.push("resume".into());
        }
        Self {
            id: format!("{id}.stdio"),
            label: label.into(),
            protocol_version: ADAPTER_PROTOCOL_VERSION.into(),
            transport: "stdio_jsonl".into(),
            execution_authority: "provider_harness".into(),
            approval_mode: if proposal_only {
                "hub_preflight_no_tools"
            } else {
                "hub_preflight_provider_boundary"
            }
            .into(),
            connection_state: if available {
                "connected"
            } else {
                "unavailable"
            }
            .into(),
            capabilities,
            provider_owns: vec![
                "agent_loop".into(),
                "tool_selection".into(),
                "provider_context".into(),
                "provider_retries".into(),
            ],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coding_adapter_declares_provider_as_execution_authority() {
        let adapter = HarnessAdapterContract::process("codex", "Codex", false, true, true);
        assert_eq!(adapter.execution_authority, "provider_harness");
        assert_eq!(adapter.connection_state, "connected");
        assert!(adapter.capabilities.contains(&"workspace_write".into()));
        assert!(adapter.capabilities.contains(&"resume".into()));
        assert!(adapter.provider_owns.contains(&"agent_loop".into()));
    }

    #[test]
    fn proposal_adapter_cannot_claim_workspace_execution() {
        let adapter = HarnessAdapterContract::process("claude", "Claude", true, true, true);
        assert_eq!(adapter.approval_mode, "hub_preflight_no_tools");
        assert!(adapter.capabilities.contains(&"proposal".into()));
        assert!(!adapter.capabilities.contains(&"workspace_write".into()));
        assert!(!adapter.capabilities.contains(&"shell".into()));
    }
}
