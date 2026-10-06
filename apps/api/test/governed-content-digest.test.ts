import { Pool } from "pg";
import { DatabaseSync } from "node:sqlite";
import { initializeGovernedSqliteFunctions } from "../src/storage/sqlite/governed-functions.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@rubrist/db";
import {
  canonicalGovernedJsonV1,
  governedContentV1CanonicalBytes,
  governedContentV1Digest,
  verifyGovernedContentV1Digest
} from "../src/lib/governed-content-digest.js";
import { governedReviewInstructionDigest } from "../src/lib/governed-review.js";
import { openPostgresTestDatabase } from "./helpers/postgres.js";

describe("governed content digest v1", () => {
  it("uses UTF-16 object-key order and exponent-free JSON numbers", () => {
    expect(canonicalGovernedJsonV1({
      "\ue000": "bmp",
      "\u{10000}": "astral",
      "2": "two",
      "10": "ten",
      nested: [1e21, 1e-7, -0]
    })).toBe(
      `{"10":"ten","2":"two","nested":[1000000000000000000000,0.0000001,0],"\u{10000}":"astral","\ue000":"bmp"}`
    );
  });

  it("exposes exact digest bytes and an independent verifier", () => {
    const content = { answer: true, input: { text: "line\nquote\"slash\\emoji😀" } };
    const bytes = governedContentV1CanonicalBytes("governed-example/v1", content);
    expect(bytes.toString("utf8")).toBe(
      `{"content":{"answer":true,"input":{"text":"line\\nquote\\\"slash\\\\emoji😀"}},"kind":"governed-example/v1"}`
    );
    const digest = governedContentV1Digest("governed-example/v1", content);
    expect(digest).toBe("sha256:748b0d3ab55287da8126fb40519a82ff3714f3186e44799c9934c05c0475188b");
    expect(() => verifyGovernedContentV1Digest("governed-example/v1", content, digest)).not.toThrow();
    expect(() => verifyGovernedContentV1Digest("governed-example/v1", content, `sha256:${"0".repeat(64)}`))
      .toThrow("governed content digest mismatch");
  });

  it("rejects values PostgreSQL JSONB cannot represent", () => {
    expect(() => canonicalGovernedJsonV1("nul\u0000value")).toThrow("cannot encode NUL");
    expect(() => canonicalGovernedJsonV1("unpaired\ud800")).toThrow("unpaired UTF-16 surrogate");
    expect(() => canonicalGovernedJsonV1(Number.POSITIVE_INFINITY)).toThrow("non-finite number");
    expect(() => canonicalGovernedJsonV1({ absent: undefined })).toThrow("cannot encode undefined");
    expect(() => canonicalGovernedJsonV1(new Array(1))).toThrow("cannot encode a sparse array");
    expect(() => canonicalGovernedJsonV1(new Date(0))).toThrow("only plain JSON objects");
  });
});

