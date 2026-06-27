import { describe, it, expect } from "bun:test"
import {
  createTaskTree,
  addTask,
  updateStatus,
  setDecision,
  findNode,
  collectDecisions,
  serializeTaskTree,
  deserializeTaskTree,
  renderTaskTree,
} from "./../src/task-tree.js"

describe("task-tree", () => {
  // Build a reusable tree: root → child-a → grandchild-a1, root → child-b
  function buildTree() {
    let tree = createTaskTree("root", "Root Task")
    tree = addTask(tree, "root", { id: "child-a", title: "Child A", status: "in-progress" })
    tree = addTask(tree, "root", { id: "child-b", title: "Child B" })
    tree = addTask(tree, "child-a", { id: "gc-a1", title: "Grandchild A1", status: "done" })
    tree = updateStatus(tree, "child-b", "in-progress")
    tree = setDecision(tree, "child-a", "Use drizzle upsert for idempotent writes")
    tree = setDecision(tree, "gc-a1", "Tree-sitter selected over regex for AST extraction")
    return tree
  }

  describe("createTaskTree", () => {
    it("creates a tree with root node at version 1", () => {
      const tree = createTaskTree("r", "Root")
      expect(tree.version).toBe(1)
      expect(tree.root.id).toBe("r")
      expect(tree.root.title).toBe("Root")
      expect(tree.root.status).toBe("pending")
      expect(tree.root.children).toEqual([])
    })
  })

  describe("addTask", () => {
    it("adds a child under the root and increments version", () => {
      const tree = createTaskTree("root", "Root")
      const t2 = addTask(tree, "root", { id: "c1", title: "Child 1" })
      expect(t2.version).toBe(2)
      const child = findNode(t2, "c1")
      expect(child).toBeDefined()
      expect(child?.title).toBe("Child 1")
      expect(child?.status).toBe("pending")
    })

    it("adds a grandchild under a nested node", () => {
      const tree = buildTree()
      const gc = findNode(tree, "gc-a1")
      expect(gc).toBeDefined()
      expect(gc?.title).toBe("Grandchild A1")
    })

    it("throws when parentId is not found", () => {
      const tree = createTaskTree("root", "Root")
      expect(() => addTask(tree, "nonexistent", { id: "x", title: "X" })).toThrow(
        /parentId "nonexistent" not found/,
      )
    })

    it("throws when id already exists in the tree", () => {
      const tree = createTaskTree("root", "Root")
      const t2 = addTask(tree, "root", { id: "dup", title: "Dup" })
      expect(() => addTask(t2, "root", { id: "dup", title: "Dup Again" })).toThrow(
        /duplicate id "dup"/,
      )
    })
  })

  describe("updateStatus", () => {
    it("updates the status of a node and returns a new tree", () => {
      const tree = createTaskTree("root", "Root")
      const t2 = updateStatus(tree, "root", "done")
      expect(t2.root.status).toBe("done")
      expect(t2.version).toBe(2)
    })

    it("throws when id is not found", () => {
      const tree = createTaskTree("root", "Root")
      expect(() => updateStatus(tree, "missing", "done")).toThrow(/id "missing" not found/)
    })
  })

  describe("setDecision", () => {
    it("attaches a decision summary to a node", () => {
      const tree = createTaskTree("root", "Root")
      const t2 = setDecision(tree, "root", "Go with bun:sqlite over pg")
      const node = findNode(t2, "root")
      expect(node?.decision).toBe("Go with bun:sqlite over pg")
      expect(t2.version).toBe(2)
    })

    it("throws when id is not found", () => {
      const tree = createTaskTree("root", "Root")
      expect(() => setDecision(tree, "ghost", "nope")).toThrow(/id "ghost" not found/)
    })
  })

  describe("findNode", () => {
    it("returns undefined for an absent id", () => {
      const tree = createTaskTree("root", "Root")
      expect(findNode(tree, "absent")).toBeUndefined()
    })

    it("finds a deeply nested node", () => {
      const tree = buildTree()
      const node = findNode(tree, "gc-a1")
      expect(node?.id).toBe("gc-a1")
      expect(node?.status).toBe("done")
    })
  })

  describe("collectDecisions", () => {
    it("returns all nodes with decisions attached", () => {
      const tree = buildTree()
      const decisions = collectDecisions(tree)
      expect(decisions).toHaveLength(2)
      const ids = decisions.map((d) => d.id)
      expect(ids).toContain("child-a")
      expect(ids).toContain("gc-a1")
    })

    it("returns empty array when no decisions are set", () => {
      const tree = createTaskTree("root", "Root")
      expect(collectDecisions(tree)).toEqual([])
    })
  })

  describe("immutability", () => {
    it("addTask does not mutate the input tree", () => {
      const tree = createTaskTree("root", "Root")
      const before = JSON.stringify(tree)
      const t2 = addTask(tree, "root", { id: "new", title: "New" })
      expect(JSON.stringify(tree)).toBe(before)
      expect(t2).not.toBe(tree)
    })

    it("updateStatus does not mutate the input tree", () => {
      const tree = createTaskTree("root", "Root")
      const before = JSON.stringify(tree)
      const t2 = updateStatus(tree, "root", "done")
      expect(JSON.stringify(tree)).toBe(before)
      expect(t2).not.toBe(tree)
    })
  })

  describe("serializeTaskTree / deserializeTaskTree (simulated restart)", () => {
    it("survives a round-trip: structure, statuses, and decisions all intact", () => {
      const tree = buildTree()
      const reloaded = deserializeTaskTree(serializeTaskTree(tree))

      // Deep-equal check
      expect(reloaded).toEqual(tree)

      // Version preserved
      expect(reloaded.version).toBe(tree.version)

      // Status of nodes preserved
      expect(findNode(reloaded, "child-a")?.status).toBe("in-progress")
      expect(findNode(reloaded, "gc-a1")?.status).toBe("done")
      expect(findNode(reloaded, "child-b")?.status).toBe("in-progress")

      // Decisions preserved
      expect(findNode(reloaded, "child-a")?.decision).toBe(
        "Use drizzle upsert for idempotent writes",
      )
      expect(findNode(reloaded, "gc-a1")?.decision).toBe(
        "Tree-sitter selected over regex for AST extraction",
      )

      // collectDecisions works on reloaded tree
      const decisions = collectDecisions(reloaded)
      expect(decisions).toHaveLength(2)
    })

    it("throws on malformed JSON", () => {
      expect(() => deserializeTaskTree("not json")).toThrow()
    })

    it("throws on structurally invalid payload", () => {
      expect(() => deserializeTaskTree(JSON.stringify({ wrong: true }))).toThrow()
    })
  })

  describe("renderTaskTree", () => {
    it("contains each task title", () => {
      const tree = buildTree()
      const md = renderTaskTree(tree)
      expect(md).toContain("Root Task")
      expect(md).toContain("Child A")
      expect(md).toContain("Child B")
      expect(md).toContain("Grandchild A1")
    })

    it("contains each decision in the Decisions section", () => {
      const tree = buildTree()
      const md = renderTaskTree(tree)
      expect(md).toContain("Decisions")
      expect(md).toContain("Use drizzle upsert for idempotent writes")
      expect(md).toContain("Tree-sitter selected over regex for AST extraction")
    })

    it("includes status markers", () => {
      const tree = buildTree()
      const md = renderTaskTree(tree)
      expect(md).toContain("[~]") // in-progress
      expect(md).toContain("[x]") // done
    })
  })
})
