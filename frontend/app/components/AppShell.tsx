"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useState } from "react";
import { AdminUser, logout } from "@/lib/api";

const navItems = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/incidents", label: "Incidents" },
  { href: "/report", label: "Report" },
];

type AppShellProps = {
  user: AdminUser;
  children: ReactNode;
};

export function AppShell({ user, children }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      router.replace("/login");
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <Link className="brand" href="/dashboard">
            <span className="brand-mark">SOC</span>
            <span>
              <strong>SOC AI Agent</strong>
              <small>Admin console</small>
            </span>
          </Link>
          <nav className="nav-list" aria-label="Primary navigation">
            {navItems.map((item) => (
              <Link
                key={item.href}
                className={pathname === item.href ? "nav-link active" : "nav-link"}
                href={item.href}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="session-card">
          <span>Signed in as</span>
          <strong>{user.username}</strong>
          <button className="button ghost full" onClick={handleLogout} disabled={loggingOut}>
            {loggingOut ? "Logging out..." : "Logout"}
          </button>
        </div>
      </aside>
      <div className="content-shell">{children}</div>
    </div>
  );
}
