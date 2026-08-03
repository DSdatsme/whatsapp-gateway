import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { requireApiKey } from "@/lib/auth";
import { createPendingRecord } from "@/lib/correlation";
import { getRequiredEnv } from "@/lib/env";
import {
  buildApprovalPayload,
  buildNotificationPayload,
  buildSelectPayload,
  sendWhatsAppMessage,
  WhatsAppSendError,
} from "@/lib/whatsapp";

export const runtime = "nodejs";

interface SendRequestBody {
  type: "notification" | "approval" | "prompt" | "select";
  text: string;
  correlationId?: string;
  approveLabel?: string;
  denyLabel?: string;
  options?: string[];
  callbackUrl?: string;
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

  if (!body.type || !body.text) {
    return NextResponse.json({ error: "type and text are required" }, { status: 400 });
  }
  if (!["notification", "approval", "prompt", "select"].includes(body.type)) {
    return NextResponse.json(
      { error: "type must be one of: notification, approval, prompt, select" },
      { status: 400 }
    );
  }
  if (body.type === "select" && (!Array.isArray(body.options) || body.options.length < 2 || body.options.length > 10)) {
    return NextResponse.json(
      { error: "options must be an array of 2-10 strings for type select" },
      { status: 400 }
    );
  }

  const correlationId = body.correlationId ?? randomUUID();
  const recipient = getRequiredEnv("WHATSAPP_RECIPIENT_NUMBER");

  const payload =
    body.type === "approval"
      ? buildApprovalPayload(
          recipient,
          body.text,
          correlationId,
          body.approveLabel ?? "Approve",
          body.denyLabel ?? "Deny"
        )
      : body.type === "select"
        ? buildSelectPayload(recipient, body.text, correlationId, body.options!)
        : buildNotificationPayload(recipient, body.text);

  try {
    const { messageId } = await sendWhatsAppMessage(payload);
    await createPendingRecord(correlationId, {
      type: body.type,
      callbackUrl: body.callbackUrl,
      whatsappMessageId: messageId,
      createdAt: Date.now(),
      ...(body.type === "select" ? { options: body.options } : {}),
    });
    return NextResponse.json({ correlationId }, { status: 200 });
  } catch (err) {
    if (err instanceof WhatsAppSendError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    throw err;
  }
}
