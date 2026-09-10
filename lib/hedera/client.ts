import { AccountId, Client, PrivateKey } from "@hashgraph/sdk";

export type HederaNetwork = "testnet" | "mainnet" | "previewnet";

/** Mirror node REST endpoints, keyed by network. */
export const MIRROR_URLS: Record<HederaNetwork, string> = {
  testnet: "https://testnet.mirrornode.hedera.com",
  mainnet: "https://mainnet-public.mirrornode.hedera.com",
  previewnet: "https://previewnet.mirrornode.hedera.com",
};

export function getNetwork(): HederaNetwork {
  const network = (process.env.HEDERA_NETWORK ?? "testnet") as HederaNetwork;
  if (!(network in MIRROR_URLS)) {
    throw new Error(
      `Unsupported HEDERA_NETWORK "${network}" — expected testnet, mainnet or previewnet`
    );
  }
  return network;
}

export function getMirrorUrl(): string {
  return MIRROR_URLS[getNetwork()];
}

/**
 * Operator key, parsed from env. Portal accounts hand out DER-encoded keys,
 * but raw hex shows up often enough that it is worth accepting both rather
 * than failing with an opaque parse error at the first transaction.
 */
export function getOperatorKey(): PrivateKey {
  const operatorKey = process.env.HEDERA_OPERATOR_KEY;
  if (!operatorKey) {
    throw new Error("Missing HEDERA_OPERATOR_KEY in environment variables");
  }

  const parsers = [
    PrivateKey.fromStringDer,
    PrivateKey.fromStringECDSA,
    PrivateKey.fromStringED25519,
  ];
  for (const parse of parsers) {
    try {
      return parse(operatorKey);
    } catch {
      // try the next encoding
    }
  }
  throw new Error(
    "HEDERA_OPERATOR_KEY is not a valid DER, ECDSA or ED25519 private key"
  );
}

/**
 * A client bound to the operator account. Every write in this module pays from
 * that account, so it must stay server-side — never import this from a client
 * component.
 */
export function getClient(): Client {
  const operatorId = process.env.HEDERA_OPERATOR_ID;
  if (!operatorId) {
    throw new Error("Missing HEDERA_OPERATOR_ID in environment variables");
  }

  return Client.forName(getNetwork()).setOperator(
    AccountId.fromString(operatorId),
    getOperatorKey()
  );
}
