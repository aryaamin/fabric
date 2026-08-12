import {
  McpOAuthError,
  exchangeMcpAuthorizationCode,
  refreshMcpOAuthToken,
} from "../../../../lib/mcp-oauth";

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const grantType = required(form, "grant_type");
    const clientId = required(form, "client_id");
    const resource = required(form, "resource");
    const token =
      grantType === "authorization_code"
        ? await exchangeMcpAuthorizationCode({
            code: required(form, "code"),
            clientId,
            redirectUri: required(form, "redirect_uri"),
            codeVerifier: required(form, "code_verifier"),
            resource,
          })
        : grantType === "refresh_token"
          ? await refreshMcpOAuthToken({
              refreshToken: required(form, "refresh_token"),
              clientId,
              resource,
            })
          : (() => {
              throw new McpOAuthError(
                "unsupported_grant_type",
                "Use authorization_code or refresh_token",
              );
            })();
    return Response.json(token, {
      headers: {
        "cache-control": "no-store",
        pragma: "no-cache",
      },
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Fabric MCP OAuth token exchange failed",
        requestId: request.headers.get("x-vercel-id"),
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    const oauth = error instanceof McpOAuthError ? error : null;
    return Response.json(
      {
        error: oauth?.code ?? "invalid_request",
        error_description: oauth?.message ?? "Could not exchange Fabric OAuth token",
      },
      {
        status: oauth?.status ?? 400,
        headers: {
          "cache-control": "no-store",
          pragma: "no-cache",
        },
      },
    );
  }
}

function required(form: FormData, key: string): string {
  const value = form.get(key);
  if (typeof value !== "string" || !value.trim()) {
    throw new McpOAuthError("invalid_request", `${key} is required`);
  }
  return value.trim();
}
