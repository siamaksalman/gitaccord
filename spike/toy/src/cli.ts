import { addTask, completeTask, load, save } from "./store";

const file = process.env.TODO_FILE ?? "tasks.json";
const [command, ...args] = process.argv.slice(2);
const tasks = load(file);

switch (command) {
  case "add": {
    const task = addTask(tasks, args.join(" "));
    save(file, tasks);
    console.log(`added #${task.id}: ${task.title}`);
    break;
  }
  case "list":
    for (const t of tasks) console.log(`${t.done ? "[x]" : "[ ]"} #${t.id} ${t.title}`);
    break;
  case "done": {
    const task = completeTask(tasks, Number(args[0]));
    save(file, tasks);
    console.log(`completed #${task.id}`);
    break;
  }
  default:
    console.error("usage: cli.ts add <title> | list | done <id>");
    process.exit(1);
}
