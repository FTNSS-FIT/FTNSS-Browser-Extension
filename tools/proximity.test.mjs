// The network boundary. Everything the README promises is enforced here or nowhere, so these tests
// are less about the happy path than about what the request is NOT allowed to contain.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gymsNear, describeDistance, SEARCH_RADIUS_METRES } from '../src/lib/proximity.js';
import { toTransmittablePoint } from '../src/lib/geo.js';

const ENDPOINT = 'https://example.test/api/proximity';

/** Captures the request and replies with whatever the test wants. */
function stub(payload, { status = 200, capture = {} } = {}) {
  return async (url, options) => {
    capture.url = url;
    capture.options = options;
    capture.body = options?.body == null ? null : JSON.parse(options.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    };
  };
}

const GYM = { id: 'g1', name: 'Iron & Oak', slug: 'iron-oak', city: 'Toronto', distanceMetres: 380 };

test('the coordinate is rounded before it leaves, whatever the caller passed', async () => {
  // THE claim. A caller handing over an exact hotel position must not be able to transmit one, and
  // that has to be true of this function rather than of the discipline of its callers.
  const capture = {};
  const exact = { lat: 43.642566, lon: -79.387057 };
  await gymsNear(exact, { endpoint: ENDPOINT, fetchImpl: stub({ gyms: [GYM] }, { capture }) });

  const expected = toTransmittablePoint(exact.lat, exact.lon);
  assert.deepEqual(capture.body, { lat: expected.lat, lon: expected.lon });
  assert.notEqual(capture.body.lat, exact.lat, 'the exact latitude must not survive');
  assert.notEqual(capture.body.lon, exact.lon, 'the exact longitude must not survive');
});

test('the request body contains the coordinate and nothing else', async () => {
  // A body built by spreading a caller's object is a body whose contents depend on every caller
  // forever. There is no page identity in scope to send, and this asserts none appears.
  const capture = {};
  await gymsNear(
    { lat: 43.6425, lon: -79.3875, url: 'https://booking.com/hotel/riu-plaza', hotel: 'Riu Plaza' },
    { endpoint: ENDPOINT, fetchImpl: stub({ gyms: [] }, { capture }) },
  );
  assert.deepEqual(Object.keys(capture.body).sort(), ['lat', 'lon']);
  assert.equal(JSON.stringify(capture.body).includes('booking'), false);
  assert.equal(JSON.stringify(capture.body).includes('Riu'), false);
});

test('no cookies, no redirects, no cache', async () => {
  // `credentials: omit` is the point rather than a tidy-up: an authenticated request re-identifies
  // the person, which is exactly what rounding the coordinate was for. A coarse point alongside a
  // session cookie is a privacy guarantee cancelled by its own transport.
  const capture = {};
  await gymsNear({ lat: 43.6425, lon: -79.3875 }, { endpoint: ENDPOINT, fetchImpl: stub({ gyms: [] }, { capture }) });
  assert.equal(capture.options.credentials, 'omit');
  assert.equal(capture.options.redirect, 'error', 'do not follow a redirect to an unagreed host');
  assert.equal(capture.options.cache, 'no-store');
  assert.equal(capture.options.method, 'POST');
});

test('coordinates in the response are dropped, not rendered', async () => {
  // The agreed shape has no lat/lon. If the server sends them anyway — a rollback, a different
  // deploy, an endpoint someone repointed — this is where they stop.
  const answer = await gymsNear({ lat: 43.6425, lon: -79.3875 }, {
    endpoint: ENDPOINT,
    fetchImpl: stub({ gyms: [{ ...GYM, latitude: 43.6, longitude: -79.4, contact_email: 'a@b.c' }] }),
  });
  assert.equal(answer.status, 'ok');
  assert.deepEqual(Object.keys(answer.gyms[0]).sort(), ['city', 'distanceMetres', 'id', 'name', 'slug']);
  assert.equal(JSON.stringify(answer.gyms).includes('a@b.c'), false);
});

test('empty is a success, not an error', async () => {
  // Early in a marketplace this is the true answer nearly everywhere on Earth, and a panel that
  // renders "something went wrong" over its most common correct answer teaches people to ignore it.
  const answer = await gymsNear({ lat: 38.7115, lon: -9.1287 }, { endpoint: ENDPOINT, fetchImpl: stub({ gyms: [] }) });
  assert.equal(answer.status, 'empty');
});

test('no endpoint is its own outcome', async () => {
  const answer = await gymsNear({ lat: 43.6425, lon: -79.3875 }, { endpoint: '' });
  assert.equal(answer.status, 'unconfigured');
});

test('a junk response is an error, not a half-rendered panel', async () => {
  for (const payload of [null, {}, { gyms: 'lots' }, { gyms: {} }]) {
    const answer = await gymsNear({ lat: 43.6425, lon: -79.3875 }, { endpoint: ENDPOINT, fetchImpl: stub(payload) });
    assert.equal(answer.status, 'error', `${JSON.stringify(payload)} should not parse`);
  }
});

test('an HTTP failure never reaches the parser', async () => {
  const answer = await gymsNear({ lat: 43.6425, lon: -79.3875 }, {
    endpoint: ENDPOINT,
    fetchImpl: stub({ gyms: [GYM] }, { status: 500 }),
  });
  assert.equal(answer.status, 'error');
});

test('unusable and out-of-range entries are dropped, and the list is capped', async () => {
  const answer = await gymsNear({ lat: 43.6425, lon: -79.3875 }, {
    endpoint: ENDPOINT,
    fetchImpl: stub({
      gyms: [
        GYM,
        { ...GYM, name: '' },                                     // no name
        { ...GYM, distanceMetres: SEARCH_RADIUS_METRES + 1 },      // outside the radius we asked for
        { ...GYM, distanceMetres: 'near' },                        // not a number
        ...Array.from({ length: 9 }, () => GYM),
      ],
    }),
  });
  // A client that trusts a count it did not enforce is not enforcing one.
  assert.equal(answer.gyms.length, 6);
});

test('a network failure and a timeout are distinguishable to us', async () => {
  const boom = async () => { throw new Error('offline'); };
  assert.equal((await gymsNear({ lat: 43.6425, lon: -79.3875 }, { endpoint: ENDPOINT, fetchImpl: boom })).reason, 'network');

  const abort = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  assert.equal((await gymsNear({ lat: 43.6425, lon: -79.3875 }, { endpoint: ENDPOINT, fetchImpl: abort })).reason, 'timeout');
});

test('distances never claim more precision than the grid supports', () => {
  // The point sent was rounded to a 250m cell, so "2.43 km" would be a precision claim the
  // coordinate cannot support. "about" is doing honest work.
  assert.equal(describeDistance(384), '380 m');
  assert.equal(describeDistance(2430), 'about 2.4 km');
  assert.equal(describeDistance(-1), '');
  assert.equal(describeDistance(NaN), '');
});
