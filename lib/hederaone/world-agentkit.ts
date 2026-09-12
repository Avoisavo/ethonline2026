import { createAgentBookVerifier } from "@worldcoin/agentkit";

export const WORLD_CHAIN_ID = "eip155:480";

let verifier: ReturnType<typeof createAgentBookVerifier> | null = null;

export function getAgentBookVerifier() {
  if (!verifier) {
    verifier = createAgentBookVerifier({
      rpcUrl: "https://worldchain-mainnet.g.alchemy.com/public",
    });
  }
  return verifier;
}

export async function checkAgentHuman(address: string): Promise<string | null> {
  const v = getAgentBookVerifier();
  return v.lookupHuman(address.trim());
}