const databaseUrl = process.env.PG_SMOKE_DATABASE_URL;
if ((process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") && !databaseUrl) {
  throw new Error("CI must set PG_SMOKE_DATABASE_URL; governed digest PostgreSQL tests may not be skipped.");
}
const runPg = databaseUrl ? describe : describe.skip;

runPg("governed content digest JavaScript/PostgreSQL interoperability", () => {
  let pool: Pool;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, cleanup } = await openPostgresTestDatabase("governed_digest"));
    await runMigrations(pool);
  }, 60_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("matches independent golden vectors across JavaScript, PostgreSQL and SQLite", async () => {
    const vectors: unknown[] = [
      null,
      true,
      false,
      "plain / \"quoted\" \\ line\n tab\t unicode é 中 😀 \u2028",
      [],
      {},
      [null, { retained: "yes" }],
      {
        "": "empty key",
        "\ue000": "BMP private-use sorts after an astral surrogate pair",
        "\u{10000}": "astral",
        "10": "ten",
        "2": "two",
        nested: { z: [3, { b: 2, a: 1 }], a: "first" }
      },
      {
        numbers: [
          -0,
          0,
          0.1,
          1e21,
          1e-7,
          -1.25e30,
          Number.MAX_SAFE_INTEGER,
          Number.MAX_VALUE,
          Number.MIN_VALUE,
          1.2345678901234567
        ]
      }
    ];

    const sqlite = new DatabaseSync(":memory:");
    initializeGovernedSqliteFunctions(sqlite);
    try {
    for (const [index, content] of vectors.entries()) {
      const kind = `governed-golden-${index}/v1`;
      const row = (await pool.query(
        `select governed_canonical_json_v1(jsonb_build_object('content',$1::jsonb,'kind',$2::text)) as canonical,
                governed_content_v1_digest($2::text,$1::jsonb) as digest,
                analysis_sha256_v1($1::jsonb) as analysis_digest`,
        [JSON.stringify(content), kind]
      )).rows[0];
      expect(String(row.canonical)).toBe(governedContentV1CanonicalBytes(kind, content).toString("utf8"));
      expect(String(row.digest)).toBe(governedContentV1Digest(kind, content));
      const actual = sqlite.prepare("SELECT governed_canonical_json_v1(?) canonical, governed_content_v1_digest(?,?) digest, analysis_sha256_v1(?) analysis_digest").get(JSON.stringify({ content, kind }), kind, JSON.stringify(content), JSON.stringify(content));
      expect(actual?.canonical).toBe(row.canonical);
      expect(actual?.digest).toBe(row.digest);
      expect(actual?.analysis_digest).toBe(row.analysis_digest);
    }
    } finally { sqlite.close(); }
  });

  it("preserves raw SQL decimal precision rather than rounding before hashing", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      initializeGovernedSqliteFunctions(sqlite);
      for (const source of ["9007199254740993", "0.123456789012345678901", "-1e-400", "1e999", "1.23000", "-0.000", '{"x":9007199254740993,"x":0.123456789012345678901,"nested":[1e-400,1.2300,1e21]}']) {
        const expected = (await pool.query("SELECT governed_canonical_json_v1($1::jsonb) canonical, governed_content_v1_digest('raw/v1',$1::jsonb) digest, analysis_sha256_v1($1::jsonb) analysis_digest", [source])).rows[0];
        const actual = sqlite.prepare("SELECT governed_canonical_json_v1(?) canonical, governed_content_v1_digest('raw/v1',?) digest, analysis_sha256_v1(?) analysis_digest").get(source,source,source);
        expect(actual).toEqual(expected);
      }
      for (const source of ['0e99999999999', '1.0000e-16383', '{"x":"\\u0000","x":"valid"}', '{"x":"\\ud800","x":"valid"}']) {
        await expect(pool.query('SELECT governed_canonical_json_v1($1::jsonb)', [source])).rejects.toThrow();
        expect(() => sqlite.prepare('SELECT governed_canonical_json_v1(?)').get(source)).toThrow();
      }
      const exact = sqlite.prepare("SELECT analysis_sha256_v1(?) digest");
      expect(exact.get('9007199254740993')?.digest).not.toBe(exact.get('9007199254740992')?.digest);
      expect(exact.get('-1e-400')?.digest).not.toBe(exact.get('0')?.digest);
    } finally { sqlite.close(); }
  });

  it("matches PostgreSQL JSONB byte bounds including spaces and decimal scale", async () => {
    const sqlite=new DatabaseSync(":memory:");
    try {
      initializeGovernedSqliteFunctions(sqlite);
      for(const source of ['null','{}','[]','1.23000','-0.000','1.2300e3','1e999','1e-400','9007199254740993','{"a":1.2300,"a":-0.00,"z":[true,false,null,"😀\\n",{"v":"中"}]}','{"text":"'+ '😀'.repeat(65536)+'"}']) {
        const expected=(await pool.query('SELECT octet_length(($1::jsonb)::text) n',[source])).rows[0].n;
        expect(sqlite.prepare('SELECT governed_jsonb_octets_v1(?) n').get(source)?.n).toBe(expected);
      }
      const bytes=Buffer.from([0,255,128,10,34]);
      const expected=(await pool.query('SELECT governed_bytes_v1_digest($1::bytea) digest',[bytes])).rows[0].digest;
      expect(sqlite.prepare('SELECT governed_bytes_v1_digest(?) digest').get(bytes)?.digest).toBe(expected);
      expect(()=>sqlite.prepare('SELECT governed_bytes_v1_digest(?)').get('not a BLOB')).toThrow();
    } finally { sqlite.close(); }
  });

  it("retains governed sampling numeric precision and PostgreSQL positivity bounds", async () => {
    const sqlite=new DatabaseSync(":memory:");
    try {
      initializeGovernedSqliteFunctions(sqlite);
      for(const source of ['0','-0.0','1','0.3333333333333333','1.000000000000000000001','-1e-400','1e-400','1e999']) {
        const expected=(await pool.query('SELECT ($1::numeric>0 AND $1::numeric<=1)::int probability,($1::numeric>0)::int weight',[source])).rows[0];
        expect(sqlite.prepare('SELECT governed_positive_numeric_v1(?,1) probability,governed_positive_numeric_v1(?,0) weight').get(source,source)).toEqual(expected);
        const expectedDigest=(await pool.query("SELECT governed_content_v1_digest('sampling/v1',jsonb_build_object('probability',$1::numeric)) digest",[source])).rows[0].digest;
        expect(sqlite.prepare("SELECT governed_content_v1_digest('sampling/v1',json_object('probability',json(?))) digest").get(source)?.digest).toBe(expectedDigest);
      }
      for(const invalid of ['null','{}','[]','"1"','NaN','Infinity'])expect(sqlite.prepare('SELECT governed_positive_numeric_v1(?,0) valid').get(invalid)?.valid).toBe(0);
    } finally { sqlite.close(); }
  });

  it("preserves PostgreSQL UTC JSON timestamp text for governed digests", async () => {
    const sqlite=new DatabaseSync(":memory:");
    const client=await pool.connect();
    try {
      await client.query("SET TIME ZONE 'UTC'");
      initializeGovernedSqliteFunctions(sqlite);
      for(const value of ['2026-08-01T00:00:00Z','2026-08-01T00:00:00.1Z','2026-08-01T00:00:00.123Z','2026-08-01T00:00:00.123456Z','2026-08-01T00:00:00.1234565Z','2026-08-01T00:00:00.9999996Z','2000-02-29T03:10:00.1200+03:00','1969-12-31T23:59:59.000001Z',...['00000050000000000000001','12345650000000000000001','12345749999999999999999','99999949999999999999999'].map(f=>'2026-08-01T00:00:00.'+f+'Z')]) {
        const expected=(await client.query('SELECT to_jsonb($1::timestamptz) stamp',[value])).rows[0].stamp;
        expect(sqlite.prepare('SELECT governed_timestamp_v1(?) stamp').get(value)?.stamp).toBe(expected);
      }
      for(const value of ['2026-02-30T00:00:00Z','2025-02-29T00:00:00Z','0000-01-01T00:00:00Z','2026-01-01T00:00:00+16:00','2026-01-01T00:00:00-23:59']) {
        await expect(client.query('SELECT to_jsonb($1::timestamptz)',[value])).rejects.toThrow();
        expect(()=>sqlite.prepare('SELECT governed_timestamp_v1(?)').get(value)).toThrow();
      }
      for(const value of ['9999-12-31T23:59:59.9999996Z','0001-01-01T00:00:00+01:00'])expect(()=>sqlite.prepare('SELECT governed_timestamp_v1(?)').get(value)).toThrow(/supported years/);
    } finally { client.release();sqlite.close(); }
  });

  it("normalizes SQLite and PostgreSQL evidence timestamps to identical milliseconds", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      initializeGovernedSqliteFunctions(sqlite);
      for (const value of ["2026-08-01T00:00:00.123456Z", "2026-08-01T00:00:00.9999996Z", "2026-08-01T03:00:00.1239+03:00", "1969-12-31T23:59:59.999999Z", "2000-02-29T00:00:00Z"]) {
        const row = (await pool.query("SELECT analysis_timestamp_v1($1::timestamptz) stamp", [value])).rows[0];
        expect(sqlite.prepare("SELECT analysis_timestamp_v1(?) stamp").get(value)?.stamp).toBe(row.stamp);
      }
      expect(() => sqlite.prepare("SELECT analysis_timestamp_v1(?)").get("not a timestamp")).toThrow();
    } finally { sqlite.close(); }
  });

  it("uses the same Unicode ordering for SQL aggregates as PostgreSQL and JavaScript", async () => {
    const values = ["～", "😀", "\ue000", "a", "aa", "é", "中", "10", "2", ""];
    const expected = [...values].sort();
    const postgres = await pool.query("SELECT value FROM unnest($1::text[]) value ORDER BY governed_utf16_sort_key_v1(value)", [values]);
    expect(postgres.rows.map(row => row.value)).toEqual(expected);
    const sqlite = new DatabaseSync(":memory:");
    try {
      initializeGovernedSqliteFunctions(sqlite);
      const row = sqlite.prepare("SELECT json_group_array(value ORDER BY governed_utf16_sort_key_v1(value)) ordered FROM json_each(?)").get(JSON.stringify(values));
      expect(JSON.parse(String(row?.ordered))).toEqual(expected);
      for (const invalid of [null, 7, '{', '"\\u0000"', '"\\ud800"']) {
        expect(() => sqlite.prepare('SELECT governed_canonical_json_v1(?)').get(invalid)).toThrow();
      }
    } finally { sqlite.close(); }
  });

  it("aligns the exported instruction helper to the persisted row projection", async () => {
    const instruction = {
      contract: "rubrist/governed-review-instruction/v1" as const,
      schemaVersion: 1 as const,
      instructionVersionId: "instruction_interop",
      projectId: "project_context_is_relational",
      criterionId: "criterion_context_is_relational",
      criterionVersionId: "criterion_version_interop",
      revision: 2,
      predecessorInstructionVersionId: "instruction_interop_v1",
      title: "Unicode 😀 instruction",
      instructions: "Apply nested evidence exactly.",
      failureCodeGuidance: "Use codes in reviewer-authored order.",
      allowedLabels: ["pass", "fail", "cannot_determine"] as ["pass", "fail", "cannot_determine"],
      createdBySubjectId: "subject_context_is_relational",
      createdAt: "2026-08-23T00:00:00.000Z",
      instructionDigest: `sha256:${"0".repeat(64)}`
    };
    const rowContent = {
      allowedLabels: instruction.allowedLabels,
      criterionVersionId: instruction.criterionVersionId,
      failureCodeGuidance: instruction.failureCodeGuidance,
      id: instruction.instructionVersionId,
      instructions: instruction.instructions,
      predecessorInstructionVersionId: instruction.predecessorInstructionVersionId,
      revision: instruction.revision,
      title: instruction.title
    };
    const databaseDigest = String((await pool.query(
      `select governed_content_v1_digest('review-instruction/v1',$1::jsonb) as digest`,
      [JSON.stringify(rowContent)]
    )).rows[0]?.digest);

    expect(governedReviewInstructionDigest(instruction)).toBe(databaseDigest);
    expect(() => verifyGovernedContentV1Digest("review-instruction/v1", rowContent, databaseDigest)).not.toThrow();
  });
});
