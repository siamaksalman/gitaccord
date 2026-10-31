// Git hooks for agent coordination (spike).
// Agents use plain git; these hooks surface other agents' plans, reasoning and
// notes in the normal git output, and enforce the protocol at the moments git
// already offers: commit, merge and push.
//
// Conventions (all stock git):
//   branch  agent/<name>                     one branch per agent
//   file    .agents/plans/<name>.md          the agent's plan, on its own branch
//   file    .agents/notes/<from>-to-<to>.md  messages to other agents
//   file    .agents/allowed_signers          (on main, optional) agent signing keys
//   trailer Why: ...                         reasoning in every commit message
//   author  <name>@agents.local              agent identity
//
// Hooks:
//   pre-commit   reject conflict markers; reject code before the plan is committed
//   commit-msg   reject agent commits without a Why: line
//   post-commit  show overlaps with other agents (including ones already on main)
//   post-merge   show whose work was just merged in, with their reasoning
//   pre-push     landing on main: reject conflict markers, and overlaps with
//                another agent that have no recorded agreement or note
//
// With an `origin` remote (agents on different machines), post-commit pushes the
// agent's branch in the background and fetches other agents' branches.
// Every run is logged to <git-common-dir>/agentsync/log.jsonl for metrics.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const started = performance.now();

function git(...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : "";
}
// ---- content-addressed cache -----------------------------------------------
// Every branch name is resolved to its commit id once per hook run. Lookups that
// then depend only on commit ids (plans, notes, signatures, "is it landed") can't
// change, so their results are cached on disk across hook runs: only agents that
// moved since the last run cost any git calls.

const refShas = new Map<string, string>();
function loadRefs(): void {
  refShas.clear();
  for (const l of git("for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads", "refs/remotes").split("\n")) {
    const [name, sha] = l.split(" ");
    if (name && sha) refShas.set(name, sha);
  }
  const head = git("rev-parse", "-q", "--verify", "HEAD");
  if (head) refShas.set("HEAD", head);
}
// Replace a leading branch name in an argument ("agent/a", "agent/a:path", "^main").
function pin(arg: string): string {
  const m = arg.match(/^(\^?)([^:]+)(:.*)?$/);
  if (!m || !refShas.has(m[2])) return arg;
  return `${m[1]}${refShas.get(m[2])}${m[3] ?? ""}`;
}

let cache: Record<string, string> | null = null;
let cacheDirty = false;
const CACHEABLE = new Set(["log", "ls-tree", "rev-parse", "cat-file", "merge-base"]);
const SYMBOLIC = /(^|\^|\.\.)(agent\/|origin\/|main($|:|\^)|HEAD|ORIG_HEAD)/;
const runMemo = new Map<string, string>(); // within one hook run, for anything
function gitMemo(...args: string[]): string {
  const pinned = args.map(pin);
  const key = pinned.join("\0");
  if (runMemo.has(key)) return runMemo.get(key)!;
  cache ??= loadJson<Record<string, string>>("cache.json", {});
  if (key in cache) return cache[key];
  const out = git(...pinned);
  runMemo.set(key, out);
  // Persist only when no symbolic ref is left after pinning (an unresolved ref,
  // e.g. one that doesn't exist yet, could change meaning later).
  if (CACHEABLE.has(args[0]) && !pinned.some((a) => SYMBOLIC.test(a))) {
    cache[key] = out;
    cacheDirty = true;
  }
  return out;
}
function cachedOk(args: string[]): boolean {
  const pinned = args.map(pin);
  const key = `ok\0${pinned.join("\0")}`;
  cache ??= loadJson<Record<string, string>>("cache.json", {});
  if (key in cache) return cache[key] === "1";
  const ok = gitOk(...pinned);
  if (!pinned.some((a) => SYMBOLIC.test(a))) {
    cache[key] = ok ? "1" : "0";
    cacheDirty = true;
  }
  return ok;
}
function saveCache(): void {
  if (!cache || !cacheDirty) return;
  const keys = Object.keys(cache);
  if (keys.length > 20000) for (const k of keys.slice(0, keys.length - 10000)) delete cache[k];
  const tmp = join(stateDir, `cache.json.${process.pid}`);
  writeFileSync(tmp, JSON.stringify(cache));
  renameSync(tmp, join(stateDir, "cache.json")); // atomic: concurrent hooks never see a torn file
}
function gitOk(...args: string[]): boolean {
  return Bun.spawnSync(["git", ...args], { stderr: "pipe" }).exitCode === 0;
}
const lines = (s: string) => s.split("\n").filter(Boolean);

