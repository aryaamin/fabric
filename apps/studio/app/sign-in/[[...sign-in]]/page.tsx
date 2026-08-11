import { SignIn } from "@clerk/nextjs";
import Link from "next/link";
import { clerkConfigured } from "../../../lib/auth";

export default function SignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      {clerkConfigured() ? (
        <SignIn />
      ) : (
        <div className="max-w-md rounded-lg border border-line bg-panel p-6 text-center">
          <h1 className="text-lg font-semibold">Authentication is not configured</h1>
          <p className="mt-2 text-sm text-ink-2">
            Add the Clerk environment variables from .env.example. Local development can still use the owner demo.
          </p>
          <Link className="mt-4 inline-block text-sm text-accent" href="/">
            Continue locally
          </Link>
        </div>
      )}
    </main>
  );
}
