import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type DragEvent,
} from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  BoardProvider,
  useBoardDispatch,
  useBoardState,
} from "@/mini-jira/board-context";
import {
  LRUCache,
  TaskTrie,
  buildPrefixSums,
  getCursorWindow,
  getVirtualRange,
  normalizeSearchTerm,
} from "@/mini-jira/structures";
import type {
  ColumnPage,
  Task,
  TaskId,
  TaskPriority,
  TaskStatus,
  ToastMessage,
  ToastTone,
} from "@/mini-jira/types";
import { STATUS_LABELS, STATUS_ORDER } from "@/mini-jira/types";
import { useDebouncedValue } from "@/mini-jira/useDebouncedValue";

const VIEWPORT_HEIGHT = 480;
const OVERSCAN = 3;
const PAGE_SIZE_OPTIONS = [24, 48, 72] as const;
const TASK_CARD_HEIGHT = 252;
const TASK_ROW_HEIGHT = TASK_CARD_HEIGHT + 8;

const CONTROL_LABEL_CLASS =
  "text-[11px] font-semibold uppercase tracking-[0.08em] text-[#4a5965]";

const STATUS_DOT_CLASS: Record<TaskStatus, string> = {
  backlog: "bg-slate-400",
  todo: "bg-blue-600",
  in_progress: "bg-amber-500",
  done: "bg-emerald-600",
};

const PRIORITY_BADGE_CLASS: Record<TaskPriority, string> = {
  low: "border-emerald-300 bg-emerald-50 text-emerald-700",
  medium: "border-amber-300 bg-amber-50 text-amber-700",
  high: "border-red-300 bg-red-50 text-red-700",
};

const TOAST_TONE_CLASS: Record<ToastTone, string> = {
  info: "border-blue-300 text-blue-800",
  success: "border-emerald-300 text-emerald-800",
  warning: "border-amber-300 text-amber-800",
  error: "border-red-300 text-red-800",
};

interface StatusColumnProps {
  status: TaskStatus;
  query: string;
  pageSize: number;
  tasksById: Record<TaskId, Task>;
  selectedTaskIds: Set<TaskId>;
  draggingTaskId: TaskId | null;
  isDropActive: boolean;
  fetchColumnPage: (
    status: TaskStatus,
    cursor: number,
    query: string,
    pageSize: number,
  ) => Promise<ColumnPage>;
  onTaskDragStart: (taskId: TaskId) => void;
  onTaskDragEnd: () => void;
  onColumnDragOver: (status: TaskStatus) => void;
  onColumnDragLeave: (status: TaskStatus) => void;
  onColumnDrop: (status: TaskStatus) => void;
  onToggleSelect: (taskId: TaskId) => void;
  onMoveTask: (taskId: TaskId, nextStatus: TaskStatus) => void;
  onSelectMany: (taskIds: TaskId[]) => void;
}

function estimateTaskHeight(): number {
  return TASK_ROW_HEIGHT;
}