const stateDir = join(git("rev-parse", "--path-format=absolute", "--git-common-dir"), "agentsync");
mkdirSync(stateDir, { recursive: true });
const remote = git("remote").split("\n").includes("origin");
const BASE = remote ? "origin/main" : "main";
const email = (agent: string) => `${agent}@agents.local`;

function currentAgent(): string | null {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  return branch.startsWith("agent/") ? branch.slice("agent/".length) : null;
}

// ---- remote sync -----------------------------------------------------------

function pushInBackground(me: string): void {
  // Detached shell so the commit never waits on the network.
  Bun.spawnSync(["sh", "-c", `git push -q --no-verify origin +HEAD:refs/heads/agent/${me} >/dev/null 2>&1 &`]);
}

function fetchRemote(force = false): void {
  if (!remote) return;
  const stamp = join(stateDir, "last-fetch");
  const last = existsSync(stamp) ? Number(readFileSync(stamp, "utf8")) : 0;
  if (!force && Date.now() - last < 15_000) return;
  writeFileSync(stamp, String(Date.now()));
  git("fetch", "-q", "origin", "+refs/heads/agent/*:refs/remotes/origin/agent/*", "+refs/heads/main:refs/remotes/origin/main");
  loadRefs();
}

// ---- agents ----------------------------------------------------------------

const agentRefPrefix = remote ? "refs/remotes/origin/agent/" : "refs/heads/agent/";
const agentShortPrefix = remote ? "origin/agent/" : "agent/";

// Every agent with a branch, plus every agent whose plan is already on main
// (its branch may be gone after landing).
function allAgents(): string[] {
  const fromRefs = [...refShas.keys()].filter((r) => r.startsWith(agentShortPrefix)).map((r) => r.slice(agentShortPrefix.length));
  const fromMain = lines(gitMemo("ls-tree", "--name-only", BASE, ".agents/plans/")).map((p) => p.replace(/^\.agents\/plans\/|\.md$/g, ""));
  return [...new Set([...fromRefs, ...fromMain])];
}

function refFor(agent: string): string {
  const ref = `${agentShortPrefix}${agent}`;
  return refShas.has(ref) ? ref : BASE;
}

const landedCache = new Map<string, boolean>();
function isLanded(agent: string): boolean {
  if (!landedCache.has(agent)) {
    const ref = refFor(agent);
    landedCache.set(agent, ref === BASE || cachedOk(["merge-base", "--is-ancestor", ref, BASE]));
  }
  return landedCache.get(agent)!;
}

// Where my branch started, remembered from the first time the hook saw it.
function forkPoint(me: string): string {
  const f = join(stateDir, `fork-${me}`);
  if (existsSync(f)) return readFileSync(f, "utf8").trim();
  const reflog = lines(git("reflog", "show", "--format=%H", `refs/heads/agent/${me}`));
  const fork = reflog.at(-1) && gitOk("merge-base", "--is-ancestor", reflog.at(-1)!, "HEAD")
    ? git("rev-parse", `${reflog.at(-1)}^{commit}`)
    : git("merge-base", "HEAD", BASE);
  // The oldest reflog entry may already be the agent's first commit; use its base on main.
  const base = git("merge-base", fork, BASE) || fork;
  writeFileSync(f, base);
  return base;
}

// ---- verification ----------------------------------------------------------

let signersFile: string | null | undefined;
function allowedSigners(): string | null {
  if (signersFile !== undefined) return signersFile;
  const content = git("show", `${BASE}:.agents/allowed_signers`);
  if (!content) return (signersFile = null);
  signersFile = join(tmpdir(), `agentsync-signers-${process.pid}`);
  writeFileSync(signersFile, content + "\n");
  return signersFile;
}

