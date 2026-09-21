# Research basis — reviewed 2026-09-21

- Anthropic, Building effective agents (2024, live updated article): https://www.anthropic.com/engineering/building-effective-agents . Read article and tool-design guidance. Supports simple composable workflows, ground-truth tool feedback, evaluator/optimizer loops, bounded autonomy and oversight. Practitioner guidance, not universal causal evidence.
- Wang et al., A Meta-Analysis of Mental Contrasting With Implementation Intentions (2021): https://doi.org/10.3389/fpsyg.2021.565202 . Read full-page abstract/introduction/method discussion: 21 studies, 15,907 participants, g=.336 with publication-bias caveat. Motivates outcome–obstacle–if/then planning; HUMAN evidence, not demonstrated LLM effectiveness.
- Reflexion: https://arxiv.org/abs/2303.11366 . Abstract reviewed, not full-paper replication. Feedback-grounded episodic reflection motivates small reusable lessons after experiments; does not imply weight learning or reliable improvement on every task.
- Self-Refine: https://arxiv.org/abs/2303.17651 . Abstract reviewed. Iterative critique/refinement can improve evaluated outputs; self-approval is not independent validation.
- ADF contracts: https://raw.githubusercontent.com/christianbalevski/adf/main/docs/guides/inner-loops.md and timers.md; skills.md and skills/adf-skill-creator/SKILL.md. Read live docs. Timers need enabled matching on_timer scope; scheduling is not proof of delivery. Loops share files/identity, are not isolated evaluators.

Synthesis, not established research result: progress ledger, pivot ladder, mandatory same-turn review/delivery and anti-spin rules below address practical orchestration failures. The default two-failed-attempt pivot trigger is a heuristic, adjustable per task. No claim this instruction skill guarantees autonomous success.

## Redistribution
Principal authorized public ADF repository PR submission on 2026-09-21. Separate shared-registry publication is not implied. Static review approved; runtime efficacy untested.
