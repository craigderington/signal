# Owned platform architecture

## Product boundary

Build an independent B2B advertising and consumer lead platform. Simpli.fi is a reference for capabilities, not the mandatory backend. The application operator owns campaign management, native ad serving, tracking, geofencing logic, attribution, lead processing, and reporting. Licensed data and access to someone else's inventory remain separate commercial inputs.

## Implemented local slice

```mermaid
flowchart LR
  Admin[Client workspace] --> Campaign[Campaign + geofence rules]
  Publisher[Participating publisher] --> Decision[Native ad selector]
  Campaign --> Decision
  Decision --> Creative[Isolated creative frame]
  Creative --> Pixel[Signed impression + click]
  Pixel --> Ledger[Idempotent budget ledger]
  Pixel --> Landing[Customer landing page]
  Landing --> Consent[Consent-aware tracker]
  Consent --> Queue[Encrypted durable lookup job]
  Queue --> Identity[Replaceable licensed identity gateway]
  Identity --> Validation[Contact validation]
  Validation --> Eligibility[Match + permission + suppression checks]
  Eligibility --> Offer[Personalized offer draft]
  Offer --> Review[Explicit delivery action]
```

One Node process and one SQLite database are sufficient to inspect the full owned workflow locally without infrastructure subscriptions. SQL statements are parameterized; API routes enforce workspace ownership. Unknown people remain anonymous without an identity source. Device-entry events do not become person identities by assumption.

## Production shape with few moving parts

Start with a modular monolith and independently runnable workers from the same codebase:

- **Application:** authenticated advertiser/client workspace, campaign configuration, creatives, budgets, reports, and lead operations.
- **PostgreSQL + PostGIS:** multi-tenant application records, validated geofence geometry, spatial indexes, signed consent references, suppression state, ledger, and a job table. Use row-level security as defense in depth. Use schema migrations and transactional outbox patterns.
- **Worker process:** consume jobs with row locks (`FOR UPDATE SKIP LOCKED`), perform enrichment/validation, and write auditable outcomes. Keep delivery out of the synchronous pixel response.
- **Ad serving process:** direct placements first. Cache read-only campaign/target data only when profiling justifies it; budget reservations and settlements must remain atomic. Load-test the actual decision deadline and fail closed/no-bid under overload.
- **Owned static/object storage:** serve reviewed creatives, exports, and assets. Add a CDN only when actual delivery volume requires it; do not serve arbitrary uploaded HTML in the dashboard origin.
- **TLS reverse proxy:** route public collector/ad endpoints and private administration appropriately. A separate public collector origin and private console origin are recommended before exposure.

Keep PostgreSQL as the queue and system of record initially. Add Redis, a streaming log, or an analytical store only after measured bottlenecks justify them. Do not begin with one microservice or SaaS subscription per feature.

## Geofencing engine

Save validated radius/geography and polygon geometries with explicit commercial purpose, tenancy, active periods, and the provenance/permissions needed for incoming location assertions. Production queries use `ST_DWithin` for radii and `ST_Covers` plus uncertainty checks for polygons. Index geometries. Check location age, source, reported accuracy, spoofing indicators, and allowed use before matching. A point-in-polygon result alone does not prove an actual visit.

The local engine implements conservative radius and simple polygon tests and rejects coarse, stale, and uncertain boundary signals. It does not implement persistent historical device audiences, visit/dwell detection, or store-visit attribution. Add those only with a suitable permitted location feed and a calibrated visit model. Do not infer a named visitor or sensitive characteristics from a location event.

## Inventory: two separate delivery paths

### Direct publisher network

Publishers we own or contract with embed our tag. We control creative delivery and internal allocation. Add publisher verification, placement contracts, publisher revenue accounting, signed server integrations, anti-replay abuse controls, visibility measurement, invalid-traffic analysis, and reconciliation before live billing.

### Exchange buying

A bidder connects to an exchange/SSP using its supported OpenRTB variant and negotiated buyer seat. The exchange sends an impression opportunity; our bidder applies eligibility, creative approval, location quality, bid price, budgets, and a strict deadline. Wins, losses, billing notifications, impression receipts, and exchange invoices must reconcile.

This requires access agreements, operating capital/credit, creative approval, traffic scale, bid infrastructure, monitoring, and exchange-specific tests. Writing an OpenRTB endpoint does not grant access to Google or any other publisher. Do not use the bidstream as an unrestricted identity or location dataset; permitted retention and use depend on the supply agreement and platform policies.

## Consumer identity options

1. Licensed API behind our normalized adapter: least data operations, external per-request dependency.
2. Licensed local graph/data feed: more ownership of execution, material refresh, storage, data quality, provenance, and deletion obligations. An old static database is not an ongoing identity product.
3. Owned first-party identities from forms/logins: lowest external data dependency, narrower coverage of anonymous traffic.

Evaluate suppliers on observable unique-person precision, household ambiguity, false matches, data age, opt-out propagation, missing results, p95 latency, and the exact rights granted to a multi-client platform. Database size is not a quality metric. Keep adapters independent of campaign logic and preserve provider IDs and evidence.

## Delivery and ten-second goal

A ten-second goal applies to the asynchronous journey after an eligible event, not to ad auction decision time. Instrument capture, queue wait, resolution, validation, eligibility, and delivery acceptance separately. Define p50/p95/p99 service objectives from representative licensed data and real volumes. Timeout individual stages, circuit-break unhealthy providers, deduplicate contact delivery across sessions/campaigns, and persist a delivery outbox.

The current MVP produces drafts and simulated demo offers. Live delivery requires review and a configured gateway. Automatic live delivery, frequency limits across visits, bounce/complaint processing, and an end-to-end latency SLA remain planned work.

## Implementation sequence

1. **Local owned workflow (implemented):** dashboard, workspaces, direct serving, native fence tests, signed events, ledger, click-to-website attribution, demo enrichment, consent gates, offers, suppression, erasure, and audit.
2. **Production application foundation:** PostgreSQL/PostGIS migrations, robust auth/roles and key lifecycle, separated public/private endpoints, distributed abuse controls, independent workers, backup/restore, observability, and explicit retention policies.
3. **Real consumer pilot:** choose licensed API or local feed; prove data rights and match quality; add validator and delivery adapter; add outbox, frequency controls, bounce/complaint handling, and measured latency.
4. **Direct publisher pilot:** supply agreements, verified placements, real-time eligible location source if needed, approved creatives, invalid-traffic controls, store-visit methodology, and billing reconciliation.
5. **Exchange bidder:** one approved supply integration, OpenRTB conformance, deadline/overload tests, atomic budget reservations, bid/win/billing reconciliation, and cautious expansion.

## Current limitations

This is an MVP, not a Simpli.fi replacement at production scale. It has no connected inventory marketplace, bidder, payment processing, identity dataset, raw location feed, email server, SMS sender, location history graph, store-visit measurement, pacing optimizer, or production fraud detection. These are explicit product milestones, not simulated live integrations.


## Customer-owned enrichment implementation

The next implemented slice adds a workspace-owned consumer directory, field provenance, source-reference history, atomic CSV/JSON import, authenticated session associations, and enrichment from local records before any anonymous provider call. An exact contact lookup is customer-provided evidence rather than a calibrated identity probability. Contact verification and channel permission remain separate. See [ENRICHMENT.md](ENRICHMENT.md) for the data contracts, retention boundary, and sourcing discussion.
