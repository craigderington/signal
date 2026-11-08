# Signal

A local, self-hosted advertising and consumer visitor-intelligence MVP. Core features run on your infrastructure, with no runtime npm packages, map service, hosted analytics, or Simpli.fi dependency.

**This is a working first slice, not a production DSP or an identity database.** Real exchange inventory, licensed consumer identity data, and contact delivery are not bundled.

## Run locally

Requires Node.js **22.16+** with `node:sqlite` and `--env-file-if-exists` support.

```bash
npm start
```

Open **http://127.0.0.1:3400**. No install step is needed. Local loopback mode signs into the demo workspace automatically. Its explicitly local token is `local-demo-only`. Data persists in the ignored `.data/` directory. Stop with Ctrl-C.

```bash
npm run check
npm test
```

SQLite may emit an experimental API warning on Node 22. Node's own SQLite driver is used directly.

## Try the owned advertising flow

1. In **Ad campaigns**, create a campaign and activate it. Start without a geofence.
2. In **Publishers**, add a placement using `http://127.0.0.1:3400` as the origin.
3. Click **Open publisher**. The creative is selected by our server, displayed in an isolated iframe, and counted through our signed impression pixel.
4. Click the creative. Our signed redirect records a deduplicated click and appends a signed `signal_click` attribution token to the landing URL.
5. The ad campaign shows impressions, clicks, and budget allocations. These are an internal ledger; **no real media is purchased and no card is charged**.
6. Add a native geofence. Attach it to a new campaign and use **Test ad server** with synthetic coordinates to exercise matching.

The contextual publisher tag uses no visitor identifier or location. The host publisher's CSP must allow our script, connection endpoint, and iframe origin. Signed creative frames restrict embedding to that placement's registered publisher origin.

The direct ad selector chooses the highest configured CPM eligible campaign. Reservations protect total and daily budgets before a creative is shown. A rendered impression settles the reservation exactly once. Unshown reservations expire after two minutes or UTC midnight. This is **direct ad serving**, not an OpenRTB auction, pacing optimizer, viewability verifier, or production fraud system.

## Try the lead flow

Click **Run demo pipeline**. Six synthetic visits exercise:

- Two person matches with valid synthetic contact checks and simulated offers.
- A matched contact without email permission.
- A household match held from person-level outreach.
- An anonymous visitor with no match.
- A suppressed contact.

All fixtures use reserved example domains and fictional phone numbers. Demo validation and delivery are labeled explicitly. **No messages are sent.** Inspect visitor details, match evidence, jobs, offer reasons, and audit events.

For a customer website, register its exact origin under **Websites** and use **Install snippet**. The tracker remains idle until the website's consent manager calls:

```js
window.Signal.consent({ collection: true, noticeVersion: 'your-notice-version' });
```

Call this only in your consent manager's approval callback, not unconditionally on page load. If consent is available before the deferred script loads, set `window.signalConsent` to the same object and call `window.Signal?.consent(...)` when available. On SPA navigation, call `window.Signal.track()`. Revoke collection with `window.Signal.revoke()` and revoke permissions through your backend where applicable.

The tracker creates a session-scoped random subject ID only after permission. It respects Global Privacy Control, sends no query string or URL fragment as the page URL, and sends no existing first-party email automatically. A signed attribution parameter is passed separately and linked only within the same client workspace. The server observes the connection IP; callers cannot provide a replacement IP in the event body. Only an explicitly configured trusted proxy may supply `X-Real-IP`.

## Consumer identity with minimal third parties

Two supported architectural paths:

1. A licensed provider's API behind a small normalization gateway you own.
2. A **licensed local identity dataset**, refreshed under contract, with your own lookup gateway. This avoids per-request dependence on a data SaaS but still requires data rights and ongoing refreshes.

Do not assume a purchased database permits this use. Confirm rights for consumer website identification, client-facing SaaS/resale, storage, refreshes, deletion/suppression propagation, and the intended contact channels. Preserve match scope and provenance; an IP-to-household association does not establish who viewed an ad.

