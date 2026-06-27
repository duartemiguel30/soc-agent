import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const outputDir = path.join(repoRoot, "demo-output");
const tempVideoDir = path.join(outputDir, "raw");
const outputVideo = path.join(outputDir, "soc-ai-agent-demo.webm");

const baseUrl =
  process.env.DEMO_FRONTEND_URL ||
  process.env.DEMO_BASE_URL ||
  "http://192.168.56.105:3000";
const username = process.env.DEMO_ADMIN_USERNAME || "admin";
const password = process.env.DEMO_ADMIN_PASSWORD || "admin";
const headless = process.env.DEMO_HEADLESS !== "false";
const slowMo = Number(process.env.DEMO_SLOW_MO_MS || "120");
const pauseMs = Number(process.env.DEMO_STEP_PAUSE_MS || "1600");
const toggleTheme = process.env.DEMO_TOGGLE_THEME === "true";

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") {
      throw error;
    }
    console.error("Playwright is required for demo recording but is not installed.");
    console.error("Install it locally with: npm install --save-dev playwright");
    console.error("Then install Chromium with: npx playwright install chromium");
    return null;
  }
}

function urlFor(pathname) {
  return new URL(pathname, baseUrl).toString();
}

async function pause(page, ms = pauseMs) {
  await page.waitForTimeout(ms);
}

async function waitForPage(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(350);
}

async function showCaption(page, text) {
  await page.evaluate((captionText) => {
    const id = "soc-demo-caption";
    let caption = document.getElementById(id);
    if (!caption) {
      const style = document.createElement("style");
      style.id = "soc-demo-caption-style";
      style.textContent = `
        #${id} {
          position: fixed;
          left: 28px;
          bottom: 28px;
          z-index: 2147483647;
          max-width: min(520px, calc(100vw - 56px));
          border: 1px solid rgba(148, 163, 184, 0.45);
          border-radius: 8px;
          background: rgba(15, 23, 42, 0.88);
          color: #f8fafc;
          box-shadow: 0 18px 42px rgba(15, 23, 42, 0.28);
          font: 700 16px/1.35 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          letter-spacing: 0;
          padding: 12px 14px;
          pointer-events: none;
          opacity: 0;
          transform: translateY(8px);
          transition: opacity 220ms ease, transform 220ms ease;
        }
        #${id}.visible {
          opacity: 1;
          transform: translateY(0);
        }
      `;
      document.head.appendChild(style);
      caption = document.createElement("div");
      caption.id = id;
      document.body.appendChild(caption);
    }
    caption.textContent = captionText;
    requestAnimationFrame(() => caption.classList.add("visible"));
  }, text);
}

async function safeClick(locator, timeout = 1800) {
  try {
    await locator.first().click({ timeout });
    return true;
  } catch {
    return false;
  }
}

async function safeClickRole(page, role, name, timeout = 1800) {
  return safeClick(page.getByRole(role, { name }), timeout);
}

async function safeClickByText(page, textOrRegex, timeout = 1800) {
  return safeClick(page.getByText(textOrRegex), timeout);
}

async function safeSelect(page, label, value) {
  try {
    await page.getByLabel(label).selectOption(value, { timeout: 1800 });
    await pause(page, 700);
    return true;
  } catch {
    return false;
  }
}

async function safeSelectAny(page, label, values) {
  for (const value of values) {
    if (await safeSelect(page, label, value)) {
      return value;
    }
  }
  return null;
}

async function safeGotoOrContinue(page, pathname, caption) {
  try {
    await goto(page, pathname, caption);
    return true;
  } catch (error) {
    console.warn(`Could not navigate to ${pathname}:`, error instanceof Error ? error.message : error);
    return false;
  }
}

async function safeScrollToText(page, text, caption) {
  try {
    const locator = page.getByText(text, { exact: true }).first();
    if (!(await locator.count())) {
      return false;
    }
    await locator.scrollIntoViewIfNeeded({ timeout: 2200 });
    if (caption) {
      await showCaption(page, caption);
    }
    await pause(page);
    return true;
  } catch {
    return false;
  }
}

async function goto(page, pathname, caption) {
  await page.goto(urlFor(pathname), { waitUntil: "domcontentloaded" });
  await waitForPage(page);
  if (caption) {
    await showCaption(page, caption);
  }
  await pause(page);
}

async function clickBackToTimeline(page) {
  if (await safeClickRole(page, "link", /back to timeline/i)) {
    await waitForPage(page);
    return true;
  }
  if (await safeClickRole(page, "button", /back to timeline/i)) {
    await waitForPage(page);
    return true;
  }
  if (await safeClickByText(page, /back to timeline/i)) {
    await waitForPage(page);
    return true;
  }
  await safeGotoOrContinue(page, "/analytics/alerts", "Full alert timeline");
  return false;
}

