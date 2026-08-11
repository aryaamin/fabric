import { SignUp } from "@clerk/nextjs";
import { clerkConfigured } from "../../../lib/auth";

export default function SignUpPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      {clerkConfigured() ? (
        <SignUp />
      ) : (
        <div className="max-w-md rounded-lg border border-line bg-panel p-6 text-center">
          <h1 className="text-lg font-semibold">Authentication is not configured</h1>
          <p className="mt-2 text-sm text-ink-2">
            Provision Clerk through the Vercel Marketplace and pull the project environment variables.
          </p>
        </div>
      )}
    </main>
  );
}
