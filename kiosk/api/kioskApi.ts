export type KioskServiceItem = {
  id: string;
  name: string;
  price: number;
  durationMinutes: number | null;
};

export type KioskServiceGroup = {
  serviceTypeId: string | null;
  serviceTypeName: string | null;
  services: KioskServiceItem[];
};

export type KioskServicesResponse = {
  ok: boolean;
  language: "hu" | "en" | "ru";
  items: KioskServiceGroup[];
};

export type KioskOrderItemPayload = {
  serviceId: string;
  quantity?: number;
};

export type KioskOrderPayload = {
  locationId: string;
  client?: {
    name?: string;
    phone?: string;
  };
  items: KioskOrderItemPayload[];
  notes?: string;
  source?: string;
};

export type KioskOrderResponse = {
  ok: boolean;
  workOrderId?: string;
  total?: number;
  client?: {
    clientName: string;
    clientPhone?: string | null;
    clientText: string;
  };
  error?: string;
};

const API_BASE = "/api/kiosk";

export async function fetchKioskServices(
  opts: { locationId?: string; lang?: "hu" | "en" | "ru" } = {}
): Promise<KioskServicesResponse> {
  const params = new URLSearchParams();
  if (opts.locationId) params.set("locationId", opts.locationId);
  if (opts.lang) params.set("lang", opts.lang);

  const res = await fetch(`${API_BASE}/services?${params.toString()}`, {
    method: "GET",
  });

  if (!res.ok) {
    throw new Error("Kiosk szolgáltatások lekérés sikertelen");
  }

  return (await res.json()) as KioskServicesResponse;
}

export async function createKioskOrder(
  payload: KioskOrderPayload
): Promise<KioskOrderResponse> {
  const res = await fetch(`${API_BASE}/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = (await res.json()) as KioskOrderResponse;

  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Kiosk rendelés sikertelen");
  }

  return data;
}
