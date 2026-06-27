import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const outputDir = path.join(repoRoot, "demo-output");
const tempVideoDir = path.join(outputDir, "raw");
const outputVideo = path.join(outputDir, "soc-ai-agent-demo.webm");

function loadDemoEnvFile() {
  const frontendRoot = path.resolve(__dirname, "..");
  const candidates = process.env.DEMO_ENV_FILE
    ? [path.resolve(process.env.DEMO_ENV_FILE)]
    : [path.join(frontendRoot, ".env.demo"), path.join(repoRoot, ".env.demo")];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }

    const content = readFileSync(candidate, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }

      const equalsIndex = line.indexOf("=");
      if (equalsIndex <= 0) {
        continue;
      }

      const key = line.slice(0, equalsIndex).trim();
      let value = line.slice(equalsIndex + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      } else {
        value = value.replace(/\s+#.*$/, "").trim();
      }

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }

    console.log(`Loaded demo environment from: ${candidate}`);
    return;
  }
}

function envNumber(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value > 0 ? value : Number(fallback);
}

loadDemoEnvFile();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function demoSpeedMultiplier() {
  const numericMultiplier = Number(process.env.DEMO_SPEED_MULTIPLIER);
  if (Number.isFinite(numericMultiplier) && numericMultiplier > 0) {
    return numericMultiplier;
  }

  const speed = (process.env.DEMO_SPEED || "normal").toLowerCase();
  if (speed === "slow") {
    return 1.25;
  }
  if (speed === "fast") {
    return 0.75;
  }
  return 1;
}

const baseUrl =
  process.env.DEMO_FRONTEND_URL ||
  process.env.DEMO_BASE_URL ||
  "http://192.168.56.105:3000";
const username = process.env.DEMO_ADMIN_USERNAME || "admin";
const password = process.env.DEMO_ADMIN_PASSWORD || "admin";
const headless = process.env.DEMO_HEADLESS ? process.env.DEMO_HEADLESS !== "false" : false;
const speedMultiplier = demoSpeedMultiplier();
const slowMo = envNumber("DEMO_SLOW_MO_MS", "120");
const videoWidth = envNumber("DEMO_VIDEO_WIDTH", "1920");
const videoHeight = envNumber("DEMO_VIDEO_HEIGHT", "1080");
const generateReportInDemo = process.env.DEMO_GENERATE_REPORT !== "false";
const reportTimeoutMs = envNumber("DEMO_REPORT_TIMEOUT_MS", "90000");
const timing = {
  captionMin: envNumber("DEMO_CAPTION_MIN_MS", "1400"),
  captionMax: envNumber("DEMO_CAPTION_MAX_MS", "3200"),
  captionPerChar: envNumber("DEMO_CAPTION_PER_CHAR_MS", "32"),
  pageMin: envNumber("DEMO_PAGE_MIN_MS", "1200"),
  pageMax: envNumber("DEMO_PAGE_MAX_MS", "2600"),
  clickPause: envNumber("DEMO_CLICK_PAUSE_MS", "650"),
  hoverPause: envNumber("DEMO_HOVER_PAUSE_MS", "420"),
  filterPause: envNumber("DEMO_FILTER_PAUSE_MS", "900"),
  rangePause: envNumber("DEMO_RANGE_PAUSE_MS", "850"),
  sectionPause: envNumber("DEMO_SECTION_PAUSE_MS", "1200"),
  scrollMin: envNumber("DEMO_SCROLL_MIN_MS", "650"),
  scrollMax: envNumber("DEMO_SCROLL_MAX_MS", "1600"),
};
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

async function pause(page, ms = actionPause("normal")) {
  await page.waitForTimeout(ms);
}

function scaledTiming(value) {
  return Math.round(value * speedMultiplier);
}

function captionDuration(text, options = {}) {
  const min = options.min ?? timing.captionMin;
  const max = options.max ?? timing.captionMax;
  const perChar = options.perChar ?? timing.captionPerChar;
  return scaledTiming(clamp(min + text.length * perChar, min, max));
}

function actionPause(kind) {
  const values = {
    hover: timing.hoverPause,
    click: timing.clickPause,
    filter: timing.filterPause,
    range: timing.rangePause,
    section: timing.sectionPause,
    page: (timing.pageMin + timing.pageMax) / 2,
    low: 700,
    normal: timing.sectionPause,
    high: 1800,
  };
  return scaledTiming(values[kind] ?? values.normal);
}

