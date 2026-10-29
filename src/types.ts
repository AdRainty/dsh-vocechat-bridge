export type Destination = { kind: 'user' | 'group'; id: number };
export type IncomingAttachment = { kind: 'image' | 'audio' | 'file'; path: string; name: string; mime: string; size?: number };
export type IncomingMessage = {
  id: string; senderId: number; destination: Destination; timestamp: number;
  text: string; attachments: IncomingAttachment[];
};
export type PreparedAttachment = IncomingAttachment & { localPath?: string; transcript?: string; error?: string };
export type PreparedMessage = Omit<IncomingMessage, 'attachments'> & { attachments: PreparedAttachment[] };
/** Historical attachments are descriptors; they never cause another download or ASR call. */
export type HistoryMessage = Omit<IncomingMessage, 'attachments'> & {
  attachments: (IncomingAttachment & {transcript?: string; error?: string})[];
};
export type ConversationHistory = {
  destination: Destination; messages: HistoryMessage[]; order: 'oldest_first';
  requested: number; truncated: boolean; error?: string;
};
export type OutgoingAttachment = { kind: 'image' | 'audio' | 'file'; path?: string; url?: string; name?: string; mime?: string };
export type SpeechRequest = { text: string; voice?: string; instructions?: string };
export type OutboundMessage = { text?: string; format?: 'plain' | 'markdown'; attachments?: OutgoingAttachment[]; speech?: SpeechRequest; replyTo?: number };
export type SessionRunOptions = { beforeSubmit: () => Promise<void>; history?: ConversationHistory };
export interface SessionPort {
  supportsSubmissionBarrier?: boolean;
  run(messages: PreparedMessage[], signal: AbortSignal, options?: SessionRunOptions): Promise<{ text?: string; sent?: boolean; quiet?: boolean }>;
  dispose?(): void;
}
export type CredentialResolver = (ref: string) => Promise<string | undefined>;
export interface Logger { debug(message: string): void; info(message: string): void; warn(message: string): void; error(message: string): void }
