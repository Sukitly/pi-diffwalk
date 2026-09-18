import type {
  ReviewUnitBoundary,
  ReviewUnitFeatures,
  ReviewUnitKind,
} from "../review/types.ts";

/**
 * A minimal client for TypeSafe's System One endpoint. The API is one POST
 * with a bearer token; the vendor SDK adds retries and typing over the same
 * call, which does not justify a runtime dependency here.
 *
 * Only the text handed to `judgeUnitFeatures` leaves the machine.
 */

export const TYPESAFE_API_KEY_ENV = "TYPESAFE_API_KEY";
export const TYPESAFE_DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const TYPESAFE_MODEL = "jev-latest";
export const TYPESAFE_TIMEOUT_MS = 8000;

export interface TypeSafeClientOptions {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export class TypeSafeError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "TypeSafeError";
    this.status = status;
  }
}

export interface UnitFeatureInput {
  /** Unified diff text of the unit, as built by renderUnitText. */
  readonly unitText: string;
  /** Text of the referenced code, when the agent named a reference. */
  readonly referenceText?: string;
}

const BOUNDARY_CRITERIA: Record<ReviewUnitBoundary, string> = {
  none: "Internal code only: no public surface, storage, permission, money, or external process is involved",
  "public-api":
    "Changes an exported function signature, type, protocol, or anything an external caller depends on",
  "persisted-format":
    "Changes how data is stored, serialized, migrated, or exchanged with another system",
  authorization:
    "Changes who may do what: permissions, roles, tokens, sessions, trust boundaries",
  money:
    "Changes prices, billing, payments, balances, quotas, or anything with a monetary consequence",
  "external-process":
    "Runs or configures shell commands, subprocesses, network calls, or third-party services",
};

const KIND_CRITERIA: Record<ReviewUnitKind, string> = {
  behavior: "Adds or changes what the program does at runtime",
  interface:
    "Changes a public type, signature, or contract without new runtime logic",
  test: "Adds or changes tests, fixtures, or test helpers",
  config:
    "Changes configuration, constants, build settings, or dependency lists",
  docs: "Changes comments, documentation, or user-facing text only",
  refactor:
    "Restructures existing code without changing what it does: renames, moves, extractions, formatting",
  generated: "Generated or vendored content that a tool produced",
};

/** The question set. Each asks one surface property; the policy combines them. */
export function buildUnitFeatureQuestions(hasReference: boolean) {
  return {
    changesBehavior: {
      type: "noul" as const,
      instructions:
        "Do the added or removed lines in `unit` change what the program does at runtime, as opposed to only how the code is written? Judge from the lines themselves.",
      criteria: {
        true: "A value, condition, call, order of operations, or side effect is different at runtime",
        false:
          "Only formatting, naming, comments, types, imports, test scaffolding, or a repetition of existing logic with different names",
      },
    },
    newControlFlow: {
      type: "noul" as const,
      instructions:
        "Do the added lines in `unit` introduce a branch, loop, early return, exception path, retry, or asynchronous boundary that the removed lines did not have?",
      criteria: {
        true: "A new if, switch, loop, try/catch, throw, return, await, callback, or promise chain appears",
        false: "No new control structure; the shape of the code is unchanged",
      },
    },
    touchesBoundary: {
      type: "choice" as const,
      instructions:
        "Which boundary, if any, do the changed lines in `unit` touch? Choose none unless the lines themselves show the boundary.",
      criteria: BOUNDARY_CRITERIA,
    },
    kind: {
      type: "choice" as const,
      instructions:
        "Which kind of change best describes the changed lines in `unit`?",
      criteria: KIND_CRITERIA,
    },
    ...(hasReference
      ? {
          mirrorsReference: {
            type: "noul" as const,
            instructions:
              "Do the added lines in `unit` have the same structure as `reference`, differing only in names, literals, or trivial ordering?",
            criteria: {
              true: "Same statements in the same shape; substituting identifiers and literals would turn one into the other",
              false:
                "Different structure, extra or missing steps, or logic that the reference does not contain",
            },
          },
        }
      : {}),
  };
}

export class TypeSafeClient {
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: TypeSafeClientOptions) {
    this.apiKey = options.apiKey;
    this.baseURL = (options.baseURL ?? TYPESAFE_DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? TYPESAFE_TIMEOUT_MS;
  }

  async judgeUnitFeatures(
    input: UnitFeatureInput,
    signal?: AbortSignal,
  ): Promise<ReviewUnitFeatures> {
    const hasReference = input.referenceText !== undefined;
    const body = {
      model: TYPESAFE_MODEL,
      state: {
        unit: input.unitText,
        ...(hasReference ? { reference: input.referenceText } : {}),
      },
      questions: buildUnitFeatureQuestions(hasReference),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseURL}/v1/systemone`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error: unknown) {
      throw new TypeSafeError(
        controller.signal.aborted
          ? `TypeSafe request timed out after ${this.timeoutMs} ms.`
          : `TypeSafe request failed: ${errorMessage(error)}`,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    if (!response.ok) {
      throw new TypeSafeError(
        `TypeSafe responded with HTTP ${response.status}.`,
        response.status,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error: unknown) {
      throw new TypeSafeError(
        `TypeSafe returned a non-JSON body: ${errorMessage(error)}`,
      );
    }
    return parseUnitFeatures(payload, hasReference);
  }
}

/** Reads the answers into features, rejecting any shape the policy cannot use. */
export function parseUnitFeatures(
  payload: unknown,
  hasReference: boolean,
): ReviewUnitFeatures {
  const answers = objectField(payload, "answers");
  const changesBehavior = noulField(answers, "changesBehavior");
  const newControlFlow = noulField(answers, "newControlFlow");
  const touchesBoundary = choiceField(
    answers,
    "touchesBoundary",
    Object.keys(BOUNDARY_CRITERIA) as ReviewUnitBoundary[],
  );
  const kind = choiceField(
    answers,
    "kind",
    Object.keys(KIND_CRITERIA) as ReviewUnitKind[],
  );
  return {
    changesBehavior,
    newControlFlow,
    touchesBoundary,
    kind,
    ...(hasReference
      ? { mirrorsReference: noulField(answers, "mirrorsReference") }
      : {}),
  };
}

function objectField(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    throw new TypeSafeError(`TypeSafe response is missing ${name}.`);
  }
  const field = (value as Record<string, unknown>)[name];
  if (field === null || typeof field !== "object") {
    throw new TypeSafeError(`TypeSafe response is missing ${name}.`);
  }
  return field as Record<string, unknown>;
}

function noulField(answers: Record<string, unknown>, name: string): number {
  const answer = objectField(answers, name);
  const value = answer.noul;
  if (typeof value !== "number" || !(value >= 0 && value <= 1)) {
    throw new TypeSafeError(`TypeSafe answer ${name} has no probability.`);
  }
  return value;
}

function choiceField<T extends string>(
  answers: Record<string, unknown>,
  name: string,
  options: readonly T[],
): { readonly choice: T; readonly confidence: number } {
  const answer = objectField(answers, name);
  const choice = answer.choice;
  const confidence = answer.confidence;
  if (typeof choice !== "string" || !options.includes(choice as T)) {
    throw new TypeSafeError(`TypeSafe answer ${name} names an unknown choice.`);
  }
  if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) {
    throw new TypeSafeError(`TypeSafe answer ${name} has no confidence.`);
  }
  return { choice: choice as T, confidence };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
