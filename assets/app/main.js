// Boots the backup window: the session the write entries are gated by, the
// policy list and the restore jobs read page by page from the control plane,
// the page model, the display layer and the writes. Create and change share
// policy.js's one construction path; a rejected submission keeps the typed
// values and shows its reason in the form that carried it, and an accepted one
// is announced as acceptance, never as a terminal outcome (KOSD-C-12,
// BACKUP-C-2). The restore entry keeps its own declaration and outcome.

import { restoreDeclaration, submitDrill, submitRestoreEntry } from "./actions.js";
import { createControlPlane } from "./control.js";
import { ENTRY_EDIT, buildPage, buildUnreadablePage } from "./model.js";
import { submitPolicy } from "./policy.js";
import {
  ENTRY_CREATE,
  FORM_CREATE,
  renderDeclaration,
  renderEntryOutcome,
  renderWindow,
  restoreSubmitLabel,
} from "./render.js";

const POLICY_KIND = "BackupPolicy";
const RESTORE_KIND = "RestoreJob";

/**
 * mount wires one window document to one control-plane client.
 *
 * @param {HTMLElement} root the window document's root element
 * @param {{client: ReturnType<import("./control.js").createControlPlane>,
 *          notice?: HTMLElement|null, now?: () => Date, namespace?: string}} options
 */
export function mount(root, { client, notice = null, now = () => new Date(), namespace = "" } = {}) {
  if (!root) {
    throw new TypeError("备份窗口需要一个根元素");
  }
  if (!client) {
    throw new TypeError("备份窗口需要控制面客户端");
  }

  let isBusy = false;
  let source = { policies: [], restores: [], session: null, sessionFailure: null };
  let rejection = null;

  function showNotice(message, tone = "info") {
    if (!notice) {
      return;
    }
    notice.dataset.tone = tone;
    notice.textContent = message;
  }

  function paint() {
    root.innerHTML = renderWindow(buildPage({ ...source, now: now(), namespace, rejection }));
  }

  async function refresh({ announcement = null } = {}) {
    if (isBusy) {
      return;
    }
    isBusy = true;
    root.setAttribute("aria-busy", "true");
    try {
      source = await readSource(client);
      rejection = null;
      paint();
      // A read clears the last answer; a write hands its answer over so the
      // acceptance stays readable after the refreshed page is painted.
      showNotice(announcement?.message ?? "", announcement?.tone ?? "info");
    } catch (error) {
      root.innerHTML = renderWindow(buildUnreadablePage({ error, now: now() }));
      showNotice(describeFailure(error), "error");
    } finally {
      isBusy = false;
      root.removeAttribute("aria-busy");
    }
  }

  async function submitPolicyForm(form) {
    if (isBusy) {
      return;
    }
    isBusy = true;
    root.setAttribute("aria-busy", "true");
    const fields = new FormData(form);
    const submitted = {
      name: field(fields, "name"),
      namespace: field(fields, "namespace"),
      ...policyFormValues(fields),
    };
    const isChange = form.dataset.entry === ENTRY_EDIT;
    try {
      const answer = await submitPolicy(client, { ...submitted, existing: isChange });
      const message = describeAnswer(isChange ? "策略修改" : "策略创建", answer);
      rejection = null;
      isBusy = false;
      await refresh({ announcement: { message, tone: answer?.accepted === true ? "info" : "error" } });
    } catch (error) {
      // The typed values stay on screen with the reason: the rejected write is
      // shown as rejected, and the policy list is the one already read.
      rejection = rejectionOf(error, form.dataset.form ?? FORM_CREATE, submitted);
      paint();
      showNotice(describeFailure(error), "error");
    } finally {
      isBusy = false;
      root.removeAttribute("aria-busy");
    }
  }

  async function submitEntry(form) {
    if (isBusy) {
      return;
    }
    isBusy = true;
    const values = new FormData(form);
    try {
      if (form.dataset.entry === "restore") {
        const outcome = await submitRestoreEntry(client, {
          name: field(values, "name"),
          namespace: field(values, "namespace"),
          policy: field(values, "policy"),
          run: field(values, "run"),
          targetApplication: field(values, "targetApplication"),
          inPlace: values.get("inPlace") === "on",
        });
        showOutcome(form, outcome);
        showNotice(describeOutcome("恢复", outcome), outcome.accepted ? "info" : "error");
      } else {
        const answer = await submitDrill(client, {
          namespace: field(values, "namespace"),
          name: field(values, "name"),
        });
        showNotice(describeAnswer("演练", answer), answer?.accepted === true ? "info" : "error");
      }
    } catch (error) {
      showNotice(describeFailure(error), "error");
    } finally {
      isBusy = false;
    }
  }

  root.addEventListener("submit", (event) => {
    const form = event.target instanceof Element ? event.target.closest("form[data-entry]") : null;
    if (!form) {
      return;
    }
    event.preventDefault();
    const entry = form.dataset.entry;
    if (entry === ENTRY_CREATE || entry === ENTRY_EDIT) {
      submitPolicyForm(form);
      return;
    }
    submitEntry(form);
  });

  root.addEventListener("change", (event) => {
    const input =
      event.target instanceof Element
        ? event.target.closest("form[data-entry='restore'] input[name='inPlace']")
        : null;
    if (!input) {
      return;
    }
    const form = input.closest("form");
    const declaration = restoreDeclaration(input.checked);
    const slot = form?.querySelector("[data-declaration]");
    if (slot) {
      slot.innerHTML = renderDeclaration(declaration.stopRequired);
    }
    const button = form?.querySelector("button[data-action='restore']");
    if (button) {
      button.textContent = restoreSubmitLabel(declaration.stopRequired);
    }
  });

  root.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button[data-action='reload']") : null;
    if (button) {
      refresh();
    }
  });

  return refresh();
}

