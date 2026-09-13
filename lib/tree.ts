import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import snapshotDigest from "./snapshot/petri-digest.json";
import snapshotExport from "./snapshot/petri-export.json";
import type { PetriExport } from "./types";

const run = promisify(execFile);

/** The petri/ engine directory. `next dev` runs from the repo root. */
export const PETRI_ROOT = process.env.PETRI_ROOT ?? path.resolve(process.cwd(), "petri");

const TSX = path.join(PETRI_ROOT, "node_modules", ".bin", "tsx");

const petri = (args: string[]) =>
  run(TSX, ["src/cli/index.ts", ...args], {
    cwd: PETRI_ROOT,
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });

/**
 * Without the engine installed (Vercel installs only the root package, and
 * .petri/identity.json is never committed) the site serves the snapshot that
 * `npm run petri:snapshot` wrote from a real `petri export`. PETRI_SNAPSHOT=1 forces it.
 */
const snapshotMode = (): boolean => process.env.PETRI_SNAPSHOT === "1" || !existsSync(TSX);

const errorText = (e: unknown): string => {
  const err = e as { stderr?: string; message: string };
  return (err.stderr?.trim() || err.message).split("\n").slice(-12).join("\n");
};

export type LoadResult =
  | { ok: true; data: PetriExport }
  | { ok: false; error: string; root: string };

/**
 * Runs the real `petri export` and reads its JSON.
 * The UI never reads .petri/ itself and never recomputes a verdict:
 * evaluate() in src/policy/acceptance.ts stays the one source of truth.
 */
export async function loadTree(): Promise<LoadResult> {
  if (snapshotMode()) return { ok: true, data: snapshotExport as unknown as PetriExport };
  const out = path.join(os.tmpdir(), `petri-ui-${process.pid}-${Date.now()}.json`);
  try {
    await petri(["export", "--out", out]);
    const data = JSON.parse(await readFile(out, "utf8")) as PetriExport;
    if (data.protocol !== "petri/export/1") {
      return { ok: false, error: `Unexpected export protocol: ${String(data.protocol)}`, root: PETRI_ROOT };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: errorText(e), root: PETRI_ROOT };
  } finally {
    await rm(out, { force: true });
  }
}

export type DigestResult = { ok: true; text: string } | { ok: false; error: string };

/** The real `petri digest`: the page an agent reads before it proposes the next node. */
export async function loadDigest(): Promise<DigestResult> {
  if (snapshotMode()) return { ok: true, text: snapshotDigest.text };
  try {
    const { stdout } = await petri(["digest"]);
    const start = stdout.indexOf("# PETRI DIGEST");
    return { ok: true, text: (start >= 0 ? stdout.slice(start) : stdout).trimEnd() };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}
