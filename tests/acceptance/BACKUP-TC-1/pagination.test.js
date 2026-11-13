// BACKUP-AC-1 / BACKUP-TC-1, paging: the control plane hands the policy list
// over one page at a time, and the window still shows every policy with its
// four items (BACKUP-C-1). Rendering only the first page drops the rest while
// the page keeps looking like a complete list.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createControlPlane } from "../../../assets/app/control.js";
import { mount } from "../../../assets/app/main.js";
import {
  OBSERVED_AT,
  completedRunPolicy,
  fakeControlPlane,
  noTargetPolicy,
} from "../fixtures/controlplane.js";

const BASE = "https://console.apps.kos.tsic.top";
const AT_OBSERVATION = new Date(OBSERVED_AT);
const ITEM_IDS = ["policy", "runs", "target", "drill"];

/** rootElement is the document root mount() writes the page into. */
function rootElement() {
  return {
    innerHTML: "",
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    addEventListener() {},
  };
}

function countOf(html, needle) {
  return html.split(needle).length - 1;
}

function policyReads(control) {
  return control.requests.filter(
    (request) => request.method === "GET" && request.path === "/api/v1/resources/BackupPolicy",
  );
}

/** sessionReads are the reads of the session the write entries are gated by. */
function sessionReads(control) {
  return control.requests.filter((request) => request.path === "/api/v1/auth/session");
}

/** restoreReads are the reads of the restore list, one page per refresh. */
function restoreReads(control) {
  return control.requests.filter((request) => request.path === "/api/v1/resources/RestoreJob");
}

function namedPolicy(policy, name) {
  policy.metadata.name = name;
  return policy;
}

function idOf(policy) {
  const { name, namespace } = policy.metadata;
  return namespace ? `${namespace}/${name}` : name;
}

test("单页读完后不再发请求，页面显示全部策略", async () => {
  const policy = namedPolicy(completedRunPolicy(), "nightly-01");
  const control = fakeControlPlane({ policies: [policy] });
  const client = createControlPlane({ baseURL: BASE, fetchImpl: control.fetchImpl });
  const root = rootElement();

  await mount(root, { client, now: () => AT_OBSERVATION });

  assert.equal(policyReads(control).length, 1, "没有游标时不再读取下一页");
  assert.equal(sessionReads(control).length, 1, "一次刷新只读一次会话");
  assert.equal(restoreReads(control).length, 1, "一次刷新只读一次恢复作业列表");
  assert.equal(control.requests.length, 3, "一次刷新只发会话、策略与恢复三个请求");
  assert.ok(root.innerHTML.includes(`data-policy="${idOf(policy)}"`));
  for (const itemId of ITEM_IDS) {
    assert.equal(countOf(root.innerHTML, `data-item="${itemId}"`), 1, `「${itemId}」项未渲染`);
  }
});

test("游标未读完时继续读取，第二页的策略与四项视图也渲染", async () => {
  const first = namedPolicy(completedRunPolicy(), "nightly-01");
  const second = namedPolicy(noTargetPolicy(), "nightly-51");
  const control = fakeControlPlane({ policies: [first, second], pageSize: 1 });
  const client = createControlPlane({ baseURL: BASE, fetchImpl: control.fetchImpl });
  const root = rootElement();

  await mount(root, { client, now: () => AT_OBSERVATION });

  const reads = policyReads(control);
  assert.equal(reads.length, 2, "游标存在时必须读下一页");
  assert.equal(reads[1].query.continue, "1", "下一页请求带回上一页的游标");

  for (const policy of [first, second]) {
    assert.ok(root.innerHTML.includes(`data-policy="${idOf(policy)}"`), `策略 ${idOf(policy)} 未渲染`);
  }
  for (const itemId of ITEM_IDS) {
    assert.equal(countOf(root.innerHTML, `data-item="${itemId}"`), 2, `第二页的「${itemId}」项未渲染`);
  }
  assert.ok(root.innerHTML.includes('data-code="target-unconfigured"'), "第二页目标未配置的原因未渲染");
});
