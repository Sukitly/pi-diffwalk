import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDiffWalkCommand } from "./extension/command.ts";
import {
  DIFFWALK_KICKOFF_MESSAGE_TYPE,
  DIFFWALK_REVIEW_RESULT_MESSAGE_TYPE,
  DIFFWALK_THREAD_FOLLOW_UP_MESSAGE_TYPE,
  type KickoffMessageDetails,
  renderKickoffMessage,
  renderSubmittedReviewMessage,
  renderThreadFollowUpMessage,
  type SubmittedReviewMessageDetails,
  type ThreadFollowUpMessageDetails,
} from "./extension/messages.ts";
import {
  DEFAULT_DEPENDENCIES,
  type DiffWalkDependencies,
  DiffWalkSession,
} from "./extension/session.ts";
import {
  registerGuidedReviewTool,
  registerReviewResponsesTool,
} from "./extension/tools.ts";

export default function diffWalk(pi: ExtensionAPI): void {
  registerDiffWalk(pi);
}

export function registerDiffWalk(
  pi: ExtensionAPI,
  dependencies: DiffWalkDependencies = DEFAULT_DEPENDENCIES,
): void {
  const session = new DiffWalkSession(pi, dependencies);

  pi.on("session_start", (_event, ctx) => {
    session.restoreFromEntries(ctx.sessionManager.getEntries());
  });

  pi.registerMessageRenderer<KickoffMessageDetails>(
    DIFFWALK_KICKOFF_MESSAGE_TYPE,
    renderKickoffMessage,
  );
  pi.registerMessageRenderer<SubmittedReviewMessageDetails>(
    DIFFWALK_REVIEW_RESULT_MESSAGE_TYPE,
    renderSubmittedReviewMessage,
  );
  pi.registerMessageRenderer<ThreadFollowUpMessageDetails>(
    DIFFWALK_THREAD_FOLLOW_UP_MESSAGE_TYPE,
    renderThreadFollowUpMessage,
  );

  registerDiffWalkCommand(pi, session);
  registerReviewResponsesTool(pi, session);
  registerGuidedReviewTool(pi, session);
}
