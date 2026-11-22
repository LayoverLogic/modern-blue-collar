# DRAFT — not legal advice — for review by counsel (Paul Mikols / KS Emerald)

> **Template status.** v4.1 draft, 2026-11-21, for the MBC white-label platform at `mbc/sandbox-revival` 808631f,
> claims re-checked against 6d63a31 (password set-up and reset by email, activity records for quotes and invoices).
>
> **What this is.** The *terms of use* that a client's staff accept to use that client's MBC instance
> ("the System"). It sits under two other documents that this file does not replace:
> - the **Master Subscription & Services Agreement (MSA)** between PEJR LLC (KS Emerald) and the client: licence,
>   fees, term, support and uptime, liability, IP, data return. Not drafted here (compliance.md §8, Paul → counsel);
> - the **Data Processing Agreement** (`data-processing-agreement-template.md`), an annex to the MSA.
>
> Replace every `{{PLACEHOLDER}}`, delete `[IF …]` paragraphs for features that are off, and keep the `[US]` or
> `[EU/IE]` governing-law block. Product statements are mapped to features in `docs/legal/README.md`.

---

# Terms of Use — {{CLIENT_TRADING_NAME}} job-management system

**Effective:** {{EFFECTIVE_DATE}} · **Version:** {{VERSION}}

## 1. Who these terms are between

These terms apply to everyone who is given an account on the job-management system of {{CLIENT_LEGAL_NAME}}
("**{{CLIENT_TRADING_NAME}}**", "**we**"). By signing in you agree to them. The System is provided to us by
{{PROVIDER_LEGAL_NAME, e.g. "PEJR LLC, trading as KS Emerald"}} ("**the Provider**") under a separate agreement.

## 2. Accounts

2.1 Accounts are created by a {{CLIENT_TRADING_NAME}} administrator, who either sends you an invitation link to
choose your own password or gives you a temporary password that you must change when you first sign in. You may not
create accounts for anyone else or share yours.

2.2 You sign in with your email address and password, or [IF GOOGLE SIGN-IN ENABLED] with the Google account for
the email address we invited. If you forget your password, use "Forgot password" to get a single-use reset link by
email. Keep your password secret and tell {{ADMIN_CONTACT}} at once if you think someone else has used your account;
changing your password signs you out on every device. **[Product: the invitation, "Forgot password" and
change-password screens exist since Frontend F3 (0cc0953); the instance needs working email — see
docs/legal/README.md before publishing.]**

2.3 What you can see and do depends on the role we give you (for example administrator, office/dispatcher or
{{TECHNICIAN_LABEL}}). [IF TECH_VISIBILITY=own] Field roles see only the jobs assigned to them. [IF
TECH_VISIBILITY=all] Field roles can see the whole schedule but change only the jobs assigned to them. Do not try to
reach information or functions your role does not give you.

2.4 We may change your role or deactivate your account at any time, for example when you leave. A deactivated
account stops working immediately, including any open session.

## 3. Acceptable use

You must use the System only for {{CLIENT_TRADING_NAME}}'s work, and you must not:

- record payment-card numbers, bank details, government ID numbers or health information in notes, messages or photos;
- upload anything other than photos of the work or property (the System accepts image files only);
- take photos of people without their agreement, or of anything not needed for the job;
- send texts or emails from the System to anyone other than customers about their work [IF SMS ENABLED: and only
  to a number the customer gave for that purpose];
- copy, export or download customer information except as your job requires and as {{CLIENT_TRADING_NAME}} allows;
- try to probe, scan or test the System's security, overload it, or get around its access controls, unless the
  Provider has authorised it in writing;
- use automated tools against it other than API keys issued by an administrator.

## 4. API keys

[IF API KEYS ARE USED] Administrators can issue API keys for integrations. A key acts with the permissions of the
person who created it, limited to read or read-and-write, and stops working if that person's account is deactivated.
Keys are shown once; store them as secrets and revoke any key you think is exposed.

## 5. Records of activity

The System records who created, changed, assigned, rescheduled, added notes or photos to, or deleted each job, and
who created each quote and invoice or changed its status, and when. These records cannot be edited through the
System. {{CLIENT_TRADING_NAME}} may use them to run the business,
resolve disputes and investigate misuse. How your personal information is handled is described in our Privacy
Notice: {{PRIVACY_NOTICE_LINK}}.

## 6. Customer information

Customer information in the System belongs to {{CLIENT_TRADING_NAME}} and is confidential. You may use it only to
do your work, during and after your engagement with us.

## 7. Availability and changes

We aim to keep the System available but do not promise it will be uninterrupted or error-free. It may be
unavailable during maintenance or because of events outside our or the Provider's control. Features may change.
**[Uptime targets and support hours belong in the MSA / SLA schedule, not here; see GTM-PLAN §5.]**

## 8. Ownership

The System's software, design and documentation belong to the Provider and are licensed to
{{CLIENT_TRADING_NAME}}. These terms give you no rights in them beyond using the System for your work.
{{CLIENT_TRADING_NAME}}'s name, logo and data belong to {{CLIENT_TRADING_NAME}}.
**[Depends on the licence decision in LICENSE-PROPOSAL.md.]**

## 9. Ending access

{{CLIENT_TRADING_NAME}} may suspend or end your access at any time. Sections 3, 5, 6 and 8 continue after your
access ends.

## 10. Liability

[Counsel to draft. For staff users this is usually governed by the employment or contractor agreement; keep this
section short and consistent with it.]

## 11. Changes to these terms

We may update these terms. We will show the new version when you next sign in or tell you another way
{{HOW_NOTIFIED}}; continuing to use the System means you accept it.

## 12. Governing law

[US] These terms are governed by the laws of {{STATE, e.g. "the State of Kansas"}}; courts of {{COUNTY_OR_VENUE}}
have jurisdiction.

[EU/IE] These terms are governed by the laws of Ireland; the Irish courts have jurisdiction.

Questions: {{ADMIN_CONTACT}}, {{ADMIN_EMAIL}}.
