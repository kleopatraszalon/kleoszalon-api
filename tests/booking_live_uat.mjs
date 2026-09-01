import { writeFile } from "node:fs/promises";

const BASE = process.env.BOOKING_UAT_BASE || "https://kleoszalon-api-1.onrender.com/api/public/marketing/booking";
const TEST_EMAIL = process.env.BOOKING_UAT_EMAIL || "vir-booking-uat@example.com";
const TEST_NAME = "VIR LIVE UAT";
const HORIZON_DAYS = Math.min(90, Math.max(7, Number(process.env.BOOKING_UAT_HORIZON_DAYS || 42) || 42));
const REQUIRE_SLOT = process.env.BOOKING_UAT_REQUIRE_SLOT === "1";
const MAX_PROBES = Math.min(1000, Math.max(12, Number(process.env.BOOKING_UAT_MAX_PROBES || 96) || 96));
const PROBE_CONCURRENCY = Math.min(16, Math.max(1, Number(process.env.BOOKING_UAT_PROBE_CONCURRENCY || 8) || 8));
const RESULT_FILE = process.env.BOOKING_UAT_RESULT_FILE || "/tmp/booking-uat-result.json";
const results = [];
const activeTokens = new Set();
let probeCount = 0;
let lifecycleExercised = false;
let slotFound = false;

const iso = (v) => {
  try { return new Date(v).toISOString(); }
  catch { return "invalid"; }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function record(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "user-agent": "Kleopatra-VIR-Live-UAT/1.4",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; }
  catch { body = { raw: text }; }
  return { status: response.status, ok: response.ok, body };
}

async function requestStable(path, options = {}, attempts = 6) {
  let last = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      last = await request(path, options);
      if (![502, 503, 504].includes(last.status)) return last;
      console.warn(`TRANSIENT | ${path} | HTTP ${last.status} | retry ${i}/${attempts}`);
    } catch (error) {
      console.warn(`TRANSIENT | ${path} | ${error?.message || error} | retry ${i}/${attempts}`);
    }
    if (i < attempts) await sleep(Math.min(15000, 2000 * i));
  }
  return last || { status: 599, ok: false, body: { error: "request_failed_after_retries" } };
}

function budapestDate(daysAhead) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Budapest",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + daysAhead * 86400000));
}

function probeDayOffsets() {
  const offsets = [];
  for (let day = 1; day <= Math.min(7, HORIZON_DAYS); day += 1) offsets.push(day);
  for (const day of [10, 14, 21, 28, 35, 42, 56, 70, 90]) {
    if (day <= HORIZON_DAYS) offsets.push(day);
  }
  return [...new Set(offsets)].sort((a, b) => a - b);
}

