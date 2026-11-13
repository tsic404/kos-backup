// BACKUP-AC-37 / BACKUP-TC-75: declaring an in-place restore shows the stop
// requirement; a submission while the application is still running is rejected
// with a reason that points at the application not being stopped, and creates
// no restore job or other side effect. Once the application is stopped the same
// submission is accepted, and the finished restore leaves the source
// application object and the source PVC in place (BACKUP-C-3, KOSD-C-39,
// KOSD-C-41).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  restoreDeclaration,
  submitRestoreEntry,
} from "../../../assets/app/actions.js";
import { createControlPlane } from "../../../assets/app/control.js";
import { restoreView } from "../../../assets/app/model.js";
import {
  OBSERVED_AT,
  RESTORE_RUN,
  fakeControlPlane,
  projectionOf,
  restoreJob,
} from "../fixtures/controlplane.js";

const BASE = "https://console.apps.kos.tsic.top";
const AT_OBSERVATION = new Date(OBSERVED_AT);
const IN_PLACE_VALUES = {
  name: "media-inplace",
  namespace: "home",
  policy: "nightly",
  run: RESTORE_RUN,
  targetApplication: "media",
  inPlace: true,
};

test("原地恢复必须显式声明，声明后进入停机要求", () => {
  const defaulted = restoreDeclaration(false);
  assert.equal(defaulted.inPlace, false, "默认不是原地恢复");
  assert.equal(defaulted.stopRequired, false, "未声明时不要求停机");

  const declared = restoreDeclaration(true);
  assert.equal(declared.inPlace, true);
  assert.equal(declared.stopRequired, true, "声明后入口要求应用停机");
});

test("应用运行中提交原地恢复被拒绝，原因指向未停机且不产生恢复作业", async () => {
  const control = fakeControlPlane({ appRunning: true });
  const client = createControlPlane({ baseURL: BASE, fetchImpl: control.fetchImpl });

  const outcome = await submitRestoreEntry(client, IN_PLACE_VALUES);

  assert.equal(outcome.accepted, false, "运行中的提交未被接受");
  assert.equal(outcome.ref, null);
  assert.equal(outcome.reason.code, "application-running");
  assert.match(outcome.reason.message, /未停机/, "原因指向应用未停机");
  assert.match(outcome.reason.message, /media/, "原因指出未停机的应用");

  assert.equal(control.requests.length, 1, "拒绝路径只发一次提交，不重试");
  assert.equal(control.state.created.length, 0, "拒绝路径不产生恢复作业");
  for (const request of control.requests) {
    assert.equal(request.method, "POST", "拒绝路径不修改或删除源对象");
    assert.equal(request.path, "/api/v1/resources/RestoreJob", "拒绝路径不写其他对象");
  }
});

test("应用到新实例的恢复不受停机门限制", async () => {
  const control = fakeControlPlane({ appRunning: true });
  const client = createControlPlane({ baseURL: BASE, fetchImpl: control.fetchImpl });

  const outcome = await submitRestoreEntry(client, {
    ...IN_PLACE_VALUES,
    name: "media-restore",
    targetApplication: "media-restored",
    inPlace: false,
  });

  assert.equal(outcome.accepted, true, "新实例恢复不覆盖源应用，不需要停机");
  assert.equal(outcome.reason, null);
  assert.equal(control.state.created.length, 1);
  assert.equal(control.state.created[0].spec.inPlace, false);
});

test("停机后同一提交被接受，且只写恢复作业", async () => {
  const control = fakeControlPlane({ appRunning: true });
  const client = createControlPlane({ baseURL: BASE, fetchImpl: control.fetchImpl });

  const rejected = await submitRestoreEntry(client, IN_PLACE_VALUES);
  control.state.appRunning = false;
  const accepted = await submitRestoreEntry(client, IN_PLACE_VALUES);

  assert.equal(rejected.accepted, false);
  assert.equal(accepted.accepted, true, "停机后同一提交被接受");
  assert.equal(accepted.reason, null);
  assert.equal(accepted.ref.kind, "RestoreJob");
  assert.equal(accepted.ref.name, "media-inplace");

  assert.equal(control.requests.length, 2, "两次提交各发一次请求，不重试");
  assert.equal(control.state.created.length, 1, "停机后恰好产生一个恢复作业");
  assert.equal(control.state.created[0].spec.inPlace, true);
  assert.deepEqual(control.state.created[0].spec, {
    policy: "nightly",
    run: RESTORE_RUN,
    targetApplication: "media",
    inPlace: true,
  });
});

test("原地恢复完成后源应用对象仍存在、源 PVC 未被删除", () => {
  const job = restoreJob({ inPlace: true });
  const view = restoreView(projectionOf(job), AT_OBSERVATION);

  assert.equal(view.inPlace, true);
  assert.equal(view.source.application, "media", "源应用对象仍可读出");
  assert.equal(view.source.pvc, "media-data-pvc", "源 PVC 仍在");
  assert.equal(view.source.retained, true, "源对象未被删除");
  assert.equal(view.created.application, "", "原地恢复不新建应用");
  assert.deepEqual(view.created.volumes, [], "原地恢复不新建卷");
});
