/**
 * One person's grant into one locked project (docs/prds/lnkdrp-locked-projects.md, decision 3).
 *
 * A locked project is a private data room: it exists only for the people on this list. Membership
 * is its own collection rather than a `memberUserIds` array on the project row, for four reasons
 * that are all specific to this repo:
 *
 * 1. The hot question is "which locked rooms may this person see", keyed on `userId` across every
 *    project in the workspace, which wants an index of its own either way.
 * 2. A grant needs a `revokedAt` that nothing else touches. `src/app/api/org-invites/claim/route.ts`
 *    deliberately revives a revoked `OrgMembership` with the invite's role, so if room access were
 *    expressed as a flag on the workspace membership, a removed person's rooms would come back with
 *    them the moment they re-accepted an invite.
 * 3. `src/lib/accounts/purge.ts` has to delete grants both by `orgId` and by the project ids it
 *    pre-reads, and a separate collection is something a purge batch can name.
 * 4. A roster on the project row would eventually be `select`ed into a project DTO by accident.
 *    A separate collection cannot leak through a projection.
 *
 * The array form is genuinely cheaper (one clause, no pre-query, and offboarding is one `$pull`).
 * It was rejected because the array would then be both the authorization authority and a field on
 * the row that every project read already loads.
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const projectMembershipSchema = new Schema(
  {
    /** The workspace the room belongs to. Kept beside `projectId` so a purge can sweep by tenant. */
    orgId: { type: Schema.Types.ObjectId, ref: "Org", required: true, index: true },
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    /**
     * What this person may do inside the room.
     *
     * Deliberately not a second permission system: the workspace role still decides what may be
     * done (decision 24), and this only records why the grant was made in the room's own terms.
     * No default, because "editor" is a real power and a writer that forgets to say so should fail
     * validation rather than quietly hand it out.
     */
    role: { type: String, trim: true, required: true, enum: ["editor", "reader"], index: true },
    /**
     * How the grant came to exist: the person who created the room, somebody added to it, or an
     * owner who used break-glass. `break_glass` is the one the room's header banner reads, so it
     * has to survive as a stored word rather than be inferred from `addedByUserId === userId`.
     */
    via: { type: String, trim: true, required: true, enum: ["creator", "added", "break_glass"], index: true },
    addedByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    /** The break-glass justification, shown to every existing member. Empty for ordinary grants. */
    reason: { type: String, trim: true, default: "" },

    isDeleted: { type: Boolean, default: false, index: true },
    /**
     * When the grant was cleared, written together with `isDeleted` by the one function allowed to
     * clear grants (`revokeProjectGrants` in `src/lib/projects/lockScope.ts`). It exists so "who
     * has ever been in this room" stays answerable after somebody leaves, which is the question a
     * compliance request opens with.
     */
    revokedAt: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: "createdDate", updatedAt: "updatedDate" },
    minimize: false,
  },
);

// One grant per person per room. A revoked grant keeps its row (see `revokedAt`), so re-adding
// somebody revives the row it already has rather than inserting a second one.
projectMembershipSchema.index({ projectId: 1, userId: 1 }, { unique: true });
// "Which locked rooms may this person see?" — the question every filtered request asks.
projectMembershipSchema.index({ orgId: 1, userId: 1, isDeleted: 1 });
// The roster for one room, for the members panel and the notification audience.
projectMembershipSchema.index({ orgId: 1, projectId: 1, isDeleted: 1 });

export type ProjectMembership = InferSchemaType<typeof projectMembershipSchema>;

/** Values of `ProjectMembership.role`. */
export type ProjectMembershipRole = "editor" | "reader";
/** Values of `ProjectMembership.via`. */
export type ProjectMembershipVia = "creator" | "added" | "break_glass";

export const ProjectMembershipModel: Model<ProjectMembership> =
  (mongoose.models.ProjectMembership as Model<ProjectMembership> | undefined) ??
  mongoose.model<ProjectMembership>("ProjectMembership", projectMembershipSchema);
