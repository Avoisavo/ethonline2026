/**
 * Map a thrown error onto a JSON response. Missing-credential errors are the
 * caller's setup problem (503) rather than a bad request, and anything else
 * from the SDK is surfaced with its status so `INSUFFICIENT_PAYER_BALANCE` and
 * friends are readable at the client.
 */
export function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);

  // Domain errors carry their own status (unknown listing, oversold, ...).
  const status = (error as { status?: unknown })?.status;
  if (typeof status === "number") {
    return Response.json({ error: message }, { status });
  }

  if (message.startsWith("Missing ")) {
    return Response.json({ error: message }, { status: 503 });
  }

  console.error("[hcs]", error);
  return Response.json({ error: message }, { status: 500 });
}
