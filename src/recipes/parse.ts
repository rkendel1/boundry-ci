// Boundry Recipe parser. A recipe is a Markdown document a person can read without knowing CI:
//
//   # <What this recipe is for>
//   <optional sentence(s) describing the purpose>
//   ## When this happens      bullets: when to run
//   ## Make sure             bullets: outcomes to verify (run side by side)
//   ## Steps                 numbered list: things to do in order (after every "Make sure" passes)
//   ## Keep                  bullets: what to keep afterwards
//   ## Afterward             bullets: what to do when finished
//   ## About this project    bullets: facts Boundry should not guess (optional)
//   ## Custom checks         ### <name> + optional "Needs the internet." + one ```sh block (escape hatch)
//
// The parser only structures the document; meaning comes from the capability catalog (catalog.ts).

export type SectionName = "when" | "makeSure" | "steps" | "keep" | "afterward" | "project" | "custom";

export interface Line { text: string; line: number }
export interface CustomStep { name: string; line: number; needsInternet: boolean; script: string; kind: "check" }
export interface ParsedRecipe {
  title: string; titleLine: number; purpose: string;
  sections: Partial<Record<SectionName, Line[]>>;
  custom: CustomStep[];
  problems: { line: number; message: string }[];
}

const HEADINGS: Record<string, SectionName> = {
  "when this happens": "when", "when": "when", "run this when": "when",
  "make sure": "makeSure", "checks": "makeSure", "check that": "makeSure",
  "steps": "steps", "then": "steps", "do this": "steps",
  "keep": "keep", "keep afterwards": "keep",
  "afterward": "afterward", "afterwards": "afterward", "after": "afterward", "when finished": "afterward",
  "about this project": "project", "project": "project",
  "custom checks": "custom", "custom steps": "custom",
};

export function parseRecipe(source: string): ParsedRecipe {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: ParsedRecipe = { title: "", titleLine: 0, purpose: "", sections: {}, custom: [], problems: [] };
  let section: SectionName | null = null;
  const purpose: string[] = [];
  let custom: CustomStep | null = null;
  let fence: string[] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const n = i + 1;
    const t = raw.trim();
    if (fence) {
      if (/^```/.test(t)) {
        if (!custom) out.problems.push({ line: n, message: "a code block is only allowed inside a custom check" });
        else if (custom.script) out.problems.push({ line: n, message: `custom check "${custom.name}" has more than one code block` });
        else custom.script = fence.join("\n");
        fence = null;
      } else fence.push(raw);
      continue;
    }
    if (/^```/.test(t)) {
      if (!/^```(sh|bash|shell)?\s*$/.test(t)) out.problems.push({ line: n, message: "custom checks must use a ```sh code block" });
      fence = [];
      continue;
    }
    if (!t || /^<!--.*-->$/.test(t)) continue;
    let m: RegExpExecArray | null;
    if ((m = /^#\s+(.+)$/.exec(t))) {
      if (out.title) out.problems.push({ line: n, message: "a recipe has exactly one title (# …)" });
      else { out.title = m[1].trim(); out.titleLine = n; }
      section = null;
      continue;
    }
    if ((m = /^##\s+(.+?)\s*:?\s*$/.exec(t))) {
      const key = m[1].toLowerCase().replace(/[.:]+$/, "").trim();
      section = HEADINGS[key] ?? null;
      if (!section) out.problems.push({ line: n, message: `unknown section "${m[1]}" — use one of: When this happens, Make sure, Steps, Keep, Afterward, About this project, Custom checks` });
      else if (out.sections[section] && section !== "custom") out.problems.push({ line: n, message: `section "${m[1]}" appears twice` });
      else out.sections[section] ??= [];
      custom = null;
      continue;
    }
    if ((m = /^###\s+(.+)$/.exec(t))) {
      if (section !== "custom") { out.problems.push({ line: n, message: "### sub-headings are only used under Custom checks" }); continue; }
      custom = { name: m[1].trim(), line: n, needsInternet: false, script: "", kind: "check" };
      out.custom.push(custom);
      continue;
    }
    if (section === null) {
      if (!out.title) out.problems.push({ line: n, message: "start the recipe with a title line: # <what it is for>" });
      else purpose.push(t);
      continue;
    }
    if (section === "custom") {
      if (!custom) { out.problems.push({ line: n, message: "start each custom check with ### <name>" }); continue; }
      if (/^needs (the )?internet\.?$/i.test(t)) custom.needsInternet = true;
      else out.problems.push({ line: n, message: `in a custom check, only "Needs the internet." and one code block are understood` });
      continue;
    }
    if ((m = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(t))) {
      const isNumbered = /^\d/.test(t);
      if (section === "steps" && !isNumbered) out.problems.push({ line: n, message: "Steps are done in order: number them (1. 2. 3.)" });
      out.sections[section]!.push({ text: m[1].trim(), line: n });
      continue;
    }
    out.problems.push({ line: n, message: `write each item as a list entry ("- …"${section === "steps" ? ' or "1. …"' : ""})` });
  }
  if (fence) out.problems.push({ line: lines.length, message: "a code block is not closed (```)" });
  for (const c of out.custom) if (!c.script.trim()) out.problems.push({ line: c.line, message: `custom check "${c.name}" needs a \`\`\`sh code block` });
  if (!out.title) out.problems.push({ line: 1, message: "a recipe needs a title: # <what it is for>" });
  out.purpose = purpose.join(" ");
  return out;
}

/** Lowercase, collapse spaces, drop trailing punctuation and the articles a/an/the. Keeps `code` spans verbatim. */
export function normalize(s: string): string {
  const spans: string[] = [];
  const masked = s.replace(/`([^`]+)`/g, (_, c) => { spans.push(c); return `\u0000${spans.length - 1}\u0000`; });
  const n = masked.toLowerCase().replace(/[.!;]+\s*$/, "").replace(/[“”"]/g, "").replace(/’/g, "'").replace(/\b(the|a|an)\b/g, " ").replace(/\s+/g, " ").trim();
  return n.replace(/\u0000(\d+)\u0000/g, (_, i) => `\`${spans[Number(i)]}\``);
}
