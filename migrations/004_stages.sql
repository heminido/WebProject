ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS processing_stage VARCHAR(20)
  CHECK (processing_stage IN ('preparing', 'converting', 'saving'));
