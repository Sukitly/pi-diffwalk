export class GitSnapshotError extends Error {
  readonly args?: readonly string[];

  constructor(message: string, args?: readonly string[]) {
    super(message);
    this.name = "GitSnapshotError";
    this.args = args;
  }
}

export class ReviewSnapshotDriftError extends GitSnapshotError {
  constructor(message: string) {
    super(message);
    this.name = "ReviewSnapshotDriftError";
  }
}
