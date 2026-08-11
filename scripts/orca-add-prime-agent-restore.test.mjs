// @ts-nocheck
// Self-contained unit tests for the fail-fast and restore behavior of the
// Orca patch script. Unlike orca-add-prime-agent.test.mjs, these need no
// installed Orca app, no network, and no built bundle: fixture trees are
// fabricated from the exported PATCHES table itself (each file's content is
// its anchors joined), so they run anywhere `node --test` does.
//
// Run:   node --test scripts/orca-add-prime-agent-restore.test.mjs
//
// Regression coverage for two review findings:
//   - "Silent partial-patch success": patchTree used to skip absent PATCHES
//     files and the CLI exited 0 with "done." on a half-patched app. It must
//     now fail fast (throw) unless requireAll=false (unpacked subset).
//   - "--restore is destructive and incomplete": restoreInstalledApp used to
//     rm -rf the extracted app dir without provenance and never reverted the
//     patched app.asar.unpacked copies. It must now refuse to delete an app
//     dir it cannot prove it created, and fully revert unpacked copies from
//     the patch-time snapshot.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { patchTree, patchUnpackedTree, restoreInstalledApp, PATCHES } from "./orca-add-prime-agent.mjs";

/** Fabricate a file whose content contains every anchor PATCHES expects. */
function writeFabricatedFile(root, relPath, content) {
  const dest = join(root, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  if (content === undefined) {
    const ops = PATCHES.find(([p]) => p === relPath)?.[1];
    assert.ok(ops, `no PATCHES entry for ${relPath}`);
    content = ops.map((op) => op.anchor).join("\n");
  }
  writeFileSync(dest, content);
}

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "orca-restore-"));
}

function cleanup(dir) {
  if (dir) rmSync(dir, { recursive: true, force: true });
}

test("patchTree fails fast when a PATCHES file is absent (fail-fast contract)", () => {
  const root = makeTempDir();
  try {
    // Only the first target exists; every other target is missing.
    writeFabricatedFile(root, PATCHES[0][0]);
    assert.throws(
      () => patchTree(root),
      (err) => {
        assert.match(err.message, /file not found/);
        assert.ok(
          err.message.includes(PATCHES[1][0]),
          `message should name the first missing file, got: ${err.message}`,
        );
        assert.match(err.message, /fail fast/);
        return true;
      },
    );
  } finally {
    cleanup(root);
  }
});

test("patchTree(requireAll:false) skips absent files (unpacked subset semantics)", () => {
  const root = makeTempDir();
  try {
    writeFabricatedFile(root, PATCHES[0][0]);
    const result = patchTree(root, { requireAll: false });
    assert.equal(result.patched.length, 1, "present target should be patched");
    assert.ok(
      result.skipped.some((s) => s.endsWith("(absent)")),
      "absent targets should be skipped, not throw",
    );
    const src = readFileSync(join(root, PATCHES[0][0]), "utf8");
    assert.ok(src.includes("prime-agent"), "present file should contain the patch");
  } finally {
    cleanup(root);
  }
});

test("patchTree on a complete tree patches everything and is idempotent", () => {
  const root = makeTempDir();
  try {
    for (const [relPath] of PATCHES) writeFabricatedFile(root, relPath);
    const first = patchTree(root);
    assert.equal(first.patched.length, PATCHES.length, "all targets patched on first run");
    assert.equal(first.skipped.length, 0);
    const second = patchTree(root);
    assert.equal(second.patched.length, 0, "nothing re-patched on second run");
    assert.equal(second.skipped.length, PATCHES.length);
    assert.ok(second.skipped.every((s) => s.endsWith("(already patched)")), "second run is a clean no-op");
  } finally {
    cleanup(root);
  }
});

test("restoreInstalledApp fully reverts: asar, extracted dir, and unpacked copies", () => {
  const app = makeTempDir();
  const resources = join(app, "Contents", "Resources");
  try {
    const rel = PATCHES[0][0]; // out/shared/tui-agent-config.js
    // Simulated converted state: extracted dir + archive backup + unpacked
    // copy + the patch-time snapshot holding the ORIGINAL unpacked bytes.
    writeFabricatedFile(join(resources, "app"), rel);
    writeFabricatedFile(join(resources, "app.asar.unpacked"), rel);
    writeFileSync(join(resources, "app.asar.bak-prime-agent"), "original archive bytes");
    const originalUnpacked = "original unpacked content";
    writeFabricatedFile(join(resources, "app.asar.unpacked.bak-prime-agent"), rel, originalUnpacked);

    restoreInstalledApp(app);

    assert.ok(!existsSync(join(resources, "app")), "extracted dir removed");
    assert.equal(
      readFileSync(join(resources, "app.asar"), "utf8"),
      "original archive bytes",
      "app.asar restored from backup",
    );
    assert.ok(!existsSync(join(resources, "app.asar.bak-prime-agent")), "backup consumed");
    assert.equal(
      readFileSync(join(resources, "app.asar.unpacked", rel), "utf8"),
      originalUnpacked,
      "unpacked copy reverted to original bytes",
    );
    assert.ok(!existsSync(join(resources, "app.asar.unpacked.bak-prime-agent")), "snapshot removed");
  } finally {
    cleanup(app);
  }
});

test("restoreInstalledApp refuses to delete an app dir it cannot prove it created", () => {
  const app = makeTempDir();
  const resources = join(app, "Contents", "Resources");
  try {
    // Directory-app layout with NO patch backup: must not be treated as ours.
    writeFabricatedFile(join(resources, "app"), PATCHES[0][0]);
    assert.throws(() => restoreInstalledApp(app), /refusing to delete/);
    assert.ok(existsSync(join(resources, "app")), "app dir untouched after refusal");
  } finally {
    cleanup(app);
  }
});

test("restoreInstalledApp is a no-op on a plain asar layout", () => {
  const app = makeTempDir();
  const resources = join(app, "Contents", "Resources");
  try {
    mkdirSync(resources, { recursive: true });
    writeFileSync(join(resources, "app.asar"), "archive");
    restoreInstalledApp(app); // must not throw
    assert.equal(readFileSync(join(resources, "app.asar"), "utf8"), "archive");
    assert.ok(!existsSync(join(resources, "app")));
  } finally {
    cleanup(app);
  }
});

test("patchUnpackedTree snapshots originals and restoreInstalledApp reverts them", () => {
  const app = makeTempDir();
  const resources = join(app, "Contents", "Resources");
  try {
    const rel = PATCHES[0][0];
    writeFabricatedFile(join(resources, "app.asar.unpacked"), rel);

    const result = patchUnpackedTree(resources);
    assert.ok(result.patched.length >= 1, "unpacked file patched");
    const snapshotPath = join(resources, "app.asar.unpacked.bak-prime-agent", rel);
    assert.ok(existsSync(snapshotPath), "patch-time snapshot created");
    const original = readFileSync(snapshotPath, "utf8");
    assert.ok(!original.includes("prime-agent"), "snapshot holds pre-patch bytes");

    // Complete the simulated converted state so restore proceeds.
    writeFabricatedFile(join(resources, "app"), rel);
    writeFileSync(join(resources, "app.asar.bak-prime-agent"), "archive");

    restoreInstalledApp(app);
    assert.equal(
      readFileSync(join(resources, "app.asar.unpacked", rel), "utf8"),
      original,
      "unpacked copy reverted to original bytes",
    );
    assert.ok(!existsSync(join(resources, "app.asar.unpacked.bak-prime-agent")), "snapshot removed");
  } finally {
    cleanup(app);
  }
});
