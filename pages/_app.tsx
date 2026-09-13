import "@/app/globals.css";
import type { AppProps } from "next/app";

// Loads Tailwind for the pages router (pages/arc, pages/hederaone, pages/hedera2 all use it).
export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
