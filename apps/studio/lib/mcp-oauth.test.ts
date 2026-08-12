import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  authenticateMcpOAuthToken,
  exchangeMcpAuthorizationCode,
  issueMcpAuthorizationCode,
  MCP_OAUTH_SCOPE,
  refreshMcpOAuthToken,
  registerMcpOAuthClient,
  validateMcpAuthorizationRequest,
} from "./mcp-oauth.ts";

test("MCP OAuth uses ChatGPT DCR, PKCE, resource binding, and token rotation", async () => {
  globalThis.__fabricMcpOAuthClients = new Map();
  globalThis.__fabricMcpOAuthCodes = new Map();
  globalThis.__fabricMcpOAuthTokens = new Map();

  const redirectUri = "https://chatgpt.com/connector/oauth/fabric-test";
  const resource = "https://fabric.test/api/mcp";
  const verifier = "fabric-verifier-abcdefghijklmnopqrstuvwxyz-0123456789";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const client = await registerMcpOAuthClient({
    name: "ChatGPT",
    redirectUris: [redirectUri],
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
  });
  const request = await validateMcpAuthorizationRequest(
    new URLSearchParams({
      response_type: "code",
      client_id: client.id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource,
      scope: MCP_OAUTH_SCOPE,
      state: "state-1",
    }),
    resource,
  );
  const code = await issueMcpAuthorizationCode(
    { id: "user_1", workspaceId: "user_user_1" },
    request,
  );
  const issued = await exchangeMcpAuthorizationCode({
    code,
    clientId: client.id,
    redirectUri,
    codeVerifier: verifier,
    resource,
  });
  const authenticated = await authenticateMcpOAuthToken(
    new Request(resource, {
      headers: { authorization: `Bearer ${issued.access_token}` },
    }),
  );

  assert.equal(authenticated?.principalId, "user_1");
  assert.equal(authenticated?.workspaceId, "user_user_1");

  const rotated = await refreshMcpOAuthToken({
    refreshToken: issued.refresh_token,
    clientId: client.id,
    resource,
  });
  assert.notEqual(rotated.access_token, issued.access_token);
  await assert.rejects(
    refreshMcpOAuthToken({
      refreshToken: issued.refresh_token,
      clientId: client.id,
      resource,
    }),
    /already used|invalid or expired/,
  );
});

test("MCP OAuth rejects untrusted dynamic redirect URIs", async () => {
  await assert.rejects(
    registerMcpOAuthClient({
      redirectUris: ["https://attacker.example/callback"],
    }),
    /ChatGPT connector callback/,
  );
});
