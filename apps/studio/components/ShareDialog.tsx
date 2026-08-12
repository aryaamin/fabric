"use client";

import { useCallback, useEffect, useState } from "react";
import { cn } from "../lib/cn";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { Skeleton } from "./ui/Skeleton";

/**
 * The Share dialog — the Google-Docs Share button, implemented.
 *
 * It shows the object's sharing mode, lets the user change it, and surfaces the
 * link and the embed snippet. Every change round-trips to /api/share, which
 * mutates the workspace object through @fabric/workspace, so this component
 * holds no sharing logic of its own — only presentation.
 *
 * The "three surfaces" strip is here on purpose. The mental leap for a new user
 * is that ONE link behaves differently depending on who opens it: an editor gets
 * the studio, a viewer gets the running app, an iframe gets the app with no
 * chrome. Showing that at the moment of sharing is what makes it obvious.
 */

type ShareMode = "restricted" | "link-viewer" | "link-editor" | "published";

interface ShareState {
  mode: ShareMode;
  link: string;
  embed: string;
}

const MODES: { id: ShareMode; label: string; hint: string; tone: "neutral" | "accent" }[] = [
  { id: "restricted", label: "Restricted", hint: "Only people you invite can open it.", tone: "neutral" },
  { id: "link-viewer", label: "Anyone with the link · Viewer", hint: "Opens the running app, read-only.", tone: "neutral" },
  { id: "link-editor", label: "Anyone with the link · Editor", hint: "Opens the studio — they can edit it.", tone: "accent" },
  { id: "published", label: "Published to the web", hint: "Anyone can view it. No link token needed.", tone: "accent" },
];

export function ShareDialog({
  slug,
  name,
  kind = "app",
  open,
  onClose,
}: {
  slug: string;
  name: string;
  kind?: "app" | "project";
  open: boolean;
  onClose: () => void;
}) {
  const [state, setState] = useState<ShareState | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"editor" | "viewer">("viewer");
  const [inviteStatus, setInviteStatus] = useState<string | null>(null);

  const post = useCallback(
    async (mode?: ShareMode) => {
      setBusy(true);
      try {
        const res = await fetch("/api/share", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(mode ? { slug, mode } : { slug }),
        });
        const data = (await res.json()) as { ok: boolean } & ShareState;
        if (data.ok) setState({ mode: data.mode, link: data.link, embed: data.embed });
      } finally {
        setBusy(false);
      }
    },
    [slug],
  );

  useEffect(() => {
    if (open) void post();
  }, [open, post]);

  async function copy(kind: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard may be unavailable (insecure origin); the field stays selectable.
    }
    setCopied(kind);
    setTimeout(() => setCopied(null), 1300);
  }

  async function sendInvite() {
    if (!inviteEmail.trim() || busy) return;
    setBusy(true);
    setInviteStatus(null);
    try {
      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug,
          inviteEmail: { email: inviteEmail.trim(), role: inviteRole },
        }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) {
        setInviteStatus(data.error ?? "Could not send invitation.");
        return;
      }
      setInviteEmail("");
      setInviteStatus("Invitation sent.");
    } finally {
      setBusy(false);
    }
  }

  const shareable = kind === "app" && state && state.mode !== "restricted";
  const modes = kind === "project" ? MODES.filter((mode) => mode.id === "restricted") : MODES;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Share “${name}”`}
      subtitle={
        kind === "project"
          ? "Invite collaborators to edit or inspect this protected source project."
          : "A link to software, that behaves like a link to a document."
      }
      width="600px"
    >
      {!state ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 rounded-md" />
          ))}
        </div>
      ) : (
        <>
          <div className="mb-4 rounded-md border border-line bg-raised p-3">
            <label htmlFor="share-email" className="text-[12px] font-medium text-ink">
              Invite by email
            </label>
            <div className="mt-2 flex gap-2">
              <input
                id="share-email"
                type="email"
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void sendInvite();
                }}
                placeholder="teammate@company.com"
                className="h-8.5 min-w-0 flex-1 rounded-md border border-line bg-base px-2.5 text-[12.5px] text-ink placeholder:text-ink-3"
              />
              <select
                aria-label="Invitation role"
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value as "editor" | "viewer")}
                className="h-8.5 rounded-md border border-line bg-base px-2 text-[12px] text-ink-2"
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
              </select>
              <Button size="sm" variant="primary" loading={busy} onClick={() => void sendInvite()}>
                Invite
              </Button>
            </div>
            {inviteStatus ? <p className="mt-2 text-[12px] text-ink-3">{inviteStatus}</p> : null}
          </div>

          <div className="flex flex-col gap-1.5">
            {modes.map((m) => {
              const active = state.mode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void post(m.id)}
                  className={cn(
                    "flex items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors duration-150 disabled:opacity-60",
                    active ? "border-accent/50 bg-accent-dim" : "border-line bg-raised hover:border-ink-3/45 hover:bg-hover",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-full border",
                      active ? "border-accent bg-accent" : "border-ink-3",
                    )}
                  >
                    {active && <span className="size-1.5 rounded-full bg-white" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-ink">{m.label}</span>
                    <span className="block text-[12px] text-ink-3">{m.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>

          {shareable ? (
            <div className="mt-4 flex flex-col gap-2">
              <CopyRow
                label="Link"
                value={state.link}
                copied={copied === "link"}
                onCopy={() => void copy("link", state.link)}
              />
              <CopyRow
                label="Embed"
                value={state.embed}
                copied={copied === "embed"}
                onCopy={() => void copy("embed", state.embed)}
              />
            </div>
          ) : (
            <p className="mt-4 rounded-md border border-line bg-raised px-3 py-2.5 text-[12.5px] text-ink-3">
              {kind === "project"
                ? "This project stays protected. Invite collaborators by email above."
                : "Turn on link sharing or publish to get a URL and an embed snippet."}
            </p>
          )}

          {kind === "app" ? <div className="mt-5 border-t border-line-soft pt-4">
            <div className="mb-2.5 text-[11.5px] font-medium uppercase tracking-[0.05em] text-ink-3">
              One link, three surfaces
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Surface title="Studio" who="Owners & editors" body="Canvas, AI chat, history, share." tone="accent" />
              <Surface title="Run only" who="Viewers" body="The running app, no editor chrome." tone="neutral" />
              <Surface title="Embed" who="Iframes" body="Chromeless, for Notion or another app." tone="neutral" />
            </div>
            <p className="mt-2.5 text-[12px] leading-relaxed text-ink-3">
              The surface is chosen by the visitor&apos;s access, not by a different URL — the same routing decision the
              preview server makes.
            </p>
          </div> : null}
        </>
      )}
    </Dialog>
  );
}

function CopyRow({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-[12px] text-ink-3">{label}</span>
      <input
        readOnly
        value={value}
        onFocus={(e) => e.currentTarget.select()}
        className="h-8.5 min-w-0 flex-1 rounded-md border border-line bg-base px-2.5 font-mono text-[12px] text-ink-2"
      />
      <Button size="sm" variant={copied ? "primary" : "secondary"} onClick={onCopy}>
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function Surface({
  title,
  who,
  body,
  tone,
}: {
  title: string;
  who: string;
  body: string;
  tone: "accent" | "neutral";
}) {
  return (
    <div className="rounded-md border border-line bg-raised p-2.5">
      <div className="flex items-center justify-between gap-1">
        <span className="text-[12.5px] font-medium text-ink">{title}</span>
        <Badge tone={tone}>{who}</Badge>
      </div>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">{body}</p>
    </div>
  );
}
