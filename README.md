# gitaccord

Git hooks that let AI coding agents work on one project in parallel without
silently overriding each other.

When several agents build features at the same time, merge conflicts aren't the
real danger: capable agents resolve those on their own. The danger is the agent
that lands last quietly rewriting another agent's feature to fit its own, adjusting
the tests, and reporting success. With plain git that happened in 24–28% of runs in
our tests.

gitaccord adds no new commands. Agents keep using plain git; the hooks underneath
make them see each other's plans and reasoning, agree on approaches that keep
both features, and refuse to land a change that breaks another agent's work
unless it's declared as an override for human review.

**Status:** design approved, spike complete, implementation starting.
**Site:** https://siamaksalman.github.io/gitaccord/

## How it works

- **Conventions, as ordinary files:** one `agent/<name>` branch per agent; a plan
  in `.agents/plans/<name>.md`; notes in `.agents/notes/<from>-to-<to>.md`; the
  shared direction in `.agents/direction.md`; a `Why:` line in every commit; and a
  user-level acceptance test per agent in `tests/acceptance/<name>.test.*`.
- **Hooks enforce the protocol:**

  | Hook | What it does |
  |---|---|
  | `pre-commit` | No code before the plan is committed; no conflict markers |
  | `commit-msg` | Every commit explains its reasoning with a `Why:` line |
  | `post-commit` | Shows overlaps with other agents, their plans, reasoning and notes |
  | `post-merge` | After `git merge main`, shows whose work came in and why |
  | `pre-push` | Landing gate: every overlap needs a recorded agreement, and other agents' own tests must pass unless an `Override:` is declared |

- **Agents land their own work** (merge `main`, test, push). No human gate; humans
  review what landed, starting with declared overrides.
- **Signed commits** per agent, so forged notes are never shown.

## Evidence

About 300 runs with Claude Code (Sonnet) and pi (GLM 5.3 Flash), against plain git
with agents landing their own work:

| | Plain git | gitaccord |
|---|---|---|
| Runs with a feature silently overridden | 24–28% | **0%** |
| No-win decisions recorded and flagged for a human | never | **always** |
| Designed clashes detected | – | **100%** |
| `main` left broken | 0–2% | **0%** |

Still open: token overhead on GLM (2.28× vs a 1.5× target) and hook latency spikes
with 6 agents under heavy load.

## Repository

- [`docs/superpowers/specs/2026-10-30-git-for-agents-design.md`](docs/superpowers/specs/2026-10-30-git-for-agents-design.md):
  the design, success metrics and full spike results.
- [`spike/`](spike/): the throwaway prototype and test harness (Bun). The hook is
  `spike/hook/agentsync2.ts`; `run.ts`, `batch.ts` and `metrics.ts` run scenarios
  against real agents and score them; `test-verify.sh` and `test-override.sh` are
  deterministic checks.
- [`docs/index.html`](docs/index.html): the project site (GitHub Pages).
