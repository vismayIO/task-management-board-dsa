import { emptyStatusMap } from "@/mini-jira/structures";
import type {
  NormalizedTaskStore,
  Task,
  TaskId,
  TaskPriority,
  TaskStatus,
} from "@/mini-jira/types";

const STATUS_PATTERN: TaskStatus[] = ["backlog", "todo", "in_progress", "done"];
const PRIORITY_PATTERN: TaskPriority[] = ["low", "medium", "high", "medium"];
const FOCUS_AREAS = [
  "Authentication",
  "Billing",
  "Roadmap",
  "Editor",
  "Analytics",
  "Automation",
  "Deployment",
  "Search",
  "Notifications",
  "Performance",
  "Integrations",
  "Reporting",
] as const;
const ACTION_VERBS = [
  "Refactor",
  "Implement",
  "Audit",
  "Backfill",
  "Stabilize",
  "Prototype",
  "Document",
  "Optimize",
] as const;

const ROOT_TASK_COUNT = 180;

function taskIdFromIndex(index: number): TaskId {
  return `TASK-${index.toString().padStart(3, "0")}`;
}

function createRootTask(index: number, now: number): Task {
  const area = FOCUS_AREAS[index % FOCUS_AREAS.length];
  const verb = ACTION_VERBS[index % ACTION_VERBS.length];
  const status = STATUS_PATTERN[index % STATUS_PATTERN.length];

  return {
    id: taskIdFromIndex(index),
    title: `${verb} ${area} workflow ${index}`,
    description: `Delivery slice ${index} for ${area.toLowerCase()} in sprint ${Math.floor(index / 10) + 1}.`,
    status,
    priority: PRIORITY_PATTERN[index % PRIORITY_PATTERN.length],
    dependencyIds: [],
    subtaskIds: [],
    parentId: null,
    createdAt: now - index * 50_000,
    updatedAt: now - index * 30_000,
  };
}

function maybeAddDependencies(index: number): TaskId[] {
  const dependencies: TaskId[] = [];

  if (index > 5 && index % 3 === 0) {
    dependencies.push(taskIdFromIndex(index - 2));
  }
  if (index > 8 && index % 7 === 0) {
    dependencies.push(taskIdFromIndex(index - 5));
  }
  if (index > 20 && index % 11 === 0) {
    dependencies.push(taskIdFromIndex(index - 9));
  }

  return [...new Set(dependencies)];
}

function createSubtask(
  parent: Task,
  subtaskIndex: number,
  now: number,
  depth = 1
): Task {
  const suffix = depth === 1 ? `S${subtaskIndex}` : `S${subtaskIndex}A`;
  const taskId = `${parent.id}-${suffix}`;

  return {
    id: taskId,
    title: `${depth === 1 ? "Subtask" : "Nested"} ${subtaskIndex} for ${parent.id}`,
    description: `Breakdown item ${subtaskIndex} attached to ${parent.title}.`,
    status: parent.status === "done" ? "done" : "todo",
    priority: parent.priority,
    dependencyIds: [],
    subtaskIds: [],
    parentId: parent.id,
    createdAt: now - subtaskIndex * 4_000,
    updatedAt: now - subtaskIndex * 2_000,
  };
}

export function createSeedTaskStore(): NormalizedTaskStore {
  const now = Date.now();
  const byId: Record<TaskId, Task> = {};
  const rootTaskIds: TaskId[] = [];
  const idsByStatus = emptyStatusMap();

  for (let index = 1; index <= ROOT_TASK_COUNT; index += 1) {
    const rootTask = createRootTask(index, now);
    rootTask.dependencyIds = maybeAddDependencies(index);

    byId[rootTask.id] = rootTask;
    rootTaskIds.push(rootTask.id);
    idsByStatus[rootTask.status].push(rootTask.id);

    const subtaskCount = index % 6 === 0 ? 3 : index % 4 === 0 ? 2 : index % 3 === 0 ? 1 : 0;

    for (let subIndex = 1; subIndex <= subtaskCount; subIndex += 1) {
      const subtask = createSubtask(rootTask, subIndex, now, 1);
      rootTask.subtaskIds.push(subtask.id);
      byId[subtask.id] = subtask;

      if (index % 9 === 0 && subIndex === 2) {
        const nested = createSubtask(subtask, 1, now, 2);
        subtask.subtaskIds.push(nested.id);
        byId[nested.id] = nested;
      }
    }
  }

  return {
    byId,
    rootTaskIds,
    idsByStatus,
  };
}
