-- 最终确认版本标记：文件与外部链接可标记，文件夹保持 0。
ALTER TABLE artifact_nodes ADD COLUMN is_final INTEGER NOT NULL DEFAULT 0;
ALTER TABLE artifact_links ADD COLUMN is_final INTEGER NOT NULL DEFAULT 0;
