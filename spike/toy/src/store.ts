import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createTask, type Task } from "./task";

export function load(path: string): Task[] {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")) as Task[];
}

export function save(path: string, tasks: Task[]): void {
  writeFileSync(path, JSON.stringify(tasks, null, 2));
}

export function addTask(tasks: Task[], title: string): Task {
  const id = tasks.reduce((max, t) => Math.max(max, t.id), 0) + 1;
  const task = createTask(id, title);
  tasks.push(task);
  return task;
}

export function completeTask(tasks: Task[], id: number): Task {
  const task = tasks.find((t) => t.id === id);
  if (!task) throw new Error(`no task with id ${id}`);
  task.done = true;
  return task;
}
