"use client";

import { AlertEvolutionExplorer } from "@/app/components/AlertEvolutionExplorer";
import { AppShell } from "@/app/components/AppShell";
import { AuthGuard } from "@/app/components/AuthGuard";

export default function AlertTimelinePage() {
  return (
    <AuthGuard>
      {(user) => (
        <AppShell user={user}>
          <main className="page">
            <div className="page-header">
              <div>
                <p className="eyebrow">Analytics</p>
                <h1>Alert/Event Timeline</h1>
              </div>
            </div>

            <section className="panel analytics-panel">
              <AlertEvolutionExplorer />
            </section>
          </main>
        </AppShell>
      )}
    </AuthGuard>
  );
}
