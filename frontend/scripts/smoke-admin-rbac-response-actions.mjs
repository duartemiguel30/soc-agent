import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(frontendRoot, "..");

function loadSmokeEnvFile() {
  const candidates = process.env.SMOKE_ENV_FILE
    ? [path.resolve(process.env.SMOKE_ENV_FILE)]
    : [path.join(repoRoot, ".env.smoke"), path.join(frontendRoot, ".env.smoke")];

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
    console.log(`[INFO] Loaded smoke environment from ${candidate}`);
    return;
  }
}

function envBool(name, fallback) {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  return value.trim().toLowerCase() === "true";
}

function envNumber(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function sanitizeLabel(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "failure";
}

loadSmokeEnvFile();

const frontendUrl = process.env.SMOKE_FRONTEND_URL || "http://192.168.56.105:3000";
const backendUrl = process.env.SMOKE_BACKEND_URL || "http://192.168.56.105:8000";
const adminUsername = process.env.SMOKE_ADMIN_USERNAME || "admin";
const adminPassword = process.env.SMOKE_ADMIN_PASSWORD || "admin";
const headless = envBool("SMOKE_HEADLESS", false);
const slowMo = envNumber("SMOKE_SLOW_MO_MS", 80);
const generateReport = envBool("SMOKE_GENERATE_REPORT", false);
const outputDir = path.resolve(repoRoot, process.env.SMOKE_OUTPUT_DIR || "smoke-output");
const resultsPath = path.join(outputDir, "smoke-results.json");
const runId = Date.now();
const analystUsername = `smoke_analyst_${runId}`;
const viewerUsername = `smoke_viewer_${runId}`;
const analystPassword = `SmokeTest!${runId}A`;
const viewerPassword = `SmokeTest!${runId}V`;
const viewerResetPassword = `SmokeTest!${runId}R`;

const results = [];
let activePage = null;
let failureCount = 0;

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") {
      throw error;
    }
    throw new Error("Playwright is required. Run: npm install && npx playwright install chromium");
  }
}

function urlFor(pathname) {
  return new URL(pathname, frontendUrl).toString();
}

async function pass(message) {
  results.push({ status: "pass", message });
  console.log(`[PASS] ${message}`);
}

async function info(message) {
  results.push({ status: "info", message });
  console.log(`[INFO] ${message}`);
}

async function fail(message, error) {
  failureCount += 1;
  const detail = error instanceof Error ? error.message : String(error || "");
  const screenshot = activePage ? await saveScreenshot(activePage, message).catch(() => null) : null;
  results.push({ status: "fail", message, detail, screenshot });
  console.log(`[FAIL] ${message}${detail ? `: ${detail}` : ""}`);
}

async function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function saveScreenshot(page, label) {
  await fs.mkdir(outputDir, { recursive: true });
  const filePath = path.join(outputDir, `${sanitizeLabel(label)}-${Date.now()}.png`);
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
        createdUsers: { analystUsername, viewerUsername },
        results,
      },
      null,
      2,
    ),
  );
  console.log(`[INFO] Smoke result summary written to ${resultsPath}`);
}

async function runStep(name, callback) {
  try {
    await callback();
    await pass(name);
  } catch (error) {
    await fail(name, error);
  }
}

async function waitForPage(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(350);
}

async function loginAs(page, username, password, options = {}) {
  const expectSuccess = options.expectSuccess !== false;
  activePage = page;
  await page.goto(urlFor("/login"), { waitUntil: "domcontentloaded" });
  await waitForPage(page);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  if (!expectSuccess) {
    await page.waitForTimeout(1200);
    const onDashboard = /\/dashboard/.test(page.url());
    await assert(!onDashboard, `Login unexpectedly succeeded for ${username}`);
    return false;
  }
  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
  await waitForPage(page);
  return true;
}

function requestContext(contextOrPage) {
  if (contextOrPage?.request) {
    return contextOrPage.request;
  }
  if (contextOrPage?.context) {
    return contextOrPage.context().request;
  }
  throw new Error("Expected a BrowserContext or Page for apiFetch.");
}

