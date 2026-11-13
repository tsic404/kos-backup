// Policy writes (BACKUP-C-2): one construction and submission path for a new
// policy and for a change to an existing one. The spec is the six parts
// KOSD-C-41 names. Ownership is the control plane's write from the session
// (KOSD-C-60), so no request carries `owner` and the window offers no channel
// to rewrite it; a value outside the contract is rejected here, named by its
// field, before anything crosses the wire.
//
// A rejected submission throws the control plane's error unchanged: the caller
// shows the reason it names and never reports the write as a success. The
// failure-domain judgement belongs to kosd's preflight (KOSD-C-41); this
// module carries the submission and the answer.

import { KERNEL_API_VERSION } from "./actions.js";

/** The kernel kind a policy is written as (KOSD-C-41). */
export const POLICY_KIND = "BackupPolicy";

/** The three consistency levels KOSD-C-41 allows. */
export const CONSISTENCY_CRASH = "crash-consistent";
export const CONSISTENCY_QUIESCED = "quiesced-consistent";
export const CONSISTENCY_HOOK = "application-hook";
export const CONSISTENCY_LEVELS = Object.freeze([CONSISTENCY_CRASH, CONSISTENCY_QUIESCED, CONSISTENCY_HOOK]);

/** The roles KOSD-C-59 grants writes by; ownership itself is KOSD-C-60. */
export const ROLE_OWNER = "Owner";
export const ROLE_MEMBER = "Member";

/**
 * PolicyValueError is one submitted value the contract does not allow. It names
 * the field it rejected, so the window can point at the input that carried it
 * (BACKUP-C-2).
 */
export class PolicyValueError extends TypeError {
  constructor(field, message) {
    super(message);
    this.name = "PolicyValueError";
    this.field = field;
  }
}

/**
 * policySpec validates the submitted values and returns the six-part spec of
 * KOSD-C-41. Unknown parts are never copied: the spec is built from the named
 * fields, so no other field has a way through.
 */
export function policySpec(values = {}) {
  if (values.owner !== undefined) {
    throw new PolicyValueError("owner", "spec.owner 由控制面按会话写入，策略提交不携带它");
  }
  const spec = {
    selector: requireText(values.selector, "selector", "选择器"),
    schedule: requireText(values.schedule, "schedule", "计划"),
    consistency: requireConsistency(values.consistency),
  };
  const target = optionalTarget(values.target);
  if (target !== null) {
    spec.target = target;
  }
  const retention = optionalRetention(values.retention);
  if (retention !== null) {
    spec.retention = retention;
  }
  const drill = optionalDrill(values.drill);
  if (drill !== null) {
    spec.drill = drill;
  }
  return spec;
}

/**
 * policyRequest builds the BackupPolicy document one submission carries. Both
 * a new policy and a change build it here, so the field set cannot drift.
 */
export function policyRequest({ name, namespace, ...values }) {
  return {
    apiVersion: KERNEL_API_VERSION,
    kind: POLICY_KIND,
    metadata: {
      name: requireText(name, "name", "策略名称"),
      namespace: requireText(namespace, "namespace", "命名空间"),
    },
    spec: policySpec(values),
  };
}

/**
 * policyValues reads the six parts back from a projection, for filling the
 * form a change starts from. The owner is not among them: it is read-only.
 */
export function policyValues(projection) {
  const spec = projection?.object?.spec ?? {};
  const retention = {};
  if (Number.isInteger(spec.retention?.keep)) {
    retention.keep = spec.retention.keep;
  }
  return {
    selector: spec.selector ?? "",
    schedule: spec.schedule ?? "",
    consistency: spec.consistency ?? "",
    target: { path: spec.target?.path ?? "", failureDomain: spec.target?.failureDomain ?? "" },
    retention,
    drill: { enabled: spec.drill?.enabled === true },
  };
}

/**
 * submitPolicy submits one policy document and returns the control plane's
 * answer: acceptance and the object it targets (KOSD-C-12). `existing` selects
 * the update of that object instead of a creation; both share the construction
 * above. A rejection throws and adds no policy.
 */
export async function submitPolicy(client, { existing = false, ...options } = {}) {
  const request = policyRequest(options);
  const ref = { namespace: request.metadata.namespace, name: request.metadata.name };
  if (existing === true) {
    return client.update(POLICY_KIND, { ...ref, object: request });
  }
  return client.create(POLICY_KIND, { namespace: ref.namespace, object: request });
}

/**
 * canManagePolicy reports whether this session may write a policy: an Owner
 * writes every policy, a Member only the ones they own, and a policy with no
 * owner is managed by an Owner alone (KOSD-C-59, KOSD-C-60).
 */
export function canManagePolicy(policy, session) {
  const owner = typeof policy?.spec?.owner === "string" ? policy.spec.owner : "";
  if (session?.role === ROLE_OWNER) {
    return true;
  }
  if (session?.role === ROLE_MEMBER && owner !== "") {
    return owner === session.username;
  }
  return false;
}

function requireText(value, field, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") {
    throw new PolicyValueError(field, `策略需要${label}（${field}）`);
  }
  return text;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function requireConsistency(value) {
  const level = requireText(value, "consistency", "一致性等级");
  if (!CONSISTENCY_LEVELS.includes(level)) {
    throw new PolicyValueError("consistency", `一致性等级（consistency）取值为 ${CONSISTENCY_LEVELS.join("、")}`);
  }
  return level;
}

function optionalTarget(value) {
  if (value === undefined || value === null) {
    return null;
  }
  requireObject(value, "target", "目标");
  const path = text(value.path);
  const failureDomain = text(value.failureDomain);
  if (path === "" && failureDomain === "") {
    return null;
  }
  if (path === "") {
    throw new PolicyValueError("target.path", "目标需要路径（target.path）");
  }
  return { path, failureDomain };
}

function optionalRetention(value) {
  if (value === undefined || value === null) {
    return null;
  }
  requireObject(value, "retention", "保留");
  if (value.keep === undefined) {
    return null;
  }
  if (!Number.isInteger(value.keep) || value.keep < 1) {
    throw new PolicyValueError("retention.keep", "保留份数（retention.keep）必须是正整数");
  }
  return { keep: value.keep };
}

function optionalDrill(value) {
  if (value === undefined || value === null) {
    return null;
  }
  requireObject(value, "drill", "演练");
  if (value.enabled === undefined) {
    return null;
  }
  if (typeof value.enabled !== "boolean") {
    throw new PolicyValueError("drill.enabled", "演练开关（drill.enabled）必须是布尔值");
  }
  return { enabled: value.enabled };
}

function requireObject(value, field, label) {
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyValueError(field, `${label}（${field}）必须是对象`);
  }
}
