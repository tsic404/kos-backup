// BACKUP-AC-34 / BACKUP-TC-70: a backup target on the same physical device as
// the source volume is rejected by the preflight with a readable reason and no
// successful record follows; a snapshot is never presented as a backup. When
// the failure domain cannot be determined the policy is accepted and the page
// keeps showing the hint.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ControlPlaneError, createControlPlane } from "../../../assets/app/control.js";
import { ITEM_POLICY, ITEM_RUNS, ITEM_TARGET, STATE_NONE, STATE_UNDETERMINED, buildPage } from "../../../assets/app/model.js";
import { submitPolicy } from "../../../assets/app/policy.js";
import { OBSERVED_AT, completedRunPolicy, projectionOf } from "../fixtures/controlplane.js";
import { SESSION_ALICE, policyPlane, referenceProvider, snapshotOnlyPolicy, sourceVolume } from "../fixtures/policyplane.js";

const BASE = "https://backup.apps.kos.tsic.top";
const AT_OBSERVATION = new Date(OBSERVED_AT);

const SUBMITTED = {
  name: "nightly",
  namespace: "home",
  selector: "app=media",
  schedule: "0 3 * * *",
  consistency: "crash-consistent",
  retention: { keep: 7 },
  drill: { enabled: true },
};

function clientFor(plane) {
  return createControlPlane({ baseURL: BASE, fetchImpl: plane.fetchImpl });
}

async function pageOf(client) {
  const page = await client.list("BackupPolicy", { namespace: "home" });
  return buildPage({ policies: page.items, now: AT_OBSERVATION });
}

test("目标与源卷同一物理设备时预检拒绝、原因可读且不产生策略", async () => {
  const provider = referenceProvider();
  const volume = sourceVolume({ provider });
  const plane = policyPlane({ session: SESSION_ALICE, volumes: [volume] });
  const client = clientFor(plane);

  let rejection = null;
  try {
    await submitPolicy(client, {
      ...SUBMITTED,
      target: { path: "/mnt/backup", failureDomain: volume.status.failureDomain },
    });
  } catch (error) {
    rejection = error;
  }

  assert.ok(rejection instanceof ControlPlaneError, "同一失败域的提交被拒绝，而不是返回成功");
  assert.equal(rejection.code, "same-failure-domain");
  assert.match(rejection.message, /同一物理设备/, "原因指出同失败域");
  assert.ok(rejection.message.includes(volume.status.device), "原因给出源卷的物理设备");
  assert.ok(rejection.message.includes(volume.metadata.name), "原因给出源卷");
  assert.equal(rejection.envelope.object.kind, "Volume");
  assert.equal(rejection.envelope.stage, "preflight");

  const page = await pageOf(client);
  assert.equal(page.policies.length, 0, "被拒绝的提交不产生策略，也没有成功记录");
});

test("只有快照记录时不呈现为备份", () => {
  const policy = snapshotOnlyPolicy();
  assert.ok(policy.status.lastSnapshot, "夹具里只有一次快照");

  const page = buildPage({ policies: [projectionOf(policy)], now: AT_OBSERVATION });
  const runs = page.policies[0].items[ITEM_RUNS];
  assert.equal(runs.state, STATE_NONE, "快照不构成一次备份运行");
  assert.notEqual(runs.state, "Succeeded");
  assert.equal(runs.run, null);
  assert.equal(runs.reason.code, "no-run");
});

test("无法判定失败域时允许提交，并在每次读取时持续提示", async () => {
  const plane = policyPlane({ session: SESSION_ALICE });
  const client = clientFor(plane);

  const answer = await submitPolicy(client, { ...SUBMITTED, target: { path: "/mnt/backup" } });
  assert.equal(answer.accepted, true, "无法判定失败域时允许提交");

  for (const reading of [1, 2]) {
    const page = await pageOf(client);
    const target = page.policies[0].items[ITEM_TARGET];
    assert.equal(target.state, STATE_UNDETERMINED, `第 ${reading} 次读取仍给出无法判定`);
    assert.equal(target.reason.code, "failure-domain-undetermined");
    assert.match(target.reason.message, /失败域/);
  }
});

test("对象记录了预检失败时原因可读，且没有成功记录", () => {
  const policy = completedRunPolicy();
  delete policy.status.lastBackup;
  policy.status.conditions = [
    {
      type: "PreflightPassed",
      status: "False",
      reason: "SameFailureDomain",
      message: "目标 /mnt/backup 与源卷 media-data 位于同一物理设备 /dev/disk/by-id/ata-WDC-WD40EFRX-68N",
    },
  ];

  const page = buildPage({ policies: [projectionOf(policy)], now: AT_OBSERVATION });
  const items = page.policies[0].items;

  assert.equal(items[ITEM_POLICY].reason.code, "SameFailureDomain", "预检拒绝的原因可读");
  assert.match(items[ITEM_POLICY].reason.message, /同一物理设备/);
  assert.equal(items[ITEM_RUNS].state, STATE_NONE, "没有成功记录");
  assert.equal(items[ITEM_RUNS].run, null);
});
