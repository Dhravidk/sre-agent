---
name: icd203-sre
description: Apply ICD 203 analytic standards to SRE outage forecasts, GitHub PR and GitLab MR reviews before and at merge, deployment monitoring, and incident investigations.
---

# ICD 203 for reliability analysis

Source: [ODNI, ICD 203, Analytic Standards, 2 January 2015](https://www.intelligence.gov/assets/documents/intelligence-community-directives/ICD_203.pdf), sections D.6.a–e, especially D.6.e.(1)–(9), pages 2–4. This is an engineering adaptation, not an IC certification or a statistical prediction model.

Apply the directive's approach: objective, timely judgments informed by relevant sources; describe source quality, express uncertainty, distinguish evidence from assumptions, evaluate alternatives, explain operational implications, show sound reasoning, and explain changed judgments. Assess likelihood and confidence separately. Never put a confidence level and a likelihood judgment in the same sentence.

Use one likelihood vocabulary consistently: almost no chance (1–5%), very unlikely (5–20%), unlikely (20–45%), roughly even chance (45–55%), likely (55–80%), very likely (80–95%), almost certain (95–99%). These are the directive's expression ranges, not measured application failure rates. `unknown` is this application's additional abstention value, outside that scale. Confidence is low, moderate, or high, with its own evidentiary explanation.

## Application workflow

Load this skill for every investigation and every change review. Populate the `risk` fields in the required output schema. Use the supplied `riskScope` for the outcome, environment, time horizon, review stage, and exact commit. Do not change that scope silently.

Before merge, forecast the defined outage or auction correctness failure conditional on deployment of the reviewed SHA. Inspect changed behavior, tests and CI results, dependencies, schema migrations, rollout controls, and rollback feasibility. A diff warning is a risk hypothesis; it is not an observed outage. A passing test suite only supports the behaviors and environments it covers. If current CI is unavailable, stale, or against another SHA, state that gap.

At merge, update the assessment using the actual merged change and available checks. Explain changed or unchanged judgment using new evidence. A merged PR/MR is not proof that a release reached the running service. Keep the merged SHA and deployed SHA distinct. Never infer deployment from commit timestamps.

During runtime monitoring, use the declared forecast horizon for further degradation. Existing outages are observed facts, not future probabilities. Correlate fresh metrics, traces, error logs, deployment records, linked issue intent, and ServiceNow reports. Identify signals that would support the leading explanation and signals that would disprove it. Copied alerts and incident tickets repeating those alerts are not independent corroboration.

For each major judgment, cite evidence IDs; assess freshness, coverage, directness, and missing portions. Explicitly state assumptions and how the answer changes if they fail. Consider at least one plausible alternative, including a dependency fault or unrelated change where supported. Record contrary evidence or state that none was available; never invent it. Describe the effect on bidding, dealer access, payment/credit dependencies, and accepted transactions when relevant.

Use `unknown` when there is no defensible basis for a likelihood estimate. Do not convert severity, test count, a static warning, or an LLM's self-rating into a probability. Use high confidence only with current, relevant, independent evidence and explain why. Deterministic fixture mode must abstain from real-world probability forecasts. Estimates remain uncalibrated expert judgments until compared against representative outcomes.

Provide concrete monitoring indicators that an operator can configure or check. Do not claim to have installed a monitor. State what evidence would change the judgment and compare with previous persisted assessments. Return likelihood rationale and confidence rationale as separate fields. Include assumptions, alternatives, contrary evidence IDs, source-quality limitations, operational impact, indicators, and the reason for any change from the previous assessment.

Rollback remains a separate deterministic decision: only a recent implicated deployment with a compatible, independently healthy immutable target is eligible. Recommend a rollback only if the policy permits it. Otherwise explain the constraint and recommend a scoped mitigation or forward fix. A likelihood judgment never authorizes merge, deployment, rollback, ticket changes, or external communication.
