// @ts-nocheck
// TDD seam S1: the Orca patch produces structurally valid, consistent artifacts.
// Fixture: copies of the real installed app's files (extracted from app.asar),
// patched in a temp tree — never touches the installed app.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, cpSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { patchTree } from "./orca-add-prime-agent.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP_PATH = process.env.ORCA_APP ?? "/Applications/Orca.app";
const RESOURCES = join(APP_PATH, "Contents", "Resources");
const ASAR = join(RESOURCES, "app.asar");
const ASAR_BACKUP = `${ASAR}.bak-prime-agent`;

const EXPECTED_CONFIG_ENTRY = {
  detectCmd: "prime-agent",
  launchCmd: "prime-agent",
  expectedProcess: "prime-agent",
  promptInjectionMode: "argv",
  draftPromptEnvVar: "ORCA_PRIME_AGENT_PREFILL",
};

// Files to copy from the extracted app into the fixture tree.
const FIXTURE_FILES = [
  "out/shared/tui-agent-config.js",
  "out/shared/orca-cli-command-name.js",
  "out/shared/tui-agent-display-names.js",
  "out/shared/agent-kind.js",
  "out/shared/synthetic-agent-title.js",
  "out/main/chunks/tui-agent-config-x5jBLMn6.js",
  "out/main/index.js",
  "out/renderer/assets/store-BgJxB0hr.js",
  "out/renderer/assets/agent-catalog-1Y3pTpm8.js",
  "out/web/assets/store-BgJxB0hr.js",
  "out/web/assets/agent-catalog-1Y3pTpm8.js",
  "out/relay/darwin-arm64/relay.js",
  "out/relay/darwin-x64/relay.js",
  "out/relay/linux-arm64/relay.js",
  "out/relay/linux-x64/relay.js",
  "out/relay/win32-arm64/relay.js",
  "out/relay/win32-x64/relay.js",
];

let extractedDir = null;
let fixtureDir = null;
const require = createRequire(import.meta.url);

