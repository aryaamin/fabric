import { MCP_OAUTH_SCOPE } from "../../../lib/mcp-oauth";

export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  return Response.json(
    {
      resource: `${origin}/api/mcp`,
      authorization_servers: [origin],
      scopes_supported: [MCP_OAUTH_SCOPE],
      resource_documentation: `${origin}/connect`,
    },
    {
      headers: {
        "cache-control": "public, max-age=300",
      },
    },
  );
}
