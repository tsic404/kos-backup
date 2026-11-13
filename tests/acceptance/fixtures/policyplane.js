// Fixtures for the policy write cases: a control plane that stores policies the
// way the kernel does — ownership written from the session (KOSD-C-60),
// selectors judged against the applications and volumes they hit, and the
// failure-domain preflight done against a source volume on a reference
// Provider. The judgement belongs to kosd; this fixture only reproduces its
// answers so the cases can assert what the window observed.

import { OBSERVED_AT, completedRunPolicy, jsonResponse, projectionOf } from "./controlplane.js";

/** The three sessions the cases act as, in the identity API's own DTO shape. */
export const SESSION_ALICE = { username: "alice", role: "Member" };
export const SESSION_BOB = { username: "bob", role: "Member" };
export const SESSION_OWNER = { username: "tsic", role: "Owner" };

const POLICY_PATH = "/api/v1/resources/BackupPolicy";
const RESTORE_PATH = "/api/v1/resources/RestoreJob";
const KERNEL_GROUP = "kos.tsic.top";
// The route and the DTO the identity API serves (kosd pkg/identity/api.go):
// GET /api/v1/auth/session answers {username, role, ...}; anything else under
// /api/v1 falls into the control plane's 404 envelope.
const SESSION_PATH = "/api/v1/auth/session";

/** ownedApplication is one application whose owner is known to the control plane. */
export function ownedApplication({ name = "media", owner = "alice", namespace = "home" } = {}) {
  return {
    apiVersion: "kos.tsic.top/v1beta1",
    kind: "Application",
    metadata: { name, namespace, labels: { app: name } },
    spec: { owner },
  };
}

/**
 * sourceVolume is the volume a policy backs up: its physical device and failure
 * domain are what the preflight compares a target against (KOSD-C-41). The
 * device facts come from the reference Provider whose snapshot capability was
 * verified, which is what makes the failure domain knowable at all.
 */
export function sourceVolume({
  name = "media-data",
  owner = "alice",
  namespace = "home",
  app = "media",
  provider = referenceProvider(),
  device = "/dev/disk/by-id/ata-WDC-WD40EFRX-68N",
  failureDomain = "disk-a",
} = {}) {
  return {
    apiVersion: "kos.tsic.top/v1beta1",
    kind: "Volume",
    metadata: { name, namespace, labels: { app } },
    spec: { owner, provider: provider.metadata.name },
    status: { device, failureDomain },
  };
}

/** referenceProvider is the Provider whose snapshot capability was verified (KOSD-C-10). */
export function referenceProvider({ name = "reference-snapshot" } = {}) {
  return {
    apiVersion: "kos.tsic.top/v1beta1",
    kind: "Provider",
    metadata: { name, namespace: "kos-system" },
    spec: { capabilities: [{ name: "snapshot", version: "v1" }] },
    status: { verified: true, verification: { source: "kos", cases: ["snapshot"] } },
  };
}

/** defaultApplications is one application per member. */
export function defaultApplications() {
  return [ownedApplication({ name: "media", owner: "alice" }), ownedApplication({ name: "media-bob", owner: "bob" })];
}

/** defaultVolumes is alice's volume, on a device whose failure domain is known. */
export function defaultVolumes() {
  return [sourceVolume()];
}

/**
 * snapshotOnlyPolicy is a policy whose only record is a snapshot. A snapshot is
 * not a backup: the page must not present it as a completed backup run
 * (KOSD-F-12).
 */
export function snapshotOnlyPolicy() {
  const policy = completedRunPolicy();
  policy.metadata.name = "nightly-snapshot";
  delete policy.status.lastBackup;
  policy.status.lastSnapshot = {
    phase: "Succeeded",
    snapshot: "/snapshots/media-data-2026-03-01",
    completedAt: "2026-03-01T11:57:00Z",
  };
  return policy;
}

/**
 * policyPlane is the control plane the policy cases write to. It keeps the
 * policies it was given by reference, so two sessions can act on one store.
 * Every request is recorded; the cases assert the page and the answers, not
 * this bookkeeping.
 */
