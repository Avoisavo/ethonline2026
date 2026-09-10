import { NextResponse } from "next/server";

import { preflight } from "@/lib/selfie-check/preflight";

/** Probe the live integration and report what still needs configuring. */
export async function GET() {
  return NextResponse.json(await preflight());
}
