# gitaccord Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `gitaccord`: a single compiled binary that installs git hooks so AI
agents working in parallel on one machine see each other's plans, record
agreements, and can't land a change that breaks another agent's own tests unless
they declare an `Override:`.

**Architecture:** One Bun/TypeScript program, compiled with `bun build --compile`.
The binary has two kinds of entry point:
- `gitaccord hook <name>`, which every installed git hook execs;
- `gitaccord init`, which a human runs once per repo.

All repository reads go through one git layer. That layer pins branch names to
commit ids once per run, caches results keyed by commit id on disk, and reads blobs
in batches through `git cat-file --batch`. The hooks are thin modules over a shared
repo model: agents, plans, overlap and notices. This is a production rewrite of the
spike's `spike/hook/agentsync2.ts`, which is the reference behaviour.

**Tech Stack:** Bun ≥ 1.4 (runtime, `bun test`, `bun build --compile`), TypeScript,
git ≥ 2.38. No runtime npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-30-git-for-agents-design.md`. Phase 1 is
defined under "Phases". The reference implementation is `spike/hook/agentsync2.ts`
and `spike/protocol/AGENTS-v2.md`.

## Global Constraints

- Agents use stock git only. gitaccord adds no command that agents call. Only
  humans run `gitaccord init`.
- Conventions, exactly:
  - branch `agent/<name>`;
  - plan `.agents/plans/<name>.md`, with sections `## Goal`, `## Touches`,
    `## Depends on`, `## Agreements` and `## Next steps`;
  - notes `.agents/notes/<from>-to-<to>[-<topic>].md`;
  - direction `.agents/direction.md`;
  - config `.agents/config.json`;
  - acceptance test `tests/acceptance/<name>.test.*`;
  - a `Why:` line in every agent commit;
  - an `Override: <agent> — <what and why>` line, either under `## Agreements` or in
    a commit message.
- Agent names match `^[a-z0-9][a-z0-9-]{0,31}$`. Branches under `agent/` with any
  other name are ignored, with a one-line warning.
- Agent identity is the commit author email. `config.agentEmail` is a template,
  default `"{name}@agents.local"`. Identity is never read from shared repo config.
- Hooks are no-ops (exit 0, no output) on any branch not under `agent/`.
- The hook latency guardrail (G4): the p95 of each run's slowest hook call is
  ≤ 500 ms. Phase 1 acceptance measures it with 10 agents and 3 concurrent
  benchmark copies.
- Hook state lives under `<git-common-dir>/gitaccord/`: `cache.json`,
  `shown-<agent>.json`, `fork-<agent>`, `log.jsonl`. State-file writes are atomic
  (write a temp file, then `rename`).
- A hook must never fail because of its own state. A corrupt state file is treated
  as empty.
- Only `pre-commit`, `commit-msg` and `pre-push` may reject, and every rejection
  message names the exact fix.
- Out of scope for phase 1 (later phases of the spec): remote sync and multi-machine
  support, commit signing, adapters, and the human review view.

## Review Focus

These are the five failure modes the spec implies but that no task's tests would
otherwise exercise. Each one gets a test in the task that owns the code.

1. **A repo whose default branch isn't `main`** (for example `master`). `init`
   detects the default branch and writes it as `config.base`, and every hook uses
   it. → Task 7 and Task 9.
2. **A human committing on `main` or on a feature branch** while hooks are
   installed. Nothing is printed, nothing is rejected, and the commit takes no
   noticeable time. → Task 6.
3. **An agent name with regex-special characters** (`agent/c++`, `agent/a.b`). It's
   ignored with a warning, and it never crashes a hook or matches another agent's
   notes by accident. → Task 4.
4. **A corrupt or concurrently written `cache.json`** (truncated JSON, or two hooks
   writing at once). The hook treats it as empty and succeeds. → Task 2.
5. **The project test command is missing or can't start** (`config.test` absent, or
   the command isn't found). The override check is skipped with a one-line
   warning, landing isn't blocked forever, and no temporary worktree is left
   behind. → Task 8.

---

## File Structure

