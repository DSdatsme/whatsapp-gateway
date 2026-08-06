import { createHash, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { getRequiredEnv } from "@/lib/env";

function constantTimeEqual(a: string, b: string): boolean {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

export function requireApiKey(request: Request): Response | null {
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${getRequiredEnv("GATEWAY_API_KEY")}`;
  if (!constantTimeEqual(header, expected)) {
    console.warn("Unauthorized request rejected: missing or invalid API key");
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