/**
 * loadPage reads the session, the policy list and the restore jobs, then builds
 * the page the window renders. A session that cannot be read gates every policy
 * closed: an unproven session gets no write entry (BACKUP-C-2, KOSD-C-60).
 *
 * @param {ReturnType<import("./control.js").createControlPlane>} client
 * @param {{now?: () => Date, namespace?: string, rejection?: object|null}} [options]
 */
export async function loadPage(client, { now = () => new Date(), namespace = "", rejection = null } = {}) {
  const source = await readSource(client);
  return buildPage({ ...source, now: now(), namespace, rejection });
}

/**
 * policyFormValues reads one submitted form as the six parts of KOSD-C-41. An
 * absent target, retention or drill stays absent, so the spec carries only what
 * the user set; the owner is not read because the form has no such field.
 *
 * @param {{get: (name: string) => FormDataEntryValue|null}} values
 */
export function policyFormValues(values) {
  const keep = field(values, "retentionKeep");
  return {
    selector: field(values, "selector"),
    schedule: field(values, "schedule"),
    consistency: field(values, "consistency"),
    target: { path: field(values, "targetPath"), failureDomain: field(values, "failureDomain") },
    retention: keep === "" ? undefined : { keep: Number(keep) },
    drill: { enabled: values.get("drill") === "on" },
  };
}

/**
 * rejectionOf turns one rejected write into what the form shows: the control
 * plane's code and message, the object it points at, and the field a local
 * validation named. The submitted values travel with it so the form keeps them.
 */
export function rejectionOf(error, form, values) {
  const envelope = error?.envelope ?? {};
  const object = envelope.object && typeof envelope.object === "object" ? envelope.object : null;
  return {
    form,
    code: envelope.code || error?.code || "write-rejected",
    message: envelope.message || error?.message || "策略提交被拒绝",
    field: typeof error?.field === "string" ? error.field : "",
    object: object
      ? { kind: object.kind ?? "", namespace: object.namespace ?? "", name: object.name ?? "" }
      : null,
    values,
  };
}

/**
 * readSource reads the session, every page of the policy list and every page of
 * the restore list. The page size is the control plane's own (KOSD-C-12), so the
 * window follows the returned cursor: an object past the first page is still
 * one the page presents.
 */
async function readSource(client) {
  const { session, failure } = await readSession(client);
  return {
    session,
    sessionFailure: failure,
    policies: await readAll(client, POLICY_KIND),
    restores: await readAll(client, RESTORE_KIND),
  };
}

/**
 * readSession reads the session the write entries are judged against. An
 * unreadable session is no session — every policy is then unmanageable, the
 * closed side of the gate — and the failure is kept so the page can name why
 * no entry is offered (KOSD-C-59, KOSD-C-60).
 */
async function readSession(client) {
  try {
    return { session: await client.session(), failure: null };
  } catch (error) {
    const envelope = error?.envelope ?? {};
    return {
      session: null,
      failure: {
        code: envelope.code || error?.code || "session-unreadable",
        message: envelope.message || error?.message || "控制面无法读取会话",
      },
    };
  }
}

/**
 * readAll reads every page of one kind's list. The page size is the control
 * plane's own (KOSD-C-12), so the window follows the returned cursor: an object
 * past the first page is still one the page presents.
 */
async function readAll(client, kind) {
  const items = [];
  const seen = new Set();
  let cursor = "";
  for (;;) {
    const page = await client.list(kind, cursor === "" ? {} : { continue: cursor });
    items.push(...page.items);
    cursor = typeof page.continue === "string" ? page.continue : "";
    if (cursor === "") {
      return items;
    }
    if (seen.has(cursor)) {
      throw new Error("控制面返回了重复的分页游标");
    }
    seen.add(cursor);
  }
}

/**
 * boot starts the window document its entry serves. Credentials are the host
 * handshake's business (KOSD-C-75); this window adds none of its own.
 */
export function boot() {
  const root = document.querySelector("#backup-window");
  if (!root) {
    return Promise.resolve();
  }
  const notice = document.querySelector("#backup-notice");
  const client = createControlPlane({ baseURL: window.location.origin });
  return mount(root, { client, notice, namespace: root.dataset.namespace ?? "" });
}

function field(values, name) {
  const value = values.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function showOutcome(form, outcome) {
  const slot = form.querySelector("[data-entry-outcome-slot]");
  if (slot) {
    slot.innerHTML = renderEntryOutcome(outcome);
  }
}

function describeOutcome(label, outcome) {
  if (outcome?.accepted === true) {
    return describeAnswer(label, outcome);
  }
  const reason = outcome?.reason ?? {};
  return `${reason.message || "恢复请求未被接受"}（${reason.code || "request-failed"}）`;
}

function describeAnswer(label, answer) {
  if (answer?.accepted !== true) {
    return `${label}未被接受`;
  }
  const ref = answer.ref ?? {};
  const where = [ref.namespace, ref.name].filter((part) => Boolean(part)).join("/");
  const kind = ref.kind ? `${ref.kind} ` : "";
  return `${label}已接受：${kind}${where}`;
}

function describeFailure(error) {
  const envelope = error?.envelope ?? {};
  const code = envelope.code || error?.code || "request-failed";
  const message = envelope.message || error?.message || "控制面请求失败";
  const retry = envelope.retryable === true ? "，可重试" : "";
  return `${message}（${code}${retry}）`;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  boot();
}
