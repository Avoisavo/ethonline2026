import {
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  type Client,
} from "@hashgraph/sdk";
import { getClient, getMirrorUrl, getOperatorKey } from "@/lib/hedera/client";

export interface CreateTopicOptions {
  memo?: string;
  /** Restrict submissions to the operator key. Without it, anyone may post. */
  restrictSubmit?: boolean;
  /** Allow the topic to be updated or deleted later. */
  adminKey?: boolean;
}

export interface CreatedTopic {
  topicId: string;
  transactionId: string;
}

export async function createTopic(
  options: CreateTopicOptions = {},
  client: Client = getClient()
): Promise<CreatedTopic> {
  const { memo, restrictSubmit = true, adminKey = true } = options;
  const operatorKey = getOperatorKey();

  const tx = new TopicCreateTransaction();
  if (memo) tx.setTopicMemo(memo);
  if (adminKey) tx.setAdminKey(operatorKey.publicKey);
  if (restrictSubmit) tx.setSubmitKey(operatorKey.publicKey);

  const response = await tx.execute(client);
  const receipt = await response.getReceipt(client);

  if (!receipt.topicId) {
    throw new Error("Topic creation returned no topic ID");
  }

  return {
    topicId: receipt.topicId.toString(),
    transactionId: response.transactionId.toString(),
  };
}

export interface SubmittedMessage {
  topicId: string;
  sequenceNumber: number;
  transactionId: string;
}

/**
 * Submit one message. Payloads over 1024 bytes are chunked by the SDK into
 * separate transactions and reassembled by the mirror node on read.
 */
export async function submitMessage(
  topicId: string,
  message: string | Uint8Array,
  client: Client = getClient()
): Promise<SubmittedMessage> {
  const response = await new TopicMessageSubmitTransaction()
    .setTopicId(topicId)
    .setMessage(message)
    .execute(client);

  const receipt = await response.getReceipt(client);

  return {
    topicId,
    sequenceNumber: receipt.topicSequenceNumber?.toNumber() ?? 0,
    transactionId: response.transactionId.toString(),
  };
}

/** Convenience wrapper for the common case of a JSON event payload. */
export async function submitJson(
  topicId: string,
  payload: unknown,
  client: Client = getClient()
): Promise<SubmittedMessage> {
  return submitMessage(topicId, JSON.stringify(payload), client);
}

export interface TopicMessage {
  sequenceNumber: number;
  consensusTimestamp: string;
  payerAccountId: string;
  /** Decoded JSON when the payload parses as JSON, otherwise the raw string. */
  contents: unknown;
}

interface MirrorTopicMessage {
  sequence_number: number;
  consensus_timestamp: string;
  message: string;
  payer_account_id: string;
}

/**
 * Read a topic's history from the mirror node. Consensus takes a few seconds
 * to propagate, so a message submitted moments ago may not appear yet.
 */
export async function readTopicMessages(
  topicId: string,
  { limit = 100, order = "asc" }: { limit?: number; order?: "asc" | "desc" } = {}
): Promise<TopicMessage[]> {
  const url = `${getMirrorUrl()}/api/v1/topics/${topicId}/messages?limit=${limit}&order=${order}`;
  const res = await fetch(url, { cache: "no-store" });

  if (!res.ok) {
    throw new Error(
      `Mirror node returned ${res.status} for topic ${topicId}: ${await res.text()}`
    );
  }

  const data: { messages?: MirrorTopicMessage[] } = await res.json();

  return (data.messages ?? []).map((msg) => {
    const decoded = Buffer.from(msg.message, "base64").toString("utf-8");
    let contents: unknown = decoded;
    try {
      contents = JSON.parse(decoded);
    } catch {
      // not JSON — keep the raw string
    }
    return {
      sequenceNumber: msg.sequence_number,
      consensusTimestamp: msg.consensus_timestamp,
      payerAccountId: msg.payer_account_id,
      contents,
    };
  });
}
