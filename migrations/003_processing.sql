ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS output_name TEXT,
  ADD COLUMN IF NOT EXISTS error_message TEXT,
  ADD COLUMN IF NOT EXISTS worker_name TEXT,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS tasks_queue_idx ON tasks (created_at, id) WHERE status = 'queued';
