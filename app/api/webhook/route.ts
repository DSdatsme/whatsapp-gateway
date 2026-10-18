import { after, NextResponse } from "next/server";
import { getRecipientNumber, getRequiredEnv } from "@/lib/env";
import { verifySignature } from "@/lib/signature";
import {
  resolveCorrelationId,
  markReplied,
  getPendingRecord,
  pinInboundDecision,
} from "@/lib/correlation";
import { deliverCallback } from "@/lib/callback";
import { recordMessageStatus } from "@/lib/message-status";
import { recordInbound } from "@/lib/window";
import { addInboxMessage } from "@/lib/inbox";
import { isWatched } from "@/lib/watch";

export const runtime = "nodejs";

interface WebhookChange {
  value?: { metadata?: { phone_number_id?: string }; messages?: unknown; statuses?: unknown };
}

interface WhatsAppStatus {
  id?: string;
  status?: string;
  recipient_id?: string;
  timestamp?: string;
  errors?: { code?: number; title?: string; message?: string; error_data?: { details?: string } }[];
}

const MAX_INBOX_TEXT_LENGTH = 1000;

const WINDOW_OPENING_TYPES = new Set([
  "text", "image", "audio", "video", "document", "sticker", "location", "contacts", "interactive", "button",
]);

function secondsToMs(timestamp: unknown): number | undefined {
  const seconds = Number(timestamp);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

// Meta accepts a send (200 + message id) before it knows whether delivery will
// succeed, e.g. free-form text outside the 24h window is only reported as failed
// here, so this is the only place a dropped message shows up.
function logStatus(status: WhatsAppStatus) {
  const summary = `messageId=${status.id}, status=${status.status}, recipient=${status.recipient_id}`;
  if (status.status === "failed") {
    const reasons = (status.errors ?? [])
      .map((e) => `code=${e.code} ${e.title}: ${e.error_data?.details ?? e.message}`)
      .join("; ");
    console.error(`WhatsApp delivery failed: ${summary}, ${reasons}`);
    return;
  }
  console.log(`WhatsApp status update: ${summary}`);
}

async function handleStatus(status: WhatsAppStatus) {
  logStatus(status);
  if (!status.id || !status.status) return;

  const error = status.errors?.[0];
  await recordMessageStatus({
    messageId: status.id,
    status: status.status,
    timestamp: secondsToMs(status.timestamp),
    recipient: status.recipient_id,
    error: error && { code: error.code, title: error.title, details: error.error_data?.details ?? error.message },
  });
}

async function recordInboundMessage(message: Record<string, any>) {
  const fromRecipient = message.from === getRecipientNumber();
  if (!fromRecipient && !(message.from && (await isWatched(message.from)))) return;

  const at = secondsToMs(message.timestamp) ?? Date.now();
  if (fromRecipient && (message.type === undefined || WINDOW_OPENING_TYPES.has(message.type))) await recordInbound(at);
  if (!message.id || (message.type === "reaction" && !message.reaction?.emoji)) return;

  const text: string | undefined =
    message.text?.body ??
    message.interactive?.button_reply?.title ??
    message.interactive?.list_reply?.title ??
    message.button?.text ??
    message.reaction?.emoji ??
    message.image?.caption ??
    message.video?.caption ??
    message.document?.caption;
  const contextMessageId: string | undefined = message.context?.id ?? message.reaction?.message_id;
  const entry = {
    id: message.id,
    type: message.type ?? "unknown",
    ...(text ? { text: text.slice(0, MAX_INBOX_TEXT_LENGTH) } : {}),
    timestamp: at,
    ...(contextMessageId ? { contextMessageId } : {}),
  };
  await (fromRecipient ? addInboxMessage(entry) : addInboxMessage(entry, message.from));
}

async function resolveReply(message: Record<string, any>) {
  const from: string = message.from ?? "";
  const inboundId: string | undefined = message.id;

  const buttonId: string | undefined = message.interactive?.button_reply?.id;
  const listReplyId: string | undefined = message.interactive?.list_reply?.id;
  const contextMessageId: string | undefined = message.context?.id;
  const replyText: string = message.interactive?.button_reply?.title ?? message.text?.body ?? "";

  // Free text resolves the most recent pending prompt, so only text may do that.
  if (!buttonId && !listReplyId && message.type !== undefined && message.type !== "text") {
    console.log(`Ignoring non-text message with no matching reply (from=${from}, type=${message.type})`);
    return;
  }

  const resolved = await resolveCorrelationId({ from, buttonId, listReplyId, contextMessageId });
  // Free text is matched to "the most recent pending prompt", which a redelivery would resolve differently, so pin the first decision.
  const pinnable = inboundId && from === getRecipientNumber();
  const candidate = resolved?.correlationId ?? null;
  const correlationId = pinnable ? await pinInboundDecision(inboundId, candidate) : candidate;
  if (!correlationId) {
    console.log(`Webhook ack without action - no matching pending reply (from=${from}, type=${message.type})`);
    return;
  }

  let value: string;
  if (resolved?.selectedIndex !== undefined) {
    const pending = await getPendingRecord(correlationId);
    value = pending?.options?.[resolved.selectedIndex] ?? "";
  } else {
    value = resolved?.decision ?? replyText;
  }

  const updated = await markReplied(correlationId, value);
  if (!updated) {
    console.log("Webhook ack without action - no matching pending reply");
    return;
  }

  const { callbackUrl } = updated;
  if (callbackUrl) {
    // After the response: a slow consumer must not make Meta retry the webhook.
    after(() => deliverCallback(callbackUrl, { correlationId, value }));
  }
  console.log(`Reply resolved: correlationId=${correlationId}, value=${value}`);
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === getRequiredEnv("WHATSAPP_VERIFY_TOKEN")) {
    return new Response(challenge ?? "", { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  if (!verifySignature(rawBody, signature, getRequiredEnv("WHATSAPP_APP_SECRET"))) {
    console.warn("Signature verification failed");
    return new Response("Invalid signature", { status: 401 });
  }

  const event = JSON.parse(rawBody);

  const changes = asArray<{ changes?: unknown }>(event?.entry)
    .flatMap((entry) => asArray<WebhookChange>(entry?.changes))
    .filter((change) => {
      const phoneId = change?.value?.metadata?.phone_number_id;
      return !phoneId || phoneId === getRequiredEnv("WHATSAPP_PHONE_ID");
    });
  const messages = changes.flatMap((change) => asArray<Record<string, any>>(change?.value?.messages));
  const statuses = changes.flatMap((change) => asArray<WhatsAppStatus>(change?.value?.statuses));

  // Replies first: a failing telemetry write must not hold up resolving one, but still fails the request so Meta retries.
  for (const message of messages) await resolveReply(message);
  for (const message of messages) await recordInboundMessage(message);
  for (const status of statuses) await handleStatus(status);

  return NextResponse.json({ ok: true });
}
