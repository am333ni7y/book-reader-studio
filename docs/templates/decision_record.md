# Decision Record: [Short Descriptive Title]

- **Decision ID**: `ADR-[YYYYMMDD]-[Number]` (e.g., `ADR-20260925-01`)
- **Status**: [ Proposed | Accepted | Superseded | Deprecated | Rejected ]
- **Date**: [YYYY-MM-DD]
- **Author(s)**: [Name / Role]
- **Supersedes / Superseded By**: [N/A or Link to other ADR]

---

## 1. Problem & Context
*What problem are we solving? What requirements, performance goals, constraints (time, budget, hardware, software, data, regulations), or observations triggered this decision?*

---

## 2. Alternatives Considered

### Option A: [Name / Brief Description]
- **Pros / Advantages**:
- **Cons / Disadvantages**:
- **Rejection Reason**: *(Be specific: performance, complexity, maintainability, reliability, cost, latency, compatibility, security, etc.)*
- **Empirical Status**: [ Experimentally evaluated | Literature / Documentation benchmark | Not experimentally tested; rejected based on X ]

### Option B: [Name / Brief Description]
- **Pros / Advantages**:
- **Cons / Disadvantages**:
- **Rejection Reason**:
- **Empirical Status**:

---

## 3. Selected Approach: [Name of Selected Option]

### 3.1 Why this approach was selected
*Explain the actual technical, logical, business, or engineering rationale.*

### 3.2 Evidence & Justification
- **Observed Facts**: *(Benchmarks, profile traces, error logs, hard requirements)*
- **Interpretations**: *(What the evidence indicates)*
- **Assumptions**: *(What we assume to be true without direct proof)*
- **Engineering Judgment**: *(Professional heuristics applied)*

---

## 4. Trade-Offs Accepted
- **What did we gain?**: *(e.g., lower latency, simpler mental model, faster time to ship)*
- **What did we give up?**: *(e.g., query flexibility, higher memory footprint, vendor coupling)*
- **Why this trade-off is acceptable for current constraints**:

---

## 5. Consequences & Dependencies
- **System Impact**: *(Changes to data flow, interfaces, error handling, downstream callers)*
- **Technical Debt Introduced**: *(Any temporary compromises, follow-up tickets required)*
- **Reconsideration Trigger**: *(Under what condition should this decision be reopened or changed?)*
