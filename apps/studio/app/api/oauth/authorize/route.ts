import { currentIdentity } from "../../../../lib/auth";
import {
  McpOAuthError,
  issueMcpAuthorizationCode,
  validateMcpAuthorizationRequest,
  type McpAuthorizationRequest,
} from "../../../../lib/mcp-oauth";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const authorization = await validateMcpAuthorizationRequest(
      url.searchParams,
      `${url.origin}/api/mcp`,
    );
    const identity = await currentIdentity();
    if (!identity) {
      const signIn = new URL("/sign-in", url.origin);
      signIn.searchParams.set("redirect_url", request.url);
      return Response.redirect(signIn);
    }
    return consentPage(authorization, url.origin);
  } catch (error) {
    return oauthProblem(error, request);
  }
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const origin = new URL(request.url).origin;
    const authorization = await validateMcpAuthorizationRequest(
      form,
      `${origin}/api/mcp`,
    );
    const identity = await currentIdentity();
    if (!identity) {
      throw new McpOAuthError("access_denied", "Sign in to authorize ChatGPT", 401);
    }
    if (form.get("decision") !== "approve") {
      return oauthRedirect(authorization, {
        error: "access_denied",
        error_description: "The user declined Fabric access",
      });
    }
    const code = await issueMcpAuthorizationCode(identity, authorization);
    return oauthRedirect(authorization, { code });
  } catch (error) {
    return oauthProblem(error, request);
  }
}

function consentPage(
  authorization: McpAuthorizationRequest,
  origin: string,
): Response {
  const inputs = {
    response_type: "code",
    client_id: authorization.clientId,
    redirect_uri: authorization.redirectUri,
    code_challenge: authorization.codeChallenge,
    code_challenge_method: "S256",
    resource: authorization.resource,
    scope: authorization.scope,
    ...(authorization.state ? { state: authorization.state } : {}),
  };
  const hidden = Object.entries(inputs)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join("");
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Connect ChatGPT to Fabric</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #09090b; color: #fafafa; }
    main { width: min(420px, calc(100vw - 40px)); border: 1px solid #27272a; border-radius: 16px; background: #111113; padding: 28px; }
    .brand { color: #a78bfa; font-weight: 700; letter-spacing: -.02em; }
    h1 { margin: 20px 0 8px; font-size: 24px; letter-spacing: -.03em; }
    p { color: #a1a1aa; line-height: 1.55; }
    ul { color: #d4d4d8; line-height: 1.8; padding-left: 20px; }
    form { display: flex; gap: 10px; margin-top: 24px; }
    button { flex: 1; border: 1px solid #3f3f46; border-radius: 9px; padding: 11px 14px; color: inherit; background: #18181b; font-weight: 600; cursor: pointer; }
    button[value=approve] { border-color: #7c3aed; background: #7c3aed; }
  </style>
</head>
<body>
  <main>
    <div class="brand">▚ Fabric</div>
    <h1>Connect ChatGPT</h1>
    <p>ChatGPT is asking Fabric to create and manage software for you.</p>
    <ul>
      <li>Create and edit your Fabric projects</li>
      <li>Build, deploy, and inspect logs</li>
      <li>Return Fabric sharing and editing links</li>
    </ul>
    <p>Cloud providers and credentials remain managed privately by Fabric.</p>
    <form method="post" action="${escapeHtml(`${origin}/api/oauth/authorize`)}">
      ${hidden}
      <button type="submit" name="decision" value="deny">Cancel</button>
      <button type="submit" name="decision" value="approve">Allow</button>
    </form>
  </main>
</body>
</html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          `default-src 'none'; style-src 'unsafe-inline'; form-action ${origin} https://chatgpt.com; base-uri 'none'; frame-ancestors 'none'`,
      },
    },
  );
}

function oauthRedirect(
  authorization: McpAuthorizationRequest,
  values: Record<string, string>,
): Response {
  const url = new URL(authorization.redirectUri);
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  if (authorization.state) url.searchParams.set("state", authorization.state);
  return Response.redirect(url, 303);
}

function oauthProblem(error: unknown, request: Request): Response {
  console.error(
    JSON.stringify({
      level: "error",
      message: "Fabric MCP OAuth authorization failed",
      requestId: request.headers.get("x-vercel-id"),
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  const oauth = error instanceof McpOAuthError ? error : null;
  return Response.json(
    {
      error: oauth?.code ?? "server_error",
      error_description: oauth?.message ?? "Could not authorize Fabric access",
    },
    {
      status: oauth?.status ?? 500,
      headers: { "cache-control": "no-store" },
    },
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
