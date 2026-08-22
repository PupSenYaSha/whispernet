// Moscow is UTC+3 year-round (Russia abolished DST in 2014), so the offset is fixed.
export const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

// Returns the real UTC timestamp of the next Monday at 00:00 Moscow time.
// The weekly general-chat cleanup must fire at 00:00 MSK regardless of the
// server's local timezone, so we compute it explicitly in Moscow wall-clock.
export function nextMondayMidnightMSK(now: number = Date.now()): number {
  // Express "now" as Moscow wall-clock by shifting the UTC instant by +3h,
  // then treat the resulting UTC fields as Moscow local fields.
  const moscowNow = new Date(now + MSK_OFFSET_MS);
  const dow = moscowNow.getUTCDay(); // 0=Sun .. 6=Sat
  let daysUntil = (8 - dow) % 7; // Monday(1) -> 0
  if (daysUntil === 0) daysUntil = 7; // already past 00:00 this Monday -> next week
  const target = new Date(moscowNow);
  target.setUTCDate(target.getUTCDate() + daysUntil);
  target.setUTCHours(0, 0, 0, 0);
  return target.getTime() - MSK_OFFSET_MS; // convert Moscow wall-clock back to UTC instant
}
