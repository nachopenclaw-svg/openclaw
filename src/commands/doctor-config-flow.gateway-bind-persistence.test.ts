// Verifies Doctor persists legacy gateway bind repairs through the real config writer.
import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../config/config.js";
import { withTempHome, writeOpenClawConfig } from "../config/test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runInitialConfigWriteHealth } from "../flows/doctor-health-contribution-runners.config.js";
import type { DoctorHealthFlowContext } from "../flows/doctor-health-contribution-types.js";
import type { RuntimeEnv } from "../runtime.js";
import { createDoctorPrompter, type DoctorOptions } from "./doctor-prompter.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_GATEWAY } from "./doctor/shared/legacy-config-migrations.runtime.gateway.js";

describe("Doctor gateway bind persistence", () => {
  it.each([
    ["localhost", "loopback"],
    ["0.0.0.0", "lan"],
  ] as const)("persists gateway bind %s as %s", async (legacyBind, canonicalBind) => {
    await withTempHome(async (home) => {
      const authoredConfig = { gateway: { mode: "local", bind: legacyBind } };
      const configPath = await writeOpenClawConfig(home, authoredConfig);
      const migratedConfig = structuredClone(authoredConfig) as Record<string, unknown>;
      const changes: string[] = [];
      for (const migration of LEGACY_CONFIG_MIGRATIONS_RUNTIME_GATEWAY) {
        migration.apply(migratedConfig, changes);
      }
      const cfg = migratedConfig as OpenClawConfig;
      const runtime: RuntimeEnv = {
        error: vi.fn(),
        exit: vi.fn(),
        log: vi.fn(),
      };
      const options: DoctorOptions = { nonInteractive: true, repair: true };
      const prompter = createDoctorPrompter({ runtime, options });
      const ctx: DoctorHealthFlowContext = {
        runtime,
        options,
        prompter,
        configResult: { cfg, shouldWriteConfig: true, sourceConfigValid: true },
        cfg,
        cfgForPersistence: structuredClone(cfg),
        sourceConfigValid: true,
        configPath,
        stateDirExistedAtStart: true,
      };

      await runInitialConfigWriteHealth(ctx);

      expect(ctx.configResultWriteCommitted).toBe(true);
      const snapshot = await readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);
      expect(snapshot.config.gateway?.bind).toBe(canonicalBind);
      expect(await fs.readFile(configPath, "utf8")).not.toContain(`"bind": "${legacyBind}"`);
    });
  });
});
