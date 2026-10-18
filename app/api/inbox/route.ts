import { NextResponse } from "next/server";
import { requireApiKey } from "@/lib/auth";
import { listInboxMessages } from "@/lib/inbox";

export const runtime = "nodejs";

const MAX_LIMIT = 200;
const PHONE_NUMBER_PATTERN = /^\d{8,15}$/;

function parseInteger(value: string | null, fallback: number, min: number, max: number): number | null {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

export async function GET(request: Request): Promise<Response> {
  const authError = requireApiKey(request);
  if (authError) return authError;

  const params = new URL(request.url).searchParams;
  const since = parseInteger(params.get("since"), 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = parseInteger(params.get("limit"), 50, 1, MAX_LIMIT);
  const from = params.get("from") ?? undefined;
  if (since === null) return NextResponse.json({ error: "since must be a non-negative integer (epoch ms)" }, { status: 400 });
  if (limit === null) return NextResponse.json({ error: `limit must be an integer from 1 to ${MAX_LIMIT}` }, { status: 400 });

  if (from !== undefined && !PHONE_NUMBER_PATTERN.test(from)) {
    return NextResponse.json({ error: "from must be a number in digits only, e.g. 919876543210" }, { status: 400 });
  }

  return NextResponse.json({ messages: await listInboxMessages({ since, limit, from }) });
}
