// lib/agentbook.ts — server/CLI-side. Register an agent's EVM address in World AgentBook via the
// @worldcoin/agentkit-cli; return the verification link (render it as a QR), then poll until registered.
import { spawn } from "child_process";
import { checkAgentHuman } from "./world-agentkit";

const VERIFY_LINK = /https:\/\/world\.org\/verify\?[^\s"']+/;

/** Run `agentkit register <address>` and resolve with the World App verification link it prints (or null).
 *  Pass { echo: true } (CLI) to stream the agentkit-cli's own output straight to the terminal. */
export function getAgentBookVerifyLink(address: string, opts: { echo?: boolean } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let p;
    try {
      p = spawn("npx", ["--yes", "@worldcoin/agentkit-cli", "register", address], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return finish(null);
    }
    let out = "";
    const onData = (d: Buffer) => {
      if (opts.echo) process.stdout.write(d); // show the agentkit-cli output directly
      out += d.toString();
      const m = out.match(VERIFY_LINK);
      if (m) finish(m[0]);
    };
    p.stdout?.on("data", onData);
    p.stderr?.on("data", onData);
    p.on("close", () => finish(null));
    p.on("error", () => finish(null));
    setTimeout(() => finish(null), 60_000); // don't hang forever waiting for the link
  });
}

/** Poll AgentBook until the address resolves to a human (registered) or the timeout elapses. */
export async function pollAgentBook(address: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<string | null> {
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
  const intervalMs = opts.intervalMs ?? 3000;
  while (Date.now() < deadline) {
    try {
      const h = await checkAgentHuman(address);
      if (h) return h;
    } catch {
      /* ignore transient RPC errors */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}
