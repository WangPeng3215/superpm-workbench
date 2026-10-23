import { prepareHomeIfConfigured } from "../config/home-migration.js";
import { migrateDefaultDatabase } from "./connection.js";

await prepareHomeIfConfigured();
console.info(`数据库迁移完成：${migrateDefaultDatabase()}`);
