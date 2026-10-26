import { createPrototypeGatewayExecutionModel } from './prototypeGatewayExecution';
export { createPrototypeGatewayExecutionModel } from './prototypeGatewayExecution';
import { createUserModel } from './user';
import { createTokenModel } from './token';
import { createSessionModel } from './session';
import { createBalanceModel } from './balance';
import { createConversationModel } from './convo';
import { createMessageModel } from './message';
import { createAgentModel } from './agent';
import { createAgentApiKeyModel } from './agentApiKey';
import { createAgentCategoryModel } from './agentCategory';
import { createMCPServerModel } from './mcpServer';
import { createRoleModel } from './role';
import { createActionModel } from './action';
import { createAssistantModel } from './assistant';
import { createFileModel } from './file';
import { createBannerModel } from './banner';
import { createKeyModel } from './key';
import { createPluginAuthModel } from './pluginAuth';
import { createTransactionModel } from './transaction';
import { createPresetModel } from './preset';
import { createPromptModel } from './prompt';
import { createPromptGroupModel } from './promptGroup';
import { createSkillModel } from './skill';
import { createSkillFileModel } from './skillFile';
import { createConversationTagModel } from './conversationTag';
import { createSharedLinkModel } from './sharedLink';
import { createToolCallModel } from './toolCall';
import { createMemoryModel } from './memory';
import { createAccessRoleModel } from './accessRole';
import { createAclEntryModel } from './aclEntry';
import { createSystemGrantModel } from './systemGrant';
import { createGroupModel } from './group';
import { createConfigModel } from './config';
import { createPrototypeJobModel } from './prototypeJob';
import { createPrototypeTurnModel } from './prototypeTurn';
import { createPrototypeEventModel } from './prototypeEvent';
import { createPrototypeArtifactModel } from './prototypeArtifact';
import { createPrototypeOutboxModel } from './prototypeOutbox';
import { createPrototypeWorkerEventReceiptModel } from './prototypeWorkerEventReceipt';
import { createGuidePageModel } from './guidePage';
import { createGuideMediaModel } from './guideMedia';

export { createPrototypeJobModel } from './prototypeJob';
export { createPrototypeTurnModel } from './prototypeTurn';
export { createPrototypeEventModel } from './prototypeEvent';
export { createPrototypeArtifactModel } from './prototypeArtifact';
export { createPrototypeOutboxModel } from './prototypeOutbox';
export { createPrototypeWorkerEventReceiptModel } from './prototypeWorkerEventReceipt';

/**
 * Creates all database models for all collections
 */
export function createModels(mongoose: typeof import('mongoose')) {
  return {
    User: createUserModel(mongoose),
    Token: createTokenModel(mongoose),
    Session: createSessionModel(mongoose),
    Balance: createBalanceModel(mongoose),
    Conversation: createConversationModel(mongoose),
    Message: createMessageModel(mongoose),
    Agent: createAgentModel(mongoose),
    AgentApiKey: createAgentApiKeyModel(mongoose),
    AgentCategory: createAgentCategoryModel(mongoose),
    MCPServer: createMCPServerModel(mongoose),
    Role: createRoleModel(mongoose),
    Action: createActionModel(mongoose),
    Assistant: createAssistantModel(mongoose),
    File: createFileModel(mongoose),
    Banner: createBannerModel(mongoose),
    Key: createKeyModel(mongoose),
    PluginAuth: createPluginAuthModel(mongoose),
    Transaction: createTransactionModel(mongoose),
    Preset: createPresetModel(mongoose),
    Prompt: createPromptModel(mongoose),
    PromptGroup: createPromptGroupModel(mongoose),
    Skill: createSkillModel(mongoose),
    SkillFile: createSkillFileModel(mongoose),
    ConversationTag: createConversationTagModel(mongoose),
    SharedLink: createSharedLinkModel(mongoose),
    ToolCall: createToolCallModel(mongoose),
    MemoryEntry: createMemoryModel(mongoose),
    AccessRole: createAccessRoleModel(mongoose),
    AclEntry: createAclEntryModel(mongoose),
    SystemGrant: createSystemGrantModel(mongoose),
    Group: createGroupModel(mongoose),
    Config: createConfigModel(mongoose),
    PrototypeGatewayExecution: createPrototypeGatewayExecutionModel(mongoose),
    PrototypeJob: createPrototypeJobModel(mongoose),
    PrototypeTurn: createPrototypeTurnModel(mongoose),
    PrototypeEvent: createPrototypeEventModel(mongoose),
    PrototypeArtifact: createPrototypeArtifactModel(mongoose),
    PrototypeOutbox: createPrototypeOutboxModel(mongoose),
    PrototypeWorkerEventReceipt: createPrototypeWorkerEventReceiptModel(mongoose),
    GuidePage: createGuidePageModel(mongoose),
    GuideMedia: createGuideMediaModel(mongoose),
  };
}
