import {
  McpOAuthError,
  registerMcpOAuthClient,
} from "../../../../lib/mcp-oauth";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      client_name?: string;
      redirect_uris?: string[];
      grant_types?: string[];
      response_types?: string[];
      token_endpoint_auth_method?: string;
    };
    const client = await registerMcpOAuthClient({
      name: body.client_name,
      redirectUris: body.redirect_uris ?? [],
      grantTypes: body.grant_types,
      responseTypes: body.response_types,
      tokenEndpointAuthMethod: body.token_endpoint_auth_method,
    });
    return Response.json(
      {
        client_id: client.id,
        client_id_issued_at: Math.floor(new Date(client.createdAt).getTime() / 1_000),
        client_name: client.name,
        redirect_uris: client.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      {
        status: 201,
        headers: { "cache-control": "no-store" },
      },
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Fabric MCP OAuth client registration failed",
        requestId: request.headers.get("x-vercel-id"),
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    const oauth = error instanceof McpOAuthError ? error : null;
    return Response.json(
      {
        error: oauth?.code ?? "invalid_client_metadata",
        error_description: oauth?.message ?? "Could not register OAuth client",
      },
      {
        status: oauth?.status ?? 400,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}
