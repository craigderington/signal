# Visitor and consumer enrichment

## Current development decision

Start with the records our customers already own: CRM exports and first-party form submissions. Source anonymous consumer matching separately. No third-party runtime service is required for the directory, import, session association, provenance, or local enrichment features.

A **visitor** is an observed website session. A **consumer** is a customer-owned contact record. A directory record does not identify an anonymous visitor by itself. They are linked only by an authenticated customer backend or an explicit workspace-admin action. Shared IP addresses are never a merge key.

## Use the dashboard

Open http://127.0.0.1:3400/#consumers and add a customer record or choose **Import CRM data**. Import supports CSV or a JSON array, up to 250 contacts / 200,000 characters per batch. The optional file picker accepts files up to 200 KB and reads them locally; the imported content is sent only to your Signal server. Source files are not retained.

Preview detects invalid rows, duplicate emails, source-ID conflicts, and suppressed contacts before saving. If any row is invalid, the import is rejected without partial writes. Repeating a timestamped export upserts the same contact; it does not create duplicate profiles or outreach permissions.

Supported fields: `email`, `name`, `phone`, `city`, `state`, `postalCode`, and `country`. CSV aliases include `email_address`, `first_name`/`last_name`, `phone_number`, `zip`, `updated_at`, and `external_id`. Unknown columns are ignored and listed in the preview. A JSON array uses the canonical field names plus optional `observedAt` and `recordId`.

```csv
email,name,phone,city,state,postalCode,country,updated_at,external_id
nora.example@example.com,Nora Example,+12025550120,Austin,TX,78701,US,2026-01-01T00:00:00Z,customer-001
```

Phone formatting accepts international numbers or 10-digit U.S. numbers and stores an international format. This is a syntax/format operation, not a verification that a number is assigned, reachable, or belongs to the contact. Email normalization trims whitespace and lowercases; it does not remove plus tags or dots.

## Field provenance and merge rules

Every populated field records its source type/name, source observation time, Signal recording time, and optional source record ID. The consumer detail panel shows these independently for each field, alongside import/update/link history.

- CRM data can fill empty fields.
- An older value cannot replace a newer observation.
- A CRM value cannot overwrite a form/manual value, even if its timestamp is newer.
- Form/manual corrections can replace values of equal or lower authority when the incoming observation is at least as recent.
- Blank imported values do not erase fields.
- Primary emails and external source-record identity changes require review; we do not silently merge different identities.

If your export contains real source timestamps, include them. Without `observedAt`/`updated_at`, the import time is recorded as the observation time, which is less informative. No source type is labeled independently identity-verified merely because it was imported or submitted through a form.

## First-party form integration

1. Register the website and load our tracker.
2. Your consent manager grants collection permission.
3. Wait for a collection acknowledgement before submitting a session association. The tracker now returns the `/collect` result from `Signal.track()` and `Signal.consent()`.
4. Send the session subject ID with the form to **your customer backend**.
5. That backend calls Signal's authenticated `/api/identify` endpoint. Keep the workspace token server-side.

Browser-side example, inside your existing permitted form flow:

```js
// Collection permission must already have been granted by your consent manager.
const observation = await window.Signal.track();
if (!observation?.accepted) {
  // Submit the ordinary business form without a tracking association.
} else {
  const subjectId = window.Signal.getSubjectId();
  // Include subjectId in the form submitted to YOUR backend.
}
```

The backend must bind the association to the actual first-party form/session, authenticate or otherwise substantiate claims as appropriate for your application, and validate the submitted data. Do not blindly forward arbitrary visitor IDs or client claims of verification/permission. The session subject is not proof of identity or a secret credential.

Server-to-server request:

```http
POST /api/identify
Authorization: Bearer <client-workspace-token>
Content-Type: application/json
```

```json
{
  "siteId": "registered-site-id",
  "subjectId": "the-consented-tracker-subject",
  "contact": {
    "email": "nora.example@example.com",
    "name": "Nora Example",
    "phone": "+12025550120",
    "city": "Austin",
    "state": "TX"
  },
  "source": {
    "type": "form",
    "name": "Request a quote",
    "observedAt": "2026-11-08T14:00:00Z"
  }
}
```

Use the actual collection timestamp; future dates are rejected. The response returns `visitorId`, `consumerId`, queued `jobId`, method `customer_provided`, and whether email permission was explicitly recorded.

You can instead supply an existing `consumerId`. Workspace admins can associate an existing `visitorId` and `consumerId` through **Visitors → details → Link known consumer**. Synthetic graph demo visitors are deliberately excluded from real customer associations. A session already linked to one consumer cannot silently switch to another; begin a new consented session when the actual person changes.

If the first consented page event has not reached Signal yet, identification returns 404 without creating contact data. Waiting for the tracker acknowledgement avoids that race. The local lookup happens before any anonymous identity adapter; an associated customer record requires no consumer-identity API request.

