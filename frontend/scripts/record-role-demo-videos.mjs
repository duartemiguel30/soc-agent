import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(frontendRoot, "..");

function loadDemoEnvFile() {
  const candidates = process.env.DEMO_ENV_FILE
    ? [path.resolve(process.env.DEMO_ENV_FILE)]
    : [path.join(frontendRoot, ".env.demo"), path.join(repoRoot, ".env.demo")];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const content = readFileSync(candidate, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const equalsIndex = line.indexOf("=");
      if (equalsIndex <= 0) continue;
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
    console.log(`[INFO] Loaded demo environment from ${candidate}`);
    return;
  }
}

loadDemoEnvFile();

function envBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return value.trim().toLowerCase() === "true";
}

function envNumber(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value > 0 ? value : Number(fallback);
}

function speedMultiplier() {
  const numeric = Number(process.env.DEMO_SPEED_MULTIPLIER);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const speed = (process.env.DEMO_SPEED || "fast").toLowerCase();
  if (speed === "slow") return 1.2;
  if (speed === "fast") return 0.8;
  return 1;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sanitizeLabel(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 90) || "capture";
}

const frontendUrl =
  process.env.DEMO_FRONTEND_URL ||
  process.env.DEMO_BASE_URL ||
  "http://192.168.56.105:3000";
const adminUsername = process.env.DEMO_ADMIN_USERNAME || "admin";
const adminPassword = process.env.DEMO_ADMIN_PASSWORD || "admin";
const headless = envBoolean("DEMO_HEADLESS", false);
const multiplier = speedMultiplier();
const videoWidth = envNumber("DEMO_VIDEO_WIDTH", 1920);
const videoHeight = envNumber("DEMO_VIDEO_HEIGHT", 1080);
const slowMo = Math.round(envNumber("DEMO_SLOW_MO_MS", 80) * multiplier);
const outputDir = path.resolve(repoRoot, process.env.DEMO_ROLES_OUTPUT_DIR || "demo-output/roles");
const resultsPath = path.join(outputDir, "role-demo-results.json");
const screenshotsDir = path.join(outputDir, "screenshots");
const rolesTheme = process.env.DEMO_ROLES_THEME || "dark";
const createUsers = envBoolean("DEMO_ROLES_CREATE_USERS", true);
const disableCreatedUsers = envBoolean("DEMO_ROLES_DISABLE_CREATED_USERS", true);
const generateReport = envBoolean("DEMO_ROLES_GENERATE_REPORT", false);
const includeAdminUserCreation = envBoolean("DEMO_ROLES_INCLUDE_ADMIN_USER_CREATION", true);
const includeForbiddenChecks = envBoolean("DEMO_ROLES_INCLUDE_FORBIDDEN_CHECKS", true);
const finalCaption = process.env.DEMO_FINAL_CAPTION || "Hope you enjoyed the presentation";
const finalCaptionMs = envNumber("DEMO_FINAL_CAPTION_MS", 2600);
const runId = Date.now();
const analystUsername = `demo_analyst_${runId}`;
const viewerUsername = `demo_viewer_${runId}`;
const analystPassword = `DemoRole!${runId}A`;
const viewerPassword = `DemoRole!${runId}V`;
const viewerResetPassword = `DemoRole!${runId}R`;
let viewerLoginPassword = viewerPassword;
const timing = {
  captionMin: envNumber("DEMO_CAPTION_MIN_MS", 850),
  captionMax: envNumber("DEMO_CAPTION_MAX_MS", 2100),
  captionPerChar: envNumber("DEMO_CAPTION_PER_CHAR_MS", 20),
  captionIntro: envNumber("DEMO_CAPTION_INTRO_MS", 250),
  stepSettle: envNumber("DEMO_STEP_SETTLE_MS", 550),
  importantStepSettle: envNumber("DEMO_IMPORTANT_STEP_SETTLE_MS", 900),
  pageMin: envNumber("DEMO_PAGE_MIN_MS", 700),
  pageMax: envNumber("DEMO_PAGE_MAX_MS", 1500),
  click: envNumber("DEMO_CLICK_PAUSE_MS", 380),
  hover: envNumber("DEMO_HOVER_PAUSE_MS", 220),
  section: envNumber("DEMO_SECTION_PAUSE_MS", 700),
  scrollMin: envNumber("DEMO_SCROLL_MIN_MS", 380),
  scrollMax: envNumber("DEMO_SCROLL_MAX_MS", 1000),
};

const results = [];
const createdUsers = [];
const videos = {};
let failureCount = 0;
let activePage = null;

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    throw new Error("Playwright is required. Run: npm install && npx playwright install chromium");
  }
}

function urlFor(pathname) {
  return new URL(pathname, frontendUrl).toString();
}

async function record(role, status, message, extra = {}) {
  results.push({ role, status, message, ...extra });
  console.log(`[${status.toUpperCase()}] ${role}: ${message}`);
}

