import { expect, test } from "bun:test";
import { addTask, completeTask } from "../src/store";
import type { Task } from "../src/task";

test("addTask assigns increasing ids", () => {
  const tasks: Task[] = [];
  expect(addTask(tasks, "a").id).toBe(1);
  expect(addTask(tasks, "b").id).toBe(2);
});

test("completeTask marks a task complete", () => {
  const tasks: Task[] = [];
  addTask(tasks, "a");
  completeTask(tasks, 1);
  expect(tasks[0].done).toBe(true);
});