export function policyPlane({
  session = SESSION_ALICE,
  applications = defaultApplications(),
  volumes = defaultVolumes(),
  policies = [],
} = {}) {
  const store = policies;
  const requests = [];

  function failure(status, code, message, { stage, object } = {}) {
    return jsonResponse(status, {
      error: {
        code,
        message,
        stage,
        object,
        retryable: false,
        requiresUserAction: true,
        sideEffects: false,
      },
    });
  }

  function refOf(object) {
    return {
      group: KERNEL_GROUP,
      kind: object.kind,
      namespace: object.metadata?.namespace,
      name: object.metadata?.name,
    };
  }

  function accepted(policy) {
    return jsonResponse(200, { accepted: true, ref: refOf(policy) });
  }

  function foreignHit(selector) {
    if (session.role === "Owner") {
      return null;
    }
    const candidates = [
      ...applications.map((object) => ({ object })),
      ...volumes.map((object) => ({ object })),
    ];
    for (const { object } of candidates) {
      if (!matchesSelector(object.metadata?.labels, selector)) {
        continue;
      }
      if (object.spec?.owner === session.username) {
        continue;
      }
      return object;
    }
    return null;
  }

  function sameDomainVolume(spec) {
    const domain = spec?.target?.failureDomain ?? "";
    if (domain === "") {
      return null;
    }
    return volumes.find((volume) => matchesSelector(volume.metadata?.labels, spec.selector) && volume.status?.failureDomain === domain) ?? null;
  }

  function ownerRewritten(spec) {
    return spec?.owner !== undefined;
  }

  function create(body) {
    const spec = body?.spec ?? {};
    if (ownerRewritten(spec)) {
      return failure(403, "owner-immutable", "spec.owner 由控制面按会话写入，提交不能携带它", { stage: "write" });
    }
    const foreign = foreignHit(spec.selector);
    if (foreign) {
      return failure(403, "selector-not-owned", `选择器命中了 ${foreign.kind} ${foreign.metadata.name}，它属于 ${foreign.spec?.owner}`, {
        stage: "write",
        object: refOf(foreign),
      });
    }
    const sameDomain = sameDomainVolume(spec);
    if (sameDomain) {
      return failure(422, "same-failure-domain", sameDomainMessage(spec, sameDomain), {
        stage: "preflight",
        object: refOf(sameDomain),
      });
    }
    const name = body?.metadata?.name ?? "";
    const namespace = body?.metadata?.namespace ?? "";
    const existing = store.find((policy) => policy.metadata.name === name && policy.metadata.namespace === namespace);
    if (existing) {
      if (sameFields(existing.spec, spec)) {
        return accepted(existing);
      }
      return failure(409, "already-exists", `策略 ${name} 已存在且字段不同`, { stage: "write", object: refOf(existing) });
    }
    const policy = {
      apiVersion: body?.apiVersion,
      kind: "BackupPolicy",
      metadata: { name, namespace },
      spec: { ...spec, owner: session.username },
    };
    store.push(policy);
    return accepted(policy);
  }

  function update(name, body) {
    const policy = store.find((item) => item.metadata.name === name);
    if (!policy) {
      return failure(404, "not-found", `没有策略 ${name}`, { stage: "write" });
    }
    const spec = body?.spec ?? {};
    if (ownerRewritten(spec)) {
      return failure(403, "owner-immutable", "spec.owner 由控制面按会话写入，提交不能携带它", { stage: "write", object: refOf(policy) });
    }
    if (session.role !== "Owner" && policy.spec?.owner !== session.username) {
      return failure(403, "not-owner", `策略 ${name} 属于 ${policy.spec?.owner}，${session.username} 不能修改`, {
        stage: "write",
        object: refOf(policy),
      });
    }
    const foreign = foreignHit(spec.selector);
    if (foreign) {
      return failure(403, "selector-not-owned", `选择器命中了 ${foreign.kind} ${foreign.metadata.name}，它属于 ${foreign.spec?.owner}`, {
        stage: "write",
        object: refOf(foreign),
      });
    }
    const sameDomain = sameDomainVolume(spec);
    if (sameDomain) {
      return failure(422, "same-failure-domain", sameDomainMessage(spec, sameDomain), {
        stage: "preflight",
        object: refOf(sameDomain),
      });
    }
    policy.spec = { ...spec, owner: policy.spec?.owner };
    return accepted(policy);
  }

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

    if (method === "GET" && target.pathname === SESSION_PATH) {
      return jsonResponse(200, {
        ...session,
        mustChangePassword: false,
        expiresAt: "2026-03-01T13:00:00Z",
        remainingSeconds: 3600,
        idleRemainingSeconds: 3600,
        absoluteRemainingSeconds: 7200,
      });
    }
    if (method === "GET" && target.pathname === POLICY_PATH) {
      return jsonResponse(200, { items: store.map((policy) => projectionOf(policy, OBSERVED_AT)) });
    }
    if (method === "GET" && target.pathname === RESTORE_PATH) {
      return jsonResponse(200, { items: [] });
    }
    if (method === "POST" && target.pathname === POLICY_PATH) {
      return create(body);
    }
    if (target.pathname.startsWith(`${POLICY_PATH}/`)) {
      const name = decodeURIComponent(target.pathname.slice(POLICY_PATH.length + 1));
      if (method === "GET") {
        const policy = store.find((item) => item.metadata.name === name);
        return policy ? jsonResponse(200, projectionOf(policy, OBSERVED_AT)) : failure(404, "not-found", `没有策略 ${name}`, { stage: "read" });
      }
      if (method === "PUT") {
        return update(name, body);
      }
    }
    return failure(404, "not-found", `没有这个接口：${method} ${target.pathname}`, { stage: "read" });
  }

  return { fetchImpl, requests, state: { policies: store, applications, volumes, session } };
}

function sameDomainMessage(spec, volume) {
  return `目标 ${spec.target?.path ?? ""} 与源卷 ${volume.metadata.name} 位于同一物理设备 ${volume.status.device}（失败域 ${volume.status.failureDomain}）`;
}

function sameFields(left = {}, right = {}) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function matchesSelector(labels, selector) {
  if (!labels || typeof selector !== "string" || selector.trim() === "") {
    return false;
  }
  return selector.split(",").every((part) => {
    const [key, value] = part.split("=").map((piece) => piece.trim());
    return key !== undefined && value !== undefined && labels[key] === value;
  });
}
