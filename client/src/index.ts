export interface GatewayClientOptions {
  baseUrl: string;
  apiKey: string;
}

export interface FallbackTemplate {
  name: string;
  language: string;
  params?: string[];
}

export interface SendResult {
  correlationId: string;
  messageId?: string;
  viaTemplate?: boolean;
  alsoMessageId?: string;
  alsoNumber?: string;
  alsoWatchError?: string;
  alsoError?: string;
}

export interface MessageStatus {
  messageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  updatedAt: number;
  recipient?: string;
  error?: { code?: number; title?: string; details?: string };
}

export interface InboxMessage {
  id: string;
  type: string;
  text?: string;
  timestamp: number;
  contextMessageId?: string;
}

export interface WindowState {
  open: boolean;
  lastInboundAt: number | null;
  expiresAt: number | null;
}

export interface SendOptions {
  correlationId?: string;
  callbackUrl?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Sends an extra copy to a second recipient, in addition to the gateway's default. Digits-only E.164, no leading "+". */
  also?: string;
}

export interface NotificationOptions extends SendOptions {
  fallbackTemplate?: FallbackTemplate;
}

export class GatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayError";
  }
}

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function createClient(options: GatewayClientOptions) {
  async function send(body: Record<string, unknown>): Promise<SendResult> {
    const res = await fetch(`${options.baseUrl}/api/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new GatewayError(data.error ?? `send failed (${res.status})`);
    if (!data.correlationId) throw new GatewayError("gateway returned an unreadable response");
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
      const res = await fetch(`${options.baseUrl}/api/replies/${encodeURIComponent(correlationId)}`, {
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

  async function sendNotification(text: string, opts: NotificationOptions = {}): Promise<SendResult> {
    return send({ type: "notification", text, also: opts.also, fallbackTemplate: opts.fallbackTemplate });
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
      also: opts.also,
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
      also: opts.also,
    });
    return pollReply(
      correlationId,
      opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
  }

  async function sendSelect(text: string, selectOptions: string[], opts: SendOptions = {}): Promise<string> {
    if (opts.callbackUrl) {
      throw new GatewayError(
        "sendSelect polls for its result and can't also be given a callbackUrl - " +
          "register your own route and call the raw send API if you want callback delivery"
      );
    }
    const { correlationId } = await send({
      type: "select",
      text,
      options: selectOptions,
      correlationId: opts.correlationId,
      also: opts.also,
    });
    return pollReply(
      correlationId,
      opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
  }

  async function sendTemplate(
    templateName: string,
    languageCode: string,
    params: string[] = [],
    opts: { correlationId?: string; also?: string } = {}
  ): Promise<void> {
    await send({
      type: "template",
      templateName,
      templateLanguage: languageCode,
      templateParams: params,
      correlationId: opts.correlationId,
      also: opts.also,
    });
  }

  async function getMessageStatus(messageId: string): Promise<MessageStatus | null> {
    const res = await fetch(`${options.baseUrl}/api/messages/${encodeURIComponent(messageId)}`, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
    });
    if (res.status === 404 && typeof (await res.json().catch(() => null))?.error === "string") return null;
    if (!res.ok) throw new GatewayError(`status lookup failed (${res.status})`);
    return res.json();
  }

  async function getWindow(): Promise<WindowState> {
    const res = await fetch(`${options.baseUrl}/api/window`, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
    });
    if (!res.ok) throw new GatewayError(`window lookup failed (${res.status})`);
    return res.json();
  }

  async function getInbox(opts: { since?: number; limit?: number; from?: string } = {}): Promise<InboxMessage[]> {
    const query = new URLSearchParams();
    if (opts.since !== undefined) query.set("since", String(opts.since));
    if (opts.limit !== undefined) query.set("limit", String(opts.limit));
    if (opts.from !== undefined) query.set("from", opts.from);
    const suffix = query.toString() ? `?${query}` : "";
    const res = await fetch(`${options.baseUrl}/api/inbox${suffix}`, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
    });
    if (!res.ok) throw new GatewayError(`inbox lookup failed (${res.status})`);
    return (await res.json()).messages;
  }

  return { sendNotification, sendApproval, sendPrompt, sendSelect, sendTemplate, getMessageStatus, getWindow, getInbox };
}
