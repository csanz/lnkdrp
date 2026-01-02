import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    /** Active organization context for the current session (org switcher). */
    activeOrgId?: string;
    user: {
      id: string;
      email: string;
      name?: string | null;
      image?: string | null;
      role: string;
      /** Optional: some session update flows only allow writing under `user`. */
      activeOrgId?: string;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId?: string;
    role?: string;
    /** Active organization context embedded in the JWT. */
    activeOrgId?: string;
  }
}




