# Failure & Incident Analysis Log

- **Failure ID**: `FAIL-[YYYYMMDD]-[Number]` (e.g., `FAIL-20260925-01`)
- **Date Discovered**: [YYYY-MM-DD]
- **Component / Subsystem**: [Name of module/subsystem]
- **Severity**: [ Critical | High | Medium | Low ]
- **Status**: [ Investigating | Resolved | Mitigated | Closed ]

---

## 1. Description of the Attempt
- **What was attempted?**:
- **Why was it attempted?**:
- **Expected behavior / outcome**:
- **Actual behavior / outcome**:

---

## 2. Detection & Evidence
- **How was the problem detected?**: *(e.g., automated test failure, crash log, regression report, monitoring alert)*
- **Observed evidence / telemetry**: *(Paste relevant error traces, log lines, metrics)*

---

## 3. Root Cause Investigation
- **What was investigated?**:
- **Identified Root Cause**: *(Underlying mechanism, flawed assumption, race condition, configuration mismatch, etc.)*
- **Certainty Level**: [ Verified | Strongly Supported | Inferred / Suspected | Unknown ]

---

## 4. Alternative Solutions Considered
1. **Option 1**: [Description] → *Rejected because:*
2. **Option 2**: [Description] → *Rejected because:*

---

## 5. Selected Solution & Verification
- **Solution Chosen**:
- **Did the solution work?**: [ Yes / Partial / Needs monitoring ]
- **Verification Evidence**: *(Test run outputs, metrics, reproduction check)*

---

## 6. Lessons Learned & Preventative Actions
- **Core Lesson Learned**:
- **Could this failure reoccur?**:
- **Preventative Rules / Guards Added**: *(e.g., lint rule, pre-commit check, assertion, architectural boundary, documentation warning)*
- **Advice for Future Developers**:
