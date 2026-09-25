import { ClarificationInvalidAnswerError, PreflightDecisionRequiredError, classifyFindings, type PreflightDecision } from '@automate/core';
import type { ClarificationRepository, NewQuestion } from '../db/repositories/clarification-repository';
import type { UploadProfileRepository } from '../db/repositories/upload-profile-repository';

/** Recomputes pre-flight findings server-side and persists resolved choices. */
export class PreflightService {
  constructor(private readonly profiles: UploadProfileRepository, private readonly clarifications: ClarificationRepository, private readonly maxDecisions?: number) {}

  resolveDecisions(uploadIds: readonly number[], submitted: readonly PreflightDecision[], priorTaskId?: number): readonly NewQuestion[] {
    const findings = classifyFindings(uploadIds.flatMap((id) => this.profiles.getDisclosureSource(id)?.profiles ?? []), { maxDecisions: this.maxDecisions }).required;
    const known = new Map(findings.map((finding) => [finding.findingKey, finding]));
    for (const decision of submitted) if (!known.has(decision.findingKey)) throw new ClarificationInvalidAnswerError(`Decision ${decision.findingKey} is not a required pre-flight choice.`);
    const submittedMap = new Map(submitted.map((item) => [item.findingKey, item.choice]));
    const seeded = priorTaskId === undefined ? new Map<string, string>() : this.clarifications.priorAnswersForTask(priorTaskId);
    const missing = findings.filter((finding) => !submittedMap.has(finding.findingKey) && !seeded.has(finding.findingKey));
    if (missing.length) throw new PreflightDecisionRequiredError(missing.map(({ question }) => question));
    return findings.map((finding) => {
      const direct = submittedMap.get(finding.findingKey);
      const answer = direct ?? seeded.get(finding.findingKey)!;
      if (!finding.options.some(({ value }) => value === answer)) throw new ClarificationInvalidAnswerError(`Choose one of ${finding.options.map(({ value }) => value).join(', ')} for ${finding.question}`);
      return { findingKey: finding.findingKey, impact: finding.impact, promptText: finding.question, rationale: finding.rationale, options: finding.options, proposedDefault: finding.proposedDefault, answer, answerSource: direct === undefined ? 'seeded' : 'user' };
    });
  }

  persist(executionId: number, questions: readonly NewQuestion[]): void { if (questions.length) this.clarifications.open({ executionId, source: 'preflight', status: 'answered', questions }); }
}
