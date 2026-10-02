/** What each step was given lands on the report as `argument`: typed text, keys, expected values, and a secret by name only. */

import { describe, expect, it } from 'vitest';
import type { SemanticNode } from '../../src/engine/contract.ts';
import type { E2EConfig } from '../../src/index.ts';
import { createFakeEngine, FAKE_APP, FAKE_APP_URL } from '../helpers/fake-engine.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { runProject } from '../helpers/run-project.ts';

const PASSWORD = 'hunter2-argument-secret';

/** One secure textbox the fake engine's locate and read both resolve. */
const SECURE_TREE: SemanticNode = {
  ref: { id: 'root', revision: '' },
  role: 'root',
  children: [{ ref: { id: 'pw', revision: '' }, role: 'textbox', name: 'Password', states: { hidden: false, secure: true } }],
};

const SECURE_TYPED = `import { test } from 'e2e';

test('types plain text into a password field', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByLabel('Password').fill('marker-plain-into-secure');
});
`;

const SUITE = `import { test, credentials, expect } from 'e2e';

test('records arguments', async ({ app, screen }) => {
  await app.open('/');
  await screen.getByLabel('Username').fill('ada');
  await screen.getByLabel('Password').fill(credentials.user('member').password);
  await screen.getByLabel('Username').press('Enter');
  await expect(screen.getByRole('button')).toHaveCount(1);
});
`;

describe('step argument', () => {
  it(
    'records the typed text, the key, and the expected value, and a secret by its name',
    async () => {
      const fake = createFakeEngine({ artifacts: true });
      const config = {
        targets: [{ name: 'fake', platform: 'web', engine: fake.engine, app: FAKE_APP }],
        credentials: { member: { username: 'ada', password: PASSWORD } },
        evidence: false,
      } as E2EConfig;
      const { outcome, project } = await runProject({ 'tests/args.e2e.ts': SUITE }, { appUrl: FAKE_APP_URL, config });
      try {
        assertValidReport(outcome.report);
        const steps = outcome.report.run.results[0]!.attempts.at(-1)!.steps;
        expect(steps.map((step) => [step.api, step.argument])).toEqual([
          ['app.open', undefined],
          ['locator.fill', '"ada"'],
          ['locator.fill', '<secret:member.password>'],
          ['locator.press', 'Enter'],
          ['expect.toHaveCount', expect.stringContaining('1')],
        ]);
        expect(JSON.stringify(outcome.report)).not.toContain(PASSWORD);
      } finally {
        project.cleanup();
      }
    },
    60_000,
  );

  it(
    'withholds plain text typed into a secure field: the field, not the argument type, decides',
    async () => {
      const fake = createFakeEngine({ artifacts: true, tree: SECURE_TREE, locate: async () => [SECURE_TREE.children![0]!] });
      const config = { targets: [{ name: 'fake', platform: 'web', engine: fake.engine, app: FAKE_APP }], evidence: false } as E2EConfig;
      const { outcome, project } = await runProject({ 'tests/secure.e2e.ts': SECURE_TYPED }, { appUrl: FAKE_APP_URL, config });
      try {
        const fill = outcome.report.run.results[0]!.attempts.at(-1)!.steps.find((step) => step.api === 'locator.fill')!;
        expect(fill.status).toBe('passed');
        expect(fill.argument).toBe('<withheld>');
        expect(JSON.stringify(outcome.report)).not.toContain('marker-plain-into-secure');
      } finally {
        project.cleanup();
      }
    },
    60_000,
  );
});
