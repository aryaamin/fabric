import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { FabricHost } from "./index.ts";

export function createNodeServer(host: FabricHost): Server {
  return createServer(async (request, response) => {
    try {
      const webRequest = toWebRequest(request);
      const webResponse = await host.fetch(webRequest);
      await writeWebResponse(response, webResponse);
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: (error as Error).message }));
    }
  });
}

function toWebRequest(request: IncomingMessage): Request {
  const origin = `http://${request.headers.host ?? "localhost"}`;
  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: new Headers(
      Object.entries(request.headers)
        .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
        .map(
          ([key, value]): [string, string] => [
            key,
            Array.isArray(value) ? value.join(",") : value,
          ],
        ),
    ),
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = Readable.toWeb(request) as ReadableStream;
    init.duplex = "half";
  }
  return new Request(new URL(request.url ?? "/", origin), init);
}

async function writeWebResponse(response: ServerResponse, webResponse: Response): Promise<void> {
  response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
  if (!webResponse.body) {
    response.end();
    return;
  }
  for await (const chunk of Readable.fromWeb(webResponse.body as never)) response.write(chunk);
  response.end();
}
