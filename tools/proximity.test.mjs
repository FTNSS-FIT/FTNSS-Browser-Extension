// The network boundary. Everything the README promises is enforced here or nowhere, so these tests
// are less about the happy path than about what the request is NOT allowed to contain.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gymsNear, describeDistance, SEARCH_RADIUS_METRES } from '../src/lib/proximity.js';
import { toTransmittablePoint } from '../src/lib/geo.js';

const ENDPOINT = 'https://example.test/api/proximity';

/**
 * Captures the request and replies with whatever the test wants.
 *
 * A well-formed payload gets `searchRadiusMetres` filled in, because a real server always sends it
 * and the client now requires it on every response — including an empty one, where the radius is
 * the entire content of what the panel then says. Tests that care about the radius set it
 * explicitly and this leaves them alone.
 */
function stub(payload, { status = 200, capture = {} } = {}) {
  const body =
    payload != null && typeof payload === 'object' && Array.isArray(payload.gyms) &&
    payload.searchRadiusMetres === undefined
      ? { ...payload, searchRadiusMetres: 5000 }
      : payload;
  return async (url, options) => {
    capture.url = url;
    capture.options = options;
    capture.body = options?.body == null ? null : JSON.parse(options.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      // text(), not json() — the client reads the body as text so it can bound the size before
      // parsing it. A stub that only offers json() would let an unbounded parse back in unnoticed.
      text: async () => JSON.stringify(body),
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
  assert.deepEqual(
    Object.keys(answer.gyms[0]).sort(),
    ['city', 'distanceMetres', 'hours', 'id', 'name', 'passes', 'path', 'slug'],
  );
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

test('a partly-unreadable answer is refused, not quietly trimmed', async () => {
  // This asserted that bad entries were FILTERED and the good ones shown, until review pointed out
  // the discarded entry could be the CLOSEST — at which point the panel labels a farther gym
  // "nearest" with complete confidence. A ranked list cannot survive an unknown number of missing
  // members. Partial data is fine when counting; it is not fine when ranking.
  for (const bad of [
    { ...GYM, name: '' },
    { ...GYM, distanceMetres: SEARCH_RADIUS_METRES + 1 },
    { ...GYM, distanceMetres: 'near' },
  ]) {
    const answer = await gymsNear({ lat: 43.6425, lon: -79.3875 }, {
      endpoint: ENDPOINT,
      fetchImpl: stub({ gyms: [GYM, bad, GYM] }),
    });
    assert.equal(answer.status, 'error', `${JSON.stringify(bad)} must poison the response`);
  }
});

test('a well-formed answer is still capped at six', async () => {
  const answer = await gymsNear({ lat: 43.6425, lon: -79.3875 }, {
    endpoint: ENDPOINT,
    fetchImpl: stub({ gyms: Array.from({ length: 12 }, (unused, i) => ({ ...GYM, distanceMetres: 100 + i })) }),
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

test('a distance is marked as an estimate, never asserted as a bound', () => {
  // Four versions of this: "390 m", "about 400 m", "under 500 m", nothing — and now a marked
  // estimate. The distinction that finally worked is between a CLAIM and an APPROXIMATION. The
  // query point is a 250m cell, so a reported 499m can be ~674m from the listing: "under 500 m"
  // asserts a bound the grid can falsify, while "~500 m" asserts an approximation it cannot.
  //
  // The tilde is load-bearing, so assert it is always there.
  for (const metres of [0, 120, 384, 499, 1094, 3707, 4999]) {
    assert.match(describeDistance(metres), /^~/, `${metres}m must be marked as approximate`);
  }
  assert.equal(describeDistance(384), '~400 m');
  assert.equal(describeDistance(1094), '~1.1 km');
  assert.equal(describeDistance(3707), '~3.7 km');
  // Never "~0 m", which would read as "you are standing in it".
  assert.equal(describeDistance(20), '~100 m');
  assert.equal(describeDistance(-1), '');
  assert.equal(describeDistance(NaN), '');
});

test('a missing distance is not zero distance', async () => {
  // `Number(null)` is 0, finite and non-negative, so a gym whose distance the server failed to
  // compute rendered as "0 m" — the most confident possible statement built from the absence of an
  // answer.
  for (const bad of [null, undefined, '', '380', {}]) {
    const answer = await gymsNear({ lat: 43.6425, lon: -79.3875 }, {
      endpoint: ENDPOINT,
      fetchImpl: stub({ gyms: [{ ...GYM, distanceMetres: bad }] }),
    });
    assert.equal(answer.status, 'error', `${JSON.stringify(bad)} must not become a distance`);
  }
});

test('an empty list without a stated radius is not evidence of an empty 5km', async () => {
  // `{ gyms: [] }` alone became "no FTNSS gyms within 5km" — a claim about five kilometres made
  // from a response that never mentioned a distance. An empty answer needs the radius MORE than a
  // full one does, because the radius is the whole content of what we then say.
  const answer = await gymsNear({ lat: 43.6425, lon: -79.3875 }, {
    endpoint: ENDPOINT,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"gyms":[]}' }),
  });
  assert.equal(answer.status, 'error');
  assert.equal(answer.reason, 'radius mismatch');
});

test('the six shown are the six nearest, not the first six sent', async () => {
  // The panel says "nearest", and that word was underwritten entirely by the server's ordering — so
  // a response listing gyms by name would have had its closest entry discarded at position seven.
  const far = Array.from({ length: 8 }, (unused, i) => ({ ...GYM, name: `Far ${i}`, distanceMetres: 4000 + i }));
  const near = { ...GYM, name: 'Closest', distanceMetres: 120 };
  const answer = await gymsNear({ lat: 43.6425, lon: -79.3875 }, {
    endpoint: ENDPOINT,
    fetchImpl: stub({ gyms: [...far, near] }),
  });
  assert.equal(answer.gyms[0].name, 'Closest');
  assert.deepEqual(
    answer.gyms.map((g) => g.distanceMetres),
    [...answer.gyms.map((g) => g.distanceMetres)].sort((a, b) => a - b),
  );
});

test('an unreadable answer is not an answer of "nothing here"', async () => {
  // A non-empty array whose every entry failed validation used to return `empty`, so a broken
  // server produced the panel's most reassuring sentence from evidence that said nothing of the
  // kind. An empty panel reads as "FTNSS has no gyms here", which is a claim.
  const answer = await gymsNear({ lat: 43.6425, lon: -79.3875 }, {
    endpoint: ENDPOINT,
    fetchImpl: stub({ gyms: [{ nope: true }, { also: 'nope' }] }),
  });
  assert.equal(answer.status, 'error');

  // A genuinely empty list is still a success.
  const none = await gymsNear({ lat: 43.6425, lon: -79.3875 }, { endpoint: ENDPOINT, fetchImpl: stub({ gyms: [] }) });
  assert.equal(none.status, 'empty');
});

test('an answer computed over a different radius is refused', async () => {
  // Not a smaller answer to our question — an answer to someone else's. Rendering it as "within
  // 5km" would assert a bound the server never applied.
  const answer = await gymsNear({ lat: 43.6425, lon: -79.3875 }, {
    endpoint: ENDPOINT,
    fetchImpl: stub({ gyms: [GYM], searchRadiusMetres: 25000 }),
  });
  assert.equal(answer.status, 'error');
  assert.equal(answer.reason, 'radius mismatch');
});

test('the endpoint allowlist is read from the manifest, not restated', async () => {
  const { endpointProblem } = await import('../src/lib/storage.js');
  const manifest = ['https://ftnss.fit/*', 'http://localhost/*'];

  assert.equal(endpointProblem('https://ftnss.fit/api/proximity', manifest), null);
  assert.equal(endpointProblem('http://localhost:8787/api/proximity', manifest), null);

  // Chrome refuses to grant a permission for an undeclared origin, and refuses at the point of
  // asking — so any other https URL was accepted here, silently failed to be granted, and left a
  // saved endpoint that could never work.
  assert.match(endpointProblem('https://evil.test/api/proximity', manifest), /not one this extension is allowed/);
  assert.match(endpointProblem('https://www.ftnss.fit/api/proximity', manifest), /not one this extension is allowed/);

  // Still enforced before the allowlist is consulted.
  assert.match(endpointProblem('http://ftnss.fit/api/proximity', manifest), /https/);
  assert.match(endpointProblem('not a url', manifest), /not a URL/);
});

test('an oversized response is refused before it is parsed', async () => {
  // response.json() reads to completion, so a gigabyte of JSON is parsed in full before any check
  // gets a look — and by then the abort timer has done its job, because the bytes did arrive. The
  // freeze happens in the parse, not the wait.
  const huge = 'x'.repeat(300 * 1024);
  const answer = await gymsNear({ lat: 43.6425, lon: -79.3875 }, {
    endpoint: ENDPOINT,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => `{"padding":"${huge}"}` }),
  });
  assert.equal(answer.status, 'error');
  assert.equal(answer.reason, 'response too large');
});

test('an absurd number of gyms is a contract violation, not a list to trim', async () => {
  const answer = await gymsNear({ lat: 43.6425, lon: -79.3875 }, {
    endpoint: ENDPOINT,
    // Sized to stay UNDER the byte limit, so this exercises the count check rather than being
    // caught by the size check first — two separate bounds, and a test that cannot tell them apart
    // is only testing whichever fires soonest.
    fetchImpl: stub({ gyms: Array.from({ length: 500 }, () => GYM) }),
  });
  // Mapping and sorting five thousand entries before deciding not to trust them is doing the
  // expensive work first.
  assert.equal(answer.status, 'error');
  assert.equal(answer.reason, 'too many gyms');
});

test('the byte limit stops the read and aborts, rather than reporting afterwards', async () => {
  // text() moved the problem rather than fixing it: it buffers the whole body first, so the
  // advertised limit was checked against memory already committed. The point is not to avoid
  // holding a large string — it is to stop receiving one.
  let aborted = false;
  const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
  let served = 0;
  const streaming = async (url, options) => {
    options.signal.addEventListener('abort', () => { aborted = true; });
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            served += 1;
            // Far more than the limit if it were ever allowed to finish.
            return served > 1000 ? { done: true } : { done: false, value: chunk };
          },
        }),
      },
    };
  };
  const answer = await gymsNear({ lat: 43.6425, lon: -79.3875 }, { endpoint: ENDPOINT, fetchImpl: streaming });
  assert.equal(answer.status, 'error');
  assert.equal(answer.reason, 'response too large');
  assert.ok(aborted, 'the connection must be aborted, not drained');
  // 256KiB at 64KiB a chunk: it must stop within a handful, not read a thousand.
  assert.ok(served < 10, `stopped after ${served} chunks`);
});

