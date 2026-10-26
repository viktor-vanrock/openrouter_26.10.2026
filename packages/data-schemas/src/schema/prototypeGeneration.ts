import { Schema } from 'mongoose';
import type { PrototypeGenerationBinding } from '~/types/prototype';

/** Additive, immutable by repository CAS; absent on historical records. */
const prototypeGenerationSchema = new Schema<PrototypeGenerationBinding>({
  schemaVersion: { type: Number, required: true, enum: [1] },
  engineId: { type: String, required: true, enum: ['direct-react-v1', 'opencode-fsd-v1'] },
  sourceProfile: { type: String, required: true, enum: ['react-source-v1', 'react-fsd-source-v1'] },
  rulesDigest: { type: String, required: true, match: /^sha256:[a-f0-9]{64}$/ },
  templateDigest: { type: String, required: true, match: /^sha256:[a-f0-9]{64}$/ },
  toolchainDigest: { type: String, required: true, match: /^sha256:[a-f0-9]{64}$/ },
}, { _id: false, strict: 'throw' });

prototypeGenerationSchema.path('sourceProfile').validate(function (this: PrototypeGenerationBinding, value: string) {
  return (this.engineId === 'direct-react-v1') === (value === 'react-source-v1');
}, 'Generation engine and source profile must match');
export default prototypeGenerationSchema;
