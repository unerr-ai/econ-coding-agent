/**
 * P0 RepoProfile core (docs/design/agnostic-hands-eyes.md §2.1). Fixture
 * corpus of synthetic repos in temp dirs — never the real checkout — asserting
 * the deterministic derivation ladder: manifest fingerprints -> ecosystems,
 * CI-config / scripts / convention-default priority for the test command,
 * toolchain pin + lockfile version fingerprints, and the on-disk cache.
 */
import { describe, it, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import {
  deriveRepoProfile,
  loadRepoProfile,
  repoProfileCachePath,
  ECOSYSTEM_CONVENTIONS,
} from "../../src/code-intelligence/repo-profile"

function makeFixtureRepo(): string {
  return mkdtempSync(join(tmpdir(), "econ-repo-profile-"))
}

function write(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

function withFixture(build: (root: string) => void, run: (root: string) => void): void {
  const root = makeFixtureRepo()
  try {
    build(root)
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe("ECOSYSTEM_CONVENTIONS", () => {
  it("has one row per seed ecosystem including the django variant", () => {
    const ids = ECOSYSTEM_CONVENTIONS.map((r) => r.id)
    expect(ids).toEqual([
      "python-pytest",
      "python-django",
      "javascript-jest",
      "javascript-vitest",
      "go",
      "rust",
      "java-maven",
      "java-gradle",
      "ruby",
      "php",
    ])
  })
})

describe("deriveRepoProfile — single ecosystems", () => {
  it("python-pytest: pyproject.toml alone selects the plain pytest row", () => {
    withFixture(
      (root) => {
        write(root, "pyproject.toml", "[project]\nname = \"demo\"\n")
      },
      (root) => {
        const profile = deriveRepoProfile(root)
        expect(profile.ecosystems).toHaveLength(1)
        const eco = profile.ecosystems[0]
        expect(eco.language).toBe("python")
        expect("unknown" in eco.tests).toBe(false)
        if (!("unknown" in eco.tests)) {
          expect(eco.tests.runner).toBe("pytest")
          expect(eco.tests.suite).toBe("pytest")
          expect(eco.tests.source).toBe("convention")
          expect(eco.tests.needsSynthesis).toBe(true)
          expect(eco.tests.validated).toBe(false)
        }
      },
    )
  })

  it("django fingerprint (tests/runtests.py) selects the django variant row over plain pytest", () => {
    withFixture(
      (root) => {
        write(root, "pyproject.toml", "[project]\nname = \"django-demo\"\n")
        write(root, "tests/runtests.py", "# django's own test runner\n")
      },
      (root) => {
        const profile = deriveRepoProfile(root)
        expect(profile.ecosystems).toHaveLength(1)
        const eco = profile.ecosystems[0]
        expect(eco.language).toBe("python")
        if (!("unknown" in eco.tests)) {
          expect(eco.tests.runner).toBe("django-test")
          expect(eco.tests.suite).toBe("python tests/runtests.py")
        }
      },
    )
  })

  it("js-jest: package.json with a jest devDependency selects the jest row", () => {
    withFixture(
      (root) => {
        write(
          root,
          "package.json",
          JSON.stringify({ name: "demo", devDependencies: { jest: "^29.0.0" } }),
        )
      },
      (root) => {
        const profile = deriveRepoProfile(root)
        expect(profile.ecosystems).toHaveLength(1)
        const eco = profile.ecosystems[0]
        expect(eco.language).toBe("javascript")
        if (!("unknown" in eco.tests)) {
          expect(eco.tests.runner).toBe("jest")
        }
      },
    )
  })

  it("js-vitest: package.json with a vitest devDependency selects the vitest row over jest", () => {
    withFixture(
      (root) => {
        write(
          root,
          "package.json",
          JSON.stringify({ name: "demo", devDependencies: { vitest: "^1.0.0" } }),
        )
      },
      (root) => {
        const profile = deriveRepoProfile(root)
        const eco = profile.ecosystems[0]
        if (!("unknown" in eco.tests)) {
          expect(eco.tests.runner).toBe("vitest")
        }
      },
    )
  })

  it("go: go.mod selects the go row and resolves the go directive as the language version", () => {
    withFixture(
      (root) => {
        write(root, "go.mod", "module example.com/demo\n\ngo 1.21\n")
      },
      (root) => {
        const profile = deriveRepoProfile(root)
        const eco = profile.ecosystems[0]
        expect(eco.language).toBe("go")
        expect(eco.versions.language).toBe("1.21")
        if (!("unknown" in eco.tests)) {
          expect(eco.tests.runner).toBe("go test")
        }
      },
    )
  })

  it("rust: Cargo.toml + Cargo.lock resolves the [[package]] version fingerprint", () => {
    withFixture(
      (root) => {
        write(root, "Cargo.toml", "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n")
        write(
          root,
          "Cargo.lock",
          [
            "# This file is automatically @generated by Cargo.",
            "version = 3",
            "",
            "[[package]]",
            'name = "serde"',
            'version = "1.0.197"',
            "",
            "[[package]]",
            'name = "libc"',
            'version = "0.2.153"',
            "",
          ].join("\n"),
        )
      },
      (root) => {
        const profile = deriveRepoProfile(root)
        const eco = profile.ecosystems[0]
        expect(eco.language).toBe("rust")
        expect(eco.versions.deps.serde).toBe("1.0.197")
        expect(eco.versions.deps.libc).toBe("0.2.153")
      },
    )
  })

  it("java-maven: pom.xml selects the maven-surefire row with a convention-default suite command", () => {
    withFixture(
      (root) => {
        write(root, "pom.xml", "<project></project>\n")
      },
      (root) => {
        const profile = deriveRepoProfile(root)
        const eco = profile.ecosystems[0]
        expect(eco.language).toBe("java")
        if (!("unknown" in eco.tests)) {
          expect(eco.tests.runner).toBe("maven-surefire")
          expect(eco.tests.suite).toBe("mvn test")
          expect(eco.tests.source).toBe("convention")
        }
      },
    )
  })
})

describe("deriveRepoProfile — monorepo (one level down)", () => {
  it("a python root + a js subdir one level down yield two EcosystemProfiles", () => {
    withFixture(
      (root) => {
        write(root, "pyproject.toml", "[project]\nname = \"backend\"\n")
        write(join(root, "frontend"), "package.json", JSON.stringify({ name: "frontend" }))
      },
      (root) => {
        const profile = deriveRepoProfile(root)
        expect(profile.ecosystems).toHaveLength(2)
        const languages = profile.ecosystems.map((e) => e.language).sort()
        expect(languages).toEqual(["javascript", "python"])
        const frontend = profile.ecosystems.find((e) => e.language === "javascript")
        expect(frontend?.root).toBe("frontend")
      },
    )
  })
})

describe("deriveRepoProfile — no-test repo", () => {
  it("no recognized manifest anywhere -> tests unknown + needsSynthesis", () => {
    withFixture(
      (root) => {
        write(root, "README.md", "# just a readme, no manifest\n")
      },
      (root) => {
        const profile = deriveRepoProfile(root)
        expect(profile.ecosystems).toHaveLength(1)
        const eco = profile.ecosystems[0]
        expect(eco.language).toBe("unknown")
        expect(eco.tests).toEqual({ unknown: true, source: "unknown", needsSynthesis: true })
      },
    )
  })
})

describe("deriveRepoProfile — CI beats convention default", () => {
  it("a workflow's explicit pytest invocation wins over the pytest row's suite default", () => {
    withFixture(
      (root) => {
        write(root, "pyproject.toml", "[project]\nname = \"demo\"\n")
        write(
          root,
          ".github/workflows/ci.yml",
          [
            "name: CI",
            "on: [push]",
            "jobs:",
            "  test:",
            "    runs-on: ubuntu-latest",
            "    steps:",
            "      - run: pip install -e .",
            "      - run: pytest -q --cov=demo",
            "",
          ].join("\n"),
        )
      },
      (root) => {
        const profile = deriveRepoProfile(root)
        const eco = profile.ecosystems[0]
        if (!("unknown" in eco.tests)) {
          expect(eco.tests.source).toBe("ci")
          expect(eco.tests.suite).toBe("pytest -q --cov=demo")
          expect(eco.tests.needsSynthesis).toBe(false)
        }
      },
    )
  })

  it("package.json scripts.test beats the jest row's convention default when no CI is present", () => {
    withFixture(
      (root) => {
        write(
          root,
          "package.json",
          JSON.stringify({
            name: "demo",
            devDependencies: { jest: "^29.0.0" },
            scripts: { test: "jest --runInBand --coverage" },
          }),
        )
      },
      (root) => {
        const profile = deriveRepoProfile(root)
        const eco = profile.ecosystems[0]
        if (!("unknown" in eco.tests)) {
          expect(eco.tests.source).toBe("scripts")
          expect(eco.tests.suite).toBe("jest --runInBand --coverage")
        }
      },
    )
  })
})

describe("deriveRepoProfile — lockfile version fingerprints", () => {
  it("npm package-lock.json (lockfileVersion 3 shape) resolves top-level dep versions", () => {
    withFixture(
      (root) => {
        write(root, "package.json", JSON.stringify({ name: "demo", devDependencies: { jest: "^29.0.0" } }))
        write(
          root,
          "package-lock.json",
          JSON.stringify({
            name: "demo",
            lockfileVersion: 3,
            packages: {
              "": { name: "demo" },
              "node_modules/jest": { version: "29.7.0" },
              "node_modules/lodash": { version: "4.17.21" },
              "node_modules/jest/node_modules/nested-thing": { version: "9.9.9" },
            },
          }),
        )
      },
      (root) => {
        const profile = deriveRepoProfile(root)
        const eco = profile.ecosystems[0]
        expect(eco.versions.deps.jest).toBe("29.7.0")
        expect(eco.versions.deps.lodash).toBe("4.17.21")
        expect(eco.versions.deps["nested-thing"]).toBeUndefined()
        expect(eco.versions.runner).toBe("29.7.0")
      },
    )
  })

  it("Gemfile.lock top-level specs resolve to dep versions", () => {
    withFixture(
      (root) => {
        write(root, "Gemfile", 'source "https://rubygems.org"\ngem "rspec"\n')
        write(
          root,
          "Gemfile.lock",
          [
            "GEM",
            "  remote: https://rubygems.org/",
            "  specs:",
            "    rspec (3.12.0)",
            "      rspec-core (~> 3.12.0)",
            "    rake (13.0.6)",
            "",
            "PLATFORMS",
            "  ruby",
            "",
          ].join("\n"),
        )
      },
      (root) => {
        const profile = deriveRepoProfile(root)
        const eco = profile.ecosystems[0]
        expect(eco.language).toBe("ruby")
        expect(eco.versions.deps.rspec).toBe("3.12.0")
        expect(eco.versions.deps.rake).toBe("13.0.6")
      },
    )
  })
})

describe("loadRepoProfile — cache", () => {
  it("persists outside the repo and reuses the cached profile while the manifest fingerprint matches", () => {
    withFixture(
      (root) => {
        write(root, "pyproject.toml", "[project]\nname = \"demo\"\n")
      },
      (root) => {
        const cachePath = repoProfileCachePath(root)
        expect(cachePath.startsWith(root)).toBe(false)

        const first = loadRepoProfile(root)
        expect(existsSync(cachePath)).toBe(true)

        const second = loadRepoProfile(root)
        expect(second).toEqual(first)
      },
    )
  })

  it("--force re-derives even when the fingerprint is unchanged", () => {
    withFixture(
      (root) => {
        write(root, "go.mod", "module example.com/demo\n\ngo 1.20\n")
      },
      (root) => {
        const first = loadRepoProfile(root)
        const forced = loadRepoProfile(root, { force: true })
        expect(forced).toEqual(first)
      },
    )
  })
})
