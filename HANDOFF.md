# Development checkpoint — 2026-11-09

The user requested a reboot. Resume from this checkpoint; do not rebuild the project.

## Product direction

Build an independent self-hosted advertising and consumer-lead platform with minimal third-party services. Simpli.fi is the reference capability set, not a required backend. Start enrichment with customer-owned CRM/form records while sourcing licensed anonymous identity matching separately. Keep identity evidence, contact validation, and channel permission distinct.

## Current work saved

- Added `server/consumers.js`: workspace-owned consumer directory, normalized contacts, per-field provenance/source authority, atomic previewed CSV/JSON imports, external record references, session associations, suppression, and erasure.
- Integrated local enrichment into `server/app.js` before anonymous provider lookup; added authenticated `/api/identify` and local refresh endpoints. Customer-provided records carry no probability score and do not grant permission or verification.
- Added `public/consumers-ui.js` and a Consumers navigation page with import preview, contact editing, field history, and session association controls. Converted dashboard script to an ES module.
- Added tracker collection acknowledgements so customer forms can await a consented page event.
- Added `ENRICHMENT.md` with workflow and API examples; updated README and architecture notes.

## Validation

- `npm run check` passed.
- Full `npm test` suite passed: **36 tests**. Includes import atomicity/idempotence, field precedence, client isolation, no identity-provider call for owned records, session association conflicts, permission/validation checks, stale snapshot delivery rejection, lifecycle races, and contact-wide erasure.
- Browser loaded the new Consumers page successfully.
- **Browser QA is unfinished:** manual Add consumer form was filled and Save contact clicked, but it remained open; waiting for the contact in the directory timed out. The last snapshot showed all fields still filled, no displayed `.form-error`, and no output from `agent-browser errors`. Investigate native form validity, submit/event handling, network response, and refresh before declaring the UI flow complete. Backend endpoint tests pass.
- Fictional browser QA contact: `nora.enrichment-qa-1108@example.com`, name `Nora Example (QA)`, source `Local QA fixture`. Check whether it was persisted, and clean up only records explicitly created for this QA. Do not erase other customer data.
- Import preview/confirmation, consumer detail drawer, known-session association UI, and mobile/accessibility checks for this new page still need browser verification.

## Restart after reboot

```bash
cd /home/cd/Projects/digital-marketing-platform
npm start
```

Open http://127.0.0.1:3400/#consumers. No npm install step is needed. Loopback demo access uses `local-demo-only` if a token is requested. Existing local data is in ignored `.data/`; preserve it and its secret. No real provider credentials or live messaging are configured.

The user explicitly wants the server left running for review. Do not stop port 3400 as QA teardown. It was running before this reboot request and will need restarting after reboot.

## Next steps

1. Inspect the checkpoint diff and this note. Resolve the manual consumer form issue.
2. Complete browser checks for CRM import preview/commit, provenance and source conflict protection, session association, and mobile behavior.
3. Run checks relevant to fixes; the latest full backend suite already passes.
4. Keep the app running on port 3400 and report the exact verified result.
5. Continue discussing licensed anonymous matching. Audience Acuity Onsight advertises an on-premise installation option; AtData Website Visitor ID uses vendor pixel technology. Neither has been contracted or integrated.

No data-provider purchases, external messages, deployments, media buys, or Git pushes were performed.
