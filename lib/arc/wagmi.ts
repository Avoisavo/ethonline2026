import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { arcTestnet } from "@/lib/arc/escrow";

// WalletConnect projectId — get a free one at https://cloud.reown.com and put it in
// .env.local as NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID. Injected wallets (MetaMask,
// Rabby, …) work without it; only the WalletConnect/mobile option needs a real id.
const projectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "ETHONLINE_ARC_DEMO";

export const wagmiConfig = getDefaultConfig({
  appName: "ethonlineArc",
  projectId,
  chains: [arcTestnet],
  ssr: true,
});
