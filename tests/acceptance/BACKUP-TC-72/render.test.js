// BACKUP-AC-36 / BACKUP-TC-72, display layer: the create form and the change
// form carry the six parts KOSD-C-41 names and no owner; a change starts from
// the values read back; and a rejected submission is shown in the form that
// carried it, naming the object it hit, while the policy set does not change.
// The expectations come from the frozen contract, not from the renderer.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createControlPlane } from "../../../assets/app/control.js";
import { ENTRY_EDIT } from "../../../assets/app/model.js";
import { loadPage, policyFormValues, rejectionOf } from "../../../assets/app/main.js";
import { CONSISTENCY_LEVELS, policyValues, submitPolicy } from "../../../assets/app/policy.js";
import { ENTRY_CREATE, FORM_CREATE, formIdOf, renderWindow } from "../../../assets/app/render.js";
import { OBSERVED_AT } from "../fixtures/controlplane.js";
import { attributeIn, entryMarkup, formValues, policyMarkup, visibleText } from "../fixtures/display.js";
import { SESSION_ALICE, policyPlane } from "../fixtures/policyplane.js";

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

const FORM_PARTS = ["selector", "schedule", "consistency", "targetPath", "failureDomain", "retentionKeep", "drill"];

function clientFor(plane) {
  return createControlPlane({ baseURL: BASE, fetchImpl: plane.fetchImpl });
}

function readPage(client, rejection = null) {
  return loadPage(client, { now: () => AT_OBSERVATION, namespace: "home", rejection });
}

function formReason(markup) {
  return markup.match(/<p[^>]*data-form-reason[^>]*>[\s\S]*?<\/p>/)?.[0] ?? "";
}

test("新建与修改表单渲染策略的六个部分，都不渲染所有者", async () => {
  const plane = policyPlane({ session: SESSION_ALICE });
  const client = clientFor(plane);
  await submitPolicy(client, CREATED);

  const html = renderWindow(await readPage(client));

  const createForm = entryMarkup(html, ENTRY_CREATE);
  assert.notEqual(createForm, "", "页面提供新建入口");
  const editForm = entryMarkup(policyMarkup(html, "home/nightly"), ENTRY_EDIT);
  assert.notEqual(editForm, "", "自己的策略提供修改入口");

  for (const form of [createForm, editForm]) {
    for (const name of FORM_PARTS) {
      assert.ok(form.includes(`name="${name}"`), `策略表单缺少 ${name} 字段`);
    }
    assert.ok(!/name="owner"/.test(form), "策略提交不携带所有者");
    assert.ok(!visibleText(form).includes("所有者"), "策略表单不渲染所有者");
    for (const level of CONSISTENCY_LEVELS) {
      assert.ok(form.includes(`value="${level}"`), `一致性等级缺少 ${level} 选项`);
    }
  }
});

test("修改表单回填等于读回值，并与新建走同一字段集合", async () => {
  const plane = policyPlane({ session: SESSION_ALICE });
  const client = clientFor(plane);
  await submitPolicy(client, CREATED);

  const html = renderWindow(await readPage(client));
  const projection = await client.get("BackupPolicy", { namespace: "home", name: "nightly" });
  const readBack = policyValues(projection);

  const form = entryMarkup(policyMarkup(html, "home/nightly"), ENTRY_EDIT);
  assert.equal(attributeIn(form, "data-form"), "home/nightly", "修改表单归属于该策略");
  assert.deepEqual(policyFormValues(formValues(form)), readBack, "回填的六个字段等于读回值");
  assert.equal(attributeIn(form, "data-policy"), "home/nightly");

  const answer = await submitPolicy(client, {
    name: "nightly",
    namespace: "home",
    existing: true,
    ...readBack,
    schedule: "0 5 * * *",
    retention: { keep: 14 },
  });
  assert.equal(answer.accepted, true);

  const created = plane.requests.find((request) => request.method === "POST");
  const changed = plane.requests.at(-1);
  assert.equal(changed.method, "PUT");
  assert.deepEqual(
    Object.keys(changed.body.spec).sort(),
    Object.keys(created.body.spec).sort(),
    "新建与修改携带同一字段集合",
  );
  assert.equal(changed.body.spec.owner, undefined, "修改不携带所有者");

  const after = await client.get("BackupPolicy", { namespace: "home", name: "nightly" });
  assert.equal(after.object.spec.schedule, "0 5 * * *", "计划为新值");
  assert.deepEqual(after.object.spec.retention, { keep: 14 }, "保留为新值");
  assert.equal(after.object.spec.owner, "alice", "所有者不变");
});

