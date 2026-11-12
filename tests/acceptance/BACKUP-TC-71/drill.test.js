// BACKUP-AC-35 / BACKUP-TC-71: a drill that finds the restored data different
// from the baseline leaves the run failed, names the file or byte count that
// differs, and lists every difference. The backup is never presented as a
// success. The drill entry submits the action through the control plane and
// returns acceptance, not a terminal outcome.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ITEM_DRILL, ITEM_RUNS, buildPage } from "../../../assets/app/model.js";
import { createControlPlane } from "../../../assets/app/control.js";
import { submitDrill } from "../../../assets/app/actions.js";
import {
  OBSERVED_AT,
  failedDrillPolicy,
  fakeControlPlane,
  projectionOf,
} from "../fixtures/controlplane.js";

const BASE = "https://console.apps.kos.tsic.top";
const AT_OBSERVATION = new Date(OBSERVED_AT);

test("演练失败时状态为失败，原因指向文件数或字节数并列出差异", () => {
  const policy = failedDrillPolicy();
  const page = buildPage({ policies: [projectionOf(policy)], now: AT_OBSERVATION });
  const items = page.policies[0].items;

  const drill = items[ITEM_DRILL];
  assert.equal(drill.state, "Failed");
  assert.equal(drill.drill.phase, policy.status.lastDrill.phase);
  assert.equal(drill.drill.succeeded, false);
  assert.equal(drill.reason.code, "drill-mismatch");
  assert.match(drill.reason.message, /files|bytes/, "原因指向文件数或字节数不一致");

  assert.deepEqual(
    drill.reason.diffs,
    [{ item: "files", baseline: "41", observed: "42" }],
    "差异项逐条可读",
  );
  assert.deepEqual(drill.drill.diffs, policy.status.lastDrill.diffs);
});

test("演练失败后备份不被标记为成功", () => {
  const policy = failedDrillPolicy();
  const page = buildPage({ policies: [projectionOf(policy)], now: AT_OBSERVATION });
  const run = page.policies[0].items[ITEM_RUNS];

  assert.equal(policy.status.lastBackup.succeeded, false, "夹具里这次运行就不是成功");
  assert.notEqual(run.state, "Succeeded");
  assert.equal(run.state, "Failed");
  assert.equal(run.run.succeeded, false);
  assert.match(run.reason.message, /files|bytes/);
});

test("字节数差异同样给出原因与差异项", () => {
  const policy = failedDrillPolicy();
  policy.status.lastDrill.diffs = [{ item: "bytes", baseline: "1048576", observed: "1048577" }];
  policy.status.lastDrill.reason = "";
  policy.status.lastBackup.diffs = policy.status.lastDrill.diffs;

  const page = buildPage({ policies: [projectionOf(policy)], now: AT_OBSERVATION });
  const drill = page.policies[0].items[ITEM_DRILL];

  assert.equal(drill.state, "Failed");
  assert.match(drill.reason.message, /bytes 1048576→1048577/);
  assert.deepEqual(drill.reason.diffs, [{ item: "bytes", baseline: "1048576", observed: "1048577" }]);
});

test("演练入口提交演练动作并只取回已接受与对象引用", async () => {
  const policy = failedDrillPolicy();
  const control = fakeControlPlane({ policies: [policy] });
  const client = createControlPlane({ baseURL: BASE, fetchImpl: control.fetchImpl });

  const page = await buildPage({
    policies: [projectionOf(policy)],
    now: AT_OBSERVATION,
  });
  const entry = page.policies[0].entries.find((item) => item.id === "drill");
  assert.equal(entry.available, true, "有运行记录时演练入口可用");

  const answer = await submitDrill(client, {
    namespace: policy.metadata.namespace,
    name: policy.metadata.name,
  });

  const drillRequests = control.requests.filter(
    (request) => request.path === "/api/v1/action-requests",
  );
  assert.equal(drillRequests.length, 1, "提交后不再轮询，不等待终态");
  assert.equal(drillRequests[0].method, "POST");
  assert.deepEqual(drillRequests[0].body, {
    kind: "BackupPolicy",
    namespace: policy.metadata.namespace,
    name: policy.metadata.name,
    action: "drill",
  });

  assert.equal(answer.accepted, true, "写请求返回已接受");
  assert.equal(answer.ref.kind, "BackupPolicy");
  assert.equal(answer.ref.name, policy.metadata.name);
  assert.equal(answer.state, undefined, "答案不是终态，进度从对象状态读取");
});

test("同一演练动作重复提交是两次请求，客户端不缓存也不去重", async () => {
  const policy = failedDrillPolicy();
  const control = fakeControlPlane({ policies: [policy] });
  const client = createControlPlane({ baseURL: BASE, fetchImpl: control.fetchImpl });

  const target = { namespace: policy.metadata.namespace, name: policy.metadata.name };
  const first = await submitDrill(client, target);
  const second = await submitDrill(client, target);

  assert.equal(control.requests.length, 2);
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.deepEqual(first.ref, second.ref, "重复提交指向同一对象（KOSD-C-12 幂等）");
});
