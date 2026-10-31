#!/bin/sh
# Deterministic test of the landing gate's override check (no model needed).
#   b lands greeting() == "hello" with a test.
#   a changes it to "hi", rewrites b's test to match and only leaves a note:
#     must be refused; then accepted once a declares "Override: b".
#   d is still working (not landed) on the same file with its own test.
#   c lands a compatible change after a: must be accepted (b's test already
#     fails on main because of a's accepted override, and d hasn't landed).
SPIKE=$(cd "$(dirname "$0")" && pwd)
HOOK=${HOOK:-agentsync2.ts}
T=$(mktemp -d)
cd "$T" && mkdir repo && cd repo
cp -R "$SPIKE/toy/." .
mkdir .agents && echo '{ "test": "bun test {files}" }' > .agents/config.json
git init -q -b main && git add -A && git -c user.name=seed -c user.email=seed@l commit -qm seed
for h in pre-commit commit-msg post-commit post-merge pre-push; do
  printf '#!/bin/sh\nexec %s %s %s "$@"\n' "$(command -v bun)" "$SPIKE/hook/$HOOK" "$h" > .git/hooks/$h
  chmod +x .git/hooks/$h
done
git checkout -q --detach
for n in a b c d; do git worktree add -q -b agent/$n "../wt-$n"; mkdir -p "../wt-$n/.agents/plans" "../wt-$n/.agents/notes"; done
as() { n=$1; shift; GIT_AUTHOR_NAME=agent-$n GIT_AUTHOR_EMAIL=$n@agents.local GIT_COMMITTER_NAME=agent-$n GIT_COMMITTER_EMAIL=$n@agents.local "$@"; }
plan() { printf '# Plan: %s\n## Touches\n- `src/greet.ts`\n## Agreements\n' "$1" > .agents/plans/$1.md; git add -A; as $1 git commit -qm "plan $1" -m "Why: plan" 2>/dev/null; }
accept() { mkdir -p tests/acceptance; printf 'import { expect, test } from "bun:test";\ntest("%s", () => expect(1).toBe(1));\n' "$1" > tests/acceptance/$1.test.ts; }
pass=0; fail=0
expect() { if [ "$1" = "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $3 (got $2)"; fi; }

cd ../wt-b && plan b
echo '- a: if a changes the greeting, keep "hello" as the default' >> .agents/plans/b.md
echo 'export const greeting = () => "hello";' > src/greet.ts
printf 'import { expect, test } from "bun:test";\nimport { greeting } from "../src/greet";\ntest("greets", () => expect(greeting()).toBe("hello"));\n' > tests/greet.test.ts
git add -A && as b git commit -qm "greeting" -m "Why: users want a greeting" 2>/dev/null
OUT=$(as b git push . HEAD:main 2>&1); expect 1 $? "b is refused without an acceptance test"
echo "$OUT" | grep -q "add your acceptance test"; expect 0 $? "refusal asks for tests/acceptance/b.test.ts"
accept b; git add -A && as b git commit -qm "acceptance" -m "Why: gate" 2>/dev/null
as b git push -q . HEAD:main 2>/dev/null; expect 0 $? "b lands"

cd ../wt-d && plan d
printf 'export const greeting = () => "hello";\nexport const wave = () => "o/";\n' > src/greet.ts
printf 'import { expect, test } from "bun:test";\nimport { wave } from "../src/greet";\ntest("waves", () => expect(wave()).toBe("o/"));\n' > tests/wave.test.ts
git add -A && as d git commit -qm "wave" -m "Why: d is still working" 2>/dev/null

cd ../wt-a && plan a
as a git merge -q --no-edit main 2>/dev/null
echo 'export const greeting = () => "hi";' > src/greet.ts
sed -i '' 's/"hello"/"hi"/' tests/greet.test.ts
echo "adapted your greeting to hi" > .agents/notes/a-to-b.md
echo '- b: changed greeting to "hi"' >> .agents/plans/a.md
accept a
echo '- d: noted' >> .agents/plans/a.md
git add -A && as a git commit -qm "hi" -m "Why: shorter" 2>/dev/null
OUT=$(as a git push . HEAD:main 2>&1); code=$?
expect 1 $code "a is refused: a note and b's earlier agreement line don't exempt it"
echo "$OUT" | grep -q "b: their tests fail"; expect 0 $? "refusal names b's failing test"
echo '- Override: b — greeting is "hi" for the new brand voice' >> .agents/plans/a.md
git add -A && as a git commit -qm "declare override" -m "Why: landing gate" 2>/dev/null
as a git push -q . HEAD:main 2>/dev/null; expect 0 $? "a lands after declaring Override: b"
tail -1 ../repo/.git/agentsync/log.jsonl | grep -q '"overrides":\["b"\]'; expect 0 $? "override is logged for human review"

cd ../wt-c && plan c
as c git merge -q --no-edit main 2>/dev/null
printf 'export const greeting = () => "hi";\nexport const farewell = () => "bye";\n' > src/greet.ts
printf -- '- a: kept "hi"\n- b: kept what a decided\n- d: noted\n' >> .agents/plans/c.md
accept c
git add -A && as c git commit -qm "farewell" -m "Why: users leave too" 2>/dev/null
OUT=$(as c git push . HEAD:main 2>&1); code=$?
expect 0 $code "c lands: b's test already failed on main, d not landed"
[ $code -ne 0 ] && echo "$OUT" | tail -8

echo "override test: $pass passed, $fail failed"
[ "$fail" = 0 ]
