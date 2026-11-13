// BACKUP-AC-36 / BACKUP-TC-73, display layer: another member's page offers no
// edit entry for a policy they do not own, the owner's page does, and a change
// submitted anyway is shown as rejected against the policy while the policy
// keeps its fields. The session the window gates on is read from the control
// plane on every page.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createControlPlane } from "../../../assets/app/control.js";
import { ENTRY_EDIT } from "../../../assets/app/model.js";
import { loadPage, policyFormValues, rejectionOf } from "../../../assets/app/main.js";
import { policyValues, submitPolicy } from "../../../assets/app/policy.js";
import { formIdOf, renderWindow } from "../../../assets/app/render.js";
import { OBSERVED_AT, jsonResponse } from "../fixtures/controlplane.js";
import { attributeIn, entryMarkup, formValues, policyMarkup, visibleText } from "../fixtures/display.js";
import { SESSION_ALICE, SESSION_BOB, policyPlane } from "../fixtures/policyplane.js";

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

function readPage(client, rejection = null) {
  return loadPage(client, { now: () => AT_OBSERVATION, namespace: "home", rejection });
}

async function storeWithAlicePolicy() {
  const store = [];
  await submitPolicy(clientFor(policyPlane({ session: SESSION_ALICE, policies: store })), CREATED);
  return store;
}

test("另一成员读到的策略没有修改入口，读取与恢复入口仍在", async () => {
  const store = await storeWithAlicePolicy();
  const bobPlane = policyPlane({ session: SESSION_BOB, policies: store });
  const bobClient = clientFor(bobPlane);

  const page = await readPage(bobClient);
  assert.equal(bobPlane.requests[0].path, "/api/v1/auth/session", "窗口先读取会话再决定入口");
  assert.deepEqual(
    bobPlane.requests.map((request) => request.path),
    ["/api/v1/auth/session", "/api/v1/resources/BackupPolicy", "/api/v1/resources/RestoreJob"],
  );

  const view = page.policies[0];
  assert.equal(view.manageable, false);
  assert.ok(!view.entries.some((entry) => entry.id === ENTRY_EDIT), "没有修改入口");

  const html = renderWindow(page);
  assert.equal(entryMarkup(html, ENTRY_EDIT), "", "页面不渲染修改表单");
  assert.ok(!policyMarkup(html, "home/nightly").includes(`data-entry="${ENTRY_EDIT}"`), "该策略上没有改写通道");
  assert.notEqual(entryMarkup(html, "restore"), "", "读取与恢复入口仍在");
});

test("会话不可读时不提供修改入口", async () => {
  const store = await storeWithAlicePolicy();
  const alicePlane = policyPlane({ session: SESSION_ALICE, policies: store });
  const fetchImpl = async (url, init = {}) => {
    if (new URL(url).pathname === "/api/v1/auth/session") {
      return jsonResponse(403, { error: { code: "unauthenticated", message: "会话不可读", stage: "read" } });
    }
    return alicePlane.fetchImpl(url, init);
  };
  const client = createControlPlane({ baseURL: BASE, fetchImpl });

  const page = await readPage(client);
  assert.equal(page.policies[0].manageable, false, "无法证明会话时不开放写入口");

  const html = renderWindow(page);
  assert.equal(entryMarkup(html, ENTRY_EDIT), "", "没有修改入口");
  const reason = html.match(/<p[^>]*data-session-reason[^>]*>[\s\S]*?<\/p>/)?.[0] ?? "";
  assert.equal(attributeIn(reason, "data-code"), "unauthenticated", "页面给出会话读取失败的原因");
  assert.match(visibleText(reason), /没有修改入口/, "原因说明入口为何缺失");
  assert.match(visibleText(reason), /会话不可读/, "原因来自控制面的说明");
});

test("所有者的页面提供修改入口，并回填读回值", async () => {
  const store = await storeWithAlicePolicy();
  const alicePlane = policyPlane({ session: SESSION_ALICE, policies: store });
  const aliceClient = clientFor(alicePlane);

  const page = await readPage(aliceClient);
  assert.equal(page.policies[0].manageable, true);

  const html = renderWindow(page);
  const form = entryMarkup(policyMarkup(html, "home/nightly"), ENTRY_EDIT);
  assert.notEqual(form, "", "所有者有修改入口");
  assert.equal(attributeIn(form, "data-form"), "home/nightly");

  const projection = await aliceClient.get("BackupPolicy", { namespace: "home", name: "nightly" });
  assert.deepEqual(policyFormValues(formValues(form)), policyValues(projection), "回填等于读回值");
});

test("直接提交的修改被拒绝，原因指向被拒策略且字段不变", async () => {
  const store = await storeWithAlicePolicy();
  const before = structuredClone(store[0].spec);

  const bobPlane = policyPlane({ session: SESSION_BOB, policies: store });
  const bobClient = clientFor(bobPlane);

  let rejection = null;
  try {
    await submitPolicy(bobClient, { ...CREATED, existing: true, schedule: "0 1 * * *" });
  } catch (error) {
    rejection = error;
  }
  assert.ok(rejection, "直接提交被拒绝");

  const submitted = { name: "nightly", namespace: "home", ...policyValues({ object: { spec: before } }) };
  const reason = rejectionOf(rejection, formIdOf({ namespace: "home", name: "nightly" }), submitted);
  const page = await readPage(bobClient, reason);
  const html = renderWindow(page);

  assert.equal(entryMarkup(html, ENTRY_EDIT), "", "仍然没有修改入口");
  const block = html.match(/<p[^>]*data-page-rejection[^>]*>[\s\S]*?<\/p>/)?.[0] ?? "";
  assert.equal(attributeIn(block, "data-code"), "not-owner");
  assert.equal(attributeIn(block, "data-object"), "BackupPolicy home/nightly", "原因指向被拒策略");
  assert.match(visibleText(block), /nightly/, "原因可读");
  assert.ok(!visibleText(html).includes("已接受"), "被拒的修改不呈现为成功");

  const after = await bobClient.get("BackupPolicy", { namespace: "home", name: "nightly" });
  assert.deepEqual(after.object.spec, before, "策略字段不变");
  assert.match(visibleText(policyMarkup(html, "home/nightly")), /0 3 \* \* \*/, "页面仍显示原计划");
});
