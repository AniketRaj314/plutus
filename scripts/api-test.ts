import "dotenv/config";

const port = process.env.PORT ?? "3000";
const baseUrl = `http://localhost:${port}`;
const token = process.env.API_BEARER_TOKEN;

if (!token) {
  console.error("API_BEARER_TOKEN is not set in .env");
  process.exit(1);
}

const GET_ENDPOINTS = [
  "/health",
  "/transactions",
  "/transactions?limit=5",
  "/envelope",
  "/splits",
  "/summary/week",
  "/summary/month",
  "/context",
  "/committed",
  "/cards",
];

async function main() {
  console.log(`Hitting ${baseUrl} ...\n`);

  for (const path of GET_ENDPOINTS) {
    const isPublic = path === "/health";
    const headers: Record<string, string> = isPublic ? {} : { Authorization: `Bearer ${token}` };

    const res = await fetch(`${baseUrl}${path}`, { headers });
    const body = await res.json().catch(() => null);
    console.log(`GET ${path} -> ${res.status}`);
    console.log(JSON.stringify(body, null, 2).slice(0, 500));
    console.log("");
  }

  // sanity check: unauthorized request should 401
  const unauthed = await fetch(`${baseUrl}/envelope`);
  console.log(`GET /envelope (no token) -> ${unauthed.status} (expect 401)`);
  console.log(JSON.stringify(await unauthed.json().catch(() => null)));
}

main().catch((err) => {
  console.error("FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
