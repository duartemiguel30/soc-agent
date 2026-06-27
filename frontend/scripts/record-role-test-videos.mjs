import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(frontendRoot, "..");

function loadTestEnvFile() {
  const candidates = process.env.TEST_ENV_FILE
    ? [path.resolve(process.env.TEST_ENV_FILE)]
    : [path.join(frontendRoot, ".env.tests"), path.join(repoRoot, ".env.tests")];

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

    console.log(`[INFO] Loaded role-test environment from ${candidate}`);
    return;
  }
}

loadTestEnvFile();

function envBool(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return value.trim().toLowerCase() === "true";
}

function envNumber(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function speedMultiplier() {
  const numeric = Number(process.env.TEST_SPEED_MULTIPLIER);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const speed = (process.env.TEST_SPEED || "normal").toLowerCase();
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

const frontendUrl = process.env.TEST_FRONTEND_URL || "http://192.168.56.105:3000";
const backendUrl = process.env.TEST_BACKEND_URL || "http://192.168.56.105:8000";
const adminUsername = process.env.TEST_ADMIN_USERNAME || "admin";
const adminPassword = process.env.TEST_ADMIN_PASSWORD || "admin";
const headless = envBool("TEST_HEADLESS", false);
const videoWidth = envNumber("TEST_VIDEO_WIDTH", 1920);
const videoHeight = envNumber("TEST_VIDEO_HEIGHT", 1080);
const slowMo = envNumber("TEST_SLOW_MO_MS", 80);
const outputDir = path.resolve(repoRoot, process.env.TEST_OUTPUT_DIR || "tests-output");
const screenshotsDir = path.join(outputDir, "screenshots");
const resultsPath = path.join(outputDir, "role-test-results.json");
const generateReport = envBool("TEST_REPORT_GENERATION", false);
const createUsers = envBool("TEST_CREATE_USERS", true);
const disableCreatedUsers = envBool("TEST_DISABLE_CREATED_USERS", true);
const runId = Date.now();
const analystUsername = process.env.TEST_ANALYST_USERNAME || `role_video_analyst_${runId}`;
const viewerUsername = process.env.TEST_VIEWER_USERNAME || `role_video_viewer_${runId}`;
const analystPassword = process.env.TEST_ANALYST_PASSWORD || `RoleVideo!${runId}A`;
const viewerPassword = process.env.TEST_VIEWER_PASSWORD || `RoleVideo!${runId}V`;
const viewerResetPassword = `RoleVideo!${runId}R`;
let viewerLoginPassword = viewerPassword;
const multiplier = speedMultiplier();
const timing = {
  captionMin: envNumber("TEST_CAPTION_MIN_MS", 900),
  captionMax: envNumber("TEST_CAPTION_MAX_MS", 2200),
  captionPerChar: envNumber("TEST_CAPTION_PER_CHAR_MS", 22),
  pageMin: envNumber("TEST_PAGE_MIN_MS", 900),
  pageMax: envNumber("TEST_PAGE_MAX_MS", 1800),
  section: envNumber("TEST_SECTION_PAUSE_MS", 900),
  click: envNumber("TEST_CLICK_PAUSE_MS", 450),
  hover: envNumber("TEST_HOVER_PAUSE_MS", 280),
  scrollMin: envNumber("TEST_SCROLL_MIN_MS", 450),
  scrollMax: envNumber("TEST_SCROLL_MAX_MS", 1100),
};

const results = [];
const videos = {};
const createdUsers = [];
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

async function record(status, message, extra = {}) {
  results.push({ status, message, ...extra });
  console.log(`[${status.toUpperCase()}] ${message}`);
}

async function pass(message) {
  await record("pass", message);
}

async function info(message) {
  await record("info", message);
}

async function skip(message, reason) {
  await record("skip", message, { reason });
}

async function fail(message, error) {
  failureCount += 1;
  const detail = error instanceof Error ? error.message : String(error || "");
  let screenshot = null;
  if (activePage) {
    screenshot = await saveScreenshot(activePage, message).catch(() => null);
  }
  await record("fail", message, { detail, screenshot });
}

async function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runCheck(name, callback) {
  try {
    await callback();
    await pass(name);
  } catch (error) {
    await fail(name, error);
  }
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
        backendUrl,
        runId,
        createdUsers: createdUsers.map((user) => ({
          id: user.id,
          username: user.username,
          role: user.role,
          disabledAtCleanup: Boolean(user.disabledAtCleanup),
        })),
        videos,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`[INFO] Role-test result summary written to ${resultsPath}`);
}

function scaled(value) {
  return Math.round(value * multiplier);
}

function captionDuration(text) {
  return scaled(clamp(timing.captionMin + text.length * timing.captionPerChar, timing.captionMin, timing.captionMax));
}

async function pause(page, ms) {
  await page.waitForTimeout(scaled(ms));
}

async function pagePause(page) {
  await pause(page, (timing.pageMin + timing.pageMax) / 2);
}

async function sectionPause(page) {
  await pause(page, timing.section);
}

async function waitForPage(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(300);
}

async function installVisualHelpers(page) {
  await page.addInitScript(() => {
    window.__socRoleCursorPosition = { x: 32, y: 32 };
  });
  await page.evaluate(() => {
    if (!document.getElementById("soc-role-test-style")) {
      const style = document.createElement("style");
      style.id = "soc-role-test-style";
      style.textContent = `
        #soc-role-test-cursor {
          position: fixed;
          left: 0;
          top: 0;
          width: 32px;
          height: 32px;
          z-index: 2147483647;
          pointer-events: none;
          transform: translate3d(32px, 32px, 0);
          filter: drop-shadow(0 4px 8px rgba(15, 23, 42, 0.35));
          transition: transform 20ms linear;
        }
        #soc-role-test-cursor.clicking {
          animation: soc-role-click 180ms ease;
        }
        @keyframes soc-role-click {
          0% { scale: 1; }
          45% { scale: 0.86; }
          100% { scale: 1; }
        }
        #soc-role-test-caption {
          position: fixed;
          left: 28px;
          bottom: 28px;
          z-index: 2147483646;
          max-width: min(560px, calc(100vw - 56px));
          border: 1px solid rgba(148, 163, 184, 0.42);
          border-radius: 8px;
          background: rgba(15, 23, 42, 0.88);
          color: #f8fafc;
          box-shadow: 0 18px 42px rgba(15, 23, 42, 0.25);
          font: 700 15px/1.35 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          letter-spacing: 0;
          padding: 11px 13px;
          pointer-events: none;
          opacity: 0;
          transform: translateY(8px);
          transition: opacity 180ms ease, transform 180ms ease;
        }
        #soc-role-test-caption.visible {
          opacity: 1;
          transform: translateY(0);
        }
      `;
      document.head.appendChild(style);
    }

    let cursor = document.getElementById("soc-role-test-cursor");
    if (!cursor) {
      cursor = document.createElement("div");
      cursor.id = "soc-role-test-cursor";
      cursor.innerHTML = `
        <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
          <path d="M5.2 3.9 26.4 18.7 16.9 20.2 12.1 28.5Z" fill="#fff" stroke="#111827" stroke-width="2" stroke-linejoin="round"/>
          <path d="M15.7 19.5 20.4 28" stroke="#111827" stroke-width="2.4" stroke-linecap="round"/>
        </svg>
      `;
      document.body.appendChild(cursor);
    }
    window.__socRoleCursorPosition ||= { x: 32, y: 32 };
    cursor.style.transform = `translate3d(${window.__socRoleCursorPosition.x}px, ${window.__socRoleCursorPosition.y}px, 0)`;
  });
}

async function showCaption(page, text) {
  await installVisualHelpers(page);
  await page.evaluate((captionText) => {
    let caption = document.getElementById("soc-role-test-caption");
    if (!caption) {
      caption = document.createElement("div");
      caption.id = "soc-role-test-caption";
      document.body.appendChild(caption);
    }
    caption.textContent = captionText;
    requestAnimationFrame(() => caption.classList.add("visible"));
  }, text);
  await page.waitForTimeout(captionDuration(text));
}

async function hideCaption(page) {
  await page.evaluate(() => {
    document.getElementById("soc-role-test-caption")?.classList.remove("visible");
  }).catch(() => undefined);
}

async function glideCursorTo(page, x, y, duration = timing.hover) {
  await installVisualHelpers(page);
  await page.evaluate(
    ({ targetX, targetY, durationMs }) =>
      new Promise((resolve) => {
        const cursor = document.getElementById("soc-role-test-cursor");
        const start = window.__socRoleCursorPosition || { x: 32, y: 32 };
        const startTime = performance.now();
        function ease(t) {
          return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        }
        function frame(now) {
          const progress = Math.min(1, (now - startTime) / Math.max(1, durationMs));
          const eased = ease(progress);
          const x = start.x + (targetX - start.x) * eased;
          const y = start.y + (targetY - start.y) * eased;
          window.__socRoleCursorPosition = { x, y };
          if (cursor) cursor.style.transform = `translate3d(${x}px, ${y}px, 0)`;
          if (progress < 1) requestAnimationFrame(frame);
          else resolve();
        }
        requestAnimationFrame(frame);
      }),
    { targetX: x, targetY: y, durationMs: scaled(duration) },
  );
}

async function smoothScrollToElement(page, locator) {
  const handle = await locator.elementHandle().catch(() => null);
  if (!handle) return;
  await page.evaluate(
    ({ element, minMs, maxMs }) =>
      new Promise((resolve) => {
        const rect = element.getBoundingClientRect();
        const target = window.scrollY + rect.top - window.innerHeight * 0.4;
        const start = window.scrollY;
        const distance = target - start;
        const duration = Math.min(maxMs, Math.max(minMs, Math.abs(distance) * 0.65));
        const startTime = performance.now();
        function ease(t) {
          return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        }
        function frame(now) {
          const progress = Math.min(1, (now - startTime) / Math.max(1, duration));
          window.scrollTo(0, start + distance * ease(progress));
          if (progress < 1) requestAnimationFrame(frame);
          else resolve();
        }
        requestAnimationFrame(frame);
      }),
    { element: handle, minMs: scaled(timing.scrollMin), maxMs: scaled(timing.scrollMax) },
  );
  await handle.dispose();
}

async function glideToLocator(page, locator) {
  await smoothScrollToElement(page, locator);
  const box = await locator.first().boundingBox();
  if (!box) return;
  await glideCursorTo(page, box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(scaled(timing.hover));
}

async function visualClick(page, locator) {
  await glideToLocator(page, locator);
  await locator.first().click();
  await page.evaluate(() => {
    const cursor = document.getElementById("soc-role-test-cursor");
    if (!cursor) return;
    cursor.classList.remove("clicking");
    void cursor.offsetWidth;
    cursor.classList.add("clicking");
  });
  await page.waitForTimeout(scaled(timing.click));
}

async function visualFill(page, locator, value) {
  await glideToLocator(page, locator);
  await locator.first().fill(value);
  await page.waitForTimeout(scaled(timing.click));
}

async function visualSelect(page, locator, value) {
  await glideToLocator(page, locator);
  await locator.first().selectOption(value);
  await page.waitForTimeout(scaled(timing.click));
}

async function navigate(page, pathname, caption) {
  await page.goto(urlFor(pathname), { waitUntil: "domcontentloaded" });
  await waitForPage(page);
  await installVisualHelpers(page);
  if (caption) await showCaption(page, caption);
  await pagePause(page);
}

function requestContext(contextOrPage) {
  if (contextOrPage?.request) return contextOrPage.request;
  if (contextOrPage?.context) return contextOrPage.context().request;
  throw new Error("Expected BrowserContext or Page.");
}

async function apiFetch(contextOrPage, requestPath, options = {}) {
  const backendPath = requestPath.startsWith("/backend") ? requestPath.slice("/backend".length) || "/" : requestPath;
  const targetUrl = requestPath.startsWith("http") ? requestPath : new URL(backendPath, backendUrl).toString();
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

async function loginAs(page, username, password) {
  activePage = page;
  await navigate(page, "/login");
  await visualFill(page, page.getByLabel("Username"), username);
  await visualFill(page, page.getByLabel("Password"), password);
  await visualClick(page, page.getByRole("button", { name: /sign in/i }));
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
  await waitForPage(page);
  await installVisualHelpers(page);
}

async function assertNoBrowserAuthStorage(page, roleName) {
  const stored = await page.evaluate(() => {
    const suspicious = [];
    for (const storage of [localStorage, sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index) || "";
        const value = storage.getItem(key) || "";
        if (/(token|session|auth|cookie)/i.test(`${key} ${value}`)) {
          suspicious.push(key);
        }
      }
    }
    return suspicious;
  });
  await assert(stored.length === 0, `${roleName} browser storage contains auth-like keys: ${stored.join(", ")}`);
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

function findUserRow(page, username) {
  return page.locator("article.admin-row").filter({ hasText: username }).first();
}

async function firstIncident(context) {
  const response = await apiFetch(context, "/incidents?archived=all&limit=1");
  if (!response.ok) return null;
  if (Array.isArray(response.data)) return response.data[0] || null;
  return response.data?.items?.[0] || null;
}

async function createRecordedContext(browser, videoName) {
  await fs.mkdir(outputDir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: videoWidth, height: videoHeight },
    recordVideo: {
      dir: outputDir,
      size: { width: videoWidth, height: videoHeight },
    },
  });
  const page = await context.newPage();
  activePage = page;
  return { context, page, videoName };
}

async function closeRecordedContext(recording) {
  const video = recording.page.video();
  await recording.context.close();
  if (!video) return null;
  const sourcePath = await video.path();
  const targetPath = path.join(outputDir, recording.videoName);
  await fs.copyFile(sourcePath, targetPath);
  await fs.rm(sourcePath, { force: true });
  videos[recording.videoName.replace(/\.webm$/, "")] = targetPath;
  return targetPath;
}

async function confirmForbiddenPage(page, pathname, label) {
  await navigate(page, pathname, `${label} cannot access ${pathname}.`);
  const bodyText = await page.locator("body").innerText().catch(() => "");
  await assert(/forbidden|cannot|login|required|not authorized|unauthorized/i.test(bodyText), `${label} should see forbidden UI for ${pathname}`);
}

async function showFirstIncidentIfAny(page, context, roleName) {
  const incident = await firstIncident(context);
  if (!incident) {
    await skip(`${roleName} incident detail`, "No incident exists in the current database.");
    await showCaption(page, "No incidents are available in this lab database, so detail checks are skipped.");
    return null;
  }
  await navigate(page, `/incidents/${incident.id}`, `${roleName} opens a read-only incident detail view.`);
  return incident;
}

async function createDisposableUsersIfNeeded(context, page) {
  if (!createUsers) {
    await info("TEST_CREATE_USERS=false; using configured/generated usernames without creating users.");
    return;
  }

  const existingAnalyst = await getUser(context, analystUsername);
  const existingViewer = await getUser(context, viewerUsername);
  const analyst = existingAnalyst || (await createUser(context, {
    username: analystUsername,
    display_name: "Role Video Analyst",
    role: "analyst",
    password: analystPassword,
  }));
  const viewer = existingViewer || (await createUser(context, {
    username: viewerUsername,
    display_name: "Role Video Viewer",
    role: "viewer",
    password: viewerPassword,
  }));

  createdUsers.push({ ...analyst, passwordKind: "generated" }, { ...viewer, passwordKind: "generated" });
  await showCaption(page, "Disposable analyst and viewer users are created for isolated role testing.");
  await pass("Disposable role-test users created");
}

async function recordAdmin(browser) {
  const recording = await createRecordedContext(browser, "role-admin.webm");
  const { context, page } = recording;
  activePage = page;

  await runCheck("Admin role video", async () => {
    await showCaption(page, "Admin role test: login, user management, audit, incidents, response actions, and report page.");
    await loginAs(page, adminUsername, adminPassword);
    await showCaption(page, "Admin dashboard is available after cookie-based login.");
    const me = await apiFetch(context, "/auth/me");
    await assert(me.ok, `/auth/me failed: ${me.text}`);
    await assert(me.data?.role === "super_admin" || me.data?.permissions?.includes("manage_users"), "Admin must be super_admin or have manage_users.");
    await assertNoBrowserAuthStorage(page, "admin");

    await navigate(page, "/admin/users", "Admin can access user management.");
    await assert(await page.getByRole("button", { name: /create user/i }).isVisible(), "Create user form is not visible.");
    await createDisposableUsersIfNeeded(context, page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForPage(page);
    await installVisualHelpers(page);
    await assert(await findUserRow(page, analystUsername).isVisible(), "Disposable analyst row is not visible.");
    await assert(await findUserRow(page, viewerUsername).isVisible(), "Disposable viewer row is not visible.");

    const analystRow = findUserRow(page, analystUsername);
    await smoothScrollToElement(page, analystRow);
    const displayInput = analystRow.getByLabel("Display name");
    const saveButton = analystRow.getByRole("button", { name: /save changes/i });
    await visualFill(page, displayInput, "Role Video Analyst Saved");
    await visualClick(page, page.getByRole("heading", { name: /admin users/i }));
    await showCaption(page, "No update is saved until Save is clicked.");
    const beforeSave = await getUser(context, analystUsername);
    await assert(beforeSave?.display_name !== "Role Video Analyst Saved", "Display name persisted before Save.");
    await visualClick(page, saveButton);
    await page.getByText(/user updated/i).waitFor({ timeout: 8000 });
    const afterSave = await getUser(context, analystUsername);
    await assert(afterSave?.display_name === "Role Video Analyst Saved", "Display name was not saved after Save.");

    const viewerRow = findUserRow(page, viewerUsername);
    await smoothScrollToElement(page, viewerRow);
    await visualFill(page, viewerRow.getByLabel("New password"), viewerResetPassword);
    await visualClick(page, page.getByRole("heading", { name: /admin users/i }));
    await showCaption(page, "Password reset is also explicit; blur alone does nothing.");
    await visualClick(page, viewerRow.getByRole("button", { name: /reset password/i }));
    viewerLoginPassword = viewerResetPassword;
    await page.locator(".alert.success").filter({ hasText: /password reset/i }).waitFor({ timeout: 8000 });

    await navigate(page, "/admin/audit", "Admin audit shows metrics and security events.");
    await assert(await page.getByRole("heading", { name: /audit/i }).first().isVisible(), "Audit page did not load.");

    await navigate(page, "/incidents", "Admin reviews incident filters and cards without mutating incidents.");
    await assert(await page.getByRole("heading", { name: /incidents/i }).first().isVisible(), "Incidents page did not load.");
    const incident = await showFirstIncidentIfAny(page, context, "Admin");
    if (incident) {
      const body = await page.locator("body").innerText();
      await assert(/response actions/i.test(body), "Response Actions section is missing.");
      await assert(/manual|dry-run|unavailable|protected|automated/i.test(body), "Response-action status badges were not visible.");
      await assert(!/stdout\s*:|stderr\s*:|disable-adaccount|iptables\s+-(a|c)/i.test(body), "Raw command/stdout/stderr text is visible.");
      await showCaption(page, "Response actions are displayed as status and policy context; Execute is not clicked.");
    }

    await navigate(page, "/report", "Report page is visible. Generation stays off unless explicitly enabled.");
    await assert(await page.getByRole("heading", { name: "Report", level: 1 }).isVisible(), "Report page did not load.");
    if (generateReport) {
      await visualClick(page, page.getByRole("button", { name: /generate report/i }));
      await page.waitForFunction(
        () => /generated report|no incidents found|report generation failed/i.test(document.body.textContent || ""),
        null,
        { timeout: 90000 },
      );
    } else {
      await skip("Admin report generation", "TEST_REPORT_GENERATION=false.");
    }
  });

  await hideCaption(page).catch(() => undefined);
  return closeRecordedContext(recording);
}

async function recordAnalyst(browser) {
  const recording = await createRecordedContext(browser, "role-analyst.webm");
  const { context, page } = recording;
  activePage = page;

  await runCheck("Analyst role video", async () => {
    await showCaption(page, "Analyst role test: investigation pages are available, admin and execution controls are blocked.");
    await loginAs(page, analystUsername, analystPassword);
    await assertNoBrowserAuthStorage(page, "analyst");
    await showCaption(page, "Analyst can view dashboard and investigation workflow.");

    await navigate(page, "/incidents", "Analyst can open the incident queue.");
    await assert(await page.getByRole("heading", { name: /incidents/i }).first().isVisible(), "Analyst cannot load incidents.");
    const incident = await showFirstIncidentIfAny(page, context, "Analyst");
    if (incident) {
      const body = await page.locator("body").innerText();
      for (const label of ["Incident Overview", "AI Analysis", "Alert Activity", "Observables", "Manual Playbook", "Notes", "Response Actions"]) {
        if (new RegExp(label, "i").test(body)) {
          await showCaption(page, `Analyst can review ${label}.`);
          await sectionPause(page);
        } else {
          await skip(`Analyst ${label}`, `${label} was not present for this incident.`);
        }
      }
      await assert((await page.getByRole("button", { name: /execute/i }).count()) === 0, "Analyst sees Execute controls.");
    }

    const usersApi = await apiFetch(context, "/admin/users");
    await assert(usersApi.status === 403, `Analyst /admin/users should return 403, got ${usersApi.status}.`);
    await confirmForbiddenPage(page, "/admin/users", "Analyst");
    const auditApi = await apiFetch(context, "/admin/audit-events");
    await assert(auditApi.status === 403, `Analyst /admin/audit-events should return 403, got ${auditApi.status}.`);
    await confirmForbiddenPage(page, "/admin/audit", "Analyst");

    await navigate(page, "/report", "Analyst can open the report page without generating a report by default.");
    await assert(await page.getByRole("heading", { name: "Report", level: 1 }).isVisible(), "Analyst report page did not load.");
  });

  await hideCaption(page).catch(() => undefined);
  return closeRecordedContext(recording);
}

async function recordViewer(browser) {
  const recording = await createRecordedContext(browser, "role-viewer.webm");
  const { context, page } = recording;
  activePage = page;

  await runCheck("Viewer role video", async () => {
    await showCaption(page, "Viewer role test: read-only pages are available, mutating controls are hidden.");
    await loginAs(page, viewerUsername, viewerLoginPassword);
    await assertNoBrowserAuthStorage(page, "viewer");
    await showCaption(page, "Viewer can open dashboard with a read-only session.");

    await navigate(page, "/incidents", "Viewer can inspect incidents without mutation controls.");
    await assert(await page.getByRole("heading", { name: /incidents/i }).first().isVisible(), "Viewer cannot load incidents.");
    const incident = await showFirstIncidentIfAny(page, context, "Viewer");
    if (incident) {
      for (const buttonName of [/approve/i, /reject/i, /^archive$/i, /unarchive/i, /execute/i, /add note/i, /save/i]) {
        await assert((await page.getByRole("button", { name: buttonName }).count()) === 0, `Viewer sees mutating button ${buttonName}.`);
      }
      await showCaption(page, "Viewer incident detail remains read-only: no approve, reject, archive, execute, note, or playbook-save controls.");
      for (const actionPath of [`/incidents/${incident.id}/approve`, `/incidents/${incident.id}/reject`, `/incidents/${incident.id}/archive`]) {
        const response = await apiFetch(context, actionPath, { method: "POST" });
        await assert(response.status === 403, `${actionPath} should return 403 for viewer, got ${response.status}.`);
      }
    }

    const usersApi = await apiFetch(context, "/admin/users");
    await assert(usersApi.status === 403, `Viewer /admin/users should return 403, got ${usersApi.status}.`);
    await confirmForbiddenPage(page, "/admin/users", "Viewer");
    const auditApi = await apiFetch(context, "/admin/audit-events");
    await assert(auditApi.status === 403, `Viewer /admin/audit-events should return 403, got ${auditApi.status}.`);
    await confirmForbiddenPage(page, "/admin/audit", "Viewer");

    await navigate(page, "/report", "Viewer can open the report page without generation by default.");
    await assert(await page.getByRole("heading", { name: "Report", level: 1 }).isVisible(), "Viewer report page did not load.");
  });

  await hideCaption(page).catch(() => undefined);
  return closeRecordedContext(recording);
}

async function cleanupUsers(browser) {
  if (!disableCreatedUsers || createdUsers.length === 0) {
    await skip("Role-test user cleanup", disableCreatedUsers ? "No created users to disable." : "TEST_DISABLE_CREATED_USERS=false.");
    return;
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  activePage = page;
  try {
    await loginAs(page, adminUsername, adminPassword);
    for (const createdUser of createdUsers) {
      const latest = await getUser(context, createdUser.username).catch(() => null);
      if (latest) {
        await disableUser(context, latest);
        createdUser.disabledAtCleanup = true;
      }
    }
    await pass("Disabled disposable role-test users");
  } catch (error) {
    await fail("Disable disposable role-test users", error);
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(screenshotsDir, { recursive: true });
  await info(`Role-test frontend URL: ${frontendUrl}`);
  await info(`Role-test backend URL: ${backendUrl}`);
  await info(`Role-test output dir: ${outputDir}`);

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless, slowMo });

  try {
    await recordAdmin(browser);
    await recordAnalyst(browser);
    await recordViewer(browser);
  } finally {
    await cleanupUsers(browser).catch(async (error) => {
      await fail("Cleanup crashed", error);
    });
    await browser.close().catch(() => undefined);
    await writeResults();
  }

  process.exitCode = failureCount > 0 ? 1 : 0;
}

main().catch(async (error) => {
  await fail("Role-test recorder crashed", error);
  await writeResults();
  process.exitCode = 1;
});
