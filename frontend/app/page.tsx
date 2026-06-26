"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getCurrentUser } from "@/lib/api";

export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    let active = true;

    getCurrentUser()
      .then(() => {
        if (active) {
          router.replace("/dashboard");
        }
      })
      .catch(() => {
        if (active) {
          router.replace("/login");
        }
      });

    return () => {
      active = false;
    };
  }, [router]);

  return (
    <main className="center-screen">
      <div className="loading-panel">Checking admin session...</div>
    </main>
  );
}
