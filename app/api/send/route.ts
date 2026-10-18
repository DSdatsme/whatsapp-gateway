import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { requireApiKey } from "@/lib/auth";
import { createPendingRecord } from "@/lib/correlation";
import { getRecipientNumber, getRequiredEnv } from "@/lib/env";
import { getWindowState } from "@/lib/window";
import { watchNumber } from "@/lib/watch";
import {
  buildApprovalPayload,
  buildNotificationPayload,
  buildSelectPayload,
  buildTemplatePayload,
  sendWhatsAppMessage,
  WhatsAppSendError,
} from "@/lib/whatsapp";

export const runtime = "nodejs";

interface FallbackTemplate {
  name: string;
  language: string;
  params?: string[];
}

interface SendRequestBody {
  type: "notification" | "approval" | "prompt" | "select" | "template";
  text: string;
  also?: string;
  correlationId?: string;
  approveLabel?: string;
  denyLabel?: string;
  options?: string[];
  callbackUrl?: string;
  templateName?: string;
  templateLanguage?: string;
  templateParams?: string[];
  fallbackTemplate?: FallbackTemplate;
}

// E.164 without the leading "+", matching what the Graph API's "to" field expects.
const PHONE_NUMBER_PATTERN = /^\d{8,15}$/;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_CALLBACK_URL_LENGTH = 2048;
const WINDOW_SAFETY_MARGIN_MS = 2 * 60 * 1000;

// Node's fetch reports DNS/network failures as "fetch failed", with the real reason in `cause`.
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length > MAX_CALLBACK_URL_LENGTH) return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function buildPayload(type: SendRequestBody["type"], recipient: string, body: Partial<SendRequestBody>, correlationId: string) {
  return type === "approval"
    ? buildApprovalPayload(recipient, body.text!, correlationId, body.approveLabel ?? "Approve", body.denyLabel ?? "Deny")
    : type === "select"
      ? buildSelectPayload(recipient, body.text!, correlationId, body.options!)
      : type === "template"
        ? buildTemplatePayload(recipient, body.templateName!, body.templateLanguage!, body.templateParams ?? [])
        : buildNotificationPayload(recipient, body.text!);
}

const badRequest = (error: string) => NextResponse.json({ error }, { status: 400 });

function validateFallbackTemplate(type: SendRequestBody["type"], fallback: Partial<FallbackTemplate> | null): string | null {
  if (type !== "notification") return "fallbackTemplate is only supported for type notification";
  if (typeof fallback?.name !== "string" || typeof fallback.language !== "string" || !fallback.name || !fallback.language) {
    return "fallbackTemplate needs a name and a language, both strings";
  }
  if (fallback.params !== undefined && !isStringArray(fallback.params)) {
    return "fallbackTemplate.params must be an array of strings";
  }
  return null;
}

async function shouldUseFallbackTemplate(body: Partial<SendRequestBody>): Promise<boolean> {
  if (!body.fallbackTemplate) return false;
  try {
    const { open, expiresAt } = await getWindowState();
    return !(open && expiresAt !== null && expiresAt - Date.now() > WINDOW_SAFETY_MARGIN_MS);
  } catch (err) {
    // A template always delivers, so an unreadable window falls back to it.
    console.error(`Could not read the 24h window state, sending the fallback template: ${describeError(err)}`);
    return true;
  }
}

async function watchOrReport(number: string): Promise<string | undefined> {
  try {
    await watchNumber(number);
  } catch (err) {
    console.error(`Could not start watching the 'also' recipient for replies: ${describeError(err)}`);
    return "could not start watching this number for replies, so its replies may not be captured";
  }
}

