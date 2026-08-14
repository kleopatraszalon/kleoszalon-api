const BASE = process.env.BOOKING_UAT_BASE || "https://kleoszalon-api-1.onrender.com/api/public/marketing/booking";
const TEST_EMAIL = process.env.BOOKING_UAT_EMAIL || "vir-booking-uat@example.com";
const TEST_NAME = "VIR LIVE UAT";

const results = [];
const activeTokens = new Set();
const iso = (v) => { try { return new Date(v).toISOString(); } catch { return "invalid"; } };

function record(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "user-agent": "Kleopatra-VIR-Live-UAT/1.1",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { status: response.status, ok: response.ok, body };
}

function budapestDate(daysAhead) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(Date.now() + daysAhead * 86400000));
}

async function safeCancel(token, reason) {
  if (!token) return false;
  try {
    const r = await request(`/manage/${encodeURIComponent(token)}/cancel`, {
      method: "POST", body: JSON.stringify({ reason }),
    });
    const cleaned = r.ok || r.status === 404;
    console.log(`${cleaned ? "CLEANUP" : "CLEANUP_FAIL"} | test booking cancellation | HTTP ${r.status}`);
    if (cleaned) activeTokens.delete(token);
    return cleaned;
  } catch (error) {
    console.warn(`CLEANUP_FAIL | ${error?.message || error}`);
    return false;
  }
}

async function findBookableSlot() {
  const root = await request("/catalog");
  if (root.status !== 200 || !root.body?.locations?.length) throw new Error(`catalog unavailable HTTP ${root.status}`);
  for (const location of root.body.locations.slice(0, 20)) {
    const scoped = await request(`/catalog?location_id=${encodeURIComponent(location.id)}`);
    if (scoped.status !== 200 || !scoped.body?.services?.length) continue;
    for (const service of scoped.body.services.slice(0, 12)) {
      for (let day = 1; day <= 21; day += 1) {
        const date = budapestDate(day);
        const av = await request(`/availability?location_id=${encodeURIComponent(location.id)}&date=${date}&service_ids=${encodeURIComponent(service.id)}`);
        if (av.status === 200 && av.body?.slots?.length) {
          return { location, service, date, scheduleSource: av.body.schedule_source, slot: av.body.slots[0] };
        }
      }
    }
  }
  throw new Error("No bookable slot found in the next 21 days");
}

