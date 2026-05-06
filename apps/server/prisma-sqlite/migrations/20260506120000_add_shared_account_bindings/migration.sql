CREATE TABLE "account_users" (
    "user_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "account_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "account_users_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT OR IGNORE INTO "account_users" ("user_id", "account_id", "created_at", "updated_at")
SELECT "user_id", "id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "accounts"
WHERE "user_id" IS NOT NULL;

UPDATE "accounts"
SET "user_id" = NULL
WHERE "user_id" IS NOT NULL;

CREATE INDEX "account_users_account_id_idx" ON "account_users"("account_id");
CREATE UNIQUE INDEX "account_users_user_id_account_id_key" ON "account_users"("user_id", "account_id");
