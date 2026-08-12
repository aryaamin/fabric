import { MCP_OAUTH_SCOPE } from "../../../lib/mcp-oauth";

export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  return Response.json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/api/oauth/authorize`,
      token_endpoint: `${origin}/api/oauth/token`,
      registration_endpoint: `${origin}/api/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [MCP_OAUTH_SCOPE],
    },
    {
      headers: {
        "cache-control": "public, max-age=300",
      },
    },
  );
}