## Permission, validation, and offers

Linking/importing a contact does not grant email permission. If your backend has collected and retained the underlying marketing-permission evidence, `/api/identify` can also record:

```json
{
  "consent": {
    "emailMarketing": true,
    "noticeVersion": "email-marketing-v2"
  }
}
```

This is an explicit assertion by the authenticated customer backend, not a browser-only checkbox accepted by an anonymous collector. The source and notice version are retained in a signed receipt bound to the site, session, workspace, and exact email. The customer remains responsible for the underlying evidence. The separate `/api/consent` receipt flow remains supported.

Subsequent collection events that omit an email receipt do not revoke an authenticated record of permission. Use the suppression/unsubscribe endpoints to revoke contact eligibility, rather than treating omission on a page event as revocation. `Signal.revoke()` stops that browser's collection and deletes its session-scoped tracker ID; it does not erase an existing directory record or retroactively revoke a backend marketing-permission record.

Customer-provided associations carry **no fabricated confidence score**. The provider confidence threshold still applies to future anonymous graph matches. Both paths require valid contact validation, a matching non-expired permission receipt, an active offer rule, and no suppression before live delivery. Format checking alone never supplies a `valid` email result.

No validation service is enabled by default, so contacts remain unverified and real offers are held. Live delivery is still disabled by default and requires an explicit dashboard Send action plus a configured delivery gateway. Automatic ten-second outreach is future work.

## Updating and refreshing

Consumer records are stored separately from visitor snapshots. After a correction/import, the next visit can refresh its local snapshot. An admin can also use **Refresh from directory**, backed by `POST /api/visitors/:id/enrich`. This does not require retaining the original IP.

An in-flight validation result cannot overwrite a newer customer revision. Live delivery rejects an offer whose customer snapshot is stale, until re-enrichment runs. A refresh preserves delivered/uncertain offer records and updates only pending drafts.

## Suppression, erasure, and retention

Suppressing a consumer blocks all associated sessions, pending lookups, and pending offers. Email suppression is shared within that client workspace, including sessions carrying a matching signed permission receipt. Import cannot reactivate a suppressed contact. Unsubscribe also marks the owned directory record suppressed.

Erasing a consumer removes its profile, field history, source references, associated visits, jobs, and offers. Erasing an owned-linked visitor through the existing visitor-erasure action also erases the associated consumer and their linked visits. A keyed email/subject suppression is retained to prevent re-import or re-append. Cross-client data remains isolated.

The existing visitor retention window still removes old visitor snapshots and association links. **The customer directory and field history remain until explicit erasure**; they do not silently expire under the visitor-retention setting. Establish a customer-record retention policy before production. All of these records reside in the local SQLite database, which is not fully encrypted; use encrypted storage/backups for real deployment. No uploaded source file or discarded conflicting field value is retained as a raw import archive.

## API summary

| Endpoint | Purpose |
| --- | --- |
| `GET /api/consumers` | Latest 500 contacts in the authenticated workspace |
| `POST /api/consumers` | Upsert a customer-owned contact and named source |
| `POST /api/consumers/import-preview` | Validate CSV/JSON without writing records |
| `POST /api/consumers/import` | Atomic validated CRM upsert batch |
| `GET /api/consumers/:id` | Profile, per-field provenance, history, sessions |
| `PATCH /api/consumers/:id` | Manual correction; primary email stays fixed |
| `POST /api/consumers/:id/suppress` | Suppress profile and related sessions |
| `DELETE /api/consumers/:id` | Erase profile and associated data |
| `POST /api/identify` | Authenticated customer/form session association |
| `POST /api/visitors/:id/enrich` | Refresh an associated visit from owned data |

## Sourcing future anonymous matching

We need a source that supports the actual identifiers available, not merely a large list of names and phone numbers. An anonymous IP lookup may represent a household or shared network, whereas a form provides a self-reported contact identifier. Keep those paths and their evidence distinct.

Two candidates for evaluation, not confirmed licenses:

- [Audience Acuity Onsight](https://audienceacuity.com/onsight/) explicitly offers on-premise data/identity installation with regular updates. This is a deployment model to evaluate against the goal of few runtime service dependencies.
- [AtData Website Visitor ID](https://atdata.com/identity/website-visitor-id/) describes a vendor-pixel-based visitor identification product. Its input/placement model must be confirmed; it is not evidence that our server can send an arbitrary IP to a public append endpoint.

For either source, obtain the exact integration contract and rights for multi-client use, storing/redistributing appended fields, permitted outreach, refreshes, and deletion/suppression propagation. Do not assume vendor scores are calibrated probabilities or accept marketing match-rate claims without a controlled pilot. The current anonymous adapter remains unconnected while we build and test owned-data workflows.
