import { NextResponse } from "next/server";
import { requireApiKey } from "@/lib/auth";
import { getWindowState } from "@/lib/window";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const authError = requireApiKey(request);
  if (authError) return authError;

  return NextResponse.json(await getWindowState());
}
