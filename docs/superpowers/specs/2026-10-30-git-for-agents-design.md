# Git for agents: design

Name: **gitaccord** (chosen 2026-10-31). "agentsync" was the working name and is
kept in the spike's file names. Date: 2026-10-30. Status: approved 2026-10-31.

## Intent

Several AI coding agents build one large project at the same time, each on its own
feature. Their features can collide: one agent changes a data model while another
writes code that reads it. Today each agent works in its own bubble and the clash
shows up only at merge time, when it is expensive to fix.

gitaccord lets agents see what the others are doing *while they work*: their
reasoning, their plans and where the project as a whole is heading. When one
agent's work would affect another's, the two notice early and agree on an
approach that works for both (a "win-win"), and that agreement is recorded.

The spike showed where this matters most. Capable agents can fix *textual* merge
conflicts on their own. What they can't fix at merge time is a *clash of intent*:
the agent that lands last silently rewrites the other's feature to fit its own.
gitaccord exists to keep every agent's intent intact.

The guiding constraint comes from the user: **agents already know git very well,
so they should not have to learn a new tool.** Everything an agent does is plain
git. gitaccord works underneath, through git hooks and file conventions.

## Goals

1. **Awareness.** Before and during work, an agent can see every other agent's
   plan, what files they are changing or depend on, and why.
2. **Early collision detection.** When an agent's work overlaps another agent's,
   it is told so in normal git output, with pointers to the other agent's plan,
   reasoning and changes.
3. **Negotiation.** Overlapping agents agree on a win-win approach by exchanging
   short notes. Neither simply overrides the other.
4. **Reasoning travels with the code.** Every agent commit carries its reasoning
   (why this change, why this approach). Agents can read why code looks the way
   it does and what each agent plans next.
5. **Shared direction.** A living "big picture" of where the project is heading,
   shaped by humans and agents together.
6. **Works in every setup:** one machine with many agents, and agents spread over
   several machines.
7. **Works with the agents people already use:** pi first, then Claude Code, and
   any agent that can run git.

## Non-goals

- Replacing git, forking git or reimplementing its storage.
- Being an agent, an orchestrator or a task scheduler. gitaccord does not decide
  who works on what; it helps agents who are already working coordinate.
- Semantic merge tooling. Agents resolve conflicts themselves, informed early.
- A hosted service in v1.

## Anti-goals (would count as failure even if it works)

- Agents have to learn new commands or a new tool to take part.
- Coordination turns into locking: agents block or wait on each other instead
  of working in parallel and agreeing.
- Agents' context gets flooded with coordination noise.
- Repositories stop working with ordinary git hosting, tooling or human workflows.

## What gitaccord is really for (from the spike)

The spike sharpened the value of the tool. Once agents land their own work,
**a capable agent fixes textual merge conflicts on its own**, and coordination
adds little there. What agents can't fix at merge time is **conflicting intent**:
two requirements that pull against each other. The agent that lands last quietly
rewrites the other agent's feature to fit its own, changes the tests to match,
and reports success.

gitaccord's job is to **preserve every agent's intent**. Agents find the clash
early, while both are still working, and agree on a design that satisfies both.
Merge-conflict avoidance is a side benefit.

Example from the spike: agent a needed task ids to become UUIDs (for syncing
across devices); agent b needed short typeable numbers (`delete 1`).
- **Plain git, agents landing their own work:** the outcome depended on who
  landed last.
  - When a landed last, it switched b's commands to UUIDs and the tests passed.
    `delete 1` no longer works, and b's feature is gone without anyone noticing.
  - When b landed last, it happened to build on a's UUIDs, and both features survived.
- **With gitaccord:** every run ended with UUIDs stored and list positions shown
  as short numbers, so both features worked fully, whatever the order.

## Evidence from the spike

A throwaway spike (in `spike/`) ran agents in parallel on a toy TypeScript to-do
app, with deliberately colliding features. Each scenario ran with plain git and
with the gitaccord hook and conventions. Hidden acceptance tests, which the
agents never saw, checked the final `main`. Full results are in "Spike results"
at the end.

What the spike showed:

- **Intent clashes need coordination; text conflicts don't** (see above).
- **Agents follow the conventions** in an `AGENTS.md` with no new tooling, on both
  pi (GLM 5.3 Flash) and Claude Code (Sonnet). Claude Code reads `CLAUDE.md`, so
  that file has to import `AGENTS.md`.
- **The negotiation is real.** Notes read like engineers agreeing on interfaces:
  who owns which function, which fields are frozen, who merges first.
- **Agreeing isn't integrating.** Without an instruction to land their own work,
  Claude Code agents agreed sound interfaces but never merged each other's code,
  so their branches still conflicted. GLM agents tended to merge each other's
  branches on their own initiative. The landing rule fixed this.
- **One plan file per agent.** A shared plan path (`.agents/plan.md`) caused
  conflicts in 3 runs. It's fixed by `.agents/plans/<name>.md`.
