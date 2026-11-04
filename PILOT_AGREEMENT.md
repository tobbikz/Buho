# Búho — Pilot agreement (template)

**Parties:** IKZ Technologies (“IKZ”) and ________________ (“Customer”).  
**Product:** Búho database monitor (on-prem), tag **v1.8.0**.  
**Pilot term:** 30 days from the Start Date below.  
**Scope:** up to **3 servers** (host+port) under Full Pro features at **USD $0**.

## 1. Start Date

Start Date: ______________ (YYYY-MM-DD)  
End Date: Start Date + 30 days (unless extended in writing).

## 2. What IKZ provides

- Access to published images (`./install.sh --pull`) and docs (`INSTALL.md`, `GO_LIVE.md`, `PRICING.md`)
- Pro feature set during the pilot (alerts, Estate, multi-instance within the 3-server cap)
- Reasonable email support (Spanish or English) for install and go-live checklist items

## 3. What Customer provides

- A non-production or agreed production environment for the install
- Least-privilege monitor logins (`sql/monitor-user*.sql`)
- One real alert channel for a test notification
- Feedback within 7 days after End Date (what worked / what blocked purchase)

## 4. Conversion

At End Date, Customer may:

1. **Convert** to Pro ($899/server/year) or Fleet ($799/server/year, 5+) per `PRICING.md`, or  
2. **Downgrade** to Free (1 instance, 7-day retention), or  
3. **Stop** and delete the deployment (Customer data stays on Customer premises).

No auto-charge. Conversion requires a written order (email is enough).

## 5. License during pilot

Same as `LICENSE` (Apache License 2.0). The “Búho” name and marks remain IKZ Technologies trademarks.

## 6. Data & security

- Búho is **read-only** against monitored databases (plus optional host `/proc` or SSH metrics if Customer enables them).
- The Búho **store** (metrics, findings, alerts) runs on Customer infrastructure.
- IKZ does not receive production data unless Customer explicitly shares logs for support.

## 7. Warranty & liability

Pilot is provided **as-is**. IKZ’s aggregate liability under this pilot is limited to USD $0 (pilot fee). This does not limit liability that cannot be excluded by law.

## 8. Signatures

| | IKZ Technologies | Customer |
|--|------------------|----------|
| Name | | |
| Title | | |
| Signature | | |
| Date | | |

---

*Template only — not legal advice. Adapt jurisdiction and payment terms before use.*
