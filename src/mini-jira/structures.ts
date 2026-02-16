import type { Task, TaskId, TaskStatus } from "@/mini-jira/types";

export function normalizeSearchTerm(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/g, " ");
}

interface TrieNode {
  children: Map<string, TrieNode>;
  taskIds: Set<TaskId>;
}

function createTrieNode(): TrieNode {
  return {
    children: new Map<string, TrieNode>(),
    taskIds: new Set<TaskId>(),
  };
}

export class TaskTrie {
  private readonly root: TrieNode;

  constructor() {
    this.root = createTrieNode();
  }

  insert(rawText: string, taskId: TaskId): void {
    const normalized = normalizeSearchTerm(rawText);
    if (!normalized) {
      return;
    }

    const segments = new Set<string>([normalized, ...normalized.split(" ").filter(Boolean)]);
    for (const segment of segments) {
      this.insertSegment(segment, taskId);
    }
  }

  suggest(prefix: string, limit = 8): TaskId[] {
    const normalized = normalizeSearchTerm(prefix);
    if (!normalized) {
      return [];
    }

    let node = this.root;
    for (const char of normalized) {
      const next = node.children.get(char);
      if (!next) {
        return [];
      }
      node = next;
    }

    return this.collect(node, limit);
  }

  private insertSegment(segment: string, taskId: TaskId): void {
    let node = this.root;
    for (const char of segment) {
      const next = node.children.get(char);
      if (next) {
        node = next;
      } else {
        const created = createTrieNode();
        node.children.set(char, created);
        node = created;
      }
      node.taskIds.add(taskId);
    }
  }

  private collect(node: TrieNode, limit: number): TaskId[] {
    const output: TaskId[] = [];
    const queue: TrieNode[] = [node];
    const seen = new Set<TaskId>();

    while (queue.length > 0 && output.length < limit) {
      const current = queue.shift();
      if (!current) {
        continue;
      }

      for (const taskId of current.taskIds) {
        if (!seen.has(taskId)) {
          seen.add(taskId);
          output.push(taskId);
          if (output.length >= limit) {
            return output;
          }
        }
      }

      for (const next of current.children.values()) {
        queue.push(next);
      }
    }

    return output;
  }
}

export class LRUCache<K, V> {
  private readonly maxEntries: number;
  private readonly map: Map<K, V>;

  constructor(maxEntries: number) {
    this.maxEntries = maxEntries;
    this.map = new Map<K, V>();
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) {
      return undefined;
    }

    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    }

    this.map.set(key, value);
    if (this.map.size <= this.maxEntries) {
      return;
    }

    const oldestKey = this.map.keys().next().value;
    if (oldestKey !== undefined) {
      this.map.delete(oldestKey);
    }
  }
}

export type Comparator<T> = (left: T, right: T) => number;

export class PriorityQueue<T> {
  private readonly compare: Comparator<T>;
  private readonly heap: T[];

  constructor(compare: Comparator<T>, seed?: T[]) {
    this.compare = compare;
    this.heap = seed ? [...seed] : [];
    if (this.heap.length > 1) {
      this.heapify();
    }
  }

  get size(): number {
    return this.heap.length;
  }

  toArray(): T[] {
    return [...this.heap];
  }

  push(value: T): void {
    this.heap.push(value);
    this.siftUp(this.heap.length - 1);
  }

  pop(): T | undefined {
    if (this.heap.length === 0) {
      return undefined;
    }

    if (this.heap.length === 1) {
      return this.heap.pop();
    }

    const top = this.heap[0];
    const tail = this.heap.pop();
    if (tail !== undefined) {
      this.heap[0] = tail;
      this.siftDown(0);
    }
    return top;
  }

  private heapify(): void {
    for (let index = Math.floor(this.heap.length / 2) - 1; index >= 0; index -= 1) {
      this.siftDown(index);
    }
  }

  private siftUp(index: number): void {
    let current = index;
    while (current > 0) {
      const parent = Math.floor((current - 1) / 2);
      if (this.compare(this.heap[current], this.heap[parent]) <= 0) {
        break;
      }

      [this.heap[current], this.heap[parent]] = [this.heap[parent], this.heap[current]];
      current = parent;
    }
  }

