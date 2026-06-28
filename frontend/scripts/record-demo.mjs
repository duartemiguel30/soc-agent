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

function envBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  return value.trim().toLowerCase() === "true";
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

  const speed = (process.env.DEMO_SPEED || "fast").toLowerCase();
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
const externalRecordingMode = envBoolean("DEMO_EXTERNAL_RECORDING_MODE", false);
const recordVideo = process.env.DEMO_RECORD_VIDEO === undefined || process.env.DEMO_RECORD_VIDEO === ""
  ? !externalRecordingMode
  : envBoolean("DEMO_RECORD_VIDEO", true);
const fullscreen = envBoolean("DEMO_FULLSCREEN", false);
const headless = externalRecordingMode ? false : process.env.DEMO_HEADLESS ? process.env.DEMO_HEADLESS !== "false" : false;
const speedMultiplier = demoSpeedMultiplier();
const slowMo = Math.round(envNumber("DEMO_SLOW_MO_MS", "120") * speedMultiplier);
const videoWidth = envNumber("DEMO_VIDEO_WIDTH", "1920");
const videoHeight = envNumber("DEMO_VIDEO_HEIGHT", "1080");
const startDelayMs = envNumber("DEMO_START_DELAY_MS", "5000");
const generateReportInDemo = process.env.DEMO_GENERATE_REPORT !== "false";
const reportTimeoutMs = envNumber("DEMO_REPORT_TIMEOUT_MS", "90000");
const demoStartTheme = process.env.DEMO_START_THEME || "light";
const switchToDarkAfterLogin = envBoolean("DEMO_SWITCH_TO_DARK_AFTER_LOGIN", true);
const finalCaption = process.env.DEMO_FINAL_CAPTION || "Hope you enjoyed the presentation";
const finalCaptionMs = envNumber("DEMO_FINAL_CAPTION_MS", "2600");
const timing = {
  captionMin: envNumber("DEMO_CAPTION_MIN_MS", "850"),
  captionMax: envNumber("DEMO_CAPTION_MAX_MS", "2100"),
  captionPerChar: envNumber("DEMO_CAPTION_PER_CHAR_MS", "20"),
  captionIntro: envNumber("DEMO_CAPTION_INTRO_MS", "250"),
  stepSettle: envNumber("DEMO_STEP_SETTLE_MS", "550"),
  importantStepSettle: envNumber("DEMO_IMPORTANT_STEP_SETTLE_MS", "900"),
  pageMin: envNumber("DEMO_PAGE_MIN_MS", "700"),
  pageMax: envNumber("DEMO_PAGE_MAX_MS", "1500"),
  clickPause: envNumber("DEMO_CLICK_PAUSE_MS", "380"),
  hoverPause: envNumber("DEMO_HOVER_PAUSE_MS", "220"),
  filterPause: envNumber("DEMO_FILTER_PAUSE_MS", "500"),
  rangePause: envNumber("DEMO_RANGE_PAUSE_MS", "520"),
  sectionPause: envNumber("DEMO_SECTION_PAUSE_MS", "700"),
  scrollMin: envNumber("DEMO_SCROLL_MIN_MS", "380"),
  scrollMax: envNumber("DEMO_SCROLL_MAX_MS", "1000"),
};
const toggleTheme = process.env.DEMO_TOGGLE_THEME === "true";
let keepDarkTheme = false;
let startDelayCompleted = false;

function launchArgs() {
  if (!fullscreen && !externalRecordingMode) {
    return [];
  }
  return ["--start-fullscreen", `--window-size=${videoWidth},${videoHeight}`];
}

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

