// Verifies Doctor persists legacy gateway bind repairs through the real config writer.
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../config/config.js";
import { withTempHome, writeOpenClawConfig } from "../config/test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runInitialConfigWriteHealth } from "../flows/doctor-health-contribution-runners.config.js";
import type { DoctorHealthFlowContext } from "../flows/doctor-health-contribution-types.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createDoctorPrompter, type DoctorOptions } from "./doctor-prompter.js";
import { normalizeCompatibilityConfigValues } from "./doctor/shared/legacy-config-core-migrate.js";
import { migrateLegacyConfig } from "./doctor/shared/legacy-config-migrate.js";

describe("Doctor gateway bind persistence", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it.each([
    ["localhost", "loopback"],
    ["0.0.0.0", "lan"],
  ] as const)("persists gateway bind %s as %s", async (legacyBind, canonicalBind) => {
    await withTempHome(async (home) => {
      const originalConfig = {
        gateway: { mode: "local", bind: legacyBind },
      } as unknown as OpenClawConfig;
      const configPath = await writeOpenClawConfig(home, originalConfig);
      const legacyMigration = migrateLegacyConfig(originalConfig);
      if (!legacyMigration.config) {
        throw new Error("expected legacy gateway bind migration");
      }
      const migrated = normalizeCompatibilityConfigValues(legacyMigration.config, {
        sourceRaw: originalConfig,
      });
      expect(migrated.config.gateway?.bind).toBe(canonicalBind);
      expect([...legacyMigration.changes, ...migrated.changes]).toContain(
        `Normalized gateway.bind "${legacyBind}" → "${canonicalBind}".`,
      );

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
        configResult: { cfg: migrated.config, shouldWriteConfig: true },
        cfg: migrated.config,
        cfgForPersistence: originalConfig,
        sourceConfigValid: true,
        configPath,
      };

      await runInitialConfigWriteHealth(ctx);

      const snapshot = await readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);
      expect(snapshot.config.gateway?.bind).toBe(canonicalBind);
      expect(await fs.readFile(configPath, "utf-8")).not.toContain(`"bind": "${legacyBind}"`);
    });
  });
});
