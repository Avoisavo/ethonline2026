import "server-only";
import { cookies } from "next/headers";

import { newAccountId } from "./store";

/** Cookie that ties the browser to a demo account record. */
export const ACCOUNT_COOKIE = "sc_demo_account";

/** Read the demo account id, if the browser already has one. */
export async function readAccountId(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(ACCOUNT_COOKIE)?.value ?? null;
}

/**
 * Resolve the demo account id for a route handler, minting one when absent.
 * Returns the id plus the cookie the handler should set on its response.
 */
export async function resolveAccountId(): Promise<{
  id: string;
  isNew: boolean;
}> {
  const existing = await readAccountId();
  if (existing) return { id: existing, isNew: false };
  return { id: newAccountId(), isNew: true };
}

export function accountCookie(id: string) {
  return {
    name: ACCOUNT_COOKIE,
    value: id,
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  };
}
