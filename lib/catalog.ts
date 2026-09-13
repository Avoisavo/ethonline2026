/** A tree is one domain × one harness × one model. */
export interface DomainOption { key: string; name: string }
export interface ModelOption { key: string; name: string; id: string }
export interface HarnessOption { key: string; name: string; note: string }

export const DOMAINS: DomainOption[] = [
  { key: "research", name: "Research" },
  { key: "coding", name: "Coding" },
  { key: "finance", name: "Finance" },
  { key: "security", name: "Security" },
  { key: "data-analysis", name: "Data analysis" },
];

export const MODELS: ModelOption[] = [
  { key: "claude-sonnet-5", name: "Claude Sonnet 5", id: "claude-sonnet-5" },
  { key: "claude-opus-5", name: "Claude Opus 5", id: "claude-opus-5" },
  { key: "claude-haiku-4-5", name: "Claude Haiku 4.5", id: "claude-haiku-4-5-20251001" },
  { key: "gpt-5", name: "GPT-5", id: "gpt-5" },
  { key: "gemini-2-5-pro", name: "Gemini 2.5 Pro", id: "gemini-2.5-pro" },
];

export const HARNESSES: HarnessOption[] = [
  { key: "hermes-agent", name: "Hermes Agent", note: "An open-source agent harness with tools, memory and skills." },
  { key: "claude-code", name: "Claude Code", note: "An agentic coding harness for the terminal." },
  { key: "pi", name: "Pi", note: "A minimal agent harness with a small tool set and a short system prompt." },
  { key: "codex-cli", name: "Codex CLI", note: "An open-source coding agent for the terminal." },
  { key: "openhands", name: "OpenHands", note: "An open-source platform for software agents." },
  { key: "aider", name: "Aider", note: "A terminal pair-programming harness that edits files in a git repo." },
  { key: "petri-harness-v1", name: "Petri harness v1", note: "The single-shot baseline in petri/harness." },
];

/** The directions a change can aim for. Shown on each line of the tree. */
export const OBJECTIVES = ["accuracy", "speed", "token savings", "security", "ethics", "code quality", "trust"];

export const DEFAULT_DOMAIN = "research";
export const DEFAULT_MODEL = "claude-sonnet-5";
export const DEFAULT_HARNESS = "hermes-agent";

export const slugOf = (domain: string, harness: string, model: string): string => `${domain}--${harness}--${model}`;

export function parseSlug(slug: string): { domain: DomainOption; harness: HarnessOption; model: ModelOption } | null {
  const [d, h, m] = slug.split("--");
  const domain = DOMAINS.find((x) => x.key === d);
  const harness = HARNESSES.find((x) => x.key === h);
  const model = MODELS.find((x) => x.key === m);
  return domain && harness && model ? { domain, harness, model } : null;
}
