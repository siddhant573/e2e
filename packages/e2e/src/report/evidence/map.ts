/**
 * The run as an evidence pack, in memory: what each file of the `.evidence`
 * layout holds, read from the finished report-1 document. No I/O here;
 * `write.ts` puts the plan on disk.
 *
 * Evidence separates `failed`, the product was wrong, from `broken`, the
 * check could not decide. Only `ASSERTION_FAILED` says the product was wrong;
 * every other failure (an inconclusive judgment, a locator that matched
 * nothing, a timeout, an interrupt) is broken.
 */

import path from 'node:path';
import type { ArtifactRecord, FailureEvidence } from '../../run/records.ts';
import type { Report1Document, ReportError, ReportResult, ReportStep } from '../build.ts';

/** The evidence contract version this producer writes. */
const EVIDENCE_VERSION = '0.1';
/** The one error code that says the product, not the check, was wrong. */
const PRODUCT_DEFECT_CODES: ReadonlySet<string> = new Set(['ASSERTION_FAILED']);
/** Redaction levels whose files are safe to copy into a pack a reader may share. */
const SHAREABLE: ReadonlySet<string> = new Set(['complete', 'not-required']);
const MAX_SLUG_LENGTH = 48;

type Verdict = 'passed' | 'failed' | 'broken' | 'skipped';
type Json = Record<string, unknown>;

export interface PackPlan {
  /** `run.yaml`, with `status: running`; `finalize` closes it. */
  readonly run: Json;
  /** `coverage/e2e-summary.json`: the run's counts, usage, and limits. */
  readonly coverage: Json;
  readonly tests: readonly TestPlan[];
}

export interface TestPlan {
  /** The folder under `tests/`, also `result.yaml`'s `test`. */
  readonly dir: string;
  /** The test file, project-relative, copied as the opaque definition under `name`. */
  readonly definition: { readonly source: string; readonly name: string };
  readonly result: Json;
  readonly steps: readonly StepPlan[];
  readonly logs: readonly LogPlan[];
}

export interface StepPlan {
  /** `<ordinal>-<id>` under `steps/`. */
  readonly folder: string;
  /** `step.json`: the report's step record without its model turns. */
  readonly record: Json;
  /** The frame to copy as `screenshot.<ext>`, relative to the artifacts root. */
  readonly screenshot?: string;
  /** The failure's screen text to copy as `screen.txt`, relative to the artifacts root. */
  readonly screen?: string;
  /** `failure.yaml`, on the step a failure landed on. */
  readonly failure?: Json;
}

export interface LogPlan {
  readonly name: string;
  /** The file under `logs/`. */
  readonly file: string;
  readonly format: string;
  /** An artifact to copy, relative to the artifacts root; else `content` is written. */
  readonly source?: string;
  readonly content?: string;
}

/** What one result ran, wherever the report keeps it: its own last attempt, or its member record in a serial group's. */
interface Execution {
  readonly attemptIndex: number;
  readonly steps: readonly ReportStep[];
  readonly artifacts: readonly ArtifactRecord[];
  readonly error: ReportError | undefined;
  readonly failure: FailureEvidence | undefined;
}

/** Plans the pack for a finished run: one test folder per selected result. */
export function planPack(report: Report1Document): PackPlan {
  const run = report.run;
  const tests = run.results.filter((result) => result.selected).map((result) => planTest(report, result));
  return {
    run: {
      evidence: EVIDENCE_VERSION,
      run_id: run.id,
      status: 'running',
      started: run.startedAt,
      title: run.project.id,
      environment: runEnvironment(report),
      metrics: runMetrics(report),
    },
    coverage: { summary: run.summary, usage: run.usage, limits: run.limits },
    tests,
  };
}

function runEnvironment(report: Report1Document): Json {
  const run = report.run;
  const models = new Set<string>();
  for (const result of run.results) {
    for (const attempt of result.attempts) {
      for (const step of attempt.steps) if (step.model !== undefined) models.add(`${step.model.provider}/${step.model.model}`);
    }
  }
  return {
    producer: { name: run.runner.name, version: run.runner.version },
    surfaces: [...new Set(run.targets.map((target) => target.platform))],
    os: run.environment.os,
    arch: run.environment.arch,
    runtime: run.environment.runtime,
    ...(run.environment.ci ? { ci: { detected: true } } : {}),
    ...(models.size === 0 ? {} : { model: [...models].join(', ') }),
    ...(run.vcs === undefined ? {} : { vcs: run.vcs }),
  };
}

