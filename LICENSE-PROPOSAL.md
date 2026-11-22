# Licence proposal for Modern Blue Collar

**DRAFT — not legal advice — for review by counsel (Paul Mikols / KS Emerald).** 2026-11-21. Finding GTM-13.
Nothing in this change alters the current licence fields; this page only sets out the decision.

## 1. Where things stand

- `README.md` ends with "## License — MIT".
- `backend/package.json` has `"license": "MIT"`, and `backend/package-lock.json` repeats it for the root package.
- There is **no `LICENSE` file** in the repository, so there is no MIT text with a copyright line either.
- The same MIT statements are on the client branches (`client/all-pro-plumbing`, `client/david-lies-plumbing`).
- The GitHub repository `LayoverLogic/modern-blue-collar` is **public** (checked 2026-11-21).
- Commits are by Alex's GitHub account and by Claude sessions. No contributor or assignment terms exist.

MIT lets anyone use, copy, modify, sell and sublicense the code, provided the notice is kept. For a product whose
business is selling a licensed, managed instance per client, that is the opposite of what is intended: a
competitor or a departing client could run or resell it legally. The GTM plan (§7a item 10, §9 decision 3) already
recommends replacing it before any demo.

Two facts counsel should weigh, which this page does not try to answer:

1. **Copies already published.** Anyone who obtained the code while it was public under an MIT statement may
   argue they hold MIT rights to *that* version. Changing the licence works going forward; it does not reach back.
   Making the repository private limits further copies.
2. **Who owns the copyright.** For PEJR LLC to license the platform to clients, PEJR must own it or hold an
   exclusive licence. Today the authors are Alex personally and AI-assisted sessions. A short IP assignment from
   Alex (and Paul, if he contributed) to PEJR LLC, and a view on AI-generated code, should come before the MSA's
   licence clause.

## 2. Options

| Option | What it means | For | Against |
|---|---|---|---|
| **A. Proprietary, all rights reserved** + a per-client licence in the MSA | `LICENSE` says "Copyright © {{YEAR}} PEJR LLC. All rights reserved." No rights to anyone except under a signed agreement. The MSA grants each client a non-exclusive, non-transferable right to use its instance for the term; KS Emerald owns the platform, the client owns its data | Matches the business: one managed instance per paying client. Simple to explain. Standard for small SaaS | Must pair with a private repository; otherwise people can still read the code, just not lawfully use it |
| **B. Source-available** (for example Business Source License 1.1, Elastic License 2.0, or PolyForm Shield / Noncommercial) | Code can be read and maybe run for limited purposes; production or competing use needs a commercial licence | Lets prospects or their IT person inspect the code; may help trust | More to explain and police; little benefit for 3–10-tech trades businesses who will never read the code; licence choice needs counsel anyway |
| **C. Keep MIT** | Anyone may do anything, including resell | Zero effort; maximises adoption if open source were the goal | Undermines the product's value and the MSA. Not compatible with the GTM plan |

## 3. Recommendation

**Option A**, together with making the GitHub repository private, before any demo or pilot. Rationale: the
offer is a managed service per client (GTM-PLAN §1–§2), clients never receive or host the code, and the MSA already
needs an IP clause ("KS Emerald owns the platform, you own your data"). Source-available adds explanation without
adding sales value at this size. Revisit only if a client insists on code escrow or inspection; escrow can be
handled by a clause in the MSA without changing the public licence.

Decision needed from Paul (with counsel): option, copyright holder name (PEJR LLC?), and whether to make the
repository private now.

## 4. Exactly which files change once Paul decides

For **Option A** (the same list applies to B with the chosen licence text and SPDX id):

| File | Change |
|---|---|
| `LICENSE` (new, repo root) | Proprietary notice, e.g. "Copyright © 2026 PEJR LLC (trading as KS Emerald). All rights reserved. This software is licensed only under a written agreement with PEJR LLC. No other right is granted." Final wording from counsel |
| `README.md` | Replace the "## License / MIT" section with "Proprietary. Copyright © 2026 PEJR LLC. See LICENSE." |
| `backend/package.json` | `"license": "MIT"` → `"license": "UNLICENSED"` (npm's value for "not licensed for use by others"; for B use the SPDX id, e.g. `"BUSL-1.1"`). Also add `"private": true` so the package can never be published to npm by mistake |
| `backend/package-lock.json` | Regenerate with `npm install` so the root entry's `"license"` matches. Do not hand-edit |
| `docs/legal/terms-of-service-template.md` §8 | Remove the "[Depends on the licence decision …]" note once the MSA wording is fixed |
| MSA template (not in this repo) | Licence grant, restrictions (no copying, reverse engineering, resale), IP ownership, data ownership, escrow if offered |
| Client branches `client/all-pro-plumbing`, `client/david-lies-plumbing` | Same `README.md` and `backend/package.json` change when those branches are next touched (they are not shipped from this repo as-is) |
| GitHub settings (not a file) | Repository visibility → private; review who has access |

Optional, not required for the licence to take effect: a one-line `// Copyright (c) 2026 PEJR LLC. All rights reserved.`
header in new source files. Do not mass-edit existing files for this.

Not affected: third-party dependencies keep their own licences (mostly MIT/Apache-2.0/ISC). A proprietary product can
use them; keep their notices, which `node_modules` already does. If Option A is chosen, run a licence check of the
production dependencies (for example `npx license-checker --production --summary`) before the first client contract.