```
package.json                 name "gitaccord", bin, scripts: test, build, bench
tsconfig.json
src/
  cli.ts                     entry: `hook <name> [args]`, `init [options]`, `--version`
  config.ts                  load .agents/config.json (base, test, agentEmail) with defaults
  git/run.ts                 spawn git: run(), ok(); clean env for worktree subprocesses
  git/refs.ts                RefTable: load refs once, pin names to commit ids
  git/cache.ts               content-addressed persistent cache (cache.json)
  git/catfile.ts             batched blob reads via one `git cat-file --batch` process
  state.ts                   state dir, atomic JSON read/write, log.jsonl
  plan.ts                    plan parsing: sections, paths, agreements, Override targets
  repo.ts                    agents, refFor, isLanded, forkPoint, changedByAuthor
  overlap.ts                 AgentView, view(), overlap()
  notices.ts                 show-once set, coordination/integration block formatting
  testrun.ts                 run another agent's tests in a throwaway worktree
  hooks/pre-commit.ts
  hooks/commit-msg.ts
  hooks/post-commit.ts
  hooks/post-merge.ts
  hooks/pre-push.ts
  init.ts                    install hooks + templates + config
  templates/AGENTS.md        from spike/protocol/AGENTS-v2.md (renamed to gitaccord)
  templates/direction.md
tests/
  fixture.ts                 temp repos with agent worktrees, `as(agent)` git runner
  *.test.ts                  one per module/hook (named in each task)
bench/hook-latency.ts        G4 benchmark (Task 9)
```

---

### Task 1: Project scaffold, git runner and test fixture

**Files:**
- Create: `package.json`, `tsconfig.json`, `src/git/run.ts`, `src/cli.ts` (version only), `tests/fixture.ts`, `tests/fixture.test.ts`

**Interfaces:**
- Produces:
  - `run(args: string[], opts?: { cwd?: string; env?: Record<string,string>; input?: string }): { code: number; out: string; err: string }` and `ok(args, opts?): boolean`, in `src/git/run.ts`. `out` is trimmed stdout.
  - `cleanEnv(): Record<string,string>`: `process.env` without any `GIT_*` keys. Hooks run with `GIT_DIR` set, and child git processes in other worktrees must not inherit it.
  - `tests/fixture.ts`:
    - `makeRepo(opts?: { base?: string; hooks?: boolean; config?: object }): Repo`, where `Repo = { dir, git(...args), agent(name): Agent, cleanup() }`;
    - `Agent = { name, dir, git(...args): RunResult, write(path, content), commit(subject, why?): RunResult, land(): RunResult }`.
    - `Agent.git` runs with `GIT_AUTHOR_*`/`GIT_COMMITTER_*` set to `agent-<name>` / `<name>@agents.local`.
    - `land()` runs `git push . HEAD:<base>`.
    - With `hooks: true`, the repo's hooks exec `bun <repo-root>/src/cli.ts hook <name> "$@"`.
    - The main worktree is left detached so `<base>` can be pushed to.

- [ ] **Step 1: Write the failing test** `tests/fixture.test.ts`:
  - `makeRepo()` gives `git("rev-parse","--abbrev-ref","HEAD").out === "HEAD"` (detached);
  - `repo.agent("a").git("rev-parse","--abbrev-ref","HEAD").out === "agent/a"`;
  - after `a.write("x.txt","1"); a.commit("x")`, `a.git("log","-1","--format=%ae").out === "a@agents.local"`;
  - `a.land().code === 0`, and `repo.git("log","-1","--format=%s","main").out === "x"`.
- [ ] **Step 2: Run** `bun test tests/fixture.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `src/git/run.ts` and `tests/fixture.ts` as specified, using `Bun.spawnSync`. The fixture copies nothing: it seeds with a `README.md`, commits as `seed`, then `git checkout --detach`. `src/cli.ts` prints `gitaccord <version from package.json>` for `--version`.
- [ ] **Step 4: Run** `bun test`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat: scaffold gitaccord with git runner and repo test fixture"`.

### Task 2: Ref pinning and content-addressed cache

**Files:**
- Create: `src/state.ts`, `src/git/refs.ts`, `src/git/cache.ts`
- Test: `tests/cache.test.ts`

