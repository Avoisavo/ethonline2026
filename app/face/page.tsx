import type { Metadata } from "next";

import { readAccountId } from "@/lib/selfie-check/session";
import { buildState } from "@/lib/selfie-check/state";

import FaceConsole from "./face-console";

export const metadata: Metadata = {
  title: "Continuity Gate · Selfie Check",
  description:
    "Selfie Check used as a continuity and freshness signal for account recovery and high-value actions.",
};

export default async function FacePage() {
  // Server-render the first paint so the client never fetches on mount.
  const initialState = buildState(await readAccountId());
  return <FaceConsole initialState={initialState} />;
}
