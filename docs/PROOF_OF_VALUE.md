# Proof Of Value

This committed proof pack packages two selected local comparison artifacts
from the current embedding-backed eval corpus. It is reusable judge-facing
local evidence, not proof of deployed-path equivalence or a broad benchmark.

The same local retrieval report also evaluates `vector_postfilter`. On the current labeled corpus it matches `trace_prefilter_vector`, so this proof pack should be read as two selected examples of keyword brittleness and scope control rather than universal baseline dominance.

## Keyword search missed the right incidents

- Artifact ID: `insurance-keyword-gap`
- Query: `Which fleet vehicles had commercial auto coverage lapse and were suspended until a new insurance certificate was uploaded?`
- Intended operator task: Answer the archive question 'Which fleet vehicles had commercial auto coverage lapse and were suspended until a new insurance certificate was uploaded?' without relying on exact keyword overlap.
- Applied scope: No structured scope. This artifact isolates the semantic retrieval advantage.
- Displayed rows: Full top 5 returned rows per mode for auditability.

| Mode | Labeled hits in top 5 | Rows in intended scope | What happened |
| --- | ---: | ---: | --- |
| Keyword only | 0/3 | n/a | Keyword-only returned 0 of 3 labeled positives in the top 5. It missed 3 labeled incident(s). 5 returned row(s) were unlabeled matches. |
| Trace hybrid | 3/3 | n/a | Trace returned 3 of 3 labeled positives in the top 5 without relying on exact keyword overlap. |

### Keyword only

| Rank | Incident ID | City | Document Type | Labeled positive | Scope match |
| ---: | --- | --- | --- | --- | --- |
| 1 | `e0156821-6436-5002-bd6e-156b33459a42` | `NYC-TLC` | `City_Permit_Renewal` | no | n/a |
| 2 | `045047cf-ac3f-535a-82ec-d02ddc302c56` | `NYC-TLC` | `City_Permit_Renewal` | no | n/a |
| 3 | `b73a28fb-a1a4-599e-9475-cb0f91b6ed03` | `MEX-SEMOVI` | `Insurance_Lapse_Report` | no | n/a |
| 4 | `87775731-ec5f-5f31-89d3-265355183987` | `NYC-TLC` | `Insurance_Lapse_Report` | no | n/a |
| 5 | `79e3a0f1-fb58-58ab-9bf0-ddbc5ea50c6b` | `MEX-SEMOVI` | `Insurance_Lapse_Report` | no | n/a |

Mode note: Keyword-only returned 0 of 3 labeled positives in the top 5. It missed 3 labeled incident(s). 5 returned row(s) were unlabeled matches.

### Trace hybrid

| Rank | Incident ID | City | Document Type | Labeled positive | Scope match |
| ---: | --- | --- | --- | --- | --- |
| 1 | `53d0c4a4-ee39-5489-aae1-138d5d5f1e2d` | `CHI-BACP` | `Insurance_Lapse_Report` | yes | n/a |
| 2 | `33b05273-4380-5229-9d67-17cf62d38bea` | `MEX-SEMOVI` | `Insurance_Lapse_Report` | yes | n/a |
| 3 | `e2591fd3-586e-5f60-97a2-1d3dbb7a839d` | `CHI-BACP` | `Insurance_Lapse_Report` | yes | n/a |
| 4 | `1260deaf-1d6e-5477-9e17-e9d97a745b6a` | `MEX-SEMOVI` | `Insurance_Lapse_Report` | no | n/a |
| 5 | `89dd054f-72ff-5d01-b402-dc5d611e524c` | `NYC-TLC` | `Insurance_Lapse_Report` | no | n/a |

Mode note: Trace returned 3 of 3 labeled positives in the top 5 without relying on exact keyword overlap.

Templated operator handoff note:

> Goal: Which fleet vehicles had commercial auto coverage lapse and were suspended until a new insurance certificate was uploaded?
> Scope: No structured scope. This artifact isolates the semantic retrieval advantage.
> Primary evidence: 53d0c4a4-ee39-5489-aae1-138d5d5f1e2d | Insurance_Lapse_Report | CHI-BACP | 2026-01-31T06:14:46+00:00
> Why Trace wins: Trace returned 3 of 3 labeled positives in the top 5 without relying on exact keyword overlap.
> Why the weaker mode failed: Keyword-only returned 0 of 3 labeled positives in the top 5. It missed 3 labeled incident(s). 5 returned row(s) were unlabeled matches.
> Suggested handoff: Escalate incident 53d0c4a4-ee39-5489-aae1-138d5d5f1e2d with the semantic evidence trail instead of relying on exact keyword matches.
> Boundary: Templated from the retrieved evidence and mode summaries; not a separate model output.