export async function POST(request: Request): Promise<Response> {
  const authError = requireApiKey(request);
  if (authError) return authError;

  let body: Partial<SendRequestBody>;
  try {
    body = (await request.json()) as Partial<SendRequestBody>;
  } catch {
    return badRequest("invalid JSON body");
  }

  if (!body || typeof body !== "object") return badRequest("request body must be a JSON object");
  if (!body.type) return badRequest("type is required");
  if (!["notification", "approval", "prompt", "select", "template"].includes(body.type)) {
    return badRequest("type must be one of: notification, approval, prompt, select, template");
  }
  if (body.type === "template") {
    if (!body.templateName || !body.templateLanguage) {
      return badRequest("templateName and templateLanguage are required for type template");
    }
  } else if (!body.text) {
    return badRequest("type and text are required");
  }
  if (body.type === "select" && (!Array.isArray(body.options) || body.options.length < 2 || body.options.length > 10)) {
    return badRequest("options must be an array of 2-10 strings for type select");
  }
  if (body.type === "template" && body.templateParams !== undefined && !isStringArray(body.templateParams)) {
    return badRequest("templateParams must be an array of strings");
  }
  if (body.fallbackTemplate != null) {
    const fallbackError = validateFallbackTemplate(body.type, body.fallbackTemplate);
    if (fallbackError) return badRequest(fallbackError);
  }
  if (body.also !== undefined && !(typeof body.also === "string" && PHONE_NUMBER_PATTERN.test(body.also))) {
    return badRequest("also must be digits only in E.164 format without a leading +, e.g. 15551234567");
  }
  const tracksReply = body.type === "approval" || body.type === "prompt" || body.type === "select";
  if (tracksReply && body.correlationId != null && !(typeof body.correlationId === "string" && CORRELATION_ID_PATTERN.test(body.correlationId))) {
    return badRequest("correlationId must be 1-128 characters: letters, digits, '.', '_', ':' or '-'");
  }
  if (body.callbackUrl != null && !isHttpUrl(body.callbackUrl)) {
    return badRequest(`callbackUrl must be an http(s) URL without credentials, at most ${MAX_CALLBACK_URL_LENGTH} characters`);
  }

  const correlationId = typeof body.correlationId === "string" && body.correlationId ? body.correlationId : randomUUID();
  const recipient = getRequiredEnv("WHATSAPP_RECIPIENT_NUMBER");

  const { fallbackTemplate: fallback } = body;
  const viaTemplate = await shouldUseFallbackTemplate(body);
  const payloadFor = (to: string) =>
    fallback && (viaTemplate || to !== recipient)
      ? buildTemplatePayload(to, fallback.name, fallback.language, fallback.params ?? [])
      : buildPayload(body.type!, to, body, correlationId);

  let messageId: string;
  try {
    ({ messageId } = await sendWhatsAppMessage(payloadFor(recipient)));
  } catch (err) {
    if (err instanceof WhatsAppSendError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    throw err;
  }
  console.log(`Sent ${body.type} message${viaTemplate ? " via fallback template" : ""}: correlationId=${correlationId}, messageId=${messageId}`);

  let trackingFailed = false;
  if (tracksReply) {
    try {
      await createPendingRecord(correlationId, {
        type: body.type,
        callbackUrl: body.callbackUrl,
        whatsappMessageId: messageId,
        createdAt: Date.now(),
        ...(body.type === "select" ? { options: body.options } : {}),
      });
    } catch (err) {
      trackingFailed = true;
      console.error(
        `Message was sent but storing its pending record failed: correlationId=${correlationId}, ` +
          `messageId=${messageId}, error=${describeError(err)}`
      );
    }
  }

  let alsoMessageId: string | undefined;
  let alsoNumber: string | undefined;
  let alsoWatchError: string | undefined;
  let alsoError: string | undefined;
  if (body.also && body.also !== getRecipientNumber()) {
    alsoWatchError = await watchOrReport(body.also);
    try {
      const copy = await sendWhatsAppMessage(payloadFor(body.also));
      alsoMessageId = copy.messageId;
      alsoNumber = copy.recipientId ?? body.also;
      if (alsoNumber !== body.also) alsoWatchError ??= await watchOrReport(alsoNumber);
    } catch (err) {
      alsoError = err instanceof WhatsAppSendError ? err.message : "unknown error sending to 'also' recipient";
      console.error(`Failed to send copy to 'also' recipient ${body.also}: ${alsoError}`);
    }
  }
  const alsoField = {
    ...(alsoMessageId ? { alsoMessageId, alsoNumber } : {}),
    ...(alsoWatchError ? { alsoWatchError } : {}),
    ...(alsoError ? { alsoError } : {}),
  };

  if (trackingFailed) {
    const error =
      "the message was sent, but storing its reply tracking failed, so its reply can't be matched; " +
      "do not retry blindly - that would send a duplicate";
    return NextResponse.json({ error, sent: true, messageId, correlationId, ...alsoField }, { status: 500 });
  }

  return NextResponse.json({ correlationId, messageId, ...(viaTemplate ? { viaTemplate: true } : {}), ...alsoField });
}
