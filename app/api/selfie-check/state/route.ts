import { NextResponse } from "next/server";

import { buildState } from "@/lib/selfie-check/state";
import { readAccountId } from "@/lib/selfie-check/session";

/** Refresh the console after a mutation. */
export async function GET() {
  return NextResponse.json(buildState(await readAccountId()));
}
