import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUnitFeatureQuestions,
  parseUnitFeatures,
  TYPESAFE_MODEL,
  TypeSafeClient,
  TypeSafeError,
} from "../../src/extension/typesafe.ts";

const answers = {
  changesBehavior: { type: "noul", noul: 0.12 },
  newControlFlow: { type: "noul", noul: 0.03 },
  touchesBoundary: {
    type: "choice",
    choice: "none",
    confidence: 0.91,
    probabilities: { none: 0.95 },
  },
  kind: {
    type: "choice",
    choice: "refactor",
    confidence: 0.8,
    probabilities: { refactor: 0.85 },
  },
};

function fakeFetch(
  handler: (input: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init))) as typeof fetch;
}

test("posts the unit text and the question set with a bearer token", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = new TypeSafeClient({
    apiKey: "sk-test",
    baseURL: "https://example.test/",
    fetch: fakeFetch((url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ answers }), { status: 200 });
    }),
  });

  const features = await client.judgeUnitFeatures({ unitText: "+x" });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://example.test/v1/systemone");
  const headers = calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer sk-test");
  const body = JSON.parse(String(calls[0]?.init?.body)) as {
    model: string;
    state: Record<string, unknown>;
    questions: Record<string, unknown>;
  };
  assert.equal(body.model, TYPESAFE_MODEL);
  assert.deepEqual(body.state, { unit: "+x" });
  assert.deepEqual(Object.keys(body.questions).sort(), [
    "changesBehavior",
    "kind",
    "newControlFlow",
    "touchesBoundary",
  ]);
  assert.deepEqual(features, {
    changesBehavior: 0.12,
    newControlFlow: 0.03,
    touchesBoundary: { choice: "none", confidence: 0.91 },
    kind: { choice: "refactor", confidence: 0.8 },
  });
});

test("adds the reference to the state and asks mirrorsReference only when given", async () => {
  let body:
    | { state: Record<string, unknown>; questions: Record<string, unknown> }
    | undefined;
  const client = new TypeSafeClient({
    apiKey: "k",
    fetch: fakeFetch((_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          answers: {
            ...answers,
            mirrorsReference: { type: "noul", noul: 0.88 },
          },
        }),
      );
    }),
  });

  const features = await client.judgeUnitFeatures({
    unitText: "+x",
    referenceText: "+y",
  });

  assert.deepEqual(body?.state, { unit: "+x", reference: "+y" });
  assert.ok("mirrorsReference" in (body?.questions ?? {}));
  assert.equal(features.mirrorsReference, 0.88);
  assert.equal("mirrorsReference" in buildUnitFeatureQuestions(false), false);
});

test("reports HTTP failures, timeouts, and malformed answers as TypeSafeError", async () => {
  const failing = new TypeSafeClient({
    apiKey: "k",
    fetch: fakeFetch(() => new Response("nope", { status: 429 })),
  });
  await assert.rejects(
    failing.judgeUnitFeatures({ unitText: "+x" }),
    (error: unknown) => {
      assert.ok(error instanceof TypeSafeError);
      assert.equal(error.status, 429);
      return true;
    },
  );

  const slow = new TypeSafeClient({
    apiKey: "k",
    timeoutMs: 5,
    fetch: fakeFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    ),
  });
  await assert.rejects(
    slow.judgeUnitFeatures({ unitText: "+x" }),
    /timed out after 5 ms/,
  );

  const malformed = new TypeSafeClient({
    apiKey: "k",
    fetch: fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            answers: { ...answers, kind: { choice: "poetry", confidence: 1 } },
          }),
        ),
    ),
  });
  await assert.rejects(
    malformed.judgeUnitFeatures({ unitText: "+x" }),
    /kind names an unknown choice/,
  );
});

test("parseUnitFeatures rejects out-of-range probabilities and missing fields", () => {
  assert.throws(
    () =>
      parseUnitFeatures(
        { answers: { ...answers, changesBehavior: { noul: 1.2 } } },
        false,
      ),
    /changesBehavior has no probability/,
  );
  assert.throws(
    () =>
      parseUnitFeatures({ answers: { changesBehavior: { noul: 0.1 } } }, false),
    /missing newControlFlow/,
  );
  assert.throws(
    () => parseUnitFeatures({ answers }, true),
    /missing mirrorsReference/,
  );
});
