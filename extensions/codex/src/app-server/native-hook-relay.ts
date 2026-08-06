/**
 * Bridges Codex native hook callbacks into OpenClaw's native hook relay so
 * app-server tool events can still run OpenClaw policy and diagnostics.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  embeddedAgentLog,
  registerNativeHookRelay,
  type BeforeToolCallFailureDisposition,
  type EmbeddedRunAttemptParams,
  type NativeHookRelayEvent,
  type NativeHookRelayRegistrationHandle,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { emitTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  addTimerTimeoutGraceMs,
  finiteSecondsToTimerSafeMilliseconds,
} from "openclaw/plugin-sdk/number-runtime";
import type { PluginHookToolContext } from "openclaw/plugin-sdk/types";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { resolveCodexToolAbortTerminalReason } from "./dynamic-tool-execution.js";
import {
  codexNativeHookRelayOwners as codexNativeHookRelayOwnerRegistry,
  nativeHookRelayUnregisterQueue,
} from "./native-hook-relay-state.js";
import type { JsonObject, JsonValue } from "./protocol.js";

/** Codex hook events that can be registered through OpenClaw's native relay. */
export const CODEX_NATIVE_HOOK_RELAY_EVENTS: readonly NativeHookRelayEvent[] = [
  "pre_tool_use",
  "post_tool_use",
  "permission_request",
  "before_agent_finalize",
] as const;

const CODEX_NATIVE_HOOK_RELAY_EVENTS_WITH_APP_SERVER_APPROVALS =
  CODEX_NATIVE_HOOK_RELAY_EVENTS.filter((event) => event !== "permission_request");
const CODEX_NATIVE_HOOK_RELAY_MIN_TTL_MS = 30 * 60_000;
/** Extra relay lifetime after the expected turn budget, preventing late hook drops. */
export const CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS = 5 * 60_000;
const CODEX_NATIVE_HOOK_RELAY_COMMAND_MIN_PARENT_MARGIN_MS = 250;
const CODEX_NATIVE_HOOK_RELAY_COMMAND_MAX_PARENT_MARGIN_MS = 1_000;
// The relay starts a niced Node subprocess, so busy hosts can exceed the former
// five-second relay timeout before policy and task-mirroring work completes.
const CODEX_NATIVE_HOOK_RELAY_DEFAULT_TIMEOUT_SEC = 10;
const CODEX_NATIVE_HOOK_RELAY_UNREGISTER_GRACE_MS = 10_000;
const CODEX_NATIVE_HOOK_RELAY_UNREGISTER_EXTRA_GRACE_MS = 5_000;

const CODEX_HOOK_MATCHER_NAMES_BY_TOOL_ID: Readonly<Record<string, readonly string[]>> = {
  exec: ["Bash", "exec", "exec_command"],
  apply_patch: ["apply_patch", "Write", "Edit"],
  spawn_agent: ["spawn_agent", "Agent"],
};

type CodexHookEventName = "PreToolUse" | "PostToolUse" | "PermissionRequest" | "Stop";

export type CodexNativePreToolUseFailure = {
  toolName: string;
  toolCallId: string;
  disposition: Exclude<BeforeToolCallFailureDisposition, "blocked">;
  durationMs: number;
};

export type CodexNativeHookRelayLease = Omit<
  NativeHookRelayRegistrationHandle,
  "unregister" | "rebindAttempt"
> & {
  acquireChild: (childThreadId: string) => (() => void) | undefined;
  releaseParent: (options?: { delay?: boolean }) => void;
};

type CodexNativeHookRelayParams = {
  options:
    | {
        enabled?: boolean;
        ttlMs?: number;
        gatewayTimeoutMs?: number;
        hookTimeoutSec?: number;
      }
    | undefined;
  generation?: string;
  events: readonly NativeHookRelayEvent[];
  agentId: string | undefined;
  sessionId: string;
  sessionKey: string | undefined;
  config: EmbeddedRunAttemptParams["config"];
  runId: string;
  channelId?: string;
  requester?: NonNullable<PluginHookToolContext["requester"]>;
  approvalContext?: Parameters<typeof registerNativeHookRelay>[0]["approvalContext"];
  attemptTimeoutMs: number;
  startupTimeoutMs: number;
  turnStartTimeoutMs: number;
  loopDetectionPreToolUseRelay: boolean;
  signal: AbortSignal;
  onPreToolUseFailure: (failure: CodexNativePreToolUseFailure) => void | Promise<void>;
};

