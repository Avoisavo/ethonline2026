import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// Canonical USDC on Arc (testnet & mainnet share this address). 6 decimals.
// This is the ERC-20 face of Arc's native USDC — the same balance the faucet funds.
const ARC_USDC = "0x3600000000000000000000000000000000000000";

export default buildModule("ethonlineArcModule", (m) => {
  const escrow = m.contract("ethonlineArc", [ARC_USDC]);
  return { escrow };
});
