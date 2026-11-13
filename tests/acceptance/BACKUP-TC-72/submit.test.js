// BACKUP-AC-36 / BACKUP-TC-72, submission path: a policy form is submitted
// through the window's own mount, and the answer is what a reader sees — an
// accepted write is announced as acceptance and the policy appears; a rejected
// one stays rejected with its reason and no policy. The root and the form are
// the minimal elements mount() touches, so the window's wiring is exercised
// without a browser.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createControlPlane } from "../../../assets/app/control.js";
import { mount } from "../../../assets/app/main.js";
import { OBSERVED_AT } from "../fixtures/controlplane.js";
import { SESSION_ALICE, policyPlane } from "../fixtures/policyplane.js";

const BASE = "https://backup.apps.kos.tsic.top";
const AT_OBSERVATION = new Date(OBSERVED_AT);

class Element {}

class FormDataStub {
  constructor(form) {
    this.form = form;
  }
  get(name) {
    return this.form.entries.has(name) ? this.form.entries.get(name) : null;
  }
}

let restore = null;

before(() => {
  const hadElement = Object.hasOwn(globalThis, "Element");
  const hadFormData = Object.hasOwn(globalThis, "FormData");
  const element = globalThis.Element;
  const formData = globalThis.FormData;
  globalThis.Element = Element;
  globalThis.FormData = FormDataStub;
  restore = () => {
    if (hadElement) {
      globalThis.Element = element;
    } else {
      delete globalThis.Element;
    }
    if (hadFormData) {
      globalThis.FormData = formData;
    } else {
      delete globalThis.FormData;
    }
  };
});

after(() => {
  restore?.();
});

function rootElement() {
  const handlers = {};
  return {
    innerHTML: "",
    attributes: {},
    handlers,
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    addEventListener(type, handler) {
      handlers[type] = handler;
    },
  };
}

function noticeElement() {
  return { dataset: {}, textContent: "" };
}

function submit(form) {
  const target = Object.assign(new Element(), { closest: () => form });
  return { target, preventDefault() {} };
}

function formOf(entry, form, entries) {
  return Object.assign(new Element(), { dataset: { entry, form }, entries: new Map(Object.entries(entries)) });
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`等待超时：${label}`);
}

const FIELDS = {
  name: "nightly",
  namespace: "home",
  selector: "app=media",
  schedule: "0 3 * * *",
  consistency: "crash-consistent",
  targetPath: "/mnt/backup",
  failureDomain: "disk-b",
  retentionKeep: "7",
  drill: "on",
};

test("提交被接受后页面给出已接受并显示该策略", async () => {
  const plane = policyPlane({ session: SESSION_ALICE });
  const client = createControlPlane({ baseURL: BASE, fetchImpl: plane.fetchImpl });
  const root = rootElement();
  const notice = noticeElement();
  await mount(root, { client, notice, now: () => AT_OBSERVATION, namespace: "home" });

  assert.ok(root.innerHTML.includes('data-entry="policy"'), "页面提供新建入口");
  root.handlers.submit(submit(formOf("policy", "create", FIELDS)));

  await waitFor(() => notice.textContent.includes("策略创建已接受"), "提示给出已接受");
  assert.match(notice.textContent, /BackupPolicy home\/nightly/, "提示给出对象引用");
  assert.equal(notice.dataset.tone, "info");

  await waitFor(() => root.innerHTML.includes('data-policy="home/nightly"'), "刷新后显示新策略");
  assert.ok(root.innerHTML.includes('data-entry="edit"'), "创建者随后可以修改");
  assert.equal(root.attributes["aria-busy"], undefined, "读取结束后不再标记忙碌");
});

test("提交被拒绝后提示与表单都给出原因，页面不显示该策略", async () => {
  const plane = policyPlane({ session: SESSION_ALICE });
  const client = createControlPlane({ baseURL: BASE, fetchImpl: plane.fetchImpl });
  const root = rootElement();
  const notice = noticeElement();
  await mount(root, { client, notice, now: () => AT_OBSERVATION, namespace: "home" });

  root.handlers.submit(submit(formOf("policy", "create", { ...FIELDS, name: "nightly-bob", selector: "app=media-bob" })));

  await waitFor(() => notice.dataset.tone === "error", "提示给出失败");
  assert.ok(notice.textContent.includes("selector-not-owned"), "提示给出稳定错误代码");

  const reason = root.innerHTML.match(/<p[^>]*data-form-reason[^>]*>[\s\S]*?<\/p>/)?.[0] ?? "";
  assert.match(reason, /data-code="selector-not-owned"/, "表单层给出原因");
  assert.match(reason, /data-object="Application home\/media-bob"/, "原因指向被拒对象");
  assert.ok(!root.innerHTML.includes("已接受"), "失败不呈现为成功");
  assert.ok(!root.innerHTML.includes('data-policy="home/nightly-bob"'), "被拒的提交不产生策略");
});