/** Defers relay unregister so late native hook subprocesses can still resolve. */
function scheduleCodexNativeHookRelayUnregister(params: {
  relay: Pick<NativeHookRelayRegistrationHandle, "unregister">;
  hookTimeoutSec?: number;
  beforeUnregister?: () => void;
}): () => void {
  let pending: { timeout: ReturnType<typeof setTimeout>; unregister: () => void } | undefined;
  const unregister = () => {
    if (!pending) {
      return;
    }
    const current = pending;
    pending = undefined;
    if (!nativeHookRelayUnregisterQueue.delete(current)) {
      return;
    }
    params.beforeUnregister?.();
    params.relay.unregister();
  };
  const timeout = setTimeout(
    unregister,
    resolveCodexNativeHookRelayUnregisterGraceMs(params.hookTimeoutSec),
  );
  pending = { timeout, unregister };
  nativeHookRelayUnregisterQueue.add(pending);
  timeout.unref();
  return () => {
    if (!pending) {
      return;
    }
    const current = pending;
    pending = undefined;
    if (nativeHookRelayUnregisterQueue.delete(current)) {
      clearTimeout(current.timeout);
    }
  };
}

/** Computes the delayed unregister window from Codex's hook timeout. */
function resolveCodexNativeHookRelayUnregisterGraceMs(hookTimeoutSec: number | undefined): number {
  const hookTimeoutMs =
    finiteSecondsToTimerSafeMilliseconds(normalizeHookTimeoutSec(hookTimeoutSec)) ?? 0;
  return Math.max(
    CODEX_NATIVE_HOOK_RELAY_UNREGISTER_GRACE_MS,
    addTimerTimeoutGraceMs(hookTimeoutMs, CODEX_NATIVE_HOOK_RELAY_UNREGISTER_EXTRA_GRACE_MS) ?? 0,
  );
}

/** Records a native pre-tool failure that Codex does not project as a tool item. */
export function emitCodexNativePreToolUseFailureDiagnostic(params: {
  agentId: string | undefined;
  sessionId: string;
  sessionKey: string | undefined;
  runId: string;
  signal?: AbortSignal;
  failure: CodexNativePreToolUseFailure;
  terminalReason?: CodexNativePreToolUseFailure["disposition"];
  sourceTimestampMs?: number;
}): void {
  emitTrustedDiagnosticEvent({
    type: "tool.execution.error",
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    runId: params.runId,
    toolName: params.failure.toolName,
    toolCallId: params.failure.toolCallId,
    durationMs: params.failure.durationMs,
    errorCategory: "before_tool_call",
    terminalReason:
      params.terminalReason ??
      (params.signal?.aborted
        ? resolveCodexToolAbortTerminalReason(params.signal)
        : params.failure.disposition),
    ...(params.sourceTimestampMs !== undefined
      ? { sourceTimestampMs: params.sourceTimestampMs }
      : {}),
  });
}

export function createCodexNativeHookRelay(
  params: CodexNativeHookRelayParams,
): CodexNativeHookRelayLease | undefined {
  if (params.options?.enabled === false) {
    return undefined;
  }
  const generation = params.generation?.trim() || randomUUID();
  const attempt: CodexNativeHookRelayAttempt = { ...params, generation };
  const relayId = buildCodexNativeHookRelayId({
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    generation,
  });
  const adoptedLease = codexNativeHookRelayOwners.get(relayId)?.adoptAttempt(attempt);
  if (adoptedLease) {
    return adoptedLease;
  }
  return new CodexNativeHookRelayRoute(attempt, relayId).handle;
}

