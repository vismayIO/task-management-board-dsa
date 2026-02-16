export type TaskId = string;

export type TaskStatus = "backlog" | "todo" | "in_progress" | "done";

export type TaskPriority = "low" | "medium" | "high";

export const STATUS_ORDER: TaskStatus[] = ["backlog", "todo", "in_progress", "done"];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "To Do",
  in_progress: "In Progress",
  done: "Done",
};

export interface Task {
  id: TaskId;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  dependencyIds: TaskId[];
  subtaskIds: TaskId[];
  parentId: TaskId | null;
  createdAt: number;
  updatedAt: number;
}

export interface NormalizedTaskStore {
  byId: Record<TaskId, Task>;
  rootTaskIds: TaskId[];
  idsByStatus: Record<TaskStatus, TaskId[]>;
}

export interface MoveRecord {
  fromStatusById: Record<TaskId, TaskStatus>;
  toStatusById: Record<TaskId, TaskStatus>;
  changedAt: number;
}

export type ToastPriority = 1 | 2 | 3;

export type ToastTone = "info" | "success" | "warning" | "error";

export interface ToastMessage {
  id: string;
  message: string;
  priority: ToastPriority;
  tone: ToastTone;
  createdAt: number;
}

export interface BoardState {
  tasks: NormalizedTaskStore;
  selectedTaskIds: Set<TaskId>;
  undoStack: MoveRecord[];
  redoStack: MoveRecord[];
  toastHeap: ToastMessage[];
  activeToasts: ToastMessage[];
  revision: number;
}

export type BoardAction =
  | { type: "toggle_task_selection"; taskId: TaskId }
  | { type: "clear_selection" }
  | { type: "select_many"; taskIds: TaskId[] }
  | { type: "move_tasks"; taskIds: TaskId[]; nextStatus: TaskStatus }
  | { type: "bulk_move_selected"; nextStatus: TaskStatus }
  | { type: "undo_move" }
  | { type: "redo_move" }
  | { type: "add_dependency"; taskId: TaskId; dependsOnTaskId: TaskId }
  | { type: "dismiss_toast"; toastId: string }
  | {
      type: "enqueue_toast";
      toast: {
        message: string;
        priority: ToastPriority;
        tone: ToastTone;
      };
    };

export interface ColumnPage {
  taskIds: TaskId[];
  totalItems: number;
  cursor: number;
  pageSize: number;
  totalPages: number;
  currentPage: number;
  pageWindow: number[];
  nextCursor: number | null;
  prevCursor: number | null;
  cacheHit: boolean;
}
