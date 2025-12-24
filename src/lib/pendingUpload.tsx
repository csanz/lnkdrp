 "use client";
 
 import { createContext, useContext, useMemo, useState } from "react";
 
 type PendingUploadContextValue = {
   pendingFile: File | null;
   setPendingFile: (file: File | null) => void;
  hasEnteredShell: boolean;
  setHasEnteredShell: (entered: boolean) => void;
 };
 
 const PendingUploadContext = createContext<PendingUploadContextValue | null>(null);
 
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
 
 export function usePendingUpload() {
   const ctx = useContext(PendingUploadContext);
   if (!ctx) throw new Error("usePendingUpload must be used within PendingUploadProvider");
   return ctx;
 }
 


