// Bounded polling shared with deterministic tests. Failed reads consume the
// same deadline as successful PENDING reads.
export async function pollSignRequest({ read, deadline, onPending = () => {}, onRetry = () => {}, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (!Number.isFinite(deadline)) throw new Error("Invalid signature request deadline");
  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("Signature request timed out; check its page before retrying any transaction.");
    await sleep(Math.min(3000, remaining));
    const budget = deadline - now();
    if (budget <= 0) continue;
    let result;
    try {
      result = await read(AbortSignal.timeout(Math.min(10_000, budget)));
    } catch (error) {
      if (error.status && error.status < 500) throw error;
      onRetry(error);
      continue;
    }
    const item = result.item ?? result;
    if (item.status !== "PENDING") return item;
    onPending(item);
  }
}
