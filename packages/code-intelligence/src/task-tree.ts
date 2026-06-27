/**
 * Immutable task-tree data structure for tracking hierarchical agent work
 * across compaction and restart. Provides serialization, status tracking,
 * and decision capture without any I/O — pure functions only.
 *
 * @sem domain=intelligence role=analysis
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Lifecycle state of a single task node; drives the markdown status marker
 * in rendered output and the router's triage decisions.
 *
 * @sem domain=intelligence role=analysis
 */
export type TaskStatus = "pending" | "in-progress" | "done" | "failed"

/**
 * A single node in the task hierarchy, carrying its identity, lifecycle state,
 * an optional decision summary, and an ordered list of child nodes.
 *
 * @sem domain=intelligence role=analysis
 */
export interface TaskNode {
  id: string
  title: string
  status: TaskStatus
  decision?: string
  children: TaskNode[]
}

/**
 * A versioned wrapper around the root node; the version counter increments on
 * every immutable update so callers can detect staleness without deep comparison.
 *
 * @sem domain=intelligence role=analysis
 */
export interface TaskTree {
  root: TaskNode
  version: number
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Deep-clone a TaskNode tree (used to satisfy immutability guarantees). */
function cloneNode(node: TaskNode): TaskNode {
  return {
    id: node.id,
    title: node.title,
    status: node.status,
    decision: node.decision,
    children: node.children.map(cloneNode),
  }
}

/** Return a new subtree with the child inserted under parentId, or null if parentId not found. */
function insertUnder(
  node: TaskNode,
  parentId: string,
  child: TaskNode,
): TaskNode | null {
  if (node.id === parentId) {
    return { ...cloneNode(node), children: [...node.children.map(cloneNode), cloneNode(child)] }
  }
  const newChildren: TaskNode[] = []
  let found = false
  for (const c of node.children) {
    const result = insertUnder(c, parentId, child)
    if (result !== null) {
      newChildren.push(result)
      found = true
    } else {
      newChildren.push(cloneNode(c))
    }
  }
  if (!found) return null
  return { ...cloneNode(node), children: newChildren }
}

/** Return a new subtree with id's status/decision updated, or null if not found. */
function updateNode(
  node: TaskNode,
  id: string,
  patch: Partial<Pick<TaskNode, "status" | "decision">>,
): TaskNode | null {
  if (node.id === id) {
    return { ...cloneNode(node), ...patch }
  }
  const newChildren: TaskNode[] = []
  let found = false
  for (const c of node.children) {
    const result = updateNode(c, id, patch)
    if (result !== null) {
      newChildren.push(result)
      found = true
    } else {
      newChildren.push(cloneNode(c))
    }
  }
  if (!found) return null
  return { ...cloneNode(node), children: newChildren }
}

/** Collect all ids in the tree (DFS). */
function collectIds(node: TaskNode): Set<string> {
  const ids = new Set<string>([node.id])
  for (const c of node.children) {
    for (const id of collectIds(c)) ids.add(id)
  }
  return ids
}

/** Walk every node, collect those with a non-empty decision. */
function walkDecisions(
  node: TaskNode,
  out: Array<{ id: string; title: string; decision: string }>,
): void {
  if (node.decision && node.decision.length > 0) {
    out.push({ id: node.id, title: node.title, decision: node.decision })
  }
  for (const c of node.children) walkDecisions(c, out)
}

/** Walk tree to find a node by id (DFS). */
function walkFind(node: TaskNode, id: string): TaskNode | undefined {
  if (node.id === id) return node
  for (const c of node.children) {
    const result = walkFind(c, id)
    if (result !== undefined) return result
  }
  return undefined
}

// Status marker for renderTaskTree output
const STATUS_MARKER: Record<TaskStatus, string> = {
  pending: "[ ]",
  "in-progress": "[~]",
  done: "[x]",
  failed: "[!]",
}

/** Render a node and its children as indented markdown lines. */
function renderNode(node: TaskNode, depth: number, lines: string[]): void {
  const indent = "  ".repeat(depth)
  const marker = STATUS_MARKER[node.status]
  lines.push(`${indent}${marker} **${node.title}** (${node.id})`)
  for (const c of node.children) renderNode(c, depth + 1, lines)
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/**
 * Initialise a fresh task tree with a single root node at version 1.
 *
 * @sem domain=intelligence role=analysis
 */
export function createTaskTree(rootId: string, rootTitle: string): TaskTree {
  return {
    root: { id: rootId, title: rootTitle, status: "pending", children: [] },
    version: 1,
  }
}

/**
 * Return a new tree with a child node appended under parentId; throws when
 * parentId is not present or when the new id already exists in the tree.
 *
 * @sem domain=intelligence role=analysis
 */
export function addTask(
  tree: TaskTree,
  parentId: string,
  node: { id: string; title: string; status?: TaskStatus; decision?: string },
): TaskTree {
  const allIds = collectIds(tree.root)
  if (allIds.has(node.id)) {
    throw new Error(`addTask: duplicate id "${node.id}"`)
  }
  const child: TaskNode = {
    id: node.id,
    title: node.title,
    status: node.status ?? "pending",
    decision: node.decision,
    children: [],
  }
  const newRoot = insertUnder(tree.root, parentId, child)
  if (newRoot === null) {
    throw new Error(`addTask: parentId "${parentId}" not found in tree`)
  }
  return { root: newRoot, version: tree.version + 1 }
}

/**
 * Return a new tree with the named node's status updated; throws when the id
 * is absent from the tree.
 *
 * @sem domain=intelligence role=analysis
 */
export function updateStatus(tree: TaskTree, id: string, status: TaskStatus): TaskTree {
  const newRoot = updateNode(tree.root, id, { status })
  if (newRoot === null) {
    throw new Error(`updateStatus: id "${id}" not found in tree`)
  }
  return { root: newRoot, version: tree.version + 1 }
}

/**
 * Return a new tree with a decision summary attached to the named node; throws
 * when the id is absent from the tree.
 *
 * @sem domain=intelligence role=analysis
 */
export function setDecision(tree: TaskTree, id: string, decision: string): TaskTree {
  const newRoot = updateNode(tree.root, id, { decision })
  if (newRoot === null) {
    throw new Error(`setDecision: id "${id}" not found in tree`)
  }
  return { root: newRoot, version: tree.version + 1 }
}

/**
 * Return the node with the given id, or undefined if it is not in the tree.
 *
 * @sem domain=intelligence role=analysis
 */
export function findNode(tree: TaskTree, id: string): TaskNode | undefined {
  return walkFind(tree.root, id)
}

/**
 * Return every node that carries a non-empty decision summary, in DFS order,
 * so agents can audit which decisions shaped the session.
 *
 * @sem domain=intelligence role=analysis
 */
export function collectDecisions(
  tree: TaskTree,
): Array<{ id: string; title: string; decision: string }> {
  const out: Array<{ id: string; title: string; decision: string }> = []
  walkDecisions(tree.root, out)
  return out
}

/**
 * Produce a stable JSON string for the full task tree; the version counter is
 * included so round-trip fidelity can be verified without deep comparison.
 *
 * @sem domain=intelligence role=analysis
 */
export function serializeTaskTree(tree: TaskTree): string {
  return JSON.stringify(tree)
}

/**
 * Parse a JSON string produced by serializeTaskTree and validate its shape;
 * throws on malformed JSON or structurally invalid payloads.
 *
 * @sem domain=intelligence role=analysis
 */
export function deserializeTaskTree(json: string): TaskTree {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error("deserializeTaskTree: invalid JSON")
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("root" in parsed) ||
    !("version" in parsed) ||
    typeof (parsed as Record<string, unknown>).version !== "number"
  ) {
    throw new Error("deserializeTaskTree: invalid TaskTree shape")
  }
  return parsed as TaskTree
}

/**
 * Render the task tree as a compact markdown string — indented task list with
 * status markers plus a Decisions section — suitable for checkpoint injection
 * into a model context window.
 *
 * @sem domain=intelligence role=analysis
 */
export function renderTaskTree(tree: TaskTree): string {
  const lines: string[] = [`## Task Tree (v${tree.version})\n`]
  renderNode(tree.root, 0, lines)

  const decisions = collectDecisions(tree)
  if (decisions.length > 0) {
    lines.push("\n### Decisions")
    for (const d of decisions) {
      lines.push(`- **${d.title}** (${d.id}): ${d.decision}`)
    }
  }

  return lines.join("\n")
}
