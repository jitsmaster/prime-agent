#!/usr/bin/env node
// Adds "prime-agent" to an installed Orca app as a supported TUI agent.
//
// The installed Orca release is a compiled Electron bundle, and its supported
// agent list is hardcoded across several compiled artifacts (shared config,
// main-process chunk, renderer store + catalog, relay bundles for remote
// hosts, and the main-process pi machinery). This script patches all of them.
//
// It never repacks app.asar: it converts the app to the directory-app layout
// (backup app.asar, extract to Resources/app), which is the standard safe way
// to patch an asar-based Electron app without risking a broken repack.
//
// STOPGAP: the durable fix is upstream. stablyai/orca main already ships most
// prime-agent support and the completion PR lands the rest, so once an Orca
// release with native support is installed this script is unnecessary (run
// --restore to revert to the original asar layout). Until then, Orca updates
// replace the whole .app and the patch must be re-applied after each update.
//
// Prerequisites:
//   - Node >= 22 on PATH, plus network access on first run (npx downloads
//     @electron/asar for extraction).
//   - The prime-agent CLI on PATH (detection matches the `prime-agent` binary;
//     build this repo and symlink packages/coding-agent/dist/bundle/cli.js).
//   - The patch is pinned to the Orca 1.4.164 compiled layout. Other versions
//     fail fast with "anchor not found" instead of silently mis-patching.
//
// After patching: quit and relaunch Orca, then pick "Prime Agent" from the
// agent picker. The prefill/status extensions are written into
// ~/.prime/agent/extensions/ by the patched app at launch time.
//
// Note: the directory-app layout breaks the app's macOS code-signature seal.
// This is local-only (same as any user-writable /Applications bundle) and is
// fully reverted by --restore.
//
// Usage:
//   node scripts/orca-add-prime-agent.mjs --app /Applications/Orca.app
//   node scripts/orca-add-prime-agent.mjs --tree /path/to/extracted/tree
//   node scripts/orca-add-prime-agent.mjs --restore --app /Applications/Orca.app
//
// Re-runnable: every patch is idempotent (skips files already patched).
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_APP = "/Applications/Orca.app";
const ASAR_BACKUP_SUFFIX = ".bak-prime-agent";

const CONFIG_ENTRY_SINGLE_QUOTE = [
  "    'prime-agent': {",
  "        detectCmd: 'prime-agent',",
  "        launchCmd: 'prime-agent',",
  "        expectedProcess: 'prime-agent',",
  "        promptInjectionMode: 'argv',",
  "        draftPromptEnvVar: 'ORCA_PRIME_AGENT_PREFILL'",
  "    },",
].join("\n");

const CONFIG_ENTRY_DOUBLE_QUOTE = [
  '\t"prime-agent": {',
  '\t\tdetectCmd: "prime-agent",',
  '\t\tlaunchCmd: "prime-agent",',
  '\t\texpectedProcess: "prime-agent",',
  '\t\tpromptInjectionMode: "argv",',
  '\t\tdraftPromptEnvVar: "ORCA_PRIME_AGENT_PREFILL"',
  "\t},",
].join("\n");

