import {
  createEmailJob,
  type CreateJobInput,
} from "@/lib/jobs/process";
import { getJobById } from "@/lib/jobs/query";
import { parseJobMerge } from "@/lib/validation/email-job";
import { dispatchCreatedEmailJobs } from "@/lib/trigger/schedule";
import { resolveSendContent } from "@/lib/jobs/campaign";

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
  const content = await resolveSendContent(source);
  const input: CreateJobInput = {
    tenantId: source.tenant_id,
    subject: content.subject,
    html: content.html,
    recipients,
    from: source.from_email,
    replyTo: source.reply_to,
    sendAt,
    idempotencyKey: null,
    attachments: content.attachments,
    merge: parseJobMerge(source.merge),
  };

  const { job, invalid, children } = await createEmailJob(input);

  if (options?.sendNow !== false && sendAt.getTime() <= Date.now()) {
    const dispatched = await dispatchCreatedEmailJobs(job, children);

    return {
      job,
      invalid,
      processed: dispatched.result,
    };
  }

  if (sendAt.getTime() > Date.now()) {
    await dispatchCreatedEmailJobs(job, children, { sendAt });
  }

  return { job, invalid, processed: null };
}