function runMetrics(report: Report1Document): Json {
  const { summary, usage } = report.run;
  return {
    tests_executed: { value: summary.executed, type: 'count' },
    model_tokens: { value: usage.modelTokens, type: 'count' },
    artifact_bytes: { value: usage.artifactBytes, type: 'bytes', unit: 'B' },
    ...(usage.estimatedCostUsd === undefined ? {} : { estimated_cost_usd: { value: usage.estimatedCostUsd, type: 'currency', unit: 'USD' } }),
  };
}

function planTest(report: Report1Document, result: ReportResult): TestPlan {
  const dir = testDir(result);
  const execution = executionOf(report, result);
  const artifacts = new Map((execution?.artifacts ?? []).map((artifact) => [artifact.id, artifact]));
  const failingIndex = execution === undefined ? -1 : failingStepIndex(execution);
  const steps = (execution?.steps ?? []).map((step) => planStep(step, execution!, artifacts, step.index === failingIndex));
  return {
    dir,
    definition: { source: result.file, name: path.posix.basename(result.file) },
    result: {
      evidence: EVIDENCE_VERSION,
      test: dir,
      status: resultVerdict(result, execution),
      definition: { path: path.posix.basename(result.file) },
      external_id: { e2e_test_id: result.testId, e2e_result_id: result.id, target: result.targetId, agent: result.agent, repeat: result.repeat },
      duration_ms: result.attempts.reduce((total, attempt) => total + attempt.durationMs, 0),
      attempts: result.attempts.map((attempt) => ({ status: attemptVerdict(attempt.status, attempt.error), duration_ms: attempt.durationMs })),
      ...(result.status === 'flaky' ? { flaky: true } : {}),
      ...(result.tags.length === 0 ? {} : { tags: result.tags }),
      steps: steps.map((entry) => entry.summary),
    },
    steps: steps.map((entry) => entry.plan),
    logs: logsFor(execution, artifacts),
  };
}

