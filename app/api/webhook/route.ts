import { NextResponse } from "next/server";
import { getRequiredEnv } from "@/lib/env";
import { verifySignature } from "@/lib/signature";
import { resolveCorrelationId, markReplied, getPendingRecord } from "@/lib/correlation";
import { deliverCallback } from "@/lib/callback";

export const runtime = "nodejs";

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
  const message = event?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (!message) {
    // Status updates (delivered/read receipts) and other non-message events
    // land here too - nothing to correlate, just ack.
    return NextResponse.json({ ok: true });
  }

  const from: string = message.from ?? "";
  const buttonId: string | undefined = message.interactive?.button_reply?.id;
  const listReplyId: string | undefined = message.interactive?.list_reply?.id;
  const contextMessageId: string | undefined = message.context?.id;
  const replyText: string = message.interactive?.button_reply?.title ?? message.text?.body ?? "";

  const resolved = await resolveCorrelationId({ from, buttonId, listReplyId, contextMessageId });
  if (!resolved) {
    console.log("Webhook ack without action - no matching pending reply");
    return NextResponse.json({ ok: true });
  }

  let value: string;
  if (resolved.selectedIndex !== undefined) {
    const pending = await getPendingRecord(resolved.correlationId);
    value = pending?.options?.[resolved.selectedIndex] ?? "";
  } else {
    value = resolved.decision ?? replyText;
  }

  const updated = await markReplied(resolved.correlationId, value);
  if (!updated) {
    console.log("Webhook ack without action - no matching pending reply");
    return NextResponse.json({ ok: true });
  }

  console.log(`Reply resolved: correlationId=${resolved.correlationId}, value=${value}`);

  if (updated.callbackUrl) {
    await deliverCallback(updated.callbackUrl, { correlationId: resolved.correlationId, value });
  }

  return NextResponse.json({ ok: true });
}
