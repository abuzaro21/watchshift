import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const state = async (page: Page) => (await page.request.get('/api/state')).json();
const card = (page: Page, name: string) => page.getByRole('article', { name: new RegExp(`^${name},`) });

async function start(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /start live demo/i }).click();
  await expect(page.getByRole('region', { name: 'Agent fleet' })).toBeVisible();
}

test('operator approves, pauses, resumes, is limited by role, and exports a verifiable audit', async ({ page }) => {
  await start(page);
  const queue = page.getByRole('region', { name: 'Approval queue' });
  await queue.getByRole('button', { name: 'Approve' }).first().click({ timeout: 30_000 });
  await expect.poll(async () => (await state(page)).approvals.recent.some((a: { status: string }) => a.status === 'granted' || a.status === 'consumed'), { timeout: 20_000 }).toBe(true);

  await page.getByLabel('Operator role').selectOption('cx-lead');
  await card(page, 'SupportOps').getByRole('button', { name: 'Pause' }).click();
  await expect(card(page, 'SupportOps')).toHaveAttribute('aria-label', /Paused/);
  await card(page, 'SupportOps').getByRole('button', { name: 'Resume' }).click();
  await expect(card(page, 'SupportOps')).not.toHaveAttribute('aria-label', /Paused/);
  await expect(card(page, 'ReleaseOps').getByRole('button', { name: 'Kill' })).toBeDisabled();

  await page.getByLabel('Operator role').selectOption('auditor');
  for (const n of ['ReleaseOps', 'SupportOps', 'InfraOps']) await expect(card(page, n).getByRole('button', { name: 'Kill' })).toBeDisabled();
  expect((await page.request.post('/api/command', { data: { type: 'kill', agent: 'releaseops', as: 'auditor' } })).status()).toBe(403);

  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Export audit JSON' }).click()]);
  const audit = JSON.parse(readFileSync((await dl.path())!, 'utf8'));
  expect(audit.events.length).toBeGreaterThan(10);
  expect(audit.events.at(-1).hash).toMatch(/^[0-9a-f]{64}$/);
});

test('rogue agent is blocked and quarantined, killed, stale retry is fenced, nothing leaves, replay explains it', async ({ page }) => {
  await start(page);
  const trigger = page.getByRole('button', { name: 'Trigger rogue agent' });
  await expect(trigger).toBeEnabled({ timeout: 20_000 });
  await trigger.click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Trigger rogue agent' }).click();

  const banner = page.getByRole('alert', { name: 'Rogue agent contained' });
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await expect(banner).toContainText('BLOCKED before any effect');
  await expect(card(page, 'InfraOps')).toHaveAttribute('aria-label', /Quarantined/);

  await banner.getByRole('button', { name: 'Kill InfraOps' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Kill InfraOps' }).click();
  await expect(card(page, 'InfraOps')).toHaveAttribute('aria-label', /Killed/);
  await banner.getByRole('button', { name: /stale worker retries/ }).click();
  await expect.poll(async () => (await state(page)).scenario.staleRetried, { timeout: 10_000 }).toBeTruthy();

  const s = await state(page);
  expect(s.world.externalSinkRows).toBe(0);
  expect(s.agents.find((a: { id: string }) => a.id === 'infraops').status).toBe('KILLED');

  await banner.getByRole('button', { name: 'Replay incident' }).click();
  const dialog = page.getByRole('dialog', { name: 'Decision replay' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(/chain/i);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
