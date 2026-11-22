# DRAFT — not legal advice — for review by counsel (Paul Mikols / KS Emerald)

> **Template status.** v4.1 draft, 2026-11-21. Written for the MBC white-label platform at
> `mbc/sandbox-revival` 808631f, claims re-checked against 6d63a31. It replaces the earlier v3 policy, which was
> one client's own policy, named providers that are no longer used (DigitalOcean, Wasabi) and claimed things the
> template does not do (Google-only sign-in with no stored passwords, audit logging of all user actions).
> v4.1: password sign-in with reset by email, Google sign-in, the activity record now covers quotes and invoices,
> encrypted backups including photos, quote / invoice emails, the optional accounting link.
>
> **How to use it.** This is the notice a *client* (the trades business, the controller) publishes for its own
> customers and staff. It is not KS Emerald's own policy.
> - Replace every `{{PLACEHOLDER}}`. `{{CLIENT_TRADING_NAME}}` should match the instance's `BRAND_COMPANY_NAME`.
> - Keep **either** the `[US]` blocks **or** the `[EU/IE]` blocks (or both, for a client with customers in both),
>   and delete the other. Delete the square-bracket labels.
> - Delete any `[IF …]` paragraph whose feature is switched off on that client's instance.
> - Do not add claims. Each statement here is tied to a product feature in `docs/legal/README.md`; check that table
>   before changing wording.

---

# Privacy Notice — {{CLIENT_TRADING_NAME}}

**Effective:** {{EFFECTIVE_DATE}} · **Version:** {{VERSION}} · **Last updated:** {{LAST_UPDATED}}

## 1. Who we are

{{CLIENT_LEGAL_NAME}} (trading as {{CLIENT_TRADING_NAME}}), {{CLIENT_POSTAL_ADDRESS}} ("**we**", "**us**") provides
{{TRADE_DESCRIPTION, e.g. "plumbing and heating services"}}. We decide how and why your personal information is
used for the purposes below.

Contact for privacy questions: {{PRIVACY_CONTACT_NAME_OR_ROLE}}, {{PRIVACY_CONTACT_EMAIL}}, {{PRIVACY_CONTACT_PHONE}}.

[EU/IE] We are the **controller** of your personal data under the EU General Data Protection Regulation (GDPR)
and the Irish Data Protection Acts 1988–2018. {{IF A DPO IS APPOINTED: "Our Data Protection Officer is … ."}}

