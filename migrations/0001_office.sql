-- Additive migration: existing proposal/account tables are never removed.
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS facility_tasks(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),data TEXT NOT NULL CHECK(json_valid(data)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)));
CREATE INDEX IF NOT EXISTS idx_facility_tasks_updated ON facility_tasks(deleted,updated_at);
CREATE TABLE IF NOT EXISTS facility_purchases(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),data TEXT NOT NULL CHECK(json_valid(data)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)));
CREATE INDEX IF NOT EXISTS idx_facility_purchases_updated ON facility_purchases(deleted,updated_at);
CREATE TABLE IF NOT EXISTS expense_projects(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),data TEXT NOT NULL CHECK(json_valid(data)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)));
CREATE INDEX IF NOT EXISTS idx_expense_projects_updated ON expense_projects(deleted,updated_at);
CREATE TABLE IF NOT EXISTS expense_vendors(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),data TEXT NOT NULL CHECK(json_valid(data)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)));
CREATE INDEX IF NOT EXISTS idx_expense_vendors_updated ON expense_vendors(deleted,updated_at);
CREATE TABLE IF NOT EXISTS item_purpose_templates(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),data TEXT NOT NULL CHECK(json_valid(data)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)));
CREATE INDEX IF NOT EXISTS idx_item_purpose_templates_updated ON item_purpose_templates(deleted,updated_at);
CREATE TABLE IF NOT EXISTS daily_reports(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),data TEXT NOT NULL CHECK(json_valid(data)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)));
CREATE INDEX IF NOT EXISTS idx_daily_reports_updated ON daily_reports(deleted,updated_at);
CREATE TABLE IF NOT EXISTS user_settings(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),data TEXT NOT NULL CHECK(json_valid(data)),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)));
CREATE INDEX IF NOT EXISTS idx_user_settings_updated ON user_settings(deleted,updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_name ON expense_vendors(json_extract(data,'$.name')) WHERE deleted=0;
CREATE TABLE IF NOT EXISTS expense_payments(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES expense_projects(id),vendor_name TEXT NOT NULL,payment_method TEXT NOT NULL CHECK(payment_method IN ('card','transfer')),expected_amount INTEGER NOT NULL CHECK(expected_amount>=0),actual_amount INTEGER CHECK(actual_amount>=0),payment_status TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),vendor_id TEXT NOT NULL REFERENCES expense_vendors(id));
CREATE INDEX IF NOT EXISTS idx_payments_project ON expense_payments(project_id);
CREATE INDEX IF NOT EXISTS idx_payments_vendor ON expense_payments(vendor_name);
CREATE TABLE IF NOT EXISTS facility_purchase_items(id TEXT PRIMARY KEY,purchase_id TEXT NOT NULL REFERENCES facility_purchases(id),data TEXT NOT NULL CHECK(json_valid(data)));
CREATE INDEX IF NOT EXISTS idx_purchase_items_parent ON facility_purchase_items(purchase_id);
CREATE TABLE IF NOT EXISTS activity_logs(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,action_type TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,previous_value TEXT,new_value TEXT,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_activity_date ON activity_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_logs(entity_id,created_at);
CREATE TABLE IF NOT EXISTS office_write_guard(value INTEGER CHECK(value=1));
CREATE TABLE IF NOT EXISTS office_snapshots(id TEXT PRIMARY KEY,data TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS office_admin(id INTEGER PRIMARY KEY CHECK(id=1),username TEXT NOT NULL,password_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS office_sessions(token TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS office_login_attempts(key TEXT PRIMARY KEY,count INTEGER NOT NULL,until_at INTEGER NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS idx_template_identity ON item_purpose_templates(json_extract(data,'$.type'),json_extract(data,'$.title')) WHERE deleted=0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_report_date ON daily_reports(json_extract(data,'$.date')) WHERE deleted=0;

CREATE TABLE IF NOT EXISTS office_revision(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
INSERT OR IGNORE INTO office_revision VALUES(1,0);
