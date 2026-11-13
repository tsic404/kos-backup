// The two actions the backup window offers (BACKUP-C-1): a restore and a drill.
// Both are control-plane writes, so the caller gets acceptance and the object
// they target and reads progress from that object's state; neither call waits
// for a terminal state and neither retries (KOSD-C-12).
//
// A restore defaults to a new instance: KOSD-C-41 and BACKUP-C-3 require the
// in-place form to be declared explicitly, so `inPlace` is false unless the
// caller says otherwise. The in-place declaration, its stop gate and the
// restore form itself belong to the restore task; this module carries the
// default submission only.

/** The kernel kind a restore writes (KOSD-C-41). */
export const RESTORE_KIND = "RestoreJob";

/** The kernel API version the objects are written in. */
export const KERNEL_API_VERSION = "kos.tsic.top/v1beta1";

/** The action that triggers one drill through the control plane (KOSD-C-42). */
export const DRILL_ACTION = "drill";

/** The kind a drill action targets: a drill verifies one policy's last run. */
export const DRILL_KIND = "BackupPolicy";

/**
 * restoreRequest builds the RestoreJob document for one restore. Without
 * `inPlace` the target application is a new instance and the source objects are
 * left untouched (BACKUP-C-3).
 *
 * @param {{name: string, namespace: string, policy: string,
 *          targetApplication: string, inPlace?: boolean}} options
 */
export function restoreRequest({ name, namespace, policy, targetApplication, inPlace = false }) {
  if (!name) {
    throw new TypeError("恢复作业需要名字");
  }
  if (!namespace) {
    throw new TypeError("恢复作业需要命名空间");
  }
  if (!policy) {
    throw new TypeError("恢复作业需要给出被恢复的策略");
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
 * @param {{name: string, namespace: string, policy: string,
 *          targetApplication: string, inPlace?: boolean}} options
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
