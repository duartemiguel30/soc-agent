"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useState } from "react";
import { AdminUser, logout } from "@/lib/api";

const navItems = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/incidents", label: "Incidents" },
  { href: "/archive", label: "Archive" },
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
  const [menuOpen, setMenuOpen] = useState(false);

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
      <header className="app-header">
        <div className="header-inner">
          <Link className="brand" href="/dashboard" onClick={() => setMenuOpen(false)}>
            <span className="brand-mark">SOC</span>
            <span>
              <strong>SOC AI Agent</strong>
              <small>Admin console</small>
            </span>
          </Link>

          <button
            className="menu-toggle"
            type="button"
            aria-expanded={menuOpen}
            aria-controls="primary-navigation"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className="hamburger" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span>Menu</span>
          </button>

          <div className={menuOpen ? "header-menu open" : "header-menu"} id="primary-navigation">
            <nav className="nav-list" aria-label="Primary navigation">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  className={pathname === item.href ? "nav-link active" : "nav-link"}
                  href={item.href}
                  onClick={() => setMenuOpen(false)}
                >
                  {item.label}
                </Link>
              ))}
            </nav>

            <div className="session-card">
              <span>Signed in</span>
              <strong>{user.username}</strong>
              <button className="button ghost" onClick={handleLogout} disabled={loggingOut}>
                {loggingOut ? "Logging out..." : "Logout"}
              </button>
            </div>
          </div>
        </div>
      </header>
      <div className="content-shell">{children}</div>
    </div>
  );
}