async function pass(role, message) {
  await record(role, "pass", message);
}

async function info(role, message) {
  await record(role, "info", message);
}

async function skip(role, message, reason) {
  await record(role, "skip", message, { reason });
}

async function fail(role, message, error) {
  failureCount += 1;
  const detail = error instanceof Error ? error.message : String(error || "");
  const screenshot = activePage ? await saveScreenshot(activePage, `${role}-${message}`).catch(() => null) : null;
  await record(role, "fail", message, { detail, screenshot });
}

async function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runRole(role, message, callback) {
  try {
    await callback();
    await pass(role, message);
  } catch (error) {
    await fail(role, message, error);
  }
}

function scaled(value) {
  return Math.round(value * multiplier);
}

function captionDuration(text) {
  return scaled(clamp(timing.captionMin + text.length * timing.captionPerChar, timing.captionMin, timing.captionMax));
}

async function pause(page, value = timing.section) {
  await page.waitForTimeout(scaled(value));
}

async function pauseForCaptionIntro(page) {
  await pause(page, timing.captionIntro);
}

async function pauseForActionSettle(page, importance = "normal") {
  await pause(page, importance === "important" || importance === "high" ? timing.importantStepSettle : timing.stepSettle);
}

async function runDemoStep(page, caption, action, options = {}) {
  if (caption) {
    await showCaption(page, caption, { wait: false });
    await pauseForCaptionIntro(page);
  }
  const result = await action();
  await pauseForActionSettle(page, options.importance || "normal");
  return result;
}

async function waitForPage(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(300);
}