Configuration is server-side only. Copy `.env.example` to `.env` and set the fields you need. Never put provider keys, workspace tokens, or the encryption secret in browser snippets.

### Owned identity gateway contract

`IDENTITY_URL` must be HTTPS. The application POSTs JSON with `Authorization: Bearer IDENTITY_KEY`:

```json
{
  "ip": "203.0.113.8",
  "subjectId": "first-party-session-id",
  "siteId": "site-uuid",
  "timestamp": "2026-11-06T12:00:00.000Z",
  "collectionConsent": { "collection": true, "noticeVersion": "v1" }
}
```

Return `{ "matched": false }`, or:

```json
{
  "matched": true,
  "person": {
    "id": "provider-record-id",
    "name": "Example Person",
    "email": "person@example.com",
    "phone": "+12025550120",
    "city": "Austin, TX",
    "scope": "person",
    "confidence": 0.97,
    "evidence": "Describe the matching source and method"
  }
}
```

`scope` must be `person` or `household`. Confidence is a provider-reported number between 0 and 1, not an independent accuracy guarantee. Person identity, email verification, and marketing permission are separate checks. Provider response bodies and credentials are not logged.

No provider is configured by default; live visitors remain anonymous. Lookup jobs are persisted, retry up to three times, and erase their encrypted raw-IP payload after success or terminal failure. Old pending work expires. Completed records retain matched contact fields until retention or erasure.

### Validation gateway

`VALIDATION_URL` receives `{ "email": "...", "phone": "..." }` with a server-side bearer `VALIDATION_KEY`. Return email and phone statuses from `valid`, `invalid`, `unknown`, or `catch_all`. No configured validator means `unverified`; a format check alone is not email deliverability validation.

For minimum ongoing services, own syntax, DNS, and line-format checks, and use a licensed validator only when stronger evidence is required. MX existence or an SMTP probe alone cannot prove a mailbox belongs to a particular person or will accept an offer.

### Contact-specific consent receipts

After your customer backend records real email marketing permission, it calls `POST /api/consent` with its workspace bearer token:

```json
{
  "siteId": "site-uuid",
  "subjectId": "the-same-first-party-session-id",
  "email": "person@example.com",
  "emailMarketing": true,
  "noticeVersion": "v1",
  "source": "First-party signup form"
}
```

After collection permission is granted, use `window.Signal.getSubjectId()` to include the same session subject in your first-party form submission to your backend. This returns `null` before permission or with Global Privacy Control enabled. The returned signed `receipt` is passed to the tracker as `emailReceipt` in the permission object. It is bound to workspace, site, visitor subject, and exact email, and expires after 30 days. The customer must retain underlying permission evidence. A forged, expired, wrong-contact, demo, or cross-workspace receipt cannot qualify a live offer. A later receipt can re-evaluate an existing held draft.

### Offer delivery

The MVP prepares offers asynchronously. **Live sends are explicit dashboard actions**, not automatic sends, and an end-to-end ten-second delivery SLA is not implemented. Demo processing is fast; real latency depends on your identity, validation, and delivery systems. Retries can exceed ten seconds.

To enable real delivery, configure `OUTREACH_URL`, `OUTREACH_KEY`, `SENDER_POSTAL_ADDRESS`, and `ENABLE_DELIVERY=true`. The HTTPS gateway receives `{offerId,to,subject,text,unsubscribeUrl,headers}` with `Idempotency-Key: <offerId>` and must durably honor that key. Return `{ "accepted": true }` only after durable acceptance.

Delivery rechecks person match, >=90% reported confidence, matching email permission, valid email result, active offer rules, and suppressions. Messages include advertisement identification, sender postal address, and unsubscribe information. The unsubscribe endpoint accepts confirmation POST and one-click POST. Uncertain or interrupted sends are held for provider reconciliation; they are not blindly retried. Acceptance is not inbox-delivery confirmation. SMS sending is not implemented.

