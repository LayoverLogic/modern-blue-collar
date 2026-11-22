# DRAFT — not legal advice — for review by counsel (Paul Mikols / KS Emerald)

> **Template status.** v0.1 draft, 2026-11-21. Structure follows GDPR Art. 28(3) and the positions in
> `/home/claude/mbc-team/gtm/implementation/compliance.md` §3–§7. Product statements in Annex 2 describe
> `mbc/sandbox-revival` at 808631f and are mapped in `docs/legal/README.md`; re-check them before each signature.
>
> **Use.** Annex to the MSA with **every** client: mandatory for EU/Irish clients, good practice for US clients
> (for a US-only client counsel may cut the GDPR-specific clauses; keep §6 breach notice and §9 return/deletion).
> Open questions for counsel are marked **[counsel]**.

---

# Data Processing Agreement

**Between**

1. **{{CLIENT_LEGAL_NAME}}**, {{CLIENT_ADDRESS}}, {{CLIENT_REGISTRATION_NO}} (the "**Controller**", "**Client**"); and
2. **{{PROVIDER_LEGAL_NAME, e.g. "PEJR LLC, trading as KS Emerald"}}**, {{PROVIDER_ADDRESS}} (the "**Processor**",
   "**Provider**").

**Date:** {{DATE}} · **Forms part of:** the Master Subscription & Services Agreement dated {{MSA_DATE}} (the "**MSA**").
If this DPA and the MSA conflict on data protection, this DPA wins.

## 1. Definitions

"**Data Protection Law**" means the GDPR (Regulation (EU) 2016/679), the Irish Data Protection Acts 1988–2018 and,
where they apply, US federal and state law (including state breach-notification law such as K.S.A. 50-7a01 et seq.).
"**Personal Data**", "**Processing**", "**Data Subject**", "**Personal Data Breach**", "**Supervisory Authority**"
have their GDPR meanings. "**Client Data**" means Personal Data processed by the Provider for the Client under the MSA.
"**Sub-processor**" means a third party the Provider engages to process Client Data. "**Instance**" means the
Client's own installation of the MBC platform (application, database and file storage).

## 2. Scope and roles

2.1 The Client is the controller and the Provider is the processor of Client Data. Annex 1 describes the processing
(Art. 28(3) subject matter, duration, nature, purpose, types of data, categories of data subjects).

2.2 The Provider processes Client Data only for the term of the MSA and as long afterwards as §9 requires.

## 3. Instructions — Art. 28(3)(a)

3.1 The Provider processes Client Data only on the Client's documented instructions. The instructions are: the MSA,
this DPA, the Client's use of the System's features, and written requests (including support tickets) from the
Client's authorised contacts listed in {{AUTHORISED_CONTACTS_SCHEDULE}}.

3.2 The Provider will tell the Client if, in its opinion, an instruction breaks Data Protection Law, unless the law
forbids telling.

3.3 If the law requires the Provider to process Client Data otherwise than on instructions, it will tell the Client
first unless that law forbids it.

## 4. Confidentiality — Art. 28(3)(b)

