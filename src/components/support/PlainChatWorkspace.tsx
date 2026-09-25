"use client";

/**
 * Tells the Plain chat which workspace and plan the person is in.
 *
 * Ari answers from the help pages, and the answers differ by plan: viewer names are Pro,
 * credits reset monthly on Pro, and so on. The chat widget can stamp thread fields on every
 * thread it opens, and the `plan` and `workspace` fields are marked available to agents in Plain,
 * so this is how Linky knows without asking. Mounted only for a signed-in person (the layout
 * decides), and it renders nothing.
 *
 * `Plain.update` is idempotent, so this re-applies whenever the workspace or plan changes; it polls
 * briefly for the widget to initialise, since the script loads on its own schedule.
 */
import { usePathname } from "next/navigation";
import { useEffect } from "react";

import { isViewerPath, type PlainThreadField } from "@/components/support/PlainChat";
import { usePlan } from "@/lib/client/usePlan";
import { useOrgsSnapshot } from "@/lib/orgs/useOrgsSnapshot";

const POLL_MS = 250;
const GIVE_UP_MS = 15_000;

/** Renders nothing; keeps the chat's thread fields in step with the active workspace and its plan. */
export default function PlainChatWorkspace() {
  const pathname = usePathname();
  const viewer = isViewerPath(pathname);
  const { plan } = usePlan();
  const { stableOrgs, activeOrgId } = useOrgsSnapshot();
  const workspaceName = stableOrgs.find((o) => o.id === activeOrgId)?.name ?? null;
  const tier = plan?.plan ?? null;

  useEffect(() => {
    if (viewer || (!tier && !workspaceName)) return;
    const threadFields: PlainThreadField[] = [];
    if (tier) threadFields.push({ key: "plan", type: "ENUM", stringValue: tier });
    if (workspaceName) threadFields.push({ key: "workspace", type: "STRING", stringValue: workspaceName });
    const apply = (): boolean => {
      const p = window.Plain;
      if (!p || !p.isInitialized()) return false;
      p.update({ threadDetails: { threadFields } });
      return true;
    };
    if (apply()) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (apply() || Date.now() - started > GIVE_UP_MS) window.clearInterval(timer);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [viewer, tier, workspaceName]);

  return null;
}
