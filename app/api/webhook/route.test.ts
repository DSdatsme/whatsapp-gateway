import { createHmac } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/correlation", () => ({
  resolveCorrelationId: vi.fn(),
  markReplied: vi.fn(),
  getPendingRecord: vi.fn(),
  pinInboundDecision: vi.fn(async (_id: string, candidate: string | null) => candidate),
}));
vi.mock("@/lib/callback", () => ({
  deliverCallback: vi.fn(async () => {}),
}));
vi.mock("@/lib/message-status", () => ({
  recordMessageStatus: vi.fn(async () => {}),
}));
vi.mock("@/lib/window", () => ({
  recordInbound: vi.fn(async () => {}),
}));
vi.mock("@/lib/inbox", () => ({
  addInboxMessage: vi.fn(async () => {}),
}));

// after() needs a real request scope, so capture its tasks and run them with flushAfter().
const afterTasks: Array<() => unknown> = [];
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: vi.fn((task: () => unknown) => void afterTasks.push(task)) };
});

import { GET, POST } from "@/app/api/webhook/route";
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

const APP_SECRET = "test-app-secret";

beforeEach(() => {
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
  process.env.WHATSAPP_VERIFY_TOKEN = "test-verify-token";
  process.env.WHATSAPP_RECIPIENT_NUMBER = "15551234567";
  process.env.WHATSAPP_PHONE_ID = "phone-1";
  vi.clearAllMocks();
  afterTasks.length = 0;
});

async function flushAfter() {
  await Promise.all(afterTasks.splice(0).map((task) => task()));
}

