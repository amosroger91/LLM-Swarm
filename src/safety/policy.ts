import { SwarmError } from "../errors.js";

export interface GitPolicy {
  cleanupWorktrees: boolean;
  preserveOnFailure: boolean;
  allowPush: boolean;
  allowMergeToBase: boolean;
  allowRemotePr: boolean;
}

export type RemoteAction = "push" | "merge-to-base" | "remote-pr";

export function assertRemoteAllowed(policy: GitPolicy, action: RemoteAction): void {
  const allowed =
    action === "push"
      ? policy.allowPush
      : action === "merge-to-base"
        ? policy.allowMergeToBase
        : policy.allowRemotePr;
  if (!allowed) {
    throw new SwarmError(
      `Refusing ${action}. Remote and destructive git actions are disabled unless the matching git.allow* flag is set. The default is local-only.`,
      "remote_disabled",
    );
  }
}
