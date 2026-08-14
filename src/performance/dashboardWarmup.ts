import { ensureDashboardAnalytics } from "../dashboard/ensureDashboardAnalytics";

let timer: NodeJS.Timeout | null = null;

export function scheduleDashboardWarmup(delayMs = Number(process.env.DASHBOARD_WARMUP_DELAY_MS ?? 2500)) {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void ensureDashboardAnalytics().catch(error => {
      console.warn("Dashboard analytics warmup skipped:", error?.message || error);
    });
  }, Math.max(250, delayMs));
  timer.unref?.();
}
