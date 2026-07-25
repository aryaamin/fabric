"use client";

import { useState } from "react";
import type { RenderNode } from "@fabric/interpreter";
import { Renderer } from "./Renderer";
import { ErrorState } from "./ui/Empty";

/**
 * The embed surface: the running app and nothing else.
 *
 * It is fully interactive — a form in an embedded app writes real data through
 * the same submit path, because "applications become reusable UI blocks" is only
 * true if the block still works when you put it somewhere else. What it lacks is
 * chrome: no header, no chat, no history, nothing that assumes it owns the page.
 */
export function EmbedApp({
  slug,
  viewName,
  initialView,
  token,
  readOnly,
}: {
  slug: string;
  viewName: string;
  initialView: RenderNode;
  token?: string;
  readOnly?: boolean;
}) {
  const [tree, setTree] = useState<RenderNode>(initialView);
  const [error, setError] = useState<string | null>(null);

  // The capability token travels with every write, exactly as it does in the URL:
  // an embed is authorized by the link that placed it.
  const qs = token ? `?k=${encodeURIComponent(token)}` : "";

  async function submit(action: string, values: Record<string, unknown>) {
    const res = await fetch(`/api/submit${qs}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, view: viewName, action, form: values }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error ?? "Submit failed");
    setTree(data.view as RenderNode);
  }

  async function invoke(action: string, args: Record<string, unknown>) {
    setError(null);
    const res = await fetch(`/api/edit${qs}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, action, args }),
    });
    const data = await res.json();
    if (!data.ok) {
      setError(data.error ?? "That action failed.");
      return;
    }
    if (data.view) setTree(data.view as RenderNode);
  }

  return (
    <div className="min-h-screen">
      {error && <ErrorState message={error} />}
      <Renderer node={tree} onAction={invoke} onSubmit={submit} readOnly={readOnly} />
    </div>
  );
}
