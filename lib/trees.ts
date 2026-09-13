import { DOMAINS, HARNESSES, MODELS, slugOf, type DomainOption, type HarnessOption, type ModelOption } from "./catalog";
import { buildShowcaseTree, SHOWCASE_TREES } from "./showcase";
import { loadDigest, loadTree, type DigestResult } from "./tree";
import type { PetriExport } from "./types";

/** A domain × harness × model that has a tree. The model is fixed; the harness evolves. */
export interface TreeEntry {
  slug: string;
  domain: DomainOption;
  model: ModelOption;
  harness: HarnessOption;
  goal: string;
  source: "real" | "showcase";
  showcaseKey?: string;
}

const pick = <T extends { key: string }>(list: T[], key: string): T => list.find((x) => x.key === key)!;
const entry = (domain: string, harness: string, model: string, goal: string, source: "real" | "showcase", showcaseKey?: string): TreeEntry => ({
  slug: slugOf(domain, harness, model),
  domain: pick(DOMAINS, domain), harness: pick(HARNESSES, harness), model: pick(MODELS, model),
  goal, source, ...(showcaseKey ? { showcaseKey } : {}),
});

export const TREES: TreeEntry[] = [
  entry("research", "hermes-agent", "claude-sonnet-5", "Solve more of 40 research tasks", "showcase", "hermes"),
  entry("coding", "claude-code", "claude-opus-5", "Solve more of 40 coding tasks", "showcase", "claudeCode"),
  entry("coding", "petri-harness-v1", "claude-sonnet-5", "Solve more of 20 coding tasks", "real"),
  entry("finance", "pi", "claude-haiku-4-5", "Solve more of 20 finance analysis tasks", "showcase", "pi"),
  entry("security", "codex-cli", "gpt-5", "Find more of 40 planted vulnerabilities", "showcase", "codex"),
  entry("data-analysis", "openhands", "gemini-2-5-pro", "Solve more of 40 data analysis tasks", "showcase", "openhands"),
];

export const findTree = (slug: string): TreeEntry | undefined => TREES.find((t) => t.slug === slug);

export type TreeLoad =
  | { ok: true; entry: TreeEntry; data: PetriExport; digest: DigestResult | null }
  | { ok: false; entry: TreeEntry; error: string; root: string };

export async function loadTreeEntry(e: TreeEntry, withDigest = false): Promise<TreeLoad> {
  if (e.source === "showcase") return { ok: true, entry: e, data: buildShowcaseTree(SHOWCASE_TREES[e.showcaseKey!]!), digest: null };
  const [tree, digest] = await Promise.all([loadTree(), withDigest ? loadDigest() : Promise.resolve(null)]);
  return tree.ok
    ? { ok: true, entry: e, data: tree.data, digest }
    : { ok: false, entry: e, error: tree.error, root: tree.root };
}
