import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./helpers";
import { READY, watchErrors } from "./mock";

// An agent on an SSH host asks, and the side bar answers it (sshAsks.ts, SshProjectsSection.svelte):
// through Kingu's hold on the host (`ssh_remote_permission_answer`), with keys typed into its
// terminal's `ssh -t` (`pty_write`), or not at all once expired.

/** Starts claude on the project's host from the side bar: its hook events come from `__e2e.ssh.hookEvents`. */
async function startRemoteAgent(page: Page) {
  await openApp(page, READY, { "kingu.agent.cli": "claude" }, { ssh: true });
  await page.evaluate(
    () =>
      ((window as any).__e2e.ssh.agents = [
        { name: "claude", path: "/usr/bin/claude", fallback: false },
      ]),
  );
  await page.getByRole("button", { name: "Open in Agents" }).click();
  await expect(
    page.getByRole("img", { name: "box: Connected", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Run claude", exact: true })
    .first()
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__e2e.spawns.some((s: { key: string }) =>
          s.key.startsWith("floating:"),
        ),
      ),
    )
    .toBe(true);
}

const push = (page: Page, event: object) =>
  page.evaluate((e) => (window as any).__e2e.ssh.hookEvents.push(e), event);
const answers = (page: Page) =>
  page.evaluate(() => (window as any).__e2e.ssh.answers);
/** What was typed into the agent's floating terminal (its `ssh -t` to the host). */
const typed = (page: Page) =>
  page.evaluate(() =>
    (window as any).__e2e.writes
      .filter((w: { key: string }) => w.key.startsWith("floating:"))
      .map((w: { data: string }) => w.data),
  );
const card = (page: Page) =>
  page.getByRole("alertdialog", { name: /needs permission$/ });

const held = {
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  session_id: "r1",
  kingu_hold: "1700000000-7",
  tool_input: { command: "npm test" },
  permission_suggestions: [
    {
      type: "addRules",
      behavior: "allow",
      destination: "localSettings",
      rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
    },
  ],
};

test("a held permission prompt on the host is answered from the side bar, for this session", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await startRemoteAgent(page);
  await push(page, held);
  await expect(card(page)).toBeVisible({ timeout: 10_000 });
  await expect(card(page).getByText("npm test", { exact: true })).toBeVisible();
  await expect(
    card(page).getByText(/waits on box for this answer/),
  ).toBeVisible();

  await card(page)
    .getByRole("button", { name: "Allow for this session" })
    .click();
  await expect(card(page)).toHaveCount(0);
  await expect
    .poll(() => answers(page))
    .toEqual([
      expect.objectContaining({
        host: "box",
        root: "/srv/app",
        token: "abcdef123456",
        hold: "1700000000-7",
        allow: true,
        session: ["rule:Bash(npm test:*)"],
        scope: "session",
        message: null,
      }),
    ]);
  // The hold took it: nothing typed into the terminal.
  expect(await typed(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test("Always allow in this project saves only the suggested rule, through the hold", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await startRemoteAgent(page);
  await push(page, held);
  await card(page)
    .getByRole("button", { name: "Always allow in this project" })
    .click();
  await expect
    .poll(() => answers(page))
    .toEqual([
      expect.objectContaining({
        allow: true,
        session: ["rule:Bash(npm test:*)"],
        scope: "project",
      }),
    ]);
  await expect(card(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Deny on the host tells the agent the reason typed", async ({ page }) => {
  const errors = watchErrors(page);
  await startRemoteAgent(page);
  await push(page, { ...held, kingu_hold: "1700000000-8" });
  await card(page)
    .getByRole("textbox", { name: "Why not? (optional, told to the agent)" })
    .fill("use  pnpm\n");
  await card(page).getByRole("button", { name: "Deny", exact: true }).click();
  await expect
    .poll(() => answers(page))
    .toEqual([
      expect.objectContaining({
        hold: "1700000000-8",
        allow: false,
        session: null,
        scope: null,
        message: "use pnpm",
      }),
    ]);
  expect(errors).toEqual([]);
});

test("a hold that ended before the answer shows as expired, and nothing is allowed or typed", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await startRemoteAgent(page);
  // The hold script on the host stopped waiting (its 122 s ran out): the answer finds no hold.
  await page.evaluate(() => ((window as any).__e2e.ssh.answered = false));
  await push(page, held);
  await card(page).getByRole("button", { name: "Allow", exact: true }).click();
  const expired = page.getByRole("status", { name: /^Expired: / });
  await expect(expired).toBeVisible();
  await expect(expired.getByText(/2-minute wait on box ran out/)).toBeVisible();
  await expect(
    expired.getByRole("button", { name: "Allow", exact: true }),
  ).toHaveCount(0);
  await expect(card(page)).toHaveCount(0);
  // Exactly the one refused answer, never retried, and never Enter in the terminal.
  expect((await answers(page)).length).toBe(1);
  expect(await typed(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test("a prompt with no hold is answered with Enter in the remote terminal", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await startRemoteAgent(page);
  await push(page, {
    hook_event_name: "PermissionRequest",
    tool_name: "Write",
    session_id: "r1",
    tool_input: { file_path: "/srv/app/a.txt" },
  });
  await expect(card(page).getByText(/presses Enter/)).toBeVisible({
    timeout: 10_000,
  });
  // No hold, no grants: only once or deny.
  await expect(
    card(page).getByRole("button", { name: "Allow for this session" }),
  ).toHaveCount(0);
  await card(page).getByRole("button", { name: "Allow", exact: true }).click();
  await expect.poll(() => typed(page)).toEqual(["\r"]);
  await expect(card(page)).toHaveCount(0);
  expect(await answers(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test("an agent's question on the host is answered with its question UI's keys", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await startRemoteAgent(page);
  await push(page, {
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    session_id: "r1",
    tool_input: {
      questions: [
        {
          question: "Which database?",
          header: "DB",
          multiSelect: false,
          options: [{ label: "Postgres" }, { label: "SQLite" }],
        },
      ],
    },
  });
  const q = page.getByRole("group", { name: "The agent asks" });
  await expect(q).toBeVisible({ timeout: 10_000 });
  await expect(q.getByText(/Typed into .* terminal on box/)).toBeVisible();
  await q.getByRole("radio", { name: /SQLite/ }).click();
  await q.getByRole("button", { name: "Send" }).click();
  // claude's selector takes the option's number.
  await expect.poll(() => typed(page)).toEqual(["2"]);
  await expect(q).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a dropped connection mid-question shows the prompt as expired with nothing to press", async ({
  page,
}) => {
  const errors = watchErrors(page);
  await startRemoteAgent(page);
  await push(page, held);
  await expect(card(page)).toBeVisible({ timeout: 10_000 });

  await page.evaluate(() => {
    const ssh = (window as any).__e2e.ssh;
    ssh.worktrees = "Connection reset by peer";
    ssh.keepalive = "Connection reset by peer";
    ssh.connect =
      "ssh: connect to host box.example.test port 22: Connection refused";
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const expired = page.getByRole("status", { name: /^Expired: / });
  await expect(expired).toBeVisible({ timeout: 10_000 });
  await expect(
    expired.getByText(/connection to box dropped before an answer/),
  ).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Allow", exact: true }),
  ).toHaveCount(0);

  // Back within the hold's budget: the prompt is answerable again; nothing was sent meanwhile.
  await page.evaluate(() => {
    const ssh = (window as any).__e2e.ssh;
    ssh.worktrees = "ok";
    ssh.keepalive = "ok";
    ssh.connect = "ok";
  });
  await expect(card(page)).toBeVisible({ timeout: 15_000 });
  expect(await answers(page)).toEqual([]);
  expect(await typed(page)).toEqual([]);
  expect(errors).toEqual([]);
});
