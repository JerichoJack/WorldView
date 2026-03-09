/**
 * ui/clock.js
 * Updates the UTC clock in the top HUD bar every second.
 */

export function startClock() {
  function tick() {
    const now = new Date();
    const hh  = now.getUTCHours()  .toString().padStart(2,'0');
    const mm  = now.getUTCMinutes().toString().padStart(2,'0');
    const ss  = now.getUTCSeconds().toString().padStart(2,'0');
    const el  = document.getElementById('clock');
    if (el) el.textContent = `${hh}:${mm}:${ss} UTC`;
  }
  tick();
  setInterval(tick, 1000);
}