function registerCodexNativeHookRelay(
  params: CodexNativeHookRelayAttempt,
  relayId: string,
  options: {
    ttlMs: number;
    signal: AbortSignal;
    onPreToolUseFailure: CodexNativeHookRelayParams["onPreToolUseFailure"];
    allowedEvents?: readonly NativeHookRelayEvent[];
    preToolUseLoopDetection?: boolean;
  },
): NativeHookRelayRegistrationHandle {
  return registerNativeHookRelay({
    provider: "codex",
    relayId,
    generation: params.generation,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...codexNativeHookRelayAttemptBinding(params),
    allowedEvents: options.allowedEvents ?? params.events,
    preToolUseLoopDetection: options.preToolUseLoopDetection ?? params.loopDetectionPreToolUseRelay,
    ttlMs: options.ttlMs,
    signal: options.signal,
    onPreToolUseFailure: options.onPreToolUseFailure,
    command: {
      // Hook relay subprocesses are observational for most tool events; keep
      // them lower priority so they do not compete with the active reply turn.
      nice: 10,
      timeoutMs: params.options?.gatewayTimeoutMs,
    },
  });
}

type CodexNativeHookRelayAttempt = CodexNativeHookRelayParams & { generation: string };

type CodexNativeHookRelayAttemptClaim = {
  readonly attempt: CodexNativeHookRelayAttempt;
  detachAbort: () => void;
};

function codexNativeHookRelayAttemptBinding(attempt: CodexNativeHookRelayAttempt) {
  return {
    runId: attempt.runId,
    ...(attempt.config ? { config: attempt.config } : {}),
    ...(attempt.channelId ? { channelId: attempt.channelId } : {}),
    ...(attempt.requester ? { requester: attempt.requester } : {}),
    ...(attempt.approvalContext ? { approvalContext: attempt.approvalContext } : {}),
  };
}

function resolveCodexNativeHookRelayAttemptTtlMs(attempt: CodexNativeHookRelayAttempt): number {
  return resolveCodexNativeHookRelayTtlMs({
    explicitTtlMs: attempt.options?.ttlMs,
    attemptTimeoutMs: attempt.attemptTimeoutMs,
    startupTimeoutMs: attempt.startupTimeoutMs,
    turnStartTimeoutMs: attempt.turnStartTimeoutMs,
  });
}

class CodexNativeHookRelayRoute {
  readonly handle: CodexNativeHookRelayLease;

  private readonly childThreadIds = new Set<string>();
  private readonly relayId: string;
  private relay: NativeHookRelayRegistrationHandle;
  private readonly lifetimeAbortController = new AbortController();
  private attemptClaim: CodexNativeHookRelayAttemptClaim | undefined;
  private ttlMs: number;
  private hookTimeoutSec: number | undefined;
  private readonly frozenPreToolUseLoopDetection: boolean;
  private renewalTimer: ReturnType<typeof setTimeout> | undefined;
  private cancelPendingUnregister: (() => void) | undefined;
  private released = false;

  constructor(attempt: CodexNativeHookRelayAttempt, relayId: string) {
    this.relayId = relayId;
    this.ttlMs = resolveCodexNativeHookRelayAttemptTtlMs(attempt);
    this.hookTimeoutSec = attempt.options?.hookTimeoutSec;
    this.frozenPreToolUseLoopDetection = attempt.loopDetectionPreToolUseRelay;
    this.relay = registerCodexNativeHookRelay(attempt, relayId, {
      ttlMs: this.ttlMs,
      signal: this.lifetimeAbortController.signal,
      onPreToolUseFailure: (failure) =>
        this.reportUnclaimedPreToolUseFailure(attempt.runId, failure),
    });
    codexNativeHookRelayOwners.set(relayId, this);
    this.handle = this.bindAttempt(attempt);
    embeddedAgentLog.debug("Codex native hook relay route registered", {
      relayId,
      generation: attempt.generation,
      runId: attempt.runId,
    });
  }

  adoptAttempt(attempt: CodexNativeHookRelayAttempt): CodexNativeHookRelayLease | undefined {
    if (this.released) {
      return undefined;
    }
    this.cancelPendingUnregister?.();
    this.cancelPendingUnregister = undefined;
    this.retireAttemptClaim();
    const lease = this.bindAttempt(attempt);
    embeddedAgentLog.debug("Codex native hook relay attempt adopted", {
      relayId: this.relayId,
      runId: attempt.runId,
      childCount: this.childThreadIds.size,
    });
    this.renew(this.ttlMs);
    return lease;
  }

