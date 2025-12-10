import React, { useEffect, useState } from "react";
import {
  fetchKioskServices,
  createKioskOrder,
  KioskServiceGroup,
  KioskServiceItem,
} from "../api/kioskApi";

type SelectedItem = {
  service: KioskServiceItem;
  quantity: number;
};

const DEFAULT_LOCATION_ID = "REPLACE_WITH_DEFAULT_LOCATION_UUID"; // ezt írd át a sajátodra

const KioskPage: React.FC = () => {
  const [groups, setGroups] = useState<KioskServiceGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<SelectedItem[]>([]);
  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [successOrderId, setSuccessOrderId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);

    fetchKioskServices({ locationId: DEFAULT_LOCATION_ID, lang: "hu" })
      .then((res) => {
        if (!mounted) return;
        setGroups(res.items || []);
      })
      .catch((err) => {
        console.error(err);
        if (mounted) setError("Nem sikerült betölteni a szolgáltatásokat.");
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const handleToggleService = (service: KioskServiceItem) => {
    setSelected((prev) => {
      const idx = prev.findIndex((p) => p.service.id === service.id);
      if (idx === -1) {
        return [...prev, { service, quantity: 1 }];
      } else {
        // ha már benne van, növeljük a mennyiséget 1-gyel (McDonald's logika)
        const copy = [...prev];
        copy[idx] = {
          ...copy[idx],
          quantity: copy[idx].quantity + 1,
        };
        return copy;
      }
    });
  };

  const handleDecreaseService = (serviceId: string) => {
    setSelected((prev) => {
      const idx = prev.findIndex((p) => p.service.id === serviceId);
      if (idx === -1) return prev;

      const item = prev[idx];
      if (item.quantity <= 1) {
        return prev.filter((p) => p.service.id !== serviceId);
      } else {
        const copy = [...prev];
        copy[idx] = { ...item, quantity: item.quantity - 1 };
        return copy;
      }
    });
  };

  const total = selected.reduce(
    (sum, item) => sum + item.service.price * item.quantity,
    0
  );

  const handleSubmit = async () => {
    if (selected.length === 0) {
      setError("Válassz legalább egy szolgáltatást!");
      return;
    }

    setSubmitting(true);
    setError(null);
    setSuccessOrderId(null);

    try {
      const payload = {
        locationId: DEFAULT_LOCATION_ID,
        client: {
          name: clientName || undefined,
          phone: clientPhone || undefined,
        },
        items: selected.map((item) => ({
          serviceId: item.service.id,
          quantity: item.quantity,
        })),
        notes: notes || undefined,
        source: "kiosk",
      };

      const res = await createKioskOrder(payload);
      setSuccessOrderId(res.workOrderId || null);

      // Visszaállítjuk a kiválasztott tételeket
      setSelected([]);
      setNotes("");
      // ne töröljük feltétlen a nevet/telefont – visszajáró vendégnél kényelmes lehet
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Hiba történt a rendelés során.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="kiosk-root">
        <div className="kiosk-center">Betöltés…</div>
      </div>
    );
  }

  if (error && groups.length === 0) {
    return (
      <div className="kiosk-root">
        <div className="kiosk-center">
          <p>{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="kiosk-root">
      <header className="kiosk-header">
        <div className="kiosk-logo">KLEOSZALON</div>
        <div className="kiosk-title">Érintőképernyős önkiszolgáló</div>
        {/* ide később jöhet nyelvválasztó */}
      </header>

      <main className="kiosk-main">
        <section className="kiosk-services">
          {groups.map((group) => (
            <div key={group.serviceTypeId || "other"} className="kiosk-group">
              {group.serviceTypeName && (
                <h2 className="kiosk-group-title">
                  {group.serviceTypeName.toUpperCase()}
                </h2>
              )}
              <div className="kiosk-services-grid">
                {group.services.map((service) => (
                  <button
                    key={service.id}
                    className="kiosk-service-card"
                    onClick={() => handleToggleService(service)}
                  >
                    <div className="kiosk-service-name">{service.name}</div>
                    {service.durationMinutes && (
                      <div className="kiosk-service-duration">
                        ~ {service.durationMinutes} perc
                      </div>
                    )}
                    <div className="kiosk-service-price">
                      {service.price.toLocaleString("hu-HU")} Ft
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>

        <aside className="kiosk-summary">
          <h2>Összegzés</h2>

          {selected.length === 0 && (
            <p>Válassz szolgáltatásokat a bal oldalon.</p>
          )}

          {selected.length > 0 && (
            <div className="kiosk-summary-list">
              {selected.map((item) => (
                <div
                  key={item.service.id}
                  className="kiosk-summary-item"
                >
                  <div>
                    <div className="kiosk-summary-name">
                      {item.service.name}
                    </div>
                    <div className="kiosk-summary-sub">
                      {item.quantity} ×{" "}
                      {item.service.price.toLocaleString("hu-HU")} Ft
                    </div>
                  </div>
                  <div className="kiosk-summary-actions">
                    <button
                      className="kiosk-qty-btn"
                      onClick={() => handleDecreaseService(item.service.id)}
                    >
                      –
                    </button>
                    <span className="kiosk-summary-qty">
                      {item.quantity}
                    </span>
                    <button
                      className="kiosk-qty-btn"
                      onClick={() => handleToggleService(item.service)}
                    >
                      +
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="kiosk-summary-total">
            <span>Végösszeg:</span>
            <strong>{total.toLocaleString("hu-HU")} Ft</strong>
          </div>

          <div className="kiosk-client-form">
            <label>
              Név (nem kötelező)
              <input
                type="text"
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
              />
            </label>
            <label>
              Telefonszám (opcionális)
              <input
                type="tel"
                value={clientPhone}
                onChange={(e) => setClientPhone(e.target.value)}
              />
            </label>
            <label>
              Megjegyzés
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
              />
            </label>
          </div>

          {error && <div className="kiosk-error">{error}</div>}
          {successOrderId && (
            <div className="kiosk-success">
              Rendelés rögzítve!  
              Azonosító: <strong>{successOrderId}</strong>
            </div>
          )}

          <button
            className="kiosk-submit-btn"
            onClick={handleSubmit}
            disabled={submitting || selected.length === 0}
          >
            {submitting ? "Küldés…" : "Rendelés rögzítése"}
          </button>
        </aside>
      </main>
    </div>
  );
};

export default KioskPage;