**Interfaces:**
- Consumes: `run`, `ok`, `makeRepo`.
- Produces:
  - `stateDir(): string`: absolute `<git-common-dir>/gitaccord`, created if missing.
  - `readJson<T>(name, fallback: T): T`. It never throws, and corrupt or missing files return `fallback`.
  - `writeJsonAtomic(name, value)`.
  - `appendLog(entry: object)`: one JSON line with `ts`, plus the `ms` elapsed since process start.
  - `class RefTable { load(): void; sha(name: string): string | undefined; pin(arg: string): string; names(prefix: string): string[] }`. `load()` is a single `git for-each-ref --format=%(refname:short) %(objectname) refs/heads refs/remotes` call plus `HEAD`.
  - `class Cache { constructor(refs: RefTable, base: string); get(args: string[]): string; ok(args: string[]): boolean; save(): void }`. `base` is `Config.base` (Task 4), and the persistence rule needs it.

- [ ] **Step 1: Write the failing tests** in `tests/cache.test.ts`:
  - `pin("agent/a")`, `pin("agent/a:.agents/plans/a.md")` and `pin("^main")` replace the leading name with the commit id and keep the suffix and prefix. `pin("src/x.ts")` is unchanged.
  - **Persistence:**
    - after `cache.get(["rev-parse","--verify","-q","agent/a:README.md"]); cache.save()`, a new `Cache` instance answers the same key without spawning git (assert via a spawn counter injected into `run`);
    - a lookup through a ref that doesn't exist (`agent/zz`) is **not** persisted;
    - after agent a commits, the next `RefTable.load()` produces a different key for `agent/a`, and the result reflects the new commit.
  - `ok(["merge-base","--is-ancestor","agent/a","main"])` is cached the same way.
  - **Review Focus 4:**
    - writing `{"truncated` into `cache.json` makes `new Cache(...).get(...)` return the right answer, and `save()` rewrites a valid file;
    - two processes calling `save()` concurrently (spawn two `bun -e` scripts) leave valid JSON behind.
  - **Pruning:** when the cache exceeds 20,000 entries, `save()` keeps the newest 10,000.
- [ ] **Step 2: Run** `bun test tests/cache.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the modules. Persistence rule, copied from the spike: a result is persisted only when the command is one of `log`, `ls-tree`, `rev-parse`, `cat-file` or `merge-base`, **and** no argument still matches `/(^|\^|\.\.)(agent\/|origin\/|<base>($|:|\^)|HEAD|ORIG_HEAD)/` after pinning, where `<base>` is the configured base branch. All results are also memoised in memory for the life of the process.
- [ ] **Step 4: Run** `bun test`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat: pin refs to commit ids and cache immutable git lookups"`.

### Task 3: Batched blob reads

**Files:**
- Create: `src/git/catfile.ts`
- Test: `tests/catfile.test.ts`

**Interfaces:**
- Consumes: `RefTable.pin`, `Cache`.
- Produces: `readBlobs(specs: string[]): Map<string, string | null>`. Each spec is `<rev>:<path>`; a missing object maps to `null`. One `git cat-file --batch` process serves the whole call. Results for pinned specs go through `Cache`.

- [ ] **Step 1: Write the failing test.** Read three specs (two existing files, one missing) and assert the contents and the `null`. Assert exactly one git process was spawned (spawn counter). Assert that a file containing a NUL byte and a multi-line file round-trip exactly.
- [ ] **Step 2: Run** `bun test tests/catfile.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Write all specs to stdin, newline-separated. Parse the `<sha> <type> <size>\n<content>\n` frames by byte length, not by lines. A frame of `<spec> missing` maps to `null`.
- [ ] **Step 4: Run** `bun test`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat: read many blobs through one cat-file batch process"`.

### Task 4: Plans, config and the repo model

**Files:**
- Create: `src/plan.ts`, `src/config.ts`, `src/repo.ts`
- Test: `tests/plan.test.ts`, `tests/repo.test.ts`

