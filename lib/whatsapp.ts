import { getRequiredEnv } from "@/lib/env";

const GRAPH_API_VERSION = "v21.0";
const REQUEST_TIMEOUT_MS = 15_000;

export class WhatsAppSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppSendError";
  }
}

interface GraphApiResponse {
  messages?: { id: string }[];
  contacts?: { wa_id?: string }[];
  error?: { message: string; code?: number; error_subcode?: number; fbtrace_id?: string };
}

export async function sendWhatsAppMessage(
  payload: Record<string, unknown>
): Promise<{ messageId: string; recipientId?: string }> {
  const phoneId = getRequiredEnv("WHATSAPP_PHONE_ID");
  const token = getRequiredEnv("WHATSAPP_TOKEN");

  console.log(`Sending WhatsApp message of type: ${payload.type}`);

  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const data = (await res.json().catch(() => null)) as GraphApiResponse | null;
    if (!res.ok) {
      const error = new WhatsAppSendError(data?.error?.message ?? `Graph API error (${res.status})`);
      console.error(
        `WhatsApp send failed: ${error.message} (http=${res.status}, code=${data?.error?.code}, ` +
          `subcode=${data?.error?.error_subcode}, fbtrace_id=${data?.error?.fbtrace_id})`
      );
      throw error;
    }
    const messageId = data?.messages?.[0]?.id;
    if (!messageId) {
      throw new WhatsAppSendError("Graph API accepted the request but returned no message id; the message may have been sent");
    }
    return { messageId, recipientId: data?.contacts?.[0]?.wa_id };
  } catch (err) {
    if (err instanceof WhatsAppSendError) {
      throw err;
    }
    const message =
      err instanceof Error && err.name === "TimeoutError"
        ? `Graph API request timed out after ${REQUEST_TIMEOUT_MS / 1000}s; the message may or may not have been sent`
        : err instanceof Error
          ? err.message
          : "Unknown error";
    const error = new WhatsAppSendError(message);
    console.error(`WhatsApp send failed: ${error.message}`);
    throw error;
  }
}

export function buildNotificationPayload(to: string, text: string): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };
}

export function buildSelectPayload(
  to: string,
  text: string,
  correlationId: string,
  options: string[]
): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text },
      action: {
        button: "Select",
        sections: [
          {
            rows: options.map((title, index) => ({ id: `${correlationId}:${index}`, title })),
          },
        ],
      },
    },
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

export function buildTemplatePayload(
  to: string,
  templateName: string,
  languageCode: string,
  params: string[]
): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(params.length > 0
        ? { components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] }
        : {}),
    },
  };
}
