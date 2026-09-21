/**
 * Skeleton entry point. Its only job today is to prove the request path works
 * end to end: browser -> CloudFront -> API Gateway -> Lambda, same-origin.
 */

interface HealthResponse {
  status: string;
  service: string;
  environment: string;
  region: string;
  lastScoringRun: string | null;
  time: string;
}

const statusEl = document.querySelector<HTMLParagraphElement>("#status");
const detailEl = document.querySelector<HTMLDListElement>("#status-detail");

function setStatus(text: string, state: "ok" | "error" | "pending"): void {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = `status status--${state}`;
}

function renderDetail(health: HealthResponse): void {
  if (!detailEl) return;
  const rows: Array<[string, string]> = [
    ["Region", health.region],
    ["Environment", health.environment],
    ["Last scoring run", health.lastScoringRun ?? "not yet scheduled"],
    ["Checked", new Date(health.time).toLocaleString()],
  ];
  detailEl.replaceChildren(
    ...rows.flatMap(([term, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = value;
      return [dt, dd];
    }),
  );
  detailEl.hidden = false;
}

async function checkHealth(): Promise<void> {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) {
      setStatus(`Service returned ${response.status}`, "error");
      return;
    }
    const health = (await response.json()) as HealthResponse;
    setStatus("Live on AWS", "ok");
    renderDetail(health);
  } catch {
    // Failing readable: say what is wrong rather than showing nothing.
    setStatus("Cannot reach the service. Check your connection.", "error");
  }
}

void checkHealth();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/service-worker.js");
  });
}
