import { NextResponse } from "next/server";

import { accountCookie, resolveAccountId } from "@/lib/selfie-check/session";
import { resetAccount } from "@/lib/selfie-check/store";

/** Clear the anchor, the nullifier history and the event log. */
export async function POST() {
  const { id, isNew } = await resolveAccountId();
  resetAccount(id);
  const res = NextResponse.json({ ok: true });
  if (isNew) res.cookies.set(accountCookie(id));
  return res;
}
