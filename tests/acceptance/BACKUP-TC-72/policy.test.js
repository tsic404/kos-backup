// BACKUP-AC-36 / BACKUP-TC-72: a member creates a policy selecting only their
// own application and changes its schedule and retention; then submits a policy
// selecting another member's application. The created policy carries the
// submitted values and the owner the API wrote, the change keeps that owner,
// and the rejected submission names the object it hit while adding no policy.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ControlPlaneError, createControlPlane } from "../../../assets/app/control.js";
import { policyRequest, policyValues, submitPolicy } from "../../../assets/app/policy.js";
import { policyPlane, SESSION_ALICE } from "../fixtures/policyplane.js";

const BASE = "https://backup.apps.kos.tsic.top";

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

const SPEC_FIELDS = ["consistency", "drill", "retention", "schedule", "selector", "target"];

function clientFor(plane) {
  return createControlPlane({ baseURL: BASE, fetchImpl: plane.fetchImpl });
}

async function listPolicies(client) {
  const page = await client.list("BackupPolicy", { namespace: "home" });
  return page.items.map((projection) => projection.object);
}

async function readPolicy(client, name) {
  return client.get("BackupPolicy", { namespace: "home", name });
}

test("创建只命中自己应用的策略，字段等于提交值且所有者由 API 写入", async () => {
  const plane = policyPlane({ session: SESSION_ALICE });
  const client = clientFor(plane);

  const answer = await submitPolicy(client, CREATED);

  assert.equal(plane.requests.length, 1, "提交只发一个请求，不等待终态");
  const request = plane.requests[0];
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/api/v1/resources/BackupPolicy");
  assert.equal(request.query.namespace, "home");
  assert.equal(request.body.kind, "BackupPolicy");
  assert.deepEqual(Object.keys(request.body.spec).sort(), SPEC_FIELDS, "spec 只携带策略的六个部分");
  assert.equal(request.body.spec.owner, undefined, "所有者由 API 按会话写入，请求不携带它");

  assert.equal(answer.accepted, true, "写请求返回已接受与对象引用");
  assert.equal(answer.ref.kind, "BackupPolicy");
  assert.equal(answer.ref.namespace, "home");
  assert.equal(answer.ref.name, "nightly");

  const policy = await readPolicy(client, "nightly");
  const spec = policy.object.spec;
  assert.equal(spec.selector, CREATED.selector);
  assert.equal(spec.schedule, CREATED.schedule);
  assert.equal(spec.consistency, CREATED.consistency);
  assert.deepEqual(spec.target, CREATED.target);
  assert.deepEqual(spec.retention, CREATED.retention);
  assert.deepEqual(spec.drill, CREATED.drill);
  assert.equal(spec.owner, "alice", "所有者是创建者的本地用户名");
});

test("修改计划与保留后字段为新值，所有者不变", async () => {
  const plane = policyPlane({ session: SESSION_ALICE });
  const client = clientFor(plane);
  await submitPolicy(client, CREATED);
  const before = await readPolicy(client, "nightly");

  const formValues = policyValues(before);
  assert.deepEqual(
    formValues,
    {
      selector: CREATED.selector,
      schedule: CREATED.schedule,
      consistency: CREATED.consistency,
      target: CREATED.target,
      retention: CREATED.retention,
      drill: CREATED.drill,
    },
    "修改从读回值开始，六个字段等于提交值",
  );
  assert.equal(formValues.owner, undefined, "所有者不在修改表单里");

  const answer = await submitPolicy(client, {
    name: CREATED.name,
    namespace: CREATED.namespace,
    existing: true,
    ...formValues,
    schedule: "0 5 * * *",
    retention: { keep: 14 },
  });

  const request = plane.requests.at(-1);
  assert.equal(request.method, "PUT");
  assert.equal(request.path, "/api/v1/resources/BackupPolicy/nightly");
  assert.equal(request.query.namespace, "home");
  assert.deepEqual(Object.keys(request.body.spec).sort(), SPEC_FIELDS, "修改走同一字段集合");
  assert.equal(answer.accepted, true);

  const after = (await readPolicy(client, "nightly")).object;
  assert.equal(after.spec.schedule, "0 5 * * *", "计划为新值");
  assert.deepEqual(after.spec.retention, { keep: 14 }, "保留为新值");
  assert.deepEqual(after.spec.target, CREATED.target, "未修改的项保持提交值");
  assert.equal(after.spec.owner, before.object.spec.owner, "所有者不变");
  assert.equal(after.spec.owner, "alice");
});

test("命中他人应用的提交被拒绝、原因可读且没有新策略出现", async () => {
  const plane = policyPlane({ session: SESSION_ALICE });
  const client = clientFor(plane);
  await submitPolicy(client, CREATED);
  const before = await listPolicies(client);

  let rejection = null;
  try {
    await submitPolicy(client, { ...CREATED, name: "nightly-bob", selector: "app=media-bob" });
  } catch (error) {
    rejection = error;
  }

  assert.ok(rejection instanceof ControlPlaneError, "被拒绝的提交抛出控制面错误，而不是返回成功");
  assert.equal(rejection.status, 403);
  assert.equal(rejection.code, "selector-not-owned");
  assert.match(rejection.message, /media-bob/, "原因指向命中的他人应用");
  assert.equal(rejection.envelope.stage, "write");
  assert.equal(rejection.envelope.object.kind, "Application");
  assert.equal(rejection.envelope.object.name, "media-bob");

  const after = await listPolicies(client);
  assert.deepEqual(
    after.map((policy) => policy.metadata.name).sort(),
    before.map((policy) => policy.metadata.name).sort(),
    "被拒前后策略集合一致",
  );
  assert.deepEqual(after.map((policy) => policy.spec), before.map((policy) => policy.spec));
});

test("所有者字段没有提交通道", () => {
  assert.throws(
    () => policyRequest({ ...CREATED, owner: "bob" }),
    (error) => error instanceof TypeError && /spec\.owner/.test(error.message),
    "提交附带所有者时被拒绝，并指向被拒字段",
  );
});

test("非法字段在窗口内被指名字段，不发起请求", async () => {
  const plane = policyPlane({ session: SESSION_ALICE });
  const client = clientFor(plane);

  assert.throws(() => policyRequest({ ...CREATED, consistency: "eventually-consistent" }), /consistency/);
  assert.throws(() => policyRequest({ ...CREATED, selector: "" }), /selector/);
  await assert.rejects(submitPolicy(client, { ...CREATED, selector: "" }), /selector/);
  assert.equal(plane.requests.length, 0, "校验失败时不产生任何请求");
});
