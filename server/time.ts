
export const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;




export function nextMondayMidnightMSK(now: number = Date.now()): number {
  
  
  const moscowNow = new Date(now + MSK_OFFSET_MS);
  const dow = moscowNow.getUTCDay(); 
  let daysUntil = (8 - dow) % 7; 
  if (daysUntil === 0) daysUntil = 7; 
  const target = new Date(moscowNow);
  target.setUTCDate(target.getUTCDate() + daysUntil);
  target.setUTCHours(0, 0, 0, 0);
  return target.getTime() - MSK_OFFSET_MS; 
}