// ops: [relativePath, [{anchor, insert, mode}...]]
const PATCHES = [
  // 1. TUI agent config — shared (single quotes, 4-space indent).
  [
    "out/shared/tui-agent-config.js",
    [
      {
        anchor: "        draftPromptEnvVar: 'ORCA_PI_PREFILL'\n    },",
        insert: `\n${CONFIG_ENTRY_SINGLE_QUOTE}`,
        mode: "after",
      },
    ],
  ],
  // 2. TUI agent config — main-process chunk (double quotes, tab indent).
  [
    "out/main/chunks/tui-agent-config-x5jBLMn6.js",
    [
      {
        anchor: '\t\tdraftPromptEnvVar: "ORCA_PI_PREFILL"\n\t},',
        insert: `\n${CONFIG_ENTRY_DOUBLE_QUOTE}`,
        mode: "after",
      },
    ],
  ],
  // 3. TUI agent config — renderer + web store chunks (double-quote shape).
  [
    "out/renderer/assets/store-BgJxB0hr.js",
    [
      {
        anchor: '\t\tdraftPromptEnvVar: "ORCA_PI_PREFILL"\n\t},',
        insert: `\n${CONFIG_ENTRY_DOUBLE_QUOTE}`,
        mode: "after",
      },
    ],
  ],
  [
    "out/web/assets/store-BgJxB0hr.js",
    [
      {
        anchor:
          'pi:{detectCmd:"pi",launchCmd:"pi",expectedProcess:"pi",promptInjectionMode:"argv",draftPromptEnvVar:"ORCA_PI_PREFILL"}',
        insert:
          '"prime-agent":{detectCmd:"prime-agent",launchCmd:"prime-agent",expectedProcess:"prime-agent",promptInjectionMode:"argv",draftPromptEnvVar:"ORCA_PRIME_AGENT_PREFILL"},',
        mode: "before",
      },
    ],
  ],
  // 4. Display names (shared) — feeds the picker + ALL_TUI_AGENTS.
  [
    "out/shared/tui-agent-display-names.js",
    [
      {
        anchor: "    pi: 'Pi',",
        insert: "\n    'prime-agent': 'Prime Agent',",
        mode: "after",
      },
    ],
  ],
  // 5. Telemetry kind mapping (shared).
  [
    "out/shared/agent-kind.js",
    [
      {
        anchor: "    pi: 'pi',",
        insert: "\n    'prime-agent': 'prime-agent',",
        mode: "after",
      },
    ],
  ],
  // 6. Synthetic title profiles (shared) — working/idle labels + pi-compatible group.
  [
    "out/shared/synthetic-agent-title.js",
    [
      {
        anchor: "        idleLabel: 'Pi ready',\n        titleIdentityGroup: 'pi-compatible'\n    },",
        insert:
          "\n    'prime-agent': {\n        workingLabel: 'Prime Agent',\n        permissionLabel: 'Prime Agent - action required',\n        idleLabel: 'Prime Agent ready',\n        titleIdentityGroup: 'pi-compatible'\n    },",
        mode: "after",
      },
    ],
  ],
  // 6b. Synthetic title profiles — main-process chunk + renderer/web
  // title-owner chunks bundle their OWN inline copies; without them the
  // renderer cannot normalize a prime-agent pane's pi-compatible title to
  // the "Prime Agent" label and falls back to "Pi".
  [
    "out/main/chunks/daemon-ready-identity-ChMsnp5C.js",
    [
      {
        anchor:
          'pi: {\n\t\tworkingLabel: "Pi",\n\t\tpermissionLabel: "Pi - action required",\n\t\tidleLabel: "Pi ready",\n\t\ttitleIdentityGroup: "pi-compatible"\n\t},',
        insert:
          '\n\t\'prime-agent\': {\n\t\tworkingLabel: "Prime Agent",\n\t\tpermissionLabel: "Prime Agent - action required",\n\t\tidleLabel: "Prime Agent ready",\n\t\ttitleIdentityGroup: "pi-compatible"\n\t},',
        mode: "after",
      },
    ],
  ],
  [
    "out/renderer/assets/agent-title-owner-_bbo0lTs.js",
    [
      {
        anchor:
          'pi: {\n\t\tworkingLabel: "Pi",\n\t\tpermissionLabel: "Pi - action required",\n\t\tidleLabel: "Pi ready",\n\t\ttitleIdentityGroup: "pi-compatible"\n\t},',
        insert:
          '\n\t\'prime-agent\': {\n\t\tworkingLabel: "Prime Agent",\n\t\tpermissionLabel: "Prime Agent - action required",\n\t\tidleLabel: "Prime Agent ready",\n\t\ttitleIdentityGroup: "pi-compatible"\n\t},',
        mode: "after",
      },
    ],
  ],
  [
    "out/web/assets/agent-title-owner-_bbo0lTs.js",
    [
      {
        anchor:
          'pi:{workingLabel:"Pi",permissionLabel:"Pi - action required",idleLabel:"Pi ready",titleIdentityGroup:"pi-compatible"}',
        insert:
          '"prime-agent":{workingLabel:"Prime Agent",permissionLabel:"Prime Agent - action required",idleLabel:"Prime Agent ready",titleIdentityGroup:"pi-compatible"},',
        mode: "before",
      },
    ],
  ],
  // 7. Renderer + web agent catalog (UI picker entry; web copy is minified).
  [
    "out/renderer/assets/agent-catalog-1Y3pTpm8.js",
    [
      {
        anchor: '\t\thomepageUrl: "https://pi.dev"\n\t},',
        insert:
          '\n\t{\n\t\tid: "prime-agent",\n\t\tlabel: translate("auto.lib.agent.catalog.prime_agent_label", "Prime Agent"),\n\t\tcmd: "prime-agent",\n\t\thomepageUrl: "https://github.com/PrimeIntellect-ai/prime-agent"\n\t},',
        mode: "after",
      },
    ],
  ],
  [
    "out/web/assets/agent-catalog-1Y3pTpm8.js",
    [
      {
        anchor: '{id:"pi",label:e("auto.lib.agent.catalog.302934c5d9","Pi"),cmd:"pi",homepageUrl:"https://pi.dev"}',
        insert:
          '{id:"prime-agent",label:e("auto.lib.agent.catalog.prime_agent_label","Prime Agent"),cmd:"prime-agent",homepageUrl:"https://github.com/PrimeIntellect-ai/prime-agent"},',
        mode: "before",
      },
    ],
  ],
  // 8. Relay bundles (remote hosts): config entry + title profile, minified.
  ...[
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-arm64",
    "win32-x64",
  ].flatMap((platform) => [
    [
      `out/relay/${platform}/relay.js`,
      [
        {
          anchor:
            'pi:{detectCmd:"pi",launchCmd:"pi",expectedProcess:"pi",promptInjectionMode:"argv",draftPromptEnvVar:"ORCA_PI_PREFILL"}',
          insert:
            '"prime-agent":{detectCmd:"prime-agent",launchCmd:"prime-agent",expectedProcess:"prime-agent",promptInjectionMode:"argv",draftPromptEnvVar:"ORCA_PRIME_AGENT_PREFILL"},',
          mode: "before",
        },
        {
          anchor:
            'pi:{workingLabel:"Pi",permissionLabel:"Pi - action required",idleLabel:"Pi ready",titleIdentityGroup:"pi-compatible"}',
          insert:
            '"prime-agent":{workingLabel:"Prime Agent",permissionLabel:"Prime Agent - action required",idleLabel:"Prime Agent ready",titleIdentityGroup:"pi-compatible"},',
          mode: "before",
        },
      ],
    ],
  ]),
  // 9. Main process (out/main/index.js) — the pi machinery, prime-agent aware.
  [
    "out/main/index.js",
    [
      {
        anchor: `var PREFILL_ENV_VAR_BY_KIND = {
	pi: "ORCA_PI_PREFILL",
	omp: "ORCA_OMP_PREFILL"
};`,
        insert: `var PREFILL_ENV_VAR_BY_KIND = {
	pi: "ORCA_PI_PREFILL",
	omp: "ORCA_OMP_PREFILL",
	'prime-agent': "ORCA_PRIME_AGENT_PREFILL"
};`,
        mode: "replace",
      },
      {
        anchor: `var OVERLAY_ROOT_DIR_NAME = {
	pi: "pi-agent-overlays",
	omp: "omp-agent-overlays"
};`,
        insert: `var OVERLAY_ROOT_DIR_NAME = {
	pi: "pi-agent-overlays",
	omp: "omp-agent-overlays",
	'prime-agent': "prime-agent-overlays"
};`,
        mode: "replace",
      },
      {
        anchor: `var AGENT_HOME_DIR_NAME = {
	pi: ".pi",
	omp: ".omp"
};`,
        insert: `var AGENT_HOME_DIR_NAME = {
	pi: ".pi",
	omp: ".omp",
	'prime-agent': ".prime"
};`,
        mode: "replace",
      },
      {
        anchor: '	return agentType === "pi" || agentType === "omp";',
        insert: '	return agentType === "pi" || agentType === "omp" || agentType === "prime-agent";',
        mode: "replace",
      },
      {
        anchor: `var PI_LAUNCH_BINARY = getLaunchBinary(require_tui_agent_config.TUI_AGENT_CONFIG.pi.launchCmd);
var OMP_LAUNCH_BINARY = getLaunchBinary(require_tui_agent_config.TUI_AGENT_CONFIG.omp.launchCmd);`,
        insert: `var PI_LAUNCH_BINARY = getLaunchBinary(require_tui_agent_config.TUI_AGENT_CONFIG.pi.launchCmd);
var OMP_LAUNCH_BINARY = getLaunchBinary(require_tui_agent_config.TUI_AGENT_CONFIG.omp.launchCmd);
var PRIME_AGENT_LAUNCH_BINARY = getLaunchBinary(require_tui_agent_config.TUI_AGENT_CONFIG["prime-agent"].launchCmd);`,
        mode: "replace",
      },
      {
        anchor: `	if (binary === OMP_LAUNCH_BINARY) return "omp";
	return binary === PI_LAUNCH_BINARY ? "pi" : null;`,
        insert: `	if (binary === PRIME_AGENT_LAUNCH_BINARY) return "prime-agent";
	if (binary === OMP_LAUNCH_BINARY) return "omp";
	return binary === PI_LAUNCH_BINARY ? "pi" : null;`,
        mode: "replace",
      },
      {
        anchor: '		} else env.ORCA_PI_SOURCE_AGENT_DIR = installed.sourceAgentDir;',
        insert:
          '		} else if (kind === "prime-agent") env.ORCA_PRIME_AGENT_SOURCE_AGENT_DIR = installed.sourceAgentDir;\n		else env.ORCA_PI_SOURCE_AGENT_DIR = installed.sourceAgentDir;',
        mode: "replace",
      },
      {
        anchor: `function clearPiAgentShadowEnv(baseEnv, kind) {
	if (kind === "omp") {
		delete baseEnv.ORCA_OMP_CODING_AGENT_DIR;
		delete baseEnv.ORCA_OMP_SOURCE_AGENT_DIR;
		delete baseEnv.ORCA_OMP_STATUS_EXTENSION;
		return;
	}
	delete baseEnv.ORCA_PI_CODING_AGENT_DIR;
	delete baseEnv.ORCA_PI_SOURCE_AGENT_DIR;
}`,
        insert: `function clearPiAgentShadowEnv(baseEnv, kind) {
	if (kind === "omp") {
		delete baseEnv.ORCA_OMP_CODING_AGENT_DIR;
		delete baseEnv.ORCA_OMP_SOURCE_AGENT_DIR;
		delete baseEnv.ORCA_OMP_STATUS_EXTENSION;
		return;
	}
	if (kind === "prime-agent") {
		delete baseEnv.ORCA_PRIME_AGENT_CODING_AGENT_DIR;
		delete baseEnv.ORCA_PRIME_AGENT_SOURCE_AGENT_DIR;
		return;
	}
	delete baseEnv.ORCA_PI_CODING_AGENT_DIR;
	delete baseEnv.ORCA_PI_SOURCE_AGENT_DIR;
}`,
        mode: "replace",
      },
      {
        anchor: `function resolvePiAgentSourceDir(baseEnv, kind) {
	const sourceKey = kind === "omp" ? "ORCA_OMP_SOURCE_AGENT_DIR" : "ORCA_PI_SOURCE_AGENT_DIR";
	const overlayKey = kind === "omp" ? "ORCA_OMP_CODING_AGENT_DIR" : "ORCA_PI_CODING_AGENT_DIR";
	const otherOverlayKey = kind === "omp" ? "ORCA_PI_CODING_AGENT_DIR" : "ORCA_OMP_CODING_AGENT_DIR";
	const sourceDir = readEnvWithProcessFallback(baseEnv, sourceKey);
	if (sourceDir) return sourceDir;
	const publicDir = readEnvWithProcessFallback(baseEnv, "PI_CODING_AGENT_DIR");
	const ownOverlayDir = readEnvWithProcessFallback(baseEnv, overlayKey);
	const otherOverlayDir = readEnvWithProcessFallback(baseEnv, otherOverlayKey);
	if (publicDir && publicDir !== ownOverlayDir && publicDir !== otherOverlayDir) return publicDir;
	return readShellStartupEnvVar("PI_CODING_AGENT_DIR", baseEnv.HOME ?? process.env.HOME, baseEnv.SHELL ?? process.env.SHELL);
}`,
        insert: `function resolvePiAgentSourceDir(baseEnv, kind) {
	const sourceKey = kind === "omp" ? "ORCA_OMP_SOURCE_AGENT_DIR" : kind === "prime-agent" ? "ORCA_PRIME_AGENT_SOURCE_AGENT_DIR" : "ORCA_PI_SOURCE_AGENT_DIR";
	const overlayKey = kind === "omp" ? "ORCA_OMP_CODING_AGENT_DIR" : kind === "prime-agent" ? "ORCA_PRIME_AGENT_CODING_AGENT_DIR" : "ORCA_PI_CODING_AGENT_DIR";
	const otherOverlayKey = kind === "omp" ? "ORCA_PI_CODING_AGENT_DIR" : kind === "prime-agent" ? "ORCA_PI_CODING_AGENT_DIR" : "ORCA_OMP_CODING_AGENT_DIR";
	const sourceDir = readEnvWithProcessFallback(baseEnv, sourceKey);
	if (sourceDir) return sourceDir;
	const publicDir = readEnvWithProcessFallback(baseEnv, kind === "prime-agent" ? "PRIME_AGENT_CODING_AGENT_DIR" : "PI_CODING_AGENT_DIR");
	const ownOverlayDir = readEnvWithProcessFallback(baseEnv, overlayKey);
	const otherOverlayDir = readEnvWithProcessFallback(baseEnv, otherOverlayKey);
	if (publicDir && publicDir !== ownOverlayDir && publicDir !== otherOverlayDir) return publicDir;
	return readShellStartupEnvVar(kind === "prime-agent" ? "PRIME_AGENT_CODING_AGENT_DIR" : "PI_CODING_AGENT_DIR", baseEnv.HOME ?? process.env.HOME, baseEnv.SHELL ?? process.env.SHELL);
}`,
        mode: "replace",
      },
      {
        anchor: `function resolveScopedPiAgentSourceDir(baseEnv, kind) {
	return readEnvWithProcessFallback(baseEnv, kind === "omp" ? "ORCA_OMP_SOURCE_AGENT_DIR" : "ORCA_PI_SOURCE_AGENT_DIR");
}`,
        insert: `function resolveScopedPiAgentSourceDir(baseEnv, kind) {
	return readEnvWithProcessFallback(baseEnv, kind === "omp" ? "ORCA_OMP_SOURCE_AGENT_DIR" : kind === "prime-agent" ? "ORCA_PRIME_AGENT_SOURCE_AGENT_DIR" : "ORCA_PI_SOURCE_AGENT_DIR");
}`,
        mode: "replace",
      },
      {
        anchor: `function exposePiManagedExtensionEnv(baseEnv, kind, managedEnv) {
	if (kind === "omp") {
		delete baseEnv.ORCA_OMP_CODING_AGENT_DIR;
		if (managedEnv.ORCA_OMP_SOURCE_AGENT_DIR) baseEnv.ORCA_OMP_SOURCE_AGENT_DIR = managedEnv.ORCA_OMP_SOURCE_AGENT_DIR;
		else delete baseEnv.ORCA_OMP_SOURCE_AGENT_DIR;
		if (managedEnv.ORCA_OMP_STATUS_EXTENSION) baseEnv.ORCA_OMP_STATUS_EXTENSION = managedEnv.ORCA_OMP_STATUS_EXTENSION;
		else delete baseEnv.ORCA_OMP_STATUS_EXTENSION;
		return;
	}
	delete baseEnv.ORCA_PI_CODING_AGENT_DIR;
	if (managedEnv.ORCA_PI_SOURCE_AGENT_DIR) baseEnv.ORCA_PI_SOURCE_AGENT_DIR = managedEnv.ORCA_PI_SOURCE_AGENT_DIR;
	else delete baseEnv.ORCA_PI_SOURCE_AGENT_DIR;
}`,
        insert: `function exposePiManagedExtensionEnv(baseEnv, kind, managedEnv) {
	if (kind === "omp") {
		delete baseEnv.ORCA_OMP_CODING_AGENT_DIR;
		if (managedEnv.ORCA_OMP_SOURCE_AGENT_DIR) baseEnv.ORCA_OMP_SOURCE_AGENT_DIR = managedEnv.ORCA_OMP_SOURCE_AGENT_DIR;
		else delete baseEnv.ORCA_OMP_SOURCE_AGENT_DIR;
		if (managedEnv.ORCA_OMP_STATUS_EXTENSION) baseEnv.ORCA_OMP_STATUS_EXTENSION = managedEnv.ORCA_OMP_STATUS_EXTENSION;
		else delete baseEnv.ORCA_OMP_STATUS_EXTENSION;
		return;
	}
	if (kind === "prime-agent") {
		delete baseEnv.ORCA_PRIME_AGENT_CODING_AGENT_DIR;
		if (managedEnv.ORCA_PRIME_AGENT_SOURCE_AGENT_DIR) baseEnv.ORCA_PRIME_AGENT_SOURCE_AGENT_DIR = managedEnv.ORCA_PRIME_AGENT_SOURCE_AGENT_DIR;
		else delete baseEnv.ORCA_PRIME_AGENT_SOURCE_AGENT_DIR;
		return;
	}
	delete baseEnv.ORCA_PI_CODING_AGENT_DIR;
	if (managedEnv.ORCA_PI_SOURCE_AGENT_DIR) baseEnv.ORCA_PI_SOURCE_AGENT_DIR = managedEnv.ORCA_PI_SOURCE_AGENT_DIR;
	else delete baseEnv.ORCA_PI_SOURCE_AGENT_DIR;
}`,
        mode: "replace",
      },
      {
        anchor: '	const shouldPrepareOmpShadow = piAgentKind === "omp" || !hasLaunchCommand;',
        insert:
          '	const shouldPrepareOmpShadow = piAgentKind === "omp" || !hasLaunchCommand;\n	const shouldPreparePrimeAgentShadow = piAgentKind === "prime-agent" || !hasLaunchCommand;',
        mode: "replace",
      },
      {
        anchor:
          '	const preexistingOmpAgentDir = piAgentKind === "omp" ? resolvePiAgentSourceDir(baseEnv, "omp") : resolveScopedPiAgentSourceDir(baseEnv, "omp");',
        insert:
          '	const preexistingOmpAgentDir = piAgentKind === "omp" ? resolvePiAgentSourceDir(baseEnv, "omp") : resolveScopedPiAgentSourceDir(baseEnv, "omp");\n	const preexistingPrimeAgentDir = piAgentKind === "prime-agent" ? resolvePiAgentSourceDir(baseEnv, "prime-agent") : resolveScopedPiAgentSourceDir(baseEnv, "prime-agent");',
        mode: "replace",
      },
      {
        anchor: `		clearPiAgentShadowEnv(baseEnv, "pi");
		clearPiAgentShadowEnv(baseEnv, "omp");`,
        insert: `		clearPiAgentShadowEnv(baseEnv, "pi");
		clearPiAgentShadowEnv(baseEnv, "omp");
		clearPiAgentShadowEnv(baseEnv, "prime-agent");`,
        mode: "replace",
      },
      {
        anchor: `		if (shouldPrepareOmpShadow) {
			const ompEnv = piTitlebarExtensionService.buildPtyEnv(id, preexistingOmpAgentDir, "omp", { materializeDefaultHome: explicitPiAgentKind === "omp" });
			Object.assign(baseEnv, ompEnv);
			exposePiManagedExtensionEnv(baseEnv, "omp", ompEnv);
		}`,
        insert: `		if (shouldPrepareOmpShadow) {
			const ompEnv = piTitlebarExtensionService.buildPtyEnv(id, preexistingOmpAgentDir, "omp", { materializeDefaultHome: explicitPiAgentKind === "omp" });
			Object.assign(baseEnv, ompEnv);
			exposePiManagedExtensionEnv(baseEnv, "omp", ompEnv);
		}
		if (shouldPreparePrimeAgentShadow) {
			const primeAgentEnv = piTitlebarExtensionService.buildPtyEnv(id, preexistingPrimeAgentDir, "prime-agent", { materializeDefaultHome: explicitPiAgentKind === "prime-agent" });
			Object.assign(baseEnv, primeAgentEnv);
			exposePiManagedExtensionEnv(baseEnv, "prime-agent", primeAgentEnv);
		}`,
        mode: "replace",
      },
      {
        anchor: `		restoreOrStripOverlayEnv(baseEnv, {
			primary: "PI_CODING_AGENT_DIR",
			overlay: "ORCA_OMP_CODING_AGENT_DIR",
			source: "ORCA_OMP_SOURCE_AGENT_DIR"
		});
		delete baseEnv.ORCA_OMP_STATUS_EXTENSION;`,
        insert: `		restoreOrStripOverlayEnv(baseEnv, {
			primary: "PI_CODING_AGENT_DIR",
			overlay: "ORCA_OMP_CODING_AGENT_DIR",
			source: "ORCA_OMP_SOURCE_AGENT_DIR"
		});
		restoreOrStripOverlayEnv(baseEnv, {
			primary: "PRIME_AGENT_CODING_AGENT_DIR",
			overlay: "ORCA_PRIME_AGENT_CODING_AGENT_DIR",
			source: "ORCA_PRIME_AGENT_SOURCE_AGENT_DIR"
		});
		delete baseEnv.ORCA_OMP_STATUS_EXTENSION;`,
        mode: "replace",
      },
      {
        anchor:
          '		source$1("home-omp", "OMP home", pathApi.join(home, ".omp", "agent", "skills"), "home", ["agent-skills"], "omp"),',
        insert:
          '		source$1("home-omp", "OMP home", pathApi.join(home, ".omp", "agent", "skills"), "home", ["agent-skills"], "omp"),\n		source$1("home-prime-agent", "Prime Agent home", pathApi.join(home, ".prime", "agent", "skills"), "home", ["agent-skills"], "prime-agent"),',
        mode: "replace",
      },
      {
        anchor:
          '	const configVar = agentId === "opencode" ? "OPENCODE_CONFIG_DIR" : agentId === "pi" || agentId === "omp" ? "PI_CODING_AGENT_DIR" : null;',
        insert:
          '	const configVar = agentId === "opencode" ? "OPENCODE_CONFIG_DIR" : agentId === "pi" || agentId === "omp" || agentId === "prime-agent" ? agentId === "prime-agent" ? "PRIME_AGENT_CODING_AGENT_DIR" : "PI_CODING_AGENT_DIR" : null;',
        mode: "replace",
      },
      {
        anchor:
          '	const value = readInheritedOrShellEnvVar(configVar, agentId === "opencode" ? "ORCA_OPENCODE_SOURCE_CONFIG_DIR" : agentId === "pi" ? "ORCA_PI_SOURCE_AGENT_DIR" : agentId === "omp" ? "ORCA_OMP_SOURCE_AGENT_DIR" : void 0);',
        insert:
          '	const value = readInheritedOrShellEnvVar(configVar, agentId === "opencode" ? "ORCA_OPENCODE_SOURCE_CONFIG_DIR" : agentId === "pi" ? "ORCA_PI_SOURCE_AGENT_DIR" : agentId === "omp" ? "ORCA_OMP_SOURCE_AGENT_DIR" : agentId === "prime-agent" ? "ORCA_PRIME_AGENT_SOURCE_AGENT_DIR" : void 0);',
        mode: "replace",
      },
      {
        anchor:
          'var PI_SESSIONS_DIR = require_session_scanner_opencode_sqlite_list.normalizeAgentSessionsDir(process.env.PI_CODING_AGENT_DIR?.trim() || (0, node_path.join)((0, node_os.homedir)(), ".pi", "agent", "sessions"), ".pi");',
        insert:
          'var PI_SESSIONS_DIR = require_session_scanner_opencode_sqlite_list.normalizeAgentSessionsDir(process.env.PI_CODING_AGENT_DIR?.trim() || (0, node_path.join)((0, node_os.homedir)(), ".pi", "agent", "sessions"), ".pi");\nvar PRIME_AGENT_SESSIONS_DIR = require_session_scanner_opencode_sqlite_list.normalizeAgentSessionsDir(process.env.PRIME_AGENT_CODING_AGENT_DIR?.trim() || (0, node_path.join)((0, node_os.homedir)(), ".prime", "agent", "sessions"), ".prime");',
        mode: "replace",
      },
      {
        anchor: `function piDiscoveries(options$1, wslHomeDirs, limit, issues) {
	return sessionRootDirs(options$1.piSessionsDir ?? PI_SESSIONS_DIR, wslHomeDirs, [
		".pi",
		"agent",
		"sessions"
	]).map((rootDir) => discoverFiles({
		rootDir,
		limit,
		agent: "pi",
		issues,
		extensions: [".jsonl"]
	}));
}`,
        insert: `function piDiscoveries(options$1, wslHomeDirs, limit, issues) {
	return sessionRootDirs(options$1.piSessionsDir ?? PI_SESSIONS_DIR, wslHomeDirs, [
		".pi",
		"agent",
		"sessions"
	]).map((rootDir) => discoverFiles({
		rootDir,
		limit,
		agent: "pi",
		issues,
		extensions: [".jsonl"]
	}));
}
function primeAgentDiscoveries(options$1, wslHomeDirs, limit, issues) {
	return sessionRootDirs(options$1.primeAgentSessionsDir ?? PRIME_AGENT_SESSIONS_DIR, wslHomeDirs, [
		".prime",
		"agent",
		"sessions"
	]).map((rootDir) => discoverFiles({
		rootDir,
		limit,
		agent: "prime-agent",
		issues,
		extensions: [".jsonl"]
	}));
}`,
        mode: "replace",
      },
      {
        anchor: `		...piDiscoveries(options$1, wslHomeDirs, limit, issues),
		...ompDiscoveries(options$1, wslHomeDirs, limit, issues)
	];`,
        insert: `		...piDiscoveries(options$1, wslHomeDirs, limit, issues),
		...primeAgentDiscoveries(options$1, wslHomeDirs, limit, issues),
		...ompDiscoveries(options$1, wslHomeDirs, limit, issues)
	];`,
        mode: "replace",
      },
    ],
  ],
];

