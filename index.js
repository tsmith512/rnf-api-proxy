
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

  if (rawResponse.status == 200) {
    responseHeaders.set('Content-Type', 'text/json');
    return new Response(JSON.stringify(content), {status: 200, headers: responseHeaders});
  }
}
