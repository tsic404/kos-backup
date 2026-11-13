// The backup page of BACKUP-C-1: the policy, its runs, the target with its
// failure domain, and the drill with its differences. Every item is built from
// one control-plane projection, so its state is the kernel object's own state
// and its observation time is the one the projection carries (KOSD-C-13).
//
// An item that cannot be presented as normal carries the reason: an
// observation older than the freshness bound, a policy without a target, a run
// or drill the object never recorded, and a target whose failure domain cannot
// be determined. Nothing here invents a state the object does not have; the
// window's own markers are named below and never shadow a kernel value.

/** The one freshness bound every read is judged by (KOSD-C-13). */
export const STALE_THRESHOLD_MS = 2 * 60 * 1000;

/** The four items the page shows for one policy (BACKUP-C-1). */
export const ITEM_POLICY = "policy";
export const ITEM_RUNS = "runs";
export const ITEM_TARGET = "target";
export const ITEM_DRILL = "drill";

/** The two actions the page offers (BACKUP-C-1, BACKUP-C-3). */
export const ENTRY_RESTORE = "restore";
export const ENTRY_DRILL = "drill";

/** A kernel value the page shows verbatim when the object has one. */
const KERNEL_SUCCEEDED = "Succeeded";
const KERNEL_FAILED = "Failed";

/** Window markers for absences: no kernel state exists for these. */
export const STATE_NONE = "None";
export const STATE_RUNNING = "Running";
export const STATE_CONFIGURED = "Configured";
export const STATE_UNCONFIGURED = "Unconfigured";
export const STATE_UNDETERMINED = "Undetermined";
export const STATE_UNREADABLE = "Unreadable";

const STATE_UNKNOWN = "Unknown";

/**
 * buildPage assembles the page from the BackupPolicy projections one list
 * returned.
 *
 * @param {{policies: import("./control.js").Projection[], now?: Date|string|number}} input
 */
export function buildPage({ policies, now = new Date() }) {
  if (!Array.isArray(policies)) {
    throw new TypeError("备份页需要策略投影列表");
  }
  const clock = toDate(now);
  const views = policies.map((projection) => policyView(projection, clock));
  const observation = oldestObservation(views);
  return {
    state: STATE_UNKNOWN,
    observedAt: observation.observedAt,
    stale: observation.stale,
    policies: views,
  };
}

/**
 * buildUnreadablePage is the page a failed read leaves behind: it names the
 * failure instead of showing an empty, apparently normal page (BACKUP-C-1).
 *
 * @param {{error: {code?: string, message?: string, status?: number}, now?: Date|string|number}} input
 */
export function buildUnreadablePage({ error, now = new Date() }) {
  const clock = toDate(now);
  return {
    state: STATE_UNREADABLE,
    observedAt: null,
    // Without an answer there is no observation, so nothing on this page may
    // claim to be fresh.
    stale: true,
    reason: {
      code: error?.code || "control-plane-unreadable",
      message: error?.message || "控制面无法读取备份对象",
      status: error?.status,
    },
    policies: [],
  };
}

/**
 * policyView builds one policy's four items.
 *
 * @param {import("./control.js").Projection} projection
 * @param {Date} now
 */
export function policyView(projection, now = new Date()) {
  const clock = toDate(now);
  const object = projection?.object ?? {};
  const spec = object.spec ?? {};
  const status = object.status ?? {};
  const observedAt = projection?.observedAt ?? null;
  const staleness = stalenessOf(observedAt, clock);
  const stamp = { observedAt, stale: staleness.stale };

  const run = status.lastBackup ?? null;
  const drill = status.lastDrill ?? null;
  const running = status.running ?? null;
  const target = spec.target ?? null;

  return {
    id: identityOf(projection, object),
    namespace: projection?.ref?.namespace ?? object.metadata?.namespace ?? "",
    name: projection?.ref?.name ?? object.metadata?.name ?? "",
    observedAt,
    stale: staleness.stale,
    items: {
      [ITEM_POLICY]: {
        id: ITEM_POLICY,
        ...stamp,
        state: {
          phase: status.phase ?? STATE_UNKNOWN,
          health: status.health?.state ?? STATE_UNKNOWN,
        },
        conditions: status.conditions ?? [],
        reason: failedCondition(status.conditions),
        policy: {
          selector: spec.selector ?? "",
          schedule: spec.schedule ?? "",
          consistency: spec.consistency ?? "",
          retention: spec.retention ?? {},
          nextRunTime: status.nextRunTime ?? null,
        },
      },
      [ITEM_RUNS]: {
        id: ITEM_RUNS,
        ...stamp,
        state: runState(running, run),
        running: running ? pickRunning(running) : null,
        run: run ? pickRun(run) : null,
        reason: runReason(running, run),
      },
      [ITEM_TARGET]: {
        id: ITEM_TARGET,
        ...stamp,
        state: targetState(target),
        target: {
          path: target?.path ?? "",
          failureDomain: target?.failureDomain ?? "",
        },
        reason: targetReason(target),
      },
      [ITEM_DRILL]: {
        id: ITEM_DRILL,
        ...stamp,
        state: drill ? drill.phase ?? STATE_UNKNOWN : STATE_NONE,
        drill: drill ? pickDrill(drill) : null,
        reason: drillReason(drill),
      },
    },
    entries: entriesFor(run, drill),
  };
}

