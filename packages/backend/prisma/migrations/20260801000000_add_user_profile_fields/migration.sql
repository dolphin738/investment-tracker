-- 为 users 表新增个人资料字段（头像 URL / 手机号 / 个人简介）
-- 三列均可空，仅 ADD COLUMN，不涉及 DROP 或 NOT NULL，向后兼容存量数据
ALTER TABLE "users" ADD COLUMN "avatar" VARCHAR(512);
ALTER TABLE "users" ADD COLUMN "phone" VARCHAR(20);
ALTER TABLE "users" ADD COLUMN "bio" VARCHAR(200);
