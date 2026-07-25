"use client";

import { useState } from "react";
import { Button } from "./ui/Button";
import { NewAppDialog } from "./NewAppDialog";

/** The one interactive island on the (otherwise server-rendered) home page. */
export function NewAppButton({ variant = "primary" }: { variant?: "primary" | "secondary" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        <svg viewBox="0 0 14 14" className="size-3.5">
          <path d="M7 2v10M2 7h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        New app
      </Button>
      <NewAppDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