/** `<slug of the title>-<first 8 hex of the result id>`: readable, path-safe, and distinct across targets, agents, and repeats. */
function testDir(result: ReportResult): string {
  const slug = result.titlePath
    .join(' ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
  const id = result.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  return `${slug === '' ? 'test' : slug}-${id}`;
}

function executionOf(report: Report1Document, result: ReportResult): Execution | undefined {
  if (result.serialGroupId !== undefined) {
    const attempt = report.run.serialGroups.find((group) => group.id === result.serialGroupId)?.attempts.at(-1);
    const member = attempt?.members.find((candidate) => candidate.testId === result.testId);
    if (attempt === undefined || member === undefined) return undefined;
    return { attemptIndex: attempt.index, steps: member.steps, artifacts: attempt.artifacts, error: member.error, failure: member.failure };
  }
  const attempt = result.attempts.at(-1);
  if (attempt === undefined) return undefined;
  return { attemptIndex: attempt.index, steps: attempt.steps, artifacts: attempt.artifacts, error: attempt.error, failure: attempt.failure };
}

/** The step the failure landed on: the last one that did not pass. */
function failingStepIndex(execution: Execution): number {
  if (execution.error === undefined && execution.failure === undefined) return -1;
  return execution.steps.findLast((step) => step.status !== 'passed')?.index ?? -1;
}

function errorVerdict(error: ReportError | undefined): Verdict {
  return error !== undefined && PRODUCT_DEFECT_CODES.has(error.code) ? 'failed' : 'broken';
}

function resultVerdict(result: ReportResult, execution: Execution | undefined): Verdict {
  if (result.status === 'passed' || result.status === 'flaky') return 'passed';
  if (result.status === 'skipped') return 'skipped';
  return errorVerdict(execution?.error);
}

function attemptVerdict(status: string, error: ReportError | undefined): Verdict {
  if (status === 'passed') return 'passed';
  if (status === 'skipped') return 'skipped';
  return errorVerdict(error);
}

function stepVerdict(step: ReportStep): Verdict {
  if (step.status === 'passed') return 'passed';
  if (step.status === 'failed') return errorVerdict(step.error);
  return 'broken';
}

/** What the step claimed against what the app showed: a matcher's details, or an assertion's instruction against the judgment. */
function expectation(step: ReportStep, error: ReportError | undefined): { expected: string; actual: string } | undefined {
  if (step.api === 'agent.assert' && step.status !== 'passed' && step.explanation !== undefined) {
    return { expected: step.label, actual: step.explanation };
  }
  const details = error?.details as { expected?: unknown; observed?: unknown } | undefined;
  if (details?.expected === undefined) return undefined;
  return { expected: String(details.expected), actual: details.observed === undefined ? '' : String(details.observed) };
}

function shareable(artifact: ArtifactRecord | undefined): artifact is ArtifactRecord & { path: string } {
  return artifact !== undefined && artifact.path !== undefined && SHAREABLE.has(artifact.redaction);
}

function planStep(
  step: ReportStep,
  execution: Execution,
  artifacts: ReadonlyMap<string, ArtifactRecord>,
  failing: boolean,
): { summary: Json; plan: StepPlan } {
  const id = `${execution.attemptIndex}-${step.index}`;
  const ordinal = step.index + 1;
  const folder = `${ordinal}-${id}`;
  const status = stepVerdict(step);
  const error = step.error ?? (failing ? execution.error : undefined);
  const claim = expectation(step, error);
  const summary: Json = {
    id,
    ordinal,
    status,
    kind: step.api,
    ...(step.label === '' ? {} : { label: step.label }),
    duration_ms: step.durationMs,
    ...(step.cache === undefined ? {} : { cache: step.cache.mode }),
    ...(claim === undefined || status === 'passed' ? {} : claim),
  };

  let screenshot = step.artifacts.map((artifactId) => artifacts.get(artifactId)).find((artifact) => artifact?.kind === 'screenshot' && shareable(artifact))?.path;
  let screen: string | undefined;
  let failure: Json | undefined;
  if (failing && error !== undefined) {
    const frame = execution.failure?.screenshot === undefined ? undefined : artifacts.get(execution.failure.screenshot);
    if (screenshot === undefined && shareable(frame)) screenshot = frame.path;
    const screenText = execution.failure?.screen === undefined ? undefined : artifacts.get(execution.failure.screen);
    if (shareable(screenText)) screen = screenText.path;
    const locator = (error.details as { locator?: unknown } | undefined)?.locator;
    const pageState: Json = {
      ...(execution.failure?.url === undefined ? {} : { url: execution.failure.url }),
      ...(screenshot === undefined ? {} : { screenshot: `steps/${folder}/screenshot${path.posix.extname(screenshot)}` }),
      ...(screen === undefined ? {} : { a11y: `steps/${folder}/screen.txt` }),
    };
    failure = {
      step: id,
      status: status === 'passed' ? errorVerdict(error) : status,
      title: step.label === '' ? step.api : step.label,
      error: { message: error.message, code: error.code },
      ...claim,
      ...(typeof locator === 'string' ? { locator_context: { locator } } : {}),
      ...(Object.keys(pageState).length === 0 ? {} : { page_state: pageState }),
    };
  }

  const { turns: _turns, ...record } = step;
  return {
    summary,
    plan: {
      folder,
      record: record as Json,
      ...(screenshot === undefined ? {} : { screenshot }),
      ...(screen === undefined ? {} : { screen }),
      ...(failure === undefined ? {} : { failure }),
    },
  };
}

/** The step stream, the agent's turns when it took any, and every trace whose redaction allows sharing. */
function logsFor(execution: Execution | undefined, artifacts: ReadonlyMap<string, ArtifactRecord>): LogPlan[] {
  const steps = execution?.steps ?? [];
  const logs: LogPlan[] = [
    {
      name: 'steps',
      file: 'steps.ndjson',
      format: 'ndjson',
      content: lines(steps.map((step) => ({ index: step.index, api: step.api, label: step.label, status: step.status, events: step.events }))),
    },
  ];
  const turns = steps.filter((step) => step.turns !== undefined && step.turns.length > 0);
  if (turns.length > 0) {
    logs.push({
      name: 'agent',
      file: 'agent.ndjson',
      format: 'ndjson',
      content: lines(turns.map((step) => ({ index: step.index, api: step.api, label: step.label, turns: step.turns }))),
    });
  }
  const traces = [...artifacts.values()].filter((artifact) => artifact.kind === 'trace' && shareable(artifact));
  traces.forEach((trace, index) => {
    logs.push({
      name: index === 0 ? 'trace' : `trace-${index + 1}`,
      file: index === 0 ? 'trace.zip' : `trace-${index + 1}.zip`,
      format: 'playwright-trace',
      source: trace.path!,
    });
  });
  return logs;
}

function lines(records: readonly unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + (records.length === 0 ? '' : '\n');
}
