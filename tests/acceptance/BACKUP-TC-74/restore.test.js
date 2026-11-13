// BACKUP-AC-37 / BACKUP-TC-74: without an in-place declaration the window
// submits a restore to a new instance — a new application and its volumes — and
// leaves the source objects untouched. The result surface then reads the
// restore job's phase, baseline, observed values and differences, and shows the
// created objects next to the preserved source objects (BACKUP-C-3, KOSD-C-39,
// KOSD-C-42).
import assert from "node:assert/strict";
import { test } from "node:test";

import { submitRestore } from "../../../assets/app/actions.js";
import { createControlPlane } from "../../../assets/app/control.js";
import { buildPage, restoreView } from "../../../assets/app/model.js";
import {
  OBSERVED_AT,
  RESTORE_RUN,
  completedRunPolicy,
  fakeControlPlane,
  projectionOf,
  restoreJob,
} from "../fixtures/controlplane.js";

const BASE = "https://console.apps.kos.tsic.top";
const AT_OBSERVATION = new Date(OBSERVED_AT);

function restoreValues(overrides = {}) {
  return {
    name: "media-restore",
    namespace: "home",
    policy: "nightly",
    run: RESTORE_RUN,
    targetApplication: "media-restored",
    ...overrides,
  };
}

test("未声明原地恢复时，提交的是恢复到新实例", async () => {
  const control = fakeControlPlane({ policies: [completedRunPolicy()] });
  const client = createControlPlane({ baseURL: BASE, fetchImpl: control.fetchImpl });

  const answer = await submitRestore(client, restoreValues());

  assert.equal(control.requests.length, 1, "提交只发一个请求，不等待终态");
  const [request] = control.requests;
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/api/v1/resources/RestoreJob");
  assert.equal(request.body.spec.inPlace, false, "未声明时提交的是恢复到新实例");
  assert.equal(request.body.spec.policy, "nightly");
  assert.equal(request.body.spec.run, RESTORE_RUN, "提交用户选中的运行");
  assert.equal(request.body.spec.targetApplication, "media-restored", "目标是新实例的应用名");

  assert.equal(answer.accepted, true, "写请求返回已接受");
  assert.equal(answer.ref.kind, "RestoreJob");
  assert.equal(answer.ref.name, "media-restore");
});

test("恢复到新实例的提交不产生对源对象的写请求", async () => {
  const control = fakeControlPlane({ policies: [completedRunPolicy()] });
  const client = createControlPlane({ baseURL: BASE, fetchImpl: control.fetchImpl });

  await submitRestore(client, restoreValues());

  for (const request of control.requests) {
    assert.equal(request.method, "POST", "只写 RestoreJob，不修改源对象");
    assert.equal(request.path, "/api/v1/resources/RestoreJob");
  }
  assert.equal(control.state.created.length, 1, "恢复作业被接受");
});

test("结果面读出阶段、基线、观测值与差异项", () => {
  const job = restoreJob();
  const view = restoreView(projectionOf(job), AT_OBSERVATION);

  assert.equal(view.name, job.metadata.name);
  assert.equal(view.phase, job.status.phase);
  assert.equal(view.verdict, "Succeeded");
  assert.equal(view.reason, null);
  assert.deepEqual(view.diffs, []);

  assert.deepEqual(view.baseline, job.status.baseline, "基线四项原样读出");
  assert.deepEqual(view.observed, job.status.observed, "观测值四项原样读出");
  assert.equal(view.baseline.tables[0].rows, job.status.baseline.tables[0].rows);
  assert.equal(view.baseline.files, job.status.baseline.files);
  assert.equal(view.baseline.bytes, job.status.baseline.bytes);
  assert.equal(view.baseline.checksum, job.status.baseline.checksum);
});

test("恢复到新实例后出现新应用与新卷，源应用、源卷与源 PVC 保留", () => {
  const job = restoreJob();
  const view = restoreView(projectionOf(job), AT_OBSERVATION);

  assert.equal(view.inPlace, false);
  assert.equal(view.created.application, job.spec.targetApplication, "新应用就是提交的目标应用");
  assert.deepEqual(view.created.volumes, ["media-restored-data"]);
  assert.notEqual(view.created.application, view.source.application, "新应用不是源应用");

  assert.equal(view.source.application, "media", "源应用仍可读出");
  assert.deepEqual(view.source.volumes, ["media-data"], "源卷仍可读出");
  assert.equal(view.source.pvc, "media-data-pvc", "源 PVC 仍可读出");
  assert.equal(view.source.retained, true, "源对象未被删除或改动");
});

test("页面把 RestoreJob 投影归入恢复结果", () => {
  const job = restoreJob();
  const page = buildPage({
    policies: [projectionOf(completedRunPolicy())],
    restores: [projectionOf(job)],
    now: AT_OBSERVATION,
  });

  assert.equal(page.restores.length, 1);
  assert.equal(page.restores[0].name, job.metadata.name);
  assert.equal(page.restores[0].verdict, "Succeeded");
});
