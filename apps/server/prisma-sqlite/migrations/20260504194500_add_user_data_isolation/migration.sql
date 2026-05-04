ALTER TABLE "accounts" ADD COLUMN "user_id" TEXT;

CREATE TABLE "user_feeds" (
    "user_id" TEXT NOT NULL,
    "feed_id" TEXT NOT NULL,
    "status" INTEGER NOT NULL DEFAULT 1,
    "category" TEXT NOT NULL DEFAULT '',
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_feeds_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "user_feeds_feed_id_fkey" FOREIGN KEY ("feed_id") REFERENCES "feeds" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "accounts_user_id_idx" ON "accounts"("user_id");
CREATE INDEX "user_feeds_feed_id_idx" ON "user_feeds"("feed_id");
CREATE UNIQUE INDEX "user_feeds_user_id_feed_id_key" ON "user_feeds"("user_id", "feed_id");

UPDATE "accounts"
SET "user_id" = (SELECT "id" FROM "users" WHERE "username" = 'admin' LIMIT 1)
WHERE "user_id" IS NULL;

INSERT OR IGNORE INTO "user_feeds" ("user_id", "feed_id", "status", "category", "created_at", "updated_at")
SELECT "users"."id", "feeds"."id", "feeds"."status", "feeds"."category", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "users"
JOIN "feeds"
WHERE "users"."username" = 'admin';