test("被拒提交在表单层给出原因并指向被拒对象，不呈现为成功", async () => {
  const plane = policyPlane({ session: SESSION_ALICE });
  const client = clientFor(plane);
  await submitPolicy(client, CREATED);
  const before = (await client.list("BackupPolicy", { namespace: "home" })).items.map(
    (projection) => projection.object.metadata.name,
  );

  const editForm = entryMarkup(policyMarkup(renderWindow(await readPage(client)), "home/nightly"), ENTRY_EDIT);
  const typed = { ...policyFormValues(formValues(editForm)), selector: "app=media-bob" };
  const submitted = { name: "nightly-bob", namespace: "home", ...typed };

  let rejection = null;
  try {
    await submitPolicy(client, submitted);
  } catch (error) {
    rejection = error;
  }
  assert.ok(rejection, "命中他人应用的提交被拒绝");

  const reason = rejectionOf(rejection, FORM_CREATE, submitted);
  const page = await readPage(client, reason);
  const html = renderWindow(page);
  const block = formReason(entryMarkup(html, ENTRY_CREATE));

  assert.equal(attributeIn(block, "data-code"), "selector-not-owned");
  assert.equal(attributeIn(block, "data-object"), "Application home/media-bob", "原因指向被拒对象");
  assert.match(visibleText(block), /media-bob/, "原因可读并给出命中的对象");
  assert.ok(!visibleText(html).includes("已接受"), "被拒的提交不呈现为成功");
  assert.equal(
    formValues(entryMarkup(html, ENTRY_CREATE)).get("selector"),
    "app=media-bob",
    "被拒后在表单里保留提交值",
  );
  assert.deepEqual(
    page.policies.map((view) => view.name).sort(),
    [...before].sort(),
    "被拒前后策略集合不变",
  );
  assert.equal(policyMarkup(html, "home/nightly-bob"), "", "没有新策略出现");
});

test("字段校验失败指向被拒字段，且不发起写请求", async () => {
  const plane = policyPlane({ session: SESSION_ALICE });
  const client = clientFor(plane);

  const submitted = {
    name: "nightly",
    namespace: "home",
    selector: "app=media",
    schedule: "0 3 * * *",
    consistency: "crash-consistent",
    target: { path: "" },
    retention: { keep: 0 },
    drill: { enabled: true },
  };
  let rejection = null;
  try {
    await submitPolicy(client, submitted);
  } catch (error) {
    rejection = error;
  }
  assert.equal(rejection.field, "retention.keep", "被拒字段是保留份数");

  const html = renderWindow(await readPage(client, rejectionOf(rejection, FORM_CREATE, submitted)));
  const form = entryMarkup(html, ENTRY_CREATE);
  const block = formReason(form);

  assert.equal(attributeIn(block, "data-field"), "retention.keep", "原因指向被拒字段");
  assert.match(visibleText(block), /retention\.keep/);
  const keepInput = form.match(/<input[^>]*name="retentionKeep"[^>]*>/)[0];
  assert.match(keepInput, /aria-invalid="true"/, "被拒字段在表单上标出");
  assert.equal(plane.requests.filter((request) => request.method !== "GET").length, 0, "本地校验失败不发起写请求");
});

test("新建表单提交的六个部分走同一构造，且不携带所有者", async () => {
  const plane = policyPlane({ session: SESSION_ALICE });
  const client = clientFor(plane);

  const createForm = entryMarkup(renderWindow(await readPage(client)), ENTRY_CREATE);
  const rendered = formValues(createForm);
  const typed = new Map(
    ["name", "namespace", "selector", "schedule", "consistency", "targetPath", "failureDomain", "retentionKeep"].map(
      (name) => [name, rendered.get(name) ?? ""],
    ),
  );
  typed.set("name", "nightly");
  typed.set("namespace", "home");
  typed.set("selector", "app=media");
  typed.set("schedule", "0 3 * * *");
  typed.set("consistency", "crash-consistent");
  typed.set("drill", "on");

  const values = policyFormValues({ get: (name) => typed.get(name) ?? null });
  assert.deepEqual(values, {
    selector: "app=media",
    schedule: "0 3 * * *",
    consistency: "crash-consistent",
    target: { path: "", failureDomain: "" },
    retention: undefined,
    drill: { enabled: true },
  }, "表单读出的就是策略的六个部分");

  const answer = await submitPolicy(client, { name: "nightly", namespace: "home", ...values });
  assert.equal(answer.accepted, true);

  const request = plane.requests.at(-1);
  assert.equal(request.method, "POST");
  assert.deepEqual(Object.keys(request.body.spec).sort(), ["consistency", "drill", "schedule", "selector"]);
  assert.equal(request.body.spec.owner, undefined);

  const page = await readPage(client);
  assert.equal(formIdOf(page.policies[0]), "home/nightly");
  assert.equal(page.policies[0].values.selector, "app=media", "创建后读回的字段等于提交值");
});