async function setInitialTheme(context, theme) {
  const normalizedTheme = theme === "dark" ? "dark" : "light";
  await context.addInitScript((nextTheme) => {
    try {
      const storedTheme = localStorage.getItem("soc_theme");
      const themeToApply = storedTheme === "dark" || storedTheme === "light" ? storedTheme : nextTheme;
      localStorage.setItem("soc_theme", themeToApply);
      document.documentElement.dataset.theme = themeToApply;
      document.documentElement.style.colorScheme = themeToApply;
      document.documentElement.classList.toggle("dark", themeToApply === "dark");
      let style = document.getElementById("soc-demo-theme-prepaint");
      if (!style) {
        style = document.createElement("style");
        style.id = "soc-demo-theme-prepaint";
        document.documentElement.appendChild(style);
      }
      style.textContent =
        themeToApply === "dark"
          ? "html, body { background: #020617 !important; color-scheme: dark; }"
          : "html, body { background: #f3f6fa !important; color-scheme: light; }";
    } catch {}
  }, normalizedTheme);
}

async function forceTheme(page, theme) {
  const normalizedTheme = theme === "dark" ? "dark" : "light";
  await page.evaluate((nextTheme) => {
    localStorage.setItem("soc_theme", nextTheme);
    document.documentElement.dataset.theme = nextTheme;
    document.documentElement.style.colorScheme = nextTheme;
    document.documentElement.classList.toggle("dark", nextTheme === "dark");
    let style = document.getElementById("soc-demo-theme-prepaint");
    if (!style) {
      style = document.createElement("style");
      style.id = "soc-demo-theme-prepaint";
      document.documentElement.appendChild(style);
    }
    style.textContent =
      nextTheme === "dark"
        ? "html, body { background: #020617 !important; color-scheme: dark; }"
        : "html, body { background: #f3f6fa !important; color-scheme: light; }";
  }, normalizedTheme);
}

async function ensureTheme(page, theme, options = {}) {
  const normalizedTheme = theme === "dark" ? "dark" : "light";
  const currentTheme = await page.evaluate(() => document.documentElement.dataset.theme || "light").catch(() => "light");
  if (currentTheme === normalizedTheme) {
    return;
  }
  if (options.visible) {
    const label = normalizedTheme === "dark" ? /switch to dark mode/i : /switch to light mode/i;
    const toggled = await clickWithDemoCursor(page, page.getByRole("button", { name: label }).first(), options.caption, { actionKind: "important" });
    if (toggled) {
      await page.waitForFunction((nextTheme) => document.documentElement.dataset.theme === nextTheme, normalizedTheme, { timeout: 4000 });
      return;
    }
  }
  await forceTheme(page, normalizedTheme);
  await page.waitForFunction((nextTheme) => document.documentElement.dataset.theme === nextTheme, normalizedTheme, { timeout: 4000 });
}

async function ensureDarkTheme(page) {
  await ensureTheme(page, "dark");
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
    important: timing.importantStepSettle,
  };
  return scaledTiming(values[kind] ?? values.normal);
}

async function pauseForCaption(page, text, options = {}) {
  await pause(page, captionDuration(text, options));
}

async function pauseForCaptionIntro(page) {
  await pause(page, scaledTiming(timing.captionIntro));
}

async function pauseForActionSettle(page, importance = "normal") {
  const duration = importance === "important" || importance === "high" ? timing.importantStepSettle : timing.stepSettle;
  await pause(page, scaledTiming(duration));
}

async function runDemoStep(page, caption, action, options = {}) {
  if (caption) {
    await showCaption(page, caption, { wait: false });
    await pauseForCaptionIntro(page);
  }
  const result = await action();
  await pauseForActionSettle(page, options.importance || options.actionKind || "normal");
  return result;
}

async function pauseForAction(page, kind) {
  await pause(page, actionPause(kind));
}

async function waitForPage(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(350);
}

