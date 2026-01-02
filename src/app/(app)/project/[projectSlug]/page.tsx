"use client";

import { use } from "react";
import ProjectPageClient from "./pageClient";
/**
 * Render the ProjectPage UI.
 */


export default function ProjectPage(props: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = use(props.params);
  // NOTE: projectSlug is now the project ID (Mongo _id) for `/project/:id`.
  return <ProjectPageClient projectSlug={projectSlug} />;
}


