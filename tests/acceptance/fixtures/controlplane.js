// Fixtures for the backup page cases. Each object is what the control plane
// would project for one BackupPolicy: the spec the user wrote and the status
// the backup reconciler recorded. The expectations the cases assert are read
// from these objects, never from the page model's own output.

/** The observation instant every fixture projection carries. */
export const OBSERVED_AT = "2026-03-01T12:00:00.000Z";

/** A policy that completed one run and passed its drill. */
export function completedRunPolicy() {
  return {
    apiVersion: "kos.tsic.top/v1beta1",
    kind: "BackupPolicy",
    metadata: { name: "nightly", namespace: "home" },
    spec: {
      owner: "alice",
      selector: "app=media",
      schedule: "0 3 * * *",
      consistency: "crash-consistent",
      target: { path: "/mnt/backup", failureDomain: "disk-b" },
      retention: { keep: 7 },
      drill: { enabled: true },
    },
    status: {
      phase: "Ready",
      health: { state: "Healthy" },
      conditions: [
        {
          type: "Reconciled",
          status: "True",
          reason: "Reconciled",
          message: "最近一次调和成功",
          lastTransitionTime: "2026-03-01T11:58:00Z",
        },
      ],
      nextRunTime: "2026-03-02T03:00:00Z",
      lastBackup: {
        scheduledAt: "2026-03-01T03:00:00Z",
        startedAt: "2026-03-01T03:00:02Z",
        completedAt: "2026-03-01T11:57:00Z",
        consistency: "crash-consistent",
        path: "/mnt/backup/home/nightly/2026-03-01",
        succeeded: true,
        baseline: {
          files: 41,
          bytes: 1048576,
          checksum: "sha256:aa",
          tables: [],
          engines: "none",
        },
      },
      lastDrill: {
        phase: "Succeeded",
        run: "/mnt/backup/home/nightly/2026-03-01",
        completedAt: "2026-03-01T11:58:30Z",
        succeeded: true,
      },
    },
  };
}

/** A policy whose drill found one extra file and failed the run. */
export function failedDrillPolicy() {
  const policy = completedRunPolicy();
  policy.metadata.name = "nightly-drill";
  policy.status.lastBackup = {
    ...policy.status.lastBackup,
    succeeded: false,
    reason: "演练不一致：files 41→42",
    diffs: [{ item: "files", baseline: "41", observed: "42" }],
  };
  policy.status.lastDrill = {
    phase: "Failed",
    run: "/mnt/backup/home/nightly-drill/2026-03-01",
    completedAt: "2026-03-01T11:58:30Z",
    succeeded: false,
    reason: "演练不一致：files 41→42",
    diffs: [{ item: "files", baseline: "41", observed: "42" }],
  };
  return policy;
}

/** A policy that never named a target and its failure domain. */
export function noTargetPolicy() {
  const policy = completedRunPolicy();
  policy.metadata.name = "nightly-unset";
  policy.spec = {
    owner: "alice",
    selector: "app=media",
    schedule: "0 3 * * *",
    consistency: "crash-consistent",
    retention: { keep: 7 },
    drill: { enabled: true },
  };
  return policy;
}

/** A policy that named a path but no failure domain: KOSD-C-41's hint case. */
export function undeterminedDomainPolicy() {
  const policy = completedRunPolicy();
  policy.metadata.name = "nightly-unknown-domain";
  policy.spec.target = { path: "/mnt/backup" };
  return policy;
}

/** projectionOf wraps one kernel object as the control plane's projection. */
export function projectionOf(object, observedAt = OBSERVED_AT) {
  const ref = {
    group: "kos.tsic.top",
    kind: object.kind,
    namespace: object.metadata?.namespace,
    name: object.metadata?.name,
  };
  return { ref, observedAt, stale: false, object };
}

/**
 * fakeControlPlane serves the two control-plane routes this window uses and
 * records every request it received, so a case can assert both the answer and
 * what crossed the wire. `pageSize` splits the policy list into pages the way
 * the control plane does: a page carries its cursor and the next request must
 * echo it. Zero keeps one page, which is the control plane's own default case.
 */
export function fakeControlPlane({
  policies = [],
  observedAt = OBSERVED_AT,
  readFailure = null,
  pageSize = 0,
} = {}) {
  const requests = [];

  async function fetchImpl(url, init = {}) {
    const target = new URL(url);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({
      method,
      path: target.pathname,
      query: Object.fromEntries(target.searchParams),
      body,
      headers: { ...(init.headers ?? {}) },
      credentials: init.credentials,
    });

    if (method === "GET" && target.pathname === "/api/v1/resources/BackupPolicy") {
      if (readFailure) {
        return jsonResponse(readFailure.status ?? 503, { error: readFailure });
      }
      const all = policies.map((policy) => projectionOf(policy, observedAt));
      const cursor = target.searchParams.get("continue") ?? "0";
      const start = Number(cursor);
      const items = pageSize > 0 ? all.slice(start, start + pageSize) : all;
      const next = start + items.length;
      const page = { items };
      if (pageSize > 0 && next < all.length) {
        page.continue = String(next);
      }
      return jsonResponse(200, page);
    }
    if (method === "POST" && target.pathname === "/api/v1/resources/RestoreJob") {
      return jsonResponse(200, {
        accepted: true,
        ref: {
          group: "kos.tsic.top",
          kind: "RestoreJob",
          namespace: body?.metadata?.namespace,
          name: body?.metadata?.name,
        },
      });
    }
    if (method === "POST" && target.pathname === "/api/v1/action-requests") {
      return jsonResponse(200, {
        accepted: true,
        ref: {
          group: "kos.tsic.top",
          kind: body?.kind,
          namespace: body?.namespace,
          name: body?.name,
        },
      });
    }
    return jsonResponse(404, {
      error: {
        code: "not-found",
        message: `没有这个接口：${method} ${target.pathname}`,
        stage: "read",
      },
    });
  }

  return { fetchImpl, requests };
}

/** jsonResponse makes the minimal Response the client reads. */
export function jsonResponse(status, payload) {
  const text = JSON.stringify(payload);
  return {
    ok: status >= 200 && status <= 299,
    status,
    async text() {
      return text;
    },
  };
}