async function showCaption(page, text, options = {}) {
  await page.evaluate((captionText) => {
    const id = "soc-demo-caption";
    let caption = document.getElementById(id);
    if (!caption) {
      const style = document.createElement("style");
      style.id = "soc-demo-caption-style";
      style.textContent = `
        #${id} {
          position: fixed;
          right: 28px;
          bottom: 28px;
          z-index: 2147483647;
          max-width: min(680px, calc(100vw - 56px));
          border: 1px solid rgba(148, 163, 184, 0.55);
          border-radius: calc(12px * var(--soc-demo-caption-scale, 1));
          background: rgba(15, 23, 42, 0.92);
          color: #f8fafc;
          box-shadow: 0 20px 48px rgba(15, 23, 42, 0.35);
          font: 700 calc(18px * var(--soc-demo-caption-scale, 1))/1.35 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          letter-spacing: 0;
          padding: calc(16px * var(--soc-demo-caption-scale, 1)) calc(18px * var(--soc-demo-caption-scale, 1));
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
    const scale = Math.max(1, Math.min(1.35, window.innerWidth / 1920));
    caption.style.setProperty("--soc-demo-caption-scale", String(scale));
    caption.textContent = captionText;
    requestAnimationFrame(() => caption.classList.add("visible"));
  }, text);
  if (options.wait !== false) {
    await pauseForCaption(page, text, options);
  }
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
    ({ nextX, nextY, minDuration, maxDuration, durationOverride, durationMultiplier }) =>
      new Promise((resolve) => {
      const cursor = document.getElementById("soc-demo-cursor");
      if (!cursor) {
          resolve();
        return;
      }

        const currentX = Number(cursor.dataset.x || cursor.style.left.replace("px", "") || 48);
        const currentY = Number(cursor.dataset.y || cursor.style.top.replace("px", "") || 48);
        const distance = Math.hypot(nextX - currentX, nextY - currentY);
        const duration = durationOverride || Math.min(maxDuration, Math.max(minDuration, distance * 1.2 * durationMultiplier));
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
      durationMultiplier: speedMultiplier,
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
    ({ nextY, minDuration, maxDuration, durationOverride, durationMultiplier }) =>
      new Promise((resolve) => {
        const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        const startY = window.scrollY || document.documentElement.scrollTop || 0;
        const endY = Math.min(maxScroll, Math.max(0, nextY));
        const distance = endY - startY;
        if (Math.abs(distance) < 2) {
          resolve();
          return;
        }

        const duration = durationOverride || Math.min(maxDuration, Math.max(minDuration, Math.abs(distance) * 0.45 * durationMultiplier));
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
      durationMultiplier: speedMultiplier,
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
      await runDemoStep(page, caption, () => smoothScrollToLocator(page, locator), { importance: options.importance || "normal" });
    } else {
      await smoothScrollToLocator(page, locator);
      await pauseForAction(page, options.importance || "section");
    }
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
    const clickAction = async () => {
      await smoothScrollToLocator(page, target, { desiredY: Math.round((page.viewportSize()?.height || videoHeight) * 0.38) });
      await moveCursorToLocator(page, target);
      await pauseForAction(page, "hover");
      await setDemoCursorClicking(page, true);
      await target.click({ timeout });
      await pause(page, scaledTiming(150));
      await setDemoCursorClicking(page, false);
    };
    if (caption) {
      await runDemoStep(page, caption, clickAction, { importance: options.actionKind || "normal" });
    } else {
      await clickAction();
      await pauseForAction(page, options.actionKind || "click");
    }
    return true;
  } catch {
    await setDemoCursorClicking(page, false).catch(() => undefined);
    return false;
  }
}

async function fillWithDemoCursor(page, locator, value, caption, options = {}) {
  const target = locator.first();
  const fillAction = async () => {
    await smoothScrollToLocator(page, target, { desiredY: Math.round((page.viewportSize()?.height || videoHeight) * 0.42) });
    await moveCursorToLocator(page, target);
    await pauseForAction(page, "hover");
    await setDemoCursorClicking(page, true);
    await target.click({ timeout: options.timeout || 2200 });
    await pause(page, scaledTiming(120));
    await setDemoCursorClicking(page, false);
    await target.fill(value);
  };
  if (caption) {
    await runDemoStep(page, caption, fillAction, { importance: options.importance || "normal" });
  } else {
    await fillAction();
    await pauseForAction(page, options.actionKind || "click");
  }
}

async function selectWithDemoCursor(page, locator, value, caption, options = {}) {
  const target = locator.first();
  const selectAction = async () => {
    await smoothScrollToLocator(page, target, { desiredY: Math.round((page.viewportSize()?.height || videoHeight) * 0.45) });
    await moveCursorToLocator(page, target);
    await pauseForAction(page, "hover");
    await setDemoCursorClicking(page, true);
    await target.click({ timeout: options.timeout || 2200 });
    await pause(page, scaledTiming(120));
    await setDemoCursorClicking(page, false);
    await target.selectOption(value, { timeout: options.timeout || 1800 });
  };
  if (caption) {
    await runDemoStep(page, caption, selectAction, { importance: options.importance || "normal" });
  } else {
    await selectAction();
    await pauseForAction(page, options.actionKind || "filter");
  }
}

async function safeSelect(page, label, value) {
  try {
    const field = page.getByLabel(label).first();
    await selectWithDemoCursor(page, field, value);
    return true;
  } catch {
    return false;
  }
}

async function pointAtControl(page, locator) {
  const target = locator.first();
  if (!(await target.count().catch(() => 0))) {
    return false;
  }
  if (!(await target.isVisible().catch(() => false))) {
    return false;
  }
  await smoothScrollToLocator(page, target, { desiredY: Math.round((page.viewportSize()?.height || videoHeight) * 0.38) });
  await moveCursorToLocator(page, target);
  await pauseForAction(page, "hover");
  return true;
}

async function pointAtIncidentFilters(page, caption) {
  await runDemoStep(page, caption, async () => {
    await smoothScrollToY(page, 0);
    await pointAtControl(page, page.getByRole("heading", { name: /^Incidents$/i }));
    const filterPanel = page.locator(".filter-panel").first();
    if (await filterPanel.count().catch(() => 0)) {
      await smoothScrollToLocator(page, filterPanel, { desiredY: Math.round((page.viewportSize()?.height || videoHeight) * 0.35) });
    }
    const controls = [
      page.getByLabel("Archive scope"),
      page.getByLabel("Status"),
      page.getByLabel("Severity"),
      page.getByLabel("Search incidents"),
      page.getByLabel("Date scope"),
    ];
    for (const control of controls) {
      await pointAtControl(page, control);
    }
  }, { importance: "important" });
}

async function applyArchiveScopeAll(page) {
  const selected = await safeSelect(page, "Archive scope", "all");
  if (selected) {
    await pauseForAction(page, "filter");
  }
  return selected;
}

async function clearIncidentFilters(page, caption) {
  const cleared = await clickWithDemoCursor(page, page.getByRole("button", { name: /clear filters/i }), caption, { actionKind: "filter" });
  if (cleared) {
    await waitForPage(page);
    await pauseForAction(page, "filter");
  }
  return cleared;
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
  if (keepDarkTheme) {
    await ensureDarkTheme(page);
  }
  await ensureDemoCursor(page);
  await moveDemoCursor(page, Math.round(videoWidth * 0.16), Math.round(videoHeight * 0.18));
  if (caption) {
    await showCaption(page, caption, { wait: false });
    await pauseForCaptionIntro(page);
    await pauseForActionSettle(page, "normal");
  }
  await pauseForAction(page, "page");
}

async function waitForExternalRecordingStart(page) {
  const startDelayConfigured = process.env.DEMO_START_DELAY_MS !== undefined && process.env.DEMO_START_DELAY_MS !== "";
  if (startDelayCompleted || (!externalRecordingMode && !startDelayConfigured) || startDelayMs <= 0) {
    return;
  }
  startDelayCompleted = true;
  const seconds = Math.ceil(startDelayMs / 1000);
  if (externalRecordingMode) {
    console.log(`External recording mode: starting in ${seconds} seconds...`);
  } else {
    console.log(`Demo start delay: starting in ${seconds} seconds...`);
  }
  await page.waitForTimeout(startDelayMs);
  await showCaption(
    page,
    externalRecordingMode ? "External recording mode: starting presentation" : "Starting presentation",
    { wait: false },
  );
  await pauseForCaptionIntro(page);
  await pauseForActionSettle(page, "normal");
}

async function waitForRoute(page, pathname) {
  if (!pathname) {
    await waitForPage(page);
    return;
  }
  await page
    .waitForFunction((nextPath) => window.location.pathname === nextPath, pathname, { timeout: 8000 })
    .catch(() => undefined);
  await waitForPage(page);
}

async function visibleNavLink(page, labelOrRegex) {
  const candidates = Array.isArray(labelOrRegex) ? labelOrRegex : [labelOrRegex];
  for (const name of candidates) {
    const links = page.getByRole("link", { name });
    const count = await links.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const link = links.nth(index);
      if (await link.isVisible().catch(() => false)) {
        return link;
      }
    }
  }
  return null;
}

async function visiblePageLinkByHref(page, href) {
  const links = page.locator(`a[href="${href}"]`);
  const count = await links.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const link = links.nth(index);
    if (await link.isVisible().catch(() => false)) {
      return link;
    }
  }
  return null;
}

async function navigateByVisibleNav(page, labelOrRegex, fallbackPath, caption, options = {}) {
  const link = await visibleNavLink(page, labelOrRegex);
  if (link) {
    await clickWithDemoCursor(page, link, caption, { actionKind: options.importance || "important" });
    await waitForRoute(page, fallbackPath);
    if (keepDarkTheme) {
      await ensureDarkTheme(page);
    }
    return true;
  }

  let pageLink = await visiblePageLinkByHref(page, fallbackPath);
  if (!pageLink && fallbackPath.startsWith("/analytics/")) {
    const dashboardLink = await visibleNavLink(page, /Dashboard/i);
    const currentPath = await page.evaluate(() => window.location.pathname).catch(() => "");
    if (dashboardLink && currentPath !== "/dashboard") {
      await clickWithDemoCursor(page, dashboardLink, "Opening Dashboard to use the visible analytics shortcut.", { actionKind: "important" });
      await waitForRoute(page, "/dashboard");
    }
    pageLink = await visiblePageLinkByHref(page, fallbackPath);
  }
  if (pageLink) {
    console.log(`[INFO] Header nav link not found for ${fallbackPath}; using a visible page link instead.`);
    await clickWithDemoCursor(page, pageLink, caption, { actionKind: options.importance || "important" });
    await waitForRoute(page, fallbackPath);
    if (keepDarkTheme) {
      await ensureDarkTheme(page);
    }
    return true;
  }

  console.warn(`[WARN] Visible nav link not found for ${fallbackPath}; falling back to direct navigation.`);
  await goto(page, fallbackPath, caption);
  return false;
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
  await navigateByVisibleNav(page, /Alert Timeline/i, "/analytics/alerts", "Full alert timeline");
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
  await goto(page, "/login", externalRecordingMode ? undefined : "SOC AI Agent Demo");
  await waitForExternalRecordingStart(page);
  await fillWithDemoCursor(page, page.getByLabel("Username"), username, "Signing in to the admin console");
  await fillWithDemoCursor(page, page.getByLabel("Password"), password);
  await clickWithDemoCursor(page, page.getByRole("button", { name: /sign in/i }));
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
  await waitForPage(page);
  await ensureDemoCursor(page);
}

async function switchDemoToDarkMode(page) {
  if (!switchToDarkAfterLogin) {
    return;
  }

  await ensureTheme(page, "dark", {
    visible: true,
    caption: "Switching to dark mode for the SOC analyst workflow",
  });
  keepDarkTheme = true;
}

async function demonstrateDashboard(page) {
  await runDemoStep(page, "Dashboard metrics: incidents vs alert events", async () => {
    await smoothScrollBy(page, 320);
  });
  await runDemoStep(page, "Alert/Event Evolution: correlated events over time", async () => {
    await clickWithDemoCursor(page, page.getByRole("button", { name: "24h" }), undefined, { actionKind: "range" });
    await clickWithDemoCursor(page, page.getByRole("button", { name: "7d" }), undefined, { actionKind: "range" });
    await clickWithDemoCursor(page, page.getByRole("button", { name: "1m" }), undefined, { actionKind: "range" });
    await clickWithDemoCursor(page, page.getByRole("button", { name: "1y" }), undefined, { actionKind: "range" });
  }, { importance: "important" });
  await safeScrollToText(page, "MITRE ATT&CK Distribution", "MITRE ATT&CK: event-weighted techniques", { importance: "high" });
  await safeScrollToText(page, "Severity Distribution", "Severity and decision distributions");
  await safeScrollToText(page, "Decision Distribution", "Severity and decision distributions");
  await safeScrollToText(page, "Top Agents", "Top agents by alert-event volume");
  await safeScrollToText(page, "Stored Severity Summary", "Stored incident summaries and active decision metrics");
  await safeScrollToText(page, "Active Decision Metrics", "Stored incident summaries and active decision metrics");
  await navigateByVisibleNav(page, /Dashboard/i, "/dashboard", "Dashboard metrics: incidents vs alert events");
}

async function demonstrateAlertTimeline(page) {
  if (!(await navigateByVisibleNav(page, /Alert Timeline/i, "/analytics/alerts", "Full alert timeline"))) {
    return;
  }
  await runDemoStep(page, "Alert/Event Evolution: correlated events over time", async () => {
    for (const range of ["24h", "7d", "1m", "1y"]) {
      await clickWithDemoCursor(page, page.getByRole("button", { name: range }), `Timeline range: ${range}`, { actionKind: "range" });
    }
  }, { importance: "important" });
  if (await clickFirstPositiveTimelineBucket(page)) {
    await runDemoStep(page, "Alert drilldown: MITRE technique and severity badges", async () => {
      await smoothScrollBy(page, 720);
    });
    await runDemoStep(page, "Alert drilldowns load more results as the analyst scrolls", async () => {
      await smoothScrollBy(page, 1700);
    }, { importance: "important" });
    await clickBackToTimeline(page);
  }
}

async function demonstrateMitre(page) {
  if (!(await navigateByVisibleNav(page, /MITRE/i, "/analytics/mitre", "MITRE ATT&CK: event-weighted techniques"))) {
    return;
  }
  await smoothScrollBy(page, 760);
  await pauseForAction(page, "section");
  const firstTechnique = page.locator("main a.analytics-row").first();
  if (await firstTechnique.count()) {
    await clickWithDemoCursor(page, firstTechnique, "Opening a MITRE-filtered incident view");
    await waitForPage(page);
    await pauseForAction(page, "page");
    await navigateByVisibleNav(page, /MITRE/i, "/analytics/mitre", "MITRE ATT&CK: event-weighted techniques");
  }
}

async function demonstrateIncidents(page) {
  if (!(await navigateByVisibleNav(page, /Incidents/i, "/incidents", "Incident triage queue"))) {
    return;
  }
  await pointAtIncidentFilters(page, "Incidents can be filtered by archive scope, severity, date, search text, and status.");
  const archiveFilterApplied = await runDemoStep(page, "Archive scope includes active, archived, and all incidents.", () => applyArchiveScopeAll(page), { importance: "important" });
  await runDemoStep(page, "Incidents load progressively as the analyst scrolls", async () => {
    await smoothScrollBy(page, 1900);
  }, { importance: "important" });
  if (archiveFilterApplied) {
    await clearIncidentFilters(page, "Clearing filters before opening an incident.");
  }

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

async function demonstrateAdminAndAudit(page) {
  if (await navigateByVisibleNav(page, /^Users$/i, "/admin/users", "Admin Users: multi-user RBAC management")) {
    await safeScrollToText(page, "Create User", "Super admins can create analyst and viewer accounts.");
    await safeScrollToText(page, "Admin Users", "Existing users are edited through explicit row actions.");
    const firstRow = page.locator("article.admin-row").first();
    if (await firstRow.count()) {
      await smoothScrollToLocator(page, firstRow);
      await moveCursorToLocator(page, firstRow.getByRole("button", { name: /save changes/i }).first());
      await showCaption(page, "Display name and role edits stay local until Save changes is clicked.");
      await pauseForAction(page, "section");
    }
  }

  if (await navigateByVisibleNav(page, /^Audit$/i, "/admin/audit", "Admin Audit: login, user, permission, and action events")) {
    await safeScrollToText(page, "Audit Metrics", "Audit metrics summarize recent security activity.");
    await safeScrollToText(page, "Audit Events", "Audit events preserve the operational trail without exposing secrets.");
    await smoothScrollBy(page, 760);
    await pauseForAction(page, "section");
  }
}

async function demonstrateReport(page) {
  if (!(await navigateByVisibleNav(page, /Report/i, "/report", "Executive report: read-only SOC summary"))) {
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

  await showCaption(page, "Generating the executive SOC report", { wait: false });
  await pauseForCaptionIntro(page);
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
  await ensureDarkTheme(page);
  await showCaption(page, "Dark mode remains active for the rest of the SOC analyst workflow.");
}

async function showFinalCaption(page) {
  await ensureDarkTheme(page);
  await showCaption(page, finalCaption, { wait: false });
  await pause(page, Math.max(scaledTiming(2200), scaledTiming(finalCaptionMs)));
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
  if (recordVideo) {
    await fs.rm(tempVideoDir, { recursive: true, force: true });
    await fs.rm(outputVideo, { force: true });
    await fs.mkdir(tempVideoDir, { recursive: true });
  }

  const browser = await chromium.launch({ headless, slowMo, args: launchArgs() });
  let context;
  let page;
  let flowError;
  let saveError;

  try {
    const contextOptions = {
      viewport: { width: videoWidth, height: videoHeight },
    };
    if (recordVideo) {
      contextOptions.recordVideo = {
        dir: tempVideoDir,
        size: { width: videoWidth, height: videoHeight },
      };
    }
    context = await browser.newContext(contextOptions);
    await setInitialTheme(context, demoStartTheme);
    page = await context.newPage();
    await login(page);
    await switchDemoToDarkMode(page);
    await demonstrateDashboard(page);
    await demonstrateAlertTimeline(page);
    await demonstrateMitre(page);
    await demonstrateIncidents(page);
    await demonstrateAdminAndAudit(page);
    await demonstrateReport(page);
    await navigateByVisibleNav(page, /Dashboard/i, "/dashboard", "Back to dashboard metrics");
    await maybeToggleTheme(page);
    await showFinalCaption(page);
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
      if (recordVideo && page) {
        await saveRecordedVideo(page);
      }
    } catch (error) {
      saveError = error;
      console.error("Could not save the demo video:", error);
    }
    await browser.close().catch((error) => console.error("Could not close browser cleanly:", error));
  }

  if (!recordVideo) {
    if (externalRecordingMode) {
      console.log("External recording mode enabled; no Playwright video was saved.");
    } else {
      console.log("Playwright video recording disabled; no Playwright video was saved.");
    }
  } else if (!saveError) {
    console.log(`Demo video saved to: ${outputVideo}`);
    console.log("High-quality 4K MP4 conversion:");
    console.log(
      `ffmpeg -y -i "${outputVideo}" -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p "${path.join(outputDir, "soc-ai-agent-demo-4k.mp4")}"`,
    );
    console.log("Faster test MP4 conversion:");
    console.log(
      `ffmpeg -y -i "${outputVideo}" -c:v libx264 -crf 23 -preset medium -pix_fmt yuv420p "${path.join(outputDir, "soc-ai-agent-demo.mp4")}"`,
    );
  }
  console.log("Safety reminder: this demo script is read-only for incident data.");
  console.log("No incidents were approved, rejected, archived, unarchived, or executed by this script.");
  if (flowError || saveError) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
