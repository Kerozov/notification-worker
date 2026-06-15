import {
  createEmailJob,
  processJobById,
  type CreateJobInput,
} from "@/lib/jobs/process";
import { getJobById } from "@/lib/jobs/query";

export async function resendJobAsNew(
  sourceJobId: string,
  recipients: string[],
  options?: { sendNow?: boolean; sendAt?: Date },
) {
  const source = await getJobById(sourceJobId);

  if (!source) {
    throw new Error("Source job not found");
  }

  const sendAt = options?.sendAt ?? new Date();
  const input: CreateJobInput = {
    tenantId: source.tenant_id,
    subject: source.subject,
    html: source.html,
    recipients,
    from: source.from_email,
    replyTo: source.reply_to,
    sendAt,
    idempotencyKey: null,
  };

  const { job, invalid } = await createEmailJob(input);

  if (options?.sendNow !== false && sendAt.getTime() <= Date.now()) {
    const result = await processJobById(job.id);

    return {
      job,
      invalid,
      processed: result,
    };
  }

  return { job, invalid, processed: null };
}
