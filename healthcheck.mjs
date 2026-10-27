const url = process.env.HEALTH_URL
  || `http://127.0.0.1:${process.env.PORT || 8080}/healthz`;

try {
  const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
