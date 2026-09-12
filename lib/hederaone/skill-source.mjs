// Resolve a skill *reference* into its actual source files.
//
// A "skill" is a Claude Skill (a SKILL.md folder), an MCP server / tool
// manifest, or plain code — fetched live (npm / URL) or read from the local
// demo/skills folder (where we plant malicious examples for the demo).
//
//   resolveRemoteSkill("@modelcontextprotocol/server-filesystem")  → npm via unpkg
//   resolveRemoteSkill("https://…/SKILL.md")                       → raw URL
//   resolveLocalDemoSkill("poisoned-pdf-skill")                    → demo/skills/<name>
//   readLocalSkill("/path/to/skill-folder")                        → file or dir
//
// Returns { name, files: [{ name, content }] }.

import { basename, join, relative } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";

const MAX_FETCH = 200000; // chars per remote file
const MAX_FILE_BYTES = 200000;
const MAX_FILES = 40;
const TEXT_EXT = /\.(md|markdown|js|mjs|cjs|ts|tsx|json|py|txt|ya?ml|toml|sh|env|rb|go)$/i;
const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

// ── remote: npm package or raw URL ──────────────────────────────────────────
async function fetchText(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  let t = await res.text();
  if (t.length > MAX_FETCH) t = t.slice(0, MAX_FETCH) + "\n…[truncated]";
  return t;
}

function displayName(pkg) {
  const at = pkg.lastIndexOf("@");
  return at > 0 ? pkg.slice(0, at) : pkg;
}

async function resolveNpm(pkg) {
  const files = [];
  let manifest = null;
  try {
    const pj = await fetchText(`https://unpkg.com/${pkg}/package.json`);
    files.push({ name: "package.json", content: pj });
    try {
      manifest = JSON.parse(pj);
    } catch {
      /* keep raw */
    }
  } catch {
    /* no manifest reachable */
  }
  const candidates = [`https://unpkg.com/${pkg}`, `https://unpkg.com/${pkg}/index.js`, `https://unpkg.com/${pkg}/dist/index.js`];
  for (const url of candidates) {
    try {
      const content = await fetchText(url);
      const nm = manifest?.main ? basename(manifest.main) : basename(new URL(url).pathname) || "index.js";
      files.push({ name: nm || "index.js", content });
      break;
    } catch {
      /* try next */
    }
  }
  if (!files.length) throw new Error(`could not fetch npm package "${pkg}" from unpkg`);
  return { name: displayName(pkg), files };
}

// Generic filenames carry no identity, and these path segments are scaffolding — so a URL
// like .../src/everything/tools/index.ts should be named "everything", not "index".
const GENERIC_FILE = new Set(["index", "main", "mod", "init", "__init__", "server", "app", "cli", "default", "skill"]);
const SKIP_SEG = new Set(["tools", "src", "lib", "dist", "build", "server", "servers", "packages", "pkg", "bin", "app", "modules", "node_modules", "main", "master", "develop", "trunk", "blob", "tree", "raw", "refs", "heads"]);

/** Derive a meaningful skill name from a URL: the file (sans ext), or — when that's generic
 *  (index/main/server…) — the nearest meaningful directory; for github raw, fall back to the repo. */
function nameFromUrl(u, file) {
  let name = file.replace(/\.[^.]+$/i, "") || "skill";
  if (!GENERIC_FILE.has(name.toLowerCase())) return name;
  const parts = u.pathname.split("/").filter(Boolean); // [...dirs, file]
  for (let i = parts.length - 2; i >= 0; i--) {
    const seg = parts[i];
    if (seg && !SKIP_SEG.has(seg.toLowerCase()) && !GENERIC_FILE.has(seg.toLowerCase())) return seg;
  }
  // github raw → raw.githubusercontent.com/<owner>/<repo>/<branch>/… : use the repo
  if (u.hostname === "raw.githubusercontent.com" && parts[1]) return parts[1];
  return name;
}

export async function resolveRemoteSkill(skill) {
  const s = (skill || "").trim();
  if (!s) throw new Error("no skill given");
  if (/^https?:\/\//i.test(s)) {
    const content = await fetchText(s);
    const u = new URL(s);
    const file = basename(u.pathname) || "skill.txt";
    return { name: nameFromUrl(u, file), files: [{ name: file, content }] };
  }
  return resolveNpm(s);
}

// ── local: a Claude Skill folder / file (read recursively) ──────────────────
function walk(dir, base, acc) {
  for (const f of readdirSync(dir).sort()) {
    if (acc.length >= MAX_FILES) return;
    const p = join(dir, f);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!SKIP_DIR.has(f)) walk(p, base, acc);
    } else if ((TEXT_EXT.test(f) || f.toUpperCase() === "SKILL.MD") && st.size <= MAX_FILE_BYTES) {
      acc.push({ name: relative(base, p) || f, content: readFileSync(p, "utf8") });
    }
  }
}

export function readLocalSkill(target) {
  const st = statSync(target);
  if (st.isDirectory()) {
    const files = [];
    walk(target, target, files);
    if (!files.length) throw new Error(`no readable files in ${target}`);
    return { name: basename(target), files };
  }
  return {
    name: basename(target).replace(/\.[^.]+$/i, ""),
    files: [{ name: basename(target), content: readFileSync(target, "utf8") }],
  };
}

// demo/skills/<name>  (file or folder) — sanitized; returns null if absent.
export function resolveLocalDemoSkill(name) {
  const safe = basename(String(name || "")).replace(/[^A-Za-z0-9._@-]/g, "");
  if (!safe) return null;
  const root = join(process.cwd(), "demo/skills");
  for (const c of [safe, safe + ".js", safe + ".md", safe + ".json"]) {
    const p = join(root, c);
    if (existsSync(p)) return readLocalSkill(p);
  }
  return null;
}
