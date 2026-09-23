import { and, asc, eq, gt, max } from 'drizzle-orm';
import { RepositoryError, type ConversationEvent } from '@automate/core';
import type { DatabaseConnection } from '../client';
import { conversationEvent } from '../schema';

/** Exclusive append/replay access to the ordered conversation transcript. */
export class ConversationEventRepository {
  constructor(private readonly connection: DatabaseConnection) {}
  append(executionId: number, event: ConversationEvent): ConversationEvent {
    try {
      this.connection.db
        .insert(conversationEvent)
        .values({
          executionId,
          seq: event.seq,
          kind: event.type,
          payload: JSON.stringify(event),
          at: event.at,
        })
        .run();
      return event;
    } catch (cause) {
      throw new RepositoryError(
        'The conversation event could not be saved.',
        cause,
      );
    }
  }
  listAfter(
    executionId: number,
    afterSeq: number,
    limit: number,
  ): { events: ConversationEvent[]; lastSeq: number; hasMore: boolean } {
    try {
      const rows = this.connection.db
        .select()
        .from(conversationEvent)
        .where(
          and(
            eq(conversationEvent.executionId, executionId),
            gt(conversationEvent.seq, afterSeq),
          ),
        )
        .orderBy(asc(conversationEvent.seq))
        .limit(limit + 1)
        .all();
      const hasMore = rows.length > limit;
      const visible = rows.slice(0, limit);
      const events = visible.map(
        (row) => JSON.parse(row.payload) as ConversationEvent,
      );
      return { events, lastSeq: events.at(-1)?.seq ?? afterSeq, hasMore };
    } catch (cause) {
      throw new RepositoryError(
        'The conversation transcript could not be read.',
        cause,
      );
    }
  }
  maxSeq(executionId: number): number {
    try {
      return (
        this.connection.db
          .select({ value: max(conversationEvent.seq) })
          .from(conversationEvent)
          .where(eq(conversationEvent.executionId, executionId))
          .get()?.value ?? 0
      );
    } catch (cause) {
      throw new RepositoryError(
        'The conversation sequence could not be read.',
        cause,
      );
    }
  }
}