// Content on `ref` at `path` is trusted only if the last non-merge commit that
// changed it is signed by `author`'s registered key.
function verified(ref: string, path: string, author: string): boolean {
  const signers = allowedSigners();
  if (!signers) return true; // verification not enabled for this repo
  const commit = gitMemo("log", "-1", "--no-merges", "--format=%H", ref, "--", path);
  if (!commit) return false;
  // A commit's signature never changes, so results are cached across hook runs.
  const cache = loadJson<Record<string, string>>("signatures.json", {});
  if (!(commit in cache)) {
    cache[commit] = git("-c", `gpg.ssh.allowedSignersFile=${signers}`, "log", "-1", "--format=%G?%n%GS", commit);
    writeFileSync(join(stateDir, "signatures.json"), JSON.stringify(cache));
  }
  const [status, signer] = cache[commit].split("\n");
  return status === "G" && signer === email(author);
}

function loadJson<T>(name: string, fallback: T): T {
  const f = join(stateDir, name);
  try {
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}

// Files changed in each agent's own commits since `fork`, from one `git log`
// over every agent branch and main (instead of one call per agent).
const changedCache = new Map<string, Map<string, Set<string>>>();
function changedByAuthor(fork: string): Map<string, Set<string>> {
  if (changedCache.has(fork)) return changedCache.get(fork)!;
  const refs = [...refShas.keys()].filter((r) => r.startsWith(agentShortPrefix));
  const out = new Map<string, Set<string>>();
  const log = gitMemo("log", "--no-merges", "--format=%x01%ae", "--name-only", "HEAD", BASE, ...refs, `^${fork}`);
  for (const chunk of log.split("\x01").slice(1)) {
    const [author, ...files] = lines(chunk);
    const set = out.get(author) ?? new Set<string>();
    for (const f of files) if (!f.startsWith(".agents/")) set.add(f);
    out.set(author, set);
  }
  changedCache.set(fork, out);
  return out;
}

// ---- plans and overlap -----------------------------------------------------

// Entries under a "## <heading>" section of a plan, e.g. "- `src/task.ts` (why)".
function planSection(plan: string, heading: string): string[] {
  const out: string[] = [];
  let inSection = false;
  for (const line of plan.split("\n")) {
    if (line.startsWith("## ")) inSection = line.slice(3).trim().toLowerCase().startsWith(heading);
    else if (inSection && /^\s*[-*]\s+/.test(line)) out.push(line.replace(/^\s*[-*]\s+/, ""));
  }
  return out;
}
const planPaths = (plan: string, heading: string) =>
  planSection(plan, heading).map((e) => e.match(/^`?([^\s`]+)`?/)?.[1]).filter(Boolean) as string[];

interface AgentView {
  name: string;
  ref: string;
  landed: boolean;
  changed: Set<string>; // files changed in the agent's own commits since my fork point
  touches: Set<string>; // changed + planned
  dependsOn: Set<string>;
  plan: string;
  planBlob: string;
  planTrusted: boolean;
}

function view(agent: string, ref: string, fork: string): AgentView {
  const planPath = `.agents/plans/${agent}.md`;
  const planRef = gitMemo("rev-parse", "--verify", "-q", `${ref}:${planPath}`) ? ref : BASE;
  const planBlob = gitMemo("rev-parse", "--verify", "-q", `${planRef}:${planPath}`);
  const planTrusted = !planBlob || verified(planRef, planPath, agent);
  const plan = planBlob && planTrusted ? gitMemo("cat-file", "-p", planBlob) : "";
  // Only the agent's own commits count (by author), whether still on its branch or
  // already landed on main, so code it merged in from others isn't attributed to it.
  const changed = changedByAuthor(fork).get(email(agent)) ?? new Set<string>();
  return {
    name: agent,
    ref,
    landed: isLanded(agent),
    changed,
    touches: new Set([...planPaths(plan, "touches"), ...changed]),
    dependsOn: new Set(planPaths(plan, "depends")),
    plan,
    planBlob,
    planTrusted,
  };
}

const intersect = (a: Set<string>, b: Set<string>) => [...a].filter((x) => b.has(x));

function overlap(mine: AgentView, theirs: AgentView) {
  return {
    both: intersect(mine.touches, theirs.touches),
    iBreakThem: intersect(mine.touches, theirs.dependsOn),
    theyBreakMe: intersect(mine.dependsOn, theirs.touches),
  };
}

function reasoningLines(ref: string, agent: string, fork: string): string[] {
  return lines(git("log", "-4", "--no-merges", `--author=${email(agent)}`, "--format=%h %s%n  Why: %(trailers:key=Why,valueonly,separator=%x20)", ref, `^${fork}`))
    .map((l) => `    ${l}`);
}

// ---- show-once state -------------------------------------------------------

function loadShown(me: string): Set<string> {
  const f = join(stateDir, `shown-${me}.json`);
  return new Set(existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as string[]) : []);
}
function saveShown(me: string, shown: Set<string>): void {
  writeFileSync(join(stateDir, `shown-${me}.json`), JSON.stringify([...shown]));
}

function printBlock(title: string, body: string[], footer: string[]): number {
  if (!body.length) return 0;
  const out = ["", `════ ${title} ════`, ...body, ...footer, "═".repeat(title.length + 10), ""].join("\n");
  console.error(out);
  return out.length;
}

// ---- post-commit: overlaps -------------------------------------------------

function postCommit(): void {
  const me = currentAgent();
  if (!me) return;
  if (remote) {
    pushInBackground(me);
    fetchRemote();
  }
  const fork = forkPoint(me);
  const shown = loadShown(me);
  let bytes = 0;
  // A merge commit (e.g. resolving `git merge main`) also gets the integration notice.
  if (git("rev-list", "--parents", "-n", "1", "HEAD").split(" ").length > 2) bytes += integrationNotice(me, "HEAD^1", "HEAD^2", shown);

  const mine = view(me, "HEAD", fork);
  const out: string[] = [];
  const log = { overlapsWith: [] as string[], notesShown: 0, unverified: 0 };

  for (const other of allAgents().filter((a) => a !== me)) {
    const theirs = view(other, refFor(other), fork);
    const block: string[] = [];
    if (!theirs.planTrusted) {
      log.unverified++;
      const key = `unverified-plan:${theirs.planBlob}`;
      if (!shown.has(key)) {
        shown.add(key);
        block.push(`  WARNING: plan on ${theirs.ref} is not signed by ${other}'s registered key; ignoring it.`);
      }
    }
    const o = overlap(mine, theirs);
    const hasOverlap = o.both.length + o.iBreakThem.length + o.theyBreakMe.length > 0;
    if (hasOverlap) log.overlapsWith.push(other);
    const overlapKey = `overlap:${other}:${[...o.both, "|", ...o.iBreakThem, "|", ...o.theyBreakMe].join(",")}:${theirs.planBlob}:${theirs.landed}`;
    if (hasOverlap && !shown.has(overlapKey)) {
      shown.add(overlapKey);
      if (theirs.landed) block.push(`  ${other}'s work is ALREADY ON ${BASE}: when you merge it, keep their intent or agree a change with them.`);
      if (o.both.length) block.push(`  you are BOTH changing: ${o.both.join(", ")}`);
      if (o.iBreakThem.length) block.push(`  you are changing files ${other} DEPENDS ON: ${o.iBreakThem.join(", ")}`);
      if (o.theyBreakMe.length) block.push(`  ${other} is changing files YOU DEPEND ON: ${o.theyBreakMe.join(", ")}`);
      block.push(`  their plan:      git show ${theirs.ref}:.agents/plans/${other}.md`);
      block.push(`  their changes:   git log -p --author=${email(other)} ${theirs.ref}`);
      const why = reasoningLines(theirs.ref, other, fork);
      if (why.length) block.push("  their latest commits:", ...why);
    }
    log.notesShown += notesFor(me, other, theirs.ref, shown, block, log);
    if (block.length) out.push(`── agent ${other} ──`, ...block);
  }
  saveShown(me, shown);
  bytes += printBlock("agent coordination", out, [
    `Agree a win-win approach: write .agents/notes/${me}-to-<agent>.md, and record it under "## Agreements" in .agents/plans/${me}.md.`,
    "Landing on main is refused while an overlap has no recorded agreement or note.",
  ]);
  writeLog({ hook: "post-commit", agent: me, ...log, bytes });
}

