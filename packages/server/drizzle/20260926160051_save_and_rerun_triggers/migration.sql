-- Custom SQL migration file, put your code below! --
CREATE TRIGGER template_revision_immutable BEFORE UPDATE OF template_id, revision_number, content_digest, entrypoint, summary, declared_inputs, declared_outputs, input_contract, contract_digest, runtime_fingerprint, runtime_detail, reads_wall_clock, note, created_at ON template_revision BEGIN SELECT RAISE(ABORT, 'template revisions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER template_revision_source_only_nulls BEFORE UPDATE OF source_execution_id ON template_revision WHEN NEW.source_execution_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'template revision provenance is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER template_revision_file_immutable BEFORE UPDATE ON template_revision_file BEGIN SELECT RAISE(ABORT, 'template revision files are immutable'); END;
--> statement-breakpoint
INSERT INTO conversation_event_kind (kind, owner, added_in) SELECT 'reuse_started', 'app', 'FEAT-111' WHERE NOT EXISTS (SELECT 1 FROM conversation_event_kind WHERE kind = 'reuse_started');
--> statement-breakpoint
INSERT INTO conversation_event_kind (kind, owner, added_in) SELECT 'task_saved', 'app', 'FEAT-111' WHERE NOT EXISTS (SELECT 1 FROM conversation_event_kind WHERE kind = 'task_saved');
