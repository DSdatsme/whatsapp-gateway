import { afterEach, describe, expect, it } from "vitest";
import { getRecipientNumber, getRequiredEnv } from "@/lib/env";

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("getRequiredEnv", () => {
  it("returns the value when the env var is set", () => {
    process.env.SOME_VAR = "value";
    expect(getRequiredEnv("SOME_VAR")).toBe("value");
  });

  it("throws a clear error when the env var is missing", () => {
    delete process.env.SOME_VAR;
    expect(() => getRequiredEnv("SOME_VAR")).toThrow(/SOME_VAR/);
  });
});

describe("getRecipientNumber", () => {
  it.each([["+919819155838"], ["91 98191 55838"], ["+91-9819155838"], ["919819155838"]])(
    "returns digits only for %s, which is how WhatsApp reports the sender",
    (configured) => {
      process.env.WHATSAPP_RECIPIENT_NUMBER = configured;
      expect(getRecipientNumber()).toBe("919819155838");
    }
  );

  it("throws a clear error when the recipient number is missing", () => {
    delete process.env.WHATSAPP_RECIPIENT_NUMBER;
    expect(() => getRecipientNumber()).toThrow(/WHATSAPP_RECIPIENT_NUMBER/);
  });

  it.each([["+"], [" "], ["abc"], ["0091 98191 55838"], ["+1 (555) 123-4567 ext. 89"], ["12345"], ["+9198191558381234567"]])(
    "throws for a setting that isn't a real phone number (%j) instead of turning it into a different number",
    (configured) => {
      process.env.WHATSAPP_RECIPIENT_NUMBER = configured;
      expect(() => getRecipientNumber()).toThrow(/phone number with country code/);
    }
  );

  it("accepts the usual punctuation people write numbers with", () => {
    process.env.WHATSAPP_RECIPIENT_NUMBER = "+1 (555) 123-4567";
    expect(getRecipientNumber()).toBe("15551234567");
  });
});
