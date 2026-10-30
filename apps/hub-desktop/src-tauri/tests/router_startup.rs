use hub_local_runner::{router, RunnerState};
use std::sync::Arc;

#[tokio::test]
async fn full_http_router_can_be_constructed() {
    let _ = router(Arc::new(RunnerState::new().unwrap()));
}