// ---------------------------------------------------------------------------
// Patching
// ---------------------------------------------------------------------------

/** Apply all patches to an extracted app tree (out/ layout). Idempotent. */
export function patchTree(treeRoot) {
  const patched = [];
  const skipped = [];
  for (const [relPath, ops] of PATCHES) {
    const fullPath = join(treeRoot, relPath);
    if (!existsSync(fullPath)) {
      skipped.push(`${relPath} (absent)`);
      continue;
    }
    let src = readFileSync(fullPath, "utf8");
    const pendingOps = ops.filter((op) => !src.includes(op.insert));
    if (pendingOps.length === 0) {
      skipped.push(`${relPath} (already patched)`);
      continue;
    }
    for (const op of pendingOps) {
      const { anchor, insert, mode } = op;
      const idx = src.indexOf(anchor);
      if (idx === -1) {
        throw new Error(`[${relPath}] anchor not found:\n${anchor.slice(0, 200)}`);
      }
      const replacement =
        mode === "replace" ? insert : mode === "before" ? insert + anchor : anchor + insert;
      src = src.replace(anchor, replacement);
    }
    writeFileSync(fullPath, src);
    patched.push(relPath);
  }
  return { patched, skipped };
}

/** Patch the duplicate copies under app.asar.unpacked (spawned CLI processes). */
export function patchUnpackedTree(resourcesDir) {
  const unpacked = join(resourcesDir, "app.asar.unpacked");
  if (!existsSync(unpacked)) return { patched: [], skipped: ["no unpacked dir"] };
  const result = patchTree(unpacked);
  return result;
}

