import { expect, it } from "vitest";
import { DownloadError, withoutDownloadErrors } from "../src/download-error";

it("recursively removes download leaves before any aggregate stringification", () => {
  const unrelated = new Error("Library needs attention");
  const download = new DownloadError();
  expect(withoutDownloadErrors(download)).toBeUndefined();
  expect(
    withoutDownloadErrors(new AggregateError([new AggregateError([download])])),
  ).toBeUndefined();
  const mixed = withoutDownloadErrors(
    new AggregateError(
      [download, new AggregateError([download, unrelated], "secret URL")],
      "secret token",
    ),
  ) as AggregateError;
  expect(mixed.message).not.toContain("secret");
  expect(mixed.errors).toHaveLength(1);
  expect(mixed.errors[0].errors).toEqual([unrelated]);
});

it("preserves unrelated aggregates including empty aggregate messages", () => {
  const empty = new AggregateError([], "Playback unavailable");
  const aggregate = new AggregateError(
    [new Error("Queue unavailable")],
    "Queue synchronization failed",
  );
  expect(withoutDownloadErrors(empty)).toBe(empty);
  expect(withoutDownloadErrors(aggregate)).toBe(aggregate);
});
