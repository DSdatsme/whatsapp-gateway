import { NextResponse } from "next/server";
import { requireApiKey } from "@/lib/auth";
import { getPendingRecord } from "@/lib/correlation";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ correlationId: string }> }
): Promise<Response> {
  const authError = requireApiKey(request);
  if (authError) return authError;

  const { correlationId } = await params;
  const record = await getPendingRecord(correlationId);

  if (!record) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (record.status === "pending") {
    return NextResponse.json({ status: "pending" });
  }
  return NextResponse.json({ status: "replied", value: record.value, receivedAt: record.receivedAt });
}
