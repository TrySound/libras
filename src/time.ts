const durationFormatter = new Intl.DurationFormat("en", {
  minutes: "numeric",
  seconds: "2-digit",
});

export function formatTime(value: number) {
  const seconds = Number.isFinite(value) ? Math.floor(value) : 0;
  return durationFormatter.format({
    minutes: Math.floor(seconds / 60),
    seconds: seconds % 60,
  });
}