We use a job-management system to run our business. It is operated for us by {{PROCESSOR_NAME, e.g. "PEJR LLC
(KS Emerald)"}}, which acts only on our instructions under a written agreement ("our software provider").

## 2. Whose information this covers

- **Customers and enquirers**: people we quote for, carry out work for, or invoice, and contacts at business customers.
- **Our staff and contractors** who use the job-management system ("users").

## 3. What we collect

| Category | Examples | From |
|---|---|---|
| Contact details | name, phone number, email address, service address (street, town/city, {{STATE_OR_COUNTY}}, {{ZIP_OR_EIRCODE}}), residential or commercial | you, or the person who booked the work |
| Job and service records | what the job is, notes, scheduled date and time, status, which {{TECHNICIAN_LABEL}} was assigned | you and our staff |
| Photos | photos of the work and the property taken by our staff | our staff |
| Quotes and invoices | items, quantities, prices, tax, totals, document numbers, status, due and paid dates | us |
| Communications | a record of calls, emails, texts and notes with you (subject, content, from/to) | you and our staff |
| **Users only:** account details | name, work email, phone, role, password (stored only as a one-way hash), when they last signed in | the user and our managers |
| **Users only:** activity history | which jobs, quotes and invoices a user created or changed, and when | the system |

We do **not** collect or store payment-card or bank-account details in the job-management system. Please do not
send them to us by text or email; if they reach us by accident we delete them {{WITHIN_30_DAYS}}.

We do not need, and ask staff not to record, information about health, disability or other sensitive matters.
If a note about access needs is necessary to do the work safely, we keep it to the minimum.

**Photos** are stored as they are taken. Phones can add hidden information (such as the time and location) to a
photo file; this is kept with the photo.

## 4. Why we use it

| Purpose | [EU/IE] Lawful basis |
|---|---|
| Booking, scheduling and carrying out the work you asked for; contacting you about it | Contract (Art. 6(1)(b)), or steps you asked for before a contract |
| Quotes, invoices and keeping business and tax records | Contract; legal obligation (Art. 6(1)(c)) for tax records |
| Service history, so we can deal with warranty, follow-up or repeat work | Legitimate interests (Art. 6(1)(f)): running and improving our service |
| [IF SMS ENABLED] Appointment texts to the number you gave us for this purpose | Contract / legitimate interests; [US] the consent you gave when you provided your number |
| Staff accounts: giving staff access to the jobs they need, and a record of who changed a job | Legitimate interests (security and accountability); staff contract |
| Protecting our systems and investigating misuse | Legitimate interests |

We do not sell personal information, use it for advertising, or make decisions about you by automated means.
[IF MARKETING IS USED: describe it and its consent here; otherwise delete.]

## 5. How users sign in

{{CLIENT_TRADING_NAME}} staff sign in with:

- an **email address and password**. Passwords are stored only as a one-way cryptographic hash, never in readable
  form. New staff choose their own password from an invitation link, or receive a temporary password that must be
  changed at first sign-in. A forgotten password is reset through a single-use link sent to the staff member's email
  address, valid for {{RESET_LINK_MINUTES, default "30 minutes"}}. Changing or resetting a password signs the person
  out on every device **[Product: the invitation, reset and change-password screens are pending on 6d63a31 —
  see docs/legal/README.md before publishing]**; and/or
- [IF GOOGLE SIGN-IN ENABLED] **Google sign-in**, available only to people we have invited (or, if we have enabled
  it, to accounts on our own email domain {{GOOGLE_ALLOWED_DOMAINS}}). Google tells the system your name and email
  address; it does not give the system your Google password.

A signed-in session lasts up to {{SESSION_LENGTH, default "8 hours"}}. Accounts of people who leave are deactivated,
which ends their access at once.

## 6. Who we share it with

- **Our software provider**, {{PROCESSOR_NAME}}, which hosts and supports the system for us.
- **Service providers it uses** (sub-processors) for hosting, file storage, email and, if enabled, text messages.
  The current list, with where each one stores data, is at {{SUBPROCESSOR_LIST_URL_OR_ANNEX}}:

  | Provider | Purpose | Location |
  |---|---|---|
  | {{HOSTING_PROVIDER}} | servers and database | {{REGION}} |
  | {{STORAGE_PROVIDER}} | photos and backups | {{REGION}} |
  | {{EMAIL_PROVIDER}} | system emails: staff invitations and password-reset links, and quotes and invoices we email to you | {{REGION}} |
  | [IF SMS ENABLED] {{SMS_PROVIDER}} | appointment texts | {{REGION}} |
  | [IF GOOGLE SIGN-IN ENABLED] Google | staff sign-in | {{REGION}} |
  | [IF ACCOUNTING LINK ENABLED] {{ACCOUNTING_PROVIDER, e.g. "Intuit QuickBooks" or "Xero"}} | our accounting: your name, contact and billing address, and the invoices we send you | {{REGION}} |

- Our accountant and professional advisers, and authorities where the law requires it.
- Anyone else only with your agreement.

[EU/IE] **International transfers.** {{IF ANY PROVIDER OR OUR SOFTWARE PROVIDER IS OUTSIDE THE EEA: "Some of these
providers, and our software provider, are based in the United States. Where your data is accessed from or stored
outside the European Economic Area we rely on {{TRANSFER_MECHANISM, e.g. "the EU–US Data Privacy Framework" or
"the European Commission's Standard Contractual Clauses"}}. You can ask us for a copy of the safeguards."}}
**[counsel: confirm mechanism per provider; see compliance.md §1 and §4.]**

## 7. How long we keep it

| Record | Kept for |
|---|---|
| Customer, job, quote and invoice records | {{RETENTION_BUSINESS_RECORDS: [US] "7 years after the last job" / [EU/IE] "6 years after the end of the tax year of the last job"}} |
| Communications log | {{RETENTION_COMMS}} |
| Photos | {{RETENTION_PHOTOS}} |
| Staff accounts | deactivated when the person leaves; deleted {{RETENTION_STAFF}} later |
| Record of changes to jobs, quotes and invoices | as long as the job record, and {{RETENTION_ACTIVITY}} after a job is deleted |
| Backups | rolling, up to {{BACKUP_RETENTION, e.g. "35 days"}}; deleted data disappears from backups within that time |

These periods are applied by us on request to our software provider; the system does not delete records automatically.

## 8. How we protect it

- The system is a separate installation for {{CLIENT_TRADING_NAME}} only, with its own database; no other business's data is held in it.
- Staff only see what their role needs. [IF TECH_VISIBILITY=own] Field staff see only the jobs assigned to them and
  the customers on those jobs. [IF TECH_VISIBILITY=all] Field staff can see the schedule, jobs and customer
  details, but not the quotes, invoices or messages of jobs that are not theirs, and can change only their own jobs.
- Each change to a **job** (status, assignment, schedule, notes, photos, deletion), and the creation and status
  changes of **quotes and invoices**, is recorded with who made it and when.
- Passwords are hashed; repeated failed sign-ins are blocked for a time; sessions expire; changing a password signs
  the person out everywhere.
- Connections to the system are encrypted (HTTPS). **[provisioning: confirm TLS is configured on the instance before publishing.]**
- Data, including photos, is backed up {{BACKUP_FREQUENCY, e.g. "nightly"}} to {{BACKUP_LOCATION}}, and backups are
  encrypted before they leave the server. **[provisioning: confirm `BACKUP_ENCRYPTION_KEY` is set and photos are
  stored on the server (`STORAGE_DRIVER=local`) or the photo bucket is backed up; otherwise remove "including
  photos" / "encrypted".]**
- The system does not load advertising or analytics trackers, or any script from another website.

No system is perfectly secure. If a breach affects your information and the law requires it, we will tell you
and the relevant authority.

## 9. Cookies and similar technology

The system's own pages use your browser's local storage to keep a staff member signed in, and short-lived
cookies only while a staff member signs in with Google or connects an accounting service. They are needed for the
system to work; there are no advertising or analytics cookies. {{IF THE CLIENT'S PUBLIC WEBSITE USES COOKIES,
THAT IS COVERED BY THE WEBSITE'S OWN NOTICE.}}

## 10. Your rights

[EU/IE] You have the right to: access your personal data; have it corrected; have it erased; restrict or object to
its use (including for legitimate interests); and receive data you gave us in a portable format. Where we rely on
consent you may withdraw it at any time. We respond within one month (extendable by two months for complex
requests, in which case we will tell you). Some records (for example invoices) we must keep for tax law even if you
ask us to erase them; we will tell you if so.

You also have the right to complain to the **Data Protection Commission**, 21 Fitzwilliam Square South, Dublin 2,
D02 RD28, Ireland, www.dataprotection.ie. **[counsel: confirm address/contact current at publication.]** We would
appreciate the chance to deal with your concern first.

[US] You can ask us what information we hold about you, ask us to correct it, or ask us to delete it where we are
not required to keep it. {{STATE_SPECIFIC_RIGHTS_IF_ANY}} **[counsel: confirm whether any state privacy law
applies to this client; see compliance.md §9.]**

To make a request, contact {{PRIVACY_CONTACT_EMAIL}}. We may need to confirm your identity first.

[IF SMS ENABLED] To stop appointment texts, reply STOP or tell us. **[SMS: the current texts do not include an
opt-out line; add one before enabling SMS for a US client, see docs/legal/README.md.]**

## 11. Children

Our services are for adults. We do not knowingly collect information about children, other than incidentally
(for example, a name given as a contact at the property).

## 12. Changes

We will post any change here with a new date and version number{{, and tell staff and customers of significant changes by …}}.

| Version | Date | Changes |
|---|---|---|
| {{VERSION}} | {{LAST_UPDATED}} | {{CHANGES}} |

[US] **Governing law:** {{STATE, e.g. "Kansas"}}. **[counsel: confirm the K.S.A. references used in v3 are still current if reinstated.]**
