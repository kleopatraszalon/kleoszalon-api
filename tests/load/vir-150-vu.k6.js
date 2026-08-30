import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'https://kleoszalon-api-1.onrender.com').replace(/\/$/, '');
const BOOKING_LOCATION_ID = __ENV.BOOKING_LOCATION_ID || '';
const BOOKING_SERVICE_IDS = __ENV.BOOKING_SERVICE_IDS || '';
const errors = new Rate('vir_errors');
const apiLatency = new Trend('vir_api_latency', true);

export const options = {
  scenarios: {
    vir_150_concurrent: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 150),
      duration: __ENV.DURATION || '5m',
      gracefulStop: '30s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    vir_errors: ['rate<0.01'],
    http_req_duration: ['p(95)<800', 'p(99)<1500'],
  },
};

function record(res, expected = 200) {
  apiLatency.add(res.timings.duration);
  const ok = check(res, {
    [`status ${expected}`]: (r) => r.status === expected,
    'not rate-limited': (r) => r.status !== 429,
    'no server error': (r) => r.status < 500,
  });
  errors.add(!ok);
}

export default function () {
  const health = http.get(`${BASE_URL}/api/health`, { tags: { endpoint: 'health' } });
  record(health);

  const bookingHealth = http.get(`${BASE_URL}/api/public/booking/health`, {
    tags: { endpoint: 'booking-health' },
  });
  record(bookingHealth);

  const catalogUrl = BOOKING_LOCATION_ID
    ? `${BASE_URL}/api/public/booking/catalog?location_id=${encodeURIComponent(BOOKING_LOCATION_ID)}`
    : `${BASE_URL}/api/public/booking/catalog`;
  const catalog = http.get(catalogUrl, { tags: { endpoint: 'booking-catalog' } });
  record(catalog);

  if (BOOKING_LOCATION_ID && BOOKING_SERVICE_IDS) {
    const date = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const availability = http.get(
      `${BASE_URL}/api/public/booking/availability?location_id=${encodeURIComponent(BOOKING_LOCATION_ID)}&date=${date}&service_ids=${encodeURIComponent(BOOKING_SERVICE_IDS)}`,
      { tags: { endpoint: 'booking-availability' } },
    );
    record(availability);
  }

  sleep(Math.random() * 1.5 + 0.5);
}
