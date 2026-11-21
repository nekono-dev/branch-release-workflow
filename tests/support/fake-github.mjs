// GitHub の応答を差し替える偽の応答層。通信も認証も行わず、要求先と書き込み件数だけを記録する。

/**
 * @param {{scenario?: "success"|"permission"|"auth"|"lost", routes?: Record<string, {status: number, body?: any}>}} [opt]
 *   scenario: success=登録した応答を返す / permission=書き込みを 403 で拒否 / auth=すべて 401 / lost=書き込みは適用されるが応答が届かない。
 *   routes のキーは "METHOD /path"。
 */
export const createFakeGitHub = ({ scenario = "success", routes = {} } = {}) => {
  /** @type {{method: string, path: string, body: any}[]} */
  const requests = [];
  /** 実際に適用された書き込み */
  const applied = [];
  const fake = {
    requests,
    applied,
    /** 書き込み（GET・HEAD 以外）の要求回数。拒否された要求も数える。 */
    get writeCount() { return requests.filter((q) => !["GET", "HEAD"].includes(q.method)).length; },
    async request(method, path, body) {
      const m = method.toUpperCase();
      // 資格情報の値は受け取らず、記録にも含めない
      requests.push({ method: m, path, body });
      const write = !["GET", "HEAD"].includes(m);
      if (scenario === "auth") return { status: 401, body: { message: "Bad credentials" } };
      if (write && scenario === "permission") return { status: 403, body: { message: "Resource not accessible" } };
      const route = routes[`${m} ${path}`];
      if (!route) return { status: 404, body: { message: "Not Found" } };
      if (write) applied.push({ method: m, path, body });
      if (write && scenario === "lost") throw Object.assign(new Error("応答が途中で切れた"), { code: "ECONNRESET" });
      return { status: route.status, body: route.body };
    },
  };
  return fake;
};
