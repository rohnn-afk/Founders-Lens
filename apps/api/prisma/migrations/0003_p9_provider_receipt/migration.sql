-- One immutable observation for an attempt, independent of answer publication.
CREATE TABLE public."GenerationProviderReceipt" (
  "attemptId" uuid PRIMARY KEY REFERENCES public."GenerationAttempt"(id) ON DELETE CASCADE,
  "leaseEpoch" integer NOT NULL CHECK ("leaseEpoch" > 0),
  "responseId" varchar(256),
  "inputTokens" integer NOT NULL CHECK ("inputTokens" >= 0),
  "outputTokens" integer NOT NULL CHECK ("outputTokens" >= 0),
  "totalTokens" integer NOT NULL CHECK ("totalTokens" >= 0),
  "observedAt" timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  CHECK ("totalTokens" >= "inputTokens"::bigint + "outputTokens")
);
REVOKE ALL ON public."GenerationProviderReceipt" FROM PUBLIC;