**Interfaces:**
- Consumes: `RefTable`, `Cache`, `readBlobs`, `readJson`, `writeJsonAtomic`.
- Produces:
  - In `plan.ts`:
    - `planSection(plan: string, heading: string): string[]`: the entries under `## <heading…>`, case-insensitive prefix match;
    - `planPaths(plan, heading): string[]`: the first token of each entry, backticks stripped;
    - `agreementNames(plan): Set<string>`: the agent names that start an `## Agreements` entry, including names listed like "a, c, d:";
    - `overrideTargets(text: string): Set<string>`, from `Override:\s*\**(?:agent\s+)?([a-z0-9-]+)`, case-insensitive.
  - In `config.ts`: `Config = { base: string; test?: string; agentEmail: string }` and `loadConfig(): Config`.
    - It reads `HEAD:.agents/config.json` with one uncached `run` call. That's agent branches inherit the file from the base branch, and the cache can't be built until `base` is known.
    - The defaults are `base: "main"` and `agentEmail: "{name}@agents.local"`.
    - Hooks build things in this order: `loadConfig()`, then `RefTable.load()`, then `new Cache(refs, cfg.base)`.
  - In `repo.ts`, `class RepoModel`:
    - `constructor(cfg, refs, cache)`;
    - `currentAgent(): string | null`;
    - `agents(): string[]`: the names from `agent/*` refs and from plans on the base branch, minus invalid names;
    - `refFor(agent): string`;
    - `isLanded(agent): boolean`;
    - `forkPoint(me): string`: from the oldest reflog entry of `agent/<me>`, merge-based against the base branch, and remembered in `fork-<me>`;
    - `changedByAuthor(fork): Map<email, Set<file>>`: one `git log --no-merges --format=%x01%ae --name-only HEAD <base> <agent refs…> ^<fork>`, excluding `.agents/`;
    - `email(agent): string`.

- [ ] **Step 1: Write the failing tests.**
  - `tests/plan.test.ts` uses fixed plan strings:
    - `planPaths` returns ``["src/a.ts","src/b.ts"]`` from ``- `src/a.ts` (why)`` and `- src/b.ts`;
    - `agreementNames` of `"## Agreements\n- b: kept\n- a, c, d: overlap only in cli.ts"` is `{b,a,c,d}`;
    - `overrideTargets("- Override: b — x\nOverride: **agent c** — y")` is `{b,c}`.
  - `tests/repo.test.ts` uses the fixture:
    - with agents a and b, `agents()` is `["a","b"]`;
    - after a lands, `isLanded("a")` is true;
    - `forkPoint("b")` is the seed commit, both before and after b merges main;
    - `changedByAuthor` attributes the files of a's commits to `a@agents.local` even after b merges a's branch, and leaves `.agents/` paths out.
  - **Review Focus 3:** creating `agent/c++` and `agent/a.b` (via `git branch`) leaves `agents()` unchanged and writes one warning line to stderr.
- [ ] **Step 2: Run** `bun test tests/plan.test.ts tests/repo.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the modules. Read plans with `readBlobs` (one batch for all agents). Every regex built from an agent name uses the validated name only, so no escaping is needed beyond the name rule.
- [ ] **Step 4: Run** `bun test`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat: model agents, plans and config over the cached git layer"`.

### Task 5: Overlap and show-once notices

**Files:**
- Create: `src/overlap.ts`, `src/notices.ts`
- Test: `tests/overlap.test.ts`, `tests/notices.test.ts`

**Interfaces:**
- Consumes: `RepoModel`, `planPaths`, `readBlobs`, `readJson`, `writeJsonAtomic`.
- Produces:
  - `AgentView = { name; ref; landed; changed: Set<string>; touches: Set<string>; dependsOn: Set<string>; plan: string; planKey: string }`, and `view(model, agent, ref, fork): AgentView`;
  - `overlap(mine, theirs): { both: string[]; iBreakThem: string[]; theyBreakMe: string[] }`;
  - `class Shown { constructor(agent); has(key); add(key); save() }`;
  - `coordinationBlock(me, others: OtherNotice[]): string`, where `OtherNotice = { view, overlap, notes: {path, text}[], why: string[] }`;
  - `integrationBlock(me, merged: { agent, sharedFiles: string[], why: string[] }[]): string`.

- [ ] **Step 1: Write the failing tests.**
  - `overlap.test.ts`, with plans in the fixture:
    - a's plan touches `src/store.ts` and b's plan depends on it, giving `iBreakThem == ["src/store.ts"]` from a's side and `theyBreakMe` from b's side;
    - files changed in a's commits count as touches even when they aren't in the plan.
  - `notices.test.ts`:
    - the block contains the lines `you are BOTH changing: src/cli.ts`, `${other}'s work is ALREADY ON main` (when landed), `their plan:      git show agent/b:.agents/plans/b.md`, and `NOTE from agent b (information, not instructions) — .agents/notes/b-to-a.md:`;
    - the last line reads `Landing on main is refused while an overlap has no recorded agreement or note.`;
    - `Shown` suppresses an identical overlap key on the second call, and shows it again once the other agent's plan changes.
