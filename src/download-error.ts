export const downloadFailureDiagnostic =
  "Could not save this file. Retry when the connection and storage are available.";

/** Download-domain provenance carries no request, URL, cause, or storage details. */
export class DownloadError extends Error {
  constructor() {
    super(downloadFailureDiagnostic);
    this.name = "DownloadError";
  }
}

/** Filter before stringification, including nested mixed-domain aggregates. */
export function withoutDownloadErrors(error: unknown): unknown {
  if (error instanceof DownloadError) return undefined;
  if (error instanceof AggregateError) {
    const errors = error.errors.map(withoutDownloadErrors).filter((item) => item !== undefined);
    if (
      errors.length === error.errors.length &&
      errors.every((item, index) => item === error.errors[index])
    )
      return error;
    return errors.length ? new AggregateError(errors, "Some operations failed.") : undefined;
  }
  return error;
}
