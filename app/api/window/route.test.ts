import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/window", () => ({
  getWindowState: vi.fn(),
}));

import { GET } from "@/app/api/window/route";
import { getWindowState } from "@/lib/window";

beforeEach(() => {
  process.env.GATEWAY_API_KEY = "test-key";
  vi.clearAllMocks();
});

function request(apiKey = "test-key") {
  return new Request("https://gateway.example/api/window", {
    headers: { authorization: `Bearer ${apiKey}` },
  });
}

describe("GET /api/window", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await GET(request("wrong-key"));
    expect(res.status).toBe(401);
    expect(getWindowState).not.toHaveBeenCalled();
  });

  it("reports whether free-form messages can be delivered right now, and when that stops", async () => {
    vi.mocked(getWindowState).mockResolvedValue({ open: true, lastInboundAt: 1000, expiresAt: 2000 });
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ open: true, lastInboundAt: 1000, expiresAt: 2000 });
  });

  it("reports a closed, unknown window before anything has ever been received", async () => {
    vi.mocked(getWindowState).mockResolvedValue({ open: false, lastInboundAt: null, expiresAt: null });
    const res = await GET(request());
    expect(await res.json()).toEqual({ open: false, lastInboundAt: null, expiresAt: null });
  });
});
