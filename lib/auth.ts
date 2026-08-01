import { NextResponse } from "next/server";
import { getRequiredEnv } from "@/lib/env";

export function requireApiKey(request: Request): Response | null {
  const header = request.headers.get("authorization");
  const expected = `Bearer ${getRequiredEnv("GATEWAY_API_KEY")}`;
  if (header !== expected) {
    console.warn("Unauthorized request rejected: missing or invalid API key");
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