Everyone the Provider authorises to access Client Data ({{PROVIDER_PERSONNEL, e.g. "the Provider's two principals
and any contractor engaged later"}}) is bound by a written duty of confidentiality and accesses Client Data only as
needed to provide the services.

## 5. Security — Art. 28(3)(c), Art. 32

5.1 The Provider implements the technical and organisational measures in **Annex 2**, taking into account the state
of the art, cost, and the nature and risks of the processing.

5.2 The Provider may change the measures if the overall level of protection does not fall. It will update Annex 2
and tell the Client of material changes.

## 6. Personal Data Breaches — Art. 28(3)(f), Art. 33

6.1 The Provider will notify the Client **without undue delay and in any case within 48 hours** of becoming aware
of (confirming) a Personal Data Breach affecting Client Data. **[counsel: 24 vs 48 hours; "becoming aware" vs
"confirming"; compliance.md §5.2.]**

6.2 The notice will include, as far as then known: the nature of the breach; the categories and approximate number
of Data Subjects and records; likely consequences; measures taken or proposed; and a contact. Information not yet
available will follow in stages without undue delay.

6.3 The Provider will take reasonable steps to contain the breach, preserve evidence, and help the Client with its
own notifications to the Supervisory Authority (in Ireland, the Data Protection Commission, within 72 hours where
required) and to Data Subjects, and with any US state notices.

6.4 The Provider keeps a record of every breach affecting Client Data, including ones judged unlikely to result in
risk, and gives the Client a copy on request.

6.5 Notice under this section is not an admission of fault or liability.

## 7. Sub-processors — Art. 28(2), 28(3)(d), 28(4)

7.1 The Client gives general written authorisation for the Sub-processors in **Annex 3**.

7.2 The Provider will give the Client **at least 30 days' written notice** before adding or replacing a
Sub-processor. The Client may object on reasonable data-protection grounds within that period; the parties will
discuss in good faith, and if they cannot resolve the objection the Client may terminate the affected services
without penalty. **[counsel: termination remedy and refunds.]**

7.3 The Provider imposes on each Sub-processor data-protection obligations that are no less protective than this
DPA (usually through the Sub-processor's standard DPA) and stays responsible to the Client for its Sub-processors.

7.4 Services the Client contracts for directly (for example the Client's own QuickBooks, Twilio or Google Workspace
account) are the Client's own processors, not Sub-processors of the Provider. **[counsel: compliance.md §10 last item.]**

## 8. International transfers

8.1 Client Data is stored in the region stated in Annex 3 ({{REGION, e.g. "EU (Ireland/France/Germany) for EU
clients"}}).

8.2 The Provider is established in the United States. Where Client Data of EU/EEA Data Subjects is accessed from
or transferred to a country without an EU adequacy decision, the parties rely on
{{TRANSFER_MECHANISM_PLACEHOLDER: "the Standard Contractual Clauses (Commission Implementing Decision (EU)
2021/914), Module {{TWO (controller to processor)}}, incorporated by reference and completed in Annex 4" / "the
Provider's self-certification under the EU–US Data Privacy Framework"}}. **[counsel: mechanism for a US LLC
processor; Art. 27 EU representative; whether an Irish entity should contract with Irish clients; compliance.md §1.]**

8.3 Each Sub-processor's transfer basis is listed in Annex 3.

## 9. Return and deletion — Art. 28(3)(g)

9.1 On termination, and on the Client's written request within {{30}} days of it, the Provider will within
**10 business days** give the Client a complete export of Client Data: CSV exports of customers, jobs and invoices
from the System, plus a full database dump and the stored photo files. **[Product: the System's own export screen
covers customers, jobs and invoices only (GTM-20); the full export is produced by the Provider from the database
and file storage.]**

9.2 The Provider will then delete Client Data, including the Instance's database and file storage, **within 30
days**, and give a written certificate of deletion. Copies in rolling backups are deleted as those backups expire,
within {{BACKUP_RETENTION, e.g. "35 days rolling plus monthly copies for 12 months"}}; until then they are kept
secure and not used. **[align with compliance.md §6.]**

9.3 §9.2 does not apply to data the Provider must keep by law; it will tell the Client what and why.

## 10. Assistance — Art. 28(3)(e), (f)

10.1 **Data Subject requests.** Taking into account the nature of the processing, the Provider will help the Client
respond to requests to exercise Data Subject rights. The Client handles requests itself where the System allows
(viewing, correcting and exporting records; deleting customers, jobs and communications as an administrator). For
anything the System's screens cannot do (for example a full export for one person, or erasure of a person's
details from the job change history), the Provider will do it within **10 business days** of a written request.
If a Data Subject contacts the Provider directly, the Provider will pass the request to the Client and not respond
itself unless instructed.

10.2 **DPIAs and consultation.** The Provider will give reasonable help with data-protection impact assessments and
prior consultation (Art. 35–36) relating to the services. Help beyond {{2}} hours a year is charged at
{{RATE}}.

## 11. Audits and information — Art. 28(3)(h)

11.1 The Provider will make available the information reasonably needed to show compliance with Art. 28, including
on request once a year a written summary of the measures in Annex 2 and the current Sub-processor list.

11.2 The Client (or an independent auditor bound by confidentiality) may audit the Provider's compliance with this
DPA on at least **30 days'** written notice, during business hours, no more than once a year unless a Supervisory
Authority requires it or after a Personal Data Breach. The Client bears its own and the auditor's costs.
**[counsel: cost of the Provider's time.]**

## 12. Liability, term, law

12.1 Liability under this DPA is subject to the limits in the MSA. **[counsel: separate cap for data-protection
claims; insurance (cyber / professional indemnity) — compliance.md §3, §10.]**

12.2 This DPA lasts as long as the Provider processes Client Data.

12.3 Governing law and jurisdiction: {{"Ireland" for Irish/EU clients / "the State of Kansas" for US clients}},
unless the SCCs require otherwise for transfer matters.

Signed for the Client: ____________________ Name / title / date
Signed for the Provider: ____________________ Name / title / date

---

## Annex 1 — Description of the processing

| Item | Description |
|---|---|
| Subject matter | Hosting, operation, maintenance and support of the Client's Instance of the MBC job-management platform |
| Duration | Term of the MSA plus the return/deletion period in §9 |
| Nature | Storage, hosting, backup, retrieval for support, transmission of system emails and (if enabled) texts, deletion |
| Purpose | Letting the Client schedule and manage jobs, keep customer and service records, quote and invoice, and communicate with its customers |
| Data Subjects | (a) the Client's customers and their contacts; (b) the Client's staff and contractors who use the System |
| Customer data | first and last name; email; phone; service address (street, city/town, state/county, ZIP/Eircode); residential/commercial type; notes |
| Service data | job title, description, notes, type, priority, status, scheduled date/time, assigned staff member; photos of the work/property (stored as uploaded, including any embedded metadata such as location); parts used |
| Financial data | quote and invoice amounts, status, due and paid dates. **No payment-card or bank-account data** |
| Communications | log of calls, emails, texts and notes: type, direction, subject, body, from/to |
| Staff data | name, email, phone, role, active flag, password hash, API keys created (hash only), job change history naming the staff member |
| Change history | for each job: what changed, from/to values, who (staff member or API key) and when; kept after a job is deleted |
| Integration data | if the Client connects QuickBooks: OAuth tokens (encrypted) and company id |
| Special categories | None intended. The Client instructs its staff not to record them |
| Frequency | Continuous |

## Annex 2 — Technical and organisational measures

State only what is true on the day of signature. Items marked **gap** are not in place on 808631f: either fix them
before signature or leave them out. Source: `backend/SECURITY_AUDIT.md`.

| Measure | Status on 808631f |
|---|---|
| Separate Instance per client (own server, database, file storage and secrets); no shared database | In place by deployment design (the software is single-tenant) |
| Encryption in transit (HTTPS/TLS) | Provided by the reverse proxy on each server (provisioning checklist) — **confirm per Instance** |
| Encryption at rest | Depends on the hosting/storage provider — **state per provider in Annex 3**. QuickBooks tokens are additionally encrypted by the application (AES-256-GCM) |
| Role-based access control: administrator, office/dispatcher, field; field staff see only their assigned jobs and those customers | In place, tested |
| Passwords stored as bcrypt hashes; optional Google sign-in limited to invited users / allow-listed domains | In place, tested |
| Sign-in rate limiting; sessions expire (default 8 h); deactivated users lose access immediately | In place, tested |
| Multi-factor authentication for staff | **Gap** (available only through Google sign-in if the Client's Google accounts enforce it) |
| API keys: hashed, read or read/write scope, revoked with their creator | In place, tested |
| Job change history (append-only, names the actor) | In place for **jobs only** — not customers, invoices, users or sign-ins |
| Optimistic locking against lost updates (jobs, customers, quotes, invoices) | In place, tested |
| Upload restrictions (images only, 10 MB, type checked from file content) | In place, tested |
| Security headers incl. Content-Security-Policy | In place, but the policy allows inline scripts (**partial**) |
| Nightly database backup | In place (`pg_dump`, gzip) |
| Backups encrypted before upload | **Gap** (GTM-16) |
| Photos included in backups | **Gap** (GTM-16) |
| Tested restore procedure | **Gap** until the restore drill in the provisioning checklist is done per Instance |
| Uptime and backup monitoring | **Gap** in the software; external monitor per provisioning checklist |
| Administrative access to servers: SSH keys only; 2FA on all provider accounts | Process (provisioning checklist) — **confirm** |
| Personnel confidentiality; least access | §4 |
| Incident response and breach log | compliance.md §5.3 runbook |
| Vulnerability management: dependency audit before each release | Process; 3 high advisories open in the QuickBooks dependency chain (PLAT-7) |

## Annex 3 — Sub-processors

**Placeholder — complete per client from the provisioning record. Mark only those actually used.**

| Sub-processor | Purpose | Data location | Transfer basis (EU clients) |
|---|---|---|---|
| {{HOSTING_PROVIDER}} | Server, database, provider snapshots | {{REGION}} | {{BASIS}} |
| {{OBJECT_STORAGE_PROVIDER}} | Photo storage, off-site backups | {{REGION}} | {{BASIS}} |
| {{EMAIL_PROVIDER}} | System email (staff invitations) | {{REGION}} | {{BASIS}} |
| [IF ENABLED] {{SMS_PROVIDER}} | Appointment texts | {{REGION}} | {{BASIS}} |
| [IF ENABLED] {{IDENTITY_PROVIDER, e.g. Google}} | Staff sign-in | {{REGION}} | {{BASIS}} |

Not sub-processors (no personal data sent): {{MONITORING_SERVICE}} health check. DigitalOcean and Wasabi are **not**
used and must not appear here.

## Annex 4 — Transfer clauses

{{Placeholder: completed SCC Module Two annexes (parties, description of transfer = Annex 1, TOMs = Annex 2,
sub-processors = Annex 3, competent supervisory authority = Data Protection Commission), or a statement that no
restricted transfer takes place. **[counsel]**}}