test('a cancelled lookup is cancelled, not timed out', async () => {
  // A caller aborts because the answer stopped being wanted — the endpoint changed, a newer lookup
  // replaced it. Calling that a timeout would put "timeout" in an export for a request nobody was
  // waiting for.
  const controller = new AbortController();
  controller.abort();
  const answer = await gymsNear({ lat: 43.6425, lon: -79.3875 }, {
    endpoint: ENDPOINT,
    signal: controller.signal,
    fetchImpl: async () => { throw new Error('should not be reached'); },
  });
  assert.equal(answer.status, 'error');
  assert.equal(answer.reason, 'cancelled');
});

test("a caller's abort stops a request already in flight", async () => {
  const controller = new AbortController();
  const hanging = async (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const pending = gymsNear({ lat: 43.6425, lon: -79.3875 }, {
    endpoint: ENDPOINT,
    signal: controller.signal,
    fetchImpl: hanging,
  });
  controller.abort();
  assert.equal((await pending).reason, 'cancelled');
});

test('an over-long path is rejected, never truncated into a different link', async () => {
  // text() truncates, which is right for a name and wrong for a path: a truncated path is still a
  // syntactically valid path, so cutting it at the cap yields something that passes every check and
  // points at a DIFFERENT gym page. "Too long to trust" must not become "a confident wrong link".
  const long = `/book/gyms/ca/ontario/${'x'.repeat(200)}/${'y'.repeat(200)}-gym`;
  const answer = await gymsNear({ lat: 43.6425, lon: -79.3875 }, {
    endpoint: ENDPOINT,
    fetchImpl: stub({ gyms: [{ ...GYM, path: long }] }),
  });
  assert.equal(answer.status, 'ok', 'the gym itself is still fine — only its link is refused');
  assert.equal(answer.gyms[0].path, null, 'no path rather than a shortened one');

  // A real-world-length path survives untouched.
  const real = '/book/gyms/ca/ontario/toronto/hone-fitness-st-clair-bathurst-toronto';
  const ok = await gymsNear({ lat: 43.6425, lon: -79.3875 }, {
    endpoint: ENDPOINT,
    fetchImpl: stub({ gyms: [{ ...GYM, path: real }] }),
  });
  assert.equal(ok.gyms[0].path, real);
});

test('a malformed price is dropped, not rendered', async () => {
  // A wrong number beside a gym is a claim about what someone will be charged. Every one of these
  // is a plausible thing a half-migrated endpoint sends.
  const bad = [
    { kind: 'day', price: 'free', currency: 'CAD' },
    { kind: 'day', price: -5, currency: 'CAD' },
    { kind: 'day', price: 20 },                        // no currency
    { kind: 'day', price: 20, currency: 'dollars' },   // not ISO-shaped
    { kind: 'fortnight', price: 20, currency: 'CAD' }, // not a canonical kind
    { price: 20, currency: 'CAD' },                    // no kind at all
  ];
  const answer = await gymsNear({ lat: 43.6425, lon: -79.3875 }, {
    endpoint: ENDPOINT,
    fetchImpl: stub({ gyms: [{ ...GYM, passes: [...bad, { kind: 'WEEK', price: 45.5, currency: 'cad' }] }] }),
  });
  assert.deepEqual(answer.gyms[0].passes, [{ kind: 'week', price: 45.5, currency: 'CAD' }]);
});

test('the legacy 90day label is refused; quarter is canonical', async () => {
  // Both exist in the DB enum and only `quarter` has rows or meaning — it is the 90-day membership
  // that Pennsylvania's three-month cap on prepaid contracts makes necessary. Accepting `90day`
  // would let a stale producer populate a duration the rest of the platform cannot see.
  const answer = await gymsNear({ lat: 43.6425, lon: -79.3875 }, {
    endpoint: ENDPOINT,
    fetchImpl: stub({ gyms: [{ ...GYM, passes: [
      { kind: '90day', price: 200, currency: 'USD' },
      { kind: 'quarter', price: 210, currency: 'USD' },
    ] }] }),
  });
  assert.deepEqual(answer.gyms[0].passes, [{ kind: 'quarter', price: 210, currency: 'USD' }]);
});

test('passes sort canonically, with quarter between month and year', async () => {
  // The panel presents durations as an ordered set, so it must not depend on an ordering it did
  // not compute — and the canonical order is not alphabetical or numeric.
  const answer = await gymsNear({ lat: 43.6425, lon: -79.3875 }, {
    endpoint: ENDPOINT,
    fetchImpl: stub({ gyms: [{ ...GYM, passes: [
      { kind: 'year', price: 700, currency: 'USD' },
      { kind: 'quarter', price: 210, currency: 'USD' },
      { kind: 'day', price: 20, currency: 'USD' },
      { kind: 'month', price: 90, currency: 'USD' },
      { kind: 'weekend', price: 40, currency: 'USD' },
      { kind: 'week', price: 45, currency: 'USD' },
    ] }] }),
  });
  assert.deepEqual(
    answer.gyms[0].passes.map((p) => p.kind),
    ['day', 'weekend', 'week', 'month', 'quarter', 'year'],
  );
});

test('open-now comes from the server and is never computed here', async () => {
  // The gym's timezone is a fact the server has and this extension does not. A traveller browsing a
  // hotel in another country is exactly the case where the browser's clock gives a wrong answer —
  // same person, same moment, different result depending on where they are sitting.
  const answer = await gymsNear({ lat: 43.6425, lon: -79.3875 }, {
    endpoint: ENDPOINT,
    fetchImpl: stub({ gyms: [{ ...GYM, hours: { open: true, opensAt: '06:00', closesAt: '22:00' } }] }),
  });
  assert.deepEqual(answer.gyms[0].hours, { open: true, opensAt: '06:00', closesAt: '22:00' });

  // Junk times are refused rather than displayed.
  const junk = await gymsNear({ lat: 43.6425, lon: -79.3875 }, {
    endpoint: ENDPOINT,
    fetchImpl: stub({ gyms: [{ ...GYM, hours: { open: true, opensAt: '25:99', closesAt: 'later' } }] }),
  });
  assert.deepEqual(junk.gyms[0].hours, { open: true, opensAt: null, closesAt: null });
});

test('an unsayable open state stays unsayable and does not become "closed"', async () => {
  // The finding this covers: `open` was coerced with `=== true`, so a response carrying real
  // opening times but no usable `open` flag produced a gym labelled CLOSED — a confident negative
  // derived from the absence of evidence, and the negative is the one a person acts on by walking
  // somewhere else.
  for (const open of [undefined, null, 'yes', 1, {}]) {
    const answer = await gymsNear({ lat: 43.6425, lon: -79.3875 }, {
      endpoint: ENDPOINT,
      fetchImpl: stub({ gyms: [{ ...GYM, hours: { open, opensAt: '06:00', closesAt: '22:00' } }] }),
    });
    assert.deepEqual(
      answer.gyms[0].hours,
      { open: null, opensAt: '06:00', closesAt: '22:00' },
      `open: ${JSON.stringify(open)} must not resolve to false`,
    );
  }

  // `false` still means false. The point is to stop inventing it, not to stop believing it.
  const shut = await gymsNear({ lat: 43.6425, lon: -79.3875 }, {
    endpoint: ENDPOINT,
    fetchImpl: stub({ gyms: [{ ...GYM, hours: { open: false, opensAt: '06:00', closesAt: '22:00' } }] }),
  });
  assert.equal(shut.gyms[0].hours.open, false);

  // And a record with neither a usable flag nor a usable time is still dropped whole — there is
  // nothing left in it to show.
  const empty = await gymsNear({ lat: 43.6425, lon: -79.3875 }, {
    endpoint: ENDPOINT,
    fetchImpl: stub({ gyms: [{ ...GYM, hours: { open: 'maybe', opensAt: 'later' } }] }),
  });
  assert.equal(empty.gyms[0].hours, null);
});

test('a filter this answer cannot apply is dropped, not merely greyed', async () => {
  const { prunedFilters } = await import('../src/popup/panel.js');
  const withHours = [{ hours: { open: true }, passes: [{ kind: 'day' }] }];
  const unknownHours = [{ hours: { open: null, opensAt: '06:00' }, passes: [{ kind: 'day' }] }];

  // The bug: filter state outlives a search. Pressed on one page, inapplicable on the next — the
  // chip greys out while STILL PRESSED, so it filters every row away, reports "no gym near here is
  // open right now", and cannot be switched off, because a disabled button fires no handler. A dead
  // end containing a false statement.
  assert.deepEqual(
    prunedFilters(unknownHours, { openNowOnly: true, selectedKind: 'day' }),
    { openNowOnly: false, selectedKind: 'day' },
  );

  // An applicable filter is left alone — pruning must not undo a choice the answer CAN honour.
  assert.deepEqual(
    prunedFilters(withHours, { openNowOnly: true, selectedKind: 'day' }),
    { openNowOnly: true, selectedKind: 'day' },
  );

  // Same rule for pass kinds, and `null` survives as `null` rather than becoming a selection.
  assert.deepEqual(
    prunedFilters(withHours, { openNowOnly: false, selectedKind: 'year' }),
    { openNowOnly: false, selectedKind: null },
  );
  assert.deepEqual(
    prunedFilters([], { openNowOnly: true, selectedKind: 'day' }),
    { openNowOnly: false, selectedKind: null },
  );

  // A known-CLOSED gym still makes the filter applicable: "nothing is open right now" is then a
  // statement about the world, which is the one case the empty-list message may be shown.
  assert.equal(
    prunedFilters([{ hours: { open: false } }], { openNowOnly: true }).openNowOnly,
    true,
  );
});
