import prototypeGatewayExecutionSchema from '~/schema/prototypeGatewayExecution';
export function createPrototypeGatewayExecutionModel(mongoose: typeof import('mongoose')) {
  return mongoose.models.PrototypeGatewayExecution || mongoose.model('PrototypeGatewayExecution', prototypeGatewayExecutionSchema);
}
