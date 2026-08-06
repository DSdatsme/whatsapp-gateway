import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";
import { verifySignature } from "@/lib/signature";

const SECRET = "test-app-secret";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

describe("verifySignature", () => {
  it("accepts a correctly signed body", () => {
    const body = JSON.stringify({ hello: "world" });
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify({ hello: "world" });
    const tampered = JSON.stringify({ hello: "mallory" });
    expect(verifySignature(tampered, sign(body), SECRET)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifySignature("{}", null, SECRET)).toBe(false);
  });

  it("rejects a malformed signature header", () => {
    expect(verifySignature("{}", "not-a-signature", SECRET)).toBe(false);
  });

  it("rejects a well-formed but wrong-length signature without throwing", () => {
    expect(() => verifySignature("{}", "sha256=abcd", SECRET)).not.toThrow();
    expect(verifySignature("{}", "sha256=abcd", SECRET)).toBe(false);
  });
});