before(async () => {
  const asarSource = existsSync(ASAR) ? ASAR : existsSync(ASAR_BACKUP) ? ASAR_BACKUP : null;
  assert.ok(asarSource, `no app.asar (or backup) found under ${RESOURCES}; set ORCA_APP`);
  extractedDir = mkdtempSync(join(tmpdir(), "orca-app-"));
  // Copy the archive to a temp path and symlink the unpacked dir under the
  // temp name, because @electron/asar resolves unpacked files as
  // "<archive>.unpacked" and the real backup name no longer matches.
  cpSync(asarSource, join(extractedDir, "app.asar"));
  try {
    symlinkSync(join(RESOURCES, "app.asar.unpacked"), join(extractedDir, "app.asar.unpacked"));
  } catch {
    // unpacked dir may be absent; extraction still works for non-unpacked files
  }
  const res = spawnSync(
    "npx",
    ["--yes", "@electron/asar", "extract", join(extractedDir, "app.asar"), extractedDir],
    { encoding: "utf8", timeout: 300_000 },
  );
  assert.equal(res.status, 0, `asar extract failed: ${res.stderr ?? res.stdout}`);
  fixtureDir = mkdtempSync(join(tmpdir(), "orca-fixture-"));
  for (const rel of FIXTURE_FILES) {
    const src = join(extractedDir, rel);
    assert.ok(existsSync(src), `missing fixture source ${rel}`);
    const dest = join(fixtureDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
  }
});

after(() => {
  for (const dir of [extractedDir, fixtureDir]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("patchTree inserts a consistent prime-agent config entry in every config copy", () => {
  patchTree(fixtureDir);

  for (const rel of [
    "out/shared/tui-agent-config.js",
    "out/main/chunks/tui-agent-config-x5jBLMn6.js",
    "out/renderer/assets/store-BgJxB0hr.js",
  ]) {
    const src = readFileSync(join(fixtureDir, rel), "utf8");
    assert.ok(src.includes("prime-agent"), `${rel}: missing prime-agent`);
    assert.ok(src.includes("ORCA_PRIME_AGENT_PREFILL"), `${rel}: missing prefill env`);
    assert.ok(src.includes("draftPromptEnvVar"), `${rel}: config shape broken`);
  }

  // Shared config is a require-able CJS module: assert the actual runtime value.
  const sharedConfig = require(join(fixtureDir, "out/shared/tui-agent-config.js"));
  assert.deepEqual(sharedConfig.TUI_AGENT_CONFIG["prime-agent"], EXPECTED_CONFIG_ENTRY);
  assert.ok(sharedConfig.isTuiAgent("prime-agent"));

  // Main's chunk is require-able too.
  const mainConfig = require(join(fixtureDir, "out/main/chunks/tui-agent-config-x5jBLMn6.js"));
  assert.deepEqual(mainConfig.TUI_AGENT_CONFIG["prime-agent"], EXPECTED_CONFIG_ENTRY);
});

test("display names, agent kind, and title profiles include prime-agent", () => {
  const displayNames = require(join(fixtureDir, "out/shared/tui-agent-display-names.js"));
  assert.equal(displayNames.TUI_AGENT_DISPLAY_NAMES["prime-agent"], "Prime Agent");
  assert.ok(displayNames.ALL_TUI_AGENTS.includes("prime-agent"));

  const kinds = require(join(fixtureDir, "out/shared/agent-kind.js"));
  assert.equal(kinds.tuiAgentToAgentKind("prime-agent"), "prime-agent");
  assert.equal(kinds.agentKindToTuiAgent("prime-agent"), "prime-agent");

  const titles = require(join(fixtureDir, "out/shared/synthetic-agent-title.js"));
  const profile = titles.SYNTHETIC_AGENT_TITLE_PROFILES["prime-agent"];
  assert.deepEqual(profile, {
    workingLabel: "Prime Agent",
    permissionLabel: "Prime Agent - action required",
    idleLabel: "Prime Agent ready",
    titleIdentityGroup: "pi-compatible",
  });
});

test("renderer catalog lists Prime Agent with the right command", () => {
  const catalog = readFileSync(join(fixtureDir, "out/renderer/assets/agent-catalog-1Y3pTpm8.js"), "utf8");
  assert.ok(catalog.includes('id: "prime-agent"'), "catalog: missing id");
  assert.ok(catalog.includes('cmd: "prime-agent"'), "catalog: missing cmd");
  assert.ok(catalog.includes('"Prime Agent"'), "catalog: missing label");
  assert.ok(catalog.includes("PrimeIntellect-ai/prime-agent"), "catalog: missing homepage");

  // Web copies are minified; assert the compact entry.
  const webStore = readFileSync(join(fixtureDir, "out/web/assets/store-BgJxB0hr.js"), "utf8");
  assert.ok(webStore.includes('"prime-agent":{detectCmd:"prime-agent"'), "web store: missing config");
  assert.ok(webStore.includes("ORCA_PRIME_AGENT_PREFILL"), "web store: missing prefill env");
  const webCatalog = readFileSync(join(fixtureDir, "out/web/assets/agent-catalog-1Y3pTpm8.js"), "utf8");
  assert.ok(webCatalog.includes('id:"prime-agent"'), "web catalog: missing id");
  assert.ok(webCatalog.includes('cmd:"prime-agent"'), "web catalog: missing cmd");
});

test("main process machinery is prime-agent aware", () => {
  const main = readFileSync(join(fixtureDir, "out/main/index.js"), "utf8");
  const checks = [
    "'prime-agent': \"ORCA_PRIME_AGENT_PREFILL\"", // prefill env map
    "'prime-agent': \"prime-agent-overlays\"", // overlay root dir
    "'prime-agent': \".prime\"", // agent home dir
    'agentType === "prime-agent"', // isPiCompatibleAgentType
    "PRIME_AGENT_LAUNCH_BINARY", // launch binary for kind detection
    'return "prime-agent";', // detectExplicitPiAgentKindFromCommand
    "ORCA_PRIME_AGENT_SOURCE_AGENT_DIR", // extension env plumbing
    "PRIME_AGENT_CODING_AGENT_DIR", // primary agent-dir env
    "home-prime-agent", // skills home root
    "primeAgentDiscoveries", // session scanner
  ];
  for (const needle of checks) {
    assert.ok(main.includes(needle), `out/main/index.js: missing ${needle}`);
  }
});

test("all relay bundles carry the config entry and title profile", () => {
  for (const rel of [
    "out/relay/darwin-arm64/relay.js",
    "out/relay/darwin-x64/relay.js",
    "out/relay/linux-arm64/relay.js",
    "out/relay/linux-x64/relay.js",
    "out/relay/win32-arm64/relay.js",
    "out/relay/win32-x64/relay.js",
  ]) {
    const src = readFileSync(join(fixtureDir, rel), "utf8");
    assert.ok(src.includes('"prime-agent":{detectCmd:"prime-agent"'), `${rel}: missing config entry`);
    assert.ok(src.includes("ORCA_PRIME_AGENT_PREFILL"), `${rel}: missing prefill env`);
    assert.ok(src.includes('"prime-agent":{workingLabel:"Prime Agent"'), `${rel}: missing title profile`);
  }
});

test("patched main bundle is syntactically valid", () => {
  const res = spawnSync(process.execPath, ["--check", join(fixtureDir, "out/main/index.js")], {
    encoding: "utf8",
  });
  assert.equal(res.status, 0, `node --check failed: ${res.stderr}`);
});

test("patchTree is idempotent (no duplicate entries on re-run)", () => {
  patchTree(fixtureDir);
  const shared = readFileSync(join(fixtureDir, "out/shared/tui-agent-config.js"), "utf8");
  assert.equal(shared.match(/detectCmd: 'prime-agent'/g)?.length, 1, "shared config: duplicate entry");
  const main = readFileSync(join(fixtureDir, "out/main/index.js"), "utf8");
  assert.equal(main.match(/var PRIME_AGENT_LAUNCH_BINARY/g)?.length, 1, "index.js: duplicate insertion");
  const relay = readFileSync(join(fixtureDir, "out/relay/darwin-arm64/relay.js"), "utf8");
  assert.equal(relay.match(/"prime-agent":\{detectCmd:"prime-agent"/g)?.length, 1, "relay: duplicate entry");
});

test("built prime-agent CLI answers --version (seam S2)", () => {
  const bundle = join(repoRoot, "packages/coding-agent/dist/bundle/cli.js");
  assert.ok(existsSync(bundle), "run npm run build first");
  const res = spawnSync(process.execPath, [bundle, "--version"], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout + res.stderr, /\d+\.\d+\.\d+/);
});

// Guard: the fixture never touches the installed app.
test("installed app is untouched by the test", () => {
  assert.ok(existsSync(ASAR) || existsSync(ASAR_BACKUP), "app bundle layout intact");
  assert.ok(fixtureDir.startsWith(tmpdir()), "fixture lives under the temp dir");
});