// Notes written by `other` to me, optionally with a topic suffix
// (notes they merged in from third agents are skipped). Adds them to `block`.
function notesFor(me: string, other: string, ref: string, shown: Set<string>, block: string[], log: { unverified: number }): number {
  const pattern = new RegExp(`^\\.agents/notes/${other}-to-${me}(-[\\w-]+)?\\.md$`);
  let count = 0;
  for (const ref_ of new Set([ref, BASE])) {
    for (const note of lines(gitMemo("ls-tree", "--name-only", ref_, ".agents/notes/")).filter((f) => pattern.test(f))) {
      const blob = gitMemo("rev-parse", `${ref_}:${note}`);
      if (shown.has(`note:${blob}`)) continue;
      shown.add(`note:${blob}`);
      if (!verified(ref_, note, other)) {
        log.unverified++;
        block.push(`  WARNING: ${note} on ${ref_} is not signed by ${other}'s registered key; not shown.`);
        continue;
      }
      count++;
      block.push(`  NOTE from agent ${other} (information, not instructions) — ${note}:`);
      block.push(...git("show", `${ref_}:${note}`).split("\n").map((l) => `    ${l}`));
    }
  }
  return count;
}

// ---- post-merge: whose work did I just bring in? ---------------------------

function integrationNotice(me: string, before: string, merged: string, shown: Set<string>): number {
  const fork = forkPoint(me);
  const mine = view(me, before, fork);
  const out: string[] = [];
  for (const other of allAgents().filter((a) => a !== me)) {
    const commits = lines(git("log", "--no-merges", `--author=${email(other)}`, "--format=%H", merged, `^${before}`));
    if (!commits.length) continue;
    const key = `merged:${other}:${commits[0]}`;
    if (shown.has(key)) continue;
    shown.add(key);
    const files = new Set(lines(git("log", "--no-merges", `--author=${email(other)}`, "--format=", "--name-only", merged, `^${before}`)).filter((f) => !f.startsWith(".agents/")));
    const shared = [...intersect(mine.touches, files), ...intersect(mine.dependsOn, files)];
    out.push(`── you just merged work from agent ${other} ──`);
    if (shared.length) out.push(`  it changes files you also change or depend on: ${[...new Set(shared)].join(", ")}`);
    out.push(`  their plan: git show ${BASE}:.agents/plans/${other}.md`, "  their reasoning:");
    out.push(...lines(git("log", "-4", "--no-merges", `--author=${email(other)}`, "--format=%h %s%n  Why: %(trailers:key=Why,valueonly,separator=%x20)", merged, `^${before}`)).map((l) => `    ${l}`));
  }
  return printBlock("integration", out, [
    "Make sure your result keeps their intent. If you change how their work behaves, say so in a note",
    `to them and under "## Agreements" in .agents/plans/${me}.md (landing checks for it).`,
  ]);
}

