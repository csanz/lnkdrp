import Image from "next/image";
import UploadButton from "@/components/UploadButton";

export default function Home() {
  return (
    <main className="grid min-h-screen place-items-center bg-white px-6 text-zinc-900">
      <div className="text-center">
        <div className="mx-auto flex items-center justify-center gap-3">
          <Image
            src="/icon.svg"
            alt="LinkDrop"
            width={40}
            height={40}
            priority
          />
          <h1 className="text-4xl font-semibold tracking-tight">LinkDrop</h1>
        </div>

        <p className="mt-2 text-sm font-medium text-zinc-600">
          Share docs, fast.
        </p>

        <p className="mx-auto mt-4 max-w-md text-base leading-relaxed text-zinc-600">
          Upload a doc. Share a link.
        </p>

        <UploadButton />
      </div>
    </main>
  );
}