async function main() {
  let primary = null;
  let intendedReschedule = null;
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
    record("Real guest booking write", createOk, `HTTP ${created.status}; status=${created.body?.status || "?"}; work_order=${created.body?.work_order_id ? "created" : "deferred/none"}`);
    if (!createOk) throw new Error(`Booking creation failed HTTP ${created.status}: ${created.body?.error || "unknown"}`);

    primary = {
      id: String(created.body.id), token: String(created.body.cancellation_token),
      locationId: selected.location.id, serviceId: selected.service.id,
      employeeId: selected.slot.employee_id, originalStart: selected.slot.start,
    };
    activeTokens.add(primary.token);

    const managed = await request(`/manage/${encodeURIComponent(primary.token)}`);
    const manageOk = managed.status === 200 && String(managed.body?.id) === primary.id && managed.body?.management_token_valid === true && managed.body?.can_cancel === true;
    record("Management-token readback", manageOk, `HTTP ${managed.status}; can_reschedule=${managed.body?.can_reschedule}; can_cancel=${managed.body?.can_cancel}`);
    if (!manageOk) throw new Error("Management-token readback failed");
    record("Initial booking time round-trip", iso(managed.body?.start_time) === iso(primary.originalStart), `requested=${iso(primary.originalStart)}; returned=${iso(managed.body?.start_time)}`);

    const conflict = await request("/book", {
      method: "POST",
      body: JSON.stringify({ ...payload, client_name: `${TEST_NAME} CONFLICT`, note: "VIR UAT conflict probe" }),
    });
    const conflictOk = conflict.status === 409;
    record("Same-slot collision protection", conflictOk, `HTTP ${conflict.status} (expected 409)`);
    if (!conflictOk && [200, 201].includes(conflict.status) && conflict.body?.cancellation_token) {
      const duplicateToken = String(conflict.body.cancellation_token);
      activeTokens.add(duplicateToken);
      await safeCancel(duplicateToken, "VIR UAT unexpected duplicate cleanup");
    }

    for (let day = 1; day <= 21 && !intendedReschedule; day += 1) {
      const date = budapestDate(day);
      const av = await request(`/availability?location_id=${encodeURIComponent(primary.locationId)}&date=${date}&service_ids=${encodeURIComponent(primary.serviceId)}&exclude_appointment_id=${encodeURIComponent(primary.id)}`);
      if (av.status === 200 && av.body?.slots?.length) intendedReschedule = av.body.slots.find((s) => iso(s.start) !== iso(primary.originalStart)) || null;
    }
    record("Alternative slot discovery for reschedule", Boolean(intendedReschedule), intendedReschedule?.start || "no alternative slot");

    if (intendedReschedule) {
      const rescheduled = await request(`/manage/${encodeURIComponent(primary.token)}/reschedule`, {
        method: "POST",
        body: JSON.stringify({ employee_id: intendedReschedule.employee_id, start_time: intendedReschedule.start, note: "VIR valós UAT - áthelyezés teszt" }),
      });
      const operationOk = rescheduled.status === 200 && rescheduled.body?.ok === true && String(rescheduled.body?.id) === primary.id;
      record("Real booking reschedule write", operationOk, `HTTP ${rescheduled.status}; requested=${iso(intendedReschedule.start)}; returned=${iso(rescheduled.body?.start_time)}`);
      if (operationOk) {
        primary.employeeId = intendedReschedule.employee_id;
        record("Reschedule time round-trip", iso(rescheduled.body?.start_time) === iso(intendedReschedule.start), `requested=${iso(intendedReschedule.start)}; returned=${iso(rescheduled.body?.start_time)}`);
        const readAfterMove = await request(`/manage/${encodeURIComponent(primary.token)}`);
        const readOk = readAfterMove.status === 200 && String(readAfterMove.body?.id) === primary.id && String(readAfterMove.body?.employee_id) === String(intendedReschedule.employee_id);
        record("Reschedule persistence readback", readOk, `HTTP ${readAfterMove.status}; status=${readAfterMove.body?.status || "?"}`);
        record("Reschedule persisted time round-trip", readOk && iso(readAfterMove.body?.start_time) === iso(intendedReschedule.start), `expected=${iso(intendedReschedule.start)}; returned=${iso(readAfterMove.body?.start_time)}`);
      }
    }

    const cancelled = await request(`/manage/${encodeURIComponent(primary.token)}/cancel`, {
      method: "POST", body: JSON.stringify({ reason: "VIR valós UAT automatikus takarítás" }),
    });
    const cancelOk = cancelled.status === 200 && cancelled.body?.ok === true && String(cancelled.body?.status).toLowerCase() === "cancelled";
    record("Real booking cancellation write", cancelOk, `HTTP ${cancelled.status}; status=${cancelled.body?.status || "?"}`);
    if (cancelOk) activeTokens.delete(primary.token);

    const readAfterCancel = await request(`/manage/${encodeURIComponent(primary.token)}`);
    const cancelledPersisted = readAfterCancel.status === 200 && String(readAfterCancel.body?.status).toLowerCase() === "cancelled" && readAfterCancel.body?.can_cancel === false && readAfterCancel.body?.can_reschedule === false;
    record("Cancellation persistence + lockout", cancelledPersisted, `HTTP ${readAfterCancel.status}; can_cancel=${readAfterCancel.body?.can_cancel}; can_reschedule=${readAfterCancel.body?.can_reschedule}`);

    if (cancelOk && intendedReschedule) {
      const slotDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Budapest", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(intendedReschedule.start));
      const reopened = await request(`/availability?location_id=${encodeURIComponent(primary.locationId)}&date=${slotDate}&service_ids=${encodeURIComponent(primary.serviceId)}&employee_id=${encodeURIComponent(primary.employeeId)}`);
      const slotFreed = reopened.status === 200 && reopened.body?.slots?.some((slot) => iso(slot.start) === iso(intendedReschedule.start));
      record("Cancelled slot released back to availability", slotFreed, `HTTP ${reopened.status}; expected=${iso(intendedReschedule.start)}`);
    }
  } finally {
    for (const token of [...activeTokens]) await safeCancel(token, "VIR valós UAT finally cleanup");
  }

  console.log("\n=== VIR LIVE BOOKING UAT SUMMARY ===");
  for (const row of results) console.log(`${row.ok ? "PASS" : "FAIL"} | ${row.name} | ${row.detail}`);
  console.log(`Active test booking cleanup queue remaining: ${activeTokens.size}`);
  console.log(`Synthetic contact: ${TEST_EMAIL}`);

  if (results.some((x) => !x.ok) || activeTokens.size) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`UAT_FATAL: ${error?.stack || error}`);
  process.exitCode = 1;
});