const SubtaskTree = memo(function SubtaskTree({
  taskId,
  tasksById,
  depth,
}: {
  taskId: TaskId;
  tasksById: Record<TaskId, Task>;
  depth: number;
}) {
  const task = tasksById[taskId];
  if (!task) {
    return null;
  }

  return (
    <li className="grid gap-0.5" style={{ paddingLeft: `${depth * 0.55}rem` }}>
      <div className="inline-flex items-center gap-1.5 text-[11px] text-[#2f3b45]">
        <span
          className={cn(
            "inline-block size-2 rounded-full",
            STATUS_DOT_CLASS[task.status],
          )}
        />
        <span className="overflow-hidden [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:1]">
          {task.title}
        </span>
      </div>
      {task.subtaskIds.length > 0 ? (
        <ul className="grid list-none gap-0.5 p-0">
          {task.subtaskIds.map((subtaskId) => (
            <SubtaskTree
              key={subtaskId}
              taskId={subtaskId}
              tasksById={tasksById}
              depth={depth + 1}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
});

const TaskCard = memo(function TaskCard({
  task,
  tasksById,
  selected,
  isDragging,
  onDragStart,
  onDragEnd,
  onToggleSelect,
  onMoveTask,
}: {
  task: Task;
  tasksById: Record<TaskId, Task>;
  selected: boolean;
  isDragging: boolean;
  onDragStart: (taskId: TaskId) => void;
  onDragEnd: () => void;
  onToggleSelect: (taskId: TaskId) => void;
  onMoveTask: (taskId: TaskId, nextStatus: TaskStatus) => void;
}) {
  const dependencyTitles = useMemo(
    () =>
      task.dependencyIds.map(
        (dependencyId) => tasksById[dependencyId]?.title ?? dependencyId,
      ),
    [task.dependencyIds, tasksById],
  );
  const dependencyPreview = dependencyTitles.slice(0, 1);
  const hiddenDependencyCount = Math.max(
    0,
    dependencyTitles.length - dependencyPreview.length,
  );
  const subtaskPreview = task.subtaskIds.slice(0, 1);
  const hiddenSubtaskCount = Math.max(
    0,
    task.subtaskIds.length - subtaskPreview.length,
  );

  const handleMove = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      onMoveTask(task.id, event.target.value as TaskStatus);
    },
    [task.id, onMoveTask],
  );

  return (
    <Card
      size="sm"
      className={cn(
        "h-[252px] gap-2 rounded-lg border border-[#dfe4e8] bg-white py-3 transition [transition-property:transform,box-shadow,opacity]",
        "cursor-grab active:cursor-grabbing hover:-translate-y-0.5 hover:shadow-[0_8px_18px_rgba(9,30,66,0.12)]",
        selected && "border-[#0972d3] shadow-[0_0_0_1px_rgba(9,114,211,0.38)]",
        isDragging && "scale-[0.98] opacity-55",
      )}
      draggable
      aria-grabbed={isDragging}
      onDragStart={(event: DragEvent<HTMLElement>) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", task.id);
        onDragStart(task.id);
      }}
      onDragEnd={() => {
        onDragEnd();
      }}
    >
      <CardHeader className="gap-1 px-3">
        <div className="flex items-center justify-between gap-2">
          <Label
            htmlFor={`task-select-${task.id}`}
            className="text-xs font-normal text-[#4a5965]"
          >
            <Checkbox
              id={`task-select-${task.id}`}
              checked={selected}
              onCheckedChange={() => {
                onToggleSelect(task.id);
              }}
            />
            <span>#{task.id.slice(-3)}</span>
          </Label>
          <Badge
            variant="outline"
            className={cn("uppercase", PRIORITY_BADGE_CLASS[task.priority])}
          >
            {task.priority}
          </Badge>
        </div>

        <CardTitle className="text-[15px] leading-5 tracking-[-0.01em] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
          {task.title}
        </CardTitle>

        <CardDescription className="text-xs leading-4 [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
          {task.description}
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-2 px-3 pb-0 pt-0">
        {dependencyTitles.length > 0 ? (
          <div className="rounded-md border border-dashed border-[#dfe4e8] bg-[#f8fafc] px-2 py-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#4a5965]">
              Depends on
            </p>
            <ul className="mt-1 grid list-none gap-0.5 p-0">
              {dependencyPreview.map((title) => (
                <li
                  key={title}
                  className="text-[11px] text-[#2f3b45] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:1]"
                >
                  {title}
                </li>
              ))}
            </ul>
            {hiddenDependencyCount > 0 ? (
              <p className="mt-0.5 text-[10px] text-[#4a5965]">
                +{hiddenDependencyCount} more dependency
              </p>
            ) : null}
          </div>
        ) : null}

        {task.subtaskIds.length > 0 ? (
          <div className="rounded-md border border-dashed border-[#dfe4e8] bg-[#f8fafc] px-2 py-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#4a5965]">
              Subtasks
            </p>
            <ul className="mt-1 max-h-11 list-none overflow-hidden p-0">
              {subtaskPreview.map((subtaskId) => (
                <SubtaskTree
                  key={subtaskId}
                  taskId={subtaskId}
                  tasksById={tasksById}
                  depth={1}
                />
              ))}
            </ul>
            {hiddenSubtaskCount > 0 ? (
              <p className="mt-0.5 text-[10px] text-[#4a5965]">
                +{hiddenSubtaskCount} more subtasks
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>

      <CardFooter className="mt-auto border-t-0 bg-transparent px-3 pb-3 pt-0">
        <div className="grid w-full gap-1">
          <Label
            htmlFor={`task-status-${task.id}`}
            className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#4a5965]"
          >
            Move
          </Label>
          <NativeSelect
            id={`task-status-${task.id}`}
            className="w-full"
            value={task.status}
            onChange={handleMove}
          >
            {STATUS_ORDER.map((status) => (
              <NativeSelectOption key={status} value={status}>
                {STATUS_LABELS[status]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </CardFooter>
    </Card>
  );
});

const StatusColumn = memo(function StatusColumn({
  status,
  query,
  pageSize,
  tasksById,
  selectedTaskIds,
  draggingTaskId,
  isDropActive,
  fetchColumnPage,
  onTaskDragStart,
  onTaskDragEnd,
  onColumnDragOver,
  onColumnDragLeave,
  onColumnDrop,
  onToggleSelect,
  onMoveTask,
  onSelectMany,
}: StatusColumnProps) {
  const [cursor, setCursor] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [page, setPage] = useState<ColumnPage>({
    taskIds: [],
    totalItems: 0,
    cursor: 0,
    pageSize,
    totalPages: 1,
    currentPage: 1,
    pageWindow: [1],
    nextCursor: null,
    prevCursor: null,
    cacheHit: false,
  });

  useEffect(() => {
    let ignore = false;

    void fetchColumnPage(status, cursor, query, pageSize)
      .then((nextPage) => {
        if (ignore) {
          return;
        }

        setPage(nextPage);
        if (nextPage.cursor !== cursor) {
          setCursor(nextPage.cursor);
        }
      })
      .catch(() => {
        if (!ignore) {
          setPage((previous) => ({
            ...previous,
            taskIds: [],
          }));
        }
      });

    return () => {
      ignore = true;
    };
  }, [status, cursor, query, pageSize, fetchColumnPage]);

  const heights = useMemo(
    () => page.taskIds.map(() => estimateTaskHeight()),
    [page.taskIds],
  );
  const prefixSums = useMemo(() => buildPrefixSums(heights), [heights]);
  const virtualRange = useMemo(
    () => getVirtualRange(prefixSums, scrollTop, VIEWPORT_HEIGHT, OVERSCAN),
    [prefixSums, scrollTop],
  );

  const visibleTaskIds = useMemo(
    () => page.taskIds.slice(virtualRange.startIndex, virtualRange.endIndex),
    [page.taskIds, virtualRange],
  );

  return (
    <Card
      className={cn(
        "overflow-hidden rounded-xl border border-[#c7d2d5] bg-white py-0 shadow-sm",
        isDropActive &&
          "border-[#0972d3] shadow-[inset_0_0_0_1px_rgba(9,114,211,0.5),0_8px_16px_rgba(9,114,211,0.16)]",
      )}
      onDragOver={(event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        onColumnDragOver(status);
      }}
      onDragLeave={(event: DragEvent<HTMLElement>) => {
        const relatedTarget = event.relatedTarget;
        if (
          relatedTarget instanceof Node &&
          event.currentTarget.contains(relatedTarget)
        ) {
          return;
        }
        onColumnDragLeave(status);
      }}
      onDrop={(event: DragEvent<HTMLElement>) => {
        event.preventDefault();
        onColumnDrop(status);
      }}
    >
      <CardHeader className="border-b border-[#dfe4e8] px-3 py-2.5">
        <CardTitle className="text-[15px] font-semibold tracking-[-0.01em] text-[#16191f]">
          {STATUS_LABELS[status]}
        </CardTitle>
        <CardDescription className="text-[11px] text-[#4a5965]">
          {page.totalItems} tasks
        </CardDescription>
        <CardAction>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              onSelectMany(page.taskIds);
            }}
            disabled={page.taskIds.length === 0}
          >
            Select page
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="p-0">
        <div
          className="relative h-[22rem] overflow-auto bg-[#fbfcfd] md:h-[30rem]"
          onScroll={(event) => {
            setScrollTop(event.currentTarget.scrollTop);
          }}
        >
          {page.taskIds.length === 0 ? (
            <div className="grid h-full place-items-center text-sm text-[#4a5965]">
              No tasks for this filter.
            </div>
          ) : (
            <div
              style={
                {
                  height: `${virtualRange.totalHeight}px`,
                } as CSSProperties
              }
              className="relative w-full"
            >
              {visibleTaskIds.map((taskId, index) => {
                const absoluteIndex = virtualRange.startIndex + index;
                const top = prefixSums[absoluteIndex];
                const task = tasksById[taskId];
                if (!task) {
                  return null;
                }

                return (
                  <div
                    key={taskId}
                    className="absolute inset-x-0 px-2"
                    style={{ top: `${top}px`, height: `${TASK_ROW_HEIGHT}px` }}
                  >
                    <TaskCard
                      task={task}
                      tasksById={tasksById}
                      selected={selectedTaskIds.has(taskId)}
                      isDragging={draggingTaskId === taskId}
                      onDragStart={onTaskDragStart}
                      onDragEnd={onTaskDragEnd}
                      onToggleSelect={onToggleSelect}
                      onMoveTask={onMoveTask}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </CardContent>

      <CardFooter className="flex-col gap-2 border-t border-[#dfe4e8] bg-[#f8fafc] px-3 py-2.5">
        <div className="flex w-full items-center justify-between gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              if (page.prevCursor !== null) {
                setCursor(page.prevCursor);
              }
            }}
            disabled={page.prevCursor === null}
          >
            Prev
          </Button>
          <div className="flex items-center gap-1">
            {page.pageWindow.map((pageNumber) => (
              <Button
                type="button"
                key={pageNumber}
                size="icon-sm"
                variant={
                  pageNumber === page.currentPage ? "default" : "outline"
                }
                onClick={() => {
                  setCursor((pageNumber - 1) * pageSize);
                }}
              >
                {pageNumber}
              </Button>
            ))}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              if (page.nextCursor !== null) {
                setCursor(page.nextCursor);
              }
            }}
            disabled={page.nextCursor === null}
          >
            Next
          </Button>
        </div>

        <div className="w-full text-right text-[11px] text-[#4a5965]">
          {page.cacheHit ? "LRU cache hit" : "LRU cache miss"}
        </div>
      </CardFooter>
    </Card>
  );
});

const ToastItem = memo(function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastMessage;
  onDismiss: (toastId: string) => void;
}) {
  useEffect(() => {
    const timeoutMs = 3200 - toast.priority * 300;
    const timerId = window.setTimeout(() => {
      onDismiss(toast.id);
    }, timeoutMs);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [toast.id, toast.priority, onDismiss]);

  return (
    <li>
      <Card
        size="sm"
        className={cn(
          "rounded-lg border bg-white py-2",
          TOAST_TONE_CLASS[toast.tone],
        )}
      >
        <CardContent className="flex items-center justify-between gap-2 px-3 py-0">
          <p className="text-xs sm:text-sm">{toast.message}</p>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => {
              onDismiss(toast.id);
            }}
          >
            Dismiss
          </Button>
        </CardContent>
      </Card>
    </li>
  );
});

function TaskBoardBody() {
  const state = useBoardState();
  const dispatch = useBoardDispatch();

  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 220);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE_OPTIONS[1]);
  const [bulkStatus, setBulkStatus] = useState<TaskStatus>("in_progress");
  const [dependencyTaskId, setDependencyTaskId] = useState<TaskId>("");
  const [dependsOnTaskId, setDependsOnTaskId] = useState<TaskId>("");
  const [draggingTaskId, setDraggingTaskId] = useState<TaskId | null>(null);
  const [dropTargetStatus, setDropTargetStatus] = useState<TaskStatus | null>(
    null,
  );

  const responseCacheRef = useRef(new LRUCache<string, ColumnPage>(120));

  const rootTasks = useMemo(
    () =>
      state.tasks.rootTaskIds
        .map((taskId) => state.tasks.byId[taskId])
        .filter((task): task is Task => Boolean(task)),
    [state.tasks.byId, state.tasks.rootTaskIds],
  );

  const selectedDependencyTaskId = dependencyTaskId || rootTasks[0]?.id || "";
  const selectedDependsOnTaskId =
    dependsOnTaskId || rootTasks[1]?.id || rootTasks[0]?.id || "";

  const trie = useMemo(() => {
    const nextTrie = new TaskTrie();
    for (const rootTaskId of state.tasks.rootTaskIds) {
      const task = state.tasks.byId[rootTaskId];
      if (!task) {
        continue;
      }
      nextTrie.insert(task.title, task.id);
    }
    return nextTrie;
  }, [state.tasks.byId, state.tasks.rootTaskIds]);

  const autocompleteSuggestions = useMemo(() => {
    if (!query.trim()) {
      return [] as Task[];
    }

    const suggestionIds = trie.suggest(query, 6);
    return suggestionIds
      .map((taskId) => state.tasks.byId[taskId])
      .filter(Boolean);
  }, [query, trie, state.tasks.byId]);

  const dependencyEdgeCount = useMemo(
    () =>
      rootTasks.reduce((count, task) => count + task.dependencyIds.length, 0),
    [rootTasks],
  );

  const fetchColumnPage = useCallback(
    async (
      status: TaskStatus,
      requestedCursor: number,
      requestedQuery: string,
      requestedPageSize: number,
    ): Promise<ColumnPage> => {
      const normalizedQuery = normalizeSearchTerm(requestedQuery);
      const cacheKey = [
        state.revision,
        status,
        normalizedQuery,
        requestedCursor,
        requestedPageSize,
      ].join("|");

      const cached = responseCacheRef.current.get(cacheKey);
      if (cached) {
        return {
          ...cached,
          cacheHit: true,
        };
      }

      await new Promise((resolve) => {
        window.setTimeout(resolve, 100);
      });

      const sourceTaskIds = state.tasks.idsByStatus[status];
      const matchingTaskIds = normalizedQuery
        ? sourceTaskIds.filter((taskId) => {
            const task = state.tasks.byId[taskId];
            if (!task) {
              return false;
            }
            const compositeText =
              `${task.title} ${task.description}`.toLowerCase();
            return compositeText.includes(normalizedQuery);
          })
        : sourceTaskIds;

      const cursorWindow = getCursorWindow(
        matchingTaskIds.length,
        requestedCursor,
        requestedPageSize,
        5,
      );

      const taskIds = matchingTaskIds.slice(
        cursorWindow.cursor,
        cursorWindow.cursor + requestedPageSize,
      );

      const result: ColumnPage = {
        taskIds,
        totalItems: matchingTaskIds.length,
        cursor: cursorWindow.cursor,
        pageSize: requestedPageSize,
        totalPages: cursorWindow.totalPages,
        currentPage: cursorWindow.currentPage,
        pageWindow: cursorWindow.pageWindow,
        nextCursor: cursorWindow.nextCursor,
        prevCursor: cursorWindow.prevCursor,
        cacheHit: false,
      };

      responseCacheRef.current.set(cacheKey, result);
      return result;
    },
    [state.revision, state.tasks.byId, state.tasks.idsByStatus],
  );

  const handleToggleSelect = useCallback(
    (taskId: TaskId) => {
      dispatch({ type: "toggle_task_selection", taskId });
    },
    [dispatch],
  );

  const handleMoveTask = useCallback(
    (taskId: TaskId, nextStatus: TaskStatus) => {
      dispatch({
        type: "move_tasks",
        taskIds: [taskId],
        nextStatus,
      });
    },
    [dispatch],
  );

  const handleSelectMany = useCallback(
    (taskIds: TaskId[]) => {
      dispatch({
        type: "select_many",
        taskIds,
      });
    },
    [dispatch],
  );

  const handleDismissToast = useCallback(
    (toastId: string) => {
      dispatch({
        type: "dismiss_toast",
        toastId,
      });
    },
    [dispatch],
  );

  const handleTaskDragStart = useCallback((taskId: TaskId) => {
    setDraggingTaskId(taskId);
  }, []);

  const handleTaskDragEnd = useCallback(() => {
    setDraggingTaskId(null);
    setDropTargetStatus(null);
  }, []);

  const handleColumnDragOver = useCallback(
    (status: TaskStatus) => {
      if (!draggingTaskId) {
        return;
      }
      setDropTargetStatus((current) => (current === status ? current : status));
    },
    [draggingTaskId],
  );

  const handleColumnDragLeave = useCallback(
    (status: TaskStatus) => {
      if (!draggingTaskId) {
        return;
      }
      setDropTargetStatus((current) => (current === status ? null : current));
    },
    [draggingTaskId],
  );

  const handleColumnDrop = useCallback(
    (status: TaskStatus) => {
      if (!draggingTaskId) {
        return;
      }

      const draggedTask = state.tasks.byId[draggingTaskId];
      if (!draggedTask || draggedTask.parentId !== null) {
        setDraggingTaskId(null);
        setDropTargetStatus(null);
        return;
      }

      const taskIds = state.selectedTaskIds.has(draggingTaskId)
        ? Array.from(state.selectedTaskIds)
        : [draggingTaskId];

      dispatch({
        type: "move_tasks",
        taskIds,
        nextStatus: status,
      });
      setDraggingTaskId(null);
      setDropTargetStatus(null);
    },
    [dispatch, draggingTaskId, state.selectedTaskIds, state.tasks.byId],
  );

  return (
    <main className="min-h-dvh bg-[#f3f4f7] p-3 text-[#16191f] sm:p-4 lg:p-6">
      <Card className="rounded-xl border border-[#c7d2d5] bg-white py-0 shadow-sm">
        <CardContent className="grid gap-4 py-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.09em] text-[#0972d3]">
              Task Management Board • Mini Jira
            </p>
            <h1 className="mt-1 text-[clamp(1.35rem,2.2vw,2.1rem)] leading-tight font-semibold tracking-[-0.02em]">
              Data-Structure Driven Workflow Board
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[#4a5965]">
              Demonstrates normalized state, trie search, LRU-cached pagination,
              undo/redo stacks, priority queue toasts, recursive trees,
              dependency graphs, and virtualized rendering.
            </p>
          </div>
          <dl className="grid gap-2">
            <div>
              <dt className="text-[11px] uppercase tracking-[0.08em] text-[#4a5965]">
                Root Tasks
              </dt>
              <dd className="mt-0.5 text-2xl font-bold tracking-[-0.02em]">
                {state.tasks.rootTaskIds.length}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-[0.08em] text-[#4a5965]">
                Selected
              </dt>
              <dd className="mt-0.5 text-2xl font-bold tracking-[-0.02em]">
                {state.selectedTaskIds.size}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-[0.08em] text-[#4a5965]">
                Dependency Edges
              </dt>
              <dd className="mt-0.5 text-2xl font-bold tracking-[-0.02em]">
                {dependencyEdgeCount}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <section className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Card
          size="sm"
          className="rounded-xl border border-[#c7d2d5] bg-white py-3 shadow-sm md:col-span-2"
        >
          <CardContent className="grid gap-2 px-3 py-0">
            <Label htmlFor="search-box" className={CONTROL_LABEL_CLASS}>
              Search tasks (Trie + debounce)
            </Label>
            <Input
              id="search-box"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              placeholder="Type task title prefix..."
            />
            {autocompleteSuggestions.length > 0 ? (
              <div className="max-h-48 overflow-y-auto rounded-md border border-[#c7d2d5] bg-white p-1 shadow-[0_8px_18px_rgba(9,30,66,0.14)]">
                {autocompleteSuggestions.map((task) => (
                  <Button
                    key={task.id}
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-full justify-start"
                    onClick={() => {
                      setQuery(task.title);
                    }}
                  >
                    {task.title}
                  </Button>
                ))}
              </div>
            ) : null}
            <small className="text-xs text-[#4a5965]">
              Debounced query: “{debouncedQuery || "(empty)"}”
            </small>
          </CardContent>
        </Card>

        <Card
          size="sm"
          className="rounded-xl border border-[#c7d2d5] bg-white py-3 shadow-sm"
        >
          <CardContent className="grid gap-2 px-3 py-0">
            <Label htmlFor="page-size-select" className={CONTROL_LABEL_CLASS}>
              Page size (cursor pagination)
            </Label>
            <NativeSelect
              id="page-size-select"
              className="w-full"
              value={String(pageSize)}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
              }}
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <NativeSelectOption key={size} value={String(size)}>
                  {size}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </CardContent>
        </Card>

        <Card
          size="sm"
          className="rounded-xl border border-[#c7d2d5] bg-white py-3 shadow-sm"
        >
          <CardContent className="grid gap-2 px-3 py-0">
            <Label htmlFor="bulk-status-select" className={CONTROL_LABEL_CLASS}>
              Bulk move selected (Set)
            </Label>
            <NativeSelect
              id="bulk-status-select"
              className="w-full"
              value={bulkStatus}
              onChange={(event) => {
                setBulkStatus(event.target.value as TaskStatus);
              }}
            >
              {STATUS_ORDER.map((status) => (
                <NativeSelectOption key={status} value={status}>
                  {STATUS_LABELS[status]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  dispatch({
                    type: "bulk_move_selected",
                    nextStatus: bulkStatus,
                  });
                }}
              >
                Apply
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  dispatch({ type: "clear_selection" });
                }}
              >
                Clear Selection
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card
          size="sm"
          className="rounded-xl border border-[#c7d2d5] bg-white py-3 shadow-sm md:col-span-2 xl:col-span-1"
        >
          <CardContent className="grid gap-2 px-3 py-0">
            <Label className={CONTROL_LABEL_CLASS}>Undo/Redo (Stack)</Label>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={state.undoStack.length === 0}
                onClick={() => {
                  dispatch({ type: "undo_move" });
                }}
              >
                Undo
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={state.redoStack.length === 0}
                onClick={() => {
                  dispatch({ type: "redo_move" });
                }}
              >
                Redo
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>

      <Card
        size="sm"
        className="mt-3 rounded-xl border border-[#c7d2d5] bg-white py-3 shadow-sm"
      >
        <CardHeader className="gap-1 border-b border-[#edf0f2] px-3 pb-2">
          <CardTitle className="text-base">
            Dependency Graph (Cycle Detection)
          </CardTitle>
        </CardHeader>
        <CardContent className="grid items-center gap-2 px-3 pt-2 md:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)_auto]">
          <Label htmlFor="dependency-task" className={CONTROL_LABEL_CLASS}>
            Task
          </Label>
          <NativeSelect
            id="dependency-task"
            className="w-full"
            value={selectedDependencyTaskId}
            onChange={(event) => {
              setDependencyTaskId(event.target.value);
            }}
          >
            {rootTasks.map((task) => (
              <NativeSelectOption key={task.id} value={task.id}>
                {task.id} - {task.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>

          <Label htmlFor="depends-on-task" className={CONTROL_LABEL_CLASS}>
            Depends on
          </Label>
          <NativeSelect
            id="depends-on-task"
            className="w-full"
            value={selectedDependsOnTaskId}
            onChange={(event) => {
              setDependsOnTaskId(event.target.value);
            }}
          >
            {rootTasks.map((task) => (
              <NativeSelectOption key={task.id} value={task.id}>
                {task.id} - {task.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>

          <Button
            type="button"
            size="sm"
            onClick={() => {
              dispatch({
                type: "add_dependency",
                taskId: selectedDependencyTaskId,
                dependsOnTaskId: selectedDependsOnTaskId,
              });
            }}
            disabled={!selectedDependencyTaskId || !selectedDependsOnTaskId}
          >
            Link Dependency
          </Button>
        </CardContent>
      </Card>

      <section className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-4">
        {STATUS_ORDER.map((status) => (
          <StatusColumn
            key={`${status}-${debouncedQuery}-${pageSize}-${state.revision}`}
            status={status}
            query={debouncedQuery}
            pageSize={pageSize}
            tasksById={state.tasks.byId}
            selectedTaskIds={state.selectedTaskIds}
            draggingTaskId={draggingTaskId}
            isDropActive={dropTargetStatus === status}
            fetchColumnPage={fetchColumnPage}
            onTaskDragStart={handleTaskDragStart}
            onTaskDragEnd={handleTaskDragEnd}
            onColumnDragOver={handleColumnDragOver}
            onColumnDragLeave={handleColumnDragLeave}
            onColumnDrop={handleColumnDrop}
            onToggleSelect={handleToggleSelect}
            onMoveTask={handleMoveTask}
            onSelectMany={handleSelectMany}
          />
        ))}
      </section>

      <Separator className="my-4 bg-[#d7dde3]" />

      <ul className="fixed bottom-4 right-4 z-[100] grid w-[min(24rem,calc(100vw-2rem))] list-none gap-2 p-0">
        {state.activeToasts.map((toast) => (
          <ToastItem
            key={toast.id}
            toast={toast}
            onDismiss={handleDismissToast}
          />
        ))}
      </ul>
    </main>
  );
}

export function TaskBoardApp() {
  return (
    <BoardProvider>
      <TaskBoardBody />
    </BoardProvider>
  );
}
