import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { requireApiKey } from "@/lib/auth";
import { createPendingRecord } from "@/lib/correlation";
import { getRequiredEnv } from "@/lib/env";
import {
  buildApprovalPayload,
  buildNotificationPayload,
  buildSelectPayload,
  buildTemplatePayload,
  sendWhatsAppMessage,
  WhatsAppSendError,
} from "@/lib/whatsapp";

export const runtime = "nodejs";

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
}

// E.164 without the leading "+", matching what the Graph API's "to" field expects.
const PHONE_NUMBER_PATTERN = /^\d{8,15}$/;

// Node's fetch reports DNS/network failures as "fetch failed", with the real reason in `cause`.
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  return err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
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

export async function POST(request: Request): Promise<Response> {
  const authError = requireApiKey(request);
  if (authError) return authError;

  let body: Partial<SendRequestBody>;
  try {
    body = (await request.json()) as Partial<SendRequestBody>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body.type) {
    return NextResponse.json({ error: "type is required" }, { status: 400 });
  }
  if (!["notification", "approval", "prompt", "select", "template"].includes(body.type)) {
    return NextResponse.json(
      { error: "type must be one of: notification, approval, prompt, select, template" },
      { status: 400 }
    );
  }
  if (body.type === "template") {
    if (!body.templateName || !body.templateLanguage) {
      return NextResponse.json(
        { error: "templateName and templateLanguage are required for type template" },
        { status: 400 }
      );
    }
  } else if (!body.text) {
    return NextResponse.json({ error: "type and text are required" }, { status: 400 });
  }
  if (body.type === "select" && (!Array.isArray(body.options) || body.options.length < 2 || body.options.length > 10)) {
    return NextResponse.json(
      { error: "options must be an array of 2-10 strings for type select" },
      { status: 400 }
    );
  }
  if (
    body.type === "template" &&
    body.templateParams !== undefined &&
    (!Array.isArray(body.templateParams) || body.templateParams.some((p) => typeof p !== "string"))
  ) {
    return NextResponse.json(
      { error: "templateParams must be an array of strings" },
      { status: 400 }
    );
  }
  if (body.also !== undefined && !PHONE_NUMBER_PATTERN.test(body.also)) {
    return NextResponse.json(
      { error: "also must be digits only in E.164 format without a leading +, e.g. 15551234567" },
      { status: 400 }
    );
  }

  const correlationId = body.correlationId ?? randomUUID();
  const recipient = getRequiredEnv("WHATSAPP_RECIPIENT_NUMBER");

  const payload = buildPayload(body.type, recipient, body, correlationId);

  try {
    const { messageId } = await sendWhatsAppMessage(payload);
    console.log(`Sent ${body.type} message: correlationId=${correlationId}, messageId=${messageId}`);
    try {
      await createPendingRecord(correlationId, {
        type: body.type,
        callbackUrl: body.callbackUrl,
        whatsappMessageId: messageId,
        createdAt: Date.now(),
        ...(body.type === "select" ? { options: body.options } : {}),
      });
    } catch (err) {
      // The message has already gone out at this point, so a retry by the caller
      // would send a duplicate - make that explicit in the logs.
      console.error(
        `Message was sent but storing its pending record failed: correlationId=${correlationId}, ` +
          `messageId=${messageId}, error=${describeError(err)}`
      );
      throw err;
    }

    let alsoError: string | undefined;
    if (body.also && body.also !== recipient) {
      try {
        await sendWhatsAppMessage(buildPayload(body.type, body.also, body, correlationId));
      } catch (err) {
        alsoError = err instanceof WhatsAppSendError ? err.message : "unknown error sending to 'also' recipient";
        console.error(`Failed to send copy to 'also' recipient ${body.also}: ${alsoError}`);
      }
    }

    return NextResponse.json({ correlationId, ...(alsoError ? { alsoError } : {}) }, { status: 200 });
  } catch (err) {
    if (err instanceof WhatsAppSendError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    throw err;
  }
}
