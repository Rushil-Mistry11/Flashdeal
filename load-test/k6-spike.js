// Optional: same test with k6 (https://k6.io).   k6 run load-test/k6-spike.js
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  stages: [
    { duration: '5s', target: 10 },
    { duration: '10s', target: 100 }, // spike
    { duration: '5s', target: 0 },
  ],
};

export default function () {
  const res = http.post('http://localhost:3000/api/claim', JSON.stringify({ userId: `k6-${__VU}-${__ITER}`, dealId: 'deal-001' }), {
    headers: { 'Content-Type': 'application/json' },
  });
  check(res, { 'accepted or throttled': (r) => r.status === 202 || r.status === 429 });
}
