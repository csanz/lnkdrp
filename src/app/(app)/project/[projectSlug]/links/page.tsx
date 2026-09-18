/**
 * Owner project links page.
 * Route: `/project/:projectId/links`
 *
 * The project-shaped twin of `/doc/:docId/links` — same shell, same table, same component
 * (`LinksManager`). The route param is called `projectSlug` for historical reasons; it has always
 * carried a project **id**.
 */
import LinksPageClient from "./pageClient";

/**
 * Render the ProjectLinksPage UI.
 */
export default async function ProjectLinksPage({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  return <LinksPageClient projectId={projectSlug} />;
}
