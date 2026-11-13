// The backup page of BACKUP-C-1 and the restore result of BACKUP-C-3 read from
// control-plane projections, so every shown state is the kernel object's own
// state and every observation time is the one the projection carries
// (KOSD-C-13). A restore is a success only when the four items KOSD-C-42 fixes
// are equal, never because the job claims it; an item that cannot be presented
// as normal carries its reason instead of a normal-looking value.
//
// The write entries are the session's: a policy this session manages carries the
// change entry and nothing else carries a write path (BACKUP-C-2, KOSD-C-60).

import { canManagePolicy, policyValues } from "./policy.js";

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

/** The write entry a session gets on a policy it manages (BACKUP-C-2). */
export const ENTRY_EDIT = "edit";

/** The restore judgement: only four equal items are a success (KOSD-C-42). */
export const RESTORE_SUCCEEDED = "Succeeded";
export const RESTORE_FAILED = "Failed";
const RESTORE_PENDING = "Pending";

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
 * buildPage assembles the page from the BackupPolicy and RestoreJob
 * projections the list calls returned. The session decides which policies
 * carry the write entry, and `rejection` is the answer the last submission
 * received: the form that carried it shows the reason, and nothing is
 * presented as written (BACKUP-C-2).
 *
 * @param {{policies: import("./control.js").Projection[],
 *          restores?: import("./control.js").Projection[],
 *          now?: Date|string|number, session?: {username: string, role: string}|null,
 *          namespace?: string, rejection?: object|null,
 *          sessionFailure?: {code: string, message: string}|null}} input
 */
export function buildPage({
  policies,
  restores = [],
  now = new Date(),
  session = null,
  namespace = "",
  rejection = null,
  sessionFailure = null,
}) {
  if (!Array.isArray(policies)) {
    throw new TypeError("备份页需要策略投影列表");
  }
  if (!Array.isArray(restores)) {
    throw new TypeError("备份页需要恢复作业投影列表");
  }
  const clock = toDate(now);
  const views = policies.map((projection) => policyView(projection, clock, session));
  const restoreViews = restores.map((projection) => restoreView(projection, clock));
  const observation = oldestObservation([...views, ...restoreViews]);
  return {
    state: STATE_UNKNOWN,
    observedAt: observation.observedAt,
    stale: observation.stale,
    namespace,
    rejection,
    // Without a session no policy is manageable; the page says why rather than
    // showing an unexplained absence of every write entry (KOSD-C-60).
    sessionReason: sessionFailure,
    policies: views,
    restores: restoreViews,
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
    restores: [],
  };
}

/**
 * policyView builds one policy's four items and the entries this session gets.
 *
 * @param {import("./control.js").Projection} projection
 * @param {Date} now
 * @param {{username: string, role: string}|null} session
 */
export function policyView(projection, now = new Date(), session = null) {
  const clock = toDate(now);
  const object = projection?.object ?? {};
  const spec = object.spec ?? {};
  const status = object.status ?? {};
  const observedAt = projection?.observedAt ?? null;
  const staleness = stalenessOf(observedAt, clock);
  const stamp = { observedAt, stale: staleness.stale };
  const manageable = canManagePolicy(object, session);

  const run = status.lastBackup ?? null;
  const drill = status.lastDrill ?? null;
  const running = status.running ?? null;
  const target = spec.target ?? null;
  const restoreRuns = runsOf(status);

  return {
    id: identityOf(projection, object),
    namespace: projection?.ref?.namespace ?? object.metadata?.namespace ?? "",
    name: projection?.ref?.name ?? object.metadata?.name ?? "",
    observedAt,
    stale: staleness.stale,
    restoreRuns,
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
    manageable,
    // The six parts a change starts from; the owner is not among them, so the
    // form has nothing to rewrite (KOSD-C-60).
    values: policyValues({ object }),
    entries: entriesFor(run, drill, { restoreRuns, manageable }),
  };
}

