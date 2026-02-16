/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useContext,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";

import { createSeedTaskStore } from "@/mini-jira/data";
import {
  PriorityQueue,
  createsDependencyCycle,
  emptyStatusMap,
} from "@/mini-jira/structures";
import type {
  BoardAction,
  BoardState,
  MoveRecord,
  Task,
  TaskId,
  TaskStatus,
  ToastMessage,
  ToastPriority,
  ToastTone,
} from "@/mini-jira/types";

const MAX_HISTORY = 60;
const MAX_ACTIVE_TOASTS = 3;
let toastCounter = 0;

const BoardStateContext = createContext<BoardState | null>(null);
const BoardDispatchContext = createContext<Dispatch<BoardAction> | null>(null);

function toastComparator(left: ToastMessage, right: ToastMessage): number {
  if (left.priority !== right.priority) {
    return left.priority - right.priority;
  }

  return right.createdAt - left.createdAt;
}

function createToast(message: string, priority: ToastPriority, tone: ToastTone): ToastMessage {
  toastCounter += 1;
  return {
    id: `toast-${toastCounter}`,
    message,
    priority,
    tone,
    createdAt: Date.now(),
  };
}

function flushVisibleToasts(state: BoardState): BoardState {
  const queue = new PriorityQueue<ToastMessage>(toastComparator, state.toastHeap);
  const activeToasts = [...state.activeToasts];

  while (activeToasts.length < MAX_ACTIVE_TOASTS && queue.size > 0) {
    const nextToast = queue.pop();
    if (!nextToast) {
      break;
    }
    activeToasts.push(nextToast);
  }

  return {
    ...state,
    toastHeap: queue.toArray(),
    activeToasts,
  };
}

function enqueueSystemToast(
  state: BoardState,
  message: string,
  priority: ToastPriority,
  tone: ToastTone
): BoardState {
  const queue = new PriorityQueue<ToastMessage>(toastComparator, state.toastHeap);
  queue.push(createToast(message, priority, tone));

  return flushVisibleToasts({
    ...state,
    toastHeap: queue.toArray(),
  });
}

function buildStatusBuckets(byId: Record<TaskId, Task>, rootTaskIds: TaskId[]): Record<TaskStatus, TaskId[]> {
  const buckets = emptyStatusMap();

  for (const taskId of rootTaskIds) {
    const task = byId[taskId];
    if (!task) {
      continue;
    }
    buckets[task.status].push(task.id);
  }

  return buckets;
}

function appendHistory(stack: MoveRecord[], record: MoveRecord): MoveRecord[] {
  if (stack.length + 1 <= MAX_HISTORY) {
    return [...stack, record];
  }
  return [...stack.slice(1), record];
}

function createMoveRecord(
  taskIds: TaskId[],
  nextStatus: TaskStatus,
  byId: Record<TaskId, Task>
): MoveRecord | null {
  const fromStatusById: Record<TaskId, TaskStatus> = {};
  const toStatusById: Record<TaskId, TaskStatus> = {};

  for (const taskId of new Set(taskIds)) {
    const task = byId[taskId];
    if (!task || task.parentId !== null) {
      continue;
    }

    if (task.status === nextStatus) {
      continue;
    }

    fromStatusById[taskId] = task.status;
    toStatusById[taskId] = nextStatus;
  }

  if (Object.keys(fromStatusById).length === 0) {
    return null;
  }

  return {
    fromStatusById,
    toStatusById,
    changedAt: Date.now(),
  };
}

function applyStatusMap(
  tasks: BoardState["tasks"],
  statusByTaskId: Record<TaskId, TaskStatus>
): BoardState["tasks"] {
  const nextById: Record<TaskId, Task> = { ...tasks.byId };
  const now = Date.now();
  let changed = false;

  for (const [taskId, status] of Object.entries(statusByTaskId) as Array<[TaskId, TaskStatus]>) {
    const task = nextById[taskId];
    if (!task || task.parentId !== null || task.status === status) {
      continue;
    }

    nextById[taskId] = {
      ...task,
      status,
      updatedAt: now,
    };
    changed = true;
  }

  if (!changed) {
    return tasks;
  }

  return {
    ...tasks,
    byId: nextById,
    idsByStatus: buildStatusBuckets(nextById, tasks.rootTaskIds),
  };
}

function moveTasks(state: BoardState, taskIds: TaskId[], nextStatus: TaskStatus): BoardState {
  const record = createMoveRecord(taskIds, nextStatus, state.tasks.byId);
  if (!record) {
    return enqueueSystemToast(state, "No eligible tasks were moved.", 1, "info");
  }

  const tasks = applyStatusMap(state.tasks, record.toStatusById);
  const movedCount = Object.keys(record.toStatusById).length;

  const nextState: BoardState = {
    ...state,
    tasks,
    selectedTaskIds: new Set<TaskId>(),
    undoStack: appendHistory(state.undoStack, record),
    redoStack: [],
    revision: state.revision + 1,
  };

  return enqueueSystemToast(nextState, `Moved ${movedCount} task${movedCount > 1 ? "s" : ""}.`, 2, "success");
}

function createInitialBoardState(): BoardState {
  const tasks = createSeedTaskStore();
  const baseState: BoardState = {
    tasks,
    selectedTaskIds: new Set<TaskId>(),
    undoStack: [],
    redoStack: [],
    toastHeap: [],
    activeToasts: [],
    revision: 1,
  };

  return enqueueSystemToast(baseState, "Board seeded with 180 tasks.", 1, "info");
}

