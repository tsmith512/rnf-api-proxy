
addEventListener("fetch", event => {
  event.respondWith(handleIncoming(event.request))
})

async function handleIncoming(request) {
  let responseHeaders = new Headers({
    'Access-Control-Allow-Origin': '*'
  });

  if (['GET', 'HEAD', 'OPTIONS'].indexOf(request.method) === -1) {
    responseHeaders.set('Content-Type', 'text/plain');
    return new Response("Method not allowed", {status: 405, headers: responseHeaders});
  }

  if (!SERVICE_HOST) {
    responseHeaders.set('Content-Type', 'text/plain');
    return new Response("Backend endpoint not specified", {status: 500, headers: responseHeaders});
  }

  const requestURL = new URL(request.url);
  const path = requestURL.pathname;

  // Flag whether or not to verify we're on a trip
  let allowRequest = false;

  // Do we need to verify that a trip is active for the current request?
  let verifyTrip = false;

  if (path === '/api/location/latest') {
    // For latest update, allow the endpoint but only if traveling
    verifyTrip = true;
    allowRequest = true;
  }
  else if (path.match(/\/api\/location\/history\/timestamp\/\d+$/)) {
    // Update for specific timestamp, allow if traveling
    verifyTrip = true;
    allowRequest = true;
  }
  else if (path.match(/\/api\/trips(\/\d+)?$/)) {
    // Pull a trip line, this is fine
    allowRequest = true;
  }

  if (!allowRequest) {
    responseHeaders.set('Content-Type', 'text/plain');
    return new Response("Endpoint not in allowlist", {status: 403, headers: responseHeaders});
  }

  // Let's see if we've looked this up before:
  // (see https://developers.cloudflare.com/workers/examples/cache-api)
  const cacheKey = new Request(requestURL.toString(), request);
  const cache = caches.default;

  const cachedResponse = await cache.match(cacheKey)
  if (cachedResponse) {
    return cachedResponse;
  }
  // #womp. No cached value, go grab it.

  // Go to the super-secret data hideout and get the info
  const newURL = `${SERVICE_HOST}${requestURL.pathname}`;
  const rawResponse = await fetch(newURL);
  const rawContent = await rawResponse.text();

  let content = null;
  try {
    content = JSON.parse(rawContent);
  }
  catch (e) {
    responseHeaders.set('Content-Type', 'text/plain');
    return new Response("Invalid JSON from API", {status: 502, headers: responseHeaders});
  }

  // Do we need to verify that there's a trip associated with this payload?
  if (verifyTrip && content.trips?.length < 1) {
    return new Response("No valid trip for this time", {status: 403, headers: responseHeaders})
  }

  // Clean up and simplify the line
  if (content?.line?.coordinates?.length > 0) {
    // Keep our houses a secret.
    content.line.coordinates.forEach((coords) => {
      // Anything in Austin is at the Capitol
      if (
        30.1457209625174 < coords[1] &&
        30.427361303226743 > coords[1] &&
        -97.92835235595705 < coords[0] &&
        -97.58090972900392 > coords[0]
      ) {
        coords[0] = -97.74053500;
        coords[1] = 30.27418300;
      }
      // Anything in Tulsa is at the Center of the Universe
      else if (
        -96.0071182 < coords[0] &&
        36.1655966 > coords[1] &&
        -95.7616425 > coords[0] &&
        35.9557765 < coords[1]
      ) {
        coords[0] = -95.99151600;
        coords[1] = 36.15685900;
      }
    });

    // Remove stationary check-ins
    const simplified = content.line.coordinates.filter((el, index, array) => {
      if (index < 1) { return true; }
      return (array[index][0] !== array[index - 1][0]) && (array[index][1] !== array[index - 1][1]);
    });
    content.line.coordinates = simplified;
  }

  // Let's cache some of these responses if we're able:
  // 1 The index of trips doesn't change often
  // 2 Once a trip is over, it doesn't change at all
  // 3 The "location from timestamp" won't change after it has been submitted,
  //   so we need to check if response-time is close to requested-time.

  let cacheable = false; // false, or a number of days.

  // #1: Trips index
  if (path === '/api/trips') {
    cacheable = 1;
  }

  // #2: Trip history
  else if (path.match(/\/api\/trips\/\d+$/)) {
    cacheable = (content?.endtime < Math.floor(Date.now() / 1000)) ? 365 : false;
  }

  // #3: Location for a given time
  else if (path.match(/\/api\/location\/history\/timestamp\/\d+$/)) {
    const difference = (content?.time - path.match(/\d+/)[0]);

    if (Number.isInteger(difference) && (Math.abs(difference)/3600) < 60) {
      cacheable = 365;
    }
  }

  if (cacheable) {
    responseHeaders.set('X-Cache-Debug', `Cacheable. Target expiration ${cacheable} days. Fetched at ${Math.floor(Date.now() / 1000)}`);
    responseHeaders.set('Cache-Control', `public, max-age=${cacheable * 24 * 60 * 60}`);
  }

  if (rawResponse.status == 200) {
    const finalResponse = new Response(JSON.stringify(content), {status: 200, headers: responseHeaders});

    // @TODO: event.waitUntil will allow you to dispatch the response and cache
    // it async after. Do that.
    if (cacheable) {
      await cache.put(cacheKey, finalResponse.clone());
    }

    return finalResponse;
  }
}
