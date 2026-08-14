const BASE = process.env.BOOKING_UAT_BASE || "https://kleoszalon-api-1.onrender.com/api/public/marketing/booking";
const TEST_EMAIL = process.env.BOOKING_UAT_EMAIL || "vir-booking-uat@example.com";
const TEST_NAME = "VIR LIVE UAT";

const results = [];
const activeTokens = [];

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "user-agent": "Kleopatra-VIR-Live-UAT/1.0",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { status: response.status, ok: response.ok, body };
}

function budapestDate(daysAhead) {
  const d = new Date(Date.now() + daysAhead * 86400000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

async function safeCancel(token, reason) {
  if (!token) return;
  try {
    const r = await request(`/manage/${encodeURIComponent(token)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
    if (r.ok || r.status === 404) return;
    console.warn(`Cleanup cancel returned HTTP ${r.status}`);
  } catch (error) {
    console.warn(`Cleanup cancel failed: ${error?.message || error}`);
  }
}

async function findBookableSlot() {
  const root = await request("/catalog");
  if (root.status !== 200 || !Array.isArray(root.body?.locations) || !root.body.locations.length) {
    throw new Error(`catalog unavailable HTTP ${root.status}`);
  }

  for (const location of root.body.locations.slice(0, 20)) {
    const scoped = await request(`/catalog?location_id=${encodeURIComponent(location.id)}`);
    if (scoped.status !== 200 || !Array.isArray(scoped.body?.services) || !scoped.body.services.length) continue;
    const services = scoped.body.services.slice(0, 12);
    for (const service of services) {
      for (let day = 1; day <= 21; day += 1) {
        const date = budapestDate(day);
        const av = await request(`/availability?location_id=${encodeURIComponent(location.id)}&date=${date}&service_ids=${encodeURIComponent(service.id)}`);
        if (av.status !== 200 || !Array.isArray(av.body?.slots) || !av.body.slots.length) continue;
        return {
          location,
          service,
          date,
          duration: av.body.duration_minutes,
          scheduleSource: av.body.schedule_source,
          slot: av.body.slots[0],
        };
      }
    }
  }
  throw new Error("No bookable slot found in the next 21 days across active locations/services");
}

async function main() {
  let primary = null;
  let unexpectedDuplicate = null;
  let cleanupFallbackUsed = false;

  try {
    const health = await request("/health");
    const healthOk = health.status === 200 && health.body?.ok === true && health.body?.database === true;
    record("Live booking API health + database", healthOk, `HTTP ${health.status}; locations=${health.body?.locations ?? "?"}; services=${health.body?.services ?? "?"}; employees=${health.body?.employees ?? "?"}`);
    if (!healthOk) throw new Error("Live booking API health failed");

    const selected = await findBookableSlot();
    record("Bookable production slot discovery", true, `${selected.location.name}; ${selected.service.name}; ${selected.slot.start}; schedule=${selected.scheduleSource || "n/a"}`);

    const payload = {
      location_id: selected.location.id,
      employee_id: selected.slot.employee_id,
      service_ids: [selected.service.id],
      client_name: TEST_NAME,
      phone: "",
      email: TEST_EMAIL,
      marketing_consent: false,
      start_time: selected.slot.start,
      booking_source: "online",
      note: "VIR valós foglalási UAT - automatikus teszt; a teszt végén lemondandó",
    };

    const created = await request("/book", { method: "POST", body: JSON.stringify(payload) });
    const createOk = [200, 201].includes(created.status) && created.body?.id && created.body?.cancellation_token && created.body?.persisted === true;
    record("Real guest booking write", Boolean(createOk), `HTTP ${created.status}; status=${created.body?.status || "?"}; work_order=${created.body?.work_order_id ? "created" : "deferred/none"}`);
    if (!createOk) throw new Error(`Real booking creation failed HTTP ${created.status}: ${created.body?.error || "unknown"}`);

    primary = {
      id: String(created.body.id),
      token: String(created.body.cancellation_token),
      originalStart: selected.slot.start,
      locationId: selected.location.id,
      serviceId: selected.service.id,
      employeeId: selected.slot.employee_id,
      workOrderId: created.body.work_order_id || null,
    };
    activeTokens.push(primary.token);

    const managed = await request(`/manage/${encodeURIComponent(primary.token)}`);
    const manageOk = managed.status === 200 && String(managed.body?.id) === primary.id && managed.body?.management_token_valid === true && managed.body?.can_cancel === true;
    record("Management-token readback", manageOk, `HTTP ${managed.status}; can_reschedule=${managed.body?.can_reschedule}; can_cancel=${managed.body?.can_cancel}`);
    if (!manageOk) throw new Error("Management token readback failed");

    const conflictPayload = {
      ...payload,
      client_name: `${TEST_NAME} CONFLICT`,
      note: "VIR UAT konfliktus teszt - ennek nem szabad létrejönnie",
    };
    const conflict = await request("/book", { method: "POST", body: JSON.stringify(conflictPayload) });
    const conflictOk = conflict.status === 409;
    if (!conflictOk && [200, 201].includes(conflict.status) && conflict.body?.cancellation_token) {
      unexpectedDuplicate = { id: conflict.body.id, token: String(conflict.body.cancellation_token) };
      activeTokens.push(unexpectedDuplicate.token);
    }
    record("Same-slot collision protection", conflictOk, `HTTP ${conflict.status} (expected 409)`);
    if (!conflictOk) throw new Error("Same-slot conflict protection failed");

    let replacement = null;
    for (let day = 1; day <= 21 && !replacement; day += 1) {
      const date = budapestDate(day);
      const av = await request(`/availability?location_id=${encodeURIComponent(primary.locationId)}&date=${date}&service_ids=${encodeURIComponent(primary.serviceId)}&exclude_appointment_id=${encodeURIComponent(primary.id)}`);
      if (av.status !== 200 || !Array.isArray(av.body?.slots)) continue;
      replacement = av.body.slots.find((slot) => slot.start !== primary.originalStart) || null;
    }
    const replacementOk = Boolean(replacement);
    record("Alternative slot discovery for reschedule", replacementOk, replacement ? replacement.start : "no alternative slot");
    if (!replacement) throw new Error("No alternative slot found for reschedule");

    const rescheduled = await request(`/manage/${encodeURIComponent(primary.token)}/reschedule`, {
      method: "POST",
      body: JSON.stringify({
        employee_id: replacement.employee_id,
        start_time: replacement.start,
        note: "VIR valós UAT - áthelyezés teszt",
      }),
    });
    const rescheduleOk = rescheduled.status === 200 && rescheduled.body?.ok === true && String(rescheduled.body?.id) === primary.id && new Date(rescheduled.body?.start_time).toISOString() === new Date(replacement.start).toISOString();
    record("Real booking reschedule write", rescheduleOk, `HTTP ${rescheduled.status}; new_start=${rescheduled.body?.start_time || "?"}`);
    if (!rescheduleOk) throw new Error(`Reschedule failed HTTP ${rescheduled.status}: ${rescheduled.body?.error || "unknown"}`);

    primary.rescheduledStart = replacement.start;
    primary.employeeId = replacement.employee_id;

    const readAfterMove = await request(`/manage/${encodeURIComponent(primary.token)}`);
    const movePersisted = readAfterMove.status === 200 && new Date(readAfterMove.body?.start_time).toISOString() === new Date(replacement.start).toISOString() && String(readAfterMove.body?.employee_id) === String(replacement.employee_id);
    record("Reschedule persistence readback", movePersisted, `HTTP ${readAfterMove.status}; status=${readAfterMove.body?.status || "?"}`);
    if (!movePersisted) throw new Error("Reschedule did not persist correctly");

    const cancelled = await request(`/manage/${encodeURIComponent(primary.token)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason: "VIR valós UAT automatikus takarítás" }),
    });
    const cancelOk = cancelled.status === 200 && cancelled.body?.ok === true && String(cancelled.body?.status).toLowerCase() === "cancelled";
    record("Real booking cancellation write", cancelOk, `HTTP ${cancelled.status}; status=${cancelled.body?.status || "?"}`);
    if (!cancelOk) throw new Error(`Cancellation failed HTTP ${cancelled.status}: ${cancelled.body?.error || "unknown"}`);
    activeTokens.splice(activeTokens.indexOf(primary.token), 1);

    const readAfterCancel = await request(`/manage/${encodeURIComponent(primary.token)}`);
    const cancelledPersisted = readAfterCancel.status === 200 && String(readAfterCancel.body?.status).toLowerCase() === "cancelled" && readAfterCancel.body?.can_cancel === false && readAfterCancel.body?.can_reschedule === false;
    record("Cancellation persistence + lockout", cancelledPersisted, `HTTP ${readAfterCancel.status}; can_cancel=${readAfterCancel.body?.can_cancel}; can_reschedule=${readAfterCancel.body?.can_reschedule}`);
    if (!cancelledPersisted) throw new Error("Cancelled booking still appears mutable or status did not persist");

    const slotDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Budapest", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(primary.rescheduledStart));
    const reopened = await request(`/availability?location_id=${encodeURIComponent(primary.locationId)}&date=${slotDate}&service_ids=${encodeURIComponent(primary.serviceId)}&employee_id=${encodeURIComponent(primary.employeeId)}`);
    const slotFreed = reopened.status === 200 && Array.isArray(reopened.body?.slots) && reopened.body.slots.some((slot) => new Date(slot.start).toISOString() === new Date(primary.rescheduledStart).toISOString());
    record("Cancelled slot released back to availability", slotFreed, `HTTP ${reopened.status}`);
    if (!slotFreed) throw new Error("Cancelled slot was not released back to availability");

    if (unexpectedDuplicate?.token) {
      await safeCancel(unexpectedDuplicate.token, "VIR UAT unexpected duplicate cleanup");
      const idx = activeTokens.indexOf(unexpectedDuplicate.token);
      if (idx >= 0) activeTokens.splice(idx, 1);
    }
  } finally {
    for (const token of [...activeTokens]) {
      cleanupFallbackUsed = true;
      await safeCancel(token, "VIR valós UAT finally cleanup");
    }
  }

  console.log("\n=== VIR LIVE BOOKING UAT SUMMARY ===");
  for (const row of results) console.log(`${row.ok ? "PASS" : "FAIL"} | ${row.name} | ${row.detail}`);
  console.log("Active test bookings left intentionally: 0");
  console.log(`Synthetic contact: ${TEST_EMAIL}`);
  console.log(`Cleanup fallback used: ${cleanupFallbackUsed ? "yes" : "no"}`);

  const failed = results.filter((x) => !x.ok);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`UAT_FATAL: ${error?.stack || error}`);
  process.exitCode = 1;
});