async function pauseForCaption(page, text, options = {}) {
  await pause(page, captionDuration(text, options));
}

async function pauseForAction(page, kind) {
  await pause(page, actionPause(kind));
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
  await pauseForCaption(page, text);
}

async function ensureDemoCursor(page) {
  await page.evaluate(() => {
    const id = "soc-demo-cursor";
    if (!document.getElementById("soc-demo-cursor-style")) {
      const style = document.createElement("style");
      style.id = "soc-demo-cursor-style";
      style.textContent = `
        #${id} {
          position: fixed;
          left: 48px;
          top: 48px;
          width: 32px;
          height: 32px;
          z-index: 2147483647;
          pointer-events: none;
          opacity: 0.96;
          filter: drop-shadow(0 3px 5px rgba(15, 23, 42, 0.28));
          transform-origin: 3px 3px;
          transition: transform 140ms ease, opacity 180ms ease;
        }
        #${id} svg {
          display: block;
          width: 32px;
          height: 32px;
        }
        #${id}.clicking {
          transform: scale(0.92);
        }
        #${id}.clicking::after {
          content: "";
          position: absolute;
          left: -5px;
          top: -5px;
          width: 18px;
          height: 18px;
          border: 2px solid rgba(37, 99, 235, 0.45);
          border-radius: 999px;
          animation: soc-demo-click-ripple 260ms ease-out forwards;
        }
        @keyframes soc-demo-click-ripple {
          from {
            opacity: 0.85;
            transform: scale(0.5);
          }
          to {
            opacity: 0;
            transform: scale(1.8);
          }
        }
      `;
      document.head.appendChild(style);
    }
    if (!document.getElementById(id)) {
      const cursor = document.createElement("div");
      cursor.id = id;
      cursor.setAttribute("aria-hidden", "true");
      cursor.dataset.x = "48";
      cursor.dataset.y = "48";
      cursor.innerHTML = `
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <path d="M4 3.5 25.2 17.2 15.2 19.1 10.2 28.5 4 3.5Z" fill="#ffffff" stroke="#111827" stroke-width="2" stroke-linejoin="round" />
          <path d="M13.9 18.4 18.6 27" fill="none" stroke="#111827" stroke-width="2.3" stroke-linecap="round" />
        </svg>
      `;
      document.body.appendChild(cursor);
    }
  });
}

async function glideCursorTo(page, x, y, options = {}) {
  await ensureDemoCursor(page);
  await page.evaluate(
    ({ nextX, nextY, minDuration, maxDuration, durationOverride }) =>
      new Promise((resolve) => {
      const cursor = document.getElementById("soc-demo-cursor");
      if (!cursor) {
          resolve();
        return;
      }

        const currentX = Number(cursor.dataset.x || cursor.style.left.replace("px", "") || 48);
        const currentY = Number(cursor.dataset.y || cursor.style.top.replace("px", "") || 48);
        const distance = Math.hypot(nextX - currentX, nextY - currentY);
        const duration = durationOverride || Math.min(maxDuration, Math.max(minDuration, distance * 1.2));
        const start = performance.now();
        const easeOutCubic = (value) => 1 - Math.pow(1 - value, 3);

      cursor.style.opacity = "0.96";
        function frame(now) {
          const progress = Math.min(1, (now - start) / duration);
          const eased = easeOutCubic(progress);
          const x = currentX + (nextX - currentX) * eased;
          const y = currentY + (nextY - currentY) * eased;
          cursor.style.left = `${x}px`;
          cursor.style.top = `${y}px`;
          cursor.dataset.x = String(x);
          cursor.dataset.y = String(y);
          if (progress < 1) {
            requestAnimationFrame(frame);
          } else {
            cursor.style.left = `${nextX}px`;
            cursor.style.top = `${nextY}px`;
            cursor.dataset.x = String(nextX);
            cursor.dataset.y = String(nextY);
            resolve();
          }
        }
        requestAnimationFrame(frame);
      }),
    {
      nextX: x,
      nextY: y,
      minDuration: scaledTiming(options.minDuration ?? 320),
      maxDuration: scaledTiming(options.maxDuration ?? 900),
      durationOverride: options.duration ? scaledTiming(options.duration) : null,
    },
  );
  await page.mouse.move(x, y).catch(() => undefined);
}

