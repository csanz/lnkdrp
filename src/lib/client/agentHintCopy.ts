/**
 * Agent hint copy registry: the single source of "an agent could do this for you" copy, the
 * sibling of `upsellCopy.ts`.
 *
 * One entry per form that has a real MCP tool doing the same job. `AgentHintNotice` reads from
 * here and nowhere else, so a form without an entry cannot show a hint, and a hint cannot promise
 * automation the MCP server does not ship. Tool names are the live ones registered in
 * `mcp/src/tools/`; if a tool is renamed there, rename it here too or the note starts lying.
 *
 * Voice: say what the agent would do, in one line. No exclamation, no "did you know", no em dash.
 */

/** Which form the hint sits on. Adding a key means a tool exists that does that form's job. */
export type AgentHintKey =
  | "share_link"
  | "project_link"
  | "create_project"
  | "doc_projects"
  | "tags"
  | "import_url"
  | "upload";

/** Copy for one hint: a short title, one line on what the agent would do, and the tools that do it. */
export type AgentHintCopy = {
  title: string;
  /** One short line, in the second person, about the job rather than about agents. */
  line: string;
  /** The MCP tools that do this job, in the order the line implies. */
  tools: readonly string[];
};

/** Copy per form. Keep the tool names in step with `mcp/src/tools/`. */
export const AGENT_HINT_COPY: Record<AgentHintKey, AgentHintCopy> = {
  share_link: {
    title: "An agent can create this link",
    line: "Give yours the label, the expiry and the password, and it makes the link. Changing one later is a single call too.",
    tools: ["lnkdrp_create_share_link", "lnkdrp_update_share_link"],
  },
  project_link: {
    title: "An agent can create this link",
    line: "Give yours the label, the expiry and the password, and it makes the project link. Changing one later is a single call too.",
    tools: ["lnkdrp_create_project_link", "lnkdrp_update_project_link"],
  },
  create_project: {
    title: "An agent can create the project",
    line: "Give yours a name and a description, and it creates the project ready for documents.",
    tools: ["lnkdrp_create_project"],
  },
  doc_projects: {
    title: "An agent can file this document",
    line: "Ask yours to put this document in a project, or take it out again, without opening this list.",
    tools: ["lnkdrp_add_docs_to_project", "lnkdrp_remove_doc_from_project"],
  },
  tags: {
    title: "An agent can tag this",
    line: "Name the tags you want and yours adds them, creating any this workspace does not have yet.",
    tools: ["lnkdrp_tag", "lnkdrp_untag"],
  },
  import_url: {
    title: "An agent can import this link",
    line: "Hand yours the same address. It fetches the PDF and gives you back the share link.",
    tools: ["lnkdrp_share_pdf"],
  },
  upload: {
    title: "An agent can upload the PDF",
    line: "Point yours at the file and it uploads the PDF and returns the share link.",
    tools: ["lnkdrp_share_pdf"],
  },
};
