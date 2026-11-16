import { createPrototypeGatewayExecutionModel } from './prototypeGatewayExecution';
export { createPrototypeGatewayExecutionModel } from './prototypeGatewayExecution';
import { createSkillSyncCredentialModel } from './skillSyncCredential';
import { createSkillSyncStatusModel } from './skillSyncStatus';
import { createConversationTagModel } from './conversationTag';
import { createAgentCategoryModel } from './agentCategory';
import { createChatProjectModel } from './chatProject';
import { createAgentApiKeyModel } from './agentApiKey';
import { createTransactionModel } from './transaction';
import { createPromptGroupModel } from './promptGroup';
import { createSystemGrantModel } from './systemGrant';
import { createPluginAuthModel } from './pluginAuth';
import { createSharedLinkModel } from './sharedLink';
import { createAccessRoleModel } from './accessRole';
import { createMCPServerModel } from './mcpServer';
import { createAssistantModel } from './assistant';
import { createSkillFileModel } from './skillFile';
import { createConversationModel } from './convo';
import { createToolCallModel } from './toolCall';
import { createAclEntryModel } from './aclEntry';
import { createAuditLogModel } from './auditLog';
import { createSessionModel } from './session';
import { createBalanceModel } from './balance';
import { createMessageModel } from './message';
import { createActionModel } from './action';
import { createBannerModel } from './banner';
import { createPresetModel } from './preset';
import { createPromptModel } from './prompt';
import { createMemoryModel } from './memory';
import { createConfigModel } from './config';
import { createPrototypeJobModel } from './prototypeJob';
import { createPrototypeTurnModel } from './prototypeTurn';
import { createPrototypeEventModel } from './prototypeEvent';
import { createPrototypeArtifactModel } from './prototypeArtifact';
import { createPrototypeOutboxModel } from './prototypeOutbox';
import { createPrototypeWorkerEventReceiptModel } from './prototypeWorkerEventReceipt';
import { createGuidePageModel } from './guidePage';
import { createGuideMediaModel } from './guideMedia';
import { createReleaseModel } from './release';
import { createUserReleaseStateModel } from './userReleaseState';

export { createPrototypeJobModel } from './prototypeJob';
export { createPrototypeTurnModel } from './prototypeTurn';
export { createPrototypeEventModel } from './prototypeEvent';
export { createPrototypeArtifactModel } from './prototypeArtifact';
export { createPrototypeOutboxModel } from './prototypeOutbox';
export { createPrototypeWorkerEventReceiptModel } from './prototypeWorkerEventReceipt';
import { createTokenModel } from './token';
import { createAgentModel } from './agent';
import { createSkillModel } from './skill';
import { createGroupModel } from './group';
import { createUserModel } from './user';
import { createRoleModel } from './role';
import { createFileModel } from './file';
import { createKeyModel } from './key';

/**
 * Creates all database models for all collections
 */
export function createModels(mongoose: typeof import('mongoose')): {
  User: ReturnType<typeof createUserModel>;
  Token: ReturnType<typeof createTokenModel>;
  Session: ReturnType<typeof createSessionModel>;
  Balance: ReturnType<typeof createBalanceModel>;
  Conversation: ReturnType<typeof createConversationModel>;
  ChatProject: ReturnType<typeof createChatProjectModel>;
  Message: ReturnType<typeof createMessageModel>;
  Agent: ReturnType<typeof createAgentModel>;
  AgentApiKey: ReturnType<typeof createAgentApiKeyModel>;
  AgentCategory: ReturnType<typeof createAgentCategoryModel>;
  MCPServer: ReturnType<typeof createMCPServerModel>;
  Role: ReturnType<typeof createRoleModel>;
  Action: ReturnType<typeof createActionModel>;
  Assistant: ReturnType<typeof createAssistantModel>;
  File: ReturnType<typeof createFileModel>;
  Banner: ReturnType<typeof createBannerModel>;
  Key: ReturnType<typeof createKeyModel>;
  PluginAuth: ReturnType<typeof createPluginAuthModel>;
  Transaction: ReturnType<typeof createTransactionModel>;
  Preset: ReturnType<typeof createPresetModel>;
  Prompt: ReturnType<typeof createPromptModel>;
  PromptGroup: ReturnType<typeof createPromptGroupModel>;
  Skill: ReturnType<typeof createSkillModel>;
  SkillFile: ReturnType<typeof createSkillFileModel>;
  SkillSyncCredential: ReturnType<typeof createSkillSyncCredentialModel>;
  SkillSyncStatus: ReturnType<typeof createSkillSyncStatusModel>;
  ConversationTag: ReturnType<typeof createConversationTagModel>;
  SharedLink: ReturnType<typeof createSharedLinkModel>;
  ToolCall: ReturnType<typeof createToolCallModel>;
  MemoryEntry: ReturnType<typeof createMemoryModel>;
  AccessRole: ReturnType<typeof createAccessRoleModel>;
  AclEntry: ReturnType<typeof createAclEntryModel>;
  SystemGrant: ReturnType<typeof createSystemGrantModel>;
  AuditLog: ReturnType<typeof createAuditLogModel>;
  Group: ReturnType<typeof createGroupModel>;
  Config: ReturnType<typeof createConfigModel>;
} {
  return {
    User: createUserModel(mongoose),
    Token: createTokenModel(mongoose),
    Session: createSessionModel(mongoose),
    Balance: createBalanceModel(mongoose),
    Conversation: createConversationModel(mongoose),
    ChatProject: createChatProjectModel(mongoose),
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
    SkillSyncCredential: createSkillSyncCredentialModel(mongoose),
    SkillSyncStatus: createSkillSyncStatusModel(mongoose),
    ConversationTag: createConversationTagModel(mongoose),
    SharedLink: createSharedLinkModel(mongoose),
    ToolCall: createToolCallModel(mongoose),
    MemoryEntry: createMemoryModel(mongoose),
    AccessRole: createAccessRoleModel(mongoose),
    AclEntry: createAclEntryModel(mongoose),
    SystemGrant: createSystemGrantModel(mongoose),
    AuditLog: createAuditLogModel(mongoose),
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
    Release: createReleaseModel(mongoose),
    UserReleaseState: createUserReleaseStateModel(mongoose),
  };
}