## Semantic search needed operational scope

- Artifact ID: `insurance-scope-gap`
- Query: `insurance lapse or coverage gap for fleet vehicles`
- Intended operator task: Answer the archive question 'insurance lapse or coverage gap for fleet vehicles' within the constrained city CHI-BACP | document type Insurance_Lapse_Report slice.
- Applied scope: city CHI-BACP | document type Insurance_Lapse_Report
- Displayed rows: Full top 5 returned rows per mode for auditability.

| Mode | Labeled hits in top 5 | Rows in intended scope | What happened |
| --- | ---: | ---: | --- |
| Semantic only | 3/3 | 3/5 | Semantic-only vector retrieval returned 3 of 3 labeled positives but surfaced 2 out-of-scope row(s) from MEX-SEMOVI, NYC-TLC in the top 5. |
| Trace hybrid | 3/3 | 5/5 | Trace returned 3 of 3 labeled positives and kept 5 of 5 returned rows inside the requested scope. |

### Semantic only

| Rank | Incident ID | City | Document Type | Labeled positive | Scope match |
| ---: | --- | --- | --- | --- | --- |
| 1 | `15d2f66f-5fa9-5fca-9bc4-2ef1ee64f3ff` | `NYC-TLC` | `Insurance_Lapse_Report` | no | no |
| 2 | `01db0ffb-8392-5fea-bdf2-2b19d1ec5dda` | `CHI-BACP` | `Insurance_Lapse_Report` | yes | yes |
| 3 | `a6119d69-6fa6-53d9-b23f-81f5892a7756` | `CHI-BACP` | `Insurance_Lapse_Report` | yes | yes |
| 4 | `c133efda-c05a-57b2-adba-881f024243fc` | `CHI-BACP` | `Insurance_Lapse_Report` | yes | yes |
| 5 | `9155b2d4-c5a6-5c83-9a00-2ce7fba58951` | `MEX-SEMOVI` | `Insurance_Lapse_Report` | no | no |

Mode note: Semantic-only vector retrieval returned 3 of 3 labeled positives but surfaced 2 out-of-scope row(s) from MEX-SEMOVI, NYC-TLC in the top 5.

### Trace hybrid

| Rank | Incident ID | City | Document Type | Labeled positive | Scope match |
| ---: | --- | --- | --- | --- | --- |
| 1 | `01db0ffb-8392-5fea-bdf2-2b19d1ec5dda` | `CHI-BACP` | `Insurance_Lapse_Report` | yes | yes |
| 2 | `a6119d69-6fa6-53d9-b23f-81f5892a7756` | `CHI-BACP` | `Insurance_Lapse_Report` | yes | yes |
| 3 | `c133efda-c05a-57b2-adba-881f024243fc` | `CHI-BACP` | `Insurance_Lapse_Report` | yes | yes |
| 4 | `a5b0d17c-d279-533e-8d7d-1ef546b98ab6` | `CHI-BACP` | `Insurance_Lapse_Report` | no | yes |
| 5 | `1d857c65-058e-5203-b3c9-a9c7a253939f` | `CHI-BACP` | `Insurance_Lapse_Report` | no | yes |

Mode note: Trace returned 3 of 3 labeled positives and kept 5 of 5 returned rows inside the requested scope.

Templated operator handoff note:

> Goal: insurance lapse or coverage gap for fleet vehicles
> Scope: city CHI-BACP | document type Insurance_Lapse_Report
> Primary evidence: 01db0ffb-8392-5fea-bdf2-2b19d1ec5dda | Insurance_Lapse_Report | CHI-BACP | 2022-03-04T06:14:19+00:00
> Why Trace wins: Trace returned 3 of 3 labeled positives and kept 5 of 5 returned rows inside the requested scope.
> Why the weaker mode failed: Semantic-only vector retrieval returned 3 of 3 labeled positives but surfaced 2 out-of-scope row(s) from MEX-SEMOVI, NYC-TLC in the top 5.
> Suggested handoff: Escalate incident 01db0ffb-8392-5fea-bdf2-2b19d1ec5dda with the filtered evidence pack for city CHI-BACP | document type Insurance_Lapse_Report before regulator or compliance review.
> Boundary: Templated from the retrieved evidence and mode summaries; not a separate model output.
