import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/inbox", () => ({
  listInboxMessages: vi.fn(async () => []),
}));

import { GET } from "@/app/api/inbox/route";
import { listInboxMessages } from "@/lib/inbox";

beforeEach(() => {
  process.env.GATEWAY_API_KEY = "test-key";
  vi.clearAllMocks();
});

function request(query = "", apiKey = "test-key") {
  return new Request(`https://gateway.example/api/inbox${query}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
}

describe("GET /api/inbox", () => {
  it("rejects an unauthenticated request without reading anything", async () => {
    const res = await GET(request("", "wrong-key"));
    expect(res.status).toBe(401);
    expect(listInboxMessages).not.toHaveBeenCalled();
  });

  it("returns the recent messages, with sensible defaults", async () => {
    const messages = [{ id: "m1", type: "text", text: "ok", timestamp: 1_700_000_000_000 }];
    vi.mocked(listInboxMessages).mockResolvedValueOnce(messages);
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages });
    expect(listInboxMessages).toHaveBeenCalledWith({ since: 0, limit: 50 });
  });

  it("passes `since` and `limit` through", async () => {
    await GET(request("?since=1700000000000&limit=5"));
    expect(listInboxMessages).toHaveBeenCalledWith({ since: 1_700_000_000_000, limit: 5 });
  });

  it("returns a watched number's messages when asked for that number", async () => {
    await GET(request("?from=919876543210"));
    expect(listInboxMessages).toHaveBeenCalledWith({ since: 0, limit: 50, from: "919876543210" });
  });

  it.each([["from=abc"], ["from=123"], ["from=%2B919876543210"]])("rejects an invalid number (%s) with a 400", async (query) => {
    const res = await GET(request(`?${query}`));
    expect(res.status).toBe(400);
    expect(listInboxMessages).not.toHaveBeenCalled();
  });

  it.each([["since=abc"], ["since=-5"], ["since=1.5"], ["limit=0"], ["limit=201"], ["limit=x"]])(
    "rejects an invalid query (%s) with a 400",
    async (query) => {
      const res = await GET(request(`?${query}`));
      expect(res.status).toBe(400);
      expect(listInboxMessages).not.toHaveBeenCalled();
    }
  );
});