/**
 * stalenessOf judges one observation against the one freshness bound. A
 * missing or unparsable observation time cannot be judged fresh, so it is
 * stale and the item says why (KOSD-C-13).
 */
export function stalenessOf(observedAt, now = new Date()) {
  const clock = toDate(now);
  const observed = toDate(observedAt);
  if (observed === null) {
    return {
      stale: true,
      reason: { code: "unobserved", message: "投影没有可用的观测时间" },
    };
  }
  if (clock.getTime() - observed.getTime() > STALE_THRESHOLD_MS) {
    return { stale: true, reason: null };
  }
  return { stale: false, reason: null };
}

/** runState is the run item's state: the in-flight action, else the last outcome. */
function runState(running, run) {
  if (running) {
    return STATE_RUNNING;
  }
  if (!run) {
    return STATE_NONE;
  }
  return run.succeeded === true ? KERNEL_SUCCEEDED : KERNEL_FAILED;
}

/** targetState reports whether the policy names a target and its failure domain. */
function targetState(target) {
  const path = typeof target?.path === "string" ? target.path.trim() : "";
  const domain = typeof target?.failureDomain === "string" ? target.failureDomain.trim() : "";
  if (path === "" && domain === "") {
    return STATE_UNCONFIGURED;
  }
  if (domain === "") {
    return STATE_UNDETERMINED;
  }
  return STATE_CONFIGURED;
}

function runReason(running, run) {
  if (running) {
    return {
      code: "running",
      message: `策略正在执行${running.kind ? " " + running.kind : ""}，结果尚未记录`,
    };
  }
  if (!run) {
    return { code: "no-run", message: "策略还没有已完成的运行" };
  }
  if (run.succeeded === true) {
    return null;
  }
  return {
    code: "run-failed",
    message: typeof run.reason === "string" && run.reason !== "" ? run.reason : "运行失败，对象未给出原因",
    diffs: run.diffs ?? [],
  };
}

function targetReason(target) {
  const state = targetState(target);
  switch (state) {
    case STATE_UNCONFIGURED:
      return { code: "target-unconfigured", message: "策略未指定备份目标" };
    case STATE_UNDETERMINED:
      return { code: "failure-domain-undetermined", message: "无法判定目标的失败域" };
    default:
      return null;
  }
}

function drillReason(drill) {
  if (!drill) {
    return null;
  }
  if (drill.phase === KERNEL_FAILED || drill.succeeded === false) {
    const diffs = drill.diffs ?? [];
    const message =
      typeof drill.reason === "string" && drill.reason !== ""
        ? drill.reason
        : describeDiffs(diffs);
    return {
      code: "drill-mismatch",
      message: message === "" ? "演练失败，对象未给出原因" : message,
      diffs,
    };
  }
  return null;
}

/** describeDiffs renders the differences the drill found, item by item. */
function describeDiffs(diffs) {
  return diffs
    .map((diff) => `${diff.item ?? "?"} ${diff.baseline ?? "-"}→${diff.observed ?? "-"}`)
    .join("；");
}

function entriesFor(run, drill) {
  return [
    {
      id: ENTRY_RESTORE,
      action: ENTRY_RESTORE,
      available: true,
      reason: null,
    },
    {
      id: ENTRY_DRILL,
      action: ENTRY_DRILL,
      available: Boolean(run) || Boolean(drill),
      reason:
        run || drill
          ? null
          : { code: "no-run", message: "没有可演练的运行，演练入口不可用" },
    },
  ];
}

function failedCondition(conditions) {
  const failed = (conditions ?? []).find((condition) => condition?.status !== "True");
  if (!failed) {
    return null;
  }
  return {
    code: failed.reason || failed.type || "condition-not-true",
    message: failed.message || `${failed.type ?? "条件"}未满足`,
  };
}

function pickRunning(running) {
  return {
    kind: running.kind ?? "",
    run: running.run ?? "",
    scope: running.scope ?? "",
    startedAt: running.startedAt ?? null,
  };
}

function pickRun(run) {
  return {
    scheduledAt: run.scheduledAt ?? null,
    startedAt: run.startedAt ?? null,
    completedAt: run.completedAt ?? null,
    consistency: run.consistency ?? "",
    path: run.path ?? "",
    succeeded: run.succeeded === true,
    reason: run.reason ?? "",
    baseline: run.baseline ?? null,
    diffs: run.diffs ?? [],
  };
}

function pickDrill(drill) {
  return {
    phase: drill.phase ?? STATE_UNKNOWN,
    run: drill.run ?? "",
    completedAt: drill.completedAt ?? null,
    succeeded: drill.succeeded === true,
    reason: drill.reason ?? "",
    diffs: drill.diffs ?? [],
  };
}

function identityOf(projection, object) {
  const namespace = projection?.ref?.namespace ?? object.metadata?.namespace ?? "";
  const name = projection?.ref?.name ?? object.metadata?.name ?? "";
  return namespace === "" ? name : `${namespace}/${name}`;
}

/** oldestObservation is the page's observation: the oldest read it shows. */
function oldestObservation(views) {
  let oldest = null;
  let stale = false;
  for (const view of views) {
    const observed = toDate(view.observedAt);
    if (observed !== null && (oldest === null || observed < oldest)) {
      oldest = observed;
    }
    stale = stale || view.stale;
  }
  return {
    observedAt: oldest === null ? null : oldest.toISOString(),
    stale: stale || oldest === null,
  };
}

function toDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}
