// Guided authoring: from "check my application before merging" to a reviewable recipe, without writing code.
// Boundry inspects the repository, offers only checks that will actually work there, asks when something is
// ambiguous, and proves the result compiles before showing it. No LLM involved.
import { gatherFacts, type FileSource, type ProjectFacts, type Ecosystem } from "./facts.ts";
import { CAPABILITIES, SAY, toolchainFor, isUnsupported } from "./catalog.ts";
import { compileRecipeSource, RecipeError, type CompiledRecipe } from "./compile.ts";

export type Goal = "check" | "release";
export interface AuthorOptions {
  goal: Goal;
  dir?: string; // where the project lives (default: repository root)
  ecosystem?: Ecosystem; // answer to "which project is this recipe for?"
  outputs?: string[]; // answer to "where does the build put its output?"
  approver?: string; // release: who approves
  publishTo?: "npm"; // release: where to publish (opt-in only)
}
export interface Question { id: string; question: string; answers?: string[]; flag: string }
export interface Authored { recipe: string | null; questions: Question[]; notes: string[]; compiled: CompiledRecipe | null }

const CHECK_ORDER = ["check.builds", "check.tests", "check.types", "check.lint", "check.formatted", "check.dependencies"];

export async function authorRecipe(files: FileSource, o: AuthorOptions): Promise<Authored> {
  const dir = o.dir ?? ".";
  const facts = await gatherFacts(files, dir);
  const questions: Question[] = [];
  const notes: string[] = [];
  let eco = o.ecosystem ?? null;
  if (!eco) {
    if (facts.ecosystems.length === 1) eco = facts.ecosystems[0];
    else if (facts.ecosystems.length > 1) questions.push({ id: "ecosystem", question: `This repository has more than one kind of project (${facts.ecosystems.join(", ")}). Which one is this recipe for?`, answers: facts.ecosystems, flag: "--project <kind>" });
    else questions.push({ id: "dir", question: "I couldn't find a project here (no package.json, Cargo.toml, go.mod, pyproject.toml or requirements.txt). Which folder holds the application?", flag: "--dir <folder>" });
  }
  if (questions.length || !eco) return { recipe: null, questions, notes, compiled: null };
  if (eco === "node" && facts.ecosystems.includes("bun")) eco = "bun";

  const tc = toolchainFor(facts, eco);
  if (isUnsupported(tc)) return { recipe: null, questions, notes: [`Boundry can't build recipes for this project yet: ${tc.unsupported}`], compiled: null };

  // Offer exactly the checks that resolve for this project; say why the others are missing.
  const checks: string[] = [];
  for (const id of CHECK_ORDER) {
    const cap = CAPABILITIES.find((c) => c.id === id)!;
    const r = cap.implement!(facts, eco, tc);
    if (isUnsupported(r)) notes.push(`Not included — “${SAY[id]}”: ${r.unsupported}`);
    else checks.push(id);
  }
  if (!checks.length) return { recipe: null, questions, notes: [...notes, "There is nothing Boundry can check in this project yet."], compiled: null };

  const keepOutput = checks.includes("check.builds") && (eco === "rust" || (o.outputs?.length ?? 0) > 0);
  if (checks.includes("check.builds") && !keepOutput) {
    const guess = facts.node?.hints.main?.includes("/") ? facts.node.hints.main.split("/")[0] : null;
    questions.push({ id: "outputs", question: `Do you want to keep the build output? If so, where does the build put it${guess ? ` (perhaps \`${guess}\`)` : ""}?`, flag: "--output <folder>" });
  }

  const L: string[] = [];
  const title = o.goal === "check" ? "Check my changes" : "Prepare a release";
  L.push(`# ${title}`, "");
  L.push(o.goal === "check" ? "Make sure every proposed change is safe to merge." : "Turn an approved version into a verified, kept release package.", "");
  L.push("## When this happens");
  if (o.goal === "check") L.push("- Someone proposes a change.", "- The main branch is updated.");
  else L.push("- I start it.");
  L.push("", "## Make sure");
  const releaseChecks = o.goal === "release" ? checks.filter((c) => c === "check.tests" || c === "check.builds") : checks;
  for (const id of releaseChecks) L.push(`- ${SAY[id]}.`);
  if (o.goal === "release") {
    const canPackage = !isUnsupported(CAPABILITIES.find((c) => c.id === "step.package")!.implement!(facts, eco, tc));
    if (!canPackage) return { recipe: null, questions, notes: [...notes, "Packaging isn't available for this kind of project yet, so a release recipe can't be prepared."], compiled: null };
    L.push("", "## Steps", "1. Package the result.", "2. Verify the package.");
    if (o.publishTo === "npm") {
      if (!o.approver) return { recipe: null, questions: [...questions, { id: "approver", question: "Publishing needs a person to approve each release. Who?", flag: "--approver <name>" }], notes, compiled: null };
      L.push(`3. Ask ${o.approver} to approve the release.`, "4. Publish the package to npm.");
    }
  }
  L.push("", "## Keep");
  if (keepOutput && o.goal === "check") L.push("- The build output.");
  if (releaseChecks.includes("check.tests")) L.push("- The test results.");
  if (o.goal === "release") L.push("- The package.");
  L.push(`- ${o.goal === "release" ? "The release evidence" : "A record of what was checked"}.`);
  if (o.goal === "check") L.push("", "## Afterward", "- Report the result on the change.");
  const project: string[] = [];
  if (dir !== ".") project.push(`- The application is in \`${dir}\`.`);
  if (o.ecosystem) project.push(`- This is a ${o.ecosystem} project.`);
  if (keepOutput && eco !== "rust") project.push(`- The build output is in ${o.outputs!.map((p) => `\`${p}\``).join(" and ")}.`);
  if (project.length) L.push("", "## About this project", ...project);
  const recipe = L.join("\n") + "\n";

  // Prove it before handing it over.
  try {
    const compiled = await compileRecipeSource(recipe, `.boundry/recipes/${o.goal}.md`, files, null);
    return { recipe, questions, notes, compiled };
  } catch (e) {
    if (e instanceof RecipeError) return { recipe: null, questions, notes: [...notes, `Internal: the suggested recipe did not compile: ${e.message}`], compiled: null };
    throw e;
  }
}

export type { ProjectFacts };
