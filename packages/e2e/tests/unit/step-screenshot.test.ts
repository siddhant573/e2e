/** The frame after a step under `screenshot: 'every-step'`: when it is taken, attached, denied, or given up on. */

import { describe, expect, it } from 'vitest';
import type { OperationContext, TargetSession } from '../../src/engine/surface.ts';
import type { ArtifactSink } from '../../src/run/fixtures.ts';
import type { SessionSecrecy } from '../../src/run/secrecy.ts';
import { captureStepScreenshot } from '../../src/run/step-screenshot.ts';
import { StepRecorder } from '../../src/run/steps.ts';

/** A session whose only working part is `artifacts.screenshot`. */
function sessionWith(screenshot: (label: string | undefined) => Promise<string>): TargetSession {
  return { artifacts: { screenshot } } as unknown as TargetSession;
}

function sink(): ArtifactSink & { readonly registered: string[] } {
  const registered: string[] = [];
  return {
    dir: '/tmp/a',
    registered,
    register: (kind, relativePath) => {
      registered.push(`${kind}:${relativePath}`);
      return `art-${registered.length - 1}`;
    },
    link: () => 'link',
  };
}

const clean = { exposure: { withholdsPixels: false } } as unknown as SessionSecrecy;
const tainted = { exposure: { withholdsPixels: true } } as unknown as SessionSecrecy;
const operation = (signal: AbortSignal, timeoutMs: number): OperationContext =>
  ({ signal, timeoutMs, runId: 'r', attemptId: 'a', origin: 'test' }) as OperationContext;

/** Runs one step whose afterStep is the capture, and returns the step record and the sink. */
async function stepWith(api: string, session: TargetSession | null, secrecy: SessionSecrecy | undefined, timeoutMs = 1_000) {
  const artifacts = sink();
  const steps: StepRecorder = new StepRecorder('a', {
    afterStep: (record) =>
      captureStepScreenshot({ record, session, secrecy, steps, artifacts, operation, timeoutMs, signal: new AbortController().signal }),
  });
  await steps.run('app', api, 'x', async () => undefined);
  return { record: steps.all()[0]!, artifacts };
}

describe('captureStepScreenshot', () => {
  it('attaches one screenshot to the step, labelled by its index', async () => {
    const labels: (string | undefined)[] = [];
    const { record, artifacts } = await stepWith('screen.tap', sessionWith(async (label) => {
      labels.push(label);
      return 'screenshots/001-step-0.png';
    }), clean);
    expect(labels).toEqual(['step-0']);
    expect(artifacts.registered).toEqual(['screenshot:screenshots/001-step-0.png']);
    expect(record.artifacts).toEqual(['art-0']);
  });

  it('leaves steps that keep their own frame alone', async () => {
    for (const api of ['app.screenshot', 'agent.assert']) {
      const { artifacts } = await stepWith(api, sessionWith(async () => 'x.png'), clean);
      expect(artifacts.registered).toEqual([]);
    }
  });

  it('takes nothing after a secret fill, and says so with a policy event', async () => {
    let asked = 0;
    const { record, artifacts } = await stepWith('screen.tap', sessionWith(async () => {
      asked += 1;
      return 'x.png';
    }), tainted);
    expect(asked).toBe(0);
    expect(artifacts.registered).toEqual([]);
    expect(record.events).toMatchObject([{ kind: 'policy', name: 'step.screenshot', decision: 'denied', code: 'PIXEL_TAINTED' }]);
  });

  it('records a failed capture as an engine event and keeps the step passed', async () => {
    const { record } = await stepWith('screen.tap', sessionWith(async () => Promise.reject(new Error('page closed'))), clean);
    expect(record.status).toBe('passed');
    expect(record.events).toMatchObject([{ kind: 'engine', name: 'step.screenshot', status: 'failed' }]);
    expect(record.artifacts).toEqual([]);
  });

  it('gives up on a capture that never settles within its budget', async () => {
    const started = Date.now();
    const { record } = await stepWith('screen.tap', sessionWith(() => new Promise<string>(() => undefined)), clean, 50);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(record.status).toBe('passed');
    expect(record.events).toMatchObject([{ kind: 'engine', name: 'step.screenshot', status: 'failed' }]);
  });

  it('does nothing without a session', async () => {
    const { record } = await stepWith('screen.tap', null, undefined);
    expect(record.events).toEqual([]);
    expect(record.artifacts).toEqual([]);
  });
});