async function readTimelineBucketCount(bucket) {
  const countText = await bucket.locator("strong").first().innerText().catch(() => "");
  const countFromStrong = Number.parseInt(countText.replace(/[^\d]/g, ""), 10);
  if (Number.isFinite(countFromStrong)) {
    return countFromStrong;
  }

  const ariaLabel = await bucket.getAttribute("aria-label").catch(() => "");
  const eventMatch = ariaLabel?.match(/,\s*(\d+)\s+events?/i);
  if (eventMatch) {
    return Number.parseInt(eventMatch[1], 10);
  }

  const title = await bucket.getAttribute("title").catch(() => "");
  const titleMatch = title?.match(/,\s*(\d+)\s+events?/i);
  if (titleMatch) {
    return Number.parseInt(titleMatch[1], 10);
  }

  return 0;
}

async function clickFirstPositiveTimelineBucket(page) {
  const buckets = page.locator("a.bar-column-link");
  const count = await buckets.count();
  if (!count) {
    return false;
  }
  for (let index = 0; index < count; index += 1) {
    const bucket = buckets.nth(index);
    const bucketCount = await readTimelineBucketCount(bucket);
    if (bucketCount <= 0) {
      continue;
    }
    await bucket.click();
    await waitForPage(page);
    return true;
  }
  return false;
}

async function login(page) {
  await goto(page, "/login", "SOC AI Agent Demo");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
  await waitForPage(page);
}

async function demonstrateDashboard(page) {
  await showCaption(page, "Dashboard: incident and alert-event metrics");
  await pause(page);
  await page.mouse.wheel(0, 280).catch(() => undefined);
  await pause(page, 700);
  await showCaption(page, "Alert/Event Evolution: correlated events over time");
  await page.getByRole("button", { name: "24h" }).click().catch(() => undefined);
  await pause(page, 900);
  await page.getByRole("button", { name: "7d" }).click().catch(() => undefined);
  await pause(page, 900);
  await page.getByRole("button", { name: "1m" }).click().catch(() => undefined);
  await pause(page, 900);
  await page.getByRole("button", { name: "1y" }).click().catch(() => undefined);
  await pause(page);
  await safeScrollToText(page, "MITRE ATT&CK Distribution", "MITRE ATT&CK distribution: event-weighted techniques");
  await safeScrollToText(page, "Severity Distribution", "Severity and decision distributions");
  await safeScrollToText(page, "Decision Distribution", "Severity and decision distributions");
  await safeScrollToText(page, "Top Agents", "Top agents by alert-event volume");
  await safeScrollToText(page, "Stored Severity Summary", "Stored incident summaries and active decision metrics");
  await safeScrollToText(page, "Active Decision Metrics", "Stored incident summaries and active decision metrics");
  await safeGotoOrContinue(page, "/dashboard", "Dashboard: incident and alert-event metrics");
}

async function demonstrateAlertTimeline(page) {
  if (!(await safeGotoOrContinue(page, "/analytics/alerts", "Full alert timeline"))) {
    return;
  }
  await showCaption(page, "Alert/Event Evolution: correlated events over time");
  for (const range of ["24h", "7d", "1m", "1y"]) {
    await safeClickRole(page, "button", range);
    await pause(page, 850);
  }
  if (await clickFirstPositiveTimelineBucket(page)) {
    await showCaption(page, "Opening an alert-period drilldown");
    await pause(page);
    await showCaption(page, "Alert drilldown: MITRE technique and severity badges");
    await page.mouse.wheel(0, 600).catch(() => undefined);
    await pause(page);
    await page.mouse.wheel(0, 1600).catch(() => undefined);
    await showCaption(page, "Alert drilldowns load more results as the analyst scrolls");
    await pause(page);
    await clickBackToTimeline(page);
    await pause(page, 900);
  }
}

async function demonstrateMitre(page) {
  if (!(await safeGotoOrContinue(page, "/analytics/mitre", "MITRE ATT&CK analytics: all techniques, event-weighted"))) {
    return;
  }
  await page.mouse.wheel(0, 700).catch(() => undefined);
  await pause(page);
  const firstTechnique = page.locator("main a.analytics-row").first();
  if (await firstTechnique.count()) {
    await showCaption(page, "Opening a MITRE-filtered incident view");
    await firstTechnique.click();
    await waitForPage(page);
    await pause(page);
    await safeGotoOrContinue(page, "/analytics/mitre", "MITRE ATT&CK analytics: all techniques, event-weighted");
  }
}

async function demonstrateIncidents(page) {
  if (!(await safeGotoOrContinue(page, "/incidents", "Incident triage queue"))) {
    return;
  }
  await showCaption(page, "Filters: archive scope, severity, and date scope");
  await safeSelectAny(page, "Archive scope", ["false", "active"]);
  await pause(page, 600);
  await safeSelectAny(page, "Archive scope", ["all"]);
  if (!(await safeSelect(page, "Severity", "critical"))) {
    await safeSelect(page, "Severity", "high");
  }
  await safeSelect(page, "Date scope", "all");
  if (await safeSelect(page, "Date scope", "day")) {
    await pause(page, 700);
    await safeSelect(page, "Date scope", "month");
    await pause(page, 700);
    await safeSelect(page, "Date scope", "year");
    await pause(page, 700);
    await safeSelect(page, "Date scope", "all");
  }
  await showCaption(page, "Incidents load progressively as the analyst scrolls");
  await page.mouse.wheel(0, 1800).catch(() => undefined);
  await pause(page);
  await safeClick(page.getByRole("button", { name: /clear filters/i }));
  await pause(page);

  const firstIncident = page.locator("main a[href^='/incidents/']").first();
  if (await firstIncident.count()) {
    await showCaption(page, "Incident detail: AI analysis and manual playbook");
    await firstIncident.click();
    await waitForPage(page);
    await pause(page);
    await demonstrateIncidentDetail(page);
  }
}