function signedRequest(body: unknown): Request {
  const raw = JSON.stringify(body);
  const signature = `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;
  return new Request("https://gateway.example/api/webhook", {
    method: "POST",
    headers: { "x-hub-signature-256": signature },
    body: raw,
  });
}

const SENDER = "15551234567";

function statusPayload(status: Record<string, unknown>) {
  return { entry: [{ changes: [{ value: { statuses: [status] } }] }] };
}

// True if a single logged line contains every one of `parts`.
function loggedLine(spy: { mock: { calls: unknown[][] } }, ...parts: string[]): boolean {
  return spy.mock.calls.some(([line]) => parts.every((part) => String(line).includes(part)));
}

const BUTTON_REPLY_PAYLOAD = {
  entry: [
    {
      changes: [
        {
          value: {
            messages: [
              { from: SENDER, interactive: { button_reply: { id: "approve:corr-1", title: "Approve" } } },
            ],
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
    expect(resolveCorrelationId).toHaveBeenCalledWith(
      expect.objectContaining({ from: SENDER, buttonId: "approve:corr-1" })
    );
    expect(markReplied).toHaveBeenCalledWith("corr-1", "approve");

    await flushAfter();
    expect(deliverCallback).toHaveBeenCalledWith("https://consumer.example/hook", {
      correlationId: "corr-1",
      value: "approve",
    });
  });

  it("responds to Meta before delivering the callback, so a slow consumer can't make Meta retry the webhook", async () => {
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
    expect(deliverCallback).not.toHaveBeenCalled();
    expect(afterTasks).toHaveLength(1);
  });

  it("passes an empty sender through when the payload has no `from` field", async () => {
    vi.mocked(resolveCorrelationId).mockResolvedValue(null);
    const payloadWithoutFrom = {
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

    await POST(signedRequest(payloadWithoutFrom));
    expect(resolveCorrelationId).toHaveBeenCalledWith(expect.objectContaining({ from: "" }));
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
                messages: [
                  { from: SENDER, interactive: { list_reply: { id: "corr-2:1", title: "Green" } } },
                ],
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

  it("logs a failed delivery with the message id, Meta's error code, and the error details", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await POST(
      signedRequest(
        statusPayload({
          id: "wamid.failed",
          status: "failed",
          recipient_id: SENDER,
          errors: [
            {
              code: 131047,
              title: "Re-engagement message",
              error_data: { details: "Message failed to send because more than 24 hours have passed" },
            },
          ],
        })
      )
    );
    expect(res.status).toBe(200);
    expect(loggedLine(errorSpy, "wamid.failed", "131047", "more than 24 hours have passed")).toBe(true);
    errorSpy.mockRestore();
  });

  it("logs a non-failed status update with its status and message id", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await POST(
      signedRequest(statusPayload({ id: "wamid.ok", status: "delivered", recipient_id: SENDER }))
    );
    expect(res.status).toBe(200);
    expect(loggedLine(logSpy, "wamid.ok", "delivered")).toBe(true);
    logSpy.mockRestore();
  });

  it("processes every message and status in a batched payload, not just the first", async () => {
    vi.mocked(resolveCorrelationId).mockResolvedValue(null);
    const batched = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { from: SENDER, interactive: { button_reply: { id: "approve:a", title: "Approve" } } },
                  { from: SENDER, interactive: { button_reply: { id: "deny:b", title: "Deny" } } },
                ],
                statuses: [{ id: "wamid.s1", status: "sent" }],
              },
            },
          ],
        },
        {
          changes: [
            {
              value: {
                messages: [{ from: SENDER, interactive: { list_reply: { id: "c:0", title: "Red" } } }],
                statuses: [{ id: "wamid.s2", status: "delivered" }],
              },
            },
          ],
        },
      ],
    };

    const res = await POST(signedRequest(batched));
    expect(res.status).toBe(200);
    expect(resolveCorrelationId).toHaveBeenCalledTimes(3);
    expect(resolveCorrelationId).toHaveBeenCalledWith(expect.objectContaining({ buttonId: "approve:a" }));
    expect(resolveCorrelationId).toHaveBeenCalledWith(expect.objectContaining({ buttonId: "deny:b" }));
    expect(resolveCorrelationId).toHaveBeenCalledWith(expect.objectContaining({ listReplyId: "c:0" }));
    expect(recordMessageStatus).toHaveBeenCalledTimes(2);
  });

  it("does not treat a non-text message (image, sticker, ...) as the answer to a pending prompt", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await POST(
      signedRequest({
        entry: [{ changes: [{ value: { messages: [{ from: SENDER, type: "image", image: { id: "media.1" } }] } }] }],
      })
    );
    expect(res.status).toBe(200);
    expect(resolveCorrelationId).not.toHaveBeenCalled();
    expect(markReplied).not.toHaveBeenCalled();
    expect(loggedLine(logSpy, SENDER, "image")).toBe(true);
    logSpy.mockRestore();
  });

  it("still resolves a plain text message through the fallback", async () => {
    vi.mocked(resolveCorrelationId).mockResolvedValue({ correlationId: "corr-p" });
    vi.mocked(markReplied).mockResolvedValue({
      status: "replied",
      type: "prompt",
      whatsappMessageId: "wamid.p",
      createdAt: 1,
      value: "release-7",
      receivedAt: 2,
    });
    const res = await POST(
      signedRequest({
        entry: [{ changes: [{ value: { messages: [{ from: SENDER, type: "text", text: { body: "release-7" } }] } }] }],
      })
    );
    expect(res.status).toBe(200);
    expect(markReplied).toHaveBeenCalledWith("corr-p", "release-7");
  });

  it("logs the sender and message type when an inbound message matches no pending reply", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(resolveCorrelationId).mockResolvedValue(null);
    const res = await POST(
      signedRequest({
        entry: [{ changes: [{ value: { messages: [{ from: SENDER, type: "text", text: { body: "hey" } }] } }] }],
      })
    );
    expect(res.status).toBe(200);
    expect(loggedLine(logSpy, SENDER, "text")).toBe(true);
    logSpy.mockRestore();
  });
});

describe("POST /api/webhook delivery status and window tracking", () => {
  it("persists a delivery status with Meta's timestamp converted from seconds to ms", async () => {
    const res = await POST(
      signedRequest(
        statusPayload({ id: "wamid.ok", status: "delivered", recipient_id: SENDER, timestamp: "1700000000" })
      )
    );
    expect(res.status).toBe(200);
    expect(recordMessageStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "wamid.ok",
        status: "delivered",
        recipient: SENDER,
        timestamp: 1_700_000_000_000,
      })
    );
  });

  it("persists Meta's error code, title and details for a failed delivery", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await POST(
      signedRequest(
        statusPayload({
          id: "wamid.failed",
          status: "failed",
          recipient_id: SENDER,
          errors: [
            {
              code: 131047,
              title: "Re-engagement message",
              error_data: { details: "Message failed to send because more than 24 hours have passed" },
            },
          ],
        })
      )
    );
    expect(recordMessageStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "wamid.failed",
        status: "failed",
        error: {
          code: 131047,
          title: "Re-engagement message",
          details: "Message failed to send because more than 24 hours have passed",
        },
      })
    );
  });

  it("fails the request when persisting a delivery status fails, so Meta retries it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(recordMessageStatus).mockRejectedValueOnce(new Error("redis down"));
    await expect(POST(signedRequest(statusPayload({ id: "wamid.s", status: "failed" })))).rejects.toThrow("redis down");
  });

  it("records an inbound message from the recipient so the 24h window can be tracked", async () => {
    vi.mocked(resolveCorrelationId).mockResolvedValue(null);
    await POST(
      signedRequest({
        entry: [
          {
            changes: [
              { value: { messages: [{ from: SENDER, type: "text", timestamp: "1700000000", text: { body: "hi" } }] } },
            ],
          },
        ],
      })
    );
    expect(recordInbound).toHaveBeenCalledWith(1_700_000_000_000);
  });

  it("records a non-text inbound message too, since any message from the recipient reopens the window", async () => {
    await POST(
      signedRequest({
        entry: [
          {
            changes: [
              { value: { messages: [{ from: SENDER, type: "image", timestamp: "1700000000", image: { id: "m" } }] } },
            ],
          },
        ],
      })
    );
    expect(recordInbound).toHaveBeenCalledWith(1_700_000_000_000);
  });

  it("does not record a message from someone other than the recipient", async () => {
    vi.mocked(resolveCorrelationId).mockResolvedValue(null);
    await POST(
      signedRequest({
        entry: [
          {
            changes: [
              { value: { messages: [{ from: "19995551234", type: "text", timestamp: "1700000000", text: { body: "hi" } }] } },
            ],
          },
        ],
      })
    );
    expect(recordInbound).not.toHaveBeenCalled();
  });

  it("fails the request when recording the inbound message fails, so Meta retries it", async () => {
    vi.mocked(recordInbound).mockRejectedValueOnce(new Error("redis down"));
    await expect(POST(signedRequest(BUTTON_REPLY_PAYLOAD))).rejects.toThrow("redis down");
  });
});

describe("POST /api/webhook scoping and window-opening types", () => {
  const inboundText = { from: SENDER, type: "text", timestamp: "1700000000", text: { body: "hi" } };

  it("ignores events addressed to a different business phone number on the same app", async () => {
    vi.mocked(resolveCorrelationId).mockResolvedValue(null);
    const res = await POST(
      signedRequest({
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: "someone-elses-number" },
                  messages: [inboundText],
                  statuses: [{ id: "wamid.other", status: "delivered" }],
                },
              },
            ],
          },
        ],
      })
    );
    expect(res.status).toBe(200);
    expect(recordInbound).not.toHaveBeenCalled();
    expect(recordMessageStatus).not.toHaveBeenCalled();
    expect(resolveCorrelationId).not.toHaveBeenCalled();
  });

  it("processes events addressed to the configured business phone number", async () => {
    vi.mocked(resolveCorrelationId).mockResolvedValue(null);
    await POST(
      signedRequest({
        entry: [
          {
            changes: [
              {
                value: {
                  metadata: { phone_number_id: "phone-1" },
                  messages: [inboundText],
                  statuses: [{ id: "wamid.mine", status: "delivered" }],
                },
              },
            ],
          },
        ],
      })
    );
    expect(recordInbound).toHaveBeenCalledTimes(1);
    expect(recordMessageStatus).toHaveBeenCalledTimes(1);
  });

  it.each(["text", "image", "audio", "interactive", "button"])("a %s message from the recipient reopens the window", async (type) => {
    vi.mocked(resolveCorrelationId).mockResolvedValue(null);
    await POST(
      signedRequest({
        entry: [{ changes: [{ value: { messages: [{ from: SENDER, type, timestamp: "1700000000" }] } }] }],
      })
    );
    expect(recordInbound).toHaveBeenCalledWith(1_700_000_000_000);
  });

  it.each(["reaction", "unsupported", "system", "request_welcome"])(
    "a %s event is not counted as the recipient opening the window",
    async (type) => {
      await POST(
        signedRequest({
          entry: [{ changes: [{ value: { messages: [{ from: SENDER, type, timestamp: "1700000000" }] } }] }],
        })
      );
      expect(recordInbound).not.toHaveBeenCalled();
    }
  );
});

describe("POST /api/webhook ordering", () => {
  const resolvedReply = () => {
    vi.mocked(resolveCorrelationId).mockResolvedValue({ correlationId: "corr-1", decision: "approve" });
    vi.mocked(markReplied).mockResolvedValue({
      status: "replied",
      type: "approval",
      whatsappMessageId: "wamid.1",
      createdAt: 1,
      value: "approve",
      receivedAt: 2,
    });
  };

  it("resolves the reply before recording the inbound time, and still fails so Meta retries if that write fails", async () => {
    resolvedReply();
    vi.mocked(recordInbound).mockRejectedValueOnce(new Error("redis down"));
    await expect(POST(signedRequest(BUTTON_REPLY_PAYLOAD))).rejects.toThrow("redis down");
    expect(markReplied).toHaveBeenCalledWith("corr-1", "approve");
  });

  it("resolves every reply in the payload before persisting statuses, and still fails if a status write fails", async () => {
    resolvedReply();
    vi.mocked(recordMessageStatus).mockRejectedValueOnce(new Error("redis down"));
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [{ id: "wamid.s", status: "delivered" }],
                messages: [{ from: SENDER, interactive: { button_reply: { id: "approve:corr-1", title: "Approve" } } }],
              },
            },
          ],
        },
      ],
    };
    await expect(POST(signedRequest(payload))).rejects.toThrow("redis down");
    expect(markReplied).toHaveBeenCalledWith("corr-1", "approve");
  });
});

describe("POST /api/webhook pinned inbound decisions", () => {
  const textMessage = { id: "wamid.in1", from: SENDER, type: "text", text: { body: "release-7" } };
  const payload = (message: Record<string, unknown> = textMessage) => ({
    entry: [{ changes: [{ value: { messages: [message] } }] }],
  });
  const replied = (value: string) => ({
    status: "replied" as const,
    type: "prompt" as const,
    whatsappMessageId: "wamid.p",
    createdAt: 1,
    value,
    receivedAt: 2,
    callbackUrl: "https://consumer.example/hook",
  });

  it("pins the candidate for a message from the recipient before applying it", async () => {
    vi.mocked(resolveCorrelationId).mockResolvedValue({ correlationId: "p2" });
    vi.mocked(markReplied).mockResolvedValue(replied("release-7"));
    await POST(signedRequest(payload()));
    expect(pinInboundDecision).toHaveBeenCalledWith("wamid.in1", "p2");
  });

  it("applies the pinned decision instead of the freshly resolved one, so a redelivery can't answer another prompt", async () => {
    vi.mocked(resolveCorrelationId).mockResolvedValue({ correlationId: "p1" });
    vi.mocked(pinInboundDecision).mockResolvedValueOnce("p2");
    vi.mocked(markReplied).mockResolvedValue(replied("release-7"));
    await POST(signedRequest(payload()));
    expect(markReplied).toHaveBeenCalledWith("p2", "release-7");
    expect(markReplied).not.toHaveBeenCalledWith("p1", expect.anything());
  });

  it("acks without applying anything when the pinned decision was 'no match'", async () => {
    vi.mocked(resolveCorrelationId).mockResolvedValue({ correlationId: "p-new" });
    vi.mocked(pinInboundDecision).mockResolvedValueOnce(null);
    const res = await POST(signedRequest(payload()));
    expect(res.status).toBe(200);
    expect(markReplied).not.toHaveBeenCalled();
  });

  it("pins 'no match' as well, so a redelivered chat message can't answer a prompt created later", async () => {
    vi.mocked(resolveCorrelationId).mockResolvedValue(null);
    await POST(signedRequest(payload()));
    expect(pinInboundDecision).toHaveBeenCalledWith("wamid.in1", null);
  });

  it("does not pin messages from anyone but the recipient", async () => {
    vi.mocked(resolveCorrelationId).mockResolvedValue(null);
    await POST(signedRequest(payload({ ...textMessage, from: "19995551234" })));
    expect(pinInboundDecision).not.toHaveBeenCalled();
  });

  it("does not pin a message that has no id", async () => {
    vi.mocked(resolveCorrelationId).mockResolvedValue(null);
    await POST(signedRequest(payload({ from: SENDER, type: "text", text: { body: "hi" } })));
    expect(pinInboundDecision).not.toHaveBeenCalled();
  });

  it("schedules the callback as soon as the reply is stored, before later writes that can fail", async () => {
    vi.mocked(resolveCorrelationId).mockResolvedValue({ correlationId: "p2" });
    vi.mocked(markReplied).mockResolvedValue(replied("release-7"));
    vi.mocked(recordInbound).mockRejectedValueOnce(new Error("redis down"));
    await expect(POST(signedRequest(payload({ ...textMessage, timestamp: "1700000000" })))).rejects.toThrow("redis down");
    expect(afterTasks).toHaveLength(1);
  });
});

describe("POST /api/webhook inbox", () => {
  const deliver = (message: Record<string, unknown>) =>
    POST(signedRequest({ entry: [{ changes: [{ value: { messages: [message] } }] }] }));
  const base = { id: "wamid.in1", from: SENDER, timestamp: "1700000000" };

  beforeEach(() => {
    vi.mocked(resolveCorrelationId).mockResolvedValue(null);
  });

  it("stores a text message from the recipient", async () => {
    await deliver({ ...base, type: "text", text: { body: "ok got it" } });
    expect(addInboxMessage).toHaveBeenCalledWith({ id: "wamid.in1", type: "text", text: "ok got it", timestamp: 1_700_000_000_000 });
  });

  it("keeps which of our messages a swipe-reply answers", async () => {
    await deliver({ ...base, type: "text", text: { body: "yes" }, context: { id: "wamid.sent" } });
    expect(addInboxMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "yes", contextMessageId: "wamid.sent" }));
  });

  it("stores a reaction as its emoji, tied to the message it was left on", async () => {
    await deliver({ ...base, type: "reaction", reaction: { message_id: "wamid.sent", emoji: "👍" } });
    expect(addInboxMessage).toHaveBeenCalledWith({
      id: "wamid.in1",
      type: "reaction",
      text: "👍",
      timestamp: 1_700_000_000_000,
      contextMessageId: "wamid.sent",
    });
  });

  it("stores a button reply by its title", async () => {
    await deliver({ ...base, type: "interactive", interactive: { button_reply: { id: "approve:c1", title: "Approve" } } });
    expect(addInboxMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "interactive", text: "Approve" }));
  });

  it("stores a template quick-reply tap by its text", async () => {
    await deliver({ ...base, type: "button", button: { text: "Yes, continue", payload: "p1" }, context: { id: "wamid.sent" } });
    expect(addInboxMessage).toHaveBeenCalledWith({
      id: "wamid.in1",
      type: "button",
      text: "Yes, continue",
      timestamp: 1_700_000_000_000,
      contextMessageId: "wamid.sent",
    });
  });

  it.each([[{ message_id: "wamid.sent" }], [{ message_id: "wamid.sent", emoji: "" }]])(
    "does not store a removed reaction (no emoji): %j",
    async (reaction) => {
      await deliver({ ...base, type: "reaction", reaction });
      expect(addInboxMessage).not.toHaveBeenCalled();
    }
  );

  it("stores a non-text message by its type, with the caption if it has one", async () => {
    await deliver({ ...base, type: "image", image: { id: "media.1", caption: "look" } });
    await deliver({ ...base, id: "wamid.in2", type: "image", image: { id: "media.2" } });
    expect(addInboxMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: "image", text: "look" }));
    expect(addInboxMessage).toHaveBeenNthCalledWith(2, { id: "wamid.in2", type: "image", timestamp: 1_700_000_000_000 });
  });

  it("truncates a very long message", async () => {
    await deliver({ ...base, type: "text", text: { body: "x".repeat(5000) } });
    expect(vi.mocked(addInboxMessage).mock.calls[0][0].text).toHaveLength(1000);
  });

  it("does not store messages from anyone but the recipient", async () => {
    await deliver({ ...base, from: "19995551234", type: "text", text: { body: "spam" } });
    expect(addInboxMessage).not.toHaveBeenCalled();
  });

  it("does not store a message that has no id", async () => {
    await deliver({ from: SENDER, type: "text", timestamp: "1700000000", text: { body: "hi" } });
    expect(addInboxMessage).not.toHaveBeenCalled();
  });

  it("resolves the reply first and still fails the request if storing the message fails, so Meta retries", async () => {
    vi.mocked(resolveCorrelationId).mockResolvedValue({ correlationId: "c1" });
    vi.mocked(markReplied).mockResolvedValue({
      status: "replied",
      type: "prompt",
      whatsappMessageId: "wamid.p",
      createdAt: 1,
      value: "yes",
      receivedAt: 2,
    });
    vi.mocked(addInboxMessage).mockRejectedValueOnce(new Error("redis down"));
    await expect(deliver({ ...base, type: "text", text: { body: "yes" } })).rejects.toThrow("redis down");
    expect(markReplied).toHaveBeenCalled();
  });
});
