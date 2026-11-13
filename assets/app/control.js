// The control-plane API is this window's only data path (KOSD-C-12): reads
// return a projection with its observation time, writes return acceptance and
// the object they target, and a long operation is followed through the object's
// state. One call is exactly one request: the client keeps no cache, retries
// nothing and follows no cursor on its own (SDK-C-2).
//
// The console session never reaches this window (KOSD-C-75); the caller passes
// whatever credential the deployment requires in `headers`, so this module adds
// no authentication field of its own.

/** The failure code the control plane uses when a projection cannot be read. */
export class ControlPlaneError extends Error {
  /**
   * @param {{status: number, envelope: object|undefined, raw: string}} failure
   */
  constructor({ status, envelope, raw }) {
    const code = typeof envelope?.code === "string" ? envelope.code : "";
    const message = typeof envelope?.message === "string" ? envelope.message : "";
    super(code ? `${code}: ${message}` : `控制面返回 ${status}`);
    this.name = "ControlPlaneError";
    this.status = status;
    /** The stable failure code, empty when the body carried no envelope. */
    this.code = code;
    /** The whole error object as sent; no field is dropped or renamed. */
    this.envelope = envelope;
    /** The response body as it arrived, for a body that is not the envelope. */
    this.raw = raw;
  }
}

/**
 * @typedef {{group: string, kind: string, namespace?: string, name: string}} ObjectRef
 * @typedef {{ref: ObjectRef, observedAt: string, stale: boolean, object: object}} Projection
 * @typedef {{accepted: boolean, ref?: ObjectRef, idempotent?: boolean}} WriteResult
 */

/**
 * createControlPlane builds the client for one control plane.
 *
 * @param {{baseURL: string, headers?: Record<string, string>,
 *          fetchImpl?: typeof fetch}} config
 */
export function createControlPlane({ baseURL, headers = {}, fetchImpl = globalThis.fetch }) {
  if (typeof baseURL !== "string" || baseURL.trim() === "") {
    throw new TypeError("控制面 API 需要基地址");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("控制面 API 需要 fetch");
  }
  const root = baseURL.replace(/\/+$/, "");

  async function call(method, path, { query, body } = {}) {
    const target = new URL(root + path);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== "") {
        target.searchParams.set(name, String(value));
      }
    }
    const request = {
      method,
      headers: { ...headers },
      // The window's origin holds no console cookie, so a credentialed request
      // would only carry something KOSD-C-75 forbids.
      credentials: "omit",
    };
    if (body !== undefined) {
      request.headers["content-type"] = "application/json";
      request.body = JSON.stringify(body);
    }
    const response = await fetchImpl(target.toString(), request);
    const text = await response.text();
    let payload;
    try {
      payload = text === "" ? undefined : JSON.parse(text);
    } catch {
      payload = undefined;
    }
    if (!response.ok) {
      throw new ControlPlaneError({
        status: response.status,
        envelope: payload?.error,
        raw: text,
      });
    }
    return payload;
  }

  return {
    /**
     * list returns one page of projections of one kind. The page size and the
     * cursor are the caller's: an omitted limit sends none and the returned
     * cursor is never followed here.
     *
     * @param {string} kind
     * @param {{namespace?: string, apiVersion?: string, labelSelector?: string,
     *          targetApp?: string, limit?: number, continue?: string}} [options]
     * @returns {Promise<{items: Projection[], continue?: string}>}
     */
    async list(kind, options = {}) {
      const page = await call("GET", `/api/v1/resources/${encodeURIComponent(kind)}`, {
        query: {
          namespace: options.namespace,
          apiVersion: options.apiVersion,
          labelSelector: options.labelSelector,
          targetApp: options.targetApp,
          limit: options.limit,
          continue: options.continue,
        },
      });
      return { items: page?.items ?? [], continue: page?.continue };
    },

    /**
     * get returns one object as the control plane observed it.
     *
     * @param {string} kind
     * @param {{namespace?: string, name: string}} ref
     * @returns {Promise<Projection>}
     */
    async get(kind, { namespace, name }) {
      if (!name) {
        throw new TypeError("读取对象需要名字");
      }
      return call("GET", `/api/v1/resources/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`, {
        query: { namespace },
      });
    },

    /**
     * create submits one object. A repeated submission is a second request:
     * idempotence is the control plane's judgement, not this client's
     * (KOSD-C-12).
     *
     * @param {string} kind
     * @param {{namespace?: string, object: object}} request
     * @returns {Promise<WriteResult>}
     */
    async create(kind, { namespace, object }) {
      return call("POST", `/api/v1/resources/${encodeURIComponent(kind)}`, {
        query: { namespace },
        body: object,
      });
    },

    /**
     * update submits the new document of one existing object. Like every write
     * it answers acceptance and the object it targets (KOSD-C-12).
     *
     * @param {string} kind
     * @param {{namespace?: string, name: string, object: object}} request
     * @returns {Promise<WriteResult>}
     */
    async update(kind, { namespace, name, object }) {
      if (!name) {
        throw new TypeError("更新对象需要名字");
      }
      return call("PUT", `/api/v1/resources/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`, {
        query: { namespace },
        body: object,
      });
    },

    /**
     * session reads the calling session: the account and the role the control
     * plane evaluates every write against (KOSD-C-59). The route and the DTO are
     * the identity API's own (kosd `pkg/identity/api.go`); the answer is returned
     * as read and this client derives nothing from it.
     *
     * @returns {Promise<{username: string, role: string}>}
     */
    async session() {
      return call("GET", "/api/v1/auth/session");
    },

    /**
     * act submits one action request. The answer is acceptance plus the object
     * it targets; the operation's progress is read from that object's state.
     *
     * @param {{kind: string, namespace: string, name: string, action: string}} request
     * @returns {Promise<WriteResult>}
     */
    async act(request) {
      return call("POST", "/api/v1/action-requests", { body: request });
    },
  };
}
