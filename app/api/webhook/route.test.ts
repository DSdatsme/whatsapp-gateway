import { createHmac } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/correlation", () => ({
  resolveCorrelationId: vi.fn(),
  markReplied: vi.fn(),
  getPendingRecord: vi.fn(),
}));
vi.mock("@/lib/callback", () => ({
  deliverCallback: vi.fn(async () => {}),
}));

import { GET, POST } from "@/app/api/webhook/route";
import { resolveCorrelationId, markReplied, getPendingRecord } from "@/lib/correlation";
import { deliverCallback } from "@/lib/callback";

const APP_SECRET = "test-app-secret";

beforeEach(() => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  process.env.WHATSAPP_VERIFY_TOKEN = "test-verify-token";
  vi.clearAllMocks();
});

function signedRequest(body: unknown): Request {
  const raw = JSON.stringify(body);
  const signature = `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;
  return new Request("https://gateway.example/api/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": signature },
    body: raw,
  });
}

const BUTTON_REPLY_PAYLOAD = {
  entry: [
    {
      changes: [
        {
          value: {
            messages: [{ interactive: { button_reply: { id: "approve:corr-1", title: "Approve" } } }],
          },
        },
      ],
    },
  ],
};

describe("GET /api/webhook", () => {
  it("echoes the challenge for a valid verify token", async () => {
    const url =
      "https://gateway.example/api/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=123";
    const res = await GET(new Request(url));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("123");
  });

  it("rejects an invalid verify token", async () => {
    const url =
      "https://gateway.example/api/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123";
    const res = await GET(new Request(url));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/webhook", () => {
  it("rejects a request with an invalid signature", async () => {
    const res = await POST(
      new Request("https://gateway.example/api/webhook", {
        method: "POST",
        headers: { "x-hub-signature-256": "sha256=deadbeef" },
        body: JSON.stringify(BUTTON_REPLY_PAYLOAD),
      })
    );
    expect(res.status).toBe(401);
  });

  it("resolves a button reply and delivers the callback", async () => {
    vi.mocked(resolveCorrelationId).mockResolvedValue({ correlationId: "corr-1", decision: "approve" });
    vi.mocked(markReplied).mockResolvedValue({
      status: "replied",
      type: "approval",
      callbackUrl: "https://consumer.example/hook",
      whatsappMessageId: "wamid.1",
      createdAt: 1,
      value: "approve",
      receivedAt: 2,
    });

    const res = await POST(signedRequest(BUTTON_REPLY_PAYLOAD));
    expect(res.status).toBe(200);
    expect(markReplied).toHaveBeenCalledWith("corr-1", "approve");
    expect(deliverCallback).toHaveBeenCalledWith("https://consumer.example/hook", {
      correlationId: "corr-1",
      value: "approve",
    });
  });

  it("acks without error when nothing resolves (stale/unmatched reply)", async () => {
    vi.mocked(resolveCorrelationId).mockResolvedValue(null);
    const res = await POST(signedRequest(BUTTON_REPLY_PAYLOAD));
    expect(res.status).toBe(200);
    expect(markReplied).not.toHaveBeenCalled();
  });

  it("acks without delivering a callback when markReplied returns null (duplicate/already-replied delivery)", async () => {
    vi.mocked(resolveCorrelationId).mockResolvedValue({ correlationId: "corr-1", decision: "approve" });
    vi.mocked(markReplied).mockResolvedValue(null);

    const res = await POST(signedRequest(BUTTON_REPLY_PAYLOAD));
    expect(res.status).toBe(200);
    expect(markReplied).toHaveBeenCalledWith("corr-1", "approve");
    expect(deliverCallback).not.toHaveBeenCalled();
  });

  it("resolves a list reply to the selected option's label", async () => {
    const LIST_REPLY_PAYLOAD = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [{ interactive: { list_reply: { id: "corr-2:1", title: "Green" } } }],
              },
            },
          ],
        },
      ],
    };

    vi.mocked(resolveCorrelationId).mockResolvedValue({ correlationId: "corr-2", selectedIndex: 1 });
    vi.mocked(getPendingRecord).mockResolvedValue({
      status: "pending",
      type: "select",
      whatsappMessageId: "wamid.2",
      createdAt: 1,
      options: ["Red", "Green", "Blue"],
    });
    vi.mocked(markReplied).mockResolvedValue({
      status: "replied",
      type: "select",
      whatsappMessageId: "wamid.2",
      createdAt: 1,
      value: "Green",
      receivedAt: 2,
      options: ["Red", "Green", "Blue"],
    });

    const res = await POST(signedRequest(LIST_REPLY_PAYLOAD));
    expect(res.status).toBe(200);
    expect(markReplied).toHaveBeenCalledWith("corr-2", "Green");
  });
});
