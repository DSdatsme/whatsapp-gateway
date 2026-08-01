import { getRequiredEnv } from "@/lib/env";

const GRAPH_API_VERSION = "v21.0";

export class WhatsAppSendError extends Error {}

export async function sendWhatsAppMessage(
  payload: Record<string, unknown>
): Promise<{ messageId: string }> {
  const phoneId = getRequiredEnv("WHATSAPP_PHONE_ID");
  const token = getRequiredEnv("WHATSAPP_TOKEN");

  console.log(`Sending WhatsApp message of type: ${payload.type}`);

  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    const error = new WhatsAppSendError(data?.error?.message ?? `Graph API error (${res.status})`);
    console.error(`WhatsApp send failed: ${error.message}`);
    throw error;
  }
  return { messageId: data.messages[0].id };
}

export function buildNotificationPayload(to: string, text: string): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };
}

export function buildApprovalPayload(
  to: string,
  text: string,
  correlationId: string,
  approveLabel: string,
  denyLabel: string
): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text },
      action: {
        buttons: [
          { type: "reply", reply: { id: `approve:${correlationId}`, title: approveLabel } },
          { type: "reply", reply: { id: `deny:${correlationId}`, title: denyLabel } },
        ],
      },
    },
  };
}