  private bindAttempt(attempt: CodexNativeHookRelayAttempt): CodexNativeHookRelayLease {
    this.ttlMs = resolveCodexNativeHookRelayAttemptTtlMs(attempt);
    this.hookTimeoutSec = attempt.options?.hookTimeoutSec;
    const claim: CodexNativeHookRelayAttemptClaim = { attempt, detachAbort: () => undefined };
    this.attemptClaim = claim;
    const binding = {
      ...codexNativeHookRelayAttemptBinding(attempt),
      signal: AbortSignal.any([this.lifetimeAbortController.signal, attempt.signal]),
      onPreToolUseFailure: attempt.onPreToolUseFailure,
    };
    if (!this.relay.rebindAttempt?.(binding)) {
      embeddedAgentLog.debug("Codex native hook relay registration re-registered", {
        relayId: this.relayId,
        runId: attempt.runId,
      });
      this.relay = registerCodexNativeHookRelay(attempt, this.relayId, {
        ttlMs: this.ttlMs,
        signal: this.lifetimeAbortController.signal,
        onPreToolUseFailure: (failure) =>
          this.reportUnclaimedPreToolUseFailure(attempt.runId, failure),
        allowedEvents: this.relay.allowedEvents,
        preToolUseLoopDetection: this.frozenPreToolUseLoopDetection,
      });
      this.relay.rebindAttempt?.(binding);
    }
    this.attachAttemptAbort(claim);
    const relay = this.relay;
    const { unregister: _unregister, rebindAttempt: _rebindAttempt, ...fields } = relay;
    return {
      ...fields,
      get expiresAtMs() {
        return relay.expiresAtMs;
      },
      renew: (ttlMs?: number) => this.renew(ttlMs),
      acquireChild: (childThreadId: string) => this.acquireChild(childThreadId),
      releaseParent: (options?: { delay?: boolean }) => this.releaseAttempt(claim, options),
    };
  }

  private reportUnclaimedPreToolUseFailure(runId: string, failure: CodexNativePreToolUseFailure) {
    emitCodexNativePreToolUseFailureDiagnostic({
      agentId: this.relay.agentId,
      sessionId: this.relay.sessionId,
      sessionKey: this.relay.sessionKey,
      runId,
      failure,
    });
  }

