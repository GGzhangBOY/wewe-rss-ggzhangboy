CREATE TABLE "knowledge_conversations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "categories" TEXT NOT NULL DEFAULT '[]',
    "use_knowledge_base" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "knowledge_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "knowledge_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversation_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sources" TEXT NOT NULL DEFAULT '[]',
    "sequence" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "knowledge_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "knowledge_conversations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "knowledge_conversations_user_id_idx" ON "knowledge_conversations"("user_id");
CREATE INDEX "knowledge_conversations_updated_at_idx" ON "knowledge_conversations"("updated_at");
CREATE INDEX "knowledge_messages_conversation_id_idx" ON "knowledge_messages"("conversation_id");
CREATE INDEX "knowledge_messages_sequence_idx" ON "knowledge_messages"("sequence");
