-- 问题枚举整备与正文 md 落盘（迁移 0009）
-- 正文唯一权威存储改为工作区 md 文件（requirements/{rid}/issues/{id}.md），
-- description/description_html 两列仅存量兼容保留；md 文件引导由迁移器在应用本迁移后执行。

-- 1. 分类枚举映射（空表时为空操作，重复执行幂等）
--    ui / development 取值不变
UPDATE issues SET issue_type = 'ui' WHERE issue_type = 'ui';
UPDATE issues SET issue_type = 'development' WHERE issue_type = 'development';
--    旧测试分类并入缺陷
UPDATE issues SET issue_type = 'defect' WHERE issue_type = 'testing';
--    旧需求变更分类 → change
UPDATE issues SET issue_type = 'change' WHERE issue_type = 'requirement';
--    旧其他分类 → question
UPDATE issues SET issue_type = 'question' WHERE issue_type = 'other';

-- 2. 状态枚举映射：open→pending、in_progress→processing、closed→resolved（解决时间缺失时以更新时间兜底）
UPDATE issues SET status = 'pending' WHERE status = 'open';
UPDATE issues SET status = 'processing' WHERE status = 'in_progress';
UPDATE issues SET status = 'resolved', resolved_at = COALESCE(resolved_at, updated_at) WHERE status = 'closed';