async function apiFetch(contextOrPage, requestPath, options = {}) {
  const backendPath = requestPath.startsWith("/backend") ? requestPath.slice("/backend".length) || "/" : requestPath;
  const targetUrl = requestPath.startsWith("http") ? requestPath : new URL(backendPath, backendUrl).toString();
  const headers = { ...(options.headers || {}) };
  const requestOptions = {
    method: options.method || "GET",
    headers,
  };
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
  return { status: response.status(), ok: response.ok(), data, text };
}

async function createUser(contextOrPage, payload) {
  const response = await apiFetch(contextOrPage, "/admin/users", { method: "POST", body: payload });
  await assert(response.ok, `Could not create user ${payload.username}: ${response.text}`);
  return response.data;
}

async function listUsers(contextOrPage) {
  const response = await apiFetch(contextOrPage, "/admin/users");
  await assert(response.ok, `Could not list users: ${response.text}`);
  return response.data;
}

async function getUser(contextOrPage, username) {
  const users = await listUsers(contextOrPage);
  return users.find((user) => user.username === username) || null;
}

async function disableUser(contextOrPage, user) {
  if (!user?.id || user.is_active === false) {
    return;
  }
  const response = await apiFetch(contextOrPage, `/admin/users/${user.id}/disable`, { method: "POST" });
  await assert(response.ok, `Could not disable ${user.username}: ${response.text}`);
}

function findUserRow(page, username) {
  return page.locator("article.admin-row").filter({ hasText: username }).first();
}

async function firstIncident(contextOrPage) {
  const response = await apiFetch(contextOrPage, "/incidents?archived=all&limit=1");
  if (!response.ok) {
    return null;
  }
  if (Array.isArray(response.data)) {
    return response.data[0] || null;
  }
  return response.data?.items?.[0] || null;
}

async function makeLoggedInContext(browser, username, password) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginAs(page, username, password);
  return { context, page };
}

