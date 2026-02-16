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
import "./task-board.css";

const VIEWPORT_HEIGHT = 480;
const OVERSCAN = 3;
const PAGE_SIZE_OPTIONS = [24, 48, 72] as const;
const TASK_CARD_HEIGHT = 252;
const TASK_ROW_HEIGHT = TASK_CARD_HEIGHT + 8;

const CONTROL_LABEL_CLASS = "mini-jira-field-label";

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
  low: "border-emerald-200 bg-emerald-50 text-emerald-700",
  medium: "border-amber-200 bg-amber-50 text-amber-700",
  high: "border-rose-200 bg-rose-50 text-rose-700",
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
      className="mini-jira-subtask-node"
      style={{ paddingLeft: `${depth * 0.55}rem` }}
    >
      <div className="mini-jira-subtask-row">
        <span
          className={cn(
            "inline-block size-2 rounded-full",
            STATUS_DOT_CLASS[task.status],
          )}
        />
        <span className="mini-jira-subtask-title">
          {task.title}
        </span>
      </div>
      {task.subtaskIds.length > 0 ? (
        <ul className="mini-jira-subtask-children">
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
      className="mini-jira-task-card"
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
      <CardHeader className="mini-jira-task-header">
        <div className="mini-jira-task-row">
          <Label
            htmlFor={`task-select-${task.id}`}
            className="mini-jira-task-select"
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
          <div className="mini-jira-task-badges">
            <Badge
              variant="outline"
              className={cn("uppercase mini-jira-priority-pill", PRIORITY_BADGE_CLASS[task.priority])}
            >
              {task.priority}
            </Badge>
            <Badge
              variant="outline"
              className={cn(
                "mini-jira-status-pill",
                STATUS_PILL_CLASS[task.status],
              )}
            >
              {STATUS_LABELS[task.status]}
            </Badge>
          </div>
        </div>

        <CardTitle className="mini-jira-task-title">
          {task.title}
        </CardTitle>

        <CardDescription className="mini-jira-task-description">
          {task.description}
        </CardDescription>
      </CardHeader>

      <CardContent className="mini-jira-task-content">
        {dependencyTitles.length > 0 ? (
          <div className="mini-jira-meta-box">
            <p className="mini-jira-meta-label">
              Depends on
            </p>
            <ul className="mini-jira-meta-list">
              {dependencyPreview.map((title) => (
                <li
                  key={title}
                  className="mini-jira-meta-item"
                >
                  {title}
                </li>
              ))}
            </ul>
            {hiddenDependencyCount > 0 ? (
              <p className="mini-jira-meta-more">
                +{hiddenDependencyCount} more dependency
              </p>
            ) : null}
          </div>
        ) : null}

        {task.subtaskIds.length > 0 ? (
          <div className="mini-jira-meta-box">
            <p className="mini-jira-meta-label">
              Subtasks
            </p>
            <ul className="mini-jira-subtask-list">
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
              <p className="mini-jira-meta-more">
                +{hiddenSubtaskCount} more subtasks
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>

      <CardFooter className="mini-jira-task-footer">
        <div className="mini-jira-move-wrap">
          <div className="mini-jira-task-row">
            <Label
              htmlFor={`task-status-${task.id}`}
              className="mini-jira-move-label"
            >
              Move to
            </Label>
            <span className="mini-jira-hint">Drag and drop enabled</span>
          </div>
          <NativeSelect
            id={`task-status-${task.id}`}
            className="mini-jira-move-select"
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
        "mini-jira-column",
        isDropActive && "mini-jira-column-active",
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
      <CardHeader className="mini-jira-column-head">
        <div className="mini-jira-column-head-row">
          <div className="mini-jira-column-title-wrap">
            <div className="mini-jira-column-title-line">
              <span
                className={cn(
                  "inline-block size-2 rounded-full",
                  STATUS_DOT_CLASS[status],
                )}
              />
              <CardTitle className="mini-jira-column-title">
                {STATUS_LABELS[status]}
              </CardTitle>
              <Badge
                variant="outline"
                className={cn("mini-jira-column-chip", STATUS_PILL_CLASS[status])}
              >
                {statusShare}%
              </Badge>
            </div>
            <CardDescription className="mini-jira-column-description">
              {page.totalItems} tasks • {page.totalPages} pages
            </CardDescription>
          </div>
          <div className="mini-jira-column-actions">
            <Tooltip>
              <TooltipTrigger className="mini-jira-inline-hint">
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
              className="mini-jira-inline-button"
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
          className="mini-jira-progress mini-jira-column-progress"
        >
          <ProgressLabel className="mini-jira-progress-label">
            Workload share
          </ProgressLabel>
          <ProgressValue className="mini-jira-progress-value">
            {(formattedValue) => formattedValue ?? `${statusShare}%`}
          </ProgressValue>
        </Progress>
      </CardHeader>

      <CardContent className="mini-jira-column-body">
        <div
          className="mini-jira-column-scroll"
          onScroll={(event) => {
            setScrollTop(event.currentTarget.scrollTop);
          }}
        >
          {page.taskIds.length === 0 ? (
            <div className="mini-jira-empty-wrap">
              <Empty className="mini-jira-empty">
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
              className="mini-jira-virtual-list"
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
                    className="mini-jira-task-slot"
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

      <CardFooter className="mini-jira-column-footer">
        <div className="mini-jira-pagination-row">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mini-jira-page-button"
            onClick={() => {
              if (page.prevCursor !== null) {
                setCursor(page.prevCursor);
              }
            }}
            disabled={page.prevCursor === null}
          >
            Prev
          </Button>
          <div className="mini-jira-page-window">
            {page.pageWindow.map((pageNumber) => (
              <Button
                type="button"
                key={pageNumber}
                size="icon-sm"
                variant={
                  pageNumber === page.currentPage ? "default" : "outline"
                }
                className="mini-jira-page-button"
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
            className="mini-jira-page-button"
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

        <div className="mini-jira-cache-note">
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
          "mini-jira-toast-card",
          TOAST_TONE_CLASS[toast.tone],
        )}
      >
        <CardContent className="mini-jira-toast-content">
          <p className="mini-jira-toast-text">{toast.message}</p>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="mini-jira-toast-dismiss"
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
    <main className="mini-jira-shell">
      <TooltipProvider delay={180}>
        <div className="mini-jira-layout">
          <Card className="mini-jira-hero">
            <CardContent className="mini-jira-hero-content">
              <div className="mini-jira-hero-copy">
                <p className="mini-jira-kicker">Task Management Board • Mini Jira</p>
                <h1 className="mini-jira-title">Operations Flight Deck</h1>
                <p className="mini-jira-description">
                  A complete board redesign with a control rail, lane-based
                  execution canvas, and data-driven insights powered by trie
                  search, LRU pagination, undo/redo stacks, and dependency
                  graphs.
                </p>
                <div className="mini-jira-metrics">
                  <Card className="mini-jira-metric-card">
                    <CardContent className="mini-jira-metric-content">
                      <p className="mini-jira-metric-label">Completion</p>
                      <Progress
                        value={completionPercent}
                        style={
                          {
                            "--status-accent": "#16a34a",
                          } as CSSProperties
                        }
                        className="mini-jira-progress"
                      >
                        <ProgressValue className="mini-jira-progress-value">
                          {(formattedValue) =>
                            formattedValue ?? `${completionPercent}%`}
                        </ProgressValue>
                      </Progress>
                    </CardContent>
                  </Card>
                  <Card className="mini-jira-metric-card">
                    <CardContent className="mini-jira-metric-content">
                      <p className="mini-jira-metric-label">Selection</p>
                      <Progress
                        value={selectionPercent}
                        style={
                          {
                            "--status-accent": "#0369a1",
                          } as CSSProperties
                        }
                        className="mini-jira-progress"
                      >
                        <ProgressValue className="mini-jira-progress-value">
                          {(formattedValue) =>
                            formattedValue ??
                            `${selectedTaskCount}/${totalRootTasks}`}
                        </ProgressValue>
                      </Progress>
                    </CardContent>
                  </Card>
                </div>
              </div>

              <div className="mini-jira-hero-stats">
                <article className="mini-jira-stat">
                  <span className="mini-jira-stat-label">Root tasks</span>
                  <strong className="mini-jira-stat-value mini-jira-mono">
                    {totalRootTasks}
                  </strong>
                </article>
                <article className="mini-jira-stat">
                  <span className="mini-jira-stat-label">Selected</span>
                  <strong className="mini-jira-stat-value mini-jira-mono">
                    {selectedTaskCount}
                  </strong>
                </article>
                <article className="mini-jira-stat">
                  <span className="mini-jira-stat-label">Dependency edges</span>
                  <strong className="mini-jira-stat-value mini-jira-mono">
                    {dependencyEdgeCount}
                  </strong>
                </article>
                <article className="mini-jira-stat">
                  <span className="mini-jira-stat-label">Done tasks</span>
                  <strong className="mini-jira-stat-value mini-jira-mono">
                    {state.tasks.idsByStatus.done.length}
                  </strong>
                </article>
              </div>
            </CardContent>

            <CardFooter className="mini-jira-hero-footer">
              {statusOverview.map((item) => (
                <div
                  key={item.status}
                  data-status={item.status}
                  style={
                    {
                      "--status-accent": STATUS_ACCENT[item.status],
                    } as CSSProperties
                  }
                  className="mini-jira-status-meter"
                >
                  <div className="mini-jira-status-meter-head">
                    <p className="mini-jira-status-meter-title">
                      <span
                        className={cn(
                          "inline-block size-2 rounded-full",
                          STATUS_DOT_CLASS[item.status],
                        )}
                      />
                      {STATUS_LABELS[item.status]}
                    </p>
                    <p className="mini-jira-status-meter-value mini-jira-mono">
                      {item.count} • {item.percent}%
                    </p>
                  </div>
                  <Progress value={item.percent} className="mini-jira-progress" />
                </div>
              ))}
            </CardFooter>
          </Card>

          <div className="mini-jira-workspace">
            <aside className="mini-jira-control-rail">
              <Card className="mini-jira-control-card">
                <CardHeader className="mini-jira-control-header">
                  <CardTitle className="mini-jira-control-title">
                    Quick Search
                  </CardTitle>
                  <CardDescription className="mini-jira-control-description">
                    Trie-backed title lookup with debounce.
                  </CardDescription>
                </CardHeader>
                <CardContent className="mini-jira-control-content">
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
                    <div className="mini-jira-suggestions">
                      {autocompleteSuggestions.map((task) => (
                        <Button
                          key={task.id}
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="mini-jira-suggestion-item"
                          onClick={() => {
                            setQuery(task.title);
                          }}
                        >
                          {task.title}
                        </Button>
                      ))}
                    </div>
                  ) : query.trim() ? (
                    <small className="mini-jira-inline-note">
                      No matching prefixes found.
                    </small>
                  ) : null}
                  <small className="mini-jira-inline-note">
                    Debounced query: “{debouncedQuery || "(empty)"}”
                  </small>
                </CardContent>
              </Card>

              <Card className="mini-jira-control-card">
                <CardHeader className="mini-jira-control-header">
                  <CardTitle className="mini-jira-control-title">
                    Workflow Controls
                  </CardTitle>
                  <CardAction>
                    <Tooltip>
                      <TooltipTrigger className="mini-jira-inline-hint">
                        Drag behavior
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        Dropping one selected task moves all selected tasks.
                      </TooltipContent>
                    </Tooltip>
                  </CardAction>
                </CardHeader>
                <CardContent className="mini-jira-control-content mini-jira-control-grid">
                  <div className="mini-jira-control-block">
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

                  <div className="mini-jira-control-block">
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
                    <div className="mini-jira-actions-row">
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

                  <div className="mini-jira-control-block">
                    <Label className={CONTROL_LABEL_CLASS}>History stack</Label>
                    <div className="mini-jira-actions-row">
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
                    <small className="mini-jira-inline-note">
                      {state.undoStack.length} undo entries •{" "}
                      {state.redoStack.length} redo entries
                    </small>
                  </div>
                </CardContent>
              </Card>

              <Card className="mini-jira-control-card">
                <CardHeader className="mini-jira-control-header">
                  <CardTitle className="mini-jira-control-title">
                    Dependency Linker
                  </CardTitle>
                  <CardDescription className="mini-jira-control-description">
                    Add directed edges with cycle protection.
                  </CardDescription>
                </CardHeader>
                <CardContent className="mini-jira-control-content mini-jira-control-grid">
                  <div className="mini-jira-control-block">
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

                  <div className="mini-jira-control-block">
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

                  <div className="mini-jira-actions-row">
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

            <section className="mini-jira-board-canvas">
              <header className="mini-jira-board-header">
                <div>
                  <h2 className="mini-jira-board-title">Execution Lanes</h2>
                  <p className="mini-jira-board-description">
                    Drag tasks between lanes or use each card&apos;s quick move
                    selector.
                  </p>
                </div>
                <div className="mini-jira-board-pills">
                  <Badge
                    variant="outline"
                    className="mini-jira-board-pill mini-jira-mono"
                  >
                    Selected {selectedTaskCount}
                  </Badge>
                  <Badge
                    variant="outline"
                    className="mini-jira-board-pill mini-jira-mono"
                  >
                    Done {state.tasks.idsByStatus.done.length}
                  </Badge>
                  <Badge
                    variant="outline"
                    className="mini-jira-board-pill mini-jira-mono"
                  >
                    Completion {completionPercent}%
                  </Badge>
                </div>
              </header>

              <div className="mini-jira-board-scroll">
                <div className="mini-jira-board-grid">
                  {STATUS_ORDER.map((status) => (
                    <StatusColumn
                      key={`${status}-${debouncedQuery}-${pageSize}-${state.revision}`}
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

          <ul className="mini-jira-toast-stack">
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
