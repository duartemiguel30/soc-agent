"use client";

import { useMemo, useState } from "react";
import { AppShell } from "@/app/components/AppShell";
import { AuthGuard } from "@/app/components/AuthGuard";
import { generateReport, ReportResponse } from "@/lib/api";

type ReportBlock =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] };

function cleanMarkdown(value: string) {
  return value
    .replace(/^#{1,6}\s*/, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .trim();
}

function parseReport(text: string): ReportBlock[] {
  const blocks: ReportBlock[] = [];
  const paragraph: string[] = [];
  let currentList: { ordered: boolean; items: string[] } | null = null;

  function flushParagraph() {
    if (paragraph.length) {
      blocks.push({ type: "paragraph", text: cleanMarkdown(paragraph.join(" ")) });
      paragraph.length = 0;
    }
  }

  function flushList() {
    if (currentList) {
      blocks.push({ type: "list", ordered: currentList.ordered, items: currentList.items });
      currentList = null;
    }
  }

  text.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      return;
    }

    const headingMatch = trimmed.match(/^(?:#{1,6}\s*)?(?:\d+\.\s*)?(Executive Summary|Key Findings|False Positives Identified|Recommended Actions|Overall Risk Assessment|Risk Assessment)[:\s-]*(.*)$/i);
    if (headingMatch) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", text: cleanMarkdown(headingMatch[1]) });
      if (headingMatch[2]) {
        paragraph.push(headingMatch[2]);
      }
      return;
    }

    const bulletMatch = trimmed.match(/^[-*•]\s+(.+)$/);
    const orderedMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (bulletMatch || orderedMatch) {
      flushParagraph();
      const ordered = Boolean(orderedMatch);
      const item = cleanMarkdown((bulletMatch || orderedMatch)?.[1] || "");
      if (!currentList || currentList.ordered !== ordered) {
        flushList();
        currentList = { ordered, items: [] };
      }
      currentList.items.push(item);
      return;
    }

    flushList();
    paragraph.push(trimmed);
  });

  flushParagraph();
  flushList();
  return blocks;
}

function ReportContent({ text }: { text: string }) {
  const blocks = useMemo(() => parseReport(text), [text]);

  if (!blocks.length) {
    return <pre className="report-output">{text}</pre>;
  }

  return (
    <div className="report-blocks">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          return <h2 key={`${block.type}-${index}`}>{block.text}</h2>;
        }
        if (block.type === "list") {
          const ListTag = block.ordered ? "ol" : "ul";
          return (
            <ListTag key={`${block.type}-${index}`}>
              {block.items.map((item, itemIndex) => (
                <li key={`${item}-${itemIndex}`}>{item}</li>
              ))}
            </ListTag>
          );
        }
        return <p key={`${block.type}-${index}`}>{block.text}</p>;
      })}
    </div>
  );
}

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
          <main className="page report-page">
            <div className="page-header">
              <div>
                <p className="eyebrow">AI summary</p>
                <h1>Report</h1>
              </div>
              <div className="toolbar">
                <button className="button primary" onClick={handleGenerate} disabled={loading}>
                  {loading ? "Generating..." : "Generate report"}
                </button>
              </div>
            </div>

            <section className="panel report-scope">
              <h2>Executive report scope</h2>
              <p>
                This page requests an AI-generated executive summary from the FastAPI `/report` endpoint based on
                currently stored incidents. The current backend report is not filtered by incident selection or date
                range.
              </p>
              <p className="muted">Generation may take time if Gemini or upstream API limits are slow to respond.</p>
            </section>

            {error ? (
              <div className="alert error">
                {error}
                <span>Check FastAPI logs, Gemini configuration, and API quota if report generation fails.</span>
              </div>
            ) : null}

            <section className="panel report-panel">
              {loading ? <div className="loading-panel">Generating executive SOC report...</div> : null}
              {!loading && !report ? (
                <div className="empty-state">Generate a report to summarize the latest stored incidents.</div>
              ) : null}
              {report ? (
                <>
                  <div className="section-head">
                    <h2>Generated Report</h2>
                    {typeof report.incidents_analyzed === "number" ? (
                      <span>{report.incidents_analyzed} incidents analyzed</span>
                    ) : null}
                  </div>
                  <ReportContent text={report.report} />
                </>
              ) : null}
            </section>
          </main>
        </AppShell>
      )}
    </AuthGuard>
  );
}
