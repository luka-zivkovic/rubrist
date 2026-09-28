import { afterEach, expect, it, vi } from "vitest";
import type { Queue } from "@rubrist/queue";
import type { RubristRepository } from "../src/repository.js";
import { registerFeedbackSyncWorker, resumeSignedOffFeedback } from "../src/workers/feedback-sync.js";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("recovers held jobs at startup and on later ticks after a failed recovery read", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const listSignedOffFeedbackSyncJobs = vi.fn().mockRejectedValueOnce(new Error("Database temporarily unavailable")).mockResolvedValue([]);
  const repository = { listSignedOffFeedbackSyncJobs } as unknown as RubristRepository;
  const queue = { work: vi.fn(async () => {}), send: vi.fn() } as unknown as Queue;
  await registerFeedbackSyncWorker(queue, repository);
  expect(queue.work).toHaveBeenCalledWith("feedback.sync", expect.any(Function));
  expect(listSignedOffFeedbackSyncJobs).toHaveBeenCalledWith(100);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(listSignedOffFeedbackSyncJobs).toHaveBeenCalledTimes(2);
});

it("a failed send cannot prevent the remaining bounded batch from being dispatched", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const jobs = [{ projectId: "project", feedbackSyncJobId: "held1" }, { projectId: "project", feedbackSyncJobId: "held2" }];
  const repository = { listSignedOffFeedbackSyncJobs: vi.fn(async () => jobs) } as unknown as RubristRepository;
  const send = vi.fn().mockRejectedValueOnce(new Error("Temporary failure")).mockResolvedValueOnce("queue-job");
  expect(await resumeSignedOffFeedback(repository, { send } as unknown as Queue)).toBe(1);
  expect(send).toHaveBeenNthCalledWith(2, "feedback.sync", jobs[1], expect.objectContaining({ retryLimit: 5 }));
});
