# Sxyprn relay

This small Node service handles only Sxyprn search and post-detail requests for
Liszt. It uses the existing `sxyprn` package outside Hatchable, where its
requests can leave from a country that Sxyprn accepts.

## Run it

Use Node.js 24. From this directory, install the package and start the service:

```sh
npm install
npm start
```

The host must provide `SXYPRN_RELAY_SECRET` as a private setting and `PORT` if
it does not supply that value itself. Do not put the secret in this repository.
The service listens on `0.0.0.0` and returns only the fields Liszt uses.

## Choose and verify a host

Choose a host that can keep its outgoing requests in one fixed country. Spain is
the first country to test because one request from there succeeded; that single
success does not prove the route will stay available. Before connecting
Hatchable, verify the host's outgoing address country using the host's own
console or an IP-country lookup, then call `/v1/search` through this relay and
confirm that Sxyprn returns a real result. The Sxyprn response is the pass/fail
check; country lookup is only diagnostic. Repeat both checks after the host
changes its region or outgoing address.

Do not automatically rotate addresses or countries. If Sxyprn blocks the
relay, the Hatchable client records a sanitized failure and its circuit breaker
pauses repeated requests.

Hosting setup and direct relay checks are owner-run. An authorized agent may
inspect the resulting Hatchable logs through already connected read-only tools,
following `AGENTS.md`; a successful local test or country lookup alone does not
verify the live integration.

## Connect Hatchable

In Hatchable's secret settings, set:

- `SXYPRN_RELAY_URL` to the relay's HTTPS origin, without a path.
- `SXYPRN_RELAY_SECRET` to the same private value used by the relay host.

The relay accepts authenticated `POST /v1/search` requests with `{"query":"..."}`
and `POST /v1/details` requests with a validated Sxyprn post URL. It rejects
other destinations and does not expose an endpoint for arbitrary fetches.

Search and detail requests share one active package call and a waiting queue of
at most 32 requests. A full queue returns HTTP 503 (busy). The 15-second request
limit includes queue time; expired waiting requests are removed before calling
the package. Each package call runs in a separate worker. On timeout, the relay
returns HTTP 504 and terminates the worker. The next call starts only after that
worker has exited.
