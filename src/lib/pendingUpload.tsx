 "use client";
 
 import { createContext, useContext, useMemo, useState } from "react";

 /**
  * Client-side context for carrying a "pending upload" file across route transitions.
  *
  * This allows a user to select a file in one place (e.g. a landing shell) and
  * complete the upload flow after navigation without re-selecting it.
  */
 
 type PendingUploadContextValue = {
   pendingFile: File | null;
   setPendingFile: (file: File | null) => void;
  hasEnteredShell: boolean;
  setHasEnteredShell: (entered: boolean) => void;
 };
 
 const PendingUploadContext = createContext<PendingUploadContextValue | null>(null);
/**
 * Render the PendingUploadProvider UI (uses memoized values, local state).
 */

 
 export function PendingUploadProvider({ children }: { children: React.ReactNode }) {
   const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [hasEnteredShell, setHasEnteredShell] = useState(false);
 
   const value = useMemo<PendingUploadContextValue>(
    () => ({ pendingFile, setPendingFile, hasEnteredShell, setHasEnteredShell }),
    [pendingFile, hasEnteredShell],
   );
 
   return (
     <PendingUploadContext.Provider value={value}>
       {children}
     </PendingUploadContext.Provider>
   );
 }
/**
 * Use Pending Upload (uses useContext).
 */

 
 export function usePendingUpload(): PendingUploadContextValue {
   const ctx = useContext(PendingUploadContext);
   if (!ctx) throw new Error("usePendingUpload must be used within PendingUploadProvider");
   return ctx;
 }
 





