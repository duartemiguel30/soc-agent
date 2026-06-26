"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useEffect, useState } from "react";
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

type Theme = "light" | "dark";

function getInitialTheme(): Theme {
  if (typeof window === "undefined") {
    return "light";
  }
  return window.localStorage.getItem("soc_theme") === "dark" ? "dark" : "light";
}

function SunIcon() {
  return (
    <svg aria-hidden="true" className="theme-icon" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M4.93 4.93 6.7 6.7M17.3 17.3l1.77 1.77M2 12h2.5M19.5 12H22M4.93 19.07 6.7 17.3M17.3 6.7l1.77-1.77" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg aria-hidden="true" className="theme-icon" viewBox="0 0 24 24">
      <path d="M20.5 14.4A7.6 7.6 0 0 1 9.6 3.5 8.6 8.6 0 1 0 20.5 14.4Z" />
    </svg>
  );
}

export function AppShell({ user, children }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const nextTheme = theme === "light" ? "dark" : "light";

  function toggleTheme() {
    setTheme(nextTheme);
  }

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      router.replace("/login");
    }
  }

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [menuOpen]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("soc_theme", theme);
  }, [theme]);

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
            aria-label="Open navigation menu"
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

          {menuOpen ? (
            <button
              className="drawer-backdrop"
              type="button"
              aria-label="Close navigation menu"
              onClick={() => setMenuOpen(false)}
            />
          ) : null}

          <div className={menuOpen ? "header-menu open" : "header-menu"} id="primary-navigation">
            <div className="drawer-head">
              <div>
                <strong>Navigation</strong>
                <span>SOC AI Agent</span>
              </div>
              <button
                className="button ghost drawer-close"
                type="button"
                aria-label="Close navigation menu"
                onClick={() => setMenuOpen(false)}
              >
                X
              </button>
            </div>
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

            <div className="header-actions">
              <button
                className="theme-toggle desktop-theme-toggle"
                type="button"
                aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
                onClick={toggleTheme}
              >
                {theme === "light" ? <MoonIcon /> : <SunIcon />}
              </button>

              <button
                className="theme-toggle drawer-theme-toggle"
                type="button"
                aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
                onClick={toggleTheme}
              >
                {theme === "light" ? <MoonIcon /> : <SunIcon />}
                <span>{theme === "light" ? "Switch to dark mode" : "Switch to light mode"}</span>
              </button>

              <div className="session-card">
                <span>Signed in</span>
                <strong>{user.username}</strong>
                <button className="button ghost" onClick={handleLogout} disabled={loggingOut}>
                  {loggingOut ? "Logging out..." : "Logout"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </header>
      <div className="content-shell">{children}</div>
    </div>
  );
}
