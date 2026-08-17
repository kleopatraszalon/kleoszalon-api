import pool from "../db";

let worker: NodeJS.Timeout | null = null;
let running = false;

/**
 * A products.price / retail_price_gross mezők a régi rendszer kompatibilitási
 * cache-ei. A tényleges forrás a product_price_versions időbeli ártörténet.
 * Ez a szinkron szándékosan nem érinti a készlet unit_cost, average_price vagy
 * purchase_price_net mezőit.
 */
export async function syncCurrentProductPrices(): Promise<number> {
  const exists = await pool.query(
    `SELECT to_regprocedure('sync_current_product_prices()') IS NOT NULL ok`,
  );
  if (!exists.rows[0]?.ok) return 0;
  const result = await pool.query(`SELECT sync_current_product_prices() changed`);
  return Number(result.rows[0]?.changed || 0);
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const changed = await syncCurrentProductPrices();
    if (changed > 0) {
      console.log(`Product pricing sync: ${changed} aktuális ár frissítve.`);
    }
  } catch (error: any) {
    console.error("Product pricing sync hiba:", error?.message || error);
  } finally {
    running = false;
  }
}

export function startProductPricingWorker(): void {
  if (worker) return;
  void tick();
  const minutes = Math.max(1, Number(process.env.PRODUCT_PRICE_SYNC_MINUTES || 5));
  worker = setInterval(() => void tick(), minutes * 60_000);
  worker.unref?.();
}

export function stopProductPricingWorker(): void {
  if (!worker) return;
  clearInterval(worker);
  worker = null;
}
