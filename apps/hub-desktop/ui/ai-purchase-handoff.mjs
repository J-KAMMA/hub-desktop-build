// hub_pay is a proposal. Approving it in the Desktop opens the buyer's own
// product/checkout screen; nothing here pays, signs or creates an order, and
// the outcome sent back to the model says only that the screen was opened.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/// The strictly validated proposal from an action's detail, or null.
export function purchaseProposal(action) {
  const { productId, quantity } = action?.detail ?? {};
  if (action?.tool !== "hub_pay" || typeof productId !== "string" || !UUID.test(productId)
    || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 20) return null;
  return { productId, quantity };
}

/// Resolves to the decision to send: approve with the honest handoff record
/// only after the product screen opened, otherwise deny (fail closed).
export async function resolvePurchaseHandoff(action, openCheckout) {
  const proposal = purchaseProposal(action);
  if (!proposal || typeof openCheckout !== "function") return { approve: false, error: "purchase_proposal_invalid" };
  try { if ((await openCheckout(proposal)) !== true) throw new Error("closed"); }
  catch { return { approve: false, error: "purchase_handoff_failed" }; }
  return { approve: true, outcome: { status: "handed_to_checkout", productId: proposal.productId, quantity: proposal.quantity } };
}
