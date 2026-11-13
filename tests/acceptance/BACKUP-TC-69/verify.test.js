// BACKUP-AC-34 / BACKUP-TC-69: a restore to a new instance is judged by the
// four items the contract fixes — each table's row count, the volume's file
// count, its total bytes and its content checksum. All four equal is a success;
// any difference is a failure that lists what differs. A restore job that
// reports Succeeded while the four items differ is not presented as a success
// (KOSD-C-42).
import assert from "node:assert/strict";
import { test } from "node:test";

import { submitRestore } from "../../../assets/app/actions.js";
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

function viewOf(job) {
  return restoreView(projectionOf(job), AT_OBSERVATION);
}

test("四项全等时恢复判定成功", () => {
  const job = restoreJob();
  const view = viewOf(job);

  assert.equal(view.verdict, "Succeeded", "四项全等判成功");
  assert.equal(view.reason, null);
  assert.deepEqual(view.diffs, []);
  assert.deepEqual(view.observed, view.baseline);
});

test("表按名比较行数，顺序不影响判定", () => {
  const job = restoreJob();
  job.status.observed.tables = [...job.status.observed.tables].reverse();
  const view = viewOf(job);

  assert.equal(view.verdict, "Succeeded", "同一组表的行数相同即全等");
});

test("文件数不一致时判失败并列出差异", () => {
  const job = restoreJob();
  assert.equal(job.status.phase, "Succeeded", "恢复作业自身报了成功");
  job.status.observed.files = 42;
  const view = viewOf(job);

  assert.equal(view.verdict, "Failed", "四项不等时不呈现成功");
  assert.equal(view.reason.code, "restore-mismatch");
  assert.deepEqual(view.diffs, [{ item: "files", baseline: "41", observed: "42" }]);
  assert.match(view.reason.message, /files/);
});

test("表行数不一致时按表列出差异", () => {
  const job = restoreJob();
  job.status.observed.tables[0].rows = 119;
  const view = viewOf(job);

  assert.equal(view.verdict, "Failed");
  assert.deepEqual(view.diffs, [{ item: "tables.orders", baseline: "120", observed: "119" }]);
});

test("总字节数与校验和不一致时判失败", () => {
  const job = restoreJob();
  job.status.observed.bytes = 1048577;
  job.status.observed.checksum = "sha256:beef";
  const view = viewOf(job);

  assert.equal(view.verdict, "Failed");
  assert.deepEqual(view.diffs, [
    { item: "bytes", baseline: "1048576", observed: "1048577" },
    { item: "checksum", baseline: "sha256:2f9c", observed: "sha256:beef" },
  ]);
});

test("恢复作业报失败时保留原因与差异项", () => {
  const job = restoreJob({
    phase: "Failed",
    reason: "恢复数据与基线不一致：files 41→42",
    diffs: [{ item: "files", baseline: "41", observed: "42" }],
  });
  const view = viewOf(job);

  assert.equal(view.verdict, "Failed");
  assert.equal(view.reason.code, "restore-failed");
  assert.match(view.reason.message, /files/, "原因可读");
  assert.deepEqual(view.diffs, [{ item: "files", baseline: "41", observed: "42" }]);
});

test("缺少基线或观测值时不能判成功", () => {
  const job = restoreJob();
  delete job.status.observed;
  const view = viewOf(job);

  assert.notEqual(view.verdict, "Succeeded", "没有观测值就不能声称四项全等");
  assert.equal(view.verdict, "Failed");
  assert.equal(view.reason.code, "restore-unverified");
  assert.equal(view.observed, null, "缺失的观测值不渲染成零值");
});

test("恢复到新实例只写恢复作业，原应用对象未被改动", async () => {
  const control = fakeControlPlane();
  const client = createControlPlane({ baseURL: BASE, fetchImpl: control.fetchImpl });

  await submitRestore(client, {
    name: "media-restore",
    namespace: "home",
    policy: "nightly",
    run: RESTORE_RUN,
    targetApplication: "media-restored",
  });

  assert.deepEqual(
    control.requests.map((request) => [request.method, request.path]),
    [["POST", "/api/v1/resources/RestoreJob"]],
    "恢复只写 RestoreJob，不改动源应用、源卷或源 PVC",
  );

  const view = viewOf(restoreJob());
  assert.equal(view.source.retained, true, "结果面记录源对象保留");
  assert.notEqual(view.created.application, view.source.application);
});