async function moveDemoCursor(page, x, y, options = {}) {
  await glideCursorTo(page, x, y, options);
}

async function setDemoCursorClicking(page, clicking) {
  await page.evaluate((isClicking) => {
    const cursor = document.getElementById("soc-demo-cursor");
    if (cursor) {
      cursor.classList.toggle("clicking", isClicking);
    }
  }, clicking);
}

async function locatorCenter(locator) {
  const box = await locator.first().boundingBox().catch(() => null);
  if (!box) {
    return null;
  }
  return {
    x: box.x + box.width / 2,
    y: box.y + Math.min(box.height / 2, 42),
  };
}

async function moveCursorToLocator(page, locator) {
  const center = await locatorCenter(locator);
  if (!center) {
    return false;
  }
  await moveDemoCursor(page, center.x, center.y);
  return true;
}

async function currentScrollY(page) {
  return page.evaluate(() => window.scrollY || document.documentElement.scrollTop || 0);
}

async function smoothScrollToY(page, targetY, options = {}) {
  await page.evaluate(
    ({ nextY, minDuration, maxDuration, durationOverride }) =>
      new Promise((resolve) => {
        const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        const startY = window.scrollY || document.documentElement.scrollTop || 0;
        const endY = Math.min(maxScroll, Math.max(0, nextY));
        const distance = endY - startY;
        if (Math.abs(distance) < 2) {
          resolve();
          return;
        }

        const duration = durationOverride || Math.min(maxDuration, Math.max(minDuration, Math.abs(distance) * 0.45));
        const start = performance.now();
        const easeOutCubic = (value) => 1 - Math.pow(1 - value, 3);

        function frame(now) {
          const progress = Math.min(1, (now - start) / duration);
          const eased = easeOutCubic(progress);
          window.scrollTo(0, startY + distance * eased);
          if (progress < 1) {
            requestAnimationFrame(frame);
          } else {
            window.scrollTo(0, endY);
            resolve();
          }
        }
        requestAnimationFrame(frame);
      }),
    {
      nextY: targetY,
      minDuration: scaledTiming(options.minDuration ?? timing.scrollMin),
      maxDuration: scaledTiming(options.maxDuration ?? timing.scrollMax),
      durationOverride: options.duration ? scaledTiming(options.duration) : null,
    },
  );
}

async function smoothScrollBy(page, distance, options = {}) {
  const viewport = page.viewportSize() || { width: videoWidth, height: videoHeight };
  const segmentSize = options.segmentSize || Math.round(viewport.height * 0.78);
  let remaining = distance;
  while (Math.abs(remaining) > segmentSize) {
    const step = Math.sign(remaining) * segmentSize;
    await smoothScrollToY(page, (await currentScrollY(page)) + step, options);
    await pause(page, scaledTiming(140));
    remaining -= step;
  }
  if (Math.abs(remaining) > 1) {
    await smoothScrollToY(page, (await currentScrollY(page)) + remaining, options);
  }
}

async function smoothScrollToLocator(page, locator, options = {}) {
  const target = locator.first();
  if (!(await target.count().catch(() => 0))) {
    return false;
  }

  const viewport = page.viewportSize() || { width: videoWidth, height: videoHeight };
  const desiredY = options.desiredY ?? Math.round(viewport.height * 0.42);
  const center = await locatorCenter(target);
  if (center) {
    const alreadyVisible = center.y >= viewport.height * 0.18 && center.y <= viewport.height * 0.78;
    if (!alreadyVisible || Math.abs(center.y - desiredY) > 90) {
      const scrollY = await currentScrollY(page);
      await smoothScrollToY(page, scrollY + center.y - desiredY, options);
    }
    const updatedCenter = (await locatorCenter(target)) || center;
    await moveDemoCursor(
      page,
      Math.min(viewport.width - 80, Math.max(24, updatedCenter.x)),
      Math.min(viewport.height - 80, Math.max(24, updatedCenter.y)),
    );
    return true;
  }

  await target.scrollIntoViewIfNeeded({ timeout: 2200 }).catch(() => undefined);
  return true;
}

async function smoothScrollToText(page, text, caption, options = {}) {
  try {
    const locator = page.getByText(text, { exact: true }).first();
    if (!(await locator.count())) {
      return false;
    }
    if (caption) {
      await showCaption(page, caption);
    }
    await smoothScrollToLocator(page, locator);
    await pauseForAction(page, options.importance || "section");
    return true;
  } catch {
    return false;
  }
}