  private attachAttemptAbort(claim: CodexNativeHookRelayAttemptClaim): void {
    const { signal } = claim.attempt;
    const onAbort = () => this.releaseAttempt(claim);
    signal.addEventListener("abort", onAbort, { once: true });
    claim.detachAbort = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) {
      onAbort();
    }
  }

  private hasClaims(): boolean {
    return this.attemptClaim !== undefined || this.childThreadIds.size > 0;
  }

  private renew(ttlMs?: number): void {
    if (this.released || !this.hasClaims()) {
      return;
    }
    this.relay.renew(ttlMs);
  }

  private acquireChild(childThreadIdInput: string): (() => void) | undefined {
    const childThreadId = childThreadIdInput.trim();
    if (!childThreadId || this.released || this.childThreadIds.has(childThreadId)) {
      return undefined;
    }
    this.cancelPendingUnregister?.();
    this.cancelPendingUnregister = undefined;
    this.childThreadIds.add(childThreadId);
    this.scheduleRenewal();
    let acquired = true;
    return () => {
      if (!acquired) {
        return;
      }
      acquired = false;
      this.childThreadIds.delete(childThreadId);
      if (this.childThreadIds.size === 0) {
        this.clearRenewal();
        if (!this.attemptClaim) {
          this.requestFinalRelease(true);
        }
      }
    };
  }

  private releaseAttempt(
    claim: CodexNativeHookRelayAttemptClaim,
    options: { delay?: boolean } = {},
  ): void {
    if (this.released || this.attemptClaim !== claim) {
      return;
    }
    this.retireAttemptClaim();
    if (this.childThreadIds.size === 0) {
      this.requestFinalRelease(options.delay === true);
    }
  }

  private retireAttemptClaim(): void {
    const claim = this.attemptClaim;
    if (!claim) {
      return;
    }
    this.attemptClaim = undefined;
    claim.detachAbort();
    this.relay.rebindAttempt?.({
      ...codexNativeHookRelayAttemptBinding(claim.attempt),
      signal: this.lifetimeAbortController.signal,
      onPreToolUseFailure: (failure) =>
        this.reportUnclaimedPreToolUseFailure(claim.attempt.runId, failure),
    });
  }

  private requestFinalRelease(delay: boolean): void {
    if (this.released || this.hasClaims()) {
      return;
    }
    if (!delay) {
      this.releaseNow("codex_native_hook_relay_released");
      return;
    }
    if (this.cancelPendingUnregister) {
      return;
    }
    this.cancelPendingUnregister = scheduleCodexNativeHookRelayUnregister({
      relay: { unregister: () => this.relay.unregister() },
      hookTimeoutSec: this.hookTimeoutSec,
      beforeUnregister: () => {
        this.cancelPendingUnregister = undefined;
        this.lifetimeAbortController.abort("codex_native_hook_relay_released");
        this.finalizeState("codex_native_hook_relay_released_delayed");
      },
    });
  }

  private scheduleRenewal(): void {
    if (this.renewalTimer || this.released || this.childThreadIds.size === 0) {
      return;
    }
    const delayMs = Math.max(1, Math.min(5 * 60_000, Math.floor(this.ttlMs / 2)));
    this.renewalTimer = setTimeout(() => {
      this.renewalTimer = undefined;
      if (this.released || this.childThreadIds.size === 0) {
        return;
      }
      this.renew(this.ttlMs);
      this.scheduleRenewal();
    }, delayMs);
    this.renewalTimer.unref();
  }

  private clearRenewal(): void {
    if (!this.renewalTimer) {
      return;
    }
    clearTimeout(this.renewalTimer);
    this.renewalTimer = undefined;
  }

  private releaseNow(reason: string): void {
    this.cancelPendingUnregister?.();
    this.cancelPendingUnregister = undefined;
    this.lifetimeAbortController.abort(reason);
    this.relay.unregister();
    this.finalizeState(reason);
  }

  private finalizeState(reason: string): void {
    if (this.released) {
      return;
    }
    this.released = true;
    embeddedAgentLog.debug("Codex native hook relay route released", {
      relayId: this.relayId,
      reason,
    });
    this.clearRenewal();
    this.attemptClaim?.detachAbort();
    this.attemptClaim = undefined;
    this.childThreadIds.clear();
    if (codexNativeHookRelayOwners.get(this.relayId) === this) {
      codexNativeHookRelayOwners.delete(this.relayId);
    }
  }

  dispose(): void {
    if (this.released) {
      return;
    }
    this.releaseNow("codex_native_hook_relay_disposed");
  }
}

const codexNativeHookRelayOwners = codexNativeHookRelayOwnerRegistry as Map<
  string,
  CodexNativeHookRelayRoute
>;

/** Selects the native hook events Codex should install for the current approval mode. */
export function resolveCodexNativeHookRelayEvents(params: {
  configuredEvents?: readonly NativeHookRelayEvent[];
  appServer: Pick<CodexAppServerRuntimeOptions, "approvalPolicy">;
}): readonly NativeHookRelayEvent[] {
  if (params.configuredEvents?.length) {
    return params.configuredEvents;
  }
  // Codex emits PermissionRequest before the app-server approval reviewer has
  // resolved the command. In native approval modes, let Codex's app-server
  // approval bridge own the real escalation instead of surfacing a stale
  // pre-guardian OpenClaw plugin approval prompt.
  return params.appServer.approvalPolicy === "never"
    ? CODEX_NATIVE_HOOK_RELAY_EVENTS
    : CODEX_NATIVE_HOOK_RELAY_EVENTS_WITH_APP_SERVER_APPROVALS;
}

