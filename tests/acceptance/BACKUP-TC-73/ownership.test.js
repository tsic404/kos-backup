// BACKUP-AC-36 / BACKUP-TC-73: another member opens the policy list, looks for
// the edit entry of a policy they do not own, and submits a change directly.
// The entry is not offered, the direct submission is rejected with a readable
// reason pointing at the policy, and the policy keeps its fields.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ControlPlaneError, createControlPlane } from "../../../assets/app/control.js";
import { ENTRY_EDIT, buildPage } from "../../../assets/app/model.js";
import { submitPolicy } from "../../../assets/app/policy.js";
import { OBSERVED_AT } from "../fixtures/controlplane.js";
import { SESSION_ALICE, SESSION_BOB, SESSION_OWNER, policyPlane } from "../fixtures/policyplane.js";

const BASE = "https://backup.apps.kos.tsic.top";
const AT_OBSERVATION = new Date(OBSERVED_AT);

const CREATED = {
  name: "nightly",
  namespace: "home",
  selector: "app=media",
  schedule: "0 3 * * *",
  consistency: "crash-consistent",
  target: { path: "/mnt/backup", failureDomain: "disk-b" },
  retention: { keep: 7 },
  drill: { enabled: true },
};

function clientFor(plane) {
  return createControlPlane({ baseURL: BASE, fetchImpl: plane.fetchImpl });
}

async function pageOf(client, session) {
  const page = await client.list("BackupPolicy", { namespace: "home" });
  return buildPage({ policies: page.items, session, now: AT_OBSERVATION });
}

async function createAlicePolicy(store) {
  const plane = policyPlane({ session: SESSION_ALICE, policies: store });
  await submitPolicy(clientFor(plane), CREATED);
}

test("另一成员看到的策略没有修改入口", async () => {
  const store = [];
  await createAlicePolicy(store);

  const bobPlane = policyPlane({ session: SESSION_BOB, policies: store });
  const bobClient = clientFor(bobPlane);
  const session = await bobClient.session();
  assert.equal(session.username, "bob", "会话 DTO 以 username 给出账号");
  assert.equal(session.role, "Member", "会话 DTO 给出角色");

  const page = await pageOf(bobClient, session);
  assert.equal(page.policies.length, 1);
  const view = page.policies[0];
  assert.equal(view.name, "nightly");
  assert.equal(view.manageable, false, "非所有者的会话不能管理该策略");
  assert.ok(!view.entries.some((entry) => entry.id === ENTRY_EDIT), "没有修改入口");
});

test("所有者与策略所有者本身都有修改入口", async () => {
  const store = [];
  await createAlicePolicy(store);

  const alicePlane = policyPlane({ session: SESSION_ALICE, policies: store });
  const aliceClient = clientFor(alicePlane);
  const alicePage = await pageOf(aliceClient, await aliceClient.session());
  assert.equal(alicePage.policies[0].manageable, true, "创建者管理自己的策略");
  assert.ok(alicePage.policies[0].entries.some((entry) => entry.id === ENTRY_EDIT));

  const ownerPlane = policyPlane({ session: SESSION_OWNER, policies: store });
  const ownerClient = clientFor(ownerPlane);
  const ownerPage = await pageOf(ownerClient, await ownerClient.session());
  assert.equal(ownerPage.policies[0].manageable, true, "全局 Owner 写全部");
});

test("无所有者的策略只由 Owner 管理", async () => {
  const ownerless = {
    apiVersion: "kos.tsic.top/v1beta1",
    kind: "BackupPolicy",
    metadata: { name: "synced", namespace: "home" },
    spec: { selector: "app=media", schedule: "0 3 * * *", consistency: "crash-consistent" },
  };
  const store = [ownerless];

  const bobPlane = policyPlane({ session: SESSION_BOB, policies: store });
  const bobClient = clientFor(bobPlane);
  const bobPage = await pageOf(bobClient, await bobClient.session());
  assert.equal(bobPage.policies[0].manageable, false);
  assert.ok(!bobPage.policies[0].entries.some((entry) => entry.id === ENTRY_EDIT));

  const ownerPlane = policyPlane({ session: SESSION_OWNER, policies: store });
  const ownerClient = clientFor(ownerPlane);
  const ownerPage = await pageOf(ownerClient, await ownerClient.session());
  assert.equal(ownerPage.policies[0].manageable, true);
});

test("直接提交的修改被拒绝、原因可读且策略字段不变", async () => {
  const store = [];
  await createAlicePolicy(store);
  const before = structuredClone(store[0].spec);

  const bobPlane = policyPlane({ session: SESSION_BOB, policies: store });
  const bobClient = clientFor(bobPlane);

  let rejection = null;
  try {
    await submitPolicy(bobClient, { ...CREATED, existing: true, schedule: "0 1 * * *" });
  } catch (error) {
    rejection = error;
  }

  assert.ok(rejection instanceof ControlPlaneError, "直接提交被拒绝，而不是返回成功");
  assert.equal(rejection.status, 403);
  assert.equal(rejection.code, "not-owner");
  assert.match(rejection.message, /nightly/, "原因指向被拒策略");
  assert.equal(rejection.envelope.object.kind, "BackupPolicy");
  assert.equal(rejection.envelope.object.name, "nightly");

  const after = await bobClient.get("BackupPolicy", { namespace: "home", name: "nightly" });
  assert.deepEqual(after.object.spec, before, "策略字段不变");
});