/**
 * restoreView builds one restore result from a RestoreJob projection: phase,
 * baseline, observed values, differences, and the created and preserved source
 * objects (BACKUP-C-3, KOSD-C-39). Its verdict is the four-item judgement
 * KOSD-C-42 fixes, never the job's own claim.
 *
 * @param {import("./control.js").Projection} projection
 * @param {Date} now
 */
export function restoreView(projection, now = new Date()) {
  const clock = toDate(now);
  const object = projection?.object ?? {};
  const spec = object.spec ?? {};
  const status = object.status ?? {};
  const observedAt = projection?.observedAt ?? null;
  const staleness = stalenessOf(observedAt, clock);
  const baseline = metricsOf(status.baseline);
  const observed = metricsOf(status.observed);
  const judgement = judgeRestore({
    phase: status.phase,
    baseline,
    observed,
    diffs: status.diffs,
    reason: status.reason,
  });

  return {
    id: identityOf(projection, object),
    namespace: projection?.ref?.namespace ?? object.metadata?.namespace ?? "",
    name: projection?.ref?.name ?? object.metadata?.name ?? "",
    observedAt,
    stale: staleness.stale,
    inPlace: spec.inPlace === true,
    policy: spec.policy ?? "",
    run: spec.run ?? "",
    targetApplication: spec.targetApplication ?? "",
    phase: status.phase ?? STATE_UNKNOWN,
    verdict: judgement.verdict,
    baseline,
    observed,
    diffs: judgement.diffs,
    reason: judgement.reason,
    created: createdOf(status.created),
    source: sourceOf(status.source),
  };
}

/**
 * judgeRestore decides what the result surface may claim. A phase other than
 * Succeeded is never a success; Succeeded is a success only when all four items
 * are recorded and equal (KOSD-C-42), so a job that says Succeeded over
 * differing data is shown as a failure with the differences listed.
 */
function judgeRestore({ phase, baseline, observed, diffs, reason }) {
  const recorded = Array.isArray(diffs) ? diffs : [];
  if (phase === KERNEL_FAILED) {
    return {
      verdict: RESTORE_FAILED,
      diffs: recorded,
      reason: {
        code: "restore-failed",
        message: reasonText(reason, recorded) || "恢复失败，对象未给出原因",
        diffs: recorded,
      },
    };
  }
  if (phase !== KERNEL_SUCCEEDED) {
    return { verdict: RESTORE_PENDING, diffs: recorded, reason: null };
  }
  const comparison = compareFour(baseline, observed);
  if (comparison.unverified) {
    return {
      verdict: RESTORE_FAILED,
      diffs: [],
      reason: {
        code: "restore-unverified",
        message: "恢复没有记录完整的基线或观测值，无法确认四项全等",
        diffs: [],
      },
    };
  }
  if (comparison.diffs.length > 0) {
    return {
      verdict: RESTORE_FAILED,
      diffs: comparison.diffs,
      reason: {
        code: "restore-mismatch",
        message: `恢复数据与基线不一致：${describeDiffs(comparison.diffs)}`,
        diffs: comparison.diffs,
      },
    };
  }
  return { verdict: RESTORE_SUCCEEDED, diffs: [], reason: null };
}

/**
 * metricsOf normalizes one side of the four-item comparison: every table's row
 * count, the file count, the total bytes and the content checksum. A side the
 * object never recorded is null rather than zeros, so an unrecorded value is
 * never presented as an equal one.
 */
export function metricsOf(metrics) {
  if (!metrics || typeof metrics !== "object") {
    return null;
  }
  return {
    tables: Array.isArray(metrics.tables)
      ? metrics.tables.map((table) => ({
          name: typeof table?.name === "string" ? table.name : "",
          rows: table?.rows ?? null,
        }))
      : [],
    files: metrics.files ?? null,
    bytes: metrics.bytes ?? null,
    checksum: metrics.checksum ?? null,
  };
}