/** Derives the native hook relay TTL from the turn budget unless explicitly configured. */
export function resolveCodexNativeHookRelayTtlMs(params: {
  explicitTtlMs: number | undefined;
  attemptTimeoutMs: number;
  startupTimeoutMs: number;
  turnStartTimeoutMs: number;
}): number {
  if (params.explicitTtlMs !== undefined) {
    return params.explicitTtlMs;
  }
  const relayBudgetMs =
    params.attemptTimeoutMs +
    params.startupTimeoutMs +
    params.turnStartTimeoutMs +
    CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS;
  return Math.max(CODEX_NATIVE_HOOK_RELAY_MIN_TTL_MS, Math.floor(relayBudgetMs));
}

function buildCodexNativeHookRelayId(params: {
  agentId: string | undefined;
  sessionId: string;
  sessionKey: string | undefined;
  generation: string;
}): string {
  const hash = createHash("sha256");
  hash.update("openclaw:codex:native-hook-relay:v2");
  hash.update("\0");
  hash.update(params.agentId?.trim() || "");
  hash.update("\0");
  hash.update(params.sessionKey?.trim() || params.sessionId);
  hash.update("\0");
  hash.update(params.generation);
  return `codex-${hash.digest("hex").slice(0, 40)}`;
}

const CODEX_HOOK_EVENT_BY_NATIVE_EVENT: Record<NativeHookRelayEvent, CodexHookEventName> = {
  pre_tool_use: "PreToolUse",
  post_tool_use: "PostToolUse",
  permission_request: "PermissionRequest",
  before_agent_finalize: "Stop",
};

const CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT: Record<NativeHookRelayEvent, string> = {
  pre_tool_use: "pre_tool_use",
  post_tool_use: "post_tool_use",
  permission_request: "permission_request",
  before_agent_finalize: "stop",
};

const CODEX_SESSION_FLAGS_HOOK_SOURCE_PATHS = [
  "/<session-flags>/config.toml",
  "<session-flags>/config.toml",
] as const;

/** Builds the Codex config overlay that installs trusted command hooks for relay events. */
export function buildCodexNativeHookRelayConfig(params: {
  relay: Pick<
    NativeHookRelayRegistrationHandle,
    "shouldRelayEvent" | "toolMatcherForEvent" | "commandForEvent"
  >;
  events?: readonly NativeHookRelayEvent[];
  hookTimeoutSec?: number;
  clearOmittedEvents?: boolean;
  loopDetectionPreToolUseRelay: boolean;
}): JsonObject {
  const events = params.events?.length ? params.events : CODEX_NATIVE_HOOK_RELAY_EVENTS;
  const selectedEvents = new Set<NativeHookRelayEvent>(events);
  const config: JsonObject = {
    "features.hooks": true,
  };
  const hookState: JsonObject = {};
  for (const event of CODEX_NATIVE_HOOK_RELAY_EVENTS) {
    const codexEvent = CODEX_HOOK_EVENT_BY_NATIVE_EVENT[event];
    const selected = selectedEvents.has(event);
    const shouldRelay = params.relay.shouldRelayEvent(event);
    // The no-policy marker is part of the shipped Codex fallback contract.
    // Only the Codex-owned loop relay opt-out may omit it.
    const selectedNoopPreToolUse =
      selected && event === "pre_tool_use" && !shouldRelay && params.loopDetectionPreToolUseRelay;
    if (!selected || (!shouldRelay && !selectedNoopPreToolUse)) {
      if (selected || params.clearOmittedEvents) {
        config[`hooks.${codexEvent}`] = [] satisfies JsonValue;
      }
      if (params.clearOmittedEvents) {
        for (const sourcePath of CODEX_SESSION_FLAGS_HOOK_SOURCE_PATHS) {
          hookState[`${sourcePath}:${CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT[event]}:0:0`] = {
            enabled: false,
          } satisfies JsonValue;
        }
      }
      continue;
    }
    const timeout = normalizeHookTimeoutSec(params.hookTimeoutSec);
    const command = params.relay.commandForEvent(event, {
      timeoutMs: resolveCodexNativeHookRelayCommandTimeoutMs(timeout),
    });
    const matcher = selectedNoopPreToolUse
      ? undefined
      : buildCodexNativeToolMatcher(params.relay.toolMatcherForEvent(event));
    config[`hooks.${codexEvent}`] = [
      {
        ...(matcher ? { matcher } : {}),
        hooks: [
          {
            type: "command",
            command,
            timeout,
            async: false,
            statusMessage: "OpenClaw native hook relay",
          },
        ],
      },
    ] satisfies JsonValue;
    const state = {
      enabled: true,
      trusted_hash: codexCommandHookTrustedHash({
        event,
        command,
        matcher,
        timeout,
        statusMessage: "OpenClaw native hook relay",
      }),
    };
    for (const sourcePath of CODEX_SESSION_FLAGS_HOOK_SOURCE_PATHS) {
      hookState[`${sourcePath}:${CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT[event]}:0:0`] =
        state satisfies JsonValue;
    }
  }
  config["hooks.state"] = hookState;
  return config;
}

