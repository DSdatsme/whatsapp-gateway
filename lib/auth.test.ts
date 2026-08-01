import { beforeEach, describe, expect, it } from "vitest";
import { requireApiKey } from "@/lib/auth";

beforeEach(() => {
  process.env.GATEWAY_API_KEY = "test-key";
});

describe("requireApiKey", () => {
  it("allows a request with the correct bearer token", () => {
    const req = new Request("https://gateway.example/api/send", {
      headers: { authorization: "Bearer test-key" },
    });
    expect(requireApiKey(req)).toBeNull();
  });

  it("rejects a missing authorization header", () => {
    const req = new Request("https://gateway.example/api/send");
    expect(requireApiKey(req)?.status).toBe(401);
  });

  it("rejects an incorrect token", () => {
    const req = new Request("https://gateway.example/api/send", {
      headers: { authorization: "Bearer wrong-key" },
    });
    expect(requireApiKey(req)?.status).toBe(401);
  });
});