/** Convert the installed app to the directory-app layout and patch it. */
export function patchInstalledApp(appPath) {
  const resources = join(appPath, "Contents", "Resources");
  const asar = join(resources, "app.asar");
  const appDir = join(resources, "app");
  const backup = `${asar}${ASAR_BACKUP_SUFFIX}`;

  if (existsSync(asar) && !existsSync(appDir)) {
    // Extract while app.asar is still named app.asar so the unpacked-files
    // resolution (app.asar.unpacked) works; rename to the backup afterwards.
    console.log(`extracting ${asar} -> ${appDir} (this takes a moment)`);
    const res = spawnSync(
      "npx",
      ["--yes", "@electron/asar", "extract", asar, appDir],
      { encoding: "utf8", timeout: 600_000 },
    );
    if (res.status !== 0) {
      rmSync(appDir, { recursive: true, force: true });
      throw new Error(`asar extract failed: ${res.stderr ?? res.stdout}`);
    }
    console.log(`moving ${asar} -> ${backup}`);
    renameSync(asar, backup);
  } else if (existsSync(asar) && existsSync(appDir)) {
    console.log(`moving ${asar} -> ${backup} (app dir already present)`);
    renameSync(asar, backup);
  }

  if (!existsSync(appDir)) {
    throw new Error(`no app.asar and no extracted app dir under ${resources}`);
  }

  const main = patchTree(appDir);
  console.log(`patched ${main.patched.length} file(s) in ${appDir}`);
  for (const f of main.skipped) console.log(`  skipped: ${f}`);
  const unpacked = patchUnpackedTree(resources);
  console.log(`patched ${unpacked.patched.length} file(s) in app.asar.unpacked`);

  // Syntax-check the highest-risk artifact.
  const indexJs = join(appDir, "out", "main", "index.js");
  if (existsSync(indexJs)) {
    const check = spawnSync(process.execPath, ["--check", indexJs], { encoding: "utf8" });
    if (check.status !== 0) {
      throw new Error(`node --check failed on out/main/index.js:\n${check.stderr}`);
    }
    console.log("node --check out/main/index.js: ok");
  }
  return { appDir, backup };
}