/** Builds a Codex config overlay that disables native hooks and clears hook arrays. */
export function buildCodexNativeHookRelayDisabledConfig(): JsonObject {
  return {
    "features.hooks": false,
    "hooks.PreToolUse": [],
    "hooks.PostToolUse": [],
    "hooks.PermissionRequest": [],
    "hooks.Stop": [],
  };
}

function normalizeHookTimeoutSec(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : CODEX_NATIVE_HOOK_RELAY_DEFAULT_TIMEOUT_SEC;
}

function resolveCodexNativeHookRelayCommandTimeoutMs(hookTimeoutSec: number | undefined): number {
  const parentTimeoutMs =
    finiteSecondsToTimerSafeMilliseconds(normalizeHookTimeoutSec(hookTimeoutSec)) ?? 5_000;
  const parentMarginMs = Math.min(
    CODEX_NATIVE_HOOK_RELAY_COMMAND_MAX_PARENT_MARGIN_MS,
    Math.max(CODEX_NATIVE_HOOK_RELAY_COMMAND_MIN_PARENT_MARGIN_MS, Math.floor(parentTimeoutMs / 5)),
  );
  return Math.max(1, parentTimeoutMs - parentMarginMs);
}

function buildCodexNativeToolMatcher(toolNames: readonly string[] | undefined): string | undefined {
  if (toolNames === undefined) {
    return undefined;
  }
  if (toolNames.length === 0) {
    throw new TypeError("Codex native hook matcher requires at least one tool name");
  }
  const nativeNames = new Set<string>();
  let hasCustomToolName = false;
  for (const toolName of toolNames) {
    const canonicalToolName = toolName.trim();
    if (!canonicalToolName || canonicalToolName === "*") {
      throw new TypeError("Codex native hook matcher requires canonical OpenClaw tool ids");
    }
    const nativeAliases = CODEX_HOOK_MATCHER_NAMES_BY_TOOL_ID[canonicalToolName];
    if (!nativeAliases) {
      hasCustomToolName = true;
    }
    for (const nativeName of nativeAliases ?? [canonicalToolName]) {
      nativeNames.add(nativeName);
    }
  }
  const sortedNames = Array.from(nativeNames).toSorted();
  if (!hasCustomToolName && sortedNames.every((toolName) => /^[A-Za-z0-9_]+$/.test(toolName))) {
    return sortedNames.join("|");
  }
  const escapedNames = sortedNames.map((toolName) =>
    toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return `(?i)^(?:${escapedNames.join("|")})$`;
}

function codexCommandHookTrustedHash(params: {
  event: NativeHookRelayEvent;
  command: string;
  matcher?: string;
  timeout: number;
  statusMessage: string;
}): string {
  // Keep the match-all matcher omitted rather than null. Codex app-server
  // converts JSON null to an empty TOML string before hashing, which changes the
  // trust identity even though both forms match all tools.
  const identity = {
    event_name: CODEX_HOOK_KEY_LABEL_BY_NATIVE_EVENT[params.event],
    ...(params.matcher ? { matcher: params.matcher } : {}),
    hooks: [
      {
        async: false,
        command: params.command,
        statusMessage: params.statusMessage,
        timeout: params.timeout,
        type: "command",
      },
    ],
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(sortJsonValue(identity)))
    .digest("hex");
  return `sha256:${hash}`;
}

function sortJsonValue(value: JsonValue): JsonValue {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  const sorted: JsonObject = {};
  for (const [key, entry] of Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    sorted[key] = sortJsonValue(entry);
  }
  return sorted;
}