function postMerge(): void {
  const me = currentAgent();
  if (!me) return;
  const shown = loadShown(me);
  const bytes = integrationNotice(me, "ORIG_HEAD", "HEAD", shown);
  saveShown(me, shown);
  writeLog({ hook: "post-merge", agent: me, bytes });
}

// ---- pre-commit: conflict markers, plan first ------------------------------

function preCommit(): void {
  const me = currentAgent();
  if (!me) return;
  const markers = lines(Bun.spawnSync(["git", "diff", "--cached", "--check"]).stdout.toString()).filter((l) => /conflict marker/.test(l));
  if (markers.length) reject("pre-commit", me, ["commit rejected: unresolved conflict markers are staged:", ...markers.map((l) => `  ${l}`), "Resolve them, then stage and commit again."]);
  if (existsSync(git("rev-parse", "--git-path", "MERGE_HEAD"))) return; // merges may proceed
  const code = lines(git("diff", "--cached", "--name-only")).filter((f) => !f.startsWith(".agents/"));
  if (code.length && !gitOk("cat-file", "-e", `HEAD:.agents/plans/${me}.md`)) {
    reject("pre-commit", me, [
      "commit rejected: commit your plan before any code, so other agents can see what you're about to do.",
      `  git restore --staged . && git add .agents/plans/${me}.md && git commit -m "Plan for ${me}" -m "Why: ..."`,
      "Then stage and commit your code.",
    ]);
  }
}

// ---- commit-msg: reasoning -------------------------------------------------

