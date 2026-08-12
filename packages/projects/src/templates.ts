import type { SourceFileInput } from "./index.ts";

export type ProjectTemplate = "empty" | "vite" | "nextjs" | "python" | "go";

export function projectTemplateFiles(
  template: ProjectTemplate,
  projectName: string,
): SourceFileInput[] {
  const slug = packageName(projectName);
  switch (template) {
    case "empty":
      return [];
    case "vite":
      return [
        text(
          "package.json",
          JSON.stringify(
            {
              name: slug,
              private: true,
              version: "0.1.0",
              type: "module",
              scripts: { dev: "vite", build: "vite build", start: "vite --host 0.0.0.0" },
              devDependencies: { vite: "latest" },
            },
            null,
            2,
          ) + "\n",
        ),
        text(
          "index.html",
          `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(projectName)}</title>
    <link rel="stylesheet" href="/src/style.css" />
  </head>
  <body>
    <main>
      <p class="eyebrow">Deployed by Fabric</p>
      <h1>${escapeHtml(projectName)}</h1>
      <p>This project was created, built, and shared through the agent cloud control plane.</p>
    </main>
  </body>
</html>
`,
        ),
        text(
          "src/style.css",
          `:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  background: #08080a;
  color: #f2f2f5;
}
body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
main { width: min(640px, calc(100% - 48px)); }
.eyebrow { color: #9c85ff; font: 600 12px ui-monospace, monospace; text-transform: uppercase; }
h1 { margin: 12px 0; font-size: clamp(42px, 9vw, 80px); letter-spacing: -0.05em; }
p { color: #a3a3ae; line-height: 1.7; }
`,
        ),
      ];
    case "nextjs":
      return [
        text(
          "package.json",
          JSON.stringify(
            {
              name: slug,
              private: true,
              version: "0.1.0",
              scripts: { dev: "next dev", build: "next build", start: "next start" },
              dependencies: { next: "latest", react: "latest", "react-dom": "latest" },
            },
            null,
            2,
          ) + "\n",
        ),
        text(
          "app/layout.tsx",
          `import type { ReactNode } from "react";
import "./style.css";

export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
`,
        ),
        text(
          "app/page.tsx",
          `export default function Page() {
  return (
    <main>
      <p>Deployed by Fabric</p>
      <h1>${escapeHtml(projectName)}</h1>
    </main>
  );
}
`,
        ),
        text(
          "app/style.css",
          `html { color-scheme: dark; font-family: ui-sans-serif, system-ui; background: #08080a; color: #f2f2f5; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
main { text-align: center; } p { color: #9c85ff; } h1 { font-size: clamp(40px, 8vw, 76px); }
`,
        ),
      ];
    case "python":
      return [
        text("requirements.txt", "fastapi\nuvicorn[standard]\n"),
        text(
          "main.py",
          `from fastapi import FastAPI

app = FastAPI(title=${JSON.stringify(projectName)})

@app.get("/")
def root():
    return {"project": ${JSON.stringify(projectName)}, "deployedBy": "Fabric"}
`,
        ),
      ];
    case "go":
      return [
        text("go.mod", `module fabric.local/${slug}\n\ngo 1.24\n`),
        text(
          "main.go",
          `package main

import (
  "encoding/json"
  "net/http"
  "os"
)

func main() {
  http.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    _ = json.NewEncoder(w).Encode(map[string]string{
      "project": ${JSON.stringify(projectName)},
      "deployedBy": "Fabric",
    })
  })
  port := os.Getenv("PORT")
  if port == "" { port = "3000" }
  _ = http.ListenAndServe(":" + port, nil)
}
`,
        ),
      ];
  }
}

function text(path: string, content: string): SourceFileInput {
  return { path, content, encoding: "utf8" };
}

function packageName(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || "fabric-project"
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