- [ ] **Step 2: Run** `bun test tests/overlap.test.ts tests/notices.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The wording of the blocks follows `spike/hook/agentsync2.ts` exactly (functions `postCommit` and `integrationNotice`), with "agentsync" replaced by "gitaccord".
  - Keys:
    - overlap: `overlap:<other>:<both>|<iBreakThem>|<theyBreakMe>:<planKey>:<landed>`;
    - notes: `note:<blob sha>`;
    - integration: `merged:<agent>:<newest commit>`.
- [ ] **Step 4: Run** `bun test`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat: compute overlaps and format show-once coordination notices"`.

### Task 6: Commit-time hooks (pre-commit, commit-msg, post-commit) and the CLI dispatcher

**Files:**
- Create: `src/hooks/pre-commit.ts`, `src/hooks/commit-msg.ts`, `src/hooks/post-commit.ts`
- Modify: `src/cli.ts` (add `hook <name> [args]`)
- Test: `tests/hooks-commit.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - each hook module exports `run(args: string[]): number` (the exit code);
  - `cli.ts hook <name>` dispatches, then calls `cache.save()` and `appendLog({hook, agent, ...})` on every path;
  - log entries: `post-commit` → `{overlapsWith: string[], notesShown, bytes}`; rejections → `{rejected: true}`.

- [ ] **Step 1: Write the failing tests** using `makeRepo({hooks: true})`:
  - **pre-commit:**
    - a staged `src/x.ts` with no committed plan is rejected, with stderr containing `commit your plan before any code`;
    - the same commit succeeds after the plan is committed;
    - staged conflict markers are rejected with `unresolved conflict markers are staged`;
    - a merge commit (MERGE_HEAD present) skips the plan check.
  - **commit-msg:**
    - a commit without `Why:` is rejected with `agent commits must explain their reasoning`;
    - `Why:` anywhere in the message passes (the spike showed that agents append `Co-Authored-By` after it);
    - merges are exempt.
  - **post-commit:**
    - b commits a plan depending on a file a changed, and stderr shows the coordination block, with `ALREADY ON main` if a has landed;
    - a second empty commit shows nothing;
    - a note `.agents/notes/a-to-b-api.md` (topic suffix) is shown once.
    - **Override notification** (spec: "the overridden agent is notified if it's still active"): when a's plan on main contains `- Override: b — default is compact`, b's next commit shows `agent a declared an override of your work:` followed by that line, once.
  - **Review Focus 2:**
    - a commit on `main` or on branch `feature/x` produces empty stderr and exit 0 from all three hooks;
    - nothing is appended to `log.jsonl` for it.
- [ ] **Step 2: Run** `bun test tests/hooks-commit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the hooks, following `spike/hook/agentsync2.ts` (`preCommit`, `commitMsg`, `postCommit`). The rejection texts are copied verbatim from there.
- [ ] **Step 4: Run** `bun test`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat: commit-time hooks: plan first, Why lines, overlap notices"`.

### Task 7: post-merge integration notice

**Files:**
- Create: `src/hooks/post-merge.ts`
- Modify: `src/hooks/post-commit.ts` (call the integration notice when HEAD has two parents)
- Test: `tests/hooks-merge.test.ts`

**Interfaces:**
- Consumes: `integrationBlock`, `RepoModel.changedByAuthor`, `Shown`.
- Produces: `integrationNotice(model, me, before: string, merged: string, shown: Shown): number` (bytes printed), exported from `post-merge.ts`.

- [ ] **Step 1: Write the failing tests.**
  - a lands a change to `src/store.ts` with `Why: humans edit it`; b, which touches `src/store.ts`, runs `git merge main`, and stderr contains `you just merged work from agent a`, `it changes files you also change or depend on: src/store.ts` and `Why: humans edit it`.
  - The same notice appears when the merge conflicts and b concludes it with `git commit`. This runs through post-commit, because HEAD has two parents.
  - It isn't shown twice.
  - **Review Focus 1:** with `makeRepo({base: "master"})` and `config.base = "master"`, merging `master` produces the same notice.
- [ ] **Step 2: Run** `bun test tests/hooks-merge.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** following the spike's `integrationNotice` and `postMerge`, using `ORIG_HEAD..HEAD` for post-merge and `HEAD^1..HEAD^2` for merge commits.
- [ ] **Step 4: Run** `bun test`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat: show whose work a merge brought in, with their reasoning"`.

