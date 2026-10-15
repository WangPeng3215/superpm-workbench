-- 文件条目支持链接形态：kind 区分文件与链接，链接条目仅存 URL 不落盘
ALTER TABLE requirement_files ADD COLUMN kind TEXT NOT NULL DEFAULT 'file';
ALTER TABLE requirement_files ADD COLUMN link_url TEXT;
