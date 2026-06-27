"use client";

import { AlertEvolutionExplorer } from "@/app/components/AlertEvolutionExplorer";
import { AppShell } from "@/app/components/AppShell";
import { AuthGuard } from "@/app/components/AuthGuard";

export default function AlertTimelinePage() {
  return (
    <AuthGuard>
      {(user) => (
        <AppShell user={user}>
          <main className="page alerts-analytics-page">
            <div className="page-header">
              <div>
                <p className="eyebrow">Analytics</p>
                <h1>Alert/Event Timeline</h1>
              </div>
            </div>

            <section className="panel analytics-panel alert-timeline-panel">
              <AlertEvolutionExplorer mode="full" />
            </section>
          </main>
        </AppShell>
      )}
    </AuthGuard>
  );
}