async function forbiddenUiOrStatus(page, apiResponse, pageName) {
  if (apiResponse) {
    await assert(apiResponse.status === 403, `${pageName} API should return 403, got ${apiResponse.status}`);
  }
  const bodyText = await page.locator("body").innerText().catch(() => "");
  await assert(/forbidden|cannot|admin authentication|required/i.test(bodyText), `${pageName} should show a forbidden message`);
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  const playwright = await loadPlaywright();
  const { chromium } = playwright;
  const browser = await chromium.launch({ headless, slowMo });
  const createdUsers = [];
  let adminContext;
  let adminPage;
  let viewerContext;
  let viewerPage;
  let analystContext;
  let analystPage;

  try {
    await info(`Smoke frontend URL: ${frontendUrl}`);
    await info(`Smoke backend URL: ${backendUrl}`);
    await info(`Smoke output dir: ${outputDir}`);

    adminContext = await browser.newContext();
    adminPage = await adminContext.newPage();

    await runStep("Admin login and /auth/me", async () => {
      await loginAs(adminPage, adminUsername, adminPassword);
      const me = await apiFetch(adminContext, "/auth/me");
      await assert(me.ok, `/auth/me failed: ${me.text}`);
      await assert(me.data?.username, "/auth/me missing username");
      await assert(me.data?.role, "/auth/me missing role");
      await assert(Array.isArray(me.data?.permissions), "/auth/me missing permissions");
      await assert(
        me.data.role === "super_admin" || me.data.permissions.includes("manage_users"),
        "Admin must be super_admin or have manage_users.",
      );
    });

    await runStep("Admin Users page and disposable user creation", async () => {
      activePage = adminPage;
      await adminPage.goto(urlFor("/admin/users"), { waitUntil: "domcontentloaded" });
      await waitForPage(adminPage);
      await assert(await adminPage.getByRole("heading", { name: /users/i }).first().isVisible(), "/admin/users did not load");
      await assert(await adminPage.getByRole("button", { name: /create user/i }).isVisible(), "Create user form is not visible");
      const analyst = await createUser(adminContext, {
        username: analystUsername,
        display_name: "Smoke Analyst",
        role: "analyst",
        password: analystPassword,
      });
      const viewer = await createUser(adminContext, {
        username: viewerUsername,
        display_name: "Smoke Viewer",
        role: "viewer",
        password: viewerPassword,
      });
      createdUsers.push(analyst, viewer);
      await info(`Created disposable smoke users: ${createdUsers.map((user) => user.username).join(", ")}`);
      await adminPage.reload({ waitUntil: "domcontentloaded" });
      await waitForPage(adminPage);
      await assert(await findUserRow(adminPage, analystUsername).isVisible(), "Analyst user row not visible");
      await assert(await findUserRow(adminPage, viewerUsername).isVisible(), "Viewer user row not visible");
    });

    await runStep("Per-user Save behavior", async () => {
      activePage = adminPage;
      const analystRow = findUserRow(adminPage, analystUsername);
      await assert(await analystRow.isVisible(), "Analyst row is missing");
      const displayInput = analystRow.getByLabel("Display name");
      const roleSelect = analystRow.getByLabel("Role");
      const saveButton = analystRow.getByRole("button", { name: /save changes/i });

      await displayInput.fill("Smoke Analyst Draft");
      await adminPage.getByRole("heading", { name: /admin users/i }).click();
      await adminPage.waitForTimeout(800);
      const afterBlur = await getUser(adminContext, analystUsername);
      await assert(afterBlur?.display_name !== "Smoke Analyst Draft", "Display name persisted before Save.");
      await assert(await saveButton.isEnabled(), "Save should be enabled after display-name change.");
      await saveButton.click();
      await adminPage.getByText(/user updated/i).waitFor({ timeout: 6000 });
      const afterSave = await getUser(adminContext, analystUsername);
      await assert(afterSave?.display_name === "Smoke Analyst Draft", "Display name did not persist after Save.");

      const refreshedRow = findUserRow(adminPage, analystUsername);
      await refreshedRow.getByLabel("Role").selectOption("viewer");
      await adminPage.getByRole("heading", { name: /admin users/i }).click();
      await adminPage.waitForTimeout(800);
      const afterRoleBlur = await getUser(adminContext, analystUsername);
      await assert(afterRoleBlur?.role === "analyst", "Role persisted before Save.");
      await refreshedRow.getByRole("button", { name: /save changes/i }).click();
      await adminPage.getByText(/user updated/i).waitFor({ timeout: 6000 });
      const afterRoleSave = await getUser(adminContext, analystUsername);
      await assert(afterRoleSave?.role === "viewer", "Role did not persist after Save.");

      const viewerDraftRow = findUserRow(adminPage, analystUsername);
      await viewerDraftRow.getByLabel("Role").selectOption("analyst");
      await viewerDraftRow.getByRole("button", { name: /save changes/i }).click();
      await adminPage.getByText(/user updated/i).waitFor({ timeout: 6000 });
      const restored = await getUser(adminContext, analystUsername);
      await assert(restored?.role === "analyst", "Analyst role was not restored for analyst RBAC tests.");
      await assert(!(await findUserRow(adminPage, analystUsername).getByRole("button", { name: /save changes/i }).isEnabled()), "Save should be disabled after refresh.");
    });

    await runStep("Password reset explicitness", async () => {
      activePage = adminPage;
      const viewerRow = findUserRow(adminPage, viewerUsername);
      await assert(await viewerRow.isVisible(), "Viewer row is missing");
      const passwordInput = viewerRow.getByLabel("New password");
      await passwordInput.fill(viewerResetPassword);
      await adminPage.getByRole("heading", { name: /admin users/i }).click();
      await adminPage.waitForTimeout(800);

      const beforeResetContext = await browser.newContext();
      try {
        const beforeResetPage = await beforeResetContext.newPage();
        activePage = beforeResetPage;
        await loginAs(beforeResetPage, viewerUsername, viewerResetPassword, { expectSuccess: false });
      } finally {
        await beforeResetContext.close();
      }

      activePage = adminPage;
      await viewerRow.getByRole("button", { name: /reset password/i }).click();
      await adminPage.getByText(/password reset/i).waitFor({ timeout: 6000 });
      const viewerLogin = await makeLoggedInContext(browser, viewerUsername, viewerResetPassword);
      viewerContext = viewerLogin.context;
      viewerPage = viewerLogin.page;
    });

    await runStep("Viewer RBAC", async () => {
      activePage = viewerPage;
      const usersApi = await apiFetch(viewerContext, "/admin/users");
      await viewerPage.goto(urlFor("/admin/users"), { waitUntil: "domcontentloaded" });
      await waitForPage(viewerPage);
      await forbiddenUiOrStatus(viewerPage, usersApi, "/admin/users");

      const auditApi = await apiFetch(viewerContext, "/admin/audit-events");
      await viewerPage.goto(urlFor("/admin/audit"), { waitUntil: "domcontentloaded" });
      await waitForPage(viewerPage);
      await forbiddenUiOrStatus(viewerPage, auditApi, "/admin/audit");

      await viewerPage.goto(urlFor("/incidents"), { waitUntil: "domcontentloaded" });
      await waitForPage(viewerPage);
      await assert(await viewerPage.getByRole("heading", { name: /incidents/i }).isVisible(), "Viewer could not load /incidents");
      for (const buttonName of [/approve/i, /reject/i, /^archive$/i, /unarchive/i, /execute/i, /add note/i]) {
        await assert((await viewerPage.getByRole("button", { name: buttonName }).count()) === 0, `Viewer sees mutating button ${buttonName}`);
      }

      const incident = await firstIncident(viewerContext);
      if (!incident) {
        await info("No incidents found; skipping viewer direct incident mutation 403 checks.");
        return;
      }
      for (const actionPath of [
        `/incidents/${incident.id}/archive`,
        `/incidents/${incident.id}/approve`,
        `/incidents/${incident.id}/reject`,
      ]) {
        const direct = await apiFetch(viewerContext, actionPath, { method: "POST" });
        await assert(direct.status === 403, `${actionPath} should return 403 for viewer, got ${direct.status}`);
      }
    });

    await runStep("Analyst RBAC", async () => {
      const analystLogin = await makeLoggedInContext(browser, analystUsername, analystPassword);
      analystContext = analystLogin.context;
      analystPage = analystLogin.page;
      activePage = analystPage;
      await analystPage.goto(urlFor("/incidents"), { waitUntil: "domcontentloaded" });
      await waitForPage(analystPage);
      await assert(await analystPage.getByRole("heading", { name: /incidents/i }).isVisible(), "Analyst could not load /incidents");
      await assert((await apiFetch(analystContext, "/admin/users")).status === 403, "Analyst /admin/users API should be 403");
      await assert((await apiFetch(analystContext, "/admin/audit-events")).status === 403, "Analyst /admin/audit API should be 403");
      await analystPage.goto(urlFor("/admin/users"), { waitUntil: "domcontentloaded" });
      await waitForPage(analystPage);
      await assert(/forbidden|cannot/i.test(await analystPage.locator("body").innerText()), "Analyst should see forbidden admin users UI");

      const incident = await firstIncident(analystContext);
      if (!incident) {
        await info("No incidents found; skipping analyst incident detail response-action UI check.");
        return;
      }
      await analystPage.goto(urlFor(`/incidents/${incident.id}`), { waitUntil: "domcontentloaded" });
      await waitForPage(analystPage);
      await assert((await analystPage.getByRole("button", { name: /execute/i }).count()) === 0, "Analyst sees Execute controls.");
      const body = await analystPage.locator("body").innerText();
      await assert(/response actions/i.test(body), "Analyst should be able to view response actions.");
    });

    await runStep("Admin audit", async () => {
      activePage = adminPage;
      await adminPage.goto(urlFor("/admin/audit"), { waitUntil: "domcontentloaded" });
      await waitForPage(adminPage);
      await assert(await adminPage.getByRole("heading", { name: /audit/i }).isVisible(), "/admin/audit did not load");
      await assert(await adminPage.getByText(/successful logins 24h/i).isVisible(), "Audit metrics did not load");
      const events = await apiFetch(adminContext, "/admin/audit-events?limit=200");
      await assert(events.ok, `Could not fetch audit events: ${events.text}`);
      const eventTypes = new Set((events.data?.items || []).map((event) => event.event_type));
      for (const expected of ["login_success", "user_created", "user_password_reset", "permission_denied"]) {
        await assert(eventTypes.has(expected), `Audit events missing ${expected}`);
      }
    });

    await runStep("Response actions safety UI", async () => {
      activePage = adminPage;
      const incident = await firstIncident(adminContext);
      if (!incident) {
        await info("No incidents found; skipping response action UI checks.");
        return;
      }
      await adminPage.goto(urlFor(`/incidents/${incident.id}`), { waitUntil: "domcontentloaded" });
      await waitForPage(adminPage);
      await assert(await adminPage.getByText(/response actions/i).first().isVisible(), "Response Actions section is missing");
      const body = await adminPage.locator("body").innerText();
      await assert(/manual|dry-run|unavailable|protected|automated/i.test(body), "Expected response-action status badges not found");
      await assert(!/iptables\s+-(a|c)|disable-adaccount|stdout\s*:|stderr\s*:/i.test(body), "Raw command or output text is visible.");
    });

    await runStep("Report page", async () => {
      activePage = adminPage;
      await adminPage.goto(urlFor("/report"), { waitUntil: "domcontentloaded" });
      await waitForPage(adminPage);
      await assert(await adminPage.getByRole("heading", { name: "Report", level: 1 }).isVisible(), "/report did not load");
      if (!generateReport) {
        await info("SMOKE_GENERATE_REPORT=false; skipping Gemini report generation.");
        return;
      }
      await adminPage.getByRole("button", { name: /generate report/i }).click();
      await adminPage.waitForFunction(
        () => {
          const text = document.body.textContent || "";
          return /generated report|no incidents found|report generation failed/i.test(text);
        },
        null,
        { timeout: 90000 },
      );
    });

    await runStep("Cleanup smoke users", async () => {
      activePage = adminPage;
      await adminPage.goto(urlFor("/dashboard"), { waitUntil: "domcontentloaded" });
      for (const username of [analystUsername, viewerUsername]) {
        const user = await getUser(adminContext, username);
        await disableUser(adminContext, user);
      }

      const disabledViewerContext = await browser.newContext();
      try {
        const disabledViewerPage = await disabledViewerContext.newPage();
        activePage = disabledViewerPage;
        await loginAs(disabledViewerPage, viewerUsername, viewerResetPassword, { expectSuccess: false });
      } finally {
        await disabledViewerContext.close();
      }
    });
  } finally {
    if (failureCount > 0) {
      await info("Attempting cleanup after failures.");
      try {
        if (adminContext) {
          for (const username of [analystUsername, viewerUsername]) {
            const user = await getUser(adminContext, username).catch(() => null);
            if (user) {
              await disableUser(adminContext, user).catch(() => undefined);
            }
          }
        }
      } catch {
        // Cleanup is best-effort; original failures remain recorded.
      }
    }
    await viewerContext?.close().catch(() => undefined);
    await analystContext?.close().catch(() => undefined);
    await adminContext?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    await writeResults();
  }

  process.exitCode = failureCount > 0 ? 1 : 0;
}

main().catch(async (error) => {
  await fail("Smoke script crashed", error);
  await writeResults();
  process.exitCode = 1;
});
