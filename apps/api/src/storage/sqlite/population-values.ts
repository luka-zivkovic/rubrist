import { ANALYSIS_POPULATION_CANONICALIZATION_VERSION, ANALYSIS_POPULATION_ELIGIBLE_INGESTION_PURPOSES, ANALYSIS_POPULATION_ELIGIBLE_SOURCES, ANALYSIS_POPULATION_ORDERING_VERSION, type AnalysisPopulation, type AnalysisPopulationDrawSummary, type AnalysisPopulationMember, type AnalysisPopulationDrawSelection, type AnalysisPopulationExclusion } from '@rubrist/shared';
import { analysisPopulationClaim } from '../../lib/analysis-population.js';
import { AnalysisPopulationRepositoryError } from '../../analysis-population/repository.js';
interface CursorValue { createdAt?:string; id?:string; position?:string }
const iso=(value:unknown)=>new Date(String(value)).toISOString();
const repoError=(code:ConstructorParameters<typeof AnalysisPopulationRepositoryError>[0],message:string)=>new AnalysisPopulationRepositoryError(code,message);
export function summarySelect(): string {
  return `select population.id as population_id,population.project_id,population.dataset_revision_id,
                 population.window_start,population.window_end,population.eligible_sources,
                 population.eligible_ingestion_purposes,population.canonicalization_version,
                 population.ordering_version,population.population_size,population.exclusion_count,
                 population.frame_digest,population.content_digest,population.snapshot_kind,
                 population.snapshot_taken_at,population.created_by_user_id,
                 population.created_by_subject_id,population.created_at as population_created_at,
                 population.created_at
                   as population_created_at_exact,
                 draw.id as draw_id,draw.method,draw.stopping_rule,draw.draw_executor,draw.seed,
                 draw.rng_version,draw.algorithm_version,draw.fixed_budget,
                 draw.inclusion_numerator,draw.inclusion_denominator,draw.draw_digest,
                 draw.content_digest as draw_content_digest,draw.executed_by_subject_id,draw.executed_at
          from analysis_populations population
          join analysis_population_draws draw on draw.population_id=population.id`;
}

export function rowToSummary(row: Record<string, unknown>) {
  const population: AnalysisPopulation = {
    id: String(row.population_id),
    projectId: String(row.project_id),
    datasetRevisionId: String(row.dataset_revision_id),
    windowStart: iso(row.window_start),
    windowEnd: iso(row.window_end),
    eligibleSources: [...ANALYSIS_POPULATION_ELIGIBLE_SOURCES],
    eligibleIngestionPurposes: [...ANALYSIS_POPULATION_ELIGIBLE_INGESTION_PURPOSES],
    canonicalizationVersion: ANALYSIS_POPULATION_CANONICALIZATION_VERSION,
    orderingVersion: ANALYSIS_POPULATION_ORDERING_VERSION,
    populationSize: Number(row.population_size),
    exclusionCount: String(row.exclusion_count),
    frameDigest: String(row.frame_digest),
    contentDigest: String(row.content_digest),
    snapshotProvenance: "sqlite-serialized-freeze/v1",
    snapshotTakenAt: iso(row.snapshot_taken_at),
    createdByUserId: String(row.created_by_user_id),
    createdBySubjectId: String(row.created_by_subject_id),
    createdAt: iso(row.population_created_at)
  };
  const draw: AnalysisPopulationDrawSummary = {
    id: String(row.draw_id),
    projectId: population.projectId,
    populationId: population.id,
    datasetRevisionId: population.datasetRevisionId,
    method: "simple_random",
    stoppingRule: "fixed",
    drawExecutor: "rubrist_server",
    seed: String(row.seed),
    rngVersion: "sha256-rank/v1",
    algorithmVersion: "rubrist-analysis-draw/v1",
    fixedBudget: Number(row.fixed_budget),
    populationSize: population.populationSize,
    inclusionProbability: {
      numerator: Number(row.inclusion_numerator),
      denominator: Number(row.inclusion_denominator)
    },
    drawDigest: String(row.draw_digest),
    contentDigest: String(row.draw_content_digest),
    executedBySubjectId: String(row.executed_by_subject_id),
    executedAt: iso(row.executed_at)
  };
  return { population, draw, claim: analysisPopulationClaim(population.id) };
}

export function rowToMember(row: Record<string, unknown>): AnalysisPopulationMember {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    populationId: String(row.population_id),
    revisionItemId: String(row.revision_item_id),
    caseId: String(row.case_id),
    caseType: String(row.case_type) as AnalysisPopulationMember["caseType"],
    ingestionPurpose: String(row.ingestion_purpose) as AnalysisPopulationMember["ingestionPurpose"],
    position: Number(row.position),
    ingestionTime: iso(row.ingestion_time),
    inputDigest: String(row.input_digest),
    itemDigest: String(row.item_digest),
    frameMemberDigest: String(row.frame_member_digest),
    lineageDigest: String(row.lineage_digest),
    createdAt: iso(row.created_at)
  };
}

export function rowToSelection(row: Record<string, unknown>): AnalysisPopulationDrawSelection {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    drawId: String(row.draw_id),
    populationId: String(row.population_id),
    memberId: String(row.member_id),
    revisionItemId: String(row.revision_item_id),
    caseId: String(row.case_id),
    position: Number(row.position),
    frameMemberDigest: String(row.frame_member_digest),
    rankDigest: String(row.rank_digest),
    contentDigest: String(row.content_digest),
    createdAt: iso(row.created_at)
  };
}

export function rowToExclusion(row: Record<string, unknown>): AnalysisPopulationExclusion {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    populationId: String(row.population_id),
    caseId: String(row.case_id),
    rawTraceId: row.raw_trace_id === null ? null : String(row.raw_trace_id),
    sourceTraceId: row.source_trace_id === null ? null : String(row.source_trace_id),
    caseType: String(row.case_type),
    ingestionPurpose: String(row.ingestion_purpose),
    position: String(row.position),
    ingestionTime: iso(row.ingestion_time),
    reason: "ineligible_ingestion_purpose",
    contentDigest: String(row.content_digest),
    createdAt: iso(row.created_at)
  } as AnalysisPopulationExclusion;
}

export function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify({
    v: 1,
    kind: value.position === undefined ? "chronological" : "position",
    ...value
  }), "utf8").toString("base64url");
}

export function decodeCursor(
  value: string | null,
  scope: string,
  expectedKind: "chronological" | "position"
): CursorValue {
  if (!value) return {};
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed.v !== 1 || parsed.kind !== expectedKind) throw new Error("version or kind");
    if (expectedKind === "position") {
      if (
        typeof parsed.position !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(parsed.position) ||
        BigInt(parsed.position) > 9_223_372_036_854_775_807n
      ) throw new Error("position");
      return { position: parsed.position };
    }
    if (
      typeof parsed.createdAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(parsed.createdAt) ||
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      typeof parsed.id !== "string" || parsed.id.length < 1 || parsed.id.length > 240 ||
      parsed.id.includes("\u0000")
    ) throw new Error("identity");
    return { createdAt: new Date(parsed.createdAt).toISOString(), id: parsed.id };
  } catch {
    throw repoError("analysis_population_invalid_cursor", `Invalid ${scope} cursor`);
  }
}
