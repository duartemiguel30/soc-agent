"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { AdminUser, hasPermission, logout } from "@/lib/api";

const navItems = [
  { href: "/dashboard", label: "Dashboard", permission: "view_dashboard" },
  { href: "/analytics/alerts", label: "Alert Timeline", permission: "view_dashboard" },
  { href: "/analytics/mitre", label: "MITRE", permission: "view_dashboard" },
  { href: "/incidents", label: "Incidents", permission: "view_incidents" },
  { href: "/report", label: "Report", permission: "generate_report" },
];

type AppShellProps = {
  user: AdminUser;
  children: ReactNode;
};

type Theme = "light" | "dark";
const THEME_STORAGE_KEY = "soc_theme";
const THEME_CHANGE_EVENT = "soc-theme-change";

function normalizeTheme(value: string | null): Theme {
  return value === "dark" || value === "light" ? value : "light";
}

function readStoredTheme(): Theme {
  if (typeof window === "undefined") {
    return "light";
  }
  try {
    return normalizeTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "light";
  }
}

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

function writeStoredTheme(theme: Theme) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Theme persistence is optional; keep the UI usable if storage is blocked.
  }
  applyTheme(theme);
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

function subscribeTheme(callback: () => void) {
  if (typeof window === "undefined") {
    return () => {};
  }
  const handleThemeChange = () => {
    applyTheme(readStoredTheme());
    callback();
  };
  window.addEventListener("storage", handleThemeChange);
  window.addEventListener(THEME_CHANGE_EVENT, handleThemeChange);
  return () => {
    window.removeEventListener("storage", handleThemeChange);
    window.removeEventListener(THEME_CHANGE_EVENT, handleThemeChange);
  };
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
  const theme = useSyncExternalStore(subscribeTheme, readStoredTheme, () => "light");
  const nextTheme = theme === "light" ? "dark" : "light";
  const visibleNavItems = navItems.filter((item) => hasPermission(user, item.permission));
  const showAdminNav = hasPermission(user, "manage_users") || hasPermission(user, "view_audit");

  function toggleTheme() {
    writeStoredTheme(nextTheme);
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
              {visibleNavItems.map((item) => (
                <Link
                  key={item.href}
                  className={pathname === item.href ? "nav-link active" : "nav-link"}
                  href={item.href}
                  onClick={() => setMenuOpen(false)}
                >
                  {item.label}
                </Link>
              ))}
              {showAdminNav ? (
                <>
                  {hasPermission(user, "manage_users") ? (
                    <Link
                      className={pathname === "/admin/users" ? "nav-link active" : "nav-link"}
                      href="/admin/users"
                      onClick={() => setMenuOpen(false)}
                    >
                      Users
                    </Link>
                  ) : null}
                  {hasPermission(user, "view_audit") ? (
                    <Link
                      className={pathname === "/admin/audit" ? "nav-link active" : "nav-link"}
                      href="/admin/audit"
                      onClick={() => setMenuOpen(false)}
                    >
                      Audit
                    </Link>
                  ) : null}
                </>
              ) : null}
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
                <strong>{user.display_name || user.username}</strong>
                {user.role ? <span>{user.role}</span> : null}
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
