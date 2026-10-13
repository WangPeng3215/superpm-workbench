import { migrateDefaultDatabase } from "./connection.js";
console.info(`数据库迁移完成：${migrateDefaultDatabase()}`);
