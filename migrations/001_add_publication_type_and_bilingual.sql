-- 001_add_publication_type_and_bilingual.sql
-- 用途：为后续关系型存储接入提供兼容升级脚本。

ALTER TABLE papers
  ADD COLUMN IF NOT EXISTS publication_type TEXT;

ALTER TABLE papers
  ADD COLUMN IF NOT EXISTS title_zh TEXT;

ALTER TABLE papers
  ADD COLUMN IF NOT EXISTS abstract_zh TEXT;

CREATE INDEX IF NOT EXISTS idx_papers_published_date
  ON papers (published_date);

CREATE INDEX IF NOT EXISTS idx_papers_publication_type
  ON papers (publication_type);