### Consent-aware ad and pixel endpoints

`POST /ads/request?placement=<public-key>` requires the placement's exact `Origin`. Contextual requests use `{}`. A publisher backend or consent-aware client may supply:

```json
{
  "consent": { "location": true, "noticeVersion": "v1" },
  "location": {
    "lat": 30.2672, "lng": -97.7431,
    "accuracyMeters": 10, "source": "gps", "timestamp": 1793966400000
  }
}
```

Supply the actual current timestamp. Location is evaluated in memory and is not persisted. Assertions can be spoofed: production needs authenticated publisher integrations and location-quality controls. The prototype accepts only recent GPS assertions with <=100 m reported accuracy and requires the uncertainty circle to fit inside the fence. IP-derived, stale, and opted-out location signals do not qualify. Polygon calculations are a local MVP implementation; production uses validated PostGIS geometries and appropriate geographic calculations.

`/pixel.gif` is a separate collection pixel requiring a short-lived signed `pixel_consent` receipt from authenticated `POST /api/pixel-consent` with `siteId`, `subjectId`, `collection:true`, and `noticeVersion`. It also requires an allowed website referrer/origin and a unique `event` query parameter. It is **not an unrestricted ad-network pixel** and must not be installed on Google or any exchange without their vendor, placement, consent-signal, and data-use approvals. The owned ad server has its own signed measurement pixel; those measurement requests do not automatically trigger identity enrichment.

## Isolation and operations

The bootstrap admin can create client workspaces in Settings. Each client gets a distinct random token and isolated sites, visitors, ads, fences, offers, ledger, and audit access. Tokens are hashed in storage. Browser sessions are HttpOnly/SameSite cookies. Public site and placement keys are identifiers, **not secrets or proof of a legitimate browser**; origin checks and in-process rate limits are basic protections, not a complete abuse defense.

The app binds to `127.0.0.1` by default. Before any deployment, set a strong `ADMIN_TOKEN`, independent `DATA_SECRET`, and exact HTTPS `PUBLIC_BASE_URL`, terminate TLS at your proxy, and disable local demo authentication. A managed deployment needs hardened sessions, account recovery, token rotation, roles, durable distributed rate limiting, monitoring, backups, restore drills, publisher verification, ledger reconciliation, creative review, and fraud protection. This MVP is not ready to expose as a public advertising service.

SQLite/WAL and its parent directory are restricted to the local owner. Pending raw-IP lookup payloads use AES-256-GCM. **The complete database is not encrypted:** matched contacts and browser consent receipts are readable to the database owner. Use encrypted storage and backups for production. Preserve `DATA_SECRET` or the local `.data/secret` across restarts; changing it breaks queued payloads, existing receipts, and suppression hashes. Local files and `.env` are ignored by Git.

`RETENTION_DAYS` defaults to 90 for visitor/contact history and audit events. Cleanup runs at startup and hourly. Ad ledger/campaign retention is intentionally separate and is not automatically purged; define financial/audit retention before production. Erasure removes a visitor's events, jobs, offers, and contact record but retains keyed subject/email suppression to prevent re-append. Suppressions must be retained and backed up; restoring an old backup must not resurrect opted-out contacts.

## Relevant primary sources

- [Simpli.fi API overview](https://simpli.fi/api) — optional future bridge, not a required dependency.
- [Google Authorized Buyers integration](https://developers.google.com/authorized-buyers/rtb/get-started/request-guide) — inventory and buyer requirements.
- [Google OpenRTB location fields](https://developers.google.com/authorized-buyers/rtb/openrtb-guide) — coarse/IP-derived signals are not precise building visits.
- [Google third-party ad serving requirements](https://support.google.com/adspolicy/answer/94230?hl=en).
- [FTC CAN-SPAM business guidance](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business) — applies to B2B commercial email too.
- [PostGIS reference](https://postgis.net/docs/reference.html) — production spatial engine.
