"use client";

import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useEffect, useState } from "react";
import { AdminUser, getCurrentUser } from "@/lib/api";

type AuthGuardProps = {
  children: (user: AdminUser) => ReactNode;
};

export function AuthGuard({ children }: AuthGuardProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<AdminUser | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let active = true;

    getCurrentUser()
      .then((currentUser) => {
        if (active) {
          setUser(currentUser);
          setChecking(false);
        }
      })
      .catch(() => {
        if (active) {
          const nextPath = pathname || "/dashboard";
          router.replace(`/login?next=${encodeURIComponent(nextPath)}`);
        }
      });

    return () => {
      active = false;
    };
  }, [pathname, router]);

  if (checking || !user) {
    return (
      <main className="center-screen">
        <div className="loading-panel">Verifying admin access...</div>
      </main>
    );
  }

  return <>{children(user)}</>;
}