async function saveScreenshot(page, label) {
  await fs.mkdir(screenshotsDir, { recursive: true });
  const filePath = path.join(screenshotsDir, `${sanitizeLabel(label)}-${Date.now()}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

async function writeResults() {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    resultsPath,
    JSON.stringify(
      {
        ok: failureCount === 0,
        frontendUrl,
        runId,
        videos,
        createdUsers: Object.fromEntries(
          createdUsers.map((user) => [user.role || user.username, {
            id: user.id,
            username: user.username,
            role: user.role,
            disabledAtCleanup: Boolean(user.disabledAtCleanup),
          }]),
        ),
        results,
      },
      null,
      2,
    ),
  );
  console.log(`[INFO] Role demo results written to ${resultsPath}`);
}

async function installVisualHelpers(page) {
  await page.evaluate(() => {
    if (!document.getElementById("soc-role-demo-style")) {
      const style = document.createElement("style");
      style.id = "soc-role-demo-style";
      style.textContent = `
        #soc-role-demo-cursor {
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
        #soc-role-demo-cursor svg { display: block; width: 32px; height: 32px; }
        #soc-role-demo-cursor.clicking { transform: scale(0.92); }
        #soc-role-demo-cursor.clicking::after {
          content: "";
          position: absolute;
          left: -5px;
          top: -5px;
          width: 18px;
          height: 18px;
          border: 2px solid rgba(59, 130, 246, 0.5);
          border-radius: 999px;
          animation: soc-role-demo-click 260ms ease-out forwards;
        }
        @keyframes soc-role-demo-click {
          from { opacity: 0.85; transform: scale(0.5); }
          to { opacity: 0; transform: scale(1.8); }
        }
        #soc-role-demo-caption {
          position: fixed;
          right: 28px;
          bottom: 28px;
          z-index: 2147483646;
          max-width: min(680px, calc(100vw - 56px));
          border: 1px solid rgba(148, 163, 184, 0.55);
          border-radius: calc(12px * var(--soc-role-demo-caption-scale, 1));
          background: rgba(15, 23, 42, 0.92);
          color: #f8fafc;
          box-shadow: 0 20px 48px rgba(15, 23, 42, 0.35);
          font: 700 calc(18px * var(--soc-role-demo-caption-scale, 1))/1.35 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          letter-spacing: 0;
          padding: calc(16px * var(--soc-role-demo-caption-scale, 1)) calc(18px * var(--soc-role-demo-caption-scale, 1));
          pointer-events: none;
          opacity: 0;
          transform: translateY(8px);
          transition: opacity 180ms ease, transform 180ms ease;
        }
        #soc-role-demo-caption.visible { opacity: 1; transform: translateY(0); }
      `;
      document.head.appendChild(style);
    }

    if (!document.getElementById("soc-role-demo-cursor")) {
      const cursor = document.createElement("div");
      cursor.id = "soc-role-demo-cursor";
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

async function showCaption(page, text, options = {}) {
  await installVisualHelpers(page);
  await page.evaluate((captionText) => {
    let caption = document.getElementById("soc-role-demo-caption");
    if (!caption) {
      caption = document.createElement("div");
      caption.id = "soc-role-demo-caption";
      document.body.appendChild(caption);
    }
    const scale = Math.max(1, Math.min(1.35, window.innerWidth / 1920));
    caption.style.setProperty("--soc-role-demo-caption-scale", String(scale));
    caption.textContent = captionText;
    requestAnimationFrame(() => caption.classList.add("visible"));
  }, text);
  if (options.wait !== false) {
    await page.waitForTimeout(captionDuration(text));
  }
}

async function hideCaption(page) {
  await page.evaluate(() => document.getElementById("soc-role-demo-caption")?.classList.remove("visible")).catch(() => undefined);
}

async function glideCursorTo(page, x, y, options = {}) {
  await installVisualHelpers(page);
  await page.evaluate(
    ({ nextX, nextY, minDuration, maxDuration, durationMultiplier }) =>
      new Promise((resolve) => {
        const cursor = document.getElementById("soc-role-demo-cursor");
        if (!cursor) {
          resolve();
          return;
        }
        const currentX = Number(cursor.dataset.x || 48);
        const currentY = Number(cursor.dataset.y || 48);
        const distance = Math.hypot(nextX - currentX, nextY - currentY);
        const duration = Math.min(maxDuration, Math.max(minDuration, distance * 1.15 * durationMultiplier));
        const start = performance.now();
        const ease = (value) => 1 - Math.pow(1 - value, 3);
        function frame(now) {
          const progress = Math.min(1, (now - start) / Math.max(1, duration));
          const x = currentX + (nextX - currentX) * ease(progress);
          const y = currentY + (nextY - currentY) * ease(progress);
          cursor.style.left = `${x}px`;
          cursor.style.top = `${y}px`;
          cursor.dataset.x = String(x);
          cursor.dataset.y = String(y);
          if (progress < 1) requestAnimationFrame(frame);
          else resolve();
        }
        requestAnimationFrame(frame);
      }),
    { nextX: x, nextY: y, minDuration: scaled(320), maxDuration: scaled(900), durationMultiplier: multiplier, ...options },
  );
  await page.mouse.move(x, y).catch(() => undefined);
}

async function locatorCenter(locator) {
  const box = await locator.first().boundingBox().catch(() => null);
  if (!box) return null;
  return { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 42) };
}

async function smoothScrollToY(page, targetY) {
  await page.evaluate(
    ({ nextY, minDuration, maxDuration, durationMultiplier }) =>
      new Promise((resolve) => {
        const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
        const startY = window.scrollY || document.documentElement.scrollTop || 0;
        const endY = Math.min(maxScroll, Math.max(0, nextY));
        const distance = endY - startY;
        if (Math.abs(distance) < 2) {
          resolve();
          return;
        }
        const duration = Math.min(maxDuration, Math.max(minDuration, Math.abs(distance) * 0.48 * durationMultiplier));
        const start = performance.now();
        const ease = (value) => 1 - Math.pow(1 - value, 3);
        function frame(now) {
          const progress = Math.min(1, (now - start) / Math.max(1, duration));
          window.scrollTo(0, startY + distance * ease(progress));
          if (progress < 1) requestAnimationFrame(frame);
          else resolve();
        }
        requestAnimationFrame(frame);
      }),
    { nextY: targetY, minDuration: scaled(timing.scrollMin), maxDuration: scaled(timing.scrollMax), durationMultiplier: multiplier },
  );
}

async function smoothScrollBy(page, distance) {
  const current = await page.evaluate(() => window.scrollY || document.documentElement.scrollTop || 0);
  await smoothScrollToY(page, current + distance);
}

async function smoothScrollToLocator(page, locator) {
  const target = locator.first();
  if (!(await target.count().catch(() => 0))) return false;
  const viewport = page.viewportSize() || { width: videoWidth, height: videoHeight };
  const center = await locatorCenter(target);
  if (!center) {
    await target.scrollIntoViewIfNeeded({ timeout: 2200 }).catch(() => undefined);
    return true;
  }
  const desiredY = Math.round(viewport.height * 0.4);
  await smoothScrollToY(page, (await page.evaluate(() => window.scrollY || 0)) + center.y - desiredY);
  const updatedCenter = (await locatorCenter(target)) || center;
  await glideCursorTo(page, Math.min(viewport.width - 80, Math.max(24, updatedCenter.x)), Math.min(viewport.height - 80, Math.max(24, updatedCenter.y)));
  return true;
}

async function clickWithCursor(page, locator, caption, options = {}) {
  const target = locator.first();
  try {
    if (!(await target.count())) return false;
    const clickAction = async () => {
      await smoothScrollToLocator(page, target);
      const center = await locatorCenter(target);
      if (center) await glideCursorTo(page, center.x, center.y);
      await pause(page, timing.hover);
      await page.evaluate(() => document.getElementById("soc-role-demo-cursor")?.classList.add("clicking"));
      await target.click({ timeout: options.timeout || 2500 });
      await pause(page, 150);
      await page.evaluate(() => document.getElementById("soc-role-demo-cursor")?.classList.remove("clicking"));
    };
    if (caption) {
      await runDemoStep(page, caption, clickAction, { importance: options.importance || "normal" });
    } else {
      await clickAction();
      await pause(page, timing.click);
    }
    return true;
  } catch {
    await page.evaluate(() => document.getElementById("soc-role-demo-cursor")?.classList.remove("clicking")).catch(() => undefined);
    return false;
  }
}

async function fillWithCursor(page, locator, value) {
  const target = locator.first();
  await smoothScrollToLocator(page, target);
  const center = await locatorCenter(target);
  if (center) await glideCursorTo(page, center.x, center.y);
  await pause(page, timing.hover);
  await page.evaluate(() => document.getElementById("soc-role-demo-cursor")?.classList.add("clicking"));
  await target.click({ timeout: 2500 });
  await pause(page, 120);
  await page.evaluate(() => document.getElementById("soc-role-demo-cursor")?.classList.remove("clicking"));
  await target.fill(value);
  await pause(page, timing.click);
}

async function pointAtControl(page, locator) {
  const target = locator.first();
  if (!(await target.count().catch(() => 0))) return false;
  if (!(await target.isVisible().catch(() => false))) return false;
  await smoothScrollToLocator(page, target);
  const center = await locatorCenter(target);
  if (center) await glideCursorTo(page, center.x, center.y);
  await pause(page, timing.hover);
  return true;
}

async function pointAtIncidentFilters(page, role) {
  await runDemoStep(page, "Incidents can be filtered by archive scope, severity, date, search text, and status.", async () => {
    await smoothScrollToY(page, 0);
    await pointAtControl(page, page.getByRole("heading", { name: /^Incidents$/i }));
    const filterPanel = page.locator(".filter-panel").first();
    if (await filterPanel.count().catch(() => 0)) {
      await smoothScrollToLocator(page, filterPanel);
    }
    const controls = [
      page.getByLabel("Archive scope"),
      page.getByLabel("Severity"),
      page.getByLabel("Search incidents"),
    ];
    if (/super admin/i.test(role)) {
      controls.push(page.getByLabel("Status"), page.getByLabel("Date scope"));
    }
    for (const control of controls) {
      await pointAtControl(page, control);
    }
  }, { importance: /super admin/i.test(role) ? "important" : "normal" });
}

async function scrollToText(page, text, caption) {
  const locator = page.getByText(text, { exact: true }).first();
  if (!(await locator.count().catch(() => 0))) return false;
  if (caption) {
    await runDemoStep(page, caption, () => smoothScrollToLocator(page, locator));
  } else {
    await smoothScrollToLocator(page, locator);
    await pause(page, timing.section);
  }
  return true;
}

async function goto(page, pathname, caption) {
  await page.goto(urlFor(pathname), { waitUntil: "domcontentloaded" });
  await waitForPage(page);
  await ensureTheme(page, rolesTheme);
  await installVisualHelpers(page);
  if (caption) {
    await showCaption(page, caption, { wait: false });
    await pauseForCaptionIntro(page);
    await pauseForActionSettle(page);
  }
  await pause(page, (timing.pageMin + timing.pageMax) / 2);
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
  await ensureTheme(page, rolesTheme);
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
    await clickWithCursor(page, link, caption, { importance: options.importance || "important" });
    await waitForRoute(page, fallbackPath);
    return true;
  }
  let pageLink = await visiblePageLinkByHref(page, fallbackPath);
  if (!pageLink && fallbackPath.startsWith("/analytics/")) {
    const dashboardLink = await visibleNavLink(page, /Dashboard/i);
    const currentPath = await page.evaluate(() => window.location.pathname).catch(() => "");
    if (dashboardLink && currentPath !== "/dashboard") {
      await clickWithCursor(page, dashboardLink, "Opening Dashboard to use the visible analytics shortcut.", { importance: "important" });
      await waitForRoute(page, "/dashboard");
    }
    pageLink = await visiblePageLinkByHref(page, fallbackPath);
  }
  if (pageLink) {
    console.log(`[INFO] Header nav link not found for ${fallbackPath}; using a visible page link instead.`);
    await clickWithCursor(page, pageLink, caption, { importance: options.importance || "important" });
    await waitForRoute(page, fallbackPath);
    return true;
  }
  console.warn(`[WARN] Visible nav link not found for ${fallbackPath}; falling back to direct navigation.`);
  await goto(page, fallbackPath, caption);
  return false;
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

async function ensureTheme(page, theme) {
  const normalizedTheme = theme === "dark" ? "dark" : "light";
  const currentTheme = await page.evaluate(() => document.documentElement.dataset.theme || "light").catch(() => "light");
  if (currentTheme === normalizedTheme) return;
  await forceTheme(page, normalizedTheme);
  await page.waitForFunction((nextTheme) => document.documentElement.dataset.theme === nextTheme, normalizedTheme, { timeout: 4000 });
}

async function createRecordedContext(browser, videoFile) {
  await fs.mkdir(outputDir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: videoWidth, height: videoHeight },
    recordVideo: { dir: outputDir, size: { width: videoWidth, height: videoHeight } },
  });
  await context.addInitScript((theme) => {
    try {
      const themeToApply = theme === "light" ? "light" : "dark";
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
  }, rolesTheme);
  const page = await context.newPage();
  activePage = page;
  return { context, page, videoFile };
}

async function closeRecordedContext(recording, key) {
  const video = recording.page.video();
  await recording.context.close();
  if (!video) return null;
  const source = await video.path();
  const target = path.join(outputDir, recording.videoFile);
  await fs.copyFile(source, target);
  await fs.rm(source, { force: true });
  videos[key] = target;
  return target;
}

function requestContext(contextOrPage) {
  if (contextOrPage?.request) return contextOrPage.request;
  if (contextOrPage?.context) return contextOrPage.context().request;
  throw new Error("Expected BrowserContext or Page.");
}

async function apiFetch(contextOrPage, requestPath, options = {}) {
  const targetPath = requestPath.startsWith("/backend") ? requestPath : `/backend${requestPath}`;
  const targetUrl = requestPath.startsWith("http") ? requestPath : new URL(targetPath, frontendUrl).toString();
  const headers = { ...(options.headers || {}) };
  const requestOptions = { method: options.method || "GET", headers };
  if (options.body !== undefined) {
    requestOptions.data = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    requestOptions.headers = { "content-type": "application/json", ...headers };
  }
  const response = await requestContext(contextOrPage).fetch(targetUrl, requestOptions);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status(), ok: response.ok(), text, data };
}

async function loginAs(page, username, password, roleLabel) {
  await goto(page, "/login");
  await fillWithCursor(page, page.getByLabel("Username"), username);
  await fillWithCursor(page, page.getByLabel("Password"), password);
  await clickWithCursor(page, page.getByRole("button", { name: /sign in/i }), `${roleLabel} signs in with an HttpOnly session cookie.`);
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
  await waitForPage(page);
  await installVisualHelpers(page);
  await ensureTheme(page, rolesTheme);
  await showCaption(page, "Role walkthrough in dark mode");
}

async function assertNoBrowserAuthStorage(page, role) {
  const suspicious = await page.evaluate(() => {
    const keys = [];
    for (const storage of [localStorage, sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index) || "";
        const value = storage.getItem(key) || "";
        if (/(token|session|auth|cookie)/i.test(`${key} ${value}`)) keys.push(key);
      }
    }
    return keys;
  });
  await assert(suspicious.length === 0, `${role} browser storage has auth-like keys: ${suspicious.join(", ")}`);
}

async function listUsers(context) {
  const response = await apiFetch(context, "/admin/users");
  await assert(response.ok, `Could not list users: ${response.text}`);
  return response.data;
}

async function getUser(context, username) {
  const users = await listUsers(context);
  return users.find((user) => user.username === username) || null;
}

async function createUser(context, payload) {
  const response = await apiFetch(context, "/admin/users", { method: "POST", body: payload });
  await assert(response.ok, `Could not create ${payload.username}: ${response.text}`);
  return response.data;
}

async function disableUser(context, user) {
  if (!user?.id || user.is_active === false) return;
  const response = await apiFetch(context, `/admin/users/${user.id}/disable`, { method: "POST" });
  await assert(response.ok, `Could not disable ${user.username}: ${response.text}`);
  user.disabledAtCleanup = true;
}

function userRow(page, username) {
  return page.locator("article.admin-row").filter({ hasText: username }).first();
}

async function createDisposableUsers(context, page) {
  if (!createUsers || !includeAdminUserCreation) {
    await skip("setup", "Disposable demo user creation", "Disabled by DEMO_ROLES_CREATE_USERS or DEMO_ROLES_INCLUDE_ADMIN_USER_CREATION.");
    return;
  }
  const analyst = (await getUser(context, analystUsername)) || (await createUser(context, {
    username: analystUsername,
    display_name: "Demo Analyst",
    role: "analyst",
    password: analystPassword,
  }));
  const viewer = (await getUser(context, viewerUsername)) || (await createUser(context, {
    username: viewerUsername,
    display_name: "Demo Viewer",
    role: "viewer",
    password: viewerPassword,
  }));
  createdUsers.push({ ...analyst }, { ...viewer });
  await showCaption(page, "Disposable analyst and viewer accounts are created for the role walkthroughs.");
  await pass("setup", "Disposable role demo users created");
}

async function firstIncident(context) {
  const response = await apiFetch(context, "/incidents?archived=all&limit=1");
  if (!response.ok) return null;
  if (Array.isArray(response.data)) return response.data[0] || null;
  return response.data?.items?.[0] || null;
}

async function openFirstIncident(page, context, role) {
  const incident = await firstIncident(context);
  if (!incident) {
    await skip(role, "Incident detail", "No incident exists in this database.");
    await showCaption(page, "No incidents are available in this lab database, so incident detail is skipped.");
    return null;
  }
  const firstIncidentLink = page.locator("main a[href^='/incidents/']").first();
  if (await firstIncidentLink.count().catch(() => 0)) {
    await clickWithCursor(page, firstIncidentLink, `${role} opens an incident detail page.`);
    await waitForRoute(page, `/incidents/${incident.id}`);
  } else {
    console.warn(`[WARN] Visible incident link not found; falling back to direct incident detail navigation.`);
    await goto(page, `/incidents/${incident.id}`, `${role} opens an incident detail page.`);
  }
  return incident;
}

async function demonstrateDashboard(page, role) {
  await navigateByVisibleNav(page, /Dashboard/i, "/dashboard", `${role} dashboard: incidents, alert events, and event-weighted analytics.`);
  await runDemoStep(page, "Total incidents counts stored cases; Total alert events counts correlated alert volume.", async () => {
    await smoothScrollBy(page, 420);
  });
  await scrollToText(page, "Alert/Event Evolution", "Alert/Event Evolution shows how activity changes over time.");
  await scrollToText(page, "MITRE ATT&CK Distribution", "MITRE, severity, decision, and agent charts summarize the SOC workload.");
  await scrollToText(page, "Severity Distribution");
  await scrollToText(page, "Decision Distribution");
  await scrollToText(page, "Top Agents");
}

async function demonstrateAnalytics(page) {
  await navigateByVisibleNav(page, /Alert Timeline/i, "/analytics/alerts", "Full alert timeline with range controls and drilldowns.");
  for (const range of ["24h", "7d", "1m", "1y"]) {
    await clickWithCursor(page, page.getByRole("button", { name: range }), `Timeline range: ${range}`);
  }
  const bucket = page.locator("a.bar-column-link").first();
  if (await bucket.count()) {
    await clickWithCursor(page, bucket, "Opening a positive alert bucket drilldown when available.");
    await waitForPage(page);
    await runDemoStep(page, "Alert drilldowns expand the selected time bucket into matching events.", async () => {
      await smoothScrollBy(page, 900);
    });
    await navigateByVisibleNav(page, /Alert Timeline/i, "/analytics/alerts", "Back to the full timeline.");
  }

  await navigateByVisibleNav(page, /MITRE/i, "/analytics/mitre", "MITRE analytics shows complete event-weighted technique distribution.");
  await runDemoStep(page, "The MITRE view keeps the complete technique distribution visible for review.", async () => {
    await smoothScrollBy(page, 760);
  });
  const firstTechnique = page.locator("main a.analytics-row").first();
  if (await firstTechnique.count()) {
    await clickWithCursor(page, firstTechnique, "Opening a MITRE-filtered drilldown.");
    await waitForPage(page);
  }
}

async function demonstrateIncidentDetail(page, context, role, readOnly = false) {
  await navigateByVisibleNav(page, /Incidents/i, "/incidents", `${role} opens incidents with filters, archive scope, date scope, and progressive loading.`);
  await pointAtIncidentFilters(page, role);
  await runDemoStep(page, "The incident queue uses progressive loading as the page scrolls.", async () => {
    await smoothScrollBy(page, 1400);
  }, { importance: "important" });
  const incident = await openFirstIncident(page, context, role);
  if (!incident) return null;

  for (const label of ["Incident Overview", "AI Analysis", "Alert Activity", "Observables", "Manual Playbook", "Notes", "Timeline", "Action History", "Response Actions"]) {
    if (!(await scrollToText(page, label, `${role} reviews ${label}.`))) {
      await skip(role, label, `${label} not present for this incident.`);
    }
  }
  const body = await page.locator("body").innerText();
  await assert(!/stdout\s*:|stderr\s*:|disable-adaccount|iptables\s+-(a|c)/i.test(body), "Response action UI exposes raw command/output text.");
  if (readOnly) {
    for (const buttonName of [/approve/i, /reject/i, /^archive$/i, /unarchive/i, /execute/i, /add note/i, /save/i]) {
      await assert((await page.getByRole("button", { name: buttonName }).count()) === 0, `${role} sees mutating button ${buttonName}.`);
    }
  }
  return incident;
}

async function demonstrateAdminUsers(page, context) {
  await navigateByVisibleNav(page, /^Users$/i, "/admin/users", "Super admin user management: RBAC, user creation, Save, reset, and disable controls.");
  await assert(await page.getByRole("button", { name: /create user/i }).isVisible(), "/admin/users did not load.");
  await createDisposableUsers(context, page);
  await clickWithCursor(page, page.getByRole("button", { name: /refresh/i }), "Refreshing the user list to show the disposable demo accounts.");
  await waitForPage(page);
  await installVisualHelpers(page);
  await assert(await userRow(page, analystUsername).isVisible(), "Disposable analyst row missing.");
  await assert(await userRow(page, viewerUsername).isVisible(), "Disposable viewer row missing.");

  const analystRow = userRow(page, analystUsername);
  await fillWithCursor(page, analystRow.getByLabel("Display name"), "Demo Analyst Saved");
  await clickWithCursor(page, page.getByRole("heading", { name: /admin users/i }), "Edits are local until the row Save button is clicked.");
  const beforeSave = await getUser(context, analystUsername);
  await assert(beforeSave?.display_name !== "Demo Analyst Saved", "Display name saved before clicking Save.");
  await clickWithCursor(page, analystRow.getByRole("button", { name: /save changes/i }), "Now Save changes writes the update and creates one audit event.");
  await page.locator(".alert.success").filter({ hasText: /user updated/i }).waitFor({ timeout: 8000 });
  const afterSave = await getUser(context, analystUsername);
  await assert(afterSave?.display_name === "Demo Analyst Saved", "Display name was not saved after clicking Save.");

  const viewerRow = userRow(page, viewerUsername);
  await fillWithCursor(page, viewerRow.getByLabel("New password"), viewerResetPassword);
  await clickWithCursor(page, page.getByRole("heading", { name: /admin users/i }), "Password reset stays explicit; blur does not change the password.");
  await clickWithCursor(page, viewerRow.getByRole("button", { name: /reset password/i }), "Reset password is a separate explicit action.");
  viewerLoginPassword = viewerResetPassword;
  await page.locator(".alert.success").filter({ hasText: /password reset/i }).waitFor({ timeout: 8000 });
  await showCaption(page, "Enable and Disable are separate explicit controls; users are never deleted by the demo.");
}

async function demonstrateAudit(page) {
  await navigateByVisibleNav(page, /^Audit$/i, "/admin/audit", "Audit review: login, user, permission, report, and response-action events.");
  await assert(await page.getByRole("heading", { name: /audit/i }).first().isVisible(), "/admin/audit did not load.");
  await scrollToText(page, "Audit Metrics", "Audit metrics summarize recent operational security activity.");
  await scrollToText(page, "Audit Events", "Audit events preserve what happened without leaking secrets.");
  await runDemoStep(page, "Audit review keeps the operational trail visible without exposing secrets.", async () => {
    await smoothScrollBy(page, 760);
  });
}

async function demonstrateReport(page, role) {
  await navigateByVisibleNav(page, /Report/i, "/report", `${role} report page.`);
  await assert(await page.getByRole("heading", { name: "Report", level: 1 }).isVisible(), "/report did not load.");
  if (role !== "super_admin" || !generateReport) {
    await info(role, role === "super_admin" ? "Report generation not run because DEMO_ROLES_GENERATE_REPORT=false." : "Report generation not run in this role video.");
    await showCaption(page, "Report generation is available for this role. It is skipped here to avoid repeated AI calls.");
    return;
  }
  const button = page.getByRole("button", { name: /generate report/i }).first();
  await clickWithCursor(page, button, "Generating the report once in the super-admin role video.");
  await page.waitForFunction(
    () => /generated report|no incidents found|report generation failed/i.test(document.body.textContent || ""),
    null,
    { timeout: 90000 },
  );
  await runDemoStep(page, "Generated report output is reviewed once, then the role video returns to the dashboard.", async () => {
    await smoothScrollBy(page, 980);
  }, { importance: "important" });
}

async function finishRoleVideo(page, roleLabel) {
  await navigateByVisibleNav(page, /Dashboard/i, "/dashboard", `${roleLabel} returns to the dashboard to close the walkthrough.`);
  await ensureTheme(page, rolesTheme);
  await showCaption(page, finalCaption, { wait: false });
  await page.waitForTimeout(Math.max(scaled(2200), scaled(finalCaptionMs)));
}

async function confirmForbidden(page, context, role, pathname, apiPath) {
  if (!includeForbiddenChecks) {
    await skip(role, pathname, "DEMO_ROLES_INCLUDE_FORBIDDEN_CHECKS=false.");
    return;
  }
  await showCaption(page, "Admin navigation is hidden for this role.");
  await pauseForActionSettle(page);
  const api = await apiFetch(context, apiPath);
  await assert(api.status === 403, `${role} ${apiPath} should return 403, got ${api.status}.`);
  await goto(page, pathname, "Direct access is also blocked by the backend.");
  const body = await page.locator("body").innerText().catch(() => "");
  await assert(/forbidden|cannot|unauthorized|required|login/i.test(body), `${role} forbidden page did not show an access-denied state.`);
}

async function recordSuperAdmin(browser) {
  const recording = await createRecordedContext(browser, "role-super-admin.webm");
  const { context, page } = recording;
  activePage = page;
  await runRole("super_admin", "Super admin role video", async () => {
    await loginAs(page, adminUsername, adminPassword, "Super admin");
    const me = await apiFetch(context, "/auth/me");
    await assert(me.ok, `/auth/me failed: ${me.text}`);
    await assert(me.data?.role === "super_admin" || me.data?.permissions?.includes("manage_users"), "Admin must have manage_users or super_admin role.");
    await assertNoBrowserAuthStorage(page, "super_admin");
    await demonstrateDashboard(page, "Super admin");
    await demonstrateAnalytics(page);
    await demonstrateIncidentDetail(page, context, "Super admin");
    await demonstrateAdminUsers(page, context);
    await demonstrateAudit(page);
    await demonstrateReport(page, "super_admin");
    await finishRoleVideo(page, "Super admin");
  });
  await hideCaption(page);
  await closeRecordedContext(recording, "super_admin");
}

async function recordAnalyst(browser) {
  const recording = await createRecordedContext(browser, "role-analyst.webm");
  const { context, page } = recording;
  activePage = page;
  await runRole("analyst", "Analyst role video", async () => {
    await loginAs(page, analystUsername, analystPassword, "Analyst");
    await assertNoBrowserAuthStorage(page, "analyst");
    await demonstrateDashboard(page, "Analyst");
    await demonstrateIncidentDetail(page, context, "Analyst");
    await confirmForbidden(page, context, "analyst", "/admin/users", "/admin/users");
    await confirmForbidden(page, context, "analyst", "/admin/audit", "/admin/audit-events");
    await demonstrateReport(page, "analyst");
    await finishRoleVideo(page, "Analyst");
  });
  await hideCaption(page);
  await closeRecordedContext(recording, "analyst");
}

async function recordViewer(browser) {
  const recording = await createRecordedContext(browser, "role-viewer.webm");
  const { context, page } = recording;
  activePage = page;
  await runRole("viewer", "Viewer role video", async () => {
    await loginAs(page, viewerUsername, viewerLoginPassword, "Viewer");
    await assertNoBrowserAuthStorage(page, "viewer");
    await demonstrateDashboard(page, "Viewer");
    const incident = await demonstrateIncidentDetail(page, context, "Viewer", true);
    if (incident) {
      for (const actionPath of [`/incidents/${incident.id}/approve`, `/incidents/${incident.id}/reject`, `/incidents/${incident.id}/archive`]) {
        const response = await apiFetch(context, actionPath, { method: "POST" });
        await assert(response.status === 403, `${actionPath} should return 403 for viewer, got ${response.status}.`);
      }
      await showCaption(page, "Backend checks also return 403 for forbidden viewer mutations.");
    }
    await confirmForbidden(page, context, "viewer", "/admin/users", "/admin/users");
    await confirmForbidden(page, context, "viewer", "/admin/audit", "/admin/audit-events");
    await demonstrateReport(page, "viewer");
    await finishRoleVideo(page, "Viewer");
  });
  await hideCaption(page);
  await closeRecordedContext(recording, "viewer");
}

async function cleanupUsers(browser) {
  if (!disableCreatedUsers || createdUsers.length === 0) {
    await skip("cleanup", "Disable disposable demo users", disableCreatedUsers ? "No created users." : "DEMO_ROLES_DISABLE_CREATED_USERS=false.");
    return;
  }
  const context = await browser.newContext();
  await context.addInitScript(() => {
    try {
      localStorage.setItem("soc_theme", "dark");
      document.documentElement.dataset.theme = "dark";
      document.documentElement.style.colorScheme = "dark";
      document.documentElement.classList.add("dark");
      let style = document.getElementById("soc-demo-theme-prepaint");
      if (!style) {
        style = document.createElement("style");
        style.id = "soc-demo-theme-prepaint";
        document.documentElement.appendChild(style);
      }
      style.textContent = "html, body { background: #020617 !important; color-scheme: dark; }";
    } catch {}
  });
  const page = await context.newPage();
  activePage = page;
  try {
    await loginAs(page, adminUsername, adminPassword, "Cleanup admin");
    for (const createdUser of createdUsers) {
      const latest = await getUser(context, createdUser.username).catch(() => null);
      if (latest) {
        await disableUser(context, latest);
        createdUser.disabledAtCleanup = true;
      }
    }
    await pass("cleanup", "Disabled disposable demo users");
  } catch (error) {
    await fail("cleanup", "Disable disposable demo users", error);
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(screenshotsDir, { recursive: true });
  for (const fileName of ["role-super-admin.webm", "role-analyst.webm", "role-viewer.webm", "role-demo-results.json"]) {
    await fs.rm(path.join(outputDir, fileName), { force: true });
  }
  await info("setup", `Role demo frontend URL: ${frontendUrl}`);
  await info("setup", `Role demo output dir: ${outputDir}`);
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless, slowMo });
  try {
    await recordSuperAdmin(browser);
    await recordAnalyst(browser);
    await recordViewer(browser);
  } finally {
    await cleanupUsers(browser).catch(async (error) => fail("cleanup", "Cleanup crashed", error));
    await browser.close().catch(() => undefined);
    await writeResults();
  }
  process.exitCode = failureCount > 0 ? 1 : 0;
}

main().catch(async (error) => {
  await fail("setup", "Role demo recorder crashed", error);
  await writeResults();
  process.exitCode = 1;
});