function boardReducer(state: BoardState, action: BoardAction): BoardState {
  switch (action.type) {
    case "toggle_task_selection": {
      const task = state.tasks.byId[action.taskId];
      if (!task || task.parentId !== null) {
        return state;
      }

      const selectedTaskIds = new Set(state.selectedTaskIds);
      if (selectedTaskIds.has(action.taskId)) {
        selectedTaskIds.delete(action.taskId);
      } else {
        selectedTaskIds.add(action.taskId);
      }

      return {
        ...state,
        selectedTaskIds,
      };
    }

    case "clear_selection": {
      if (state.selectedTaskIds.size === 0) {
        return state;
      }

      return {
        ...state,
        selectedTaskIds: new Set<TaskId>(),
      };
    }

    case "select_many": {
      const selectedTaskIds = new Set(state.selectedTaskIds);
      for (const taskId of action.taskIds) {
        const task = state.tasks.byId[taskId];
        if (!task || task.parentId !== null) {
          continue;
        }
        selectedTaskIds.add(taskId);
      }

      return {
        ...state,
        selectedTaskIds,
      };
    }

    case "deselect_many": {
      if (state.selectedTaskIds.size === 0 || action.taskIds.length === 0) {
        return state;
      }

      let changed = false;
      const selectedTaskIds = new Set(state.selectedTaskIds);

      for (const taskId of action.taskIds) {
        if (selectedTaskIds.delete(taskId)) {
          changed = true;
        }
      }

      if (!changed) {
        return state;
      }

      return {
        ...state,
        selectedTaskIds,
      };
    }

    case "move_tasks": {
      return moveTasks(state, action.taskIds, action.nextStatus);
    }

    case "bulk_move_selected": {
      if (state.selectedTaskIds.size === 0) {
        return enqueueSystemToast(state, "Select tasks before bulk move.", 1, "warning");
      }

      return moveTasks(state, Array.from(state.selectedTaskIds), action.nextStatus);
    }

    case "undo_move": {
      if (state.undoStack.length === 0) {
        return enqueueSystemToast(state, "Undo stack is empty.", 1, "info");
      }

      const record = state.undoStack[state.undoStack.length - 1];
      const tasks = applyStatusMap(state.tasks, record.fromStatusById);
      const nextState: BoardState = {
        ...state,
        tasks,
        undoStack: state.undoStack.slice(0, -1),
        redoStack: appendHistory(state.redoStack, record),
        revision: state.revision + 1,
      };

      return enqueueSystemToast(nextState, "Undid last move.", 2, "success");
    }

    case "redo_move": {
      if (state.redoStack.length === 0) {
        return enqueueSystemToast(state, "Redo stack is empty.", 1, "info");
      }

      const record = state.redoStack[state.redoStack.length - 1];
      const tasks = applyStatusMap(state.tasks, record.toStatusById);
      const nextState: BoardState = {
        ...state,
        tasks,
        redoStack: state.redoStack.slice(0, -1),
        undoStack: appendHistory(state.undoStack, record),
        revision: state.revision + 1,
      };

      return enqueueSystemToast(nextState, "Redid last move.", 2, "success");
    }

    case "add_dependency": {
      const task = state.tasks.byId[action.taskId];
      const dependencyTask = state.tasks.byId[action.dependsOnTaskId];

      if (!task || !dependencyTask) {
        return enqueueSystemToast(state, "Invalid dependency target.", 1, "error");
      }

      if (task.id === dependencyTask.id) {
        return enqueueSystemToast(state, "A task cannot depend on itself.", 1, "error");
      }

      if (task.dependencyIds.includes(dependencyTask.id)) {
        return enqueueSystemToast(state, "Dependency already exists.", 1, "info");
      }

      if (createsDependencyCycle(state.tasks.byId, task.id, dependencyTask.id)) {
        return enqueueSystemToast(state, "Dependency rejected: cycle detected.", 3, "error");
      }

      const updatedTask: Task = {
        ...task,
        dependencyIds: [...task.dependencyIds, dependencyTask.id],
        updatedAt: Date.now(),
      };

      return enqueueSystemToast(
        {
          ...state,
          tasks: {
            ...state.tasks,
            byId: {
              ...state.tasks.byId,
              [task.id]: updatedTask,
            },
          },
          revision: state.revision + 1,
        },
        `Dependency added: ${task.id} -> ${dependencyTask.id}`,
        2,
        "success"
      );
    }

    case "dismiss_toast": {
      const activeToasts = state.activeToasts.filter((toast) => toast.id !== action.toastId);
      if (activeToasts.length === state.activeToasts.length) {
        return state;
      }

      return flushVisibleToasts({
        ...state,
        activeToasts,
      });
    }

    case "enqueue_toast": {
      return enqueueSystemToast(
        state,
        action.toast.message,
        action.toast.priority,
        action.toast.tone
      );
    }

    default: {
      return state;
    }
  }
}

export function BoardProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(boardReducer, undefined, createInitialBoardState);
  const memoizedState = useMemo(() => state, [state]);

  return (
    <BoardStateContext.Provider value={memoizedState}>
      <BoardDispatchContext.Provider value={dispatch}>{children}</BoardDispatchContext.Provider>
    </BoardStateContext.Provider>
  );
}

export function useBoardState(): BoardState {
  const context = useContext(BoardStateContext);
  if (!context) {
    throw new Error("useBoardState must be used inside BoardProvider");
  }
  return context;
}

export function useBoardDispatch(): Dispatch<BoardAction> {
  const context = useContext(BoardDispatchContext);
  if (!context) {
    throw new Error("useBoardDispatch must be used inside BoardProvider");
  }
  return context;
}
