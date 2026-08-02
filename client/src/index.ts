export interface GatewayClientOptions {
  baseUrl: string;
  apiKey: string;
}

export interface SendOptions {
  correlationId?: string;
  callbackUrl?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export class GatewayError extends Error {}

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function createClient(options: GatewayClientOptions) {
  async function send(body: Record<string, unknown>): Promise<{ correlationId: string }> {
    const res = await fetch(`${options.baseUrl}/api/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new GatewayError(data.error ?? `send failed (${res.status})`);
    return data;
  }

  async function pollReply(
    correlationId: string,
    pollIntervalMs: number,
    timeoutMs: number
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      const res = await fetch(`${options.baseUrl}/api/replies/${correlationId}`, {
        headers: { Authorization: `Bearer ${options.apiKey}` },
      });
      if (!res.ok) {
        throw new GatewayError(`poll failed (${res.status})`);
      }
      const data = await res.json();
      if (data.status === "replied") return data.value;
    }
    throw new GatewayError(`timed out waiting for reply to ${correlationId}`);
  }

  async function sendNotification(text: string): Promise<void> {
    await send({ type: "notification", text });
  }

  async function sendApproval(text: string, opts: SendOptions = {}): Promise<boolean> {
    if (opts.callbackUrl) {
      throw new GatewayError(
        "sendApproval polls for its result and can't also be given a callbackUrl - " +
          "register your own route and call the raw send API if you want callback delivery"
      );
    }
    const { correlationId } = await send({
      type: "approval",
      text,
      correlationId: opts.correlationId,
    });
    const value = await pollReply(
      correlationId,
      opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    return value === "approve";
  }

  async function sendPrompt(text: string, opts: SendOptions = {}): Promise<string> {
    if (opts.callbackUrl) {
      throw new GatewayError(
        "sendPrompt polls for its result and can't also be given a callbackUrl - " +
          "register your own route and call the raw send API if you want callback delivery"
      );
    }
    const { correlationId } = await send({
      type: "prompt",
      text,
      correlationId: opts.correlationId,
    });
    return pollReply(
      correlationId,
      opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
  }

  return { sendNotification, sendApproval, sendPrompt };
}
