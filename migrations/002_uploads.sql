ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS storage_name TEXT,
  ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT CHECK (file_size_bytes > 0);