/**
 * compareFour compares both sides item by item. Tables are matched by name, so
 * a different order is the same data; every recorded value must be present.
 */
function compareFour(baseline, observed) {
  if (!baseline || !observed) {
    return { unverified: true, diffs: [] };
  }
  if (
    baseline.files === null ||
    baseline.bytes === null ||
    baseline.checksum === null ||
    observed.files === null ||
    observed.bytes === null ||
    observed.checksum === null
  ) {
    return { unverified: true, diffs: [] };
  }
  const diffs = [];
  const rowsByName = (side) => new Map(side.tables.map((table) => [table.name, table.rows]));
  const baseRows = rowsByName(baseline);
  const observedRows = rowsByName(observed);
  const names = [...new Set([...baseRows.keys(), ...observedRows.keys()])].sort();
  for (const name of names) {
    const base = baseRows.has(name) ? baseRows.get(name) : null;
    const seen = observedRows.has(name) ? observedRows.get(name) : null;
    if (base === null || seen === null || String(base) !== String(seen)) {
      diffs.push({ item: `tables.${name}`, baseline: quantity(base), observed: quantity(seen) });
    }
  }
  for (const item of ["files", "bytes"]) {
    if (String(baseline[item]) !== String(observed[item])) {
      diffs.push({ item, baseline: quantity(baseline[item]), observed: quantity(observed[item]) });
    }
  }
  if (String(baseline.checksum) !== String(observed.checksum)) {
    diffs.push({ item: "checksum", baseline: quantity(baseline.checksum), observed: quantity(observed.checksum) });
  }
  diffs.sort((left, right) => (left.item < right.item ? -1 : left.item > right.item ? 1 : 0));
  return { unverified: false, diffs };
}

/** runsOf lists the runs a restore may name: the recorded runs, else the last one. */
function runsOf(status) {
  const recorded = Array.isArray(status?.runs) ? status.runs : [];
  const runs = recorded.length > 0 ? recorded : status?.lastBackup ? [status.lastBackup] : [];
  return runs
    .map((run) => ({
      path: typeof run?.path === "string" ? run.path : "",
      completedAt: run?.completedAt ?? null,
      consistency: run?.consistency ?? "",
      succeeded: run?.succeeded === true,
    }))
    .filter((run) => run.path !== "");
}

function reasonText(reason, diffs) {
  if (typeof reason === "string" && reason !== "") {
    return reason;
  }
  return describeDiffs(diffs);
}

function quantity(value) {
  return value === null || value === undefined ? "—" : String(value);
}

function createdOf(created) {
  return {
    application: typeof created?.application === "string" ? created.application : "",
    volumes: Array.isArray(created?.volumes)
      ? created.volumes.filter((volume) => typeof volume === "string")
      : [],
  };
}

function sourceOf(source) {
  return {
    application: typeof source?.application === "string" ? source.application : "",
    volumes: Array.isArray(source?.volumes)
      ? source.volumes.filter((volume) => typeof volume === "string")
      : [],
    pvc: typeof source?.pvc === "string" ? source.pvc : "",
    retained: source?.retained === true,
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

/**
 * entriesFor lists the actions one policy offers: a restore when the object
 * records a restorable run, a drill when it records a run or a drill, and the
 * change entry only when this session manages the policy (BACKUP-C-2).
 */
function entriesFor(run, drill, { restoreRuns = [], manageable = false } = {}) {
  const restorable = restoreRuns.length > 0;
  const entries = [
    {
      id: ENTRY_RESTORE,
      action: ENTRY_RESTORE,
      available: restorable,
      reason: restorable
        ? null
        : { code: "no-run", message: "没有可恢复的运行，恢复入口不可用" },
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
  if (manageable) {
    entries.push({ id: ENTRY_EDIT, action: ENTRY_EDIT, available: true, reason: null });
  }
  return entries;
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