function commitMsg(file: string): void {
  const me = currentAgent();
  if (!me) return;
  if (existsSync(git("rev-parse", "--git-path", "MERGE_HEAD"))) return; // merges are exempt
  if (/^Why:\s*\S/m.test(readFileSync(file, "utf8"))) return;
  reject("commit-msg", me, [
    "commit rejected: agent commits must explain their reasoning.",
    "Add a trailer line at the end of the message, e.g.:",
    "  Why: <what you were trying to achieve and why this approach>",
  ]);
}

// ---- pre-push: landing gate ------------------------------------------------

function prePush(): void {
  const me = currentAgent();
  if (!me) return;
  const updates = lines(readFileSync(0, "utf8")).map((l) => l.split(" "));
  const landing = updates.find(([, , remoteRef]) => remoteRef === "refs/heads/main");
  if (!landing) return;
  const sha = landing[1];
  fetchRemote(true);

  const markers = lines(git("grep", "-n", "-E", "^(<<<<<<<|>>>>>>>)( |$)", sha, "--", ".", ":(exclude).agents"));
  if (markers.length) reject("pre-push", me, ["landing rejected: unresolved conflict markers:", ...markers.slice(0, 10).map((l) => `  ${l}`)]);

  const fork = forkPoint(me);
  const mine = view(me, sha, fork);
  const myPlan = git("show", `${sha}:.agents/plans/${me}.md`);
  const agreements = planSection(myPlan, "agreements");
  const myNotes = lines(git("ls-tree", "--name-only", sha, ".agents/notes/"));
  const missing: string[] = [];
  const overlapping: string[] = [];
  for (const other of allAgents().filter((a) => a !== me)) {
    const o = overlap(mine, view(other, refFor(other), fork));
    const files = [...new Set([...o.both, ...o.iBreakThem, ...o.theyBreakMe])];
    if (!files.length) continue;
    overlapping.push(other);
    const agreed = agreements.some((e) => new RegExp(`^\\**(agent\\s+)?${other}\\b`, "i").test(e.trim()));
    const noted = myNotes.some((n) => new RegExp(`^\\.agents/notes/${me}-to-${other}(-[\\w-]+)?\\.md$`).test(n));
    if (!agreed && !noted) missing.push(`  ${other}: overlapping on ${files.join(", ")} (their plan: git show ${refFor(other)}:.agents/plans/${other}.md)`);
  }
  if (missing.length) {
    reject("pre-push", me, [
      "landing rejected: your work overlaps with these agents, but nothing records how you settled it:",
      ...missing,
      `For each one, write .agents/notes/${me}-to-<agent>.md and add a line under "## Agreements" in`,
      `.agents/plans/${me}.md, e.g. "- <agent>: <what you agreed or decided, and why>". Commit, then land again.`,
      "If you had to override their intent, say so plainly: it will be reviewed.",
    ]);
  }

  // Agreement or override? A note can't prove it, but tests can: each overlapping
  // agent's own tests (their version) must still pass on what I'm landing, unless I
  // declared an explicit Override for them. Their agreement lines don't exempt me:
  // in the spike, an agent's plan said "if b adds compact mode, the default stays
  // pretty", and b then changed the default; a line written beforehand can't approve
  // a change made later.
  const overrides = overrideTargets(me, sha, fork, myPlan);
  const testCmd = projectTestCommand();

  // Every agent states its intent as a user-level acceptance test, so later agents
  // are checked against what users see, not just against internals (in the spike,
  // an agent kept a library default to pass another agent's unit tests while
  // changing the CLI default users actually get).
  if (testCmd && !lines(gitMemo("ls-tree", "-r", "--name-only", sha, "tests/acceptance/")).some((f) => f.startsWith(`tests/acceptance/${me}.`))) {
    reject("pre-push", me, [
      `landing rejected: add your acceptance test first: tests/acceptance/${me}.test.ts`,
      "It should use the program the way a user would (e.g. run the CLI) and check the behaviour",
      "you were asked to build. Other agents' landings are checked against it, so your intent",
      "survives their changes.",
    ], { missingAcceptance: true });
  }
  const broken: string[] = [];
  if (testCmd) {
    for (const other of overlapping) {
      if (overrides.has(other)) continue;
      // Only agents whose work is already in what I'm landing (landed on main, or
      // merged into my branch): otherwise their feature is simply absent here.
      const theirRef = refFor(other);
      if (!isLanded(other) && !cachedOk(["merge-base", "--is-ancestor", theirRef, sha])) continue;
      const theirTests = [...(changedByAuthor(fork).get(email(other)) ?? [])].filter(isTestFile);
      if (!theirTests.length) continue;
      const failure = runTheirTests(sha, theirRef, theirTests, testCmd);
      // Already failing on main (e.g. after an accepted override): not my change.
      if (failure && runTheirTests(pin(BASE), theirRef, theirTests, testCmd) === null) {
        broken.push(`  ${other}: their tests fail on what you're landing (${theirTests.join(", ")}):`, ...failure.map((l) => `    ${l}`));
      }
    }
  }
  if (broken.length) {
    reject("pre-push", me, [
      "landing rejected: your changes break other agents' work, judged by their own tests:",
      ...broken,
      "Either:",
      "  - keep their behaviour (adapt your code so their tests pass), or",
      `  - if you must change it (even with their agreement), add "Override: <agent> — <what you changed and why>" under`,
      `    "## Agreements" in .agents/plans/${me}.md. Overrides are always flagged for human review.`,
    ], { broken: true });
  }
  writeLog({ hook: "pre-push", agent: me, rejected: false, overrides: [...overrides] });
}

