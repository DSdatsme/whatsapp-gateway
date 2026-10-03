import { getRequiredEnv } from "@/lib/env";

const GRAPH_API_VERSION = "v21.0";

export class WhatsAppSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppSendError";
  }
}

interface GraphApiResponse {
  messages?: { id: string }[];
  error?: { message: string; code?: number; error_subcode?: number; fbtrace_id?: string };
}

export async function sendWhatsAppMessage(
  payload: Record<string, unknown>
): Promise<{ messageId: string }> {
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
    });

    const data = (await res.json()) as GraphApiResponse;
    if (!res.ok) {
      const error = new WhatsAppSendError(data?.error?.message ?? `Graph API error (${res.status})`);
      console.error(
        `WhatsApp send failed: ${error.message} (http=${res.status}, code=${data?.error?.code}, ` +
          `subcode=${data?.error?.error_subcode}, fbtrace_id=${data?.error?.fbtrace_id})`
      );
      throw error;
    }
    return { messageId: data.messages![0].id };
  } catch (err) {
    if (err instanceof WhatsAppSendError) {
      throw err;
    }
    const error = new WhatsAppSendError(err instanceof Error ? err.message : "Unknown error");
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
