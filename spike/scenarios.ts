// Test scenarios. Each has features (one per agent), a direction for the
// coordinated run, and a hidden acceptance test file in acceptance/.

export interface Scenario {
  direction: string;
  acceptance: string;
  features: Record<string, string>;
  // Agent pairs designed to clash: ground truth for overlap-detection recall.
  clashes: [string, string][];
}

const RICHER_TASKS = `Feature: richer tasks.
- Replace the boolean \`done\` field with \`status\`: "todo" | "doing" | "done".
- Add an optional \`priority\` ("low" | "medium" | "high") and an optional \`due\` date (YYYY-MM-DD).
- CLI: \`add <title> [--priority low|medium|high] [--due YYYY-MM-DD]\`, \`status <id> <todo|doing|done>\`,
  keep \`done <id>\` as a shortcut for status done, and show status/priority/due in \`list\`.
- Update the tests.`;

const CSV_EXPORT = `Feature: export.
- CLI: \`export --csv\` prints all tasks as CSV to stdout: a header row, then one row per task,
  with one column per task field (every field a task has), properly quoted when needed.
- Add tests.`;

export const SCENARIOS: Record<string, Scenario> = {
  // Two agents: a new data model and a feature that reads it.
  collide: {
    direction: `# Direction

A small command-line to-do app. Goals for this iteration:

- Richer tasks: status, priority, due dates.
- Getting data out: export tasks so other tools can use them.

Every feature must keep working together after merging to \`main\`.
`,
    acceptance: "collide.test.ts",
    clashes: [["a", "b"]],
    features: { a: RICHER_TASKS, b: CSV_EXPORT },
  },

  // Three agents, all touching cli.ts; b and c depend on a's data model.
  three: {
    direction: `# Direction

A small command-line to-do app. Goals for this iteration:

- Richer tasks: status, priority, due dates.
- Getting data out: export tasks so other tools can use them.
- Finding things: filter and sort the task list.

Every feature must keep working together after merging to \`main\`.
`,
    acceptance: "three.test.ts",
    clashes: [["a", "b"], ["a", "c"], ["b", "c"]],
    features: {
      a: RICHER_TASKS,
      b: CSV_EXPORT,
      c: `Feature: filtering and sorting.
- CLI: \`list --status <todo|doing|done>\` shows only tasks with that status,
  \`list --priority <low|medium|high>\` shows only tasks with that priority,
  \`list --sort due\` orders tasks by due date (tasks without one last). Options can be combined.
- Tasks are getting \`status\`, \`priority\` and \`due\` fields this iteration (a teammate is adding them).
- Add tests.`,
    },
  },

  // Requirements that genuinely can't both hold: someone has to give way.
  nowin: {
    direction: `# Direction

A small command-line to-do app. Goals for this iteration:

- Make tasks.json pleasant for people who edit it by hand and review it in git.
- Make storage lean for people who sync tasks.json over slow connections.

Every feature must keep working together after merging to \`main\`.
`,
    acceptance: "nowin.test.ts",
    clashes: [["a", "b"]],
    features: {
      a: `Feature: human-friendly storage.
- People edit tasks.json by hand and review it in git diffs. By default, save it pretty-printed:
  indented, one field per line.
- Add tests.`,
      b: `Feature: compact storage.
- tasks.json is synced over slow mobile connections. By default, save it as compact single-line
  JSON with no whitespace.
- Add tests.`,
    },
  },

  // a renames a field that b's new features read and write.
  rename: {
    direction: `# Direction

A small command-line to-do app. Goals for this iteration:

- Align the data model with the upcoming sync API, which calls a task's text \`text\`.
- Make tasks easier to find and fix.

Every feature must keep working together after merging to \`main\`.
`,
    acceptance: "rename.test.ts",
    clashes: [["a", "b"]],
    features: {
      a: `Feature: sync API naming.
- Rename the task field \`title\` to \`text\` everywhere (type, store, CLI, tests), so tasks.json
  matches the sync API. Existing tasks.json files that still use \`title\` must keep loading.
- Update the tests.`,
      b: `Feature: find and fix tasks.
- CLI: \`search <words>\` lists tasks whose title contains the words (case-insensitive), and
  \`edit <id> <new title>\` changes a task's title.
- Add tests.`,
    },
  },

  // b's feature lives in a different file but depends on a's storage format.
  hiddendep: {
    direction: `# Direction

A small command-line to-do app. Goals for this iteration:

- Make the storage format future-proof so it can be migrated later.
- Protect people's data with backups.

Every feature must keep working together after merging to \`main\`.
`,
    acceptance: "hiddendep.test.ts",
    clashes: [["a", "b"]],
    features: {
      a: `Feature: versioned storage.
- tasks.json must become an object \`{ "version": 2, "tasks": [...] }\` instead of a bare array,
  so the format can be migrated later. Old bare-array files must still load (and are saved in the
  new format).
- Update the tests.`,
      b: `Feature: backups.
- Put the logic in a new file \`src/backup.ts\` and wire it into the CLI:
  \`backup <file>\` copies the current tasks.json to <file>;
  \`restore <file>\` replaces tasks.json with <file>, but first validates that <file> is a valid
  tasks file and refuses (exit code 1, message on stderr) if it isn't.
- Add tests.`,
    },
  },

  // Six agents, six features, mostly in the same two files.
  crowd: {
    direction: `# Direction

A small command-line to-do app. Goals for this iteration:

- Richer tasks: status, priority, due dates, tags.
- Getting data out: CSV export and stats.
- Finding things: filter and sort.
- Fixing things: edit and delete.

Every feature must keep working together after merging to \`main\`.
`,
    acceptance: "crowd.test.ts",
    clashes: [["a", "b"], ["a", "c"], ["a", "f"]],
    features: {
      a: RICHER_TASKS,
      b: CSV_EXPORT,
      c: `Feature: filtering and sorting.
- CLI: \`list --status <todo|doing|done>\`, \`list --priority <low|medium|high>\`,
  \`list --sort due\` (tasks without a due date last). Options can be combined.
- Tasks are getting \`status\`, \`priority\` and \`due\` fields this iteration (a teammate is adding them).
- Add tests.`,
      d: `Feature: tags.
- Tasks get a \`tags\` field (list of strings). CLI: \`add <title> --tag <tag>\` (repeatable),
  \`list --tag <tag>\` shows only tasks with that tag, and \`list\` shows tags as #tag.
- Add tests.`,
      e: `Feature: edit and delete.
- CLI: \`edit <id> <new title>\` changes a task's title; \`delete <id>\` removes a task.
- Add tests.`,
      f: `Feature: stats.
- CLI: \`stats\` prints one line per status with its count, e.g. \`todo: 3\`, \`doing: 1\`, \`done: 2\`.
- Tasks are getting a \`status\` field (todo|doing|done) this iteration (a teammate is adding it).
- Add tests.`,
    },
  },

  // Two agents whose requirements pull in opposite directions.
  disagree: {
    direction: `# Direction

A small command-line to-do app. Goals for this iteration:

- Prepare for syncing tasks between devices later this year.
- Make the CLI faster to use day to day.

Every feature must keep working together after merging to \`main\`.
`,
    acceptance: "disagree.test.ts",
    clashes: [["a", "b"]],
    features: {
      a: `Feature: sync-ready ids.
- Tasks will soon be synced between devices, so ids must be globally unique:
  the \`id\` field stored in tasks.json must become a random UUID string (crypto.randomUUID()).
- Update store, CLI and tests accordingly.`,
      b: `Feature: quick task commands.
- Users want to type short numbers: \`done <n>\` and a new \`delete <n>\` command, where <n> is
  the small number shown next to each task in \`list\` (1, 2, 3, ...).
- \`delete <n>\` removes that task. Keep the numbers short and easy to type.
- Add tests.`,
    },
  },
};