### Task 8: The landing gate (pre-push)

**Files:**
- Create: `src/hooks/pre-push.ts`, `src/testrun.ts`
- Test: `tests/hooks-push.test.ts`

**Interfaces:**
- Consumes: `RepoModel`, `view`, `overlap`, `planSection`, `agreementNames`, `overrideTargets`, `Config.test`, `cleanEnv`.
- Produces:
  - `runTheirTests(sha, theirRef, files: string[], testCmd: string): string[] | null`: the failing output lines, or `null` when the tests pass or can't run;
  - the pre-push log entry `{rejected, broken?, missingAcceptance?, overrides: string[]}`.

The gate applies only to pushes whose remote ref is `refs/heads/<base>`. It checks
the following in order, and the first failure rejects:
1. conflict markers in the pushed tree;
2. every overlapping agent has a `## Agreements` entry or a `<me>-to-<them>` note;
3. if `config.test` is set, `tests/acceptance/<me>.*` exists in the pushed tree;
4. if `config.test` is set, for each overlapping agent **not** named in an
   `Override:` line, whose work is landed or is an ancestor of the pushed commit, and
   who has test files among its own changes: their tests, in their version, pass on
   the pushed commit, unless they already fail on the base branch.

- [ ] **Step 1: Write the failing tests.** Port `spike/test-override.sh` into `bun test` cases with the same scenario: b's greeting `"hello"` plus its test; d unlanded; a changes the greeting to `"hi"` and rewrites b's test; c lands a compatible change.
  - b is refused without `tests/acceptance/b.test.ts`, with the message `add your acceptance test first`.
  - a, with only a note plus b's earlier agreement line, is refused with `b: their tests fail`.
  - a lands after adding `- Override: b — …`, and the log entry has `overrides: ["b"]`.
  - c lands: b's test already fails on main, and d is unlanded.
  - Pushing a missing agreement is refused with `nothing records how you settled it`, and lands once the `## Agreements` line exists.
  - A push to a non-base ref (`git push . HEAD:refs/heads/scratch`) is never gated.
  - **Review Focus 5:**
    - with `config.test` set to `does-not-exist {files}`, landing proceeds, stderr has the one line `gitaccord: test command could not run; override check skipped`, and `git worktree list` shows no leftover worktree;
    - with `config.test` unset, steps 3 and 4 are skipped silently.
- [ ] **Step 2: Run** `bun test tests/hooks-push.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, following the spike's `prePush`, `overrideTargets`, `projectTestCommand` and `runTheirTests`.
  - The rejection texts are copied verbatim from `spike/hook/agentsync2.ts`.
  - `runTheirTests` adds a throwaway worktree with `git worktree add --detach` under the OS temp dir, using `cleanEnv()`, and removes it in a `finally`.
  - A spawn error, or exit code 127 from `sh -c`, counts as "couldn't run", and returns `null` with the warning.
- [ ] **Step 4: Run** `bun test`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat: landing gate with agreements, acceptance tests and override check"`.

### Task 9: `gitaccord init`, the compiled binary and the latency benchmark

**Files:**
- Create: `src/init.ts`, `src/templates/AGENTS.md`, `src/templates/direction.md`, `bench/hook-latency.ts`
- Modify: `src/cli.ts` (add `init`), `package.json` (scripts `build`: `bun build --compile src/cli.ts --outfile dist/gitaccord`, and `bench`)
- Test: `tests/init.test.ts`

**Interfaces:**
- Produces: `init(dir: string, opts: { test?: string; force?: boolean; binary: string }): { installed: string[]; wrote: string[]; skipped: string[] }`.
- The CLI:
  - `gitaccord init [--test "<cmd {files}>"] [--force]`, run in a repo, prints what it installed and wrote, and exits non-zero outside a git repo with `gitaccord init: not a git repository`.
  - It installs five hooks, each `#!/bin/sh\nexec "<absolute binary path>" hook <name> "$@"`.
  - It refuses to overwrite an existing non-gitaccord hook without `--force`, naming it.
  - It writes `.agents/config.json` with the detected `base`, which comes from `git symbolic-ref --short refs/remotes/origin/HEAD` and otherwise the current branch, plus `test` if given.
  - It writes `AGENTS.md`, `CLAUDE.md` (containing `@AGENTS.md`) and `.agents/direction.md` only if they're absent.
  - It's idempotent.

