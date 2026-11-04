// Fills the API with upcoming appointment slots so the web page has times to show.
// WARNING: calls /reset, which deletes every booking.
//
//   BASE_URL=https://your-site.netlify.app API_KEY=... node scripts/seed.mjs

const BASE_URL = process.env.BASE_URL?.replace(/\/+$/, "");
const API_KEY = process.env.API_KEY;
if (!BASE_URL || !API_KEY) {
  console.error("Set BASE_URL and API_KEY");
  process.exit(1);
}

const PROVIDERS = ["Dr Ade", "Dr Bello", "Dr Chukwu"];
const DAYS = 14;

// Weekdays, 09:00–16:30 UTC, 30-minute slots; each provider works a different block.
const slots = [];
const today = new Date();
today.setUTCHours(0, 0, 0, 0);
for (let d = 1; d <= DAYS; d++) {
  const day = new Date(today.getTime() + d * 86_400_000);
  if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
  const date = day.toISOString().slice(0, 10);
  PROVIDERS.forEach((provider, p) => {
    for (let h = 9 + p; h < 13 + p; h++) {
      for (const m of ["00", "30"]) {
        const start = `${date}T${String(h).padStart(2, "0")}:${m}:00Z`;
        const end = new Date(Date.parse(start) + 30 * 60_000).toISOString().replace(".000", "");
        slots.push({ id: `${date}-${provider.split(" ")[1].toLowerCase()}-${h}${m}`, provider, start, end });
      }
    }
  });
}

const res = await fetch(`${BASE_URL}/reset`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": API_KEY },
  body: JSON.stringify({ slots }),
});
console.log(res.status, await res.text());
process.exit(res.ok ? 0 : 1);
