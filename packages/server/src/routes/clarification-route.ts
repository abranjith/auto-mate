import { Value } from '@sinclair/typebox/value';
import { ClarificationAnswerRequestSchema, ValidationError, type ClarificationAnswerRequest, type FindingOption } from '@automate/core';
import { Router } from 'express';
import type { ClarificationRepository, ClarificationWithQuestions } from '../db/repositories/clarification-repository';
import type { ClarificationService } from '../disclosure/clarification-service';

const parseId = (value: string, label: string) => { const id = Number(value); if (!Number.isSafeInteger(id) || id < 1) throw new ValidationError(`${label} must be a positive integer.`); return id; };
const present = (batch: ClarificationWithQuestions) => ({ ...batch, askedAt: batch.askedAt.toISOString(), settledAt: batch.settledAt?.toISOString() ?? null, createdAt: undefined, questions: batch.questions.map((question) => ({ id: question.id, position: question.position, findingKey: question.findingKey, impact: question.impact, promptText: question.promptText, rationale: question.rationale, options: question.options ? JSON.parse(question.options) as FindingOption[] : null, proposedDefault: question.proposedDefault, answer: question.answer, answerSource: question.answerSource, answeredAt: question.answeredAt?.toISOString() ?? null })) });

/** Clarification replay and answer endpoints. */
export function clarificationRoute(deps: { readonly clarifications: ClarificationRepository; readonly service: ClarificationService }): Router {
  const router = Router();
  router.get('/api/executions/:executionId/clarifications', (request, response, next) => { try { response.json({ clarifications: deps.clarifications.listByExecution(parseId(String(request.params.executionId), 'Execution id')).map(present) }); } catch (cause) { next(cause); } });
  router.post('/api/clarifications/:clarificationId/answers', (request, response, next) => { try { if (!Value.Check(ClarificationAnswerRequestSchema, request.body)) throw new ValidationError('Submit one bounded answer for every question.'); const result = deps.service.answer(parseId(String(request.params.clarificationId), 'Clarification id'), (request.body as ClarificationAnswerRequest).answers); response.json(present(result)); } catch (cause) { next(cause); } });
  return router;
}
