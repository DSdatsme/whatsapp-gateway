import { afterEach, describe, expect, it } from "vitest";
import { getRequiredEnv } from "@/lib/env";

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