// Agents named in "Override: <agent>" lines in my plan or my own commit messages.
function overrideTargets(me: string, sha: string, fork: string, myPlan: string): Set<string> {
  const text = myPlan + "\n" + git("log", `--author=${email(me)}`, "--format=%B", sha, `^${fork}`);
  return new Set([...text.matchAll(/Override:\s*\**(?:agent\s+)?([\w-]+)/gi)].map((m) => m[1]));
}

function projectTestCommand(): string | undefined {
  try {
    return JSON.parse(gitMemo("show", `${BASE}:.agents/config.json`) || "{}").test;
  } catch {
    return undefined;
  }
}

const isTestFile = (f: string) => /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(f);

// Run `their` version of their test files against `sha` in a throwaway worktree.
// Returns the tail of the output on failure, or null when they pass.
function runTheirTests(sha: string, theirRef: string, tests: string[], testCmd: string): string[] | null {
  // Hooks run with GIT_DIR and friends set; a clean environment keeps these git
  // calls pointed at the throwaway worktree.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const tmp = join(tmpdir(), `agentsync-check-${process.pid}-${Date.now()}`);
  const run = (cmd: string[], cwd?: string) => Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const repoDir = git("rev-parse", "--show-toplevel");
  if (run(["git", "-C", repoDir, "worktree", "add", "-q", "--detach", tmp, sha]).exitCode !== 0) return null;
  try {
    const existing = tests.filter((f) => run(["git", "cat-file", "-e", `${pin(theirRef)}:${f}`], tmp).exitCode === 0);
    if (!existing.length) return null;
    run(["git", "checkout", pin(theirRef), "--", ...existing], tmp);
    const cmd = testCmd.includes("{files}") ? testCmd.replace("{files}", existing.join(" ")) : `${testCmd} ${existing.join(" ")}`;
    const r = run(["sh", "-c", cmd], tmp);
    if (r.exitCode === 0) return null;
    return (r.stdout.toString() + r.stderr.toString()).trim().split("\n").filter((l) => /fail|error|expect/i.test(l)).slice(0, 8);
  } finally {
    run(["git", "-C", repoDir, "worktree", "remove", "--force", tmp]);
  }
}

// ---- shared ----------------------------------------------------------------

function reject(hook: string, me: string, message: string[], extra: Record<string, unknown> = {}): never {
  writeLog({ hook, agent: me, rejected: true, ...extra });
  console.error(message.join("\n"));
  process.exit(1);
}

function writeLog(entry: Record<string, unknown>): void {
  saveCache();
  appendFileSync(
    join(stateDir, "log.jsonl"),
    JSON.stringify({ ts: Date.now(), ms: Math.round(performance.now() - started), ...entry }) + "\n",
  );
}

loadRefs();
const [hook, ...args] = process.argv.slice(2);
if (hook === "post-commit") postCommit();
else if (hook === "post-merge") postMerge();
else if (hook === "pre-commit") preCommit();
else if (hook === "commit-msg") commitMsg(args[0]);
else if (hook === "pre-push") prePush();
