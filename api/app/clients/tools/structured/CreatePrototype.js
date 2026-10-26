const { z } = require('zod');
const { StructuredTool } = require('@librechat/agents/langchain/tools');
const { requirePrototypeEnabled } = require('~/server/services/Prototypes/PrototypeAdmission');

const createPrototypeSchema = z
  .object({
    spec: z.string().trim().min(1).max(50000),
  })
  .strict();

class CreatePrototype extends StructuredTool {
  constructor(fields = {}) {
    super(fields);
    this.name = 'create_prototype';
    this.description =
      'Creates an interactive interface prototype from the user requirements. Execution continues asynchronously in this conversation.';
    this.schema = createPrototypeSchema;
    this.req = fields.req;
    this.model = fields.model;
    this.prototypeService = fields.prototypeService;
  }

  async _call(input, _runManager, config) {
    requirePrototypeEnabled(this.req);
    const injected = this.prototypeService != null;
    const prototypeService = injected
      ? this.prototypeService
      : require('~/server/services/Prototypes').createPrototypeService();
    const result = injected
      ? await prototypeService.acceptToolCall(
          {
            userId: this.req?.user?.id ?? this.req?.user?._id,
            tenantId: this.req?.user?.tenantId ?? this.req?.user?.orgId,
            conversationId: this.req?.body?.conversationId,
            messageId: this.req?.body?.messageId,
            modelId: this.model,
          },
          input,
        )
      : await prototypeService.acceptToolCall({
          req: this.req,
          spec: input.spec,
          toolCallId: config?.toolCall?.id ?? this.req?.body?.toolCallId,
          messageId: this.req?.body?.messageId,
          modelId: this.model,
          attachments: this.req?.body?.attachments,
        });
    return JSON.stringify({
      accepted: true,
      job_id: result.jobId ?? result.job_id,
      status: result.status ?? 'queued',
      model_id: result.modelId ?? this.model,
    });
  }
}

module.exports = CreatePrototype;
