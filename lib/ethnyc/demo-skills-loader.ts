// lib/demo-skills-loader.ts — SERVER-ONLY. Resolve a demo skill ref (a single file OR a
// Claude-Skill folder: SKILL.md + scripts/…) under demo/skills into one concatenated
// source blob. Folders read SKILL.md first, then the rest, each with a path header — so
// the poison in the description AND the exfil script both ride the task's `init`.
// Used by the /api/hedera createTask action and scripts/run-task.ts.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, basename } from "node:path";

const SKILL_TEXT_EXT = /\.(md|markdown|js|mjs|cjs|ts|json|py|txt|ya?ml|toml|sh)$/i;

export function loadDemoSkill(ref: string): { name: string; source: string; files: string[] } {
  const safe = basename(String(ref || "")).replace(/[^A-Za-z0-9._@-]/g, "");
  const root = join(process.cwd(), "demo", "skills");
  let target = "";
  for (const c of [safe, `${safe}.js`, `${safe}.json`, `${safe}.md`]) {
    const p = join(root, c);
    if (safe && existsSync(p)) { target = p; break; }
  }
  if (!target) return { name: safe.replace(/\.[^.]+$/, ""), source: "", files: [] };
  const name = basename(target).replace(/\.[^.]+$/, "");
  if (!statSync(target).isDirectory()) return { name, source: readFileSync(target, "utf8"), files: [basename(target)] };

  const files: { rel: string; content: string }[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      const s = statSync(p);
      if (s.isDirectory()) { if (f !== "node_modules") walk(p); }
      else if ((SKILL_TEXT_EXT.test(f) || f.toUpperCase() === "SKILL.MD") && s.size <= 200000) {
        files.push({ rel: relative(target, p), content: readFileSync(p, "utf8") });
      }
    }
  };
  walk(target);
  files.sort((a, b) => (a.rel === "SKILL.md" ? -1 : b.rel === "SKILL.md" ? 1 : a.rel.localeCompare(b.rel)));
  return { name, source: files.map((f) => `=== ${f.rel} ===\n${f.content}`).join("\n").slice(0, 8000), files: files.map((f) => f.rel) };
}