async function safeCancel(token, reason) {
  if (!token) return false;
  try {
    const response = await requestStable(`/manage/${encodeURIComponent(token)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
    const cleaned = response.ok || response.status === 404;
    console.log(`${cleaned ? "CLEANUP" : "CLEANUP_FAIL"} | test booking cancellation | HTTP ${response.status}`);
    if (cleaned) activeTokens.delete(token);
    return cleaned;
  } catch (error) {
    console.warn(`CLEANUP_FAIL | ${error?.message || error}`);
    return false;
  }
}

async function findBookableSlot() {
  const root = await requestStable("/catalog");
  if (root.status !== 200 || !root.body?.locations?.length) {
    throw new Error(`catalog unavailable HTTP ${root.status}`);
  }

  const locations = root.body.locations.slice(0, 8);
  const scopedCatalogs = (await Promise.all(locations.map(async (location) => {
    const scoped = await requestStable(`/catalog?location_id=${encodeURIComponent(location.id)}`);
    if (scoped.status !== 200 || !scoped.body?.services?.length) return null;
    return { location, services: scoped.body.services.slice(0, 6) };
  }))).filter(Boolean);

  const candidates = [];
  for (const day of probeDayOffsets()) {
    for (const catalog of scopedCatalogs) {
      for (const service of catalog.services) {
        candidates.push({ location: catalog.location, service, day });
        if (candidates.length >= MAX_PROBES) break;
      }
      if (candidates.length >= MAX_PROBES) break;
    }
    if (candidates.length >= MAX_PROBES) break;
  }

  for (let offset = 0; offset < candidates.length; offset += PROBE_CONCURRENCY) {
    const batch = candidates.slice(offset, offset + PROBE_CONCURRENCY);
    const checked = await Promise.all(batch.map(async (candidate) => {
      probeCount += 1;
      const date = budapestDate(candidate.day);
      const availability = await requestStable(
        `/availability?location_id=${encodeURIComponent(candidate.location.id)}&date=${date}&service_ids=${encodeURIComponent(candidate.service.id)}`,
      );
      if (availability.status !== 200 || !availability.body?.slots?.length) return null;
      return {
        location: candidate.location,
        service: candidate.service,
        date,
        scheduleSource: availability.body.schedule_source,
        slot: availability.body.slots[0],
      };
    }));
    const found = checked.find(Boolean);
    if (found) return found;
  }
  return null;
}

async function exerciseBookingLifecycle(selected) {
  lifecycleExercised = true;
  let primary = null;
  let intendedReschedule = null;

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

  const created = await requestStable("/book", { method: "POST", body: JSON.stringify(payload) });
  const createOk = [200, 201].includes(created.status)
    && created.body?.id
    && created.body?.cancellation_token
    && created.body?.persisted === true;
  record(
    "Real guest booking write",
    createOk,
    `HTTP ${created.status}; status=${created.body?.status || "?"}; work_order=${created.body?.work_order_id ? "created" : "deferred/none"}`,
  );
  if (!createOk) throw new Error(`Booking creation failed HTTP ${created.status}: ${created.body?.error || "unknown"}`);

  primary = {
    id: String(created.body.id),
    token: String(created.body.cancellation_token),
    locationId: selected.location.id,
    serviceId: selected.service.id,
    employeeId: selected.slot.employee_id,
    originalStart: selected.slot.start,
  };
  activeTokens.add(primary.token);

  const managed = await requestStable(`/manage/${encodeURIComponent(primary.token)}`);
  const manageOk = managed.status === 200
    && String(managed.body?.id) === primary.id
    && managed.body?.management_token_valid === true
    && managed.body?.can_cancel === true;
  record(
    "Management-token readback",
    manageOk,
    `HTTP ${managed.status}; can_reschedule=${managed.body?.can_reschedule}; can_cancel=${managed.body?.can_cancel}`,
  );
  if (!manageOk) throw new Error("Management-token readback failed");

  record(
    "Initial booking time round-trip",
    iso(managed.body?.start_time) === iso(primary.originalStart),
    `requested=${iso(primary.originalStart)}; returned=${iso(managed.body?.start_time)}`,
  );

  const conflict = await requestStable("/book", {
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

  for (let day = 1; day <= HORIZON_DAYS && !intendedReschedule; day += 1) {
    const date = budapestDate(day);
    const availability = await requestStable(
      `/availability?location_id=${encodeURIComponent(primary.locationId)}&date=${date}&service_ids=${encodeURIComponent(primary.serviceId)}&exclude_appointment_id=${encodeURIComponent(primary.id)}`,
    );
    if (availability.status === 200 && availability.body?.slots?.length) {
      intendedReschedule = availability.body.slots.find((slot) => iso(slot.start) !== iso(primary.originalStart)) || null;
    }
  }

  record(
    "Alternative slot discovery for reschedule",
    Boolean(intendedReschedule),
    intendedReschedule?.start || "no alternative slot",
  );

  if (intendedReschedule) {
    const rescheduled = await requestStable(`/manage/${encodeURIComponent(primary.token)}/reschedule`, {
      method: "POST",
      body: JSON.stringify({
        employee_id: intendedReschedule.employee_id,
        start_time: intendedReschedule.start,
        note: "VIR valós UAT - áthelyezés teszt",
      }),
    });
    const operationOk = rescheduled.status === 200
      && rescheduled.body?.ok === true
      && String(rescheduled.body?.id) === primary.id;
    record(
      "Real booking reschedule write",
      operationOk,
      `HTTP ${rescheduled.status}; requested=${iso(intendedReschedule.start)}; returned=${iso(rescheduled.body?.start_time)}`,
    );
    if (operationOk) {
      primary.employeeId = intendedReschedule.employee_id;
      record(
        "Reschedule time round-trip",
        iso(rescheduled.body?.start_time) === iso(intendedReschedule.start),
        `requested=${iso(intendedReschedule.start)}; returned=${iso(rescheduled.body?.start_time)}`,
      );
      const readAfterMove = await requestStable(`/manage/${encodeURIComponent(primary.token)}`);
      const readOk = readAfterMove.status === 200
        && String(readAfterMove.body?.id) === primary.id
        && String(readAfterMove.body?.employee_id) === String(intendedReschedule.employee_id);
      record("Reschedule persistence readback", readOk, `HTTP ${readAfterMove.status}; status=${readAfterMove.body?.status || "?"}`);
      record(
        "Reschedule persisted time round-trip",
        readOk && iso(readAfterMove.body?.start_time) === iso(intendedReschedule.start),
        `expected=${iso(intendedReschedule.start)}; returned=${iso(readAfterMove.body?.start_time)}`,
      );
    }
  }

  const cancelled = await requestStable(`/manage/${encodeURIComponent(primary.token)}/cancel`, {
    method: "POST",
    body: JSON.stringify({ reason: "VIR valós UAT automatikus takarítás" }),
  });
  const cancelOk = cancelled.status === 200
    && cancelled.body?.ok === true
    && String(cancelled.body?.status).toLowerCase() === "cancelled";
  record("Real booking cancellation write", cancelOk, `HTTP ${cancelled.status}; status=${cancelled.body?.status || "?"}`);
  if (cancelOk) activeTokens.delete(primary.token);

  const readAfterCancel = await requestStable(`/manage/${encodeURIComponent(primary.token)}`);
  const cancelledPersisted = readAfterCancel.status === 200
    && String(readAfterCancel.body?.status).toLowerCase() === "cancelled"
    && readAfterCancel.body?.can_cancel === false
    && readAfterCancel.body?.can_reschedule === false;
  record(
    "Cancellation persistence + lockout",
    cancelledPersisted,
    `HTTP ${readAfterCancel.status}; can_cancel=${readAfterCancel.body?.can_cancel}; can_reschedule=${readAfterCancel.body?.can_reschedule}`,
  );

  if (cancelOk && intendedReschedule) {
    const slotDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Budapest",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(intendedReschedule.start));
    const reopened = await requestStable(
      `/availability?location_id=${encodeURIComponent(primary.locationId)}&date=${slotDate}&service_ids=${encodeURIComponent(primary.serviceId)}&employee_id=${encodeURIComponent(primary.employeeId)}`,
    );
    const slotFreed = reopened.status === 200
      && reopened.body?.slots?.some((slot) => iso(slot.start) === iso(intendedReschedule.start));
    record("Cancelled slot released back to availability", slotFreed, `HTTP ${reopened.status}; expected=${iso(intendedReschedule.start)}`);
  }
}

async function persistResult(fatalError = null) {
  const failed = results.some((row) => !row.ok) || activeTokens.size > 0 || Boolean(fatalError);
  const payload = {
    ok: !failed,
    mode: lifecycleExercised ? "booking_lifecycle" : "inventory_skip",
    slot_found: slotFound,
    lifecycle_exercised: lifecycleExercised,
    probe_count: probeCount,
    probe_limit: MAX_PROBES,
    horizon_days: HORIZON_DAYS,
    strict_slot_requirement: REQUIRE_SLOT,
    cleanup_remaining: activeTokens.size,
    fatal_error: fatalError ? String(fatalError?.message || fatalError) : null,
    results,
  };
  await writeFile(RESULT_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`UAT_RESULT_FILE | ${RESULT_FILE} | mode=${payload.mode}; probes=${probeCount}/${MAX_PROBES}`);
  return payload;
}

async function main() {
  let fatalError = null;
  try {
    const health = await requestStable("/health", {}, 8);
    const healthOk = health.status === 200 && health.body?.ok === true && health.body?.database === true;
    record(
      "Live booking API health + database",
      healthOk,
      `HTTP ${health.status}; locations=${health.body?.locations ?? "?"}; services=${health.body?.services ?? "?"}; employees=${health.body?.employees ?? "?"}`,
    );
    if (!healthOk) throw new Error("Live booking API health failed");

    const selected = await findBookableSlot();
    slotFound = Boolean(selected);
    if (!selected) {
      const detail = `no slot in bounded production sample: ${probeCount}/${MAX_PROBES} probes across ${HORIZON_DAYS} days; write lifecycle not attempted`;
      if (REQUIRE_SLOT) {
        record("Bookable production slot discovery", false, detail);
        throw new Error(`No bookable slot found in bounded production sample (${probeCount} probes)`);
      }
      record("Bookable production slot discovery", true, `SKIP | ${detail}`);
      console.warn(`UAT_SKIP | ${detail} | set BOOKING_UAT_REQUIRE_SLOT=1 for strict inventory validation`);
    } else {
      record(
        "Bookable production slot discovery",
        true,
        `${selected.location.name}; ${selected.service.name}; ${selected.slot.start}; schedule=${selected.scheduleSource || "n/a"}; probes=${probeCount}`,
      );
      await exerciseBookingLifecycle(selected);
    }
  } catch (error) {
    fatalError = error;
    throw error;
  } finally {
    for (const token of [...activeTokens]) {
      await safeCancel(token, "VIR valós UAT finally cleanup");
    }
    await persistResult(fatalError);
  }

  console.log("\n=== VIR LIVE BOOKING UAT SUMMARY ===");
  for (const row of results) console.log(`${row.ok ? "PASS" : "FAIL"} | ${row.name} | ${row.detail}`);
  console.log(`Active test booking cleanup queue remaining: ${activeTokens.size}`);
  console.log(`Synthetic contact: ${TEST_EMAIL}`);
  console.log(`Inventory horizon: ${HORIZON_DAYS} days; probes: ${probeCount}/${MAX_PROBES}; strict slot requirement: ${REQUIRE_SLOT}`);
  if (results.some((row) => !row.ok) || activeTokens.size) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`UAT_FATAL: ${error?.stack || error}`);
  process.exitCode = 1;
});
