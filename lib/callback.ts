export async function deliverCallback(
  callbackUrl: string,
  payload: { correlationId: string; value: string },
  attempts = 2
): Promise<void> {
  const effectiveAttempts = Math.max(1, Math.floor(attempts));
  for (let i = 0; i < effectiveAttempts; i++) {
    try {
      const res = await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) return;
    } catch {
      // Network error - fall through and retry (or give up on the last attempt).
    }
  }
  // Best-effort only: the reply is already durably stored and recoverable via polling.
  try {
    console.warn(
      `Failed to deliver callback after ${effectiveAttempts} attempts`,
      { callbackUrl, correlationId: payload.correlationId }
    );
  } catch {
    // Silence any logging failure - deliverCallback must never throw under any circumstance
  }
}
