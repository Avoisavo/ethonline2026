import { defineConfig, configVariable } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";
// Load env so configVariable() can read ARC_PRIVATE_KEY. Hardhat 3 reads config variables from
// env vars by default but does NOT auto-load .env — and the key may live in hardhat/arc/.env OR the
// project-root .env.local (two levels up), so load both (later calls don't override already-set vars).
import dotenv from "dotenv";
dotenv.config();                          // hardhat/arc/.env (cwd)
dotenv.config({ path: "../../.env.local" }); // project-root .env.local (two levels up)

export default defineConfig({
  plugins: [hardhatToolboxViem],
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
      arcTestnet: {
      type: "http",
      chainType: "l1",
      url: "https://rpc.testnet.arc.network",
      chainId: 5042002,
      accounts: [configVariable("ARC_PRIVATE_KEY")],
    },
  },
});
