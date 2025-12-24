import Link from "next/link";

/**
 * Login page placeholder.
 *
 * Auth is partially wired via NextAuth, but a full UI is not implemented yet.
 */
export default function LoginPage() {
  return (
    <main className="grid min-h-[100svh] place-items-center bg-white px-6 text-zinc-900">
      <div className="w-full max-w-md">
        <h1 className="text-xl font-semibold tracking-tight">Login</h1>
        <p className="mt-3 text-sm leading-6 text-zinc-600">
          Authentication isn’t wired up yet.
        </p>
        <div className="mt-6">
          <Link
            href="/"
            className="text-sm font-medium text-zinc-900 underline underline-offset-4"
          >
            Back
          </Link>
        </div>
      </div>
    </main>
  );
}


