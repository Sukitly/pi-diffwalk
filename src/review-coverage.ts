import { listReviewableHunks } from "./review-delta.ts";
import type {
	HunkId,
	HunkReviewRecord,
	HunkReviewRequirement,
	ReviewCoverage,
	ReviewDelta,
	ReviewRoundId,
	ReviewSnapshot,
} from "./types.ts";

export interface SkippedHunkOutcome {
	readonly hunkId: HunkId;
	readonly reason: string;
}

export interface ReviewCoverageInput {
	readonly commentedHunkIds: readonly HunkId[];
	readonly skippedHunks: readonly SkippedHunkOutcome[];
}

export class ReviewCoverageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReviewCoverageError";
	}
}

export function computeReviewCoverage(
	roundId: ReviewRoundId,
	snapshot: ReviewSnapshot,
	delta: ReviewDelta,
	input: ReviewCoverageInput,
): ReviewCoverage {
	if (delta.currentSnapshotId !== snapshot.id) {
		throw new ReviewCoverageError(
			`Review delta references snapshot ${delta.currentSnapshotId}, not ${snapshot.id}.`,
		);
	}

	const hunks = listReviewableHunks(snapshot);
	const hunksById = new Map(hunks.map((hunk) => [hunk.id, hunk]));
	const requirements = validateRequirements(delta, hunksById);
	const commentedHunkIds = validateCommentedHunks(
		input.commentedHunkIds,
		hunksById,
	);
	const skippedHunks = validateSkippedHunks(input.skippedHunks, requirements);

	for (const hunkId of commentedHunkIds) {
		if (skippedHunks.has(hunkId)) {
			throw new ReviewCoverageError(
				`Hunk ${hunkId} cannot be both commented and skipped.`,
			);
		}
	}

	const records = hunks.map((hunk): HunkReviewRecord => {
		if (commentedHunkIds.has(hunk.id)) {
			return {
				hunkId: hunk.id,
				fingerprint: hunk.fingerprint,
				disposition: "commented",
				commentedInRoundId: roundId,
			};
		}

		const skipReason = skippedHunks.get(hunk.id);
		if (skipReason !== undefined) {
			return {
				hunkId: hunk.id,
				fingerprint: hunk.fingerprint,
				disposition: "skipped",
				skippedInRoundId: roundId,
				skipReason,
			};
		}

		const requirement = requirements.get(hunk.id);
		if (requirement === undefined) {
			throw new ReviewCoverageError(
				`No review requirement exists for hunk ${hunk.id}.`,
			);
		}
		return {
			hunkId: hunk.id,
			fingerprint: hunk.fingerprint,
			disposition: "reviewed-without-comment",
			reviewedInRoundId:
				requirement.type === "carried-forward"
					? requirement.reviewedInRoundId
					: roundId,
		};
	});

	return { snapshotId: snapshot.id, records };
}

function validateRequirements(
	delta: ReviewDelta,
	hunksById: ReadonlyMap<HunkId, { readonly id: HunkId }>,
): Map<HunkId, HunkReviewRequirement> {
	const requirements = new Map<HunkId, HunkReviewRequirement>();
	for (const requirement of delta.hunks) {
		if (!hunksById.has(requirement.hunkId)) {
			throw new ReviewCoverageError(
				`Review delta contains unknown hunk ${requirement.hunkId}.`,
			);
		}
		if (requirements.has(requirement.hunkId)) {
			throw new ReviewCoverageError(
				`Review delta contains duplicate hunk ${requirement.hunkId}.`,
			);
		}
		requirements.set(requirement.hunkId, requirement);
	}
	for (const hunkId of hunksById.keys()) {
		if (!requirements.has(hunkId)) {
			throw new ReviewCoverageError(
				`Review delta does not cover hunk ${hunkId}.`,
			);
		}
	}
	return requirements;
}

function validateCommentedHunks(
	commentedHunks: readonly HunkId[],
	hunksById: ReadonlyMap<HunkId, { readonly id: HunkId }>,
): ReadonlySet<HunkId> {
	const result = new Set<HunkId>();
	for (const hunkId of commentedHunks) {
		if (!hunksById.has(hunkId)) {
			throw new ReviewCoverageError(
				`Comment references unknown hunk ${hunkId}.`,
			);
		}
		result.add(hunkId);
	}
	return result;
}

function validateSkippedHunks(
	skippedHunks: readonly SkippedHunkOutcome[],
	requirements: ReadonlyMap<HunkId, HunkReviewRequirement>,
): ReadonlyMap<HunkId, string> {
	const result = new Map<HunkId, string>();
	for (const skipped of skippedHunks) {
		const requirement = requirements.get(skipped.hunkId);
		if (requirement === undefined) {
			throw new ReviewCoverageError(
				`Skip references unknown hunk ${skipped.hunkId}.`,
			);
		}
		if (requirement.type === "carried-forward") {
			throw new ReviewCoverageError(
				`Carried-forward hunk ${skipped.hunkId} cannot be skipped.`,
			);
		}
		if (skipped.reason.trim().length === 0) {
			throw new ReviewCoverageError(
				`Skipped hunk ${skipped.hunkId} requires a non-empty reason.`,
			);
		}
		if (result.has(skipped.hunkId)) {
			throw new ReviewCoverageError(
				`Hunk ${skipped.hunkId} is skipped more than once.`,
			);
		}
		result.set(skipped.hunkId, skipped.reason);
	}
	return result;
}
