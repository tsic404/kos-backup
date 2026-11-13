// The two actions the backup window offers (BACKUP-C-1): a restore and a drill.
// Both are control-plane writes, so the caller gets acceptance and the object
// they target and reads progress from that object's state; neither call waits
// for a terminal state and neither retries (KOSD-C-12).
//
// A restore defaults to a new instance: KOSD-C-41 and BACKUP-C-3 require the
// in-place form to be declared explicitly. The declaration is what makes the
// entry show the stop requirement, and the control plane still judges whether
// the application is stopped: a submission while it runs is rejected with a
// reason, and no restore job is written (KOSD-C-41). This module adds no second
// gate, so the window never disagrees with the control plane's judgement.

/** The kernel kind a restore writes (KOSD-C-41). */
export const RESTORE_KIND = "RestoreJob";

/** The kernel API version the objects are written in. */
export const KERNEL_API_VERSION = "kos.tsic.top/v1beta1";

/** The action that triggers one drill through the control plane (KOSD-C-42). */
export const DRILL_ACTION = "drill";

/** The kind a drill action targets: a drill verifies one policy's last run. */
export const DRILL_KIND = "BackupPolicy";

/**
 * restoreDeclaration is the restore form's two shapes. Without a declaration
 * the form submits a new instance and asks for nothing else; a declared
 * in-place restore requires the application to be stopped first (BACKUP-C-3).
 *
 * @param {boolean} inPlace
 */
export function restoreDeclaration(inPlace) {
  const declared = inPlace === true;
  return { inPlace: declared, stopRequired: declared };
}

/**
 * restoreRequest builds the RestoreJob document for one restore. The run names
 * the backup instance the restore reads; without `inPlace` the target
 * application is a new instance and the source objects are left untouched
 * (BACKUP-C-3).
 *
 * @param {{name: string, namespace: string, policy: string, run: string,
 *          targetApplication: string, inPlace?: boolean}} options
 */
export function restoreRequest({
  name,
  namespace,
  policy,
  run,
  targetApplication,
  inPlace = false,
}) {
  if (!name) {
    throw new TypeError("恢复作业需要名字");
  }
  if (!namespace) {
    throw new TypeError("恢复作业需要命名空间");
  }
  if (!policy) {
    throw new TypeError("恢复作业需要给出被恢复的策略");
  }
  if (!run) {
    throw new TypeError("恢复作业需要给出被恢复的运行");
  }
  if (!targetApplication) {
    throw new TypeError("恢复作业需要给出目标应用");
  }
  return {
    apiVersion: KERNEL_API_VERSION,
    kind: RESTORE_KIND,
    metadata: { name, namespace },
    spec: {
      policy,
      run,
      targetApplication,
      inPlace: inPlace === true,
    },
  };
}

/**
 * submitRestore submits the restore request and returns the control plane's
 * answer: acceptance and the object it targets (KOSD-C-12).
 *
 * @param {ReturnType<import("./control.js").createControlPlane>} client
 * @param {Parameters<typeof restoreRequest>[0]} options
 * @returns {Promise<{accepted: boolean, ref?: object, idempotent?: boolean}>}
 */
export async function submitRestore(client, options) {
  const request = restoreRequest(options);
  return client.create(RESTORE_KIND, {
    namespace: request.metadata.namespace,
    object: request,
  });
}

/**
 * submitRestoreEntry submits one restore entry and turns the control plane's
 * judgement into the two outcomes the entry can show: accepted with the object
 * it targets, or rejected with the reason. A rejection is not retried and does
 * not submit a second request, so a refused in-place restore writes nothing
 * (KOSD-C-41).
 *
 * @param {ReturnType<import("./control.js").createControlPlane>} client
 * @param {Parameters<typeof restoreRequest>[0]} options
 * @returns {Promise<{accepted: boolean, ref: object|null,
 *                    reason: {code: string, message: string}|null}>}
 */
export async function submitRestoreEntry(client, options) {
  try {
    const answer = await submitRestore(client, options);
    if (answer?.accepted === true) {
      return { accepted: true, ref: answer.ref ?? null, reason: null };
    }
    return {
      accepted: false,
      ref: null,
      reason: { code: "not-accepted", message: "控制面未接受恢复请求" },
    };
  } catch (error) {
    return { accepted: false, ref: null, reason: failureReason(error) };
  }
}

/**
 * drillRequest builds the action request that asks the control plane to verify
 * one policy's last run (KOSD-C-42). It is an action on the policy object, not
 * a window-private call: the kernel owns the drill and records its phases in
 * the policy's status (KOSD-C-12).
 *
 * @param {{namespace: string, name: string}} target
 */
export function drillRequest({ namespace, name }) {
  if (!namespace) {
    throw new TypeError("演练动作需要命名空间");
  }
  if (!name) {
    throw new TypeError("演练动作需要策略名字");
  }
  return {
    kind: DRILL_KIND,
    namespace,
    name,
    action: DRILL_ACTION,
  };
}

/**
 * submitDrill submits one drill action and returns the control plane's answer:
 * acceptance and the policy it targets. The drill's progress and its
 * differences are read from the policy's status (KOSD-C-12, KOSD-C-42).
 *
 * @param {ReturnType<import("./control.js").createControlPlane>} client
 * @param {{namespace: string, name: string}} target
 * @returns {Promise<{accepted: boolean, ref?: object, idempotent?: boolean}>}
 */
export async function submitDrill(client, target) {
  return client.act(drillRequest(target));
}

/** failureReason keeps the control plane's code and message for display. */
function failureReason(error) {
  const envelope = error?.envelope ?? {};
  return {
    code: envelope.code || error?.code || "request-failed",
    message: envelope.message || error?.message || "控制面请求失败",
  };
}
