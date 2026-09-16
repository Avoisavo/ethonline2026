import type { HederaRef, HederaTopic } from "./types";

/**
 * A HashScan link for one record on the Hedera topic.
 *
 * HashScan's transaction route takes a consensus timestamp ("1789462530.860350104").
 * Until `petri hedera check` has read that timestamp back from the mirror node,
 * the link opens the topic instead.
 */
export function hashscanRecordUrl(topic: HederaTopic, ref: HederaRef): string {
  return ref.timestamp
    ? `https://hashscan.io/${topic.network}/transaction/${ref.timestamp}`
    : `https://hashscan.io/${topic.network}/topic/${topic.topicId}`;
}

export const hashscanTopicUrl = (topic: HederaTopic): string =>
  `https://hashscan.io/${topic.network}/topic/${topic.topicId}`;
