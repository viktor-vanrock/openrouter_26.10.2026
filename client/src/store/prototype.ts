import { atom, atomFamily } from 'recoil';
import { atomWithLocalStorage } from './utils';
import type { PrototypeCardData } from 'librechat-data-provider';

export const prototypeModeByConvoId = atomFamily<boolean, string>({
  key: 'prototypeModeByConvoId',
  default: false,
});

export const prototypeSubmittingByIndex = atomFamily<boolean, string | number>({
  key: 'prototypeSubmittingByIndex',
  default: false,
});

export const prototypePreview = atom<{
  jobId: string;
  conversationId: string;
  htmlDigest?: string;
} | null>({
  key: 'prototypePreview',
  default: null,
});

export const prototypeCardByConvoId = atomFamily<PrototypeCardData | null, string>({
  key: 'prototypeCardByConvoId',
  default: null,
});

export const prototypeModePinned = atomWithLocalStorage<boolean>('prototypeModePinned', false);
