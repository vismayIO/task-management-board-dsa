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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
const TASK_CARD_HEIGHT = 286;
const TASK_ROW_HEIGHT = TASK_CARD_HEIGHT + 10;

const CONTROL_LABEL_CLASS =
  "text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-slate-600";
const PROGRESS_CLASS =
  "w-full gap-1.5 [&_[data-slot=progress-track]]:h-1.5 [&_[data-slot=progress-track]]:rounded-full [&_[data-slot=progress-track]]:bg-slate-200/80 [&_[data-slot=progress-indicator]]:bg-[var(--status-accent)]";
const PROGRESS_LABEL_CLASS =
  "text-[0.68rem] font-semibold uppercase tracking-[0.06em] text-slate-600";
const PROGRESS_VALUE_CLASS = "text-[0.74rem] text-slate-700";
const CARD_COMMON_INTERACTIVE =
  "transition-all duration-200 motion-reduce:transition-none";

const STATUS_DOT_CLASS: Record<TaskStatus, string> = {
  backlog: "bg-slate-500",
  todo: "bg-sky-600",
  in_progress: "bg-amber-500",
  done: "bg-emerald-600",
};

const STATUS_PILL_CLASS: Record<TaskStatus, string> = {
  backlog: "border-slate-300 bg-slate-100 text-slate-700",
  todo: "border-sky-300 bg-sky-50 text-sky-700",
  in_progress: "border-amber-300 bg-amber-50 text-amber-700",
  done: "border-emerald-300 bg-emerald-50 text-emerald-700",
};

const PRIORITY_BADGE_CLASS: Record<TaskPriority, string> = {
  low: "border-emerald-300 bg-emerald-100 text-emerald-900",
  medium: "border-amber-300 bg-amber-100 text-amber-900",
  high: "border-red-300 bg-red-100 text-red-900",
};

const TOAST_TONE_CLASS: Record<ToastTone, string> = {
  info: "border-sky-300 text-sky-800",
  success: "border-emerald-300 text-emerald-800",
  warning: "border-amber-300 text-amber-800",
  error: "border-rose-300 text-rose-800",
};

const STATUS_ACCENT: Record<TaskStatus, string> = {
  backlog: "#64748b",
  todo: "#0369a1",
  in_progress: "#d97706",
  done: "#16a34a",
};

interface StatusColumnProps {
  status: TaskStatus;
  query: string;
  pageSize: number;
  totalRootTasks: number;
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
  onDeselectMany: (taskIds: TaskId[]) => void;
}

function estimateTaskHeight(): number {
  return TASK_ROW_HEIGHT;
}

