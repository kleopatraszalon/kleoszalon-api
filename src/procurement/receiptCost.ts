export type ReceiptCostInput = {
  quantity: number;
  netUnitPrice: number;
  taxRatePct?: number;
  ancillaryCostTotal?: number;
};

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const round4 = (value: number) => Math.round((value + Number.EPSILON) * 10000) / 10000;

export function calculateReceiptCost(input: ReceiptCostInput) {
  const quantity = Number(input.quantity);
  const netUnitPrice = round4(Number(input.netUnitPrice));
  const taxRatePct = round4(Number(input.taxRatePct ?? 0));
  const ancillaryCostTotal = round2(Number(input.ancillaryCostTotal ?? 0));

  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Érvénytelen bevételezési mennyiség.");
  if (!Number.isFinite(netUnitPrice) || netUnitPrice < 0) throw new Error("Érvénytelen nettó bevételezési egységár.");
  if (!Number.isFinite(taxRatePct) || taxRatePct < 0 || taxRatePct > 100) throw new Error("Érvénytelen bevételezési adókulcs.");
  if (!Number.isFinite(ancillaryCostTotal) || ancillaryCostTotal < 0) throw new Error("Érvénytelen járulékos bevételezési költség.");

  const netTotal = round2(netUnitPrice * quantity);
  const taxTotal = round2(netTotal * taxRatePct / 100);
  const grossTotal = round2(netTotal + taxTotal);
  const landedTotal = round2(grossTotal + ancillaryCostTotal);
  const landedUnitCost = round4(landedTotal / quantity);

  return {
    quantity,
    netUnitPrice,
    taxRatePct,
    ancillaryCostTotal,
    netTotal,
    taxTotal,
    grossTotal,
    landedTotal,
    landedUnitCost,
  };
}
