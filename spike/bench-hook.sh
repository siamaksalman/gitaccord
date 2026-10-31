#!/bin/sh
# Hook latency benchmark: N signing agents with plans, notes and overlapping code.
# Usage: ./bench-hook.sh <agents>
set -e
N=${1:-6}
SPIKE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
cd "$T"
names=$(awk -v n="$N" 'BEGIN { for (i = 1; i <= n; i++) printf "g%d ", i }')
mkdir repo && cd repo
cp -R "$SPIKE/toy/." .
mkdir .agents
for n in $names; do
  ssh-keygen -q -t ed25519 -N "" -C "$n" -f "../key-$n"
  echo "$n@agents.local $(cut -d' ' -f1,2 ../key-$n.pub)" >> .agents/allowed_signers
done
git init -q -b main && git add -A && git -c user.name=seed -c user.email=seed@l commit -qm seed
for h in pre-commit commit-msg post-commit post-merge pre-push; do
  printf '#!/bin/sh\nexec %s %s %s "$@"\n' "$(command -v bun)" "$SPIKE/hook/${HOOK:-agentsync.ts}" "$h" > .git/hooks/$h
  chmod +x .git/hooks/$h
done
git checkout -q --detach

as() { name=$1; shift
  GIT_AUTHOR_NAME=agent-$name GIT_AUTHOR_EMAIL=$name@agents.local \
  GIT_COMMITTER_NAME=agent-$name GIT_COMMITTER_EMAIL=$name@agents.local \
  git -c gpg.format=ssh -c user.signingkey="$T/key-$name" -c commit.gpgsign=true "$@"; }

prev=""
for n in $names; do
  git worktree add -q -b agent/$n "../wt-$n"
  cd "../wt-$n"
  mkdir -p .agents/plans .agents/notes
  printf '# Plan: %s\n## Touches\n- `src/cli.ts`\n- `src/%s.ts`\n## Depends on\n- `src/task.ts`\n' "$n" "$n" > .agents/plans/$n.md
  [ -n "$prev" ] && echo "hello $prev, from $n" > .agents/notes/$n-to-$prev.md
  git add -A && as $n commit -qm "plan" -m "Why: bench" 2>/dev/null
  echo "// $n" >> src/cli.ts && echo "export const $n = 1;" > src/$n.ts
  git add -A && as $n commit -qm "code" -m "Why: bench" 2>/dev/null
  prev=$n
  cd ../repo
done
# Three more commits per agent so every hook sees all the others.
for round in 1 2 3; do
  for n in $names; do
    cd "../wt-$n" && as $n commit -q --allow-empty -m "sync $round" -m "Why: bench" 2>/dev/null; cd ../repo
  done
done
bun -e '
const l = require("fs").readFileSync(".git/agentsync/log.jsonl", "utf8").trim().split("\n").map(JSON.parse).filter(e => e.hook === "post-commit");
const ms = l.map(e => e.ms).sort((a, b) => a - b);
const late = l.slice(-Number(process.argv[1]) * 3).map(e => e.ms).sort((a, b) => a - b);
console.log(`agents=${process.argv[1]} post-commit calls=${ms.length} median=${ms[ms.length >> 1]}ms p95=${ms[Math.floor(ms.length * 0.95)]}ms max=${ms.at(-1)}ms | with all agents present: median=${late[late.length >> 1]}ms max=${late.at(-1)}ms`);
' "$N"