function percentage(part: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.round((part / total) * 100);
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
    <li
      className="grid gap-0.5"
      style={{ paddingLeft: `${depth * 0.55}rem` }}
    >
      <div className="inline-flex items-center gap-1.5 text-[0.72rem] text-slate-600">
        <span
          className={cn(
            "inline-block size-2 rounded-full",
            STATUS_DOT_CLASS[task.status],
          )}
        />
        <span className="line-clamp-1">
          {task.title}
        </span>
      </div>
      {task.subtaskIds.length > 0 ? (
        <ul className="mt-1 list-none p-0">
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
      data-status={task.status}
      data-selected={selected ? "true" : "false"}
      data-dragging={isDragging ? "true" : "false"}
      style={
        {
          "--status-accent": STATUS_ACCENT[task.status],
        } as CSSProperties
      }
      className={cn(
        "h-[286px] cursor-grab gap-0 rounded-xl border border-slate-200 border-l-4 bg-white py-0",
        "border-l-[var(--status-accent)]",
        CARD_COMMON_INTERACTIVE,
        "hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-lg",
        "data-[selected=true]:border-sky-700 data-[selected=true]:shadow-[0_0_0_2px_rgba(2,132,199,0.22)]",
        "data-[dragging=true]:scale-[0.985] data-[dragging=true]:opacity-60",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:ring-offset-1",
      )}
      draggable
      tabIndex={0}
      role="article"
      aria-label={`Task ${task.id}: ${task.title}`}
      aria-describedby={`task-hint-${task.id}`}
      aria-grabbed={isDragging}
      onDragStart={(event: DragEvent<HTMLElement>) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", task.id);
        onDragStart(task.id);
      }}
      onDragEnd={() => {
        onDragEnd();
      }}
      onKeyDown={(event) => {
        if (event.currentTarget !== event.target) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToggleSelect(task.id);
        }
      }}
    >
      <CardHeader className="grid gap-2 px-3 pb-1 pt-3">
        <div className="flex items-center justify-between gap-2">
          <Label
            htmlFor={`task-select-${task.id}`}
            className="inline-flex items-center gap-1.5 text-xs text-slate-600"
          >
            <Checkbox
              id={`task-select-${task.id}`}
              checked={selected}
              onCheckedChange={() => {
                onToggleSelect(task.id);
              }}
            />
            <span className="opacity-80">#{task.id.slice(-3)}</span>
          </Label>
          <div className="inline-flex items-center gap-1">
            <Badge
              variant="outline"
              className={cn(
                "text-[0.66rem] font-semibold uppercase tracking-[0.05em]",
                PRIORITY_BADGE_CLASS[task.priority],
              )}
            >
              {task.priority}
            </Badge>
            <Badge
              variant="outline"
              className={cn(
                "text-[0.66rem] font-semibold tracking-[0.05em]",
                STATUS_PILL_CLASS[task.status],
              )}
            >
              {STATUS_LABELS[task.status]}
            </Badge>
          </div>
        </div>

        <CardTitle className="line-clamp-2 text-[1.03rem] font-semibold leading-snug text-slate-900">
          {task.title}
        </CardTitle>

        <CardDescription className="line-clamp-2 text-sm leading-snug text-slate-600">
          {task.description}
        </CardDescription>
      </CardHeader>

      <CardContent className="grid min-h-0 flex-1 content-start gap-2 overflow-hidden px-3 pb-2">
        {dependencyTitles.length > 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50/70 px-2.5 py-2">
            <p className="text-[0.66rem] font-semibold uppercase tracking-[0.08em] text-slate-600">
              Depends on
            </p>
            <ul className="mt-1 list-none p-0">
              {dependencyPreview.map((title) => (
                <li key={title} className="line-clamp-1 text-xs text-slate-700">
                  {title}
                </li>
              ))}
            </ul>
            {hiddenDependencyCount > 0 ? (
              <p className="mt-1 text-xs text-slate-500">
                +{hiddenDependencyCount} more dependency
              </p>
            ) : null}
          </div>
        ) : null}

        {task.subtaskIds.length > 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50/70 px-2.5 py-2">
            <p className="text-[0.66rem] font-semibold uppercase tracking-[0.08em] text-slate-600">
              Subtasks
            </p>
            <ul className="mt-1 max-h-12 list-none overflow-hidden p-0">
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
              <p className="mt-1 text-xs text-slate-500">
                +{hiddenSubtaskCount} more subtasks
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>

      <CardFooter className="mt-0 block border-t border-slate-200/70 bg-slate-50/60 px-3 pb-2.5 pt-2">
        <div className="grid w-full gap-1">
          <div className="flex items-center justify-between gap-2">
            <Label
              htmlFor={`task-status-${task.id}`}
              className="text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-slate-600"
            >
              Move to
            </Label>
            <span id={`task-hint-${task.id}`} className="text-[0.68rem] text-slate-500">
              Drag and drop enabled
            </span>
          </div>
          <NativeSelect
            id={`task-status-${task.id}`}
            className="w-full [&_[data-slot=native-select]]:border-slate-300 [&_[data-slot=native-select]]:bg-white"
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
  totalRootTasks,
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
  onDeselectMany,
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
  const statusShare = useMemo(
    () => percentage(page.totalItems, totalRootTasks),
    [page.totalItems, totalRootTasks],
  );
  const isPageFullySelected = useMemo(
    () =>
      page.taskIds.length > 0 &&
      page.taskIds.every((taskId) => selectedTaskIds.has(taskId)),
    [page.taskIds, selectedTaskIds],
  );

  return (
    <Card
      data-status={status}
      style={
        {
          "--status-accent": STATUS_ACCENT[status],
        } as CSSProperties
      }
      className={cn(
        "relative overflow-hidden rounded-xl border border-slate-300 bg-white shadow-sm",
        "before:absolute before:inset-x-0 before:top-0 before:h-[3px] before:bg-[var(--status-accent)] before:content-['']",
        CARD_COMMON_INTERACTIVE,
        "focus-within:border-sky-400 focus-within:shadow-[0_0_0_3px_rgba(14,165,233,0.18)]",
        isDropActive && "border-sky-400 shadow-[0_0_0_2px_rgba(56,189,248,0.35)]",
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
      <CardHeader className="grid gap-2 border-b border-slate-200 px-3 py-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className={cn(
                  "inline-block size-2 rounded-full",
                  STATUS_DOT_CLASS[status],
                )}
              />
              <CardTitle className="text-[0.95rem] font-semibold tracking-[-0.01em] text-slate-800">
                {STATUS_LABELS[status]}
              </CardTitle>
              <Badge
                variant="outline"
                className={cn(
                  "text-[0.65rem] font-semibold tracking-[0.05em]",
                  STATUS_PILL_CLASS[status],
                )}
              >
                {statusShare}%
              </Badge>
            </div>
            <CardDescription className="mt-1 text-xs text-slate-500">
              {page.totalItems} tasks • {page.totalPages} pages
            </CardDescription>
          </div>
          <div className="flex max-w-full flex-wrap items-center justify-end gap-1.5">
            <Tooltip>
              <TooltipTrigger className="inline-flex min-h-9 items-center rounded-md border border-slate-300 bg-slate-50 px-2.5 text-[0.7rem] font-semibold uppercase tracking-[0.06em] text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/35">
                Drop Tip
              </TooltipTrigger>
              <TooltipContent side="left">
                Dragging a selected task moves all selected tasks.
              </TooltipContent>
            </Tooltip>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                if (isPageFullySelected) {
                  onDeselectMany(page.taskIds);
                  return;
                }
                onSelectMany(page.taskIds);
              }}
              disabled={page.taskIds.length === 0}
              className="min-h-9"
            >
              {isPageFullySelected ? "Deselect page" : "Select page"}
            </Button>
          </div>
        </div>
        <Progress
          value={statusShare}
          style={
            {
              "--status-accent": STATUS_ACCENT[status],
            } as CSSProperties
          }
          className={cn(PROGRESS_CLASS, "mt-0.5")}
        >
          <ProgressLabel className={PROGRESS_LABEL_CLASS}>
            Workload share
          </ProgressLabel>
          <ProgressValue className={PROGRESS_VALUE_CLASS}>
            {(formattedValue) => formattedValue ?? `${statusShare}%`}
          </ProgressValue>
        </Progress>
      </CardHeader>

      <CardContent className="p-0">
        <div
          className="relative h-[24rem] overflow-auto bg-slate-50/60 xl:h-[31rem]"
          onScroll={(event) => {
            setScrollTop(event.currentTarget.scrollTop);
          }}
        >
          {page.taskIds.length === 0 ? (
            <div className="grid h-full place-items-center px-3">
              <Empty className="border-slate-300 bg-white/80">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    0
                  </EmptyMedia>
                  <EmptyTitle>No tasks for this filter</EmptyTitle>
                  <EmptyDescription>
                    Clear the search or move tasks into this column.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
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

      <CardFooter className="grid gap-2 border-t border-slate-200 bg-slate-50/80 px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-9"
            onClick={() => {
              if (page.prevCursor !== null) {
                setCursor(page.prevCursor);
              }
            }}
            disabled={page.prevCursor === null}
          >
            Prev
          </Button>
          <div className="flex items-center gap-1.5">
            {page.pageWindow.map((pageNumber) => (
              <Button
                type="button"
                key={pageNumber}
                size="icon-sm"
                variant={
                  pageNumber === page.currentPage ? "default" : "outline"
                }
                className="min-h-9"
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
            className="min-h-9"
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

        <div className="text-right text-xs text-slate-500">
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
          "border bg-white/95 backdrop-blur-sm",
          TOAST_TONE_CLASS[toast.tone],
        )}
      >
        <CardContent className="flex items-center justify-between gap-2.5 px-3 py-2.5">
          <p className="text-sm text-slate-700">{toast.message}</p>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="min-h-8"
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
  const totalRootTasks = rootTasks.length;
  const selectedTaskCount = state.selectedTaskIds.size;
  const completionPercent = percentage(
    state.tasks.idsByStatus.done.length,
    totalRootTasks,
  );
  const selectionPercent = percentage(selectedTaskCount, totalRootTasks);
  const statusOverview = useMemo(
    () =>
      STATUS_ORDER.map((status) => ({
        status,
        count: state.tasks.idsByStatus[status].length,
        percent: percentage(state.tasks.idsByStatus[status].length, totalRootTasks),
      })),
    [state.tasks.idsByStatus, totalRootTasks],
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

  const handleDeselectMany = useCallback(
    (taskIds: TaskId[]) => {
      dispatch({
        type: "deselect_many",
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
    <main className="min-h-dvh bg-gradient-to-b from-sky-50 via-blue-50 to-emerald-50 p-3 text-slate-800 sm:p-4">
      <TooltipProvider delay={180}>
        <div className="relative z-10 mx-auto grid w-full max-w-[1820px] gap-4">
          <Card className="overflow-hidden rounded-2xl border border-slate-300 bg-white/95 shadow-[0_12px_26px_rgba(13,46,66,0.08)]">
            <CardContent className="grid gap-4 p-4 lg:grid-cols-[1.65fr_1fr]">
              <div className="grid gap-3">
                <p className="m-0 text-[0.72rem] font-semibold uppercase tracking-[0.09em] text-sky-800">
                  Task Management Board • Mini Jira
                </p>
                <h1 className="m-0 text-[clamp(1.45rem,2.1vw,2.1rem)] font-semibold leading-tight tracking-[-0.02em] text-slate-900">
                  Operations Flight Deck
                </h1>
                <p className="m-0 max-w-4xl text-sm text-slate-600 sm:text-[0.95rem]">
                  A complete board redesign with a control rail, lane-based
                  execution canvas, and data-driven insights powered by trie
                  search, LRU pagination, undo/redo stacks, and dependency
                  graphs.
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Card className="border border-slate-200 bg-white/90 shadow-none">
                    <CardContent className="grid gap-1.5 px-3 py-3">
                      <p className="m-0 text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-slate-600">
                        Completion
                      </p>
                      <Progress
                        value={completionPercent}
                        style={
                          {
                            "--status-accent": "#16a34a",
                          } as CSSProperties
                        }
                        className={PROGRESS_CLASS}
                      >
                        <ProgressValue className={PROGRESS_VALUE_CLASS}>
                          {(formattedValue) =>
                            formattedValue ?? `${completionPercent}%`}
                        </ProgressValue>
                      </Progress>
                    </CardContent>
                  </Card>
                  <Card className="border border-slate-200 bg-white/90 shadow-none">
                    <CardContent className="grid gap-1.5 px-3 py-3">
                      <p className="m-0 text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-slate-600">
                        Selection
                      </p>
                      <Progress
                        value={selectionPercent}
                        style={
                          {
                            "--status-accent": "#0369a1",
                          } as CSSProperties
                        }
                        className={PROGRESS_CLASS}
                      >
                        <ProgressValue className={PROGRESS_VALUE_CLASS}>
                          {(formattedValue) =>
                            formattedValue ??
                            `${selectedTaskCount}/${totalRootTasks}`}
                        </ProgressValue>
                      </Progress>
                    </CardContent>
                  </Card>
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
                <article className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                  <span className="block text-[0.68rem] uppercase tracking-[0.08em] text-slate-600">
                    Root tasks
                  </span>
                  <strong className="mt-1 block text-2xl leading-none text-slate-800">
                    {totalRootTasks}
                  </strong>
                </article>
                <article className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                  <span className="block text-[0.68rem] uppercase tracking-[0.08em] text-slate-600">
                    Selected
                  </span>
                  <strong className="mt-1 block text-2xl leading-none text-slate-800">
                    {selectedTaskCount}
                  </strong>
                </article>
                <article className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                  <span className="block text-[0.68rem] uppercase tracking-[0.08em] text-slate-600">
                    Dependency edges
                  </span>
                  <strong className="mt-1 block text-2xl leading-none text-slate-800">
                    {dependencyEdgeCount}
                  </strong>
                </article>
                <article className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                  <span className="block text-[0.68rem] uppercase tracking-[0.08em] text-slate-600">
                    Done tasks
                  </span>
                  <strong className="mt-1 block text-2xl leading-none text-slate-800">
                    {state.tasks.idsByStatus.done.length}
                  </strong>
                </article>
              </div>
            </CardContent>

            <CardFooter className="grid gap-2 border-t border-slate-200 bg-slate-50/70 px-4 py-3 sm:grid-cols-2 xl:grid-cols-4">
              {statusOverview.map((item) => (
                <div
                  key={item.status}
                  data-status={item.status}
                  style={
                    {
                      "--status-accent": STATUS_ACCENT[item.status],
                    } as CSSProperties
                  }
                  className="rounded-lg border border-slate-200 bg-white/90 px-2.5 py-2"
                >
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <p className="m-0 inline-flex items-center gap-1.5 text-[0.7rem] font-semibold uppercase tracking-[0.06em] text-slate-700">
                      <span
                        className={cn(
                          "inline-block size-2 rounded-full",
                          STATUS_DOT_CLASS[item.status],
                        )}
                      />
                      {STATUS_LABELS[item.status]}
                    </p>
                    <p className="m-0 text-[0.72rem] text-slate-600">
                      {item.count} • {item.percent}%
                    </p>
                  </div>
                  <Progress value={item.percent} className={PROGRESS_CLASS} />
                </div>
              ))}
            </CardFooter>
          </Card>

          <div className="grid gap-4 xl:grid-cols-[minmax(300px,340px)_1fr] xl:items-start">
            <aside className="grid gap-3 xl:sticky xl:top-3">
              <Card className="rounded-2xl border border-slate-300 bg-white/90 shadow-sm backdrop-blur">
                <CardHeader className="flex items-start justify-between gap-2 px-4 pb-2 pt-3">
                  <CardTitle className="text-base font-semibold text-slate-800">
                    Quick Search
                  </CardTitle>
                  <CardDescription className="mt-1 text-xs text-slate-500">
                    Trie-backed title lookup with debounce.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-2.5 px-4 pb-4 pt-1">
                  <Label htmlFor="search-box" className={CONTROL_LABEL_CLASS}>
                    Search tasks
                  </Label>
                  <Input
                    id="search-box"
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                    }}
                    placeholder="Start typing task title..."
                  />
                  {autocompleteSuggestions.length > 0 ? (
                    <div className="max-h-44 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1">
                      {autocompleteSuggestions.map((task) => (
                        <Button
                          key={task.id}
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="min-h-9 w-full justify-start focus-visible:ring-2 focus-visible:ring-sky-500/30"
                          onClick={() => {
                            setQuery(task.title);
                          }}
                        >
                          {task.title}
                        </Button>
                      ))}
                    </div>
                  ) : query.trim() ? (
                    <small className="text-xs text-slate-500">
                      No matching prefixes found.
                    </small>
                  ) : null}
                  <small className="text-xs text-slate-500">
                    Debounced query: “{debouncedQuery || "(empty)"}”
                  </small>
                </CardContent>
              </Card>

              <Card className="rounded-2xl border border-slate-300 bg-white/90 shadow-sm backdrop-blur">
                <CardHeader className="flex items-start justify-between gap-2 px-4 pb-2 pt-3">
                  <CardTitle className="text-base font-semibold text-slate-800">
                    Workflow Controls
                  </CardTitle>
                  <CardAction>
                    <Tooltip>
                      <TooltipTrigger className="inline-flex min-h-9 items-center rounded-md border border-slate-300 bg-slate-50 px-2.5 text-[0.68rem] font-semibold uppercase tracking-[0.06em] text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/35">
                        Drag behavior
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        Dropping one selected task moves all selected tasks.
                      </TooltipContent>
                    </Tooltip>
                  </CardAction>
                </CardHeader>
                <CardContent className="grid gap-3 px-4 pb-4 pt-1">
                  <div className="grid gap-1.5">
                    <Label htmlFor="page-size-select" className={CONTROL_LABEL_CLASS}>
                      Page size
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
                  </div>

                  <div className="grid gap-1.5">
                    <Label htmlFor="bulk-status-select" className={CONTROL_LABEL_CLASS}>
                      Bulk move selected
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
                    <div className="flex flex-wrap gap-2">
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
                        Clear
                      </Button>
                    </div>
                  </div>

                  <div className="grid gap-1.5">
                    <Label className={CONTROL_LABEL_CLASS}>History stack</Label>
                    <div className="flex flex-wrap gap-2">
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
                    <small className="text-xs text-slate-500">
                      {state.undoStack.length} undo entries •{" "}
                      {state.redoStack.length} redo entries
                    </small>
                  </div>
                </CardContent>
              </Card>

              <Card className="rounded-2xl border border-slate-300 bg-white/90 shadow-sm backdrop-blur">
                <CardHeader className="flex items-start justify-between gap-2 px-4 pb-2 pt-3">
                  <CardTitle className="text-base font-semibold text-slate-800">
                    Dependency Linker
                  </CardTitle>
                  <CardDescription className="mt-1 text-xs text-slate-500">
                    Add directed edges with cycle protection.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 px-4 pb-4 pt-1">
                  <div className="grid gap-1.5">
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
                  </div>

                  <div className="grid gap-1.5">
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
                  </div>

                  <div className="flex flex-wrap gap-2">
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
                  </div>
                </CardContent>
              </Card>
            </aside>

            <section className="overflow-hidden rounded-2xl border border-slate-300 bg-white/90 shadow-sm">
              <header className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 px-4 py-3">
                <div>
                  <h2 className="text-lg font-semibold tracking-[-0.02em] text-slate-800">
                    Execution Lanes
                  </h2>
                  <p className="mt-1 text-xs text-slate-500 sm:text-sm">
                    Drag tasks between lanes or use each card&apos;s quick move
                    selector.
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge
                    variant="outline"
                    className="border-slate-300 bg-slate-50 text-xs text-slate-700"
                  >
                    Selected {selectedTaskCount}
                  </Badge>
                  <Badge
                    variant="outline"
                    className="border-slate-300 bg-slate-50 text-xs text-slate-700"
                  >
                    Done {state.tasks.idsByStatus.done.length}
                  </Badge>
                  <Badge
                    variant="outline"
                    className="border-emerald-300 bg-emerald-50 text-xs text-emerald-700"
                  >
                    Completion {completionPercent}%
                  </Badge>
                </div>
              </header>

              <div className="overflow-x-auto p-3">
                <div className="grid auto-cols-[minmax(min(22rem,84vw),1fr)] auto-flow-col gap-3 2xl:grid-cols-4 2xl:auto-cols-auto 2xl:auto-flow-row">
                  {STATUS_ORDER.map((status) => (
                    <StatusColumn
                      key={`${status}-${debouncedQuery}-${pageSize}`}
                      status={status}
                      query={debouncedQuery}
                      pageSize={pageSize}
                      totalRootTasks={totalRootTasks}
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
                      onDeselectMany={handleDeselectMany}
                    />
                  ))}
                </div>
              </div>
            </section>
          </div>

          <ul className="fixed bottom-4 right-4 z-50 m-0 grid w-[min(25rem,calc(100vw-2rem))] list-none gap-2 p-0">
            {state.activeToasts.map((toast) => (
              <ToastItem
                key={toast.id}
                toast={toast}
                onDismiss={handleDismissToast}
              />
            ))}
          </ul>
        </div>
      </TooltipProvider>
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
