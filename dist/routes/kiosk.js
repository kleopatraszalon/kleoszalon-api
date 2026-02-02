"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.kioskRouter = void 0;
const express_1 = require("express");
const db_1 = require("../db"); // ha nálad máshol van a pool, igazítsd
exports.kioskRouter = (0, express_1.Router)();
/**
 * GET /api/kiosk/services
 * Egyszerű, kiosk-barát szolgáltatáslista.
 * Opcionális query: locationId (UUID)
 */
exports.kioskRouter.get("/services", async (req, res) => {
    const { locationId, lang } = req.query;
    // Nyelv választása – ha nincs megadva, HU legyen az alap
    const language = lang || "hu";
    // Dinamikusan választjuk a név oszlopot (name_hu / name_en / name_ru)
    const nameColumn = language === "en"
        ? "s.name_en"
        : language === "ru"
            ? "s.name_ru"
            : "s.name_hu";
    try {
        const params = [];
        let where = "s.is_active = TRUE";
        if (locationId) {
            params.push(locationId);
            where += ` AND (s.location_id = $${params.length} OR s.location_id IS NULL)`;
        }
        const query = `
      SELECT
        s.id,
        ${nameColumn} AS name,
        s.base_price AS price,
        s.duration_minutes,
        st.id AS service_type_id,
        COALESCE(st.name_hu, st.name_en, st.name_ru) AS service_type_name
      FROM services s
      LEFT JOIN service_types st ON st.id = s.service_type_id
      WHERE ${where}
      ORDER BY st.display_order NULLS LAST, s.display_order NULLS LAST, name;
    `;
        const { rows } = await db_1.pool.query(query, params);
        // Csoportosítás típus szerint – a frontendnek kényelmesebb
        const grouped = {};
        for (const row of rows) {
            const key = row.service_type_id || "other";
            if (!grouped[key]) {
                grouped[key] = {
                    serviceTypeId: row.service_type_id,
                    serviceTypeName: row.service_type_name,
                    services: [],
                };
            }
            grouped[key].services.push({
                id: row.id,
                name: row.name,
                price: row.price,
                durationMinutes: row.duration_minutes,
            });
        }
        const result = Object.values(grouped);
        res.json({
            ok: true,
            language,
            items: result,
        });
    }
    catch (err) {
        console.error("Kiosk services hiba:", err);
        res.status(500).json({
            ok: false,
            error: "Kiosk services lekérés sikertelen",
        });
    }
});
/**
 * POST /api/kiosk/orders
 * Új kiosk-rendelést/work_order-t hoz létre.
 *
 * Request body példa:
 * {
 *   "locationId": "uuid",
 *   "client": { "name": "Kiss Anna", "phone": "+36..." },
 *   "items": [
 *     { "serviceId": "uuid", "quantity": 1 }
 *   ],
 *   "notes": "Balayage + szárítás",
 *   "source": "kiosk"
 * }
 */
exports.kioskRouter.post("/orders", async (req, res) => {
    const clientIp = req.headers["x-forwarded-for"] ||
        req.socket.remoteAddress ||
        null;
    const { locationId, client, items, notes, source, } = req.body || {};
    if (!locationId || !items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({
            ok: false,
            error: "locationId és legalább egy tétel kötelező",
        });
    }
    const clientName = client?.name || "Kiosk vendég";
    const clientPhone = client?.phone || null;
    const orderSource = source || "kiosk";
    const clientText = clientPhone
        ? `${clientName} (${clientPhone})`
        : clientName;
    const clientNotes = (notes ? notes + " " : "") +
        (clientPhone ? `| Tel: ${clientPhone}` : "") +
        (clientIp ? ` | IP: ${clientIp}` : "");
    const clientRef = clientText;
    const clientInfo = { clientName, clientPhone, clientText };
    try {
        // 1) Szolgáltatások árainak lekérése
        const serviceIds = items.map((i) => i.serviceId);
        const { rows: serviceRows } = await db_1.pool.query(`
      SELECT id, base_price
      FROM services
      WHERE id = ANY($1::uuid[])
    `, [serviceIds]);
        // Map árakhoz
        const priceById = new Map();
        for (const row of serviceRows) {
            priceById.set(row.id, Number(row.base_price) || 0);
        }
        // 2) Összegzés
        let total = 0;
        const normalizedItems = items.map((i) => {
            const quantity = i.quantity && i.quantity > 0 ? i.quantity : 1;
            const unitPrice = priceById.get(i.serviceId) ?? 0;
            const lineTotal = unitPrice * quantity;
            total += lineTotal;
            return {
                ...i,
                quantity,
                unitPrice,
                lineTotal,
            };
        });
        // 3) tranzakció – work_order + work_order_items
        await db_1.pool.query("BEGIN");
        // FIGYELEM: a work_orders/work_order_items sémát igazítsd a sajátodhoz!
        const insertWorkOrderSql = `
      INSERT INTO work_orders
        (location_id, client_name, client_phone, status, source, total_amount, notes, created_at, updated_at)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
      RETURNING id;
    `;
        const { rows: woRows } = await db_1.pool.query(insertWorkOrderSql, [
            locationId,
            clientName,
            clientPhone,
            "NEW", // állapot – ha nálad máshogy hívják, módosítsd
            orderSource,
            total,
            clientNotes,
        ]);
        const workOrderId = woRows[0].id;
        const insertItemSql = `
      INSERT INTO work_order_items
        (work_order_id, service_id, quantity, unit_price, total_price, created_at, updated_at)
      VALUES
        ($1, $2, $3, $4, $5, NOW(), NOW());
    `;
        for (const item of normalizedItems) {
            await db_1.pool.query(insertItemSql, [
                workOrderId,
                item.serviceId,
                item.quantity,
                item.unitPrice,
                item.lineTotal,
            ]);
        }
        await db_1.pool.query("COMMIT");
        res.status(201).json({
            ok: true,
            workOrderId,
            total,
            client: clientInfo,
        });
    }
    catch (err) {
        await db_1.pool.query("ROLLBACK");
        console.error("Kiosk order hiba:", err);
        res.status(500).json({
            ok: false,
            error: "Kiosk rendelés létrehozása sikertelen",
        });
    }
});
