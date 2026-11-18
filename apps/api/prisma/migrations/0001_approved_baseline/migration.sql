-- M02-T01: Prisma 7.10.1 mechanical translation; domain definitions unchanged.
-- Approved schema SHA-256: e1b6f64a4317d67028977ff32e15be27fb9408f3163cbb9d94fccb0c8bd153ef
-- Approved guard SHA-256: d65707ef927fcbd8f37f06dc1c4a2b2c4d440201d3b48934443555805bd77ee1
BEGIN;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'DISABLED', 'DELETION_REQUESTED', 'PURGING', 'DELETED');

-- CreateEnum
CREATE TYPE "IdeaStatus" AS ENUM ('ACTIVE', 'ARCHIVED', 'DELETION_REQUESTED', 'PURGING', 'DELETED');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "GenerationStatus" AS ENUM ('PENDING', 'RUNNING', 'CANCEL_REQUESTED', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ThinkingStrategy" AS ENUM ('EXPLORE', 'CHALLENGE', 'INFORM', 'COMPARE', 'ACT', 'REFLECT');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'EDITED_AND_ACCEPTED', 'DISMISSED', 'INVALIDATED');

-- CreateEnum
CREATE TYPE "ProposalKind" AS ENUM ('FACT', 'HYPOTHESIS', 'DECISION', 'LEARNING', 'CORRECTION');

-- CreateEnum
CREATE TYPE "MemoryKind" AS ENUM ('FACT', 'HYPOTHESIS', 'DECISION', 'LEARNING');

-- CreateEnum
CREATE TYPE "MemoryStatus" AS ENUM ('ACTIVE', 'REMOVED');

-- CreateEnum
CREATE TYPE "AssumptionStatus" AS ENUM ('PROPOSED', 'ACTIVE', 'REVISED', 'ARCHIVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ExperimentStatus" AS ENUM ('SUGGESTED', 'PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ResearchStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'INSUFFICIENT_EVIDENCE', 'FAILED', 'LIMIT_REACHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EvidenceOrigin" AS ENUM ('EXTERNAL_SOURCE', 'USER_REPORT', 'MODEL_INFERENCE');

-- CreateEnum
CREATE TYPE "EvidenceTrust" AS ENUM ('UNASSESSED', 'SOURCE_CHECKED', 'CONTESTED', 'STALE', 'OUT_OF_SCOPE', 'UNVERIFIABLE');

-- CreateEnum
CREATE TYPE "EvidenceRelation" AS ENUM ('SUPPORTS', 'CHALLENGES', 'INCONCLUSIVE');

-- CreateEnum
CREATE TYPE "SnapshotStatus" AS ENUM ('DRAFT', 'REVIEWING', 'APPROVED');

-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'CLAIMED', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "DataOperationKind" AS ENUM ('EXPORT', 'DELETE_IDEA', 'DELETE_ACCOUNT');

-- CreateEnum
CREATE TYPE "DataOperationStatus" AS ENUM ('REQUESTED', 'RUNNING', 'WAITING_RETRY', 'REQUIRES_ATTENTION', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "DeletionState" AS ENUM ('ACTIVE', 'DELETION_REQUESTED', 'PURGING', 'DELETED');

-- CreateEnum
CREATE TYPE "WebhookInboxStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'APPLIED', 'IGNORED', 'FAILED');

-- CreateEnum
CREATE TYPE "ArtifactState" AS ENUM ('AVAILABLE', 'EXPIRED', 'PURGED');

-- CreateTable
CREATE TABLE "UserAccount" (
    "id" UUID NOT NULL,
    "clerkSubject" VARCHAR(255) NOT NULL,
    "clerkInstanceId" VARCHAR(100) NOT NULL,
    "subjectKey" CHAR(64) NOT NULL,
    "subjectKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "providerObjectUpdatedAt" TIMESTAMPTZ(3),
    "providerEventAt" TIMESTAMPTZ(3),
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "preferencesVersion" INTEGER NOT NULL DEFAULT 1,
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "UserAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Idea" (
    "id" UUID NOT NULL,
    "contextEpoch" INTEGER NOT NULL DEFAULT 0,
    "ownerId" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "summary" TEXT,
    "status" "IdeaStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Idea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" UUID NOT NULL,
    "ideaId" UUID NOT NULL,
    "title" VARCHAR(200),
    "status" "ConversationStatus" NOT NULL DEFAULT 'ACTIVE',
    "metadataVersion" INTEGER NOT NULL DEFAULT 1,
    "proactiveResearch" BOOLEAN NOT NULL DEFAULT true,
    "nextSequence" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" UUID NOT NULL,
    "ideaId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" JSONB NOT NULL,
    "contentSchemaVersion" INTEGER NOT NULL DEFAULT 1,
    "clientSubmissionKey" VARCHAR(128),
    "submissionSha256" CHAR(64),
    "generationAttemptId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationAttempt" (
    "orchestrationMetadata" JSONB,
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "triggerMessageId" UUID NOT NULL,
    "contextEpoch" INTEGER,
    "dispatchAuthorizedAt" TIMESTAMPTZ(3),
    "attemptNumber" INTEGER NOT NULL,
    "regenerationKey" VARCHAR(128),
    "status" "GenerationStatus" NOT NULL DEFAULT 'PENDING',
    "strategy" "ThinkingStrategy",
    "selectedAt" TIMESTAMPTZ(3),
    "provider" VARCHAR(80),
    "model" VARCHAR(100),
    "errorCode" VARCHAR(100),
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseEpoch" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMPTZ(3),
    "lastHeartbeatAt" TIMESTAMPTZ(3),
    "deadlineAt" TIMESTAMPTZ(3) NOT NULL,
    "executionAttempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "GenerationAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryProposal" (
    "id" UUID NOT NULL,
    "ideaId" UUID NOT NULL,
    "sourceMessageId" UUID,
    "targetMemoryId" UUID,
    "expectedMemoryVersion" INTEGER,
    "resultMemoryId" UUID,
    "kind" "ProposalKind" NOT NULL,
    "candidate" JSONB NOT NULL,
    "provenance" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "ProposalStatus" NOT NULL DEFAULT 'PROPOSED',
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfirmedMemory" (
    "id" UUID NOT NULL,
    "ideaId" UUID NOT NULL,
    "kind" "MemoryKind" NOT NULL,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "currentContent" JSONB NOT NULL,
    "status" "MemoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "assumptionId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ConfirmedMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryRevision" (
    "id" UUID NOT NULL,
    "memoryId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "provenance" JSONB NOT NULL DEFAULT '{}',
    "actorId" UUID NOT NULL,
    "reason" VARCHAR(300),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assumption" (
    "id" UUID NOT NULL,
    "ideaId" UUID NOT NULL,
    "statement" TEXT NOT NULL,
    "status" "AssumptionStatus" NOT NULL DEFAULT 'PROPOSED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "evidenceStatus" VARCHAR(40) NOT NULL DEFAULT 'UNTESTED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Assumption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Experiment" (
    "id" UUID NOT NULL,
    "ideaId" UUID NOT NULL,
    "assumptionId" UUID,
    "hypothesis" TEXT NOT NULL,
    "plan" JSONB NOT NULL,
    "successCriteria" JSONB NOT NULL,
    "status" "ExperimentStatus" NOT NULL DEFAULT 'SUGGESTED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "acceptedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Experiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Learning" (
    "id" UUID NOT NULL,
    "ideaId" UUID NOT NULL,
    "experimentId" UUID,
    "observation" TEXT,
    "interpretation" TEXT NOT NULL,
    "origin" "EvidenceOrigin" NOT NULL DEFAULT 'USER_REPORT',
    "approvedById" UUID NOT NULL,
    "evidenceLinksRecorded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Learning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchJob" (
    "id" UUID NOT NULL,
    "ideaId" UUID NOT NULL,
    "triggerMessageId" UUID,
    "query" TEXT NOT NULL,
    "dedupeKey" VARCHAR(128) NOT NULL,
    "budget" JSONB NOT NULL,
    "status" "ResearchStatus" NOT NULL DEFAULT 'QUEUED',
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "errorCode" VARCHAR(80),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseEpoch" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMPTZ(3),
    "lastHeartbeatAt" TIMESTAMPTZ(3),
    "deadlineAt" TIMESTAMPTZ(3) NOT NULL,
    "executionAttempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ResearchJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidenceRecord" (
    "id" UUID NOT NULL,
    "ideaId" UUID NOT NULL,
    "researchJobId" UUID,
    "origin" "EvidenceOrigin" NOT NULL,
    "trust" "EvidenceTrust" NOT NULL DEFAULT 'UNASSESSED',
    "finding" TEXT NOT NULL,
    "sourceTitle" VARCHAR(500),
    "sourceLocator" TEXT,
    "sourcePublisher" VARCHAR(255),
    "sourceObservedAt" TIMESTAMPTZ(3),
    "retrievedAt" TIMESTAMPTZ(3),
    "geography" VARCHAR(200),
    "periodStart" DATE,
    "periodEnd" DATE,
    "limitations" TEXT,
    "dedupeFingerprint" VARCHAR(128),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssumptionEvidence" (
    "ideaId" UUID NOT NULL,
    "assumptionId" UUID NOT NULL,
    "evidenceId" UUID NOT NULL,
    "relationship" "EvidenceRelation" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssumptionEvidence_pkey" PRIMARY KEY ("assumptionId","evidenceId")
);

-- CreateTable
CREATE TABLE "LearningEvidence" (
    "ideaId" UUID NOT NULL,
    "learningId" UUID NOT NULL,
    "evidenceId" UUID NOT NULL,

    CONSTRAINT "LearningEvidence_pkey" PRIMARY KEY ("learningId","evidenceId")
);

-- CreateTable
CREATE TABLE "DocumentSnapshot" (
    "id" UUID NOT NULL,
    "ideaId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "SnapshotStatus" NOT NULL DEFAULT 'DRAFT',
    "content" JSONB NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "draftRevision" INTEGER NOT NULL DEFAULT 1,
    "contentSha256" CHAR(64),
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "DocumentSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExportJob" (
    "artifactState" "ArtifactState",
    "artifactExpiresAt" TIMESTAMPTZ(3),
    "id" UUID NOT NULL,
    "ideaId" UUID NOT NULL,
    "snapshotId" UUID NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "status" "ExportStatus" NOT NULL DEFAULT 'QUEUED',
    "objectKey" VARCHAR(600),
    "fileSha256" CHAR(64),
    "errorCode" VARCHAR(80),
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseEpoch" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMPTZ(3),
    "lastHeartbeatAt" TIMESTAMPTZ(3),
    "deadlineAt" TIMESTAMPTZ(3) NOT NULL,
    "executionAttempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ExportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "kind" VARCHAR(100) NOT NULL,
    "aggregateType" VARCHAR(60) NOT NULL,
    "aggregateId" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "lastErrorCode" VARCHAR(100),
    "claimEpoch" INTEGER NOT NULL DEFAULT 0,
    "dispatchAttempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMPTZ(3),
    "publishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" VARCHAR(100) NOT NULL,
    "resourceType" VARCHAR(80) NOT NULL,
    "resourceId" UUID,
    "ideaId" UUID,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageLedger" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "operationType" VARCHAR(60) NOT NULL,
    "provider" VARCHAR(80),
    "reservationId" UUID NOT NULL,
    "reservationState" VARCHAR(20) NOT NULL DEFAULT 'RESERVED',
    "reservedUnits" DECIMAL(16,5) NOT NULL,
    "measuredUnits" DECIMAL(16,5) NOT NULL,
    "unit" VARCHAR(40) NOT NULL,
    "reconciliationKey" VARCHAR(128) NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataOperation" (
    "fileSha256" CHAR(64),
    "capturedAt" TIMESTAMPTZ(3),
    "id" UUID NOT NULL,
    "accountId" UUID,
    "ideaId" UUID,
    "kind" "DataOperationKind" NOT NULL,
    "status" "DataOperationStatus" NOT NULL DEFAULT 'REQUESTED',
    "cleanupCheckpoint" JSONB NOT NULL DEFAULT '{}',
    "objectKey" VARCHAR(600),
    "errorCode" VARCHAR(100),
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "leaseEpoch" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMPTZ(3),
    "lastHeartbeatAt" TIMESTAMPTZ(3),
    "deadlineAt" TIMESTAMPTZ(3) NOT NULL,
    "executionAttempts" INTEGER NOT NULL DEFAULT 0,
    "clerkInstanceId" VARCHAR(100) NOT NULL,
    "ownerSubjectKey" CHAR(64) NOT NULL,
    "subjectKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "reverificationKey" CHAR(64),
    "deletionScopeKey" VARCHAR(200),
    "deletionState" "DeletionState",
    "policyVersion" VARCHAR(60) NOT NULL,
    "livePurgedAt" TIMESTAMPTZ(3),
    "backupResidualUntil" TIMESTAMPTZ(3),
    "receiptMirroredAt" TIMESTAMPTZ(3),
    "retainUntil" TIMESTAMPTZ(3),
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "artifactState" "ArtifactState",
    "artifactExpiresAt" TIMESTAMPTZ(3),

    CONSTRAINT "DataOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "operationType" VARCHAR(100) NOT NULL,
    "targetScope" VARCHAR(200) NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "requestFingerprint" CHAR(64) NOT NULL,
    "algorithmVersion" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(30) NOT NULL,
    "responseStatus" INTEGER,
    "responseRef" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookInbox" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(30) NOT NULL DEFAULT 'clerk',
    "clerkInstanceId" VARCHAR(100) NOT NULL,
    "eventId" VARCHAR(128) NOT NULL,
    "eventType" VARCHAR(100) NOT NULL,
    "bodySha256" CHAR(64) NOT NULL,
    "subjectKey" CHAR(64),
    "subjectKeyVersion" INTEGER,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "objectUpdatedAt" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReceivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "WebhookInboxStatus" NOT NULL DEFAULT 'RECEIVED',
    "leaseEpoch" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMPTZ(3),
    "lastHeartbeatAt" TIMESTAMPTZ(3),
    "deadlineAt" TIMESTAMPTZ(3) NOT NULL,
    "executionAttempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastErrorCode" VARCHAR(100),
    "processedAt" TIMESTAMPTZ(3),

    CONSTRAINT "WebhookInbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityTombstone" (
    "id" UUID NOT NULL,
    "clerkInstanceId" VARCHAR(100) NOT NULL,
    "subjectKey" CHAR(64) NOT NULL,
    "subjectKeyVersion" INTEGER NOT NULL,
    "deletionOperationId" UUID,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL,
    "livePurgedAt" TIMESTAMPTZ(3),
    "retainUntil" TIMESTAMPTZ(3),
    "lastProviderEventAt" TIMESTAMPTZ(3),

    CONSTRAINT "IdentityTombstone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserAccount_clerkSubject_key" ON "UserAccount"("clerkSubject");

-- CreateIndex
CREATE UNIQUE INDEX "UserAccount_subjectKey_key" ON "UserAccount"("subjectKey");

-- CreateIndex
CREATE INDEX "Idea_ownerId_updatedAt_idx" ON "Idea"("ownerId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "Conversation_ideaId_updatedAt_idx" ON "Conversation"("ideaId", "updatedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_id_ideaId_key" ON "Conversation"("id", "ideaId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_generationAttemptId_key" ON "Message"("generationAttemptId");

-- CreateIndex
CREATE INDEX "Message_ideaId_createdAt_idx" ON "Message"("ideaId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_generationAttemptId_conversationId_key" ON "Message"("generationAttemptId", "conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_conversationId_sequence_key" ON "Message"("conversationId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "Message_id_conversationId_key" ON "Message"("id", "conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_id_ideaId_key" ON "Message"("id", "ideaId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_conversationId_clientSubmissionKey_key" ON "Message"("conversationId", "clientSubmissionKey");

-- CreateIndex
CREATE INDEX "GenerationAttempt_conversationId_createdAt_idx" ON "GenerationAttempt"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationAttempt_triggerMessageId_attemptNumber_key" ON "GenerationAttempt"("triggerMessageId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationAttempt_conversationId_regenerationKey_key" ON "GenerationAttempt"("conversationId", "regenerationKey");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationAttempt_id_conversationId_key" ON "GenerationAttempt"("id", "conversationId");

-- CreateIndex
CREATE INDEX "MemoryProposal_ideaId_status_createdAt_idx" ON "MemoryProposal"("ideaId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ConfirmedMemory_ideaId_status_idx" ON "ConfirmedMemory"("ideaId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ConfirmedMemory_id_ideaId_key" ON "ConfirmedMemory"("id", "ideaId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryRevision_memoryId_version_key" ON "MemoryRevision"("memoryId", "version");

-- CreateIndex
CREATE INDEX "Assumption_ideaId_status_idx" ON "Assumption"("ideaId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Assumption_id_ideaId_key" ON "Assumption"("id", "ideaId");

-- CreateIndex
CREATE INDEX "Experiment_ideaId_status_idx" ON "Experiment"("ideaId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Experiment_id_ideaId_key" ON "Experiment"("id", "ideaId");

-- CreateIndex
CREATE INDEX "Learning_ideaId_createdAt_idx" ON "Learning"("ideaId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Learning_id_ideaId_key" ON "Learning"("id", "ideaId");

-- CreateIndex
CREATE INDEX "ResearchJob_ideaId_status_idx" ON "ResearchJob"("ideaId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchJob_ideaId_dedupeKey_key" ON "ResearchJob"("ideaId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchJob_id_ideaId_key" ON "ResearchJob"("id", "ideaId");

-- CreateIndex
CREATE INDEX "EvidenceRecord_ideaId_createdAt_idx" ON "EvidenceRecord"("ideaId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceRecord_id_ideaId_key" ON "EvidenceRecord"("id", "ideaId");

-- CreateIndex
CREATE UNIQUE INDEX "EvidenceRecord_ideaId_dedupeFingerprint_key" ON "EvidenceRecord"("ideaId", "dedupeFingerprint");

-- CreateIndex
CREATE INDEX "AssumptionEvidence_evidenceId_idx" ON "AssumptionEvidence"("evidenceId");

-- CreateIndex
CREATE INDEX "LearningEvidence_ideaId_learningId_idx" ON "LearningEvidence"("ideaId", "learningId");

-- CreateIndex
CREATE INDEX "LearningEvidence_evidenceId_ideaId_idx" ON "LearningEvidence"("evidenceId", "ideaId");

-- CreateIndex
CREATE INDEX "DocumentSnapshot_ideaId_createdAt_idx" ON "DocumentSnapshot"("ideaId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentSnapshot_ideaId_version_key" ON "DocumentSnapshot"("ideaId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentSnapshot_id_ideaId_key" ON "DocumentSnapshot"("id", "ideaId");

-- CreateIndex
CREATE INDEX "ExportJob_snapshotId_createdAt_idx" ON "ExportJob"("snapshotId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ExportJob_ideaId_status_idx" ON "ExportJob"("ideaId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ExportJob_snapshotId_idempotencyKey_key" ON "ExportJob"("snapshotId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_nextAttemptAt_idx" ON "OutboxEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "AuditEvent_actorId_occurredAt_idx" ON "AuditEvent"("actorId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "AuditEvent_ideaId_occurredAt_idx" ON "AuditEvent"("ideaId", "occurredAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "UsageLedger_reservationId_key" ON "UsageLedger"("reservationId");

-- CreateIndex
CREATE INDEX "UsageLedger_accountId_occurredAt_idx" ON "UsageLedger"("accountId", "occurredAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "UsageLedger_accountId_reconciliationKey_key" ON "UsageLedger"("accountId", "reconciliationKey");

-- CreateIndex
CREATE UNIQUE INDEX "DataOperation_reverificationKey_key" ON "DataOperation"("reverificationKey");

-- CreateIndex
CREATE UNIQUE INDEX "DataOperation_deletionScopeKey_key" ON "DataOperation"("deletionScopeKey");

-- CreateIndex
CREATE INDEX "DataOperation_accountId_requestedAt_idx" ON "DataOperation"("accountId", "requestedAt" DESC);

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_accountId_operationType_targetScope_key_key" ON "IdempotencyRecord"("accountId", "operationType", "targetScope", "key");

-- CreateIndex
CREATE INDEX "WebhookInbox_status_nextAttemptAt_idx" ON "WebhookInbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookInbox_provider_clerkInstanceId_eventId_key" ON "WebhookInbox"("provider", "clerkInstanceId", "eventId");

-- CreateIndex
CREATE INDEX "IdentityTombstone_retainUntil_idx" ON "IdentityTombstone"("retainUntil");

-- CreateIndex
CREATE UNIQUE INDEX "IdentityTombstone_clerkInstanceId_subjectKey_key" ON "IdentityTombstone"("clerkInstanceId", "subjectKey");

-- AddForeignKey
ALTER TABLE "Idea" ADD CONSTRAINT "Idea_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "UserAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_ideaId_fkey" FOREIGN KEY ("conversationId", "ideaId") REFERENCES "Conversation"("id", "ideaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_generationAttemptId_conversationId_fkey" FOREIGN KEY ("generationAttemptId", "conversationId") REFERENCES "GenerationAttempt"("id", "conversationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationAttempt" ADD CONSTRAINT "GenerationAttempt_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationAttempt" ADD CONSTRAINT "GenerationAttempt_triggerMessageId_conversationId_fkey" FOREIGN KEY ("triggerMessageId", "conversationId") REFERENCES "Message"("id", "conversationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryProposal" ADD CONSTRAINT "MemoryProposal_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryProposal" ADD CONSTRAINT "MemoryProposal_sourceMessageId_ideaId_fkey" FOREIGN KEY ("sourceMessageId", "ideaId") REFERENCES "Message"("id", "ideaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryProposal" ADD CONSTRAINT "MemoryProposal_targetMemoryId_ideaId_fkey" FOREIGN KEY ("targetMemoryId", "ideaId") REFERENCES "ConfirmedMemory"("id", "ideaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfirmedMemory" ADD CONSTRAINT "ConfirmedMemory_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfirmedMemory" ADD CONSTRAINT "ConfirmedMemory_assumptionId_ideaId_fkey" FOREIGN KEY ("assumptionId", "ideaId") REFERENCES "Assumption"("id", "ideaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryRevision" ADD CONSTRAINT "MemoryRevision_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES "ConfirmedMemory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assumption" ADD CONSTRAINT "Assumption_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_assumptionId_ideaId_fkey" FOREIGN KEY ("assumptionId", "ideaId") REFERENCES "Assumption"("id", "ideaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Learning" ADD CONSTRAINT "Learning_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Learning" ADD CONSTRAINT "Learning_experimentId_ideaId_fkey" FOREIGN KEY ("experimentId", "ideaId") REFERENCES "Experiment"("id", "ideaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchJob" ADD CONSTRAINT "ResearchJob_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchJob" ADD CONSTRAINT "ResearchJob_triggerMessageId_ideaId_fkey" FOREIGN KEY ("triggerMessageId", "ideaId") REFERENCES "Message"("id", "ideaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceRecord" ADD CONSTRAINT "EvidenceRecord_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvidenceRecord" ADD CONSTRAINT "EvidenceRecord_researchJobId_ideaId_fkey" FOREIGN KEY ("researchJobId", "ideaId") REFERENCES "ResearchJob"("id", "ideaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssumptionEvidence" ADD CONSTRAINT "AssumptionEvidence_assumptionId_ideaId_fkey" FOREIGN KEY ("assumptionId", "ideaId") REFERENCES "Assumption"("id", "ideaId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssumptionEvidence" ADD CONSTRAINT "AssumptionEvidence_evidenceId_ideaId_fkey" FOREIGN KEY ("evidenceId", "ideaId") REFERENCES "EvidenceRecord"("id", "ideaId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningEvidence" ADD CONSTRAINT "LearningEvidence_learningId_ideaId_fkey" FOREIGN KEY ("learningId", "ideaId") REFERENCES "Learning"("id", "ideaId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LearningEvidence" ADD CONSTRAINT "LearningEvidence_evidenceId_ideaId_fkey" FOREIGN KEY ("evidenceId", "ideaId") REFERENCES "EvidenceRecord"("id", "ideaId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "DocumentSnapshot" ADD CONSTRAINT "DocumentSnapshot_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "Idea"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_snapshotId_ideaId_fkey" FOREIGN KEY ("snapshotId", "ideaId") REFERENCES "DocumentSnapshot"("id", "ideaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "UserAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageLedger" ADD CONSTRAINT "UsageLedger_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "UserAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataOperation" ADD CONSTRAINT "DataOperation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "UserAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "UserAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Approved SQL guards follow all generated tables/types/FKs.
-- Founder's Lens: SQL guards to append to a Prisma-generated migration.
-- Apply only AFTER Prisma-generated CREATE TYPE / CREATE TABLE / FK statements.
-- Requires PostgreSQL 15+. Re-run only in fresh migration; not a standalone idempotent script.
-- Snapshot immutability, generation selection, content provenance and structural checks.

CREATE UNIQUE INDEX "GenerationAttempt_one_active_per_conversation"
  ON "GenerationAttempt" ("conversationId")
  WHERE "status" IN ('PENDING'::"GenerationStatus", 'RUNNING'::"GenerationStatus", 'CANCEL_REQUESTED'::"GenerationStatus");

CREATE UNIQUE INDEX "GenerationAttempt_one_selected_per_user_turn"
  ON "GenerationAttempt" ("triggerMessageId")
  WHERE "selectedAt" IS NOT NULL;

ALTER TABLE "GenerationAttempt" ADD CONSTRAINT "generation_selected_only_if_complete"
  CHECK ("selectedAt" IS NULL OR "status" = 'COMPLETED'::"GenerationStatus");
ALTER TABLE "GenerationAttempt" ADD CONSTRAINT "generation_attempt_number_positive" CHECK ("attemptNumber" > 0);
ALTER TABLE "Message" ADD CONSTRAINT "message_sequence_positive" CHECK ("sequence" > 0);
ALTER TABLE "Message" ADD CONSTRAINT "user_message_requires_submission_key"
  CHECK (("role" = 'USER'::"MessageRole" AND "clientSubmissionKey" IS NOT NULL AND "submissionSha256" IS NOT NULL AND "generationAttemptId" IS NULL)
      OR ("role" = 'ASSISTANT'::"MessageRole" AND "clientSubmissionKey" IS NULL AND "submissionSha256" IS NULL AND "generationAttemptId" IS NOT NULL));
-- SYSTEM messages are intentionally disallowed for v1 user-visible transcript; system prompts stay outside Message.
ALTER TABLE "DocumentSnapshot" ADD CONSTRAINT "draft_revision_positive" CHECK ("draftRevision" > 0);
ALTER TABLE "Idea" ADD CONSTRAINT "idea_version_positive" CHECK ("version" > 0);
ALTER TABLE "Assumption" ADD CONSTRAINT "assumption_version_positive" CHECK ("version" > 0);
ALTER TABLE "Experiment" ADD CONSTRAINT "experiment_version_positive" CHECK ("version" > 0);
ALTER TABLE "ConfirmedMemory" ADD CONSTRAINT "memory_version_positive" CHECK ("currentVersion" > 0);
ALTER TABLE "MemoryRevision" ADD CONSTRAINT "memory_revision_version_positive" CHECK ("version" > 0);
ALTER TABLE "Conversation" ADD CONSTRAINT "conversation_next_sequence_positive" CHECK ("nextSequence" > 0);
ALTER TABLE "EvidenceRecord" ADD CONSTRAINT "evidence_date_range_valid"
  CHECK ("periodStart" IS NULL OR "periodEnd" IS NULL OR "periodStart" <= "periodEnd");
ALTER TABLE "EvidenceRecord" ADD CONSTRAINT "checked_source_requires_provenance"
  CHECK ("trust" <> 'SOURCE_CHECKED'::"EvidenceTrust" OR
    ("origin" = 'EXTERNAL_SOURCE'::"EvidenceOrigin" AND "sourceLocator" IS NOT NULL AND "retrievedAt" IS NOT NULL));
ALTER TABLE "DocumentSnapshot" ADD CONSTRAINT "approval_requires_metadata"
  CHECK (("status" <> 'APPROVED'::"SnapshotStatus") OR
    ("contentSha256" IS NOT NULL AND "approvedAt" IS NOT NULL AND "approvedById" IS NOT NULL));
ALTER TABLE "ExportJob" ADD CONSTRAINT "completed_export_has_artifact"
  CHECK ("status" <> 'COMPLETED'::"ExportStatus" OR
    ("objectKey" IS NOT NULL AND "fileSha256" IS NOT NULL AND "completedAt" IS NOT NULL
      AND "artifactState" IS NOT NULL AND "artifactExpiresAt" IS NOT NULL));
ALTER TABLE "MemoryProposal" ADD CONSTRAINT "review_metadata_present"
  CHECK ("status" = 'PROPOSED'::"ProposalStatus" OR "status" = 'INVALIDATED'::"ProposalStatus" OR
    ("reviewedAt" IS NOT NULL AND "reviewedById" IS NOT NULL));
ALTER TABLE "MemoryProposal" ADD CONSTRAINT "target_version_consistency"
  CHECK (("targetMemoryId" IS NULL AND "expectedMemoryVersion" IS NULL) OR
    ("targetMemoryId" IS NOT NULL AND "expectedMemoryVersion" IS NOT NULL AND "expectedMemoryVersion" > 0));

-- Design migration fragment: role/entry-point grants are specified in physical-design §13.
-- This helper is SECURITY INVOKER: custom settings alone never grant purge authority.
CREATE OR REPLACE FUNCTION fl_privacy_delete_authorized(row_idea uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE op_id uuid; epoch integer;
BEGIN
  IF current_user <> 'fl_purge_owner' THEN RETURN false; END IF;
  op_id := nullif(current_setting('fl.purge_operation', true), '')::uuid;
  epoch := nullif(current_setting('fl.purge_epoch', true), '')::integer;
  RETURN EXISTS (
    SELECT 1 FROM public."DataOperation" d JOIN public."Idea" i ON i."id" = row_idea
    WHERE d."id" = op_id AND d."status" = 'RUNNING'::public."DataOperationStatus" AND d."leaseEpoch" = epoch AND d."leaseUntil" > statement_timestamp()
      AND d."deletionState" = 'PURGING'::public."DeletionState"
      AND i."status" = 'PURGING'::public."IdeaStatus"
      AND ((d."kind" = 'DELETE_IDEA'::public."DataOperationKind" AND d."ideaId" = row_idea)
        OR (d."kind" = 'DELETE_ACCOUNT'::public."DataOperationKind" AND d."accountId" = i."ownerId"))
  );
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION fl_prevent_immutable_revision_change() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP = 'DELETE' AND public.fl_privacy_delete_authorized(
    (SELECT "ideaId" FROM public."ConfirmedMemory" WHERE "id" = OLD."memoryId")
  ) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'immutable memory revision';
END $$;
CREATE TRIGGER fl_memory_revision_append_only
  BEFORE UPDATE OR DELETE ON "MemoryRevision"
  FOR EACH ROW EXECUTE FUNCTION fl_prevent_immutable_revision_change();

CREATE OR REPLACE FUNCTION fl_protect_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.fl_privacy_delete_authorized(OLD."ideaId") THEN RETURN OLD; END IF;
    -- All ordinary approved-snapshot deletion remains forbidden.
    IF OLD."status" = 'APPROVED'::"SnapshotStatus" THEN
      RAISE EXCEPTION 'approved snapshot requires controlled purge';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'APPROVED'::"SnapshotStatus" THEN
    RAISE EXCEPTION 'approved snapshot is immutable';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."ideaId" <> OLD."ideaId" OR NEW."version" <> OLD."version" THEN
    RAISE EXCEPTION 'snapshot identity/version cannot change';
  END IF;
  -- Editing a review preview returns it to DRAFT; APPROVED remains protected.
  RETURN NEW;
END $$;
CREATE TRIGGER fl_snapshot_guard
  BEFORE UPDATE OR DELETE ON "DocumentSnapshot"
  FOR EACH ROW EXECUTE FUNCTION fl_protect_snapshot();

-- Required application invariants not representable as simple SQL checks:
-- * Authorization and idea ACTIVE state for every write, including worker commits.
-- * triggerMessage is USER and assistant output references a COMPLETED generation attempt;
--   enforce atomically in service or add reviewed deferred triggers.
-- * current memory version corresponds to the latest immutable MemoryRevision.
-- * ExportJob creation requires snapshot APPROVED; check in locked transaction.
-- * Conversation active-generation uniqueness is enforced by index above; retirement
--   must happen before retry insertion in a single database transaction.
-- * For immediate response correction, conversation-context status is separate from approval.


-- Phase 2D static design corrections; must be migration/integration tested.
ALTER TABLE "MemoryProposal" ADD CONSTRAINT "proposal_version_positive" CHECK ("version" > 0);
ALTER TABLE "UserAccount" ADD CONSTRAINT "preferences_version_positive" CHECK ("preferencesVersion" > 0);
ALTER TABLE "Conversation" ADD CONSTRAINT "metadata_version_positive" CHECK ("metadataVersion" > 0);
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "idempotency_status_valid"
  CHECK ("status" IN ('IN_PROGRESS', 'SUCCEEDED', 'FAILED_REPLAYABLE'));
ALTER TABLE "UsageLedger" ADD CONSTRAINT "usage_reservation_valid"
  CHECK ("reservationState" IN ('RESERVED', 'SETTLED', 'RELEASED') AND "reservedUnits" >= 0 AND "measuredUnits" >= 0);


-- Final security/privacy design checks (unexecuted migration fragment).
ALTER TABLE "Idea" ADD CONSTRAINT "idea_context_epoch_nonnegative" CHECK ("contextEpoch" >= 0);
ALTER TABLE "WebhookInbox" ADD CONSTRAINT "webhook_attempts_nonnegative"
  CHECK ("leaseEpoch" >= 0 AND "executionAttempts" >= 0);
ALTER TABLE "DataOperation" ADD CONSTRAINT "deletion_scope_and_state"
  CHECK (("kind" = 'EXPORT'::"DataOperationKind" AND "deletionScopeKey" IS NULL AND "deletionState" IS NULL)
    OR ("kind" IN ('DELETE_IDEA'::"DataOperationKind", 'DELETE_ACCOUNT'::"DataOperationKind")
      AND "deletionScopeKey" IS NOT NULL AND "deletionState" IS NOT NULL));
-- Immutable guards authorize DELETE only through the validated purge role and scope.
-- Procedure DDL and exact runtime role grants must be generated/reviewed during implementation;
-- never grant API logins fl_purge_owner membership or use database-owner credentials at runtime.

ALTER TABLE "DataOperation" ADD CONSTRAINT "completed_deletion_has_receipt"
  CHECK ("kind" = 'EXPORT'::"DataOperationKind" OR "status" <> 'COMPLETED'::"DataOperationStatus"
    OR ("deletionState" = 'DELETED'::"DeletionState" AND "livePurgedAt" IS NOT NULL AND "receiptMirroredAt" IS NOT NULL));
ALTER TABLE "WebhookInbox" ADD CONSTRAINT "processed_webhook_has_time"
  CHECK ("status" NOT IN ('APPLIED'::"WebhookInboxStatus", 'IGNORED'::"WebhookInboxStatus") OR "processedAt" IS NOT NULL);


-- Phase3 approved-principle amendments; design fragments, not an applied migration.
ALTER TABLE "GenerationAttempt" ADD CONSTRAINT "orchestration_metadata_minimized"
  CHECK ("orchestrationMetadata" IS NULL OR
    (jsonb_typeof("orchestrationMetadata") = 'object'
      AND octet_length("orchestrationMetadata"::text) <= 4096));
ALTER TABLE "Message" ADD CONSTRAINT "assistant_v2_payload_shape"
  CHECK ("contentSchemaVersion" <> 2 OR
    ("role" = 'ASSISTANT'::"MessageRole"
      AND jsonb_typeof("content") = 'object'
      AND "content" ? 'text' AND jsonb_typeof("content"->'text') = 'string'
      AND "content" ? 'assistantContent' AND jsonb_typeof("content"->'assistantContent') = 'object'
      AND ("content"->'assistantContent') ? 'schemaVersion'
      AND "content"->'assistantContent'->>'schemaVersion' = '1'));
-- Full versioned JSON validation/field allowlist, matching strategy, evidence/proposal scope,
-- claim support, card count/variants and metadata immutability are application-use-case gates.
-- Version1 historical payloads are unchanged; unknown versions fail closed in reader/validator.

-- P4-B01/B02 approved design fragments only. Generate/review migrations; none executed.
-- Prisma owns the Learning unique key, marker, LearningEvidence PK/FKs/indexes.
-- Do not emit duplicate CREATE TABLE / FK DDL from this guard file.
ALTER TABLE "Experiment" ADD CONSTRAINT "experiment_plan_title_shape"
  CHECK (NOT ("plan" ? 'title') OR
    (jsonb_typeof("plan"->'title') = 'string'
      AND length("plan"->>'title') <= 200)) NOT VALID;
-- NOT VALID preserves unreviewed legacy rows; new writes still check the constraint.
-- Validate later only after data-shape review, without fabricating/backfilling titles.

CREATE OR REPLACE FUNCTION fl_learning_history_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $fl_learning$
BEGIN
  IF TG_OP = 'DELETE' AND public.fl_privacy_delete_authorized(OLD."ideaId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'learning history requires scoped privacy purge; ordinary update forbidden';
END $fl_learning$;
CREATE TRIGGER fl_learning_history_immutable
  BEFORE UPDATE OR DELETE ON "Learning"
  FOR EACH ROW EXECUTE FUNCTION fl_learning_history_guard();

CREATE OR REPLACE FUNCTION fl_learning_evidence_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $fl_learning_evidence$
DECLARE captured boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.fl_privacy_delete_authorized(OLD."ideaId") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'learning evidence requires scoped privacy purge';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'captured learning evidence cannot be rewritten';
  END IF;
  SELECT l."evidenceLinksRecorded" INTO captured FROM public."Learning" l
    WHERE l."id" = NEW."learningId" AND l."ideaId" = NEW."ideaId" FOR UPDATE;
  IF NOT FOUND OR NOT captured THEN
    RAISE EXCEPTION 'learning evidence capture marker required';
  END IF;
  IF (SELECT count(*) FROM public."LearningEvidence" e WHERE e."learningId" = NEW."learningId") >= 20 THEN
    RAISE EXCEPTION 'learning evidence capture limit exceeded';
  END IF;
  RETURN NEW;
END $fl_learning_evidence$;
CREATE TRIGGER fl_learning_evidence_capture_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "LearningEvidence"
  FOR EACH ROW EXECUTE FUNCTION fl_learning_evidence_guard();
-- Service must insert true + the complete distinct set in the original create transaction only.
-- These guards prove neither founder authorization nor initial-transaction-only INSERT permission.
-- No late association insertion port/API exists; test the trusted create service and SQL role grants.
-- Legacy false remains immutable; no automatic false->true backfill or true->false reset.
-- Purge role/operation/idea locks stay live while deleting LearningEvidence, then its parents.

COMMIT;