/** Restore the original app.asar layout. */
export function restoreInstalledApp(appPath) {
  const resources = join(appPath, "Contents", "Resources");
  const asar = join(resources, "app.asar");
  const appDir = join(resources, "app");
  const backup = `${asar}${ASAR_BACKUP_SUFFIX}`;
  if (existsSync(appDir)) rmSync(appDir, { recursive: true, force: true });
  if (existsSync(backup) && !existsSync(asar)) renameSync(backup, asar);
  if (existsSync(asar)) console.log("restored app.asar");
  else console.log("nothing to restore");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { app: DEFAULT_APP, tree: null, restore: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--app" && argv[i + 1]) args.app = resolve(argv[++i]);
    else if (arg === "--tree" && argv[i + 1]) args.tree = resolve(argv[++i]);
    else if (arg === "--restore") args.restore = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else {
      console.error(`unknown argument: ${arg}`);
      args.help = true;
    }
  }
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`usage:
  node scripts/orca-add-prime-agent.mjs [--app /Applications/Orca.app]   patch installed app
  node scripts/orca-add-prime-agent.mjs --tree <dir>                     patch an extracted tree
  node scripts/orca-add-prime-agent.mjs --restore [--app ...]            restore app.asar
`);
    process.exit(args.help && !process.argv.includes("--help") && !process.argv.includes("-h") ? 1 : 0);
  }
  try {
    if (args.restore) {
      restoreInstalledApp(args.app);
    } else if (args.tree) {
      const result = patchTree(args.tree);
      console.log(`patched ${result.patched.length}, skipped ${result.skipped.length}`);
      for (const f of result.skipped) console.log(`  skipped: ${f}`);
    } else {
      patchInstalledApp(args.app);
      console.log("done. Quit and relaunch Orca to pick up the change.");
    }
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
