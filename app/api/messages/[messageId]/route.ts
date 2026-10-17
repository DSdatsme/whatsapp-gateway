import { NextResponse } from "next/server";
import { requireApiKey } from "@/lib/auth";
import { getMessageStatus } from "@/lib/message-status";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ messageId: string }> }
): Promise<Response> {
  const authError = requireApiKey(request);
  if (authError) return authError;

  const { messageId } = await params;
  const record = await getMessageStatus(messageId);

  if (!record) {
    return NextResponse.json(
      { error: "no delivery status for this message id (yet, or it expired)" },
      { status: 404 }
    );
  }
  return NextResponse.json(record);
}
