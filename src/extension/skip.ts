import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getAgentDir,
  readStoredCredential,
} from "@earendil-works/pi-coding-agent";
import {
  decideSkip,
  gateReasons,
  renderUnitText,
  type SkipDecision,
} from "../review/skip.ts";
import { changedLineKey, resolvedSpanChangedLines } from "../review/span.ts";
import type {
  ReviewDelta,
  ReviewSnapshot,
  ReviewUnit,
  ReviewUnitFeatures,
  ReviewUnitVerdict,
} from "../review/types.ts";
import { parseRoutineReference } from "./routine.ts";
import {
  TYPESAFE_API_KEY_ENV,
  TypeSafeClient,
  type UnitFeatureInput,
} from "./typesafe.ts";

/**
 * Skipping units with a decision model is opt-in, because it sends the
 * changed lines of every unit to a second vendor. The switch lives in pi's
 * settings.json under `diffwalk.skip`. The key lives where pi keeps every
 * other API key, auth.json under the provider id `typesafe`, with the
 * environment variable as a fallback. Consent and credential stay separate:
 * a stored key does not enable skipping by itself.
 */

export const SKIP_SETTING_KEY = "skip";
export const SKIP_SETTING_VALUE = "typesafe";
export const TYPESAFE_AUTH_PROVIDER_ID = "typesafe";

export type SkipConfiguration =
  | { readonly status: "disabled" }
  | {
      readonly status: "enabled";
      readonly apiKey: string;
      readonly baseURL?: string;
    }
  | { readonly status: "misconfigured"; readonly reason: string };

export async function readSkipConfiguration(
  agentDir = getAgentDir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<SkipConfiguration> {
  return readSkipConfigurationFrom(agentDir, env, () =>
    readStoredApiKey(agentDir),
  );
}

/** The `typesafe` api-key credential from pi's auth.json, if any. */
function readStoredApiKey(agentDir: string): string | undefined {
  const credential = readStoredCredential(
    TYPESAFE_AUTH_PROVIDER_ID,
    join(agentDir, "auth.json"),
  );
  if (credential?.type !== "api_key") return undefined;
  const key = credential.key;
  return key === undefined || key.trim().length === 0 ? undefined : key;
}

export async function readSkipConfigurationFrom(
  agentDir: string,
  env: NodeJS.ProcessEnv,
  storedApiKey: () => string | undefined,
): Promise<SkipConfiguration> {
  let raw: string;
  try {
    raw = await readFile(join(agentDir, "settings.json"), "utf8");
  } catch {
    return { status: "disabled" };
  }
  let settings: unknown;
  try {
    settings = JSON.parse(raw);
  } catch {
    return { status: "disabled" };
  }
  const diffwalk =
    settings !== null && typeof settings === "object"
      ? (settings as Record<string, unknown>).diffwalk
      : undefined;
  const setting =
    diffwalk !== null && typeof diffwalk === "object"
      ? (diffwalk as Record<string, unknown>)[SKIP_SETTING_KEY]
      : undefined;
  if (setting === undefined) return { status: "disabled" };
  if (setting !== SKIP_SETTING_VALUE) {
    return {
      status: "misconfigured",
      reason: `settings.json diffwalk.${SKIP_SETTING_KEY} is ${JSON.stringify(setting)}; the only supported value is ${JSON.stringify(SKIP_SETTING_VALUE)}.`,
    };
  }
  const envKey = env[TYPESAFE_API_KEY_ENV];
  const apiKey =
    storedApiKey() ??
    (envKey === undefined || envKey.trim().length === 0 ? undefined : envKey);
  if (apiKey === undefined) {
    return {
      status: "misconfigured",
      reason: `settings.json enables diffwalk.${SKIP_SETTING_KEY} but auth.json has no ${JSON.stringify(TYPESAFE_AUTH_PROVIDER_ID)} api_key credential and ${TYPESAFE_API_KEY_ENV} is not set.`,
    };
  }
  const baseURL = env.TYPESAFE_BASE_URL;
  return {
    status: "enabled",
    apiKey,
    ...(baseURL === undefined || baseURL.length === 0 ? {} : { baseURL }),
  };
}

/** What the session needs from a judge; the client is injected for tests. */
export type UnitFeatureJudge = (
  input: UnitFeatureInput,
  signal?: AbortSignal,
) => Promise<ReviewUnitFeatures>;

export function createUnitFeatureJudge(
  configuration: Extract<SkipConfiguration, { status: "enabled" }>,
): UnitFeatureJudge {
  const client = new TypeSafeClient({
    apiKey: configuration.apiKey,
    ...(configuration.baseURL === undefined
      ? {}
      : { baseURL: configuration.baseURL }),
  });
  return (input, signal) => client.judgeUnitFeatures(input, signal);
}

/** Text of the referenced lines, read from the worktree; undefined when unreadable. */
export type ReferenceTextReader = (
  repositoryRoot: string,
  reference: string,
) => Promise<string | undefined>;

export const REFERENCE_TEXT_MAX_LINES = 80;

export const readReferenceText: ReferenceTextReader = async (
  repositoryRoot,
  reference,
) => {
  const parsed = parseRoutineReference(reference);
  if (parsed === undefined) return undefined;
  let content: string;
  try {
    content = await readFile(join(repositoryRoot, parsed.path), "utf8");
  } catch {
    return undefined;
  }
  const lines = content.split("\n");
  const start = parsed.startLine ?? 1;
  const end = Math.min(
    parsed.endLine ?? start + REFERENCE_TEXT_MAX_LINES - 1,
    start + REFERENCE_TEXT_MAX_LINES - 1,
    lines.length,
  );
  if (start > lines.length) return undefined;
  return lines.slice(start - 1, end).join("\n");
};

export interface JudgeUnitInput {
  readonly snapshot: ReviewSnapshot;
  readonly delta: ReviewDelta;
  readonly unit: ReviewUnit;
  readonly judge: UnitFeatureJudge;
  readonly readReference: ReferenceTextReader;
  readonly signal?: AbortSignal;
}

/**
 * Judges one accepted unit and applies the skip policy. Throws only for
 * transport and protocol failures; the caller decides how to degrade.
 */
export async function judgeUnit(input: JudgeUnitInput): Promise<SkipDecision> {
  const { snapshot, delta, unit } = input;
  const unresolved = new Set(
    delta.lines
      .filter(
        (requirement) =>
          requirement.type === "needs-review" &&
          requirement.reason === "unresolved-comment",
      )
      .map((requirement) => changedLineKey(requirement)),
  );
  const hasUnresolvedComment = unit.spans.some((span) =>
    resolvedSpanChangedLines(snapshot, span).some((line) =>
      unresolved.has(changedLineKey(line)),
    ),
  );
  const gates = { hasUnresolvedComment };
  const gated = gateReasons(gates);
  if (gated.length > 0) return { review: true, reasons: gated };
  const referenceText =
    unit.routine === undefined
      ? undefined
      : await input.readReference(
          snapshot.repositoryRoot,
          unit.routine.reference,
        );
  const features = await input.judge(
    {
      unitText: renderUnitText(snapshot, unit),
      ...(referenceText === undefined ? {} : { referenceText }),
    },
    input.signal,
  );
  return decideSkip(features, gates);
}

export function verdictOf(decision: SkipDecision): ReviewUnitVerdict {
  return decision.review
    ? { outcome: "review" }
    : {
        outcome: "skip",
        source: "typesafe",
        reasons: decision.reasons,
        features: decision.features,
      };
}