- [ ] **Step 1: Write the failing tests.**
  - `init` in a fresh repo installs the 5 hooks and writes the 4 files.
  - A second run reports everything as `skipped` and changes nothing (compare file mtimes).
  - An existing custom `pre-commit` is left alone and reported, and `--force` replaces it.
  - **Review Focus 1:** in a repo whose branch is `master`, `config.json` has `"base": "master"`.
  - The template `AGENTS.md` contains `tests/acceptance/<your name>.test.ts` and `Override: <agent>`.
- [ ] **Step 2: Run** `bun test tests/init.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `init.ts`.
  - The templates are `spike/protocol/AGENTS-v2.md` and `.agents/direction.md`, with "agentsync" renamed to "gitaccord", imported as text (`import t from "./templates/AGENTS.md" with { type: "text" }`) so the compiled binary embeds them.
  - Port `spike/bench-hook.sh` to `bench/hook-latency.ts`:
    - it builds the compiled binary;
    - it creates N agents, each with a plan, a note to the previous agent, and a code commit to `src/cli.ts`;
    - it then makes 3 rounds of empty commits per agent;
    - it runs `--copies` benchmarks concurrently;
    - it prints the median, p95 and max of the `post-commit` `ms` values from `log.jsonl`;
    - it exits 1 if p95 > 500.
- [ ] **Step 4: Run** `bun test`, then `bun run build && bun run bench -- --agents 10 --copies 3`. Expected: tests PASS, and the benchmark prints `p95=` ≤ 500 ms and exits 0. Record the printed numbers in the commit message.
- [ ] **Step 5: Commit** with `git commit -m "feat: gitaccord init and compiled binary; G4 benchmark <numbers>"`.

### Task 10: Validate against the spike harness

**Files:**
- Modify: `spike/run.ts` (accept `HOOK_CMD`, an executable used as `exec "$HOOK_CMD" hook <name> "$@"` in place of `bun <hook>.ts <name>`; when it's set, run `"$HOOK_CMD" init --test "bun test {files}"` in the seed repo instead of copying the protocol files)
- Modify: `spike/run.ts` agent launch (minimal environment and narrower tools, below)
- Modify: `docs/superpowers/specs/2026-10-30-git-for-agents-design.md` (add the phase 1 validation results)

**Interfaces:**
- Consumes: `dist/gitaccord`, `spike/batch.ts`, `spike/metrics.ts`.

- [ ] **Step 1: Harden the harness launch.** This responds to the security review on `spike/run.ts`.
  - Agents get `env = { PATH, HOME, TERM, LANG, plus the provider variables pi or claude need, plus the identity variables }` instead of `...process.env`.
  - Claude Code gets `--allowedTools "Bash(git:*),Bash(bun:*),Bash(sleep:*),Bash(ls:*),Bash(cat:*),Bash(mkdir:*),Read,Edit,Write,Glob,Grep"`.
  - Run `bun spike/run.ts disagree coord noop` and one real Claude Code `disagree coord` run. Expected: both complete, with `result.json` written.
- [ ] **Step 2: Run the validation round** with `HOOK_CMD=$PWD/dist/gitaccord RUN_TIMEOUT=1200`, using `spike/evidence-v2.specs` on `claude --model sonnet`, plus `nowin:coord:5:a nowin:coord:5:b`. Expected scorecard (`bun spike/metrics.ts --since <start>`):
  - P2 = 0;
  - P2b = 0;
  - P3 = 100% / ≥ 80%;
  - G1 = 0;
  - M1 ≥ 90%;
  - G4 p95 ≤ 500 ms.
- [ ] **Step 3: Run the same round on pi** (`--model 9router/ollama/glm-5.3-flash`, `--parallel 3`, `RUN_TIMEOUT=600`). Expected: the same thresholds, except G2, which is recorded but not gating (phase 2 addresses it).
- [ ] **Step 4: Record the results.** Add a "Phase 1 validation" subsection under "Success metrics" in the spec, with both scorecards and any misses traced to their cause, as in the earlier rounds.
- [ ] **Step 5: Commit** with `git commit -m "test: validate gitaccord phase 1 binary against the spike harness"`.
