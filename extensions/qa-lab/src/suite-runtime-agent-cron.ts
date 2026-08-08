// Qa Lab plugin module owns suite runtime cron discovery and matching.
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

export type QaCronJob = {
  delivery?: { mode?: string };
  description?: string;
  id?: string;
  name?: string;
  payload?: { kind?: string; message?: string; text?: string; lightContext?: boolean };
  sessionTarget?: string;
  state?: { nextRunAtMs?: number };
};

const MANAGED_DREAMING_CRON_MARKER = "[managed-by=memory-core.short-term-promotion]";
const MANAGED_DREAMING_CRON_NAME = "Memory Dreaming Promotion";
const MANAGED_DREAMING_PROMPT = "__openclaw_memory_core_short_term_promotion_dream__";

export async function listCronJobs(env: Pick<QaSuiteRuntimeEnv, "gateway">) {
  const payload = (await env.gateway.call(
    "cron.list",
    {
      includeDisabled: true,
      limit: 200,
      sortBy: "name",
      sortDir: "asc",
    },
    { timeoutMs: 30_000 },
  )) as {
    jobs?: QaCronJob[];
  };
  return payload.jobs ?? [];
}

function isManagedDreamingCronJob(job: QaCronJob) {
  if (job.description?.includes(MANAGED_DREAMING_CRON_MARKER)) {
    return true;
  }
  if (job.name !== MANAGED_DREAMING_CRON_NAME) {
    return false;
  }
  if (job.payload?.kind === "systemEvent" && job.payload.text === MANAGED_DREAMING_PROMPT) {
    return true;
  }
  return (
    job.payload?.kind === "agentTurn" &&
    job.payload.message === MANAGED_DREAMING_PROMPT &&
    job.payload.lightContext === true &&
    job.sessionTarget === "isolated" &&
    job.delivery?.mode === "none"
  );
}

export function findManagedDreamingCronJob(jobs: readonly QaCronJob[]) {
  return jobs.find(isManagedDreamingCronJob);
}
