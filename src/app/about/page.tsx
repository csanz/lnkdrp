/**
 * About page.
 *
 * Lightweight static copy explaining what LinkDrop is.
 */
import AboutCopy from "@/components/AboutCopy";
/**
 * Render the AboutPage UI.
 */


export default function AboutPage() {
  return (
    <main className="grid min-h-[100svh] place-items-center bg-white px-6 text-zinc-900">
      <div className="w-full max-w-md">
        <h1 className="text-xl font-semibold tracking-tight">About</h1>
        <div className="mt-3">
          <AboutCopy />
        </div>
      </div>
    </main>
  );
}