async function demonstrateIncidentDetail(page) {
  await safeScrollToText(page, "Incident Overview", "Incident detail: overview and AI analysis");
  await safeScrollToText(page, "AI Analysis", "Incident detail: overview and AI analysis");
  await safeScrollToText(page, "Alert Activity", "Alert Activity: correlated alert events in one incident");
  await safeScrollToText(page, "Observables", "Observables: extracted Wazuh/Sysmon values");
  if (!(await safeScrollToText(page, "Manual Playbook", "Manual Playbook: analyst checklist"))) {
    await safeScrollToText(page, "Create manual playbook", "Manual Playbook: analyst checklist");
    await safeScrollToText(page, "Suggested template", "Manual Playbook: analyst checklist");
    await safeScrollToText(page, "Checklist", "Manual Playbook: analyst checklist");
  }
  if (!(await safeScrollToText(page, "Response Actions", "Response Actions: analyst-controlled actions"))) {
    await safeScrollToText(page, "Suggested response actions", "Response Actions: analyst-controlled actions");
    await safeScrollToText(page, "Other available actions", "Response Actions: analyst-controlled actions");
    await safeScrollToText(page, "Unavailable actions", "Response Actions: analyst-controlled actions");
  }
  await safeScrollToText(page, "Analyst Notes", "Notes, Timeline, and Action History");
  await safeScrollToText(page, "Timeline", "Notes, Timeline, and Action History");
  await safeScrollToText(page, "Action History", "Notes, Timeline, and Action History");
}

async function demonstrateReport(page) {
  if (await safeGotoOrContinue(page, "/report", "Executive report: read-only SOC summary")) {
    await page.mouse.wheel(0, 700).catch(() => undefined);
    await pause(page);
  }
}

async function maybeToggleTheme(page) {
  if (!toggleTheme) {
    return;
  }
  await showCaption(page, "Theme check: light and dark mode");
  await safeClick(page.getByRole("button", { name: /switch to dark|switch to light/i }));
  await pause(page, 900);
  await safeClick(page.getByRole("button", { name: /switch to dark|switch to light/i }));
  await pause(page, 900);
}

async function saveRecordedVideo(page) {
  const video = page.video();
  if (!video) {
    throw new Error("Playwright did not create a video recording.");
  }
  await fs.mkdir(outputDir, { recursive: true });
  await video.saveAs(outputVideo);
}

async function main() {
  const playwright = await loadPlaywright();
  if (!playwright) {
    process.exitCode = 1;
    return;
  }
  const { chromium } = playwright;
  await fs.rm(tempVideoDir, { recursive: true, force: true });
  await fs.rm(outputVideo, { force: true });
  await fs.mkdir(tempVideoDir, { recursive: true });

  const browser = await chromium.launch({ headless, slowMo });
  let context;
  let page;
  let flowError;
  let saveError;

  try {
    context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      recordVideo: {
        dir: tempVideoDir,
        size: { width: 1440, height: 960 },
      },
    });
    page = await context.newPage();
    await login(page);
    await demonstrateDashboard(page);
    await demonstrateAlertTimeline(page);
    await demonstrateMitre(page);
    await demonstrateIncidents(page);
    await demonstrateReport(page);
    await goto(page, "/dashboard", "Back to dashboard");
    await maybeToggleTheme(page);
    await pause(page, 1200);
  } catch (error) {
    flowError = error;
    console.error("Demo flow failed before completion:", error);
  } finally {
    try {
      if (context) {
        await context.close();
      }
    } catch (error) {
      console.error("Could not close Playwright context cleanly:", error);
    }
    try {
      if (page) {
        await saveRecordedVideo(page);
      }
    } catch (error) {
      saveError = error;
      console.error("Could not save the demo video:", error);
    }
    await browser.close().catch((error) => console.error("Could not close browser cleanly:", error));
  }

  if (!saveError) {
    console.log(`Demo video saved to: ${outputVideo}`);
    console.log("Optional MP4 conversion:");
    console.log(`ffmpeg -y -i "${outputVideo}" "${path.join(outputDir, "soc-ai-agent-demo.mp4")}"`);
    console.log("Safety reminder: this demo script is read-only for incident data.");
    console.log("No incidents were approved, rejected, archived, unarchived, or executed by this script.");
  }
  if (flowError || saveError) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
