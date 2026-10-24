-- 每日任务与工时记录：任务按计划日期归属，工时按实际执行日期归属。
CREATE TABLE daily_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  plan_date TEXT NOT NULL,
  requirement_id INTEGER REFERENCES requirements(id),
  planned_start_at TEXT,
  planned_end_at TEXT,
  estimated_minutes INTEGER NOT NULL CHECK (estimated_minutes > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX idx_daily_tasks_plan_date ON daily_tasks(plan_date);
CREATE INDEX idx_daily_tasks_requirement ON daily_tasks(requirement_id);

-- duration_seconds 由后端按开始/结束时间计算；active 记录 ended_at 为空。
CREATE TABLE daily_time_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES daily_tasks(id),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
  end_reason TEXT CHECK (end_reason IN ('manual', 'auto_18_00', 'daily_limit')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 全实例只允许一条活动计时；并发开始请求由部分唯一索引兜底。
CREATE UNIQUE INDEX idx_daily_time_entries_active ON daily_time_entries(status) WHERE status = 'active';
CREATE INDEX idx_daily_time_entries_task ON daily_time_entries(task_id);
CREATE INDEX idx_daily_time_entries_started ON daily_time_entries(started_at);

-- 手动修正工时审计：只追加，不更新或删除。
CREATE TABLE daily_time_entry_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES daily_time_entries(id),
  before_started_at TEXT NOT NULL,
  before_ended_at TEXT,
  after_started_at TEXT NOT NULL,
  after_ended_at TEXT,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_daily_time_entry_audits_entry ON daily_time_entry_audits(entry_id);