- **Waiting is the weak spot.** The hook only runs on `git commit`, so agents
  learn about each other only when they commit, then sleep and commit again to
  check for replies. Coordinated runs took 1.2–3× longer than plain git.
- **Format drift.** Some agents put `Why:` in the subject line instead of a
  trailer. Enforcement must be precise, and error messages must say exactly what
  to do.

## Design

### Conventions (all stock git)

| Thing | Convention |
|---|---|
| Agent identity | a unique name per agent, e.g. `pi-3` or `laptop/claude-1` |
| Agent branch | `agent/<name>`, one per agent, in its own `git worktree` |
| Plan | `.agents/plans/<name>.md` on the agent's own branch |
| Notes to other agents | `.agents/notes/<from>-to-<to>[-<topic>].md` on the sender's branch |
| Direction (big picture) | `.agents/direction.md` on `main` |
| Reasoning | a `Why:` trailer on every agent commit (the body may say more) |
| Rules for agents | `AGENTS.md` at the repo root; `CLAUDE.md` imports it with `@AGENTS.md` |

A plan has fixed sections the hook parses: **Goal**, **Touches** (paths the agent
will change), **Depends on** (paths it relies on but won't change), **Agreements**
(what it settled with whom) and **Next steps**.

Because plans and notes live on each agent's own branch, two agents never write
the same file, and everything syncs across machines with normal `git push` and
`git fetch`. Other agents read them with `git show agent/<name>:.agents/plans/<name>.md`.

### The hook binary

One Bun program, compiled to a single binary with `bun build --compile`, installed
as the repository's git hooks.

The design rule, learned from the spike: **anything the protocol depends on is
enforced by a hook, not just asked for.** Fast agents (Claude Code finishes in
seconds) skip steps that `AGENTS.md` only requests.

- **`pre-commit`:**
  - rejects unresolved conflict markers (`<<<<<<<`, `>>>>>>>`). In the spike, an
    agent committed markers and broke `main` while believing its work had landed;
  - rejects code commits until the agent's plan is committed, so others can see
    its intent before its code exists.
- **`commit-msg`:** on `agent/*` branches, rejects commits without a `Why:` line.
  The error message shows the exact fix.
- **`post-merge`** (and `post-commit` on merge commits): after `git merge main`,
  shows whose work was just brought in, which of the agent's files it touches,
  and those agents' `Why:` lines and plans.
- **`pre-push` (the landing gate):** when pushing to `main`, it refuses if:
  - conflict markers are present; or
  - the agent's work overlaps another agent's and the agent has recorded nothing
    about it: neither a note to them nor a line under `## Agreements` in its plan.

  This is what turns a silent override into a recorded decision. In the
  Claude Code evidence round it refused 72 landings across 59 runs, and each time
  the agent recorded an agreement and landed.
- **Agreement or override: judged by tests, not words.** A note can't prove what
  it means, so the gate lets each agent's own tests decide. It went through three
  iterations in the spike, each closing a hole found in real runs:
  1. *A note was enough to land.* In a multi-machine run, the agent that landed
     last rewrote another agent's `delete <n>` to use UUIDs and only announced it
     in a note. The feature was lost and no human was told.
  2. *The other agent's agreement line exempted the check.* One agent's plan said
     "if b adds compact mode, the default stays pretty". b then changed the
     default, and the check skipped a's tests because a had "agreed" with b.
  3. *Unit tests only.* b kept the library default pretty, so a's unit tests still
     passed, and changed the CLI default that users actually get, writing "No
     override needed".

  The final rule:
  - **Acceptance test required.** Before landing, every agent must have
    `tests/acceptance/<name>.test.*`. It uses the program the way a user would
    (for example, runs the CLI) and checks the behaviour the agent was asked to
    build. This is how an agent's intent is written down in executable form.
  - **Other agents' tests, in their version.** At landing, the gate runs every
    overlapping agent's own tests, taken from *their* branch rather than any
    rewritten copy, against what is being landed. It does this only for agents
    whose work is actually included (landed on `main`, or merged into the branch).
    It skips tests that already fail on `main`, because those aren't this
    change's fault.
  - **If those tests fail,** landing is refused unless the agent declares
    `Override: <agent> — <what and why>`. Notes and agreement lines don't exempt
    the check. Overrides are always listed for human review (alongside direction
    changes), and the overridden agent is notified if it's still active.
  - **The project's test command** is configured in `.agents/config.json`, for
    example `{ "test": "bun test {files}" }`.

  **The limit:** the gate protects only what an agent's own tests cover. In the
  6-agent crowd scenario, an agent's export kept a stale `done` column from the
  old data model, and its own tests asserted that same column, so nothing failed.
  Human review of `main` and the hidden acceptance tests (P1) remain the backstop.
- **`post-commit`:** computes overlaps between this agent and every other agent,
  and prints a short coordination block to the agent's terminal:
  - who else is changing the same files;
  - who depends on files this agent is changing, and the reverse;
  - notes addressed to this agent that it hasn't seen yet;
  - the exact git commands to read the other agent's plan, reasoning and diff;
  - the other agent's latest commit subjects and `Why:` lines.
- **Overlap rule (v1):** file level. An overlap is any intersection between one
  agent's *touches* (plan plus actual diff against `main`) and another agent's
  *touches* or *depends on*.
- **Noise control:** each notice is shown once until something changes: a new
  note, a changed plan or a new overlapping file. The hook keeps a small
  per-worktree state file under `.git/` to track what it has shown.

### Branch lifecycle

- **Visible after landing:** an agent stays visible to the others after its work
  lands, labelled "already on main". Its touches are the files in its own commits
  (matched by author) since the other agent's branch started. In the first
  version of the spike, landed agents were ignored. Fast agents then landed before
  anyone could see them, and the next agent silently overrode their work (the
  main cause of Claude Code's early failures). Show-once notices stop this from
  becoming noise.
- **Building on each other:** agents may merge or cherry-pick from another
  agent's branch (the spike showed this is how agents carry out agreements). An
  agent's own touches are computed only from commits made on its own branch, so
  commits brought in from agent B never show up as "you are both changing", and
  notes are attributed to the agent whose branch first committed them.
- **Keeping up with `main`:** agents may merge `main` into their branch whenever
  they like. Overlap is always computed against the merge base.
- **Landing on `main` (decided by the user: no bottlenecks):** agents merge
  their own branch into `main` once they're done. No human gate and no
  integrator agent. To land, an agent:
  1. merges the latest `main` into its branch, resolving any conflicts using the
     agreements in the notes;
  2. runs the full test suite;
  3. updates `main` with a fast-forward push.

  If another agent landed first, the push is rejected and the agent repeats the
  steps. Git's own non-fast-forward check is the only "lock", and it never makes
  an agent wait on a person. Humans review what landed afterwards and can revert.
- **Agreeing isn't integrating:** in the Claude Code spike run, three agents
  agreed sound interfaces but never merged each other's code, and their branches
  still conflicted. Under the landing rule above, the agent that lands later
  resolves the conflict while it knows the agreement. `AGENTS.md` must say this
  explicitly.
- **Plans and notes on `main`:** they merge into `main` with the code, under
  `.agents/`, as the permanent record of why things were built the way they were.
  This keeps reasoning next to the code, which the user asked for. They're plain
  files in one folder and don't affect normal git use.

### Waiting and finishing (phase 1)

Without an adapter, agents only learn about each other when they commit. Phase 1
accepts that limitation, and adds these rules:

- Agents are told to commit small and often, so each real commit doubles as a
  check-in.
- Empty "check" commits are allowed but rate-limited by the rules in `AGENTS.md`:
  at most 3 rounds of `sleep 60` followed by a check, and only while an agent
  is waiting on a reply.
- **Never blocking:** an agent that gets no reply after those rounds records its
  assumption in its plan and finishes. It doesn't wait indefinitely.
- **Done** means the plan's status is `done`, its own tests pass, and no note
  addressed to the agent has gone unanswered.

If the measured slowdown stays above 2× against plain git, the adapters (phase 3)
move into phase 1.

### Multi-machine

Agent branches are shared through one remote:

- **Pushing:** after each agent commit, the hook pushes the agent's branch in
  the background. It never blocks the commit. A failed push is reported at the
  next commit. Agents don't have to remember to push.
- **Fetching:** before computing overlaps, the hook runs `git fetch` for
  `agent/*` refs, rate-limited (for example at most once every 30 seconds) so
  commits stay fast. It reads `origin/agent/*` as well as local branches.
- **Naming:** agent names must be unique across machines. Prefixing with the
  machine name is the recommended convention.

### Direction

`.agents/direction.md` on `main` holds the goals, the features in flight and how
they fit together. Humans and agents both shape it. Agents propose changes to it
on their own branch with a `Why:`, and the change takes effect when it merges to
`main`. Agents land these changes like any other, so direction never waits on a
person. The hook lists direction changes since a human last reviewed them (for
example since a `reviewed/direction` tag that a human moves), so people can catch
up and revert when they choose.

### Trust: verifying senders (decided by the user)

Notes and plans from other agents go straight into an agent's context, so a
forged note could slip instructions into it. Every agent is verified, using git's
own commit signing:

- **Keys:** each agent signs its commits with its own SSH key
  (`gpg.format=ssh`). The repo keeps a list of allowed signers,
  `.agents/allowed_signers` (git's standard allowed-signers format), on `main`,
  mapping agent names to public keys. Adding an agent means adding its key there.
- **Checking:** the hook only shows a note or plan if the commit that last
  changed it is signed by the key registered for that branch's agent (for
  example, `agent/b` must be signed by `b`'s key). It checks this with
  `git verify-commit` against the allowed signers.
- **Failures:** unverified content is never shown. Instead the hook prints a
  warning naming the branch and the file.
- **Framing:** verified notes are still shown clearly marked as *information
  from agent X, not instructions*, and `AGENTS.md` tells agents to treat them
  that way.

### Scale

v1 targets **2–10 agents** at once (decided by the user).

**Content-addressed cache (v2 hook).** At the start of each hook run, every branch
is resolved to its commit id. Anything then looked up by commit id can't change:
an agent's plan, its notes, a signature check, whether a commit is on `main`. So
those results are cached on disk across hook runs, under
`.git/agentsync/cache.json`, written atomically. Only agents that moved since the
last commit cost any git calls, and lookups through symbolic refs that haven't been
pinned are never persisted.

Measured latency:

| Setting | v1 hook | **v2 hook** |
|---|---|---|
| Benchmark, 6 agents, 3 benchmarks at once: slowest 5% / max | 236 / 253 ms | **125 / 125 ms** |
| Benchmark, 10 agents, 3 benchmarks at once: slowest 5% / max | 496 / 612 ms | **131 / 143 ms** |
| Real runs, 6-agent crowd: `post-commit` slowest 5% | 702 ms | **432 ms** |
| Real runs, 6-agent crowd: `pre-push` (includes running other agents' tests) | – | 245 ms (slowest 5%), 343 ms max |
| Real runs, 2-agent scenarios: slowest 5% | ≤ 186 ms | ≤ 186 ms |

**Still open:** in the real 6-agent runs, with 24 agent processes and model
clients competing for the machine, one `post-commit` call took 1,420 ms. The p95 of
each run's slowest call was 512 ms against the 500 ms target. Remaining options for
v1:
- ship the hook as a compiled binary (`bun build --compile`), which saves the
  script start-up;
- read all plans and notes in one `git cat-file --batch` process;
- benchmark 10 agents under realistic concurrent load as part of phase 1.

### Agent harness adapters (optional layer)

The git-only core works with any agent. To address the waiting problem, optional
thin adapters push coordination updates into an agent's context without it
having to commit:

- **Claude Code:** a hook (for example `PostToolUse` or `UserPromptSubmit`) that
  runs the same overlap check and injects new notices as additional context.
- **pi:** an extension doing the same.

Adapters reuse the hook binary's logic. They are an accelerator, not a
requirement, and agents still never call gitaccord themselves.

## Success metrics

gitaccord succeeds only if it beats the realistic alternative: **plain git with
agents landing their own work** (merge `main`, test, push). Every metric is
measured for both, on the same scenarios and models. The spike harness computes
them all (`bun spike/metrics.ts`).

### Primary: what gitaccord claims to add

| # | Metric | Definition | Threshold |
|---|---|---|---|
| P1 | **Intent survival** | Share of agents' features whose hidden acceptance tests pass on the final `main` (excluding no-win scenarios) | ≥ 95%, and at least plain git's |
| P2 | **Silent override rate** | Share of runs where a feature passed on its own agent's branch but is broken on `main`, with no decision recorded in `.agents/` | ≤ 5% |
| P3 | **Decision traceability** | In no-win scenarios: share of runs with the decision recorded, and share flagged for a human | 100% and ≥ 80% |

### Guardrails: what gitaccord must not make worse

| # | Metric | Definition | Threshold |
|---|---|---|---|
| G1 | **Broken `main`** | Share of runs where `main`'s own tests fail or conflict markers are committed | ≤ 5%, and no worse than plain git |
| G2 | **Work overhead** | Mean model tokens with gitaccord ÷ mean with plain git, per scenario. Wall time is reported for reference only: provider stalls of 10–60 minutes made it unreliable | ≤ 1.5× |
| G3 | **Context cost** | Coordination text shown per agent per run | ≤ 4 KB |
| G4 | **Hook latency** | 95th percentile of each run's slowest hook call | ≤ 500 ms |

### Mechanism: is it working the way we think?

| # | Metric | Definition | Threshold |
|---|---|---|---|
| M1 | **Clash detection recall** | Share of each scenario's designed clash pairs that the hook flagged to at least one of the two agents | ≥ 90% |
| M2 | **Compliance** | Agent commits with a `Why:` line; agent commits signed and verified | ≥ 95%; 100% |
| M3 | **Forgery blocked** | The scripted forgery test (`spike/test-verify.sh`): unregistered and impersonated notes never shown | 100% |

### What counts as evidence

- **At least 10 runs** per scenario, model and mode. Rates are reported with 95%
  Wilson confidence intervals. With fewer runs, results are indicative only.
- **Both landing orders.** The spike showed that with plain git, the order of
  landing decides whose intent survives. Every clash scenario runs with each side
  landing first (the harness's `ORDER` control).
- **At least two models**, one strong and one mid-sized (so far Claude Sonnet and
  GLM 5.3 Flash).
- **Scenario mix:** at least 3 clash-of-intent scenarios, 1 no-win scenario,
  1 crowd scenario (6+ agents) and 1 multi-machine scenario.
- **Infrastructure failures are excluded and counted:** for example, a model
  provider timing out before agents start. The harness stops a run after a time
  limit (`RUN_TIMEOUT`: 10 minutes for the GLM round, 20 minutes by default),
  records it as an infrastructure failure and retries it once. The Claude Code
  evidence round ran before this limit existed, so its stalled runs simply ran
  long and still count.
- **The bar:** gitaccord is worth building past phase 1 if it meets every primary
  metric and guardrail on both models, and beats plain git on P2 with confidence
  intervals that don't overlap.

**Verdict from the spike:**
- **The core claim is met on both models.** Silent overrides fell from 24–28%
  with plain git to 0%, with confidence intervals that don't overlap.
- **Every no-win decision was recorded and flagged for a human.**
- **Clash detection was 100%,** and `main` was never broken.
- **Two guardrails are still open:**
  - *G2 work overhead on GLM* (2.28× tokens; Claude Code is at 1.16–1.18×);
  - *G4 hook latency spikes* with 6 agents under heavy load.

  Both have concrete fixes listed in this document (adapters and shorter
  notices; a compiled binary and batched reads), and both are phase 1 work.

### Evidence round: Claude Code (10 runs per cell, both landing orders)

Final hook design (plan-first, merge notice, landing gate, faster hook), with
plain git and agents landing their own work as the comparison. 109 of 110 runs
completed, with 1 infrastructure failure. The model was Claude Sonnet, and the
run cost $35.11 in total.

| # | Metric | gitaccord | plain git | Met |
|---|---|---|---|---|
| P1 | Intent survival | **99%** (137/138) [96–100%] | 97% (116/120) [92–99%] | ✅ |
| P2 | Silent overrides | **0%** (0/59) [0–6%] | **28%** (14/50) [17–42%] | ✅ |
| P3 | No-win: decision recorded / flagged for a human | **100% / 100%** (10/10) | not possible | ✅ |
| G1 | Broken `main` | 0% (0/59) | 0% (0/50) | ✅ |
| G2 | Work overhead (tokens) | **1.16×** | 1.00× | ✅ |
| G3 | Coordination text per agent per run | 2.3 KB | – | ✅ |
| G4 | Hook latency, p95 of per-run max | **925 ms** | – | ❌ crowd scenario only |
| M1 | Clash detection recall | **100%** (79/79) | – | ✅ |
| M2 | `Why:` line / signed and verified | 100% / 100% | – | ✅ |
| M3 | Forgery blocked (`test-verify.sh`) | 5/5 checks | – | ✅ |

**The bar for P2 is met:** silent overrides drop from 28% to 0%, with confidence
intervals that don't overlap ([17–42%] against [0–6%]).

Findings:
- **Landing order decides plain git's outcome.**
  - In the disagree scenario, plain git lost a feature in 4 of 5 runs when b
    landed first, and in none when a landed first.
  - With gitaccord, all 10 runs passed in both orders.
  - In the no-win scenario, plain git always resolved it (one side won) but left
    no record in any of the 10 runs. gitaccord recorded and flagged every decision.
- **The landing gate does the work.** It refused 72 landings and the plan-first
  check refused 6 commits, in 59 coordinated runs. Agents responded every time by
  recording an agreement, never by giving up.
- **One recorded override slipped through** (multi-machine disagree run): an agent
  overrode another's feature and only announced it in a note. This is the one P1
  miss, and it led to the agreement/override distinction in the landing gate above.
- **Hook latency fails only under crowd load:**
  - crowd `post-commit`: p95 702 ms, max 1,068 ms, with 24 agent processes running;
  - every other scenario: p95 ≤ 186 ms.

  See "Scale" for the work this needs.
- **Wall time was dominated by provider stalls**, not coordination. In 20 runs an
  API request hung for about 11 minutes before retrying. Plain-git and
  coordinated runs were hit alike: time with gitaccord came to 0.86× plain git,
  which is noise. That's why G2 uses tokens.

### Verification of the v2 hook (Claude Code)

The v2 hook adds the content-addressed cache, the override check judged by tests,
and required acceptance tests. 54 Claude Code runs: crowd, multi-machine,
disagree, rename and no-win, in both landing orders, with no infrastructure
failures.

| What was checked | Result |
|---|---|
| Multi-machine runs (where the note-only override had slipped through) | **10/10 passed**, no feature lost |
| Silent overrides (no recorded decision) | **0/54** |
| Unflagged overrides (another agent's feature broken without an `Override:` line), final rule | 3/10 → 2/10 → **0/14** across the three iterations |
| No-win decisions recorded and flagged for a human | 100% |
| Extra overrides declared where the other feature actually survived | 2/14 (disagree: b's original tests used the old id format). Costs some human review; nothing goes unseen |
| Clash detection | 40/40 |
| Broken `main` | 0 |
| Work overhead (tokens) | 1.18× |
| Crowd: feature lost without an override | 2/5 runs: stale `done` column, see "The limit" above |

The scripted tests pass on v2: `test-verify.sh` 5/5 and `test-override.sh` 8/8.
The no-win replay still behaves the same.

### Evidence round: GLM 5.3 Flash

Same scenarios as the Claude Code round, on the **v1 hook**. v1 has the landing
gate, plan-first and the merge notice, but not the override check or acceptance
tests. It stayed on v1 so its results weren't mixed between versions. The P2b
metric therefore doesn't apply.

There were 106 completed runs and 23 infrastructure failures, all of them runs
stopped at the 10-minute limit; each was retried once. The crowd cells are short
of 10 runs, because the 6-agent GLM runs often hit the limit: 6 completed with
gitaccord, 10 with plain git.

| # | Metric | gitaccord (v1 hook) | plain git | Met |
|---|---|---|---|---|
| P1 | Intent survival | 97% (113/116) [93–99%] | 97% (116/120) [92–99%] | ✅ |
| P2 | Silent overrides | **0%** (0/56) [0–6%] | **24%** (12/50) [14–37%] | ✅ |
| P3 | No-win: decision recorded / flagged for a human | **100% / 100%** (10/10) | not possible | ✅ |
| G1 | Broken `main` | 0% (0/56) | 2% (1/50) | ✅ |
| G2 | Work overhead (tokens) | **2.28×** (time 1.84×) | 1.00× | ❌ |
| G3 | Coordination text per agent per run | 3.0 KB | – | ✅ |
| G4 | Hook latency, p95 of per-run max | 514 ms (v1 hook) | – | ❌ |
| M1 | Clash detection recall | **100%** (68/68) | – | ✅ |
| M2 | `Why:` line / signed and verified | 100% / 100% | – | ✅ |

Findings:
- **The core result reproduces on a second, very different model:** silent
  overrides went from 24% to 0%, with confidence intervals that don't overlap,
  just as with Claude Code.
- **GLM pays more for coordination:** 2.28× the tokens, against 1.16–1.18× for
  Claude Code. GLM takes more turns reading notices and writing notes. This is
  over the 1.5× guardrail, and it's the main open cost question. Adapters, which
  deliver notices without the agent having to commit and poll, and shorter
  notices are the levers to test.
- **The P1 misses with gitaccord aren't overrides:**
  - in one disagree run, b's own implementation failed its feature;
  - in one multi-machine hiddendep run, a's version of the storage format was
    overridden *and recorded* (not silent), while b's backup feature failed on its
    own branch.
- **Hook latency:** GLM ran the v1 hook, which is 514 ms at p95. The v2 cache
  (measured with Claude Code) is the fix.

Choosing the second model: six "flash" models available through 9router were
raced on the same small coding task:

| Model | Time | Result |
|---|---|---|
| GLM 5.3 Flash | 14s | correct, 24.9k tokens |
| GLM 5.3 Flash, thinking off | 15s | correct, 28.0k tokens (more turns, so no faster) |
| MiniMax M3.1 Flash | 34s | correct |
| DeepSeek V4.1 Flash | 39s | correct |
| GLM 4.7 Flash | 18s | did not do the task |
| Clef Flash | 2s | did not do the task |

GLM 5.3 Flash is the fastest model that does the task correctly. Earlier slow
GLM runs were caused by provider stalls under concurrent load, which the time
limit and retry now handle. The model and its thinking level weren't the cause.

### Earlier rounds (indicative, under 10 runs per cell)

Scorecard from the landing rounds (round 5 onward):

| Metric | Claude Code: gitaccord | Claude Code: plain git | GLM: gitaccord | GLM: plain git |
|---|---|---|---|---|
| P1 intent survival | 89% (16/18) ❌ | 100% (14/14) | 100% (18/18) ✅ | 100% (14/14) |
| P2 silent overrides | 11% (1/9) ❌ | 29% (2/7) | 0% (0/9) ✅ | 29% (2/7) |
| P3 decision / human flag | 50% / 100% ❌ | not possible | 100% / 100% ✅ | not possible |
| G1 broken `main` | 11% (1/9) ❌ | 0% (0/7) | 0% (0/9) ✅ | 0% (0/7) |
| G2 time overhead | 1.90× ❌ | – | 3.35× ❌ | – |
| G3 context cost | 0.8 KB ✅ | – | 2.9 KB ✅ (crowd alone: 7.4 KB) | – |
| G4 hook latency p95 | 356 ms ✅ | – | 410 ms ✅ | – |
| M1 detection recall | 82% (9/11) ❌ | – | 100% (11/11) ✅ | – |
| M2 Why / signed | 100% / 100% ✅ | – | 100% / 100% ✅ | – |

### After the hook fixes (Claude Code)

The Claude Code misses came from three causes, all confirmed in the run logs:
1. Landed agents were ignored, so fast agents never saw each other.
2. Claude Code followed the task prompt rather than `AGENTS.md`, and skipped the
   plan and wait steps.
3. An agent's `bun test` passed even though conflict markers were in a file no
   test loads.

The hook now covers all three (`pre-commit`, `post-merge` and the `pre-push`
landing gate above). The rerun of 11 Claude Code runs, against the same
plain-git runs, gave:

| Metric | Claude Code: gitaccord (before → after) | Claude Code: plain git |
|---|---|---|
| P1 intent survival | 89% → **100%** (22/22) ✅ | 100% (14/14) |
| P2 silent overrides | 11% → **0%** (0/11) ✅ | 29% (2/7) |
| P3 decision / human flag | 50% / 100% → **100% / 100%** ✅ | not possible |
| G1 broken `main` | 11% → **0%** (0/11) ✅ | 0% (0/7) |
| G2 time overhead | 1.90× → **1.75×** ❌ | – |
| G3 context cost | 1.7 KB ✅ (crowd alone: 8.4 KB) | – |
| G4 hook latency p95 | **554 ms** ❌ (the crowd run; every other run ≤ 313 ms) | – |
| M1 detection recall | 82% → **100%** (13/13) ✅ | – |
| M2 Why / signed | 100% / 100% ✅ | – |

**The landing gate did the work.** It refused 15 landings across the 11 runs. In
each case the agent then wrote a note and an agreement and landed. In the no-win
run, agent b kept a's pretty-print option, made compact the CLI default,
explained in a note that this overrides a's default for CLI users, and flagged
it for human review.

What's left:
- **Time overhead** is 1.75× the plain-git time (31s → 53s on average), above the
  1.5× target. Adapters remain the way to fix it.
- **The crowd scenario is too heavy at 6 agents:** the slowest hook call took
  554 ms, and each agent read 8.4 KB of coordination text. Both need caching and
  summarised notices before going to 10 agents.

What the results before the fixes said:
- **On GLM, gitaccord met every metric except time overhead.**
- **P2 is where gitaccord shows its value:** plain git silently overrode a feature
  in about a third of runs on both models, while gitaccord was at 0–11%.
  Plain git's silent overrides here all come from no-win and order-sensitive
  cases, which is exactly where gitaccord's recorded decisions make the difference.
- **The crowd scenario is the context-cost hotspot:** with 6 agents on GLM, each
  agent read 7.4 KB of coordination text, almost twice the threshold. Summarising
  notices will be needed well before 10 agents.
- **Claude Code's misses trace to specific, fixable causes:**
  - One agent committed conflict markers to `main`. That one run caused both the
    P1 and the G1 miss.
  - In one no-win run, the decision wasn't recorded in words the metric detects.
  - In one multi-machine run, the agents each committed once and landed before
    any overlap could be seen. That's the M1 miss.
- **Time overhead (G2) fails on both models.** It's the clearest argument for
  moving the adapters (phase 3) into phase 1.
- **Every cell has fewer than 10 runs,** so none of this is conclusive yet.

## Phases

1. **Single machine, git-only core.** It includes:
   - the conventions, per-agent plan files and `AGENTS.md`;
   - the compiled hook binary with every hook from the spike's v2 design:
     `pre-commit`, `commit-msg`, `post-commit`, `post-merge`, and the `pre-push`
     landing gate with the override check and required acceptance tests;
   - the content-addressed cache, plus batched reads;
   - show-once notices;
   - an install command for humans (`gitaccord init`), which also writes
     `.agents/config.json`.

   Validated with the spike harness on pi and Claude Code, and it must close G4
   (latency under concurrent load).
2. **Faster, cheaper coordination.** Claude Code and pi adapters that deliver
   notices without a commit, and shorter notices. This moved up from phase 3
   because G2 (token overhead on GLM, 2.28×) is the main open guardrail. Measure
   tokens against phase 1.
3. **Multi-machine.** Background push and fetch of `agent/*` refs, unique naming,
   and signed commits with allowed signers. It already passed in the spike (10/10
   runs with Claude Code on v2); this phase hardens it across real machines.
4. **Humans in the loop.** A read-only view (command-line first) of direction,
   plans, overlaps, negotiations and, first of all, **declared overrides waiting
   for review**.

Function-level overlap detection (using tree-sitter) is a candidate after phase 2
if file-level detection proves too coarse on real projects.

## Constraints

- **Language and runtime:** TypeScript on Bun, shipped as a single compiled
  binary. (Decided by the user, replacing the earlier Rust idea.)
- Agents use stock git commands only.
- Repositories must remain valid, ordinary git repositories.
- Hook work on commit must stay fast; it must never noticeably slow down `git commit`.

## Decided by the user

- Build "git for agents", covering both code collaboration and agent reasoning.
- Agents coordinate and negotiate win-win outcomes rather than one overriding another.
- Reasoning lives alongside code; agents read both why code is the way it is and
  what others plan next, and see the project's overall direction.
- Humans and agents both shape direction.
- Every setup must eventually work: one machine and many machines.
- No new tools for agents: they use git, which they already know.
- Bun instead of Rust.
- Test with pi first, then Claude Code.
- Agents land their own work on `main`, with no human or integrator bottleneck.
- v1 is for 2–10 agents at once.
- Senders are verified: notes and plans are shown only from signed, registered agents.
- Second test model: GLM 5.3 Flash (confirmed as the fastest model that does the
  task correctly, after racing the faster options).

## Calls I made (please check)

- **Stock git only for v1**, with no `git agent` extension command. It can be added
  later if agents turn out to want it.
- **Plans on each agent's own branch** rather than one shared `agents` branch
  (proved simpler in the spike, and it can't produce write conflicts).
- **File-level overlap first**, function-level later.
- **Humans review direction after the fact** rather than approving it first, to
  match the user's "no bottlenecks" answer.
- **Enforce the `Why:` trailer** with a hard reject, not a warning.
- **Plans and notes merge into `main`** as the permanent record, rather than
  being stripped out.
- **Agents may build on each other's branches.** Touches only count commits made
  on the agent's own branch.
- **Phase 1 waiting** is limited to at most 3 check rounds, and agents never
  block on a reply.
- **The hook pushes agent branches in the background,** so on multiple machines
  agents don't have to remember to push.
- **Success metrics and thresholds** (see "Success metrics"), including the bar of
  at least 10 runs per cell and testing both landing orders.
- **G2 measures tokens, not wall time,** because provider stalls made wall time
  unreliable.
- **Explicit `Override:` lines** for any change to another agent's landed
  behaviour, always routed to human review (from the one P1 miss in the evidence
  round).
- **The protocol is enforced by hooks**, not just requested in `AGENTS.md`:
  plan-first, the landing gate, and conflict markers.

## Left to the builder

- The exact plan file format and how leniently to parse it.
- The state file format and the "show once" logic.
- Rate limits and error handling for remote fetch.
- Wording of the coordination block and of `AGENTS.md`, tuned by running the
  spike harness.
- Packaging of `gitaccord init`.

## Spike results

Toy app: a command-line to-do app in TypeScript with Bun. Scenarios:

- **collide:** two agents. a changes the task model (status, priority, due);
  b adds CSV export of every field.
- **three:** like collide, plus c adds filtering and sorting. All three edit `cli.ts`.
- **disagree:** a needs UUID ids for sync; b needs short typeable numbers for
  `done` and `delete`.

A run passes when every hidden acceptance test passes on the final `main`.

### Rounds 1–4: the runner merges branches mechanically at the end

| Agent | Scenario | Plain git | gitaccord |
|---|---|---|---|
| GLM 5.3 Flash (pi) | collide | 0/3 | 3/3 |
| GLM 5.3 Flash (pi) | three | 0/2 | 2/3 ¹ |
| GLM 5.3 Flash (pi) | disagree | 0/2 | 2/3 ² |
| Claude Code (Sonnet) | three | 0/1 | 0/3 ³ |
| Claude Code (Sonnet) | disagree | 0/1 | 3/3 |

¹ The one failure conflicted only on the shared `.agents/plan.md` (since fixed).
² The failure conflicted on the shared plan file, and the agents also never merged each other's code.
³ One failure was the plan file. In the two runs after that was fixed, the agents agreed but never integrated.

### Round 5: agents land their own work (both setups), one plan file per agent

| Agent | Scenario | Plain git | gitaccord |
|---|---|---|---|
| Claude Code (Sonnet) | three | **2/2** | 2/2 |
| Claude Code (Sonnet) | disagree | **0/1**: b's feature silently overridden | 1/1 |
| GLM 5.3 Flash (pi) | three | 1/1 | 1/1 |
| GLM 5.3 Flash (pi) | disagree | **1/1**: preserved by landing order | 1/1 |

Two more GLM runs didn't start: 9router timed out while looking up the model.
They're excluded.

**Plain git preserving intent depends on landing order.** In the disagree
scenario, plain git preserved both features when the UUID change landed first,
because the short-numbers agent then built on top of it (GLM). It destroyed one
feature when the UUID agent landed last (Claude Code). So with plain git, intent
survived in 1 of 2 runs. With gitaccord it survived in all 5 disagree runs across
rounds 1–5, regardless of order.

Run time in round 5:

| Agent | Plain git | gitaccord |
|---|---|---|
| Claude Code | 69–86s | 83–141s |
| GLM | 358–552s | 440–548s |

**Runner bug found:** in every run, commits were credited to the last agent set
up. `git config` inside a worktree writes to the shared repository config. This
didn't affect any pass or fail result, and it's fixed in the runner by giving each
agent its identity through environment variables. It matters for the design:
agent identity must be set per process (environment variables or a signing key),
never through shared repo config.

### Caveats

- These are small numbers of runs on a toy project. They show the idea works and
  where its value lies; they don't establish a reliability rate.
- Only one scenario tests a clash of intent. Phase 1 validation needs several
  more of these, since that's where the tool earns its keep.
- Everything ran on one machine.
- All raw runs are kept in `spike/runs/`. Each has a `report.md` and its full git history.