  private siftDown(index: number): void {
    let current = index;

    while (current < this.heap.length) {
      const left = current * 2 + 1;
      const right = left + 1;
      let largest = current;

      if (left < this.heap.length && this.compare(this.heap[left], this.heap[largest]) > 0) {
        largest = left;
      }

      if (right < this.heap.length && this.compare(this.heap[right], this.heap[largest]) > 0) {
        largest = right;
      }

      if (largest === current) {
        return;
      }

      [this.heap[current], this.heap[largest]] = [this.heap[largest], this.heap[current]];
      current = largest;
    }
  }
}

export function buildDependencyGraph(tasksById: Record<TaskId, Task>): Map<TaskId, TaskId[]> {
  const graph = new Map<TaskId, TaskId[]>();
  for (const task of Object.values(tasksById)) {
    graph.set(task.id, [...task.dependencyIds]);
  }
  return graph;
}

function hasPath(graph: Map<TaskId, TaskId[]>, start: TaskId, target: TaskId): boolean {
  if (start === target) {
    return true;
  }

  const visited = new Set<TaskId>();
  const stack: TaskId[] = [start];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current)) {
      continue;
    }

    visited.add(current);
    const neighbors = graph.get(current) ?? [];

    for (const neighbor of neighbors) {
      if (neighbor === target) {
        return true;
      }
      if (!visited.has(neighbor)) {
        stack.push(neighbor);
      }
    }
  }

  return false;
}

export function createsDependencyCycle(
  tasksById: Record<TaskId, Task>,
  taskId: TaskId,
  dependsOnTaskId: TaskId
): boolean {
  const graph = buildDependencyGraph(tasksById);
  const current = graph.get(taskId) ?? [];
  graph.set(taskId, [...current, dependsOnTaskId]);
  return hasPath(graph, dependsOnTaskId, taskId);
}

export interface CursorWindow {
  totalPages: number;
  currentPage: number;
  cursor: number;
  pageWindow: number[];
  nextCursor: number | null;
  prevCursor: number | null;
}

export function getCursorWindow(
  totalItems: number,
  requestedCursor: number,
  pageSize: number,
  windowSize = 5
): CursorWindow {
  const safePageSize = Math.max(pageSize, 1);
  const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
  const maxCursor = Math.max(0, (totalPages - 1) * safePageSize);
  const cursor = Math.max(0, Math.min(requestedCursor, maxCursor));
  const currentPage = Math.floor(cursor / safePageSize) + 1;

  const halfWindow = Math.floor(windowSize / 2);
  let startPage = Math.max(1, currentPage - halfWindow);
  const endPage = Math.min(totalPages, startPage + windowSize - 1);
  startPage = Math.max(1, endPage - windowSize + 1);

  const pageWindow: number[] = [];
  for (let page = startPage; page <= endPage; page += 1) {
    pageWindow.push(page);
  }

  const prevCursor = currentPage > 1 ? cursor - safePageSize : null;
  const nextCursor = currentPage < totalPages ? cursor + safePageSize : null;

  return {
    totalPages,
    currentPage,
    cursor,
    pageWindow,
    nextCursor,
    prevCursor,
  };
}

export function buildPrefixSums(heights: number[]): number[] {
  const prefix = new Array<number>(heights.length + 1);
  prefix[0] = 0;
  for (let index = 0; index < heights.length; index += 1) {
    prefix[index + 1] = prefix[index] + heights[index];
  }
  return prefix;
}

export function binarySearchPrefix(prefix: number[], target: number): number {
  let left = 0;
  let right = prefix.length - 1;

  while (left < right) {
    const middle = Math.floor((left + right + 1) / 2);
    if (prefix[middle] <= target) {
      left = middle;
    } else {
      right = middle - 1;
    }
  }

  return left;
}

export interface VirtualRange {
  startIndex: number;
  endIndex: number;
  totalHeight: number;
}

export function getVirtualRange(
  prefix: number[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number
): VirtualRange {
  const itemCount = Math.max(0, prefix.length - 1);
  if (itemCount === 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      totalHeight: 0,
    };
  }

  const start = Math.max(0, binarySearchPrefix(prefix, scrollTop) - overscan);
  const bottom = scrollTop + viewportHeight;
  const end = Math.min(itemCount, binarySearchPrefix(prefix, bottom) + overscan + 1);

  return {
    startIndex: start,
    endIndex: end,
    totalHeight: prefix[prefix.length - 1],
  };
}

export function emptyStatusMap(): Record<TaskStatus, TaskId[]> {
  return {
    backlog: [],
    todo: [],
    in_progress: [],
    done: [],
  };
}