async function clickWithDemoCursor(page, locator, caption, options = {}) {
  const target = locator.first();
  const timeout = options.timeout || 2200;
  try {
    if (!(await target.count())) {
      return false;
    }
    if (caption) {
      await showCaption(page, caption);
    }
    await smoothScrollToLocator(page, target, { desiredY: Math.round((page.viewportSize()?.height || videoHeight) * 0.38) });
    await moveCursorToLocator(page, target);
    await pauseForAction(page, "hover");
    await setDemoCursorClicking(page, true);
    await target.click({ timeout });
    await pause(page, scaledTiming(150));
    await setDemoCursorClicking(page, false);
    await pauseForAction(page, options.actionKind || "click");
    return true;
  } catch {
    await setDemoCursorClicking(page, false).catch(() => undefined);
    return false;
  }
}

async function safeSelect(page, label, value) {
  try {
    const field = page.getByLabel(label).first();
    await smoothScrollToLocator(page, field, { desiredY: Math.round((page.viewportSize()?.height || videoHeight) * 0.45) });
    await moveCursorToLocator(page, field);
    await pauseForAction(page, "hover");
    await field.selectOption(value, { timeout: 1800 });
    await pauseForAction(page, "filter");
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

async function safeScrollToText(page, text, caption, options = {}) {
  return smoothScrollToText(page, text, caption, options);
}

async function reportPanelText(page) {
  return page.locator(".report-panel").first().innerText().catch(() => "");
}

async function waitForReportResult(page, initialText) {
  try {
    await page
      .locator(".loading-panel")
      .first()
      .waitFor({ state: "visible", timeout: 2500 })
      .catch(() => undefined);

    await page.waitForFunction(
      ({ initial, minLength }) => {
        const panel = document.querySelector(".report-panel");
        const text = panel?.textContent?.trim() || "";
        const hasReport = Boolean(panel?.querySelector(".report-blocks, .report-output"));
        const loading = Boolean(panel?.querySelector(".loading-panel"));
        const changed = text !== initial && text.length >= minLength;
        return !loading && (hasReport || changed);
      },
      { initial: initialText.trim(), minLength: 120 },
      { timeout: reportTimeoutMs, polling: 750 },
    );
    return true;
  } catch {
    return false;
  }
}

async function goto(page, pathname, caption) {
  await page.goto(urlFor(pathname), { waitUntil: "domcontentloaded" });
  await waitForPage(page);
  await ensureDemoCursor(page);
  await moveDemoCursor(page, Math.round(videoWidth * 0.16), Math.round(videoHeight * 0.18));
  if (caption) {
    await showCaption(page, caption);
  }
  await pauseForAction(page, "page");
}

async function clickBackToTimeline(page) {
  if (await clickWithDemoCursor(page, page.getByRole("link", { name: /back to timeline/i }), "Back to the full alert timeline")) {
    await waitForPage(page);
    return true;
  }
  if (await clickWithDemoCursor(page, page.getByRole("button", { name: /back to timeline/i }), "Back to the full alert timeline")) {
    await waitForPage(page);
    return true;
  }
  if (await clickWithDemoCursor(page, page.getByText(/back to timeline/i), "Back to the full alert timeline")) {
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
    if (!(await clickWithDemoCursor(page, bucket, "Opening an alert-period drilldown"))) {
      continue;
    }
    await waitForPage(page);
    return true;
  }
  return false;
}

async function login(page) {
  await goto(page, "/login", "SOC AI Agent Demo");
  await clickWithDemoCursor(page, page.getByLabel("Username"), "Signing in to the admin console");
  await page.getByLabel("Username").fill(username);
  await moveCursorToLocator(page, page.getByLabel("Password"));
  await page.getByLabel("Password").fill(password);
  await clickWithDemoCursor(page, page.getByRole("button", { name: /sign in/i }));
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
  await waitForPage(page);
  await ensureDemoCursor(page);
}

async function demonstrateDashboard(page) {
  await showCaption(page, "Dashboard metrics: incidents vs alert events");
  await smoothScrollBy(page, 320);
  await pauseForAction(page, "low");
  await showCaption(page, "Alert/Event Evolution: correlated events over time");
  await clickWithDemoCursor(page, page.getByRole("button", { name: "24h" }), undefined, { actionKind: "range" });
  await clickWithDemoCursor(page, page.getByRole("button", { name: "7d" }), undefined, { actionKind: "range" });
  await clickWithDemoCursor(page, page.getByRole("button", { name: "1m" }), undefined, { actionKind: "range" });
  await clickWithDemoCursor(page, page.getByRole("button", { name: "1y" }), undefined, { actionKind: "range" });
  await safeScrollToText(page, "MITRE ATT&CK Distribution", "MITRE ATT&CK: event-weighted techniques", { importance: "high" });
  await safeScrollToText(page, "Severity Distribution", "Severity and decision distributions");
  await safeScrollToText(page, "Decision Distribution", "Severity and decision distributions");
  await safeScrollToText(page, "Top Agents", "Top agents by alert-event volume");
  await safeScrollToText(page, "Stored Severity Summary", "Stored incident summaries and active decision metrics");
  await safeScrollToText(page, "Active Decision Metrics", "Stored incident summaries and active decision metrics");
  await safeGotoOrContinue(page, "/dashboard", "Dashboard metrics: incidents vs alert events");
}

async function demonstrateAlertTimeline(page) {
  if (!(await safeGotoOrContinue(page, "/analytics/alerts", "Full alert timeline"))) {
    return;
  }
  await showCaption(page, "Alert/Event Evolution: correlated events over time");
  for (const range of ["24h", "7d", "1m", "1y"]) {
    await clickWithDemoCursor(page, page.getByRole("button", { name: range }), `Timeline range: ${range}`, { actionKind: "range" });
  }
  if (await clickFirstPositiveTimelineBucket(page)) {
    await showCaption(page, "Alert drilldown: MITRE technique and severity badges");
    await smoothScrollBy(page, 720);
    await pauseForAction(page, "section");
    await smoothScrollBy(page, 1700);
    await showCaption(page, "Alert drilldowns load more results as the analyst scrolls");
    await clickBackToTimeline(page);
  }
}

async function demonstrateMitre(page) {
  if (!(await safeGotoOrContinue(page, "/analytics/mitre", "MITRE ATT&CK: event-weighted techniques"))) {
    return;
  }
  await smoothScrollBy(page, 760);
  await pauseForAction(page, "section");
  const firstTechnique = page.locator("main a.analytics-row").first();
  if (await firstTechnique.count()) {
    await clickWithDemoCursor(page, firstTechnique, "Opening a MITRE-filtered incident view");
    await waitForPage(page);
    await pauseForAction(page, "page");
    await safeGotoOrContinue(page, "/analytics/mitre", "MITRE ATT&CK: event-weighted techniques");
  }
}

async function demonstrateIncidents(page) {
  if (!(await safeGotoOrContinue(page, "/incidents", "Incident triage queue"))) {
    return;
  }
  await showCaption(page, "Incident filters: archive scope, severity, date");
  await safeSelectAny(page, "Archive scope", ["false", "active"]);
  await safeSelectAny(page, "Archive scope", ["all"]);
  if (!(await safeSelect(page, "Severity", "critical"))) {
    await safeSelect(page, "Severity", "high");
  }
  await safeSelect(page, "Date scope", "all");
  if (await safeSelect(page, "Date scope", "day")) {
    await safeSelect(page, "Date scope", "month");
    await safeSelect(page, "Date scope", "year");
    await safeSelect(page, "Date scope", "all");
  }
  await showCaption(page, "Incidents load progressively as the analyst scrolls");
  await smoothScrollBy(page, 1900);
  await pauseForAction(page, "section");
  await clickWithDemoCursor(page, page.getByRole("button", { name: /clear filters/i }), "Clearing filters to show the full queue");

  const firstIncident = page.locator("main a[href^='/incidents/']").first();
  if (await firstIncident.count()) {
    await clickWithDemoCursor(page, firstIncident, "Incident detail: AI analysis and manual response workflow");
    await waitForPage(page);
    await pauseForAction(page, "page");
    await demonstrateIncidentDetail(page);
  }
}

async function demonstrateIncidentDetail(page) {
  await safeScrollToText(page, "Incident Overview", "Incident detail: overview and AI analysis");
  await safeScrollToText(page, "AI Analysis", "Incident detail: overview and AI analysis");
  await safeScrollToText(page, "Alert Activity", "Alert Activity: correlated alert events in one incident");
  await safeScrollToText(page, "Observables", "Observables: extracted Wazuh/Sysmon values", { importance: "high" });
  if (!(await safeScrollToText(page, "Manual Playbook", "Manual Playbook: analyst checklist"))) {
    await safeScrollToText(page, "Create manual playbook", "Manual Playbook: analyst checklist");
    await safeScrollToText(page, "Suggested template", "Manual Playbook: analyst checklist");
    await safeScrollToText(page, "Checklist", "Manual Playbook: analyst checklist");
  }
  if (!(await safeScrollToText(page, "Response Actions", "Response Actions: analyst-controlled actions", { importance: "high" }))) {
    await safeScrollToText(page, "Suggested response actions", "Response Actions: analyst-controlled actions", { importance: "high" });
    await safeScrollToText(page, "Other available actions", "Response Actions: analyst-controlled actions", { importance: "high" });
    await safeScrollToText(page, "Unavailable actions", "Response Actions: analyst-controlled actions", { importance: "high" });
  }
  await safeScrollToText(page, "Analyst Notes", "Notes, Timeline, and Action History");
  await safeScrollToText(page, "Timeline", "Notes, Timeline, and Action History");
  await safeScrollToText(page, "Action History", "Notes, Timeline, and Action History");
}

async function demonstrateReport(page) {
  if (!(await safeGotoOrContinue(page, "/report", "Executive report: read-only SOC summary"))) {
    return;
  }

  if (!generateReportInDemo) {
    await smoothScrollBy(page, 760);
    await pauseForAction(page, "section");
    return;
  }

  const generateButton = page.getByRole("button", { name: /generate report/i }).first();
  const canGenerate = (await generateButton.count().catch(() => 0)) && (await generateButton.isEnabled().catch(() => false));
  if (!canGenerate) {
    await showCaption(page, "Report generation is unavailable in this environment");
    await safeScrollToText(page, "Executive report scope", undefined, { importance: "normal" });
    return;
  }

  const initialText = await reportPanelText(page);
  if (!(await clickWithDemoCursor(page, generateButton, undefined, { actionKind: "click", timeout: 3000 }))) {
    await showCaption(page, "Report generation is unavailable in this environment");
    return;
  }

  await showCaption(page, "Generating the executive SOC report");
  await moveCursorToLocator(page, page.locator(".report-panel").first());
  const reportReady = await waitForReportResult(page, initialText);
  if (reportReady) {
    await showCaption(page, "AI-generated executive summary from stored incidents");
  } else {
    await showCaption(page, "Report generation is unavailable in this environment");
  }

  if (!(await safeScrollToText(page, "Generated Report", undefined, { importance: "high" }))) {
    await smoothScrollToLocator(page, page.locator(".report-panel").first());
  }
  await smoothScrollBy(page, 980);
  await pauseForAction(page, "high");
}

async function maybeToggleTheme(page) {
  if (!toggleTheme) {
    return;
  }
  await showCaption(page, "Theme check: light and dark mode");
  await clickWithDemoCursor(page, page.getByRole("button", { name: /switch to dark|switch to light/i }));
  await clickWithDemoCursor(page, page.getByRole("button", { name: /switch to dark|switch to light/i }));
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
      viewport: { width: videoWidth, height: videoHeight },
      recordVideo: {
        dir: tempVideoDir,
        size: { width: videoWidth, height: videoHeight },
      },
    });
    page = await context.newPage();
    await login(page);
    await demonstrateDashboard(page);
    await demonstrateAlertTimeline(page);
    await demonstrateMitre(page);
    await demonstrateIncidents(page);
    await demonstrateReport(page);
    await goto(page, "/dashboard", "Back to dashboard metrics");
    await maybeToggleTheme(page);
    await pauseForAction(page, "page");
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
    console.log("High-quality 4K MP4 conversion:");
    console.log(
      `ffmpeg -y -i "${outputVideo}" -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p "${path.join(outputDir, "soc-ai-agent-demo-4k.mp4")}"`,
    );
    console.log("Faster test MP4 conversion:");
    console.log(
      `ffmpeg -y -i "${outputVideo}" -c:v libx264 -crf 23 -preset medium -pix_fmt yuv420p "${path.join(outputDir, "soc-ai-agent-demo.mp4")}"`,
    );
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
