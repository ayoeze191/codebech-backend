-- A candidate has one current answer per question. This prevents stale queue
-- jobs from racing against a later attempt for the same question.
CREATE UNIQUE INDEX "Submission_invitationId_questionId_key" ON "Submission"("invitationId", "questionId");
