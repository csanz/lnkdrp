import { TROUBLESHOOTING } from "@/lib/mcp/clientSetups";

/** Short Q/A list shared by `/connect` and the public guides. */
export default function Troubleshooting() {
  return (
    <dl className="grid gap-4 sm:grid-cols-2">
      {TROUBLESHOOTING.map((item) => (
        <div key={item.q}>
          <dt className="text-[13px] font-semibold text-[var(--fg)]">{item.q}</dt>
          <dd className="mt-1 text-[13px] leading-5 text-[var(--muted)]">{item.a}</dd>
        </div>
      ))}
    </dl>
  );
}
