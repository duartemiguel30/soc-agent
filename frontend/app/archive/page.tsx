"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function ArchiveRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/incidents?archived=true");
  }, [router]);

  return (
    <main className="center-screen">
      <div className="loading-panel">Opening archived incidents...</div>
    </main>
  );
}
