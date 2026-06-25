"use client";

import { useState } from "react";
import { AppShell } from "@/app/components/AppShell";
import { AuthGuard } from "@/app/components/AuthGuard";
import { generateReport, ReportResponse } from "@/lib/api";

export default function ReportPage() {
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGenerate() {
    setLoading(true);
    setError(null);
    try {
      setReport(await generateReport());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Report generation failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthGuard>
      {(user) => (
        <AppShell user={user}>
          <main className="page">
            <div className="page-header">
              <div>
                <p className="eyebrow">AI summary</p>
                <h1>Report</h1>
              </div>
              <button className="button primary" onClick={handleGenerate} disabled={loading}>
                {loading ? "Generating..." : "Generate report"}
              </button>
            </div>

            {error ? (
              <div className="alert error">
                {error}
                <span>
                  Check FastAPI logs and Gemini configuration if the API returned an upstream model error.
                </span>
              </div>
            ) : null}

            <section className="panel report-panel">
              {loading ? <div className="loading-panel">Generating executive SOC report...</div> : null}
              {!loading && !report ? (
                <div className="empty-state">Generate a fresh report from the latest stored incidents.</div>
              ) : null}
              {report ? (
                <>
                  <div className="section-head">
                    <h2>Generated Report</h2>
                    {typeof report.incidents_analyzed === "number" ? (
                      <span>{report.incidents_analyzed} incidents analyzed</span>
                    ) : null}
                  </div>
                  <pre className="report-output">{report.report}</pre>
                </>
              ) : null}
            </section>
          </main>
        </AppShell>
      )}
    </AuthGuard>
  );
}
